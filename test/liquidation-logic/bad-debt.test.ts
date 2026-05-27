import { ethers, expect, exp, makeProtocol, presentValue, mulPrice, mulFactor, default24Assets,
  CollateralState, makeCollateralStates } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

describe('partial liquidation: bad debt', function() {
  // Protocol
  let comet: CometHarnessInterfaceExtendedAssetList;

  // Constants
  const baseTokenPrice = exp(1, 8);
  const initialBaseFunding = baseTokenPrice * 10_000n;
  const baseBorrowMin = exp(10, 6); // $10

  // Assets
  let tokens: { [symbol: string]: FaucetToken } = {};
  let baseToken: FaucetToken;
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  // Signers
  let alice: SignerWithAddress;
  let absorber: SignerWithAddress;

  // Math
  const baseScale: bigint = 10n ** 6n;
  const factorScale: bigint = 10n ** 18n;
  let targetHealthFactor: bigint;

  let snapshot: SnapshotRestorer;

  before(async function() {
    const protocol = await makeProtocol({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        ...default24Assets(),
      },
      baseTrackingBorrowSpeed: 0,
      baseBorrowMin: baseBorrowMin,
    });
    comet = protocol.cometWithExtendedAssetList;
    for (let asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      tokens[asset] = protocol.tokens[asset] as FaucetToken;
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    baseToken = protocol.tokens['USDC'] as FaucetToken;
    priceFeeds['USDC'] = protocol.priceFeeds['USDC'];

    [alice, absorber] = protocol.users;

    const allocateAmount = exp(1_000_000, 18);
    for (const token of Object.values(protocol.tokens)) {
      await (token as FaucetToken).allocateTo(alice.address, allocateAmount);
      await (token as FaucetToken).connect(alice).approve(comet.address, ethers.constants.MaxUint256);
    }

    // Make reserves on comet for borrowings
    await baseToken.allocateTo(comet.address, initialBaseFunding);

    targetHealthFactor = (await comet.targetHealthFactor()).toBigInt();
    snapshot = await takeSnapshot();
  });

  context('1 collateral: full seizure, user has not enough collateral to cover debt (asset index 0)', function () {
    const collateralAmount = exp(1, 18); // 1 COMP, initially worth $100
    const borrowAmount = exp(80, 6); // $80

    const collateralKey = 'COMP';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let cometBaseTokenBalanceBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop COMP by 50%. Alice's 1 COMP is now worth only $50,
      // so the collateral cannot repay the $80 debt even after full seizure.
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const newCompPrice = compPrice * 50n / 100n;
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, newCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: collateral value after liquidation factor is below the debt (bad debt)', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      // collateralValueAfterLF = collateralValue * LF = $50 * 0.90 = $45 < $80 debt
      const collateralValueAfterLF = mulFactor(
        mulPrice(collateralAmount, compPrice, assetInfo.scale.toBigInt()),
        assetInfo.liquidationFactor.toBigInt()
      );
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(collateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for the full collateral seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      // wantedCollateralValue = full collateral value at current price
      const wantedCollateralValue = mulPrice(collateralAmount, compPrice, assetInfo.scale.toBigInt());

      await expect(absorbTx)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey].address, collateralAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      // basePaidOut = newBalance(0) - oldBalance = -oldBalance (bad debt written off to zero)
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx)
        .to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
    });

    it('alice assetsIn bit is cleared after absorb', async () => {
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied collateral decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralAmount));
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(
        collateralsState[collateralKey].collateralReservesBefore.add(collateralAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      // getReserves = balance - totalSupply + totalBorrow; after absorb totalBorrow=0, totalSupply=0
      // balance = initialBaseFunding - borrowAmount; oldBalance ≈ -borrowAmount
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('1 collateral: full seizure, user has not enough collateral to cover debt (asset index 16)', function () {
    const collateralAmount = exp(100, 18); // 100 LDO, initially worth $200
    const borrowAmount = exp(80, 6); // $80

    const collateralKey = 'LDO';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let cometBaseTokenBalanceBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount); // index 16 in default24Assets
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop LDO from $2 to $0.50. The collateral is now worth $50,
      // so it cannot cover the $80 debt even after full seizure.
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(0.5, 8), 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: collateral value after liquidation factor is below the debt (bad debt)', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      // collateralValueAfterLF = $50 * LF < $80 debt
      const collateralValueAfterLF = mulFactor(
        mulPrice(collateralAmount, ldoPrice, assetInfo.scale.toBigInt()),
        assetInfo.liquidationFactor.toBigInt()
      );
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(collateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for the full collateral seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(collateralAmount, ldoPrice, assetInfo.scale.toBigInt());

      await expect(absorbTx)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey].address, collateralAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx)
        .to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
    });

    it('alice assetsIn remains zero', async () => {
      // LDO is at index 16, which sets a _reserved bit, not assetsIn
      expect(assetsInBefore).to.be.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bit is cleared after absorb', async () => {
      expect(reservedBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied collateral decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralAmount));
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(
        collateralsState[collateralKey].collateralReservesBefore.add(collateralAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('1 collateral: full seizure, user has not enough collateral to cover debt (last asset index)', function () {
    const collateralAmount = exp(100, 18); // 100 last-index tokens, initially worth $100
    const borrowAmount = exp(70, 6); // $70

    const collateralKey = 'sUSDe';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let cometBaseTokenBalanceBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount); // last index in default24Assets
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop the last asset from $1 to $0.50. The collateral is now worth $50,
      // so it cannot cover the $70 debt even after full seizure.
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(0.5, 8), 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: collateral value after liquidation factor is below the debt (bad debt)', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const susdePrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      // collateralValueAfterLF = $50 * LF < $70 debt
      const collateralValueAfterLF = mulFactor(
        mulPrice(collateralAmount, susdePrice, assetInfo.scale.toBigInt()),
        assetInfo.liquidationFactor.toBigInt()
      );
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(collateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for the full collateral seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const susdePrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(collateralAmount, susdePrice, assetInfo.scale.toBigInt());

      await expect(absorbTx)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey].address, collateralAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx)
        .to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
    });

    it('alice assetsIn remains zero', async () => {
      // sUSDe is at the last index (>= 16), which sets a _reserved bit, not assetsIn
      expect(assetsInBefore).to.be.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bit is cleared after absorb', async () => {
      expect(reservedBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied collateral decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralAmount));
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(
        collateralsState[collateralKey].collateralReservesBefore.add(collateralAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('multi-collateral: full seizure of first asset then full seizure of second (assets index 0 and 1)', function () {
    const compAmount = exp(0.5, 18); // 0.5 COMP, worth $50 before the price drop
    const wethAmount = exp(0.0275, 18); // 0.0275 WETH at $2,000 = $55
    const borrowAmount = exp(80, 6); // $80

    const collateralKey1 = 'COMP';
    const collateralKey2 = 'WETH';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey1].address, compAmount);
      await comet.connect(alice).supply(tokens[collateralKey2].address, wethAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 20%.
      // COMP: $50 supplied value -> $40. WETH: $55 supplied value -> $44.
      // Together they cannot cover the $80 debt after liquidation factors,
      // so the contract should fully seize both assets and write off bad debt.
      await priceFeeds[collateralKey1].connect(alice).setRoundData(0, exp(80, 8), 0, 0, 0);
      await priceFeeds[collateralKey2].connect(alice).setRoundData(0, exp(1600, 8), 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey1, collateralKey2]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const compPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wethPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      // totalCollateralValueAfterLF = $40 * 0.90 + $44 * 0.90 = $36 + $39.60 = $75.60 < $80 debt
      const totalCollateralValueAfterLF =
        mulFactor(mulPrice(compAmount, compPrice, compInfo.scale.toBigInt()), compInfo.liquidationFactor.toBigInt()) +
        mulFactor(mulPrice(wethAmount, wethPrice, wethInfo.scale.toBigInt()), wethInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full COMP seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const compPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(compAmount, compPrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey1].address, compAmount, wantedCollateralValue);
    });

    it('emits AbsorbCollateral for full WETH seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const wethPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(wethAmount, wethPrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey2].address, wethAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey1].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey2].address)).to.be.equal(0);
    });

    it('alice assetsIn bits are cleared after absorb', async () => {
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey1].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey1].totalsCollateralBefore.sub(compAmount));
    });

    it('comet total supplied WETH decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey2].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey2].totalsCollateralBefore.sub(wethAmount));
    });

    it('comet ERC20 COMP token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey1].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey1].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey2].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey2].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet COMP collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey1].address)).to.be.equal(
        collateralsState[collateralKey1].collateralReservesBefore.add(compAmount)
      );
    });

    it('comet WETH collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey2].address)).to.be.equal(
        collateralsState[collateralKey2].collateralReservesBefore.add(wethAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('multi-collateral: full seizure of first asset then full seizure of second (assets index 15 and 16)', function () {
    const aaveAmount = exp(0.4, 18); // 0.4 AAVE, worth $40 before the price drop
    const ldoAmount = exp(20, 18); // 20 LDO, worth $40 before the price drop
    const borrowAmount = exp(45, 6); // $45

    const collateralKey1 = 'AAVE';
    const collateralKey2 = 'LDO';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey1].address, aaveAmount);
      await comet.connect(alice).supply(tokens[collateralKey2].address, ldoAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 50%. Together they still cannot cover the $45 debt
      // after liquidation factors, so the contract fully seizes both assets.
      await priceFeeds[collateralKey1].connect(alice).setRoundData(0, exp(50, 8), 0, 0, 0);
      await priceFeeds[collateralKey2].connect(alice).setRoundData(0, exp(1, 8), 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey1, collateralKey2]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const aavePrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const ldoPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      // totalCollateralValueAfterLF = $20 * AAVE_LF + $20 * LDO_LF < $45 debt
      const totalCollateralValueAfterLF =
        mulFactor(mulPrice(aaveAmount, aavePrice, aaveInfo.scale.toBigInt()), aaveInfo.liquidationFactor.toBigInt()) +
        mulFactor(mulPrice(ldoAmount, ldoPrice, ldoInfo.scale.toBigInt()), ldoInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full AAVE seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const aavePrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(aaveAmount, aavePrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey1].address, aaveAmount, wantedCollateralValue);
    });

    it('emits AbsorbCollateral for full LDO seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const ldoPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(ldoAmount, ldoPrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey2].address, ldoAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice AAVE collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey1].address)).to.be.equal(0);
    });

    it('alice LDO collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey2].address)).to.be.equal(0);
    });

    it('alice assetsIn bit is cleared after absorb', async () => {
      // AAVE is at index 15, which sets an assetsIn bit
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bit is cleared after absorb', async () => {
      // LDO is at index 16, which sets a _reserved bit
      expect(reservedBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied AAVE decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey1].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey1].totalsCollateralBefore.sub(aaveAmount));
    });

    it('comet total supplied LDO decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey2].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey2].totalsCollateralBefore.sub(ldoAmount));
    });

    it('comet ERC20 AAVE token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey1].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey1].tokenBalanceBefore);
    });

    it('comet ERC20 LDO token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey2].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey2].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet AAVE collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey1].address)).to.be.equal(
        collateralsState[collateralKey1].collateralReservesBefore.add(aaveAmount)
      );
    });

    it('comet LDO collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey2].address)).to.be.equal(
        collateralsState[collateralKey2].collateralReservesBefore.add(ldoAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('multi-collateral: full seizure of first asset then full seizure of second (last two asset indexes: 22 and 23)', function () {
    const usdeAmount = exp(50, 18); // 50 USDe, worth $50 before the price drop
    const susdeAmount = exp(50, 18); // 50 sUSDe, worth $50 before the price drop
    const borrowAmount = exp(70, 6); // $70

    const collateralKey1 = 'USDe';
    const collateralKey2 = 'sUSDe';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey1].address, usdeAmount);
      await comet.connect(alice).supply(tokens[collateralKey2].address, susdeAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 30%. Together they still cannot cover the $70 debt
      // after liquidation factors, so the contract fully seizes both assets.
      await priceFeeds[collateralKey1].connect(alice).setRoundData(0, exp(0.7, 8), 0, 0, 0);
      await priceFeeds[collateralKey2].connect(alice).setRoundData(0, exp(0.7, 8), 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey1, collateralKey2]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
      const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const susdeInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const usdePrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const susdePrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      // totalCollateralValueAfterLF = $35 * USDe_LF + $35 * sUSDe_LF < $70 debt
      const totalCollateralValueAfterLF =
        mulFactor(mulPrice(usdeAmount, usdePrice, usdeInfo.scale.toBigInt()), usdeInfo.liquidationFactor.toBigInt()) +
        mulFactor(mulPrice(susdeAmount, susdePrice, susdeInfo.scale.toBigInt()), susdeInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full USDe seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const usdePrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(usdeAmount, usdePrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey1].address, usdeAmount, wantedCollateralValue);
    });

    it('emits AbsorbCollateral for full sUSDe seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const susdePrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(susdeAmount, susdePrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey2].address, susdeAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice USDe collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey1].address)).to.be.equal(0);
    });

    it('alice sUSDe collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey2].address)).to.be.equal(0);
    });

    it('alice assetsIn remains zero', async () => {
      // USDe and sUSDe are at the last two indexes (>= 16), which set _reserved bits, not assetsIn
      expect(assetsInBefore).to.be.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are cleared after absorb', async () => {
      expect(reservedBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied USDe decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey1].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey1].totalsCollateralBefore.sub(usdeAmount));
    });

    it('comet total supplied sUSDe decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey2].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey2].totalsCollateralBefore.sub(susdeAmount));
    });

    it('comet ERC20 USDe token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey1].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey1].tokenBalanceBefore);
    });

    it('comet ERC20 sUSDe token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey2].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey2].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet USDe collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey1].address)).to.be.equal(
        collateralsState[collateralKey1].collateralReservesBefore.add(usdeAmount)
      );
    });

    it('comet sUSDe collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey2].address)).to.be.equal(
        collateralsState[collateralKey2].collateralReservesBefore.add(susdeAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('multi-collateral: full seizure of first asset then full seizure of second (assets index 14 and 18)', function () {
    const uniAmount = exp(5, 18); // 5 UNI, worth $40 before the price drop
    const mkrAmount = exp(0.016, 18); // 0.016 MKR, worth $40 before the price drop
    const borrowAmount = exp(45, 6); // $45

    const collateralKey1 = 'UNI';
    const collateralKey2 = 'MKR';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey1].address, uniAmount);
      await comet.connect(alice).supply(tokens[collateralKey2].address, mkrAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 50%. Together they still cannot cover the $45 debt
      // after liquidation factors, so the contract fully seizes both assets.
      await priceFeeds[collateralKey1].connect(alice).setRoundData(0, exp(4, 8), 0, 0, 0);
      await priceFeeds[collateralKey2].connect(alice).setRoundData(0, exp(1250, 8), 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey1, collateralKey2]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
      const uniInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const mkrInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const uniPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const mkrPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      // totalCollateralValueAfterLF = $20 * UNI_LF + $20 * MKR_LF < $45 debt
      const totalCollateralValueAfterLF =
        mulFactor(mulPrice(uniAmount, uniPrice, uniInfo.scale.toBigInt()), uniInfo.liquidationFactor.toBigInt()) +
        mulFactor(mulPrice(mkrAmount, mkrPrice, mkrInfo.scale.toBigInt()), mkrInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full UNI seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const uniPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(uniAmount, uniPrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey1].address, uniAmount, wantedCollateralValue);
    });

    it('emits AbsorbCollateral for full MKR seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const mkrPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(mkrAmount, mkrPrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey2].address, mkrAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice UNI collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey1].address)).to.be.equal(0);
    });

    it('alice MKR collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey2].address)).to.be.equal(0);
    });

    it('alice assetsIn bit is cleared after absorb', async () => {
      // UNI is at index 14, which sets an assetsIn bit
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bit is cleared after absorb', async () => {
      // MKR is at index 18, which sets a _reserved bit
      expect(reservedBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied UNI decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey1].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey1].totalsCollateralBefore.sub(uniAmount));
    });

    it('comet total supplied MKR decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey2].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey2].totalsCollateralBefore.sub(mkrAmount));
    });

    it('comet ERC20 UNI token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey1].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey1].tokenBalanceBefore);
    });

    it('comet ERC20 MKR token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey2].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey2].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet UNI collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey1].address)).to.be.equal(
        collateralsState[collateralKey1].collateralReservesBefore.add(uniAmount)
      );
    });

    it('comet MKR collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey2].address)).to.be.equal(
        collateralsState[collateralKey2].collateralReservesBefore.add(mkrAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('multi-collateral: 5 different collaterals with non following asset indexes', function () {
    const collateralConfigs = [
      { symbol: 'WBTC', index: 3, amount: exp(0.0004, 8), droppedPrice: exp(32500, 8) },
      { symbol: 'cbETH', index: 7, amount: exp(0.01, 18), droppedPrice: exp(1650, 8) },
      { symbol: 'AAVE', index: 15, amount: exp(0.3, 18), droppedPrice: exp(50, 8) },
      { symbol: 'ARB', index: 19, amount: exp(30, 18), droppedPrice: exp(0.5, 8) },
      { symbol: 'tBTC', index: 12, amount: exp(0.0004, 18), droppedPrice: exp(32500, 8) },
    ];
    const borrowAmount = exp(65, 6); // $65

    const collateralKeys = collateralConfigs.map(c => c.symbol);
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop every collateral by 50%. The five assets still cannot cover the $65 debt
      // after liquidation factors, so the contract fully seizes each one and writes off bad debt.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
      let totalCollateralValueAfterLF = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        totalCollateralValueAfterLF +=
          mulFactor(mulPrice(config.amount, price, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
      }
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    for (const config of collateralConfigs) {
      it(`emits AbsorbCollateral for full ${config.symbol} seizure`, async () => {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const wantedCollateralValue = mulPrice(config.amount, price, assetInfo.scale.toBigInt());
        await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
          .withArgs(absorber.address, alice.address, tokens[config.symbol].address, config.amount, wantedCollateralValue);
      });
    }

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    for (const config of collateralConfigs) {
      it(`alice ${config.symbol} collateral balance is zero after absorb`, async () => {
        expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.be.equal(0);
      });
    }

    it('alice assetsIn bits are cleared after absorb', async () => {
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are cleared after absorb', async () => {
      expect(reservedBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    for (const config of collateralConfigs) {
      it(`comet total supplied ${config.symbol} decreases by the seized amount`, async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;
        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(config.amount));
      });
    }

    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    for (const config of collateralConfigs) {
      it(`comet ${config.symbol} collateral reserves increase by the seized collateral amount`, async () => {
        expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(
          collateralsState[config.symbol].collateralReservesBefore.add(config.amount)
        );
      });
    }

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });
 
  context('multi-collateral: full seizure of second asset when remaining debt is above min debt value', function () {
    const compAmount = exp(0.5, 18); // 0.5 COMP, worth $50 before the price drop
    const wethAmount = exp(0.025, 18); // 0.025 WETH, worth $50 before the price drop
    const borrowAmount = exp(70, 6); // $70

    const collateralKey1 = 'COMP';
    const collateralKey2 = 'WETH';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey1].address, compAmount);
      await comet.connect(alice).supply(tokens[collateralKey2].address, wethAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // COMP falls from $100 to $80 and WETH falls from $2,000 to $1,200.
      // After COMP is fully seized, the remaining debt is still above baseBorrowMin,
      // but WETH is still not enough to cover it, so WETH is fully seized too.
      await priceFeeds[collateralKey1].connect(alice).setRoundData(0, exp(80, 8), 0, 0, 0);
      await priceFeeds[collateralKey2].connect(alice).setRoundData(0, exp(1200, 8), 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey1, collateralKey2]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const compPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wethPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      // COMP: $80*0.5=$40 * LF 0.90 = $36. WETH: $1200*0.025=$30 * LF 0.90 = $27. Total $63 < $70 debt
      const totalCollateralValueAfterLF =
        mulFactor(mulPrice(compAmount, compPrice, compInfo.scale.toBigInt()), compInfo.liquidationFactor.toBigInt()) +
        mulFactor(mulPrice(wethAmount, wethPrice, wethInfo.scale.toBigInt()), wethInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('sanity check: remaining debt after full COMP seizure stays above min debt value', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const compPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const compSeizedValue = mulFactor(mulPrice(compAmount, compPrice, compInfo.scale.toBigInt()), compInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      // Remaining debt > minDebt ensures WETH goes through the normal (not minDebt) seizure path
      expect(debtValue - compSeizedValue).to.be.greaterThan(mulPrice(baseBorrowMin, baseTokenPrice, baseScale));
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full COMP seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const compPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(compAmount, compPrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey1].address, compAmount, wantedCollateralValue);
    });

    it('emits AbsorbCollateral for full WETH seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const wethPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(wethAmount, wethPrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey2].address, wethAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey1].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is zero after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey2].address)).to.be.equal(0);
    });

    it('alice assetsIn bits are cleared after absorb', async () => {
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey1].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey1].totalsCollateralBefore.sub(compAmount));
    });

    it('comet total supplied WETH decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey2].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey2].totalsCollateralBefore.sub(wethAmount));
    });

    it('comet ERC20 COMP token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey1].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey1].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey2].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey2].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet COMP collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey1].address)).to.be.equal(
        collateralsState[collateralKey1].collateralReservesBefore.add(compAmount)
      );
    });

    it('comet WETH collateral reserves increase by the seized collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey2].address)).to.be.equal(
        collateralsState[collateralKey2].collateralReservesBefore.add(wethAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('1 collateral: full seizure when collateral value equals debt after liquidation factor', function () {
    const collateralAmount = exp(1, 18); // 1 COMP
    const borrowAmount = exp(45, 6); // $45

    const collateralKey = 'COMP';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let cometBaseTokenBalanceBefore: BigNumber;
    let assetsInBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const debtValue = mulPrice(borrowAmount, baseTokenPrice, baseScale);

      // We want exact equality after full seizure:
      //   seizedValue = collateralValue * liquidationFactor = debtValue
      // so:
      //   collateralValue = debtValue / liquidationFactor
      // For $45 debt and COMP LF 0.90: collateralValue = 45 / 0.90 = $50.
      const wantedCollateralValue = debtValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      const exactCompPrice = wantedCollateralValue * assetInfo.scale.toBigInt() / collateralAmount;
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, exactCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: seized value exactly equals the debt (boundary: exact coverage)', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const collateralValue = mulPrice(collateralAmount, compPrice, assetInfo.scale.toBigInt());
      const seizedValue = mulFactor(collateralValue, assetInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(seizedValue).to.be.equal(debtValue);
    });

    it('sanity check: debt is greater than baseBorrowMin', async () => {
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtValue).to.be.greaterThan(mulPrice(baseBorrowMin, baseTokenPrice, baseScale));
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full COMP seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const price = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(collateralAmount, price, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey].address, collateralAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after full seizure', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after full seizure', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
    });

    it('alice assetsIn is cleared', async () => {
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied collateral decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralAmount));
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet collateral reserves increase by all seized collateral', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(
        collateralsState[collateralKey].collateralReservesBefore.add(collateralAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('multi-collateral: full seizure when total collateral value equals debt after liquidation factors', function () {
    const compAmount = exp(1, 18); // 1 COMP
    const wethAmount = exp(0.01, 18); // 0.01 WETH
    const borrowAmount = exp(54, 6); // $54

    const collateralKey1 = 'COMP';
    const collateralKey2 = 'WETH';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey1].address, compAmount);
      await comet.connect(alice).supply(tokens[collateralKey2].address, wethAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const debtValue = mulPrice(borrowAmount, baseTokenPrice, baseScale);

      // First asset: choose COMP value of $40 after the price change.
      //   COMP seizedValue = $40 * LF 0.90 = $36
      const compWantedCollateralValue = exp(40, 8);
      const exactCompPrice = compWantedCollateralValue * compInfo.scale.toBigInt() / compAmount;

      // Second asset must cover exactly the remaining debt:
      //   remaining debt = $54 - $36 = $18, which is above baseBorrowMin ($10)
      //   WETH collateralValue = $18 / LF 0.90 = $20
      const compWantedSeizedValue = mulFactor(compWantedCollateralValue, compInfo.liquidationFactor.toBigInt());
      const wethWantedCollateralValue = (debtValue - compWantedSeizedValue) * factorScale / wethInfo.liquidationFactor.toBigInt();
      const exactWethPrice = wethWantedCollateralValue * wethInfo.scale.toBigInt() / wethAmount;

      await priceFeeds[collateralKey1].connect(alice).setRoundData(0, exactCompPrice, 0, 0, 0);
      await priceFeeds[collateralKey2].connect(alice).setRoundData(0, exactWethPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey1, collateralKey2]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: COMP seized value plus WETH seized value exactly equals the debt (boundary: exact coverage)', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const compPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wethPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      // compSeizedValue = $40 * LF 0.90 = $36; wethSeizedValue = $20 * LF 0.90 = $18; total = $54 = debtValue
      const compSeizedValue = mulFactor(mulPrice(compAmount, compPrice, compInfo.scale.toBigInt()), compInfo.liquidationFactor.toBigInt());
      const wethSeizedValue = mulFactor(mulPrice(wethAmount, wethPrice, wethInfo.scale.toBigInt()), wethInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(compSeizedValue + wethSeizedValue).to.be.equal(debtValue);
    });

    it('sanity check: remaining debt after COMP seizure is above baseBorrowMin', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const compPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      // compSeizedValue = $36; debtValue = $54; remaining = $18 > baseBorrowMin ($10)
      const compSeizedValue = mulFactor(mulPrice(compAmount, compPrice, compInfo.scale.toBigInt()), compInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtValue - compSeizedValue).to.be.greaterThan(mulPrice(baseBorrowMin, baseTokenPrice, baseScale));
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full COMP seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const price = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(compAmount, price, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey1].address, compAmount, wantedCollateralValue);
    });

    it('emits AbsorbCollateral for full WETH seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const price = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(wethAmount, price, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey2].address, wethAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after both assets are fully seized', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after both assets are fully seized', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey1].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey2].address)).to.be.equal(0);
    });

    it('alice assetsIn is cleared', async () => {
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey1].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey1].totalsCollateralBefore.sub(compAmount));
    });

    it('comet total supplied WETH decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey2].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey2].totalsCollateralBefore.sub(wethAmount));
    });

    it('comet ERC20 COMP token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey1].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey1].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey2].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey2].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet COMP collateral reserves increase by all seized COMP', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey1].address)).to.be.equal(
        collateralsState[collateralKey1].collateralReservesBefore.add(compAmount)
      );
    });

    it('comet WETH collateral reserves increase by all seized WETH', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey2].address)).to.be.equal(
        collateralsState[collateralKey2].collateralReservesBefore.add(wethAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('multi-collateral: final collateral below min debt is fully seized as bad debt (assets index 3, 7, 19)', function () {
    const wbtcAmount = exp(0.001, 8); // $40
    const cbethAmount = exp(0.008, 18); // $21
    const arbAmount = exp(10, 18); // $5
    const borrowAmount = exp(65, 6); // $65

    const collateralKey1 = 'WBTC';
    const collateralKey2 = 'cbETH';
    const collateralKey3 = 'ARB';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey1].address, wbtcAmount); // index 3 in default24Assets
      await comet.connect(alice).supply(tokens[collateralKey2].address, cbethAmount); // index 7 in default24Assets
      await comet.connect(alice).supply(tokens[collateralKey3].address, arbAmount); // index 19 in default24Assets
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      const wbtcInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const cbethInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const arbInfo = await comet.getAssetInfoByAddress(tokens[collateralKey3].address);

      // We choose prices from target USD values, rather than hardcoding prices:
      //   WBTC target value = $40  ->  $40 / 0.001 WBTC = $40,000
      //   cbETH target value = $21 ->  $21 / 0.008 cbETH = $2,625
      //   ARB target value = $5    ->  $5 / 10 ARB = $0.50
      const wbtcTargetValue = exp(40, 8);
      const cbethTargetValue = exp(21, 8);
      const arbTargetValue = exp(5, 8);
      const wbtcPrice = wbtcTargetValue * wbtcInfo.scale.toBigInt() / wbtcAmount;
      const cbethPrice = cbethTargetValue * cbethInfo.scale.toBigInt() / cbethAmount;
      const arbPrice = arbTargetValue * arbInfo.scale.toBigInt() / arbAmount;

      await priceFeeds[collateralKey1].connect(alice).setRoundData(0, wbtcPrice, 0, 0, 0);
      await priceFeeds[collateralKey2].connect(alice).setRoundData(0, cbethPrice, 0, 0, 0);
      await priceFeeds[collateralKey3].connect(alice).setRoundData(0, arbPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey1, collateralKey2, collateralKey3]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
      const wbtcInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const cbethInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const arbInfo = await comet.getAssetInfoByAddress(tokens[collateralKey3].address);
      const wbtcPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const cbethPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      const arbPrice = (await priceFeeds[collateralKey3].latestRoundData())[1].toBigInt();
      // wbtcSeized = $40 * 0.90 = $36; cbethSeized = $21 * 0.90 = $18.9; arbSeized = $5 * 0.85 = $4.25; total = $59.15 < $65
      const totalCollateralValueAfterLF =
        mulFactor(mulPrice(wbtcAmount, wbtcPrice, wbtcInfo.scale.toBigInt()), wbtcInfo.liquidationFactor.toBigInt()) +
        mulFactor(mulPrice(cbethAmount, cbethPrice, cbethInfo.scale.toBigInt()), cbethInfo.liquidationFactor.toBigInt()) +
        mulFactor(mulPrice(arbAmount, arbPrice, arbInfo.scale.toBigInt()), arbInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
    });

    it('sanity check: remaining debt after WBTC and cbETH seizure is below baseBorrowMin (triggers minDebt path for ARB)', async () => {
      const wbtcInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const cbethInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const wbtcPrice = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const cbethPrice = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      // wbtcSeized = $36, cbethSeized = $18.9; remaining = $65 - $36 - $18.9 = $10.1 < baseBorrowMin ($10)
      const wbtcSeizedValue = mulFactor(mulPrice(wbtcAmount, wbtcPrice, wbtcInfo.scale.toBigInt()), wbtcInfo.liquidationFactor.toBigInt());
      const cbethSeizedValue = mulFactor(mulPrice(cbethAmount, cbethPrice, cbethInfo.scale.toBigInt()), cbethInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtValue - wbtcSeizedValue - cbethSeizedValue).to.be.lessThan(mulPrice(baseBorrowMin, baseTokenPrice, baseScale));
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full WBTC seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey1].address);
      const price = (await priceFeeds[collateralKey1].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(wbtcAmount, price, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey1].address, wbtcAmount, wantedCollateralValue);
    });

    it('emits AbsorbCollateral for full cbETH seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey2].address);
      const price = (await priceFeeds[collateralKey2].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(cbethAmount, price, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey2].address, cbethAmount, wantedCollateralValue);
    });

    it('emits AbsorbCollateral for full ARB seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey3].address);
      const price = (await priceFeeds[collateralKey3].latestRoundData())[1].toBigInt();
      const wantedCollateralValue = mulPrice(arbAmount, price, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey3].address, arbAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice WBTC collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey1].address)).to.be.equal(0);
    });

    it('alice cbETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey2].address)).to.be.equal(0);
    });

    it('alice ARB collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey3].address)).to.be.equal(0);
    });

    it('alice assetsIn is cleared', async () => {
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are cleared', async () => {
      expect(reservedBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied WBTC decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey1].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey1].totalsCollateralBefore.sub(wbtcAmount));
    });

    it('comet total supplied cbETH decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey2].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey2].totalsCollateralBefore.sub(cbethAmount));
    });

    it('comet total supplied ARB decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey3].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey3].totalsCollateralBefore.sub(arbAmount));
    });

    it('comet ERC20 collateral token balances do not change during absorb', async () => {
      expect(await tokens[collateralKey1].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey1].tokenBalanceBefore);
      expect(await tokens[collateralKey2].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey2].tokenBalanceBefore);
      expect(await tokens[collateralKey3].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey3].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet collateral reserves increase for all seized collateral', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey1].address)).to.be.equal(
        collateralsState[collateralKey1].collateralReservesBefore.add(wbtcAmount)
      );
      expect(await comet.getCollateralReserves(tokens[collateralKey2].address)).to.be.equal(
        collateralsState[collateralKey2].collateralReservesBefore.add(cbethAmount)
      );
      expect(await comet.getCollateralReserves(tokens[collateralKey3].address)).to.be.equal(
        collateralsState[collateralKey3].collateralReservesBefore.add(arbAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('1 collateral: debt below min debt and collateral cannot cover it', function () {
    const collateralAmount = exp(1, 18); // 1 AAVE
    const borrowAmount = exp(12, 6); // $12, initially above baseBorrowMin
    const repayAmount = exp(4, 6); // leaves $8 debt, below baseBorrowMin
    const droppedAavePrice = exp(5, 8); // collateral value becomes $5

    const collateralKey = 'AAVE';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let cometBaseTokenBalanceBefore: BigNumber;
    let assetsInBefore: number;
    let oldBalance: bigint;
    let principalBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // repay part of the borrow to have debt below baseBorrowMin
      await comet.connect(alice).supply(baseToken.address, repayAmount);

      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedAavePrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('alice borrow balance is below baseBorrowMin after repay', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
      expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
    });

    it('sanity check: debt is below baseBorrowMin (triggers minDebt path)', async () => {
      // debtValue = $8e8, minDebtValue = $10e8 — enters _processDebtClosing
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtValue).to.be.lessThan(mulPrice(baseBorrowMin, baseTokenPrice, baseScale));
    });

    it('sanity check: collateral value after liquidation factor cannot cover the debt (bad debt)', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      // AAVE value = $5, after LF 0.85 = $4.25 < $8 debt — full seizure still leaves residual bad debt
      const seizedValue = mulFactor(mulPrice(collateralAmount, droppedAavePrice, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(seizedValue).to.be.lessThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('emits AbsorbCollateral for full AAVE seizure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const wantedCollateralValue = mulPrice(collateralAmount, droppedAavePrice, assetInfo.scale.toBigInt());
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, tokens[collateralKey].address, collateralAmount, wantedCollateralValue);
    });

    it('emits AbsorbDebt for the full remaining borrow amount', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
    });

    it('alice assetsIn is cleared', async () => {
      expect(assetsInBefore).to.not.equal(0);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied collateral decreases by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralAmount));
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet collateral reserves increase by all seized collateral', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(
        collateralsState[collateralKey].collateralReservesBefore.add(collateralAmount)
      );
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding + oldBalance);
    });
  });

  context('24 collaterals: all collaterals are fully seized after moderate price drops', function () {
    const collateralSymbols = [
      'COMP', 'WETH', 'USDT', 'WBTC', 'DAI', 'wstETH', 'rsETH', 'cbETH',
      'rETH', 'weETH', 'ezETH', 'cbBTC', 'tBTC', 'LINK', 'UNI', 'AAVE',
      'LDO', 'CRV', 'MKR', 'ARB', 'OP', 'GMX', 'USDe', 'sUSDe',
    ];
    const largeCollateralValue = exp(9_000, 8);
    const stableCollateralValue = exp(100, 8);
    const dustCollateralValue = exp(1, 8);
    const priceDropFactor = 85n; // 15% price drop

    let collateralConfigs: {
      symbol: string;
      asset: FaucetToken;
      amount: bigint;
      initialPrice: bigint;
      droppedPrice: bigint;
    }[] = [];
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let cometBaseTokenBalanceBefore: BigNumber;
    let oldBalance: bigint;
    let principalBefore: BigNumber;
    let borrowAmount: bigint;
    let maxBorrowValue: bigint;
    let debtRemainingValue: bigint;
    let totalSeizedValue: bigint;
    let collateralValues: { [symbol: string]: bigint } = {};
    let seizedValues: { [symbol: string]: bigint } = {};
    let collateralsState: Record<string, CollateralState> = {};

    before(async function() {
      for (const symbol of collateralSymbols) {
        const asset = tokens[symbol];
        const assetInfo = await comet.getAssetInfoByAddress(asset.address);
        const initialPrice = (await priceFeeds[symbol].latestRoundData())[1].toBigInt();
        let targetValue = dustCollateralValue;
        if (symbol === 'COMP') {
          targetValue = largeCollateralValue;
        } else if (symbol === 'USDT' || symbol === 'DAI') {
          targetValue = stableCollateralValue;
        }
        const amount = targetValue * assetInfo.scale.toBigInt() / initialPrice;

        collateralConfigs.push({
          symbol,
          asset,
          amount,
          initialPrice,
          droppedPrice: initialPrice * priceDropFactor / 100n,
        });
      }
    });

    it('uses all supported collateral assets', () => {
      expect(collateralConfigs.length).to.be.equal(24);
    });

    it('alice supplies every collateral', async () => {
      for (const config of collateralConfigs) {
        await expect(
          comet.connect(alice).supply(config.asset.address, config.amount)
        ).to.not.be.reverted;
      }
    });

    it('calculates a borrow amount close to the initial borrow capacity', async () => {
      maxBorrowValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(config.asset.address);
        const collateralValue = mulPrice(config.amount, config.initialPrice, assetInfo.scale);
        maxBorrowValue += mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
      }

      // Borrow just under the initial borrow limit so the position is valid before prices move.
      borrowAmount = maxBorrowValue * 99n / 100n * baseScale / baseTokenPrice;
    });

    it('alice borrows close to the initial borrow capacity', async () => {
      await expect(
        comet.connect(alice).withdraw(baseToken.address, borrowAmount)
      ).to.not.be.reverted;
    });

    it('alice borrow balance is equal to the borrowed amount', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount);
    });

    it('every collateral price drops', async () => {
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('captures state before absorb', async () => {
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      const utilization = await comet.getUtilization();
      const borrowRate = (await comet.getBorrowRate(utilization)).toBigInt();
      const timeElapsed = 1n;
      const baseBorrowIndex = totalsBasic.baseBorrowIndex.toBigInt()
        + mulFactor(totalsBasic.baseBorrowIndex.toBigInt(), borrowRate * timeElapsed);

      principalBefore = userBasic.principal;
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      oldBalance = presentValue(principalBefore, totalsBasic.baseSupplyIndex, baseBorrowIndex);
    });

    it('borrow balance is greater than or equal to the borrowed amount', async () => {
      expect(-oldBalance).to.be.greaterThanOrEqual(borrowAmount);
    });

    it('comet ERC20 base token balance is reduced by the borrow before absorb', async () => {
      expect(cometBaseTokenBalanceBefore).to.be.equal(initialBaseFunding - borrowAmount);
    });

    it('captures collateral state before absorb', async () => {
      collateralsState = await makeCollateralStates(comet, tokens, collateralSymbols);

      // Note: these checks are not strictly necessary, but they help to ensure that the collateral state is captured correctly.
      // This checks inside the for loop to avoid massive test output.
      for (const config of collateralConfigs) {
        expect(collateralsState[config.symbol].totalsCollateralBefore).to.be.equal(config.amount);
        expect(collateralsState[config.symbol].collateralReservesBefore).to.be.equal(0);
        expect(collateralsState[config.symbol].tokenBalanceBefore).to.be.equal(config.amount);
      }
    });

    it('post-drop collateral cannot cover the debt after liquidation factors', async () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      totalSeizedValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(config.asset.address);
        collateralValues[config.symbol] = mulPrice(config.amount, config.droppedPrice, assetInfo.scale);
        seizedValues[config.symbol] = mulFactor(collateralValues[config.symbol], assetInfo.liquidationFactor);
        totalSeizedValue += seizedValues[config.symbol];
      }

      expect(totalSeizedValue).to.be.lessThan(debtRemainingValue);
    });

    it('target health math requires full seizure for each collateral', async () => {
      for (const [index, config] of collateralConfigs.entries()) {
        const assetInfo = await comet.getAssetInfoByAddress(config.asset.address);
        const remainingConfigs = collateralConfigs.slice(index);
        let remainingCollateralizedValue = 0n;

        for (const remainingConfig of remainingConfigs) {
          const remainingInfo = await comet.getAssetInfoByAddress(remainingConfig.asset.address);
          remainingCollateralizedValue += mulFactor(
            collateralValues[remainingConfig.symbol],
            remainingInfo.borrowCollateralFactor
          );
        }

        const wantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - remainingCollateralizedValue) * factorScale
            / (mulFactor(assetInfo.liquidationFactor, targetHealthFactor) - assetInfo.borrowCollateralFactor.toBigInt());
        
        expect(wantedCollateralValue).to.be.greaterThan(collateralValues[config.symbol]);
        
        debtRemainingValue -= seizedValues[config.symbol];
      }
    });

    it('debt remaining value is greater than zero: bad debt', async () => {
      expect(debtRemainingValue).to.be.greaterThan(0n);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    for (const config of collateralConfigs) {
      it(`emits AbsorbCollateral for full ${config.symbol} seizure`, async () => {
        const assetInfo = await comet.getAssetInfoByAddress(config.asset.address);
        const wantedCollateralValue = mulPrice(config.amount, config.droppedPrice, assetInfo.scale.toBigInt());
        await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
          .withArgs(absorber.address, alice.address, config.asset.address, config.amount, wantedCollateralValue);
      });
    }

    it('emits AbsorbDebt for the full absorbed borrow amount', async () => {
      const basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('all alice collateral balances are zero', async () => {
      for (const config of collateralConfigs) {
        expect(await comet.collateralBalanceOf(alice.address, config.asset.address)).to.be.equal(0);
      }
    });

    // Comet borrow state
    it('comet total borrow base decreases by the absorbed principal', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      // principalBefore is negative (borrow), so .add reduces totalBorrowBase
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.add(principalBefore));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('all collateral totals are zero', async () => {
      for (const config of collateralConfigs) {
        const totalSupplyAsset = (await comet.totalsCollateral(config.asset.address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(config.amount));
        expect(totalSupplyAsset).to.be.equal(0);
      }
    });

    it('comet ERC20 collateral token balances do not change during absorb', async () => {
      for (const config of collateralConfigs) {
        expect(await config.asset.balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      }
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('all collateral reserves increase by the seized amounts', async () => {
      for (const config of collateralConfigs) {
        expect(await comet.getCollateralReserves(config.asset.address)).to.be.equal(
          collateralsState[config.symbol].collateralReservesBefore.add(config.amount)
        );
      }
    });

    it('comet base reserves decrease by the absorbed debt', async () => {
      // ERC20 balance of comet only moved by borrowAmount (not projected-interest-inflated oldBalance)
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - borrowAmount);
    });
  });
});