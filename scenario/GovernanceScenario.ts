import { scenario } from './context/CometContext';
import { expect } from 'chai';
import { BigNumberish, constants, utils } from 'ethers';
import { exp } from '../test/helpers';
import { FaucetToken } from '../build/types';
import { calldata } from '../src/deploy';
import { expectBase, isBridgedDeployment } from './utils';

const UINT32_MAX = 2 ** 32 - 1;
const NEW_FUNCTION_EXPECTED_VALUE = 101n;
const MIN_BASE_BALANCE = '>= 1000';
const BASE_PRICE = 1;
const DOGECOIN_TOTAL_SUPPLY = 1_000_000;
const DOGECOIN_DECIMALS = 8;
const DOGECOIN_PRICE = 1_000;
const DOGECOIN_ALLOCATE_AMOUNT = 100;
const BORROW_COLLATERAL_FACTOR = 0.8;
const LIQUIDATE_COLLATERAL_FACTOR = 0.85;
const LIQUIDATION_FACTOR = 0.95;
const DOGECOIN_SUPPLY_CAP = 1_000;
const BASE_BORROW_MULTIPLIER = 1000n;

scenario('upgrade Comet implementation and initialize', {filter: async (ctx) => !isBridgedDeployment(ctx)}, async ({ comet, configurator, proxyAdmin }, context) => {
  // For this scenario, we will be using the value of LiquidatorPoints.numAbsorbs for address ZERO to test that initialize has been called
  expect((await comet.liquidatorPoints(constants.AddressZero)).numAbsorbs).to.be.equal(0);

  // Deploy new version of Comet Factory
  const dm = context.world.deploymentManager;
  const cometModifiedFactory = await dm.deploy('cometFactory', 'test/CometModifiedFactory.sol', [], true);

  // Execute a governance proposal to:
  // 1. Set the new factory address in Configurator
  // 2. Deploy and upgrade to the new implementation of Comet
  // 3. Call initialize(address) on the new version of Comet
  const setFactoryCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [comet.address, cometModifiedFactory.address]);
  const deployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [configurator.address, comet.address]);
  const initializeCalldata = utils.defaultAbiCoder.encode(['address'], [constants.AddressZero]);
  await context.fastGovernanceExecute(
    [configurator.address, proxyAdmin.address, comet.address],
    [0, 0, 0],
    ['setFactory(address,address)', 'deployAndUpgradeTo(address,address)', 'initialize(address)'],
    [setFactoryCalldata, deployAndUpgradeToCalldata, initializeCalldata]
  );

  // LiquidatorPoints.numAbsorbs for address ZERO should now be set as UInt32.MAX
  expect((await comet.liquidatorPoints(constants.AddressZero)).numAbsorbs).to.be.equal(UINT32_MAX);
});

scenario('upgrade Comet implementation and initialize using deployUpgradeToAndCall', {filter: async (ctx) => !isBridgedDeployment(ctx)}, async ({ comet, configurator, proxyAdmin }, context) => {
  // For this scenario, we will be using the value of LiquidatorPoints.numAbsorbs for address ZERO to test that initialize has been called
  expect((await comet.liquidatorPoints(constants.AddressZero)).numAbsorbs).to.be.equal(0);

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
  const setFactoryCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [comet.address, cometModifiedFactory.address]);
  const modifiedComet = (await dm.hre.ethers.getContractFactory('CometModified')).attach(comet.address);
  const initializeCalldata = (await modifiedComet.populateTransaction.initialize(constants.AddressZero)).data;
  const deployUpgradeToAndCallCalldata = utils.defaultAbiCoder.encode(['address', 'address', 'bytes'], [configurator.address, comet.address, initializeCalldata]);

  await context.fastGovernanceExecute(
    [configurator.address, proxyAdmin.address],
    [0, 0],
    ['setFactory(address,address)', 'deployUpgradeToAndCall(address,address,bytes)'],
    [setFactoryCalldata, deployUpgradeToAndCallCalldata]
  );

  // LiquidatorPoints.numAbsorbs for address ZERO should now be set as UInt32.MAX
  expect((await comet.liquidatorPoints(constants.AddressZero)).numAbsorbs).to.be.equal(UINT32_MAX);
});

scenario('upgrade Comet implementation and call new function', {filter: async (ctx) => !isBridgedDeployment(ctx)}, async ({ comet, configurator, proxyAdmin, actors }, context) => {
  const { signer } = actors;

  // Deploy new version of Comet Factory
  const dm = context.world.deploymentManager;
  const cometModifiedFactory = await dm.deploy('cometFactory', 'test/CometModifiedFactory.sol', [], true);

  // Upgrade Comet implementation
  const setFactoryCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [comet.address, cometModifiedFactory.address]);
  const deployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [configurator.address, comet.address]);
  await context.fastGovernanceExecute(
    [configurator.address, proxyAdmin.address],
    [0, 0],
    ['setFactory(address,address)', 'deployAndUpgradeTo(address,address)'],
    [setFactoryCalldata, deployAndUpgradeToCalldata]
  );

  const CometModified = await dm.hre.ethers.getContractFactory('CometModified');
  const modifiedComet = CometModified.attach(comet.address).connect(signer.signer);

  // Call new functions on Comet
  await modifiedComet.initialize(constants.AddressZero);
  expect(await modifiedComet.newFunction()).to.be.equal(NEW_FUNCTION_EXPECTED_VALUE);
});

scenario('add new asset',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    tokenBalances: {
      $comet: { $base: MIN_BASE_BALANCE },
    },
    prices: {
      $base: BASE_PRICE
    }
  },
  async ({ comet, configurator, proxyAdmin, actors }, context) => {
    const { albert } = actors;

    // Deploy new token and pricefeed
    const dm = context.world.deploymentManager;
    const dogecoin = await dm.deploy<FaucetToken, [string, string, BigNumberish, string]>(
      'DOGE',
      'test/FaucetToken.sol',
      [exp(DOGECOIN_TOTAL_SUPPLY, DOGECOIN_DECIMALS).toString(), 'Dogecoin', DOGECOIN_DECIMALS, 'DOGE'],
      true
    );
    const dogecoinPricefeed = await dm.deploy(
      'DOGE:priceFeed',
      'test/SimplePriceFeed.sol',
      [exp(DOGECOIN_PRICE, DOGECOIN_DECIMALS).toString(), DOGECOIN_DECIMALS],
      true
    );

    // Allocate some tokens to Albert
    await dogecoin.allocateTo(albert.address, exp(DOGECOIN_ALLOCATE_AMOUNT, DOGECOIN_DECIMALS));

    // Execute a governance proposal to:
    // 1. Add new asset via Configurator
    // 2. Deploy and upgrade to new implementation of Comet
    const newAssetConfig = {
      asset: dogecoin.address,
      priceFeed: dogecoinPricefeed.address,
      decimals: await dogecoin.decimals(),
      borrowCollateralFactor: exp(BORROW_COLLATERAL_FACTOR, DOGECOIN_DECIMALS),
      liquidateCollateralFactor: exp(LIQUIDATE_COLLATERAL_FACTOR, DOGECOIN_DECIMALS),
      liquidationFactor: exp(LIQUIDATION_FACTOR, DOGECOIN_DECIMALS),
      supplyCap: exp(DOGECOIN_SUPPLY_CAP, DOGECOIN_DECIMALS),
    };

    const addAssetCalldata = await calldata(configurator.populateTransaction.addAsset(comet.address, newAssetConfig));
    const deployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(['address', 'address'], [configurator.address, comet.address]);
    await context.fastGovernanceExecute(
      [configurator.address, proxyAdmin.address],
      [0, 0],
      ['addAsset(address,(address,address,uint8,uint64,uint64,uint64,uint128))', 'deployAndUpgradeTo(address,address)'],
      [addAssetCalldata, deployAndUpgradeToCalldata]
    );

    // Try to supply new token and borrow base
    const baseAssetAddress = await comet.baseToken();
    const borrowAmount = BASE_BORROW_MULTIPLIER * (await comet.baseScale()).toBigInt();
    await dogecoin.connect(albert.signer).approve(comet.address, exp(DOGECOIN_ALLOCATE_AMOUNT, DOGECOIN_DECIMALS));
    await albert.supplyAsset({ asset: dogecoin.address, amount: exp(DOGECOIN_ALLOCATE_AMOUNT, DOGECOIN_DECIMALS) });
    await albert.withdrawAsset({ asset: baseAssetAddress, amount: borrowAmount });

    expect(await albert.getCometCollateralBalance(dogecoin.address)).to.be.equal(exp(DOGECOIN_ALLOCATE_AMOUNT, DOGECOIN_DECIMALS));
    expectBase(await albert.getCometBaseBalance(), -borrowAmount);
  });