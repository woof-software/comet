# Migrations

Migrations are simple scripts which deploy or modify contracts. The goal of migration scripts is to make sure that users can see potential changes that are run prior to creating a governance proposal. This is a "nothing up my sleeve" approach to governance preparation (as in, the magician rolls up his sleeves to show there's nothing there-- so the developer deploys scripts from GitHub to show which code was deployed or run).

## Creating a Migration

To create a new migration, run:

```sh
yarn hardhat gen:migration --network mainnet --deployment usdc my_migration
```

This will create a new file, such as `deployments/mainnet/usdc/migrations/164443237_my_migration.ts` with a base migration script. There are currently two steps to a migration script, but this is likely to change soon:

 1. Prepare: steps used to create artifacts, such as new on-chain contracts. The output from this step is stored (e.g. "NewCometImplementation: 0x...")
 2. Enact: steps used to make these artifacts current, such as upgrading the proxy to the address from the previous step.

## Running a Migration Locally

You can run the preparation for a migration locally via:

```sh
yarn hardhat migrate --network mainnet --deployment usdc --prepare 164443237_my_migration
```

or the enactment via:

```sh
yarn hardhat migrate --network mainnet --deployment usdc --enact 164443237_my_migration
```

or both preparation and enactment via:

```sh
yarn hardhat migrate --network mainnet --deployment usdc --prepare --enact 164443237_my_migration
```

## Simulating a Migration

You can simulate either of the previous steps to see what effect they would have without actually modifying the on-chain state:

```sh
yarn hardhat migrate --network mainnet --deployment usdc --prepare --simulate 164443237_my_migration
```

When simulating a migration, you can also impersonate an address to run the migration as. This can be helpful when trying to test a migration that makes a proposal, which requires an address with enough COMP:

```sh
yarn hardhat migrate --network mainnet --deployment usdc --prepare --simulate --impersonate ADDRESS_TO_IMPERSONATE 164443237_my_migration
```

### Simulating the governance proposal

`--simulate` runs the migration's own steps against a local fork. The two Tenderly flags go a step further and put the *resulting governance proposal* through the real governor — propose, queue and execute — skipping only the vote. Both are used alongside `--enact`, and both need `TENDERLY_USERNAME` and `TENDERLY_ACCESS_KEY` set in your `.env`.

```sh
yarn hardhat migrate --network mainnet --deployment usdc --prepare --enact --tenderly 164443237_my_migration
```

`--tenderly` chains together stateless Tenderly `simulate-bundle` API calls and prints a shareable simulation link for each step.

```sh
yarn hardhat migrate --network mainnet --deployment usdc --prepare --enact --tenderlyVnet 164443237_my_migration
```

`--tenderlyVnet` instead creates a [Tenderly Virtual TestNet](https://docs.tenderly.co/virtual-testnets) — a persistent, shareable fork — and runs `propose()`, `queue()` and `execute()` on it as real transactions. Only the vote is skipped, by writing the `forVotes` tally straight into governor storage. The run prints the Virtual TestNet's public RPC URL and dashboard link, so anyone can inspect the resulting state for themselves.

If your Tenderly account or access token can't create Virtual TestNets programmatically, create one from the Tenderly dashboard and paste its **Admin RPC URL** into either variable:

- `TENDERLY_VNET_RPC_URL` — used for every network
- `TENDERLY_VNET_RPC_URL_<NETWORK>` — e.g. `TENDERLY_VNET_RPC_URL_BASE`; takes precedence for that network

When one of these is set, the existing Virtual TestNet is reused instead of a new one being created.

### Multichain proposals

If the proposal reaches an L2, the simulation follows it there. After it executes on the governance chain, every bridge message it emitted is relayed to the corresponding L2 and the bridged proposal is executed there. For Arbitrum, Base and Optimism, any L2→L1 token bridging the proposal performs is then simulated back on the governance chain, so reserves seeded from an L2 show up where the migration's `verify` step expects them.

The L2s are discovered from the proposal's own targets, so a proposal that bridges to a single market needs nothing extra. A migration that has to reach a market the proposal doesn't otherwise name can register it explicitly:

```ts
const opDm = await deploymentManager.addBridgedDeploymentManager('optimism', 'weth', opHre);
```

Under `--tenderlyVnet`, each L2 involved gets its own Virtual TestNet, and the relay runs against that.

## Running a Migration in GitHub

The preferred way to run a migration is in GitHub, via manual workflow dispatch. The goal of this approach is that it's clear to everyone the exact code that ran, which affords less opportunity for "I'm looking at \<CODE X\>, but what was deployed was actually \<CODE Y\>." Look at "Prepare Migration" and "Enact Migration" dispatches in GitHub Actions in this repo (or any fork).

## Migration Artifacts

After preparation, a migration stores some artifacts under `deployments/mainnet/usdc/artifacts/164443237_my_migration.json`. These will be loaded and can be referenced in the enact step of that migration.

## Testing Migrations

Migrations can be tested using Comet's [scenario framework](https://github.com/compound-finance/comet/blob/main/SCENARIO.md).

Migrations that have been staged to a branch but not enacted yet will automatically be picked up and run by the scenarios framework (in the [MigrationConstraint](https://github.com/compound-finance/comet/blob/main/scenario/constraints/MigrationConstraint.ts)). This ensures that any new migrations are checked against all existing scenarios and any issues with a migration can be proactively caught. Remember, migrations **need to be staged in git** before it can be picked up by scenarios.

Migrations should also include a `verify` function to check that the correct state-changes are made by it. This `verify` block is also run as part of the scenario framework.

## Process for Managing Migrations

Once a migration has been created, the next step is to create a PR on GitHub and follow the process to get it reviewed, enacted, and merged:

 1. Open up a PR with the migration script.
 2. Get it reviewed and approved by others.
 3. Prepare/enact the migration in GitHub via [manual workflow dispatch](#running-a-migration-in-github).
 4. If the migration creates a governance proposal on-chain, then **wait** until the proposal either executes or fails before merging the PR. Otherwise, just merge the PR.

> Note: If the governance proposal fails, make sure that no changes to roots are included in the PR when merging.
