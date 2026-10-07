import { scenario } from './context/CometContext.js';
import { expect } from 'chai';
import { AbiCoder, ZeroAddress } from 'ethers';
import { exp } from '../test/helpers.js';
import { CometModified__factory, FaucetToken__factory } from '../build/types/index.js';
import { calldata } from '../src/deploy/index.js';
import { expectBase, isBridgedDeployment } from './utils/index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

scenario('upgrade Comet implementation and initialize', {filter: async (ctx) => !isBridgedDeployment(ctx)}, async ({ comet, configurator, proxyAdmin }, context) => {
  // For this scenario, we will be using the value of LiquidatorPoints.numAbsorbs for address ZERO to test that initialize has been called
  expect((await comet.liquidatorPoints(ZeroAddress)).numAbsorbs).to.be.equal(0n);

  // Deploy new version of Comet Factory
  const dm = context.world.deploymentManager;
  const cometModifiedFactory = await dm.deploy('cometFactory', 'test/CometModifiedFactory.sol', [], true);

  // Execute a governance proposal to:
  // 1. Set the new factory address in Configurator
  // 2. Deploy and upgrade to the new implementation of Comet
  // 3. Call initialize(address) on the new version of Comet
  const cometAddress = await comet.getAddress();
  const configuratorAddress = await configurator.getAddress();
  const proxyAdminAddress = await proxyAdmin.getAddress();
  const setFactoryCalldata = abiCoder.encode(['address', 'address'], [cometAddress, await cometModifiedFactory.getAddress()]);
  const deployAndUpgradeToCalldata = abiCoder.encode(['address', 'address'], [configuratorAddress, cometAddress]);
  const initializeCalldata = abiCoder.encode(['address'], [ZeroAddress]);
  await context.fastGovernanceExecute(
    [configuratorAddress, proxyAdminAddress, cometAddress],
    [0, 0, 0],
    ['setFactory(address,address)', 'deployAndUpgradeTo(address,address)', 'initialize(address)'],
    [setFactoryCalldata, deployAndUpgradeToCalldata, initializeCalldata]
  );

  // LiquidatorPoints.numAbsorbs for address ZERO should now be set as UInt32.MAX
  expect((await comet.liquidatorPoints(ZeroAddress)).numAbsorbs).to.be.equal(2n ** 32n - 1n);
});

scenario('upgrade Comet implementation and initialize using deployUpgradeToAndCall', {filter: async (ctx) => !isBridgedDeployment(ctx)}, async ({ comet, configurator, proxyAdmin }, context) => {
  // For this scenario, we will be using the value of LiquidatorPoints.numAbsorbs for address ZERO to test that initialize has been called
  expect((await comet.liquidatorPoints(ZeroAddress)).numAbsorbs).to.be.equal(0n);

  // Deploy new version of Comet Factory
  const dm = context.world.deploymentManager;
  const cometModifiedFactory = await dm.deploy(
    'cometFactory',
    'test/CometModifiedFactory.sol',
    [],
    true
  );

  // Execute a governance proposal to:
  // 1. Set the new factory address in Configurator
  // 2. DeployUpgradeToAndCall the new implementation of Comet
  const cometAddress = await comet.getAddress();
  const configuratorAddress = await configurator.getAddress();
  const proxyAdminAddress = await proxyAdmin.getAddress();
  const setFactoryCalldata = abiCoder.encode(['address', 'address'], [cometAddress, await cometModifiedFactory.getAddress()]);
  const modifiedComet = CometModified__factory.connect(cometAddress, comet.runner);
  const initializeCalldata = (await modifiedComet.initialize.populateTransaction(ZeroAddress)).data;
  const deployUpgradeToAndCallCalldata = abiCoder.encode(['address', 'address', 'bytes'], [configuratorAddress, cometAddress, initializeCalldata]);

  await context.fastGovernanceExecute(
    [configuratorAddress, proxyAdminAddress],
    [0, 0],
    ['setFactory(address,address)', 'deployUpgradeToAndCall(address,address,bytes)'],
    [setFactoryCalldata, deployUpgradeToAndCallCalldata]
  );

  // LiquidatorPoints.numAbsorbs for address ZERO should now be set as UInt32.MAX
  expect((await comet.liquidatorPoints(ZeroAddress)).numAbsorbs).to.be.equal(2n ** 32n - 1n);
});

scenario('upgrade Comet implementation and call new function', {filter: async (ctx) => !isBridgedDeployment(ctx)}, async ({ comet, configurator, proxyAdmin, actors }, context) => {
  const { signer } = actors;

  // Deploy new version of Comet Factory
  const dm = context.world.deploymentManager;
  const cometModifiedFactory = await dm.deploy('cometFactory', 'test/CometModifiedFactory.sol', [], true);

  // Upgrade Comet implementation
  const cometAddress = await comet.getAddress();
  const configuratorAddress = await configurator.getAddress();
  const proxyAdminAddress = await proxyAdmin.getAddress();
  const setFactoryCalldata = abiCoder.encode(['address', 'address'], [cometAddress, await cometModifiedFactory.getAddress()]);
  const deployAndUpgradeToCalldata = abiCoder.encode(['address', 'address'], [configuratorAddress, cometAddress]);
  await context.fastGovernanceExecute(
    [configuratorAddress, proxyAdminAddress],
    [0, 0],
    ['setFactory(address,address)', 'deployAndUpgradeTo(address,address)'],
    [setFactoryCalldata, deployAndUpgradeToCalldata]
  );

  const modifiedComet = CometModified__factory.connect(cometAddress, signer.signer);

  // Call new functions on Comet
  await modifiedComet.initialize(ZeroAddress);
  expect(await modifiedComet.newFunction()).to.be.equal(101n);
});

scenario('add new asset',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    tokenBalances: {
      $comet: { $base: '>= 1000' },
    },
    prices: {
      $base: 1
    }
  },
  async ({ comet, configurator, proxyAdmin, actors }, context) => {
    const { albert } = actors;

    // Deploy new token and pricefeed
    const dm = context.world.deploymentManager;
    const dogecoinContract = await dm.deploy(
      'DOGE',
      'test/FaucetToken.sol',
      [exp(1_000_000, 8).toString(), 'Dogecoin', 8, 'DOGE'],
      true
    );
    const dogecoin = FaucetToken__factory.connect(await dogecoinContract.getAddress(), await dm.getSigner());
    const dogecoinPricefeed = await dm.deploy(
      'DOGE:priceFeed',
      'test/SimplePriceFeed.sol',
      [exp(1_000, 8).toString(), 8],
      true
    );

    // Allocate some tokens to Albert
    await dogecoin.allocateTo(albert.address, exp(100, 8));

    // Execute a governance proposal to:
    // 1. Add new asset via Configurator
    // 2. Deploy and upgrade to new implementation of Comet
    const newAssetConfig = {
      asset: await dogecoin.getAddress(),
      priceFeed: await dogecoinPricefeed.getAddress(),
      decimals: await dogecoin.decimals(),
      borrowCollateralFactor: exp(0.8, 18),
      liquidateCollateralFactor: exp(0.85, 18),
      liquidationFactor: exp(0.95, 18),
      supplyCap: exp(1_000, 8),
    };

    const cometAddress = await comet.getAddress();
    const configuratorAddress = await configurator.getAddress();
    const proxyAdminAddress = await proxyAdmin.getAddress();
    const dogecoinAddress = await dogecoin.getAddress();
    const addAssetCalldata = await calldata(configurator.addAsset.populateTransaction(cometAddress, newAssetConfig));
    const deployAndUpgradeToCalldata = abiCoder.encode(['address', 'address'], [configuratorAddress, cometAddress]);
    await context.fastGovernanceExecute(
      [configuratorAddress, proxyAdminAddress],
      [0, 0],
      ['addAsset(address,(address,address,uint8,uint64,uint64,uint64,uint128))', 'deployAndUpgradeTo(address,address)'],
      [addAssetCalldata, deployAndUpgradeToCalldata]
    );

    // Try to supply new token and borrow base
    const baseAssetAddress = await comet.baseToken();
    const borrowAmount = 1000n * await comet.baseScale();
    await dogecoin.connect(albert.signer).approve(cometAddress, exp(100, 8));
    await albert.supplyAsset({ asset: dogecoinAddress, amount: exp(100, 8) });
    await albert.withdrawAsset({ asset: baseAssetAddress, amount: borrowAmount });

    expect(await albert.getCometCollateralBalance(dogecoinAddress)).to.be.equal(exp(100, 8));
    expectBase(await albert.getCometBaseBalance(), -borrowAmount);
  });
