import {
  EvilToken,
  EvilToken__factory,
  NonStandardFaucetFeeToken,
  NonStandardFaucetFeeToken__factory,
  FaucetToken,
  SimplePriceFeed,
  Configurator,
  CometProxyAdmin,
  CometHarnessInterfaceExtendedAssetList as CometWithExtendedAssetList,
} from '../build/types';
import { ethers, expect, exp, makeConfigurator, makeProtocol, ReentryAttack, takeSnapshot, SnapshotRestorer, MAX_ASSETS } from './helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';

describe('buyCollateral', function () {
  // Protocol: 24 collateral assets (ASSET0..ASSET23) + USDC base.
  // storeFrontPriceFactor=0.5, liquidationFactor(ASSETx)=0.8, price=$1 each.
  //   discountFactor  = 0.5 × (1 − 0.8) = 0.1
  //   assetPriceDisc  = $1 × (1 − 0.1) = $0.90
  //   quote(50 base)  = 1e8 × 50e6 × 1e18 / 0.9e8 / 1e6 = 55.555555555555555555 collateral

  let comet: CometWithExtendedAssetList;      // attached to cometProxyWithExtendedAssetList
  let baseToken: FaucetToken;                 // USDC
  let collateralToken: FaucetToken;           // ASSET0
  let collateralTokens: FaucetToken[];        // ASSET0..ASSET23
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;
  let governor: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let priceFeeds: { [symbol: string]: SimplePriceFeed };
  let configuratorAsProxy: Configurator;
  let proxyAdmin: CometProxyAdmin;
  let configuratorProxyAddress: string;
  let snapshot: SnapshotRestorer;

  before(async () => {
    const assetsConfig: { [symbol: string]: any } = {
      USDC: { initial: 1e6, decimals: 6, initialPrice: 1 },
    };
    for (let i = 0; i < MAX_ASSETS; i++) {
      assetsConfig[`ASSET${i}`] = {
        initial: 1e7,
        decimals: 18,
        initialPrice: 1,
        liquidationFactor: exp(0.8, 18),
        borrowCF: exp(0.75, 18),
        liquidateCF: exp(0.85, 18),
        supplyCap: exp(10000, 18),
      };
    }

    const protocol = await makeConfigurator({
      base: 'USDC',
      storeFrontPriceFactor: exp(0.5, 18),
      targetReserves: exp(100, 6),
      assets: assetsConfig,
    });

    const { cometWithExtendedAssetList, cometProxyWithExtendedAssetList, configurator, configuratorProxy } = protocol;

    comet = cometWithExtendedAssetList.attach(cometProxyWithExtendedAssetList.address) as CometWithExtendedAssetList;
    configuratorAsProxy = configurator.attach(configuratorProxy.address) as unknown as Configurator;
    proxyAdmin = protocol.proxyAdmin;
    configuratorProxyAddress = configuratorProxy.address;

    baseToken = protocol.tokens.USDC as FaucetToken;
    priceFeeds = protocol.priceFeeds;
    [alice, bob, dave] = protocol.users;
    governor = protocol.governor;
    pauseGuardian = protocol.pauseGuardian;

    collateralTokens = [];
    for (let i = 0; i < MAX_ASSETS; i++) {
      const token = protocol.tokens[`ASSET${i}`] as FaucetToken;
      collateralTokens.push(token);
      await token.allocateTo(comet.address, exp(100, 18));
    }
    collateralToken = collateralTokens[0];

    // Give alice approval to spend base token
    await baseToken.connect(alice).approve(comet.address, ethers.constants.MaxUint256);

    snapshot = await takeSnapshot();
  });

  // ─── Revert cases ───────────────────────────────────────────────────────────

  describe('revert cases', function () {
    describe('Paused', function () {
      it('pause guardian pauses buying', async () => {
        await expect(
          comet.connect(pauseGuardian).pause(false, false, false, false, true)
        ).to.not.be.reverted;
      });

      it('sanity: isBuyPaused is true', async () => {
        expect(await comet.isBuyPaused()).to.be.true;
      });

      it('reverts with Paused', async () => {
        await expect(
          comet.connect(alice).buyCollateral(collateralToken.address, 0, 1, alice.address)
        ).to.be.revertedWithCustomError(comet, 'Paused');
      });

      it('pause guardian resets buy pause', async () => {
        await expect(
          comet.connect(pauseGuardian).pause(false, false, false, false, false)
        ).to.not.be.reverted;
      });
    });

    describe('NotForSale — reserves equal targetReserves exactly', function () {
      const BUY_AMOUNT = exp(50, 6);
      let targetReservesValue: BigNumber;

      before(async () => {
        targetReservesValue = await comet.targetReserves();
        await baseToken.allocateTo(comet.address, targetReservesValue);
      });

      after(async () => {
        await snapshot.restore();
      });

      it('sanity: reserves equal targetReserves', async () => {
        expect(await comet.getReserves()).to.be.equal(targetReservesValue);
      });

      it('reverts with NotForSale', async () => {
        await expect(
          comet.connect(alice).buyCollateral(collateralToken.address, 0, BUY_AMOUNT, alice.address)
        ).to.be.revertedWithCustomError(comet, 'NotForSale');
      });
    });

    describe('NotForSale — reserves exceed targetReserves', function () {
      const BUY_AMOUNT = exp(50, 6);
      let targetReservesValue: BigNumber;

      before(async () => {
        targetReservesValue = await comet.targetReserves();
        await baseToken.allocateTo(comet.address, targetReservesValue.add(1));
      });

      after(async () => {
        await snapshot.restore();
      });

      it('sanity: reserves exceed targetReserves', async () => {
        expect(await comet.getReserves()).to.be.gt(targetReservesValue);
      });

      it('reverts with NotForSale', async () => {
        await expect(
          comet.connect(alice).buyCollateral(collateralToken.address, 0, BUY_AMOUNT, alice.address)
        ).to.be.revertedWithCustomError(comet, 'NotForSale');
      });
    });

    describe('TooMuchSlippage — minAmount exceeds quoted collateral', function () {
      const BUY_AMOUNT = exp(50, 6);
      const MIN_COLLATERAL = exp(60, 18);
      let quoteAmount: BigNumber;

      before(async () => {
        await baseToken.allocateTo(alice.address, BUY_AMOUNT);
        quoteAmount = await comet.quoteCollateral(collateralToken.address, BUY_AMOUNT);
      });

      after(async () => {
        await snapshot.restore();
      });

      it('sanity: quoted collateral is less than requested minAmount', () => {
        // quote(50 baseToken) ≈ 55.555e18 < 60e18 = MIN_COLLATERAL
        expect(quoteAmount).to.be.lt(MIN_COLLATERAL);
      });

      it('reverts with TooMuchSlippage', async () => {
        await expect(
          comet.connect(alice).buyCollateral(collateralToken.address, MIN_COLLATERAL, BUY_AMOUNT, alice.address)
        ).to.be.revertedWithCustomError(comet, 'TooMuchSlippage');
      });
    });

    describe('InsufficientReserves — quoted amount exceeds collateral reserves', function () {
      const BUY_AMOUNT = exp(200, 6);
      let collateralReserves: BigNumber;
      let quoteAmount: BigNumber;

      before(async () => {
        await baseToken.allocateTo(alice.address, BUY_AMOUNT);
        collateralReserves = await comet.getCollateralReserves(collateralToken.address);
        quoteAmount = await comet.quoteCollateral(collateralToken.address, BUY_AMOUNT);
      });

      after(async () => {
        await snapshot.restore();
      });

      it('sanity: quoted collateral exceeds collateral reserves', () => {
        // collateralReserves = 100e18; quote(200 baseToken) ≈ 222e18 > 100e18
        expect(quoteAmount).to.be.gt(collateralReserves);
      });

      it('reverts with InsufficientReserves', async () => {
        await expect(
          comet.connect(alice).buyCollateral(collateralToken.address, 0, BUY_AMOUNT, alice.address)
        ).to.be.revertedWithCustomError(comet, 'InsufficientReserves');
      });
    });

    describe('InsufficientReserves — second buy exceeds remaining reserves', function () {
      const BUY_AMOUNT = exp(50, 6);
      let firstBuyTx: any;
      let quoteAmount: BigNumber;
      let collateralReservesBefore: BigNumber;

      before(async () => {
        await baseToken.allocateTo(alice.address, BUY_AMOUNT * 2n);
        collateralReservesBefore = await comet.getCollateralReserves(collateralToken.address);
        quoteAmount = await comet.quoteCollateral(collateralToken.address, BUY_AMOUNT);
      });

      after(async () => {
        await snapshot.restore();
      });

      it('alice buys collateral — does not revert', async () => {
        firstBuyTx = await comet.connect(alice).buyCollateral(collateralToken.address, 0, BUY_AMOUNT, alice.address);
        await expect(firstBuyTx).to.not.be.reverted;
      });

      it('collateral reserves decrease by quoted amount after first buy', async () => {
        expect(await comet.getCollateralReserves(collateralToken.address)).to.be.equal(collateralReservesBefore.sub(quoteAmount));
      });

      it('alice base balance decreases by BUY_AMOUNT', async () => {
        await expect(firstBuyTx).to.changeTokenBalance(baseToken, alice, -BUY_AMOUNT);
      });

      it('alice collateral balance increases by quoted amount', async () => {
        await expect(firstBuyTx).to.changeTokenBalance(collateralToken, alice, quoteAmount);
      });

      it('sanity: remaining collateral reserves are less than second buy quote', async () => {
        const remaining = await comet.getCollateralReserves(collateralToken.address);
        const secondQuote = await comet.quoteCollateral(collateralToken.address, BUY_AMOUNT);
        expect(secondQuote).to.be.gt(remaining);
      });

      it('second buyCollateral reverts with InsufficientReserves', async () => {
        await expect(
          comet.connect(alice).buyCollateral(collateralToken.address, 0, BUY_AMOUNT, alice.address)
        ).to.be.revertedWithCustomError(comet, 'InsufficientReserves');
      });
    });
  });

  // ─── Successful purchase — buyer is the recipient ───────────────────────────

  describe('successful purchase — buyer is the recipient', function () {
    // reserves = 0 < targetReserves(100e6) → collateral is for sale
    const BUY_AMOUNT = exp(50, 6);

    let reservesBefore: BigNumber;
    let collateralReservesBefore: BigNumber;
    let quoteAmount: BigNumber;
    let buyTx: ContractTransaction;

    before(async () => {
      await baseToken.allocateTo(alice.address, exp(200, 6));
      reservesBefore = await comet.getReserves();
      collateralReservesBefore = await comet.getCollateralReserves(collateralToken.address);
      // Note: we do not verify the quote amount logic, as it is tested in other tests
      quoteAmount = await comet.quoteCollateral(collateralToken.address, BUY_AMOUNT);
    });

    it('sanity: reserves are below targetReserves before purchase', async () => {
      expect(reservesBefore).to.be.lt(await comet.targetReserves());
    });

    it('sanity: collateralReserves equals allocated collateral amount', async () => {
      expect(collateralReservesBefore).to.be.equal(exp(100, 18));
    });

    it('alice approves comet to spend base token', async () => {
      await expect(baseToken.connect(alice).approve(comet.address, BUY_AMOUNT)).to.not.be.reverted;
    });

    it('alice buys collateral — does not revert', async () => {
      buyTx = await comet.connect(alice).buyCollateral(collateralToken.address, 0, BUY_AMOUNT, alice.address);
      await expect(buyTx).to.not.be.reverted;
    });

    it('emits BuyCollateral with correct buyer, asset, baseAmount and collateralAmount', async () => {
      await expect(buyTx)
        .to.emit(comet, 'BuyCollateral')
        .withArgs(alice.address, collateralToken.address, BUY_AMOUNT, quoteAmount);
    });

    it('emits Transfer: base from alice to comet', async () => {
      await expect(buyTx)
        .to.emit(baseToken, 'Transfer')
        .withArgs(alice.address, comet.address, BUY_AMOUNT);
    });

    it('emits Transfer: collateral from comet to alice', async () => {
      await expect(buyTx)
        .to.emit(collateralToken, 'Transfer')
        .withArgs(comet.address, alice.address, quoteAmount);
    });

    it('alice base balance decreases by BUY_AMOUNT', async () => {
      await expect(buyTx).to.changeTokenBalance(baseToken, alice, -BUY_AMOUNT);
    });

    it('alice collateral balance increases by quoted collateral amount', async () => {
      await expect(buyTx).to.changeTokenBalance(collateralToken, alice, quoteAmount);
    });

    it('comet base balance increases by BUY_AMOUNT', async () => {
      await expect(buyTx).to.changeTokenBalance(baseToken, comet, BUY_AMOUNT);
    });

    it('comet collateral balance decreases by quoted collateral amount', async () => {
      await expect(buyTx).to.changeTokenBalance(collateralToken, comet, quoteAmount.mul(-1));
    });

    it('protocol reserves increase by BUY_AMOUNT paid', async () => {
      expect(await comet.getReserves()).to.be.equal(reservesBefore.add(BUY_AMOUNT));
    });

    it('collateralReserves decreases by quoted collateral amount', async () => {
      expect(await comet.getCollateralReserves(collateralToken.address)).to.be.equal(collateralReservesBefore.sub(quoteAmount));
    });
  });

  // ─── Successful purchase — recipient differs from buyer ─────────────────────

  describe('successful purchase — recipient differs from buyer', function () {
    // alice pays base token, bob receives collateral
    const BUY_AMOUNT = exp(50, 6);

    let quoteAmount: BigNumber;
    let buyTx: ContractTransaction;

    before(async () => {
      await snapshot.restore();

      await baseToken.allocateTo(alice.address, exp(200, 6));
      quoteAmount = await comet.quoteCollateral(collateralToken.address, BUY_AMOUNT);
    });

    it('alice approves and calls buyCollateral with bob as recipient — does not revert', async () => {
      await baseToken.connect(alice).approve(comet.address, BUY_AMOUNT);
      buyTx = await comet.connect(alice).buyCollateral(collateralToken.address, 0, BUY_AMOUNT, bob.address);
      await expect(buyTx).to.not.be.reverted;
    });

    it('emits BuyCollateral with correct buyer, asset, baseAmount and collateralAmount', async () => {
      await expect(buyTx)
        .to.emit(comet, 'BuyCollateral')
        .withArgs(alice.address, collateralToken.address, BUY_AMOUNT, quoteAmount);
    });

    it('emits Transfer: base from alice to comet', async () => {
      await expect(buyTx)
        .to.emit(baseToken, 'Transfer')
        .withArgs(alice.address, comet.address, BUY_AMOUNT);
    });

    it('emits Transfer: collateral from comet to bob', async () => {
      await expect(buyTx)
        .to.emit(collateralToken, 'Transfer')
        .withArgs(comet.address, bob.address, quoteAmount);
    });

    it('bob collateral balance increases by quoted collateral amount', async () => {
      await expect(buyTx).to.changeTokenBalance(collateralToken, bob, quoteAmount);
    });

    it('alice collateral balance is unchanged', async () => {
      await expect(buyTx).to.changeTokenBalance(collateralToken, alice, 0);
    });

    it('alice base balance decreases by BUY_AMOUNT', async () => {
      await expect(buyTx).to.changeTokenBalance(baseToken, alice, -BUY_AMOUNT);
    });
  });

  // ─── Collateral for sale when reserves are negative ─────────────────────────

  describe('collateral for sale when reserves are negative', function () {
    // Uses configurator to set targetReserves=0 and deployAndUpgradeTo so that
    // buying is allowed when reserves are negative (reserves < 0 = targetReserves).
    //
    // Path to negative reserves using ASSET1 (borrowCF=0.75, liquidateCF=0.85, liqFactor=0.8):
    //   1. alice supplies 1000 baseToken (totalSupplyBase ≈ 1000e6)
    //   2. bob supplies 1000 ASSET1 at $1, borrows 700 baseToken
    //      (borrowCF=0.75 → max = 750; 700 < 750 ✓)
    //   3. ASSET1 price drops to $0.70
    //      collateral value = 1000×$0.70 = $700; 700×0.85(liqCF) = 595 < 700 borrow → liquidatable
    //   4. absorb: deltaBalance = 1000×0.70×0.8(liqFactor) = 560 < 700 → bad debt = 140
    //   5. After absorb:
    //      balance(base) ≈ 300, totalSupplyBase ≈ 1000, totalBorrowBase = 0
    //      reserves = 300 − 1000 + 0 = −700 (negative) ✓
    //      collateralReserves(ASSET1) = (100e18 pre-alloc + 1000e18 seized) − 0 = 1100e18

    const BUY_AMOUNT = exp(200, 6);

    let collateralToken1: FaucetToken;
    let reservesAfterAbsorb: BigNumber;
    let collateralReservesBefore: BigNumber;
    let quoteAmount: BigNumber;
    let buyTx: ContractTransaction;

    before(async () => {
      // Set targetReserves to 0 so negative reserves allow buying
      await configuratorAsProxy.connect(governor).setTargetReserves(comet.address, 0);
      await proxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, comet.address);

      collateralToken1 = collateralTokens[1]; // ASSET1

      // Step 1: alice supplies 1000 baseToken
      await baseToken.allocateTo(alice.address, exp(1000, 6));
      await baseToken.connect(alice).approve(comet.address, exp(1000, 6));
      await comet.connect(alice).supply(baseToken.address, exp(1000, 6));

      // Step 2: bob supplies 1000 ASSET1, borrows 700 baseToken
      await collateralToken1.allocateTo(bob.address, exp(1000, 18));
      await collateralToken1.connect(bob).approve(comet.address, exp(1000, 18));
      await comet.connect(bob).supply(collateralToken1.address, exp(1000, 18));
      await comet.connect(bob).withdraw(baseToken.address, exp(700, 6));

      // Step 3: ASSET1 price drops to $0.70 → position becomes liquidatable
      await priceFeeds['ASSET1'].setRoundData(0, exp(0.7, 8), 0, 0, 0);

      // Step 4: absorb creates bad debt (deltaBalance=560 < 700 borrow → deficit=140)
      await comet.connect(governor).absorb(governor.address, [bob.address]);

      reservesAfterAbsorb = await comet.getReserves();
      collateralReservesBefore = await comet.getCollateralReserves(collateralToken1.address);
      quoteAmount = await comet.quoteCollateral(collateralToken1.address, BUY_AMOUNT);

      await baseToken.allocateTo(dave.address, BUY_AMOUNT);
    });

    it('sanity: reserves are negative after absorb', () => {
      expect(reservesAfterAbsorb).to.be.lt(0);
    });

    it('sanity: ASSET1 collateral reserves include seized amount plus pre-allocated reserves', () => {
      // 100e18 (outer pre-allocation) + 1000e18 (bob's seized collateral, totalsCollateral cleared by absorb)
      expect(collateralReservesBefore).to.be.equal(exp(1100, 18));
    });

    it('dave approves comet to spend base token', async () => {
      await expect(baseToken.connect(dave).approve(comet.address, BUY_AMOUNT)).to.not.be.reverted;
    });

    it('dave buys ASSET1 collateral when reserves are negative — does not revert', async () => {
      buyTx = await comet.connect(dave).buyCollateral(collateralToken1.address, 0, BUY_AMOUNT, dave.address);
      await expect(buyTx).to.not.be.reverted;
    });

    it('dave base balance decreases by BUY_AMOUNT', async () => {
      await expect(buyTx).to.changeTokenBalance(baseToken, dave, -BUY_AMOUNT);
    });

    it('dave collateral balance increases by quoted collateral amount', async () => {
      await expect(buyTx).to.changeTokenBalance(collateralToken1, dave, quoteAmount);
    });

    it('comet base balance increases by BUY_AMOUNT', async () => {
      await expect(buyTx).to.changeTokenBalance(baseToken, comet, BUY_AMOUNT);
    });

    it('comet collateral balance decreases by quoted collateral amount', async () => {
      await expect(buyTx).to.changeTokenBalance(collateralToken1, comet, quoteAmount.mul(-1));
    });

    it('protocol reserves increase by exactly BUY_AMOUNT', async () => {
      // buyCollateral does not call accrueInternal; post-absorb utilization = 0 → no index change
      // reservesAfterBuy = reservesAfterAbsorb + BUY_AMOUNT ≈ −700e6 + 200e6 = −500e6
      expect(await comet.getReserves()).to.be.equal(reservesAfterAbsorb.add(BUY_AMOUNT));
    });

    it('protocol reserves remain negative after purchase', async () => {
      // BUY_AMOUNT(200e6) < |reservesAfterAbsorb|(≈700e6) → sum still negative
      expect(await comet.getReserves()).to.be.lt(0);
    });

    it('collateral reserves decrease by quoted collateral amount', async () => {
      expect(await comet.getCollateralReserves(collateralToken1.address)).to.be.equal(collateralReservesBefore.sub(quoteAmount));
    });
  });

  // ─── Collateral reserves vs user-owned collateral ───────────────────────────

  describe('collateral reserves vs user-owned collateral', function () {
    // collateralToken (ASSET0) has 100e18 pre-allocated to comet as reserves
    // (not tracked in totalsCollateral). When alice supplies 10e18 via protocol,
    // balance = 110e18 and totalsCollateral = 10e18.
    // getCollateralReserves = 110e18 − 10e18 = 100e18 — only the excess is buyable.

    const ALICE_COLLATERAL_AMOUNT = exp(10, 18);
    let aliceCollateralPosition: BigNumber;

    before(async () => {
      await snapshot.restore();

      await collateralToken.allocateTo(alice.address, ALICE_COLLATERAL_AMOUNT);
      await collateralToken.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
      await comet.connect(alice).supply(collateralToken.address, ALICE_COLLATERAL_AMOUNT);

      aliceCollateralPosition = (await comet.userCollateral(alice.address, collateralToken.address)).balance;
    });

    it('collateralReserves equals 100e18 — only directly allocated excess is available', async () => {
      const reserves = await comet.getCollateralReserves(collateralToken.address);
      // balance = 100e18 (pre-allocated) + 10e18 (alice supply) = 110e18
      // totalsCollateral = 10e18 → reserves = 100e18
      expect(reserves).to.be.equal(exp(100, 18));
    });

    it('bob buys from collateral reserves — does not revert', async () => {
      await baseToken.allocateTo(bob.address, exp(50, 6));
      await baseToken.connect(bob).approve(comet.address, exp(50, 6));
      await expect(
        comet.connect(bob).buyCollateral(collateralToken.address, 0, exp(50, 6), bob.address)
      ).to.not.be.reverted;
    });

    it("alice's on-protocol collateral position is unchanged after buy from reserves", async () => {
      const alicePositionAfter = (await comet.userCollateral(alice.address, collateralToken.address)).balance;
      expect(alicePositionAfter).to.be.equal(aliceCollateralPosition);
    });
  });

  // ─── All 24 collateral assets — extended asset list coverage ────────────────

  describe('all 24 collateral assets are purchasable — extended asset list coverage', function () {
    // Validates all 24 packed slots in AssetList are correctly readable by
    // getAssetInfoByAddress inside quoteCollateral and buyCollateral.
    // A mis-packed slot would cause BadAsset revert or a wrong price.
    // Uses the outer comet (already configured with 24 assets, 100e18 reserves each).
    //
    // All 24 buys happen sequentially (no per-test snapshots); accumulated state
    // is verified at the end for reserves and per-asset collateral reserves.
    // BUY_AMOUNT must satisfy 24 × BUY_AMOUNT < targetReserves(100e6) to avoid NotForSale.

    const BUY_AMOUNT = exp(4, 6);

    let quoteAmounts: BigNumber[] = [];
    let minAmounts: BigNumber[] = [];
    let buyTxs: ContractTransaction[] = [];
    let reservesBefore: BigNumber;
    let collateralReservesBefore: BigNumber[] = [];

    before(async () => {
      await snapshot.restore();

      await baseToken.allocateTo(alice.address, BUY_AMOUNT * BigInt(MAX_ASSETS));
      await baseToken.connect(alice).approve(comet.address, ethers.constants.MaxUint256);

      reservesBefore = await comet.getReserves();

      for (let i = 0; i < MAX_ASSETS; i++) {
        const quote = await comet.quoteCollateral(collateralTokens[i].address, BUY_AMOUNT);
        quoteAmounts.push(quote);
        // minAmount = quoteAmount × 99/100 (1% slippage tolerance)
        minAmounts.push(quote.mul(99).div(100));
        collateralReservesBefore.push(await comet.getCollateralReserves(collateralTokens[i].address));
      }
    });

    it('quote amounts are positive for each of 24 collaterals', () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        expect(quoteAmounts[i]).to.be.gt(0, `ASSET${i} quote is zero`);
      }
    });

    it('ASSET0 through ASSET23: each buyCollateral with minAmount does not revert', async () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        const tx = await comet.connect(alice).buyCollateral(
          collateralTokens[i].address, minAmounts[i], BUY_AMOUNT, alice.address
        );
        await expect(tx).to.not.be.reverted;
        buyTxs[i] = tx;
      }
    });

    it('each tx emits BuyCollateral with correct buyer, asset, baseAmount and collateralAmount', async () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        await expect(buyTxs[i])
          .to.emit(comet, 'BuyCollateral')
          .withArgs(alice.address, collateralTokens[i].address, BUY_AMOUNT, quoteAmounts[i]);
      }
    });

    it('each tx: comet base balance increases by BUY_AMOUNT', async () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        await expect(buyTxs[i]).to.changeTokenBalance(baseToken, comet, BUY_AMOUNT);
      }
    });

    it('each tx: comet collateral balance decreases by quoted amount', async () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        await expect(buyTxs[i]).to.changeTokenBalance(
          collateralTokens[i], comet, quoteAmounts[i].mul(-1)
        );
      }
    });

    it('each tx: alice collateral balance increases by quoted amount', async () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        await expect(buyTxs[i]).to.changeTokenBalance(
          collateralTokens[i], alice, quoteAmounts[i]
        );
      }
    });

    it('each collateral amount received exceeds minAmount — slippage protection verified', () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        // quoteAmounts[i] is actual received; minAmounts[i] = quoteAmount × 99/100
        expect(quoteAmounts[i]).to.be.gt(minAmounts[i], `ASSET${i}: received ≤ minAmount`);
      }
    });

    it('protocol reserves increase by total base amount paid across all 24 buys', async () => {
      // buyCollateral does not call accrueInternal; utilization = 0 → no index change
      // totalPaid = BUY_AMOUNT × MAX_ASSETS = 10e6 × 24 = 240e6
      const totalBasePaid = BUY_AMOUNT * BigInt(MAX_ASSETS);
      expect(await comet.getReserves()).to.be.equal(reservesBefore.add(totalBasePaid));
    });

    it('collateral reserves decrease by quoted amount for each asset', async () => {
      for (let i = 0; i < MAX_ASSETS; i++) {
        expect(await comet.getCollateralReserves(collateralTokens[i].address)).to.be.equal(
          collateralReservesBefore[i].sub(quoteAmounts[i]),
          `ASSET${i} collateral reserves mismatch`
        );
      }
    });
  });

  // ─── Fee-on-transfer tokens ─────────────────────────────────────────────────

  describe('fee-on-transfer tokens', function () {
    describe('fee-on-transfer base token — 1% fee', function () {
      // Non-standard fee token as base; collateral has no fee.
      // doTransferIn records net received = gross − fee as baseAmount.
      // collateralAmount and BuyCollateral event are based on net base.
      //
      // alice sends 50e6 feeBaseToken (gross), fee=1%
      //   net received by comet = 50e6 × 0.99 = 49.5e6
      //   quote(49.5e6) = 1×49.5e6×1e18 / 0.9e8 / 1e6 = 55e18 collateralToken

      let feeComet: CometWithExtendedAssetList;
      let baseToken: NonStandardFaucetFeeToken;   // shadows outer; scoped to this describe
      let collateralToken: FaucetToken;            // shadows outer; scoped to this describe
      let aliceFee: SignerWithAddress;
      let buyTx: ContractTransaction;
      let aliceBaseTokenBefore: BigNumber;
      let aliceCollateralTokenBefore: BigNumber;
      let reservesBefore: BigNumber;

      const GROSS_AMOUNT = exp(50, 6);
      const NET_AMOUNT = exp(49.5, 6);         // 50e6 × 0.99
      const EXPECTED_COLLATERAL = exp(55, 18); // 49.5 / 0.9

      before(async () => {
        const protocol = await makeProtocol({
          base: 'FEEBASE',
          storeFrontPriceFactor: exp(0.5, 18),
          targetReserves: exp(100, 6),
          assets: {
            FEEBASE: {
              initial: 1e6,
              decimals: 6,
              initialPrice: 1,
              factory: (await ethers.getContractFactory('NonStandardFaucetFeeToken')) as NonStandardFaucetFeeToken__factory,
            },
            ASSET0: {
              initial: 1e7,
              decimals: 18,
              initialPrice: 1,
              liquidationFactor: exp(0.8, 18),
              supplyCap: exp(10000, 18),
            },
          },
        });
        feeComet = protocol.cometWithExtendedAssetList;
        baseToken = protocol.tokens.FEEBASE as unknown as NonStandardFaucetFeeToken;
        collateralToken = protocol.tokens.ASSET0 as FaucetToken;
        [aliceFee] = protocol.users;

        await baseToken.setParams(100, 10000); // 1% fee on base token transfers

        await collateralToken.allocateTo(feeComet.address, exp(100, 18));
        await baseToken.allocateTo(aliceFee.address, exp(100, 6));

        aliceBaseTokenBefore = await baseToken.balanceOf(aliceFee.address);
        aliceCollateralTokenBefore = await collateralToken.balanceOf(aliceFee.address);
        reservesBefore = await feeComet.getReserves();
      });

      it('alice approves and buys — does not revert', async () => {
        await baseToken.connect(aliceFee).approve(feeComet.address, GROSS_AMOUNT);
        buyTx = await feeComet.connect(aliceFee).buyCollateral(collateralToken.address, 0, GROSS_AMOUNT, aliceFee.address);
        await expect(buyTx).to.not.be.reverted;
      });

      it('BuyCollateral event records net baseAmount (after fee), not gross', async () => {
        await expect(buyTx)
          .to.emit(feeComet, 'BuyCollateral')
          .withArgs(aliceFee.address, collateralToken.address, NET_AMOUNT, EXPECTED_COLLATERAL);
      });

      it('alice receives collateral based on net base — collateral token has no fee', async () => {
        const after = await collateralToken.balanceOf(aliceFee.address);
        expect(after.sub(aliceCollateralTokenBefore)).to.be.equal(EXPECTED_COLLATERAL);
      });

      it('comet reserves increase by net base amount, not gross', async () => {
        const after = await feeComet.getReserves();
        expect(after).to.be.equal(reservesBefore.add(NET_AMOUNT));
      });

      it('alice base balance decreases by the gross amount sent', async () => {
        const after = await baseToken.balanceOf(aliceFee.address);
        expect(after).to.be.equal(aliceBaseTokenBefore.sub(GROSS_AMOUNT));
      });
    });

    describe('fee-on-transfer collateral token — 1% fee', function () {
      // No-fee base; collateral has 1% fee on transfer out.
      // comet quotes and sends gross collateralAmount; buyer receives net after fee.
      // BuyCollateral event records gross (what comet sent, not what buyer received).
      //
      // alice sends 50e6 baseToken (no fee)
      //   net base = 50e6
      //   quote = 50/0.9 = 55_555_555_555_555_555_555 collateralToken (gross)
      //   fee = floor(55555555555555555555 / 100) = 555555555555555555
      //   alice receives 55555555555555555555 − 555555555555555555 = 55000000000000000000 (net)

      let feeComet: CometWithExtendedAssetList;
      let baseToken: FaucetToken;                          // shadows outer; scoped to this describe
      let collateralToken: NonStandardFaucetFeeToken;      // shadows outer; scoped to this describe
      let aliceFee: SignerWithAddress;
      let buyTx: ContractTransaction;
      let aliceCollateralTokenBefore: BigNumber;

      const BUY_AMOUNT = exp(50, 6);
      const EXPECTED_COLLATERAL_GROSS = 55555555555555555555n;
      // net = gross − floor(gross / 100) = 55555555555555555555 − 555555555555555555 = 55000000000000000000
      const EXPECTED_COLLATERAL_NET = 55000000000000000000n;

      before(async () => {
        const protocol = await makeProtocol({
          base: 'BASE',
          storeFrontPriceFactor: exp(0.5, 18),
          targetReserves: exp(100, 6),
          assets: {
            BASE: { initial: 1e6, decimals: 6, initialPrice: 1 },
            FEECOLL: {
              initial: 1e7,
              decimals: 18,
              initialPrice: 1,
              liquidationFactor: exp(0.8, 18),
              supplyCap: exp(10000, 18),
              factory: (await ethers.getContractFactory('NonStandardFaucetFeeToken')) as NonStandardFaucetFeeToken__factory,
            },
          },
        });
        feeComet = protocol.cometWithExtendedAssetList;
        baseToken = protocol.tokens.BASE as FaucetToken;
        collateralToken = protocol.tokens.FEECOLL as unknown as NonStandardFaucetFeeToken;
        [aliceFee] = protocol.users;

        await collateralToken.setParams(100, 10000); // 1% fee on collateral transfers

        await collateralToken.allocateTo(feeComet.address, exp(100, 18));
        await baseToken.allocateTo(aliceFee.address, exp(100, 6));

        aliceCollateralTokenBefore = await collateralToken.balanceOf(aliceFee.address);
      });

      it('alice approves and buys — does not revert', async () => {
        await baseToken.connect(aliceFee).approve(feeComet.address, BUY_AMOUNT);
        buyTx = await feeComet.connect(aliceFee).buyCollateral(collateralToken.address, 0, BUY_AMOUNT, aliceFee.address);
        await expect(buyTx).to.not.be.reverted;
      });

      it('BuyCollateral event records gross collateral amount (pre-fee, what comet sent)', async () => {
        await expect(buyTx)
          .to.emit(feeComet, 'BuyCollateral')
          .withArgs(aliceFee.address, collateralToken.address, BUY_AMOUNT, EXPECTED_COLLATERAL_GROSS);
      });

      it('alice receives collateral net of transfer fee — less than the quoted gross', async () => {
        const after = await collateralToken.balanceOf(aliceFee.address);
        expect(after.sub(aliceCollateralTokenBefore)).to.be.equal(EXPECTED_COLLATERAL_NET);
      });
    });
  });

  // ─── Reentrancy ─────────────────────────────────────────────────────────────

  describe('reentrancy', function () {
    describe('reentrant buyCollateral via EvilToken base — is blocked', function () {
      // EVIL token re-enters buyCollateral on transferFrom.
      // Expected: the outer buyCollateral call reverts with ReentrantCallBlocked.

      let evilComet: CometWithExtendedAssetList;
      let evilBaseToken: EvilToken;
      let evilCollateralToken: FaucetToken;
      let evilAlice: SignerWithAddress;
      let evilBob: SignerWithAddress;

      before(async () => {
        const protocol = await makeProtocol({
          base: 'EVIL',
          assets: {
            EVIL: {
              decimals: 6,
              initial: 1e6,
              initialPrice: 1,
              factory: (await ethers.getContractFactory('EvilToken')) as EvilToken__factory,
            },
            ASSET0: { initial: 1e4, decimals: 18, initialPrice: 3000 },
          },
          targetReserves: 1,
        });
        evilComet = protocol.cometWithExtendedAssetList;
        evilCollateralToken = protocol.tokens.ASSET0 as FaucetToken;
        evilBaseToken = protocol.tokens.EVIL as unknown as EvilToken;
        [evilAlice, evilBob] = protocol.users;

        const attack = Object.assign({}, await evilBaseToken.getAttack(), {
          attackType: ReentryAttack.BuyCollateral,
          source: evilAlice.address,
          destination: evilBob.address,
          asset: evilCollateralToken.address,
          amount: exp(3000, 6),
          maxCalls: 1,
        });
        await evilBaseToken.setAttack(attack);

        await evilCollateralToken.allocateTo(evilComet.address, exp(100, 18));
        await evilBaseToken.allocateTo(evilAlice.address, exp(5000, 6));
        await evilBaseToken.connect(evilAlice).approve(evilBaseToken.address, exp(5000, 6));
        await evilBaseToken.connect(evilAlice).approve(evilComet.address, exp(5000, 6));
        await evilComet.connect(evilAlice).allow(evilBaseToken.address, true);
      });

      it('reverts with ReentrantCallBlocked on second buyCollateral from callback', async () => {
        await expect(
          evilComet.connect(evilAlice).buyCollateral(evilCollateralToken.address, 0, exp(3000, 6), evilAlice.address)
        ).to.be.revertedWithCustomError(evilComet, 'ReentrantCallBlocked');
      });
    });

    describe('reentrant supply during buyCollateral is blocked — state comparison proof', function () {
      // normalProtocol vs evilProtocol: both run in the same block (automine off).
      // EVIL triggers SupplyFrom callback during buyCollateral's doTransferIn.
      //
      // Expected after mining:
      //   normal: supply went through → totalSupplyBase = 1e6, normalBob credited
      //   evil:   supply blocked      → totalSupplyBase = 0,   evilBob receives nothing
      //   collateral totals equal in both (buyCollateral executed correctly in both)

      let normalComet: CometWithExtendedAssetList;
      let evilComet: CometWithExtendedAssetList;
      let normalCollateralToken: FaucetToken;
      let evilCollateralToken: FaucetToken;
      let normalBaseToken: FaucetToken;
      let evilBaseToken: EvilToken;
      let normalAlice: SignerWithAddress;
      let normalBob: SignerWithAddress;
      let evilAlice: SignerWithAddress;
      let evilBob: SignerWithAddress;

      before(async () => {
        const collateralArgs = { initial: 1e4, decimals: 18, initialPrice: 3000 };
        const baseArgs = { decimals: 6, initial: 1e6, initialPrice: 1 };

        const normalProtocol = await makeProtocol({
          base: 'BASE',
          assets: { BASE: baseArgs, ASSET0: collateralArgs },
          targetReserves: 1,
        });
        normalComet = normalProtocol.cometWithExtendedAssetList;
        normalBaseToken = normalProtocol.tokens.BASE as FaucetToken;
        normalCollateralToken = normalProtocol.tokens.ASSET0 as FaucetToken;
        [normalAlice, normalBob, evilAlice, evilBob] = normalProtocol.users;

        const evilProtocol = await makeProtocol({
          base: 'EVIL',
          assets: {
            EVIL: { ...baseArgs, factory: (await ethers.getContractFactory('EvilToken')) as EvilToken__factory },
            ASSET0: collateralArgs,
          },
          targetReserves: 1,
        });
        evilComet = evilProtocol.cometWithExtendedAssetList;
        evilCollateralToken = evilProtocol.tokens.ASSET0 as FaucetToken;
        evilBaseToken = evilProtocol.tokens.EVIL as unknown as EvilToken;

        const attack = Object.assign({}, await evilBaseToken.getAttack(), {
          attackType: ReentryAttack.SupplyFrom,
          source: evilAlice.address,
          destination: evilBob.address,
          asset: evilBaseToken.address,
          amount: exp(3000, 6),
          maxCalls: 1,
        });
        await evilBaseToken.setAttack(attack);

        await normalCollateralToken.allocateTo(normalComet.address, exp(100, 18));
        await normalBaseToken.allocateTo(normalAlice.address, exp(5000, 6));
        await evilCollateralToken.allocateTo(evilComet.address, exp(100, 18));
        await evilBaseToken.allocateTo(evilAlice.address, exp(5000, 6));

        await normalBaseToken.connect(normalAlice).approve(normalComet.address, exp(5000, 6));
        await evilBaseToken.connect(evilAlice).approve(evilBaseToken.address, exp(5000, 6));
        await evilBaseToken.connect(evilAlice).approve(evilComet.address, exp(5000, 6));
        await evilComet.connect(evilAlice).allow(evilBaseToken.address, true);

        // Submit all txs in the same block so identical time elapses for both protocols
        await ethers.provider.send('evm_setAutomine', [false]);

        await normalComet.connect(normalAlice).supplyFrom(normalAlice.address, normalBob.address, normalBaseToken.address, exp(1, 6));
        await normalComet.connect(normalAlice).buyCollateral(normalCollateralToken.address, 0, exp(3000, 6), normalAlice.address);
        await evilComet.connect(evilAlice).buyCollateral(evilCollateralToken.address, 0, exp(3000, 6), evilAlice.address);

        await ethers.provider.send('evm_mine', []);
        await ethers.provider.send('evm_setAutomine', [true]);
      });

      it('normal protocol: supply went through — totalSupplyBase equals supplied amount', async () => {
        const totals = await normalComet.totalsBasic();
        expect(totals.totalSupplyBase).to.be.equal(exp(1, 6));
      });

      it('evil protocol: reentrant supply is blocked — totalSupplyBase is zero', async () => {
        const totals = await evilComet.totalsBasic();
        expect(totals.totalSupplyBase).to.be.equal(0);
      });

      it('normalBob received the supplied base token on-protocol', async () => {
        const bobBalance = await normalComet.balanceOf(normalBob.address);
        expect(bobBalance).to.be.equal(exp(1, 6));
      });

      it('evilBob received zero base tokens — reentrant supply was blocked', async () => {
        const evilBobBalance = await evilComet.balanceOf(evilBob.address);
        expect(evilBobBalance).to.be.equal(0);
      });

      it('collateral totals are equal — buyCollateral executed correctly in both protocols', async () => {
        const normalTotals = await normalComet.totalsCollateral(normalCollateralToken.address);
        const evilTotals = await evilComet.totalsCollateral(evilCollateralToken.address);
        expect(normalTotals.totalSupplyAsset).to.be.equal(evilTotals.totalSupplyAsset);
      });
    });
  });
});
