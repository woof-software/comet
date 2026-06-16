import { ethers, expect, exp, makeProtocol, presentValue, mulPrice, mulFactor, default24Assets, divPrice, CollateralState, makeCollateralStates, seedMarketActivity } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { AssetInfoStructOutput, TotalsBasicStructOutput } from 'build/types/CometHarnessInterfaceExtendedAssetList';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

describe('partial liquidation', function() {
  // Protocol
  let comet: CometHarnessInterfaceExtendedAssetList;

  // Constants
  const baseTokenPrice = exp(1, 8);
  const initialBaseFunding = baseTokenPrice * 10_000n;
  const baseBorrowMin = 0; // $0

  // Assets
  let tokens: { [symbol: string]: FaucetToken } = {};
  let baseToken: FaucetToken;
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  // Signers
  let alice: SignerWithAddress;
  let absorber: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;

  // Math
  const baseScale: bigint = 10n ** 6n;
  const factorScale: bigint = 10n ** 18n;
  let targetHealthFactor: bigint;

  let snapshot: SnapshotRestorer;

  function getWantedCollateralValue(
    assetInfo: AssetInfoStructOutput,
    debtRemainingValue: bigint,
    totalCollateralizedValue: bigint,
  ): bigint {
    // S = (targetHF * debt - totalCollateralizedValue) / (targetHF * LF - BCF)
    return (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
      / (mulFactor(assetInfo.liquidationFactor, targetHealthFactor) - assetInfo.borrowCollateralFactor.toBigInt());
  }

  before(async function() {
    const default24AssetsData = default24Assets();
    const protocol = await makeProtocol({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        ...default24AssetsData,
        // Large cap so the 24-collateral scenario can hold enough sUSDe.
        sUSDe: { ...default24AssetsData.sUSDe, supplyCap: exp(4000, 18) },
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
    [bob, dave] = protocol.users.slice(2);

    const allocateAmount = exp(1_000_000, 18);
    for (const token of Object.values(protocol.tokens)) {
      await (token as FaucetToken).allocateTo(alice.address, allocateAmount);
      await (token as FaucetToken).connect(alice).approve(comet.address, ethers.constants.MaxUint256);
    }

    await seedMarketActivity(comet, tokens, priceFeeds, bob, dave, baseToken,  initialBaseFunding );

    targetHealthFactor = (await comet.targetHealthFactor()).toBigInt();

    snapshot = await takeSnapshot();
  });

  context('1 collateral: partial seizure, user has enough to cover debt (asset index 0)', function () {
    const collateralAmount = exp(1, 18); // $100 COMP
    const borrowAmount = exp(80, 6); // $80

    const collateralKey = 'COMP';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let assetsInBefore: number;
    let reservedBefore: number;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of the only collateral backing the debt.
    let totalCollateralizedValue: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop price by 7%
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const newCompPrice = compPrice * 93n / 100n;
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, newCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      // COMP is the only collateral backing the debt, so the BCF-weighted total is just its value:
      // $93 × 0.80 = $74.40.
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const compCollateralValue = mulPrice(collateralAmount, newCompPrice, compInfo.scale);
      totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const price = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const collateralValue = mulPrice(collateralAmount, price, assetInfo.scale);
      const liquidityValue = mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const price = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const balance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);
      const liquidityValue = mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates seize amount and seized value for partial liquidation', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();

      // Debt is 80 USDC, so the debt value is $80.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);

      // Solve for S in:
      // targetHF = (totalCollateralValue - S * borrowCF) / (debt - S * liquidationFactor)
      // With these values, S is about $66.21 of COMP.
      const wantedCollateralValue = getWantedCollateralValue(assetInfo, debtRemainingValue, totalCollateralizedValue);

      // Convert the wanted USD value into COMP amount, then apply LF for the debt value repaid.
      // At $93/COMP this seizes about 0.7119 COMP and repays about $59.59 of debt value.
      collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, compPrice, assetInfo.scale);
      collateralsState[collateralKey].seizedValue = mulFactor(wantedCollateralValue, assetInfo.liquidationFactor);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);

      expect(collateralBalance).to.be.equal(collateralAmount - collateralsState[collateralKey].seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount - collateralsState[collateralKey].seizeAmount);
    });

    it('alice assetsIn does not change', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
    });
  });

  context('1 collateral: partial seizure, user has enough to cover debt (asset index 16)', function () {
    const collateralAmount = exp(100, 18); // 100 LDO, initially worth $200
    const borrowAmount = exp(80, 6); // $80

    const collateralKey = 'LDO';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let assetsInBefore: number;
    let reservedBefore: number;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of the only collateral backing the debt.
    let totalCollateralizedValue: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop LDO by 45% from $2 to $1.10. 100 LDO is now worth $110.
      // Remaining debt after partial seizure ≈ $21.68, which is above baseBorrowMin ($10).
      const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const newLdoPrice = ldoPrice * 55n / 100n;
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, newLdoPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      // LDO is the only collateral backing the debt, so the BCF-weighted total is just its value:
      // $110 × 0.55 = $60.50.
      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const ldoCollateralValue = mulPrice(collateralAmount, newLdoPrice, ldoInfo.scale);
      totalCollateralizedValue = mulFactor(ldoCollateralValue, ldoInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const price = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const collateralValue = mulPrice(collateralAmount, price, assetInfo.scale);
      const liquidityValue = mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const price = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const balance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);
      const liquidityValue = mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates seize amount and seized value for partial liquidation', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1];

      // Debt is $80.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);

      // Solve for S in:
      // targetHF = (totalCollateralValue - S * borrowCF) / (debt - S * liquidationFactor)
      const wantedCollateralValue = getWantedCollateralValue(assetInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, ldoPrice, assetInfo.scale);
      collateralsState[collateralKey].seizedValue = mulFactor(wantedCollateralValue, assetInfo.liquidationFactor);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);

      expect(collateralBalance).to.be.equal(collateralAmount - collateralsState[collateralKey].seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount - collateralsState[collateralKey].seizeAmount);
    });

    it('alice assetsIn does not change', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
    });
  });

  context('1 collateral: partial seizure, user has enough to cover debt (last asset index)', function () {
    const collateralAmount = exp(100, 18); // 100 sUSDe, initially worth $100
    const borrowAmount = exp(50, 6); // $50

    const collateralKey = 'sUSDe';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let assetsInBefore: number;
    let reservedBefore: number;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of the only collateral backing the debt.
    let totalCollateralizedValue: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop sUSDe by 40% from $1 to $0.60. 100 sUSDe is now worth $60.
      // Remaining debt after partial seizure ≈ $15.22, which is above baseBorrowMin ($10).
      const sUsdePrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const newSUsdePrice = sUsdePrice * 60n / 100n;
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, newSUsdePrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      // sUSDe is the only collateral backing the debt, so the BCF-weighted total is just its value:
      // $60 × 0.72 = $43.20.
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const sUsdeCollateralValue = mulPrice(collateralAmount, newSUsdePrice, sUsdeInfo.scale);
      totalCollateralizedValue = mulFactor(sUsdeCollateralValue, sUsdeInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const price = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const collateralValue = mulPrice(collateralAmount, price, assetInfo.scale);
      const liquidityValue = mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const price = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const balance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);
      const liquidityValue = mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates seize amount and seized value for partial liquidation', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const sUsdePrice = (await priceFeeds[collateralKey].latestRoundData())[1];

      // Debt is $50.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);

      // Solve for S in:
      // targetHF = (totalCollateralValue - S * borrowCF) / (debt - S * liquidationFactor)
      const wantedCollateralValue = getWantedCollateralValue(assetInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, sUsdePrice, assetInfo.scale);
      collateralsState[collateralKey].seizedValue = mulFactor(wantedCollateralValue, assetInfo.liquidationFactor);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);

      expect(collateralBalance).to.be.equal(collateralAmount - collateralsState[collateralKey].seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount - collateralsState[collateralKey].seizeAmount);
    });

    it('alice assetsIn does not change', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
    });
  });

  context('multi-collateral: full seizure of first asset then partial of second', function () {
    const borrowAmount = exp(80, 6); // $80

    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(0.6, 18), droppedPrice: exp(80, 8) }, // 0.6 COMP, worth $60 before the price drop
      { symbol: 'WETH', amount: exp(0.0225, 18), droppedPrice: exp(2000, 8) }, // 0.0225 WETH at $2,000 = $45
    ];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let assetsInBefore: number;
    let reservedBefore: number;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of the collateral still backing the debt when WETH is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop COMP by 20% to $80. The supplied COMP is now worth $48.
      // WETH stays at $45, enough for partial seizure after COMP is fully seized.
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      // COMP is fully seized before the loop reaches WETH, so when WETH is partially seized the only
      // collateral still backing the debt is WETH: $45 × 0.75 = $33.75.
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, wethInfo.scale);
      totalCollateralizedValue = mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates COMP full seizure and WETH partial seizure values', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      // COMP is first in asset order. After the 20% price drop, 0.6 COMP is worth $48 — less than the
      // target HF formula wants, so the whole COMP balance is seized.
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, compInfo.scale);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      // After COMP full seizure, debt is $80 - $43.20 = $36.80.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;

      // Solve the same target HF formula for WETH.
      // It wants about $25.08 of WETH value, so WETH is partially seized.
      const wantedWethCollateralValue = getWantedCollateralValue(wethInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, collateralConfigs[1].droppedPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
    });

    it('alice WETH collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
    });

    it('alice assetsIn keeps only WETH', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const expectedAssetsIn = 1 << wethInfo.offset;

      expect(assetsInBefore).to.not.equal(expectedAssetsIn);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(expectedAssetsIn);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    for (const config of collateralConfigs) {
      it(`comet total supplied ${config.symbol} is reduced by the seized amount`, async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
      });
    }

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    for (const config of collateralConfigs) {
      it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
        expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
      });
    }
  });

  context('multi-collateral: full seizure of asset index 15 then partial of asset index 16', function () {
    const borrowAmount = exp(75, 6); // $75

    const collateralConfigs = [
      { symbol: 'AAVE', amount: exp(0.6, 18), droppedPrice: exp(80, 8) }, // 0.6 AAVE, worth $60 before the price drop
      { symbol: 'LDO', amount: exp(37.5, 18), droppedPrice: exp(1.6, 8) }, // 37.5 LDO, worth $75 before the price drop
    ];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let reservedBefore: number;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of the collateral still backing the debt when LDO is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 20%. AAVE is now worth $48 and LDO is worth $60.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      // AAVE is fully seized before the loop reaches LDO, so when LDO is partially seized the only
      // collateral still backing the debt is LDO: $60 × 0.55 = $33.
      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const ldoCollateralValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, ldoInfo.scale);
      totalCollateralizedValue = mulFactor(ldoCollateralValue, ldoInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates AAVE full seizure and LDO partial seizure values', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      // AAVE is asset index 15. After the 20% price drop, 0.6 AAVE is worth $48 — less than the
      // target HF formula wants, so the whole AAVE balance is seized.
      const aaveCollateralValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(aaveCollateralValue, aaveInfo.liquidationFactor);

      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // After AAVE full seizure, debt is $75 - $40.80 = $34.20.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;

      // Solve the same target HF formula for LDO.
      // It wants about $8.50 of LDO value, so LDO is partially seized.
      const wantedLdoCollateralValue = getWantedCollateralValue(ldoInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedLdoCollateralValue, ldoPrice, ldoInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedLdoCollateralValue, ldoInfo.liquidationFactor);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice AAVE collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
    });

    it('alice LDO collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
    });

    it('alice assetsIn is zero after AAVE is fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved keeps only LDO', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    for (const config of collateralConfigs) {
      it(`comet total supplied ${config.symbol} is reduced by the seized amount`, async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
      });
    }

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    for (const config of collateralConfigs) {
      it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
        expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
      });
    }
  });

  context('multi-collateral: full seizure of asset index 22 then partial of asset index 23', function () {
    const borrowAmount = exp(90, 6); // $90

    const collateralConfigs = [
      { symbol: 'USDe', amount: exp(60, 18), droppedPrice: exp(0.8, 8) }, // 60 USDe, worth $60 before the price drop
      { symbol: 'sUSDe', amount: exp(75, 18), droppedPrice: exp(0.8, 8) }, // 75 sUSDe, worth $75 before the price drop
    ];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let reservedBefore: number;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of the collateral still backing the debt when sUSDe is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 20%. USDe is now worth $48 and sUSDe is worth $60.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      // USDe is fully seized before the loop reaches sUSDe, so when sUSDe is partially seized the only
      // collateral still backing the debt is sUSDe: $60 × 0.72 = $43.20.
      const susdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const susdeCollateralValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, susdeInfo.scale);
      totalCollateralizedValue = mulFactor(susdeCollateralValue, susdeInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates USDe full seizure and sUSDe partial seizure values', async () => {
      const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const usdePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      // USDe is asset index 22. After the 20% price drop, 60 USDe is worth $48 — less than the
      // target HF formula wants, so the whole USDe balance is seized.
      const usdeCollateralValue = mulPrice(collateralConfigs[0].amount, usdePrice, usdeInfo.scale);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(usdeCollateralValue, usdeInfo.liquidationFactor);

      const susdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const susdePrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // After USDe full seizure, debt is $90 - $44.16 = $45.84.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;

      // Solve the same target HF formula for sUSDe.
      // It wants about $32.79 of sUSDe value, so sUSDe is partially seized.
      const wantedSusdeCollateralValue = getWantedCollateralValue(susdeInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedSusdeCollateralValue, susdePrice, susdeInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedSusdeCollateralValue, susdeInfo.liquidationFactor);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice USDe collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
    });

    it('alice sUSDe collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
    });

    it('alice assetsIn remains zero', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved keeps only sUSDe', async () => {
      const susdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      expect((await comet.userBasic(alice.address))._reserved).to.not.be.equal(reservedBefore);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(1 << (susdeInfo.offset - 16));
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    for (const config of collateralConfigs) {
      it(`comet total supplied ${config.symbol} is reduced by the seized amount`, async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
      });
    }

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    for (const config of collateralConfigs) {
      it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
        expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
      });
    }
  });

  context('multi-collateral: full seizure of asset index 10 then partial of asset index 20', function () {
    const borrowAmount = exp(80, 6);   // $80

    const collateralConfigs = [
      { symbol: 'ezETH', amount: exp(0.02, 18), droppedPrice: exp(2512.5, 8) }, // 0.02 ezETH, worth $67 before the price drop
      { symbol: 'OP', amount: exp(40, 18), droppedPrice: exp(1.5, 8) }, // 40 OP, worth $80 before the price drop
    ];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let reservedBefore: number;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of the collateral still backing the debt when OP is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 25%. ezETH is now worth $50.25 and OP is worth $60.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      // ezETH is fully seized before the loop reaches OP, so when OP is partially seized the only
      // collateral still backing the debt is OP: $60 × 0.55 = $33.
      const opInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const opCollateralValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, opInfo.scale);
      totalCollateralizedValue = mulFactor(opCollateralValue, opInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates ezETH full seizure and OP partial seizure values', async () => {
      const ezETHInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const ezETHPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      // ezETH is asset index 10. After the 25% price drop, 0.02 ezETH is worth $50.25 — less than the
      // target HF formula wants, so the whole ezETH balance is seized.
      const ezETHCollateralValue = mulPrice(collateralConfigs[0].amount, ezETHPrice, ezETHInfo.scale);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(ezETHCollateralValue, ezETHInfo.liquidationFactor);

      const opInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const opPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // After ezETH full seizure, debt is $80 − $45.73 = $34.27.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;

      // Solve the same target HF formula for OP.
      // It wants about $8.72 of OP value, so OP is partially seized.
      const wantedOPCollateralValue = getWantedCollateralValue(opInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedOPCollateralValue, opPrice, opInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedOPCollateralValue, opInfo.liquidationFactor);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice ezETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
    });

    it('alice OP collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
    });

    it('alice assetsIn is zero after ezETH is fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved is unchanged as OP still has remaining balance', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    for (const config of collateralConfigs) {
      it(`comet total supplied ${config.symbol} is reduced by the seized amount`, async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
      });
    }

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    for (const config of collateralConfigs) {
      it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
        expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
      });
    }
  });

  context('multi-collateral: 5 different collaterals with non following asset indexes', function () {
    const borrowAmount = exp(80, 6);    // $80

    const collateralConfigs = [
      { symbol: 'WBTC', amount: exp(0.0001, 8), droppedPrice: exp(32500, 8) }, // 0.0001 WBTC, worth $6.50 before the price drop
      { symbol: 'rsETH', amount: exp(0.001, 18), droppedPrice: exp(1700, 8) }, // 0.001 rsETH, worth $3.40 before the price drop
      { symbol: 'cbETH', amount: exp(0.001, 18), droppedPrice: exp(1650, 8) }, // 0.001 cbETH, worth $3.30 before the price drop
      { symbol: 'CRV', amount: exp(3, 18), droppedPrice: exp(0.5, 8) }, // 3 CRV, worth $3.00 before the price drop
      { symbol: 'GMX', amount: exp(6, 18), droppedPrice: exp(20, 8) }, // 6 GMX, worth $240 before the price drop
    ];
    let collateralsState: Record<string, CollateralState>;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let reservedBefore: number;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    let innerSnapshot: SnapshotRestorer;
    // BCF-weighted value of the collateral still backing the debt when GMX is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop all five assets by 50%.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      // WBTC, rsETH, cbETH and CRV are fully seized before the loop reaches GMX, so when GMX is
      // partially seized the only collateral still backing the debt is GMX: $120 × 0.50 = $60.
      const gmxInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[4].symbol].address);
      const gmxCollateralValue = mulPrice(collateralConfigs[4].amount, collateralConfigs[4].droppedPrice, gmxInfo.scale);
      totalCollateralizedValue = mulFactor(gmxCollateralValue, gmxInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));

      innerSnapshot = await takeSnapshot();
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    // This context focuses on contract storage state after absorb.
    context('storage: full seizure of asset indexes 3, 6, 7, 17 and partial seizure of asset 21', function () {
      let absorbTx: ContractTransaction;

      it('absorb is successful', async () => {
        absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
        await expect(absorbTx).to.be.not.be.reverted;
      });

      it('alice is no longer liquidatable', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.false;
      });

      it('new health factor is greater than targetHF', async () => {
        // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
        // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
        const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
        let liquidityValue = 0n;
        for (const config of collateralConfigs) {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
          const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
          const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
          liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
        }
        const newHF = liquidityValue * factorScale / debtValue;
        expect(newHF).to.be.greaterThan(targetHealthFactor);
      });

      it('calculates full seizure values for asset indexes 3, 6, 7, 17 and GMX partial seizure values', async () => {
        // WBTC, rsETH, cbETH and CRV are each worth only a few dollars after the 50% price drop — far
        // below the debt — so every one is fully seized directly without solving the target HF formula.
        for (let i = 0; i < collateralConfigs.length - 1; i++) {
          const config = collateralConfigs[i];
          const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
          const collateralValue = mulPrice(config.amount, config.droppedPrice, assetInfo.scale);

          collateralsState[config.symbol].seizeAmount = config.amount;
          collateralsState[config.symbol].seizedValue = mulFactor(collateralValue, assetInfo.liquidationFactor);
        }

        const gmxInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[4].symbol].address);

        // After CRV full seizure, debt reduces to about $72.79.
        const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralConfigs.slice(0, 3 + 1).reduce((sum, { symbol }) => sum + collateralsState[symbol].seizedValue, 0n);

        // Solve the same target HF formula for GMX.
        // It wants about $45.52 of GMX value, so GMX is partially seized.
        const wantedGmxCollateralValue = getWantedCollateralValue(gmxInfo, debtRemainingValue, totalCollateralizedValue);

        collateralsState[collateralConfigs[4].symbol].seizeAmount = divPrice(wantedGmxCollateralValue, collateralConfigs[4].droppedPrice, gmxInfo.scale);
        collateralsState[collateralConfigs[4].symbol].seizedValue = mulFactor(wantedGmxCollateralValue, gmxInfo.liquidationFactor);
      });

      // Events
      it('AbsorbDebt event is emitted', async () => {
        const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
        const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

        await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
      });

      // User base balances
      it('alice borrow balance matches remaining debt', async () => {
        // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
        // the initial debt value minus the total seized value, converted back to base units.
        const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
        const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
        expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
      });

      it('alice has less debt than before', async () => {
        // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
        // than her debt before the absorb — she owes less than before.
        expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
      });

      it('alice simple base balance is zero', async () => {
        expect(await comet.balanceOf(alice.address)).to.be.equal(0);
      });

      // User collateral state
      // WBTC, rsETH, cbETH and CRV are fully seized; GMX (index 4) is partially seized (checked below).
      for (const config of collateralConfigs.slice(0, 4)) {
        it(`alice ${config.symbol} collateral balance is zero`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
        });
      }

      it('alice GMX collateral balance is reduced by the seized amount', async () => {
        expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[4].symbol].address)).to.be.equal(collateralConfigs[4].amount - collateralsState[collateralConfigs[4].symbol].seizeAmount);
        expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[4].symbol].address)).balance).to.be.equal(collateralConfigs[4].amount - collateralsState[collateralConfigs[4].symbol].seizeAmount);
      });

      it('alice assetsIn is zero after WBTC, rsETH, and cbETH are fully seized', async () => {
        expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
      });

      it('alice reserved keeps only GMX after CRV is fully seized', async () => {
        const gmxInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[4].symbol].address);

        expect((await comet.userBasic(alice.address))._reserved).to.not.be.equal(reservedBefore);
        expect((await comet.userBasic(alice.address))._reserved).to.be.equal(1 << (gmxInfo.offset - 16));
      });

      // Comet borrow state
      it('comet total borrow base is reduced by the base paid out', async () => {
        const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

        const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

        expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
      });

      it('comet total supply base is unchanged', async () => {
        expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
      });

      // Comet collateral balances
      for (const config of collateralConfigs) {
        it(`comet total supplied ${config.symbol} is reduced by the seized amount`, async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;

          expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
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

      it('comet base reserves are reduced by the base paid out', async () => {
        const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

        expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
      });

      for (const config of collateralConfigs) {
        it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
          expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
        });
      }
    });

    // This context focuses only on AbsorbCollateral event validation.
    context('emit AbsorbCollateral events for each collateral', function () {
      let absorbTx: ContractTransaction;

      before(async () => {
        await innerSnapshot.restore();
      });

      after(async () => await innerSnapshot.restore());

      it('sanity check: user is liquidatable', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.true;
      });

      it('sanity check: currentHF is below targetHF', async () => {
        const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
        let liquidityValue = 0n;

        for (const config of collateralConfigs) {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
          const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
          const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
          liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
        }

        const currentHF = liquidityValue * factorScale / debtValue;

        expect(currentHF).to.be.lessThan(targetHealthFactor);
      });

      it('absorb is successful', async () => {
        absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
        await expect(absorbTx).to.not.be.reverted;
      });

      it('alice is no longer liquidatable', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.false;
      });

      it('new health factor is greater than targetHF', async () => {
        // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
        // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
        const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
        let liquidityValue = 0n;
        for (const config of collateralConfigs) {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
          const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
          const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
          liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
        }
        const newHF = liquidityValue * factorScale / debtValue;
        expect(newHF).to.be.greaterThan(targetHealthFactor);
      });

      // The first four collaterals are fully seized; each emits AbsorbCollateral for its whole balance
      // and records its seizedValue so GMX's partial seizure (below) can compute the remaining debt.
      for (const config of collateralConfigs.slice(0, 4)) {
        it(`emits AbsorbCollateral for ${config.symbol} full seizure`, async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
          const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
          const collateralValue = mulPrice(config.amount, price, assetInfo.scale);

          await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[config.symbol].address, config.amount, collateralValue
          );
          collateralsState[config.symbol].seizedValue = mulFactor(collateralValue, assetInfo.liquidationFactor);
        });
      }

      it('emits AbsorbCollateral for GMX partial seizure', async () => {
        const gmxInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[4].symbol].address);
        const gmxPrice = (await priceFeeds[collateralConfigs[4].symbol].latestRoundData())[1].toBigInt();

        // At GMX's turn, totalCollateralizedValue holds only GMX's BCF contribution.
        // S = (targetHF * debt - totalCollateralValue) / (targetHF * LF - BCF)
        const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralConfigs.slice(0, 4).reduce((sum, { symbol }) => sum + collateralsState[symbol].seizedValue, 0n);
        const wantedGmxCollateralValue = getWantedCollateralValue(gmxInfo, debtRemainingValue, totalCollateralizedValue);
        const gmxSeizeAmount = divPrice(wantedGmxCollateralValue, gmxPrice, gmxInfo.scale);

        await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
          absorber.address, alice.address, tokens[collateralConfigs[4].symbol].address, gmxSeizeAmount, wantedGmxCollateralValue
        );
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                          TARGET HF REACHED
  //////////////////////////////////////////////////////////////*/

  context('2 collaterals: partial COMP seizure restores targetHF, WETH untouched (assets index 0 and 1)', function () {
    const borrowAmount = exp(80, 6);
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18), droppedPrice: exp(90, 8) }, // $100 before -> $90 after price drop
      { symbol: 'WETH', amount: exp(0.001, 18), droppedPrice: exp(2000, 8) }, // $2
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;

    let assetsInBefore: number;
    let reservedBefore: number;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of all collateral still backing the debt when COMP is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop COMP 10%: $100 → $90. Position becomes liquidatable:
      // LCF_weighted = 0.85×$90 + 0.80×$2 = $78.1 < debt $80
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));

      // When COMP is partially seized the loop has not touched WETH, so the BCF-weighted total still
      // includes both COMP and the untouched WETH: 0.80 × $90 + 0.75 × $2 = $73.5.
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const compValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, compInfo.scale);
      const wethValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, wethInfo.scale);
      totalCollateralizedValue =
        mulFactor(compValue, compInfo.borrowCollateralFactor) +
        mulFactor(wethValue, wethInfo.borrowCollateralFactor);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates expected partial seizure amounts for COMP', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      // debtRemainingValue = $80 in Chainlink 8-decimal price units = 8000000000
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);

      // S = (1.05 × $80 − $73.5) × 1e18 / (1.05 × 0.9 − 0.8) × 1e18 ≈ $72.41 = 7241379310
      const compWantedCollateralValue = getWantedCollateralValue(compInfo, debtRemainingValue, totalCollateralizedValue);

      // collateralsState[collateralKey].seizeAmount = floor($72.41 × 1e18 / $90) ≈ 804597701111111111 (≈0.8046 COMP)
      collateralsState[collateralConfigs[0].symbol].seizeAmount = divPrice(compWantedCollateralValue, collateralConfigs[0].droppedPrice, compInfo.scale);

      // collateralsState[collateralKey].seizedValue = $72.41 × 0.9 = $65.17 = 6517241379
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compWantedCollateralValue, compInfo.liquidationFactor);
    });

    it('wantedCollateralValue is less than COMP collateral value: partial seizure confirmed', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const compValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, compInfo.scale);
      const compWantedCollateralValue = getWantedCollateralValue(compInfo, debtRemainingValue, totalCollateralizedValue);

      expect(compWantedCollateralValue).to.be.lessThan(compValue);
    });

    it('after COMP partial seizure, targetHF condition is met: loop breaks before touching WETH', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const compWantedCollateralValue = getWantedCollateralValue(compInfo, debtRemainingValue, totalCollateralizedValue);
      const debtAfterComp = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const totalCVAfterComp = totalCollateralizedValue - mulFactor(compWantedCollateralValue, compInfo.borrowCollateralFactor);

      expect(mulFactor(debtAfterComp, targetHealthFactor)).to.be.equal(totalCVAfterComp);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    // User collateral state
    it('alice COMP balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralConfigs[0].amount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(
        collateralConfigs[0].amount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('alice WETH balance is unchanged: WETH was not seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount);
    });

    it('alice assetsIn still includes both COMP and WETH after partial seizure', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount));
    });

    it('comet total supplied WETH is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore
      );
    });

    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet COMP collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH collateral reserves remain zero', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });
  });

  context('2 collaterals: partial AAVE seizure restores targetHF, LDO untouched (assets index 15 and 16)', function () {
    const borrowAmount = exp(66, 6);
    const collateralConfigs = [
      { symbol: 'AAVE', amount: exp(1, 18), droppedPrice: exp(80, 8) }, // $100 before the price drop
      { symbol: 'LDO', amount: exp(10, 18), droppedPrice: exp(2, 8) }, // $20
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;

    let assetsInBefore: number;
    let reservedBefore: number;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of all collateral still backing the debt when AAVE is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop AAVE 20%: $100 -> $80. Position becomes liquidatable:
      // LCF_weighted = 0.65*$80 + 0.62*$20 = $64.40 < debt $66.
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));

      // When AAVE is partially seized the loop has not touched LDO, so the BCF-weighted total still
      // includes both AAVE and the untouched LDO: 0.60 × $80 + 0.55 × $20 = $59.
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const aaveValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);
      const ldoValue = mulPrice(collateralConfigs[1].amount, ldoPrice, ldoInfo.scale);
      totalCollateralizedValue =
        mulFactor(aaveValue, aaveInfo.borrowCollateralFactor) +
        mulFactor(ldoValue, ldoInfo.borrowCollateralFactor);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates expected partial seizure amounts for AAVE', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);

      // S = (1.05 * $66 - $59) * 1e18 / (1.05 * 0.85 - 0.60) ~= $35.21.
      const aaveWantedCollateralValue = getWantedCollateralValue(aaveInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = divPrice(aaveWantedCollateralValue, aavePrice, aaveInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(aaveWantedCollateralValue, aaveInfo.liquidationFactor);
    });

    it('wantedCollateralValue is less than AAVE collateral value: partial seizure confirmed', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const aaveValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);
      const aaveWantedCollateralValue = getWantedCollateralValue(aaveInfo, debtRemainingValue, totalCollateralizedValue);

      expect(aaveWantedCollateralValue).to.be.lessThan(aaveValue);
    });

    it('after AAVE partial seizure, targetHF condition is met: loop breaks before touching LDO', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const aaveWantedCollateralValue = getWantedCollateralValue(aaveInfo, debtRemainingValue, totalCollateralizedValue);
      const debtAfterAave = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const totalCVAfterAave = totalCollateralizedValue - mulFactor(aaveWantedCollateralValue, aaveInfo.borrowCollateralFactor);

      expect(mulFactor(debtAfterAave, targetHealthFactor)).to.be.equal(totalCVAfterAave);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice AAVE balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralConfigs[0].amount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(
        collateralConfigs[0].amount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('alice LDO balance is unchanged: LDO was not seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount);
    });

    it('alice assetsIn still includes AAVE after partial seizure', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved still includes LDO after partial seizure', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    it('comet total supplied AAVE is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount));
    });

    it('comet total supplied LDO is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore
      );
    });

    it('comet AAVE collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet LDO collateral reserves remain zero', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });
  });

  context('2 non-adjacent collaterals: partial rETH seizure restores targetHF, LDO untouched (assets index 8 and 16)', function () {
    const borrowAmount = exp(70, 6);
    const collateralConfigs = [
      { symbol: 'rETH', amount: exp(0.025, 18), droppedPrice: exp(2800, 8) }, // $87.50 before the price drop
      { symbol: 'LDO', amount: exp(10, 18), droppedPrice: exp(2, 8) }, // $20
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;

    let assetsInBefore: number;
    let reservedBefore: number;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of all collateral still backing the debt when rETH is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop rETH 20%: $87.50 -> $70. Position becomes liquidatable:
      // LCF_weighted = 0.78*$70 + 0.62*$20 = $67 < debt $70.
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));

      // When rETH is partially seized the loop has not touched LDO, so the BCF-weighted total still
      // includes both rETH and the untouched LDO: 0.72 * $70 + 0.55 * $20 = $61.40.
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const rEthPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const rEthValue = mulPrice(collateralConfigs[0].amount, rEthPrice, rEthInfo.scale);
      const ldoValue = mulPrice(collateralConfigs[1].amount, ldoPrice, ldoInfo.scale);
      totalCollateralizedValue =
        mulFactor(rEthValue, rEthInfo.borrowCollateralFactor) +
        mulFactor(ldoValue, ldoInfo.borrowCollateralFactor);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates expected partial seizure amounts for rETH', async () => {
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const rEthPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);

      // S = (1.05 * $70 - $61.40) * 1e18 / (1.05 * 0.92 - 0.72) ~= $49.19.
      const rEthWantedCollateralValue = getWantedCollateralValue(rEthInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = divPrice(rEthWantedCollateralValue, rEthPrice, rEthInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(rEthWantedCollateralValue, rEthInfo.liquidationFactor);
    });

    it('wantedCollateralValue is less than rETH collateral value: partial seizure confirmed', async () => {
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const rEthPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const rEthValue = mulPrice(collateralConfigs[0].amount, rEthPrice, rEthInfo.scale);
      const rEthWantedCollateralValue = getWantedCollateralValue(rEthInfo, debtRemainingValue, totalCollateralizedValue);

      expect(rEthWantedCollateralValue).to.be.lessThan(rEthValue);
    });

    it('after rETH partial seizure, targetHF condition is met when the loop reaches LDO', async () => {
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const debtAfterREth = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const rEthWantedCollateralValue = getWantedCollateralValue(rEthInfo, debtRemainingValue, totalCollateralizedValue);
      const totalCVAfterREth = totalCollateralizedValue - mulFactor(rEthWantedCollateralValue, rEthInfo.borrowCollateralFactor);

      expect(mulFactor(debtAfterREth, targetHealthFactor)).to.be.lessThan(totalCVAfterREth);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice rETH balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralConfigs[0].amount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(
        collateralConfigs[0].amount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('alice LDO balance is unchanged: LDO was not seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount);
    });

    it('alice assetsIn still includes rETH after partial seizure', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved still includes LDO after partial seizure', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    it('comet total supplied rETH is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount));
    });

    it('comet total supplied LDO is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore
      );
    });

    it('comet rETH collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet LDO collateral reserves remain zero', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });
  });

  context('3 collaterals: rETH fully seized, AAVE partially seized, LDO untouched (assets index 8, 15 and 16)', function () {
    const borrowAmount = exp(90, 6);
    const rEthDroppedPrice = exp(3000, 8);
    const aaveDroppedPrice = exp(80, 8);
    const collateralConfigs = [
      { symbol: 'rETH', amount: exp(0.01, 18), droppedPrice: rEthDroppedPrice }, // $30 after the price change
      { symbol: 'AAVE', amount: exp(1, 18), droppedPrice: aaveDroppedPrice }, // $80 after the price change
      { symbol: 'LDO', amount: exp(10, 18), droppedPrice: exp(2, 8) }, // $20
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;

    let totalsBasicBefore: TotalsBasicStructOutput;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldPrincipal: bigint;
    let balanceBefore: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    // BCF-weighted value of the collateral still backing the debt when AAVE is partially seized
    // (AAVE plus the untouched LDO; rETH is already fully seized).
    let totalCollateralizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // rETH becomes worth $30 and AAVE becomes worth $80.
      // LCF_weighted = 0.78*$30 + 0.65*$80 + 0.62*$20 = $87.80 < debt $90.
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, rEthDroppedPrice, 0, 0, 0);
      await priceFeeds[collateralConfigs[1].symbol].connect(alice).setRoundData(0, aaveDroppedPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      // rETH is fully seized before the loop reaches AAVE, so when AAVE is partially seized the
      // BCF-weighted total still backing the debt is AAVE plus the untouched LDO ($59).
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[2].symbol].address);
      const ldoPrice = (await priceFeeds[collateralConfigs[2].symbol].latestRoundData())[1].toBigInt();
      const aaveValue = mulPrice(collateralConfigs[1].amount, aaveDroppedPrice, aaveInfo.scale);
      const ldoValue = mulPrice(collateralConfigs[2].amount, ldoPrice, ldoInfo.scale);
      totalCollateralizedValue =
        mulFactor(aaveValue, aaveInfo.borrowCollateralFactor) +
        mulFactor(ldoValue, ldoInfo.borrowCollateralFactor);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldPrincipal = userBasic.principal.toBigInt();
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates rETH full seizure and AAVE partial seizure values', async () => {
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      // rETH is first in asset order. After the price drop it is worth $30 — below what the debt
      // needs, so the whole rETH balance is seized.
      const rEthValue = mulPrice(collateralConfigs[0].amount, rEthDroppedPrice, rEthInfo.scale);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(rEthValue, rEthInfo.liquidationFactor);

      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      // After rETH full seizure, debt is $90 - $27.60 = $62.40.
      // AAVE and LDO still provide $59 of BCF-weighted collateral.
      const debtAfterREth = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const aaveWantedCollateralValue = getWantedCollateralValue(aaveInfo, debtAfterREth, totalCollateralizedValue);

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(aaveWantedCollateralValue, aaveDroppedPrice, aaveInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(aaveWantedCollateralValue, aaveInfo.liquidationFactor);
    });

    it('after AAVE partial seizure, targetHF condition is met before touching LDO', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const debtAfterREth = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const aaveWantedCollateralValue = getWantedCollateralValue(aaveInfo, debtAfterREth, totalCollateralizedValue);
      const debtAfterAave = debtAfterREth - collateralsState[collateralConfigs[1].symbol].seizedValue;
      const totalCVAfterAave = totalCollateralizedValue - mulFactor(aaveWantedCollateralValue, aaveInfo.borrowCollateralFactor);

      expect(mulFactor(debtAfterAave, targetHealthFactor)).to.be.equal(totalCVAfterAave);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice rETH balance is zero after full seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
    });

    it('alice AAVE balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(
        collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('alice LDO balance is unchanged: LDO was not seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[2].symbol].address)).to.be.equal(collateralConfigs[2].amount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[2].symbol].address)).balance).to.be.equal(collateralConfigs[2].amount);
    });

    it('alice assetsIn keeps only AAVE after rETH full seizure', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      expect(assetsInBefore).to.not.be.equal(1 << aaveInfo.offset);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(1 << aaveInfo.offset);
    });

    it('alice reserved still includes LDO', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      const newPrincipal = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(newPrincipal - oldPrincipal));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    // rETH (fully seized) and AAVE (partially seized) are both reduced; LDO is untouched (checked below).
    for (const config of collateralConfigs.slice(0, 2)) {
      it(`comet total supplied ${config.symbol} is reduced by the seized amount`, async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
      });
    }

    it('comet total supplied LDO is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[2].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[2].symbol].totalsCollateralBefore
      );
    });

    // rETH (fully seized) and AAVE (partially seized) reserves both increase; LDO is untouched (checked below).
    for (const config of collateralConfigs.slice(0, 2)) {
      it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
        expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(
          collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount)
        );
      });
    }

    it('comet LDO collateral reserves remain zero', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[2].symbol].address)).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });

    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });
  });

  /*//////////////////////////////////////////////////////////////
                            24 COLLATERALS
  //////////////////////////////////////////////////////////////*/

  context('24 collaterals: assets 0-4 fully seized, asset 5 partially seized, assets 6-23 untouched', function () {
    const collateralConfigs = [
      { symbol: 'COMP',   amount: divPrice(exp(5, 8),    exp(50, 8),    10n ** 18n), initialPrice: exp(100, 8),   droppedPrice: exp(50, 8),    targetDroppedValue: exp(5, 8) },
      { symbol: 'WETH',   amount: divPrice(exp(5, 8),    exp(1000, 8),  10n ** 18n), initialPrice: exp(2000, 8),  droppedPrice: exp(1000, 8),  targetDroppedValue: exp(5, 8) },
      { symbol: 'USDT',   amount: divPrice(exp(5, 8),    exp(0.5, 8),   10n ** 6n),  initialPrice: exp(1, 8),     droppedPrice: exp(0.5, 8),   targetDroppedValue: exp(5, 8) },
      { symbol: 'WBTC',   amount: divPrice(exp(5, 8),    exp(32500, 8), 10n ** 8n),  initialPrice: exp(65000, 8), droppedPrice: exp(32500, 8), targetDroppedValue: exp(5, 8) },
      { symbol: 'DAI',    amount: divPrice(exp(5, 8),    exp(0.5, 8),   10n ** 18n), initialPrice: exp(1, 8),     droppedPrice: exp(0.5, 8),   targetDroppedValue: exp(5, 8) },
      { symbol: 'wstETH', amount: divPrice(exp(100, 8),  exp(1800, 8),  10n ** 18n), initialPrice: exp(3600, 8),  droppedPrice: exp(1800, 8),  targetDroppedValue: exp(100, 8) },
      { symbol: 'rsETH',  amount: divPrice(exp(0.01, 8), exp(1700, 8),  10n ** 18n), initialPrice: exp(3400, 8),  droppedPrice: exp(1700, 8),  targetDroppedValue: exp(0.01, 8) },
      { symbol: 'cbETH',  amount: divPrice(exp(0.01, 8), exp(1650, 8),  10n ** 18n), initialPrice: exp(3300, 8),  droppedPrice: exp(1650, 8),  targetDroppedValue: exp(0.01, 8) },
      { symbol: 'rETH',   amount: divPrice(exp(0.01, 8), exp(1750, 8),  10n ** 18n), initialPrice: exp(3500, 8),  droppedPrice: exp(1750, 8),  targetDroppedValue: exp(0.01, 8) },
      { symbol: 'weETH',  amount: divPrice(exp(0.01, 8), exp(1700, 8),  10n ** 18n), initialPrice: exp(3400, 8),  droppedPrice: exp(1700, 8),  targetDroppedValue: exp(0.01, 8) },
      { symbol: 'ezETH',  amount: divPrice(exp(0.01, 8), exp(1675, 8),  10n ** 18n), initialPrice: exp(3350, 8),  droppedPrice: exp(1675, 8),  targetDroppedValue: exp(0.01, 8) },
      { symbol: 'cbBTC',  amount: divPrice(exp(0.01, 8), exp(32500, 8), 10n ** 8n),  initialPrice: exp(65000, 8), droppedPrice: exp(32500, 8), targetDroppedValue: exp(0.01, 8) },
      { symbol: 'tBTC',   amount: divPrice(exp(0.01, 8), exp(32500, 8), 10n ** 18n), initialPrice: exp(65000, 8), droppedPrice: exp(32500, 8), targetDroppedValue: exp(0.01, 8) },
      { symbol: 'LINK',   amount: divPrice(exp(0.01, 8), exp(7.5, 8),   10n ** 18n), initialPrice: exp(15, 8),    droppedPrice: exp(7.5, 8),   targetDroppedValue: exp(0.01, 8) },
      { symbol: 'UNI',    amount: divPrice(exp(0.01, 8), exp(4, 8),     10n ** 18n), initialPrice: exp(8, 8),     droppedPrice: exp(4, 8),     targetDroppedValue: exp(0.01, 8) },
      { symbol: 'AAVE',   amount: divPrice(exp(0.01, 8), exp(50, 8),    10n ** 18n), initialPrice: exp(100, 8),   droppedPrice: exp(50, 8),    targetDroppedValue: exp(0.01, 8) },
      { symbol: 'LDO',    amount: divPrice(exp(0.01, 8), exp(1, 8),     10n ** 18n), initialPrice: exp(2, 8),     droppedPrice: exp(1, 8),     targetDroppedValue: exp(0.01, 8) },
      { symbol: 'CRV',    amount: divPrice(exp(0.01, 8), exp(0.5, 8),   10n ** 18n), initialPrice: exp(1, 8),     droppedPrice: exp(0.5, 8),   targetDroppedValue: exp(0.01, 8) },
      { symbol: 'MKR',    amount: divPrice(exp(0.01, 8), exp(1250, 8),  10n ** 18n), initialPrice: exp(2500, 8),  droppedPrice: exp(1250, 8),  targetDroppedValue: exp(0.01, 8) },
      { symbol: 'ARB',    amount: divPrice(exp(0.01, 8), exp(0.5, 8),   10n ** 18n), initialPrice: exp(1, 8),     droppedPrice: exp(0.5, 8),   targetDroppedValue: exp(0.01, 8) },
      { symbol: 'OP',     amount: divPrice(exp(0.01, 8), exp(1, 8),     10n ** 18n), initialPrice: exp(2, 8),     droppedPrice: exp(1, 8),     targetDroppedValue: exp(0.01, 8) },
      { symbol: 'GMX',    amount: divPrice(exp(0.01, 8), exp(20, 8),    10n ** 18n), initialPrice: exp(40, 8),    droppedPrice: exp(20, 8),    targetDroppedValue: exp(0.01, 8) },
      { symbol: 'USDe',   amount: divPrice(exp(0.01, 8), exp(0.5, 8),   10n ** 18n), initialPrice: exp(1, 8),     droppedPrice: exp(0.5, 8),   targetDroppedValue: exp(0.01, 8) },
      { symbol: 'sUSDe',  amount: divPrice(exp(0.01, 8), exp(0.5, 8),   10n ** 18n), initialPrice: exp(1, 8),     droppedPrice: exp(0.5, 8),   targetDroppedValue: exp(0.01, 8) },
    ];
    const borrowAmount = exp(103, 6);
    const firstFullSeizureCount = 5;
    const partialSeizureIndex = 5;

    let collateralsState: Record<string, CollateralState> = {};
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldPrincipal: bigint;
    let balanceBefore: bigint;
    // BCF-weighted value of the collateral still backing the debt when asset 5 is partially seized
    // (asset 5 plus the untouched assets 6–23; assets 0–4 are already fully seized).
    let totalCollateralizedValue: bigint;

    before(async function() {
      // Bob adds deep base liquidity so utilization stays near zero and the borrow rate stays at its
      // base value. This keeps interest accrual on par with an empty market, so the exact
      // partial-liquidation math (newBalance / principal) below is not perturbed by the seeded borrower.
      const extraBaseLiquidity = exp(100_000, 6);
      await baseToken.allocateTo(bob.address, extraBaseLiquidity);
      await baseToken.connect(bob).approve(comet.address, extraBaseLiquidity);
      await comet.connect(bob).supply(baseToken.address, extraBaseLiquidity);

      for (const config of collateralConfigs) {
        const asset = tokens[config.symbol];

        await comet.connect(alice).supply(asset.address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // The borrow is opened while prices are healthy, then every collateral is repriced
      // to the target liquidation value used by the seizure math below.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      totalsBasicBefore = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldPrincipal = userBasic.principal.toBigInt();
      balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));

      // Sum the BCF-weighted value of asset 5 and every untouched asset after it (6–23). The fully
      // seized assets 0–4 are excluded, mirroring how the contract subtracts them before reaching asset 5.
      totalCollateralizedValue = 0n;
      for (let i = firstFullSeizureCount; i < collateralConfigs.length; i++) {
        const config = collateralConfigs[i];
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const collateralValue = mulPrice(config.amount, config.droppedPrice, assetInfo.scale);
        totalCollateralizedValue += mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
      }
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates full seizure values for asset indexes 0 through 4 and partial seizure values for asset index 5', async () => {
      // The first five supplied collateral values are small and cannot cover the debt, so each is
      // fully seized directly without solving the target HF formula.
      for (let i = 0; i < firstFullSeizureCount; i++) {
        const config = collateralConfigs[i];
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const collateralValue = mulPrice(config.amount, config.droppedPrice, assetInfo.scale);

        collateralsState[config.symbol].seizeAmount = config.amount;
        collateralsState[config.symbol].seizedValue = mulFactor(collateralValue, assetInfo.liquidationFactor);
      }

      const config = collateralConfigs[partialSeizureIndex];
      const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale)
        - collateralConfigs
          .slice(0, firstFullSeizureCount)
          .reduce((sum, { symbol }) => sum + collateralsState[symbol].seizedValue, 0n);

      // After the first five assets are fully seized, wstETH has enough value to restore targetHF partially.
      const wantedCollateralValue = getWantedCollateralValue(assetInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState[config.symbol].seizeAmount = divPrice(
        wantedCollateralValue,
        config.droppedPrice,
        assetInfo.scale
      );
      collateralsState[config.symbol].seizedValue = mulFactor(wantedCollateralValue, assetInfo.liquidationFactor);
    });

    it('after asset index 5 partial seizure, targetHF condition is met before touching asset indexes 6 through 23', async () => {
      const config = collateralConfigs[partialSeizureIndex];
      const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale)
        - collateralConfigs
          .slice(0, firstFullSeizureCount)
          .reduce((sum, { symbol }) => sum + collateralsState[symbol].seizedValue, 0n);

      const wantedCollateralValue = getWantedCollateralValue(assetInfo, debtRemainingValue, totalCollateralizedValue);
      const debtAfterPartialSeizure = debtRemainingValue - collateralsState[config.symbol].seizedValue;
      const totalCVAfterPartialSeizure = totalCollateralizedValue - mulFactor(wantedCollateralValue, assetInfo.borrowCollateralFactor);

      // The partial seizure solves for the amount that restores targetHF, so the position lands at or
      // above target: debt * HF <= totalCV (equality is the exact boundary the seizure math targets).
      expect(mulFactor(debtAfterPartialSeizure, targetHealthFactor)).to.be.lessThanOrEqual(totalCVAfterPartialSeizure);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice assetsIn removes fully seized indexes and keeps remaining indexes 5 through 15', async () => {
      const expectedAssetsIn = ((1 << 16) - 1) - ((1 << firstFullSeizureCount) - 1);

      expect(assetsInBefore).to.be.equal((1 << 16) - 1);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(expectedAssetsIn);
    });

    it('alice reserved still includes asset indexes 16 through 23', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('alice balances for asset indexes 0 through 4 are zero after full seizure', async () => {
      for (let i = 0; i < firstFullSeizureCount; i++) {
        const config = collateralConfigs[i];
        expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.be.equal(0);
        expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
      }
    });

    it('alice balances for asset indexes 6 through 23 are unchanged', async () => {
      for (let i = partialSeizureIndex + 1; i < collateralConfigs.length; i++) {
        const config = collateralConfigs[i];
        expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.be.equal(config.amount);
        expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(config.amount);
      }
    });

    it('alice balance for asset index 5 is reduced by the seized amount', async () => {
      const config = collateralConfigs[partialSeizureIndex];
      expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.be.equal(
        config.amount - collateralsState[config.symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(
        config.amount - collateralsState[config.symbol].seizeAmount
      );
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      const newPrincipal = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(newPrincipal - oldPrincipal));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    it('comet total supplied collateral for asset indexes 0 through 4 is reduced by the fully seized amounts', async () => {
      for (let i = 0; i < firstFullSeizureCount; i++) {
        const config = collateralConfigs[i];
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
      }
    });

    it('comet total supplied collateral for asset index 5 is reduced by the seized amount', async () => {
      const config = collateralConfigs[partialSeizureIndex];
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(
        collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount)
      );
    });

    it('comet total supplied collateral for asset indexes 6 through 23 is unchanged', async () => {
      for (let i = partialSeizureIndex + 1; i < collateralConfigs.length; i++) {
        const config = collateralConfigs[i];
        expect((await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore);
      }
    });

    it('comet ERC20 collateral token balances do not change during absorb', async () => {
      for (const config of collateralConfigs) {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      }
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet collateral reserves increase for asset indexes 0 through 5', async () => {
      for (let i = 0; i <= partialSeizureIndex; i++) {
        const config = collateralConfigs[i];
        expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(
          collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount)
        );
      }
    });

    it('comet collateral reserves remain zero for asset indexes 6 through 23', async () => {
      for (let i = partialSeizureIndex + 1; i < collateralConfigs.length; i++) {
        expect(await comet.getCollateralReserves(tokens[collateralConfigs[i].symbol].address)).to.be.equal(0);
      }
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });
  });

  context('24 collaterals: assets 0-22 fully seized, sUSDe (asset 23) partially seized, user remains borrower', function () {
    const targetCollateralUsdPerAsset = exp(12, 8); // ~$12 per asset - keeps absorb from hitting target HF early
    const assetSymbols23 = Object.keys(default24Assets()).filter((s) => s !== 'USDC' && s !== 'sUSDe');
    const sUsDeAmount = exp(380, 18);
    const borrowAmount = exp(457.5, 6);
    const droppedSUsDePrice = exp(0.8, 8);

    let collateralsState: Record<string, CollateralState>;
    let collateralConfigs: { symbol: string, amount: bigint }[] = [];
    const assetSupplyAmounts: { [symbol: string]: bigint } = {};
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let baseReservesBefore: bigint;
    let totalsBasicBefore: TotalsBasicStructOutput;
    let balanceBefore: bigint;
    let borrowPrincipalBefore: BigNumber;
    // BCF-weighted value of the only collateral still backing the debt when sUSDe is partially seized.
    let totalCollateralizedValue: bigint;

    before(async function () {
      // Bob adds deep base liquidity so utilization stays near zero and the borrow rate stays at its
      // base value. This keeps interest accrual on par with an empty market, so the exact
      // partial-liquidation math (newBalance / principal) below is not perturbed by the seeded borrower.
      const extraBaseLiquidity = exp(100_000, 6);
      await baseToken.allocateTo(bob.address, extraBaseLiquidity);
      await baseToken.connect(bob).approve(comet.address, extraBaseLiquidity);
      await comet.connect(bob).supply(baseToken.address, extraBaseLiquidity);

      collateralConfigs = [];
      for (const sym of assetSymbols23) {
        const info = await comet.getAssetInfoByAddress(tokens[sym].address);
        const price = (await priceFeeds[sym].latestRoundData())[1];
        assetSupplyAmounts[sym] = divPrice(targetCollateralUsdPerAsset, price, info.scale);
        collateralConfigs.push({ symbol: sym, amount: assetSupplyAmounts[sym] });
        await comet.connect(alice).supply(tokens[sym].address, assetSupplyAmounts[sym]);
      }
      collateralConfigs.push({ symbol: 'sUSDe', amount: sUsDeAmount });
      await comet.connect(alice).supply(tokens['sUSDe'].address, sUsDeAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['sUSDe'].connect(alice).setRoundData(0, droppedSUsDePrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      borrowPrincipalBefore = (await comet.userBasic(alice.address)).principal;
      totalsBasicBefore = await comet.totalsBasic();
      balanceBefore = presentValue(borrowPrincipalBefore, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));

      // The 23 lower-index assets are fully seized before the loop reaches sUSDe, so when sUSDe is
      // partially seized the only collateral still backing the debt is sUSDe.
      const sUsDeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const sUsDeValue = mulPrice(sUsDeAmount, droppedSUsDePrice, sUsDeInfo.scale);
      totalCollateralizedValue = mulFactor(sUsDeValue, sUsDeInfo.borrowCollateralFactor);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: currentHF is below targetHF', async () => {
      const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      let liquidityValue = 0n;

      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
        liquidityValue += mulFactor(collateralValue, assetInfo.liquidateCollateralFactor);
      }

      const currentHF = liquidityValue * factorScale / debtValue;

      expect(currentHF).to.be.lessThan(targetHealthFactor);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('new health factor is greater than targetHF', async () => {
      // The absorb restored the position to targetHF using BCF-weighted collateral; the LCF-weighted
      // health factor (LCF > BCF) is therefore strictly above targetHF afterwards.
      const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);
      let liquidityValue = 0n;
      for (const config of collateralConfigs) {
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
        const balance = await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address);
        liquidityValue += mulFactor(mulPrice(balance, price, assetInfo.scale), assetInfo.liquidateCollateralFactor);
      }
      const newHF = liquidityValue * factorScale / debtValue;
      expect(newHF).to.be.greaterThan(targetHealthFactor);
    });

    it('calculates sUSDe partial seizure values after 23 full seizures', async () => {
      const sUsDeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      let debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);

      for (const sym of assetSymbols23) {
        const info = await comet.getAssetInfoByAddress(tokens[sym].address);
        const price = (await priceFeeds[sym].latestRoundData())[1];
        const value = mulPrice(assetSupplyAmounts[sym], price, info.scale);
        collateralsState[sym].seizeAmount = assetSupplyAmounts[sym];
        collateralsState[sym].seizedValue = mulFactor(value, info.liquidationFactor);
        debtRemainingValue -= collateralsState[sym].seizedValue;
      }

      const sUsDeWantedCollateralValue = getWantedCollateralValue(sUsDeInfo, debtRemainingValue, totalCollateralizedValue);

      collateralsState['sUSDe'].seizeAmount = divPrice(sUsDeWantedCollateralValue, droppedSUsDePrice, sUsDeInfo.scale);
      collateralsState['sUSDe'].seizedValue = mulFactor(sUsDeWantedCollateralValue, sUsDeInfo.liquidationFactor);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance matches remaining debt', async () => {
      // Each seized collateral repaid its seizedValue of debt, so the remaining borrow balance equals
      // the initial debt value minus the total seized value, converted back to base units.
      const totalSeizedValue = Object.values(collateralsState).reduce((sum, { seizedValue }) => sum + seizedValue, 0n);
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - totalSeizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValue * baseScale / baseTokenPrice);
    });

    it('alice has less debt than before', async () => {
      // Partial liquidation repaid part of the debt, so alice's remaining borrow balance is smaller
      // than her debt before the absorb — she owes less than before.
      expect((await comet.borrowBalanceOf(alice.address)).toBigInt()).to.be.lessThan(-balanceBefore);
    });

    it('alice simple base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice assetsIn is zero after all lower-index assets are fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved keeps only sUSDe bit after assets 16–22 are fully seized', async () => {
      const sUsDeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(1 << (sUsDeInfo.offset - 16));
    });

    it('all 23 fully seized collateral balances are zero', async () => {
      for (const sym of assetSymbols23) {
        expect(await comet.collateralBalanceOf(alice.address, tokens[sym].address)).to.be.equal(0, `${sym} collateral balance should be zero`);
        expect((await comet.userCollateral(alice.address, tokens[sym].address)).balance).to.be.equal(0, `${sym} user collateral balance should be zero`);
      }
    });

    it('alice sUSDe collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address)).to.be.equal(sUsDeAmount - collateralsState['sUSDe'].seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens['sUSDe'].address)).balance).to.be.equal(sUsDeAmount - collateralsState['sUSDe'].seizeAmount);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the principal delta', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      const borrowPrincipalAfter = (await comet.userBasic(alice.address)).principal;
      expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(borrowPrincipalAfter.sub(borrowPrincipalBefore)));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
    });

    // Comet collateral balances
    it('comet totalsCollateral for all fully seized assets 0-22 are reduced by alice seized amount', async () => {
      for (const sym of assetSymbols23) {
        expect((await comet.totalsCollateral(tokens[sym].address)).totalSupplyAsset)
          .to.be.equal(collateralsState[sym].totalsCollateralBefore.sub(assetSupplyAmounts[sym]));
      }
    });

    it('comet total supplied sUSDe is reduced by the seized amount and still positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['sUSDe'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['sUSDe'].totalsCollateralBefore.sub(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet ERC20 collateral token balances do not change during absorb', async () => {
      for (const config of collateralConfigs) {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      }
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet collateral reserves for assets 0-22 increase by the fully seized amounts', async () => {
      for (const sym of assetSymbols23) {
        expect(await comet.getCollateralReserves(tokens[sym].address)).to.be.equal(assetSupplyAmounts[sym]);
      }
    });

    it('comet sUSDe collateral reserves increase by seized sUSDe', async () => {
      expect(await comet.getCollateralReserves(tokens['sUSDe'].address)).to.be.equal(collateralsState['sUSDe'].collateralReservesBefore.add(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;

      expect(await comet.getReserves()).to.be.approximately(baseReservesBefore - basePaidOut, 5);
    });
  });
});
