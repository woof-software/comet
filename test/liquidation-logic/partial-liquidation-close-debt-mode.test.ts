import { ethers, expect, exp, makeProtocol, presentValue, mulPrice, mulFactor, default24Assets, divPrice, CollateralState, makeCollateralStates } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, DefaultLiquidationModule, FaucetToken, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

describe('partial liquidation (close debt mode)', function() {
  // Protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: DefaultLiquidationModule;

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
  let governor: SignerWithAddress;

  // Math
  const baseScale: bigint = 10n ** 6n;
  const factorScale: bigint = 10n ** 18n;

  let snapshot: SnapshotRestorer;

  before(async function() {
    const default24AssetsData = default24Assets();
    const protocol = await makeProtocol({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        ...default24AssetsData,
        // Large cap so the 24-collateral scenario can hold enough sUSDe.
        sUSDe: { ...default24AssetsData.sUSDe, supplyCap: exp(400, 18) },
      },
      baseTrackingBorrowSpeed: 0,
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
    governor = protocol.governor;

    const allocateAmount = exp(1_000_000, 18);
    for (const token of Object.values(protocol.tokens)) {
      await (token as FaucetToken).allocateTo(alice.address, allocateAmount);
      await (token as FaucetToken).connect(alice).approve(comet.address, ethers.constants.MaxUint256);
    }

    // Make reserves on comet for borrowings
    await baseToken.allocateTo(comet.address, initialBaseFunding);

    // Enable close debt mode
    await liquidationModule.connect(governor).liquidationModeToggle(false);

    snapshot = await takeSnapshot();
  });

  context('1 collateral: full debt closure (no partial seizure branch), user has enough to cover the debt (asset index 0)', function () {
    const collateralAmount = exp(1, 18); // $100 COMP
    const borrowAmount = exp(80, 6); // $80

    const collateralKey = 'COMP';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let seizedValue: bigint;
    let seizeAmount: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop price by 7%
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const newCompPrice = compPrice * 93n / 100n;
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, newCompPrice, 0, 0, 0);
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
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: collateral can fully cover the debt', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();

      // Debt is 80 USDC, so the debt value is $80.
      // debtValue = 80e6 * 1e8 / 1e6 = 80e8
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // Alice supplied 1 COMP. After the 7% price drop it is worth $93.
      // collateralValue = 1e18 * 93e8 / 1e18 = 93e8
      const collateralValue = mulPrice(collateralAmount, compPrice, assetInfo.scale);

      // In close debt mode the seized collateral value is penalized by LF.
      // The collateral can cover the debt because collateralValue * LF > debt: $93 * 0.90 = $83.70 > $80.
      const collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);
      expect(collateralValueLeft).to.be.greaterThan(debtRemainingValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates seize amount and seized value for full debt closure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const compPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();

      // Seize only enough collateral to close the whole debt, scaling the debt value up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($80 / 0.90) / $93 ≈ 0.9558 COMP
      seizeAmount = divPrice(debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt(), compPrice, assetInfo.scale);

      // The entire debt is repaid, so the seized value equals the debt value.
      seizedValue = debtRemainingValue;

      collateralsState[collateralKey].seizeAmount = seizeAmount;
      collateralsState[collateralKey].seizedValue = seizedValue;
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);

      expect(collateralBalance).to.be.equal(collateralAmount - seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount - seizeAmount);
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

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(seizeAmount));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(seizeAmount));
    });
  });

  context('1 collateral: full debt closure (no partial seizure branch), user has enough to cover the debt (asset index 16)', function () {
    const collateralAmount = exp(100, 18); // 100 LDO, initially worth $200
    const borrowAmount = exp(80, 6); // $80

    const collateralKey = 'LDO';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let seizedValue: bigint;
    let seizeAmount: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop LDO by 45% from $2 to $1.10. 100 LDO is now worth $110.
      // collateralValue * LF = $110 * 0.85 = $93.50 > $80 debt, so the debt is fully closed.
      const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const newLdoPrice = ldoPrice * 55n / 100n;
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, newLdoPrice, 0, 0, 0);
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
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: collateral can fully cover the debt', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1];

      // Debt is $80.
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 100 LDO at $1.10 is worth $110.
      const collateralValue = mulPrice(collateralAmount, ldoPrice, assetInfo.scale);

      // In close debt mode the seized collateral value is penalized by LF.
      // The collateral can cover the debt because collateralValue * LF > debt: $110 * 0.85 = $93.50 > $80.
      const collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);
      expect(collateralValueLeft).to.be.greaterThan(debtRemainingValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates seize amount and seized value for full debt closure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const ldoPrice = (await priceFeeds[collateralKey].latestRoundData())[1];

      // Seize only enough collateral to close the whole debt, scaling the debt value up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($80 / 0.85) / $1.10 ≈ 85.56 LDO
      seizeAmount = divPrice(debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt(), ldoPrice, assetInfo.scale);

      // The entire debt is repaid, so the seized value equals the debt value.
      seizedValue = debtRemainingValue;

      collateralsState[collateralKey].seizeAmount = seizeAmount;
      collateralsState[collateralKey].seizedValue = seizedValue;
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);

      expect(collateralBalance).to.be.equal(collateralAmount - seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount - seizeAmount);
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

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(seizeAmount));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(seizeAmount));
    });
  });

  context('1 collateral: full debt closure (no partial seizure branch), user has enough to cover the debt (last asset index)', function () {
    const collateralAmount = exp(100, 18); // 100 sUSDe, initially worth $100
    const borrowAmount = exp(50, 6); // $50

    const collateralKey = 'sUSDe';
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let seizedValue: bigint;
    let seizeAmount: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralKey].address, collateralAmount);
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop sUSDe by 40% from $1 to $0.60. 100 sUSDe is now worth $60.
      // collateralValue * LF = $60 * 0.92 = $55.20 > $50 debt, so the debt is fully closed.
      const sUsdePrice = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();
      const newSUsdePrice = sUsdePrice * 60n / 100n;
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, newSUsdePrice, 0, 0, 0);
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
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: collateral can fully cover the debt', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const sUsdePrice = (await priceFeeds[collateralKey].latestRoundData())[1];

      // Debt is $50.
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 100 sUSDe at $0.60 is worth $60.
      const collateralValue = mulPrice(collateralAmount, sUsdePrice, assetInfo.scale);

      // In close debt mode the seized collateral value is penalized by LF.
      // The collateral can cover the debt because collateralValue * LF > debt: $60 * 0.92 = $55.20 > $50.
      const collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);
      expect(collateralValueLeft).to.be.greaterThan(debtRemainingValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates seize amount and seized value for full debt closure', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const sUsdePrice = (await priceFeeds[collateralKey].latestRoundData())[1];

      // Seize only enough collateral to close the whole debt, scaling the debt value up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($50 / 0.92) / $0.60 ≈ 90.58 sUSDe
      seizeAmount = divPrice(debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt(), sUsdePrice, assetInfo.scale);

      // The entire debt is repaid, so the seized value equals the debt value.
      seizedValue = debtRemainingValue;

      collateralsState[collateralKey].seizeAmount = seizeAmount;
      collateralsState[collateralKey].seizedValue = seizedValue;
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice collateral balance is reduced by the seized amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address);

      expect(collateralBalance).to.be.equal(collateralAmount - seizeAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount - seizeAmount);
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

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore.sub(seizeAmount));
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore.add(seizeAmount));
    });
  });

  context('multi-collateral: full seizure of first asset, partial of second, debt fully closed', function () {
    const borrowAmount = exp(80, 6); // $80

    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(0.6, 18), droppedPrice: exp(80, 8) }, // 0.6 COMP, worth $60 before the price drop
      { symbol: 'WETH', amount: exp(0.0225, 18), droppedPrice: exp(2000, 8) }, // 0.0225 WETH at $2,000 = $45
    ];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop COMP by 20% to $80. The supplied COMP is now worth $48.
      // WETH stays at $45; after COMP is fully seized, a partial WETH seizure closes the remaining debt.
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
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
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: collaterals can fully cover the debt', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      // Debt is $80.
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 0.6 COMP at $80 is worth $48; 0.0225 WETH at $2,000 is worth $45.
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, compInfo.scale);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, wethInfo.scale);

      // The combined LF-penalized collateral value covers the debt, so it is fully closed across both assets:
      // $48 * 0.90 + $45 * 0.90 = $43.20 + $40.50 = $83.70 > $80.
      const totalCollateralValueLeft =
        mulFactor(compCollateralValue, compInfo.liquidationFactor) +
        mulFactor(wethCollateralValue, wethInfo.liquidationFactor);
      expect(totalCollateralValueLeft).to.be.greaterThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates COMP full seizure values', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // COMP is first in asset order. After the 20% price drop, 0.6 COMP is worth $48.
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, compInfo.scale);

      // COMP cannot cover the debt on its own: collateralValue * LF < debt: $48 * 0.90 = $43.20 < $80.
      // So COMP is fully seized and the cycle moves to the next asset.
      const compCollateralValueLeft = mulFactor(compCollateralValue, compInfo.liquidationFactor);
      expect(compCollateralValueLeft).to.be.lessThan(debtRemainingValue);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = compCollateralValueLeft;
    });

    it('calculates WETH partial seizure values for full debt closure', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, wethInfo.scale);

      // After COMP full seizure, debt is $80 - $43.20 = $36.80.
      debtRemainingValue -= collateralsState[collateralConfigs[0].symbol].seizedValue;

      // WETH can cover the remaining debt: collateralValue * LF > debt: $45 * 0.90 = $40.50 > $36.80.
      const wethCollateralValueLeft = mulFactor(wethCollateralValue, wethInfo.liquidationFactor);
      expect(wethCollateralValueLeft).to.be.greaterThan(debtRemainingValue);

      // Seize only enough WETH to close the remaining debt, scaling it up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($36.80 / 0.90) / $2,000 ≈ 0.02044 WETH
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(debtRemainingValue * factorScale / wethInfo.liquidationFactor.toBigInt(), collateralConfigs[1].droppedPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValue;
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
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

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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

    it('comet total supplied COMP is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet COMP collateral reserves increase by all seized COMP', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount));
    });

    it('comet WETH collateral reserves increase by seized WETH', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount));
    });
  });

  context('multi-collateral: full seizure of asset index 15, partial of asset index 16, debt fully closed', function () {
    const borrowAmount = exp(75, 6); // $75

    const collateralConfigs = [
      { symbol: 'AAVE', amount: exp(0.6, 18), droppedPrice: exp(80, 8) }, // 0.6 AAVE, worth $60 before the price drop
      { symbol: 'LDO', amount: exp(37.5, 18), droppedPrice: exp(1.6, 8) }, // 37.5 LDO, worth $75 before the price drop
    ];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 20%. AAVE is now worth $48 and LDO is worth $60.
      // AAVE is fully seized; a partial LDO seizure then closes the remaining debt.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: collaterals can fully cover the debt', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // Debt is $75.
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 0.6 AAVE at $80 is worth $48; 37.5 LDO at $1.60 is worth $60.
      const aaveCollateralValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);
      const ldoCollateralValue = mulPrice(collateralConfigs[1].amount, ldoPrice, ldoInfo.scale);

      // The combined LF-penalized collateral value covers the debt, so it is fully closed across both assets:
      // $48 * 0.85 + $60 * 0.85 = $40.80 + $51.00 = $91.80 > $75.
      const totalCollateralValueLeft =
        mulFactor(aaveCollateralValue, aaveInfo.liquidationFactor) +
        mulFactor(ldoCollateralValue, ldoInfo.liquidationFactor);
      expect(totalCollateralValueLeft).to.be.greaterThan(debtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates AAVE full seizure values', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // AAVE is asset index 15. After the 20% price drop, 0.6 AAVE is worth $48.
      const aaveCollateralValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);

      // AAVE cannot cover the debt on its own: collateralValue * LF < debt: $48 * 0.85 = $40.80 < $75.
      // So AAVE is fully seized and the cycle moves to the next asset.
      const aaveCollateralValueLeft = mulFactor(aaveCollateralValue, aaveInfo.liquidationFactor);
      expect(aaveCollateralValueLeft).to.be.lessThan(debtRemainingValue);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = aaveCollateralValueLeft;
    });

    it('calculates LDO partial seizure values for full debt closure', async () => {
      const ldoInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const ldoPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const ldoCollateralValue = mulPrice(collateralConfigs[1].amount, ldoPrice, ldoInfo.scale);

      // After AAVE full seizure, debt is $75 - $40.80 = $34.20.
      debtRemainingValue -= collateralsState[collateralConfigs[0].symbol].seizedValue;

      // LDO can cover the remaining debt: collateralValue * LF > debt: $60 * 0.85 = $51.00 > $34.20.
      const ldoCollateralValueLeft = mulFactor(ldoCollateralValue, ldoInfo.liquidationFactor);
      expect(ldoCollateralValueLeft).to.be.greaterThan(debtRemainingValue);

      // Seize only enough LDO to close the remaining debt, scaling it up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($34.20 / 0.85) / $1.60 ≈ 25.15 LDO
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(debtRemainingValue * factorScale / ldoInfo.liquidationFactor.toBigInt(), ldoPrice, ldoInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValue;
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
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

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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

    it('comet total supplied AAVE is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied LDO is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet AAVE collateral reserves increase by all seized AAVE', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount));
    });

    it('comet LDO collateral reserves increase by seized LDO', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount));
    });
  });

  context('multi-collateral: full seizure of asset index 22, partial of asset index 23, debt fully closed', function () {
    const borrowAmount = exp(90, 6); // $90

    const collateralConfigs = [
      { symbol: 'USDe', amount: exp(60, 18), droppedPrice: exp(0.8, 8) }, // 60 USDe, worth $60 before the price drop
      { symbol: 'sUSDe', amount: exp(75, 18), droppedPrice: exp(0.8, 8) }, // 75 sUSDe, worth $75 before the price drop
    ];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 20%. USDe is now worth $48 and sUSDe is worth $60.
      // USDe is fully seized; a partial sUSDe seizure then closes the remaining debt.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: collaterals can fully cover the debt', async () => {
      const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const susdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const usdePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const susdePrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // Debt is $90.
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 60 USDe at $0.80 is worth $48; 75 sUSDe at $0.80 is worth $60.
      const usdeCollateralValue = mulPrice(collateralConfigs[0].amount, usdePrice, usdeInfo.scale);
      const susdeCollateralValue = mulPrice(collateralConfigs[1].amount, susdePrice, susdeInfo.scale);

      // The combined LF-penalized collateral value covers the debt, so it is fully closed across both assets:
      // $48 * 0.92 + $60 * 0.92 = $44.16 + $55.20 = $99.36 > $90.
      const totalCollateralValueLeft =
        mulFactor(usdeCollateralValue, usdeInfo.liquidationFactor) +
        mulFactor(susdeCollateralValue, susdeInfo.liquidationFactor);
      expect(totalCollateralValueLeft).to.be.greaterThan(debtValue);
    });

    it('alice reserved includes USDe and sUSDe', async () => {
      const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const susdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const expectedReserved = (1 << (usdeInfo.offset - 16)) | (1 << (susdeInfo.offset - 16));

      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(expectedReserved);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates USDe full seizure values', async () => {
      const usdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const usdePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // USDe is asset index 22. After the 20% price drop, 60 USDe is worth $48.
      const usdeCollateralValue = mulPrice(collateralConfigs[0].amount, usdePrice, usdeInfo.scale);

      // USDe cannot cover the debt on its own: collateralValue * LF < debt: $48 * 0.92 = $44.16 < $90.
      // So USDe is fully seized and the cycle moves to the next asset.
      const usdeCollateralValueLeft = mulFactor(usdeCollateralValue, usdeInfo.liquidationFactor);
      expect(usdeCollateralValueLeft).to.be.lessThan(debtRemainingValue);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = usdeCollateralValueLeft;
    });

    it('calculates sUSDe partial seizure values for full debt closure', async () => {
      const susdeInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const susdePrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const susdeCollateralValue = mulPrice(collateralConfigs[1].amount, susdePrice, susdeInfo.scale);

      // After USDe full seizure, debt is $90 - $44.16 = $45.84.
      debtRemainingValue -= collateralsState[collateralConfigs[0].symbol].seizedValue;

      // sUSDe can cover the remaining debt: collateralValue * LF > debt: $60 * 0.92 = $55.20 > $45.84.
      const susdeCollateralValueLeft = mulFactor(susdeCollateralValue, susdeInfo.liquidationFactor);
      expect(susdeCollateralValueLeft).to.be.greaterThan(debtRemainingValue);

      // Seize only enough sUSDe to close the remaining debt, scaling it up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($45.84 / 0.92) / $0.80 ≈ 62.28 sUSDe
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(debtRemainingValue * factorScale / susdeInfo.liquidationFactor.toBigInt(), susdePrice, susdeInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValue;
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
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

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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

    it('comet total supplied USDe is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied sUSDe is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet USDe collateral reserves increase by all seized USDe', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount));
    });

    it('comet sUSDe collateral reserves increase by seized sUSDe', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount));
    });
  });

  context('multi-collateral: full seizure of asset index 10, partial of asset index 20, debt fully closed', function () {
    const borrowAmount = exp(80, 6);   // $80

    const collateralConfigs = [
      { symbol: 'ezETH', amount: exp(0.02, 18), droppedPrice: exp(2512.5, 8) }, // 0.02 ezETH, worth $67 before the price drop
      { symbol: 'OP', amount: exp(40, 18), droppedPrice: exp(1.5, 8) }, // 40 OP, worth $80 before the price drop
    ];
    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop both assets by 25%. ezETH is now worth $50.25 and OP is worth $60.
      // ezETH is fully seized; a partial OP seizure then closes the remaining debt.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
      await comet.accrueAccount(alice.address);

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: collaterals can fully cover the debt', async () => {
      const ezETHInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const opInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const ezETHPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      const opPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // Debt is $80.
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 0.02 ezETH at $2,512.50 is worth $50.25; 40 OP at $1.50 is worth $60.
      const ezETHCollateralValue = mulPrice(collateralConfigs[0].amount, ezETHPrice, ezETHInfo.scale);
      const opCollateralValue = mulPrice(collateralConfigs[1].amount, opPrice, opInfo.scale);

      // The combined LF-penalized collateral value covers the debt, so it is fully closed across both assets:
      // $50.25 * 0.91 + $60 * 0.85 = $45.73 + $51.00 = $96.73 > $80.
      const totalCollateralValueLeft =
        mulFactor(ezETHCollateralValue, ezETHInfo.liquidationFactor) +
        mulFactor(opCollateralValue, opInfo.liquidationFactor);
      expect(totalCollateralValueLeft).to.be.greaterThan(debtValue);
    });

    it('alice assetsIn includes only ezETH', async () => {
      const ezETHInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      expect(ezETHInfo.offset).to.be.equal(10);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(1 << ezETHInfo.offset);
    });

    it('alice reserved includes only OP', async () => {
      const opInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      expect(opInfo.offset).to.be.equal(20);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(1 << (opInfo.offset - 16));
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('calculates ezETH full seizure values', async () => {
      const ezETHInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const ezETHPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // ezETH is asset index 10. After the 25% price drop, 0.02 ezETH is worth $50.25.
      const ezETHCollateralValue = mulPrice(collateralConfigs[0].amount, ezETHPrice, ezETHInfo.scale);

      // ezETH cannot cover the debt on its own: collateralValue * LF < debt: $50.25 * 0.91 = $45.73 < $80.
      // So ezETH is fully seized and the cycle moves to the next asset.
      const ezETHCollateralValueLeft = mulFactor(ezETHCollateralValue, ezETHInfo.liquidationFactor);
      expect(ezETHCollateralValueLeft).to.be.lessThan(debtRemainingValue);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = ezETHCollateralValueLeft;
    });

    it('calculates OP partial seizure values for full debt closure', async () => {
      const opInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const opPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const opCollateralValue = mulPrice(collateralConfigs[1].amount, opPrice, opInfo.scale);

      // After ezETH full seizure, debt is $80 − $45.73 = $34.27.
      debtRemainingValue -= collateralsState[collateralConfigs[0].symbol].seizedValue;

      // OP can cover the remaining debt: collateralValue * LF > debt: $60 * 0.85 = $51.00 > $34.27.
      const opCollateralValueLeft = mulFactor(opCollateralValue, opInfo.liquidationFactor);
      expect(opCollateralValueLeft).to.be.greaterThan(debtRemainingValue);

      // Seize only enough OP to close the remaining debt, scaling it up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($34.27 / 0.85) / $1.50 ≈ 26.88 OP
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(debtRemainingValue * factorScale / opInfo.liquidationFactor.toBigInt(), opPrice, opInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValue;
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
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

      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
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

    it('comet total supplied ezETH is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied OP is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount));
      expect(totalSupplyAsset).to.not.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });

    it('comet ezETH collateral reserves increase by all seized ezETH', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount));
    });

    it('comet OP collateral reserves increase by seized OP', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount));
    });
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
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let reservedBefore: number;
    let oldBalance: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;
    let innerSnapshot: SnapshotRestorer;

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

      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      reservedBefore = userBasic._reserved;
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));

      innerSnapshot = await takeSnapshot();
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: collaterals can fully cover the debt', async () => {
      // Debt is $80.
      const debtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // Sum each collateral's LF-penalized value across all five assets.
      let totalCollateralValueLeft = 0n;
      for (const config of collateralConfigs) {
        const info = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const collateralValue = mulPrice(config.amount, config.droppedPrice, info.scale);
        totalCollateralValueLeft += mulFactor(collateralValue, info.liquidationFactor);
      }

      // The combined LF-penalized value covers the debt, so it is fully closed across the assets:
      // $2.93 + $1.56 + $1.52 + $1.20 + $98.40 = $105.61 > $80.
      expect(totalCollateralValueLeft).to.be.greaterThan(debtValue);
    });

    // This context focuses on contract storage state after absorb.
    context('storage: full seizure of asset indexes 3, 6, 7, 17, partial of asset 21, debt fully closed', function () {
      let absorbTx: ContractTransaction;
      let basePaidOut: bigint;
      let debtRemainingValue: bigint;

      it('sanity check: enabled close debt mode', async () => {
        expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
      });

      it('absorb is successful', async () => {
        absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
        await expect(absorbTx).to.be.not.be.reverted;
      });

      it('calculates WBTC full seizure values', async () => {
        const wbtcInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

        debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

        // WBTC is asset index 3. After the 50% price drop, 0.0001 WBTC is worth $3.25.
        const wbtcCollateralValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, wbtcInfo.scale);

        // WBTC cannot cover the debt on its own: collateralValue * LF < debt: $3.25 * 0.90 = $2.925 < $80.
        // So WBTC is fully seized and the cycle moves to the next asset.
        const wbtcCollateralValueLeft = mulFactor(wbtcCollateralValue, wbtcInfo.liquidationFactor);
        expect(wbtcCollateralValueLeft).to.be.lessThan(debtRemainingValue);

        collateralsState[collateralConfigs[0].symbol].seizedValue = wbtcCollateralValueLeft;
      });

      it('calculates rsETH full seizure values', async () => {
        const rsETHInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

        // After WBTC full seizure, debt reduces.
        debtRemainingValue -= collateralsState[collateralConfigs[0].symbol].seizedValue;

        // rsETH is asset index 6. After the 50% price drop, 0.001 rsETH is worth $1.70.
        const rsETHCollateralValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, rsETHInfo.scale);

        // rsETH cannot cover the debt on its own: collateralValue * LF < debt: $1.70 * 0.92 = $1.564 < $77.08.
        // So rsETH is fully seized and the cycle moves to the next asset.
        const rsETHCollateralValueLeft = mulFactor(rsETHCollateralValue, rsETHInfo.liquidationFactor);
        expect(rsETHCollateralValueLeft).to.be.lessThan(debtRemainingValue);

        collateralsState[collateralConfigs[1].symbol].seizedValue = rsETHCollateralValueLeft;
      });

      it('calculates cbETH full seizure values', async () => {
        const cbETHInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[2].symbol].address);

        // After rsETH full seizure, debt reduces further.
        debtRemainingValue -= collateralsState[collateralConfigs[1].symbol].seizedValue;

        // cbETH is asset index 7. After the 50% price drop, 0.001 cbETH is worth $1.65.
        const cbETHCollateralValue = mulPrice(collateralConfigs[2].amount, collateralConfigs[2].droppedPrice, cbETHInfo.scale);

        // cbETH cannot cover the debt on its own: collateralValue * LF < debt: $1.65 * 0.92 = $1.518 < $75.51.
        // So cbETH is fully seized and the cycle moves to the next asset.
        const cbETHCollateralValueLeft = mulFactor(cbETHCollateralValue, cbETHInfo.liquidationFactor);
        expect(cbETHCollateralValueLeft).to.be.lessThan(debtRemainingValue);

        collateralsState[collateralConfigs[2].symbol].seizedValue = cbETHCollateralValueLeft;
      });

      it('calculates CRV full seizure values', async () => {
        const crvInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[3].symbol].address);

        // After cbETH full seizure, debt reduces further.
        debtRemainingValue -= collateralsState[collateralConfigs[2].symbol].seizedValue;

        // CRV is asset index 17. After the 50% price drop, 3 CRV is worth $1.50.
        const crvCollateralValue = mulPrice(collateralConfigs[3].amount, collateralConfigs[3].droppedPrice, crvInfo.scale);

        // CRV cannot cover the debt on its own: collateralValue * LF < debt: $1.50 * 0.80 = $1.20 < $73.99.
        // So CRV is fully seized and the cycle moves to the next asset.
        const crvCollateralValueLeft = mulFactor(crvCollateralValue, crvInfo.liquidationFactor);
        expect(crvCollateralValueLeft).to.be.lessThan(debtRemainingValue);

        collateralsState[collateralConfigs[3].symbol].seizedValue = crvCollateralValueLeft;
      });

      it('calculates GMX partial seizure values for full debt closure', async () => {
        const gmxInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[4].symbol].address);
        const gmxCollateralValue = mulPrice(collateralConfigs[4].amount, collateralConfigs[4].droppedPrice, gmxInfo.scale);

        // After CRV full seizure, debt reduces to about $72.79.
        debtRemainingValue -= collateralsState[collateralConfigs[3].symbol].seizedValue;

        // GMX can cover the remaining debt: collateralValue * LF > debt: $120 * 0.82 = $98.40 > $72.79.
        const gmxCollateralValueLeft = mulFactor(gmxCollateralValue, gmxInfo.liquidationFactor);
        expect(gmxCollateralValueLeft).to.be.greaterThan(debtRemainingValue);

        // Seize only enough GMX to close the remaining debt, scaling it up by the penalty (LF).
        // seizeAmount = (debt / LF) / price ≈ ($72.79 / 0.82) / $20 ≈ 4.44 GMX
        collateralsState[collateralConfigs[4].symbol].seizeAmount = divPrice(debtRemainingValue * factorScale / gmxInfo.liquidationFactor.toBigInt(), collateralConfigs[4].droppedPrice, gmxInfo.scale);
        collateralsState[collateralConfigs[4].symbol].seizedValue = debtRemainingValue;
      });

      // Events
      it('AbsorbDebt event is emitted', async () => {
        // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
        basePaidOut = -oldBalance;
        const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

        await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
      });

      // User base balances
      it('alice borrow balance is fully closed after absorb', async () => {
        expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
      });

      it('alice principal is zero after absorb', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
      });

      it('alice simple base balance is zero after absorb', async () => {
        expect(await comet.balanceOf(alice.address)).to.be.equal(0);
      });

      // User collateral state
      it('alice WBTC collateral balance is zero', async () => {
        expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
        expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
      });

      it('alice rsETH collateral balance is zero', async () => {
        expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
        expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(0);
      });

      it('alice cbETH collateral balance is zero', async () => {
        expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[2].symbol].address)).to.be.equal(0);
        expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[2].symbol].address)).balance).to.be.equal(0);
      });

      it('alice CRV collateral balance is zero', async () => {
        expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[3].symbol].address)).to.be.equal(0);
        expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[3].symbol].address)).balance).to.be.equal(0);
      });

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

        expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
      });

      it('comet total supply base is unchanged', async () => {
        expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
      });

      // Comet collateral balances
      it('comet total supplied WBTC is zero', async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralConfigs[0].amount));
        expect(totalSupplyAsset).to.be.equal(0);
      });

      it('comet total supplied rsETH is zero', async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralConfigs[1].amount));
        expect(totalSupplyAsset).to.be.equal(0);
      });

      it('comet total supplied cbETH is zero', async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[2].symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[2].symbol].totalsCollateralBefore.sub(collateralConfigs[2].amount));
        expect(totalSupplyAsset).to.be.equal(0);
      });

      it('comet total supplied CRV is zero', async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[3].symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[3].symbol].totalsCollateralBefore.sub(collateralConfigs[3].amount));
        expect(totalSupplyAsset).to.be.equal(0);
      });

      it('comet total supplied GMX is reduced by the seized amount', async () => {
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[4].symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[4].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[4].symbol].seizeAmount));
        expect(totalSupplyAsset).to.not.be.equal(0);
      });

      for (const config of collateralConfigs) {
        it(`comet ERC20 ${config.symbol} token balance does not change during absorb`, async () => {
          expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
        });
      }

      it('comet ERC20 base token balance does not change during absorb', async () => {
        expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
      });

      it('comet base reserves are reduced by the base paid out', async () => {
        expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
      });

      it('comet WBTC collateral reserves increase by all seized WBTC', async () => {
        expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralConfigs[0].amount));
      });

      it('comet rsETH collateral reserves increase by all seized rsETH', async () => {
        expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralConfigs[1].amount));
      });

      it('comet cbETH collateral reserves increase by all seized cbETH', async () => {
        expect(await comet.getCollateralReserves(tokens[collateralConfigs[2].symbol].address)).to.be.equal(collateralsState[collateralConfigs[2].symbol].collateralReservesBefore.add(collateralConfigs[2].amount));
      });

      it('comet CRV collateral reserves increase by all seized CRV', async () => {
        expect(await comet.getCollateralReserves(tokens[collateralConfigs[3].symbol].address)).to.be.equal(collateralsState[collateralConfigs[3].symbol].collateralReservesBefore.add(collateralConfigs[3].amount));
      });

      it('comet GMX collateral reserves increase by seized GMX', async () => {
        expect(await comet.getCollateralReserves(tokens[collateralConfigs[4].symbol].address)).to.be.equal(collateralsState[collateralConfigs[4].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[4].symbol].seizeAmount));
      });
    });

    // This context focuses only on AbsorbCollateral event validation.
    context('emit AbsorbCollateral events for each collateral', function () {
      let absorbTx: ContractTransaction;
      let debtRemainingValue: bigint;

      before(async () => {
        await innerSnapshot.restore();
        debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      });
      after(async () => await innerSnapshot.restore());

      it('sanity check: enabled close debt mode', async () => {
        expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
      });

      it('absorb is successful', async () => {
        absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
        await expect(absorbTx).to.not.be.reverted;
      });

      it('emits AbsorbCollateral for WBTC full seizure', async () => {
        const wbtcInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
        const wbtcPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
        const wbtcCollateralValue = mulPrice(collateralConfigs[0].amount, wbtcPrice, wbtcInfo.scale);

        await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
          absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralConfigs[0].amount, wbtcCollateralValue
        );
        debtRemainingValue -= mulFactor(wbtcCollateralValue, wbtcInfo.liquidationFactor);
      });

      it('emits AbsorbCollateral for rsETH full seizure', async () => {
        const rsETHInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
        const rsETHPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
        const rsETHCollateralValue = mulPrice(collateralConfigs[1].amount, rsETHPrice, rsETHInfo.scale);

        await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
          absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount, rsETHCollateralValue
        );
        debtRemainingValue -= mulFactor(rsETHCollateralValue, rsETHInfo.liquidationFactor);
      });

      it('emits AbsorbCollateral for cbETH full seizure', async () => {
        const cbETHInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[2].symbol].address);
        const cbETHPrice = (await priceFeeds[collateralConfigs[2].symbol].latestRoundData())[1].toBigInt();
        const cbETHCollateralValue = mulPrice(collateralConfigs[2].amount, cbETHPrice, cbETHInfo.scale);

        await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
          absorber.address, alice.address, tokens[collateralConfigs[2].symbol].address, collateralConfigs[2].amount, cbETHCollateralValue
        );
        debtRemainingValue -= mulFactor(cbETHCollateralValue, cbETHInfo.liquidationFactor);
      });

      it('emits AbsorbCollateral for CRV full seizure', async () => {
        const crvInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[3].symbol].address);
        const crvPrice = (await priceFeeds[collateralConfigs[3].symbol].latestRoundData())[1].toBigInt();
        const crvCollateralValue = mulPrice(collateralConfigs[3].amount, crvPrice, crvInfo.scale);

        await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
          absorber.address, alice.address, tokens[collateralConfigs[3].symbol].address, collateralConfigs[3].amount, crvCollateralValue
        );
        debtRemainingValue -= mulFactor(crvCollateralValue, crvInfo.liquidationFactor);
      });

      it('emits AbsorbCollateral for GMX partial seizure', async () => {
        const gmxInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[4].symbol].address);
        const gmxPrice = (await priceFeeds[collateralConfigs[4].symbol].latestRoundData())[1].toBigInt();

        // GMX closes the remaining debt: seizeAmount = (debt / LF) / price, scaling the debt up by the penalty.
        const gmxSeizeAmount = divPrice(debtRemainingValue * factorScale / gmxInfo.liquidationFactor.toBigInt(), gmxPrice, gmxInfo.scale);
        // The event reports wantedCollateralValue recomputed from the seized amount.
        const wantedGmxCollateralValue = mulPrice(gmxSeizeAmount, gmxPrice, gmxInfo.scale);

        await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
          absorber.address, alice.address, tokens[collateralConfigs[4].symbol].address, gmxSeizeAmount, wantedGmxCollateralValue
        );
      });
    });
  });

  /*//////////////////////////////////////////////////////////////
                  DEBT FULLY CLOSED, TRAILING COLLATERAL UNTOUCHED
  //////////////////////////////////////////////////////////////*/

  context('2 collaterals: COMP partial seizure closes the debt, WETH untouched (assets index 0 and 1)', function () {
    const borrowAmount = exp(80, 6);
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18), droppedPrice: exp(90, 8) }, // $100 before -> $90 after price drop
      { symbol: 'WETH', amount: exp(0.001, 18), droppedPrice: exp(2000, 8) }, // $2
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;

    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let totalSupplyBaseBefore: BigNumber;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    let debtRemainingValue: bigint;
    let compSeizeAmount: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop COMP 10%: $100 → $90. Position becomes liquidatable:
      // LCF_weighted = 0.85×$90 + 0.80×$2 = $78.1 < debt $80
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
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
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: COMP alone can fully cover the debt', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      // debtRemainingValue = $80 in Chainlink 8-decimal price units = 8000000000
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 1 COMP × $90 / 1e18 = 9000000000
      const compValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, compInfo.scale);

      // COMP can cover the debt because collateralValue * LF > debt: $90 * 0.90 = $81.00 > $80.
      // So COMP is partially seized to close the whole debt and the loop never touches WETH.
      const compCollateralValueLeft = mulFactor(compValue, compInfo.liquidationFactor);
      expect(compCollateralValueLeft).to.be.greaterThan(debtRemainingValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates COMP seize amount for full debt closure', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      // Seize only enough COMP to close the whole debt, scaling the debt value up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($80 / 0.90) / $90 ≈ 0.9877 COMP
      compSeizeAmount = divPrice(debtRemainingValue * factorScale / compInfo.liquidationFactor.toBigInt(), collateralConfigs[0].droppedPrice, compInfo.scale);
    });

    it('seize amount is less than COMP balance: partial seizure confirmed', () => {
      expect(compSeizeAmount).to.be.lessThan(collateralConfigs[0].amount);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice is no longer liquidatable after the debt is closed', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    // User collateral state
    it('alice COMP balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralConfigs[0].amount - compSeizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(
        collateralConfigs[0].amount - compSeizeAmount
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
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(compSeizeAmount));
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
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(compSeizeAmount)
      );
    });

    it('comet WETH collateral reserves remain zero', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });
  });

  context('2 collaterals: AAVE partial seizure closes the debt, LDO untouched (assets index 15 and 16)', function () {
    const borrowAmount = exp(66, 6);
    const collateralConfigs = [
      { symbol: 'AAVE', amount: exp(1, 18), droppedPrice: exp(80, 8) }, // $100 before the price drop
      { symbol: 'LDO', amount: exp(10, 18), droppedPrice: exp(2, 8) }, // $20
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;

    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let totalSupplyBaseBefore: BigNumber;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    let debtRemainingValue: bigint;
    let aaveSeizeAmount: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop AAVE 20%: $100 -> $80. Position becomes liquidatable:
      // LCF_weighted = 0.65*$80 + 0.62*$20 = $64.40 < debt $66.
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
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
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: AAVE alone can fully cover the debt', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      // Debt is $66.
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 1 AAVE at $80 is worth $80.
      const aaveValue = mulPrice(collateralConfigs[0].amount, aavePrice, aaveInfo.scale);

      // AAVE can cover the debt because collateralValue * LF > debt: $80 * 0.85 = $68.00 > $66.
      // So AAVE is partially seized to close the whole debt and the loop never touches LDO.
      const aaveCollateralValueLeft = mulFactor(aaveValue, aaveInfo.liquidationFactor);
      expect(aaveCollateralValueLeft).to.be.greaterThan(debtRemainingValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates AAVE seize amount for full debt closure', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const aavePrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      // Seize only enough AAVE to close the whole debt, scaling the debt value up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($66 / 0.85) / $80 ≈ 0.9706 AAVE
      aaveSeizeAmount = divPrice(debtRemainingValue * factorScale / aaveInfo.liquidationFactor.toBigInt(), aavePrice, aaveInfo.scale);
    });

    it('seize amount is less than AAVE balance: partial seizure confirmed', () => {
      expect(aaveSeizeAmount).to.be.lessThan(collateralConfigs[0].amount);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice is no longer liquidatable after the debt is closed', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice AAVE balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralConfigs[0].amount - aaveSeizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(
        collateralConfigs[0].amount - aaveSeizeAmount
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
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied AAVE is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(aaveSeizeAmount));
    });

    it('comet total supplied LDO is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore
      );
    });

    it('comet AAVE collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(aaveSeizeAmount)
      );
    });

    it('comet LDO collateral reserves remain zero', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
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

  context('2 non-adjacent collaterals: rETH partial seizure closes the debt, LDO untouched (assets index 8 and 16)', function () {
    const borrowAmount = exp(60, 6);
    const collateralConfigs = [
      { symbol: 'rETH', amount: exp(0.025, 18), droppedPrice: exp(2800, 8) }, // $87.50 before the price drop
      { symbol: 'LDO', amount: exp(1, 18), droppedPrice: exp(2, 8) }, // $2
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;

    let totalBorrowBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let totalSupplyBaseBefore: BigNumber;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    let debtRemainingValue: bigint;
    let rEthSeizeAmount: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // Drop rETH 20%: $87.50 -> $70. Position becomes liquidatable:
      // LCF_weighted = 0.78*$70 + 0.62*$2 = $55.84 < debt $60.
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
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
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: rETH alone can fully cover the debt', async () => {
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const rEthPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      // Debt is $60.
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // 0.025 rETH at $2,800 is worth $70.
      const rEthValue = mulPrice(collateralConfigs[0].amount, rEthPrice, rEthInfo.scale);

      // rETH can cover the debt because collateralValue * LF > debt: $70 * 0.92 = $64.40 > $60.
      // So rETH is partially seized to close the whole debt and the loop never touches LDO.
      const rEthCollateralValueLeft = mulFactor(rEthValue, rEthInfo.liquidationFactor);
      expect(rEthCollateralValueLeft).to.be.greaterThan(debtRemainingValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates rETH seize amount for full debt closure', async () => {
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const rEthPrice = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();

      // Seize only enough rETH to close the whole debt, scaling the debt value up by the penalty (LF).
      // seizeAmount = (debt / LF) / price = ($60 / 0.92) / $2,800 ≈ 0.0233 rETH
      rEthSeizeAmount = divPrice(debtRemainingValue * factorScale / rEthInfo.liquidationFactor.toBigInt(), rEthPrice, rEthInfo.scale);
    });

    it('seize amount is less than rETH balance: partial seizure confirmed', () => {
      expect(rEthSeizeAmount).to.be.lessThan(collateralConfigs[0].amount);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice is no longer liquidatable after the debt is closed', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice rETH balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralConfigs[0].amount - rEthSeizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(
        collateralConfigs[0].amount - rEthSeizeAmount
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
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied rETH is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(rEthSeizeAmount));
    });

    it('comet total supplied LDO is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore
      );
    });

    it('comet rETH collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(rEthSeizeAmount)
      );
    });

    it('comet LDO collateral reserves remain zero', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
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

  context('3 collaterals: rETH fully seized, AAVE partial seizure closes the debt, LDO untouched (assets index 8, 15 and 16)', function () {
    const borrowAmount = exp(90, 6);
    const collateralConfigs = [
      { symbol: 'rETH', amount: exp(0.01, 18), droppedPrice: exp(3000, 8) }, // $30 after the price change
      { symbol: 'AAVE', amount: exp(1, 18), droppedPrice: exp(80, 8) }, // $80 after the price change
      { symbol: 'LDO', amount: exp(10, 18), droppedPrice: exp(2, 8) }, // $20
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;

    let totalBorrowBaseBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let cometBaseTokenBalanceBefore: BigNumber;

    let debtRemainingValue: bigint;
    let rEthSeizeAmount: bigint;
    let rEthSeizedValue: bigint;
    let aaveSeizeAmount: bigint;
    let aaveSeizedValue: bigint;

    before(async function() {
      for (const config of collateralConfigs) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // rETH becomes worth $30 and AAVE becomes worth $80.
      // LCF_weighted = 0.78*$30 + 0.65*$80 + 0.62*$20 = $87.80 < debt $90.
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, collateralConfigs[0].droppedPrice, 0, 0, 0);
      await priceFeeds[collateralConfigs[1].symbol].connect(alice).setRoundData(0, collateralConfigs[1].droppedPrice, 0, 0, 0);
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
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: rETH cannot fully cover the debt but AAVE can close the rest', async () => {
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      // Debt is $90.
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      // rETH collateralValueLeft = $30 * 0.92 = $27.60, so rETH is fully seized.
      const rEthValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, rEthInfo.scale);
      const rEthCollateralValueLeft = mulFactor(rEthValue, rEthInfo.liquidationFactor);
      expect(rEthCollateralValueLeft).to.be.lessThan(debtRemainingValue);

      // AAVE collateralValueLeft = $80 * 0.85 = $68, enough to close the remaining $62.40 debt.
      const debtAfterREth = debtRemainingValue - rEthCollateralValueLeft;
      const aaveValue = mulPrice(collateralConfigs[1].amount, collateralConfigs[1].droppedPrice, aaveInfo.scale);
      const aaveCollateralValueLeft = mulFactor(aaveValue, aaveInfo.liquidationFactor);
      expect(aaveCollateralValueLeft).to.be.greaterThan(debtAfterREth);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates rETH full seizure values', async () => {
      const rEthInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const rEthValue = mulPrice(collateralConfigs[0].amount, collateralConfigs[0].droppedPrice, rEthInfo.scale);

      rEthSeizeAmount = collateralConfigs[0].amount;
      rEthSeizedValue = mulFactor(rEthValue, rEthInfo.liquidationFactor);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = rEthSeizeAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = rEthSeizedValue;
    });

    it('calculates AAVE partial seizure values that close the remaining debt', async () => {
      const aaveInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const debtAfterREth = debtRemainingValue - rEthSeizedValue;

      // Seize only enough AAVE to close the remaining debt, scaling by LF.
      // seizeAmount = (debtAfterREth / LF) / price = ($62.40 / 0.85) / $80 ≈ 0.9176 AAVE
      aaveSeizeAmount = divPrice(debtAfterREth * factorScale / aaveInfo.liquidationFactor.toBigInt(), collateralConfigs[1].droppedPrice, aaveInfo.scale);
      aaveSeizedValue = debtAfterREth;

      collateralsState[collateralConfigs[1].symbol].seizeAmount = aaveSeizeAmount;
      collateralsState[collateralConfigs[1].symbol].seizedValue = aaveSeizedValue;
    });

    it('AAVE seize amount is less than AAVE balance: partial seizure confirmed', () => {
      expect(aaveSeizeAmount).to.be.lessThan(collateralConfigs[1].amount);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      // The whole debt is closed, so the new balance is 0 and the base paid out equals the old debt.
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice is no longer liquidatable after the debt is closed', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice rETH balance is zero after full seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0);
    });

    it('alice AAVE balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralConfigs[1].amount - aaveSeizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(
        collateralConfigs[1].amount - aaveSeizeAmount
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

    it('alice reserved still includes LDO after absorb', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied rETH is zero', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;

      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(rEthSeizeAmount));
      expect(totalSupplyAsset).to.be.equal(0);
    });

    it('comet total supplied AAVE is reduced by the seized amount', async () => {
      const totalSupplyAsset = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAsset).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(aaveSeizeAmount));
    });

    it('comet total supplied LDO is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[2].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[2].symbol].totalsCollateralBefore
      );
    });

    it('comet rETH collateral reserves increase by all seized rETH', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(rEthSeizeAmount)
      );
    });

    it('comet AAVE collateral reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(aaveSeizeAmount)
      );
    });

    it('comet LDO collateral reserves remain zero', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[2].symbol].address)).to.be.equal(0);
    });

    it('comet base reserves are reduced by the base paid out', async () => {
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
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
    let collateralValues: bigint[] = [];
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let assetsInBefore: number;
    let reservedBefore: number;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;

    before(async function() {
      collateralValues = [];

      for (const config of collateralConfigs) {
        const asset = tokens[config.symbol];
        const assetInfo = await comet.getAssetInfoByAddress(asset.address);

        collateralValues.push(mulPrice(config.amount, config.droppedPrice, assetInfo.scale));
        await comet.connect(alice).supply(asset.address, config.amount);
      }
      await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

      // The borrow is opened while prices are healthy, then every collateral is repriced
      // to the target liquidation value used by the seizure math below.
      for (const config of collateralConfigs) {
        await priceFeeds[config.symbol].connect(alice).setRoundData(0, config.droppedPrice, 0, 0, 0);
      }
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
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: assets 0 through 4 cannot close the debt, but asset 5 can close the rest', async () => {
      let remainingDebtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      for (let i = 0; i < firstFullSeizureCount; i++) {
        const config = collateralConfigs[i];
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
        const collateralValue = mulPrice(config.amount, config.droppedPrice, assetInfo.scale);
        const collateralValueLeft = mulFactor(collateralValue, assetInfo.liquidationFactor);

        expect(collateralValueLeft).to.be.lessThan(remainingDebtValue);
        remainingDebtValue -= collateralValueLeft;
      }

      const partialConfig = collateralConfigs[partialSeizureIndex];
      const partialAssetInfo = await comet.getAssetInfoByAddress(tokens[partialConfig.symbol].address);
      const partialCollateralValue = mulPrice(partialConfig.amount, partialConfig.droppedPrice, partialAssetInfo.scale);
      const partialCollateralValueLeft = mulFactor(partialCollateralValue, partialAssetInfo.liquidationFactor);

      expect(partialCollateralValueLeft).to.be.greaterThan(remainingDebtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates full seizure values for asset indexes 0 through 4', async () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      for (let i = 0; i < firstFullSeizureCount; i++) {
        const config = collateralConfigs[i];
        const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);

        // The first five collateral values are small, so each asset is fully seized
        // and the remaining debt moves to the next asset.
        collateralsState[config.symbol].seizeAmount = config.amount;
        collateralsState[config.symbol].seizedValue = mulFactor(collateralValues[i], assetInfo.liquidationFactor);
        debtRemainingValue -= collateralsState[config.symbol].seizedValue;
      }
    });

    it('calculates partial seizure values for asset index 5 that close the remaining debt', async () => {
      const config = collateralConfigs[partialSeizureIndex];
      const assetInfo = await comet.getAssetInfoByAddress(tokens[config.symbol].address);
      const collateralValueLeft = mulFactor(collateralValues[partialSeizureIndex], assetInfo.liquidationFactor);

      // Close debt mode seizes only enough wstETH to pay the remaining debt.
      expect(collateralValueLeft).to.be.greaterThan(debtRemainingValue);

      collateralsState[config.symbol].seizeAmount = divPrice(
        debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt(),
        config.droppedPrice,
        assetInfo.scale
      );
      collateralsState[config.symbol].seizedValue = debtRemainingValue;
    });

    it('asset index 5 seize amount is less than its collateral balance: partial seizure confirmed', () => {
      const config = collateralConfigs[partialSeizureIndex];
      expect(collateralsState[config.symbol].seizeAmount).to.be.lessThan(config.amount);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    it('alice is no longer liquidatable after the debt is closed', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice assetsIn removes fully seized indexes and keeps remaining indexes 5 through 15', async () => {
      const expectedAssetsIn = ((1 << 16) - 1) - ((1 << firstFullSeizureCount) - 1);

      expect(assetsInBefore).to.be.equal((1 << 16) - 1);
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(expectedAssetsIn);
    });

    it('alice reserved still includes asset indexes 16 through 23 after absorb', async () => {
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
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied collateral for asset indexes 0 through 4 is zero', async () => {
      for (let i = 0; i < firstFullSeizureCount; i++) {
        const config = collateralConfigs[i];
        const totalSupplyAsset = (await comet.totalsCollateral(tokens[config.symbol].address)).totalSupplyAsset;

        expect(totalSupplyAsset).to.be.equal(collateralsState[config.symbol].totalsCollateralBefore.sub(collateralsState[config.symbol].seizeAmount));
        expect(totalSupplyAsset).to.be.equal(0);
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
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });
  });

  context('24 collaterals: assets 0-22 fully seized, sUSDe (asset 23) partially seized to close the debt', function () {
    const targetCollateralUsdPerAsset = exp(12, 8); // ~$12 per asset - keeps absorb from hitting target HF early
    const assetSymbols23 = Object.keys(default24Assets()).filter((s) => s !== 'USDC' && s !== 'sUSDe');
    const sUsDeAmount = exp(380, 18);
    const borrowAmount = exp(457.5, 6);
    const droppedSUsDePrice = exp(0.8, 8);

    let collateralsState: Record<string, CollateralState>;
    let collateralConfigs: { symbol: string, amount: bigint }[] = [];
    let assetSupplyAmounts: { [symbol: string]: bigint } = {};
    let absorbTx: ContractTransaction;
    let cometBaseTokenBalanceBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let oldBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;

    before(async function () {
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

      const borrowPrincipalBefore = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      oldBalance = presentValue(borrowPrincipalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(({ symbol }) => symbol));
    });

    after(async () => await snapshot.restore());

    it('sanity check: enabled close debt mode', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.false;
    });

    it('sanity check: user is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('sanity check: assets 0 through 22 cannot close the debt, but sUSDe can close the rest', async () => {
      let remainingDebtValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      for (const sym of assetSymbols23) {
        const info = await comet.getAssetInfoByAddress(tokens[sym].address);
        const price = (await priceFeeds[sym].latestRoundData())[1];
        const value = mulPrice(assetSupplyAmounts[sym], price, info.scale);
        const collateralValueLeft = mulFactor(value, info.liquidationFactor);

        expect(collateralValueLeft).to.be.lessThan(remainingDebtValue);
        remainingDebtValue -= collateralValueLeft;
      }

      const sUsDeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const sUsDeValue = mulPrice(sUsDeAmount, droppedSUsDePrice, sUsDeInfo.scale);
      const sUsDeCollateralValueLeft = mulFactor(sUsDeValue, sUsDeInfo.liquidationFactor);

      expect(sUsDeCollateralValueLeft).to.be.greaterThan(remainingDebtValue);
    });

    it('absorb is successful', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates full seizure values for asset indexes 0 through 22', async () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);

      for (const sym of assetSymbols23) {
        const info = await comet.getAssetInfoByAddress(tokens[sym].address);
        const price = (await priceFeeds[sym].latestRoundData())[1];
        const value = mulPrice(assetSupplyAmounts[sym], price, info.scale);
        const seizedValue = mulFactor(value, info.liquidationFactor);

        collateralsState[sym].seizeAmount = assetSupplyAmounts[sym];
        collateralsState[sym].seizedValue = seizedValue;
        debtRemainingValue -= seizedValue;
      }
    });

    it('calculates sUSDe partial seizure values that close the remaining debt', async () => {
      const sUsDeInfo = await comet.getAssetInfoByAddress(tokens['sUSDe'].address);
      const sUsDeValue = mulPrice(sUsDeAmount, droppedSUsDePrice, sUsDeInfo.scale);
      const sUsDeCollateralValueLeft = mulFactor(sUsDeValue, sUsDeInfo.liquidationFactor);

      expect(sUsDeCollateralValueLeft).to.be.greaterThan(debtRemainingValue);

      collateralsState['sUSDe'].seizeAmount = divPrice(
        debtRemainingValue * factorScale / sUsDeInfo.liquidationFactor.toBigInt(),
        droppedSUsDePrice,
        sUsDeInfo.scale
      );
      collateralsState['sUSDe'].seizedValue = debtRemainingValue;
    });

    it('sUSDe seize amount is less than sUSDe balance: partial seizure confirmed', () => {
      expect(collateralsState['sUSDe'].seizeAmount).to.be.lessThan(sUsDeAmount);
    });

    // Events
    it('AbsorbDebt event is emitted', async () => {
      basePaidOut = -oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice borrow balance is fully closed after absorb', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero after absorb', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice is no longer liquidatable after the debt is closed', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
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
    it('comet total borrow base is reduced by the base paid out', async () => {
      const totalBorrowBase = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(basePaidOut));
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet totalsCollateral are zero for all fully seized assets 0-22', async () => {
      for (const sym of assetSymbols23) {
        expect((await comet.totalsCollateral(tokens[sym].address)).totalSupplyAsset).to.be.equal(0);
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
      expect(await comet.getReserves()).to.be.equal(initialBaseFunding - basePaidOut);
    });
  });
});
