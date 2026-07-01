import hre from 'hardhat';
import {
  ethers,
  expect,
  exp,
  makeProtocol,
  setErc20Balance,
  setBalance,
  takeSnapshot,
  SnapshotRestorer,
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
  CometHarnessInterfaceExtendedAssetList,
  LiquidationModule,
  OneInchV6CoreAdapter,
  OneInchV6CoreAdapter__factory,
  ERC20,
  ERC20__factory,
  SimplePriceFeed,
} from '../../build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber } from 'ethers';

// End-to-end keeper DEX liquidations against a fresh Comet that uses REAL mainnet USDC-market tokens, so the
// seized collateral is actually swapped on a fork through 1inch. Prices are mock SimplePriceFeeds (kept well
// below real market prices) so we can push the position into liquidation while keeping the adapter's
// oracle-derived minimum conservative. Swap calldata is built from the on-chain `seizurePlan`, exactly as a
// keeper would, and the per-collateral seized amounts are also asserted against the plan (not events).
describe('liquidation module dex route', function () {
  this.timeout(600_000);

  const PENALTY_BPS: bigint = BigInt(500); // 5%
  const BPS = 10_000n;

  // The Comet's collateral set (>= 5 real USDC-market tokens), in asset-list order.
  const COLLATERALS = [
    TOKENS.WBTC.address,
    TOKENS.WETH.address,
    TOKENS.UNI.address,
    TOKENS.LINK.address,
    TOKENS.WSTETH.address,
  ];

  const WBTC_PRICE = 60_000;
  const WETH_PRICE = 1_600;
  const WSTETH_PRICE = 1_950;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let adapter: OneInchV6CoreAdapter;
  let liquidationModule: LiquidationModule;

  let usdc: ERC20;
  let wbtc: ERC20;
  let weth: ERC20;
  let wsteth: ERC20;
  let uni: ERC20;
  let link: ERC20;
  let wbtcFeed: SimplePriceFeed;
  let wethFeed: SimplePriceFeed;
  let wstethFeed: SimplePriceFeed;
  let uniFeed: SimplePriceFeed;
  let linkFeed: SimplePriceFeed;

  let governor: SignerWithAddress;
  let executor: SignerWithAddress;
  let borrower: SignerWithAddress;
  let lender: SignerWithAddress;
  let absorber: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  type PlanItem = { asset: string; seizedAmount: BigNumber; seizedValue: BigNumber };

  // Builds one 1inch swap quote per planned seizure, aligned to the plan order the contract iterates.
  const quotePlan = async (plan: PlanItem[]): Promise<string[]> => {
    const swapData: string[] = [];
    for (const s of plan) {
      swapData.push(
        await fetch1inchSwapData({
          chainId: CHAIN_ID,
          src: s.asset,
          dst: TOKENS.USDC.address,
          amount: s.seizedAmount.toString(),
          from: adapter.address,
          slippage: ONEINCH_SLIPPAGE_PCT,
          protocols: AMM_PROTOCOLS,
        })
      );
    }
    return swapData;
  };

  before(async () => {
    // Fork mainnet so the real tokens and the Uniswap V4 / 1inch routers exist.
    await hre.network.provider.request({
      method: 'hardhat_reset',
      params: [{ forking: { jsonRpcUrl: process.env.MAINNET_QUICKNODE_LINK } }],
    });

    // The Comet governor must be the hardcoded DAO.
    governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));

    // The adapter is deployed BEFORE the Comet (the Comet's constructor later binds it via initiateAdapter),
    // so routes are built from an explicit collateral list rather than read from the not-yet-existing Comet.
    // UNI is intentionally dropped from the route map (left unset) so the five-collateral test can exercise
    // the fallback where a seized collateral has no DEX route and the adapter sweeps it back to Comet. The
    // other contexts never supply UNI, so this doesn't affect them.
    const usdcRoutesNoUni = Object.fromEntries(
      Object.entries(MARKETS.usdc.routes).filter(
        ([addr]) => addr.toLowerCase() !== TOKENS.UNI.address.toLowerCase()
      )
    );
    const routes = buildRoutesFromList(COLLATERALS, usdcRoutesNoUni);

    const AdapterFactory = (await ethers.getContractFactory('OneInchV6CoreAdapter')) as OneInchV6CoreAdapter__factory;
    adapter = await AdapterFactory.deploy(
      CORE_ROUTER,
      REDUNDANT_ROUTER,
      TOKENS.WETH.address,
      SLIPPAGE_BPS,
      routes
    );
    await adapter.deployed();

    const protocol = await makeProtocol({
      base: 'USDC',
      governor,
      baseBorrowMin: 0,
      // Zero interest so the debt-reduction assertion is exact (no accrual between snapshot and liquidate).
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
      assets: {
        USDC: { decimals: 6, initialPrice: 1, address: TOKENS.USDC.address },
        WBTC: { decimals: 8, initialPrice: WBTC_PRICE, address: TOKENS.WBTC.address },
        WETH: { decimals: 18, initialPrice: WETH_PRICE, address: TOKENS.WETH.address },
        WSTETH: { decimals: 18, initialPrice: WSTETH_PRICE, address: TOKENS.WSTETH.address },
        // Only supplied in the five-collateral context. UNI is left route-less in the adapter (see above).
        UNI: { decimals: 18, initialPrice: 10, address: TOKENS.UNI.address },
        LINK: { decimals: 18, initialPrice: 10, address: TOKENS.LINK.address },
      },
      dexAdapter: adapter.address,
    });
    comet = protocol.comet;
    liquidationModule = protocol.defaultLiquidationModule;
    executor = protocol.executors[0];
    wbtcFeed = protocol.priceFeeds['WBTC'];
    wethFeed = protocol.priceFeeds['WETH'];
    wstethFeed = protocol.priceFeeds['WSTETH'];
    uniFeed = protocol.priceFeeds['UNI'];
    linkFeed = protocol.priceFeeds['LINK'];
    [borrower, lender, absorber] = protocol.users;

    usdc = ERC20__factory.connect(TOKENS.USDC.address, ethers.provider);
    wbtc = ERC20__factory.connect(TOKENS.WBTC.address, ethers.provider);
    weth = ERC20__factory.connect(TOKENS.WETH.address, ethers.provider);
    wsteth = ERC20__factory.connect(TOKENS.WSTETH.address, ethers.provider);
    uni = ERC20__factory.connect(TOKENS.UNI.address, ethers.provider);
    link = ERC20__factory.connect(TOKENS.LINK.address, ethers.provider);
  });

  // Supplies `amount` of base liquidity from the lender so the borrower can draw USDC.
  const supplyBase = async (amount: bigint) => {
    await setErc20Balance(TOKENS.USDC.address, lender.address, amount, TOKENS.USDC.slot);
    await usdc.connect(lender).approve(comet.address, ethers.constants.MaxUint256);
    await comet.connect(lender).supply(TOKENS.USDC.address, amount);
  };

  // Borrower supplies a real collateral amount.
  const supplyCollateral = async (token: ERC20, info: { address: string; slot: number | string }, amount: bigint) => {
    await setErc20Balance(info.address, borrower.address, amount, info.slot);
    await token.connect(borrower).approve(comet.address, ethers.constants.MaxUint256);
    await comet.connect(borrower).supply(info.address, amount);
  };

  context('one collateral is seized and swapped through the DEX route', function () {
    const LENDER_USDC = exp(20_000, 6);
    const WBTC_COLLATERAL = exp(1.5, 7);
    const BORROW_USDC = exp(7_000, 6);
    const WBTC_PRICE_DROPPED = exp(50_000, 8);

    let plan: PlanItem[];
    let swapData: string[];
    let cometUsdcBefore: bigint;
    let executorUsdcBefore: bigint;
    let borrowBefore: bigint;
    const collateralBefore = new Map<string, bigint>();
    const cometBalanceBefore = new Map<string, bigint>();

    let tx: Awaited<ReturnType<LiquidationModule['liquidate']>>;

    before(async () => {
      snapshot = await takeSnapshot();

      await supplyBase(LENDER_USDC);
      await supplyCollateral(wbtc, TOKENS.WBTC, WBTC_COLLATERAL);
      await comet.connect(borrower).withdraw(TOKENS.USDC.address, BORROW_USDC);

      await wbtcFeed.setRoundData(0, WBTC_PRICE_DROPPED, 0, 0, 0);
      await comet.accrueAccount(borrower.address);

      plan = await liquidationModule.seizurePlan(borrower.address);
      swapData = await quotePlan(plan);

      cometUsdcBefore = (await usdc.balanceOf(comet.address)).toBigInt();
      executorUsdcBefore = (await usdc.balanceOf(executor.address)).toBigInt();
      borrowBefore = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
      for (const s of plan) {
        collateralBefore.set(s.asset, (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt());
        cometBalanceBefore.set(
          s.asset,
          (await ERC20__factory.connect(s.asset, ethers.provider).balanceOf(comet.address)).toBigInt()
        );
      }
    });

    after(async () => await snapshot.restore());

    it('liquidates through the DEX route with the 1inch quote', async () => {
      tx = await liquidationModule
        .connect(executor)
        .liquidate(absorber.address, borrower.address, swapData);
      await tx.wait();
    });

    it('did not fall back to absorbing the collateral', async () => {
      await expect(tx).to.not.emit(adapter, 'RedundantSwapFailed');
    });

    it('seizes exactly the planned amount from the borrower and removes it from Comet', async () => {
      for (const s of plan) {
        // Borrower's collateral accounting drops by the seized amount...
        const accountAfter = (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt();
        expect(collateralBefore.get(s.asset)! - accountAfter).to.equal(s.seizedAmount.toBigInt());

        // ...and the tokens physically leave Comet (sold, not swept back as on a failed swap).
        const cometAfter = (await ERC20__factory.connect(s.asset, ethers.provider).balanceOf(comet.address)).toBigInt();
        expect(cometBalanceBefore.get(s.asset)! - cometAfter).to.equal(s.seizedAmount.toBigInt());
      }
    });

    it('reduces the borrower debt and restores the position', async () => {
      const borrowAfter = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
      expect(borrowAfter).to.be.lessThan(borrowBefore);
      expect(await liquidationModule.isLiquidatable(borrower.address)).to.be.false;
    });

    it('sends proceeds to Comet and exactly penaltyBps of the realized base to the executor', async () => {
      const baseRepaid = (await usdc.balanceOf(comet.address)).toBigInt() - cometUsdcBefore;
      const penalty = (await usdc.balanceOf(executor.address)).toBigInt() - executorUsdcBefore;
      const baseReceived = baseRepaid + penalty;

      let minOut = 0n;
      for (const s of plan) {
        minOut += (await adapter.calculateMinAmountOut(s.asset, s.seizedAmount)).toBigInt();
      }
      expect(baseReceived).to.be.greaterThanOrEqual(minOut);

      expect(penalty).to.equal((baseReceived * PENALTY_BPS) / BPS);
      expect(baseRepaid).to.be.greaterThan(0n);
    });

    it('leaves no tokens stranded on the adapter or the module', async () => {
      for (const token of [usdc, wbtc]) {
        expect((await token.balanceOf(adapter.address)).toBigInt()).to.equal(0n);
        expect((await token.balanceOf(liquidationModule.address)).toBigInt()).to.equal(0n);
      }
    });
  });

  context('three collaterals are all seized and swapped through the DEX route', function () {
    const LENDER_USDC = exp(10_000, 6);
    const WBTC_COLLATERAL = exp(3, 6);
    const WETH_COLLATERAL = exp(1, 18);
    const WSTETH_COLLATERAL = exp(1, 18);
    const BORROW_USDC = exp(3_800, 6);
    // Drop every collateral price 20% 
    const WBTC_PRICE_DROPPED = exp(WBTC_PRICE * 0.8, 8);
    const WETH_PRICE_DROPPED = exp(WETH_PRICE * 0.8, 8);
    const WSTETH_PRICE_DROPPED = exp(WSTETH_PRICE * 0.8, 8);

    let plan: PlanItem[];
    let swapData: string[];
    let cometUsdcBefore: bigint;
    let executorUsdcBefore: bigint;
    let borrowBefore: bigint;
    const collateralBefore = new Map<string, bigint>();
    const cometBalanceBefore = new Map<string, bigint>();

    let tx: Awaited<ReturnType<LiquidationModule['liquidate']>>;

    before(async () => {
      snapshot = await takeSnapshot();

      await supplyBase(LENDER_USDC);
      await supplyCollateral(wbtc, TOKENS.WBTC, WBTC_COLLATERAL);
      await supplyCollateral(weth, TOKENS.WETH, WETH_COLLATERAL);
      await supplyCollateral(wsteth, TOKENS.WSTETH, WSTETH_COLLATERAL);
      await comet.connect(borrower).withdraw(TOKENS.USDC.address, BORROW_USDC);

      await wbtcFeed.setRoundData(0, WBTC_PRICE_DROPPED, 0, 0, 0);
      await wethFeed.setRoundData(0, WETH_PRICE_DROPPED, 0, 0, 0);
      await wstethFeed.setRoundData(0, WSTETH_PRICE_DROPPED, 0, 0, 0);
      await comet.accrueAccount(borrower.address);

      plan = await liquidationModule.seizurePlan(borrower.address);
      swapData = await quotePlan(plan);

      cometUsdcBefore = (await usdc.balanceOf(comet.address)).toBigInt();
      executorUsdcBefore = (await usdc.balanceOf(executor.address)).toBigInt();
      borrowBefore = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
      for (const s of plan) {
        collateralBefore.set(s.asset, (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt());
        cometBalanceBefore.set(
          s.asset,
          (await ERC20__factory.connect(s.asset, ethers.provider).balanceOf(comet.address)).toBigInt()
        );
      }
    });

    after(async () => await snapshot.restore());

    it('liquidates all three collaterals through the DEX route', async () => {
      tx = await liquidationModule
        .connect(executor)
        .liquidate(absorber.address, borrower.address, swapData);
      await tx.wait();
    });

    it('seizes all three collaterals', () => {
      expect(plan.length).to.equal(3);
    });

    it('did not fall back to absorbing any collateral', async () => {
      await expect(tx).to.not.emit(adapter, 'RedundantSwapFailed');
    });

    it('seizes exactly the planned amount from the borrower and removes it from Comet', async () => {
      for (const s of plan) {
        // Borrower's collateral accounting drops by the seized amount...
        const accountAfter = (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt();
        expect(collateralBefore.get(s.asset)! - accountAfter).to.equal(s.seizedAmount.toBigInt());

        // ...and the tokens physically leave Comet (sold, not swept back as on a failed swap).
        const cometAfter = (await ERC20__factory.connect(s.asset, ethers.provider).balanceOf(comet.address)).toBigInt();
        expect(cometBalanceBefore.get(s.asset)! - cometAfter).to.equal(s.seizedAmount.toBigInt());
      }
    });

    it('reduces the borrower debt and restores the position', async () => {
      const borrowAfter = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
      expect(borrowAfter).to.be.lessThan(borrowBefore);
      expect(await liquidationModule.isLiquidatable(borrower.address)).to.be.false;
    });

    it('sends proceeds to Comet and exactly penaltyBps of the realized base to the executor', async () => {
      const baseRepaid = (await usdc.balanceOf(comet.address)).toBigInt() - cometUsdcBefore;
      const penalty = (await usdc.balanceOf(executor.address)).toBigInt() - executorUsdcBefore;
      const baseReceived = baseRepaid + penalty;

      let minOut = 0n;
      for (const s of plan) {
        minOut += (await adapter.calculateMinAmountOut(s.asset, s.seizedAmount)).toBigInt();
      }
      expect(baseReceived).to.be.greaterThanOrEqual(minOut);

      expect(penalty).to.equal((baseReceived * PENALTY_BPS) / BPS);
      expect(baseRepaid).to.be.greaterThan(0n);
    });

    it('leaves no tokens stranded on the adapter or the module', async () => {
      for (const token of [usdc, wbtc, weth, wsteth]) {
        expect((await token.balanceOf(adapter.address)).toBigInt()).to.equal(0n);
        expect((await token.balanceOf(liquidationModule.address)).toBigInt()).to.equal(0n);
      }
    });
  });

  context('five collaterals, one without a DEX route is swept back to Comet instead of swapped', function () {
    const LENDER_USDC = exp(10_000, 6);
    const WBTC_COLLATERAL = exp(3, 6);
    const WETH_COLLATERAL = exp(1, 18);
    const WSTETH_COLLATERAL = exp(1, 18);
    const UNI_COLLATERAL = exp(180, 18);
    const LINK_COLLATERAL = exp(240, 18);
    const BORROW_USDC = exp(6_300, 6);
    const BASE_PRICE = exp(1, 8);
    const BASE_SCALE = exp(1, 6);

    // UNI swap route is unset and should be absorbed
    const isUni = (asset: string) => asset.toLowerCase() === TOKENS.UNI.address.toLowerCase();

    let plan: PlanItem[];
    let swapData: string[];
    let uniSeizedValue: bigint;
    let cometUsdcBefore: bigint;
    let borrowBefore: bigint;
    const collateralBefore = new Map<string, bigint>();
    const cometBalanceBefore = new Map<string, bigint>();
    const reservesBefore = new Map<string, bigint>();

    let tx: Awaited<ReturnType<LiquidationModule['liquidate']>>;

    before(async () => {
      snapshot = await takeSnapshot();

      await supplyBase(LENDER_USDC);
      await supplyCollateral(wbtc, TOKENS.WBTC, WBTC_COLLATERAL);
      await supplyCollateral(weth, TOKENS.WETH, WETH_COLLATERAL);
      await supplyCollateral(wsteth, TOKENS.WSTETH, WSTETH_COLLATERAL);
      await supplyCollateral(uni, TOKENS.UNI, UNI_COLLATERAL);
      await supplyCollateral(link, TOKENS.LINK, LINK_COLLATERAL);
      await comet.connect(borrower).withdraw(TOKENS.USDC.address, BORROW_USDC);

      await wbtcFeed.setRoundData(0, exp(WBTC_PRICE * 0.8, 8), 0, 0, 0);
      await wethFeed.setRoundData(0, exp(WETH_PRICE * 0.8, 8), 0, 0, 0);
      await wstethFeed.setRoundData(0, exp(WSTETH_PRICE * 0.8, 8), 0, 0, 0);
      await uniFeed.setRoundData(0, exp(8, 8), 0, 0, 0);
      await linkFeed.setRoundData(0, exp(6, 8), 0, 0, 0);
      await comet.accrueAccount(borrower.address);

      plan = await liquidationModule.seizurePlan(borrower.address);
      // Quote every seizure on 1inch EXCEPT UNI
      swapData = await Promise.all(
        plan.map((s) =>
          isUni(s.asset)
            ? Promise.resolve('0x')
            : fetch1inchSwapData({
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
      uniSeizedValue = plan.find((s) => isUni(s.asset))!.seizedValue.toBigInt();

      cometUsdcBefore = (await usdc.balanceOf(comet.address)).toBigInt();
      borrowBefore = (await comet.borrowBalanceOf(borrower.address)).toBigInt();
      for (const s of plan) {
        collateralBefore.set(s.asset, (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt());
        cometBalanceBefore.set(
          s.asset,
          (await ERC20__factory.connect(s.asset, ethers.provider).balanceOf(comet.address)).toBigInt()
        );
        reservesBefore.set(s.asset, (await comet.getCollateralReserves(s.asset)).toBigInt());
      }
    });

    after(async () => await snapshot.restore());

    it('liquidates, swapping every collateral except UNI', async () => {
      tx = await liquidationModule
        .connect(executor)
        .liquidate(absorber.address, borrower.address, swapData);
      await tx.wait();
    });

    it('falls back to absorbing the route-less collateral', async () => {
      await expect(tx).to.emit(adapter, 'RedundantSwapFailed');
    });

    it('seizes the planned amount from the borrower for every collateral', async () => {
      for (const s of plan) {
        const after = (await comet.collateralBalanceOf(borrower.address, s.asset)).toBigInt();
        expect(collateralBefore.get(s.asset)! - after).to.equal(s.seizedAmount.toBigInt());
      }
    });

    it('returns UNI to Comet as reserves while the swapped collaterals leave Comet', async () => {
      for (const s of plan) {
        const cometAfter = (await ERC20__factory.connect(s.asset, ethers.provider).balanceOf(comet.address)).toBigInt();
        const reservesAfter = (await comet.getCollateralReserves(s.asset)).toBigInt();
        if (isUni(s.asset)) {
          // Swept back: Comet's token balance is unchanged (out then back) and it becomes protocol reserves.
          expect(cometBalanceBefore.get(s.asset)! - cometAfter).to.equal(0n);
          expect(reservesAfter - reservesBefore.get(s.asset)!).to.equal(s.seizedAmount.toBigInt());
        } else {
          // Sold: the tokens left Comet and reserves are unchanged.
          expect(cometBalanceBefore.get(s.asset)! - cometAfter).to.equal(s.seizedAmount.toBigInt());
          expect(reservesAfter - reservesBefore.get(s.asset)!).to.equal(0n);
        }
      }
    });

    it('leaves no UNI stranded on the adapter or the module', async () => {
      expect((await uni.balanceOf(adapter.address)).toBigInt()).to.equal(0n);
      expect((await uni.balanceOf(liquidationModule.address)).toBigInt()).to.equal(0n);
    });

    it('liquidates bad debt', async () => {
      const basePaidOut = borrowBefore - (await comet.borrowBalanceOf(borrower.address)).toBigInt();
      const baseRepaid = (await usdc.balanceOf(comet.address)).toBigInt() - cometUsdcBefore;

      const unswappedBaseAmount = (uniSeizedValue * BASE_SCALE) / BASE_PRICE;
      const requiredBase = basePaidOut - unswappedBaseAmount;

      expect(unswappedBaseAmount).to.be.greaterThan(0n);
      expect(requiredBase).to.be.lessThan(basePaidOut);
      expect(baseRepaid).to.be.greaterThanOrEqual(requiredBase);
      expect(baseRepaid + unswappedBaseAmount).to.be.greaterThanOrEqual(basePaidOut);
    });

    it('reduces the borrower debt and restores the position', async () => {
      expect((await comet.borrowBalanceOf(borrower.address)).toBigInt()).to.be.lessThan(borrowBefore);
      expect(await liquidationModule.isLiquidatable(borrower.address)).to.be.false;
    });
  });
});
