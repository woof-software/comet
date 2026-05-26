import { ethers, expect, exp, default24Assets, makeConfigurator, mulPrice, mulFactor, factorScale, divPrice, presentValue, CollateralState, makeCollateralStates } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, FaucetToken, PriceFeedWithRevert, PriceFeedWithRevert__factory, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

describe('absorb: general logic', function () {
  let comet: CometHarnessInterfaceExtendedAssetList;
  let configurator: Configurator;
  let cometProxyAdmin: CometProxyAdmin;
  let configuratorProxyAddress: string;
  let cometProxyAddress: string;

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
    });
    configuratorProxyAddress = protocol.configuratorProxy.address;
    cometProxyAddress = protocol.cometProxy.address;
    configurator = protocol.configurator.attach(configuratorProxyAddress);
    comet = protocol.cometWithExtendedAssetList.attach(cometProxyAddress);
    cometProxyAdmin = protocol.proxyAdmin;

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

    snapshot = await takeSnapshot();
  });

  context('1 collateral: after absorb debt = 0 and some collateral surplus on user balance (COMP, index 0)', function () {
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
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop COMP from $100 to $79.  C × LCF = $67.15 < $70 → liquidatable.
      // target-HF formula residual ≈ $6.07 < baseBorrowMin $10 → minDebt branch.
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      const newCompPrice = compPrice * 79n / 100n;
      await priceFeeds['COMP'].connect(alice).setRoundData(0, newCompPrice, 0, 0, 0);
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

    it('calculates seize amount and seized value via minDebt path full closure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      const lf = assetInfo.liquidationFactor.toBigInt();

      // Actual debt value at the time absorb ran.
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // _processDebtClosing: C × LF = $71.10 > D = $70 → seize exactly D / LF of COMP.
      // seizedValue = D (full debt repaid); seizeAmount = D / LF / compPrice (in COMP tokens).
      collateralsState['COMP'].seizeAmount = divPrice(debtRemainingValue * factorScale / lf, compPrice, assetInfo.scale);
      collateralsState['COMP'].seizedValue = debtRemainingValue;
    });

    it('newBalance is zero after full closure', async () => {
      // _processDebtClosing wipes the entire debt.
      newBalance = 0n;
    });

    it('newPrincipal matches newBalance', async () => {
      const newPrincipal = (await comet.userBasic(alice.address)).principal;
      expect(newPrincipal).to.equal(newBalance);
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('alice collateral balance is positive — surplus stays with user', async () => {
      // seize D / LF ≈ 0.984 COMP; ≈ 0.016 COMP remains
      const remaining = (await comet.collateralBalanceOf(alice.address, tokens['COMP'].address)).toBigInt();
      expect(remaining).to.be.greaterThan(0n);
    });

    it('alice collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens['COMP'].address);
      expect(collateralBalance).to.be.equal(collateralAmount - collateralsState['COMP'].seizeAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(false);
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

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice assetsIn does not change', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
    });

    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address))
        .to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('1 collateral: after absorb debt = 0 and some collateral surplus on user balance (LDO, index 16)', function () {
    const ldoSupplyAmount = exp(10, 18);
    const ldoBorrowAmount = exp(10, 6); // = baseBorrowMin = $10
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
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens['LDO'].address, ldoSupplyAmount);
      await comet.connect(alice).withdraw(baseToken.address, ldoBorrowAmount);

      // Drop LDO from $2 to $1.60 (20%). C × LCF = $9.92 < $10 → liquidatable.
      // D = $10 = minDebtValue → outer minDebt fires on first iteration.
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();
      await priceFeeds['LDO'].connect(alice).setRoundData(0, ldoPrice * 80n / 100n, 0, 0, 0);
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

    it('calculates seize amount and seized value via _processDebtClosing full closure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();
      const lf = assetInfo.liquidationFactor.toBigInt();

      // D ≤ minDebt → outer branch → _processDebtClosing.
      // C × LF = $13.60 > D = $10 → seize exactly D / LF of LDO; surplus stays.
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      collateralsState['LDO'].seizeAmount = divPrice(debtRemainingValue * factorScale / lf, ldoPrice, assetInfo.scale);
      collateralsState['LDO'].seizedValue = debtRemainingValue;
    });

    it('newBalance is zero after full closure', async () => {
      newBalance = 0n;
    });

    it('newPrincipal matches newBalance', async () => {
      const newPrincipal = (await comet.userBasic(alice.address)).principal;
      expect(newPrincipal).to.equal(newBalance);
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('alice collateral balance is positive — surplus stays with user', async () => {
      // seize D / LF ≈ 7.35 LDO; ≈ 2.65 LDO remains
      const remaining = await comet.collateralBalanceOf(alice.address, tokens['LDO'].address);
      expect(remaining).to.be.greaterThan(0n);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(false);
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

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice assetsIn does not change', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['LDO'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['LDO'].totalsCollateralBefore.sub(collateralsState['LDO'].seizeAmount));
    });

    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['LDO'].address))
        .to.be.equal(collateralsState['LDO'].collateralReservesBefore.add(collateralsState['LDO'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('1 collateral: after absorb debt = 0 and some collateral surplus on user balance (sUSDe, index 23)', function () {
    const sUsdeSupplyAmount = exp(15, 18);
    const sUsdeBorrowAmount = exp(10, 6); // = baseBorrowMin = $10
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
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens['sUSDe'].address, sUsdeSupplyAmount);
      await comet.connect(alice).withdraw(baseToken.address, sUsdeBorrowAmount);

      // Drop sUSDe from $1 to $0.80 (20%). C × LCF = $9.60 < $10 → liquidatable.
      // D = $10 = minDebtValue → outer minDebt fires on first iteration.
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();
      await priceFeeds['sUSDe'].connect(alice).setRoundData(0, sUsdePrice * 80n / 100n, 0, 0, 0);
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

    it('calculates seize amount and seized value via _processDebtClosing full closure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();
      const lf = assetInfo.liquidationFactor.toBigInt();

      // D ≤ minDebt → outer branch → _processDebtClosing.
      // C × LF = $11.04 > D = $10 → seize exactly D / LF of sUSDe; surplus stays.
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      collateralsState['sUSDe'].seizeAmount = divPrice(debtRemainingValue * factorScale / lf, sUsdePrice, assetInfo.scale);
      collateralsState['sUSDe'].seizedValue = debtRemainingValue;
    });

    it('newBalance is zero after full closure', async () => {
      newBalance = 0n;
    });

    it('newPrincipal is zero after full closure', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.equal(0);
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('alice collateral balance is positive — surplus stays with user', async () => {
      // seize D / LF ≈ 13.59 sUSDe; ≈ 1.41 sUSDe remains
      expect(await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address)).to.be.greaterThan(0);
    });

    it('alice collateral balance is reduced by the seized amount after absorb', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address)).to.be.equal(sUsdeSupplyAmount - collateralsState['sUSDe'].seizeAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(false);
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

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice assetsIn does not change', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied collateral is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['sUSDe'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['sUSDe'].totalsCollateralBefore.sub(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['sUSDe'].address))
        .to.be.equal(collateralsState['sUSDe'].collateralReservesBefore.add(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('2 collaterals: after absorb debt = 0 and some 2nd collateral surplus (COMP index 0, WETH index 1)', function () {
    const compSupplyAmount = exp(1, 18);    // 1 COMP
    const wethSupplyAmount = exp(6, 15);    // 0.006 WETH = $12
    const multiColBorrowAmount = exp(86, 6); // $86
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
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens['COMP'].address, compSupplyAmount);
      await comet.connect(alice).supply(tokens['WETH'].address, wethSupplyAmount);
      await comet.connect(alice).withdraw(baseToken.address, multiColBorrowAmount);

      // Drop COMP 15%: $100 → $85. totalLCF = $72.25 + $9.60 = $81.85 < $86 → liquidatable.
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      await priceFeeds['COMP'].connect(alice).setRoundData(0, compPrice * 85n / 100n, 0, 0, 0);
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

    it('calculates seize amounts: COMP fully seized (else branch), WETH partial (outer minDebt)', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens['WETH'].address);
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      const wethPrice = (await priceFeeds['WETH'].latestRoundData())[1].toBigInt();
      const lf_comp = compInfo.liquidationFactor.toBigInt();
      const lf_weth = wethInfo.liquidationFactor.toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // Iter 1 (COMP): wantedCV ≈ $91.72 > collateralValue $85 → else branch → seize all COMP.
      // seizedValue = C × LF = $85 × 0.90 = $76.50
      const compCollateralValue = mulPrice(compSupplyAmount, compPrice, compInfo.scale);
      collateralsState['COMP'].seizeAmount = compSupplyAmount;
      collateralsState['COMP'].seizedValue = mulFactor(compCollateralValue, lf_comp);

      const debtAfterComp = debtRemainingValue - collateralsState['COMP'].seizedValue;

      // Iter 2 (WETH): debtAfterComp ≈ $9.50 ≤ minDebtValue $10 → outer minDebt → _processDebtClosing.
      // C × LF = $10.80 > debtAfterComp → seize exactly debtAfterComp / LF of WETH.
      collateralsState['WETH'].seizeAmount = divPrice(debtAfterComp * factorScale / lf_weth, wethPrice, wethInfo.scale);
      collateralsState['WETH'].seizedValue = debtAfterComp;
    });

    it('newBalance is zero after full closure', async () => {
      newBalance = 0n;
    });

    it('newPrincipal matches newBalance', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.equal(newBalance);
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('alice COMP collateral balance is zero — fully seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['COMP'].address)).to.equal(0);
    });

    it('alice WETH collateral balance is positive — surplus stays with user', async () => {
      // debtAfterComp ≈ $9.50; seize ≈ 0.00528 WETH; ≈ 0.00072 WETH remains
      expect(await comet.collateralBalanceOf(alice.address, tokens['WETH'].address)).to.be.greaterThan(0);
    });

    it('alice WETH collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens['WETH'].address);
      expect(collateralBalance).to.be.equal(wethSupplyAmount - collateralsState['WETH'].seizeAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(false);
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

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied COMP is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['WETH'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['WETH'].totalsCollateralBefore.sub(collateralsState['WETH'].seizeAmount));
    });

    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet COMP collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address))
        .to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet WETH collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['WETH'].address))
        .to.be.equal(collateralsState['WETH'].collateralReservesBefore.add(collateralsState['WETH'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('2 collaterals: after absorb debt = 0 and some 2nd collateral surplus (AAVE index 15, LDO index 16)', function () {
    const aaveSupplyAmount = exp(1, 17);     // 0.1 AAVE = $10
    const ldoSupplyAmount = exp(10, 18);     // 10 LDO = $20 → $15 after drop
    const aaveLdoBorrowAmount = exp(16, 6);  // $16
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
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens['AAVE'].address, aaveSupplyAmount);
      await comet.connect(alice).supply(tokens['LDO'].address, ldoSupplyAmount);
      await comet.connect(alice).withdraw(baseToken.address, aaveLdoBorrowAmount);

      // Drop LDO 25%: $2 → $1.50. totalLCF = $6.50 + $9.30 = $15.80 < $16 → liquidatable.
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();
      await priceFeeds['LDO'].connect(alice).setRoundData(0, ldoPrice * 75n / 100n, 0, 0, 0);
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

    it('calculates seize amounts: AAVE fully seized (inner minDebt), LDO partial (outer minDebt)', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens['AAVE'].address);
      const ldoInfo = await comet.getAssetInfoByAddress(tokens['LDO'].address);
      const aavePrice = (await priceFeeds['AAVE'].latestRoundData())[1].toBigInt();
      const ldoPrice = (await priceFeeds['LDO'].latestRoundData())[1].toBigInt();
      const lf_aave = aaveInfo.liquidationFactor.toBigInt();
      const lf_ldo = ldoInfo.liquidationFactor.toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // Iter 1 (AAVE): wantedCV ≈ $8.72 < $10, partial branch taken.
      // D - seizedValue_target ≈ $8.59 ≤ $10 → inner minDebt → _processDebtClosing(D, AAVE).
      // C_AAVE × LF = $8.50 < D = $16 → seize all AAVE; seizedValue = C_AAVE × LF.
      const aaveCollateralValue = mulPrice(aaveSupplyAmount, aavePrice, aaveInfo.scale);
      collateralsState['AAVE'].seizeAmount = aaveSupplyAmount;
      collateralsState['AAVE'].seizedValue = mulFactor(aaveCollateralValue, lf_aave);

      const debtAfterAave = debtRemainingValue - collateralsState['AAVE'].seizedValue;

      // Iter 2 (LDO): debtAfterAave ≈ $7.50 ≤ minDebtValue $10 → outer minDebt → _processDebtClosing.
      // C_LDO × LF = $12.75 > debtAfterAave → seize exactly debtAfterAave / LF of LDO; surplus stays.
      collateralsState['LDO'].seizeAmount = divPrice(debtAfterAave * factorScale / lf_ldo, ldoPrice, ldoInfo.scale);
      collateralsState['LDO'].seizedValue = debtAfterAave;
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('newPrincipal matches newBalance', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.equal(newBalance);
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('alice AAVE collateral balance is zero — fully seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['AAVE'].address)).to.equal(0);
    });

    it('alice LDO collateral balance is positive — surplus stays with user', async () => {
      // debtAfterAave ≈ $7.50; seize ≈ 5.88 LDO; ≈ 4.12 LDO remains
      expect(await comet.collateralBalanceOf(alice.address, tokens['LDO'].address)).to.be.greaterThan(0n);
    });

    it('alice LDO collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens['LDO'].address);
      expect(collateralBalance).to.be.equal(ldoSupplyAmount - collateralsState['LDO'].seizeAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(false);
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

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice reserved bits do not change', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied AAVE is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['AAVE'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['AAVE'].totalsCollateralBefore.sub(collateralsState['AAVE'].seizeAmount));
    });

    it('comet total supplied LDO is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['LDO'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['LDO'].totalsCollateralBefore.sub(collateralsState['LDO'].seizeAmount));
    });

    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet AAVE collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['AAVE'].address))
        .to.be.equal(collateralsState['AAVE'].collateralReservesBefore.add(collateralsState['AAVE'].seizeAmount));
    });

    it('comet LDO collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['LDO'].address))
        .to.be.equal(collateralsState['LDO'].collateralReservesBefore.add(collateralsState['LDO'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('2 collaterals: after absorb debt = 0 and some 2nd collateral surplus (USDe index 22, sUSDe index 23)', function () {
    const usdeSupplyAmount = exp(4, 18);      // 4 USDe → $3.40 after 15% drop
    const sUsdeSupplyAmount = exp(10, 18);    // 10 sUSDe → $8.00 after 20% drop
    const usdeSUsdeBorrowAmount = exp(10, 6); // $10 = baseBorrowMin
    const collateralKeys = ['USDe', 'sUSDe'];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let reservedBefore: number;
    let debtRemainingValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens['USDe'].address, usdeSupplyAmount);
      await comet.connect(alice).supply(tokens['sUSDe'].address, sUsdeSupplyAmount);
      await comet.connect(alice).withdraw(baseToken.address, usdeSUsdeBorrowAmount);

      // Drop USDe 15%: $1 → $0.85. Drop sUSDe 20%: $1 → $0.80.
      // totalLCF = $3.40×0.82 + $8×0.80 = $9.19 < $10 → liquidatable.
      const usdePrice = (await priceFeeds['USDe'].latestRoundData())[1].toBigInt();
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();
      await priceFeeds['USDe'].connect(alice).setRoundData(0, usdePrice * 85n / 100n, 0, 0, 0);
      await priceFeeds['sUSDe'].connect(alice).setRoundData(0, sUsdePrice * 80n / 100n, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      const userBasic = await comet.userBasic(alice.address);
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

    it('calculates seize amounts: USDe fully seized (outer minDebt, D > C×LF), sUSDe partial (outer minDebt)', async () => {
      const usdeInfo = await comet.getAssetInfoByAddress(tokens['USDe'].address);
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const usdePrice = (await priceFeeds['USDe'].latestRoundData())[1].toBigInt();
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();
      const lf_usde = usdeInfo.liquidationFactor.toBigInt();
      const lf_susde = sUsdeInfo.liquidationFactor.toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // Iter 1 (USDe): D=$10 = minDebtValue → outer minDebt → _processDebtClosing(D, USDe).
      // C_USDe × LF = $3.40 × 0.92 = $3.13 < D → seize all USDe; seizedValue = C_USDe × LF.
      const usdeCollateralValue = mulPrice(usdeSupplyAmount, usdePrice, usdeInfo.scale);
      collateralsState['USDe'].seizeAmount = usdeSupplyAmount;
      collateralsState['USDe'].seizedValue = mulFactor(usdeCollateralValue, lf_usde);

      const debtAfterUsde = debtRemainingValue - collateralsState['USDe'].seizedValue;

      // Iter 2 (sUSDe): debtAfterUsde ≈ $6.87 ≤ minDebtValue $10 → outer minDebt → _processDebtClosing.
      // C_sUSDe × LF = $7.36 > debtAfterUsde → seize exactly debtAfterUsde / LF of sUSDe; surplus stays.
      collateralsState['sUSDe'].seizeAmount = divPrice(debtAfterUsde * factorScale / lf_susde, sUsdePrice, sUsdeInfo.scale);
      collateralsState['sUSDe'].seizedValue = debtAfterUsde;
    });

    it('newBalance is zero after full closure', async () => {
      newBalance = 0n;
    });

    it('newPrincipal matches newBalance', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.equal(newBalance);
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('alice USDe collateral balance is zero — fully seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['USDe'].address)).to.equal(0);
    });

    it('alice sUSDe collateral balance is positive — surplus stays with user', async () => {
      // debtAfterUsde ≈ $6.87; seize ≈ 9.34 sUSDe; ≈ 0.66 sUSDe remains
      expect(await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address)).to.be.greaterThan(0n);
    });

    it('alice sUSDe collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address);
      expect(collateralBalance).to.be.equal(sUsdeSupplyAmount - collateralsState['sUSDe'].seizeAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(false);
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

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('comet total supplied USDe is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['USDe'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['USDe'].totalsCollateralBefore.sub(collateralsState['USDe'].seizeAmount));
    });

    it('comet total supplied sUSDe is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['sUSDe'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['sUSDe'].totalsCollateralBefore.sub(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet USDe collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['USDe'].address))
        .to.be.equal(collateralsState['USDe'].collateralReservesBefore.add(collateralsState['USDe'].seizeAmount));
    });

    it('comet sUSDe collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['sUSDe'].address))
        .to.be.equal(collateralsState['sUSDe'].collateralReservesBefore.add(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    it('alice reserved bits are changed: USDe bit cleared, sUSDe bit kept', async () => {
      // USDe is at asset index 22 → bit (22-16)=6 in _reserved; cleared after full seizure.
      // sUSDe is at asset index 23 → bit 7 in _reserved; kept because surplus remains.
      const expectedReserved = reservedBefore ^ (1 << (22 - 16));
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(expectedReserved);
    });
  });

  context('2 collaterals: after absorb debt = 0 and some 2nd collateral surplus (ezETH index 10, OP index 20)', function () {
    const ezethSupplyAmount = exp(1, 17);   // 0.1 ezETH
    const opSupplyAmount = exp(15, 18);     // 15 OP = $30
    const borrowAmount248 = exp(248, 6);    // $248
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
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens['ezETH'].address, ezethSupplyAmount);
      await comet.connect(alice).supply(tokens['OP'].address, opSupplyAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount248);

      // Drop ezETH 25%: $3350 → $2512.50. totalLCF = $190.95 + $18.60 = $209.55 < $248 → liquidatable.
      const ezethPrice = (await priceFeeds['ezETH'].latestRoundData())[1].toBigInt();
      await priceFeeds['ezETH'].connect(alice).setRoundData(0, ezethPrice * 75n / 100n, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = (await comet.userBasic(alice.address))._reserved;
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

    it('calculates seize amounts: ezETH fully seized (else branch), OP partial (inner minDebt)', async () => {
      const ezethInfo = await comet.getAssetInfoByAddress(tokens['ezETH'].address);
      const opInfo = await comet.getAssetInfoByAddress(tokens['OP'].address);
      const ezethPrice = (await priceFeeds['ezETH'].latestRoundData())[1].toBigInt();
      const opPrice = (await priceFeeds['OP'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // Iter 1 (ezETH): wantedCV ≈ $266 > C_ezETH → else branch → seize all ezETH.
      const ezethCV = mulPrice(ezethSupplyAmount, ezethPrice, ezethInfo.scale);
      collateralsState['ezETH'].seizeAmount = ezethSupplyAmount;
      collateralsState['ezETH'].seizedValue = mulFactor(ezethCV, ezethInfo.liquidationFactor.toBigInt());

      const debtAfterEzETH = debtRemainingValue - collateralsState['ezETH'].seizedValue;

      // Iter 2 (OP): partial branch, then inner minDebt → _processDebtClosing(debtAfterEzETH, OP).
      // C_OP × LF = $25.50 > debtAfterEzETH ≈ $19.36 → seize exactly debtAfterEzETH / LF.
      const lf_op = opInfo.liquidationFactor.toBigInt();
      collateralsState['OP'].seizeAmount = divPrice(debtAfterEzETH * factorScale / lf_op, opPrice, opInfo.scale);
      collateralsState['OP'].seizedValue = debtAfterEzETH;
    });

    it('newBalance is zero after full closure', async () => {
      newBalance = 0n;
    });

    it('newPrincipal matches newBalance', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.equal(newBalance);
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('alice ezETH collateral balance is zero — fully seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['ezETH'].address)).to.equal(0);
    });

    it('alice OP collateral balance is positive — surplus stays with user', async () => {
      // debtAfterEzETH ≈ $19.36; seize ≈ 11.39 OP; ≈ 3.61 OP remains
      expect(await comet.collateralBalanceOf(alice.address, tokens['OP'].address)).to.be.greaterThan(0n);
    });

    it('alice OP collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens['OP'].address);
      expect(collateralBalance).to.be.equal(opSupplyAmount - collateralsState['OP'].seizeAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(false);
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

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice reserved bits do not change — OP bit kept because surplus remains', async () => {
      // ezETH (index 10) is in assetsIn (uint16), not _reserved. OP (index 20) → bit 4 of _reserved.
      // ezETH fully seized clears its assetsIn bit; OP partial → _reserved bit 4 stays.
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('comet total supplied ezETH is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['ezETH'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['ezETH'].totalsCollateralBefore.sub(collateralsState['ezETH'].seizeAmount));
    });

    it('comet total supplied OP is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['OP'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['OP'].totalsCollateralBefore.sub(collateralsState['OP'].seizeAmount));
    });

    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet ezETH collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['ezETH'].address))
        .to.be.equal(collateralsState['ezETH'].collateralReservesBefore.add(collateralsState['ezETH'].seizeAmount));
    });

    it('comet OP collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['OP'].address))
        .to.be.equal(collateralsState['OP'].collateralReservesBefore.add(collateralsState['OP'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  context('5 collaterals: after absorb debt = 0 and some last collateral surplus (COMP 0, CRV 17, ARB 19, OP 20, sUSDe 23)', function () {
    const compSupplyAmount5 = exp(2, 16);    // 0.02 COMP = $2 initial
    const crvSupplyAmount = exp(1, 18);      // 1 CRV = $1 initial
    const arbSupplyAmount = exp(1, 18);      // 1 ARB = $1 initial
    const opSupplyAmount5 = exp(1, 18);      // 1 OP  = $2 initial
    const sUsdeSupplyAmount5 = exp(10, 18);  // 10 sUSDe = $10 initial
    const borrowAmount5 = exp(10, 6);        // $10 = baseBorrowMin
    const collateralKeys = ['COMP', 'CRV', 'ARB', 'OP', 'sUSDe'];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function () {
      await comet.connect(alice).supply(tokens['COMP'].address, compSupplyAmount5);
      await comet.connect(alice).supply(tokens['CRV'].address, crvSupplyAmount);
      await comet.connect(alice).supply(tokens['ARB'].address, arbSupplyAmount);
      await comet.connect(alice).supply(tokens['OP'].address, opSupplyAmount5);
      await comet.connect(alice).supply(tokens['sUSDe'].address, sUsdeSupplyAmount5);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount5);

      // Drop prices 25% for COMP/CRV/ARB/OP, 20% for sUSDe.
      // totalLCF after drops: $1.275+$0.41+$0.47+$0.93+$6.40 = $9.49 < $10 → liquidatable.
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      const crvPrice  = (await priceFeeds['CRV'].latestRoundData())[1].toBigInt();
      const arbPrice  = (await priceFeeds['ARB'].latestRoundData())[1].toBigInt();
      const opPrice   = (await priceFeeds['OP'].latestRoundData())[1].toBigInt();
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();
      await priceFeeds['COMP'].connect(alice).setRoundData(0, compPrice  * 75n / 100n, 0, 0, 0);
      await priceFeeds['CRV'].connect(alice).setRoundData(0,  crvPrice   * 75n / 100n, 0, 0, 0);
      await priceFeeds['ARB'].connect(alice).setRoundData(0,  arbPrice   * 75n / 100n, 0, 0, 0);
      await priceFeeds['OP'].connect(alice).setRoundData(0,   opPrice    * 75n / 100n, 0, 0, 0);
      await priceFeeds['sUSDe'].connect(alice).setRoundData(0, sUsdePrice * 80n / 100n, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = (await comet.userBasic(alice.address))._reserved;
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

    it('calculates seize amounts: first 4 fully seized (outer minDebt), sUSDe partial', async () => {
      const compInfo  = await comet.getAssetInfoByAddress(tokens['COMP'].address);
      const crvInfo   = await comet.getAssetInfoByAddress(tokens['CRV'].address);
      const arbInfo   = await comet.getAssetInfoByAddress(tokens['ARB'].address);
      const opInfo    = await comet.getAssetInfoByAddress(tokens['OP'].address);
      const sUsdeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const compPrice  = (await priceFeeds['COMP'].latestRoundData())[1].toBigInt();
      const crvPrice   = (await priceFeeds['CRV'].latestRoundData())[1].toBigInt();
      const arbPrice   = (await priceFeeds['ARB'].latestRoundData())[1].toBigInt();
      const opPrice    = (await priceFeeds['OP'].latestRoundData())[1].toBigInt();
      const sUsdePrice = (await priceFeeds['sUSDe'].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // Each of the first 4: outer minDebt → _processDebtClosing → C×LF < D → seize all.
      // seizedValue = C × LF; track running debt remainder.
      collateralsState['COMP'].seizeAmount = compSupplyAmount5;
      collateralsState['COMP'].seizedValue = mulFactor(mulPrice(compSupplyAmount5, compPrice, compInfo.scale), compInfo.liquidationFactor.toBigInt());
      let dRemaining = debtRemainingValue - collateralsState['COMP'].seizedValue;

      collateralsState['CRV'].seizeAmount = crvSupplyAmount;
      collateralsState['CRV'].seizedValue = mulFactor(mulPrice(crvSupplyAmount, crvPrice, crvInfo.scale), crvInfo.liquidationFactor.toBigInt());
      dRemaining -= collateralsState['CRV'].seizedValue;

      collateralsState['ARB'].seizeAmount = arbSupplyAmount;
      collateralsState['ARB'].seizedValue = mulFactor(mulPrice(arbSupplyAmount, arbPrice, arbInfo.scale), arbInfo.liquidationFactor.toBigInt());
      dRemaining -= collateralsState['ARB'].seizedValue;

      collateralsState['OP'].seizeAmount = opSupplyAmount5;
      collateralsState['OP'].seizedValue = mulFactor(mulPrice(opSupplyAmount5, opPrice, opInfo.scale), opInfo.liquidationFactor.toBigInt());
      dRemaining -= collateralsState['OP'].seizedValue;

      // sUSDe: outer minDebt → _processDebtClosing(dRemaining, sUSDe).
      // C_sUSDe × LF = $7.36 > dRemaining ≈ $6.14 → seize partial; surplus stays.
      const lf_susde = sUsdeInfo.liquidationFactor.toBigInt();
      collateralsState['sUSDe'].seizeAmount = divPrice(dRemaining * factorScale / lf_susde, sUsdePrice, sUsdeInfo.scale);
      collateralsState['sUSDe'].seizedValue = dRemaining;
    });

    it('newBalance is zero after full closure', async () => {
      newBalance = 0n;
    });

    it('newPrincipal matches newBalance', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.equal(newBalance);
    });

    it('alice borrow balance is zero after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
    });

    it('alice COMP collateral balance is zero — fully seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['COMP'].address)).to.equal(0);
    });

    it('alice CRV collateral balance is zero — fully seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['CRV'].address)).to.equal(0);
    });

    it('alice ARB collateral balance is zero — fully seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['ARB'].address)).to.equal(0);
    });

    it('alice OP collateral balance is zero — fully seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens['OP'].address)).to.equal(0);
    });

    it('alice sUSDe collateral balance is positive — surplus stays with user', async () => {
      // dRemaining ≈ $6.14; seize ≈ 8.34 sUSDe; ≈ 1.66 sUSDe remains
      expect(await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address)).to.be.greaterThan(0n);
    });

    it('alice sUSDe collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens['sUSDe'].address);
      expect(collateralBalance).to.be.equal(sUsdeSupplyAmount5 - collateralsState['sUSDe'].seizeAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.equal(false);
    });

    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('comet ERC20 base token balance does not change during absorb', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice reserved bits: only sUSDe bit kept (all others fully seized)', async () => {
      // CRV(17)→bit1, ARB(19)→bit3, OP(20)→bit4 are cleared after full seizure.
      // COMP(0) is in assetsIn (uint16, not _reserved). sUSDe(23)→bit7 stays (surplus remains).
      const expectedReserved = reservedBefore & (1 << (23 - 16));
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(expectedReserved);
    });

    it('comet total supplied COMP is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['COMP'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['COMP'].totalsCollateralBefore.sub(collateralsState['COMP'].seizeAmount));
    });

    it('comet total supplied CRV is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['CRV'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['CRV'].totalsCollateralBefore.sub(collateralsState['CRV'].seizeAmount));
    });

    it('comet total supplied ARB is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['ARB'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['ARB'].totalsCollateralBefore.sub(collateralsState['ARB'].seizeAmount));
    });

    it('comet total supplied OP is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['OP'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['OP'].totalsCollateralBefore.sub(collateralsState['OP'].seizeAmount));
    });

    it('comet total supplied sUSDe is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens['sUSDe'].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState['sUSDe'].totalsCollateralBefore.sub(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet COMP collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['COMP'].address))
        .to.be.equal(collateralsState['COMP'].collateralReservesBefore.add(collateralsState['COMP'].seizeAmount));
    });

    it('comet CRV collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['CRV'].address))
        .to.be.equal(collateralsState['CRV'].collateralReservesBefore.add(collateralsState['CRV'].seizeAmount));
    });

    it('comet ARB collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['ARB'].address))
        .to.be.equal(collateralsState['ARB'].collateralReservesBefore.add(collateralsState['ARB'].seizeAmount));
    });

    it('comet OP collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['OP'].address))
        .to.be.equal(collateralsState['OP'].collateralReservesBefore.add(collateralsState['OP'].seizeAmount));
    });

    it('comet sUSDe collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens['sUSDe'].address))
        .to.be.equal(collateralsState['sUSDe'].collateralReservesBefore.add(collateralsState['sUSDe'].seizeAmount));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });
  });

  // absorb calls accrueInternal() as its very first action, advancing the global
  // interest indices to the current block before any seizure logic runs.
  // A third-party base supplier sets totalSupplyBase > baseMinForRewards so all four
  // indices - baseSupplyIndex, baseBorrowIndex, trackingSupplyIndex, trackingBorrowIndex
  // - grow over the 1-hour wait.
  context('absorb calls accrueInternal: all indices grow, lastAccrualTime is updated', function () {
    const AVERAGE_WAIT_TIME = 3600; // 1 hour in seconds

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
      await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
      await priceFeeds['COMP'].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
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
      expect(await comet.isLiquidatable(alice.address)).to.equal(true);
    });

    it('1 hour passes', async () => {
      await ethers.provider.send('evm_increaseTime', [AVERAGE_WAIT_TIME]);
      await ethers.provider.send('evm_mine', []);
    });

    it('absorb is successful', async () => {
      await expect(
        comet.connect(absorber).absorb(absorber.address, [alice.address])
      ).to.not.be.reverted;
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

      before(async function() {
        await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
        // Drop COMP to $70: LCF-weighted value = $70 × 0.85 = $59.5 < $70 debt → liquidatable.
        // USDC price is still valid here so isLiquidatable() can be called safely.
        await priceFeeds['COMP'].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
        await comet.accrueAccount(alice.address);
        wasLiquidatable = await comet.isLiquidatable(alice.address);
        // Set USDC price to 0 — getPrice(baseTokenPriceFeed) will now revert with BadPrice
        await priceFeeds['USDC'].connect(alice).setRoundData(0, 0, 0, 0, 0);
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

      before(async function() {
        await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
        // Drop COMP to $70: LCF-weighted value = $70 × 0.85 = $59.5 < $70 debt → liquidatable.
        // USDC price is still valid here so isLiquidatable() can be called safely.
        await priceFeeds['COMP'].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
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

      before(async function() {
        await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
        // Drop COMP to $70 via the still-active SimplePriceFeed — comet still uses it
        // because deployAndUpgradeTo has not been called yet.
        await priceFeeds['COMP'].connect(alice).setRoundData(0, exp(70, 8), 0, 0, 0);
        await comet.accrueAccount(alice.address);

        wasLiquidatable = await comet.isLiquidatable(alice.address);

        await configurator.updateAssetPriceFeed(cometProxyAddress, tokens['COMP'].address, priceFeedWithRevert.address);
        await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
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
      before(async function() {
        await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount);
        // Drop COMP to $70 via the still-active SimplePriceFeed — comet still uses it
        // because deployAndUpgradeTo has not been called yet.
        await priceFeeds['COMP'].connect(alice).setRoundData(0, 0, 0, 0, 0);
        await comet.accrueAccount(alice.address);
      });

      after(async () => await snapshot.restore());

      it('absorb reverts because the collateral price feed is zero', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
          .to.be.revertedWithCustomError(comet, 'BadPrice');
      });
    });

    // absorbInternal unconditionally computes uint256(-presentValue(principal)) before
    // the principal > 0 guard. When principal is positive the negation produces a negative
    // int256, and casting it to uint256 panics (Solidity 0.8+ overflow). The net effect
    // is still a revert — a net supplier cannot be absorbed.
    context('absorb reverts when user principal is positive', function () {
      before(async function() {
        await comet.connect(alice).supply(baseToken.address, exp(100, 6));
      });

      after(async () => await snapshot.restore());

      it('sanity check: principal is positive', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.be.greaterThan(0);
      });

      // Contract computes uint256(-presentValue(positive_principal)) before the principal > 0
      // guard fires, which overflows in Solidity 0.8+. Absorb still reverts — just with panic.
      it('absorb reverts because alice has a positive principal', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
          .to.be.reverted;
      });
    });

    // absorbInternal hits `debtRemainingValue <= liquidity` when the account has debt
    // but the LCF-weighted collateral still covers it. A borrow-collateralized account
    // trivially satisfies this (BCF ≤ LCF), so it reverts with NotLiquidatable.
    context('absorb reverts when user has debt but is borrow collateralized', function () {
      before(async function() {
      // 1 COMP at $100, BCF=0.8 → $80 borrow power; borrow $70 — fully collateralized.
      // LCF-weighted = $100 × 0.85 = $85 ≥ $70 debt → not liquidatable.
        await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
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

      it('absorb reverts because alice has debt but is not liquidatable', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
          .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
      });
    });

    // When COMP price sits between the BCF and LCF thresholds, the account is no longer
    // borrow-collateralized but LCF-weighted collateral still covers the debt, so
    // debtRemainingValue <= liquidity and absorb reverts with NotLiquidatable.
    context('absorb reverts when user has debt, is not borrow collateralized, but is not liquidatable', function () {
      before(async function() {
      // 1 COMP at $100, borrow $70. Drop COMP to $85:
      // BCF-weighted = $85 × 0.8 = $68 < $70 → not borrow collateralized.
      // LCF-weighted = $85 × 0.85 = $72.25 ≥ $70 → not liquidatable.
        await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
        await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

        await priceFeeds['COMP'].connect(alice).setRoundData(0, exp(85, 8), 0, 0, 0);
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

    context('absorb reverts when liquidation is on pause', function () {
      it('set liquidation to pause', async () => {
        await comet.connect(governor).pause(false, false, false, true, false);
      });

      it('absorb reverts because liquidation is on pause', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
          .to.be.revertedWithCustomError(comet, 'AbsorbPaused');
      });
    });
  });
});
