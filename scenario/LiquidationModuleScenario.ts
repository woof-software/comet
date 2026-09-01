import { expect } from 'chai';
import { constants } from 'ethers';
import { LiquidationModule__factory } from '../build/types';
import { scenario } from './context/CometContext';
import {
  fundAccount,
  getLiquidationModuleAddress,
  hasModule,
} from './utils';

/*//////////////////////////////////////////////////////////////
                              ABSORB
//////////////////////////////////////////////////////////////*/

scenario(
  'LiquidationModule#absorb > reverts when caller is not Comet',
  { filter: async (context) => await hasModule(context) },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );

    expect(await module.comet()).to.equal(comet.address);
    expect(albert.address).to.not.equal(comet.address);
    await expect(module.connect(albert.signer).absorb(albert.address, betty.address)).to.be.revertedWithCustomError(module, 'OnlyComet');
  }
);

/*//////////////////////////////////////////////////////////////
                       DEX ROUTE PAUSE
//////////////////////////////////////////////////////////////*/

scenario(
  'LiquidationModule#setDexRoutePaused > DAO can pause the DEX route',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    // sanity check
    expect(await module.dexRoutePaused()).to.be.false;

    await module.connect(dao).setDexRoutePaused(true);
    
    expect(await module.dexRoutePaused()).to.be.true;
  }
);

scenario(
  'LiquidationModule#setDexRoutePaused > non-DAO Pauser can pause the DEX route',
  { filter: async (context) => await hasModule(context) },
  async ({ actors, dao }, context, world) => {
    const { charles } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const pauserRole = await module.PAUSER_ROLE();
    await fundAccount(world, charles);
    await module.connect(dao).grantRole(pauserRole, charles.address);

    // sanity check
    expect(await module.dexRoutePaused()).to.be.false;

    await module.connect(charles.signer).setDexRoutePaused(true);
    
    expect(await module.dexRoutePaused()).to.be.true;
  }
);

scenario(
  'LiquidationModule#setDexRoutePaused > DAO can unpause the DEX route',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    await module.connect(dao).setDexRoutePaused(true);

    // sanity check
    expect(await module.dexRoutePaused()).to.be.true;

    await module.connect(dao).setDexRoutePaused(false);
    
    expect(await module.dexRoutePaused()).to.be.false;
  }
);

scenario(
  'LiquidationModule#setDexRoutePaused > non-DAO Pauser can unpause the DEX route',
  { filter: async (context) => await hasModule(context) },
  async ({ actors, dao }, context, world) => {
    const { charles } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const pauserRole = await module.PAUSER_ROLE();
    await fundAccount(world, charles);
    await module.connect(dao).grantRole(pauserRole, charles.address);
    await module.connect(dao).setDexRoutePaused(true);

    // sanity check
    expect(await module.dexRoutePaused()).to.be.true;

    await module.connect(charles.signer).setDexRoutePaused(false);
    
    expect(await module.dexRoutePaused()).to.be.false;
  }
);

scenario(
  'LiquidationModule#setDexRoutePaused > reverts when caller is not a Pauser',
  { filter: async (context) => await hasModule(context) },
  async ({ actors }, context, world) => {
    const { albert } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const pauserRole = await module.PAUSER_ROLE();

    expect(await module.hasRole(pauserRole, albert.address)).to.be.false;
    await expect(module.connect(albert.signer).setDexRoutePaused(true)).to.be.revertedWith(
      `AccessControl: account ${albert.address.toLowerCase()} is missing role ${pauserRole.toLowerCase()}`
    );
  }
);

scenario(
  'LiquidationModule#setDexRoutePaused > reverts when DEX route is already unpaused',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );

    expect(await module.dexRoutePaused()).to.be.false;
    await expect(module.connect(dao).setDexRoutePaused(false)).to.be.revertedWithCustomError(module, 'AlreadySet');
  }
);

scenario(
  'LiquidationModule#setDexRoutePaused > reverts when DEX route is already paused',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    await module.connect(dao).setDexRoutePaused(true);

    expect(await module.dexRoutePaused()).to.be.true;
    await expect(module.connect(dao).setDexRoutePaused(true)).to.be.revertedWithCustomError(module, 'AlreadySet');
  }
);

/*//////////////////////////////////////////////////////////////
                      LIQUIDATION MODE
//////////////////////////////////////////////////////////////*/

scenario(
  'LiquidationModule#liquidationModeToggle > DAO can disable partial liquidation',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );

    expect(await module.partialLiquidationEnabled()).to.be.true;

    await module.connect(dao).liquidationModeToggle(false);
    
    expect(await module.partialLiquidationEnabled()).to.be.false;
  }
);

scenario(
  'LiquidationModule#liquidationModeToggle > non-DAO Pauser can disable partial liquidation',
  { filter: async (context) => await hasModule(context) },
  async ({ actors, dao }, context, world) => {
    const { charles } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const pauserRole = await module.PAUSER_ROLE();
    await fundAccount(world, charles);
    await module.connect(dao).grantRole(pauserRole, charles.address);

    expect(await module.partialLiquidationEnabled()).to.be.true;

    await module.connect(charles.signer).liquidationModeToggle(false);

    expect(await module.partialLiquidationEnabled()).to.be.false;
  }
);

scenario(
  'LiquidationModule#liquidationModeToggle > DAO can enable partial liquidation',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    await module.connect(dao).liquidationModeToggle(false);

    expect(await module.partialLiquidationEnabled()).to.be.false;

    await module.connect(dao).liquidationModeToggle(true);
    
    expect(await module.partialLiquidationEnabled()).to.be.true;
  }
);

scenario(
  'LiquidationModule#liquidationModeToggle > non-DAO Pauser can enable partial liquidation',
  { filter: async (context) => await hasModule(context) },
  async ({ actors, dao }, context, world) => {
    const { charles } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const pauserRole = await module.PAUSER_ROLE();
    await fundAccount(world, charles);
    await module.connect(dao).grantRole(pauserRole, charles.address);
    await module.connect(dao).liquidationModeToggle(false);

    expect(await module.partialLiquidationEnabled()).to.be.false;

    await module.connect(charles.signer).liquidationModeToggle(true);

    expect(await module.partialLiquidationEnabled()).to.be.true;
  }
);

scenario(
  'LiquidationModule#liquidationModeToggle > reverts when caller is not a Pauser',
  { filter: async (context) => await hasModule(context) },
  async ({ actors }, context, world) => {
    const { albert } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const pauserRole = await module.PAUSER_ROLE();

    expect(await module.hasRole(pauserRole, albert.address)).to.be.false;
    await expect(module.connect(albert.signer).liquidationModeToggle(false)).to.be.revertedWith(
      `AccessControl: account ${albert.address.toLowerCase()} is missing role ${pauserRole.toLowerCase()}`
    );
  }
);

scenario(
  'LiquidationModule#liquidationModeToggle > reverts when partial liquidation is already enabled',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );

    expect(await module.partialLiquidationEnabled()).to.be.true;
    await expect(module.connect(dao).liquidationModeToggle(true)).to.be.revertedWithCustomError(module, 'AlreadySet');
  }
);

scenario(
  'LiquidationModule#liquidationModeToggle > reverts when partial liquidation is already disabled',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    await module.connect(dao).liquidationModeToggle(false);

    expect(await module.partialLiquidationEnabled()).to.be.false;
    await expect(module.connect(dao).liquidationModeToggle(false)).to.be.revertedWithCustomError(module, 'AlreadySet');
  }
);

/*//////////////////////////////////////////////////////////////
                   INCENTIVE AND SLIPPAGE
//////////////////////////////////////////////////////////////*/

scenario(
  'LiquidationModule#setIncentiveBps > Multisig can update the incentive',
  { filter: async (context) => await hasModule(context) },
  async ({ actors, dao }, context, world) => {
    const { betty } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    // The multisig is a role the DAO hands out; plain AccessControl cannot be asked who holds it.
    await fundAccount(world, betty);
    await module.connect(dao).grantRole(await module.MULTISIG_ROLE(), betty.address);
    const incentiveBefore = await module.incentiveBps();
    const newIncentive = incentiveBefore === 700 ? 600 : 700; // in case when we can accidentally already have wanted incentive

    await module.connect(betty.signer).setIncentiveBps(newIncentive);
    expect(await module.incentiveBps()).to.equal(newIncentive);
  }
);

scenario(
  'LiquidationModule#setIncentiveBps > reverts when caller is not the Multisig',
  { filter: async (context) => await hasModule(context) },
  async ({ actors }, context, world) => {
    const { albert } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const multisigRole = await module.MULTISIG_ROLE();

    expect(await module.hasRole(multisigRole, albert.address)).to.be.false;
    await expect(module.connect(albert.signer).setIncentiveBps(700)).to.be.revertedWith(
      `AccessControl: account ${albert.address.toLowerCase()} is missing role ${multisigRole.toLowerCase()}`
    );
  }
);

scenario(
  'LiquidationModule#setIncentiveBps > DAO cannot update the incentive without Multisig role',
  { filter: async (context) => await hasModule(context) },
  async ({ dao }, context, world) => {
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const multisigRole = await module.MULTISIG_ROLE();

    expect(await module.hasRole(multisigRole, dao.address)).to.be.false;
    await expect(module.connect(dao).setIncentiveBps(700)).to.be.revertedWith(
      `AccessControl: account ${dao.address.toLowerCase()} is missing role ${multisigRole.toLowerCase()}`
    );
  }
);

scenario(
  'LiquidationModule#setIncentiveBps > reverts when incentive exceeds maximum',
  { filter: async (context) => await hasModule(context) },
  async ({ actors, dao }, context, world) => {
    const { betty } = actors;
    const MAX_INCENTIVE = 1_000;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    await fundAccount(world, betty);
    await module.connect(dao).grantRole(await module.MULTISIG_ROLE(), betty.address);

    await expect(module.connect(betty.signer).setIncentiveBps(MAX_INCENTIVE + 1)).to.be.revertedWithCustomError(module, 'InvalidIncentiveBps');
  }
);

scenario(
  'LiquidationModule constructor > reverts when initial incentive exceeds maximum',
  { filter: async (context) => await hasModule(context) },
  async ({ actors }, context, world) => {
    const { albert, betty, charles } = actors;
    const MAX_INCENTIVE = 1_000;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const scenarioEthers = world.deploymentManager.hre.ethers;
    const [deployer] = await scenarioEthers.getSigners();
    await fundAccount(world, deployer);
    const LiquidationModuleFactory = (await scenarioEthers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    const deployTransaction = LiquidationModuleFactory.getDeployTransaction(
      await module.dexAdapter(),
      betty.address,
      [albert.address],
      [charles.address],
      MAX_INCENTIVE + 1
    );

    await expect(deployer.sendTransaction(deployTransaction)).to.be.revertedWithCustomError(module, 'InvalidIncentiveBps');
  }
);

scenario(
  'LiquidationModule#setSlippageBps > Multisig can update adapter slippage',
  { filter: async (context) => await hasModule(context) },
  async ({ actors, dao }, context, world) => {
    const { betty } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    await fundAccount(world, betty);
    await module.connect(dao).grantRole(await module.MULTISIG_ROLE(), betty.address);
    const scenarioEthers = world.deploymentManager.hre.ethers;
    const adapter = new scenarioEthers.Contract(
      await module.dexAdapter(),
      ['function slippageBps() view returns (uint16)'],
      scenarioEthers.provider
    );
    const slippageBefore = await adapter.slippageBps();
    const newSlippage = slippageBefore === 100 ? 200 : 100; // in case when we can accidentally already have wanted slippage

    // The zero address addresses the global slippage rather than one collateral's override.
    await module.connect(betty.signer).setSlippageBps(newSlippage, constants.AddressZero);

    expect(await adapter.slippageBps()).to.equal(newSlippage);
  }
);

scenario(
  'LiquidationModule#setSlippageBps > reverts when caller is not the Multisig',
  { filter: async (context) => await hasModule(context) },
  async ({ actors }, context, world) => {
    const { albert } = actors;
    const module = LiquidationModule__factory.connect(
      (await getLiquidationModuleAddress(context))!,
      world.deploymentManager.hre.ethers.provider
    );
    const multisigRole = await module.MULTISIG_ROLE();

    expect(await module.hasRole(multisigRole, albert.address)).to.be.false;
    await expect(module.connect(albert.signer).setSlippageBps(100, constants.AddressZero)).to.be.revertedWith(
      `AccessControl: account ${albert.address.toLowerCase()} is missing role ${multisigRole.toLowerCase()}`
    );
  }
);
