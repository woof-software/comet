# Contracts Archive

## Problem

`spider` re-fetches every verified contract's source/ABI/bytecode from Etherscan/Blockscout on every fresh checkout, because the build-file cache at `deployments/{network}/.contracts/{address}.json` is gitignored and never persisted. `woof-software/comet-contracts-archive` is a separate public repo that persists those build files outside comet-markets, consumed as a git submodule.

## Repository layout

```
comet-contracts-archive/
  {network}/.contracts/{address}.json   # e.g. base/.contracts/0x0090a563....json
```

Tracked on the `develop` branch for now — temporary, to be switched to `main` once reviewed. Each file is a `BuildFile` — the exact same shape `storeBuildFile` already writes to the local cache (`contract`, `contracts: { [fqn]: { abi, bin, metadata, ... } }`, `version`) — so entries move between the two repos as a plain file copy, no transform.

## Local integration

The archive is checked out as a git submodule at `plugins/import/contracts-archive` (tracking `develop`; not under `cache/`, which is Hardhat's own build-cache directory and gets wiped by `hardhat clean`).

[`seedArchiveCache(cache, network)`](../plugins/deployment_manager/ContractMap.ts#L24) bulk-merges the archive into a network's `Cache` in one pass: `fs.readdir`s `plugins/import/contracts-archive/{network}/.contracts/`, and for every `{address}.json` not already present in `cache` (checked via the existing `getBuildFile`), parses and writes it in with `storeBuildFile`. Malformed entries are logged and skipped rather than failing the run.

[`DeploymentManager.spider()`](../plugins/deployment_manager/DeploymentManager.ts#L454) calls `seedArchiveCache(this.cache, this.network)` once, before crawling starts. Every downstream lookup — `spider`, `scenario:spider`, `deploy`, `migrate` — then just hits the local cache exactly as it did before the archive existed; `Import.ts:fetchContract` itself is untouched (local cache → live fetch, two branches, no archive awareness in the hot path).

`ContractMap.ts` also exports `getArchivedBuildFile(network, address)`, a single-file read straight off the archive on disk. It isn't wired into any lookup path today — `seedArchiveCache` covers every call site — but is available for a future per-address fallback (e.g. `spiderOther`'s cross-deployment lookups) without needing another bulk pass.

## Automation

Two workflows keep the archive — and comet-markets' pin on it — moving forward on their own. They run independently on separate schedules; neither triggers the other.

### [sync-contracts-archive.yaml](../.github/workflows/sync-contracts-archive.yaml)

Cron `0 3 1,15 * *` (~biweekly, 1st & 15th at 03:00 UTC) + `workflow_dispatch`.

1. Checkout with `submodules: recursive`, `yarn install`, `yarn build`.
2. `yarn hardhat scenario:spider` with no `--bases` — spiders every configured market (`env.config.scenario.bases`) concurrently in one call.
3. For every network, diffs `deployments/{network}/.contracts/*.json` against `plugins/import/contracts-archive/{network}/.contracts/`; any file present locally but not in the submodule gets copied in. This is exactly the set spider had to fetch live because the archive didn't have it yet.
4. If anything was copied: inside the submodule checkout, commits on branch `archive-sync/<run-id>`, pushes to `comet-contracts-archive` authenticated as `x-access-token:${CONTRACTS_ARCHIVE_TOKEN}`, opens a PR against `develop` via `gh pr create`, and immediately `gh pr merge --squash --delete-branch` in the same job.

No review gate on that merge — every entry is a verbatim copy of what an explorer already returned for that address, so there's nothing subjective to check. Runs `env`-scoped with the full set of `ETHERSCAN_KEY*`/`*_QUICKNODE_LINK`/`*SCAN_KEY` secrets, same as spidering anywhere else.

### [sync-contracts-archive-submodule.yaml](../.github/workflows/sync-contracts-archive-submodule.yaml)

Cron `0 6 * * 1` (weekly, Monday 06:00 UTC) + `workflow_dispatch`. Runs with `contents: write`, `pull-requests: write`, `issues: write` on the default `GITHUB_TOKEN` — no cross-repo token needed, since it only ever touches comet-markets.

1. `git fetch origin develop` inside the submodule, compare to the currently pinned commit. No difference → job ends, no-op.
2. Difference found → `git checkout` the new commit inside the submodule (bumps the gitlink), `yarn install`, `yarn build`.
3. Runs `yarn lint` and `yarn tsc --noEmit -p .` as two `continue-on-error` steps, so both outcomes are captured regardless of which fails.
4. Both green → commits the bumped gitlink on a standing branch `chore/bump-contracts-archive` (force-pushed each run, so repeated weeks update one PR instead of stacking new ones), opens a PR against `main` if one isn't already open for that branch.
5. Either red → no PR. Instead opens (or comments on, if one's already open) a single tracking issue titled "Archive submodule bump failing checks", deduped via `gh issue list --search`.

The submodule-bump PR is the one point in the whole pipeline that still waits on a human — merging it into `main`.

## Setup

`CONTRACTS_ARCHIVE_TOKEN` — comet-markets repo secret. A classic PAT (`repo` scope; fine-grained wasn't available — the `woof-software` org hasn't opted in to fine-grained PATs for members) under an account with push access to `comet-contracts-archive`. Required by `sync-contracts-archive.yaml` to push the branch, open the PR, and merge it. **Done.**
