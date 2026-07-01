import { ethers, expect, exp, presentValue, mulPrice, mulFactor, divPrice, default24Assets, CollateralState, makeCollateralStates, makeConfigurator, principalValue, deployDefaultLiquidationModuleWithComet, seedMarketActivity, DeployLiquidationModuleOpts, deployEmptyDexAdapter} from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, LiquidationModule, FaucetToken, SimplePriceFeed, AssetListFactory, CometExtAssetList } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';
import { AssetInfoStructOutput } from 'build/types/CometWithExtendedAssetList';

// These flows cover absorption after a collateral is soft-delisted by setting BCF to 0.
// The collateral no longer contributes to the borrow-side health value, but if LCF and LF
// remain positive it is still liquidatable and must reduce the account's debt when seized.
describe('absorb logic with delisted collaterals', function() {
  // Protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  let cometExt: CometExtAssetList;
  let configurator: Configurator;
  let cometProxyAdmin: CometProxyAdmin;
  let configuratorProxyAddress: string;
  let cometProxyAddress: string;
  let liquidationModule: LiquidationModule;
  let assetListFactory: AssetListFactory;
  let liquidationModuleOpts: DeployLiquidationModuleOpts;
  let emptyDexAdapterAddress: string;

  const baseTokenPrice = exp(1, 8);
  const initialBaseFunding = baseTokenPrice * 10_000n;
  const collateralAmount = exp(1, 18); // 1 COMP, $100 at initial price (BCF=0.8 → $80 borrow power)
  const borrowAmount = exp(70, 6); // $70 USDC, within the $80 borrow limit

  // Assets
  let tokens: { [symbol: string]: FaucetToken } = {};
  let baseToken: FaucetToken;
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  let alice: SignerWithAddress;
  let absorber: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let governor: SignerWithAddress;

  // Math
  const baseScale: bigint = 10n ** 6n;
  const factorScale: bigint = 10n ** 18n;
  let targetHealthFactor: bigint;

  let snapshot: SnapshotRestorer;

  before(async function() {    
    const protocol = await makeConfigurator({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        ...default24Assets(),
      },
      baseTrackingBorrowSpeed: 0,
      skipInitStorage: true
    });

    configuratorProxyAddress = protocol.configuratorProxy.address;
    cometProxyAddress = protocol.cometProxy.address;
    configurator = protocol.configurator.attach(configuratorProxyAddress);
    comet = protocol.comet.attach(cometProxyAddress);
    cometProxyAdmin = protocol.proxyAdmin;
    cometExt = protocol.extensionDelegate;
    assetListFactory = await ethers.getContractAt("AssetListFactory", (await cometExt.assetListFactory())) as AssetListFactory;

    pauseGuardian = protocol.pauseGuardian;
    governor = protocol.governor;

    liquidationModule = protocol.defaultLiquidationModule;
    targetHealthFactor = (await liquidationModule.TARGET_HEALTH_FACTOR()).toBigInt();
    ///turn off DEX liquidation to test pure absorbtion mechanics
    await liquidationModule.connect(protocol.pausers[0]).setDexRoutePaused(true);

    emptyDexAdapterAddress = (await deployEmptyDexAdapter(Object.entries(protocol.tokens).filter(([symbol]) => symbol !== protocol.base).map(([, token]) => {return token.address}))).address;
    liquidationModuleOpts = {
      multisig: protocol.multisig.address,
      executors: [protocol.executors[0].address],
      pausers: [pauseGuardian.address],
      dexAdapter: emptyDexAdapterAddress
    } as DeployLiquidationModuleOpts;

    for (let asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      tokens[asset] = protocol.tokens[asset] as FaucetToken;
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    baseToken = protocol.tokens['USDC'] as FaucetToken;
    priceFeeds['USDC'] = protocol.priceFeeds['USDC'];

    [alice, absorber] = protocol.users;
    const [bob, dave] = protocol.users.slice(2);
    
    const allocateAmount = exp(1_000_000, 18);
    for (const token of Object.values(protocol.tokens)) {
      await (token as FaucetToken).allocateTo(alice.address, allocateAmount);
      await (token as FaucetToken).connect(alice).approve(comet.address, ethers.constants.MaxUint256);
    }

    await seedMarketActivity(comet, tokens, priceFeeds, bob, dave, baseToken,  initialBaseFunding );

    await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
    await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

    snapshot = await takeSnapshot();
  });

  context.only('1 soft delisted collateral: BCF = 0 (partial seizure with falling into minDebt case)', function () {
    const droppedCompPrice = exp(80, 8); // 1 COMP is worth $80 after the price drop
    const collateralKey = 'COMP';

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let collateralValue: bigint;
    let totalCollateralizedValue: bigint;
    let wantedCollateralValue: bigint;
    let minDebtValue: bigint;
    let closeoutCollateralValueLeft: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let assetInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;

    before(async function() {
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
        
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);

      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).setDexRoutePaused(true);

      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
      minDebtValue = mulPrice((await comet.baseBorrowMin()).toBigInt(), baseTokenPrice, baseScale);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: alice is not borrow-collateralized after COMP BCF is zeroed', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('sanity check: alice is liquidatable because COMP LCF still counts for liquidation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      // debtRemainingValue = 70e6 * 1e8 / 1e6 = 70e8
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('calculates COMP collateral value at the dropped price', async () => {
      // collateralValue = 1e18 * 80e8 / 1e18 = 80e8
      collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      expect(collateralValue).to.be.equal(exp(80, 8));
    });

    it('excludes the BCF-zero COMP from total collateralized value', async () => {
      // totalCollateralizedValue = collateralValue * BCF = 80e8 * 0 = 0
      totalCollateralizedValue = mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
      expect(totalCollateralizedValue).to.be.equal(0n);
    });

    it('calculates the COMP amount needed to close the debt', async () => {
      // With totalCollateralizedValue = 0 and BCF = 0, the target-HF formula reduces to:
      // wantedCollateralValue = debtRemainingValue / LF = 70e8 / 0.90 = 77.777...e8
      wantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(assetInfo.liquidationFactor, targetHealthFactor) - assetInfo.borrowCollateralFactor.toBigInt());

      expect(wantedCollateralValue).to.be.lessThan(collateralValue);
    });

    it('calculates the rounded COMP seize amount', () => {
      // seizeAmount = wantedCollateralValue * COMP scale / COMP price
      // = 77.777...e8 * 1e18 / 80e8 = 0.972222222125 COMP
      collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, assetInfo.scale);
    });

    it('calculates the seized value from the rounded seize amount', () => {
      // seizedValue = wantedCollateralValue * LF
      // = 77.77777777e8 * 0.90 = 69.99999999e8
      collateralsState[collateralKey].seizedValue = mulFactor(wantedCollateralValue, assetInfo.liquidationFactor);
    });

    it('subtracts the seized value from the debt remaining value and fall into minDebt case', () => {
      expect(debtRemainingValue - collateralsState[collateralKey].seizedValue).to.be.lessThan(minDebtValue);
      // due to the rounding, remaining debt is 1 wei
      expect(debtRemainingValue - collateralsState[collateralKey].seizedValue).to.be.equal(1n);
    });

    it('calculates closeout collateral value from the full COMP balance', () => {
      // _processDebtClosing starts from the full collateral balance:
      // closeoutCollateralValue = 1e18 * 80e8 / 1e18 = 80e8
      wantedCollateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
    });

    it('calculates closeout collateral value left after liquidation factor', () => {
      // closeoutCollateralValueLeft = wantedCollateralValue * LF
      // = 80e8 * 0.90 = 72e8
      closeoutCollateralValueLeft = mulFactor(wantedCollateralValue, assetInfo.liquidationFactor);
    });

    it('confirms the closeout branch can cover the full remaining debt', () => {
      // debtRemainingValue = 70e8 and closeoutCollateralValueLeft = 72e8,
      // so _processDebtClosing takes its partial-close branch.
      expect(debtRemainingValue).to.be.lessThan(closeoutCollateralValueLeft);
    });

    it('calculates closeout seize amount from the full remaining debt', () => {
      // collateral amount to seize = (debt / LF) / price
      // adjustedDebtValue = 70e8 * 1e18 / 0.90e18 = 77.77777777e8
      const adjustedDebtValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState[collateralKey].seizeAmount = divPrice(adjustedDebtValue, droppedCompPrice, assetInfo.scale);
    });

    it('recomputes closeout wanted collateral value from the closeout seize amount', () => {
      // wantedCollateralValue = closeoutSeizeAmount * COMP price / COMP scale
      // = 0.972222222125e18 * 80e8 / 1e18 = 77.77777777e8
      wantedCollateralValue = mulPrice(collateralsState[collateralKey].seizeAmount, droppedCompPrice, assetInfo.scale);
    });

    it('treats the closeout seized value as the full remaining debt', () => {
      // _processDebtClosing sets seizedValue = debtRemainingValue in this branch,
      // so the 1 price-scale unit rounding shortfall does not leave a borrow.
      collateralsState[collateralKey].seizedValue = debtRemainingValue;
    });

    it('deducts the seized COMP value from the debt even though COMP has BCF zero', () => {
      expect(debtRemainingValue - collateralsState[collateralKey].seizedValue).to.be.equal(0n);
    });

    it('AbsorbCollateral seizes COMP even though COMP has BCF zero', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralKey].address, collateralsState[collateralKey].seizeAmount, wantedCollateralValue
      );
    });

    it('calculates new balance as zero after the seized COMP closes the debt', () => {
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the closed borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(
        collateralAmount - collateralsState[collateralKey].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(
        collateralAmount - collateralsState[collateralKey].seizeAmount
      );
    });

    it('asset remains in the assetIn list because some COMP remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralKey].totalsCollateralBefore.toBigInt() - collateralsState[collateralKey].seizeAmount
      );
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralKey].address)).toBigInt()).to.be.equal(
        collateralsState[collateralKey].collateralReservesBefore.toBigInt() + collateralsState[collateralKey].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('1 soft delisted collateral: BCF = 0, full seizure', function () {
    const droppedCompPrice = exp(50, 8); // 1 COMP is worth $50 after the price drop
    const collateralKey = 'COMP';

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let collateralValue: bigint;
    let totalCollateralizedValue: bigint;
    let wantedCollateralValue: bigint;
    let debtRemainingValueAfterSeize: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let reservedBefore: number;
    let assetInfo: AssetInfoStructOutput;

    before(async function() {
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
      reservedBefore = userBasic._reserved;
      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is not borrow-collateralized after COMP BCF is zeroed', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('sanity check: alice is liquidatable because COMP LCF still counts for liquidation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      // debtRemainingValue = 70e6 * 1e8 / 1e6 = 70e8
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('calculates COMP collateral value at the dropped price', async () => {
      // collateralValue = 1e18 * 50e8 / 1e18 = 50e8
      collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      expect(collateralValue).to.be.equal(exp(50, 8));
    });

    it('excludes the BCF-zero COMP from total collateralized value', async () => {
      // totalCollateralizedValue = collateralValue * BCF = 50e8 * 0 = 0
      totalCollateralizedValue = mulFactor(collateralValue, assetInfo.borrowCollateralFactor);
      expect(totalCollateralizedValue).to.be.equal(0n);
    });

    it('calculates that closing the debt wants more COMP than alice has', async () => {
      // With totalCollateralizedValue = 0 and BCF = 0, the target-HF formula reduces to:
      // wantedCollateralValue = debtRemainingValue / LF = 70e8 / 0.90 = 77.777...e8
      wantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(assetInfo.liquidationFactor, targetHealthFactor) - assetInfo.borrowCollateralFactor.toBigInt());

      expect(wantedCollateralValue).to.be.greaterThan(collateralValue);
    });

    it('uses the full captured COMP amount as the seizure amount', async () => {
      collateralsState[collateralKey].seizeAmount = collateralAmount;
      collateralsState[collateralKey].seizedValue = mulFactor(collateralValue, assetInfo.liquidationFactor);
      wantedCollateralValue = collateralValue;

      // seizedValue = 50e8 * 0.90 = 45e8
      expect(collateralsState[collateralKey].seizedValue).to.be.equal(exp(45, 8));
    });

    it('deducts the seized COMP value from the debt even though COMP has BCF zero', () => {
      debtRemainingValueAfterSeize = debtRemainingValue - collateralsState[collateralKey].seizedValue;

      // debtRemainingValueAfterSeize = 70e8 - 45e8 = 25e8
      expect(debtRemainingValueAfterSeize).to.be.equal(exp(25, 8));
    });

    it('AbsorbCollateral seizes all COMP even though COMP has BCF zero', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralKey].address, collateralsState[collateralKey].seizeAmount, wantedCollateralValue
      );
    });

    it('calculates new balance as zero after bad debt handling', () => {
      // The full seizure leaves residual debt, but totalCollateralizedValue remains zero,
      // so absorb writes off the residual shortfall as bad debt.
      expect(debtRemainingValueAfterSeize).to.be.greaterThan(0n);
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the full borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(newBalance);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0n);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('asset is removed from the assetIn list because all COMP was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralKey].totalsCollateralBefore.toBigInt() - collateralsState[collateralKey].seizeAmount
      );
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralKey].address)).toBigInt()).to.be.equal(
        collateralsState[collateralKey].collateralReservesBefore.toBigInt() + collateralsState[collateralKey].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: soft delisted COMP first, normal WETH second, partial seizure leaves debt above minDebt', function () {
    const droppedCompPrice = exp(80, 8); // 1 COMP is worth $80 after the price drop
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)      }, // 1 COMP, soft-delisted (BCF=0)
      { symbol: 'WETH', amount: exp(0.001, 18)  }, // 0.001 WETH, worth $2
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let debtRemainingValueAfterSeize: bigint;
    let compCollateralValue: bigint;
    let wethCollateralValue: bigint;
    let liquidationValue: bigint;
    let totalCollateralizedValue: bigint;
    let wantedCollateralValue: bigint;
    let minDebtValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      minDebtValue = mulPrice((await comet.baseBorrowMin()).toBigInt(), baseTokenPrice, baseScale);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is not borrow-collateralized after COMP BCF is zeroed', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('sanity check: alice is liquidatable because LCF-weighted collateral is below debt', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      // debtRemainingValue = 70e6 * 1e8 / 1e6 = 70e8
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('calculates COMP collateral value at the dropped price', () => {
      // compCollateralValue = 1e18 * 80e8 / 1e18 = 80e8
      compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      expect(compCollateralValue).to.be.equal(exp(80, 8));
    });

    it('calculates WETH collateral value at the current price', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // wethCollateralValue = 0.001e18 * 2000e8 / 1e18 = 2e8
      wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      expect(wethCollateralValue).to.be.equal(exp(2, 8));
    });

    it('calculates LCF-weighted liquidation value below debt', () => {
      // liquidationValue = COMP value * LCF + WETH value * LCF
      // = 80e8 * 0.85 + 2e8 * 0.80 = 69.6e8
      liquidationValue = mulFactor(compCollateralValue, compInfo.liquidateCollateralFactor)
        + mulFactor(wethCollateralValue, wethInfo.liquidateCollateralFactor);

      expect(liquidationValue).to.be.equal(exp(69.6, 8));
      expect(liquidationValue).to.be.lessThan(debtRemainingValue);
    });

    it('excludes soft delisted COMP but includes WETH in total collateralized value', () => {
      // totalCollateralizedValue = COMP value * 0 + WETH value * 0.75 = 1.5e8
      totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor)
        + mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      expect(totalCollateralizedValue).to.be.equal(exp(1.5, 8));
    });

    it('calculates the COMP amount needed to reach target health', () => {
      // wantedCollateralValue =
      //   (targetHF * debt - totalCollateralizedValue) / (targetHF * LF - BCF)
      // = (1.05 * 70e8 - 1.5e8) / (1.05 * 0.90 - 0) = 76.19047619e8
      wantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());
    });

    it('COMP collateral value covers remaining debt', () => {
      expect(wantedCollateralValue).to.be.lessThan(compCollateralValue);
    });

    it('calculates seize amount of COMP collateral', async () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, compInfo.scale);
    });

    it('calculates seized value and leaves debt above minDebt', () => {
      // seizedValue = wantedCollateralValue * LF = 76.19047619e8 * 0.90 = 68.57142857e8
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(wantedCollateralValue, compInfo.liquidationFactor);
      debtRemainingValueAfterSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
    });

    it('remaining debt is above minDebt', () => {
      expect(debtRemainingValueAfterSeize).to.be.greaterThan(minDebtValue);
    });

    it('reaches target health without entering the minDebt closeout branch', () => {
      // debtRemainingValueAfterSeize * targetHF = 1.42857143e8 * 1.05 = 1.5e8
      expect(mulFactor(debtRemainingValueAfterSeize, targetHealthFactor)).to.be.equal(totalCollateralizedValue);
    });

    it('AbsorbCollateral seizes only part of COMP', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, wantedCollateralValue
      );
    });

    it('does not seize WETH', async () => {
      const absorbReceipt = await absorbTx.wait();
      const wethAbsorbCollateralEvents = absorbReceipt.events?.filter((event) =>
        event.event === 'AbsorbCollateral' && event.args?.asset === tokens[collateralConfigs[1].symbol].address
      ) ?? [];

      expect(wethAbsorbCollateralEvents.length).to.be.equal(0);
    });

    // User base balances
    it('alice remains a borrower after partial COMP seizure', async () => {
      newBalance = -(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);

      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(-newBalance);
    });

    it('alice borrow balance is above minDebt', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.greaterThan(await comet.baseBorrowMin());
    });

    it('alice has new principal', async () => {
      const totalsBasic = await comet.totalsBasic();
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    it('alice principal remains negative', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.lessThan(0);
    });

    // User collateral state
    it('alice COMP collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralAmount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('alice WETH collateral balance is unchanged', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
    });

    it('assetIn list is unchanged because both collateral balances remain', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed base amount', async () => {
      basePaidOut = newBalance - oldBalance;
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is unchanged', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore);
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: normal COMP first, soft delisted WETH second, partial seizure closes debt', function () {
    const droppedCompPrice = exp(20, 8); // 1 COMP is worth $20 after the price drop
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, normal (BCF=0.8)
      { symbol: 'WETH', amount: exp(0.03, 18) }, // 0.03 WETH, worth $60
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let debtRemainingValueAfterCompSeize: bigint;
    let debtRemainingValueAfterWethSeize: bigint;
    let compCollateralValue: bigint;
    let wethCollateralValue: bigint;
    let liquidationValue: bigint;
    let totalCollateralizedValue: bigint;
    let wantedCompCollateralValue: bigint;
    let wantedWethCollateralValue: bigint;
    let minDebtValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      minDebtValue = mulPrice((await comet.baseBorrowMin()).toBigInt(), baseTokenPrice, baseScale);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is not borrow-collateralized after WETH BCF is zeroed and COMP price drops', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('sanity check: alice is liquidatable because LCF-weighted collateral is below debt', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      // debtRemainingValue = 70e6 * 1e8 / 1e6 = 70e8
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('calculates COMP collateral value at the dropped price', () => {
      // compCollateralValue = 1e18 * 20e8 / 1e18 = 20e8
      compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      expect(compCollateralValue).to.be.equal(exp(20, 8));
    });

    it('calculates WETH collateral value at the current price', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // wethCollateralValue = 0.03e18 * 2000e8 / 1e18 = 60e8
      wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      expect(wethCollateralValue).to.be.equal(exp(60, 8));
    });

    it('calculates LCF-weighted liquidation value below debt', () => {
      // liquidationValue = COMP value * LCF + WETH value * LCF
      // = 20e8 * 0.85 + 60e8 * 0.80 = 65e8
      liquidationValue = mulFactor(compCollateralValue, compInfo.liquidateCollateralFactor)
        + mulFactor(wethCollateralValue, wethInfo.liquidateCollateralFactor);

      expect(liquidationValue).to.be.equal(exp(65, 8));
      expect(liquidationValue).to.be.lessThan(debtRemainingValue);
    });

    it('includes normal COMP but excludes soft delisted WETH from total collateralized value', () => {
      // totalCollateralizedValue = COMP value * 0.8 + WETH value * 0 = 16e8
      totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor)
        + mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      expect(totalCollateralizedValue).to.be.equal(exp(16, 8));
    });

    it('calculates that COMP alone cannot reach target health', () => {
      // wantedCompCollateralValue =
      //   (targetHF * debt - totalCollateralizedValue) / (targetHF * LF - BCF)
      // = (1.05 * 70e8 - 16e8) / (1.05 * 0.90 - 0.80) = 396.55172413e8
      wantedCompCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());

      expect(wantedCompCollateralValue).to.be.greaterThan(compCollateralValue);
    });

    it('COMP can not cover wanted collateral value, full seizure', () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
    });

    it('calculates seized COMP value and leaves debt above minDebt', () => {
      // comp seizedValue = 20e8 * 0.90 = 18e8
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);
      debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;

      expect(debtRemainingValueAfterCompSeize).to.be.greaterThan(minDebtValue);
    });

    it('calculates the WETH value needed to reach target health', () => {
      // totalCollateralizedValue is zero after COMP is fully seized because WETH has BCF = 0.
      // wantedWethCollateralValue = (1.05 * 52e8 - 0) / (1.05 * 0.90 - 0) = 57.77777777e8
      wantedWethCollateralValue = (mulFactor(debtRemainingValueAfterCompSeize, targetHealthFactor)) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());
    });

    it('WETH collateral value covers the target-health seizure', () => {
      expect(wantedWethCollateralValue).to.be.lessThan(wethCollateralValue);
    });

    it('target-health WETH seizure would leave debt below minDebt', () => {
      // target-health seizedValue = 57.77777777e8 * 0.90 = 51.99999999e8
      // debt left = 52e8 - 51.99999999e8 = 1, so absorb switches to the minDebt closeout branch.
      const targetHealthSeizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
      const debtRemainingValueAfterTargetHealthSeize = debtRemainingValueAfterCompSeize - targetHealthSeizedValue;

      expect(debtRemainingValueAfterTargetHealthSeize).to.be.lessThanOrEqual(minDebtValue);
    });

    it('calculates the WETH amount needed to close the remaining debt', async () => {
      // wantedWethCollateralValue = remaining debt / LF = 52e8 / 0.90 = 57.77777777e8
      wantedWethCollateralValue = debtRemainingValueAfterCompSeize * factorScale / wethInfo.liquidationFactor.toBigInt();
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
    });

    it('calculates seized WETH value and closes the debt', () => {
      // The minDebt closeout branch treats the seized WETH as covering all remaining debt.
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValueAfterCompSeize;
      debtRemainingValueAfterWethSeize = debtRemainingValueAfterCompSeize - collateralsState[collateralConfigs[1].symbol].seizedValue;

      expect(collateralsState[collateralConfigs[1].symbol].seizedValue).to.be.equal(exp(52, 8));
      expect(debtRemainingValueAfterWethSeize).to.be.equal(0n);
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('emits AbsorbDebt for the full absorbed debt', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('AbsorbCollateral seizes all COMP first', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, compCollateralValue
      );
    });

    it('AbsorbCollateral seizes only part of WETH second', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, wantedWethCollateralValue
      );
    });

    // User base balances
    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice simple base balance is zero after absorb', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice WETH collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(
        collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('alice still holds WETH collateral after partial seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.greaterThan(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.greaterThan(0n);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('assetIn list keeps only WETH because COMP was fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('1 collateral: full delisted COMP absorb', function () {
    const collateralKey = 'COMP';

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let totalCollateralizedValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;

    before(async function() {
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is not borrow-collateralized because COMP has no BCF', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('sanity check: alice is liquidatable because full-delisted COMP contributes no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      // debtRemainingValue = 70e6 * 1e8 / 1e6 = 70e8
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('excludes full-delisted COMP from total collateralized value', async () => {
      const collateralValue = mulPrice(collateralAmount, (await priceFeeds[collateralKey].latestRoundData())[1], compInfo.scale);
      totalCollateralizedValue = mulFactor(collateralValue, compInfo.borrowCollateralFactor);
      expect(totalCollateralizedValue).to.be.equal(0n);
    });

    it('uses zero cached price and full COMP balance as the seizure amount', () => {
      collateralsState[collateralKey].seizeAmount = collateralAmount;
      collateralsState[collateralKey].seizedValue = 0n;

      expect(collateralsState[collateralKey].seizedValue).to.be.equal(0n);
    });

    it('AbsorbCollateral seizes all COMP with zero wanted value', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralKey].address, collateralsState[collateralKey].seizeAmount, 0
      );
    });

    it('debt is not reduced by full-delisted COMP', () => {
      expect(debtRemainingValue - collateralsState[collateralKey].seizedValue).to.be.equal(debtRemainingValue);
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the full borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0n);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('asset is removed from the assetIn list because all COMP was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralKey].totalsCollateralBefore.sub(collateralsState[collateralKey].seizeAmount)
      );
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(
        collateralsState[collateralKey].collateralReservesBefore.add(collateralsState[collateralKey].seizeAmount)
      );
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: full delisted COMP first, normal WETH second', function () {
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, full-delisted (BCF=0, LCF=0)
      { symbol: 'WETH', amount: exp(0.04, 18) }, // 0.04 WETH, worth $80
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let debtRemainingValueAfterWethSeize: bigint;
    let wethCollateralValue: bigint;
    let totalCollateralizedValue: bigint;
    let wantedWethCollateralValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable because WETH LCF-weighted value is below debt', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('calculates WETH collateralized value after full-delisted COMP is ignored', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // wethCollateralValue = 0.04e18 * 2000e8 / 1e18 = 80e8
      wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      totalCollateralizedValue = mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      expect(totalCollateralizedValue).to.be.equal(exp(60, 8));
    });

    it('full-delisted COMP is fully seized with zero wanted value', async () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = 0n;
    });

    it('emits AbsorbCollateral event for COMP', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, 0
      );
    });

    it('calculates partial WETH seizure after COMP reduces no debt', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // wantedWethCollateralValue = (1.05 * 70e8 - 60e8) / (1.05 * 0.90 - 0.75)
      wantedWethCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());

      expect(wantedWethCollateralValue).to.be.lessThan(wethCollateralValue);

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
    });

    it('AbsorbCollateral seizes only part of WETH second', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, wantedWethCollateralValue
      );
    });

    // User base balances
    it('alice remains a borrower after WETH reaches target health', async () => {
      debtRemainingValueAfterWethSeize = debtRemainingValue - collateralsState[collateralConfigs[1].symbol].seizedValue;
      newBalance = -(debtRemainingValueAfterWethSeize * baseScale / baseTokenPrice);

      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(-newBalance);
    });

    it('alice borrow balance is above minDebt', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.greaterThan(await comet.baseBorrowMin());
    });

    it('alice has new principal', async () => {
      const totalsBasic = await comet.totalsBasic();
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    it('alice principal remains negative', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.lessThan(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice still holds WETH collateral after partial seizure', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(
        collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('assetIn list keeps only WETH because COMP was fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed WETH value only', async () => {
      basePaidOut = newBalance - oldBalance;
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet base reserves are reduced by the absorbed WETH value only', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: normal COMP first is fully seized, full delisted WETH second is also seized', function () {
    const droppedCompPrice = exp(20, 8); // 1 COMP is worth $20 after the price drop
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, normal
      { symbol: 'WETH', amount: exp(0.03, 18) }, // 0.03 WETH, worth $60 but fully delisted (BCF=0, LCF=0)
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let compCollateralValue: bigint;
    let debtRemainingValueAfterCompSeize: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable from normal COMP liquidation value only', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('calculates that normal COMP is fully seized first', () => {
      // compCollateralValue = 1e18 * 20e8 / 1e18 = 20e8
      compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);
      debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;

      expect(debtRemainingValueAfterCompSeize).to.be.greaterThan(0n);
    });

    it('AbsorbCollateral seizes all full-delisted WETH with zero wanted value', async () => {
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
      collateralsState[collateralConfigs[1].symbol].seizedValue = 0n;
    });

    it('full-delisted WETH does not reduce the remaining debt', () => {
      expect(debtRemainingValueAfterCompSeize - collateralsState[collateralConfigs[1].symbol].seizedValue).to.be.equal(debtRemainingValueAfterCompSeize);
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the full borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    it('AbsorbCollateral seizes all COMP first', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, compCollateralValue
      );
    });

    it('emits AbsorbCollateral event for WETH', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, 0
      );
    });

    // User base balances
    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('assetIn list removes both seized collaterals', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(
        assetsInBefore & ~(1 << compInfo.offset) & ~(1 << wethInfo.offset)
      );
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet total supplied WETH is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: normal COMP partially covers debt, full delisted WETH is not touched', function () {
    const droppedCompPrice = exp(80, 8); // 1 COMP is worth $80 after the price drop
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, normal
      { symbol: 'WETH', amount: exp(0.03, 18) }, // WETH is fully delisted (BCF=0, LCF=0) but should remain untouched
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let debtRemainingValueAfterCompSeize: bigint;
    let compCollateralValue: bigint;
    let totalCollateralizedValue: bigint;
    let wantedCompCollateralValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable from normal COMP liquidation value only', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('calculates normal COMP collateralized value', () => {
      // compCollateralValue = 1e18 * 80e8 / 1e18 = 80e8
      compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor);

      expect(totalCollateralizedValue).to.be.equal(exp(64, 8));
    });

    it('calculates partial COMP seizure to reach target health', () => {
      wantedCompCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());

      expect(wantedCompCollateralValue).to.be.lessThan(compCollateralValue);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = divPrice(wantedCompCollateralValue, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(wantedCompCollateralValue, compInfo.liquidationFactor);
      debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
    });

    it('remaining debt is above minDebt', async () => {
      // we need this test to prevent accidently dropping into the minDebt branch
      expect(debtRemainingValueAfterCompSeize).to.be.greaterThan(mulPrice(await comet.baseBorrowMin(), baseTokenPrice, baseScale));
    });

    it('AbsorbCollateral seizes only part of COMP', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, wantedCompCollateralValue
      );
    });

    it('does not seize full-delisted WETH after COMP reaches target health', async () => {
      const absorbReceipt = await absorbTx.wait();
      const wethAbsorbCollateralEvents = absorbReceipt.events?.filter((event) =>
        event.event === 'AbsorbCollateral' && event.args?.asset === tokens[collateralConfigs[1].symbol].address
      ) ?? [];

      expect(wethAbsorbCollateralEvents.length).to.be.equal(0);
    });

    // User base balances
    it('alice remains a borrower after COMP reaches target health', async () => {
      newBalance = -(debtRemainingValueAfterCompSeize * baseScale / baseTokenPrice);

      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(-newBalance);
      expect(await comet.borrowBalanceOf(alice.address)).to.be.greaterThan(0);
    });

    it('alice borrow balance is above minDebt', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.greaterThan(await comet.baseBorrowMin());
    });

    it('alice has new principal', async () => {
      const totalsBasic = await comet.totalsBasic();
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    it('alice principal remains negative', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.lessThan(0);
    });

    // User collateral state
    it('alice COMP collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralAmount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(
        collateralAmount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('alice WETH collateral balance is unchanged', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount);
    });

    it('assetIn list is unchanged because both collateral balances remain', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed COMP value only', async () => {
      basePaidOut = newBalance - oldBalance;
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet total supplied WETH is unchanged', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore);
    });

    it('comet base reserves are reduced by the absorbed COMP value only', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: both COMP and WETH are full delisted and both are absorbed', function () {
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, full-delisted (BCF=0, LCF=0)
      { symbol: 'WETH', amount: exp(0.03, 18) }, // 0.03 WETH, full-delisted (BCF=0, LCF=0)
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable because both collaterals contribute no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('AbsorbCollateral seizes all COMP with zero wanted value', async () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = 0n;
    });

    it('AbsorbCollateral seizes all WETH with zero wanted value', async () => {
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
      collateralsState[collateralConfigs[1].symbol].seizedValue = 0n;
    });

    it('full-delisted collaterals do not reduce the remaining debt', () => {
      expect(debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue - collateralsState[collateralConfigs[1].symbol].seizedValue)
        .to.be.equal(debtRemainingValue);
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the full borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    it('emits AbsorbCollateral event for COMP', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, 0
      );
    });

    it('emits AbsorbCollateral event for WETH', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, 0
      );
    });

    // User base balances
    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('assetIn list removes both seized collaterals', async () => {
      const newAssetsIn = await comet.userBasic(alice.address);
      expect(newAssetsIn.assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset) & ~(1 << wethInfo.offset));
      expect(newAssetsIn.assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet total supplied WETH is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('1 collateral: COMP has BCF, LCF, and LF set to zero', function () {
    const collateralKey = 'COMP';

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;

    before(async function() {
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable because LF-zero COMP contributes no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      // doesn't matter what the value is, need > 0
      expect(debtRemainingValue).to.be.greaterThan(0n);
    });

    it('does not emit AbsorbCollateral for LF-zero COMP', async () => {
      const absorbReceipt = await absorbTx.wait();
      const compAbsorbCollateralEvents = absorbReceipt.events?.filter((event) =>
        event.event === 'AbsorbCollateral' && event.args?.asset === tokens[collateralKey].address
      ) ?? [];

      expect(compAbsorbCollateralEvents.length).to.be.equal(0);
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the full borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is unchanged', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(collateralAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('assetIn list is unchanged because COMP was skipped', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is unchanged', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralsState[collateralKey].totalsCollateralBefore);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralsState[collateralKey].tokenBalanceBefore);
    });

    it('comet COMP reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralsState[collateralKey].collateralReservesBefore);
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: LF-zero COMP first, normal WETH second is partially seized', function () {
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, LF=0 (BCF=0, LCF=0, LF=0) — skipped entirely
      { symbol: 'WETH', amount: exp(0.04, 18) }, // 0.04 WETH, worth $80
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let debtRemainingValueAfterWethSeize: bigint;
    let wethCollateralValue: bigint;
    let totalCollateralizedValue: bigint;
    let wantedWethCollateralValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let wethInfo: AssetInfoStructOutput;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable because normal WETH LCF-weighted value is below debt', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('does not emit AbsorbCollateral for LF-zero COMP', async () => {
      const absorbReceipt = await absorbTx.wait();
      const compAbsorbCollateralEvents = absorbReceipt.events?.filter((event) =>
        event.event === 'AbsorbCollateral' && event.args?.asset === tokens[collateralConfigs[0].symbol].address
      ) ?? [];

      expect(compAbsorbCollateralEvents.length).to.be.equal(0);
    });

    it('calculates WETH collateralized value after LF-zero COMP is skipped', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // wethCollateralValue = 0.04e18 * 2000e8 / 1e18 = 80e8
      wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      totalCollateralizedValue = mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      expect(totalCollateralizedValue).to.be.equal(exp(60, 8));
    });

    it('calculates partial WETH seizure to reach target health', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      wantedWethCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());

      expect(wantedWethCollateralValue).to.be.lessThan(wethCollateralValue);

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
      debtRemainingValueAfterWethSeize = debtRemainingValue - collateralsState[collateralConfigs[1].symbol].seizedValue;
    });

    it('remaining debt is above minDebt', async () => {
      // we need this test to prevent accidently dropping into the minDebt branch
      expect(debtRemainingValueAfterWethSeize).to.be.greaterThan(mulPrice(await comet.baseBorrowMin(), baseTokenPrice, baseScale));
    });

    it('AbsorbCollateral seizes only part of WETH', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, wantedWethCollateralValue
      );
    });

    // User base balances
    it('alice remains a borrower after WETH reaches target health', async () => {
      newBalance = -(debtRemainingValueAfterWethSeize * baseScale / baseTokenPrice);

      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(-newBalance);
      expect(await comet.borrowBalanceOf(alice.address)).to.be.greaterThan(0);
    });

    it('alice borrow balance is above minDebt', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.greaterThan(await comet.baseBorrowMin());
    });

    it('alice has new principal', async () => {
      const totalsBasic = await comet.totalsBasic();
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    it('alice principal remains negative', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.lessThan(0);
    });

    // User collateral state
    it('alice COMP collateral balance is unchanged', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(collateralAmount);
    });

    it('alice WETH collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.greaterThan(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(
        collateralConfigs[1].amount - collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('assetIn list is unchanged because both collateral balances remain', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed WETH value only', async () => {
      basePaidOut = newBalance - oldBalance;
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is unchanged', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore);
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].collateralReservesBefore);
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet base reserves are reduced by the absorbed WETH value only', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: normal COMP first is fully seized, LF-zero WETH second is untouched', function () {
    const droppedCompPrice = exp(20, 8); // 1 COMP is worth $20 after the price drop
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, normal
      { symbol: 'WETH', amount: exp(0.03, 18) }, // 0.03 WETH, LF=0 — skipped by absorb loop
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let debtRemainingValueAfterCompSeize: bigint;
    let compCollateralValue: bigint;
    let totalCollateralizedValue: bigint;
    let wantedCompCollateralValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable from normal COMP liquidation value only', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('calculates that normal COMP cannot reach target health', () => {
      // compCollateralValue = 1e18 * 20e8 / 1e18 = 20e8
      compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor);
      wantedCompCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());

      expect(wantedCompCollateralValue).to.be.greaterThan(compCollateralValue);
    });

    it('calculates full COMP seizure and residual debt', () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);
      debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;

      expect(debtRemainingValueAfterCompSeize).to.be.greaterThan(0n);
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the full borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    it('AbsorbCollateral seizes all COMP', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, compCollateralValue
      );
    });

    it('does not emit AbsorbCollateral for LF-zero WETH', async () => {
      const absorbReceipt = await absorbTx.wait();
      const wethAbsorbCollateralEvents = absorbReceipt.events?.filter((event) =>
        event.event === 'AbsorbCollateral' && event.args?.asset === tokens[collateralConfigs[1].symbol].address
      ) ?? [];

      expect(wethAbsorbCollateralEvents.length).to.be.equal(0);
    });

    // User base balances
    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice WETH collateral balance is unchanged', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('assetIn list keeps only WETH because COMP was fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.sub(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet total supplied WETH is unchanged', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore);
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: both COMP and WETH have BCF, LCF, and LF set to zero', function () {
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, all factors zero — skipped by absorb loop
      { symbol: 'WETH', amount: exp(0.03, 18) }, // 0.03 WETH, all factors zero — skipped by absorb loop
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable because both collaterals contribute no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      // matter only > 0
      expect(debtRemainingValue).to.be.greaterThan(0n);
    });

    it('does not emit AbsorbCollateral for either LF-zero collateral', async () => {
      const absorbReceipt = await absorbTx.wait();
      const absorbCollateralEvents = absorbReceipt.events?.filter((event) => event.event === 'AbsorbCollateral') ?? [];

      expect(absorbCollateralEvents.length).to.be.equal(0);
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the full borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);

      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, basePaidOut, valueOfBasePaidOut
      );
    });

    // User base balances
    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is unchanged', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(collateralAmount);
    });

    it('alice WETH collateral balance is unchanged', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(collateralConfigs[1].amount);
    });

    it('assetIn list is unchanged because both collaterals were skipped', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is unchanged', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore);
    });

    it('comet total supplied WETH is unchanged', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[0].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].tokenBalanceBefore);
    });

    it('comet ERC20 WETH token balance is unchanged', async () => {
      expect(await tokens[collateralConfigs[1].symbol].balanceOf(comet.address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].tokenBalanceBefore);
    });

    it('comet COMP reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralsState[collateralConfigs[0].symbol].collateralReservesBefore);
    });

    it('comet WETH reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralsState[collateralConfigs[1].symbol].collateralReservesBefore);
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('5 collaterals: BCF-zero, normal, LCF-zero, LF-zero, and BCF-zero assets', function () {
    const droppedCompPrice = exp(10, 8); // 1 COMP is worth $10 after the price drop
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)      }, // 1 COMP, BCF-zero
      { symbol: 'WETH', amount: exp(0.001, 18)  }, // 0.001 WETH, worth $2, normal
      { symbol: 'USDT', amount: exp(10, 6)      }, // 10 USDT, LCF-zero but LF positive
      { symbol: 'WBTC', amount: exp(0.001, 8)   }, // 0.001 WBTC, LF-zero
      { symbol: 'DAI',  amount: exp(63, 18)     }, // 63 DAI, BCF-zero
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let oldBalance: bigint;
    let newBalance: bigint;
    let basePaidOut: bigint;
    let debtRemainingValue: bigint;
    let compCollateralValue: bigint;
    let wethCollateralValue: bigint;
    let daiCollateralValue: bigint;
    let debtRemainingValueAfterCompSeize: bigint;
    let debtRemainingValueAfterWethSeize: bigint;
    let wantedDaiCollateralValue: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let usdtInfo: AssetInfoStructOutput;
    let wbtcInfo: AssetInfoStructOutput;
    let daiInfo: AssetInfoStructOutput;

    before(async function() {
      for (const config of collateralConfigs.slice(1)) {
        await comet.connect(alice).supply(tokens[config.symbol].address, config.amount);
      }

      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[2].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[2].symbol].address, 0);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[3].symbol].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[3].symbol].address, 0);
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralConfigs[3].symbol].address, 0);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[4].symbol].address, 0);
      await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);

      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      usdtInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[2].symbol].address);
      wbtcInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[3].symbol].address);
      daiInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[4].symbol].address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: alice is liquidatable across the mixed collateral set', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates debt remaining value before absorb', () => {
      debtRemainingValue = mulPrice(-oldBalance, baseTokenPrice, baseScale);
      expect(debtRemainingValue).to.be.equal(exp(70, 8));
    });

    it('AbsorbCollateral seizes all first BCF-zero COMP', async () => {
      compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);
      debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
    });

    it('emit AbsorbCollateral event for COMP', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, compCollateralValue
      );
    });

    it('AbsorbCollateral seizes all second normal WETH', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wethCollateralValue, wethInfo.liquidationFactor);
      debtRemainingValueAfterWethSeize = debtRemainingValueAfterCompSeize - collateralsState[collateralConfigs[1].symbol].seizedValue;
    });

    it('emit AbsorbCollateral event for WETH', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, wethCollateralValue
      );
    });

    it('AbsorbCollateral seizes all third LCF-zero USDT with zero wanted value', async () => {
      collateralsState[collateralConfigs[2].symbol].seizeAmount = collateralConfigs[2].amount;
      collateralsState[collateralConfigs[2].symbol].seizedValue = 0n;
    });

    it('emit AbsorbCollateral event for USDT', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[2].symbol].address, collateralsState[collateralConfigs[2].symbol].seizeAmount, 0
      );
    });

    it('USDT seizure does not decrease the remaining debt', () => {
      expect(debtRemainingValueAfterWethSeize - collateralsState[collateralConfigs[2].symbol].seizedValue).to.be.equal(debtRemainingValueAfterWethSeize);
    });

    it('does not emit AbsorbCollateral for fourth LF-zero WBTC', async () => {
      const absorbReceipt = await absorbTx.wait();
      const wbtcAbsorbCollateralEvents = absorbReceipt.events?.filter((event) =>
        event.event === 'AbsorbCollateral' && event.args?.asset === tokens[collateralConfigs[3].symbol].address
      ) ?? [];

      expect(wbtcAbsorbCollateralEvents.length).to.be.equal(0);
    });

    it('remaining debt is above minDebt', async () => {
      // we need this test to prevent accidentally dropping into the minDebt branch
      expect(debtRemainingValueAfterWethSeize).to.be.greaterThan(mulPrice(await comet.baseBorrowMin(), baseTokenPrice, baseScale));
    });

    it('calculates DAI value needed to close the remaining debt', async () => {
      const daiPrice = (await priceFeeds[collateralConfigs[4].symbol].latestRoundData())[1].toBigInt();

      daiCollateralValue = mulPrice(collateralConfigs[4].amount, daiPrice, daiInfo.scale);
      wantedDaiCollateralValue = debtRemainingValueAfterWethSeize * factorScale / daiInfo.liquidationFactor.toBigInt();

      expect(wantedDaiCollateralValue).to.be.lessThan(daiCollateralValue);

      collateralsState[collateralConfigs[4].symbol].seizeAmount = divPrice(wantedDaiCollateralValue, daiPrice, daiInfo.scale);
      collateralsState[collateralConfigs[4].symbol].seizedValue = debtRemainingValueAfterWethSeize;
    });

    it('AbsorbCollateral partially seizes fifth BCF-zero DAI', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[4].symbol].address, collateralsState[collateralConfigs[4].symbol].seizeAmount, wantedDaiCollateralValue
      );
    });

    it('newBalance is zero after full closure', () => {
      newBalance = 0n;
    });

    it('AbsorbDebt writes off the full borrow amount', async () => {
      basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    // User base balances
    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP, WETH, and USDT collateral balances are zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[2].symbol].address)).to.be.equal(0);
    });

    it('alice WBTC collateral balance is unchanged', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[3].symbol].address)).to.be.equal(collateralConfigs[3].amount);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[3].symbol].address)).balance).to.be.equal(collateralConfigs[3].amount);
    });

    it('alice DAI collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[4].symbol].address)).to.be.equal(
        collateralConfigs[4].amount - collateralsState[collateralConfigs[4].symbol].seizeAmount
      );
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[4].symbol].address)).balance).to.be.equal(
        collateralConfigs[4].amount - collateralsState[collateralConfigs[4].symbol].seizeAmount
      );
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('assetIn list keeps WBTC and DAI after absorb', async () => {
      const assetsInAfter = (await comet.userBasic(alice.address)).assetsIn;

      expect(assetsInAfter).to.be.equal(
        assetsInBefore
          & ~(1 << compInfo.offset)
          & ~(1 << wethInfo.offset)
          & ~(1 << usdtInfo.offset)
      );
      expect(assetsInAfter).to.be.equal((1 << wbtcInfo.offset) | (1 << daiInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    for (const config of collateralConfigs) {
      it(`comet ERC20 ${config.symbol} token balance is unchanged`, async () => {
        expect(await tokens[config.symbol].balanceOf(comet.address)).to.be.equal(collateralsState[config.symbol].tokenBalanceBefore);
      });
    }

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[1].symbol].seizeAmount)
      );
    });

    it('comet USDT reserves increase by the full collateral amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[2].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[2].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[2].symbol].seizeAmount)
      );
    });

    it('comet WBTC reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[3].symbol].address)).to.be.equal(collateralsState[collateralConfigs[3].symbol].collateralReservesBefore);
    });

    it('comet DAI reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[4].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[4].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[4].symbol].seizeAmount)
      );
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('revert cases', function () {
    context('1 soft delisted collateral: BCF = 0 and collateral is deactivated', function () {
      const droppedCompPrice = exp(80, 8); // 1 COMP is worth $80 after the price drop
      const collateralKey = 'COMP';

      before(async function() {
        await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
        await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    
        await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
        await comet.accrueAccount(alice.address);
    
        const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
        await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      });
    
      after(async () => await snapshot.restore());
    
      it('sanity check: alice is liquidatable because deactivation is ignored by the liquidation path', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.true;
      });
    
      it('borrow collateralization check reverts before the BCF-zero skip', async () => {
        await expect(comet.isBorrowCollateralized(alice.address))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
          .withArgs(tokens[collateralKey].address);
      });
    
      it('absorb reverts', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
          .withArgs(tokens[collateralKey].address);
      });
    });

    context('1 soft delisted collateral: BCF = 0, LCF = 0, LF > 0 and collateral is deactivated', function () {
      const collateralKey = 'COMP';
      before(async function() {
        await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
        await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
        await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

        const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
        await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      });

      after(async () => await snapshot.restore());

      it('sanity check: alice is liquidatable because LCF zero skips deactivated COMP in the liquidation path', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.true;
      });

      it('borrow collateralization check reverts before the BCF-zero skip', async () => {
        await expect(comet.isBorrowCollateralized(alice.address))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
          .withArgs(tokens[collateralKey].address);
      });

      it('absorb reverts', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
          .withArgs(tokens[collateralKey].address);
      });
    });

    context('1 soft delisted collateral: BCF = 0, LCF = 0, LF = 0 and collateral is deactivated', function () {
      const collateralKey = 'COMP';
      before(async function() {
        await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
        await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
        await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralKey].address, 0);
        await cometProxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

        const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
        await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      });

      after(async () => await snapshot.restore());

      it('sanity check: alice is liquidatable because LCF zero skips deactivated COMP in the liquidation path', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.true;
      });

      it('borrow collateralization check reverts before the BCF-zero skip', async () => {
        await expect(comet.isBorrowCollateralized(alice.address))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
          .withArgs(tokens[collateralKey].address);
      });

      it('absorb reverts', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
          .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
          .withArgs(tokens[collateralKey].address);
      });
    });
  });
});
