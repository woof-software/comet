import axios from 'axios';
import { ethers } from 'hardhat';
import { BigNumber, BigNumberish } from 'ethers';

/**
 * Helper for getting swap qoute from 1inch Aggregation API (v6) and preparing the calldata that
 * `OneInchV6CoreAdapter._coreSwap` expects as `swapData`.
 *
 * Note: Requires the env var `ONEINCH_API_KEY` (1inch developer-portal key). Quotes are computed against
 * mainnet head, so the test fork should be pinned at (or very close to) the latest block.
 */

export const ONEINCH_V6_SWAP_SELECTOR = ethers.utils
  .id('swap(address,(address,address,address,address,uint256,uint256,uint256),bytes)')
  .slice(0, 10);

export const ONEINCH_V6_SWAP_ABI =
  'function swap(address executor, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc, bytes data) returns (uint256 returnAmount, uint256 spentAmount)';

export const ONEINCH_V6_ROUTER_MAINNET = '0x111111125421cA6dc452d289314280a0f8842A65';

const ONEINCH_API_BASE = 'https://api.1inch.dev/swap/v6.0';

export interface OneInchSwapParams {
  // EVM chain id the swap executes on (mainnet = 1).
  chainId: number;
  // Source (collateral) token address.
  src: string;
  // Destination (Comet base) token address.
  dst: string;
  // Input amount in src collateral units, as a decimal string.
  amount: string;
  // Caller/receiver of the swap. */
  from: string;
  // Slippage tolerance in percent (e.g. 1 for 1%).
  slippage: number;
  // Optional comma-separated liquidity-source whitelist (e.g. 'UNISWAP_V3,SUSHI').
  protocols?: string;
}

export interface OneInchSwapQuote {
  // Router calldata to pass as swapData to adapter.swap(collateral, swapData).
  data: string;
  // Expected output amount in `dst` base units (decimal string).
  dstAmount: string;
  // Router the calldata targets, should be equal to the Dex Adapter's address.
  to: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


// Calls the 1inch v6 `/swap` endpoint and returns its raw calldata.
// Retries on errors and throws if no valid response wa received.
export async function requestRaw1inchSwap(params: OneInchSwapParams): Promise<OneInchSwapQuote> {
  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) {
    throw new Error('ONEINCH_API_KEY is not set — required to fetch 1inch swap calldata');
  }

  const url = `${ONEINCH_API_BASE}/${params.chainId}/swap`;
  const query = {
    src: params.src,
    dst: params.dst,
    amount: params.amount,
    from: params.from,
    origin: params.from,
    receiver: params.from,
    slippage: params.slippage,
    disableEstimate: true, // skip on-chain balance/allowance checks (adapter isn't funded on real chain)
    allowPartialFill: false,
    // Force plain transferFrom calldata against the granted allowance.
    usePermit2: false,
    // When set, restrict routing to the whitelisted AMMs.
    ...(params.protocols ? { protocols: params.protocols } : {}),
  };
  const headers = { Authorization: `Bearer ${apiKey}`, accept: 'application/json' };

  const maxAttempts = 5;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { data } = await axios.get(url, { params: query, headers });
      return { data: data.tx.data, dstAmount: data.dstAmount, to: data.tx.to };
    } catch (err) {
      lastErr = err;
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 429 && attempt < maxAttempts) {
        await sleep(1500 * attempt); // linear backoff for rate limiting
        continue;
      }
      if (axios.isAxiosError(err) && err.response) {
        throw new Error(
          `1inch API error (${err.response.status}): ${JSON.stringify(err.response.data)}`
        );
      }
      throw err;
    }
  }
  throw lastErr;
}


// Fetches swap quote from 1Inch API and throws if it returned an unsupported function.
// List of 1Inch V6 functions, supported by OneInchV6Adapter: swap().
export async function fetch1inchSwapData(params: OneInchSwapParams): Promise<string> {
  const quote = await requestRaw1inchSwap(params);
  const selector = quote.data.slice(0, 10).toLowerCase();
  if (selector !== ONEINCH_V6_SWAP_SELECTOR) {
    throw new Error(
      `1inch returned calldata with selector ${selector}, but the adapter only accepts ` +
        `${ONEINCH_V6_SWAP_SELECTOR} (IOneInchV6.swap). Try a different token pair/amount or a ` +
        `more liquid route; 1inch sometimes routes through unoswap-style functions.`
    );
  }
  return quote.data;
}


// Fetches and re-encodes 1inch swap calldata with a different minReturnAmount.
export async function withCustomMinReturn(params: OneInchSwapParams, minReturn: BigNumberish): Promise<string> {
  const quote = await fetch1inchSwapData(params);
  const iface = new ethers.utils.Interface([ONEINCH_V6_SWAP_ABI]);
  const [executor, desc, data] = iface.decodeFunctionData('swap', quote);
  const newDesc = {
    srcToken: desc.srcToken,
    dstToken: desc.dstToken,
    srcReceiver: desc.srcReceiver,
    dstReceiver: desc.dstReceiver,
    amount: desc.amount,
    minReturnAmount: BigNumber.from(minReturn),
    flags: desc.flags,
  };
  return iface.encodeFunctionData('swap', [executor, newDesc, data]);
}
