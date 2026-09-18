// Reads a live Comet market and shapes it into a bench preset.
//
// Uses @stas-b-woof/compound for the deployment registry and the typed contract
// reads. Everything is read at ONE pinned block, so a preset is a coherent
// snapshot rather than a set of values from drifting heights.

import { makeTransport, blockParam, CHAIN_NAMES, ENDPOINTS } from './rpc.mjs';

const IDX_SCALE = 10n ** 15n;        // BASE_INDEX_SCALE
const SECONDS_PER_YEAR = 31_536_000n;

// The SDK's barrel pulls viem's signing tree; these four subpaths do not.
let sdk;
async function loadSdk() {
    if (!sdk) {
        const [client, protocol, abis, deployments] = await Promise.all([
            import('@stas-b-woof/compound/client'),
            import('@stas-b-woof/compound/protocol'),
            import('@stas-b-woof/compound/abis'),
            import('@stas-b-woof/compound/deployments'),
        ]);
        sdk = { ...client, ...protocol, ...abis, ...deployments };
    }
    return sdk;
}

async function clientFor(chainId) {
    const { defineClient } = await loadSdk();
    const send = makeTransport(chainId);
    const client = defineClient({
        rpc: {
            ethCall: ({ to, data, block }) => send('eth_call', [{ to, data }, blockParam(block)]),
            ethBlockNumber: async () => BigInt(await send('eth_blockNumber', [])),
        },
    });
    return { client, host: send.host, send };
}

/** Every market the SDK knows about, on the chains this server can reach. */
export async function listMarkets() {
    const { getDeployedChains, getMarketsPerChain, resolveMarketSymbol } = await loadSdk();
    return getDeployedChains()
        .filter(chainId => (ENDPOINTS[chainId] ?? []).some(Boolean))
        .map(chainId => ({
            chainId,
            chain: CHAIN_NAMES[chainId] ?? String(chainId),
            markets: getMarketsPerChain(chainId).map(address => ({
                address,
                symbol: resolveMarketSymbol(chainId, address) ?? 'unknown',
            })),
        }))
        .filter(c => c.markets.length > 0);
}

/**
 * Read one market and return a preset record.
 *
 * The rate curve is stored per YEAR because that is what the form holds, and the
 * bench divides by SECONDS_PER_YEAR exactly as the constructor does. Multiplying
 * the on-chain per-second value back up round-trips without loss — but note the
 * result can differ from the per-year number governance voted on, because the
 * chain only ever kept the floored per-second one.
 */
export async function fetchMarketPreset(chainId, market) {
    const { client, host, send } = await clientFor(chainId);
    const { makeContractReader, readContract, cometAbi, tokenAbi, resolveMarketSymbol } = await loadSdk();

    const block = await client.rpc.ethBlockNumber();
    const read = makeContractReader(client, cometAbi, market);
    const at = (fn) => read(fn, [], block);

    // The header, not the wall clock: `lastAccrualTime` is a chain timestamp, so
    // the gap the bench has to settle is only meaningful against another one.
    const header = await send('eth_getBlockByNumber', [blockParam(block), false]);
    const blockTime = BigInt(header.timestamp);

    const [
        totals, decimals, baseToken, symbol,
        supplyKink, sBase, sLow, sHigh,
        borrowKink, bBase, bLow, bHigh,
        baseMinForRewards, supplySpeed, borrowSpeed,
    ] = await Promise.all([
        at('totalsBasic'), at('decimals'), at('baseToken'), at('symbol'),
        at('supplyKink'), at('supplyPerSecondInterestRateBase'),
        at('supplyPerSecondInterestRateSlopeLow'), at('supplyPerSecondInterestRateSlopeHigh'),
        at('borrowKink'), at('borrowPerSecondInterestRateBase'),
        at('borrowPerSecondInterestRateSlopeLow'), at('borrowPerSecondInterestRateSlopeHigh'),
        at('baseMinForRewards'), at('baseTrackingSupplySpeed'), at('baseTrackingBorrowSpeed'),
    ]);

    // The bench's `reserves` field feeds cash = R + S − B, and cash must come out
    // as the token balance. Derive R from that identity with the STORED indices,
    // the same ones the model will use, so the round trip is exact.
    const balance = await readContract(client, baseToken, tokenAbi, 'balanceOf', [market], block);
    const S = totals.totalSupplyBase * totals.baseSupplyIndex / IDX_SCALE;
    const B = totals.totalBorrowBase * totals.baseBorrowIndex / IDX_SCALE;
    const reserves = balance - S + B;

    const perYear = (perSecond) => (perSecond * SECONDS_PER_YEAR).toString();
    const underlying = resolveMarketSymbol(chainId, market) ?? symbol;
    const chain = CHAIN_NAMES[chainId] ?? String(chainId);

    return {
        id: `m-${chainId}-${market.toLowerCase()}`,
        kind: 'market',
        chainId,
        chain,
        market,
        symbol: underlying,
        name: `${symbol} · ${chain}`,
        values: {
            decimals: String(decimals),
            totalSupplyBase: totals.totalSupplyBase.toString(),
            totalBorrowBase: totals.totalBorrowBase.toString(),
            bsi: totals.baseSupplyIndex.toString(),
            bbi: totals.baseBorrowIndex.toString(),
            tsi: totals.trackingSupplyIndex.toString(),
            tbi: totals.trackingBorrowIndex.toString(),
            reserves: reserves.toString(),
            supplyKink: supplyKink.toString(),
            sBaseY: perYear(sBase),
            sLowY: perYear(sLow),
            sHighY: perYear(sHigh),
            borrowKink: borrowKink.toString(),
            bBaseY: perYear(bBase),
            bLowY: perYear(bLow),
            bHighY: perYear(bHigh),
            baseMinForRewards: baseMinForRewards.toString(),
            trackSupplySpeed: supplySpeed.toString(),
            trackBorrowSpeed: borrowSpeed.toString(),
            // Seconds of interest the chain already owes: storage is current as
            // of lastAccrualTime, the read happened at blockTime, and every
            // view function bridges the difference on the fly (:397). Part of
            // the snapshot, not of the viewer's plan — so it ships in `values`.
            pendingSecs: (blockTime - BigInt(totals.lastAccrualTime)).toString(),
            // Nothing about the observation window or the simulated actions lives
            // here: those are the viewer's, and selecting another market must not
            // silently reset them.
        },
        source: {
            block: block.toString(),
            blockTime: blockTime.toString(),
            lastAccrualTime: totals.lastAccrualTime,
            balance: balance.toString(),
            rpc: host(),
            refreshedAt: new Date().toISOString(),
        },
    };
}
