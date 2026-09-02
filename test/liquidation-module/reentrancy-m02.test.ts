import { ethers, exp, expect, setBalance } from '../helpers';
import {
  CometInterface,
  CometWithExtendedAssetList__factory,
  CometExtAssetList__factory,
  AssetListFactory__factory,
  SimplePriceFeed__factory,
  FaucetToken,
  FaucetToken__factory,
  LiquidationModule,
  LiquidationModule__factory,
  ReentrantDexAdapter,
  ReentrantDexAdapter__factory,
  ReentrantBorrower,
  ReentrantBorrower__factory,
} from 'build/types';

/**
 * Regression test for audit finding M-02: reentrancy during a DEX liquidation.
 */
describe('M-02 — DEX liquidation reentrancy (fixed)', function () {
  it('a reentrant borrow during the swap persists as real debt — no base is stolen', async () => {
    const signers = await ethers.getSigners();
    const [, pauseGuardian, multisig, executor, pauser] = signers;
    const lender = signers[9];

    const governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));

    // ── Market tokens: USDC base + WETH collateral ──
    const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const usdc = (await (await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC')).deployed()) as FaucetToken;
    const weth = (await (await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH')).deployed()) as FaucetToken;

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await (await PriceFeedFactory.deploy(exp(1, 8), 8)).deployed();
    const wethFeed = await (await PriceFeedFactory.deploy(exp(2000, 8), 8)).deployed();

    const AssetListFactoryFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await (await AssetListFactoryFactory.deploy()).deployed();
    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await (await CometExtFactory.deploy(
      { name32: ethers.utils.formatBytes32String('Compound Comet'), symbol32: ethers.utils.formatBytes32String('BASE') },
      assetListFactory.address
    )).deployed();

    // ── Malicious DEX adapter (reenters during swap) ──
    const AdapterFactory = (await ethers.getContractFactory('ReentrantDexAdapter')) as ReentrantDexAdapter__factory;
    const adapter = (await (await AdapterFactory.deploy()).deployed()) as ReentrantDexAdapter;

    // ── Liquidation module bound to the malicious adapter ──
    const ModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    const module = (await (await ModuleFactory.deploy(
      adapter.address, multisig.address, [executor.address], [pauser.address], BigInt(500)
    )).deployed()) as LiquidationModule;

    // ── Comet ──
    const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const cometContract = await (await CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: module.address,
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
      assetConfigs: [{
        asset: weth.address,
        priceFeed: wethFeed.address,
        decimals: 18,
        borrowCollateralFactor: exp(0.8, 18),
        liquidateCollateralFactor: exp(0.85, 18),
        liquidationFactor: exp(0.9, 18),
        supplyCap: exp(1_000_000, 18),
      }],
    })).deployed();
    await cometContract.initializeStorage();
    const comet = (await ethers.getContractAt('CometInterface', cometContract.address)) as CometInterface;

    // ── Attacker account ──
    const BorrowerFactory = (await ethers.getContractFactory('ReentrantBorrower')) as ReentrantBorrower__factory;
    const borrower = (await (await BorrowerFactory.deploy()).deployed()) as ReentrantBorrower;

    // ── Funding ──
    await usdc.allocateTo(lender.address, exp(200_000, 6));
    await weth.allocateTo(borrower.address, exp(101, 18)); // 1 WETH initial + 100 WETH flash loan

    // Lender seeds base liquidity so the borrows are fundable.
    await usdc.connect(lender).approve(comet.address, exp(200_000, 6));
    await comet.connect(lender).supply(usdc.address, exp(200_000, 6));

    // Attack params: flash-supply 100 WETH, borrow 100,000 USDC during the reentrancy.
    await borrower.configure(comet.address, usdc.address, weth.address, exp(100, 18), exp(100_000, 6));

    // Open the small position that will be liquidated: supply 1 WETH, borrow 1,500 USDC.
    await borrower.openPosition(exp(1, 18), exp(1_500, 6));

    // Point the adapter at the attacker and drop WETH so the small position is liquidatable.
    await adapter.setReentrantCall(borrower.address, borrower.interface.encodeFunctionData('attack'));
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    await wethFeed.setRoundData(1, exp(1_700, 8), now, now, 1);
    expect(await comet.isLiquidatable(borrower.address)).to.equal(true);

    // ── Snapshot before the attack ──
    const usdcBefore = await usdc.balanceOf(borrower.address);          // ~1,500 (initial borrow)

    // ── Keeper liquidates → DEX route → swap → reentrancy → debt already finalized, borrow survives ──
    await module.connect(executor).liquidate(executor.address, borrower.address, ['0x']);

    // ── Results (measured right after the liquidation) ──
    const debtAfter = await comet.borrowBalanceOf(borrower.address);
    const usdcAfter = await usdc.balanceOf(borrower.address);
    const gainedUsdc = usdcAfter.sub(usdcBefore);
    const collAfter = await comet.collateralBalanceOf(borrower.address, weth.address);

    console.log(`  reentrant borrow drawn:    ${ethers.utils.formatUnits(gainedUsdc, 6)} USDC`);
    console.log(`  debt owed after:           ${ethers.utils.formatUnits(debtAfter, 6)} USDC (reentrant borrow persists)`);

    // 1) The reentrant borrow still executed (attacker received the base) — the attack path runs…
    expect(gainedUsdc.gte(exp(100_000, 6))).to.equal(true);
    // 2) …but it is NOT erased: the account owes at least the base it drew, so there is no free base.
    expect(debtAfter.gte(gainedUsdc)).to.equal(true);
    // 3) The position is properly collateralized against that debt, so the flash-supplied collateral is locked.
    await expect(borrower.withdrawCollateral(collAfter))
      .to.be.revertedWithCustomError(comet, 'NotCollateralized');
  });
});
