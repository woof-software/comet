import { ethers, exp, expect, setBalance } from '../helpers';
import {
  CometInterface,
  CometWithExtendedAssetList__factory,
  CometExtAssetList__factory,
  AssetListFactory__factory,
  SimplePriceFeed__factory,
  SimplePriceFeed,
  FaucetToken,
  FaucetToken__factory,
  LiquidationModule,
  LiquidationModule__factory,
  ReentrantDexAdapter,
  ReentrantDexAdapter__factory,
} from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../helpers/snapshot';

// Comet operations lock (audit finding M-02 hardening).
//
// A DEX liquidation writes its outcome into Comet — collateral seized, debt cleared — before the collateral
// is actually sold, and only then hands control to a router. In that window Comet reports a debt as repaid
// while the base repaying it is still in flight, so reserves and utilization read low. `liquidate` therefore
// holds Comet's operations lock for the whole call: every guarded operation reverts with `OperationsLocked`
// until the liquidation finishes.
//
// The market below is built so the DEX route runs end to end with a re-entrant call planted inside the swap.
// The attack rides in on the router calldata the liquidation forwards to the adapter, so each context just
// encodes the Comet call it wants tried inside the swap window. The guard runs before any of the operation's own checks, so the planted call
// needs no funding or permission of its own: the lock is the first thing it meets.
describe('comet operations lock', function () {
  const INCENTIVE_BPS = BigInt(500);

  // The swap data the module forwards to the adapter: the contract to call, and the call to make on it.
  const attack = (target: string, callData: string) =>
    [ethers.utils.defaultAbiCoder.encode(['address', 'bytes'], [target, callData])];

  // Market setup: 1 WETH of collateral against a 1,500 USDC borrow, then WETH is repriced from
  // $2,000 to $1,700 — below the 0.85 liquidate collateral factor, so the position is liquidatable.
  const COLLATERAL_SUPPLIED = exp(1, 18);
  const BASE_BORROWED = exp(1_500, 6);
  const BASE_LIQUIDITY = exp(200_000, 6);
  const WETH_PRICE_INITIAL = exp(2_000, 8);
  const WETH_PRICE_DROPPED = exp(1_700, 8);

  let comet: CometInterface;
  let liquidationModule: LiquidationModule;
  let dexAdapter: ReentrantDexAdapter;

  let usdc: FaucetToken;
  let weth: FaucetToken;
  let wethFeed: SimplePriceFeed;

  let governor: SignerWithAddress; // also the DAO holding DEFAULT_ADMIN_ROLE
  let pauseGuardian: SignerWithAddress;
  let multisig: SignerWithAddress;
  let executor: SignerWithAddress;
  let pauser: SignerWithAddress;
  let lender: SignerWithAddress;
  let borrower: SignerWithAddress; // the underwater account being liquidated
  let other: SignerWithAddress; // holds no role and no position

  let snapshot: SnapshotRestorer;

  before(async () => {
    const signers = await ethers.getSigners();
    [, pauseGuardian, multisig, executor, pauser, lender, borrower, other] = signers;

    // The DAO (DEFAULT_ADMIN_ROLE) is the hardcoded governance timelock.
    governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));

    // ── Market tokens: USDC base + WETH collateral ──
    const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    usdc = await (await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC')).deployed() as FaucetToken;
    weth = await (await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH')).deployed() as FaucetToken;

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await (await PriceFeedFactory.deploy(exp(1, 8), 8)).deployed() as SimplePriceFeed;
    wethFeed = await (await PriceFeedFactory.deploy(WETH_PRICE_INITIAL, 8)).deployed() as SimplePriceFeed;

    // ── Asset list factory + extension delegate ──
    const AssetListFactoryFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await (await AssetListFactoryFactory.deploy()).deployed();
    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await (await CometExtFactory.deploy(
      {
        name32: ethers.utils.formatBytes32String('Compound Comet'),
        symbol32: ethers.utils.formatBytes32String('Comet'),
      },
      assetListFactory.address
    )).deployed();

    // ── DEX adapter that re-enters Comet during the swap ──
    const AdapterFactory = (await ethers.getContractFactory('ReentrantDexAdapter')) as ReentrantDexAdapter__factory;
    dexAdapter = await (await AdapterFactory.deploy()).deployed() as ReentrantDexAdapter;

    // ── Liquidation module bound to that adapter ──
    const ModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    liquidationModule = await (await ModuleFactory.deploy(
      dexAdapter.address,
      multisig.address,
      [executor.address],
      [pauser.address],
      INCENTIVE_BPS
    )).deployed() as LiquidationModule;

    // ── Comet ──
    const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const cometContract = await (await CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: liquidationModule.address,
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
      baseTrackingSupplySpeed: exp(0, 15),
      baseTrackingBorrowSpeed: exp(0, 15),
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
          supplyCap: exp(1_000_000, 18),
        },
      ],
    })).deployed();
    await cometContract.initializeStorage();
    comet = await ethers.getContractAt('CometInterface', cometContract.address) as CometInterface;

    // ── Funding ──
    // The lender seeds base liquidity so the borrow is fundable, and so re-entrant borrow-side
    // operations fail on the lock rather than on an empty market.
    await usdc.allocateTo(lender.address, BASE_LIQUIDITY);
    await usdc.connect(lender).approve(comet.address, BASE_LIQUIDITY);
    await comet.connect(lender).supply(usdc.address, BASE_LIQUIDITY);

    // `other` is funded but holds no position, so it can attempt guarded operations of its own.
    await usdc.allocateTo(other.address, BASE_LIQUIDITY);
    await weth.allocateTo(other.address, COLLATERAL_SUPPLIED);
    await usdc.connect(other).approve(comet.address, ethers.constants.MaxUint256);
    await weth.connect(other).approve(comet.address, ethers.constants.MaxUint256);

    // ── The position that will be liquidated ──
    await weth.allocateTo(borrower.address, COLLATERAL_SUPPLIED);
    await weth.connect(borrower).approve(comet.address, COLLATERAL_SUPPLIED);
    await comet.connect(borrower).supply(weth.address, COLLATERAL_SUPPLIED);
    await comet.connect(borrower).withdraw(usdc.address, BASE_BORROWED);

    // Reprice WETH so the position falls under the liquidate collateral factor.
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    await wethFeed.setRoundData(1, WETH_PRICE_DROPPED, now, now, 1);

    snapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                  REENTRANT ATTACK ON COMET (SUPPLY)
  //////////////////////////////////////////////////////////////*/

  // The router a liquidation swaps through is arbitrary code, so it is the natural place to try to re-enter
  // Comet. The supply planted here is valid in every other respect — a funded account, an allowance to Comet
  // and a manager permission for the adapter — which leaves the operations lock as the only thing that can
  // reject it.
  context('reverts on reentrant attack on comet (supplyFrom operation)', function () {
    const SUPPLY_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('supplyFrom', [other.address, other.address, usdc.address, SUPPLY_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  context('reverts on reentrant attack on comet (supply operation)', function () {
    const SUPPLY_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('supply', [usdc.address, SUPPLY_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  // Both branches of supplyInternal sit behind the same guard, so the collateral branch is closed too.
  context('reverts on reentrant attack on comet (supply operation, collateral asset)', function () {
    const COLLATERAL_AMOUNT = exp(1, 18);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('supply', [weth.address, COLLATERAL_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  context('reverts on reentrant attack on comet (supplyTo operation)', function () {
    const SUPPLY_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('supplyTo', [other.address, usdc.address, SUPPLY_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  // A withdraw of base is the borrow side of the market, the side whose rate the unfinished
  // liquidation distorts, so it is the operation with the most to gain from re-entering.
  context('reverts on reentrant attack on comet (withdraw operation)', function () {
    const WITHDRAW_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('withdraw', [usdc.address, WITHDRAW_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  // Both branches of withdrawInternal sit behind the same guard, so the collateral branch is closed too.
  context('reverts on reentrant attack on comet (withdraw operation, collateral asset)', function () {
    const COLLATERAL_AMOUNT = exp(1, 18);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('withdraw', [weth.address, COLLATERAL_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  context('reverts on reentrant attack on comet (withdrawTo operation)', function () {
    const WITHDRAW_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('withdrawTo', [other.address, usdc.address, WITHDRAW_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  context('reverts on reentrant attack on comet (withdrawFrom operation)', function () {
    const WITHDRAW_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('withdrawFrom', [other.address, other.address, usdc.address, WITHDRAW_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  // Every transfer entry point funnels through transferInternal, which carries the guard.
  context('reverts on reentrant attack on comet (transfer operation)', function () {
    const TRANSFER_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('transfer', [other.address, TRANSFER_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  context('reverts on reentrant attack on comet (transferFrom operation)', function () {
    const TRANSFER_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('transferFrom', [other.address, lender.address, TRANSFER_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  context('reverts on reentrant attack on comet (transferAsset operation, collateral asset)', function () {
    const COLLATERAL_AMOUNT = exp(1, 18);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('transferAsset', [other.address, weth.address, COLLATERAL_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  context('reverts on reentrant attack on comet (transferAssetFrom operation)', function () {
    const TRANSFER_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('transferAssetFrom', [other.address, lender.address, usdc.address, TRANSFER_AMOUNT]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });

  // The operation the lock exists for: mid-liquidation the cleared debt is on the books while the base
  // repaying it is still in flight, so reserves read low and collateral looks up for sale at a discount.
  context('reverts on reentrant attack on comet (buyCollateral operation)', function () {
    const BASE_AMOUNT = exp(100, 6);

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(borrower.address)).to.equal(true);
    });

    it('reverts with OperationsLocked', async () => {
      const swapData = attack(comet.address, comet.interface.encodeFunctionData('buyCollateral', [weth.address, 0, BASE_AMOUNT, other.address]));

      await expect(liquidationModule.connect(executor).liquidate(executor.address, borrower.address, swapData))
        .to.be.revertedWithCustomError(comet, 'OperationsLocked');
    });

    it('leaves the borrower collateral untouched', async () => {
      expect(await comet.collateralBalanceOf(borrower.address, weth.address)).to.equal(COLLATERAL_SUPPLIED);
    });

    it('leaves the borrower debt untouched', async () => {
      // The liquidation reverted, so the debt is exactly what was borrowed, interest included.
      expect(await comet.borrowBalanceOf(borrower.address)).to.be.equal(BASE_BORROWED);
    });
  });
});
