import { ethers, expect, exp, presentValue, mulPrice, default24Assets, makeConfigurator, deployDefaultLiquidationModuleWithComet, deployEmptyDexAdapter, seedMarketActivity, DeployLiquidationModuleOpts,
  CollateralState, makeCollateralStates } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, LiquidationModule, FaucetToken, PriceFeedWithRevert, PriceFeedWithRevert__factory, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';
import { SnapshotRestorer, takeSnapshot } from '../helpers/snapshot';

describe('collateral price oracle reverts across varying collateral factors during absorption', function() {
  // Protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  let configurator: Configurator;
  let cometProxyAdmin: CometProxyAdmin;
  let configuratorProxyAddress: string;
  let cometProxyAddress: string;
  let liquidationModule: LiquidationModule;
  let updateOpts: { multisig: string, executors: string[], pausers: string[], dexAdapter: string };

  const baseTokenPrice = exp(1, 8);
  const initialBaseFunding = baseTokenPrice * 10_000n;
  const collateralAmount = exp(1, 18); // 1 COMP, $100 at initial price (BCF=0.8 → $80 borrow power)
  const borrowAmount = exp(70, 6); // $70 USDC, within the $80 borrow limit

  // Assets
  let tokens: { [symbol: string]: FaucetToken } = {};
  let baseToken: FaucetToken;
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};
  let priceFeedWithRevert: PriceFeedWithRevert;

  let pauseGuardian: SignerWithAddress;
  let alice: SignerWithAddress;
  let absorber: SignerWithAddress;
  let governor: SignerWithAddress;

  // Math
  const baseScale: bigint = 10n ** 6n;

  let snapshot: SnapshotRestorer;

  before(async function() {
    const protocol = await makeConfigurator({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        ...default24Assets(),
      },
      baseTrackingBorrowSpeed: 0,
      skipInitStorage: true,
    });
    configuratorProxyAddress = protocol.configuratorProxy.address;
    cometProxyAddress = protocol.cometProxy.address;
    configurator = protocol.configurator.attach(configuratorProxyAddress);
    comet = protocol.comet.attach(cometProxyAddress);
    cometProxyAdmin = protocol.proxyAdmin;

    for (let asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      tokens[asset] = protocol.tokens[asset] as FaucetToken;
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    baseToken = protocol.tokens['USDC'] as FaucetToken;
    priceFeeds['USDC'] = protocol.priceFeeds['USDC'];

    pauseGuardian = protocol.pauseGuardian;
    governor = protocol.governor;
    [alice, absorber] = protocol.users;
    const [bob, dave] = protocol.users.slice(2);

    const allocateAmount = exp(1_000_000, 18);
    for (const token of Object.values(protocol.tokens)) {
      await (token as FaucetToken).allocateTo(alice.address, allocateAmount);
      await (token as FaucetToken).connect(alice).approve(comet.address, ethers.constants.MaxUint256);
    }

    await seedMarketActivity(comet, tokens, priceFeeds, bob, dave, baseToken,  initialBaseFunding );

    // Deploy the reverting oracle once; each context wires it to COMP in its own before block
    // (right before deployAndUpgradeTo) so the pre-update liquidity checks still see a working oracle.
    const PriceFeedWithRevert = await ethers.getContractFactory('PriceFeedWithRevert') as PriceFeedWithRevert__factory;
    priceFeedWithRevert = await PriceFeedWithRevert.deploy();

    await comet.connect(alice).supply(tokens['COMP'].address, collateralAmount);
    await comet.connect(alice).withdraw(baseToken.address, borrowAmount);

    // A fresh adapter is required because the module's initiateModule calls dexAdapter.initiateAdapter,
    // even though the DEX route itself is never exercised here.
    const updateDexAdapter = await deployEmptyDexAdapter(Object.values(tokens).map(t => t.address));
    updateOpts = {
      multisig: protocol.multisig.address,
      executors: protocol.executors.map(e => e.address),
      pausers: protocol.pausers.map(p => p.address),
      dexAdapter: updateDexAdapter.address
    } as DeployLiquidationModuleOpts;

    snapshot = await takeSnapshot();
  });

  /*//////////////////////////////////////////////////////////////
                           COLLATERAL FACTORS
  //////////////////////////////////////////////////////////////*/

  // Baseline: the reverting oracle is wired to COMP with NO factor changes (BCF 0.8, LCF 0.85, LF 0.9
  // all default). Every path that reads the COMP price reverts — the raw price fetch,
  // isBorrowCollateralized, isLiquidatable, and absorb. The factor-flip contexts below start from here.
  context('oracle reverts with default factors, absorb reverts', function() {
    const collateralKey = 'COMP';

    before(async function() {
      // Wire the reverting oracle to COMP and upgrade with all factors at defaults; no factor changes.
      await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(updateOpts, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: fetching the COMP price from the reverting oracle reverts', async () => {
      await expect(comet.getPrice(priceFeedWithRevert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('isBorrowCollateralized reverts because BCF > 0 calls the reverting oracle', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('isLiquidatable reverts because LCF > 0 calls the reverting oracle', async () => {
      await expect(comet.isLiquidatable(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('absorb reverts because the liquidation path calls the reverting oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });
  });

  // With the reverting oracle live and all factors at their defaults, every COMP price path
  // reverts: the raw price fetch, isBorrowCollateralized, isLiquidatable, and absorb. Flipping
  // BCF to 0 shields only the borrow-collateralization check from the oracle; the liquidation
  // path still needs it (LCF > 0), so absorb remains blocked.
  context('oracle reverts and absorb reverting, setting BCF to 0 does not prevent absorb from reverting', function() {
    const collateralKey = 'COMP';

    before(async function() {
      // Wire the reverting oracle to COMP and upgrade with all factors still at defaults (BCF 0.8, LCF 0.85, LF 0.9).
      await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(updateOpts, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    // Sanity: the oracle and every liquidity check that depends on it revert while BCF > 0.
    it('sanity check: fetching the COMP price from the reverting oracle reverts', async () => {
      await expect(comet.getPrice(priceFeedWithRevert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: isBorrowCollateralized reverts because default BCF > 0 calls the reverting oracle', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: isLiquidatable reverts because default LCF > 0 calls the reverting oracle', async () => {
      await expect(comet.isLiquidatable(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: absorb reverts while BCF > 0 because the liquidation path calls the reverting oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('governance sets COMP BCF to 0', async () => {
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      // Each upgrade needs a fresh module and its own fresh dex adapter: the comet constructor calls
      // module.setAssetList and the module constructor calls dexAdapter.initiateAdapter — both are
      // one-time and revert with AlreadySet on the instances the first upgrade already wired.
      const nextDexAdapter = await deployEmptyDexAdapter(Object.values(tokens).map(t => t.address));
      liquidationModule = await deployDefaultLiquidationModuleWithComet({ ...updateOpts, dexAdapter: nextDexAdapter.address }, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    it('isBorrowCollateralized returns false without reverting once BCF = 0 skips the oracle', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('isLiquidatable still reverts after BCF = 0 because LCF > 0 keeps calling the oracle', async () => {
      await expect(comet.isLiquidatable(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('absorb still reverts after BCF = 0 because the liquidation path remains on the reverting oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });
  });

  // Continuing from BCF = 0 (where absorb still reverts on the LCF path), flipping LCF to 0 removes
  // the oracle from the liquidation check entirely: isLiquidatable stops reverting and absorb
  // succeeds. All collateral is seized at price 0 and the remaining debt is written off as bad debt.
  context('oracle reverts and absorb reverting, setting BCF and LCF to 0 stops absorb from reverting and seizes collateral', function() {
    const collateralKey = 'COMP';

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let collateralState: CollateralState;
    let reservedBefore: number;

    before(async function() {
      // Reverting oracle live with BCF = 0 (LCF 0.85, LF 0.9 still default): the borrow check skips
      // the oracle, but the liquidation path still calls it, so isLiquidatable and absorb revert.
      await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(updateOpts, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: fetching the COMP price from the reverting oracle reverts', async () => {
      await expect(comet.getPrice(priceFeedWithRevert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('isBorrowCollateralized returns false because BCF = 0 zeros COMP borrow power and skips the oracle', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('isLiquidatable reverts while LCF > 0 because the liquidation path calls the reverting oracle', async () => {
      await expect(comet.isLiquidatable(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('absorb reverts while LCF > 0 because the liquidation path calls the reverting oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('governance sets COMP LCF to 0', async () => {
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      const nextDexAdapter = await deployEmptyDexAdapter(Object.values(tokens).map(t => t.address));
      liquidationModule = await deployDefaultLiquidationModuleWithComet({ ...updateOpts, dexAdapter: nextDexAdapter.address }, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    it('isLiquidatable returns true once LCF = 0 skips the oracle and leaves the $70 debt uncovered', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds once LCF = 0 removes the oracle from the liquidation path', async () => {
      // Capture pre-absorb state now (after the LCF flip, immediately before the action) so the
      // frozen base index used for basePaidOut matches the balances the absorb settles against.
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = -presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralState = (await makeCollateralStates(comet, tokens, [collateralKey]))[collateralKey];
      reservedBefore = userBasic._reserved;

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates the COMP seizure values when LCF zero skips the oracle fetch', async () => {
      // seizedValue = wantedCollateralValue * LF = 0 regardless of LF being positive.
      collateralState.seizeAmount = collateralAmount;
    });

    it('AbsorbCollateral seizes all COMP at value 0 because the price was never fetched', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralKey].address, collateralState.seizeAmount, collateralState.seizedValue
      );
    });

    it('AbsorbDebt writes off the full debt as bad debt', async () => {
      const valueOfBasePaidOut = mulPrice(balanceBefore, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, balanceBefore, valueOfBasePaidOut
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

    it('asset removed from the assetIn list of the user', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are zero', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
      expect(reservedBefore).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - balanceBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized collateral', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset.toBigInt();
      expect(totalSupplyAssetAfter).to.be.equal(collateralState.totalsCollateralBefore.toBigInt() - collateralState.seizeAmount);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralState.tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the seized collateral', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralKey].address)).toBigInt()).to.be.equal(
        collateralState.collateralReservesBefore.toBigInt() + collateralState.seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - balanceBefore, 2);
    });
  });

  // Continuing from BCF = 0, LCF = 0 (where absorb succeeds and seizes the collateral), flipping LF
  // to 0 makes the seizure loop skip COMP entirely: absorb still writes off the debt as bad debt,
  // but the collateral stays with the borrower, making the asset effectively non-liquidatable.
  context('oracle reverts and absorb reverting, setting BCF, LCF and LF to 0 stops absorb from reverting but skips collateral seizure', function() {
    const collateralKey = 'COMP';

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let collateralState: CollateralState;
    let assetsInBefore: number;
    let reservedBefore: number;

    before(async function() {
      // Reverting oracle live with BCF = 0 and LCF = 0 (LF 0.9 still default): both liquidity checks
      // skip the oracle, so absorb already succeeds and would seize COMP. LF is flipped to 0 below.
      await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(updateOpts, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: fetching the COMP price from the reverting oracle reverts', async () => {
      await expect(comet.getPrice(priceFeedWithRevert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('isBorrowCollateralized returns false because BCF = 0 zeros COMP borrow power and skips the oracle', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });

    it('isLiquidatable returns true because LCF = 0 skips the oracle and leaves the $70 debt uncovered', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('governance sets COMP LF to 0', async () => {
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      const nextDexAdapter = await deployEmptyDexAdapter(Object.values(tokens).map(t => t.address));
      liquidationModule = await deployDefaultLiquidationModuleWithComet({ ...updateOpts, dexAdapter: nextDexAdapter.address }, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    it('absorb succeeds while LF = 0 makes the seizure loop skip COMP', async () => {
      // Capture pre-absorb state now (after the LF flip, immediately before the action) so the
      // frozen base index used for basePaidOut matches the balances the absorb settles against.
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralState = (await makeCollateralStates(comet, tokens, [collateralKey]))[collateralKey];
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('AbsorbCollateral is not emitted because LF = 0 skips the asset in the seizure loop', async () => {
      await expect(absorbTx).to.not.emit(comet, 'AbsorbCollateral');
    });

    it('AbsorbDebt writes off the full debt as bad debt', async () => {
      // LF = 0 causes the loop to skip COMP, so debtRemainingValue never decreases;
      // bad-debt branch zeroes newBalance, absorbing the entire debt from protocol reserves
      const valueOfBasePaidOut = mulPrice(-balanceBefore, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, -balanceBefore, valueOfBasePaidOut
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
    it('alice COMP collateral balance is unchanged because the asset was not seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(collateralAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('asset remains in the assetIn list of the user', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - -balanceBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is unchanged because LF = 0 skips collateral seizure', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralState.totalsCollateralBefore);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralState.tokenBalanceBefore);
    });

    it('comet COMP reserves are unchanged because LF = 0 skips collateral seizure', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralState.collateralReservesBefore);
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - -balanceBefore, 2);
    });
  });

  /*//////////////////////////////////////////////////////////////
                         DEACTIVATED COLLATERAL
  //////////////////////////////////////////////////////////////*/

  // Deactivation is checked in the borrow path (_getLiquidity(false)) before the oracle, so once COMP
  // is deactivated isBorrowCollateralized reverts with TokenIsDeactivated instead of the oracle error.
  // The liquidation path (module _getLiquidity(true)) never checks deactivation, so isLiquidatable and
  // absorb still revert on the oracle while LCF > 0 — deactivation alone does not unblock absorb.
  context('oracle reverts and absorb reverting, deactivating collateral does not prevent absorb from reverting', function() {
    const collateralKey = 'COMP';

    before(async function() {
      // Reverting oracle live with all factors at defaults; COMP is NOT deactivated yet.
      await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(updateOpts, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    after(async () => await snapshot.restore());

    it('sanity check: fetching the COMP price from the reverting oracle reverts', async () => {
      await expect(comet.getPrice(priceFeedWithRevert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: isBorrowCollateralized reverts on the oracle while BCF > 0 and COMP is active', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: isLiquidatable reverts on the oracle while LCF > 0', async () => {
      await expect(comet.isLiquidatable(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: absorb reverts on the oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('governance deactivates COMP', async () => {
      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
    });

    it('isBorrowCollateralized reverts with TokenIsDeactivated because the borrow path checks deactivation before the oracle', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(tokens[collateralKey].address);
    });

    it('isLiquidatable still reverts on the oracle because the liquidation path never checks deactivation', async () => {
      await expect(comet.isLiquidatable(alice.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('absorb still reverts on the oracle because deactivation does not unblock the liquidation path', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });
  });

  // Starting from deactivated COMP, flipping BCF to 0 does NOT unblock absorb: the borrow path still
  // reverts with TokenIsDeactivated (deactivation is checked before the BCF = 0 skip), and the
  // liquidation path still reverts on the oracle because LCF > 0. Absorb stays blocked.
  context('oracle reverts, collateral deactivated, setting BCF to 0 does not prevent absorb from reverting', function() {
    const collateralKey = 'COMP';

    before(async function() {
      // Reverting oracle live with default factors; COMP deactivated.
      await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(updateOpts, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
    });

    after(async () => await snapshot.restore());

    it('sanity check: fetching the COMP price from the reverting oracle reverts', async () => {
      await expect(comet.getPrice(priceFeedWithRevert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: isBorrowCollateralized reverts with TokenIsDeactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(tokens[collateralKey].address);
    });

    it('sanity check: absorb reverts on the oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('governance sets COMP BCF to 0', async () => {
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      const nextDexAdapter = await deployEmptyDexAdapter(Object.values(tokens).map(t => t.address));
      liquidationModule = await deployDefaultLiquidationModuleWithComet({ ...updateOpts, dexAdapter: nextDexAdapter.address }, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    it('isBorrowCollateralized still reverts with TokenIsDeactivated because deactivation is checked before the BCF = 0 skip', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(tokens[collateralKey].address);
    });

    it('absorb still reverts on the oracle because LCF > 0 keeps the liquidation path on the reverting oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });
  });

  // Starting from deactivated COMP, zeroing BOTH BCF and LCF removes the oracle from every path the
  // liquidation module touches: isLiquidatable stops reverting and absorb succeeds, even though COMP
  // stays deactivated (the liquidation path is intentionally deactivation-agnostic so borrowers can exit).
  context('oracle reverts, collateral deactivated, setting BCF and LCF to 0 stops absorb from reverting and seizes collateral', function() {
    const collateralKey = 'COMP';

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let collateralState: CollateralState;
    let reservedBefore: number;

    before(async function() {
      // Reverting oracle live with default factors; COMP deactivated.
      await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(updateOpts, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
    });

    after(async () => await snapshot.restore());

    it('sanity check: fetching the COMP price from the reverting oracle reverts', async () => {
      await expect(comet.getPrice(priceFeedWithRevert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: isBorrowCollateralized reverts with TokenIsDeactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(tokens[collateralKey].address);
    });

    it('sanity check: absorb reverts on the oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('governance sets COMP BCF and LCF to 0', async () => {
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      const nextDexAdapter = await deployEmptyDexAdapter(Object.values(tokens).map(t => t.address));
      liquidationModule = await deployDefaultLiquidationModuleWithComet({ ...updateOpts, dexAdapter: nextDexAdapter.address }, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    it('isBorrowCollateralized still reverts with TokenIsDeactivated because deactivation is checked before the BCF = 0 skip', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(tokens[collateralKey].address);
    });

    it('isLiquidatable returns true once LCF = 0 skips the oracle and leaves the $70 debt uncovered', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds once BCF = 0 and LCF = 0 remove the oracle from every liquidation path', async () => {
      // Capture pre-absorb state now (after the flip, immediately before the action) so the frozen
      // base index used for basePaidOut matches the balances the absorb settles against.
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = -presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralState = (await makeCollateralStates(comet, tokens, [collateralKey]))[collateralKey];
      reservedBefore = userBasic._reserved;

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('calculates the deactivated COMP seizure values when LCF zero skips the oracle fetch', async () => {
      // seizedValue = wantedCollateralValue * LF = 0 regardless of LF being positive.
      collateralState.seizeAmount = collateralAmount;
    });

    it('AbsorbCollateral seizes the deactivated COMP at value 0 because the price was never fetched', async () => {
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbCollateral').withArgs(
        absorber.address, alice.address, tokens[collateralKey].address, collateralState.seizeAmount, collateralState.seizedValue
      );
    });

    it('AbsorbDebt writes off the full debt as bad debt', async () => {
      const valueOfBasePaidOut = mulPrice(balanceBefore, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, balanceBefore, valueOfBasePaidOut
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

    it('asset removed from the assetIn list of the user', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
    });

    it('alice reserved bits are zero', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
      expect(reservedBefore).to.be.equal(0);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - balanceBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is reduced by the seized collateral', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset.toBigInt();
      expect(totalSupplyAssetAfter).to.be.equal(collateralState.totalsCollateralBefore.toBigInt() - collateralState.seizeAmount);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralState.tokenBalanceBefore);
    });

    it('comet COMP reserves increase by the seized collateral', async () => {
      expect((await comet.getCollateralReserves(tokens[collateralKey].address)).toBigInt()).to.be.equal(
        collateralState.collateralReservesBefore.toBigInt() + collateralState.seizeAmount
      );
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - balanceBefore, 2);
    });
  });

  // Starting from deactivated COMP, zeroing BCF, LCF and LF: absorb still succeeds (BCF = 0 and LCF = 0
  // skip the oracle) but LF = 0 makes the seizure loop skip COMP, so the debt is written off as bad
  // debt while the deactivated collateral stays with the borrower.
  context('oracle reverts, collateral deactivated, setting BCF, LCF and LF to 0 stops absorb from reverting but skips collateral seizure', function() {
    const collateralKey = 'COMP';

    let absorbTx: ContractTransaction;
    let balanceBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let baseReservesBefore: bigint;
    let cometBaseTokenBalanceBefore: bigint;
    let collateralState: CollateralState;
    let assetsInBefore: number;
    let reservedBefore: number;

    before(async function() {
      // Reverting oracle live with default factors; COMP deactivated.
      await configurator.updateAssetPriceFeed(cometProxyAddress, tokens[collateralKey].address, priceFeedWithRevert.address);
      liquidationModule = await deployDefaultLiquidationModuleWithComet(updateOpts, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);

      const compInfo = await comet.getAssetInfoByAddress(tokens[collateralKey].address);
      await comet.connect(pauseGuardian).deactivateCollateral(compInfo.offset);
    });

    after(async () => await snapshot.restore());

    it('sanity check: fetching the COMP price from the reverting oracle reverts', async () => {
      await expect(comet.getPrice(priceFeedWithRevert.address))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('sanity check: isBorrowCollateralized reverts with TokenIsDeactivated', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(tokens[collateralKey].address);
    });

    it('sanity check: absorb reverts on the oracle', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [alice.address]))
        .to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
    });

    it('governance sets COMP BCF, LCF and LF to 0', async () => {
      await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      await configurator.updateAssetLiquidationFactor(cometProxyAddress, tokens[collateralKey].address, 0);
      const nextDexAdapter = await deployEmptyDexAdapter(Object.values(tokens).map(t => t.address));
      liquidationModule = await deployDefaultLiquidationModuleWithComet({ ...updateOpts, dexAdapter: nextDexAdapter.address }, comet.address);
      await configurator.connect(governor).setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await cometProxyAdmin.connect(governor).deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress);
    });

    it('isBorrowCollateralized still reverts with TokenIsDeactivated because deactivation is checked before the BCF = 0 skip', async () => {
      await expect(comet.isBorrowCollateralized(alice.address))
        .to.be.revertedWithCustomError(comet, 'TokenIsDeactivated').withArgs(tokens[collateralKey].address);
    });

    it('isLiquidatable returns true once LCF = 0 skips the oracle and leaves the $70 debt uncovered', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('absorb succeeds while LF = 0 makes the seizure loop skip the deactivated COMP', async () => {
      // Capture pre-absorb state now (after the flip, immediately before the action) so the frozen
      // base index used for the absorbed amount matches the balances the absorb settles against.
      const userBasic = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();
      balanceBefore = -presentValue(userBasic.principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase.toBigInt();
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase.toBigInt();
      baseReservesBefore = (await comet.getReserves()).toBigInt();
      cometBaseTokenBalanceBefore = (await baseToken.balanceOf(comet.address)).toBigInt();
      collateralState = (await makeCollateralStates(comet, tokens, [collateralKey]))[collateralKey];
      assetsInBefore = userBasic.assetsIn;
      reservedBefore = userBasic._reserved;

      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.not.be.reverted;
    });

    it('AbsorbCollateral is not emitted because LF = 0 skips the asset in the seizure loop', async () => {
      await expect(absorbTx).to.not.emit(comet, 'AbsorbCollateral');
    });

    it('AbsorbDebt writes off the full debt as bad debt', async () => {
      // LF = 0 causes the loop to skip COMP, so debtRemainingValue never decreases;
      // bad-debt branch zeroes newBalance, absorbing the entire debt from protocol reserves
      const valueOfBasePaidOut = mulPrice(balanceBefore, baseTokenPrice, baseScale);
      await expect(absorbTx).to.emit(liquidationModule, 'AbsorbDebt').withArgs(
        absorber.address, alice.address, balanceBefore, valueOfBasePaidOut
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
    it('alice COMP collateral balance is unchanged because the asset was not seized', async () => {
      expect(await comet.collateralBalanceOf(alice.address, tokens[collateralKey].address)).to.be.equal(collateralAmount);
      expect((await comet.userCollateral(alice.address, tokens[collateralKey].address)).balance).to.be.equal(collateralAmount);
    });

    it('alice is no longer liquidatable after absorb', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('asset remains in the assetIn list of the user', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(assetsInBefore);
    });

    it('alice reserved bits are unchanged', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(reservedBefore);
    });

    // Comet borrow state
    it('comet total borrow base is reduced by the absorbed base amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore - balanceBefore);
    });

    it('comet total supply base is unchanged', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    // Comet collateral balances
    it('comet total supplied COMP is unchanged because LF = 0 skips collateral seizure', async () => {
      const totalSupplyAssetAfter = (await comet.totalsCollateral(tokens[collateralKey].address)).totalSupplyAsset;
      expect(totalSupplyAssetAfter).to.be.equal(collateralState.totalsCollateralBefore);
    });

    it('comet ERC20 base token balance is unchanged', async () => {
      expect(await baseToken.balanceOf(comet.address)).to.be.equal(cometBaseTokenBalanceBefore);
    });

    it('comet ERC20 COMP token balance is unchanged', async () => {
      expect(await tokens[collateralKey].balanceOf(comet.address)).to.be.equal(collateralState.tokenBalanceBefore);
    });

    it('comet COMP reserves are unchanged because LF = 0 skips collateral seizure', async () => {
      expect(await comet.getCollateralReserves(tokens[collateralKey].address)).to.be.equal(collateralState.collateralReservesBefore);
    });

    it('comet base reserves are reduced by the absorbed base amount', async () => {
      // ±2 base units: present-value rounding and interest accrued on the seeded positions between the reserves snapshot and this check.
      expect((await comet.getReserves()).toBigInt()).to.be.approximately(baseReservesBefore - balanceBefore, 2);
    });
  });
});
