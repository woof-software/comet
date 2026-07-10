import hre from 'hardhat';
import {
  ethers,
  expect,
  exp,
  setErc20Balance,
  setBalance,
  takeSnapshot,
  TOKENS,
  MARKETS,
  buildRoutesFromList,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  fetch1inchSwapData,
  CHAIN_ID,
  ONEINCH_SLIPPAGE_PCT,
  AMM_PROTOCOLS,
} from '../helpers';
import {
  CometInterface,
  CometWithExtendedAssetList__factory,
  CometExtAssetList__factory,
  AssetListFactory__factory,
  LiquidationModule,
  LiquidationModule__factory,
  OneInchV6Adapter,
  OneInchV6Adapter__factory,
  ERC20,
  ERC20__factory,
  SimplePriceFeed,
  SimplePriceFeed__factory,
  LiquidationSeizureView,
  LiquidationSeizureView__factory,
} from '../../build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// Test of a view helper calculating seizure plan at future timestamp, at which the liquidation will occur.
describe('LiquidationSeizureView', function () {
  this.timeout(600_000);

  const INCENTIVE_BPS = 500n; // 5%
  const WBTC_INITIAL_PRICE = exp(60_000, 8);
  const WBTC_DROPPED_PRICE = exp(50_000, 8);
  const LENDER_USDC = exp(20_000, 6);
  const WBTC_COLLATERAL = exp(0.16, 8); // sized so the seizure stays partial (and grows with the debt)
  const BORROW_USDC = exp(7_000, 6);
  // The keeper reads the plan now but expects the liquidation to mine ~1 day out; the debt accrues until then.
  const ACCRUAL_BUFFER = 24 * 3600;

  let comet: CometInterface;
  let adapter: OneInchV6Adapter;
  let liquidationModule: LiquidationModule;
  let seizureView: LiquidationSeizureView;

  let usdc: ERC20;
  let wbtc: ERC20;
  let wbtcFeed: SimplePriceFeed;

  let executor: SignerWithAddress;
  let borrower: SignerWithAddress;
  let lender: SignerWithAddress;
  let absorber: SignerWithAddress;

  let execTimestamp: number;
  let planNow: Awaited<ReturnType<LiquidationModule['seizurePlan']>>;
  let viewPlan: Awaited<ReturnType<LiquidationSeizureView['seizurePlanAt']>>;
  let groundTruthPlan: Awaited<ReturnType<LiquidationModule['seizurePlan']>>;
  let debtNow: bigint;
  let debtAtExec: bigint;

  before(async () => {
    await hre.network.provider.request({
      method: 'hardhat_reset',
      params: [{ forking: { jsonRpcUrl: process.env.MAINNET_QUICKNODE_LINK } }],
    });

    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const pauseGuardian = signers[1];
    executor = signers[2];
    const multisig = signers[8];
    [borrower, lender, absorber] = [signers[9], signers[10], signers[11]];

    // The Comet governor must be the hardcoded DAO.
    const governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));

    // Adapter with the WBTC swap route.
    const routes = buildRoutesFromList([TOKENS.WBTC.address], MARKETS.usdc.routes);
    const AdapterFactory = (await ethers.getContractFactory('OneInchV6Adapter')) as OneInchV6Adapter__factory;
    adapter = await (await AdapterFactory.deploy(CORE_ROUTER, REDUNDANT_ROUTER, TOKENS.WETH.address, SLIPPAGE_BPS, routes)).deployed();

    // Keeper liquidation module bound to the adapter.
    const LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    liquidationModule = await (
      await LiquidationModuleFactory.deploy(adapter.address, multisig.address, [executor.address], [signers[5].address], INCENTIVE_BPS)
    ).deployed();

    // Price feeds + asset list infra.
    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await (await PriceFeedFactory.deploy(exp(1, 8), 8)).deployed();
    wbtcFeed = await (await PriceFeedFactory.deploy(WBTC_INITIAL_PRICE, 8)).deployed();

    const AssetListFactoryFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await (await AssetListFactoryFactory.deploy()).deployed();
    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await (
      await CometExtFactory.deploy(
        { name32: ethers.utils.formatBytes32String('Compound Comet'), symbol32: ethers.utils.formatBytes32String('📈BASE') },
        assetListFactory.address
      )
    ).deployed();

    // Comet with a non-zero borrow rate so the debt visibly accrues over the buffer. Reward tracking is
    // disabled (threshold above the whole market) so the long time-jump only accrues the base index.
    const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const cometContract = await CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: liquidationModule.address,
      baseToken: TOKENS.USDC.address,
      baseTokenPriceFeed: usdcFeed.address,
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0, 18),
      supplyPerYearInterestRateSlopeHigh: exp(0, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(1, 18), // 100% APR — makes the accrual visible over the buffer
      borrowPerYearInterestRateSlopeLow: exp(0, 18),
      borrowPerYearInterestRateSlopeHigh: exp(0, 18),
      storeFrontPriceFactor: exp(1, 18),
      trackingIndexScale: exp(1, 15),
      baseTrackingSupplySpeed: exp(1, 15),
      baseTrackingBorrowSpeed: exp(1, 15),
      baseMinForRewards: exp(1_000_000_000_000, 6),
      baseBorrowMin: 0,
      targetReserves: 0,
      assetConfigs: [
        {
          asset: TOKENS.WBTC.address,
          priceFeed: wbtcFeed.address,
          decimals: 8,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(1_000, 8),
        },
      ],
    });
    await cometContract.deployed();
    await cometContract.initializeStorage();
    comet = (await ethers.getContractAt('CometInterface', cometContract.address)) as CometInterface;

    usdc = ERC20__factory.connect(TOKENS.USDC.address, ethers.provider);
    wbtc = ERC20__factory.connect(TOKENS.WBTC.address, ethers.provider);

    // The view helper, bound to the (now fully wired) module.
    seizureView = await (await new LiquidationSeizureView__factory(deployer).deploy(liquidationModule.address)).deployed();
  });

  context('calculates seizurePlanAt', function () {
    before(async () => {
      // Liquidatable single-WBTC position: lender funds base, borrower borrows near its limit, price then drops.
      await setErc20Balance(TOKENS.USDC.address, lender.address, LENDER_USDC, TOKENS.USDC.slot);
      await usdc.connect(lender).approve(comet.address, ethers.constants.MaxUint256);
      await comet.connect(lender).supply(TOKENS.USDC.address, LENDER_USDC);

      await setErc20Balance(TOKENS.WBTC.address, borrower.address, WBTC_COLLATERAL, TOKENS.WBTC.slot);
      await wbtc.connect(borrower).approve(comet.address, ethers.constants.MaxUint256);
      await comet.connect(borrower).supply(TOKENS.WBTC.address, WBTC_COLLATERAL);
      await comet.connect(borrower).withdraw(TOKENS.USDC.address, BORROW_USDC);

      await wbtcFeed.setRoundData(0, WBTC_DROPPED_PRICE, 0, 0, 0);
      await comet.accrueAccount(borrower.address);
      expect(await comet.isLiquidatable(borrower.address)).to.be.true;

      const now = (await ethers.provider.getBlock('latest')).timestamp;
      execTimestamp = now + ACCRUAL_BUFFER;

      planNow = await liquidationModule.seizurePlan(borrower.address);
      debtNow = (await comet.borrowBalanceOf(borrower.address)).toBigInt();

      // Store values, a real liquidation would seize at the liquidation timestamp.
      const snapshot = await takeSnapshot();
      await ethers.provider.send('evm_setNextBlockTimestamp', [execTimestamp]);
      await comet.accrueAccount(borrower.address);
      groundTruthPlan = await liquidationModule.seizurePlan(borrower.address);
      debtAtExec = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
      await snapshot.restore();
    });

    it('calls seizurePlanAt for the future timestamp', async () => {
      viewPlan = await seizureView.seizurePlanAt(borrower.address, execTimestamp);
      expect(viewPlan.length).to.equal(1);
      expect(viewPlan[0].asset).to.equal(TOKENS.WBTC.address);
      expect(viewPlan[0].seizedAmount.gt(0)).to.be.true;
    });

    it('matches the plan the module computes after accruing to that timestamp', () => {
      expect(viewPlan.length).to.equal(groundTruthPlan.length);
      for (let i = 0; i < groundTruthPlan.length; i++) {
        expect(viewPlan[i].asset).to.equal(groundTruthPlan[i].asset);
        expect(viewPlan[i].seizedAmount).to.equal(groundTruthPlan[i].seizedAmount);
        expect(viewPlan[i].seizedValue).to.equal(groundTruthPlan[i].seizedValue);
        expect(viewPlan[i].wantedCollateralValue).to.equal(groundTruthPlan[i].wantedCollateralValue);
      }
      // The projection is non-trivial: the debt accrued, so the seizure is larger than at the current block.
      expect(debtAtExec).to.be.greaterThan(debtNow);
      expect(viewPlan[0].seizedAmount.gt(planNow[0].seizedAmount)).to.be.true;
    });

    it('liquidates at that timestamp with 1inch quotes sized from the view plan', async () => {
      // One 1inch quote per planned seizure, sized to the amount the VIEW projected for execTimestamp.
      const swapData = await Promise.all(
        viewPlan.map((s) =>
          fetch1inchSwapData({
            chainId: CHAIN_ID,
            src: s.asset,
            dst: TOKENS.USDC.address,
            amount: s.seizedAmount.toString(),
            from: adapter.address,
            slippage: ONEINCH_SLIPPAGE_PCT,
            protocols: AMM_PROTOCOLS,
          })
        )
      );

      const collateralBefore = new Map<string, bigint>();
      for (const s of viewPlan) {
        collateralBefore.set(s.asset, (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt());
      }
      const debtBefore = (await comet.borrowBalanceOf(borrower.address)).toBigInt();

      // Mine the liquidation at the SAME timestamp the view planned for, so the module accrues to the identical
      // state and recomputes exactly the view's seizures — the 1inch calldata matches and the swap does not revert.
      await ethers.provider.send('evm_setNextBlockTimestamp', [execTimestamp]);
      const tx = await liquidationModule.connect(executor).liquidate(absorber.address, borrower.address, swapData);
      await tx.wait();

      // The swap consumed exactly the quoted amounts (no InvalidAmountIn) and did not fall back to absorbing.
      await expect(tx).to.not.emit(adapter, 'RedundantSwapFailed');
      for (const s of viewPlan) {
        const after = (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt();
        expect(collateralBefore.get(s.asset)! - after).to.equal(s.seizedAmount.toBigInt());
      }

      // Debt was reduced and the borrower is healthy again.
      expect((await comet.borrowBalanceOf(borrower.address)).toBigInt()).to.be.lessThan(debtBefore);
      expect(await liquidationModule.isLiquidatable(borrower.address)).to.be.false;
    });
  });
});
