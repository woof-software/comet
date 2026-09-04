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

[`fetchContract`](../plugins/deployment_manager/Import.ts#L66), for a given `(network, address)`:

1. **Local cache** - `deployments/{network}/.contracts/{address}.json`. Gitignored, so it is empty on a fresh clone.
2. **Contracts archive** - `DeploymentManager.spider()` bulk-seeds that cache from the [`contracts-archive`](contracts-archive.md) submodule before crawling, so most addresses are already there by the time anything looks them up.
3. **Live fetch** - `importContract`, only for what the first two missed.

The sibling `readContract` handles the inverse case: a contract *we* compiled, whose ABI comes from Hardhat artifacts rather than an explorer.

## Sources per network

Decided by `blockScoutNetworks` in [`Import.ts`](../plugins/deployment_manager/Import.ts#L26):

| Network | Source | Host |
| --- | --- | --- |
| mainnet | Blockscout | `eth.blockscout.com` |
| optimism | Blockscout | `optimism.blockscout.com` |
| base | Blockscout | `base.blockscout.com` |
| arbitrum | Blockscout | `arbitrum.blockscout.com` |
| unichain | Blockscout | `unichain.blockscout.com` |
| scroll | Blockscout | `scrollscan.com` |
| ronin | Blockscout → Sourcify | `explorer.roninchain.com`, then `sourcify.dev` |
| polygon, mantle, linea | Etherscan | `api.etherscan.io/v2/api?chainid=…` |

> **Blockscout replaces Etherscan for the networks above - it is not a first choice with an Etherscan fallback.** If Blockscout is down for `mainnet`, `base`, `arbitrum` or `optimism`, import fails. Ronin is the only network with a second source.

Etherscan goes through the unified V2 API, so the chain is selected by `chainid` rather than a per-chain host. Keys come from `getEtherscanApiKey`, which has a primary key per network and rotates through every configured `ETHERSCAN_KEY*` on retry.

Bytecode is fetched separately from source. On the Blockscout path `getContractCreationCodeFromBlockscout` tries `eth_getCode` over that network's RPC first, then falls back to reading the input of the contract's first transaction - **so a network's `*_QUICKNODE_LINK` is needed to import from it, not just to fork it**. Where the creation code ends with the reported constructor arguments, that suffix is stripped.

## Sourcify fallback

[Sourcify](https://sourcify.dev) is an independent verification database, used where a network's own Blockscout instance has real coverage gaps. It is consulted only for networks in `sourcifyChainIds` - currently **Ronin only** (chain `2020`) - and only once Blockscout has answered without an ABI:

- Blockscout says `Contract source code not verified` → go straight to Sourcify.
- Blockscout returns an otherwise incomplete record → for a network *with* a Sourcify entry, go straight to Sourcify; such records have consistently turned out to be permanent rather than transient, so retrying only burns time. For a network *without* one, retry Blockscout (3×, 2s backing off to 10s) and then fail.

The response is reshaped to match the Etherscan path, including double-wrapping multi-file sources the way Etherscan's `SourceCode` field does. One known gap: Sourcify's creation-time constructor arguments aren't fetched, so on this path the creation code keeps its trailing constructor-args suffix instead of having it stripped. Stored bytecode only - ABI and source are unaffected.

## Retries and failures

`importContract` retries **7 times at 10s**. Two things end it early:

- an error message containing `Contract source code not verified` - a definitive answer, not a hiccup
- retries exhausted

An HTTP error from an explorer (a 500, a rate-limit) is thrown by axios before any source-specific handling runs, so it counts as transient and is retried.

This matters more than it used to. `base.blockscout.com` has been observed returning intermittent `500 Something went wrong.` for addresses that succeed seconds later - roughly half of requests in one September 2026 sample, plausibly rate-limiting under spider's request rate. Four attempts usually ride that out for a single address, but a spider touching dozens of contracts on Base has a good chance of hitting a hard failure, and there is no second source to fall back to.

## Adding a network

1. Add its RPC variable to `.env` and `.env.example` - needed for import, not just forking.
2. For Blockscout: add the host to all three maps in [`blockscout.ts`](../plugins/import/blockscout.ts) and add the network to `blockScoutNetworks`. For Etherscan: make sure it has a `chainId` in `networkConfigs` and a key in `getEtherscanApiKey`.
3. Add a `sourcifyChainIds` entry only if that explorer is known to have verification gaps a second source would fill.
