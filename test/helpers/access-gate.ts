import { ethers } from 'hardhat';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractFactory } from 'ethers';
import {
  AssetListFactory__factory,
  CometExtAssetList__factory,
  CometWithExtendedAssetList,
  CometWithExtendedAssetList__factory,
  DefaultAccessGate,
  DefaultAccessGate__factory,
  FaucetToken,
  FaucetToken__factory,
  ListAccessGate,
  SimplePriceFeed__factory,
} from '../../build/types';
import { exp } from '../helpers';
import { setBalance } from './network-helpers';

// OZ AccessControl role identifiers of the access gates.
export const ADMIN_ROLE = ethers.constants.HashZero; // DEFAULT_ADMIN_ROLE, held by the governor
export const OPERATOR_ADMIN_ROLE = ethers.utils.id('OPERATOR_ADMIN_ROLE');
export const PAUSER_ROLE = ethers.utils.id('PAUSER_ROLE');
export const OPERATOR_ROLE = ethers.utils.id('OPERATOR_ROLE');

// OZ v4 AccessControl revert message for a caller missing `role`.
export const missingRole = (account: string, role: string) =>
  `AccessControl: account ${account.toLowerCase()} is missing role ${role}`;

// AccessGateAction enum values.
export const Action = {
  SUPPLY_BASE: 0,
  REPAY: 1,
  SUPPLY_COLLATERAL: 2,
  WITHDRAW_BASE: 3,
  BORROW: 4,
  WITHDRAW_COLLATERAL: 5,
  TRANSFER_BASE: 6,
  TRANSFER_BASE_BORROW: 7,
  TRANSFER_COLLATERAL: 8,
  ABSORB: 9,
  BUY_COLLATERAL: 10,
  WITHDRAW_RESERVES: 11,
  APPROVE_THIS: 12,
};
export const ACTIONS = Object.entries(Action);
export const COLLATERAL_ACTIONS = ACTIONS.filter(([, action]) =>
  [Action.SUPPLY_COLLATERAL, Action.WITHDRAW_COLLATERAL, Action.TRANSFER_COLLATERAL, Action.BUY_COLLATERAL].includes(action)
);
export const UNDEFINED_ACTION = 13;
export const NO_ASSET = 255;

// Collateral offsets of the fixture market: WETH is listed first, WBTC second.
export const WETH_INDEX = 0;
export const WBTC_INDEX = 1;
export const NUM_ASSETS = 2;

export type MarketFixture = {
  deployer: SignerWithAddress;
  comet: CometWithExtendedAssetList;
  usdc: FaucetToken;
  wbtc: FaucetToken;
  governor: SignerWithAddress; // holds DEFAULT_ADMIN_ROLE and OPERATOR_ADMIN_ROLE, no PAUSER_ROLE
  operatorAdmin: SignerWithAddress; // holds OPERATOR_ADMIN_ROLE
  pausers: string[]; // hold PAUSER_ROLE
  pauser: SignerWithAddress; // equals pausers[0]
  operators: string[]; // hold OPERATOR_ROLE of the list gates
  operator: SignerWithAddress; // equals operators[0]
  other: SignerWithAddress; // holds no role
  counterparty: SignerWithAddress; // holds no role, used as a party of the checked actions
  accounts: SignerWithAddress[]; // hold no role, free to be listed by the tests
};

export type DefaultAccessGateFixture = MarketFixture & {
  AccessGateFactory: DefaultAccessGate__factory;
  gate: DefaultAccessGate;
  cometSigner: SignerWithAddress; // the bound Comet, impersonated to call the hooks
};

export type ListAccessGateFixture = MarketFixture & {
  AccessGateFactory: ContractFactory;
  gate: ListAccessGate;
  cometSigner: SignerWithAddress; // the bound Comet, impersonated to call the hooks
};

/**
 * Deploys a market (the real CometWithExtendedAssetList: USDC base, WETH and WBTC collaterals) and the
 * DefaultAccessGate bound to it.
 */
export async function deployDefaultAccessGateFixture(): Promise<DefaultAccessGateFixture> {
  const market = await deployMarketFixture();

  const AccessGateFactory = (await ethers.getContractFactory('DefaultAccessGate')) as DefaultAccessGate__factory;
  const gate = await AccessGateFactory.deploy(market.comet.address, market.governor.address, market.operatorAdmin.address, market.pausers);
  await gate.deployed();

  return { ...market, AccessGateFactory, gate, cometSigner: await impersonateComet(market.comet) };
}

/**
 * Deploys a market (the real CometWithExtendedAssetList: USDC base, WETH and WBTC collaterals) and a list gate
 * (AllowlistGate or BlocklistGate) bound to it.
 */
export async function deployListAccessGateFixture(gateName: 'AllowlistGate' | 'BlocklistGate'): Promise<ListAccessGateFixture> {
  const market = await deployMarketFixture();

  const AccessGateFactory = await ethers.getContractFactory(gateName);
  const gate = (await AccessGateFactory.deploy(
    market.comet.address,
    market.governor.address,
    market.operatorAdmin.address,
    market.pausers,
    market.operators
  )) as ListAccessGate;
  await gate.deployed();

  return { ...market, AccessGateFactory, gate, cometSigner: await impersonateComet(market.comet) };
}

/**
 * Deploys the market up to Comet. Comet and the gate reference each other: the gate must be the next contract
 * deployed by the deployer, so its address is known upfront.
 */
async function deployMarketFixture(): Promise<MarketFixture> {
  const signers = await ethers.getSigners();
  const [deployer, governor, operatorAdmin] = signers;
  const pausers = [signers[3].address, signers[4].address];
  const pauser = signers[3];
  const counterparty = signers[5];
  const other = signers[6];
  const operators = [signers[7].address, signers[8].address];
  const operator = signers[7];
  const accounts = signers.slice(9, 14);

  // Mock market tokens: USDC base + WETH and WBTC collaterals
  const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
  const usdc = await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC');
  await usdc.deployed();
  const weth = await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH');
  await weth.deployed();
  const wbtc = await FaucetTokenFactory.deploy(exp(1, 8), 'Wrapped Bitcoin', 8, 'WBTC');
  await wbtc.deployed();

  const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
  const usdcFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
  await usdcFeed.deployed();
  const wethFeed = await PriceFeedFactory.deploy(exp(2000, 8), 8);
  await wethFeed.deployed();
  const wbtcFeed = await PriceFeedFactory.deploy(exp(60000, 8), 8);
  await wbtcFeed.deployed();

  // Asset list factory + extension delegate
  const AssetListFactoryFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
  const assetListFactory = await AssetListFactoryFactory.deploy();
  await assetListFactory.deployed();
  const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
  const extensionDelegate = await CometExtFactory.deploy(
    {
      name32: ethers.utils.formatBytes32String('Compound Comet'),
      symbol32: ethers.utils.formatBytes32String('Comet'),
    },
    assetListFactory.address
  );
  await extensionDelegate.deployed();

  const nonce = await deployer.getTransactionCount();
  const gateAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonce + 1 });

  // Comet (the real implementation, not the test harness)
  const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
  const comet = await CometFactory.deploy({
    governor: governor.address,
    pauseGuardian: pauser.address,
    extensionDelegate: extensionDelegate.address,
    baseToken: usdc.address,
    baseTokenPriceFeed: usdcFeed.address,
    supplyKink: exp(0.8, 18),
    supplyPerYearInterestRateBase: exp(0, 18),
    supplyPerYearInterestRateSlopeLow: exp(0.05, 18),
    supplyPerYearInterestRateSlopeHigh: exp(2, 18),
    borrowKink: exp(0.8, 18),
    borrowPerYearInterestRateBase: exp(0.005, 18),
    borrowPerYearInterestRateSlopeLow: exp(0.1, 18),
    borrowPerYearInterestRateSlopeHigh: exp(3, 18),
    storeFrontPriceFactor: exp(1, 18),
    trackingIndexScale: exp(1, 15),
    baseTrackingSupplySpeed: exp(1, 15),
    baseTrackingBorrowSpeed: exp(1, 15),
    baseMinForRewards: exp(1, 6),
    baseBorrowMin: exp(1, 6),
    targetReserves: 0,
    assetConfigs: [
      {
        asset: weth.address,
        priceFeed: wethFeed.address,
        decimals: 18,
        borrowCollateralFactor: exp(0.8, 18),
        liquidateCollateralFactor: exp(0.85, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: exp(150000, 18),
      },
      {
        asset: wbtc.address,
        priceFeed: wbtcFeed.address,
        decimals: 8,
        borrowCollateralFactor: exp(0.7, 18),
        liquidateCollateralFactor: exp(0.75, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: exp(1000, 8),
      },
    ],
    accessGate: gateAddress,
  });
  await comet.deployed();

  return { deployer, comet, usdc, wbtc, governor, operatorAdmin, pausers, pauser, operators, operator, other, counterparty, accounts };
}

/**
 * Impersonates the Comet to call the gate hooks, which are accepted from the bound Comet only
 */
async function impersonateComet(comet: CometWithExtendedAssetList): Promise<SignerWithAddress> {
  const cometSigner = await ethers.getImpersonatedSigner(comet.address);
  await setBalance(comet.address, ethers.utils.parseEther('10'));
  return cometSigner;
}
