import { scenario } from './context/CometContext';
import { exp } from '../test/helpers';
import { expect } from 'chai';

const ETH_REPAY_AMOUNT = 2;
const ETH_BORROW_AMOUNT = 1;
const ETH_FINAL_REPAY_AMOUNT = 1;

const DAI_MINT_REDEEM_AMOUNT = 1000;

const USDC_MINT_REDEEM_AMOUNT = 20_000;

const WBTC_APPROVE_AMOUNT = 1;
const WBTC_REPAY_BEHALF_AMOUNT = 0.1;
const WBTC_BORROW_AMOUNT = 0.2;
const WBTC_REPAY_AMOUNT = 0.2;

const BORROW_TOLERANCE = 1.6e-6;

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
    const dm = context.world.deploymentManager;
    const whale = await world.impersonateAddress(CETH_WHALE_ADDRESS);
    const cETH = await dm.existing('cETH', CETH_ADDRESS);
    const borrowBefore = await cETH.callStatic.borrowBalanceCurrent(whale.address);
    await cETH.connect(whale).repayBorrow({value: exp(ETH_REPAY_AMOUNT, 18)});
    await cETH.connect(whale).borrow(exp(ETH_BORROW_AMOUNT, 18));
    await cETH.connect(whale).repayBorrow({value: exp(ETH_FINAL_REPAY_AMOUNT, 18)});
    const borrowAfter = await cETH.callStatic.borrowBalanceCurrent(whale.address);
    expect(borrowAfter.toBigInt() - borrowBefore.toBigInt()).to.be.lt(exp(BORROW_TOLERANCE, 18));
  }
);

scenario.skip(
  'Compound v2 > allows a user to mint & redeem cDAI',
  {},
  async (_, context, world) => {
    const dm = context.world.deploymentManager;
    const whale = await world.impersonateAddress(DAI_WHALE_ADDRESS);
    const DAI = await dm.existing('DAI', DAI_ADDRESS);
    const cDAI = await dm.existing('cDAI', CDAI_ADDRESS);
    await DAI.connect(whale).approve(cDAI.address, exp(DAI_MINT_REDEEM_AMOUNT, 18));
    await cDAI.connect(whale).mint(exp(DAI_MINT_REDEEM_AMOUNT, 18));
    await cDAI.connect(whale).redeemUnderlying(exp(DAI_MINT_REDEEM_AMOUNT, 818));
  }
);

scenario.skip(
  'Compound v2 > allows a user to mint & redeem cUSDC',
  {},
  async (_, context, world) => {
    const dm = context.world.deploymentManager;
    const whale = await world.impersonateAddress(USDC_WHALE_ADDRESS);
    const USDC = await dm.existing('USDC', USDC_ADDRESS);
    const cUSDC = await dm.existing('cUSDC', CUSDC_ADDRESS);
    await USDC.connect(whale).approve(cUSDC.address, exp(USDC_MINT_REDEEM_AMOUNT, 18));
    await cUSDC.connect(whale).mint(exp(USDC_MINT_REDEEM_AMOUNT, 18));
    await cUSDC.connect(whale).redeemUnderlying(exp(USDC_MINT_REDEEM_AMOUNT, 18));
  }
);

scenario.skip(
  'Compound v2 > allows a user to repay, borrow, repay cWBTC2',
  {},
  async (_, context, world) => {
    const dm = context.world.deploymentManager;
    const borrower = await world.impersonateAddress(WBTC_BORROWER_ADDRESS);
    const whale = await world.impersonateAddress(WBTC_WHALE_ADDRESS);
    const WBTC = await dm.existing('WBTC', WBTC_ADDRESS);
    const cWBTC2 = await dm.existing('cWBTC2', CWBTC2_ADDRESS);
    const borrowBefore = await cWBTC2.callStatic.borrowBalanceCurrent(borrower.address);
    await WBTC.connect(whale).approve(cWBTC2.address, exp(WBTC_APPROVE_AMOUNT, 8));
    await cWBTC2.connect(whale).repayBorrowBehalf(borrower.address, exp(WBTC_REPAY_BEHALF_AMOUNT, 8));
    await cWBTC2.connect(borrower).borrow(exp(WBTC_BORROW_AMOUNT, 8));
    await cWBTC2.connect(borrower).repayBorrow(exp(WBTC_REPAY_AMOUNT, 8));
    const borrowAfter = await cWBTC2.callStatic.borrowBalanceCurrent(borrower.address);
    expect(borrowAfter.toBigInt() - borrowBefore.toBigInt()).to.be.lt(exp(BORROW_TOLERANCE, 18));
  }
);