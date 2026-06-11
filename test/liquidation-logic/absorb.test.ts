import { ethers, expect, exp, default24Assets, makeConfigurator, mulPrice, mulFactor, factorScale, divPrice, presentValue, CollateralState, makeCollateralStates, deployAndUpdateLiquidationModule } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, LiquidationModule, FaucetToken, PriceFeedWithRevert, PriceFeedWithRevert__factory, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

describe('absorb: general logic', function () {
  let comet: CometHarnessInterfaceExtendedAssetList;
  let configurator: Configurator;
  let cometProxyAdmin: CometProxyAdmin;
  let configuratorProxyAddress: string;
  let cometProxyAddress: string;
  let liquidationModule: LiquidationModule;

  const initialBaseFunding = exp(1, 8) * 10_000n;
  const baseBorrowMin = exp(10, 6);
  const collateralAmount = exp(1, 18); // 1 COMP, $100 at initial price (BCF=0.8 → $80 borrow power)
  const borrowAmount = exp(70, 6);     // $70 USDC, within the $80 borrow limit
  const baseTokenPrice = exp(1, 8);
  const baseScale = 10n ** 6n;

  let tokens: { [symbol: string]: FaucetToken } = {};
  let baseToken: FaucetToken;
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};
  let priceFeedWithRevert: PriceFeedWithRevert;

  let alice: SignerWithAddress;
  let absorber: SignerWithAddress;
  let governor: SignerWithAddress;

  let snapshot: SnapshotRestorer;
  let baseSnapshot: SnapshotRestorer;

  before(async function() {
    const protocol = await makeConfigurator({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        ...default24Assets(),
      },
      baseTrackingSupplySpeed: exp(1, 15),
      baseTrackingBorrowSpeed: exp(1, 15),
      baseBorrowMin: baseBorrowMin,
      liquidationModuleOpts: {
        borderHF: exp(102, 16), // 1.02
        healthPositionHF: exp(110, 16), // 1.10
      }
    });
    configuratorProxyAddress = protocol.configuratorProxy.address;
    cometProxyAddress = protocol.cometProxy.address;
    configurator = protocol.configurator.attach(configuratorProxyAddress);
    comet = protocol.comet.attach(cometProxyAddress);
    cometProxyAdmin = protocol.proxyAdmin;
    liquidationModule = protocol.defaultLiquidationModule;

    for (let asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      tokens[asset] = protocol.tokens[asset] as FaucetToken;
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    baseToken = protocol.tokens['USDC'] as FaucetToken;
    priceFeeds['USDC'] = protocol.priceFeeds['USDC'];

    [alice, absorber] = protocol.users;
    governor = protocol.governor;
    
    const allocateAmount = exp(1_000_000, 18);
    for (const token of Object.values(protocol.tokens)) {
      await (token as FaucetToken).allocateTo(alice.address, allocateAmount);
      await (token as FaucetToken).connect(alice).approve(comet.address, ethers.constants.MaxUint256);
    }

    await baseToken.allocateTo(comet.address, initialBaseFunding);

    const PriceFeedWithRevertFactory = await ethers.getContractFactory('PriceFeedWithRevert') as PriceFeedWithRevert__factory;
    priceFeedWithRevert = await PriceFeedWithRevertFactory.deploy();

    baseSnapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                              TESTS LOGIC
  //////////////////////////////////////////////////////////////*/
  // Note: tests running performs at the end of the file.

  function runAbsorbTests({ partialLiquidationEnabled, viaLiquidationModule }: { 
    partialLiquidationEnabled: boolean;
    viaLiquidationModule: boolean; 
  }) {
    describe(`partialLiquidationEnabled = ${partialLiquidationEnabled} && viaLiquidationModule = ${viaLiquidationModule}`, function() {
      before(async function() {
        // Reset to the clean protocol baseline so state (and the canonical
        // liquidationModule reference) from the previous run does not leak in.
        await baseSnapshot.restore();

        // The module defaults to partialLiquidationEnabled = true; toggling to the
        // value it already holds reverts with LiquidationModeAlreadySet.
        if ((await liquidationModule.partialLiquidationEnabled()) !== partialLiquidationEnabled) {
          await liquidationModule.connect(governor).liquidationModeToggle(partialLiquidationEnabled);
        }

        // sanity check
        expect(await liquidationModule.partialLiquidationEnabled()).to.be.equal(partialLiquidationEnabled);

        snapshot = await takeSnapshot();
      });

      context('1 collateral: after absorb debt = 0 and some collateral surplus on user balance (COMP, index 0)', function () {
        const collateralKey = 'COMP';

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

          // Drop COMP from $100 to $79.  C × LCF = $67.15 < $70 → liquidatable.
          // target-HF formula residual ≈ $6.07 < baseBorrowMin $10 → minDebt branch.
          const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          const newCompPrice = compPrice * 79n / 100n;
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, newCompPrice, 0, 0, 0);
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amount and seized value via minDebt path full closure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          const lf = assetInfo.liquidationFactor.toBigInt();

          // _processDebtClosing: C × LF = $71.10 > D = $70 → seize exactly D / LF of COMP.
          // Debt reduction = D (full debt repaid); seizeAmount = D / LF / compPrice (in COMP tokens).
          collateralsState[collateralKey].seizeAmount = divPrice(debtRemainingValue * factorScale / lf, compPrice, assetInfo.scale);
          collateralsState[collateralKey].seizedValue = mulPrice(collateralsState[collateralKey].seizeAmount, compPrice, assetInfo.scale);
        });

        it('emits AbsorbCollateral for the seized collateral', async () => {
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address,
            alice.address,
            tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount,
            collateralsState[collateralKey].seizedValue
          );
        });

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        it('alice collateral balance is positive — surplus stays with user', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.greaterThan(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it('alice collateral balance is reduced by the seized amount', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(collateralAmount - collateralsState[collateralKey].seizeAmount);
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
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
        });

        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });

        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });

        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });

        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address))
            .to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });

        it('comet base reserves are reduced by the base paid out', async () => {
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      context('1 collateral: after absorb debt = 0 and some collateral surplus on user balance (LDO, index 16)', function () {
        const ldoSupplyAmount = exp(10, 18);
        const ldoBorrowAmount = exp(11, 6); // > baseBorrowMin $10
        const collateralKey = 'LDO';

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          await comet.connect(alice).supply(tokens[collateralKey].address, ldoSupplyAmount);
          await comet.connect(alice).withdraw(baseToken.address, ldoBorrowAmount);

          // Drop LDO from $2 to $1.60 (20%). C × LCF = $9.92 < $11 → liquidatable.
          // target-HF formula residual < baseBorrowMin $10 → minDebt branch.
          const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, ldoPrice * 80n / 100n, 0, 0, 0);
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amount and seized value via _processDebtClosing full closure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();
          const lf = assetInfo.liquidationFactor.toBigInt();

          // D ≤ minDebt → outer branch → _processDebtClosing.
          // C × LF = $13.60 > D = $10 → seize exactly D / LF of LDO; surplus stays.
          collateralsState[collateralKey].seizeAmount = divPrice(debtRemainingValue * factorScale / lf, ldoPrice, assetInfo.scale);
          collateralsState[collateralKey].seizedValue = mulPrice(collateralsState[collateralKey].seizeAmount, ldoPrice, assetInfo.scale);
        });

        it('emits AbsorbCollateral for the seized collateral', async () => {
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address,
            alice.address,
            tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount,
            collateralsState[collateralKey].seizedValue
          );
        });

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        it('alice collateral balance is positive — surplus stays with user', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.greaterThan(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it('alice collateral balance is reduced by the seized amount', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(ldoSupplyAmount - collateralsState[collateralKey].seizeAmount);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(ldoSupplyAmount - collateralsState[collateralKey].seizeAmount);
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
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
        });

        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });

        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });

        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });

        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address))
            .to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });

        it('comet base reserves are reduced by the base paid out', async () => {
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      context('1 collateral: after absorb debt = 0 and some collateral surplus on user balance (sUSDe, index 23)', function () {
        const sUsdeSupplyAmount = exp(16, 18);
        const sUsdeBorrowAmount = exp(11, 6); // > baseBorrowMin $10
        const collateralKey = 'sUSDe';

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          await comet.connect(alice).supply(tokens[collateralKey].address, sUsdeSupplyAmount);
          await comet.connect(alice).withdraw(baseToken.address, sUsdeBorrowAmount);

          // Drop sUSDe from $1 to $0.80 (20%). C × LCF = $10.24 < $11 → liquidatable.
          // target-HF formula residual < baseBorrowMin $10 → minDebt branch.
          const sUsdePrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, sUsdePrice * 80n / 100n, 0, 0, 0);
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amount and seized value via _processDebtClosing full closure', async () => {
          const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
          const sUsdePrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
          const lf = assetInfo.liquidationFactor.toBigInt();

          // D ≤ minDebt → outer branch → _processDebtClosing.
          // C × LF = $11.78 > D = $11 → seize exactly D / LF of sUSDe; surplus stays.
          collateralsState[collateralKey].seizeAmount = divPrice(debtRemainingValue * factorScale / lf, sUsdePrice, assetInfo.scale);
          collateralsState[collateralKey].seizedValue = mulPrice(collateralsState[collateralKey].seizeAmount, sUsdePrice, assetInfo.scale);
        });

        it('emits AbsorbCollateral for the seized collateral', async () => {
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
            absorber.address,
            alice.address,
            tokens[collateralKey].address,
            collateralsState[collateralKey].seizeAmount,
            collateralsState[collateralKey].seizedValue
          );
        });

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        it('alice collateral balance is positive — surplus stays with user', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.greaterThan(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it('alice collateral balance is reduced by the seized amount', async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(sUsdeSupplyAmount - collateralsState[collateralKey].seizeAmount);
          expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(sUsdeSupplyAmount - collateralsState[collateralKey].seizeAmount);
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
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
        });

        // Comet collateral balances
        it('comet total supplied collateral is reduced by the seized amount', async () => {
          const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
          expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount));
        });

        it('comet ERC20 collateral token balance does not change during absorb', async () => {
          expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
        });

        it('comet ERC20 base token balance does not change during absorb', async () => {
          expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
        });

        it('comet collateral reserves increase by the seized amount', async () => {
          expect(await comet.getCollateralReserves(tokens[collateralKey].address))
            .to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount));
        });

        it('comet base reserves are reduced by the base paid out', async () => {
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      context('2 collaterals: after absorb debt = 0 and some 2nd collateral surplus (COMP index 0, WETH index 1)', function () {
        const collateralConfigs = [
          { symbol: 'COMP', amount: exp(1, 18), priceDrop: 85n  }, // 1 COMP: $100 → $85 (15% drop)
          { symbol: 'WETH', amount: exp(6, 15), priceDrop: 100n }, // 0.006 WETH = $12, no price change
        ];
        const multiColBorrowAmount = exp(86, 6); // $86

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, multiColBorrowAmount);

          // Drop COMP 15%: $100 → $85. totalLCF = $72.25 + $9.60 = $81.85 < $86 → liquidatable.
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amounts: COMP fully seized (else branch), WETH partial (outer minDebt)', async () => {
          const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const compPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const lf_comp = compInfo.liquidationFactor.toBigInt();
          const lf_weth = wethInfo.liquidationFactor.toBigInt();

          // Iter 1 (COMP): wantedCV ≈ $91.72 > collateralValue $85 → else branch → seize all COMP.
          // Debt reduction = C × LF = $85 × 0.90 = $76.50
          const compCollateralValue = mulPrice(collateralConfigs[0].amount, compPrice, compInfo.scale);
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
          collateralsState[collateralConfigs[0].symbol].seizedValue = compCollateralValue;

          const debtAfterComp = debtRemainingValue - mulFactor(compCollateralValue, lf_comp);

          // Iter 2 (WETH): debtAfterComp ≈ $9.50 ≤ minDebtValue $10 → outer minDebt → _processDebtClosing.
          // C × LF = $10.80 > debtAfterComp → seize exactly debtAfterComp / LF of WETH.
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(debtAfterComp * factorScale / lf_weth, wethPrice, wethInfo.scale);
          collateralsState[collateralConfigs[1].symbol].seizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, wethPrice, wethInfo.scale);
        });

        for (const config of collateralConfigs) {
          it(`emits AbsorbCollateral for seized ${config.symbol}`, async () => {
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address,
              alice.address,
              tokens[config.symbol].address,
              collateralsState[config.symbol].seizeAmount,
              collateralsState[config.symbol].seizedValue
            );
          });
        }

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        it(`alice ${collateralConfigs[0].symbol} collateral balance is zero — fully seized`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
        });

        it(`alice ${collateralConfigs[1].symbol} collateral balance is positive — surplus stays with user`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.greaterThan(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it(`alice ${collateralConfigs[1].symbol} collateral balance is reduced by the seized amount`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
        });

        it('alice assetsIn keeps only WETH bit', async () => {
          const expectedAssetsIn = assetsInBefore & ~(1 << 0);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(expectedAssetsIn);
        });

        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });

        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out', async () => {
          const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      context('2 collaterals: after absorb debt = 0 and some 2nd collateral surplus (AAVE index 15, LDO index 16)', function () {
        const collateralConfigs = [
          { symbol: 'AAVE', amount: exp(1, 17),  priceDrop: 100n }, // 0.1 AAVE = $10, no price change
          { symbol: 'LDO',  amount: exp(10, 18), priceDrop: 75n  }, // 10 LDO = $20 -> $15 after 25% drop
        ];
        const aaveLdoBorrowAmount = exp(16, 6); // $16

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, aaveLdoBorrowAmount);

          // Drop LDO 25%: $2 -> $1.50. totalLCF = $6.50 + $9.30 = $15.80 < $16 -> liquidatable.
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amounts: AAVE fully seized (inner minDebt), LDO partial (outer minDebt)', async () => {
          const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const lf_aave = aaveInfo.liquidationFactor.toBigInt();
          const lf_ldo = ldoInfo.liquidationFactor.toBigInt();

          // Iter 1 (AAVE): wantedCV ~ $8.72 < $10, partial branch taken.
          // D - target debt reduction ~ $8.59 <= $10 -> inner minDebt -> _processDebtClosing(D, AAVE).
          // C_AAVE x LF = $8.50 < D = $16 -> seize all AAVE; debt reduction = C_AAVE x LF.
          const aaveCollateralValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
          collateralsState[collateralConfigs[0].symbol].seizedValue = aaveCollateralValue;

          const debtAfterAave = debtRemainingValue - mulFactor(aaveCollateralValue, lf_aave);

          // Iter 2 (LDO): debtAfterAave ~ $7.50 <= minDebtValue $10 -> outer minDebt -> _processDebtClosing.
          // C_LDO x LF = $12.75 > debtAfterAave -> seize exactly debtAfterAave / LF of LDO; surplus stays.
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(debtAfterAave * factorScale / lf_ldo, ldoPrice, ldoInfo.scale);
          collateralsState[collateralConfigs[1].symbol].seizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, ldoPrice, ldoInfo.scale);
        });

        for (const config of collateralConfigs) {
          it(`emits AbsorbCollateral for seized ${config.symbol}`, async () => {
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address,
              alice.address,
              tokens[config.symbol].address,
              collateralsState[config.symbol].seizeAmount,
              collateralsState[config.symbol].seizedValue
            );
          });
        }

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        it(`alice ${collateralConfigs[0].symbol} collateral balance is zero - fully seized`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
        });

        it(`alice ${collateralConfigs[1].symbol} collateral balance is positive - surplus stays with user`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.greaterThan(0n);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it(`alice ${collateralConfigs[1].symbol} collateral balance is reduced by the seized amount`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
        });

        it('alice assetsIn clears AAVE bit', async () => {
          const expectedAssetsIn = assetsInBefore & ~(1 << 15);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(expectedAssetsIn);
        });

        it('alice reserved bits do not change', async () => {
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });

        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out', async () => {
          const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      context('2 collaterals: after absorb debt = 0 and some 2nd collateral surplus (USDe index 22, sUSDe index 23)', function () {
        const collateralConfigs = [
          { symbol: 'USDe',  amount: exp(4, 18),  priceDrop: 85n }, // 4 USDe -> $3.40 after 15% drop
          { symbol: 'sUSDe', amount: exp(12, 18), priceDrop: 80n }, // 12 sUSDe -> $9.60 after 20% drop
        ];
        const usdeSUsdeBorrowAmount = exp(11, 6); // > baseBorrowMin $10

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let balanceBefore: bigint;
        let reservedBefore: number;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, usdeSUsdeBorrowAmount);

          // Drop USDe 15%: $1 -> $0.85. Drop sUSDe 20%: $1 -> $0.80.
          // totalLCF = $3.40 x 0.82 + $9.60 x 0.80 = $10.47 < $11 -> liquidatable.
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amounts: USDe fully seized (outer minDebt, D > CxLF), sUSDe partial (outer minDebt)', async () => {
          const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const usdePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const sUsdePrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
          const lf_usde = usdeInfo.liquidationFactor.toBigInt();
          const lf_susde = sUsdeInfo.liquidationFactor.toBigInt();

          // Iter 1 (USDe): D=$11 > minDebtValue, but D > CxLF -> seize all USDe.
          // C_USDe x LF = $3.40 x 0.92 = $3.13 < D -> seize all USDe; debt reduction = C_USDe x LF.
          const usdeCollateralValue = mulPrice(collateralConfigs[0].amount, usdePrice, usdeInfo.scale);
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
          collateralsState[collateralConfigs[0].symbol].seizedValue = usdeCollateralValue;

          const debtAfterUsde = debtRemainingValue - mulFactor(usdeCollateralValue, lf_usde);

          // Iter 2 (sUSDe): debtAfterUsde ~ $7.87 <= minDebtValue $10 -> outer minDebt -> _processDebtClosing.
          // C_sUSDe x LF = $7.36 > debtAfterUsde -> seize exactly debtAfterUsde / LF of sUSDe; surplus stays.
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(debtAfterUsde * factorScale / lf_susde, sUsdePrice, sUsdeInfo.scale);
          collateralsState[collateralConfigs[1].symbol].seizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, sUsdePrice, sUsdeInfo.scale);
        });

        for (const config of collateralConfigs) {
          it(`emits AbsorbCollateral for seized ${config.symbol}`, async () => {
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address,
              alice.address,
              tokens[config.symbol].address,
              collateralsState[config.symbol].seizeAmount,
              collateralsState[config.symbol].seizedValue
            );
          });
        }

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        it(`alice ${collateralConfigs[0].symbol} collateral balance is zero - fully seized`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
        });

        it(`alice ${collateralConfigs[1].symbol} collateral balance is positive - surplus stays with user`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.greaterThan(0n);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it(`alice ${collateralConfigs[1].symbol} collateral balance is reduced by the seized amount`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
        });

        it('alice assetsIn does not change', async () => {
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
        });

        it('alice reserved bits are changed: USDe bit cleared, sUSDe bit kept', async () => {
          // USDe is at asset index 22 → bit (22-16)=6 in _reserved; cleared after full seizure.
          // sUSDe is at asset index 23 → bit 7 in _reserved; kept because surplus remains.
          const expectedReserved = reservedBefore ^ (1 << (22 - 16));
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(expectedReserved);
        });

        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out', async () => {
          const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      context('2 collaterals: after absorb debt = 0 and some 2nd collateral surplus (ezETH index 10, OP index 20)', function () {
        const collateralConfigs = [
          { symbol: 'ezETH', amount: exp(1, 17),  priceDrop: 75n  }, // 0.1 ezETH: $3350 -> $2512.50 (25% drop)
          { symbol: 'OP',    amount: exp(15, 18), priceDrop: 100n }, // 15 OP = $30, no price change
        ];
        const borrowAmount248 = exp(248, 6); // $248

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount248);

          // Drop ezETH 25%: $3350 -> $2512.50. totalLCF = $190.95 + $18.60 = $209.55 < $248 -> liquidatable.
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amounts: ezETH fully seized (else branch), OP partial (inner minDebt)', async () => {
          const ezethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
          const opInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
          const ezethPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
          const opPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

          // Iter 1 (ezETH): wantedCV ~ $266 > C_ezETH -> else branch -> seize all ezETH.
          const ezethCV = mulPrice(collateralConfigs[0].amount, ezethPrice, ezethInfo.scale);
          collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
          collateralsState[collateralConfigs[0].symbol].seizedValue = ezethCV;

          const debtAfterEzETH = debtRemainingValue - mulFactor(ezethCV, ezethInfo.liquidationFactor.toBigInt());

          // Iter 2 (OP): partial branch, then inner minDebt -> _processDebtClosing(debtAfterEzETH, OP).
          // C_OP x LF = $25.50 > debtAfterEzETH ~ $19.36 -> seize exactly debtAfterEzETH / LF.
          const lf_op = opInfo.liquidationFactor.toBigInt();
          collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(debtAfterEzETH * factorScale / lf_op, opPrice, opInfo.scale);
          collateralsState[collateralConfigs[1].symbol].seizedValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, opPrice, opInfo.scale);
        });

        for (const config of collateralConfigs) {
          it(`emits AbsorbCollateral for seized ${config.symbol}`, async () => {
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address,
              alice.address,
              tokens[config.symbol].address,
              collateralsState[config.symbol].seizeAmount,
              collateralsState[config.symbol].seizedValue
            );
          });
        }

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        it(`alice ${collateralConfigs[0].symbol} collateral balance is zero - fully seized`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.equal(0);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
        });

        it(`alice ${collateralConfigs[1].symbol} collateral balance is positive - surplus stays with user`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.greaterThan(0n);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it(`alice ${collateralConfigs[1].symbol} collateral balance is reduced by the seized amount`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount);
        });

        it('alice assetsIn clears ezETH bit', async () => {
          const expectedAssetsIn = assetsInBefore & ~(1 << 10);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(expectedAssetsIn);
        });

        it('alice reserved bits do not change — OP bit kept because surplus remains', async () => {
          // ezETH (index 10) is in assetsIn (uint16), not _reserved. OP (index 20) → bit 4 of _reserved.
          // ezETH fully seized clears its assetsIn bit; OP partial → _reserved bit 4 stays.
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
        });

        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out', async () => {
          const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      context('5 collaterals: after absorb debt = 0 and some last collateral surplus (COMP 0, CRV 17, ARB 19, OP 20, sUSDe 23)', function () {
        // First 4 are fully seized; sUSDe (last) is partially seized with surplus remaining.
        // priceDrop: numerator of the drop factor (75 = drop 25%, 80 = drop 20%).
        const collateralConfigs = [
          { symbol: 'COMP',  amount: exp(2, 16),  priceDrop: 75n }, // 0.02 COMP = $2 initial
          { symbol: 'CRV',   amount: exp(1, 18),  priceDrop: 75n }, // 1 CRV = $1 initial
          { symbol: 'ARB',   amount: exp(1, 18),  priceDrop: 75n }, // 1 ARB = $1 initial
          { symbol: 'OP',    amount: exp(1, 18),  priceDrop: 75n }, // 1 OP = $2 initial
          { symbol: 'sUSDe', amount: exp(11, 18), priceDrop: 80n }, // 11 sUSDe = $11 initial
        ];
        const borrowAmount5 = exp(11, 6); // > baseBorrowMin $10

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount5);

          // Drop prices 25% for COMP/CRV/ARB/OP, 20% for sUSDe.
          // totalLCF after drops: $1.275+$0.41+$0.47+$0.93+$7.04 = $10.12 < $11 -> liquidatable.
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amounts: first 4 fully seized (outer minDebt), sUSDe partial', async () => {
          // Each of the first 4: outer minDebt -> _processDebtClosing -> CxLF < D -> seize all.
          for (const config of collateralConfigs.slice(0, 4)) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
            collateralsState[config.symbol].seizeAmount = config.amount;
            collateralsState[config.symbol].seizedValue = collateralValue;
            debtRemainingValue -= mulFactor(collateralValue, assetInfo.liquidationFactor.toBigInt());
          }

          // sUSDe: outer minDebt -> _processDebtClosing(dRemaining, sUSDe).
          // C_sUSDe x LF = $8.10 > dRemaining -> seize partial; surplus stays.
          const lastConfig = collateralConfigs[4];
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[lastConfig.symbol].address);
          const sUsdePrice = (await priceFeeds[lastConfig.symbol].latestRoundData())[1].toBigInt();
          const lf_susde = sUsdeInfo.liquidationFactor.toBigInt();
          collateralsState[lastConfig.symbol].seizeAmount = divPrice(debtRemainingValue * factorScale / lf_susde, sUsdePrice, sUsdeInfo.scale);
          collateralsState[lastConfig.symbol].seizedValue = mulPrice(collateralsState[lastConfig.symbol].seizeAmount, sUsdePrice, sUsdeInfo.scale);
        });

        for (const config of collateralConfigs) {
          it(`emits AbsorbCollateral for seized ${config.symbol}`, async () => {
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address,
              alice.address,
              tokens[config.symbol].address,
              collateralsState[config.symbol].seizeAmount,
              collateralsState[config.symbol].seizedValue
            );
          });
        }

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        for (const config of collateralConfigs.slice(0, 4)) {
          it(`alice ${config.symbol} collateral balance is zero - fully seized`, async () => {
            expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0n);
          });
        }

        it(`alice ${collateralConfigs[4].symbol} collateral balance is positive - surplus stays with user`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[4].symbol].address)).to.be.greaterThan(0n);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[4].symbol].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it(`alice ${collateralConfigs[4].symbol} collateral balance is reduced by the seized amount`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[4].symbol].address)).to.be.equal(collateralConfigs[4].amount - collateralsState[collateralConfigs[4].symbol].seizeAmount);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[4].symbol].address)).balance).to.be.equal(collateralConfigs[4].amount - collateralsState[collateralConfigs[4].symbol].seizeAmount);
        });

        it('alice assetsIn clears COMP bit', async () => {
          const expectedAssetsIn = assetsInBefore & ~(1 << 0);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(expectedAssetsIn);
        });

        it('alice reserved bits: only sUSDe bit kept (all others fully seized)', async () => {
          // CRV(17)→bit1, ARB(19)→bit3, OP(20)→bit4 are cleared after full seizure.
          // COMP(0) is in assetsIn (uint16, not _reserved). sUSDe(23)→bit7 stays (surplus remains).
          const expectedReserved = reservedBefore & (1 << (23 - 16));
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(expectedReserved);
        });

        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out', async () => {
          const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      context('24 collaterals: after absorb debt = 0 and some last collateral surplus (COMP 0 through sUSDe 23)', function () {
        // The first 23 collaterals are intentionally tiny and fully seized.
        // sUSDe is last at index 23 and is large enough to close the remaining debt
        // with surplus left on alice's balance.
        const collateralConfigs = [
          { symbol: 'COMP',  amount: exp(0.001, 18),    priceDrop: 75n }, // $0.10 initial
          { symbol: 'WETH',  amount: exp(0.00005, 18),  priceDrop: 75n }, // $0.10 initial
          { symbol: 'USDT',  amount: exp(0.1, 6),       priceDrop: 75n }, // $0.10 initial
          { symbol: 'WBTC',  amount: exp(0.000002, 8),  priceDrop: 75n }, // $0.13 initial
          { symbol: 'DAI',   amount: exp(0.1, 18),      priceDrop: 75n }, // $0.10 initial
          { symbol: 'wstETH', amount: exp(0.000028, 18), priceDrop: 75n }, // ≈ $0.10 initial
          { symbol: 'rsETH', amount: exp(0.00003, 18),  priceDrop: 75n }, // ≈ $0.10 initial
          { symbol: 'cbETH', amount: exp(0.00003, 18),  priceDrop: 75n }, // ≈ $0.10 initial
          { symbol: 'rETH',  amount: exp(0.000029, 18), priceDrop: 75n }, // ≈ $0.10 initial
          { symbol: 'weETH', amount: exp(0.00003, 18),  priceDrop: 75n }, // ≈ $0.10 initial
          { symbol: 'ezETH', amount: exp(0.00003, 18),  priceDrop: 75n }, // ≈ $0.10 initial
          { symbol: 'cbBTC', amount: exp(0.000002, 8),  priceDrop: 75n }, // $0.13 initial
          { symbol: 'tBTC',  amount: exp(0.000002, 18), priceDrop: 75n }, // $0.13 initial
          { symbol: 'LINK',  amount: exp(0.006667, 18), priceDrop: 75n }, // ≈ $0.10 initial
          { symbol: 'UNI',   amount: exp(0.0125, 18),   priceDrop: 75n }, // $0.10 initial
          { symbol: 'AAVE',  amount: exp(0.001, 18),    priceDrop: 75n }, // $0.10 initial
          { symbol: 'LDO',   amount: exp(0.05, 18),     priceDrop: 75n }, // $0.10 initial
          { symbol: 'CRV',   amount: exp(0.1, 18),      priceDrop: 75n }, // $0.10 initial
          { symbol: 'MKR',   amount: exp(0.00004, 18),  priceDrop: 75n }, // $0.10 initial
          { symbol: 'ARB',   amount: exp(0.1, 18),      priceDrop: 75n }, // $0.10 initial
          { symbol: 'OP',    amount: exp(0.05, 18),     priceDrop: 75n }, // $0.10 initial
          { symbol: 'GMX',   amount: exp(0.0025, 18),   priceDrop: 75n }, // $0.10 initial
          { symbol: 'USDe',  amount: exp(0.1, 18),      priceDrop: 75n }, // $0.10 initial
          { symbol: 'sUSDe', amount: exp(14, 18),       priceDrop: 80n }, // $14 initial
        ];
        const borrowAmount24 = exp(11, 6); // > baseBorrowMin $10

        let collateralsState: Record<string, CollateralState>;
        let absorbTx: ContractTransaction;
        let totalSupplyBaseBefore: BigNumber;
        let totalBorrowBaseBefore: BigNumber;
        let assetsInBefore: number;
        let reservedBefore: number;
        let balanceBefore: bigint;
        let debtRemainingValue: bigint;
        let cometBaseTokenBalanceBefore: BigNumber;

        before(async function () {
          for (const config of collateralConfigs) {
            await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
          }
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount24);

          // Drop the first 23 assets 25% and sUSDe 20%.
          // The first 23 are too small to close the debt; sUSDe closes the remainder with surplus.
          for (const config of collateralConfigs) {
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            await priceFeeds[config.symbol].connect(alice).setRoundData(0, price * config.priceDrop / 100n, 0, 0, 0);
          }
          await comet.accrueAccount(alice.address);

          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const userBasic = await comet.userBasic(alice.address);
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          assetsInBefore = userBasic.assetsIn;
          reservedBefore = userBasic._reserved;
          balanceBefore = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
          cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
          collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
        });

        after(async () => await snapshot.restore());

        it('sanity check: user is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('sanity check: debt value is greater than base borrow min value', () => {
          debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          const minDebtValue = mulPrice(baseBorrowMin, baseTokenPrice, baseScale);
          expect(debtRemainingValue).to.be.greaterThan(minDebtValue);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            absorbTx = await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
          await expect(absorbTx).to.not.be.reverted;
        });

        it('calculates seize amounts: first 23 fully seized (outer minDebt), sUSDe partial', async () => {
          // Each of the first 23: outer minDebt → _processDebtClosing → C×LF < D → seize all.
          for (const config of collateralConfigs.slice(0, 23)) {
            const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
            const price = (await priceFeeds[config.symbol].latestRoundData())[1].toBigInt();
            const collateralValue = mulPrice(config.amount, price, assetInfo.scale);
            collateralsState[config.symbol].seizeAmount = config.amount;
            collateralsState[config.symbol].seizedValue = collateralValue;
            debtRemainingValue -= mulFactor(collateralValue, assetInfo.liquidationFactor.toBigInt());
          }

          // sUSDe: outer minDebt → _processDebtClosing(dRemaining, sUSDe).
          // C_sUSDe × LF = $8.832 > dRemaining, so only part of sUSDe is seized.
          const lastConfig = collateralConfigs[23];
          const sUsdeInfo = await comet.getAssetInfoByAddress(tokens[lastConfig.symbol].address);
          const sUsdePrice = (await priceFeeds[lastConfig.symbol].latestRoundData())[1].toBigInt();
          const lf_susde = sUsdeInfo.liquidationFactor.toBigInt();
          const closeoutCollateralValueLeft = mulFactor(mulPrice(lastConfig.amount, sUsdePrice, sUsdeInfo.scale), lf_susde);
          expect(debtRemainingValue).to.be.lessThan(closeoutCollateralValueLeft);
          collateralsState[lastConfig.symbol].seizeAmount = divPrice(debtRemainingValue * factorScale / lf_susde, sUsdePrice, sUsdeInfo.scale);
          collateralsState[lastConfig.symbol].seizedValue = mulPrice(collateralsState[lastConfig.symbol].seizeAmount, sUsdePrice, sUsdeInfo.scale);
        });

        for (const config of collateralConfigs) {
          it(`emits AbsorbCollateral for seized ${config.symbol}`, async () => {
            await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
              absorber.address,
              alice.address,
              tokens[config.symbol].address,
              collateralsState[config.symbol].seizeAmount,
              collateralsState[config.symbol].seizedValue
            );
          });
        }

        it('emits AbsorbDebt for the full absorbed debt', async () => {
          const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
          await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut);
        });

        // User base balances
        it('alice principal is zero after absorb', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0);
        });

        it('alice borrow balance is zero after absorb', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });

        it('alice simple base balance is zero after absorb', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.equal(0);
        });

        // User collateral state
        for (const config of collateralConfigs.slice(0, 23)) {
          it(`alice ${config.symbol} collateral balance is zero — fully seized`, async () => {
            expect(await comet.collateralBalanceOf(alice.address, tokens[config.symbol].address)).to.equal(0);
            expect((await comet.userCollateral(alice.address, tokens[config.symbol].address)).balance).to.be.equal(0n);
          });
        }

        it(`alice ${collateralConfigs[23].symbol} collateral balance is positive — surplus stays with user`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[23].symbol].address)).to.be.greaterThan(0n);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[23].symbol].address)).balance).to.be.greaterThan(0n);
        });

        // We check that surplus is collateral amount - debt / (LP * collateral price).
        it(`alice ${collateralConfigs[23].symbol} collateral balance is reduced by the seized amount`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[23].symbol].address)).to.be.equal(collateralConfigs[23].amount - collateralsState[collateralConfigs[23].symbol].seizeAmount);
          expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[23].symbol].address)).balance).to.be.equal(collateralConfigs[23].amount - collateralsState[collateralConfigs[23].symbol].seizeAmount);
        });

        it('alice assetsIn bits are all cleared', async () => {
          expect(assetsInBefore).to.not.equal(0);
          expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
        });

        it('alice reserved bits: only sUSDe bit kept (all others fully seized)', async () => {
          // Indexes 16-22 are cleared after full seizure. sUSDe(23)→bit7 stays.
          const expectedReserved = reservedBefore & (1 << (23 - 16));
          expect((await comet.userBasic(alice.address))._reserved).to.be.equal(expectedReserved);
        });

        // Comet borrow state
        it('comet total borrow base is reduced by the base paid out', async () => {
          const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
          expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(-balanceBefore));
        });

        it('comet total supply base is unchanged', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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
          expect(await comet.getReserves()).to.be.equal(initialBaseFunding + balanceBefore);
        });
      });

      // absorb calls accrueInternal() as its very first action, advancing the global
      // interest indices to the current block before any seizure logic runs.
      // A third-party base supplier sets totalSupplyBase > baseMinForRewards so all four
      // indices - baseSupplyIndex, baseBorrowIndex, trackingSupplyIndex, trackingBorrowIndex
      // - grow over the 1-hour wait.
      context('absorb calls accrueInternal: all indices grow, lastAccrualTime is updated', function () {
        const AVERAGE_WAIT_TIME = 3600; // 1 hour in seconds
        const collateralKey = 'COMP';
        let lastAccrualTimeBefore: number;
        let baseSupplyIndexBefore: bigint;
        let baseBorrowIndexBefore: bigint;
        let trackingSupplyIndexBefore: bigint;
        let trackingBorrowIndexBefore: bigint;
        let totalSupplyBaseBefore: bigint;
        let totalBorrowBaseBefore: bigint;
        let supplyRateBefore: bigint;
        let borrowRateBefore: bigint;
        let trackingSupplySpeed: bigint;
        let trackingBorrowSpeed: bigint;
        let baseScaleValue: bigint;

        before(async function() {
          // Absorber supplies $100 USDC so totalSupplyBase > baseMinForRewards,
          // which enables both baseSupplyIndex and trackingSupplyIndex to grow.
          await baseToken.allocateTo(absorber.address, exp(100, 6));
          await baseToken.connect(absorber).approve(comet.address, ethers.constants.MaxUint256);
          await comet.connect(absorber).supply(baseToken.address, exp(100, 6));

          // Alice supplies COMP, borrows $70, then COMP drops to $70.
          // LCF-weighted = $70 × 0.85 = $59.5 < $70 debt → liquidatable.
          await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
          await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
          await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
          await comet.accrueAccount(alice.address);

          // Capture all state that accrueInternal() will use when absorb is called.
          // Utilization and rates are read here because no state-changing calls occur
          // between this point and absorb — evm_increaseTime only shifts timestamps.
          const utilization = await comet.getUtilization();
          const totalsBasic = await comet.totalsBasic();
          lastAccrualTimeBefore = totalsBasic.lastAccrualTime;
          baseSupplyIndexBefore = totalsBasic.baseSupplyIndex.toBigInt();
          baseBorrowIndexBefore = totalsBasic.baseBorrowIndex.toBigInt();
          trackingSupplyIndexBefore = totalsBasic.trackingSupplyIndex.toBigInt();
          trackingBorrowIndexBefore = totalsBasic.trackingBorrowIndex.toBigInt();
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
          supplyRateBefore = (await comet.getSupplyRate(utilization)).toBigInt();
          borrowRateBefore = (await comet.getBorrowRate(utilization)).toBigInt();
          trackingSupplySpeed = (await comet.baseTrackingSupplySpeed()).toBigInt();
          trackingBorrowSpeed = (await comet.baseTrackingBorrowSpeed()).toBigInt();
          baseScaleValue = (await comet.baseScale()).toBigInt();
        });

        after(async () => await snapshot.restore());

        it('sanity check: alice is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('1 hour passes', async () => {
          await ethers.provider.send('evm_increaseTime', [AVERAGE_WAIT_TIME]);
          await ethers.provider.send('evm_mine', []);
        });

        it('absorb is successful', async () => {
          if (viaLiquidationModule) {
            await liquidationModule.connect(absorber)['liquidate(address,address,bytes)'](absorber.address, alice.address, []);
          } else {
            await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          }
        });

        it('lastAccrualTime was advanced to the absorb block timestamp', async () => {
          const { lastAccrualTime } = await comet.totalsBasic();
          expect(lastAccrualTime).to.be.approximately(lastAccrualTimeBefore + AVERAGE_WAIT_TIME, 5); // 5 seconds tolerance
        });

        it('baseSupplyIndex increased', async () => {
          const { baseSupplyIndex, lastAccrualTime } = await comet.totalsBasic();
          const timeElapsed = BigInt(lastAccrualTime - lastAccrualTimeBefore);
          // baseSupplyIndex_ += baseSupplyIndex_ * supplyRate * timeElapsed / factorScale
          const expected = baseSupplyIndexBefore + baseSupplyIndexBefore * supplyRateBefore * timeElapsed / factorScale;
          expect(baseSupplyIndex.toBigInt()).to.equal(expected);
        });

        it('baseBorrowIndex increased', async () => {
          const { baseBorrowIndex, lastAccrualTime } = await comet.totalsBasic();
          const timeElapsed = BigInt(lastAccrualTime - lastAccrualTimeBefore);
          // baseBorrowIndex_ += baseBorrowIndex_ * borrowRate * timeElapsed / factorScale
          const expected = baseBorrowIndexBefore + baseBorrowIndexBefore * borrowRateBefore * timeElapsed / factorScale;
          expect(baseBorrowIndex.toBigInt()).to.equal(expected);
        });

        it('trackingSupplyIndex increased', async () => {
          const { trackingSupplyIndex, lastAccrualTime } = await comet.totalsBasic();
          const timeElapsed = BigInt(lastAccrualTime - lastAccrualTimeBefore);
          // divBaseWei(n, baseWei) = n * baseScale / baseWei
          const expected = trackingSupplyIndexBefore + trackingSupplySpeed * timeElapsed * baseScaleValue / totalSupplyBaseBefore;
          expect(trackingSupplyIndex.toBigInt()).to.equal(expected);
        });

        it('trackingBorrowIndex increased', async () => {
          const { trackingBorrowIndex, lastAccrualTime } = await comet.totalsBasic();
          const timeElapsed = BigInt(lastAccrualTime - lastAccrualTimeBefore);
          // divBaseWei(n, baseWei) = n * baseScale / baseWei
          const expected = trackingBorrowIndexBefore + trackingBorrowSpeed * timeElapsed * baseScaleValue / totalBorrowBaseBefore;
          expect(trackingBorrowIndex.toBigInt()).to.equal(expected);
        });
      });

      context('revert cases', function () {
        // absorbInternal calls getPrice(baseTokenPriceFeed) unconditionally before any
        // liquidatability check. A bad (zero) base price propagates BadPrice() through the
        // entire absorb path and reverts the whole call.
        context('base token price feed returns bad price during absorb', function () {
          let wasLiquidatable: boolean;
          const collateralKey = 'COMP';
          const baseTokenKey = 'USDC';

          before(async function() {
            await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
            await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
            // Drop COMP to $70: LCF-weighted value = $70 × 0.85 = $59.5 < $70 debt → liquidatable.
            // USDC price is still valid here so isLiquidatable() can be called safely.
            await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
            await comet.accrueAccount(alice.address);
            wasLiquidatable = await comet.isLiquidatable(alice.address);
            // Set USDC price to 0 — getPrice(baseTokenPriceFeed) will now revert with BadPrice
            await priceFeeds[baseTokenKey].connect(alice).setRoundData(0, 0, 0, 0, 0);
          });

          after(async () => await snapshot.restore());

          it('sanity check: alice was liquidatable before the base price feed was broken', () => {
            expect(wasLiquidatable).to.be.true;
          });

          it('absorb reverts because base token price feed returns bad price', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(comet, 'BadPrice');
          });
        });

        // absorbInternal calls getPrice(baseTokenPriceFeed) unconditionally before any
        // liquidatability check. A bad oracle reverts propagates revert error of the oracle through the
        // entire absorb path and reverts the whole call.
        context('base token price feed reverts during absorb', function () {
          let wasLiquidatable: boolean;
          const collateralKey = 'COMP';

          before(async function() {
            await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
            await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
            // Drop COMP to $70: LCF-weighted value = $70 × 0.85 = $59.5 < $70 debt → liquidatable.
            // USDC price is still valid here so isLiquidatable() can be called safely.
            await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
            await comet.accrueAccount(alice.address);

            wasLiquidatable = await comet.isLiquidatable(alice.address);

            await configurator.setBaseTokenPriceFeed(cometProxyAddress, priceFeedWithRevert.address);
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
          });

          after(async () => await snapshot.restore());

          it('sanity check: alice was liquidatable before the base price feed was broken', () => {
            expect(wasLiquidatable).to.be.true;
          });

          it('absorb reverts because base token price feed reverts', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
          });
        });

        // With BCF, LCF, LF all positive, _getLiquidity(account, true, []) fetches every
        // in-position collateral price. A reverting oracle blocks that call before the
        // protocol can evaluate whether the account is underwater.
        context('BCF, LCF and LF > 0: reverting collateral price feed blocks absorb', function () {
          let wasLiquidatable: boolean;
          const collateralKey = 'COMP';

          before(async function() {
            await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
            await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
            // Drop COMP to $70 via the still-active SimplePriceFeed — comet still uses it
            // because deployAndUpgradeTo has not been called yet.
            await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
            await comet.accrueAccount(alice.address);

            wasLiquidatable = await comet.isLiquidatable(alice.address);

            await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
            await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
            // Re-wire comet to a fresh module after the upgrade. Use a local: clobbering the
            // outer `liquidationModule` would leave a dangling reference after snapshot.restore()
            // reverts this deployment, breaking the next run's `before` hook.
            await deployAndUpdateLiquidationModule({ comet, governor });
          });

          after(async () => await snapshot.restore());

          it('sanity check: alice was liquidatable before switching to the reverting oracle', () => {
            expect(wasLiquidatable).to.be.true;
          });

          it('absorb reverts because the collateral price feed reverts', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
          });
        });

        // absorbInternal calls getPrice(baseTokenPriceFeed) unconditionally before any
        // liquidatability check. A zero oracle propagates BadPrice through the
        // entire absorb path and reverts the whole call.
        context('BCF, LCF and LF > 0: zero collateral price feed blocks absorb', function () {
          const collateralKey = 'COMP';
          let wasLiquidatable: boolean;

          before(async function() {
            await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
            await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

            // Drop COMP to $70 via the still-active SimplePriceFeed — comet still uses it
            // because deployAndUpgradeTo has not been called yet.
            await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
            await comet.accrueAccount(alice.address);

            wasLiquidatable = await comet.isLiquidatable(alice.address);

            await priceFeeds[collateralKey].connect(alice).setRoundData(0, 0, 0, 0, 0);
            await comet.accrueAccount(alice.address);
          });

          after(async () => await snapshot.restore());

          it('sanity check: alice was liquidatable before the collateral price feed was set to zero', () => {
            expect(wasLiquidatable).to.be.true;
          });

          it('sanity check: isLiquidatable reverts because the collateral price feed is zero', async () => {
            await expect(comet.isLiquidatable(alice.address))
              .to.be.revertedWithCustomError(comet, 'BadPrice');
          });

          it('absorb reverts because the collateral price feed is zero', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(comet, 'BadPrice');
          });
        });

        context('absorb reverts when user principal is positive', function () {
          before(async function() {
            await comet.connect(alice).supply(baseToken.address, exp(100, 6));
          });

          after(async () => await snapshot.restore());

          it('sanity check: principal is positive', async () => {
            expect((await comet.userBasic(alice.address)).principal).to.be.greaterThan(0);
          });

          it('sanity check: isLiquidatable returns false', async () => {
            expect(await comet.isLiquidatable(alice.address)).to.be.false;
          });

          // Contract computes uint256(-presentValue(positive_principal)) before the principal > 0
          // guard fires, which overflows in Solidity 0.8+. Absorb still reverts — just with panic.
          it('absorb reverts because alice has a positive principal', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
          });
        });

        context('absorb reverts when user principal is zero', function () {
          after(async () => await snapshot.restore());

          it('sanity check: principal is zero', async () => {
            expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
          });

          it('sanity check: isLiquidatable returns false', async () => {
            expect(await comet.isLiquidatable(alice.address)).to.be.false;
          });

          it('absorb reverts because alice has zero principal', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
          });
        });

        // absorbInternal hits `debtRemainingValue <= liquidity` when the account has debt
        // but the LCF-weighted collateral still covers it. A borrow-collateralized account
        // trivially satisfies this (BCF ≤ LCF), so it reverts with NotLiquidatable.
        context('absorb reverts when user has debt but is borrow collateralized', function () {
          const collateralKey = 'COMP';

          before(async function() {
          // 1 COMP at $100, BCF=0.8 → $80 borrow power; borrow $70 — fully collateralized.
          // LCF-weighted = $100 × 0.85 = $85 ≥ $70 debt → not liquidatable.
            await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
            await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
          });

          after(async () => await snapshot.restore());

          it('sanity check: user has debt', async () => {
            expect((await comet.userBasic(alice.address)).principal).to.be.lessThan(0);
          });

          it('sanity check: alice is borrow collateralized', async () => {
          // Note: we do not check isLiqquidatable here as BCF < LCF
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
          });

          it('sanity check: isLiquidatable returns false', async () => {
            expect(await comet.isLiquidatable(alice.address)).to.be.false;
          });

          it('absorb reverts because alice has debt but is not liquidatable', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
          });
        });

        // When COMP price sits between the BCF and LCF thresholds, the account is no longer
        // borrow-collateralized but LCF-weighted collateral still covers the debt, so
        // debtRemainingValue <= liquidity and absorb reverts with NotLiquidatable.
        context('absorb reverts when user has debt, is not borrow collateralized, but is not liquidatable', function () {
          const collateralKey = 'COMP';
      
          before(async function() {
          // 1 COMP at $100, borrow $70. Drop COMP to $85:
          // BCF-weighted = $85 × 0.8 = $68 < $70 → not borrow collateralized.
          // LCF-weighted = $85 × 0.85 = $72.25 ≥ $70 → not liquidatable.
            await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
            await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

            await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(85, 8), 0, 0, 0);
            await comet.accrueAccount(alice.address);
          });

          after(async () => await snapshot.restore());

          it('sanity check: user has debt', async () => {
            expect((await comet.userBasic(alice.address)).principal).to.be.lessThan(0);
          });

          it('sanity check: alice is not borrow collateralized', async () => {
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
          });

          it('sanity check: alice is not liquidatable', async () => {
            expect(await comet.isLiquidatable(alice.address)).to.be.false;
          });

          it('absorb reverts because alice is not liquidatable', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
          });
        });

        context('absorb reverts when liquidation is on pause and user is not liquidatable', function () {
          after(async () => await snapshot.restore());

          it('sanity check: alice is not liquidatable', async () => {
            expect(await comet.isLiquidatable(alice.address)).to.be.false;
          });

          it('set liquidation to pause', async () => {
            await comet.connect(governor).pause(false, false, false, true, false);
          });

          it('absorb reverts because liquidation is on pause before liquidatability matters', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(comet, 'Paused');
          });
        });

        context('absorb reverts when liquidation is on pause and user is liquidatable', function () {
          const collateralKey = 'COMP';

          before(async function() {
            await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
            await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

            // Drop COMP to $70: LCF-weighted value = $70 * 0.85 = $59.5 < $70 debt.
            await priceFeeds[collateralKey].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
            await comet.accrueAccount(alice.address);
          });

          after(async () => await snapshot.restore());

          it('sanity check: alice is liquidatable', async () => {
            expect(await comet.isLiquidatable(alice.address)).to.be.true;
          });

          it('set liquidation to pause', async () => {
            await comet.connect(governor).pause(false, false, false, true, false);
          });

          it('absorb reverts because liquidation is on pause', async () => {
            await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
              .to.be.revertedWithCustomError(comet, 'Paused');
          });
        });
      });
    });
  }

  /*//////////////////////////////////////////////////////////////
                             TESTS SETUP
  //////////////////////////////////////////////////////////////*/

  runAbsorbTests({ partialLiquidationEnabled: false, viaLiquidationModule: false }); // full debt close case
  runAbsorbTests({ partialLiquidationEnabled: true, viaLiquidationModule: false });
  runAbsorbTests({ partialLiquidationEnabled: true, viaLiquidationModule: true}); // entry point on the liquidation module, not comet
});
