import { ethers, expect, exp, makeProtocol, presentValue, mulPrice, mulFactor, default24Assets, divPrice, CollateralState, makeCollateralStates } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

describe('partial liquidation: min debt', function() {
  let comet: CometHarnessInterfaceExtendedAssetList;

  const baseTokenPrice = exp(1, 8);
  const initialBaseFunding = baseTokenPrice * 10_000n;
  const baseBorrowMin = exp(10, 6);

  let tokens: { [symbol: string]: FaucetToken } = {};
  let baseToken: FaucetToken;
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  let alice: SignerWithAddress;
  let absorber: SignerWithAddress;

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

    await baseToken.allocateTo(comet.address, initialBaseFunding);
    targetHealthFactor = (await protocol.defaultLiquidationModule.targetHealthFactor()).toBigInt();
    snapshot = await takeSnapshot();
  });

  // Note: this test flow covers event AbsorbCollateral emission when
  // the collateral is partially seized when debt is below min debt.
  context('1 collateral: debt below min debt and collateral can partially cover it (0 index)', function () {
    const collateralAmount = exp(0.13, 18); // 0.13 COMP, worth $13 before the price drop
    const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
    const repayAmount = exp(0.7, 6); // leaves $9.50 debt, below baseBorrowMin
    const droppedCompPrice = exp(85.9, 8); // collateral value becomes $11.167

    const collateralKeys = ['COMP'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let collateralValue: bigint;
    let collateralValueLeft: bigint;
    let wantedCollateralValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
      await comet.connect(alice).supply(baseToken.address, repayAmount);

      await priceFeeds['COMP'].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: alice borrow balance is below baseBorrowMin after repay', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
      expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('min debt branch can close the debt by partially seizing COMP', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
      collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

      // debtRemainingValue = 9.5e8, minDebtValue = 10e8, so absorb enters
      // _processDebtClosing. collateralValueLeft = 11.167e8 * 0.90 = 10.0503e8,
      // so COMP can close the debt with a partial seizure.
      expect(debtRemainingValue).to.be.lessThan(minDebtValue);
      expect(debtRemainingValue).to.be.lessThan(collateralValueLeft);

      wantedCollateralValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState['COMP'].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, assetInfo.scale);
      collateralsState['COMP'].seizedValue = debtRemainingValue;
      wantedCollateralValue = mulPrice(collateralsState['COMP'].seizeAmount, droppedCompPrice, assetInfo.scale);
    });

    it('calculates newBalance as zero after debt is fully closed', async () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['COMP'].seizedValue;

      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens['COMP'].balanceOf(comet.address)).to.be.equal(collateralsState['COMP'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['COMP'].address)).to.be.equal(collateralAmount - collateralsState['COMP'].seizeAmount);
    });

    it('alice assetsIn does not change because collateral remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address)).to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('1 collateral: debt below min debt and collateral can partially cover it (16 index)', function () {
    const ldoAmount = exp(10, 18); // 10 LDO, worth $20 before the price drop
    const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
    const repayAmount = exp(0.7, 6); // leaves $9.50 debt, below baseBorrowMin
    const droppedLdoPrice = exp(1.5, 8); // collateral value becomes $15

    const collateralKeys = ['LDO'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let collateralValue: bigint;
    let collateralValueLeft: bigint;
    let wantedCollateralValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['LDO'].address, ldoAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
      await comet.connect(alice).supply(baseToken.address, repayAmount);

      await priceFeeds['LDO'].connect(alice).setRoundData(0, droppedLdoPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: alice borrow balance is below baseBorrowMin after repay', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
      expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('min debt branch can close the debt by partially seizing LDO', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
      collateralValue = mulPrice(ldoAmount, droppedLdoPrice, assetInfo.scale);
      collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

      // debtRemainingValue = 9.5e8, minDebtValue = 10e8, so absorb enters
      // _processDebtClosing. collateralValueLeft = 15e8 * 0.85 = 12.75e8,
      // so LDO can close the debt with a partial seizure.
      expect(debtRemainingValue).to.be.lessThan(minDebtValue);
      expect(debtRemainingValue).to.be.lessThan(collateralValueLeft);

      wantedCollateralValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState['LDO'].seizeAmount = divPrice(wantedCollateralValue, droppedLdoPrice, assetInfo.scale);
      collateralsState['LDO'].seizedValue = debtRemainingValue;
      wantedCollateralValue = mulPrice(collateralsState['LDO'].seizeAmount, droppedLdoPrice, assetInfo.scale);
    });

    it('calculates newBalance as zero after debt is fully closed', async () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['LDO'].seizedValue;

      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens['LDO'].balanceOf(comet.address)).to.be.equal(collateralsState['LDO'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['LDO'].address)).to.be.equal(ldoAmount - collateralsState['LDO'].seizeAmount);
    });

    it('alice assetsIn does not change because collateral remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['LDO'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['LDO'].totalsCollateralBefore.sub(collateralsState['LDO'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['LDO'].address)).to.be.equal(collateralsState['LDO'].collateralReservesBefore.add(collateralsState['LDO'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('1 collateral: debt below min debt and collateral can partially cover it (23 index)', function () {
    const sUsdeAmount = exp(15, 18); // 15 sUSDe, worth $15 before the price drop
    const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
    const repayAmount = exp(0.7, 6); // leaves $9.50 debt, below baseBorrowMin
    const droppedSUsdePrice = exp(0.75, 8); // collateral value becomes $11.25

    const collateralKeys = ['sUSDe'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let collateralValue: bigint;
    let collateralValueLeft: bigint;
    let wantedCollateralValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['sUSDe'].address, sUsdeAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
      await comet.connect(alice).supply(baseToken.address, repayAmount);

      await priceFeeds['sUSDe'].connect(alice).setRoundData(0, droppedSUsdePrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: alice borrow balance is below baseBorrowMin after repay', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
      expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('min debt branch can close the debt by partially seizing sUSDe', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
      collateralValue = mulPrice(sUsdeAmount, droppedSUsdePrice, assetInfo.scale);
      collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

      // debtRemainingValue = 9.5e8, minDebtValue = 10e8, so absorb enters
      // _processDebtClosing. collateralValueLeft = 11.25e8 * 0.92 = 10.35e8,
      // so sUSDe can close the debt with a partial seizure.
      expect(debtRemainingValue).to.be.lessThan(minDebtValue);
      expect(debtRemainingValue).to.be.lessThan(collateralValueLeft);

      wantedCollateralValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState['sUSDe'].seizeAmount = divPrice(wantedCollateralValue, droppedSUsdePrice, assetInfo.scale);
      collateralsState['sUSDe'].seizedValue = debtRemainingValue;
      wantedCollateralValue = mulPrice(collateralsState['sUSDe'].seizeAmount, droppedSUsdePrice, assetInfo.scale);
    });

    it('calculates newBalance as zero after debt is fully closed', async () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['sUSDe'].seizedValue;

      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens['sUSDe'].balanceOf(comet.address)).to.be.equal(collateralsState['sUSDe'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address)).to.be.equal(sUsdeAmount - collateralsState['sUSDe'].seizeAmount);
    });

    it('alice assetsIn does not change because collateral remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['sUSDe'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['sUSDe'].totalsCollateralBefore.sub(collateralsState['sUSDe'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['sUSDe'].address)).to.be.equal(collateralsState['sUSDe'].collateralReservesBefore.add(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  // Note: this flow proves that the baseBorrowMin branch can be reached after
  // an earlier collateral is fully seized in the same absorb cycle.
  context('multi-collateral: first collateral fully seized, second collateral closes debt below min debt (asset indexes 0 and 1)', function () {
    const compAmount = exp(0.1, 18); // 0.1 COMP, worth $10
    const wethAmount = exp(0.008, 18); // 0.008 WETH, worth $16 before the price drop
    const borrowAmount = exp(18.5, 6); // leaves $9.50 debt after COMP full seizure
    const droppedWethPrice = exp(1500, 8); // WETH value becomes $12

    const collateralKeys = ['COMP', 'WETH'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['COMP'].address, compAmount);
      await comet.connect(alice).supply(tokens['WETH'].address, wethAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['WETH'].connect(alice).setRoundData(0, droppedWethPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates COMP full seizure values', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      // COMP value = 0.1 * $100 = $10. WETH value after drop = 0.008 * $1500 = $12.
      const compCollateralValue = mulPrice(compAmount, compPrice, compInfo.scale);
      const wethCollateralValue = mulPrice(wethAmount, wethPrice, wethInfo.scale);
      const totalCollateralizedValue =
        mulFactor(compCollateralValue, compInfo.borrowCollateralFactor) +
        mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      // The target HF formula wants more than $10 from COMP, so COMP is fully seized.
      const wantedCompCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());
      expect(wantedCompCollateralValue).to.be.greaterThan(compCollateralValue);

      collateralsState['COMP'].seizeAmount = compAmount;
      collateralsState['COMP'].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);
    });

    it('calculates WETH partial seizure values through the min debt branch', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();

      // COMP full seizure covers $9, leaving $9.50 debt, below the $10 baseBorrowMin.
      debtRemainingValue -= collateralsState['COMP'].seizedValue;
      expect(debtRemainingValue).to.be.lessThan(minDebtValue);

      const wethCollateralValue = mulPrice(wethAmount, wethPrice, wethInfo.scale);
      const wethCollateralValueLeft = mulFactor(wethCollateralValue, wethInfo.liquidationFactor);

      // WETH LF-weighted value is $10.80, so _processDebtClosing can close the debt partially.
      expect(debtRemainingValue).to.be.lessThan(wethCollateralValueLeft);

      const wantedWethCollateralValue = debtRemainingValue * factorScale / wethInfo.liquidationFactor.toBigInt();
      collateralsState['WETH'].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState['WETH'].seizedValue = debtRemainingValue;
    });

    it('calculates newBalance as zero after WETH closes the remaining debt', async () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['WETH'].seizedValue;

      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 COMP token balance does not change during absorb', async () => {
      expect(await tokens['COMP'].balanceOf(comet.address)).to.be.equal(collateralsState['COMP'].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance does not change during absorb', async () => {
      expect(await tokens['WETH'].balanceOf(comet.address)).to.be.equal(collateralsState['WETH'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['COMP'].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['WETH'].address)).to.be.equal(wethAmount - collateralsState['WETH'].seizeAmount);
      expect(await comet.collateralBalanceOf(alice.address, tokens['WETH'].address)).to.be.greaterThan(0); // to prevent zero balance case
    });

    it('alice assetsIn keeps only WETH', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);

      expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(1 << wethInfo.offset);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied COMP is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['WETH'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['WETH'].totalsCollateralBefore.sub(collateralsState['WETH'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet COMP collateral reserves increase by all seized COMP', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address)).to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet WETH collateral reserves increase by seized WETH', async () => {
      expect(await comet.getCollateralReserves(tokens['WETH'].address)).to.be.equal(collateralsState['WETH'].collateralReservesBefore.add(collateralsState['WETH'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('multi-collateral: first collateral fully seized, second collateral closes debt below min debt (asset indexes 15 and 16)', function () {
    // AAVE at $100: 0.1 AAVE = $10. LDO drops from $2 to $1.50: 10 LDO = $15.
    // BCF total before drop: 0.60*$10 + 0.55*$20 = $17 → borrow $16.50 is collateralized.
    // LCF after drop: 0.65*$10 + 0.62*$15 = $15.80 < $16.50 → liquidatable.
    // Formula wants $11.64 of AAVE but only $10 available → AAVE fully seized.
    // seizedValue_AAVE = 0.85*$10 = $8.50; remaining = $8.00 < $10 minDebt.
    // LDO LF-weighted $12.75 > $8.00 → partial LDO seizure.
    const aaveAmount = exp(0.1, 18);      // 0.1 AAVE = $10
    const ldoAmount = exp(10, 18);        // 10 LDO = $20 initial, $15 after drop
    const borrowAmount = exp(16.5, 6);    // $16.50
    const droppedLdoPrice = exp(1.5, 8);  // LDO drops to $1.50

    const collateralKeys = ['AAVE', 'LDO'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['AAVE'].address, aaveAmount);
      await comet.connect(alice).supply(tokens['LDO'].address, ldoAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['LDO'].connect(alice).setRoundData(0, droppedLdoPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates AAVE full seizure values', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens['AAVE'].address);
      const ldoInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      const aavePrice = (await priceFeeds['AAVE'].latestRoundData())[1].toBigInt();
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      // AAVE value = 0.1 * $100 = $10. LDO value after drop = 10 * $1.50 = $15.
      const aaveCollateralValue = mulPrice(aaveAmount, aavePrice, aaveInfo.scale);
      const ldoCollateralValue = mulPrice(ldoAmount, ldoPrice, ldoInfo.scale);
      const totalCollateralizedValue =
        mulFactor(aaveCollateralValue, aaveInfo.borrowCollateralFactor) +
        mulFactor(ldoCollateralValue, ldoInfo.borrowCollateralFactor);

      // The target HF formula wants more than $10 from AAVE, so AAVE is fully seized.
      const wantedAaveCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(aaveInfo.liquidationFactor, targetHealthFactor) - aaveInfo.borrowCollateralFactor.toBigInt());
      expect(wantedAaveCollateralValue).to.be.greaterThan(aaveCollateralValue);

      collateralsState['AAVE'].seizeAmount = aaveAmount;
      collateralsState['AAVE'].seizedValue = mulFactor(aaveCollateralValue, aaveInfo.liquidationFactor);
    });

    it('calculates LDO partial seizure values through the min debt branch', async () => {
      const ldoInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();

      // AAVE full seizure covers $8.50, leaving $8.00 debt, below the $10 baseBorrowMin.
      debtRemainingValue -= collateralsState['AAVE'].seizedValue;
      expect(debtRemainingValue).to.be.lessThan(minDebtValue);

      const ldoCollateralValue = mulPrice(ldoAmount, ldoPrice, ldoInfo.scale);
      const ldoCollateralValueLeft = mulFactor(ldoCollateralValue, ldoInfo.liquidationFactor);

      // LDO LF-weighted value is $12.75, so _processDebtClosing can close the debt partially.
      expect(debtRemainingValue).to.be.lessThan(ldoCollateralValueLeft);

      const wantedLdoCollateralValue = debtRemainingValue * factorScale / ldoInfo.liquidationFactor.toBigInt();
      collateralsState['LDO'].seizeAmount = divPrice(wantedLdoCollateralValue, ldoPrice, ldoInfo.scale);
      collateralsState['LDO'].seizedValue = debtRemainingValue;
    });

    it('calculates newBalance as zero after LDO closes the remaining debt', async () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['LDO'].seizedValue;

      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 AAVE token balance does not change during absorb', async () => {
      expect(await tokens['AAVE'].balanceOf(comet.address)).to.be.equal(collateralsState['AAVE'].tokenBalanceBefore);
    });

    it('comet ERC20 LDO token balance does not change during absorb', async () => {
      expect(await tokens['LDO'].balanceOf(comet.address)).to.be.equal(collateralsState['LDO'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice AAVE collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['AAVE'].address)).to.be.equal(0);
    });

    it('alice LDO collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['LDO'].address)).to.be.equal(ldoAmount - collateralsState['LDO'].seizeAmount);
      expect(await comet.collateralBalanceOf(alice.address, tokens['LDO'].address)).to.be.greaterThan(0);
    });

    it('alice assetsIn is empty after AAVE is fully seized', async () => {
      // AAVE (index 15) was the only assetsIn asset; LDO (index 16) is tracked in _reserved.
      expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits do not change because LDO remains', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied AAVE is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['AAVE'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['AAVE'].totalsCollateralBefore.sub(collateralsState['AAVE'].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied LDO is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['LDO'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['LDO'].totalsCollateralBefore.sub(collateralsState['LDO'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet AAVE collateral reserves increase by all seized AAVE', async () => {
      expect(await comet.getCollateralReserves(tokens['AAVE'].address)).to.be.equal(collateralsState['AAVE'].collateralReservesBefore.add(collateralsState['AAVE'].seizeAmount));
    });

    it('comet LDO collateral reserves increase by seized LDO', async () => {
      expect(await comet.getCollateralReserves(tokens['LDO'].address)).to.be.equal(collateralsState['LDO'].collateralReservesBefore.add(collateralsState['LDO'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('multi-collateral: first collateral fully seized, second collateral closes debt below min debt (asset indexes 22 and 23)', function () {
    // USDe at $1: 15 USDe = $15. sUSDe drops from $1 to $0.60: 20 sUSDe = $12.
    // BCF total before drop: 0.75*$15 + 0.72*$20 = $25.65 → borrow $23.00 is collateralized.
    // LCF after drop: 0.82*$15 + 0.80*$12 = $21.90 < $23.00 → liquidatable.
    // Formula wants $20.65 of USDe but only $15 available → USDe fully seized.
    // seizedValue_USDe = 0.92*$15 = $13.80; remaining = $9.20 < $10 minDebt.
    // sUSDe LF-weighted $11.04 > $9.20 → partial sUSDe seizure.
    const usdeAmount = exp(15, 18);          // $15
    const sUsdeAmount = exp(20, 18);         // $20 initial, $12 after drop
    const borrowAmount = exp(23, 6);         // $23.00
    const droppedSUsdePrice = exp(0.6, 8);   // sUSDe drops to $0.60

    const collateralKeys = ['USDe', 'sUSDe'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['USDe'].address, usdeAmount);
      await comet.connect(alice).supply(tokens['sUSDe'].address, sUsdeAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['sUSDe'].connect(alice).setRoundData(0, droppedSUsdePrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates USDe full seizure values', async () => {
      const usdeInfo = await comet.getAssetInfoByAddress(tokens['USDe'].address);
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const usdePrice = (await priceFeeds['USDe'].latestRoundData())[1].toBigInt();
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      // USDe value = $15. sUSDe value after drop = 20 * $0.60 = $12.
      const usdeCollateralValue = mulPrice(usdeAmount, usdePrice, usdeInfo.scale);
      const sUsdeCollateralValue = mulPrice(sUsdeAmount, sUsdePrice, sUsdeInfo.scale);
      const totalCollateralizedValue =
        mulFactor(usdeCollateralValue, usdeInfo.borrowCollateralFactor) +
        mulFactor(sUsdeCollateralValue, sUsdeInfo.borrowCollateralFactor);

      // The target HF formula wants more than $15 from USDe, so USDe is fully seized.
      const wantedUsdeCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(usdeInfo.liquidationFactor, targetHealthFactor) - usdeInfo.borrowCollateralFactor.toBigInt());
      expect(wantedUsdeCollateralValue).to.be.greaterThan(usdeCollateralValue);

      collateralsState['USDe'].seizeAmount = usdeAmount;
      collateralsState['USDe'].seizedValue = mulFactor(usdeCollateralValue, usdeInfo.liquidationFactor);
    });

    it('calculates sUSDe partial seizure values through the min debt branch', async () => {
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();

      // USDe full seizure covers $13.80, leaving $9.20 debt, below the $10 baseBorrowMin.
      debtRemainingValue -= collateralsState['USDe'].seizedValue;
      expect(debtRemainingValue).to.be.lessThan(minDebtValue);

      const sUsdeCollateralValue = mulPrice(sUsdeAmount, sUsdePrice, sUsdeInfo.scale);
      const sUsdeCollateralValueLeft = mulFactor(sUsdeCollateralValue, sUsdeInfo.liquidationFactor);

      // sUSDe LF-weighted value is $11.04, so _processDebtClosing can close the debt partially.
      expect(debtRemainingValue).to.be.lessThan(sUsdeCollateralValueLeft);

      const wantedSUsdeCollateralValue = debtRemainingValue * factorScale / sUsdeInfo.liquidationFactor.toBigInt();
      collateralsState['sUSDe'].seizeAmount = divPrice(wantedSUsdeCollateralValue, sUsdePrice, sUsdeInfo.scale);
      collateralsState['sUSDe'].seizedValue = debtRemainingValue;
    });

    it('calculates newBalance as zero after sUSDe closes the remaining debt', async () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['sUSDe'].seizedValue;

      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 USDe token balance does not change during absorb', async () => {
      expect(await tokens['USDe'].balanceOf(comet.address)).to.be.equal(collateralsState['USDe'].tokenBalanceBefore);
    });

    it('comet ERC20 sUSDe token balance does not change during absorb', async () => {
      expect(await tokens['sUSDe'].balanceOf(comet.address)).to.be.equal(collateralsState['sUSDe'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice USDe collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['USDe'].address)).to.be.equal(0);
    });

    it('alice sUSDe collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address)).to.be.equal(sUsdeAmount - collateralsState['sUSDe'].seizeAmount);
      expect(await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address)).to.be.greaterThan(0);
    });

    it('alice assetsIn does not change because neither asset is tracked there', async () => {
      // Both USDe (index 22) and sUSDe (index 23) are in _reserved, not assetsIn.
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice USDe reserved bit is cleared after full seizure, sUSDe reserved bit remains', async () => {
      // USDe index 22 → bit 6 of _reserved cleared; sUSDe index 23 → bit 7 stays.
      const expectedReserved = reservedBefore ^ (1 << (22 - 16));
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(expectedReserved);
    });

    it('comet total supplied USDe is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['USDe'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['USDe'].totalsCollateralBefore.sub(collateralsState['USDe'].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied sUSDe is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['sUSDe'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['sUSDe'].totalsCollateralBefore.sub(collateralsState['sUSDe'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet USDe collateral reserves increase by all seized USDe', async () => {
      expect(await comet.getCollateralReserves(tokens['USDe'].address)).to.be.equal(collateralsState['USDe'].collateralReservesBefore.add(collateralsState['USDe'].seizeAmount));
    });

    it('comet sUSDe collateral reserves increase by seized sUSDe', async () => {
      expect(await comet.getCollateralReserves(tokens['sUSDe'].address)).to.be.equal(collateralsState['sUSDe'].collateralReservesBefore.add(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('multi-collateral: first collateral fully seized, second collateral closes debt below min debt (non-adjacent asset indexes 10 and 20)', function () {
    // ezETH at $3350: 0.004 ezETH = $13.40. OP drops from $2 to $1.20: 10 OP = $12.
    // BCF total before drop: 0.70*$13.40 + 0.55*$20 = $20.38 → borrow $18.50 is collateralized.
    // LCF after drop: 0.76*$13.40 + 0.62*$12 = $17.624 < $18.50 → liquidatable.
    // Formula wants $14.52 of ezETH but only $13.40 available → ezETH fully seized.
    // seizedValue_ezETH = 0.91*$13.40 = $12.194; remaining = $6.306 < $10 minDebt.
    // OP LF-weighted $10.20 > $6.306 → partial OP seizure.
    const ezEthAmount = exp(0.004, 18);    // 0.004 ezETH = $13.40
    const opAmount = exp(10, 18);          // 10 OP = $20 initial, $12 after drop
    const borrowAmount = exp(18.5, 6);     // $18.50
    const droppedOpPrice = exp(1.2, 8);    // OP drops to $1.20

    const collateralKeys = ['ezETH', 'OP'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['ezETH'].address, ezEthAmount);
      await comet.connect(alice).supply(tokens['OP'].address, opAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['OP'].connect(alice).setRoundData(0, droppedOpPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates ezETH full seizure values', async () => {
      const ezEthInfo = await comet.getAssetInfoByAddress(tokens['ezETH'].address);
      const opInfo = await comet.getAssetInfoByAddress(tokens['OP'].address);
      const ezEthPrice = (await priceFeeds['ezETH'].latestRoundData())[1].toBigInt();
      const opPrice = (await priceFeeds['OP'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      // ezETH value = 0.004 * $3350 = $13.40. OP value after drop = 10 * $1.20 = $12.
      const ezEthCollateralValue = mulPrice(ezEthAmount, ezEthPrice, ezEthInfo.scale);
      const opCollateralValue = mulPrice(opAmount, opPrice, opInfo.scale);
      const totalCollateralizedValue =
        mulFactor(ezEthCollateralValue, ezEthInfo.borrowCollateralFactor) +
        mulFactor(opCollateralValue, opInfo.borrowCollateralFactor);

      // The target HF formula wants more than $13.40 from ezETH, so ezETH is fully seized.
      const wantedEzEthCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(ezEthInfo.liquidationFactor, targetHealthFactor) - ezEthInfo.borrowCollateralFactor.toBigInt());
      expect(wantedEzEthCollateralValue).to.be.greaterThan(ezEthCollateralValue);

      collateralsState['ezETH'].seizeAmount = ezEthAmount;
      collateralsState['ezETH'].seizedValue = mulFactor(ezEthCollateralValue, ezEthInfo.liquidationFactor);
    });

    it('calculates OP partial seizure values through the min debt branch', async () => {
      const opInfo = await comet.getAssetInfoByAddress(tokens['OP'].address);
      const opPrice = (await priceFeeds['OP'].latestRoundData())[1].toBigInt();

      // ezETH full seizure covers $12.194, leaving $6.306 debt, below the $10 baseBorrowMin.
      debtRemainingValue -= collateralsState['ezETH'].seizedValue;
      expect(debtRemainingValue).to.be.lessThan(minDebtValue);

      const opCollateralValue = mulPrice(opAmount, opPrice, opInfo.scale);
      const opCollateralValueLeft = mulFactor(opCollateralValue, opInfo.liquidationFactor);

      // OP LF-weighted value is $10.20, so _processDebtClosing can close the debt partially.
      expect(debtRemainingValue).to.be.lessThan(opCollateralValueLeft);

      const wantedOpCollateralValue = debtRemainingValue * factorScale / opInfo.liquidationFactor.toBigInt();
      collateralsState['OP'].seizeAmount = divPrice(wantedOpCollateralValue, opPrice, opInfo.scale);
      collateralsState['OP'].seizedValue = debtRemainingValue;
    });

    it('calculates newBalance as zero after OP closes the remaining debt', async () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['OP'].seizedValue;

      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 ezETH token balance does not change during absorb', async () => {
      expect(await tokens['ezETH'].balanceOf(comet.address)).to.be.equal(collateralsState['ezETH'].tokenBalanceBefore);
    });

    it('comet ERC20 OP token balance does not change during absorb', async () => {
      expect(await tokens['OP'].balanceOf(comet.address)).to.be.equal(collateralsState['OP'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice ezETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['ezETH'].address)).to.be.equal(0);
    });

    it('alice OP collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['OP'].address)).to.be.equal(opAmount - collateralsState['OP'].seizeAmount);
      expect(await comet.collateralBalanceOf(alice.address, tokens['OP'].address)).to.be.greaterThan(0);
    });

    it('alice assetsIn is empty after ezETH is fully seized', async () => {
      // ezETH (index 10) was the only assetsIn asset; OP (index 20) is tracked in _reserved.
      expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits do not change because OP remains', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied ezETH is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['ezETH'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['ezETH'].totalsCollateralBefore.sub(collateralsState['ezETH'].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied OP is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['OP'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['OP'].totalsCollateralBefore.sub(collateralsState['OP'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet ezETH collateral reserves increase by all seized ezETH', async () => {
      expect(await comet.getCollateralReserves(tokens['ezETH'].address)).to.be.equal(collateralsState['ezETH'].collateralReservesBefore.add(collateralsState['ezETH'].seizeAmount));
    });

    it('comet OP collateral reserves increase by seized OP', async () => {
      expect(await comet.getCollateralReserves(tokens['OP'].address)).to.be.equal(collateralsState['OP'].collateralReservesBefore.add(collateralsState['OP'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  // Note: this flow covers the minDebt guard inside the formula branch.
  // The formula's target-HF partial seizure would leave remaining debt below
  // baseBorrowMin, so the guard redirects to _processDebtClosing which
  // closes the debt in full with a slightly smaller collateral seizure.
  context('1 collateral: formula gives partial seizure but guard fires because S*LF leaves debt below minDebt, closes debt fully (0 index)', function () {
    const collateralAmount = exp(0.2, 18); // $20
    const borrowAmount = exp(15, 6);       // $15, above baseBorrowMin of $10
    const droppedCompPrice = exp(85, 8);   // $85 → collateralValue = $17

    const collateralKeys = ['COMP'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let collateralValue: bigint;
    let collateralValueLeft: bigint;
    let formulaWantedCollateralValue: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['COMP'].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('remaining debt is larger than the minimum borrow', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
      collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

      // debtRemainingValue=$15e8 > minDebtValue=$10e8
      expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
    });

    it('reaching target health only needs part of the collateral, not all of it', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);

      // Formula: S = (targetHF*D - BCF*C) / (targetHF*LF - BCF)
      // = (1.1*15e8 - 0.8*17e8) / (1.1*0.9 - 0.8) = 2.9e8 / 0.19 ≈ 15.26e8
      const totalBCFvalue = mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
      formulaWantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalBCFvalue) * factorScale
        / (mulFactor(assetInfo.liquidationFactor, targetHealthFactor) - assetInfo.borrowCollateralFactor.toBigInt());

      // formulaWantedCollateralValue ≈ $15.26e8 < collateralValue $17e8
      expect(formulaWantedCollateralValue).to.be.lessThan(collateralValue);
    });

    it('that partial path would leave debt at or under the minimum', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);

      // formulaSeizedValue = LF * formulaWantedCollateralValue = 0.9 * $15.26e8 ≈ $13.74e8
      const formulaSeizedValue = mulFactor(formulaWantedCollateralValue, assetInfo.liquidationFactor);

      // Guard: debtRemainingValue - formulaSeizedValue = $1.26e8 ≤ minDebtValue $10e8 → guard fires.
      expect(debtRemainingValue - formulaSeizedValue).to.be.lessThanOrEqual(minDebtValue);
    });

    it('at liquidation pricing, collateral can still cover the full debt', async () => {
      // debtRemainingValue $15e8 < collateralValueLeft $15.3e8 → debt fully closed.
      expect(debtRemainingValue).to.be.lessThan(collateralValueLeft);
    });

    it('full close: expected seize size and no borrow left', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);

      // seizeAmount = divPrice(debtRemaining * FACTOR_SCALE / LF, price, scale) ≈ 0.196 COMP
      const seize = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState['COMP'].seizeAmount = divPrice(seize, droppedCompPrice, assetInfo.scale);
    });

    it('debt remaining value is zero after full close and new balance becomes zero', async () => {
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens['COMP'].balanceOf(comet.address)).to.be.equal(collateralsState['COMP'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice collateral balance is reduced by the seized amount with leftover remaining', async () => {
      const remainingCollateral = await comet.collateralBalanceOf(alice.address, tokens['COMP'].address);
      expect(remainingCollateral).to.be.equal(collateralAmount - collateralsState['COMP'].seizeAmount);
      expect(remainingCollateral).to.be.greaterThan(0);
    });

    it('alice assetsIn does not change because collateral remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount but remains positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address)).to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('1 collateral: formula gives partial seizure but guard fires because S*LF leaves debt below minDebt, closes debt fully (16 index)', function () {
    const collateralAmount = exp(14, 18);      // 14 LDO = $28 initial
    const borrowAmount = exp(15, 6);           // $15, above baseBorrowMin of $10
    const droppedLdoPrice = exp(1.4, 8);       // $1.40 → collateralValue = $19.60

    const collateralKeys = ['LDO'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let collateralValue: bigint;
    let collateralValueLeft: bigint;
    let formulaWantedCollateralValue: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens['LDO'].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['LDO'].connect(alice).setRoundData(0, droppedLdoPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('remaining debt is larger than the minimum borrow', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
      collateralValue = mulPrice(collateralAmount, droppedLdoPrice, assetInfo.scale);
      collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

      // debtRemainingValue=$15e8 > minDebtValue=$10e8
      expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
    });

    it('reaching target health only needs part of the collateral, not all of it', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);

      // Formula: S = (targetHF*D - BCF*C) / (targetHF*LF - BCF)
      // = (1.1*15e8 - 0.55*19.60e8) / (1.1*0.85 - 0.55) = 5.72e8 / 0.385 ≈ 14.86e8
      const totalBCFvalue = mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
      formulaWantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalBCFvalue) * factorScale
        / (mulFactor(assetInfo.liquidationFactor, targetHealthFactor) - assetInfo.borrowCollateralFactor.toBigInt());

      // formulaWantedCollateralValue ≈ $14.86e8 < collateralValue $19.60e8
      expect(formulaWantedCollateralValue).to.be.lessThan(collateralValue);
    });

    it('that partial path would leave debt at or under the minimum', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);

      // formulaSeizedValue = LF * formulaWantedCollateralValue = 0.85 * $14.86e8 ≈ $12.63e8
      const formulaSeizedValue = mulFactor(formulaWantedCollateralValue, assetInfo.liquidationFactor);

      // Guard: debtRemainingValue - formulaSeizedValue = $2.37e8 ≤ minDebtValue $10e8 → guard fires.
      expect(debtRemainingValue - formulaSeizedValue).to.be.lessThanOrEqual(minDebtValue);
    });

    it('at liquidation pricing, collateral can still cover the full debt', async () => {
      // debtRemainingValue $15e8 < collateralValueLeft $16.66e8 → debt fully closed.
      expect(debtRemainingValue).to.be.lessThan(collateralValueLeft);
    });

    it('full close: expected seize size and no borrow left', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);

      // seizeAmount = divPrice(debtRemaining * FACTOR_SCALE / LF, price, scale)
      const seize = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState['LDO'].seizeAmount = divPrice(seize, droppedLdoPrice, assetInfo.scale);
    });

    it('debt remaining value is zero after full close and new balance becomes zero', async () => {
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens['LDO'].balanceOf(comet.address)).to.be.equal(collateralsState['LDO'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice collateral balance is reduced by the seized amount with leftover remaining', async () => {
      const remainingCollateral = await comet.collateralBalanceOf(alice.address, tokens['LDO'].address);
      expect(remainingCollateral).to.be.equal(collateralAmount - collateralsState['LDO'].seizeAmount);
      expect(remainingCollateral).to.be.greaterThan(0);
    });

    it('alice assetsIn does not change because collateral remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount but remains positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['LDO'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['LDO'].totalsCollateralBefore.sub(collateralsState['LDO'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['LDO'].address)).to.be.equal(collateralsState['LDO'].collateralReservesBefore.add(collateralsState['LDO'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('1 collateral: formula gives partial seizure but guard fires because S*LF leaves debt below minDebt, closes debt fully (23 index)', function () {
    const collateralAmount = exp(21, 18);      // 21 sUSDe = $21 initial
    const borrowAmount = exp(15, 6);           // $15, above baseBorrowMin of $10
    const droppedSUsdePrice = exp(0.85, 8);    // $0.85 → collateralValue = $17.85

    const collateralKeys = ['sUSDe'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let collateralValue: bigint;
    let collateralValueLeft: bigint;
    let formulaWantedCollateralValue: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens['sUSDe'].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['sUSDe'].connect(alice).setRoundData(0, droppedSUsdePrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('remaining debt is larger than the minimum borrow', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
      collateralValue = mulPrice(collateralAmount, droppedSUsdePrice, assetInfo.scale);
      collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

      // debtRemainingValue=$15e8 > minDebtValue=$10e8
      expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
    });

    it('reaching target health only needs part of the collateral, not all of it', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);

      // Formula: S = (targetHF*D - BCF*C) / (targetHF*LF - BCF)
      // = (1.1*15e8 - 0.72*17.85e8) / (1.1*0.92 - 0.72) = 3.648e8 / 0.292 ≈ 12.49e8
      const totalBCFvalue = mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
      formulaWantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalBCFvalue) * factorScale
        / (mulFactor(assetInfo.liquidationFactor, targetHealthFactor) - assetInfo.borrowCollateralFactor.toBigInt());

      // formulaWantedCollateralValue ≈ $12.49e8 < collateralValue $17.85e8
      expect(formulaWantedCollateralValue).to.be.lessThan(collateralValue);
    });

    it('that partial path would leave debt at or under the minimum', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);

      // formulaSeizedValue = LF * formulaWantedCollateralValue = 0.92 * $12.49e8 ≈ $11.49e8
      const formulaSeizedValue = mulFactor(formulaWantedCollateralValue, assetInfo.liquidationFactor);

      // Guard: debtRemainingValue - formulaSeizedValue = $3.51e8 ≤ minDebtValue $10e8 → guard fires.
      expect(debtRemainingValue - formulaSeizedValue).to.be.lessThanOrEqual(minDebtValue);
    });

    it('at liquidation pricing, collateral can still cover the full debt', async () => {
      // debtRemainingValue $15e8 < collateralValueLeft $16.42e8 → debt fully closed.
      expect(debtRemainingValue).to.be.lessThan(collateralValueLeft);
    });

    it('full close: expected seize size and no borrow left', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);

      // seizeAmount = divPrice(debtRemaining * FACTOR_SCALE / LF, price, scale)
      const seize = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState['sUSDe'].seizeAmount = divPrice(seize, droppedSUsdePrice, assetInfo.scale);
    });

    it('debt remaining value is zero after full close and new balance becomes zero', async () => {
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens['sUSDe'].balanceOf(comet.address)).to.be.equal(collateralsState['sUSDe'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice collateral balance is reduced by the seized amount with leftover remaining', async () => {
      const remainingCollateral = await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address);
      expect(remainingCollateral).to.be.equal(collateralAmount - collateralsState['sUSDe'].seizeAmount);
      expect(remainingCollateral).to.be.greaterThan(0);
    });

    it('alice assetsIn does not change because collateral remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount but remains positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['sUSDe'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['sUSDe'].totalsCollateralBefore.sub(collateralsState['sUSDe'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['sUSDe'].address)).to.be.equal(collateralsState['sUSDe'].collateralReservesBefore.add(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  // Note: this flow proves the minDebt guard inside the formula branch survives a preceding
  // full seizure. COMP is fully seized (formula demands more than available), leaving
  // remaining debt of $11 — above baseBorrowMin — so Branch A does not fire on WETH.
  // WETH enters the formula path, the guard fires because S*LF leaves $2.33 dust,
  // and _processDebtClosing case 1 closes the debt fully. Alice retains leftover WETH.
  context('2 collaterals: first fully seized then second formula gives partial seizure but guard fires because S*LF leaves debt at or under minDebt, closes debt fully (index 0 and 1)', function () {
    const compAmount = exp(0.1, 18);       // $10
    const wethAmount = exp(0.0087, 18);    // 0.0087 WETH; dropped $1500 → $13.05
    const borrowAmount = exp(20, 6);       // $20, above baseBorrowMin of $10
    const droppedWethPrice = exp(1500, 8); // $1500 → wethValue = $13.05

    const collateralKeys = ['COMP', 'WETH'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let formulaWantedWethValue: bigint;
    let wethCollateralValueLeft: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['COMP'].address, compAmount);
      await comet.connect(alice).supply(tokens['WETH'].address, wethAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['WETH'].connect(alice).setRoundData(0, droppedWethPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates COMP full seizure values', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      // compValue=$10e8, wethValue=$13.05e8
      const compCollateralValue = mulPrice(compAmount, compPrice, compInfo.scale);
      const wethCollateralValue = mulPrice(wethAmount, wethPrice, wethInfo.scale);
      const totalCollateralizedValue =
        mulFactor(compCollateralValue, compInfo.borrowCollateralFactor) +
        mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      // The target HF formula demands more than $10 from COMP → COMP fully seized.
      const wantedCompCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());
      expect(wantedCompCollateralValue).to.be.greaterThan(compCollateralValue);

      collateralsState['COMP'].seizeAmount = compAmount;
      collateralsState['COMP'].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);
    });

    it('after COMP is fully seized, remaining debt is still above the minimum borrow', async () => {
      // After COMP full seizure: debtRemaining = $11e8, still above minDebt $10e8.
      debtRemainingValue -= collateralsState['COMP'].seizedValue;
      expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
    });

    it('reaching target health only needs part of the WETH, not all of it', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();

      // wethValue = $13.05e8
      const wethCollateralValue = mulPrice(wethAmount, wethPrice, wethInfo.scale);
      wethCollateralValueLeft = mulFactor(wethCollateralValue, wethInfo.liquidationFactor);
      const totalBCFvalue = mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      // Formula: S = (1.1*$11 - 0.75*$13.05) / (1.1*0.9 - 0.75) = $2.3125/0.24 ≈ $9.64e8
      formulaWantedWethValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalBCFvalue) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());

      // formulaWantedWethValue ≈ $9.64e8 < wethCollateralValue $13.05e8 → partial WETH, not full.
      expect(formulaWantedWethValue).to.be.lessThan(wethCollateralValue);
    });

    it('wanted weth collateral value is less than borrow minimum value', async () => {
      expect(formulaWantedWethValue).to.be.lessThan(minDebtValue);
    });

    it('that partial WETH path would leave debt at or under the minimum', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);

      // formulaSeizedValue = 0.9 * $9.64e8 ≈ $8.67e8
      const formulaSeizedValue = mulFactor(formulaWantedWethValue, wethInfo.liquidationFactor);

      // Guard: $11e8 - $8.67e8 = $2.33e8 ≤ minDebt $10e8 → redirect to full close path.
      expect(debtRemainingValue - formulaSeizedValue).to.be.lessThanOrEqual(minDebtValue);
    });

    it('at liquidation pricing, WETH can still cover the full remaining debt', async () => {
      // $11e8 < LF*wethValue $11.745e8 → debt can be fully closed from WETH.
      expect(debtRemainingValue).to.be.lessThan(wethCollateralValueLeft);
    });

    it('full close: expected WETH seize size and no borrow left', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();

      // seizeAmount = divPrice(debtRemaining * FACTOR_SCALE / LF, price, scale) ≈ 0.00815 WETH
      const seize = debtRemainingValue * factorScale / wethInfo.liquidationFactor.toBigInt();
      collateralsState['WETH'].seizeAmount = divPrice(seize, wethPrice, wethInfo.scale);
    });

    it('debt remaining value is zero after full close and new balance becomes zero', async () => {
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 COMP token balance does not change during absorb', async () => {
      expect(await tokens['COMP'].balanceOf(comet.address)).to.be.equal(collateralsState['COMP'].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance does not change during absorb', async () => {
      expect(await tokens['WETH'].balanceOf(comet.address)).to.be.equal(collateralsState['WETH'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice COMP collateral balance is zero after full seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['COMP'].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is reduced by the seized amount with leftover remaining', async () => {
      const remainingWeth = await comet.collateralBalanceOf(alice.address, tokens['WETH'].address);
      expect(remainingWeth).to.be.equal(wethAmount - collateralsState['WETH'].seizeAmount);
      expect(remainingWeth).to.be.greaterThan(0);
    });

    it('alice assetsIn no longer contains COMP after full seizure', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      expect((await comet.userBasic(alice.address)).assetsIn & (1 << compInfo.offset)).to.be.equal(0);
    });

    it('alice assetsIn still contains WETH because collateral remains', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      expect((await comet.userBasic(alice.address)).assetsIn & (1 << wethInfo.offset)).to.not.be.equal(0);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied COMP is zero after full seizure', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied WETH is reduced by the seized amount but remains positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['WETH'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['WETH'].totalsCollateralBefore.sub(collateralsState['WETH'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet COMP collateral reserves increase by all seized COMP', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address)).to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet WETH collateral reserves increase by the seized WETH amount', async () => {
      expect(await comet.getCollateralReserves(tokens['WETH'].address)).to.be.equal(collateralsState['WETH'].collateralReservesBefore.add(collateralsState['WETH'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('2 collaterals: first fully seized then second formula gives partial seizure but guard fires because S*LF leaves debt at or under minDebt, closes debt fully (index 15 and 16)', function () {
    const aaveAmount = exp(0.1, 18);        // 0.1 AAVE = $10 initial
    const ldoAmount = exp(13, 18);          // 13 LDO = $26 at $2
    const borrowAmount = exp(20, 6);        // $20, above baseBorrowMin of $10
    const droppedAavePrice = exp(40, 8);    // $40 → aaveValue = $4

    const collateralKeys = ['AAVE', 'LDO'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let formulaWantedLdoValue: bigint;
    let ldoCollateralValueLeft: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['AAVE'].address, aaveAmount);
      await comet.connect(alice).supply(tokens['LDO'].address, ldoAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['AAVE'].connect(alice).setRoundData(0, droppedAavePrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates AAVE full seizure values', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens['AAVE'].address);
      const ldoInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      const aavePrice = (await priceFeeds['AAVE'].latestRoundData())[1].toBigInt();
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      // aaveValue=$4e8, ldoValue=$26e8
      const aaveCollateralValue = mulPrice(aaveAmount, aavePrice, aaveInfo.scale);
      const ldoCollateralValue = mulPrice(ldoAmount, ldoPrice, ldoInfo.scale);
      const totalCollateralizedValue =
        mulFactor(aaveCollateralValue, aaveInfo.borrowCollateralFactor) +
        mulFactor(ldoCollateralValue, ldoInfo.borrowCollateralFactor);

      // The target HF formula demands more than $4 from AAVE → AAVE fully seized.
      const wantedAaveCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(aaveInfo.liquidationFactor, targetHealthFactor) - aaveInfo.borrowCollateralFactor.toBigInt());
      expect(wantedAaveCollateralValue).to.be.greaterThan(aaveCollateralValue);

      collateralsState['AAVE'].seizeAmount = aaveAmount;
      collateralsState['AAVE'].seizedValue = mulFactor(aaveCollateralValue, aaveInfo.liquidationFactor);
    });

    it('after AAVE is fully seized, remaining debt is still above the minimum borrow', async () => {
      // After AAVE full seizure: debtRemaining = ~$16.60e8, still above minDebt $10e8.
      debtRemainingValue -= collateralsState['AAVE'].seizedValue;
      expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
    });

    it('reaching target health only needs part of the LDO, not all of it', async () => {
      const ldoInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();

      // ldoValue = $26e8
      const ldoCollateralValue = mulPrice(ldoAmount, ldoPrice, ldoInfo.scale);
      ldoCollateralValueLeft = mulFactor(ldoCollateralValue, ldoInfo.liquidationFactor);
      const totalBCFvalue = mulFactor(ldoCollateralValue, ldoInfo.borrowCollateralFactor);

      // Formula: S = (1.05*$16.60 - 0.55*$26) / (1.05*0.85 - 0.55) = $3.13/0.3425 ≈ $9.14e8
      formulaWantedLdoValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalBCFvalue) * factorScale
        / (mulFactor(ldoInfo.liquidationFactor, targetHealthFactor) - ldoInfo.borrowCollateralFactor.toBigInt());

      // formulaWantedLdoValue ≈ $9.14e8 < ldoCollateralValue $26e8 → partial LDO, not full.
      expect(formulaWantedLdoValue).to.be.lessThan(ldoCollateralValue);
    });

    it('wanted LDO collateral value is less than borrow minimum value', async () => {
      expect(formulaWantedLdoValue).to.be.lessThan(minDebtValue);
    });

    it('that partial LDO path would leave debt at or under the minimum', async () => {
      const ldoInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);

      // formulaSeizedValue = 0.85 * $9.14e8 ≈ $7.77e8
      const formulaSeizedValue = mulFactor(formulaWantedLdoValue, ldoInfo.liquidationFactor);

      // Guard: $16.60e8 - $7.77e8 = $8.83e8 ≤ minDebt $10e8 → redirect to full close path.
      expect(debtRemainingValue - formulaSeizedValue).to.be.lessThanOrEqual(minDebtValue);
    });

    it('at liquidation pricing, LDO can still cover the full remaining debt', async () => {
      // $16.60e8 < LF*ldoValue $22.10e8 → debt can be fully closed from LDO.
      expect(debtRemainingValue).to.be.lessThan(ldoCollateralValueLeft);
    });

    it('full close: expected LDO seize size and no borrow left', async () => {
      const ldoInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();

      // seizeAmount = divPrice(debtRemaining * FACTOR_SCALE / LF, price, scale)
      const seize = debtRemainingValue * factorScale / ldoInfo.liquidationFactor.toBigInt();
      collateralsState['LDO'].seizeAmount = divPrice(seize, ldoPrice, ldoInfo.scale);
    });

    it('debt remaining value is zero after full close and new balance becomes zero', async () => {
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 AAVE token balance does not change during absorb', async () => {
      expect(await tokens['AAVE'].balanceOf(comet.address)).to.be.equal(collateralsState['AAVE'].tokenBalanceBefore);
    });

    it('comet ERC20 LDO token balance does not change during absorb', async () => {
      expect(await tokens['LDO'].balanceOf(comet.address)).to.be.equal(collateralsState['LDO'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice AAVE collateral balance is zero after full seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['AAVE'].address)).to.be.equal(0);
    });

    it('alice LDO collateral balance is reduced by the seized amount with leftover remaining', async () => {
      const remainingLdo = await comet.collateralBalanceOf(alice.address, tokens['LDO'].address);
      expect(remainingLdo).to.be.equal(ldoAmount - collateralsState['LDO'].seizeAmount);
      expect(remainingLdo).to.be.greaterThan(0);
    });

    it('alice assetsIn no longer contains AAVE after full seizure', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens['AAVE'].address);
      expect((await comet.userBasic(alice.address)).assetsIn & (1 << aaveInfo.offset)).to.be.equal(0);
    });

    it('alice reserved bits do not change because LDO collateral remains', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied AAVE is zero after full seizure', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['AAVE'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['AAVE'].totalsCollateralBefore.sub(collateralsState['AAVE'].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied LDO is reduced by the seized amount but remains positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['LDO'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['LDO'].totalsCollateralBefore.sub(collateralsState['LDO'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet AAVE collateral reserves increase by all seized AAVE', async () => {
      expect(await comet.getCollateralReserves(tokens['AAVE'].address)).to.be.equal(collateralsState['AAVE'].collateralReservesBefore.add(collateralsState['AAVE'].seizeAmount));
    });

    it('comet LDO collateral reserves increase by the seized LDO amount', async () => {
      expect(await comet.getCollateralReserves(tokens['LDO'].address)).to.be.equal(collateralsState['LDO'].collateralReservesBefore.add(collateralsState['LDO'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('2 collaterals: first fully seized then second formula gives partial seizure but guard fires because S*LF leaves debt at or under minDebt, closes debt fully (index 22 and 23)', function () {
    const usdeAmount = exp(15, 18);             // 15 USDe = $15 initial
    const sUsdeAmount = exp(21, 18);            // 21 sUSDe = $21 at $1
    const borrowAmount = exp(25, 6);            // $25, above baseBorrowMin of $10
    const droppedUsdePrice = exp(0.65, 8);      // $0.65 → usdeValue = $9.75

    const collateralKeys = ['USDe', 'sUSDe'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let formulaWantedSUsdeValue: bigint;
    let sUsdeCollateralValueLeft: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['USDe'].address, usdeAmount);
      await comet.connect(alice).supply(tokens['sUSDe'].address, sUsdeAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['USDe'].connect(alice).setRoundData(0, droppedUsdePrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates USDe full seizure values', async () => {
      const usdeInfo = await comet.getAssetInfoByAddress(tokens['USDe'].address);
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const usdePrice = (await priceFeeds['USDe'].latestRoundData())[1].toBigInt();
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      // usdeValue=$9.75e8, sUsdeValue=$21e8
      const usdeCollateralValue = mulPrice(usdeAmount, usdePrice, usdeInfo.scale);
      const sUsdeCollateralValue = mulPrice(sUsdeAmount, sUsdePrice, sUsdeInfo.scale);
      const totalCollateralizedValue =
        mulFactor(usdeCollateralValue, usdeInfo.borrowCollateralFactor) +
        mulFactor(sUsdeCollateralValue, sUsdeInfo.borrowCollateralFactor);

      // The target HF formula demands more than $9.75 from USDe → USDe fully seized.
      const wantedUsdeCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(usdeInfo.liquidationFactor, targetHealthFactor) - usdeInfo.borrowCollateralFactor.toBigInt());
      expect(wantedUsdeCollateralValue).to.be.greaterThan(usdeCollateralValue);

      collateralsState['USDe'].seizeAmount = usdeAmount;
      collateralsState['USDe'].seizedValue = mulFactor(usdeCollateralValue, usdeInfo.liquidationFactor);
    });

    it('after USDe is fully seized, remaining debt is still above the minimum borrow', async () => {
      // After USDe full seizure: debtRemaining = ~$16.03e8, still above minDebt $10e8.
      debtRemainingValue -= collateralsState['USDe'].seizedValue;
      expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
    });

    it('reaching target health only needs part of the sUSDe, not all of it', async () => {
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();

      // sUsdeValue = $21e8
      const sUsdeCollateralValue = mulPrice(sUsdeAmount, sUsdePrice, sUsdeInfo.scale);
      sUsdeCollateralValueLeft = mulFactor(sUsdeCollateralValue, sUsdeInfo.liquidationFactor);
      const totalBCFvalue = mulFactor(sUsdeCollateralValue, sUsdeInfo.borrowCollateralFactor);

      // Formula: S = (1.1*$16.03 - 0.72*$21) / (1.1*0.92 - 0.72) = $2.513/0.292 ≈ $8.61e8
      formulaWantedSUsdeValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalBCFvalue) * factorScale
        / (mulFactor(sUsdeInfo.liquidationFactor, targetHealthFactor) - sUsdeInfo.borrowCollateralFactor.toBigInt());

      // formulaWantedSUsdeValue ≈ $8.61e8 < sUsdeCollateralValue $21e8 → partial sUSDe, not full.
      expect(formulaWantedSUsdeValue).to.be.lessThan(sUsdeCollateralValue);
    });

    it('wanted sUSDe collateral value is less than borrow minimum value', async () => {
      expect(formulaWantedSUsdeValue).to.be.lessThan(minDebtValue);
    });

    it('that partial sUSDe path would leave debt at or under the minimum', async () => {
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);

      // formulaSeizedValue = 0.92 * $8.61e8 ≈ $7.92e8
      const formulaSeizedValue = mulFactor(formulaWantedSUsdeValue, sUsdeInfo.liquidationFactor);

      // Guard: $16.03e8 - $7.92e8 = $8.11e8 ≤ minDebt $10e8 → redirect to full close path.
      expect(debtRemainingValue - formulaSeizedValue).to.be.lessThanOrEqual(minDebtValue);
    });

    it('at liquidation pricing, sUSDe can still cover the full remaining debt', async () => {
      // $16.03e8 < LF*sUsdeValue $19.32e8 → debt can be fully closed from sUSDe.
      expect(debtRemainingValue).to.be.lessThan(sUsdeCollateralValueLeft);
    });

    it('full close: expected sUSDe seize size and no borrow left', async () => {
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();

      // seizeAmount = divPrice(debtRemaining * FACTOR_SCALE / LF, price, scale)
      const seize = debtRemainingValue * factorScale / sUsdeInfo.liquidationFactor.toBigInt();
      collateralsState['sUSDe'].seizeAmount = divPrice(seize, sUsdePrice, sUsdeInfo.scale);
    });

    it('debt remaining value is zero after full close and new balance becomes zero', async () => {
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 USDe token balance does not change during absorb', async () => {
      expect(await tokens['USDe'].balanceOf(comet.address)).to.be.equal(collateralsState['USDe'].tokenBalanceBefore);
    });

    it('comet ERC20 sUSDe token balance does not change during absorb', async () => {
      expect(await tokens['sUSDe'].balanceOf(comet.address)).to.be.equal(collateralsState['sUSDe'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice USDe collateral balance is zero after full seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['USDe'].address)).to.be.equal(0);
    });

    it('alice sUSDe collateral balance is reduced by the seized amount with leftover remaining', async () => {
      const remainingSUsde = await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address);
      expect(remainingSUsde).to.be.equal(sUsdeAmount - collateralsState['sUSDe'].seizeAmount);
      expect(remainingSUsde).to.be.greaterThan(0);
    });

    it('alice assetsIn is zero because both assets are tracked in reserved', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice USDe reserved bit is cleared after full seizure but sUSDe bit remains', async () => {
      // USDe is bit 6 of _reserved (22-16=6), sUSDe is bit 7 (23-16=7)
      const expectedReserved = reservedBefore ^ (1 << (22 - 16));
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(expectedReserved);
    });

    it('comet total supplied USDe is zero after full seizure', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['USDe'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['USDe'].totalsCollateralBefore.sub(collateralsState['USDe'].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied sUSDe is reduced by the seized amount but remains positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['sUSDe'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['sUSDe'].totalsCollateralBefore.sub(collateralsState['sUSDe'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet USDe collateral reserves increase by all seized USDe', async () => {
      expect(await comet.getCollateralReserves(tokens['USDe'].address)).to.be.equal(collateralsState['USDe'].collateralReservesBefore.add(collateralsState['USDe'].seizeAmount));
    });

    it('comet sUSDe collateral reserves increase by the seized sUSDe amount', async () => {
      expect(await comet.getCollateralReserves(tokens['sUSDe'].address)).to.be.equal(collateralsState['sUSDe'].collateralReservesBefore.add(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('2 collaterals: first fully seized then second formula gives partial seizure but guard fires because S*LF leaves debt at or under minDebt, closes debt fully (index 10 and 20)', function () {
    const ezEthAmount = exp(0.004, 18);         // 0.004 ezETH = $13.40 initial
    const opAmount = exp(13, 18);               // 13 OP = $26 at $2
    const borrowAmount = exp(22, 6);            // $22, above baseBorrowMin of $10
    const droppedEzEthPrice = exp(1500, 8);     // $1500 → ezEthValue = $6

    const collateralKeys = ['ezETH', 'OP'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let formulaWantedOpValue: bigint;
    let opCollateralValueLeft: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['ezETH'].address, ezEthAmount);
      await comet.connect(alice).supply(tokens['OP'].address, opAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['ezETH'].connect(alice).setRoundData(0, droppedEzEthPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates ezETH full seizure values', async () => {
      const ezEthInfo = await comet.getAssetInfoByAddress(tokens['ezETH'].address);
      const opInfo = await comet.getAssetInfoByAddress(tokens['OP'].address);
      const ezEthPrice = (await priceFeeds['ezETH'].latestRoundData())[1].toBigInt();
      const opPrice = (await priceFeeds['OP'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      // ezEthValue=$6e8, opValue=$26e8
      const ezEthCollateralValue = mulPrice(ezEthAmount, ezEthPrice, ezEthInfo.scale);
      const opCollateralValue = mulPrice(opAmount, opPrice, opInfo.scale);
      const totalCollateralizedValue =
        mulFactor(ezEthCollateralValue, ezEthInfo.borrowCollateralFactor) +
        mulFactor(opCollateralValue, opInfo.borrowCollateralFactor);

      // The target HF formula demands more than $6 from ezETH → ezETH fully seized.
      const wantedEzEthCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(ezEthInfo.liquidationFactor, targetHealthFactor) - ezEthInfo.borrowCollateralFactor.toBigInt());
      expect(wantedEzEthCollateralValue).to.be.greaterThan(ezEthCollateralValue);

      collateralsState['ezETH'].seizeAmount = ezEthAmount;
      collateralsState['ezETH'].seizedValue = mulFactor(ezEthCollateralValue, ezEthInfo.liquidationFactor);
    });

    it('after ezETH is fully seized, remaining debt is still above the minimum borrow', async () => {
      // After ezETH full seizure: debtRemaining = ~$16.54e8, still above minDebt $10e8.
      debtRemainingValue -= collateralsState['ezETH'].seizedValue;
      expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
    });

    it('reaching target health only needs part of the OP, not all of it', async () => {
      const opInfo = await comet.getAssetInfoByAddress(tokens['OP'].address);
      const opPrice = (await priceFeeds['OP'].latestRoundData())[1].toBigInt();

      // opValue = $26e8
      const opCollateralValue = mulPrice(opAmount, opPrice, opInfo.scale);
      opCollateralValueLeft = mulFactor(opCollateralValue, opInfo.liquidationFactor);
      const totalBCFvalue = mulFactor(opCollateralValue, opInfo.borrowCollateralFactor);

      // Formula: S = (1.05*$16.54 - 0.55*$26) / (1.05*0.85 - 0.55) = $3.067/0.3425 ≈ $8.95e8
      formulaWantedOpValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalBCFvalue) * factorScale
        / (mulFactor(opInfo.liquidationFactor, targetHealthFactor) - opInfo.borrowCollateralFactor.toBigInt());

      // formulaWantedOpValue ≈ $8.95e8 < opCollateralValue $26e8 → partial OP, not full.
      expect(formulaWantedOpValue).to.be.lessThan(opCollateralValue);
    });

    it('wanted OP collateral value is less than borrow minimum value', async () => {
      expect(formulaWantedOpValue).to.be.lessThan(minDebtValue);
    });

    it('that partial OP path would leave debt at or under the minimum', async () => {
      const opInfo = await comet.getAssetInfoByAddress(tokens['OP'].address);

      // formulaSeizedValue = 0.85 * $8.95e8 ≈ $7.61e8
      const formulaSeizedValue = mulFactor(formulaWantedOpValue, opInfo.liquidationFactor);

      // Guard: $16.54e8 - $7.61e8 = $8.93e8 ≤ minDebt $10e8 → redirect to full close path.
      expect(debtRemainingValue - formulaSeizedValue).to.be.lessThanOrEqual(minDebtValue);
    });

    it('at liquidation pricing, OP can still cover the full remaining debt', async () => {
      // $16.54e8 < LF*opValue $22.10e8 → debt can be fully closed from OP.
      expect(debtRemainingValue).to.be.lessThan(opCollateralValueLeft);
    });

    it('full close: expected OP seize size and no borrow left', async () => {
      const opInfo = await comet.getAssetInfoByAddress(tokens['OP'].address);
      const opPrice = (await priceFeeds['OP'].latestRoundData())[1].toBigInt();

      // seizeAmount = divPrice(debtRemaining * FACTOR_SCALE / LF, price, scale)
      const seize = debtRemainingValue * factorScale / opInfo.liquidationFactor.toBigInt();
      collateralsState['OP'].seizeAmount = divPrice(seize, opPrice, opInfo.scale);
    });

    it('debt remaining value is zero after full close and new balance becomes zero', async () => {
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 ezETH token balance does not change during absorb', async () => {
      expect(await tokens['ezETH'].balanceOf(comet.address)).to.be.equal(collateralsState['ezETH'].tokenBalanceBefore);
    });

    it('comet ERC20 OP token balance does not change during absorb', async () => {
      expect(await tokens['OP'].balanceOf(comet.address)).to.be.equal(collateralsState['OP'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice ezETH collateral balance is zero after full seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['ezETH'].address)).to.be.equal(0);
    });

    it('alice OP collateral balance is reduced by the seized amount with leftover remaining', async () => {
      const remainingOp = await comet.collateralBalanceOf(alice.address, tokens['OP'].address);
      expect(remainingOp).to.be.equal(opAmount - collateralsState['OP'].seizeAmount);
      expect(remainingOp).to.be.greaterThan(0);
    });

    it('alice assetsIn no longer contains ezETH after full seizure', async () => {
      const ezEthInfo = await comet.getAssetInfoByAddress(tokens['ezETH'].address);
      expect((await comet.userBasic(alice.address)).assetsIn & (1 << ezEthInfo.offset)).to.be.equal(0);
    });

    it('alice reserved bits do not change because OP collateral remains', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied ezETH is zero after full seizure', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['ezETH'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['ezETH'].totalsCollateralBefore.sub(collateralsState['ezETH'].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied OP is reduced by the seized amount but remains positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['OP'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['OP'].totalsCollateralBefore.sub(collateralsState['OP'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet ezETH collateral reserves increase by all seized ezETH', async () => {
      expect(await comet.getCollateralReserves(tokens['ezETH'].address)).to.be.equal(collateralsState['ezETH'].collateralReservesBefore.add(collateralsState['ezETH'].seizeAmount));
    });

    it('comet OP collateral reserves increase by the seized OP amount', async () => {
      expect(await comet.getCollateralReserves(tokens['OP'].address)).to.be.equal(collateralsState['OP'].collateralReservesBefore.add(collateralsState['OP'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  // Note: On COMP the target-health partial slice would leave debt under baseBorrowMin,
  // so the min-borrow guard widens to full seizure—but that still does not repay everything.
  // On WETH the guard path applies again to the small debt; liquidation pricing still lets
  // WETH cover what remains, so absorb wipes borrow and the account is no longer a borrower.
  context('2 collaterals: first hits min-borrow guard, partial paydown would leave debt under minimum so full seizure; second hits guard but can cover the rest and becomes non-borrower', function () {
    // COMP at index 0, WETH at index 1.
    // COMP value = $20; WETH drops from $16 to $8.
    // Borrow $23.45 is:
    //   - collateralized before drop (BCF: 0.8*$20 + 0.75*$16 = $28)
    //   - liquidatable after drop (LCF: 0.85*$20 + 0.8*$8 = $23.4 < $23.45)
    const compAmount = exp(0.2, 18);       // $20 at $100
    const wethAmount = exp(0.008, 18);     // $16 at $2000, $8 at $1000
    const borrowAmount = exp(23.45, 6);    // above baseBorrowMin ($10)
    const droppedWethPrice = exp(1000, 8); // WETH drops to $1000

    const collateralKeys = ['COMP', 'WETH'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let compCollateralValue: bigint;
    let compCollateralValueLeft: bigint;
    let formulaWantedCompValue: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens['COMP'].address, compAmount);
      await comet.connect(alice).supply(tokens['WETH'].address, wethAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['WETH'].connect(alice).setRoundData(0, droppedWethPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('alice borrow balance is equal to borrowed amount and above baseBorrowMin', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount);
      expect(await comet.borrowBalanceOf(alice.address)).to.be.greaterThan(baseBorrowMin);
    });

    it('reaching target health only needs part of the COMP, not the full position', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

      compCollateralValue = mulPrice(compAmount, compPrice, compInfo.scale); // $20e8
      const wethCollateralValue = mulPrice(wethAmount, wethPrice, wethInfo.scale); // $8e8 after drop
      const totalCollateralizedValue =
        mulFactor(compCollateralValue, compInfo.borrowCollateralFactor) +
        mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      formulaWantedCompValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());
      compCollateralValueLeft = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      expect(formulaWantedCompValue).to.be.lessThan(compCollateralValue);
    });

    it('that partial COMP path would leave debt at or under the minimum', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      const formulaSeizedCompValue = mulFactor(formulaWantedCompValue, compInfo.liquidationFactor);

      expect(debtRemainingValue - formulaSeizedCompValue).to.be.lessThanOrEqual(minDebtValue);
    });

    it('total debt is still at least the liquidation value of the entire COMP position', async () => {
      // So liquidation takes all COMP (full seizure), not a smaller partial slice.
      expect(debtRemainingValue).to.be.greaterThanOrEqual(compCollateralValueLeft);
    });

    it('expected full COMP seizure: entire balance at full mark, repay up to liquidation value', async () => {
      collateralsState['COMP'].seizeAmount = compAmount;
      collateralsState['COMP'].seizedValue = compCollateralValueLeft;
    });

    it('after full COMP seizure, remaining debt is below minimum borrow but positive', async () => {
      debtRemainingValue -= collateralsState['COMP'].seizedValue;

      expect(debtRemainingValue).to.be.lessThan(minDebtValue);
      expect(debtRemainingValue).to.be.greaterThan(0);
    });

    it('at liquidation pricing, WETH still covers the remaining debt', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();
      const wethCollateralValue = mulPrice(wethAmount, wethPrice, wethInfo.scale);
      const wethCollateralValueLeft = mulFactor(wethCollateralValue, wethInfo.liquidationFactor);

      expect(debtRemainingValue).to.be.lessThan(wethCollateralValueLeft);
    });

    it('expected WETH seize amount and collateral value for closing the remainder', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();

      // Mirrors closing the small debt with partial WETH (wanted value → wei → rounded token amount → repriced).
      const grossWethValue = debtRemainingValue * factorScale / wethInfo.liquidationFactor.toBigInt();
      collateralsState['WETH'].seizeAmount = divPrice(grossWethValue, wethPrice, wethInfo.scale);
      collateralsState['WETH'].seizedValue = debtRemainingValue;
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('newBalance is zero after WETH closes the remaining debt', () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['WETH'].seizedValue;
      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance and principal are zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('AbsorbCollateral events are emitted for COMP full seizure and WETH minDebt close', async () => {
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address,
        alice.address,
        tokens['COMP'].address,
        collateralsState['COMP'].seizeAmount,
        compCollateralValue
      );
    });

    it('AbsorbCollateral event is emitted for WETH minDebt close', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();
      const wethWantedCollateralValue = mulPrice(collateralsState['WETH'].seizeAmount, wethPrice, wethInfo.scale);

      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address,
        alice.address,
        tokens['WETH'].address,
        collateralsState['WETH'].seizeAmount,
        wethWantedCollateralValue
      );
    });

    it('comet ERC20 COMP balance on Comet is unchanged during absorb', async () => {
      expect(await tokens['COMP'].balanceOf(comet.address)).to.be.equal(collateralsState['COMP'].tokenBalanceBefore);
    });

    it('comet ERC20 WETH balance on Comet is unchanged during absorb', async () => {
      expect(await tokens['WETH'].balanceOf(comet.address)).to.be.equal(collateralsState['WETH'].tokenBalanceBefore);
    });

    it('comet ERC20 base balance on Comet is unchanged during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice COMP collateral balance is zero after full seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['COMP'].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance drops by the seized WETH amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['WETH'].address)).to.be.equal(wethAmount - collateralsState['WETH'].seizeAmount);
    });

    it('alice still holds WETH collateral after partial seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['WETH'].address)).to.be.greaterThan(0);
    });

    it('alice assetsIn keeps only WETH and reserved bits do not change', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(1 << wethInfo.offset);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied COMP collateral is reduced by the seized COMP amount', async () => {
      const compTotalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;

      expect(compTotalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supplied COMP collateral is zero', async () => {
      expect((await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied WETH collateral is reduced by the seized WETH amount', async () => {
      const wethTotalSupplyAsset = (await comet.totalsCollateral(tokens['WETH'].address)).totalSupplyAsset;

      expect(wethTotalSupplyAsset).to.be.equal(collateralsState['WETH'].totalsCollateralBefore.sub(collateralsState['WETH'].seizeAmount));
    });

    it('comet total supplied WETH collateral is still positive', async () => {
      expect((await comet.totalsCollateral(tokens['WETH'].address)).totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is reduced by the base paid out on absorb', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total borrow base is zero', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet COMP collateral reserves increase by the seized COMP amount', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address)).to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet WETH collateral reserves increase by the seized WETH amount', async () => {
      expect(await comet.getCollateralReserves(tokens['WETH'].address)).to.be.equal(collateralsState['WETH'].collateralReservesBefore.add(collateralsState['WETH'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  // Note: this context covers the equality edge case of the Branch A condition:
  // `debtRemainingValue <= minDebtValue`. When alice borrows exactly baseBorrowMin
  // with no subsequent repay, the absorb immediately enters _processDebtClosing
  // (case 1: debt < LF×collateralValue) and closes the debt fully, leaving leftover COMP.
  context('debt = minDebt', function () {
    // COMP: BCF=0.80, LCF=0.85, LF=0.90
    // At $100: 0.13 COMP = $13; BCF×$13 = $10.40 ≥ $10 → collateralized to borrow
    // Drop to $88: compValue = $11.44e8
    //   LCF×$11.44 = $9.724 < $10 → liquidatable
    //   debtRemainingValue ($10e8) = minDebtValue ($10e8) → Branch A fires immediately
    //   case 1: $10e8 < LF×$11.44 = $10.296e8 → debt fully closed, leftover COMP
    const collateralAmount = exp(0.13, 18); // 0.13 COMP = $13 initial
    const borrowAmount = exp(10, 6);        // $10, exactly baseBorrowMin
    const droppedCompPrice = exp(88, 8);    // $88 → compValue = $11.44e8

    const collateralKeys = ['COMP'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let collateralValue: bigint;
    let collateralValueLeft: bigint;
    let wantedCollateralValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['COMP'].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: alice borrow balance equals baseBorrowMin exactly', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(await comet.baseBorrowMin());
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('min debt branch fires immediately: debtRemainingValue equals minDebtValue and collateral covers it', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
      collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

      // debtRemainingValue = $10e8 = minDebtValue = $10e8 → absorb immediately enters
      // _processDebtClosing. collateralValueLeft = $11.44e8 * 0.90 = $10.296e8 > debt,
      // so COMP can close the debt with a partial seizure (case 1).
      expect(debtRemainingValue).to.be.equal(minDebtValue);
      expect(debtRemainingValue).to.be.lessThan(collateralValueLeft);

      wantedCollateralValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState['COMP'].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, assetInfo.scale);
      collateralsState['COMP'].seizedValue = debtRemainingValue;
      wantedCollateralValue = mulPrice(collateralsState['COMP'].seizeAmount, droppedCompPrice, assetInfo.scale);
    });

    it('calculates newBalance as zero after debt is fully closed', async () => {
      const debtRemainingValueAfterSeize = debtRemainingValue - collateralsState['COMP'].seizedValue;

      expect(debtRemainingValueAfterSeize).to.be.equal(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens['COMP'].balanceOf(comet.address)).to.be.equal(collateralsState['COMP'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice collateral balance is reduced by the seized amount with leftover remaining', async () => {
      const remainingComp = await comet.collateralBalanceOf(alice.address, tokens['COMP'].address);
      expect(remainingComp).to.be.equal(collateralAmount - collateralsState['COMP'].seizeAmount);
      expect(remainingComp).to.be.greaterThan(0);
    });

    it('alice assetsIn does not change because collateral remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount but remains positive', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet total borrow base is zero', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      expect(totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address)).to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  // Note: this context covers _processDebtClosing case 2. When debt equals minDebt
  // but LF×collateralValue < debtRemainingValue, the contract seizes ALL collateral
  // and the residual debt is forgiven as bad debt (totalCollateralizedValue == 0).
  context('debt = minDebt but collateral cannot cover, full seizure and bad debt', function () {
    const collateralAmount = exp(0.125, 18); // 0.125 COMP = $12.50 initial
    const borrowAmount = exp(10, 6);         // $10, exactly baseBorrowMin
    const droppedCompPrice = exp(80, 8);     // $80 → compValue = $10e8

    const collateralKeys = ['COMP'];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let minDebtValue: bigint;
    let collateralValue: bigint;
    let collateralValueLeft: bigint;
    let residualDebtValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      await priceFeeds['COMP'].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
    });

    after(async () => await snapshot.restore());

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(true, 'User is not liquidatable');
    });

    it('sanity check: alice borrow balance equals baseBorrowMin exactly', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(await comet.baseBorrowMin());
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('min debt branch fires immediately: debtRemainingValue equals minDebtValue; collateral cannot cover, all COMP seized', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
      collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

      // debtRemainingValue = $10e8 = minDebtValue → Branch A fires immediately.
      // collateralValueLeft = 0.90 × $10e8 = $9e8 < debtRemainingValue $10e8
      // → case 2: seize all COMP; residual $1e8 becomes bad debt.
      expect(debtRemainingValue).to.be.equal(minDebtValue);
      expect(debtRemainingValue).to.be.greaterThanOrEqual(collateralValueLeft);

      collateralsState['COMP'].seizeAmount = collateralAmount;
      collateralsState['COMP'].seizedValue = collateralValueLeft;
    });

    it('residual debt is forgiven as bad debt: newBalance is set to zero despite remaining debt', async () => {
      residualDebtValue = debtRemainingValue - collateralsState['COMP'].seizedValue;

      // $10e8 - $9e8 = $1e8 > 0: residual exists, but totalCollateralizedValue == 0 so forgiven.
      expect(residualDebtValue).to.be.greaterThan(0n);
      newBalance = 0n;
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 collateral token balance does not change during absorb', async () => {
      expect(await tokens['COMP'].balanceOf(comet.address)).to.be.equal(collateralsState['COMP'].tokenBalanceBefore);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice COMP collateral balance is zero after full seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['COMP'].address)).to.be.equal(0);
    });

    it('alice assetsIn clears the COMP bit because all collateral was seized', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      expect((await comet.userBasic(alice.address)).assetsIn & (1 << compInfo.offset)).to.be.equal(0);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied COMP collateral is reduced by the full seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supplied COMP collateral is zero after full seizure', async () => {
      expect((await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset).to.be.equal(0);
    });

    it('comet total borrow base is reduced by the base paid out on absorb', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total borrow base is zero', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet COMP collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address)).to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });
});
