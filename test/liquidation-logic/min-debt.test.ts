import { ethers, expect, exp, makeProtocol, presentValue, mulPrice, mulFactor, default24Assets, divPrice, CollateralState, makeCollateralStates, seedMarketActivity } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, FaucetToken, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';
import { TotalsBasicStructOutput } from 'build/types/CometExtAssetList';

import { useBlockDelta } from '../helpers/block-clock';

describe('partial liquidation: min debt', function() {
  // Pin one second between blocks so interest accrues deterministically regardless of machine speed.
  useBlockDelta(1);

  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: LiquidationModule;

  const baseTokenPrice = exp(1, 8);
  const initialBaseFunding = baseTokenPrice * 10_000n;
  const baseBorrowMin = exp(10, 6);

  let tokens: { [symbol: string]: FaucetToken } = {};
  let baseToken: FaucetToken;
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  let alice: SignerWithAddress;
  let absorber: SignerWithAddress;
  let pauser: SignerWithAddress;
  let executor: SignerWithAddress;

  const baseScale: bigint = 10n ** 6n;
  const factorScale: bigint = 10n ** 18n;
  const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);

  let targetHealthFactor: bigint;

  let snapshot: SnapshotRestorer;
  let baseSnapshot: SnapshotRestorer;

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
    comet = protocol.comet;
    liquidationModule = protocol.defaultLiquidationModule;
    targetHealthFactor = (await protocol.defaultLiquidationModule.TARGET_HEALTH_FACTOR()).toBigInt();

    for (let asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      tokens[asset] = protocol.tokens[asset] as FaucetToken;
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    baseToken = protocol.tokens['USDC'] as FaucetToken;
    priceFeeds['USDC'] = protocol.priceFeeds['USDC'];

    [alice, absorber] = protocol.users;
    const [bob, dave] = protocol.users.slice(2);
    pauser = protocol.pausers[0];
    executor = protocol.executors[0];

    const allocateAmount = exp(1_000_000, 18);
    for (const token of Object.values(protocol.tokens)) {
      for (const user of [alice]) {
        await (token as FaucetToken).allocateTo(user.address, allocateAmount);
        await (token as FaucetToken).connect(user).approve(comet.address, ethers.constants.MaxUint256);
      }
    }

    await seedMarketActivity(comet, tokens, priceFeeds, bob, dave, baseToken, initialBaseFunding);

    baseSnapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                              TESTS LOGIC
  //////////////////////////////////////////////////////////////*/
  // Note: tests running performs at the end of the file.

  function runMinDebtTests({ partialLiquidationEnabled, viaLiquidationModule }: { partialLiquidationEnabled: boolean, viaLiquidationModule: boolean }) {
    describe(`partialLiquidationEnabled = ${partialLiquidationEnabled} && viaLiquidationModule = ${viaLiquidationModule}`, function() {
      before(async function() {
        // Reset to the clean protocol baseline so state (and the canonical
        // liquidationModule reference) from the previous run does not leak in.
        await baseSnapshot.restore();

        // The module defaults to partialLiquidationEnabled = true; toggling to the
        // value it already holds reverts with LiquidationModeAlreadySet.
        if ((await liquidationModule.partialLiquidationEnabled()) !== partialLiquidationEnabled) {
          await liquidationModule.connect(pauser).liquidationModeToggle(partialLiquidationEnabled);
        }

        if (viaLiquidationModule) {
          await liquidationModule.connect(pauser).setDexRoutePaused(true);
        }

        // sanity check
        expect(await liquidationModule.partialLiquidationEnabled()).to.be.equal(partialLiquidationEnabled);

        snapshot = await takeSnapshot();
      });

      context('1 collateral: debt below min debt and collateral can partially cover it (0 index)', function () {
        const collateralAmount = exp(0.13, 18); // 0.13 COMP, worth $13 before the price drop
        const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
        const repayAmount = exp(0.7, 6); // leaves $9.50 debt, below baseBorrowMin
        const droppedCompPrice = exp(85.9, 8); // collateral value becomes $11.167
    
        const collateralKey = 'COMP';
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
          await comet.connect(alice).supply(baseToken.address, repayAmount);
    
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: alice borrow balance is below baseBorrowMin after repay', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
          expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('min debt branch closes the debt', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          const wantedCollateralValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
          collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, assetInfo.scale);
          collateralsState[collateralKey].seizedValue = debtRemainingValue;
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral event is emitted for partial COMP seizure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address,
            alice.address,
            tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount,
            mulPrice(collateralsState[collateralKey].seizeAmount, droppedCompPrice, assetInfo.scale)
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice collateral balance is reduced by the seized amount', async () => {
          const remaining = collateralAmount - collateralsState[collateralKey].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn does not change because collateral remains', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
    
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
    
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });
    
        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('1 collateral: debt below min debt and collateral can partially cover it (16 index)', function () {
        const ldoAmount = exp(10, 18); // 10 LDO, worth $20 before the price drop
        const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
        const repayAmount = exp(0.7, 6); // leaves $9.50 debt, below baseBorrowMin
        const droppedLdoPrice = exp(1.5, 8); // collateral value becomes $15
    
        const collateralKey = 'LDO';
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          await comet.connect(alice).supply(tokens[collateralKey].address, ldoAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
          await comet.connect(alice).supply(baseToken.address, repayAmount);
    
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedLdoPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: alice borrow balance is below baseBorrowMin after repay', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
          expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('min debt branch can close the debt by partially seizing LDO', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          const wantedCollateralValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
          collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, droppedLdoPrice, assetInfo.scale);
          collateralsState[collateralKey].seizedValue = debtRemainingValue;
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral event is emitted for partial LDO seizure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address,
            alice.address,
            tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount,
            mulPrice(collateralsState[collateralKey].seizeAmount, droppedLdoPrice, assetInfo.scale)
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice collateral balance is reduced by the seized amount', async () => {
          const remaining = ldoAmount - collateralsState[collateralKey].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn does not change because collateral remains', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
    
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
    
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });
    
        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('1 collateral: debt below min debt and collateral can partially cover it (23 index)', function () {
        const sUsdeAmount = exp(15, 18); // 15 sUSDe, worth $15 before the price drop
        const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
        const repayAmount = exp(0.7, 6); // leaves $9.50 debt, below baseBorrowMin
        const droppedSUsdePrice = exp(0.75, 8); // collateral value becomes $11.25
    
        const collateralKey = 'sUSDe';
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          await comet.connect(alice).supply(tokens[collateralKey].address, sUsdeAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
          await comet.connect(alice).supply(baseToken.address, repayAmount);
    
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedSUsdePrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: alice borrow balance is below baseBorrowMin after repay', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
          expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('min debt branch can close the debt by partially seizing sUSDe', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          const wantedCollateralValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
          collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, droppedSUsdePrice, assetInfo.scale);
          collateralsState[collateralKey].seizedValue = debtRemainingValue;
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral event is emitted for partial sUSDe seizure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address,
            alice.address,
            tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount,
            mulPrice(collateralsState[collateralKey].seizeAmount, droppedSUsdePrice, assetInfo.scale)
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice collateral balance is reduced by the seized amount', async () => {
          const remaining = sUsdeAmount - collateralsState[collateralKey].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn does not change because collateral remains', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
    
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
    
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });
    
        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      // Debt is below baseBorrowMin from the very first absorb iteration (borrow then partial repay), so
      // absorb enters _processDebtClosing immediately.
      context('multi-collateral: debt below min debt from the start, first collateral fully seized then second closes it (asset indexes 5 and 16)', function () {
        const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
        const repayAmount = exp(0.7, 6);   // leaves $9.50 debt, below baseBorrowMin
        const collateralConfigs = [
          { symbol: 'wstETH', amount: exp(0.002, 18), droppedPrice: exp(1500, 8) }, // $7.20 → $3, fully seized
          { symbol: 'LDO',    amount: exp(5, 18),     droppedPrice: exp(2, 8) },     // $10, closes the remainder
        ];
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
          await comet.connect(alice).supply(baseToken.address, repayAmount);
    
          for (const config of collateralConfigs) {
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is below min debt after the partial repay', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
          expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
        });
    
        it('sanity check: the first collateral cannot cover the debt, so it is fully seized and the second closes the remainder', async () => {
          const firstInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const firstPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const secondInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const secondPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const firstCollateralValueLeft = mulFactor(mulPrice(collateralConfigs[0].amount, firstPrice, firstInfo.scale), firstInfo.liquidationFactor);
          const secondCollateralValueLeft = mulFactor(mulPrice(collateralConfigs[1].amount, secondPrice, secondInfo.scale), secondInfo.liquidationFactor);
    
          expect(debtValue).to.be.greaterThan(firstCollateralValueLeft);          // first cannot cover → full seizure
          expect(debtValue - firstCollateralValueLeft).to.be.lessThan(secondCollateralValueLeft); // second covers the remainder
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: first collateral fully seized, second closes the sub-min debt', async () => {
          const firstInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const firstPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const secondInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const secondPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // First collateral cannot cover the debt → fully seized, repaying its liquidation value.
          const firstSeizedValue = mulFactor(mulPrice(collateralConfigs[0].amount, firstPrice, firstInfo.scale), firstInfo.liquidationFactor);
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
    
          // Second collateral closes the remaining debt.
          const remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - firstSeizedValue;
          const wantedSecondValue = remainingDebt * factorScale / secondInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedSecondValue, secondPrice, secondInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral seizes all of the first collateral', async () => {
          const firstInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const firstPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const firstCollateralValue = mulPrice(collateralConfigs[0].amount, firstPrice, firstInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address,
            collateralsState[collateralConfigs[0].symbol].seizeAmount, firstCollateralValue
          );
        });
    
        it('AbsorbCollateral partially seizes the second collateral to close the debt', async () => {
          const secondInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const secondPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const secondSeizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, secondPrice, secondInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address,
            collateralsState[collateralConfigs[1].symbol].seizeAmount, secondSeizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice first collateral balance is zero after full seizure', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
        });
    
        it('alice second collateral balance is reduced by the seized amount and still positive', async () => {
          const remaining = collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn clears the first collateral (wstETH index 5)', async () => {
          // wstETH (index 5) lives in assetsIn and is fully seized; LDO (index 16) lives in _reserved.
          expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved bits do not change because the second collateral remains', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address))
              .to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('multi-collateral: debt below min debt from the start, first four fully seized then the last closes it (asset indexes 1, 5, 13, 17, 21)', function () {
        const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
        const repayAmount = exp(0.7, 6);   // leaves $9.50 debt, below baseBorrowMin
        const collateralConfigs = [
          { symbol: 'WETH',   amount: exp(0.0005, 18),  droppedPrice: exp(2000, 8) }, // $1.00
          { symbol: 'wstETH', amount: exp(0.0003, 18),  droppedPrice: exp(3600, 8) }, // $1.08
          { symbol: 'LINK',   amount: exp(0.07, 18),    droppedPrice: exp(15, 8) },   // $1.05
          { symbol: 'CRV',    amount: exp(1, 18),       droppedPrice: exp(1, 8) },    // $1.00
          { symbol: 'GMX',    amount: exp(0.4, 18),     droppedPrice: exp(25, 8) },   // $16 → $10, closes the remainder
        ];
        const fullSeizureCount = 4;
        const partialIndex = 4; // GMX
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
          await comet.connect(alice).supply(baseToken.address, repayAmount);
    
          for (const config of collateralConfigs) {
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is below min debt after the partial repay', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
          expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
        });
    
        it('sanity check: the first four collaterals cannot cover the debt, so they are fully seized and the last closes the remainder', async () => {
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            remainingDebt -= mulFactor(mulPrice(config.amount, price, scale), liquidationFactor);
          }
    
          // The four dust collaterals leave a positive debt that the last collateral covers.
          const lastInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const lastPrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const lastCollateralValueLeft = mulFactor(mulPrice(collateralConfigs[partialIndex].amount, lastPrice, lastInfo.scale), lastInfo.liquidationFactor);
          expect(remainingDebt).to.be.lessThan(lastCollateralValueLeft);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: first four fully seized, GMX closes the sub-min debt', async () => {
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            collateralsState[config.symbol].seizeAmount = config.amount;
            remainingDebt -= mulFactor(mulPrice(config.amount, price, assetInfo.scale), assetInfo.liquidationFactor);
          }
    
          const gmxInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const gmxPrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const wantedGmxValue = remainingDebt * factorScale / gmxInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount = divPrice(wantedGmxValue, gmxPrice, gmxInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        for (let i = 0; i < fullSeizureCount; i++) {
          it(`AbsorbCollateral seizes all ${collateralConfigs[i].symbol}`, async () => {
            const config = collateralConfigs[i];
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address, alice.address, tokens[config.symbol].address, config.amount, collateralValue
            );
          });
        }
    
        it('AbsorbCollateral partially seizes GMX to close the debt', async () => {
          const gmxInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const gmxPrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const gmxSeizedValue = mulPrice(collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount, gmxPrice, gmxInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[partialIndex].symbol].address,
            collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount, gmxSeizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        for (let i = 0; i < fullSeizureCount; i++) {
          it(`alice ${collateralConfigs[i].symbol} collateral balance is zero after full seizure`, async () => {
            expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[i].symbol].address)).to.be.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[i].symbol].address)).balance).to.be.equal(0);
          });
        }
    
        it('alice GMX collateral balance is reduced by the seized amount and still positive', async () => {
          const remaining = collateralConfigs[partialIndex].amount - collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn is cleared (WETH, wstETH, LINK fully seized)', async () => {
          // WETH (1), wstETH (5) and LINK (13) live in assetsIn; all are fully seized.
          expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved keeps only GMX after CRV is fully seized', async () => {
          // CRV is index 17 → _reserved bit 1 (cleared); GMX is index 21 → bit 5 (kept, surplus remains).
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore & ~(1 << (17 - 16)));
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address))
              .to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('multi-collateral: debt below min debt from the start, first 23 fully seized then sUSDe closes it (all asset indexes 0-23)', function () {
        const borrowAmount = exp(10.2, 6); // $10.20, initially above baseBorrowMin
        const repayAmount = exp(0.7, 6);   // leaves $9.50 debt, below baseBorrowMin
    
        // priceDrop is the percentage numerator applied to the live price (75 = drop 25%, 80 = drop 20%).
        const collateralConfigs = [
          { symbol: 'COMP',   amount: exp(0.001, 18),     priceDrop: 75n }, // ~$0.10
          { symbol: 'WETH',   amount: exp(0.00005, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'USDT',   amount: exp(0.1, 6),        priceDrop: 75n }, // ~$0.10
          { symbol: 'WBTC',   amount: exp(0.000002, 8),   priceDrop: 75n }, // ~$0.13
          { symbol: 'DAI',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'wstETH', amount: exp(0.000028, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'rsETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'cbETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'rETH',   amount: exp(0.000029, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'weETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'ezETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'cbBTC',  amount: exp(0.000002, 8),   priceDrop: 75n }, // ~$0.13
          { symbol: 'tBTC',   amount: exp(0.000002, 18),  priceDrop: 75n }, // ~$0.13
          { symbol: 'LINK',   amount: exp(0.006667, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'UNI',    amount: exp(0.0125, 18),    priceDrop: 75n }, // ~$0.10
          { symbol: 'AAVE',   amount: exp(0.001, 18),     priceDrop: 75n }, // ~$0.10
          { symbol: 'LDO',    amount: exp(0.05, 18),      priceDrop: 75n }, // ~$0.10
          { symbol: 'CRV',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'MKR',    amount: exp(0.00004, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'ARB',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'OP',     amount: exp(0.05, 18),      priceDrop: 75n }, // ~$0.10
          { symbol: 'GMX',    amount: exp(0.0025, 18),    priceDrop: 75n }, // ~$0.10
          { symbol: 'USDe',   amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'sUSDe',  amount: exp(13, 18),        priceDrop: 70n }, // $13 → $9.10, closes the remainder
        ];
        const fullSeizureCount = 23;
        const partialIndex = 23; // sUSDe
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
          await comet.connect(alice).supply(baseToken.address, repayAmount);
    
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is below min debt after the partial repay', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount - repayAmount);
          expect(await comet.borrowBalanceOf(alice.address)).to.be.lessThan(baseBorrowMin);
        });
    
        it('sanity check: the first 23 collaterals cannot cover the debt, so they are fully seized and sUSDe closes the remainder', async () => {
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            remainingDebt -= mulFactor(mulPrice(config.amount, price, scale), liquidationFactor);
          }
    
          // The 23 dust collaterals leave a positive debt that sUSDe covers.
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const sUsdePrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const sUsdeCollateralValueLeft = mulFactor(mulPrice(collateralConfigs[partialIndex].amount, sUsdePrice, sUsdeInfo.scale), sUsdeInfo.liquidationFactor);
          expect(remainingDebt).to.be.lessThan(sUsdeCollateralValueLeft);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: first 23 fully seized, sUSDe closes the sub-min debt', async () => {
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            collateralsState[config.symbol].seizeAmount = config.amount;
            remainingDebt -= mulFactor(mulPrice(config.amount, price, assetInfo.scale), assetInfo.liquidationFactor);
          }
    
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const sUsdePrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const wantedSUsdeValue = remainingDebt * factorScale / sUsdeInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount = divPrice(wantedSUsdeValue, sUsdePrice, sUsdeInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        for (let i = 0; i < fullSeizureCount; i++) {
          it(`alice ${collateralConfigs[i].symbol} collateral balance is zero after full seizure`, async () => {
            expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[i].symbol].address)).to.be.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[i].symbol].address)).balance).to.be.equal(0);
          });
        }
    
        it('alice sUSDe collateral balance is reduced by the seized amount and still positive', async () => {
          const remaining = collateralConfigs[partialIndex].amount - collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn is cleared (asset indexes 0-15 fully seized)', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved keeps only sUSDe after assets 16-22 are fully seized', async () => {
          // Asset indexes 16-22 (LDO..USDe) live in _reserved and are fully seized; sUSDe (index 23 → bit 7) is kept.
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore & (1 << (23 - 16)));
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address))
              .to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      // Note: this flow proves that the baseBorrowMin branch can be reached after
      // an earlier collateral is fully seized in the same absorb cycle.
      context('multi-collateral: first collateral fully seized, second collateral closes debt below min debt (asset indexes 0 and 1)', function () {
        const droppedWethPrice = exp(1500, 8); // WETH value becomes $12
        const collateralConfigs = [
          { symbol: 'COMP', amount: exp(0.1, 18) },   // 0.1 COMP, worth $10
          { symbol: 'WETH', amount: exp(0.008, 18) },  // 0.008 WETH, worth $16 before the price drop
        ];
        const borrowAmount = exp(18.5, 6); // leaves $9.50 debt after COMP full seizure
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralConfigs[1].symbol].connect(alice).setRoundData(0, droppedWethPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: debt after the first collateral is fully seized is below min debt', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const firstSeizedValue = mulFactor(mulPrice(collateralConfigs[0].amount, compPrice, scale), liquidationFactor);
    
          expect(debtValue - firstSeizedValue).to.be.lessThan(minDebtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates COMP full seizure values', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const compCollateralValue = mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale);
    
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
          collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);
        });
    
        it('calculates WETH partial seizure values through the min debt branch', async () => {
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // COMP full seizure leaves a sub-min debt that WETH closes via _processDebtClosing.
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;
          const wantedWethCollateralValue = debtRemainingValue * factorScale / wethInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral seizes all COMP', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const compCollateralValue = mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address,
            collateralsState[collateralConfigs[0].symbol].seizeAmount, compCollateralValue
          );
        });
    
        it('AbsorbCollateral partially seizes WETH to close min debt', async () => {
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const wethSeizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, wethPrice, wethInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address,
            collateralsState[collateralConfigs[1].symbol].seizeAmount, wethSeizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice COMP collateral balance is zero', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
        });
    
        it('alice WETH collateral balance is reduced by the seized amount', async () => {
          const remaining = collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn keeps only WETH', async () => {
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
    
          expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(1 << wethInfo.offset);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        for (const config of collateralConfigs) {
          it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
            expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
          });
        }
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('multi-collateral: first collateral fully seized, second collateral closes debt below min debt (asset indexes 15 and 16)', function () {
        const droppedLdoPrice = exp(1.5, 8);  // LDO drops to $1.50
        const collateralConfigs = [
          { symbol: 'AAVE', amount: exp(0.1, 18) },   // 0.1 AAVE = $10
          { symbol: 'LDO', amount: exp(10, 18) },      // 10 LDO = $20 initial, $15 after drop
        ];
        const borrowAmount = exp(16.5, 6);    // $16.50
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralConfigs[1].symbol].connect(alice).setRoundData(0, droppedLdoPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: debt after the first collateral is fully seized is below min debt', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const firstSeizedValue = mulFactor(mulPrice(collateralConfigs[0].amount, aavePrice, scale), liquidationFactor);
    
          expect(debtValue - firstSeizedValue).to.be.lessThan(minDebtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates AAVE full seizure values', async () => {
          const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const aaveCollateralValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);
    
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
          collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(aaveCollateralValue, aaveInfo.liquidationFactor);
        });
    
        it('calculates LDO partial seizure values through the min debt branch', async () => {
          const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // AAVE full seizure leaves a sub-min debt that LDO closes via _processDebtClosing.
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;
          const wantedLdoCollateralValue = debtRemainingValue * factorScale / ldoInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedLdoCollateralValue, ldoPrice, ldoInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral seizes all AAVE', async () => {
          const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const aaveCollateralValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address,
            collateralsState[collateralConfigs[0].symbol].seizeAmount, aaveCollateralValue
          );
        });
    
        it('AbsorbCollateral partially seizes LDO to close min debt', async () => {
          const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const ldoSeizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, ldoPrice, ldoInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address,
            collateralsState[collateralConfigs[1].symbol].seizeAmount, ldoSeizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice AAVE collateral balance is zero', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
        });
    
        it('alice LDO collateral balance is reduced by the seized amount', async () => {
          const remaining = collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn is empty after AAVE is fully seized', async () => {
          // AAVE (index 15) was the only assetsIn asset; LDO (index 16) is tracked in _reserved.
          expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved bits do not change because LDO remains', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        for (const config of collateralConfigs) {
          it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
            expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
          });
        }
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('multi-collateral: first collateral fully seized, second collateral closes debt below min debt (asset indexes 22 and 23)', function () {
        const droppedSUsdePrice = exp(0.6, 8);   // sUSDe drops to $0.60
        const collateralConfigs = [
          { symbol: 'USDe', amount: exp(15, 18) },   // $15
          { symbol: 'sUSDe', amount: exp(20, 18) },  // $20 initial, $12 after drop
        ];
        const borrowAmount = exp(23, 6);         // $23.00
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralConfigs[1].symbol].connect(alice).setRoundData(0, droppedSUsdePrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: debt after the first collateral is fully seized is below min debt', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const usdePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const firstSeizedValue = mulFactor(mulPrice(collateralConfigs[0].amount, usdePrice, scale), liquidationFactor);
    
          expect(debtValue - firstSeizedValue).to.be.lessThan(minDebtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates USDe full seizure values', async () => {
          const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const usdePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const usdeCollateralValue = mulPrice(collateralConfigs[0].amount, usdePrice, usdeInfo.scale);
    
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
          collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(usdeCollateralValue, usdeInfo.liquidationFactor);
        });
    
        it('calculates sUSDe partial seizure values through the min debt branch', async () => {
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const sUsdePrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // USDe full seizure leaves a sub-min debt that sUSDe closes via _processDebtClosing.
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;
          const wantedSUsdeCollateralValue = debtRemainingValue * factorScale / sUsdeInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedSUsdeCollateralValue, sUsdePrice, sUsdeInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral seizes all USDe', async () => {
          const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const usdePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const usdeCollateralValue = mulPrice(collateralConfigs[0].amount, usdePrice, usdeInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address,
            collateralsState[collateralConfigs[0].symbol].seizeAmount, usdeCollateralValue
          );
        });
    
        it('AbsorbCollateral partially seizes sUSDe to close min debt', async () => {
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const sUsdePrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const sUsdeSeizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, sUsdePrice, sUsdeInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address,
            collateralsState[collateralConfigs[1].symbol].seizeAmount, sUsdeSeizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice USDe collateral balance is zero', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
        });
    
        it('alice sUSDe collateral balance is reduced by the seized amount', async () => {
          const remaining = collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(remaining);
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
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        for (const config of collateralConfigs) {
          it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
            expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
          });
        }
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('multi-collateral: 5 non-adjacent collaterals, first four fully seized then USDe closes debt below min debt (asset indexes 4, 8, 12, 18, 22)', function () {
        const borrowAmount = exp(11, 6); // $11, above baseBorrowMin $10
    
        const collateralConfigs = [
          { symbol: 'DAI',  amount: exp(2, 18),       droppedPrice: exp(0.5, 8) },   // $2.00 → $1.00
          { symbol: 'rETH', amount: exp(0.0005, 18),  droppedPrice: exp(1750, 8) },  // $1.75 → $0.875
          { symbol: 'tBTC', amount: exp(0.00002, 18), droppedPrice: exp(32500, 8) }, // $1.30 → $0.65
          { symbol: 'MKR',  amount: exp(0.001, 18),   droppedPrice: exp(1250, 8) },  // $2.50 → $1.25
          { symbol: 'USDe', amount: exp(13, 18),      droppedPrice: exp(0.7, 8) },   // $13.00 → $9.10
        ];
        const fullSeizureCount = 4; // DAI, rETH, tBTC, MKR
        const partialIndex = 4;     // USDe
    
        let collateralsState: Record<string, CollateralState>;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
        let innerSnapshot: SnapshotRestorer;
    
        before(async function () {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          // Drop every collateral so the LCF-weighted value falls below the debt.
          for (const config of collateralConfigs) {
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
    
          innerSnapshot = await takeSnapshot();
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: debt after the first four collaterals are fully seized is below min debt', async () => {
          let debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            debtValue -= mulFactor(mulPrice(config.amount, config.droppedPrice, scale), liquidationFactor);
          }
    
          expect(debtValue).to.be.lessThan(minDebtValue);
        });
    
        // This context focuses on contract storage and state after absorb.
        context('storage: first four fully seized, USDe partially seized to close debt below min debt', function () {
          let absorbTx: ContractTransaction;
    
          after(async () => await innerSnapshot.restore());
    
          it('absorb is successful', async () => {
            absorbTx = viaLiquidationModule
              ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
              : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
            await expect(absorbTx).to.not.be.reverted;
          });
    
          it('calculates seize amounts: first four fully seized, USDe partial closes the debt', async () => {
            let debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
            for (let i = 0; i < fullSeizureCount; i++) {
              const config = collateralConfigs[i];
              const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
              const collateralValue = mulPrice(config.amount, config.droppedPrice, assetInfo.scale);
    
              collateralsState[config.symbol].seizeAmount = config.amount;
              debtRemainingValue -= mulFactor(collateralValue, assetInfo.liquidationFactor);
            }
    
            // The sub-min debt that remains is closed from USDe via _processDebtClosing.
            const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
            const usdePrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
            const wantedUsdeCollateralValue = debtRemainingValue * factorScale / usdeInfo.liquidationFactor.toBigInt();
            collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount = divPrice(wantedUsdeCollateralValue, usdePrice, usdeInfo.scale);
          });
    
          // User base balances
          it('alice principal is zero after absorb', async () => {
            expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
          });
    
          it('alice borrow balance is zero after absorb', async () => {
            expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
          });
    
          it('alice simple base balance is zero after absorb', async () => {
            expect(await comet.balanceOf(alice.address)).to.be.equal(0);
          });
    
          // User collateral state
          for (let i = 0; i < fullSeizureCount; i++) {
            it(`alice ${collateralConfigs[i].symbol} collateral balance is zero after full seizure`, async () => {
              expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[i].symbol].address)).to.be.equal(0);
              expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[i].symbol].address)).balance).to.be.equal(0);
            });
          }
    
          it('alice USDe collateral balance is reduced by the seized amount and still positive', async () => {
            const remaining = collateralConfigs[partialIndex].amount - collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount;
            expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).to.be.equal(remaining);
            expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).balance).to.be.equal(remaining);
          });
    
          it('alice assetsIn is cleared (DAI, rETH, tBTC fully seized)', async () => {
            // DAI (4), rETH (8) and tBTC (12) live in assetsIn (uint16); all are fully seized.
            expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
            expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
          });
    
          it('alice reserved keeps only USDe after MKR is fully seized', async () => {
            // MKR is asset index 18 → _reserved bit 2 (cleared); USDe is index 22 → bit 6 (kept, surplus remains).
            expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore & ~(1 << (18 - 16)));
          });
    
          // Comet borrow state
          it('comet total borrow base is reduced by the base paid out on absorb', async () => {
            expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
          for (const config of collateralConfigs) {
            it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
              expect(await comet.getCollateralReserves(tokens[config.symbol].address))
                .to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
            });
          }
    
          it('comet base reserves are reduced by the base paid out', async () => {
            // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
            expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
          });
        });
    
        // This context focuses only on event emission during absorb.
        context('events: AbsorbCollateral per collateral and AbsorbDebt', function () {
          let absorbTx: ContractTransaction;
          let debtRemainingValue: bigint;
    
          before(async () => {
            await innerSnapshot.restore();
            debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          });
          after(async () => await innerSnapshot.restore());
    
          it('absorb is successful', async () => {
            absorbTx = viaLiquidationModule
              ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
              : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
            await expect(absorbTx).to.not.be.reverted;
          });
    
          it('emits AbsorbDebt for the full absorbed debt', async () => {
            // newBalance is zero, so basePaidOut = -balanceBefore
            const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
          });
    
          for (let i = 0; i < fullSeizureCount; i++) {
            it(`emits AbsorbCollateral for ${collateralConfigs[i].symbol} full seizure`, async () => {
              const config = collateralConfigs[i];
              const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
              const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
              const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
    
              await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
                absorber.address, alice.address, tokens[config.symbol].address, config.amount, collateralValue
              );
              debtRemainingValue -= mulFactor(collateralValue, assetInfo.liquidationFactor);
            });
          }
    
          it('emits AbsorbCollateral for USDe partial seizure that closes the debt', async () => {
            const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
            const usdePrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
    
            // remaining debt is below minDebt, so _processDebtClosing seizes exactly debt / LF of USDe.
            const wantedUsdeCollateralValue = debtRemainingValue * factorScale / usdeInfo.liquidationFactor.toBigInt();
            const usdeSeizeAmount = divPrice(wantedUsdeCollateralValue, usdePrice, usdeInfo.scale);
            const usdeSeizedValue = mulPrice(usdeSeizeAmount, usdePrice, usdeInfo.scale);
    
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address, alice.address, tokens[collateralConfigs[partialIndex].symbol].address, usdeSeizeAmount, usdeSeizedValue
            );
          });
        });
      });
    
      // Debt starts above baseBorrowMin (normal debt). All 24 collaterals: the first 23 are dust and each is
      // fully seized, and somewhere in that cycle the debt crosses below baseBorrowMin. sUSDe (index 23, last)
      // then closes the remaining sub-min debt and keeps a surplus. AbsorbCollateral events are not asserted here.
      context('multi-collateral: normal debt, first 23 fully seized dropping debt below min then sUSDe closes it (all asset indexes 0-23)', function () {
        const borrowAmount = exp(11, 6); // $11, above baseBorrowMin $10
    
        // priceDrop is the percentage numerator applied to the live price (75 = drop 25%, 80 = drop 20%).
        const collateralConfigs = [
          { symbol: 'COMP',   amount: exp(0.001, 18),     priceDrop: 75n }, // ~$0.10
          { symbol: 'WETH',   amount: exp(0.00005, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'USDT',   amount: exp(0.1, 6),        priceDrop: 75n }, // ~$0.10
          { symbol: 'WBTC',   amount: exp(0.000002, 8),   priceDrop: 75n }, // ~$0.13
          { symbol: 'DAI',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'wstETH', amount: exp(0.000028, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'rsETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'cbETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'rETH',   amount: exp(0.000029, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'weETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'ezETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'cbBTC',  amount: exp(0.000002, 8),   priceDrop: 75n }, // ~$0.13
          { symbol: 'tBTC',   amount: exp(0.000002, 18),  priceDrop: 75n }, // ~$0.13
          { symbol: 'LINK',   amount: exp(0.006667, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'UNI',    amount: exp(0.0125, 18),    priceDrop: 75n }, // ~$0.10
          { symbol: 'AAVE',   amount: exp(0.001, 18),     priceDrop: 75n }, // ~$0.10
          { symbol: 'LDO',    amount: exp(0.05, 18),      priceDrop: 75n }, // ~$0.10
          { symbol: 'CRV',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'MKR',    amount: exp(0.00004, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'ARB',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'OP',     amount: exp(0.05, 18),      priceDrop: 75n }, // ~$0.10
          { symbol: 'GMX',    amount: exp(0.0025, 18),    priceDrop: 75n }, // ~$0.10
          { symbol: 'USDe',   amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'sUSDe',  amount: exp(14, 18),        priceDrop: 80n }, // $14 → $11.20, closes the remainder
        ];
        const fullSeizureCount = 23;
        const partialIndex = 23; // sUSDe
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt at the start', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: the first 23 full seizures drop the debt below min debt and sUSDe covers the remainder', async () => {
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            remainingDebt -= mulFactor(mulPrice(config.amount, price, scale), liquidationFactor);
          }
    
          // After the 23 full seizures the debt has crossed below minDebt but is still positive, so sUSDe closes it.
          expect(remainingDebt).to.be.lessThan(minDebtValue);
          expect(remainingDebt).to.be.greaterThan(0);
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const sUsdePrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const sUsdeCollateralValueLeft = mulFactor(mulPrice(collateralConfigs[partialIndex].amount, sUsdePrice, sUsdeInfo.scale), sUsdeInfo.liquidationFactor);
          expect(remainingDebt).to.be.lessThan(sUsdeCollateralValueLeft);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: first 23 fully seized, sUSDe closes the sub-min debt', async () => {
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            collateralsState[config.symbol].seizeAmount = config.amount;
            remainingDebt -= mulFactor(mulPrice(config.amount, price, assetInfo.scale), assetInfo.liquidationFactor);
          }
    
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const sUsdePrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const wantedSUsdeValue = remainingDebt * factorScale / sUsdeInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount = divPrice(wantedSUsdeValue, sUsdePrice, sUsdeInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        for (let i = 0; i < fullSeizureCount; i++) {
          it(`alice ${collateralConfigs[i].symbol} collateral balance is zero after full seizure`, async () => {
            expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[i].symbol].address)).to.be.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[i].symbol].address)).balance).to.be.equal(0);
          });
        }
    
        it('alice sUSDe collateral balance is reduced by the seized amount and still positive', async () => {
          const remaining = collateralConfigs[partialIndex].amount - collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn is cleared (asset indexes 0-15 fully seized)', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved keeps only sUSDe after assets 16-22 are fully seized', async () => {
          // Asset indexes 16-22 (LDO..USDe) live in _reserved and are fully seized; sUSDe (index 23 → bit 7) is kept.
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore & (1 << (23 - 16)));
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address))
              .to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
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
    
        const collateralKey = 'COMP';
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: reducing debt only to min debt would leave health below target, so the debt is closed fully', async () => {
          const { scale, liquidationFactor, borrowCollateralFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const collateralValue = mulPrice(collateralAmount, droppedCompPrice, scale);
    
          // Pay the debt down only to minDebt: that frees deltaCollateral of collateral. If the resulting
          // health factor is still below target, reaching target needs the debt below minDebt → guard fires.
          const deltaCollateral = (debtValue - minDebtValue) * factorScale / liquidationFactor.toBigInt();
          const expectedHF = mulFactor(collateralValue - deltaCollateral, borrowCollateralFactor) * factorScale / minDebtValue;
    
          expect(expectedHF).to.be.lessThan(targetHealthFactor);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates the full-close seize amount', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
    
          // The guard closes the debt fully: seizeAmount = divPrice(debt * FACTOR_SCALE / LF, price, scale).
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const seize = debtRemainingValue * factorScale / liquidationFactor.toBigInt();
          collateralsState[collateralKey].seizeAmount = divPrice(seize, droppedCompPrice, scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral event is emitted for partial COMP seizure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const seizedValue = mulPrice(collateralsState[collateralKey].seizeAmount, droppedCompPrice, assetInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount, seizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice collateral balance is reduced by the seized amount with leftover remaining', async () => {
          const remainingCollateral = collateralAmount - collateralsState[collateralKey].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(remainingCollateral);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(remainingCollateral);
        });
    
        it('alice assetsIn does not change because collateral remains', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
    
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount but remains positive', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
    
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });
    
        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('1 collateral: formula gives partial seizure but guard fires because S*LF leaves debt below minDebt, closes debt fully (16 index)', function () {
        const collateralAmount = exp(14, 18);      // 14 LDO = $28 initial
        const borrowAmount = exp(15, 6);           // $15, above baseBorrowMin of $10
        const droppedLdoPrice = exp(1.4, 8);       // $1.40 → collateralValue = $19.60
    
        const collateralKey = 'LDO';
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedLdoPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: reducing debt only to min debt would leave health below target, so the debt is closed fully', async () => {
          const { scale, liquidationFactor, borrowCollateralFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const collateralValue = mulPrice(collateralAmount, droppedLdoPrice, scale);
    
          // Pay the debt down only to minDebt: that frees deltaCollateral of collateral. If the resulting
          // health factor is still below target, reaching target needs the debt below minDebt → guard fires.
          const deltaCollateral = (debtValue - minDebtValue) * factorScale / liquidationFactor.toBigInt();
          const expectedHF = mulFactor(collateralValue - deltaCollateral, borrowCollateralFactor) * factorScale / minDebtValue;
    
          expect(expectedHF).to.be.lessThan(targetHealthFactor);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates the full-close seize amount', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
    
          // The guard closes the debt fully: seizeAmount = divPrice(debt * FACTOR_SCALE / LF, price, scale).
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const seize = debtRemainingValue * factorScale / liquidationFactor.toBigInt();
          collateralsState[collateralKey].seizeAmount = divPrice(seize, droppedLdoPrice, scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral event is emitted for partial LDO seizure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const seizedValue = mulPrice(collateralsState[collateralKey].seizeAmount, droppedLdoPrice, assetInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount, seizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice collateral balance is reduced by the seized amount with leftover remaining', async () => {
          const remainingCollateral = collateralAmount - collateralsState[collateralKey].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(remainingCollateral);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(remainingCollateral);
        });
    
        it('alice assetsIn does not change because collateral remains', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
    
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount but remains positive', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
    
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });
    
        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('1 collateral: formula gives partial seizure but guard fires because S*LF leaves debt below minDebt, closes debt fully (23 index)', function () {
        const collateralAmount = exp(21, 18);      // 21 sUSDe = $21 initial
        const borrowAmount = exp(15, 6);           // $15, above baseBorrowMin of $10
        const droppedSUsdePrice = exp(0.85, 8);    // $0.85 → collateralValue = $17.85
    
        const collateralKey = 'sUSDe';
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedSUsdePrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: reducing debt only to min debt would leave health below target, so the debt is closed fully', async () => {
          const { scale, liquidationFactor, borrowCollateralFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const collateralValue = mulPrice(collateralAmount, droppedSUsdePrice, scale);
    
          // Pay the debt down only to minDebt: that frees deltaCollateral of collateral. If the resulting
          // health factor is still below target, reaching target needs the debt below minDebt → guard fires.
          const deltaCollateral = (debtValue - minDebtValue) * factorScale / liquidationFactor.toBigInt();
          const expectedHF = mulFactor(collateralValue - deltaCollateral, borrowCollateralFactor) * factorScale / minDebtValue;
    
          expect(expectedHF).to.be.lessThan(targetHealthFactor);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates the full-close seize amount', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
    
          // The guard closes the debt fully: seizeAmount = divPrice(debt * FACTOR_SCALE / LF, price, scale).
          const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const seize = debtRemainingValue * factorScale / liquidationFactor.toBigInt();
          collateralsState[collateralKey].seizeAmount = divPrice(seize, droppedSUsdePrice, scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral event is emitted for partial sUSDe seizure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const seizedValue = mulPrice(collateralsState[collateralKey].seizeAmount, droppedSUsdePrice, assetInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount, seizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice collateral balance is reduced by the seized amount with leftover remaining', async () => {
          const remainingCollateral = collateralAmount - collateralsState[collateralKey].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(remainingCollateral);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(remainingCollateral);
        });
    
        it('alice assetsIn does not change because collateral remains', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
    
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount but remains positive', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
    
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });
    
        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      // Note: this flow proves the minDebt guard inside the formula branch survives a preceding
      // full seizure. COMP is fully seized (formula demands more than available), leaving
      // remaining debt of $11 — above baseBorrowMin — so Branch A does not fire on WETH.
      // WETH enters the formula path, the guard fires because S*LF leaves $2.33 dust,
      // and _processDebtClosing case 1 closes the debt fully. Alice retains leftover WETH.
      context('2 collaterals: first fully seized then second formula gives partial seizure but guard fires because S*LF leaves debt at or under minDebt, closes debt fully (index 0 and 1)', function () {
        const droppedWethPrice = exp(1500, 8); // $1500 → wethValue = $13.05
        const collateralConfigs = [
          { symbol: 'COMP', amount: exp(0.1, 18) },     // $10
          { symbol: 'WETH', amount: exp(0.0087, 18) },  // 0.0087 WETH; dropped $1500 → $13.05
        ];
        const borrowAmount = exp(20, 6);       // $20, above baseBorrowMin of $10
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralConfigs[1].symbol].connect(alice).setRoundData(0, droppedWethPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is above the minimum debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: after the first collateral is fully seized, reducing debt only to min debt leaves health below target, so the debt is closed fully', async () => {
          const firstInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const firstPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const secondInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const secondPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // The first collateral is fully seized, reducing the debt by its LF-weighted value.
          const firstCollateralValue = mulPrice(collateralConfigs[0].amount, firstPrice, firstInfo.scale);
          const remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - mulFactor(firstCollateralValue, firstInfo.liquidationFactor);
    
          // Pay the remaining debt down only to minDebt using the second collateral. If health stays below
          // target, reaching target needs the debt below minDebt → guard fires and the debt is closed fully.
          const secondCollateralValue = mulPrice(collateralConfigs[1].amount, secondPrice, secondInfo.scale);
          const deltaCollateral = (remainingDebt - minDebtValue) * factorScale / secondInfo.liquidationFactor.toBigInt();
          const expectedHF = mulFactor(secondCollateralValue - deltaCollateral, secondInfo.borrowCollateralFactor) * factorScale / minDebtValue;
    
          expect(expectedHF).to.be.lessThan(targetHealthFactor);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: COMP fully seized, WETH full close', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // COMP is fully seized; the remaining debt is closed fully from WETH.
          const compCollateralValue = mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale);
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
    
          const remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - mulFactor(compCollateralValue, compInfo.liquidationFactor);
          const wantedWethValue = remainingDebt * factorScale / wethInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethValue, wethPrice, wethInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral seizes all COMP', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const compCollateralValue = mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address,
            collateralsState[collateralConfigs[0].symbol].seizeAmount, compCollateralValue
          );
        });
    
        it('AbsorbCollateral partially seizes WETH to close remaining debt', async () => {
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const wethSeizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, wethPrice, wethInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address,
            collateralsState[collateralConfigs[1].symbol].seizeAmount, wethSeizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice COMP collateral balance is zero after full seizure', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
        });
    
        it('alice WETH collateral balance is reduced by the seized amount with leftover remaining', async () => {
          const remainingWeth = collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(remainingWeth);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(remainingWeth);
        });
    
        it('alice assetsIn no longer contains COMP after full seizure', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          expect((await comet.userBasic(alice.address)).assetsIn & (1 << compInfo.offset)).to.be.equal(0);
        });
    
        it('alice assetsIn still contains WETH because collateral remains', async () => {
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          expect((await comet.userBasic(alice.address)).assetsIn & (1 << wethInfo.offset)).to.not.be.equal(0);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        for (const config of collateralConfigs) {
          it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
            expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
          });
        }
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('2 collaterals: first fully seized then second formula gives partial seizure but guard fires because S*LF leaves debt at or under minDebt, closes debt fully (index 15 and 16)', function () {
        const droppedAavePrice = exp(40, 8);    // $40 → aaveValue = $4
        const collateralConfigs = [
          { symbol: 'AAVE', amount: exp(0.1, 18) },  // 0.1 AAVE = $10 initial
          { symbol: 'LDO', amount: exp(13, 18) },    // 13 LDO = $26 at $2
        ];
        const borrowAmount = exp(20, 6);        // $20, above baseBorrowMin of $10
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedAavePrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is above the minimum debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: after the first collateral is fully seized, reducing debt only to min debt leaves health below target, so the debt is closed fully', async () => {
          const firstInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const firstPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const secondInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const secondPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // The first collateral is fully seized, reducing the debt by its LF-weighted value.
          const firstCollateralValue = mulPrice(collateralConfigs[0].amount, firstPrice, firstInfo.scale);
          const remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - mulFactor(firstCollateralValue, firstInfo.liquidationFactor);
    
          // Pay the remaining debt down only to minDebt using the second collateral. If health stays below
          // target, reaching target needs the debt below minDebt → guard fires and the debt is closed fully.
          const secondCollateralValue = mulPrice(collateralConfigs[1].amount, secondPrice, secondInfo.scale);
          const deltaCollateral = (remainingDebt - minDebtValue) * factorScale / secondInfo.liquidationFactor.toBigInt();
          const expectedHF = mulFactor(secondCollateralValue - deltaCollateral, secondInfo.borrowCollateralFactor) * factorScale / minDebtValue;
    
          expect(expectedHF).to.be.lessThan(targetHealthFactor);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: AAVE fully seized, LDO full close', async () => {
          const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // AAVE is fully seized; the remaining debt is closed fully from LDO.
          const aaveCollateralValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
    
          const remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - mulFactor(aaveCollateralValue, aaveInfo.liquidationFactor);
          const wantedLdoValue = remainingDebt * factorScale / ldoInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedLdoValue, ldoPrice, ldoInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral seizes all AAVE', async () => {
          const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const aaveCollateralValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address,
            collateralsState[collateralConfigs[0].symbol].seizeAmount, aaveCollateralValue
          );
        });
    
        it('AbsorbCollateral partially seizes LDO to close remaining debt', async () => {
          const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const ldoSeizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, ldoPrice, ldoInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address,
            collateralsState[collateralConfigs[1].symbol].seizeAmount, ldoSeizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice AAVE collateral balance is zero after full seizure', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
        });
    
        it('alice LDO collateral balance is reduced by the seized amount with leftover remaining', async () => {
          const remainingLdo = collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(remainingLdo);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(remainingLdo);
        });
    
        it('alice assetsIn no longer contains AAVE after full seizure', async () => {
          const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          expect((await comet.userBasic(alice.address)).assetsIn & (1 << aaveInfo.offset)).to.be.equal(0);
        });
    
        it('alice reserved bits do not change because LDO collateral remains', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        for (const config of collateralConfigs) {
          it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
            expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
          });
        }
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('5 non-adjacent collaterals: first four fully seized then the last formula gives partial seizure but guard fires because S*LF leaves debt at or under minDebt, closes debt fully (indexes 2, 4, 17, 19, 23)', function () {
        const borrowAmount = exp(38, 6); // $38, above baseBorrowMin of $10
    
        // priceDrop is the percentage numerator applied to the live price (50 = drop 50%, 80 = drop 20%).
        const collateralConfigs = [
          { symbol: 'USDT',  amount: exp(10, 6),  priceDrop: 50n }, // $10 → $5
          { symbol: 'DAI',   amount: exp(10, 18), priceDrop: 50n }, // $10 → $5
          { symbol: 'CRV',   amount: exp(10, 18), priceDrop: 50n }, // $10 → $5
          { symbol: 'ARB',   amount: exp(10, 18), priceDrop: 50n }, // $10 → $5
          { symbol: 'sUSDe', amount: exp(30, 18), priceDrop: 80n }, // $30 → $24, closes the debt
        ];
        const fullSeizureCount = 4;
        const partialIndex = 4; // sUSDe
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is above the minimum debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: after the first four collaterals are fully seized, reducing debt only to min debt leaves health below target, so the debt is closed fully', async () => {
          // The first four collaterals are fully seized, reducing the debt by their LF-weighted value.
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            remainingDebt -= mulFactor(mulPrice(config.amount, price, scale), liquidationFactor);
          }
    
          // Pay the remaining debt down only to minDebt using the last collateral. If health stays below
          // target, reaching target needs the debt below minDebt → guard fires and the debt is closed fully.
          const lastInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const lastPrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const lastCollateralValue = mulPrice(collateralConfigs[partialIndex].amount, lastPrice, lastInfo.scale);
          const deltaCollateral = (remainingDebt - minDebtValue) * factorScale / lastInfo.liquidationFactor.toBigInt();
          const expectedHF = mulFactor(lastCollateralValue - deltaCollateral, lastInfo.borrowCollateralFactor) * factorScale / minDebtValue;
    
          expect(expectedHF).to.be.lessThan(targetHealthFactor);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: first four fully seized, last collateral closes the debt', async () => {
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            collateralsState[config.symbol].seizeAmount = config.amount;
            remainingDebt -= mulFactor(mulPrice(config.amount, price, assetInfo.scale), assetInfo.liquidationFactor);
          }
    
          // The guard redirects to _processDebtClosing, which closes the debt fully from the last collateral.
          const lastInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const lastPrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const wantedLastValue = remainingDebt * factorScale / lastInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount = divPrice(wantedLastValue, lastPrice, lastInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        for (let i = 0; i < fullSeizureCount; i++) {
          it(`AbsorbCollateral seizes all ${collateralConfigs[i].symbol}`, async () => {
            const config = collateralConfigs[i];
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address, alice.address, tokens[config.symbol].address, config.amount, collateralValue
            );
          });
        }
    
        it('AbsorbCollateral partially seizes the last collateral to close remaining debt', async () => {
          const lastInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const lastPrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const lastSeizedValue = mulPrice(collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount, lastPrice, lastInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralConfigs[partialIndex].symbol].address,
            collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount, lastSeizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        for (let i = 0; i < fullSeizureCount; i++) {
          it(`alice ${collateralConfigs[i].symbol} collateral balance is zero after full seizure`, async () => {
            expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[i].symbol].address)).to.be.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[i].symbol].address)).balance).to.be.equal(0);
          });
        }
    
        it('alice sUSDe collateral balance is reduced by the seized amount with leftover remaining', async () => {
          const remaining = collateralConfigs[partialIndex].amount - collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn clears USDT and DAI after full seizure', async () => {
          // USDT (2) and DAI (4) live in assetsIn and are fully seized; the rest live in _reserved.
          expect((await comet.userBasic(alice.address)).assetsIn).to.not.be.equal(assetsInBefore);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved keeps only sUSDe after CRV and ARB are fully seized', async () => {
          // CRV (17) → bit 1 and ARB (19) → bit 3 are cleared; sUSDe (23) → bit 7 is kept (surplus remains).
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore & (1 << (23 - 16)));
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address))
              .to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      context('24 collaterals: first 23 fully seized then sUSDe formula gives partial seizure but guard fires because S*LF leaves debt at or under minDebt, closes debt fully (all asset indexes 0-23)', function () {
        const borrowAmount = exp(18, 6); // $18, above baseBorrowMin $10
    
        // priceDrop is the percentage numerator applied to the live price (75 = drop 25%, 80 = drop 20%).
        const collateralConfigs = [
          { symbol: 'COMP',   amount: exp(0.001, 18),     priceDrop: 75n }, // ~$0.10
          { symbol: 'WETH',   amount: exp(0.00005, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'USDT',   amount: exp(0.1, 6),        priceDrop: 75n }, // ~$0.10
          { symbol: 'WBTC',   amount: exp(0.000002, 8),   priceDrop: 75n }, // ~$0.13
          { symbol: 'DAI',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'wstETH', amount: exp(0.000028, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'rsETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'cbETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'rETH',   amount: exp(0.000029, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'weETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'ezETH',  amount: exp(0.00003, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'cbBTC',  amount: exp(0.000002, 8),   priceDrop: 75n }, // ~$0.13
          { symbol: 'tBTC',   amount: exp(0.000002, 18),  priceDrop: 75n }, // ~$0.13
          { symbol: 'LINK',   amount: exp(0.006667, 18),  priceDrop: 75n }, // ~$0.10
          { symbol: 'UNI',    amount: exp(0.0125, 18),    priceDrop: 75n }, // ~$0.10
          { symbol: 'AAVE',   amount: exp(0.001, 18),     priceDrop: 75n }, // ~$0.10
          { symbol: 'LDO',    amount: exp(0.05, 18),      priceDrop: 75n }, // ~$0.10
          { symbol: 'CRV',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'MKR',    amount: exp(0.00004, 18),   priceDrop: 75n }, // ~$0.10
          { symbol: 'ARB',    amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'OP',     amount: exp(0.05, 18),      priceDrop: 75n }, // ~$0.10
          { symbol: 'GMX',    amount: exp(0.0025, 18),    priceDrop: 75n }, // ~$0.10
          { symbol: 'USDe',   amount: exp(0.1, 18),       priceDrop: 75n }, // ~$0.10
          { symbol: 'sUSDe',  amount: exp(25, 18),        priceDrop: 80n }, // $25 → $20 after drop; closes the remaining debt
        ];
        const fullSeizureCount = 23;
        const partialIndex = 23; // sUSDe
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function () {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          // Drop every collateral price (first 23 by 25%, sUSDe by 20%) so the position is liquidatable.
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is above the minimum debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: after the first 23 collaterals are fully seized, reducing debt only to min debt leaves health below target, so the debt is closed fully', async () => {
          // The first 23 collaterals are fully seized, reducing the debt by their LF-weighted value.
          let remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            remainingDebt -= mulFactor(mulPrice(config.amount, price, assetInfo.scale), assetInfo.liquidationFactor);
          }
    
          // Pay the remaining debt down only to minDebt using sUSDe. If health stays below target, reaching
          // target needs the debt below minDebt → guard fires and the debt is closed fully.
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const sUsdePrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const sUsdeCollateralValue = mulPrice(collateralConfigs[partialIndex].amount, sUsdePrice, sUsdeInfo.scale);
          const deltaCollateral = (remainingDebt - minDebtValue) * factorScale / sUsdeInfo.liquidationFactor.toBigInt();
          const expectedHF = mulFactor(sUsdeCollateralValue - deltaCollateral, sUsdeInfo.borrowCollateralFactor) * factorScale / minDebtValue;
    
          expect(expectedHF).to.be.lessThan(targetHealthFactor);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: first 23 fully seized, sUSDe full close', async () => {
          let debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          for (let i = 0; i < fullSeizureCount; i++) {
            const config = collateralConfigs[i];
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
    
            collateralsState[config.symbol].seizeAmount = config.amount;
            debtRemainingValue -= mulFactor(mulPrice(config.amount, price, assetInfo.scale), assetInfo.liquidationFactor);
          }
    
          // The guard redirects to _processDebtClosing, which closes the debt fully from sUSDe.
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[partialIndex].symbol].address);
          const sUsdePrice = (await priceFeeds[collateralConfigs[partialIndex].symbol].latestRoundData())[1].toBigInt();
          const wantedSUsdeCollateralValue = debtRemainingValue * factorScale / sUsdeInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount = divPrice(wantedSUsdeCollateralValue, sUsdePrice, sUsdeInfo.scale);
        });
    
        it('emits AbsorbDebt for the full absorbed debt', async () => {
          // newBalance is zero, so basePaidOut = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        for (let i = 0; i < fullSeizureCount; i++) {
          it(`alice ${collateralConfigs[i].symbol} collateral balance is zero after full seizure`, async () => {
            expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[i].symbol].address)).to.be.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[i].symbol].address)).balance).to.be.equal(0);
          });
        }
    
        it('alice sUSDe collateral balance is reduced by the seized amount and still positive', async () => {
          const remaining = collateralConfigs[partialIndex].amount - collateralsState[collateralConfigs[partialIndex].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[partialIndex].symbol].address)).balance).to.be.equal(remaining);
        });
    
        it('alice assetsIn is cleared (asset indexes 0-15 fully seized)', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved keeps only sUSDe after assets 16-22 are fully seized', async () => {
          // Asset indexes 16-22 (LDO..USDe) live in _reserved and are fully seized; sUSDe (index 23 → bit 7) is kept.
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore & (1 << (23 - 16)));
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
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
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address))
              .to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±5 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 5);
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
        const borrowAmount = exp(23.45, 6);    // above baseBorrowMin ($10)
        const droppedWethPrice = exp(1000, 8); // WETH drops to $1000
        const collateralConfigs = [
          { symbol: 'COMP', amount: exp(0.2, 18)   }, // $20 at $100
          { symbol: 'WETH', amount: exp(0.008, 18) }, // $16 at $2000, $8 at $1000
        ];
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralConfigs[1].symbol].connect(alice).setRoundData(0, droppedWethPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.greaterThan(minDebtValue);
        });
    
        it('sanity check: reducing debt only to min debt would leave health below target, so the first collateral seizure is redirected to the full-close path', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const compCollateralValue = mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale);
          const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
    
          // Reduce the debt to minDebt by seizing deltaCollateral of the first collateral (the second is untouched).
          // If the resulting health stays below target, reaching target needs the debt below minDebt → guard fires.
          const deltaCollateral = (debtValue - minDebtValue) * factorScale / compInfo.liquidationFactor.toBigInt();
          const collateralizedValue = mulFactor(compCollateralValue - deltaCollateral, compInfo.borrowCollateralFactor) + mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);
          const expectedHF = collateralizedValue * factorScale / minDebtValue;
    
          expect(expectedHF).to.be.lessThan(targetHealthFactor);
        });
    
        it('sanity check: the first collateral cannot cover the debt, so it is fully seized leaving a positive sub-min debt for the second to close', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
    
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const compCollateralValueLeft = mulFactor(mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale), compInfo.liquidationFactor);
    
          // Seizing the whole first collateral repays only its liquidation value, leaving a positive debt below minDebt.
          expect(debtValue).to.be.greaterThan(compCollateralValueLeft);
          expect(debtValue - compCollateralValueLeft).to.be.lessThan(minDebtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates seize amounts: COMP fully seized, WETH closes the sub-min remainder', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
    
          // COMP cannot cover the debt → fully seized, repaying its liquidation value.
          const compCollateralValueLeft = mulFactor(mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale), compInfo.liquidationFactor);
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
    
          // WETH closes the remaining sub-min debt.
          const remainingDebt = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - compCollateralValueLeft;
          const wantedWethValue = remainingDebt * factorScale / wethInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethValue, wethPrice, wethInfo.scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral seizes all COMP', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const compCollateralValue = mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address,
            alice.address,
            tokens[collateralConfigs[0].symbol].address,
            collateralsState[collateralConfigs[0].symbol].seizeAmount,
            compCollateralValue
          );
        });
    
        it('AbsorbCollateral partially seizes WETH to close remainder', async () => {
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const wethWantedCollateralValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, wethPrice, wethInfo.scale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address,
            alice.address,
            tokens[collateralConfigs[1].symbol].address,
            collateralsState[collateralConfigs[1].symbol].seizeAmount,
            wethWantedCollateralValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice COMP collateral balance is zero after full seizure', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
        });
    
        it('alice WETH collateral balance drops by the seized WETH amount', async () => {
          const remaining = collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(remaining);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(remaining);
        });
    
    
        it('alice assetsIn keeps only WETH after COMP full seizure', async () => {
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(1 << wethInfo.offset);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        for (const config of collateralConfigs) {
          it(`comet total supplied ${config.symbol} collateral is reduced by the seized amount`, async () => {
            const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;
    
            expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet total supplied WETH collateral is still positive', async () => {
          expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.not.be.equal(0);
        });
    
        it('comet ERC20 base balance on Comet is unchanged during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        for (const config of collateralConfigs) {
          it(`comet ERC20 ${config.symbol} balance on Comet is unchanged during absorb`, async () => {
            expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
          });
        }
    
        for (const config of collateralConfigs) {
          it(`comet ${config.symbol} collateral reserves increase by the seized amount`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(collateralsState[config.symbol].collateralReservesBefore.add(collateralsState[config.symbol].seizeAmount));
          });
        }
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±5 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 5);
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
    
        const collateralKey = 'COMP';
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is equal to min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.equal(minDebtValue);
        });
    
        it('sanity check: collateral covers the debt, so it is closed by a partial seizure', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const collateralValueLeft = mulFactor(mulPrice(collateralAmount, droppedCompPrice, scale), liquidationFactor);
    
          // debt = minDebt < LF * collateralValue → _processDebtClosing closes the debt with a partial seizure, leftover collateral.
          expect(minDebtValue).to.be.lessThan(collateralValueLeft);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('calculates the partial seize amount that closes the min debt', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
    
          // debt equals minDebt, so the closing seize is minDebt / LF / price.
          const wantedCollateralValue = minDebtValue * factorScale / liquidationFactor.toBigInt();
          collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, scale);
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral event is emitted for partial COMP seizure', async () => {
          const { scale } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const seizedValue = mulPrice(collateralsState[collateralKey].seizeAmount, droppedCompPrice, scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount, seizedValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice collateral balance is reduced by the seized amount with leftover remaining', async () => {
          const remainingComp = collateralAmount - collateralsState[collateralKey].seizeAmount;
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(remainingComp);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(remainingComp);
        });
    
        it('alice assetsIn does not change because collateral remains', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
    
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount but remains positive', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
    
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });
    
        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    
      // Note: this context covers _processDebtClosing case 2. When debt equals minDebt
      // but LF×collateralValue < debtRemainingValue, the contract seizes ALL collateral
      // and the residual debt is forgiven as bad debt (totalCollateralizedValue == 0).
      context('debt = minDebt but collateral cannot cover, full seizure and bad debt', function () {
        const collateralAmount = exp(0.125, 18); // 0.125 COMP = $12.50 initial
        const borrowAmount = exp(10, 6);         // $10, exactly baseBorrowMin
        const droppedCompPrice = exp(80, 8);     // $80 → compValue = $10e8
    
        const collateralKey = 'COMP';
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalsBasicBefore: TotalsBasicStructOutput;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;
        let reservesBefore: BigNumber;
    
        before(async function() {
          await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          totalsBasicBefore = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(userBasic.principal, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
    
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          reservesBefore = await comet.getReserves();
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is equal to min debt', () => {
          expect(mulPrice(-balanceBefore, baseTokenPrice, baseScale)).to.be.equal(minDebtValue);
        });
    
        it('sanity check: collateral cannot cover the debt, so all of it is seized and the residual is forgiven as bad debt', async () => {
          const { scale, liquidationFactor } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const collateralValueLeft = mulFactor(mulPrice(collateralAmount, droppedCompPrice, scale), liquidationFactor);
    
          // debt = minDebt > LF * collateralValue → _processDebtClosing case 2: seize all collateral; the
          // positive residual (debt - collateralValueLeft) is forgiven because no collateral remains.
          expect(minDebtValue).to.be.greaterThan(collateralValueLeft);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('AbsorbDebt event is emitted', async () => {
          // newBalance is zero, so basePaidOut = newBalance - balanceBefore = -balanceBefore
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
    
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });
    
        it('AbsorbCollateral seizes all COMP', async () => {
          const { scale } = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const collateralValue = mulPrice(collateralAmount, droppedCompPrice, scale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address, alice.address, tokens[collateralKey].address,
            collateralAmount, collateralValue
          );
        });
    
        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
        });
    
        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
        });
    
        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice COMP collateral balance is zero after full seizure', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0);
        });
    
        it('alice assetsIn clears the COMP bit because all collateral was seized', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          expect((await comet.userBasic(alice.address)).assetsIn & (1 << compInfo.offset)).to.be.equal(0);
        });
    
        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });
    
        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out on absorb', async () => {
          const { totalBorrowBase } = await comet.totalsBasic();
    
          expect(totalBorrowBase).to.be.equal(totalsBasicBefore.totalBorrowBase.sub(-balanceBefore));
        });
        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalsBasicBefore.totalSupplyBase);
        });
    
        // Comet collateral balances
        it('comet total supplied COMP collateral is reduced by the full seized amount', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
    
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralAmount));
        });
    
        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });
    
        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });
    
        it('comet COMP collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralAmount));
        });
    
        it('comet base reserves are reduced by the base paid out', async () => {
          // ±1 base unit: present-value rounding because other borrowers remain in totalBorrowBase.
          expect(await comet.getReserves()).to.be.approximately(reservesBefore.add(balanceBefore), 1);
        });
      });
    });
  }

  /*//////////////////////////////////////////////////////////////
                             TESTS SETUP
  //////////////////////////////////////////////////////////////*/

  runMinDebtTests({ partialLiquidationEnabled: false, viaLiquidationModule: false }); // full debt close case
  runMinDebtTests({ partialLiquidationEnabled: true, viaLiquidationModule: false });
  runMinDebtTests({ partialLiquidationEnabled: true, viaLiquidationModule: true });
});
