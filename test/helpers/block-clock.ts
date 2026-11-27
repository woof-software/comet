import type { EIP1193Provider, RequestArguments } from 'hardhat/types';

/**
 * Opt-in deterministic block clock for the in-process `hardhat` network.
 */

/** Seconds forced between consecutive blocks, or null while the wrapper is inert (stock Hardhat). */
let blockDelta: number | null = null;

/** Set by a test calling evm_setNextBlockTimestamp/evm_increaseTime; consumed by the next mined block. */
let manualTimestampPending = false;

/**
 * Pins every subsequent block to exactly `parent + delta` seconds, removing the system clock from the equation.
 * @param delta Seconds between consecutive blocks; must be >= 1.
 */
export function enableBlockDelta(delta = 1): void {
  if (!Number.isInteger(delta) || delta < 1) {
    // A delta of 0 would need `allowBlocksWithSameTimestamp: true` on the hardhat network, which changes the
    // DEFAULT (wrapper-off) behaviour for every suite. Keeping the default stock is worth more than a frozen
    // clock: use delta 1 and zero the fixture's interest rates if a test must see no accrual at all.
    throw new Error(`enableBlockDelta: delta must be an integer >= 1, got ${delta}`);
  }
  blockDelta = delta;
  manualTimestampPending = false;
}

/** Hands the clock back to Hardhat: the wrapper becomes a pass-through again. */
export function disableBlockDelta(): void {
  blockDelta = null;
  manualTimestampPending = false;
}

/** The active delta, or null when the wrapper is inert. */
export function getBlockDelta(): number | null {
  return blockDelta;
}

/**
 * Enables the deterministic clock for the enclosing describe block and restores stock behaviour afterwards.
 * @param delta Seconds between consecutive blocks; must be >= 1.
 */
export function useBlockDelta(delta = 1): void {
  before(() => enableBlockDelta(delta));
  after(() => disableBlockDelta());
}

/**
 * Wraps a provider so mined blocks honour the active delta. Registered once from hardhat.config.ts; a no-op
 * for every network other than the in-process one, and a pass-through until a test enables a delta.
 * @param provider The provider to wrap.
 * @param network The network the provider belongs to.
 * @return The wrapped provider (or the original, for non-hardhat networks).
 */
export function wrapProviderWithBlockDelta<T extends EIP1193Provider>(provider: T, network: string): T {
  // Only the in-process network: live and forked RPCs have a real clock we must not fake.
  if (network !== 'hardhat') return provider;

  const pinNextTimestamp = async (delta: number) => {
    const block = (await provider.request({
      method: 'eth_getBlockByNumber',
      params: ['latest', false],
    })) as { timestamp: string } | null;
    if (block == null) return;
    const next = BigInt(block.timestamp) + BigInt(delta);
    await provider.request({ method: 'evm_setNextBlockTimestamp', params: [Number(next)] });
  };

  const request = async (args: RequestArguments) => {
    const delta = blockDelta;
    // Inert unless a test opted in — stock Hardhat behaviour.
    if (delta === null) return provider.request(args);

    const method = args.method;

    if (method === 'evm_setNextBlockTimestamp' || method === 'evm_increaseTime') {
      manualTimestampPending = true;
      return provider.request(args);
    }
    // A reset or revert rewinds the chain, so any pending manual timestamp no longer applies.
    if (method === 'hardhat_reset' || method === 'evm_revert') {
      manualTimestampPending = false;
      return provider.request(args);
    }

    const minesABlock =
      method === 'eth_sendTransaction' || method === 'eth_sendRawTransaction' || method === 'evm_mine';
    if (minesABlock) {
      const paramsLength = Array.isArray(args.params) ? args.params.length : 0;
      const minesWithOwnTimestamp = method === 'evm_mine' && paramsLength > 0;
      if (manualTimestampPending) {
        manualTimestampPending = false;
      } else if (!minesWithOwnTimestamp) {
        await pinNextTimestamp(delta);
      }
    }
    return provider.request(args);
  };

  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === 'request') return request;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
