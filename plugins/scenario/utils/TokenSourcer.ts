import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { BigNumber, Contract, Event, EventFilter, constants, utils } from 'ethers';
import { erc20 } from './ERC20';
import { DeploymentManager } from '../../deployment_manager/DeploymentManager';
import { debug } from '../../deployment_manager/Utils';

const getMaxEntry = (args: [string, BigNumber][]) =>
  args.reduce(([a1, m], [a2, e]) => (m.gte(e) == true ? [a1, m] : [a2, e]));

interface SourceTokenParameters {
  dm: DeploymentManager;
  amount: number | bigint;
  asset: string;
  address: string;
  blacklist: string[];
  blockNumber?: number;
}

export async function fetchQuery(
  contract: Contract,
  filter: EventFilter,
  fromBlock: number,
  toBlock: number,
  originalBlock: number,
  MAX_SEARCH_BLOCKS = 40000,
  BLOCK_SPAN = 2048
): Promise<{ recentLogs: Event[], blocksDelta: number }> {
  if (originalBlock - fromBlock > MAX_SEARCH_BLOCKS) {
    throw(new Error(`No events found within ${MAX_SEARCH_BLOCKS} blocks for ${contract.address}`));
  }
  try {
    const res = await contract.queryFilter(filter, fromBlock, toBlock);
    if (res.length > 0) {
      return { recentLogs: res, blocksDelta: toBlock - fromBlock };
    } else {
      const nextToBlock = fromBlock;
      const nextFrom = fromBlock - BLOCK_SPAN;
      if (nextFrom < 0) {
        throw(new Error('No events found by chain genesis'));
      }
      return fetchQuery(contract, filter, nextFrom, nextToBlock, originalBlock);
    }
  } catch (err) {
    if (err.message.includes('query returned more')) {
      const midBlock = (fromBlock + toBlock) / 2;
      return fetchQuery(contract, filter, midBlock, toBlock, originalBlock);
    } else {
      throw(err);
    }
  }
}

/// ETH balance is used for transfer out when amount is negative
export async function sourceTokens({
  dm,
  amount: amount_,
  asset,
  address,
  blacklist,
  blockNumber,
}: SourceTokenParameters) {
  let amount = BigNumber.from(amount_);
  if (amount.isZero()) {
    return;
  } else if (amount.isNegative()) {
    await removeTokens(dm, amount.abs(), asset, address);
    return;
  }

  // A bridged token nobody has bridged in size can't be sourced from a holder: when the
  // whole supply is short of what we need, searching for one is provably futile, so mint
  // straight away rather than paying for a full log scan first.
  const totalSupply = await new Contract(asset, erc20, dm.hre.ethers.provider).totalSupply();
  if (totalSupply.lt(amount)) {
    const authority = await findMintAuthority(dm, asset);
    if (authority) {
      await mintTokens(dm, authority, asset, address, amount);
      return;
    }
  }

  try {
    await addTokens(dm, amount, asset, address, [address].concat(blacklist), blockNumber);
  } catch (err) {
    // `fetchQuery` throws an Error, `addTokens` throws a bare string; either way the
    // holder search is exhausted, so fall back to minting where the token allows it.
    const authority = await findMintAuthority(dm, asset);
    if (!authority) throw err;
    debug(`Source Tokens: holder search failed for ${asset}, minting instead`, err);
    await mintTokens(dm, authority, asset, address, amount);
  }
}

// Bridged L2 tokens gate `mint` on the bridge/gateway that owns them, and each stack names
// that getter differently. They also all sit behind a proxy (clone, transparent, beacon),
// so the selector-in-bytecode probe used elsewhere can't see the implementation — these
// have to be probed by eth_call.
const MINT_AUTHORITY_GETTERS = ['gateway()', 'bridge()', 'BRIDGE()', 'l2Bridge()'];

// keyed by network + token; the minting authority is immutable for these tokens
const mintAuthorityCache = new Map<string, string | null>();

// The probe is a static call, so the credited account is irrelevant — but it must not be
// the zero address, which ERC20._mint rejects before the access check is even reached.
const MINT_PROBE_RECIPIENT = '0x000000000000000000000000000000000000dEaD';

/// The address allowed to `mint(address,uint256)` on `asset`, or null if there is none
export async function findMintAuthority(
  dm: DeploymentManager,
  asset: string
): Promise<string | null> {
  const key = `${dm.network}:${asset.toLowerCase()}`;
  if (mintAuthorityCache.has(key)) return mintAuthorityCache.get(key);

  const provider = dm.hre.ethers.provider;
  const mintData = erc20.encodeFunctionData('mint', [MINT_PROBE_RECIPIENT, 1]);

  let authority: string | null = null;
  for (const signature of MINT_AUTHORITY_GETTERS) {
    try {
      const result = await provider.call({
        to: asset,
        data: utils.id(signature).slice(0, 10),
      });
      // a bare address, not a fallback returning something else shaped like one
      if (result.length !== 66) continue;
      if (result.slice(2, 26) !== '0'.repeat(24)) continue;

      const candidate = utils.getAddress('0x' + result.slice(26));
      if (candidate === constants.AddressZero) continue;

      // `from` passes the onlyGateway/onlyBridge check, so this also rejects tokens whose
      // mint entrypoint is named differently (e.g. Arbitrum's `bridgeMint`)
      await provider.call({ from: candidate, to: asset, data: mintData });
      authority = candidate;
      break;
    } catch (e) {
      continue;
    }
  }

  mintAuthorityCache.set(key, authority);
  return authority;
}

async function mintTokens(
  dm: DeploymentManager,
  authority: string,
  asset: string,
  recipient: string,
  amount: BigNumber
) {
  debug(`Source Tokens: minting ${amount} of ${asset} via ${authority}`);
  const tokenContract = new Contract(asset, erc20, dm.hre.ethers.provider);
  const balanceBefore = await tokenContract.balanceOf(recipient);

  await dm.hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [authority],
  });
  // zero gas price keeps this working without topping up the real gateway's ETH balance
  await dm.hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0']);
  const signer = await dm.getSigner(authority);
  await tokenContract.connect(signer).mint(recipient, amount, { gasPrice: 0 });
  await dm.hre.network.provider.request({
    method: 'hardhat_stopImpersonatingAccount',
    params: [authority],
  });

  const balanceAfter = await tokenContract.balanceOf(recipient);
  if (!balanceAfter.sub(balanceBefore).eq(amount)) {
    throw new Error(
      `Error: minting ${asset} via ${authority} credited ${balanceAfter.sub(balanceBefore)}, expected ${amount}`
    );
  }
}

async function removeTokens(
  dm: DeploymentManager,
  amount: BigNumber,
  asset: string,
  address: string
) {
  let ethers = dm.hre.ethers;
  await dm.hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [address],
  });
  let signer = await dm.getSigner(address);
  let tokenContract = new ethers.Contract(asset, erc20, signer);
  let currentBalance = await tokenContract.balanceOf(address);
  if (currentBalance.lt(amount)) throw 'Error: Insufficient address balance';
  await dm.hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0']);
  await tokenContract.transfer('0x0000000000000000000000000000000000000001', amount, { gasPrice: 0 });
  await dm.hre.network.provider.request({
    method: 'hardhat_stopImpersonatingAccount',
    params: [address],
  });
}

async function addTokens(
  dm: DeploymentManager,
  amount: BigNumber,
  asset: string,
  address: string,
  blacklist: string[],
  block?: number,
  offsetBlocks?: number,
  MAX_SEARCH_BLOCKS = 40000,
  BLOCK_SPAN = 2048
) {
  if (asset.toLowerCase() === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') { // USDC
    BLOCK_SPAN = 128;
  }

  if(dm.network === 'ronin') {
    MAX_SEARCH_BLOCKS = 500;
  }
  // XXX we should really take min of current balance and amount and transfer that much
  let ethers = dm.hre.ethers;
  block = block ?? (await ethers.provider.getBlockNumber());
  let tokenContract = new ethers.Contract(asset, erc20, ethers.provider);
  let filter = tokenContract.filters.Transfer();
  let { recentLogs, blocksDelta } = await fetchQuery(
    tokenContract,
    filter,
    block - BLOCK_SPAN - (offsetBlocks ?? 0),
    block - (offsetBlocks ?? 0),
    block,
    MAX_SEARCH_BLOCKS,
    BLOCK_SPAN
  );
  let holder = await searchLogs(recentLogs, amount, tokenContract, ethers, blacklist);
  if (holder) {
    await dm.hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [holder],
    });
    let impersonatedSigner = await dm.getSigner(holder);
    let impersonatedProviderTokenContract = tokenContract.connect(impersonatedSigner);
    await dm.hre.network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0']);
    await impersonatedProviderTokenContract.transfer(address, amount, { gasPrice: 0 });
    await dm.hre.network.provider.request({
      method: 'hardhat_stopImpersonatingAccount',
      params: [holder],
    });
  } else {
    if ((offsetBlocks ?? 0) > MAX_SEARCH_BLOCKS) throw "Error: Couldn't find sufficient tokens";
    await addTokens(dm, amount, asset, address, blacklist, block, (offsetBlocks ?? 0) + blocksDelta);
  }
}

async function searchLogs(
  recentLogs: Event[],
  amount: BigNumber,
  tokenContract: Contract,
  ethers: HardhatRuntimeEnvironment['ethers'],
  blacklist?: string[],
  logOffset?: number,
): Promise<string | null> {
  let addresses = new Set<string>();
  if ((logOffset ?? 0) >= recentLogs.length) return null;
  recentLogs.slice(logOffset ?? 0, (logOffset ?? 0) + 20).map((log) => {
    addresses.add(log.args![0]);
    addresses.add(log.args![1]);
  });
  let balancesDict = new Map<string, BigNumber>();
  await Promise.all([
    ...Array.from(addresses).map(async (address) => {
      balancesDict.set(address, await tokenContract.balanceOf(address));
    })
  ]);
  for (let address of blacklist) {
    balancesDict.delete(address);
  }
  let balances = Array.from(balancesDict.entries());
  if (balances.length > 0) {
    let max = getMaxEntry(balances);
    if (max[1].gte(amount)) {
      return max[0];
    }
  }
  return searchLogs(recentLogs, amount, tokenContract, ethers, blacklist, (logOffset ?? 0) + 20);
}
