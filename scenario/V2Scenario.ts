import { scenario } from './context/CometContext';
import { expect } from 'chai';
import { getConfigForScenario } from './utils/scenarioHelper';

// Ethereum addresses
const CETH_WHALE_ADDRESS = '0xeb312f4921aebbe99facacfe92f22b942cbd7599';
const CETH_ADDRESS = '0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5';

const DAI_WHALE_ADDRESS = '0xc61cb8183b7692c8feb6a9431b0b23537a6402b0';
const DAI_ADDRESS = '0x6b175474e89094c44da98b954eedeac495271d0f';
const CDAI_ADDRESS = '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643';

const USDC_WHALE_ADDRESS = '0xb99cc7e10fe0acc68c50c7829f473d81e23249cc';
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const CUSDC_ADDRESS = '0x39AA39c021dfbaE8faC545936693aC917d5E7563';

const WBTC_BORROWER_ADDRESS = '0x795148ed4d088cb0ff4757b832adfc6f3b354cf9';
const WBTC_WHALE_ADDRESS = '0x1cb17a66dc606a52785f69f08f4256526abd4943';
const WBTC_ADDRESS = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const CWBTC2_ADDRESS = '0xccF4429DB6322D5C611ee964527D42E5d685DD6a';

// note: meant for sanity checking v2 proposals, can normally be set to skip
// enable to check specific v2 actions with addresses hard-coded by network
// addresses to check and markets will need to be updated between runs
scenario.skip(
  'Compound v2 > allows a user to repay, borrow, repay cETH',
  {},
  async (_, context, world) => {
    const config = getConfigForScenario(context);
    const dm = context.world.deploymentManager;
    const whale = await world.impersonateAddress(CETH_WHALE_ADDRESS);
    const cETH = await dm.existing('cETH', CETH_ADDRESS);
    const borrowBefore = await cETH.callStatic.borrowBalanceCurrent(whale.address);
    await cETH.connect(whale).repayBorrow({value: config.compoundV2.eth.repayAmount,});
    await cETH.connect(whale).borrow(config.compoundV2.eth.borrowAmount);
    await cETH.connect(whale).repayBorrow({value: config.compoundV2.eth.finalRepayAmount});
    const borrowAfter = await cETH.callStatic.borrowBalanceCurrent(whale.address);
    expect(borrowAfter.toBigInt() - borrowBefore.toBigInt()).to.be.lt(config.compoundV2.borrowTolerance);
  }
);

scenario.skip(
  'Compound v2 > allows a user to mint & redeem cDAI',
  {},
  async (_, context, world) => {
    const config = getConfigForScenario(context);
    const dm = context.world.deploymentManager;
    const whale = await world.impersonateAddress(DAI_WHALE_ADDRESS);
    const DAI = await dm.existing('DAI', DAI_ADDRESS);
    const cDAI = await dm.existing('cDAI', CDAI_ADDRESS);
    await DAI.connect(whale).approve(cDAI.address, config.compoundV2.dai.mintRedeemAmount);
    await cDAI.connect(whale).mint(config.compoundV2.dai.mintRedeemAmount);
    await cDAI.connect(whale).redeemUnderlying(config.compoundV2.dai.mintRedeemAmount);
  }
);

scenario.skip(
  'Compound v2 > allows a user to mint & redeem cUSDC',
  {},
  async (_, context, world) => {
    const config = getConfigForScenario(context);
    const dm = context.world.deploymentManager;
    const whale = await world.impersonateAddress(USDC_WHALE_ADDRESS);
    const USDC = await dm.existing('USDC', USDC_ADDRESS);
    const cUSDC = await dm.existing('cUSDC', CUSDC_ADDRESS);
    await USDC.connect(whale).approve(cUSDC.address, config.compoundV2.usdc.mintRedeemAmount);
    await cUSDC.connect(whale).mint(config.compoundV2.usdc.mintRedeemAmount);
    await cUSDC.connect(whale).redeemUnderlying(config.compoundV2.usdc.mintRedeemAmount);
  }
);

scenario.skip(
  'Compound v2 > allows a user to repay, borrow, repay cWBTC2',
  {},
  async (_, context, world) => {
    const config = getConfigForScenario(context);
    const dm = context.world.deploymentManager;
    const borrower = await world.impersonateAddress(WBTC_BORROWER_ADDRESS);
    const whale = await world.impersonateAddress(WBTC_WHALE_ADDRESS);
    const WBTC = await dm.existing('WBTC', WBTC_ADDRESS);
    const cWBTC2 = await dm.existing('cWBTC2', CWBTC2_ADDRESS);
    const borrowBefore = await cWBTC2.callStatic.borrowBalanceCurrent(borrower.address);
    await WBTC.connect(whale).approve(cWBTC2.address, config.compoundV2.wbtc.approveAmount);
    await cWBTC2.connect(whale).repayBorrowBehalf(borrower.address, config.compoundV2.wbtc.repayBehalfAmount);
    await cWBTC2.connect(borrower).borrow(config.compoundV2.wbtc.borrowAmount);
    await cWBTC2.connect(borrower).repayBorrow(config.compoundV2.wbtc.repayAmount);
    const borrowAfter = await cWBTC2.callStatic.borrowBalanceCurrent(borrower.address);
    expect(borrowAfter.toBigInt() - borrowBefore.toBigInt()).to.be.lt(config.compoundV2.borrowTolerance);
  }
);