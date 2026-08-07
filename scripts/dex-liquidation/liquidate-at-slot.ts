/**
 * Slot-targeted liquidation submitter.
 *
 * Sends a PRE-SIGNED Gnosis Safe `execTransaction` (whose inner call is a Comet
 * `liquidate(absorber, account, swapData)`) into one exact Ethereum mainnet slot, i.e. at one exact
 * `block.timestamp == T`.
 *
 * Why this exists: the seizure plan — and therefore the seized amounts baked into `swapData` — are
 * computed for a single timestamp `T`. Because the market accrues interest, at any other timestamp the
 * debt (and the partial seized amount) drifts and the DEX adapter's exact `amountIn` check reverts
 * (`InvalidAmountIn`). In the fork test (test/liquidation-module/live-comet-dex-simulation.test.ts) we
 * pinned the block time with `evm_setNextBlockTimestamp`. On real mainnet we cannot set block time, so
 * we instead target the slot whose consensus-fixed timestamp equals `T`:
 *
 *     block.timestamp == GENESIS + 12 * slot        (post-Merge; the builder cannot choose it)
 *
 * The Safe transaction (inner liquidate + swapData + owner signatures) is prepared and signed IN
 * ADVANCE and pasted into the constants below together with `T`. This script only does the timing:
 * it assembles `execTransaction` calldata, wraps it in an EIP-1559 tx from a throwaway executor EOA,
 * and submits it as a Flashbots-style bundle bounded to `minTimestamp == maxTimestamp == T` across
 * several builders, in the final seconds before `T`.
 *
 * See slot-targeted-safe-execution.md for the full rationale.
 *
 * Run:  RPC_URL=... EXECUTOR_KEY=0x... FB_AUTH_KEY=0x... npx hardhat run scripts/dex-liquidation/liquidate-at-slot.ts
 * (or with ts-node). Set DRY_RUN=1 to only simulate against the current head and exit.
 */
import 'dotenv/config';
import { ethers, BigNumber } from 'ethers';

// Node 23 provides a global `fetch` at runtime, but @types/node@16 does not type it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const httpFetch = (globalThis as any).fetch as (url: string, init?: any) => Promise<any>;

// ══════════════════════════════════════ CONSTANTS ══════════════════════════════════════
// Fill these from the Safe transaction that was prepared and signed in advance, plus the slot target.

// ── Slot target (unix seconds). MUST be slot-aligned: (TARGET_TIMESTAMP - GENESIS) % 12 == 0.
//    This is the exact timestamp the seizure plan / swapData were computed for. ──
const TARGET_TIMESTAMP = 0;

// ── The Safe and the exact fields that were hashed & signed (frozen — must match the safeTxHash) ──
const SAFE_ADDRESS = '0x4c894222653870C5e5a346E2c293a75DAC8d77a8';
const SAFE_TX = {
  to: '0xD2B9A994961d2e15B2C4af17E7a97f1FF06C5444', // the Comet / liquidation module the Safe calls
  value: '0',
  data: '', // liquidate(absorber, account, swapData) calldata, with swapData computed for TARGET_TIMESTAMP
  operation: 0, // 0 = CALL
  // Per the spec: safeTxGas == 0 && gasPrice == 0 makes an inner-call failure REVERT the whole tx
  // (GS013) instead of returning false — so a tx that lands in the wrong slot simply reverts, burns
  // no funds, and the signatures stay reusable. Keep these zero.
  safeTxGas: '0',
  baseGas: '0',
  gasPrice: '0',
  gasToken: '0x0000000000000000000000000000000000000000',
  refundReceiver: '0x0000000000000000000000000000000000000000',
};

// ── Owner signatures as a COMMA-SEPARATED list of individual 65-byte signatures (one per owner, ANY
//    order). The script recovers each signer via the Safe's getTransactionHash, checks they are owners
//    meeting the threshold, sorts them ascending by owner address (mandatory — checkNSignatures requires
//    each recovered owner strictly greater than the last), and concatenates them into the final blob.
//    Grab each owner's `signature` from the Safe Tx Service confirmations or the Safe UI. ──
const OWNER_SIGNATURES = '';

// ── The Safe nonce the signatures were made against. The signatures silently become invalid if the
//    Safe executes anything else in the meantime; we abort if the on-chain nonce has moved. ──
const SIGNED_NONCE = 0;

// ── Executor tx sizing. safeTxGas=0 means the inner call consumes all forwarded gas, so GAS_LIMIT
//    must comfortably cover execTransaction + liquidate + every swap. Cannot be estimated at `latest`
//    (the amounts only match at T), so it is a generous constant. ──
const GAS_LIMIT = 3_000_000;
const PRIORITY_FEE_GWEI = 0.5; // maxFeePerGas = baseFee * 2 + tip (~1.4x headroom when signing at T-30s)

// ── Missed-slot policy. Retargeting to T+12 is NOT valid here: the swapData is pinned to T, so a
//    later slot would revert on the adapter's amount check. If the slot is missed or the auction is
//    lost, the only correct action is to abort and re-prepare a freshly-signed Safe tx for a new T. ──
const ON_MISS = 'abort' as const;

// ── Consensus (mainnet). For testnets read GET /eth/v1/beacon/genesis instead of hardcoding. ──
const GENESIS = 1606824023;
const SLOT_SECONDS = 12;

// ── Builders: submit to all in parallel; only one wins a slot. Flashbots needs X-Flashbots-Signature;
//    the others ignore it. ──
const FLASHBOTS_URL = 'https://relay.flashbots.net';
const BUILDERS: { url: string, flashbots?: boolean }[] = [
  { url: FLASHBOTS_URL, flashbots: true },
  { url: 'https://rpc.titanbuilder.xyz' },
  { url: 'https://rpc.beaverbuild.org' },
  { url: 'https://rsync-builder.xyz' },
];

// ── Timing ──
const SIGN_LEAD_SECS = 30; // sign the executor tx at T-30s (bounds base-fee drift to ~2-3 blocks)
const SUBMIT_WINDOW_SECS = 13; // start the submit loop at T-13s (~1 slot); resubmit as the head advances
const INCLUSION_WAIT_SECS = 36; // after T, how long to wait for the receipt before declaring a miss

// ═══════════════════════════════════════ ENV ═══════════════════════════════════════════
const RPC_URL = reqEnv('RPC_URL');
const EXECUTOR_KEY = reqEnv('EXECUTOR_KEY'); // pays gas only; needs no relationship to the Safe
const FB_AUTH_KEY = reqEnv('FB_AUTH_KEY'); // Flashbots reputation key; must hold zero funds
const DRY_RUN = !!process.env.DRY_RUN;

const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const executor = new ethers.Wallet(EXECUTOR_KEY, provider);
const authWallet = new ethers.Wallet(FB_AUTH_KEY);

const SAFE_ABI = [
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function isOwner(address owner) view returns (bool)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
];
const safe = new ethers.Contract(SAFE_ADDRESS, SAFE_ABI, provider);

// ═════════════════════════════════════ HELPERS ═════════════════════════════════════════
function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sleepUntil(tsSec: number, label: string) {
  while (nowSec() < tsSec) {
    const remain = tsSec - nowSec();
    if (remain <= 5 || remain % 15 === 0) console.log(`  …${remain}s until ${label}`);
    await sleep(1000);
  }
}

/** Recover the owner that produced a Safe signature over `safeTxHash`. Handles ECDSA EIP-712 (v 27/28)
 *  and eth_sign (v 31/32) owner signatures; EIP-1271/contract and approved-hash sigs are not supported. */
function recoverSafeSigner(safeTxHash: string, sig: string): string {
  const s = sig.startsWith('0x') ? sig : `0x${sig}`;
  if (ethers.utils.hexDataLength(s) !== 65) throw new Error(`signature must be 65 bytes: ${s}`);
  const v = parseInt(s.slice(-2), 16);
  if (v === 27 || v === 28) return ethers.utils.recoverAddress(safeTxHash, s);
  if (v === 31 || v === 32) {
    // eth_sign: owner signed the EIP-191 personal-message digest of safeTxHash, with v offset by +4.
    return ethers.utils.verifyMessage(ethers.utils.arrayify(safeTxHash), s.slice(0, 130) + (v - 4).toString(16).padStart(2, '0'));
  }
  throw new Error(`unsupported signature v=${v}`);
}

/** Turn the comma-separated OWNER_SIGNATURES into the single, ascending-by-owner `signatures` blob that
 *  execTransaction expects — verifying each recovered signer is a Safe owner and the threshold is met. */
async function assembleSignatures(): Promise<string> {
  const safeTxHash: string = await safe.getTransactionHash(
    SAFE_TX.to, SAFE_TX.value, SAFE_TX.data, SAFE_TX.operation,
    SAFE_TX.safeTxGas, SAFE_TX.baseGas, SAFE_TX.gasPrice, SAFE_TX.gasToken, SAFE_TX.refundReceiver, SIGNED_NONCE,
  );
  const parts = OWNER_SIGNATURES.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('Set OWNER_SIGNATURES.');

  const recovered = parts.map((sig) => ({ owner: recoverSafeSigner(safeTxHash, sig), sig: (sig.startsWith('0x') ? sig : `0x${sig}`).slice(2) }));
  recovered.sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()));

  const threshold: BigNumber = await safe.getThreshold();
  if (recovered.length < threshold.toNumber()) throw new Error(`${recovered.length} signature(s) < threshold ${threshold.toString()}`);
  for (let i = 0; i < recovered.length; i++) {
    if (i > 0 && recovered[i].owner.toLowerCase() === recovered[i - 1].owner.toLowerCase()) throw new Error(`duplicate signature from ${recovered[i].owner}`);
    if (!(await safe.isOwner(recovered[i].owner))) {
      throw new Error(`recovered signer ${recovered[i].owner} is not a Safe owner — wrong SAFE_TX fields, SIGNED_NONCE, or a bad signature.`);
    }
  }
  console.log(`Assembled ${recovered.length} signature(s) (threshold ${threshold.toString()}) over safeTxHash ${safeTxHash}:`);
  recovered.forEach((r) => console.log(`  ${r.owner}`));
  return `0x${recovered.map((r) => r.sig).join('')}`;
}

/** Encode the `execTransaction` calldata from the frozen Safe fields and the assembled signatures. */
function encodeExecTransaction(signatures: string): string {
  return new ethers.utils.Interface(SAFE_ABI).encodeFunctionData('execTransaction', [
    SAFE_TX.to,
    SAFE_TX.value,
    SAFE_TX.data,
    SAFE_TX.operation,
    SAFE_TX.safeTxGas,
    SAFE_TX.baseGas,
    SAFE_TX.gasPrice,
    SAFE_TX.gasToken,
    SAFE_TX.refundReceiver,
    signatures,
  ]);
}

/** Sign a fresh EIP-1559 executor tx carrying the execTransaction calldata. */
async function signExecutorTx(execData: string, chainId: number): Promise<{ rawTx: string, txHash: string }> {
  const head = await provider.getBlock('latest');
  const baseFee = head.baseFeePerGas ?? (await provider.getGasPrice());
  const tip = ethers.utils.parseUnits(String(PRIORITY_FEE_GWEI), 'gwei');
  const maxFee = baseFee.mul(2).add(tip);
  const nonce = await provider.getTransactionCount(executor.address, 'latest');

  const rawTx = await executor.signTransaction({
    chainId,
    type: 2,
    to: SAFE_ADDRESS,
    value: 0,
    data: execData,
    gasLimit: GAS_LIMIT,
    maxPriorityFeePerGas: tip,
    maxFeePerGas: maxFee,
    nonce,
  });
  return { rawTx, txHash: ethers.utils.keccak256(rawTx) };
}

async function flashbotsHeaders(body: string): Promise<Record<string, string>> {
  const sig = await authWallet.signMessage(ethers.utils.id(body));
  return { 'Content-Type': 'application/json', 'X-Flashbots-Signature': `${authWallet.address}:${sig}` };
}

/** eth_callBundle against latest state. Validates calldata/signature encoding — NOT future state, so a
 *  state-dependent revert here (e.g. the amount check at the current timestamp) is expected. */
async function simulate(rawTx: string, blockNumber: number): Promise<void> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_callBundle',
    params: [{ txs: [rawTx], blockNumber: ethers.utils.hexValue(blockNumber), stateBlockNumber: 'latest' }],
  });
  try {
    const res = await httpFetch(FLASHBOTS_URL, { method: 'POST', headers: await flashbotsHeaders(body), body });
    console.log('  eth_callBundle:', (await res.text()).slice(0, 500));
  } catch (e) {
    console.log('  eth_callBundle failed to send:', (e as Error).message);
  }
}

/** Submit the bundle to every builder for exactly `blockNumber`, bounded to the target timestamp. */
async function sendBundle(rawTx: string, blockNumber: number, targetTs: number): Promise<void> {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendBundle',
    params: [{
      txs: [rawTx],
      blockNumber: ethers.utils.hexValue(blockNumber),
      minTimestamp: targetTs,
      maxTimestamp: targetTs,
    }],
  });

  await Promise.all(
    BUILDERS.map(async (b) => {
      const headers = b.flashbots
        ? await flashbotsHeaders(body)
        : { 'Content-Type': 'application/json' };
      try {
        const res = await httpFetch(b.url, { method: 'POST', headers, body });
        console.log(`  [${b.url}] ${res.status} ${(await res.text()).slice(0, 160)}`);
      } catch (e) {
        console.log(`  [${b.url}] send error: ${(e as Error).message}`);
      }
    })
  );
}

function nearestAlignedSlots(ts: number): { below: number, above: number } {
  const off = ((ts - GENESIS) % SLOT_SECONDS + SLOT_SECONDS) % SLOT_SECONDS;
  return { below: ts - off, above: ts - off + SLOT_SECONDS };
}

async function assertSafeNonce(): Promise<void> {
  const onchain: BigNumber = await safe.nonce();
  if (!onchain.eq(SIGNED_NONCE)) {
    throw new Error(
      `Safe nonce moved: on-chain ${onchain.toString()} != signed ${SIGNED_NONCE}. ` +
      `The signatures are now invalid — abort and re-collect signatures.`
    );
  }
}

// ═══════════════════════════════════════ MAIN ══════════════════════════════════════════
async function main() {
  // ── Validate constants ──
  if (TARGET_TIMESTAMP <= 0) throw new Error('Set TARGET_TIMESTAMP.');
  if (!ethers.utils.isAddress(SAFE_ADDRESS) || BigNumber.from(SAFE_ADDRESS).isZero()) throw new Error('Set SAFE_ADDRESS.');
  if (ethers.utils.hexDataLength(SAFE_TX.data) === 0) throw new Error('Set SAFE_TX.data (the signed liquidate calldata).');
  if (OWNER_SIGNATURES.trim().length === 0) throw new Error('Set OWNER_SIGNATURES (comma-separated owner signatures).');

  if ((TARGET_TIMESTAMP - GENESIS) % SLOT_SECONDS !== 0) {
    const { below, above } = nearestAlignedSlots(TARGET_TIMESTAMP);
    throw new Error(
      `TARGET_TIMESTAMP ${TARGET_TIMESTAMP} is not slot-aligned ((T-GENESIS) % 12 != 0). ` +
      `Nearest slots: ${below} or ${above}. The seizure plan must be recomputed for a slot-aligned T.`
    );
  }

  const { chainId } = await provider.getNetwork();
  if (chainId !== 1) console.warn(`WARNING: chainId ${chainId} != 1; GENESIS ${GENESIS} is the mainnet value.`);

  // ── Pre-flight (Section 11 acceptance checks) ──
  await assertSafeNonce();
  const signatures = await assembleSignatures();
  const execData = encodeExecTransaction(signatures);

  const balance = await provider.getBalance(executor.address);
  const head0 = await provider.getBlock('latest');
  const baseFee0 = head0.baseFeePerGas ?? (await provider.getGasPrice());
  const need = BigNumber.from(GAS_LIMIT).mul(baseFee0.mul(2).add(ethers.utils.parseUnits(String(PRIORITY_FEE_GWEI), 'gwei')));
  console.log(`Executor ${executor.address} balance ${ethers.utils.formatEther(balance)} ETH, worst-case gas cost ~${ethers.utils.formatEther(need)} ETH`);
  if (balance.lt(need)) throw new Error('Executor balance below worst-case gas cost.');

  console.log(`Target timestamp ${TARGET_TIMESTAMP} (slot ${(TARGET_TIMESTAMP - GENESIS) / SLOT_SECONDS}); now ${nowSec()} (T-${TARGET_TIMESTAMP - nowSec()}s)`);

  if (DRY_RUN) {
    const { rawTx, txHash } = await signExecutorTx(execData, chainId);
    console.log(`DRY_RUN — executor tx ${txHash}; simulating against head...`);
    await simulate(rawTx, head0.number + 1);
    return;
  }

  if (nowSec() >= TARGET_TIMESTAMP) throw new Error('TARGET_TIMESTAMP is in the past.');

  // ── T-30s: re-check nonce and sign the executor tx (limits base-fee drift) ──
  await sleepUntil(TARGET_TIMESTAMP - SIGN_LEAD_SECS, 'sign (T-30s)');
  await assertSafeNonce();
  const { rawTx, txHash } = await signExecutorTx(execData, chainId);
  console.log(`Signed executor tx ${txHash}`);
  await simulate(rawTx, (await provider.getBlockNumber()) + 1);

  // ── T-13s .. T: resubmit each time the head advances; only the last submission can land ──
  await sleepUntil(TARGET_TIMESTAMP - SUBMIT_WINDOW_SECS, 'submit window (T-13s)');
  while (nowSec() < TARGET_TIMESTAMP) {
    const head = await provider.getBlockNumber();
    console.log(`[T-${TARGET_TIMESTAMP - nowSec()}s] eth_sendBundle for block ${head + 1} @ ts ${TARGET_TIMESTAMP}`);
    await sendBundle(rawTx, head + 1, TARGET_TIMESTAMP);
    await sleep(Math.min(4000, Math.max(500, (TARGET_TIMESTAMP - nowSec()) * 1000)));
  }

  // ── After T: wait for the receipt; a no-show means the slot was missed or the auction was lost ──
  console.log('Target passed; waiting for inclusion...');
  const deadline = TARGET_TIMESTAMP + INCLUSION_WAIT_SECS;
  while (nowSec() < deadline) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt) {
      const block = await provider.getBlock(receipt.blockNumber);
      if (receipt.status === 1 && block.timestamp === TARGET_TIMESTAMP) {
        console.log(`✅ Included in block ${receipt.blockNumber} @ ts ${block.timestamp}, tx ${txHash}`);
      } else {
        console.log(`⚠️  Mined in block ${receipt.blockNumber} @ ts ${block.timestamp} (status ${receipt.status}). ` +
          `Expected ts ${TARGET_TIMESTAMP} — inspect: a wrong-slot inclusion should have reverted (GS013).`);
      }
      return;
    }
    await sleep(2000);
  }

  // Not included. Per ON_MISS policy, abort — the pre-signed swapData is only valid at TARGET_TIMESTAMP.
  throw new Error(
    `Not included at ts ${TARGET_TIMESTAMP} (slot missed or auction lost). Policy=${ON_MISS}: ` +
    `the pre-signed swapData is pinned to T and cannot be replayed at a later slot. ` +
    `Re-prepare and re-sign a Safe tx (fresh swapData) for a new target timestamp.`
  );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
