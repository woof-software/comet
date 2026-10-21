import { expect } from 'chai';
import { ethers } from 'ethers';
import { CometContext, scenario } from '../context/CometContext';
import { fundAccount, servicePatch2 } from '../utils';
import { deployTimelock } from './shared';

// The governor of the Configurator itself, which every governor-only function checks the caller against

scenario(
  'Configurator#transferGovernor transfers the governor role to another address if called by governor',
  {},
  async ({ configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const newGovernor = await deployTimelock(context);
    await configurator.connect(admin.signer).transferGovernor(newGovernor);

    expect(await configurator.governor()).to.be.equal(newGovernor);
  }
);

scenario(
  'Configurator#transferGovernor new governor can call governor-only methods',
  {},
  async ({ configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    const newGovernor = await deployTimelock(context);
    const newGovernorSigner = await context.world.impersonateAddress(newGovernor);
    await fundAccount(context.world, newGovernorSigner);

    await configurator.connect(admin.signer).transferGovernor(newGovernor);
    await configurator.connect(newGovernorSigner).transferGovernor(admin.address);

    expect(await configurator.governor()).to.be.equal(admin.address);
  }
);

scenario(
  'Configurator#transferGovernor transfers the governor role to the governor itself',
  {},
  async ({ configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    await configurator.connect(admin.signer).transferGovernor(admin.address);

    expect(await configurator.governor()).to.be.equal(admin.address);
  }
);

scenario(
  'Configurator#transferGovernor reverts if called by non-governor',
  {},
  async ({ configurator, actors }, context) => {
    const { albert } = actors;
    const newGovernor = await deployTimelock(context);

    await expect(
      configurator.connect(albert.signer).transferGovernor(newGovernor)
    ).to.be.revertedWithCustomError(configurator, 'Unauthorized');
  }
);

scenario(
  'Configurator#transferGovernor reverts if new governor is zero address',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ configurator, actors }) => {
    const { admin } = actors;
    await fundAccount(admin.context.world, admin);

    await expect(
      configurator.connect(admin.signer).transferGovernor(ethers.constants.AddressZero)
    ).to.be.revertedWithCustomError(configurator, 'InvalidAddress');
  }
);
