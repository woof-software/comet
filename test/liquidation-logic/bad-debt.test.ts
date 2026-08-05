import { ethers, expect, exp, makeProtocol, presentValue, mulPrice, mulFactor, default24Assets,
  CollateralState, makeCollateralStates, seedMarketActivity } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, FaucetToken, DexLiquidationModule, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

import { useBlockDelta } from '../helpers/block-clock';

describe('partial liquidation: bad debt', function() {
  // Pin one second between blocks so interest accrues deterministically regardless of machine speed.
  useBlockDelta(1);

  // Protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: DexLiquidationModule;

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
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;
  let pauser: SignerWithAddress;
  let executor: SignerWithAddress;

  // Math
  const baseScale: bigint = 10n ** 6n;
  const factorScale: bigint = 10n ** 18n;

  let baseSnapshot: SnapshotRestorer;
  let snapshot: SnapshotRestorer;

  before(async function() {
    const protocol = await makeProtocol({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        ...default24Assets(),
      },
      baseTrackingBorrowSpeed: 0,
      baseTrackingSupplySpeed: 0,
      baseBorrowMin: baseBorrowMin,
    });
    comet = protocol.comet;
    liquidationModule = protocol.defaultLiquidationModule;
    for (let asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      tokens[asset] = protocol.tokens[asset] as FaucetToken;
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    baseToken = protocol.tokens['USDC'] as FaucetToken;
    priceFeeds['USDC'] = protocol.priceFeeds['USDC'];

    [alice, absorber] = protocol.users;
    [bob, dave] = protocol.users.slice(2);
    pauser = protocol.pausers[0];
    executor = protocol.executors[0];

    const allocateAmount = exp(1_000_000, 18);
    for (const token of Object.values(protocol.tokens)) {
      await (token as FaucetToken).allocateTo(alice.address, allocateAmount);
      await (token as FaucetToken).connect(alice).approve(comet.address, ethers.constants.MaxUint256);
    }

    await seedMarketActivity(comet, tokens, priceFeeds, bob, dave, baseToken, initialBaseFunding );
    
    baseSnapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                              TESTS LOGIC
  //////////////////////////////////////////////////////////////*/
  // Note: tests running performs at the end of the file.

  function runBadDebtTests({ partialLiquidationEnabled, viaLiquidationModule }: { partialLiquidationEnabled: boolean, viaLiquidationModule: boolean }) {
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
        let balanceBefore: bigint;
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: collateral value after liquidation factor is below the debt (bad debt)', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          // collateralValueAfterLF = collateralValue * LF = $50 * 0.90 = $45 < $80 debt
          const collateralValueAfterLF = mulFactor(
            mulPrice(collateralAmount, compPrice, assetInfo.scale.toBigInt()),
            assetInfo.liquidationFactor.toBigInt()
          );
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(collateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);

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
          // basePaidOut = newBalance(0) - balanceBefore = -balanceBefore (bad debt written off to zero)
          const basePaidOut = -balanceBefore;
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
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0);
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
          // balance = initialBaseFunding - borrowAmount; balanceBefore ≈ -borrowAmount
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
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
        let balanceBefore: bigint;
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: collateral value after liquidation factor is below the debt (bad debt)', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          // collateralValueAfterLF = $50 * LF < $80 debt
          const collateralValueAfterLF = mulFactor(
            mulPrice(collateralAmount, ldoPrice, assetInfo.scale.toBigInt()),
            assetInfo.liquidationFactor.toBigInt()
          );
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(collateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0);
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
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
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
        let balanceBefore: bigint;
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: collateral value after liquidation factor is below the debt (bad debt)', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const susdePrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          // collateralValueAfterLF = $50 * LF < $70 debt
          const collateralValueAfterLF = mulFactor(
            mulPrice(collateralAmount, susdePrice, assetInfo.scale.toBigInt()),
            assetInfo.liquidationFactor.toBigInt()
          );
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(collateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0);
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
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
        });
      });
    
      context('multi-collateral: full seizure of first asset then full seizure of second (assets index 0 and 1)', function () {
        const collateralConfigs = [
          { symbol: 'COMP', amount: exp(0.5, 18), droppedPrice: exp(80, 8) },     // 0.5 COMP, worth $50 before → $40
          { symbol: 'WETH', amount: exp(0.0275, 18), droppedPrice: exp(1600, 8) }, // 0.0275 WETH at $2,000 = $55 → $44
        ];
        const borrowAmount = exp(80, 6); // $80
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let cometBaseTokenBalanceBefore: BigNumber;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let principalBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          // Drop both assets by 20%.
          // COMP: $50 supplied value -> $40. WETH: $55 supplied value -> $44.
          // Together they cannot cover the $80 debt after liquidation factors,
          // so the contract should fully seize both assets and write off bad debt.
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
          // totalCollateralValueAfterLF = $40 * 0.90 + $44 * 0.90 = $36 + $39.60 = $75.60 < $80 debt
          let totalCollateralValueAfterLF = 0n;
          for (const config of collateralConfigs) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            totalCollateralValueAfterLF += mulFactor(mulPrice(config.amount, price, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
          }
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
          });
        }
    
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
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
        });
      });
    
      context('multi-collateral: full seizure of first asset then full seizure of second (assets index 15 and 16)', function () {
        const collateralConfigs = [
          { symbol: 'AAVE', amount: exp(0.4, 18), droppedPrice: exp(50, 8) }, // 0.4 AAVE, worth $40 before → $20
          { symbol: 'LDO', amount: exp(20, 18), droppedPrice: exp(1, 8) },    // 20 LDO, worth $40 before → $20
        ];
        const borrowAmount = exp(45, 6); // $45
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let cometBaseTokenBalanceBefore: BigNumber;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let principalBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          // Drop both assets by 50%. Together they still cannot cover the $45 debt
          // after liquidation factors, so the contract fully seizes both assets.
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
          // totalCollateralValueAfterLF = $20 * AAVE_LF + $20 * LDO_LF < $45 debt
          let totalCollateralValueAfterLF = 0n;
          for (const config of collateralConfigs) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            totalCollateralValueAfterLF += mulFactor(mulPrice(config.amount, price, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
          }
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
          });
        }
    
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
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
        });
      });
    
      context('multi-collateral: full seizure of first asset then full seizure of second (last two asset indexes: 22 and 23)', function () {
        const collateralConfigs = [
          { symbol: 'USDe', amount: exp(50, 18), droppedPrice: exp(0.7, 8) },  // 50 USDe, worth $50 before → $35
          { symbol: 'sUSDe', amount: exp(50, 18), droppedPrice: exp(0.7, 8) }, // 50 sUSDe, worth $50 before → $35
        ];
        const borrowAmount = exp(70, 6); // $70
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let cometBaseTokenBalanceBefore: BigNumber;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let principalBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          // Drop both assets by 30%. Together they still cannot cover the $70 debt
          // after liquidation factors, so the contract fully seizes both assets.
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
          // totalCollateralValueAfterLF = $35 * USDe_LF + $35 * sUSDe_LF < $70 debt
          let totalCollateralValueAfterLF = 0n;
          for (const config of collateralConfigs) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            totalCollateralValueAfterLF += mulFactor(mulPrice(config.amount, price, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
          }
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
          });
        }
    
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
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
        });
      });
    
      context('multi-collateral: full seizure of first asset then full seizure of second (assets index 14 and 18)', function () {
        const collateralConfigs = [
          { symbol: 'UNI', amount: exp(5, 18), droppedPrice: exp(4, 8) },       // 5 UNI, worth $40 before → $20
          { symbol: 'MKR', amount: exp(0.016, 18), droppedPrice: exp(1250, 8) }, // 0.016 MKR, worth $40 before → $20
        ];
        const borrowAmount = exp(45, 6); // $45
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let cometBaseTokenBalanceBefore: BigNumber;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let principalBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          // Drop both assets by 50%. Together they still cannot cover the $45 debt
          // after liquidation factors, so the contract fully seizes both assets.
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
          // totalCollateralValueAfterLF = $20 * UNI_LF + $20 * MKR_LF < $45 debt
          let totalCollateralValueAfterLF = 0n;
          for (const config of collateralConfigs) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            totalCollateralValueAfterLF += mulFactor(mulPrice(config.amount, price, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
          }
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
          });
        }
    
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
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
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
        let balanceBefore: bigint;
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralKeys);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: total collateral value after liquidation factors is below the debt (bad debt)', async () => {
          let totalCollateralValueAfterLF = 0n;
          for (const config of collateralConfigs) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            totalCollateralValueAfterLF +=
              mulFactor(mulPrice(config.amount, price, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
          }
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
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
          // ±10 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 10);
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
        let balanceBefore: bigint;
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: seized value exactly equals the debt (boundary: exact coverage)', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          const collateralValue = mulPrice(collateralAmount, compPrice, assetInfo.scale.toBigInt());
          const seizedValue = mulFactor(collateralValue, assetInfo.liquidationFactor.toBigInt());
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(seizedValue).to.be.equal(debtValue);
        });
    
        it('sanity check: debt is greater than baseBorrowMin', async () => {
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(debtValue).to.be.greaterThan(mulPrice(baseBorrowMin, baseTokenPrice, baseScale));
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
    
        it('alice simple base balance is zero after full seizure', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        it('alice collateral balance is zero', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0);
        });
    
        it('alice assetsIn is cleared', async () => {
          expect(assetsInBefore).to.not.equal(0);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved is cleared', async () => {
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
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
        });
      });
    
      context('multi-collateral: full seizure when total collateral value equals debt after liquidation factors', function () {
        const collateralConfigs = [
          { symbol: 'COMP', amount: exp(1, 18) },   // 1 COMP (price computed in before)
          { symbol: 'WETH', amount: exp(0.01, 18) }, // 0.01 WETH (price computed in before)
        ];
        const borrowAmount = exp(54, 6); // $54
    
        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let cometBaseTokenBalanceBefore: BigNumber;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let balanceBefore: bigint;
        let principalBefore: BigNumber;
    
        before(async function() {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const debtValue = mulPrice(borrowAmount, baseTokenPrice, baseScale);
    
          // First asset: choose COMP value of $40 after the price change.
          //   COMP seizedValue = $40 * LF 0.90 = $36
          const compWantedCollateralValue = exp(40, 8);
          const exactCompPrice = compWantedCollateralValue * compInfo.scale.toBigInt() / collateralConfigs[0].amount;
    
          // Second asset must cover exactly the remaining debt:
          //   remaining debt = $54 - $36 = $18, which is above baseBorrowMin ($10)
          //   WETH collateralValue = $18 / LF 0.90 = $20
          const compWantedSeizedValue = mulFactor(compWantedCollateralValue, compInfo.liquidationFactor.toBigInt());
          const wethWantedCollateralValue = (debtValue - compWantedSeizedValue) * factorScale / wethInfo.liquidationFactor.toBigInt();
          const exactWethPrice = wethWantedCollateralValue * wethInfo.scale.toBigInt() / collateralConfigs[1].amount;
    
          await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, exactCompPrice, 0, 0, 0);
          await priceFeeds[collateralConfigs[1].symbol].connect(alice).setRoundData(0, exactWethPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);
    
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          principalBefore = userBasic.principal;
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: COMP seized value plus WETH seized value exactly equals the debt (boundary: exact coverage)', async () => {
          // compSeizedValue = $40 * LF 0.90 = $36; wethSeizedValue = $20 * LF 0.90 = $18; total = $54 = debtValue
          let totalSeizedValue = 0n;
          for (const config of collateralConfigs) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            totalSeizedValue += mulFactor(mulPrice(config.amount, price, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
          }
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(totalSeizedValue).to.be.equal(debtValue);
        });
    
        it('sanity check: remaining debt after COMP seizure is above baseBorrowMin', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          // compSeizedValue = $36; debtValue = $54; remaining = $18 > baseBorrowMin ($10)
          const compSeizedValue = mulFactor(mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale.toBigInt()), compInfo.liquidationFactor.toBigInt());
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(debtValue - compSeizedValue).to.be.greaterThan(mulPrice(baseBorrowMin, baseTokenPrice, baseScale));
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
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
          const basePaidOut = -balanceBefore;
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
    
        it('alice simple base balance is zero after both assets are fully seized', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });
    
        // User collateral state
        for (const config of collateralConfigs) {
          it(`alice ${config.symbol} collateral balance is zero`, async () => {
            expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.be.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
          });
        }
    
        it('alice assetsIn is cleared', async () => {
          expect(assetsInBefore).to.not.equal(0);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved is cleared', async () => {
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
          it(`comet ${config.symbol} collateral reserves increase by all seized ${config.symbol}`, async () => {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(
              collateralsState[config.symbol].collateralReservesBefore.add(config.amount)
            );
          });
        }
    
        it('comet base reserves decrease by the absorbed debt', async () => {
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
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
        let balanceBefore: bigint;
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is below min debt', () => {
          expect(-balanceBefore).to.be.lessThan(baseBorrowMin);
        });
    
        it('sanity check: collateral value after liquidation factor cannot cover the debt (bad debt)', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          // AAVE value = $5, after LF 0.85 = $4.25 < $8 debt — full seizure still leaves residual bad debt
          const seizedValue = mulFactor(mulPrice(collateralAmount, droppedAavePrice, assetInfo.scale.toBigInt()), assetInfo.liquidationFactor.toBigInt());
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(seizedValue).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        it('emits AbsorbCollateral for full AAVE seizure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const wantedCollateralValue = mulPrice(collateralAmount, droppedAavePrice, assetInfo.scale.toBigInt());
          await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
            .withArgs(absorber.address, alice.address, tokens[collateralKey].address, collateralAmount, wantedCollateralValue);
        });
    
        it('emits AbsorbDebt for the full remaining borrow amount', async () => {
          const basePaidOut = -balanceBefore;
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
        it('alice collateral balance is zero', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0);
        });
    
        it('alice assetsIn is cleared', async () => {
          expect(assetsInBefore).to.not.equal(0);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved is cleared', async () => {
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
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect(await comet.getReserves()).to.be.approximately(initialBaseFunding + balanceBefore, 5);
        });
      });
    
      context('24 collaterals: all collaterals are fully seized after moderate price drops', function () {
        // All 24 supported collaterals with a 15% price drop applied.
        // COMP holds the large position ($9,000 target); USDT/DAI are stable ($100 target); the rest are dust ($1 target).
        // Amounts derived from: targetValue * scale / initialPrice.
        const collateralConfigs = [
          { symbol: 'COMP',   amount: exp(90, 18),  initialPrice: exp(100, 8),   droppedPrice: exp(85, 8) },
          { symbol: 'WETH',   amount: exp(5, 14),   initialPrice: exp(2000, 8),  droppedPrice: exp(1700, 8) },
          { symbol: 'USDT',   amount: exp(100, 6),  initialPrice: exp(1, 8),     droppedPrice: exp(0.85, 8) },
          { symbol: 'WBTC',   amount: 2000n,        initialPrice: exp(65000, 8), droppedPrice: exp(55250, 8) },
          { symbol: 'DAI',    amount: exp(100, 18), initialPrice: exp(1, 8),     droppedPrice: exp(0.85, 8) },
          { symbol: 'wstETH', amount: exp(3, 14),   initialPrice: exp(3600, 8),  droppedPrice: exp(3060, 8) },
          { symbol: 'rsETH',  amount: exp(3, 14),   initialPrice: exp(3400, 8),  droppedPrice: exp(2890, 8) },
          { symbol: 'cbETH',  amount: exp(3, 14),   initialPrice: exp(3300, 8),  droppedPrice: exp(2805, 8) },
          { symbol: 'rETH',   amount: exp(3, 14),   initialPrice: exp(3500, 8),  droppedPrice: exp(2975, 8) },
          { symbol: 'weETH',  amount: exp(3, 14),   initialPrice: exp(3400, 8),  droppedPrice: exp(2890, 8) },
          { symbol: 'ezETH',  amount: exp(3, 14),   initialPrice: exp(3350, 8),  droppedPrice: exp(2847, 8) },
          { symbol: 'cbBTC',  amount: 2000n,        initialPrice: exp(65000, 8), droppedPrice: exp(55250, 8) },
          { symbol: 'tBTC',   amount: exp(2, 13),   initialPrice: exp(65000, 8), droppedPrice: exp(55250, 8) },
          { symbol: 'LINK',   amount: exp(7, 16),   initialPrice: exp(15, 8),    droppedPrice: exp(12.75, 8) },
          { symbol: 'UNI',    amount: exp(125, 15), initialPrice: exp(8, 8),     droppedPrice: exp(6.8, 8) },
          { symbol: 'AAVE',   amount: exp(1, 16),   initialPrice: exp(100, 8),   droppedPrice: exp(85, 8) },
          { symbol: 'LDO',    amount: exp(5, 17),   initialPrice: exp(2, 8),     droppedPrice: exp(1.7, 8) },
          { symbol: 'CRV',    amount: exp(1, 18),   initialPrice: exp(1, 8),     droppedPrice: exp(0.85, 8) },
          { symbol: 'MKR',    amount: exp(4, 14),   initialPrice: exp(2500, 8),  droppedPrice: exp(2125, 8) },
          { symbol: 'ARB',    amount: exp(1, 18),   initialPrice: exp(1, 8),     droppedPrice: exp(0.85, 8) },
          { symbol: 'OP',     amount: exp(5, 17),   initialPrice: exp(2, 8),     droppedPrice: exp(1.7, 8) },
          { symbol: 'GMX',    amount: exp(25, 15),  initialPrice: exp(40, 8),    droppedPrice: exp(34, 8) },
          { symbol: 'USDe',   amount: exp(1, 18),   initialPrice: exp(1, 8),     droppedPrice: exp(0.85, 8) },
          { symbol: 'sUSDe',  amount: exp(1, 18),   initialPrice: exp(1, 8),     droppedPrice: exp(0.85, 8) },
        ];
    
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let cometBaseTokenBalanceBefore: BigNumber;
        let baseReservesBefore: bigint;
        let balanceBefore: bigint;
        let principalBefore: BigNumber;
        let borrowAmount: bigint;
        let collateralsState: Record<string, CollateralState> = {};
    
        before(async function() {
          // Bob adds base liquidity so alice's large (~$7k) borrow keeps utilization within the
          // supported range; without it the seeded ~$2k base supply makes the borrow exceed it.
          const extraBaseLiquidity = exp(20_000, 6);
          await baseToken.allocateTo(bob.address, extraBaseLiquidity);
          await baseToken.connect(bob).approve(comet.address, extraBaseLiquidity);
          await comet.connect(bob).supply(baseToken.address, extraBaseLiquidity);
    
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
    
          // Borrow just under the initial borrow limit so the position is valid before prices move.
          let maxBorrowValue = 0n;
          for (const config of collateralConfigs) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const collateralValue = mulPrice(config.amount, config.initialPrice, assetInfo.scale);
            maxBorrowValue += mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
          }
          borrowAmount = maxBorrowValue * 99n / 100n * baseScale / baseTokenPrice;
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
    
          for (const config of collateralConfigs) {
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);
    
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
          balanceBefore = presentValue(principalBefore, totalsBasic.baseSupplyIndex, baseBorrowIndex);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
          baseReservesBefore = (await comet.getReserves()).toBigInt();
        });
    
        after(async () => await snapshot.restore());
    
        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });
    
        it('sanity check: debt is greater than min debt', () => {
          expect(-balanceBefore).to.be.greaterThan(baseBorrowMin);
        });
    
        it('sanity check: post-drop collateral cannot cover the debt after liquidation factors', async () => {
          let totalCollateralValueAfterLF = 0n;
          for (const config of collateralConfigs) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const collateralValue = mulPrice(config.amount, config.droppedPrice, assetInfo.scale);
            totalCollateralValueAfterLF += mulFactor(collateralValue, assetInfo.liquidationFactor);
          }
          const debtValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          expect(totalCollateralValueAfterLF).to.be.lessThan(debtValue);
        });
    
        it('absorb is successful', async () => {
          absorbTx = viaLiquidationModule
            ? await liquidationModule.connect(executor).liquidate(absorber.address, alice.address, [])
            : await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(absorbTx).to.not.be.reverted;
        });
    
        for (const config of collateralConfigs) {
          it(`emits AbsorbCollateral for full ${config.symbol} seizure`, async () => {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const wantedCollateralValue = mulPrice(config.amount, config.droppedPrice, assetInfo.scale.toBigInt());
            await expect(absorbTx).to.emit(comet, 'AbsorbCollateral')
              .withArgs(absorber.address, alice.address, tokens[config.symbol].address, config.amount, wantedCollateralValue);
          });
        }
    
        it('emits AbsorbDebt for the full absorbed borrow amount', async () => {
          const basePaidOut = -balanceBefore;
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
        it('all alice collateral balances are zero', async () => {
          for (const config of collateralConfigs) {
            expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.be.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0);
          }
        });
    
        it('alice assetsIn is cleared', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });
    
        it('alice reserved bits are cleared', async () => {
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
        it('all collateral totals are zero', async () => {
          for (const config of collateralConfigs) {
            const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;
            expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(config.amount));
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
    
        it('all collateral reserves increase by the seized amounts', async () => {
          for (const config of collateralConfigs) {
            expect(await comet.getCollateralReserves(tokens[config.symbol].address)).to.be.equal(
              collateralsState[config.symbol].collateralReservesBefore.add(config.amount)
            );
          }
        });
    
        it('comet base reserves decrease by the absorbed debt', async () => {
          // ±5 base units: present-value rounding plus interest on the seeded positions (the seeded supply/borrow net out in reserves).
          expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore + balanceBefore, 5);
        });
      });
    });
  }

  /*//////////////////////////////////////////////////////////////
                             TESTS SETUP
  //////////////////////////////////////////////////////////////*/

  runBadDebtTests({ partialLiquidationEnabled: false, viaLiquidationModule: false });
  runBadDebtTests({ partialLiquidationEnabled: true, viaLiquidationModule: false });
  runBadDebtTests({ partialLiquidationEnabled: true, viaLiquidationModule: true });
});
