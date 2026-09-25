# Contract Import

## Problem

Almost every contract this repo interacts with was deployed by somebody else - WETH on Base, the L2 standard bridge, a Chainlink price feed, the governor, every ERC-20 collateral. Calling `weth.balanceOf(x)` needs that contract's ABI; checking a deployed implementation needs its bytecode. None of it is in this repo.

Contract import is the step that, given only `(network, address)`, pulls that metadata off a block explorer and writes it out as a `BuildFile` - the same shape Hardhat produces for contracts we compile ourselves:

```jsonc
// deployments/base/.contracts/0x4200000000000000000000000000000000000006.json
{
  "contract": "WETH9",
  "version": "v0.5.17+commit.d19bba13",
  "contracts": {
    "contracts/WETH9.sol:WETH9": { "network": …, "address": …, "name": …, "abi": …, "bin": …, "constructorArgs": …, "metadata": … }
  }
}
```

`spider` is what drives it. Starting from `roots.json` it walks outward through `relations.ts`, and each newly discovered address must be imported before its own functions and storage can be read to find the next ones - so import is the inner loop of the entire crawl ([`Spider.ts:84`](../plugins/deployment_manager/Spider.ts#L84), [`DeploymentManager.ts:158`](../plugins/deployment_manager/DeploymentManager.ts#L158)).

## Lookup order

[`fetchContract`](../plugins/deployment_manager/Import.ts#L54), for a given `(network, address)`:

1. **Local cache** - `deployments/{network}/.contracts/{address}.json`. Gitignored, so it is empty on a fresh clone.
2. **Contracts archive** - `DeploymentManager.spider()` bulk-seeds that cache from the [`contracts-archive`](contracts-archive.md) submodule before crawling, so most addresses are already there by the time anything looks them up. `fetchContract` also checks the archive directly per-address (`getArchivedBuildFile`), so a lookup outside a full spider crawl still benefits.
3. **Live fetch** - `importContract` → [`loadContract`](../plugins/import/import.ts#L459), only for what the first two missed.

The sibling `readContract` handles the inverse case: a contract *we* compiled, whose ABI comes from Hardhat artifacts rather than an explorer.

## The live-fetch waterfall

Same order for every network, first success wins:

| # | Source | Request |
| --- | --- | --- |
| 1 | Blockscout V2 | `GET {blockscoutHost}/api/v2/smart-contracts/{address}` |
| 2 | Blockscout V1 (legacy) | `GET {blockscoutHost}/api?module=contract&action=getsourcecode` |
| 3 | Sourcify | `GET sourcify.dev/server/v2/contract/{chainId}/{address}` |
| 4 | Etherscan (V2 unified API) | `GET api.etherscan.io/v2/api?chainid={chainId}&module=contract&action=getsourcecode` |

A source is **skipped**, not attempted-and-failed, when it isn't configured for that
network: no Blockscout host in [`blockscout.ts`](../plugins/import/blockscout.ts)
(`mantle`, `linea` today - no verifiably-working Blockscout instance found for either;
`polygon.blockscout.com` is confirmed working and configured), or no `chainId`
resolvable in `networkConfigs` for Etherscan. Sourcify has no allowlist - every
network is attempted, since its `chainId` is the same one every other source already
uses; a chain or address it doesn't index just fails the same way an unverified one
would.

All four sources return the same shape (`EtherscanData`: `source`, `abi`, `contract`,
`compiler`, `optimized`, `optimizationRuns`, `constructorArgs`), assembled into a
`BuildFile` by one shared `buildContractFromSourceData`.

Bytecode is fetched separately from source, after a source wins: `eth_getCode` over
the network's own RPC first (**so a network's `*_QUICKNODE_LINK` is needed to import
from it, not just to fork it**), then a first-transaction lookup via whichever
explorer family (Blockscout or Etherscan) supplied the source - Sourcify and Etherscan
share the Etherscan-family fallback, since Sourcify doesn't carry transaction history.
Where the creation code ends with the reported constructor arguments, that suffix is
stripped; Sourcify doesn't report them, so that step is skipped on that path.

## Retries and failures

Each source gets **one attempt**, plus **one quick retry** (~2s) on a transient
failure (network error, 5xx, 429) before moving to the next source - a definitive
"not verified" answer (a clean 404, or `ABI: "Contract source code not verified"`)
skips straight to the next source with no retry. Etherscan keeps its own internal
key-rotation-on-retry across every configured `ETHERSCAN_KEY*`, since that's specific
to it having multiple keys at all.

If every configured source for a network fails, `importContract` retries the whole
waterfall **3 times at 10s** - but only when at least one source failed for a
transient reason. If every source came back with a definitive "not verified", that's
treated as the answer and surfaces immediately.

## Adding a network

1. Add its RPC variable to `.env` and `.env.example` - needed for import, not just forking.
2. Make sure it has a `chainId` in `networkConfigs` (`hardhat.config.ts`) - this alone is enough for Sourcify and (with a key) Etherscan.
3. For Blockscout: add the host to all three maps in [`blockscout.ts`](../plugins/import/blockscout.ts).
4. For Etherscan: add a key to `getEtherscanApiKey` in [`etherscan.ts`](../plugins/import/etherscan.ts) if the network doesn't already share `ETHERSCAN_KEY`.

No allowlist to maintain for Sourcify - it's attempted automatically once step 2 is done.
