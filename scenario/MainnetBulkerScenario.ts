import { ethers, utils } from 'ethers';
import { expect } from 'chai';
import { scenario } from './context/CometContext';
import CometAsset from './context/CometAsset';
import {
  ERC20,
  IWstETH,
  MainnetBulker
} from '../build/types';
import { exp } from '../test/helpers';
import { expectApproximately, isBulkerSupported, matchesDeployment } from './utils';

const MAINNET_WSTETH_ADDRESS = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
const MAINNET_STETH_ADDRESS = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
const STETH_SUPPLY_AMOUNT = 0.1;
const STANDARD_DECIMALS = 18;
const STETH_BALANCE_TOLERANCE = 2n;
const WSTETH_BALANCE_TOLERANCE = 1n;
const STETH_WITHDRAWAL_TOLERANCE = 3n;
const WSTETH_WITHDRAWAL_TOLERANCE = 1n;
const MAX_STETH_WITHDRAWAL_TOLERANCE = 2n;
const WSTETH_SUPPLY_CAP_SMALL = 1;
const WSTETH_SUPPLY_CAP_MEDIUM = 2;
const WSTETH_TOKEN_BALANCE = 2;
const WSTETH_COMET_BALANCE = 5;
const WSTETH_COMET_POSITION = 1;
const SOURCE_TOKEN_BUFFER = 3n;
const INVALID_ASSET_INDEX = -1;

async function getWstETHIndex(context: any): Promise<number> {
  const comet = await context.getComet();
  const totalAssets = await comet.numAssets();
  for (let i = 0; i < totalAssets; i++) {
    const asset = await comet.getAssetInfo(i);
    if (asset.asset.toLowerCase() === MAINNET_WSTETH_ADDRESS) {
      return i;
    }
  }
  return INVALID_ASSET_INDEX;
}

async function hasWstETH(context: any): Promise<boolean> {
  return (await getWstETHIndex(context) > INVALID_ASSET_INDEX);
}

scenario(
  'MainnetBulker > wraps stETH before supplying',
  {
    filter: async (ctx) => await hasWstETH(ctx) && await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
    supplyCaps: async (ctx) => (
      {
        [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_SUPPLY_CAP_SMALL,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: '== 0' },
      }
    ),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const stETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_STETH_ADDRESS) as ERC20;
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    const toSupplyStEth = exp(STETH_SUPPLY_AMOUNT, STANDARD_DECIMALS);

    await context.sourceTokens(toSupplyStEth + SOURCE_TOKEN_BUFFER, new CometAsset(stETH), albert);

    expect(await stETH.balanceOf(albert.address)).to.be.greaterThanOrEqual(toSupplyStEth);

    await stETH.connect(albert.signer).approve(bulker.address, toSupplyStEth);

    const supplyStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, toSupplyStEth]
    );
    const calldata = [supplyStEthCalldata];
    const actions = [await (bulker as MainnetBulker).ACTION_SUPPLY_STETH()];

    await albert.invoke({ actions, calldata });

    expectApproximately((await stETH.balanceOf(albert.address)).toBigInt(), 0n, STETH_BALANCE_TOLERANCE);
    expectApproximately(
      (await comet.collateralBalanceOf(albert.address, wstETH.address)).toBigInt(),
      (await wstETH.getWstETHByStETH(toSupplyStEth)).toBigInt(),
      WSTETH_BALANCE_TOLERANCE
    );
  }
);

scenario(
  'MainnetBulker > unwraps wstETH before withdrawing',
  {
    filter: async (ctx) => await hasWstETH(ctx) && await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
    supplyCaps: async (ctx) => (
      {
        [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_SUPPLY_CAP_MEDIUM,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_TOKEN_BALANCE },
        $comet: { [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_COMET_BALANCE },
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_COMET_POSITION }
      }
    )
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const stETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_STETH_ADDRESS) as ERC20;
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    await albert.allow(bulker.address, true);

    const toWithdrawStEth = (await wstETH.getStETHByWstETH(exp(WSTETH_COMET_POSITION, STANDARD_DECIMALS))).toBigInt();
    const withdrawStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, toWithdrawStEth]
    );
    const calldata = [withdrawStEthCalldata];
    const actions = [await (bulker as MainnetBulker).ACTION_WITHDRAW_STETH()];

    await albert.invoke({ actions, calldata });

    expectApproximately(
      (await stETH.balanceOf(albert.address)).toBigInt(),
      toWithdrawStEth,
      STETH_WITHDRAWAL_TOLERANCE
    );
    expectApproximately(
      (await comet.collateralBalanceOf(albert.address, wstETH.address)).toBigInt(),
      0n,
      WSTETH_WITHDRAWAL_TOLERANCE
    );
  }
);

scenario(
  'MainnetBulker > withdraw max stETH leaves no dust',
  {
    filter: async (ctx) => await hasWstETH(ctx) && await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
    supplyCaps: async (ctx) => (
      {
        [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_SUPPLY_CAP_MEDIUM,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_TOKEN_BALANCE },
        $comet: { [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_COMET_BALANCE },
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: WSTETH_COMET_POSITION }
      }
    )
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const stETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_STETH_ADDRESS) as ERC20;
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    await albert.allow(bulker.address, true);

    const withdrawStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, ethers.constants.MaxUint256]
    );
    const calldata = [withdrawStEthCalldata];
    const actions = [await (bulker as MainnetBulker).ACTION_WITHDRAW_STETH()];

    await albert.invoke({ actions, calldata });

    expectApproximately(
      (await stETH.balanceOf(albert.address)).toBigInt(),
      (await wstETH.getStETHByWstETH(exp(WSTETH_COMET_POSITION, STANDARD_DECIMALS))).toBigInt(),
      MAX_STETH_WITHDRAWAL_TOLERANCE
    );
    expect(await comet.collateralBalanceOf(albert.address, wstETH.address)).to.be.equal(0n);
  }
);

scenario(
  'MainnetBulker > it reverts when passed an action that does not exist',
  {
    filter: async (ctx) => await hasWstETH(ctx) && await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors }) => {
    const { betty } = actors;

    const supplyGalacticCreditsCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, betty.address, exp(WSTETH_COMET_POSITION, STANDARD_DECIMALS)]
    );
    const calldata = [supplyGalacticCreditsCalldata];
    const actions = [
      ethers.utils.formatBytes32String('ACTION_SUPPLY_GALACTIC_CREDITS')
    ];

    await expect(
      betty.invoke({ actions, calldata })
    ).to.be.revertedWith("custom error 'UnhandledAction()'");
  }
);