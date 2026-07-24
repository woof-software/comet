import { ethers, expect, exp, presentValue, mulPrice, mulFactor, divPrice, default24Assets, CollateralState, makeCollateralStates, makeConfigurator, principalValue, deployDefaultLiquidationModuleWithComet, seedMarketActivity, DeployLiquidationModuleOpts, deployEmptyDexAdapter} from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, LiquidationModule, FaucetToken, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';
import { AssetInfoStructOutput } from 'build/types/CometWithExtendedAssetList';

import { useBlockDelta } from '../helpers/block-clock';

// These flows cover absorption after a collateral is soft-delisted by setting BCF to 0.
// The collateral no longer contributes to the borrow-side health value, but if LCF and LF
// remain positive it is still liquidatable and must reduce the account's debt when seized.
describe('absorb logic with delisted collaterals', function() {
  // Pin one second between blocks so interest accrues deterministically regardless of machine speed.
  useBlockDelta(1);

  // Protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  let configurator: Configurator;
  let cometProxyAdmin: CometProxyAdmin;
  let configuratorProxyAddress: string;
  let cometProxyAddress: string;
  let liquidationModule: LiquidationModule;
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

    pauseGuardian = protocol.pauseGuardian;
    governor = protocol.governor;

    liquidationModule = protocol.defaultLiquidationModule;
    targetHealthFactor = (await liquidationModule.TARGET_HEALTH_FACTOR()).toBigInt();
    ///turn off DEX liquidation to test pure absorbtion mechanics
    await liquidationModule.connect(protocol.pausers[0]).setDexRoutePaused(true);

    emptyDexAdapterAddress = (await deployEmptyDexAdapter(Object.entries(protocol.tokens).filter(([symbol]) => symbol !== protocol.base).map(([, token]) => {return token.address;}))).address;
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

  /*//////////////////////////////////////////////////////////////
                        BCF = 0 / SOFT DELISTED
  //////////////////////////////////////////////////////////////*/

  context('1 soft delisted collateral: BCF = 0, partial seizure', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — liquidation value $70.55 still covers the $70 debt
    const collateralKey = 'COMP';
    const TIME_UNTIL_LIQUIDATABLE = 180 * 24 * 60 * 60; // 180 days of borrow interest

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseSupplyIndexBefore: bigint;
    let baseBorrowIndexBefore: bigint;
    let baseReservesBefore: bigint;
    let absorbedBaseAmount: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let assetInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowCollateralizedAfterSoftDelist: boolean;
    let liquidatableAfterSoftDelist: boolean;

    before(async function() {
      // Capture the health flags while COMP is still a normal collateral (BCF = 0.8, price $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Governance soft-delists COMP (BCF -> 0) and rewires a fresh liquidation module.
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      // COMP declines to $83; liquidation value ($83 * 0.85 = $70.55) still exceeds the $70 debt.
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
      borrowCollateralizedAfterSoftDelist = await comet.isBorrowCollateralized(alice.address);
      liquidatableAfterSoftDelist = await comet.isLiquidatable(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: before soft-delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before soft-delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: after soft-delisting, comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('alice is not borrow-collateralized after COMP borrow collateral factor is zeroed', () => {
      expect(borrowCollateralizedAfterSoftDelist).to.be.false;
    });

    it('alice is still not liquidatable after COMP borrow collateral factor is zeroed', () => {
      expect(liquidatableAfterSoftDelist).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      await ethers.provider.send('evm_increaseTime', [TIME_UNTIL_LIQUIDATABLE]);
      await ethers.provider.send('evm_mine', []);
      await comet.accrueAccount(alice.address);
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseSupplyIndexBefore = totalsBasic.baseSupplyIndex.toBigInt();
      baseBorrowIndexBefore = totalsBasic.baseBorrowIndex.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates seize amount and seized value for the minDebt closeout', async () => {
      // With COMP BCF = 0 the target-HF seizure closes the whole debt (falls into the minDebt closeout),
      // so absorb seizes enough COMP to repay the full accrued debt:
      // adjustedDebtValue = debtValue * 1e18 / 0.90e18
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      const adjustedDebtValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState[collateralKey].seizeAmount = divPrice(adjustedDebtValue, droppedCompPrice, assetInfo.scale);
      collateralsState[collateralKey].seizedValue = debtRemainingValue;

      // getReserves() = baseBalance - presentValueSupply(totalSupplyBase) + presentValueBorrow(totalBorrowBase).
      // Absorb leaves the base token balance unchanged, so the exact reserve decrease is the supply-value
      // increase minus the remaining borrow-value increase after alice's principal is removed.
      const totalSupplyBefore = presentValue(totalSupplyBaseBefore, baseSupplyIndexBefore, baseBorrowIndexBefore);
      const totalSupplyAfter = presentValue(totalSupplyBaseBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      const totalBorrowBefore = -presentValue(-totalBorrowBaseBefore, baseSupplyIndexBefore, baseBorrowIndexBefore);
      const totalBorrowAfter = -presentValue(-(totalBorrowBaseBefore + principalBefore), totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      absorbedBaseAmount = (totalSupplyAfter - totalSupplyBefore) - (totalBorrowAfter - totalBorrowBefore);
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is reduced by the seized amount and some COMP remains', async () => {
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
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      // totalBorrowBase is denominated in principal, so it drops by alice's borrow principal
      // (principalBefore is negative, so adding it subtracts the magnitude).
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
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
      expect((await comet.getReserves()).toBigInt()).to.be.equal(baseReservesBefore - absorbedBaseAmount);
    });
  });

  context('1 soft delisted collateral: BCF = 0, close-debt mode leaves collateral', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — still above the liquidation threshold post-delist
    const collateralKey = 'COMP';
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseSupplyIndexBefore: bigint;
    let baseBorrowIndexBefore: bigint;
    let baseReservesBefore: bigint;
    let absorbedBaseAmount: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let assetInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowCollateralizedAfterSoftDelist: boolean;
    let liquidatableAfterSoftDelist: boolean;

    before(async function() {
      // Capture the health flags while COMP is still a normal collateral (BCF = 0.8, price $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Governance soft-delists COMP (BCF -> 0), accelerates borrow accrual for the test,
      // and rewires a fresh liquidation module.
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      // COMP declines to $83; liquidation value ($83 * 0.85 = $70.55) still exceeds the $70 debt.
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
      borrowCollateralizedAfterSoftDelist = await comet.isBorrowCollateralized(alice.address);
      liquidatableAfterSoftDelist = await comet.isLiquidatable(alice.address);

      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);
    });

    after(async () => await snapshot.restore());

    it('sanity check: before soft-delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before soft-delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: after soft-delisting, comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('alice is not borrow-collateralized after COMP borrow collateral factor is zeroed', () => {
      expect(borrowCollateralizedAfterSoftDelist).to.be.false;
    });

    it('alice is still not liquidatable after COMP borrow collateral factor is zeroed', () => {
      expect(liquidatableAfterSoftDelist).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      // Stop as soon as alice is liquidatable. The debt (~$70.6) is then below the full COMP value
      // ($74.70), so close-debt mode seizes COMP only partially to repay the debt — leaving COMP behind.
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const totalsBasic = await comet.totalsBasic();
      const userBasic = await comet.userBasic(alice.address);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseSupplyIndexBefore = totalsBasic.baseSupplyIndex.toBigInt();
      baseBorrowIndexBefore = totalsBasic.baseBorrowIndex.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates seize amount and seized value for the debt closeout', async () => {
      // The accrued debt is below the full COMP value, so close-debt mode seizes only enough COMP to
      // repay the full debt (debt/LF worth) and leaves the rest of the COMP:
      // adjustedDebtValue = debtValue * 1e18 / 0.90e18
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      const adjustedDebtValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState[collateralKey].seizeAmount = divPrice(adjustedDebtValue, droppedCompPrice, assetInfo.scale);
      collateralsState[collateralKey].seizedValue = debtRemainingValue;

      // getReserves() = baseBalance - presentValueSupply(totalSupplyBase) + presentValueBorrow(totalBorrowBase).
      // Absorb leaves the base token balance unchanged, so the exact reserve decrease is the supply-value
      // increase minus the remaining borrow-value increase after alice's principal is removed.
      const totalSupplyBefore = presentValue(totalSupplyBaseBefore, baseSupplyIndexBefore, baseBorrowIndexBefore);
      const totalSupplyAfter = presentValue(totalSupplyBaseBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      const totalBorrowBefore = -presentValue(-totalBorrowBaseBefore, baseSupplyIndexBefore, baseBorrowIndexBefore);
      const totalBorrowAfter = -presentValue(-(totalBorrowBaseBefore + principalBefore), totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      absorbedBaseAmount = (totalSupplyAfter - totalSupplyBefore) - (totalBorrowAfter - totalBorrowBefore);
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is reduced by the seized amount and some COMP remains', async () => {
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
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      // totalBorrowBase is denominated in principal, so it drops by alice's borrow principal
      // (principalBefore is negative, so adding it subtracts the magnitude).
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
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
      expect((await comet.getReserves()).toBigInt()).to.be.equal(baseReservesBefore - absorbedBaseAmount);
    });
  });

  context('2 collaterals: soft delisted COMP first, normal WETH second, partial seizure', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — COMP + WETH liquidation value still covers the initial debt
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)      }, // 1 COMP, soft-delisted (BCF=0)
      { symbol: 'WETH', amount: exp(0.001, 18)  }, // 0.001 WETH, worth $2
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseSupplyIndexBefore: bigint;
    let baseBorrowIndexBefore: bigint;
    let baseReservesBefore: bigint;
    let absorbedBaseAmount: bigint;
    let debtRemainingValueAfterSeize: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowCollateralizedAfterSoftDelist: boolean;
    let liquidatableAfterSoftDelist: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while COMP is still a normal collateral and WETH is also supplied.
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Governance soft-delists COMP (BCF -> 0), accelerates borrow accrual for the test,
      // and rewires a fresh liquidation module.
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
      borrowCollateralizedAfterSoftDelist = await comet.isBorrowCollateralized(alice.address);
      liquidatableAfterSoftDelist = await comet.isLiquidatable(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: before soft-delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before soft-delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: after soft-delisting, comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('alice is not borrow-collateralized after COMP borrow collateral factor is zeroed', () => {
      expect(borrowCollateralizedAfterSoftDelist).to.be.false;
    });

    it('alice is still not liquidatable after COMP borrow collateral factor is zeroed', () => {
      expect(liquidatableAfterSoftDelist).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseSupplyIndexBefore = totalsBasic.baseSupplyIndex.toBigInt();
      baseBorrowIndexBefore = totalsBasic.baseBorrowIndex.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates COMP and WETH seize amounts for the partial seizure', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // COMP has BCF=0, so only WETH contributes to collateralized value:
      // totalCollateralizedValue = WETH value * BCF = 2e8 * 0.75 = 1.5e8
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      const totalCollateralizedValue = mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      // Solve the target-HF formula for COMP; WETH is left untouched.
      // wantedCollateralValue = (targetHF * debtValue - WETH_BCF_value) / (targetHF * COMP_LF - COMP_BCF)
      const wantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());

      collateralsState[collateralConfigs[0].symbol].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(wantedCollateralValue, compInfo.liquidationFactor);

      // The rounded COMP seize amount can leave the account just below target health, so absorb
      // seizes a dust amount of WETH to restore target health while leaving the debt above minDebt.
      const debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const wantedWethCollateralValue = (mulFactor(debtRemainingValueAfterCompSeize, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
      debtRemainingValueAfterSeize = debtRemainingValue
        - collateralsState[collateralConfigs[0].symbol].seizedValue
        - collateralsState[collateralConfigs[1].symbol].seizedValue;

      const principalAfter = (await comet.userBasic(alice.address)).principal.toBigInt();
      const totalSupplyBefore = presentValue(totalSupplyBaseBefore, baseSupplyIndexBefore, baseBorrowIndexBefore);
      const totalSupplyAfter = presentValue(totalSupplyBaseBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      const totalBorrowBefore = -presentValue(-totalBorrowBaseBefore, baseSupplyIndexBefore, baseBorrowIndexBefore);
      const totalBorrowAfter = -presentValue(-(totalBorrowBaseBefore + principalBefore - principalAfter), totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      absorbedBaseAmount = (totalSupplyAfter - totalSupplyBefore) - (totalBorrowAfter - totalBorrowBefore);
    });

    // User base balances
    it('alice remains a borrower after partial COMP seizure', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice has new principal', async () => {
      const newBalance = -(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
      const totalsBasic = await comet.totalsBasic();
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    // User collateral state
    it('alice COMP collateral balance is reduced by the seized amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralAmount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('alice WETH collateral balance is reduced by the dust seize amount', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by the absorbed base amount', async () => {
      const principalAfter = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore - principalAfter);
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

    it('comet total supplied WETH is reduced by the dust seize amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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

    it('comet COMP reserves increase by the seized amount', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.add(collateralsState[collateralConfigs[0].symbol].seizeAmount)
      );
    });

    it('comet WETH reserves increase by the dust seize amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      expect((await comet.getReserves()).toBigInt()).to.be.equal(baseReservesBefore - absorbedBaseAmount);
    });
  });

  context('2 collaterals: soft delisted COMP first fully seized, normal WETH second closes the debt', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — COMP + WETH liquidation value still covers the initial debt
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)      }, // 1 COMP, soft-delisted (BCF=0)
      { symbol: 'WETH', amount: exp(0.005, 18)  }, // 0.005 WETH, worth $10 — enough to close the debt with some left over
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseSupplyIndexBefore: bigint;
    let baseBorrowIndexBefore: bigint;
    let baseReservesBefore: bigint;
    let absorbedBaseAmount: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowCollateralizedAfterSoftDelist: boolean;
    let liquidatableAfterSoftDelist: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while COMP is still a normal collateral and WETH is also supplied.
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Governance soft-delists COMP (BCF -> 0), accelerates borrow accrual for the test,
      // rewires a fresh liquidation module, and disables partial liquidation mode.
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
      borrowCollateralizedAfterSoftDelist = await comet.isBorrowCollateralized(alice.address);
      liquidatableAfterSoftDelist = await comet.isLiquidatable(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: before soft-delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before soft-delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: after soft-delisting, comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('alice is not borrow-collateralized after COMP borrow collateral factor is zeroed', () => {
      expect(borrowCollateralizedAfterSoftDelist).to.be.false;
    });

    it('alice is still not liquidatable after COMP borrow collateral factor is zeroed', () => {
      expect(liquidatableAfterSoftDelist).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      // Stop as soon as alice is liquidatable. At that point the debt (~$78.55) already exceeds the
      // full COMP value ($74.70), so COMP is fully seized, but WETH ($9 of capacity) is only tapped
      // for the ~$3.85 remainder — leaving WETH behind.
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseSupplyIndexBefore = totalsBasic.baseSupplyIndex.toBigInt();
      baseBorrowIndexBefore = totalsBasic.baseBorrowIndex.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates COMP full seizure and the WETH partial seizure that closes the debt', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const totalsBasic = await comet.totalsBasic();

      // Partial liquidation is disabled, so COMP (soft-delisted) is fully seized first, repaying
      // COMP value * LF.
      const compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      // WETH then closes the remaining debt through the close-debt branch: it seizes remaining/LF
      // worth and leaves the rest of the WETH untouched.
      const debtRemainingValueAfterCompSeize = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale)
        - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const wantedWethCollateralValue = debtRemainingValueAfterCompSeize * factorScale / wethInfo.liquidationFactor.toBigInt();
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValueAfterCompSeize;

      const totalSupplyBefore = presentValue(totalSupplyBaseBefore, baseSupplyIndexBefore, baseBorrowIndexBefore);
      const totalSupplyAfter = presentValue(totalSupplyBaseBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      const totalBorrowBefore = -presentValue(-totalBorrowBaseBefore, baseSupplyIndexBefore, baseBorrowIndexBefore);
      const totalBorrowAfter = -presentValue(-(totalBorrowBaseBefore + principalBefore), totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      absorbedBaseAmount = (totalSupplyAfter - totalSupplyBefore) - (totalBorrowAfter - totalBorrowBefore);
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

    it('assetIn list keeps only WETH because COMP was fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the full absorbed base amount', async () => {
      expect((await comet.getReserves()).toBigInt()).to.be.equal(baseReservesBefore - absorbedBaseAmount);
    });
  });

  context('2 collaterals: normal COMP first, soft delisted WETH second, partial seizure closes debt', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines near the liquidation boundary while COMP + WETH still cover the initial debt
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(3, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, normal (BCF=0.8)
      { symbol: 'WETH', amount: exp(0.03, 18) }, // 0.03 WETH, worth $60
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowCollateralizedAfterSoftDelist: boolean;
    let liquidatableAfterSoftDelist: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while both COMP and WETH are normal collaterals.
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Governance soft-delists WETH (BCF -> 0), accelerates borrow accrual for the test,
      // and rewires a fresh liquidation module.
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
      borrowCollateralizedAfterSoftDelist = await comet.isBorrowCollateralized(alice.address);
      liquidatableAfterSoftDelist = await comet.isLiquidatable(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: before soft-delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before soft-delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: after soft-delisting, comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('alice is not borrow-collateralized after WETH borrow collateral factor is zeroed', () => {
      expect(borrowCollateralizedAfterSoftDelist).to.be.false;
    });

    it('alice is still not liquidatable after WETH borrow collateral factor is zeroed', () => {
      expect(liquidatableAfterSoftDelist).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates COMP and WETH seize amounts for the full COMP seizure then WETH closeout', async () => {
      // Normal COMP cannot reach target health after the debt accrues, so it is fully seized.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      const debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const actualWethSeizeAmount = collateralConfigs[1].amount
        - (await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).toBigInt();

      collateralsState[collateralConfigs[1].symbol].seizeAmount = actualWethSeizeAmount;
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValueAfterCompSeize;
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

    it('assetIn list keeps only WETH because COMP was fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
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
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  context('2 collaterals: normal COMP first, soft delisted WETH second, full debt close mode', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines near the liquidation boundary while COMP + WETH still cover the initial debt
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(3, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, normal (BCF=0.8)
      { symbol: 'WETH', amount: exp(0.03, 18) }, // 0.03 WETH, worth $60
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowCollateralizedAfterSoftDelist: boolean;
    let liquidatableAfterSoftDelist: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while both COMP and WETH are normal collaterals.
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Governance soft-delists WETH (BCF -> 0), accelerates borrow accrual for the test, rewires a
      // fresh liquidation module, and disables partial liquidation mode.
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
      borrowCollateralizedAfterSoftDelist = await comet.isBorrowCollateralized(alice.address);
      liquidatableAfterSoftDelist = await comet.isLiquidatable(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: before soft-delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before soft-delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: after soft-delisting, comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('alice is not borrow-collateralized after WETH borrow collateral factor is zeroed', () => {
      expect(borrowCollateralizedAfterSoftDelist).to.be.false;
    });

    it('alice is still not liquidatable after WETH borrow collateral factor is zeroed', () => {
      expect(liquidatableAfterSoftDelist).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates COMP full seizure then WETH closeout that repays the debt', async () => {
      // Partial liquidation is disabled, so COMP is fully seized (the accrued debt exceeds the full
      // COMP value), then WETH closes the remaining debt through the close-debt branch, leaving WETH.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const compCollateralValue = mulPrice(collateralAmount, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralAmount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      const debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const actualWethSeizeAmount = collateralConfigs[1].amount
        - (await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).toBigInt();

      collateralsState[collateralConfigs[1].symbol].seizeAmount = actualWethSeizeAmount;
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValueAfterCompSeize;
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

    it('assetIn list keeps only WETH because COMP was fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the full absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
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
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  /*//////////////////////////////////////////////////////////////
                     BCF & LCF = 0 / DELISTED
  //////////////////////////////////////////////////////////////*/

  context('1 collateral: delisted COMP absorb', function () {
    const collateralKey = 'COMP';

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let compInfoBeforeDelist: AssetInfoStructOutput;

    before(async function() {
      // Capture the health flags while COMP is still listed.
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      compInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralKey].address);

      // Governance fully delists COMP for collateralization purposes (BCF -> 0, LCF -> 0),
      // then rewires a fresh liquidation module.
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, COMP liquidation value could cover alice debt', () => {
      const debtValueBeforeDelist = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const compCollateralValueBeforeDelist = mulPrice(collateralAmount, baseTokenPrice * 100n, compInfoBeforeDelist.scale);
      const compLiquidationValueBeforeDelist = mulFactor(compCollateralValueBeforeDelist, compInfoBeforeDelist.liquidationFactor);

      expect(compLiquidationValueBeforeDelist).to.be.greaterThanOrEqual(debtValueBeforeDelist);
    });

    it('alice is not borrow-collateralized after COMP is fully delisted', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('alice is liquidatable because full-delisted COMP contributes no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates full COMP removal and absorbed debt value', () => {
      // Full-delisted COMP (BCF=0, LCF=0) is excluded from collateralized and liquidatable value.
      // With no other collateral, absorb removes the whole COMP balance and closes Alice's borrow.
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      collateralsState[collateralKey].seizeAmount = collateralAmount;
      collateralsState[collateralKey].seizedValue = debtRemainingValue;
    });

    it('absorbed debt value equals Alice debt before absorb', () => {
      expect(collateralsState[collateralKey].seizedValue).to.be.equal(mulPrice(-balanceBefore, baseTokenPrice, baseScale));
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

    it('asset is removed from the assetIn list because all COMP was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
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
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: delisted COMP first, normal WETH second, partial position remains', function () {
    const droppedCompPrice = exp(75, 8); // COMP declines to $75: COMP alone cannot cover the $70 debt, but COMP + WETH can.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    }, // 1 COMP, full-delisted (BCF=0, LCF=0)
      { symbol: 'WETH', amount: exp(0.04, 18) }, // 0.04 WETH, worth $80
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let compInfoBeforeDelist: AssetInfoStructOutput;
    let wethInfoBeforeDelist: AssetInfoStructOutput;
    let wethPriceBeforeDelist: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);

      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      compInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      wethPriceBeforeDelist = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, WETH alone could not back the debt but COMP plus WETH could', () => {
      const debtValue = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const compCollateralValueBeforeDelist = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfoBeforeDelist.scale);
      const wethCollateralValueBeforeDelist = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfoBeforeDelist.scale);
      const compBorrowValueBeforeDelist = mulFactor(compCollateralValueBeforeDelist, compInfoBeforeDelist.borrowCollateralFactor);
      const wethBorrowValueBeforeDelist = mulFactor(wethCollateralValueBeforeDelist, wethInfoBeforeDelist.borrowCollateralFactor);
      const totalBorrowValueBeforeDelist = compBorrowValueBeforeDelist + wethBorrowValueBeforeDelist;

      expect(wethBorrowValueBeforeDelist).to.be.lessThan(debtValue);
      expect(totalBorrowValueBeforeDelist).to.be.greaterThanOrEqual(debtValue);
    });

    it('alice is not borrow-collateralized after COMP is delisted because WETH cannot fully back the debt', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('alice is liquidatable because full-delisted COMP contributes no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates full COMP removal and partial WETH seizure', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      const totalCollateralizedValue = mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);
      const wantedWethCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
    });

    // User base balances
    it('alice borrow balance equals the debt left after WETH reaches target health', async () => {
      const debtRemainingValueAfterSeize = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[1].symbol].seizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal matches the reduced debt', async () => {
      const debtRemainingValueAfterSeize = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[1].symbol].seizedValue;
      const newBalance = -(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
      const totalsBasic = await comet.totalsBasic();
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice still holds WETH balance', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by the repaid principal', async () => {
      const principalAfter = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore - principalAfter);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the repaid base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: delisted COMP first, normal WETH second, full debt close leaves WETH', function () {
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    },
      { symbol: 'WETH', amount: exp(0.04, 18) },
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let compInfoBeforeDelist: AssetInfoStructOutput;
    let wethInfoBeforeDelist: AssetInfoStructOutput;
    let compPriceBeforeDelist: bigint;
    let wethPriceBeforeDelist: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      compInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      compPriceBeforeDelist = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      wethPriceBeforeDelist = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, WETH alone could not back the debt but COMP plus WETH could', () => {
      const debtValue = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const compCollateralValueBeforeDelist = mulPrice(collateralConfigs[0].amount, compPriceBeforeDelist, compInfoBeforeDelist.scale);
      const wethCollateralValueBeforeDelist = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfoBeforeDelist.scale);
      const compBorrowValueBeforeDelist = mulFactor(compCollateralValueBeforeDelist, compInfoBeforeDelist.borrowCollateralFactor);
      const wethBorrowValueBeforeDelist = mulFactor(wethCollateralValueBeforeDelist, wethInfoBeforeDelist.borrowCollateralFactor);
      const totalBorrowValueBeforeDelist = compBorrowValueBeforeDelist + wethBorrowValueBeforeDelist;

      expect(wethBorrowValueBeforeDelist).to.be.lessThan(debtValue);
      expect(totalBorrowValueBeforeDelist).to.be.greaterThanOrEqual(debtValue);
    });

    it('alice is liquidatable after COMP is delisted', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates full COMP removal and WETH debt closeout', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const wantedWethCollateralValue = debtRemainingValue * factorScale / wethInfo.liquidationFactor.toBigInt();

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValue;
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
    });

    it('alice still holds a small WETH balance', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: delisted COMP first, normal WETH second, bad debt with nothing remaining', function () {
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    },
      { symbol: 'WETH', amount: exp(0.03, 18) },
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let compInfoBeforeDelist: AssetInfoStructOutput;
    let wethInfoBeforeDelist: AssetInfoStructOutput;
    let compPriceBeforeDelist: bigint;
    let wethPriceBeforeDelist: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      compInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      compPriceBeforeDelist = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      wethPriceBeforeDelist = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, WETH alone could not back the debt but COMP plus WETH could', () => {
      const debtValue = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const compCollateralValueBeforeDelist = mulPrice(collateralConfigs[0].amount, compPriceBeforeDelist, compInfoBeforeDelist.scale);
      const wethCollateralValueBeforeDelist = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfoBeforeDelist.scale);
      const compBorrowValueBeforeDelist = mulFactor(compCollateralValueBeforeDelist, compInfoBeforeDelist.borrowCollateralFactor);
      const wethBorrowValueBeforeDelist = mulFactor(wethCollateralValueBeforeDelist, wethInfoBeforeDelist.borrowCollateralFactor);
      const totalBorrowValueBeforeDelist = compBorrowValueBeforeDelist + wethBorrowValueBeforeDelist;

      expect(wethBorrowValueBeforeDelist).to.be.lessThan(debtValue);
      expect(totalBorrowValueBeforeDelist).to.be.greaterThanOrEqual(debtValue);
    });

    it('alice is liquidatable after COMP is delisted', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates full COMP removal and full WETH seizure with bad debt', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wethCollateralValue, wethInfo.liquidationFactor);
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
    });

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('assetIn list removes both fully seized collaterals', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(
        assetsInBefore & ~(1 << compInfo.offset) & ~(1 << wethInfo.offset)
      );
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the full collateral amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: normal COMP first, delisted WETH second, partial position leaves both assets', function () {
    const droppedCompPrice = exp(80, 8); // COMP declines to $80: COMP alone cannot cover the $70 debt, but COMP + WETH can.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    },
      { symbol: 'WETH', amount: exp(0.04, 18) },
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let compInfoBeforeDelist: AssetInfoStructOutput;
    let wethInfoBeforeDelist: AssetInfoStructOutput;
    let wethPriceBeforeDelist: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);

      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      compInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      wethPriceBeforeDelist = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, COMP alone could not back the debt but COMP plus WETH could', () => {
      const debtValue = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const compCollateralValueBeforeDelist = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfoBeforeDelist.scale);
      const wethCollateralValueBeforeDelist = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfoBeforeDelist.scale);
      const compBorrowValueBeforeDelist = mulFactor(compCollateralValueBeforeDelist, compInfoBeforeDelist.borrowCollateralFactor);
      const wethBorrowValueBeforeDelist = mulFactor(wethCollateralValueBeforeDelist, wethInfoBeforeDelist.borrowCollateralFactor);
      const totalBorrowValueBeforeDelist = compBorrowValueBeforeDelist + wethBorrowValueBeforeDelist;

      expect(compBorrowValueBeforeDelist).to.be.lessThan(debtValue);
      expect(totalBorrowValueBeforeDelist).to.be.greaterThanOrEqual(debtValue);
    });

    it('alice is not borrow-collateralized after WETH is delisted because COMP cannot fully back the debt', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('alice is liquidatable because full-delisted WETH contributes no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates partial COMP seizure and leaves WETH untouched', async () => {
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      const totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor);
      const wantedCompCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt());

      collateralsState[collateralConfigs[0].symbol].seizeAmount = divPrice(wantedCompCollateralValue, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(wantedCompCollateralValue, compInfo.liquidationFactor);
    });

    // User base balances
    it('alice borrow balance equals the debt left after COMP reaches target health', async () => {
      const debtRemainingValueAfterSeize = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal matches the reduced debt', async () => {
      const debtRemainingValueAfterSeize = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const newBalance = -(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
      const totalsBasic = await comet.totalsBasic();
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    // User collateral state
    it('alice still holds COMP balance', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralConfigs[0].amount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('alice still holds the full WETH balance', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
    });

    it('assetIn list keeps both collaterals because neither was fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the repaid principal', async () => {
      const principalAfter = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore - principalAfter);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore
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

    it('comet COMP reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore
      );
    });

    it('comet base reserves are reduced by the repaid base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: normal COMP first, delisted WETH second, full debt close leaves both assets', function () {
    const droppedCompPrice = exp(80, 8); // COMP has enough liquidation value to close the debt, but not enough borrow power after WETH is delisted.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    },
      { symbol: 'WETH', amount: exp(0.04, 18) },
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let compInfoBeforeDelist: AssetInfoStructOutput;
    let wethInfoBeforeDelist: AssetInfoStructOutput;
    let wethPriceBeforeDelist: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);

      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      compInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      wethPriceBeforeDelist = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, COMP alone could not back the debt but COMP plus WETH could', () => {
      const debtValue = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const compCollateralValueBeforeDelist = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfoBeforeDelist.scale);
      const wethCollateralValueBeforeDelist = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfoBeforeDelist.scale);
      const compBorrowValueBeforeDelist = mulFactor(compCollateralValueBeforeDelist, compInfoBeforeDelist.borrowCollateralFactor);
      const wethBorrowValueBeforeDelist = mulFactor(wethCollateralValueBeforeDelist, wethInfoBeforeDelist.borrowCollateralFactor);
      const totalBorrowValueBeforeDelist = compBorrowValueBeforeDelist + wethBorrowValueBeforeDelist;

      expect(compBorrowValueBeforeDelist).to.be.lessThan(debtValue);
      expect(totalBorrowValueBeforeDelist).to.be.greaterThanOrEqual(debtValue);
    });

    it('alice is liquidatable after WETH is delisted', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates COMP debt closeout and leaves WETH untouched', async () => {
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const wantedCompCollateralValue = debtRemainingValue * factorScale / compInfo.liquidationFactor.toBigInt();

      collateralsState[collateralConfigs[0].symbol].seizeAmount = divPrice(wantedCompCollateralValue, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizedValue = debtRemainingValue;
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
    it('alice still holds COMP balance', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralConfigs[0].amount - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('alice still holds the full WETH balance', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(collateralConfigs[1].amount);
    });

    it('assetIn list keeps both collaterals because neither was fully seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore
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

    it('comet COMP reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves are unchanged', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: normal COMP first, delisted WETH second, bad debt with nothing remaining', function () {
    const droppedCompPrice = exp(60, 8); // COMP cannot cover the debt after WETH is delisted; WETH is removed without covering debt.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    },
      { symbol: 'WETH', amount: exp(0.04, 18) },
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let compInfoBeforeDelist: AssetInfoStructOutput;
    let wethInfoBeforeDelist: AssetInfoStructOutput;
    let wethPriceBeforeDelist: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);

      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      compInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      wethPriceBeforeDelist = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[1].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, COMP alone could not back the debt but COMP plus WETH could', () => {
      const debtValue = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const compCollateralValueBeforeDelist = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfoBeforeDelist.scale);
      const wethCollateralValueBeforeDelist = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfoBeforeDelist.scale);
      const compBorrowValueBeforeDelist = mulFactor(compCollateralValueBeforeDelist, compInfoBeforeDelist.borrowCollateralFactor);
      const wethBorrowValueBeforeDelist = mulFactor(wethCollateralValueBeforeDelist, wethInfoBeforeDelist.borrowCollateralFactor);
      const totalBorrowValueBeforeDelist = compBorrowValueBeforeDelist + wethBorrowValueBeforeDelist;

      expect(compBorrowValueBeforeDelist).to.be.lessThan(debtValue);
      expect(totalBorrowValueBeforeDelist).to.be.greaterThanOrEqual(debtValue);
    });

    it('alice is liquidatable after WETH is delisted', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates full COMP removal and full WETH removal with bad debt', async () => {
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);

      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
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
    });

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('assetIn list removes both fully seized collaterals', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(
        assetsInBefore & ~(1 << compInfo.offset) & ~(1 << wethInfo.offset)
      );
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the full collateral amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  /*//////////////////////////////////////////////////////////////
                         LF = 0 / FULL DELISTED
  //////////////////////////////////////////////////////////////*/

  context('1 collateral: LF-zero COMP absorb skips collateral and writes off debt', function () {
    const collateralKey = 'COMP';

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let assetInfoBeforeDelist: AssetInfoStructOutput;
    let collateralPriceBeforeDelist: bigint;

    before(async function() {
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      assetInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      collateralPriceBeforeDelist = (await priceFeeds[collateralKey].latestRoundData())[1].toBigInt();

      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.connect(governor).updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, COMP could cover alice debt by liquidation factor', () => {
      const debtValueBeforeDelist = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const collateralValueBeforeDelist = mulPrice(collateralAmount, collateralPriceBeforeDelist, assetInfoBeforeDelist.scale);
      const liquidationValueBeforeDelist = mulFactor(collateralValueBeforeDelist, assetInfoBeforeDelist.liquidationFactor);

      expect(liquidationValueBeforeDelist).to.be.greaterThanOrEqual(debtValueBeforeDelist);
    });

    it('alice is not borrow-collateralized after COMP LF is zeroed', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('alice is liquidatable because LF-zero COMP contributes no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
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
    it('alice COMP collateral balance is unchanged because LF-zero collateral is skipped', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(collateralAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount);
    });

    it('assetIn list is unchanged because COMP was not seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - basePaidOut);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralKey].totalsCollateralBefore
      );
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

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  context('2 collaterals: LF-zero COMP first, normal WETH second, partial WETH seizure', function () {
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)    },
      { symbol: 'WETH', amount: exp(0.04, 18) },
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;
    let borrowBalanceBeforeDelist: bigint;
    let compInfoBeforeDelist: AssetInfoStructOutput;
    let wethInfoBeforeDelist: AssetInfoStructOutput;
    let compPriceBeforeDelist: bigint;
    let wethPriceBeforeDelist: bigint;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);
      borrowBalanceBeforeDelist = (await comet.borrowBalanceOf(alice.address)).toBigInt();
      compInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfoBeforeDelist = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      compPriceBeforeDelist = (await priceFeeds[collateralConfigs[0].symbol].latestRoundData())[1].toBigInt();
      wethPriceBeforeDelist = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before delisting, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before delisting, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('sanity check: before delisting, WETH alone could not back the debt but COMP plus WETH could', () => {
      const debtValue = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const compCollateralValueBeforeDelist = mulPrice(collateralConfigs[0].amount, compPriceBeforeDelist, compInfoBeforeDelist.scale);
      const wethCollateralValueBeforeDelist = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfoBeforeDelist.scale);
      const compBorrowValueBeforeDelist = mulFactor(compCollateralValueBeforeDelist, compInfoBeforeDelist.borrowCollateralFactor);
      const wethBorrowValueBeforeDelist = mulFactor(wethCollateralValueBeforeDelist, wethInfoBeforeDelist.borrowCollateralFactor);
      const totalBorrowValueBeforeDelist = compBorrowValueBeforeDelist + wethBorrowValueBeforeDelist;

      expect(wethBorrowValueBeforeDelist).to.be.lessThan(debtValue);
      expect(totalBorrowValueBeforeDelist).to.be.greaterThanOrEqual(debtValue);
    });

    it('sanity check: before delisting, WETH alone could not keep alice above liquidation threshold', () => {
      const debtValue = mulPrice(borrowBalanceBeforeDelist, baseTokenPrice, baseScale);
      const wethCollateralValueBeforeDelist = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfoBeforeDelist.scale);
      const wethLiquidationValueBeforeDelist = mulFactor(wethCollateralValueBeforeDelist, wethInfoBeforeDelist.liquidateCollateralFactor);

      expect(wethLiquidationValueBeforeDelist).to.be.lessThan(debtValue);
    });

    it('alice is not borrow-collateralized after COMP LF is zeroed because WETH cannot fully back the debt', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('alice is liquidatable because LF-zero COMP contributes no liquidation value', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates skipped COMP and partial WETH seizure', async () => {
      const debtRemainingValue = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPriceBeforeDelist, wethInfo.scale);
      const totalCollateralizedValue = mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);
      const wantedWethCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPriceBeforeDelist, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
    });

    // User base balances
    it('alice borrow balance equals the debt left after WETH reaches target health', async () => {
      const debtRemainingValueAfterSeize = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[1].symbol].seizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal matches the reduced debt', async () => {
      const debtRemainingValueAfterSeize = mulPrice(-balanceBefore, baseTokenPrice, baseScale) - collateralsState[collateralConfigs[1].symbol].seizedValue;
      const newBalance = -(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
      const totalsBasic = await comet.totalsBasic();
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    // User collateral state
    it('alice COMP collateral balance is unchanged because LF-zero collateral is skipped', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(collateralConfigs[0].amount);
    });

    it('alice still holds WETH balance', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by the repaid principal', async () => {
      const principalAfter = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore - principalAfter);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is unchanged', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect(await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the repaid base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 2);
    });
  });

  /*//////////////////////////////////////////////////////////////
                          DEACTIVATED ASSET
  //////////////////////////////////////////////////////////////*/

  // Deactivating a collateral keeps its factors intact but blocks all borrow-side actions:
  // isBorrowCollateralized reverts TokenIsDeactivated while the borrower still holds it. isLiquidatable
  // ignores deactivation, and absorb can still seize the deactivated asset. With COMP's BCF intact,
  // the default (partial) liquidation restores target health and leaves the borrower with debt.
  context('deactivated collateral: one asset, partial liquidation', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — still above the liquidation threshold post-deactivation
    const collateralKey = 'COMP';
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      // Capture the health flags while COMP is still an active collateral (price $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual for the test and rewire a fresh liquidation module.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      // Governance deactivates COMP (its factors stay normal); COMP then declines to $83.
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralKey].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized still reverts because deactivated COMP remains after the partial seizure', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralKey].address);
    });

    it('calculates seize amount and seized value for the partial liquidation', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const totalsBasic = await comet.totalsBasic();

      // Re-derive the exact debt the absorb repaid (pre-absorb principal at the post-absorb indices).
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      // Deactivation is ignored by the liquidation path, so COMP still contributes its BCF-weighted value.
      const totalCollateralizedValue = mulFactor(mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale), assetInfo.borrowCollateralFactor);

      // Solve targetHF = (totalCollateralValue - S * BCF) / (debt - S * LF) for the seized value S:
      //   S = (targetHF * debt - totalCollateralValue) / (targetHF * LF - BCF)
      const wantedCollateralValue = (mulFactor(debtRemainingValue, targetHealthFactor) - totalCollateralizedValue) * factorScale
        / (mulFactor(assetInfo.liquidationFactor, targetHealthFactor) - assetInfo.borrowCollateralFactor.toBigInt());

      collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, assetInfo.scale);
      collateralsState[collateralKey].seizedValue = mulFactor(wantedCollateralValue, assetInfo.liquidationFactor);
    });

    // User base balances
    it('alice borrow balance equals the debt left after the seized value', async () => {
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValueAfterSeize = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale)
        - collateralsState[collateralKey].seizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal matches the reduced debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValueAfterSeize = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale)
        - collateralsState[collateralKey].seizedValue;
      const newBalance = -(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    // User collateral state
    it('alice COMP collateral balance is reduced by the seized amount and some COMP remains', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(
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
    it('comet total borrow base is reduced by the repaid principal', async () => {
      const principalAfter = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore - principalAfter);
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

    it('comet base reserves are reduced by the repaid base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  // Close-debt mode (partial liquidation disabled): with the debt still below the full COMP value,
  // absorb seizes only enough COMP to repay the whole debt, leaving the deactivated COMP behind. Once
  // the debt is gone, isBorrowCollateralized short-circuits (principal >= 0) and no longer reverts.
  context('deactivated collateral: one asset, full debt close', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — still above the liquidation threshold post-deactivation
    const collateralKey = 'COMP';
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      // Capture the health flags while COMP is still an active collateral (price $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual, rewire a fresh liquidation module, and disable partial liquidation.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      // Governance deactivates COMP (its factors stay normal); COMP then declines to $83.
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralKey].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized returns true once the debt is fully repaid', async () => {
      // With no debt the check short-circuits before ever inspecting the (still deactivated) COMP.
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('calculates seize amount and seized value for the debt closeout', async () => {
      const assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      const totalsBasic = await comet.totalsBasic();

      // The absorb accrued interest in its own block, so re-derive the exact debt it repaid from the
      // pre-absorb principal valued at the post-absorb indices. Close-debt mode then seizes only enough
      // COMP to repay the whole debt (debt < full COMP value): seizeAmount = (debt / LF) / price.
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      const adjustedDebtValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState[collateralKey].seizeAmount = divPrice(adjustedDebtValue, droppedCompPrice, assetInfo.scale);
      collateralsState[collateralKey].seizedValue = debtRemainingValue;
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
    it('alice COMP collateral balance is reduced by the seized amount and some COMP remains', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(
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
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
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
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  // Close-debt mode where the debt has grown past the full COMP value: COMP is fully seized and the
  // residual debt is written off as bad debt. With no COMP left and no debt, isBorrowCollateralized
  // returns true again.
  context('deactivated collateral: one asset, full debt close with bad debt', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — still above the liquidation threshold post-deactivation
    const collateralKey = 'COMP';
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let reservedBefore: number;
    let principalBefore: bigint;
    let assetInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      // Capture the health flags while COMP is still an active collateral (price $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual, rewire a fresh liquidation module, and disable partial liquidation.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      // Governance deactivates COMP (its factors stay normal); COMP then declines to $83.
      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(assetInfo.offset);
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralKey].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes until the debt exceeds the full COMP value', async () => {
      // Grow the debt past COMP's full liquidation value so COMP alone cannot cover it.
      const collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      const fullSeizureValue = mulFactor(collateralValue, assetInfo.liquidationFactor);

      while (mulPrice((await comet.borrowBalanceOf(alice.address)).toBigInt(), baseTokenPrice, baseScale) <= fullSeizureValue) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized returns true because COMP was fully seized and the debt is gone', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('calculates the full COMP seizure', () => {
      // The debt exceeds the full COMP value, so the whole balance is seized and the residual is bad debt.
      collateralsState[collateralKey].seizeAmount = collateralAmount;
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
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(0n);
    });

    it('asset is removed from the assetIn list because all COMP was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
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
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  // Two collaterals: COMP (index 0) deactivated, WETH (index 1) normal. COMP keeps its factors, so the
  // default (partial) liquidation fully seizes COMP first, then partially seizes WETH to restore target
  // health while leaving debt. Once COMP is gone, borrow-collateralized checks no longer hit the
  // deactivated collateral.
  context('deactivated collateral: 2 collaterals, deactivated COMP first, normal WETH second, partial liquidation', function () {
    const droppedCompPrice = exp(75, 8); // COMP declines to $75 — still above the liquidation threshold post-deactivation
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)     }, // 1 COMP, deactivated (factors stay normal)
      { symbol: 'WETH', amount: exp(0.005, 18) }, // 0.005 WETH, worth $10, normal
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while both collaterals are active (COMP $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual for the test and rewire a fresh liquidation module.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      // Governance deactivates COMP (its factors stay normal); COMP then declines to $83.
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[0].symbol].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes until COMP alone cannot restore target health', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      const totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor)
        + mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);
      const fullCompTargetHealthValue = totalCollateralizedValue
        + compCollateralValue * (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt()) / factorScale;

      while (mulFactor(mulPrice((await comet.borrowBalanceOf(alice.address)).toBigInt(), baseTokenPrice, baseScale), targetHealthFactor) <= fullCompTargetHealthValue) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized returns true because the deactivated COMP was fully seized', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('calculates full COMP seizure and partial WETH seizure for the partial liquidation', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const totalsBasic = await comet.totalsBasic();

      // Deactivation is ignored by absorb, so both collaterals still count toward the BCF-weighted value.
      // Re-derive the exact debt the absorb repaid (pre-absorb principal at the post-absorb indices).
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      const totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor)
        + mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      // COMP alone cannot restore target health after the extra accrual, so it is fully seized first.
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      // WETH then restores target health:
      //   S = (targetHF * remainingDebt - remainingCollateralValue) / (targetHF * LF - BCF)
      const debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const totalCollateralizedValueAfterCompSeize = totalCollateralizedValue
        - mulFactor(compCollateralValue, compInfo.borrowCollateralFactor);
      const wantedWethCollateralValue = (mulFactor(debtRemainingValueAfterCompSeize, targetHealthFactor) - totalCollateralizedValueAfterCompSeize) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
    });

    // User base balances
    it('alice borrow balance equals the debt left after the seized value', async () => {
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValueAfterSeize = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale)
        - collateralsState[collateralConfigs[0].symbol].seizedValue
        - collateralsState[collateralConfigs[1].symbol].seizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal matches the reduced debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValueAfterSeize = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale)
        - collateralsState[collateralConfigs[0].symbol].seizedValue
        - collateralsState[collateralConfigs[1].symbol].seizedValue;
      const newBalance = -(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice WETH collateral balance is reduced by the seized amount and some WETH remains', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by the repaid principal', async () => {
      const principalAfter = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore - principalAfter);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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

    it('comet COMP reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the repaid base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  // Close-debt mode: the debt has grown past the full COMP value, so absorb fully seizes the deactivated
  // COMP, then WETH closes the remaining debt (partial WETH seizure) — leaving WETH behind. With the debt
  // gone, isBorrowCollateralized short-circuits and returns true.
  context('deactivated collateral: 2 collaterals, deactivated COMP first, normal WETH second, full debt close', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — still above the liquidation threshold post-deactivation
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)     }, // 1 COMP, deactivated (factors stay normal)
      { symbol: 'WETH', amount: exp(0.005, 18) }, // 0.005 WETH, worth $10, normal
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while both collaterals are active (COMP $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual, rewire a fresh liquidation module, and disable partial liquidation.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      // Governance deactivates COMP (its factors stay normal); COMP then declines to $83.
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[0].symbol].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized returns true once the debt is fully repaid', async () => {
      // No debt: the check short-circuits before inspecting the (still deactivated, but seized) COMP.
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('calculates COMP full seizure and the WETH closeout that repays the remaining debt', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // Re-derive the exact debt the absorb repaid (pre-absorb principal at the post-absorb indices);
      // COMP is fully seized first (the debt exceeds the full COMP value), repaying compValue * LF.
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      // WETH closes the remaining debt through the close-debt branch: seizeAmount = (remaining / LF) / price.
      const debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const wantedWethCollateralValue = debtRemainingValueAfterCompSeize * factorScale / wethInfo.liquidationFactor.toBigInt();
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValueAfterCompSeize;
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

    it('alice WETH collateral balance is reduced by the seized amount and some WETH remains', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  // Close-debt mode where the debt has grown past the combined COMP + WETH value: both collaterals are
  // fully seized and the residual debt is written off as bad debt. With no collateral and no debt,
  // isBorrowCollateralized returns true again.
  context('deactivated collateral: 2 collaterals, deactivated COMP first, normal WETH second, full debt close with bad debt', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — still above the liquidation threshold post-deactivation
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)     }, // 1 COMP, deactivated (factors stay normal)
      { symbol: 'WETH', amount: exp(0.005, 18) }, // 0.005 WETH, worth $10, normal
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while both collaterals are active (COMP $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual, rewire a fresh liquidation module, and disable partial liquidation.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      // Governance deactivates COMP (its factors stay normal); COMP then declines to $83.
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[0].symbol].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes until the debt exceeds the combined COMP and WETH value', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const compValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      const wethValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      const fullSeizureValue = mulFactor(compValue, compInfo.liquidationFactor) + mulFactor(wethValue, wethInfo.liquidationFactor);

      while (mulPrice((await comet.borrowBalanceOf(alice.address)).toBigInt(), baseTokenPrice, baseScale) <= fullSeizureValue) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized returns true because both collaterals were seized and the debt is gone', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('calculates the full COMP and WETH seizure', () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
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

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(0n);
    });

    it('assetIn list removes both fully seized collaterals', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  // Two collaterals: COMP (index 0) normal, WETH (index 1) deactivated. The default (partial)
  // liquidation fully seizes COMP first, then partially seizes WETH to restore target health while
  // leaving debt. isBorrowCollateralized reverts throughout because some deactivated WETH remains.
  context('deactivated collateral: 2 collaterals, normal COMP first, deactivated WETH second, partial liquidation', function () {
    const droppedCompPrice = exp(75, 8); // COMP declines to $75 — still above the liquidation threshold post-deactivation
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)     }, // 1 COMP, normal
      { symbol: 'WETH', amount: exp(0.005, 18) }, // 0.005 WETH, worth $10, deactivated (factors stay normal)
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while both collaterals are active (COMP $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual for the test and rewire a fresh liquidation module.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      // Governance deactivates WETH (its factors stay normal); COMP then declines to $83.
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(wethInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because WETH is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[1].symbol].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes until COMP alone cannot restore target health', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      const totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor)
        + mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);
      const fullCompTargetHealthValue = totalCollateralizedValue
        + compCollateralValue * (mulFactor(compInfo.liquidationFactor, targetHealthFactor) - compInfo.borrowCollateralFactor.toBigInt()) / factorScale;
      let debt = mulPrice((await comet.borrowBalanceOf(alice.address)).toBigInt(), baseTokenPrice, baseScale);

      while (mulFactor(debt, targetHealthFactor) <= fullCompTargetHealthValue) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
        debt = mulPrice((await comet.borrowBalanceOf(alice.address)).toBigInt(), baseTokenPrice, baseScale);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized still reverts because deactivated WETH remains after the partial seizure', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[1].symbol].address);
    });

    it('calculates full COMP seizure and partial WETH seizure for the partial liquidation', async () => {
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const totalsBasic = await comet.totalsBasic();

      // Deactivation is ignored by absorb, so both collaterals still count toward the BCF-weighted value.
      // Re-derive the exact debt the absorb repaid (pre-absorb principal at the post-absorb indices).
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      const wethCollateralValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      const totalCollateralizedValue = mulFactor(compCollateralValue, compInfo.borrowCollateralFactor)
        + mulFactor(wethCollateralValue, wethInfo.borrowCollateralFactor);

      // COMP alone cannot restore target health after the extra accrual, so it is fully seized first.
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      // WETH then restores target health:
      //   S = (targetHF * remainingDebt - remainingCollateralValue) / (targetHF * LF - BCF)
      const debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const totalCollateralizedValueAfterCompSeize = totalCollateralizedValue
        - mulFactor(compCollateralValue, compInfo.borrowCollateralFactor);
      const wantedWethCollateralValue = (mulFactor(debtRemainingValueAfterCompSeize, targetHealthFactor) - totalCollateralizedValueAfterCompSeize) * factorScale
        / (mulFactor(wethInfo.liquidationFactor, targetHealthFactor) - wethInfo.borrowCollateralFactor.toBigInt());

      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = mulFactor(wantedWethCollateralValue, wethInfo.liquidationFactor);
    });

    // User base balances
    it('alice borrow balance equals the debt left after the seized value', async () => {
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValueAfterSeize = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale)
        - collateralsState[collateralConfigs[0].symbol].seizedValue
        - collateralsState[collateralConfigs[1].symbol].seizedValue;
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal matches the reduced debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValueAfterSeize = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale)
        - collateralsState[collateralConfigs[0].symbol].seizedValue
        - collateralsState[collateralConfigs[1].symbol].seizedValue;
      const newBalance = -(debtRemainingValueAfterSeize * baseScale / baseTokenPrice);
      const newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(newPrincipal);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[0].symbol].address)).balance).to.be.equal(0n);
    });

    it('alice WETH collateral balance is reduced by the seized amount and some WETH remains', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by the repaid principal', async () => {
      const principalAfter = (await comet.userBasic(alice.address)).principal.toBigInt();
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore - principalAfter);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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

    it('comet COMP reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the repaid base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  // Close-debt mode: the debt has grown past the full COMP value, so absorb fully seizes COMP, then the
  // deactivated WETH closes the remaining debt (partial WETH seizure) — leaving WETH behind. With the
  // debt gone, isBorrowCollateralized short-circuits and returns true.
  context('deactivated collateral: 2 collaterals, normal COMP first, deactivated WETH second, full debt close', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — still above the liquidation threshold post-deactivation
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)     }, // 1 COMP, normal
      { symbol: 'WETH', amount: exp(0.005, 18) }, // 0.005 WETH, worth $10, deactivated (factors stay normal)
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while both collaterals are active (COMP $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual, rewire a fresh liquidation module, and disable partial liquidation.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      // Governance deactivates WETH (its factors stay normal); COMP then declines to $83.
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(wethInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because WETH is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[1].symbol].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes and the borrow accrues interest', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice becomes liquidatable once the accrued debt exceeds the LCF-weighted collateral', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized returns true once the debt is fully repaid', async () => {
      // No debt: the check short-circuits before inspecting the (still deactivated) WETH.
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('calculates COMP full seizure and the WETH closeout that repays the remaining debt', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      const wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();

      // Re-derive the exact debt the absorb repaid (pre-absorb principal at the post-absorb indices);
      // COMP is fully seized first (the debt exceeds the full COMP value), repaying compValue * LF.
      const totalsBasic = await comet.totalsBasic();
      const debtRemainingValue = mulPrice(-presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), baseTokenPrice, baseScale);
      const compCollateralValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[0].symbol].seizedValue = mulFactor(compCollateralValue, compInfo.liquidationFactor);

      // WETH closes the remaining debt through the close-debt branch: seizeAmount = (remaining / LF) / price.
      const debtRemainingValueAfterCompSeize = debtRemainingValue - collateralsState[collateralConfigs[0].symbol].seizedValue;
      const wantedWethCollateralValue = debtRemainingValueAfterCompSeize * factorScale / wethInfo.liquidationFactor.toBigInt();
      collateralsState[collateralConfigs[1].symbol].seizeAmount = divPrice(wantedWethCollateralValue, wethPrice, wethInfo.scale);
      collateralsState[collateralConfigs[1].symbol].seizedValue = debtRemainingValueAfterCompSeize;
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

    it('alice WETH collateral balance is reduced by the seized amount and some WETH remains', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the seized amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  // Close-debt mode where the debt has grown past the combined COMP + WETH value: both collaterals are
  // fully seized and the residual debt is written off as bad debt. With no collateral and no debt,
  // isBorrowCollateralized returns true again.
  context('deactivated collateral: 2 collaterals, normal COMP first, deactivated WETH second, full debt close with bad debt', function () {
    const droppedCompPrice = exp(83, 8); // COMP declines to $83 — still above the liquidation threshold post-deactivation
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18); // Speeds up this scenario without changing the liquidation math under test.
    const collateralConfigs = [
      { symbol: 'COMP', amount: exp(1, 18)     }, // 1 COMP, normal
      { symbol: 'WETH', amount: exp(0.005, 18) }, // 0.005 WETH, worth $10, deactivated (factors stay normal)
    ];

    let collateralsState: Record<string, CollateralState>;
    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let reservedBefore: number;
    let principalBefore: bigint;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);

      // Capture the health flags while both collaterals are active (COMP $100).
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      // Accelerate borrow accrual, rewire a fresh liquidation module, and disable partial liquidation.
      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      // Governance deactivates WETH (its factors stay normal); COMP then declines to $83.
      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(wethInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized now reverts because WETH is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[1].symbol].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
    });

    it('time passes until the debt exceeds the combined COMP and WETH value', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const compValue = mulPrice(collateralConfigs[0].amount, droppedCompPrice, compInfo.scale);
      const wethValue = mulPrice(collateralConfigs[1].amount, wethPrice, wethInfo.scale);
      const fullSeizureValue = mulFactor(compValue, compInfo.liquidationFactor) + mulFactor(wethValue, wethInfo.liquidationFactor);

      while (mulPrice((await comet.borrowBalanceOf(alice.address)).toBigInt(), baseTokenPrice, baseScale) <= fullSeizureValue) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('alice is liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('isBorrowCollateralized returns true because both collaterals were seized and the debt is gone', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('calculates the full COMP and WETH seizure', () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
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

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
      expect((await comet.userCollateral(alice.address, tokens[collateralConfigs[1].symbol].address)).balance).to.be.equal(0n);
    });

    it('assetIn list removes both fully seized collaterals', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice\'s absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[0].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet total supplied WETH is reduced by the full collateral amount', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralConfigs[1].symbol].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].totalsCollateralBefore.toBigInt() - collateralsState[collateralConfigs[1].symbol].seizeAmount
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
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      // ±50 base units: present-value rounding plus absorb's transaction-block accrual.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  /*//////////////////////////////////////////////////////////////
                DEACTIVATED ASSET WITH DIFF COLL FACTORTS
  //////////////////////////////////////////////////////////////*/

  context('deactivated collateral: 1 collateral, BCF = 0, full debt close mode', function () {
    const collateralKey = 'COMP';
    const droppedCompPrice = exp(83, 8);
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18);

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let assetInfo: AssetInfoStructOutput;
    let collateralsState: Record<string, CollateralState>;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(assetInfo.offset);
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralKey].address);
    });

    it('alice is still not liquidatable right after deactivation', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('absorb reverts while alice is not liquidatable', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(newLiquidationModule, 'NotLiquidatable');
    });

    it('time passes until alice becomes liquidatable', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates the partial COMP seizure', async () => {
      const totalsBasic = await comet.totalsBasic();
      const basePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      const debtRemainingValue = mulPrice(basePaidOut, baseTokenPrice, baseScale);
      const wantedCollateralValue = debtRemainingValue * factorScale / assetInfo.liquidationFactor.toBigInt();
      collateralsState[collateralKey].seizeAmount = divPrice(wantedCollateralValue, droppedCompPrice, assetInfo.scale);
      collateralsState[collateralKey].seizedValue = debtRemainingValue;
    });

    it('emits AbsorbCollateral for COMP', async () => {
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address,
        alice.address,
        tokens[collateralKey].address,
        collateralsState[collateralKey].seizeAmount,
        mulPrice(collateralsState[collateralKey].seizeAmount, droppedCompPrice, assetInfo.scale)
      );
    });

    it('emits AbsorbDebt for the absorbed debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const basePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address,
        alice.address,
        basePaidOut,
        mulPrice(basePaidOut, baseTokenPrice, baseScale)
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is reduced by the seized amount and some COMP remains', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(
        collateralAmount - collateralsState[collateralKey].seizeAmount
      );
    });

    it('asset remains in the assetIn list because some COMP remains', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('isBorrowCollateralized returns true after debt close', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset).to.be.equal(
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

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  context('deactivated collateral: 1 collateral, LCF = 0, full debt close mode', function () {
    const collateralKey = 'COMP';
    const droppedCompPrice = exp(83, 8);
    const acceleratedBorrowRate = exp(0.25, 18);

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let assetInfo: AssetInfoStructOutput;
    let collateralsState: Record<string, CollateralState>;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(assetInfo.offset);
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralKey].address);
    });

    it('alice is liquidatable immediately because LCF is zero', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('emits AbsorbCollateral for COMP', async () => {
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address,
        alice.address,
        tokens[collateralKey].address,
        collateralAmount,
        0
      );
    });

    it('emits AbsorbDebt for the absorbed debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const basePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address,
        alice.address,
        basePaidOut,
        mulPrice(basePaidOut, baseTokenPrice, baseScale)
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
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

    it('asset is removed from the assetIn list because all COMP was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << assetInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('isBorrowCollateralized returns true after debt close', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset).to.be.equal(
        collateralsState[collateralKey].totalsCollateralBefore.toBigInt() - collateralAmount
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
        collateralsState[collateralKey].collateralReservesBefore.toBigInt() + collateralAmount
      );
    });

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  context('deactivated collateral: 1 collateral, BCF = 0, bad debt case', function () {
    const collateralKey = 'COMP';
    const droppedCompPrice = exp(20, 8);
    const acceleratedBorrowRate = exp(0.25, 18);

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let assetInfo: AssetInfoStructOutput;
    let collateralsState: Record<string, CollateralState>;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(assetInfo.offset);
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralKey].address);
    });

    it('alice is liquidatable after the COMP price drop', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates the full COMP seizure', async () => {
      const collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      collateralsState[collateralKey].seizeAmount = collateralAmount;
      collateralsState[collateralKey].seizedValue = mulFactor(collateralValue, assetInfo.liquidationFactor);
    });

    it('emits AbsorbCollateral for COMP', async () => {
      const collateralValue = mulPrice(collateralAmount, droppedCompPrice, assetInfo.scale);
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address,
        alice.address,
        tokens[collateralKey].address,
        collateralsState[collateralKey].seizeAmount,
        collateralValue
      );
    });

    it('emits AbsorbDebt for the absorbed debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const basePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address,
        alice.address,
        basePaidOut,
        mulPrice(basePaidOut, baseTokenPrice, baseScale)
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
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

    it('asset is removed from the assetIn list because all COMP was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << assetInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('isBorrowCollateralized returns true after debt close', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset).to.be.equal(
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

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  context('deactivated collateral: 1 collateral, LCF = 0, bad debt case', function () {
    const collateralKey = 'COMP';
    const droppedCompPrice = exp(20, 8);
    const acceleratedBorrowRate = exp(0.25, 18);

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let assetInfo: AssetInfoStructOutput;
    let collateralsState: Record<string, CollateralState>;
    let newLiquidationModule: LiquidationModule;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      assetInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(assetInfo.offset);
      await priceFeeds[collateralKey].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralKey].address);
    });

    it('alice is liquidatable after the COMP price drop', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, [collateralKey]);

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('isBorrowCollateralized returns true after debt close', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates the full COMP seizure', async () => {
      collateralsState[collateralKey].seizeAmount = collateralAmount;
    });

    it('emits AbsorbCollateral for COMP', async () => {
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address,
        alice.address,
        tokens[collateralKey].address,
        collateralsState[collateralKey].seizeAmount,
        0
      );
    });

    it('emits AbsorbDebt for the absorbed debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const expectedBasePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address,
        alice.address,
        expectedBasePaidOut,
        mulPrice(expectedBasePaidOut, baseTokenPrice, baseScale)
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
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

    it('asset is removed from the assetIn list because all COMP was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << assetInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized amount', async () => {
      expect((await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset).to.be.equal(
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

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  context('deactivated collateral: 2 collaterals, first collateral BCF = 0, full debt close mode', function () {
    const droppedCompPrice = exp(20, 8);
    const acceleratedBorrowRate = exp(0.25, 18);
    const collateralConfigs = [
      { symbol: 'COMP', amount: collateralAmount },
      { symbol: 'WETH', amount: exp(0.03, 18) },
    ];

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let collateralsState: Record<string, CollateralState>;
    let newLiquidationModule: LiquidationModule;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[0].symbol].address);
    });

    it('alice is liquidatable after the COMP price drop', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('isBorrowCollateralized returns true after debt close', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates the COMP and WETH seizure', async () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount
        - (await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).toBigInt();
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount
        - (await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).toBigInt();
    });

    it('emits AbsorbCollateral for COMP', async () => {
      const expectedCompCollateralValue = mulPrice(collateralsState[collateralConfigs[0].symbol].seizeAmount, droppedCompPrice, compInfo.scale);

      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, expectedCompCollateralValue
      );
    });

    it('emits AbsorbCollateral for WETH', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const expectedWethCollateralValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, wethPrice, wethInfo.scale);

      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, expectedWethCollateralValue
      );
    });

    it('emits AbsorbDebt for the absorbed debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const expectedBasePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, expectedBasePaidOut, mulPrice(expectedBasePaidOut, baseTokenPrice, baseScale)
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is reduced', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet COMP reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  context('deactivated collateral: 2 collaterals, first collateral LCF = 0, full debt close mode', function () {
    const droppedCompPrice = exp(20, 8);
    const FIVE_DAYS = 5 * 24 * 60 * 60;
    const acceleratedBorrowRate = exp(0.25, 18);
    const collateralConfigs = [
      { symbol: 'COMP', amount: collateralAmount },
      { symbol: 'WETH', amount: exp(0.05, 18) },
    ];

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let collateralsState: Record<string, CollateralState>;
    let newLiquidationModule: LiquidationModule;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
      await newLiquidationModule.connect(pauseGuardian).liquidationModeToggle(false);

      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[0].symbol].address);
    });

    it('time passes until alice becomes liquidatable', async () => {
      while (!(await comet.isLiquidatable(alice.address))) {
        await ethers.provider.send('evm_increaseTime', [FIVE_DAYS]);
        await ethers.provider.send('evm_mine', []);
        await comet.accrueAccount(alice.address);
      }
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('isBorrowCollateralized returns true after debt close', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates the COMP and WETH seizure', async () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount
        - (await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).toBigInt();
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount
        - (await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).toBigInt();
    });

    it('emits AbsorbCollateral for COMP with zero collateral value', async () => {
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, 0
      );
    });

    it('emits AbsorbCollateral for WETH', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const expectedWethCollateralValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, wethPrice, wethInfo.scale);

      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, expectedWethCollateralValue
      );
    });

    it('emits AbsorbDebt for the absorbed debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const expectedBasePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, expectedBasePaidOut, mulPrice(expectedBasePaidOut, baseTokenPrice, baseScale)
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is reduced', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(
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
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet COMP reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the seized amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  context('deactivated collateral: 2 collaterals, first collateral BCF = 0, bad debt case', function () {
    const droppedCompPrice = exp(20, 8);
    const acceleratedBorrowRate = exp(0.25, 18);
    const collateralConfigs = [
      { symbol: 'COMP', amount: collateralAmount },
      { symbol: 'WETH', amount: exp(0.005, 18) },
    ];

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let collateralsState: Record<string, CollateralState>;
    let newLiquidationModule: LiquidationModule;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[0].symbol].address);
    });

    it('alice is liquidatable after the COMP price drop', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates the full COMP and WETH seizure', async () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
    });

    it('emits AbsorbCollateral for COMP', async () => {
      const expectedCompCollateralValue = mulPrice(collateralsState[collateralConfigs[0].symbol].seizeAmount, droppedCompPrice, compInfo.scale);

      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, expectedCompCollateralValue
      );
    });

    it('emits AbsorbCollateral for WETH', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const expectedWethCollateralValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, wethPrice, wethInfo.scale);

      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, expectedWethCollateralValue
      );
    });

    it('emits AbsorbDebt for the absorbed debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const expectedBasePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, expectedBasePaidOut, mulPrice(expectedBasePaidOut, baseTokenPrice, baseScale)
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('assetIn list is cleared because all collateral was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset) & ~(1 << wethInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('isBorrowCollateralized returns true after debt close', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });

  context('deactivated collateral: 2 collaterals, first collateral LCF = 0, bad debt case', function () {
    const droppedCompPrice = exp(20, 8);
    const acceleratedBorrowRate = exp(0.25, 18);
    const collateralConfigs = [
      { symbol: 'COMP', amount: collateralAmount },
      { symbol: 'WETH', amount: exp(0.005, 18) },
    ];

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let assetsInBefore: number;
    let reservedBefore: number;
    let principalBefore: bigint;
    let collateralsState: Record<string, CollateralState>;
    let newLiquidationModule: LiquidationModule;
    let compInfo: AssetInfoStructOutput;
    let wethInfo: AssetInfoStructOutput;
    let borrowCollateralizedBefore: boolean;
    let liquidatableBefore: boolean;

    before(async function() {
      await comet.connect(alice).supply(tokens[collateralConfigs[1].symbol].address, collateralConfigs[1].amount);
      borrowCollateralizedBefore = await comet.isBorrowCollateralized(alice.address);
      liquidatableBefore = await comet.isLiquidatable(alice.address);

      await configurator.connect(governor).setBorrowPerYearInterestRateBase(cometProxyAddress, acceleratedBorrowRate);
      await configurator.connect(governor).updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      await configurator.connect(governor).updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralConfigs[0].symbol].address, 0);
      newLiquidationModule = await deployDefaultLiquidationModuleWithComet(liquidationModuleOpts, cometProxyAddress);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, newLiquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      compInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[0].symbol].address);
      wethInfo = await comet.getAssetInfoByAddress(tokens[collateralConfigs[1].symbol].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
      await priceFeeds[collateralConfigs[0].symbol].connect(alice).setRoundData(0, droppedCompPrice, 0, 0, 0);
      await comet.accrueAccount(alice.address);
    });

    after(async () => await snapshot.restore());

    it('sanity check: comet and the new liquidation module are in sync', async () => {
      expect(await comet.liquidationModule()).to.equal(newLiquidationModule.address);
      expect(await comet.assetList()).to.equal(await newLiquidationModule.assetList());
    });

    it('sanity check: before deactivation, alice was borrow-collateralized', () => {
      expect(borrowCollateralizedBefore).to.be.true;
    });

    it('sanity check: before deactivation, alice was not liquidatable', () => {
      expect(liquidatableBefore).to.be.false;
    });

    it('isBorrowCollateralized reverts because COMP is deactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated')
        .withArgs(tokens[collateralConfigs[0].symbol].address);
    });

    it('alice is liquidatable after the COMP price drop', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds', async () => {
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;
      principalBefore = userBasic.principal.toBigInt();
      collateralsState = await makeCollateralStates(comet, tokens, collateralConfigs.map(c => c.symbol));

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('calculates the full COMP and WETH seizure', async () => {
      collateralsState[collateralConfigs[0].symbol].seizeAmount = collateralConfigs[0].amount;
      collateralsState[collateralConfigs[1].symbol].seizeAmount = collateralConfigs[1].amount;
    });

    it('emits AbsorbCollateral for COMP with zero collateral value', async () => {
      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[0].symbol].address, collateralsState[collateralConfigs[0].symbol].seizeAmount, 0
      );
    });

    it('emits AbsorbCollateral for WETH', async () => {
      const wethPrice = (await priceFeeds[collateralConfigs[1].symbol].latestRoundData())[1].toBigInt();
      const expectedWethCollateralValue = mulPrice(collateralsState[collateralConfigs[1].symbol].seizeAmount, wethPrice, wethInfo.scale);

      await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralConfigs[1].symbol].address, collateralsState[collateralConfigs[1].symbol].seizeAmount, expectedWethCollateralValue
      );
    });

    it('emits AbsorbDebt for the absorbed debt', async () => {
      const totalsBasic = await comet.totalsBasic();
      const expectedBasePaidOut = -presentValue(principalBefore, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, expectedBasePaidOut, mulPrice(expectedBasePaidOut, baseTokenPrice, baseScale)
      );
    });

    // User base balances
    it('alice borrow balance is zero', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    });

    it('alice base balance is zero', async () => {
      expect(await comet.balanceOf(alice.address)).to.be.equal(0);
    });

    it('alice principal is zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    // User collateral state
    it('alice COMP collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[0].symbol].address)).to.be.equal(0);
    });

    it('alice WETH collateral balance is zero', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralConfigs[1].symbol].address)).to.be.equal(0);
    });

    it('assetIn list is cleared because all collateral was seized', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore & ~(1 << compInfo.offset) & ~(1 << wethInfo.offset));
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    it('isBorrowCollateralized returns true after debt close', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    // Comet borrow state
    it('comet total borrow base is reduced by alice absorbed borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore + principalBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet COMP reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[0].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[0].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[0].symbol].seizeAmount
      );
    });

    it('comet WETH reserves increase by the full collateral amount', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralConfigs[1].symbol].address)).toBigInt()).to.be.equal(
        collateralsState[collateralConfigs[1].symbol].collateralReservesBefore.toBigInt() + collateralsState[collateralConfigs[1].symbol].seizeAmount
      );
    });

    it('comet base reserves are reduced by alice absorbed borrow principal', async () => {
      const basePaidOut = -(await comet.borrowBalanceOf(alice.address)).toBigInt() - balanceBefore;
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - basePaidOut, 50);
    });
  });
});
