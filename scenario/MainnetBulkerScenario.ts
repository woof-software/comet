import { ethers, utils } from 'ethers';
import { expect } from 'chai';
import { scenario } from './context/CometContext';
import CometAsset from './context/CometAsset';
import {
  ERC20,
  IWstETH,
  MainnetBulker,
  MainnetBulkerWithWstETHSupport
} from '../build/types';
import { exp } from '../test/helpers';
import { expectApproximately, isBulkerSupported, matchesDeployment } from './utils';

const MAINNET_WSTETH_ADDRESS = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
const MAINNET_STETH_ADDRESS = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84';
// tETH is the only active collateral in the mainnet/wsteth Comet with non-zero borrowCF;
// rsETH and ezETH have had their supply caps zeroed out by governance.
const MAINNET_TETH_ADDRESS = '0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8';

async function getWstETHIndex(context: any): Promise<number> {
  const comet = await context.getComet();
  const totalAssets = await comet.numAssets();
  for (let i = 0; i < totalAssets; i++) {
    const asset = await comet.getAssetInfo(i);
    if (asset.asset.toLowerCase() === MAINNET_WSTETH_ADDRESS) {
      return i;
    }
  }
  return -1;
}

async function hasWstETH(context: any): Promise<boolean> {
  return (await getWstETHIndex(context) > -1);
}

async function isWstETHBase(context: any): Promise<boolean> {
  const comet = await context.getComet();
  return (await comet.baseToken()).toLowerCase() === MAINNET_WSTETH_ADDRESS;
}

scenario(
  'MainnetBulker > steth is derived from wsteth.stETH()',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ bulker }, context) => {
    const wstETHAddress = await (bulker as MainnetBulker).wsteth();
    const stETHAddress = await (bulker as MainnetBulker).steth();
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', wstETHAddress) as IWstETH;

    expect(stETHAddress.toLowerCase()).to.be.equal((await wstETH.stETH()).toLowerCase());
  }
);

scenario(
  'MainnetBulker > wraps stETH before supplying',
  {
    filter: async (ctx) => await hasWstETH(ctx) && await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
    supplyCaps: async (ctx) => (
      {
        [`$asset${await getWstETHIndex(ctx)}`]: 1,
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
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/interfaces/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    const toSupplyStEth = exp(.1, 18);

    await context.sourceTokens(toSupplyStEth + 3n, new CometAsset(stETH), albert);

    expect(await stETH.balanceOf(albert.address)).to.be.greaterThanOrEqual(toSupplyStEth);

    // approve bulker as albert
    await stETH.connect(albert.signer).approve(bulker.address, toSupplyStEth);

    const supplyStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, toSupplyStEth]
    );
    const calldata = [supplyStEthCalldata];
    const actions = [await (bulker as MainnetBulker).ACTION_SUPPLY_STETH()];

    await albert.invoke({ actions, calldata });

    expectApproximately((await stETH.balanceOf(albert.address)).toBigInt(), 0n, 2n);
    expectApproximately(
      (await comet.collateralBalanceOf(albert.address, wstETH.address)).toBigInt(),
      (await wstETH.getWstETHByStETH(toSupplyStEth)).toBigInt(),
      1n
    );
  }
);

scenario(
  'MainnetBulker > unwraps wstETH before withdrawing',
  {
    filter: async (ctx) => await hasWstETH(ctx) && await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
    supplyCaps: async (ctx) => (
      {
        [`$asset${await getWstETHIndex(ctx)}`]: 2,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: 2 },
        $comet: { [`$asset${await getWstETHIndex(ctx)}`]: 5 },
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: 1 }
      }
    )
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const stETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_STETH_ADDRESS) as ERC20;
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/interfaces/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    await albert.allow(bulker.address, true);

    // withdraw stETH via bulker
    const toWithdrawStEth = (await wstETH.getStETHByWstETH(exp(1, 18))).toBigInt();
    const withdrawStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, toWithdrawStEth]
    );
    const calldata = [withdrawStEthCalldata];
    const actions = [await (bulker as MainnetBulker).ACTION_WITHDRAW_STETH()];

    await albert.invoke({ actions, calldata });

    // Approximation because some precision will be lost from the stETH to wstETH conversions
    expectApproximately(
      (await stETH.balanceOf(albert.address)).toBigInt(),
      toWithdrawStEth,
      3n
    );
    expectApproximately(
      (await comet.collateralBalanceOf(albert.address, wstETH.address)).toBigInt(),
      0n,
      1n
    );
  }
);

scenario(
  'MainnetBulker > withdraw max stETH leaves no dust',
  {
    filter: async (ctx) => await hasWstETH(ctx) && await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
    supplyCaps: async (ctx) => (
      {
        [`$asset${await getWstETHIndex(ctx)}`]: 2,
      }
    ),
    tokenBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: 2 },
        $comet: { [`$asset${await getWstETHIndex(ctx)}`]: 5 },
      }
    ),
    cometBalances: async (ctx) => (
      {
        albert: { [`$asset${await getWstETHIndex(ctx)}`]: 1 }
      }
    )
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const stETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_STETH_ADDRESS) as ERC20;
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/interfaces/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    await albert.allow(bulker.address, true);

    // withdraw max stETH via bulker
    const withdrawStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, ethers.constants.MaxUint256]
    );
    const calldata = [withdrawStEthCalldata];
    const actions = [await (bulker as MainnetBulker).ACTION_WITHDRAW_STETH()];

    await albert.invoke({ actions, calldata });

    expectApproximately(
      (await stETH.balanceOf(albert.address)).toBigInt(),
      (await wstETH.getStETHByWstETH(exp(1, 18))).toBigInt(),
      2n
    );
    expect(await comet.collateralBalanceOf(albert.address, wstETH.address)).to.be.equal(0n);
  }
);

scenario(
  'MainnetBulkerWithWstETHSupport > ACTION_SUPPLY_STETH supplies wstETH as the base asset',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const stETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_STETH_ADDRESS) as ERC20;
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    const toSupplyStEth = exp(.1, 18);
    await context.sourceTokens(toSupplyStEth + 3n, new CometAsset(stETH), albert);
    await stETH.connect(albert.signer).approve(bulker.address, toSupplyStEth);

    const supplyStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, toSupplyStEth]
    );
    const actions = [await (bulker as MainnetBulkerWithWstETHSupport).ACTION_SUPPLY_STETH()];

    await albert.invoke({ actions, calldata: [supplyStEthCalldata] });

    expectApproximately((await stETH.balanceOf(albert.address)).toBigInt(), 0n, 2n);
    expectApproximately(
      (await comet.balanceOf(albert.address)).toBigInt(),
      (await wstETH.getWstETHByStETH(toSupplyStEth)).toBigInt(),
      2n
    );
  }
);

scenario(
  'MainnetBulkerWithWstETHSupport > ACTION_SUPPLY_STETH amount=max repays full wstETH debt',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const stETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_STETH_ADDRESS) as ERC20;
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    // Use tETH as collateral: the only asset in this market with a non-zero borrowCF on the
    // live fork (rsETH borrowCF=0; ezETH supplyCap=0 with no borrow headroom).
    // 0.5 tETH at price≈1.006 wstETH and borrowCF=0.9 gives ~0.45 wstETH borrowing power,
    // which is enough to borrow the 0.2 wstETH required by this test.
    const toSupplyTETH = exp(0.5, 18);
    await context.sourceTokens(toSupplyTETH, MAINNET_TETH_ADDRESS, albert);
    const tETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_TETH_ADDRESS);
    await tETH.connect(albert.signer).approve(comet.address, toSupplyTETH);
    await albert.safeSupplyAsset({ asset: MAINNET_TETH_ADDRESS, amount: toSupplyTETH });

    const toBorrowWstEth = exp(0.2, 18); // above the market's 0.1 wstETH borrowMin
    await albert.withdrawAsset({ asset: MAINNET_WSTETH_ADDRESS, amount: toBorrowWstEth });

    const borrowBalanceBefore = (await comet.callStatic.borrowBalanceOf(albert.address)).toBigInt();
    expect(borrowBalanceBefore).to.be.greaterThan(0n);

    const expectedStEthPulled = (await wstETH.getStETHByWstETH(borrowBalanceBefore)).toBigInt();
    // Extra 1e9 wei covers ~3 blocks of borrow interest; bulker re-reads borrowBalanceOf() live.
    await context.sourceTokens(expectedStEthPulled + exp(1, 9), new CometAsset(stETH), albert);
    const stEthBalanceBefore = (await stETH.balanceOf(albert.address)).toBigInt();
    await stETH.connect(albert.signer).approve(bulker.address, ethers.constants.MaxUint256);

    const supplyStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, ethers.constants.MaxUint256]
    );
    const actions = [await (bulker as MainnetBulkerWithWstETHSupport).ACTION_SUPPLY_STETH()];

    await albert.invoke({ actions, calldata: [supplyStEthCalldata] });

    // wstETH→stETH→wstETH double conversion in the bulker can lose 1 wei to rounding.
    expectApproximately((await comet.borrowBalanceOf(albert.address)).toBigInt(), 0n, 1n);
    // stETH spent = getStETHByWstETH(live borrow at invoke) > expectedStEthPulled by ~3 blocks of interest.
    expectApproximately(
      stEthBalanceBefore - (await stETH.balanceOf(albert.address)).toBigInt(),
      expectedStEthPulled,
      exp(1, 9)
    );
  }
);

scenario(
  'MainnetBulkerWithWstETHSupport > ACTION_WITHDRAW_STETH withdraws base wstETH and returns stETH',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const stETH = await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', MAINNET_STETH_ADDRESS) as ERC20;
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    const toSupplyWstEth = exp(0.2, 18);
    await context.sourceTokens(toSupplyWstEth + 3n, MAINNET_WSTETH_ADDRESS, albert);
    await wstETH.connect(albert.signer).approve(comet.address, toSupplyWstEth);
    // wstETH is the base token — use supplyAsset (not safeSupplyAsset) to avoid the
    // bumpSupplyCaps call, which does a case-sensitive address comparison that fails for
    // the base token and incorrectly triggers getAssetInfoByAddress → BadAsset().
    await albert.supplyAsset({ asset: MAINNET_WSTETH_ADDRESS, amount: toSupplyWstEth });
    await albert.allow(bulker.address, true);

    const toWithdrawStEth = exp(0.05, 18);
    const expectedWstEthBurned = (await wstETH.getWstETHByStETH(toWithdrawStEth)).toBigInt();
    const baseBalanceBefore = (await comet.callStatic.balanceOf(albert.address)).toBigInt();

    const withdrawStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, toWithdrawStEth]
    );
    const actions = [await (bulker as MainnetBulkerWithWstETHSupport).ACTION_WITHDRAW_STETH()];

    await albert.invoke({ actions, calldata: [withdrawStEthCalldata] });

    // Supply interest accrues during the invoke block (~1.87e7 wei/s at live utilization); 1e9 covers it.
    expectApproximately(
      baseBalanceBefore - (await comet.balanceOf(albert.address)).toBigInt(),
      expectedWstEthBurned,
      exp(1, 9)
    );
    expectApproximately((await stETH.balanceOf(albert.address)).toBigInt(), toWithdrawStEth, 3n);
  }
);

scenario(
  'MainnetBulkerWithWstETHSupport > ACTION_WITHDRAW_STETH amount=max withdraws full base balance',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;

    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    const toSupplyWstEth = exp(0.2, 18);
    await context.sourceTokens(toSupplyWstEth + 3n, MAINNET_WSTETH_ADDRESS, albert);
    await wstETH.connect(albert.signer).approve(comet.address, toSupplyWstEth);
    await albert.supplyAsset({ asset: MAINNET_WSTETH_ADDRESS, amount: toSupplyWstEth });
    await albert.allow(bulker.address, true);

    expect((await comet.callStatic.balanceOf(albert.address)).toBigInt()).to.be.greaterThan(0n);

    const withdrawStEthCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, ethers.constants.MaxUint256]
    );
    const actions = [await (bulker as MainnetBulkerWithWstETHSupport).ACTION_WITHDRAW_STETH()];

    await albert.invoke({ actions, calldata: [withdrawStEthCalldata] });

    expect(await comet.balanceOf(albert.address)).to.be.equal(0n);
  }
);

scenario(
  'MainnetBulkerWithWstETHSupport > deposit() wraps ETH to wstETH and forwards it to Comet',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, bulker }, context) => {
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    expect(await wstETH.balanceOf(bulker.address)).to.be.equal(0);

    const ethAmount = exp(0.05, 18);
    const expectedWstEth = (await wstETH.getWstETHByStETH(ethAmount)).toBigInt();
    const cometWstEthBefore = (await wstETH.balanceOf(comet.address)).toBigInt();

    const adminSigner = await context.world.impersonateAddress(await comet.governor(), { value: ethAmount + exp(0.1, 18) });
    await (bulker as MainnetBulkerWithWstETHSupport).connect(adminSigner).deposit(comet.address, { value: ethAmount });

    expectApproximately(
      (await wstETH.balanceOf(comet.address)).toBigInt() - cometWstEthBefore,
      expectedWstEth,
      2n
    );
    expect(await wstETH.balanceOf(bulker.address)).to.be.equal(0);
  }
);

scenario(
  'MainnetBulker > invoke() with an action unknown to the MainnetBulker reverts',
  {
    filter: async (ctx) => await hasWstETH(ctx) && await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors }) => {
    const { betty } = actors;

    const supplyGalacticCreditsCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, betty.address, exp(1, 18)]
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

scenario(
  'MainnetBulker > ACTION_SUPPLY_STETH on MainnetBulker when comet baseToken is wstETH reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;
    const wstethAddr = await (bulker as MainnetBulkerWithWstETHSupport).wsteth();
    const freshBulker = await context.world.deploymentManager.deploy(
      'bulkerFreshMainnetBulker',
      'bulkers/MainnetBulker.sol',
      [await bulker.admin(), await bulker.wrappedNativeToken(), wstethAddr],
      true
    );
    const freshMainnetBulker = await context.world.deploymentManager.hre.ethers.getContractAt(
      'MainnetBulker', freshBulker.address
    ) as MainnetBulker;
    const actionCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, exp(0.01, 18)]
    );
    await expect(
      freshMainnetBulker.connect(albert.signer).invoke(
        [await freshMainnetBulker.ACTION_SUPPLY_STETH()],
        [actionCalldata]
      )
    ).to.be.revertedWith("custom error 'UnsupportedBaseAsset()'");
  }
);

scenario(
  'MainnetBulker > ACTION_WITHDRAW_STETH on MainnetBulker when comet baseToken is wstETH reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;
    const wstethAddr = await (bulker as MainnetBulkerWithWstETHSupport).wsteth();
    const freshBulker = await context.world.deploymentManager.deploy(
      'bulkerFreshMainnetBulker',
      'bulkers/MainnetBulker.sol',
      [await bulker.admin(), await bulker.wrappedNativeToken(), wstethAddr],
      true
    );
    const freshMainnetBulker = await context.world.deploymentManager.hre.ethers.getContractAt(
      'MainnetBulker', freshBulker.address
    ) as MainnetBulker;
    const actionCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, exp(0.01, 18)]
    );
    await expect(
      freshMainnetBulker.connect(albert.signer).invoke(
        [await freshMainnetBulker.ACTION_WITHDRAW_STETH()],
        [actionCalldata]
      )
    ).to.be.revertedWith("custom error 'UnsupportedBaseAsset()'");
  }
);

scenario(
  'MainnetBulker > ACTION_SUPPLY_STETH on MainnetBulkerWithWstETHSupport when comet baseToken is not wstETH reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && !await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;
    const wstethAddr = await (bulker as MainnetBulker).wsteth();
    const freshBulker = await context.world.deploymentManager.deploy(
      'bulkerFreshWithWstETHSupport',
      'bulkers/MainnetBulkerWithWstETHSupport.sol',
      [await bulker.admin(), await bulker.wrappedNativeToken(), wstethAddr],
      true
    );
    const freshWithWstETH = await context.world.deploymentManager.hre.ethers.getContractAt(
      'MainnetBulkerWithWstETHSupport', freshBulker.address
    ) as MainnetBulkerWithWstETHSupport;
    const actionCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, exp(0.01, 18)]
    );
    await expect(
      freshWithWstETH.connect(albert.signer).invoke(
        [await freshWithWstETH.ACTION_SUPPLY_STETH()],
        [actionCalldata]
      )
    ).to.be.revertedWith("custom error 'UnsupportedBaseAsset()'");
  }
);

scenario(
  'MainnetBulker > ACTION_WITHDRAW_STETH on MainnetBulkerWithWstETHSupport when comet baseToken is not wstETH reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && !await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;
    const wstethAddr = await (bulker as MainnetBulker).wsteth();
    const freshBulker = await context.world.deploymentManager.deploy(
      'bulkerFreshWithWstETHSupport',
      'bulkers/MainnetBulkerWithWstETHSupport.sol',
      [await bulker.admin(), await bulker.wrappedNativeToken(), wstethAddr],
      true
    );
    const freshWithWstETH = await context.world.deploymentManager.hre.ethers.getContractAt(
      'MainnetBulkerWithWstETHSupport', freshBulker.address
    ) as MainnetBulkerWithWstETHSupport;
    const actionCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, exp(0.01, 18)]
    );
    await expect(
      freshWithWstETH.connect(albert.signer).invoke(
        [await freshWithWstETH.ACTION_WITHDRAW_STETH()],
        [actionCalldata]
      )
    ).to.be.revertedWith("custom error 'UnsupportedBaseAsset()'");
  }
);

scenario(
  'MainnetBulker > deposit() on MainnetBulkerWithWstETHSupport when comet baseToken is not wstETH reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && !await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, bulker }, context) => {
    const wstethAddr = await (bulker as MainnetBulker).wsteth();
    const freshBulker = await context.world.deploymentManager.deploy(
      'bulkerFreshWithWstETHSupport',
      'bulkers/MainnetBulkerWithWstETHSupport.sol',
      [await bulker.admin(), await bulker.wrappedNativeToken(), wstethAddr],
      true
    );
    const freshWithWstETH = await context.world.deploymentManager.hre.ethers.getContractAt(
      'MainnetBulkerWithWstETHSupport', freshBulker.address
    ) as MainnetBulkerWithWstETHSupport;
    const adminSigner = await context.world.impersonateAddress(await bulker.admin(), { value: exp(0.1, 18) });
    await expect(
      freshWithWstETH.connect(adminSigner).deposit(comet.address, { value: exp(0.01, 18) })
    ).to.be.revertedWith("custom error 'UnsupportedBaseAsset()'");
  }
);

scenario(
  'MainnetBulker > ACTION_SUPPLY_STETH doTransferIn with a false-returning stETH reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && !await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, actors, bulker }, context) => {
    const { albert } = actors;
    const falseToken = await context.world.deploymentManager.deploy(
      'bulkerFalseStETH',
      'test/FalseReturnToken.sol',
      [],
      true
    );
    const mockWstETH = await context.world.deploymentManager.deploy(
      'bulkerMockWstETH',
      'test/MockWstETH.sol',
      [falseToken.address],
      true
    );
    const freshBulker = await context.world.deploymentManager.deploy(
      'bulkerFreshMainnetBulkerUH17',
      'bulkers/MainnetBulker.sol',
      [await bulker.admin(), await bulker.wrappedNativeToken(), mockWstETH.address],
      true
    );
    const freshMainnetBulker = await context.world.deploymentManager.hre.ethers.getContractAt(
      'MainnetBulker', freshBulker.address
    ) as MainnetBulker;
    const actionCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint'],
      [comet.address, albert.address, exp(0.01, 18)]
    );
    await expect(
      freshMainnetBulker.connect(albert.signer).invoke(
        [await freshMainnetBulker.ACTION_SUPPLY_STETH()],
        [actionCalldata]
      )
    ).to.be.revertedWith("custom error 'TransferInFailed()'");
  }
);

scenario(
  'MainnetBulker > deposit() called by non-admin reverts',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && matchesDeployment(ctx, [{ network: 'mainnet', deployment: 'wsteth' }]),
  },
  async ({ comet, actors, bulker }) => {
    const { albert } = actors;
    await expect(
      (bulker as MainnetBulkerWithWstETHSupport).connect(albert.signer).deposit(comet.address, { value: exp(0.01, 18) })
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  }
);

scenario(
  'MainnetBulkerWithWstETHSupport > deposit() with pre-existing wstETH sweeps total balance into Comet',
  {
    filter: async (ctx) => await isBulkerSupported(ctx) && await isWstETHBase(ctx) && matchesDeployment(ctx, [{ network: 'mainnet' }]),
  },
  async ({ comet, bulker }, context) => {
    const wstETH = await context.world.deploymentManager.hre.ethers.getContractAt('contracts/IWstETH.sol:IWstETH', MAINNET_WSTETH_ADDRESS) as IWstETH;

    const extraWstEth = exp(0.01, 18);
    const wstEthWhale = await context.world.impersonateAddress('0x0B925eD163218f6662a35e0f0371Ac234f9E9371', { value: exp(0.1, 18) });
    await wstETH.connect(wstEthWhale).transfer(bulker.address, extraWstEth);

    const ethAmount = exp(0.05, 18);
    const expectedNewWstEth = (await wstETH.getWstETHByStETH(ethAmount)).toBigInt();
    const cometWstEthBefore = (await wstETH.balanceOf(comet.address)).toBigInt();

    const adminSigner = await context.world.impersonateAddress(await bulker.admin(), { value: ethAmount + exp(0.1, 18) });
    await (bulker as MainnetBulkerWithWstETHSupport).connect(adminSigner).deposit(comet.address, { value: ethAmount });

    // Both the pre-existing wstETH and the newly wrapped ETH amount go to Comet.
    expectApproximately(
      (await wstETH.balanceOf(comet.address)).toBigInt() - cometWstEthBefore,
      extraWstEth + expectedNewWstEth,
      2n
    );
    expect(await wstETH.balanceOf(bulker.address)).to.be.equal(0);
  }
);