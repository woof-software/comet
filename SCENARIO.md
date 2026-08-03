# Scenarios

Scenarios are high-level property and ad-hoc tests for the Comet protocol. To run and check scenarios:

`npx hardhat scenario`

## Running Scenarios

You can run scenarios against a given base as:

`npx hardhat scenario --bases development,linea,mainnet`

You can run scenarios from a specific file (or files matching a glob pattern) with `--glob`:

`npx hardhat scenario --glob 'scenario/AllowBySigScenario.ts'`

`npx hardhat scenario --glob 'scenario/AllowBySigScenario.ts' --bases development`

The default is `scenario/**.ts` (all scenario files). The pattern is passed to [fast-glob](https://github.com/mrmlnc/fast-glob); quote it in the shell so paths and braces are not expanded by bash. Combine with `--bases` to limit which deployment environments are used.

You can run spider persistently first if you wish:

`npx hardhat scenario --spider`

Note: if you want to speed up, probably better to first:

`npx hardhat deploy --simulate --overwrite`

You can change the number of workers:

`npx hardhat scenario --workers 4`

## Adding New Scenarios

To add a new scenario, add to `scenario/`, e.g.

**scenario/NewToken.ts**

```ts
import { scenario } from './context/CometContext';
import { expect } from 'chai';
import { BigNumber } from 'ethers';
import { World } from '../plugins/scenario';

scenario('Comet#allow > allows a user to authorize a manager', { upgrade: true }, async ({ comet, actors }) => {
  const { albert, betty } = actors;

  await albert.allow(betty, true);

  expect(await comet.isAllowed(albert.address, betty.address)).to.be.true;
});
```

For more information, see the Scenarios Hardhat plugin.

## Constraints

### Modern Constraint

**requirements**: `{ upgrade: true }`

This constraint is to indicate that all deployments must use the most recent version of the Comet contract. For instance, say your scenario uses a feature that's not available on certain test-nets (or mainnet), then you would otherwise not be able to run the scenario on those networks. But if you include `{upgrade: true}` in your constraint requirements, the scenario will deploy a new Comet instance and upgrade the proxy to that before running the scenario. Note: currently this simply uses the `deploy.ts` script for deployment.
