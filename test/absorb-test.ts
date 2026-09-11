import { expect, exp, makeProtocol, mulPrice, mulFactor, divPrice, presentValue, principalValue, ZERO_ADDRESS, presentValueSupply, ethers, SnapshotRestorer, makeConfigurator, MAX_ASSETS, takeSnapshot } from './helpers';
import { CometExtAssetList, CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, CometWithExtendedAssetList, Configurator, ConfiguratorProxy, FaucetToken, NonStandardFaucetFeeToken, PriceFeedWithRevert, PriceFeedWithRevert__factory, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, ContractTransaction } from 'ethers';

/**
 * Absorb liquidation behavior tests
 * @notice Exercises the `absorb` liquidation flow of Comet with an extended asset list.
 * @dev Covers:
 * - Making a single borrower under-collateralized and absorbing a single collateral position.
 * - Absorbing a single borrower with multiple collateral assets and validating events, balances,
 *   reserves, `assetsIn` bitmasks, and asset lists.
 * - Absorbing multiple underwater borrowers in a single call and checking protocol accounting.
 * - Tracking liquidator points (`numAbsorbs`, `numAbsorbed`, `approxSpend`) including edge cases
 *   like empty account arrays.
 * - Revert paths for paused absorb, non-liquidatable accounts, and bad/deprecated price feeds.
 * - Sensitivity of post-absorb principal to different price drop magnitudes (borrower becomes
 *   lender vs principal zero) and behavior when absorbing across many (24) collateral assets.
 */
describe('abosorb', function () {
  // Constants
  const baseTokenDecimals = 6;
  const usdcPrice = exp(1, 8);
  const COLLATERAL_AMOUNT:bigint = exp(1, 18);
  const BORROW_AMOUNT:bigint = exp(80, baseTokenDecimals);
  const DAVE_BASE_SUPPLY_AMOUNT:bigint = exp(100, baseTokenDecimals);
  const LIQUIDATION_CF:bigint = exp(0.9, 18);
  const LIQUIDATION_FACTOR:bigint = exp(1, 18);
  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  // Assets
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};
  // Users
  let absorber: SignerWithAddress;
  let alice: SignerWithAddress;
  let dave: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let protocol: any; // Store protocol to access more users
  // Prices
  let compPrice = 100;
  let wethPrice = 4000;
  let wbtcPrice = 100000;
  // Values
  let baseScale: bigint;

  before(async () => {
    protocol = await makeProtocol(
      {
        base: 'USDC',
        assets: {
          USDC: { decimals: baseTokenDecimals, initialPrice: 1 },
          COMP: { decimals: 18, initialPrice: compPrice, borrowCF: exp(0.8, 18), liquidateCF: LIQUIDATION_CF },
          WETH: { decimals: 18, initialPrice: wethPrice, borrowCF: exp(0.8, 18), liquidateCF: LIQUIDATION_CF },
          WBTC: { decimals: 8, initialPrice: wbtcPrice, borrowCF: exp(0.8, 18), liquidateCF: LIQUIDATION_CF },
        }
      }
    );
    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens[protocol.base] as FaucetToken;
    for (let asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      collaterals[asset] = protocol.tokens[asset] as FaucetToken;
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    priceFeeds['USDC'] = protocol.priceFeeds['USDC'];

    [absorber, alice, dave] = protocol.users;
    pauseGuardian = protocol.pauseGuardian;
    await baseToken.allocateTo(dave.address, exp(1000, baseTokenDecimals));
    await collaterals['COMP'].allocateTo(alice.address, exp(100, 18));

    baseScale = (await comet.baseScale()).toBigInt();
  });

  describe('setup: alice becomes underwater', function () {
    it('dave supplies base token to allow borrowing', async () => {
      await baseToken.connect(dave).approve(comet.address, DAVE_BASE_SUPPLY_AMOUNT);
      await comet.connect(dave).supply(baseToken.address, DAVE_BASE_SUPPLY_AMOUNT);
    });

    it('alice supplies collateral and make borrow position', async () => {
      await collaterals['COMP'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT); // $100 worth
      await comet.connect(alice).supplyTo(alice.address, collaterals['COMP'].address, COLLATERAL_AMOUNT);

      await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);
    });

    it('alice becomes borrower', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.be.lessThan(0);
    });

    it('alice is collateralized enough', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('alice is not liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.false;
    });

    it('collateral price drops on 20%', async () => {
      compPrice = compPrice * 80 / 100;
      await priceFeeds['COMP'].setRoundData(0, exp(80, 8), 0, 0, 0);
    });

    it('alice becomes liquidatable', async () => {
      expect(await comet.isLiquidatable(alice.address)).to.be.true;
    });

    it('alice is not collateralized enough', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
    });
  });

  describe('absorbing single user with single collateral', function () {
    let totalsCollateralBefore: BigNumber;
    let absorbTx: ContractTransaction;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let collateralReservesBefore: BigNumber;
    let deltaValue: bigint;
    let oldBalance: bigint;
    let newBalance: bigint;

    before(async () => {
      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
    });

    it('alice collateral balance is equal to supplied amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, collaterals['COMP'].address);
      expect(collateralBalance).to.be.equal(COLLATERAL_AMOUNT);
    });

    it('aliceborrow balance is equal to borrowed amount', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(BORROW_AMOUNT);
    });

    it('alice assets in is equal to 1', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(1);
    });

    it('alice reserved is equal to 0', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    it('comet total supplied collateral amount is equal to alice supplied amount', async () => {
      totalsCollateralBefore = (await comet.totalsCollateral(collaterals['COMP'].address)).totalSupplyAsset;
      expect(totalsCollateralBefore).to.be.equal(COLLATERAL_AMOUNT);
    });

    it('comet total supply base is equal to dave supplied amount', async () => {
      totalSupplyBaseBefore = (await comet.totalsBasic()).totalSupplyBase;
      expect(totalSupplyBaseBefore).to.be.equal(DAVE_BASE_SUPPLY_AMOUNT);
    });

    it('comet total borrow base is equal to alice borrowed amount', async () => {
      totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBaseBefore).to.be.equal(BORROW_AMOUNT);
    });

    it('comet reserves are equal to zero', async () => {
      expect(await comet.getReserves()).to.be.equal(0);
    });

    it('collateral reserves are equal to zero', async () => {
      collateralReservesBefore = await comet.getCollateralReserves(collaterals['COMP'].address);
      expect(collateralReservesBefore).to.be.equal(0);
    });

    it('absorb is successful', async () => {
      // Perform absorb
      absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTx).to.be.not.be.reverted;
    });

    it('AbsorbCollateral is emmited with correct values', async () => {
      const compPrice = (await priceFeeds['COMP'].latestRoundData())[1];
      const value = mulPrice(COLLATERAL_AMOUNT, compPrice, exp(1, 18));
      deltaValue = mulFactor(value, LIQUIDATION_FACTOR);

      await expect(absorbTx)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, collaterals['COMP'].address, COLLATERAL_AMOUNT, value);
    });

    it('AbsorbDebt event is emmited', async () => {
      const deltaBalance = divPrice(deltaValue, usdcPrice, baseScale);
      newBalance = oldBalance + deltaBalance;

      const basePaidOut = newBalance - oldBalance;
      const valueOfBasePaidOut = mulPrice(basePaidOut, usdcPrice, baseScale);

      await expect(absorbTx).to.emit(comet, 'AbsorbDebt').withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('new balance is equal to 0', async () => {
      expect(newBalance).to.equal(0);
    });

    it('alice principal becomes 0', async () => {
      // new balance is less than 0, thus newBalance and principal becomes 0
      expect((await comet.userBasic(alice.address)).principal).to.be.equal(0);
    });

    it('Transfer event is not emitted when new principal is 0', async () => {
      await expect(absorbTx).to.not.emit(comet, 'Transfer');
    });

    it('alice collateral balance becomes 0', async () => {
      expect(await comet.collateralBalanceOf(alice.address, collaterals['COMP'].address)).to.be.equal(0);
    });

    it('comet collateral reserves are increased by absorb amount', async () => {
      expect(await comet.getCollateralReserves(collaterals['COMP'].address)).to.be.equal(collateralReservesBefore.add(COLLATERAL_AMOUNT));
    });

    it('comet total supply collateral is decreased by collateral amount', async () => {
      expect((await comet.totalsCollateral(collaterals['COMP'].address)).totalSupplyAsset).to.be.equal(totalsCollateralBefore.sub(COLLATERAL_AMOUNT));
    });

    it('resets assetsIn and reserved to 0', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    it('comet total supply base is not changed', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    it('comet total borrow base deacreased by borrow amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(totalBorrowBaseBefore.sub(BORROW_AMOUNT));
    });

    it('comet reserves becomes negative', async () => {
      // Reserves becomes negative as total balance is $20 and total supply is $100
      // total borrow becomes zero after absorb, thus reserves becomes $20 - $100 = -$80
      expect(await comet.getReserves()).to.be.equal(-exp(80, 6));
    });
  });

  describe('absorbing single user with multiple collaterals', function () {
    const COLLATERAL_AMOUNT_COMP: bigint = exp(1, 18); // $100 worth
    const COLLATERAL_AMOUNT_WETH: bigint = exp(0.05, 18); // $200 worth
    const COLLATERAL_AMOUNT_WBTC: bigint = exp(0.0005, 8); // $50 worth
    const BORROW_AMOUNT: bigint = exp(250, baseTokenDecimals);
    const DAVE_BASE_SUPPLY_AMOUNT: bigint = exp(500, baseTokenDecimals);

    let compTotalsBefore: BigNumber;
    let wethTotalsBefore: BigNumber;
    let wbtcTotalsBefore: BigNumber;
    let compReservesBefore: BigNumber;
    let wethReservesBefore: BigNumber;
    let wbtcReservesBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let absorbTxMulti: ContractTransaction;
    let oldBalanceMulti: bigint;
    let newAliceBalance: bigint;

    let baseSupplyIndexBefore: BigNumber;
    let baseBorrowIndexBefore: BigNumber;

    let newAlicePrincipal: bigint;

    let compValue: bigint;
    let wethValue: bigint;
    let wbtcValue: bigint;

    before(async () => {
      // Check alice's state before starting - should be clean after first test
      const aliceStateBefore = await comet.userBasic(alice.address);
      const totalsBasic = await comet.totalsBasic();

      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
      
      // Verify alice was properly reset after first absorb
      expect(aliceStateBefore.assetsIn).to.be.equal(0, 'alice assetsIn should be 0 after first test');
      expect(aliceStateBefore.principal).to.be.equal(0, 'alice principal should be 0 after first test');
      expect(aliceStateBefore._reserved).to.be.equal(0, 'alice _reserved should be 0 after first test');

      // Supply base so that borrowing is possible
      await baseToken.connect(dave).approve(comet.address, DAVE_BASE_SUPPLY_AMOUNT);
      await comet.connect(dave).supply(baseToken.address, DAVE_BASE_SUPPLY_AMOUNT);

      // Allocate COMP, WETH, and WBTC collateral to alice
      await collaterals['COMP'].allocateTo(alice.address, COLLATERAL_AMOUNT_COMP);
      await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_AMOUNT_WETH);
      await collaterals['WBTC'].allocateTo(alice.address, COLLATERAL_AMOUNT_WBTC);

      // Approve and supply all three collaterals
      await collaterals['COMP'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT_COMP);
      await collaterals['WETH'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT_WETH);
      await collaterals['WBTC'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT_WBTC);

      await comet.connect(alice).supplyTo(alice.address, collaterals['COMP'].address, COLLATERAL_AMOUNT_COMP);
      await comet.connect(alice).supplyTo(alice.address, collaterals['WETH'].address, COLLATERAL_AMOUNT_WETH);
      await comet.connect(alice).supplyTo(alice.address, collaterals['WBTC'].address, COLLATERAL_AMOUNT_WBTC);

      // Borrow against the collateral
      await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);

      // Initially alice should not be liquidatable
      expect(await comet.isLiquidatable(alice.address)).to.be.false;

      // Price drops on 20%
      compPrice = compPrice * 80 / 100;
      wethPrice = wethPrice * 80 / 100;
      wbtcPrice = wbtcPrice * 80 / 100;
      await priceFeeds['COMP'].setRoundData(0, exp(compPrice, 8), 0, 0, 0);
      await priceFeeds['WETH'].setRoundData(0, exp(wethPrice, 8), 0, 0, 0);
      await priceFeeds['WBTC'].setRoundData(0, exp(wbtcPrice, 8), 0, 0, 0);

      expect(await comet.isLiquidatable(alice.address)).to.be.true;

      // Snapshot protocol state before absorb
      const principal = (await comet.userBasic(alice.address)).principal;
      oldBalanceMulti = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

      compTotalsBefore = (await comet.totalsCollateral(collaterals['COMP'].address)).totalSupplyAsset;
      wethTotalsBefore = (await comet.totalsCollateral(collaterals['WETH'].address)).totalSupplyAsset;
      wbtcTotalsBefore = (await comet.totalsCollateral(collaterals['WBTC'].address)).totalSupplyAsset;
      compReservesBefore = await comet.getCollateralReserves(collaterals['COMP'].address);
      wethReservesBefore = await comet.getCollateralReserves(collaterals['WETH'].address);
      wbtcReservesBefore = await comet.getCollateralReserves(collaterals['WBTC'].address);
      
      baseSupplyIndexBefore = totalsBasic.baseSupplyIndex;
      baseBorrowIndexBefore = totalsBasic.baseBorrowIndex;
    });

    it('alice has COMP, WETH, and WBTC collateral supplied', async () => {
      expect(await comet.collateralBalanceOf(alice.address, collaterals['COMP'].address)).to.be.equal(COLLATERAL_AMOUNT_COMP);
      expect(await comet.collateralBalanceOf(alice.address, collaterals['WETH'].address)).to.be.equal(COLLATERAL_AMOUNT_WETH);
      expect(await comet.collateralBalanceOf(alice.address, collaterals['WBTC'].address)).to.be.equal(COLLATERAL_AMOUNT_WBTC);
    });

    it('alice borrow balance is equal to borrowed amount', async () => {
      expect(await comet.borrowBalanceOf(alice.address)).to.be.approximately(BORROW_AMOUNT, 1);
    });

    it('alice assetsIn bitmask reflects all three assets', async () => {
      // assetsIn is a bitmask, not a count
      // If COMP is at offset 0, WETH at offset 1, WBTC at offset 2:
      // Bit 0 (COMP) = 1
      // Bit 1 (WETH) = 2
      // Bit 2 (WBTC) = 4
      // Total = 1 + 2 + 4 = 7
      
      // First, let's check the actual asset offsets
      const numAssets = await comet.numAssets();
      let compOffset: number | null = null;
      let wethOffset: number | null = null;
      let wbtcOffset: number | null = null;
      
      for (let i = 0; i < numAssets; i++) {
        const info = await comet.getAssetInfo(i);
        if (info.asset.toLowerCase() === collaterals['COMP'].address.toLowerCase()) {
          compOffset = info.offset;
        } else if (info.asset.toLowerCase() === collaterals['WETH'].address.toLowerCase()) {
          wethOffset = info.offset;
        } else if (info.asset.toLowerCase() === collaterals['WBTC'].address.toLowerCase()) {
          wbtcOffset = info.offset;
        }
      }
      
      // Calculate expected bitmask value
      const expectedAssetsIn = (1 << compOffset!) | (1 << wethOffset!) | (1 << wbtcOffset!);
      
      // Verify the bitmask matches expected value
      const actualAssetsIn = (await comet.userBasic(alice.address)).assetsIn;
      expect(actualAssetsIn).to.be.equal(expectedAssetsIn);
    });

    it('alice reserved is equal to 0', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    it('alice asset list contains COMP, WETH, and WBTC', async () => {
      const assetList = await comet.getAssetList(alice.address);
      expect(assetList).to.include(collaterals['COMP'].address);
      expect(assetList).to.include(collaterals['WETH'].address);
      expect(assetList).to.include(collaterals['WBTC'].address);
      expect(assetList.length).to.be.equal(3);
    });

    it('comet total supplied collateral amounts are equal to alice supplied amounts', async () => {
      expect(compTotalsBefore).to.be.equal(COLLATERAL_AMOUNT_COMP);
      expect(wethTotalsBefore).to.be.equal(COLLATERAL_AMOUNT_WETH);
      expect(wbtcTotalsBefore).to.be.equal(COLLATERAL_AMOUNT_WBTC);
    });

    it('comet total supply base is equal to dave supplied amount', async () => {
      const expectedTotalSupply = totalSupplyBaseBefore.add(DAVE_BASE_SUPPLY_AMOUNT);
      totalSupplyBaseBefore = (await comet.totalsBasic()).totalSupplyBase;
      expect(totalSupplyBaseBefore).to.be.approximately(expectedTotalSupply, 2); // possible precision loss
    });

    it('comet total borrow base is equal to alice borrowed amount', async () => {
      const expectedTotalBorrow = totalBorrowBaseBefore.add(BORROW_AMOUNT);
      totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      expect(totalBorrowBaseBefore).to.be.approximately(expectedTotalBorrow, 2); // possible precision loss
    });

    it('collateral reserves are equal to zero', async () => {
      expect(compReservesBefore).to.be.equal(COLLATERAL_AMOUNT_COMP); // reserve is kept from single absorb test
      expect(wethReservesBefore).to.be.equal(0);
      expect(wbtcReservesBefore).to.be.equal(0);
    });

    it('absorb is successful', async () => {
      // Perform absorb
      absorbTxMulti = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
      await expect(absorbTxMulti).to.not.be.reverted;
    });

    it('AbsorbCollateral events are emitted for COMP, WETH, and WBTC', async () => {
      compValue = mulPrice(COLLATERAL_AMOUNT_COMP, exp(compPrice, 8), exp(1, 18));
      wethValue = mulPrice(COLLATERAL_AMOUNT_WETH, exp(wethPrice, 8), exp(1, 18));
      wbtcValue = mulPrice(COLLATERAL_AMOUNT_WBTC, exp(wbtcPrice, 8), exp(1, 8));

      await expect(absorbTxMulti)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, collaterals['COMP'].address, COLLATERAL_AMOUNT_COMP, compValue)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, collaterals['WETH'].address, COLLATERAL_AMOUNT_WETH, wethValue)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, collaterals['WBTC'].address, COLLATERAL_AMOUNT_WBTC, wbtcValue);
    });

    it('AbsorbDebt event is emitted', async () => {
      let deltaValue = mulFactor(compValue, LIQUIDATION_FACTOR);
      deltaValue += mulFactor(wethValue, LIQUIDATION_FACTOR);
      deltaValue += mulFactor(wbtcValue, LIQUIDATION_FACTOR);
      
      const deltaBalance = divPrice(deltaValue, usdcPrice, baseScale);
      newAliceBalance = oldBalanceMulti + deltaBalance;

      const basePaidOut = newAliceBalance - oldBalanceMulti;
      const valueOfBasePaidOut = mulPrice(basePaidOut, usdcPrice, baseScale);

      await expect(absorbTxMulti)
        .to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, alice.address, basePaidOut, valueOfBasePaidOut);
    });

    it('new alice balance is greater than 0', async () => {
      expect(newAliceBalance).to.be.greaterThan(0);
    });

    it('alice principal becomes > 0', async () => {
      newAlicePrincipal = await principalValue(newAliceBalance, baseSupplyIndexBefore, baseBorrowIndexBefore);
      expect(newAlicePrincipal).to.be.greaterThan(0);
      expect((await comet.userBasic(alice.address)).principal).to.be.approximately(newAlicePrincipal, 2); // possible precision loss
    });

    it('Transfer event is emitted', async () => {
      const receipt = await absorbTxMulti.wait();
      const transferEvent = receipt.events?.find((e: any) => e.event === 'Transfer');
      
      expect(transferEvent).to.not.be.undefined;
      
      const transferFrom = transferEvent?.args?.from;
      const transferTo = transferEvent?.args?.to;
      const transferAmount = transferEvent?.args?.amount;
      
      expect(transferFrom).to.be.equal(ZERO_ADDRESS);
      expect(transferTo).to.be.equal(alice.address);
      expect(transferAmount).to.be.approximately(presentValueSupply(baseSupplyIndexBefore, newAlicePrincipal), 2);
    });

    it('alice collateral balances become 0', async () => {
      expect(await comet.collateralBalanceOf(alice.address, collaterals['COMP'].address)).to.be.equal(0);
      expect(await comet.collateralBalanceOf(alice.address, collaterals['WETH'].address)).to.be.equal(0);
      expect(await comet.collateralBalanceOf(alice.address, collaterals['WBTC'].address)).to.be.equal(0);
    });

    it('comet collateral reserves are increased by absorb amounts', async () => {
      expect(await comet.getCollateralReserves(collaterals['COMP'].address)).to.be.equal(compReservesBefore.add(COLLATERAL_AMOUNT_COMP));
      expect(await comet.getCollateralReserves(collaterals['WETH'].address)).to.be.equal(wethReservesBefore.add(COLLATERAL_AMOUNT_WETH));
      expect(await comet.getCollateralReserves(collaterals['WBTC'].address)).to.be.equal(wbtcReservesBefore.add(COLLATERAL_AMOUNT_WBTC));
    });

    it('comet total supply collateral is decreased by collateral amounts', async () => {
      expect((await comet.totalsCollateral(collaterals['COMP'].address)).totalSupplyAsset).to.be.equal(compTotalsBefore.sub(COLLATERAL_AMOUNT_COMP));
      expect((await comet.totalsCollateral(collaterals['WETH'].address)).totalSupplyAsset).to.be.equal(wethTotalsBefore.sub(COLLATERAL_AMOUNT_WETH));
      expect((await comet.totalsCollateral(collaterals['WBTC'].address)).totalSupplyAsset).to.be.equal(wbtcTotalsBefore.sub(COLLATERAL_AMOUNT_WBTC));
    });

    it('resets assetsIn and reserved to 0', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    it('alice asset list is empty', async () => {
      expect(await comet.getAssetList(alice.address)).to.be.empty;
    });

    it('comet total supply base increased by alice new principal', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.approximately(totalSupplyBaseBefore.add(newAlicePrincipal), 2);
    });

    it('comet total borrow base becomes 0', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(0);
    });
  });

  describe('absorbing multiple users', function () {
    const COLLATERAL_AMOUNT_PER_USER: bigint = exp(1, 18); // $100 worth per user
    const BORROW_AMOUNT_PER_USER: bigint = exp(80, baseTokenDecimals);
    const DAVE_BASE_SUPPLY_AMOUNT: bigint = exp(500, baseTokenDecimals);

    let user1: SignerWithAddress;
    let user2: SignerWithAddress;
    let user3: SignerWithAddress;
    let compTotalsBefore: BigNumber;
    let compReservesBefore: BigNumber;
    let totalSupplyBaseBefore: BigNumber;
    let totalBorrowBaseBefore: BigNumber;
    let absorbTxMultiple: ContractTransaction;
    let oldBalanceUser1: bigint;
    let oldBalanceUser2: bigint;
    let oldBalanceUser3: bigint;

    let users: SignerWithAddress[] = [];

    let newBalanceUser1: bigint;
    let newBalanceUser2: bigint;
    let newBalanceUser3: bigint;

    let newTotalSupply: BigNumber;

    let compValue: bigint;

    before(async () => {
      // WIthdraw all base tokens from Alice to make sure it has no balance
      await comet.connect(alice).withdraw(baseToken.address, ethers.constants.MaxUint256);

      const totalsBasicBefore = await comet.totalsBasic();

      // Restore comp price to 100
      compPrice = 100;
      await priceFeeds['COMP'].setRoundData(0, exp(compPrice, 8), 0, 0, 0);

      // Get additional users from protocol
      user1 = alice; // Reuse alice
      user2 = protocol.users[3];
      user3 = protocol.users[4];
      users = [user1, user2, user3];

      // Get initial state
      const totalsBasic = await comet.totalsBasic();
      totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
      totalBorrowBaseBefore = totalsBasic.totalBorrowBase;

      // Supply base so that borrowing is possible
      await baseToken.allocateTo(dave.address, DAVE_BASE_SUPPLY_AMOUNT);
      await baseToken.connect(dave).approve(comet.address, DAVE_BASE_SUPPLY_AMOUNT);
      await comet.connect(dave).supply(baseToken.address, DAVE_BASE_SUPPLY_AMOUNT);

      for (const user of users) {
        await collaterals['COMP'].allocateTo(user.address, COLLATERAL_AMOUNT_PER_USER);
        await collaterals['COMP'].connect(user).approve(comet.address, COLLATERAL_AMOUNT_PER_USER);
        await comet.connect(user).supplyTo(user.address, collaterals['COMP'].address, COLLATERAL_AMOUNT_PER_USER);
        await comet.connect(user).withdraw(baseToken.address, BORROW_AMOUNT_PER_USER);
      }

      // Price drops on 20%
      compPrice = compPrice * 80 / 100;
      await priceFeeds['COMP'].setRoundData(0, exp(compPrice, 8), 0, 0, 0);

      expect(await comet.isLiquidatable(user1.address)).to.be.true;
      expect(await comet.isLiquidatable(user2.address)).to.be.true;
      expect(await comet.isLiquidatable(user3.address)).to.be.true;

      // Snapshot protocol state before absorb
      const principal1 = (await comet.userBasic(user1.address)).principal;
      const principal2 = (await comet.userBasic(user2.address)).principal;
      const principal3 = (await comet.userBasic(user3.address)).principal;
      oldBalanceUser1 = presentValue(principal1, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      oldBalanceUser2 = presentValue(principal2, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);
      oldBalanceUser3 = presentValue(principal3, totalsBasicBefore.baseSupplyIndex, totalsBasicBefore.baseBorrowIndex);

      compTotalsBefore = (await comet.totalsCollateral(collaterals['COMP'].address)).totalSupplyAsset;
      compReservesBefore = await comet.getCollateralReserves(collaterals['COMP'].address);
    });

    it('all three users have COMP collateral supplied', async () => {
      expect(await comet.collateralBalanceOf(user1.address, collaterals['COMP'].address)).to.be.equal(COLLATERAL_AMOUNT_PER_USER);
      expect(await comet.collateralBalanceOf(user2.address, collaterals['COMP'].address)).to.be.equal(COLLATERAL_AMOUNT_PER_USER);
      expect(await comet.collateralBalanceOf(user3.address, collaterals['COMP'].address)).to.be.equal(COLLATERAL_AMOUNT_PER_USER);
    });

    it('all three users have borrow positions', async () => {
      expect(await comet.borrowBalanceOf(user1.address)).to.be.approximately(BORROW_AMOUNT_PER_USER, 1);
      expect(await comet.borrowBalanceOf(user2.address)).to.be.approximately(BORROW_AMOUNT_PER_USER, 1);
      expect(await comet.borrowBalanceOf(user3.address)).to.be.approximately(BORROW_AMOUNT_PER_USER, 1);
    });

    it('all three users assetsIn is equal to 1', async () => {
      expect((await comet.userBasic(user1.address)).assetsIn).to.be.equal(1);
      expect((await comet.userBasic(user2.address)).assetsIn).to.be.equal(1);
      expect((await comet.userBasic(user3.address)).assetsIn).to.be.equal(1);
    });

    it('comet total supplied collateral amount is equal to sum of all users', async () => {
      const expectedTotal = COLLATERAL_AMOUNT_PER_USER * 3n;
      expect(compTotalsBefore).to.be.equal(expectedTotal);
    });

    it('new comet total supply base includes dave supplied amount', async () => {
      const expectedTotalSupply = totalSupplyBaseBefore.add(DAVE_BASE_SUPPLY_AMOUNT);
      newTotalSupply = (await comet.totalsBasic()).totalSupplyBase;
      expect(newTotalSupply).to.be.approximately(expectedTotalSupply, 10);
    });

    it('comet total borrow base is equal to sum of all users borrows', async () => {
      const expectedTotalBorrow = totalBorrowBaseBefore.add(BORROW_AMOUNT_PER_USER * 3n);
      const actualTotalBorrow = (await comet.totalsBasic()).totalBorrowBase;
      expect(actualTotalBorrow).to.be.approximately(expectedTotalBorrow, 5); // possible rounding loss
    });

    it('absorb is successful for all three users', async () => {
      // Perform absorb for all three users
      absorbTxMultiple = await comet.connect(absorber).absorb(absorber.address, [user1.address, user2.address, user3.address]);
      await expect(absorbTxMultiple).to.not.be.reverted;
    });

    it('AbsorbCollateral events are emitted for each user', async () => {
      compValue = mulPrice(COLLATERAL_AMOUNT_PER_USER, exp(compPrice, 8), exp(1, 18));

      await expect(absorbTxMultiple)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, user1.address, collaterals['COMP'].address, COLLATERAL_AMOUNT_PER_USER, compValue)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, user2.address, collaterals['COMP'].address, COLLATERAL_AMOUNT_PER_USER, compValue)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, user3.address, collaterals['COMP'].address, COLLATERAL_AMOUNT_PER_USER, compValue);
    });

    it('AbsorbDebt events are emitted for each user', async () => {
      const deltaValue = mulFactor(compValue, LIQUIDATION_FACTOR);
      const deltaBalance = divPrice(deltaValue, usdcPrice, baseScale);
      
      // Calculate for each user using the old balances from before block
      newBalanceUser1 = oldBalanceUser1 + deltaBalance;
      const basePaidOutUser1 = newBalanceUser1 - oldBalanceUser1;
      const valueOfBasePaidOutUser1 = mulPrice(basePaidOutUser1, usdcPrice, baseScale);

      newBalanceUser2 = oldBalanceUser2 + deltaBalance;
      const basePaidOutUser2 = newBalanceUser2 - oldBalanceUser2;
      const valueOfBasePaidOutUser2 = mulPrice(basePaidOutUser2, usdcPrice, baseScale);

      newBalanceUser3 = oldBalanceUser3 + deltaBalance;
      const basePaidOutUser3 = newBalanceUser3 - oldBalanceUser3;
      const valueOfBasePaidOutUser3 = mulPrice(basePaidOutUser3, usdcPrice, baseScale);

      await expect(absorbTxMultiple)
        .to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, user1.address, basePaidOutUser1, valueOfBasePaidOutUser1)
        .to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, user2.address, basePaidOutUser2, valueOfBasePaidOutUser2)
        .to.emit(comet, 'AbsorbDebt')
        .withArgs(absorber.address, user3.address, basePaidOutUser3, valueOfBasePaidOutUser3);
    });

    it('all users principal becomes 0', async () => {
      expect((await comet.userBasic(user1.address)).principal).to.be.equal(0);
      expect((await comet.userBasic(user2.address)).principal).to.be.equal(0);
      expect((await comet.userBasic(user3.address)).principal).to.be.equal(0);
    });

    it('Transfer events are not emitted when new principal is 0', async () => {
      await expect(absorbTxMultiple).to.not.emit(comet, 'Transfer');
    });

    it('all users collateral balances become 0', async () => {
      expect(await comet.collateralBalanceOf(user1.address, collaterals['COMP'].address)).to.be.equal(0);
      expect(await comet.collateralBalanceOf(user2.address, collaterals['COMP'].address)).to.be.equal(0);
      expect(await comet.collateralBalanceOf(user3.address, collaterals['COMP'].address)).to.be.equal(0);
    });

    it('comet collateral reserves are increased by all absorbed amounts', async () => {
      const expectedReserves = compReservesBefore.add(COLLATERAL_AMOUNT_PER_USER * 3n);
      expect(await comet.getCollateralReserves(collaterals['COMP'].address)).to.be.equal(expectedReserves);
    });

    it('comet total supply collateral is decreased by all collateral amounts', async () => {
      const expectedTotal = compTotalsBefore.sub(COLLATERAL_AMOUNT_PER_USER * 3n);
      expect((await comet.totalsCollateral(collaterals['COMP'].address)).totalSupplyAsset).to.be.equal(expectedTotal);
    });

    it('resets assetsIn and reserved to 0 for all users', async () => {
      expect((await comet.userBasic(user1.address)).assetsIn).to.be.equal(0);
      expect((await comet.userBasic(user1.address))._reserved).to.be.equal(0);
      expect((await comet.userBasic(user2.address)).assetsIn).to.be.equal(0);
      expect((await comet.userBasic(user2.address))._reserved).to.be.equal(0);
      expect((await comet.userBasic(user3.address)).assetsIn).to.be.equal(0);
      expect((await comet.userBasic(user3.address))._reserved).to.be.equal(0);
    });

    it('all users asset lists are empty', async () => {
      expect(await comet.getAssetList(user1.address)).to.be.empty;
      expect(await comet.getAssetList(user2.address)).to.be.empty;
      expect(await comet.getAssetList(user3.address)).to.be.empty;
    });

    it('comet total supply base is not changed', async () => {
      // Total supply is not changed as new user's principal is 0
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(newTotalSupply);
    });

    it('comet total borrow base becomes 0', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal(0);
    });
  });

  describe('liquidator points tracking', function () {
    const COLLATERAL_AMOUNT: bigint = exp(1, 18);
    const BORROW_AMOUNT: bigint = exp(80, baseTokenDecimals);
    const DAVE_BASE_SUPPLY_AMOUNT: bigint = exp(200, baseTokenDecimals);

    let testUser1: SignerWithAddress;
    let testUser2: SignerWithAddress;
    let liquidatorPoints: any;
    let newLiquidatorPoints: any;

    before(async () => {
      // Get additional users and new absorber from protocol
      testUser1 = protocol.users[5];
      testUser2 = protocol.users[6];
      absorber = protocol.users[7];

      // Restore comp price to 100
      compPrice = 100;
      await priceFeeds['COMP'].setRoundData(0, exp(compPrice, 8), 0, 0, 0);

      // Supply base so that borrowing is possible
      await baseToken.allocateTo(dave.address, DAVE_BASE_SUPPLY_AMOUNT);
      await baseToken.connect(dave).approve(comet.address, DAVE_BASE_SUPPLY_AMOUNT);
      await comet.connect(dave).supply(baseToken.address, DAVE_BASE_SUPPLY_AMOUNT);

      // Setup testUser1: supply collateral and borrow
      const collateral = collaterals['COMP'];
      await collateral.allocateTo(testUser1.address, COLLATERAL_AMOUNT);
      await collateral.connect(testUser1).approve(comet.address, COLLATERAL_AMOUNT);
      await comet.connect(testUser1).supplyTo(testUser1.address, collateral.address, COLLATERAL_AMOUNT);
      await comet.connect(testUser1).withdraw(baseToken.address, BORROW_AMOUNT);

      // Setup testUser2: supply collateral and borrow
      await collateral.allocateTo(testUser2.address, COLLATERAL_AMOUNT);
      await collateral.connect(testUser2).approve(comet.address, COLLATERAL_AMOUNT);
      await comet.connect(testUser2).supplyTo(testUser2.address, collateral.address, COLLATERAL_AMOUNT);
      await comet.connect(testUser2).withdraw(baseToken.address, BORROW_AMOUNT);

      // Price drops to make users liquidatable
      compPrice = compPrice * 80 / 100;
      await priceFeeds['COMP'].setRoundData(0, exp(compPrice, 8), 0, 0, 0);

      expect(await comet.isLiquidatable(testUser1.address)).to.be.true;
      expect(await comet.isLiquidatable(testUser2.address)).to.be.true;
    });

    it('numAbsorbs is 0 as initial', async () => {
      liquidatorPoints = await comet.liquidatorPoints(absorber.address);
      expect(liquidatorPoints.numAbsorbs).to.be.equal(0);
    });

    it('numAbsorbed is 0 as initial', async () => {
      expect(liquidatorPoints.numAbsorbed).to.be.equal(0);
    });

    it('approxSpend is 0 as initial', async () => {
      expect(liquidatorPoints.approxSpend).to.be.equal(0);
    });

    it('absor is successful for the first user', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [testUser1.address])).to.not.be.reverted;
    });

    it('numAbsorbs increased by 1', async () => {
      newLiquidatorPoints = await comet.liquidatorPoints(absorber.address);
      expect(newLiquidatorPoints.numAbsorbs).to.be.equal(liquidatorPoints.numAbsorbs + 1);
    });

    it('first absorb increments numAbsorbed by number of accounts', async () => {
      expect(newLiquidatorPoints.numAbsorbed).to.be.equal(liquidatorPoints.numAbsorbed.add(1));
    });

    it('first absorb adds to approxSpend based on gas used and base fee', async () => {
      // approxSpend should increase (contract measures gas inside function, not total tx gas)
      expect(newLiquidatorPoints.approxSpend).to.be.greaterThan(liquidatorPoints.approxSpend);
      expect(newLiquidatorPoints.approxSpend).to.be.greaterThan(0);
      liquidatorPoints = newLiquidatorPoints;
    });

    it('second absorb is successful for the second user', async () => {
      await expect(comet.connect(absorber).absorb(absorber.address, [testUser2.address])).to.not.be.reverted;
    });

    it('second absorb increments numAbsorbs by 1 again', async () => {
      newLiquidatorPoints = await comet.liquidatorPoints(absorber.address);
      expect(newLiquidatorPoints.numAbsorbs).to.be.equal(liquidatorPoints.numAbsorbs + 1);
    });

    it('second absorb increments numAbsorbed by 1 again', async () => {
      expect(newLiquidatorPoints.numAbsorbed).to.be.equal(liquidatorPoints.numAbsorbed.add(1));
    });

    it('second absorb adds to approxSpend accumulating total spend', async () => {
      expect(newLiquidatorPoints.approxSpend).to.be.greaterThan(liquidatorPoints.approxSpend);
      expect(newLiquidatorPoints.approxSpend).to.be.greaterThan(0);
      liquidatorPoints = newLiquidatorPoints;
    });

    describe('edge cases', function () {
      it('numAbsorbs is increased by 1 when 0 accounts are provided', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [])).to.not.be.reverted;
        newLiquidatorPoints = await comet.liquidatorPoints(absorber.address);
        expect(newLiquidatorPoints.numAbsorbs).to.be.equal(liquidatorPoints.numAbsorbs + 1);
      });
    });
  });

  describe('revert cases', function () {
    describe('pause', function () {
      it('absorbing is not paused for default', async () => {
        expect(await comet.isAbsorbPaused()).to.be.false;
      });

      it('pause guarding pause absorbing', async () => {
        await comet.connect(pauseGuardian).pause(false, false, false, true, false);
      });

      it('isAbsorbPaused returns true', async () => {
        expect(await comet.isAbsorbPaused()).to.be.true;
      });

      it('absorb is reverted', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address])).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });
    });

    describe('not liquidatable', function () {
      it('alice is not liquidatable', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.false;
      });

      it('revert when user is not liquidatable', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address])).to.be.revertedWithCustomError(comet, 'NotLiquidatable');
      });
    });
  });

  describe('edge cases', function () {
    describe('price feed deprecation can not absorb user immidiately', function () {
      const COLLATERAL_AMOUNT: bigint = exp(1, 18);
      const BORROW_AMOUNT: bigint = exp(10, baseTokenDecimals);

      it('alice supply collateral and borrow', async () => {
        await collaterals['COMP'].allocateTo(alice.address, COLLATERAL_AMOUNT);
        await collaterals['COMP'].connect(alice).approve(comet.address, COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['COMP'].address, COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);
      });

      it('alice has borrow balance', async () => {
        expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(BORROW_AMOUNT);
      });

      it('drop comp price to 0', async () => {
        await priceFeeds['COMP'].setRoundData(0, 0, 0, 0, 0);
      });

      it('isLiquidatable reverted', async () => {
        await expect(comet.isLiquidatable(alice.address)).to.be.revertedWithCustomError(comet, 'BadPrice');
      });

      it('absorb is reverted', async () => {
        await expect(comet.connect(absorber).absorb(absorber.address, [alice.address])).to.be.revertedWithCustomError(comet, 'BadPrice');
      });
    });

    describe('price drop amount impact on new principal', function () {
      const LIQUIDATION_FACTOR: bigint = exp(0.9, 18);

      let compPrice = 100;
      let comet: CometHarnessInterfaceExtendedAssetList;
      let baseToken: FaucetToken;
      let comp: FaucetToken;
      let alice: SignerWithAddress;
      let dave: SignerWithAddress;
      let baseTokenLender: SignerWithAddress;
      let absorber: SignerWithAddress;
      let compPriceFeed: SimplePriceFeed;
      let oldBalance: bigint; // Principal in present value

      before(async () => {
        const protocol = await makeProtocol(
          {
            base: 'USDC',
            assets: {
              USDC: { decimals: baseTokenDecimals, initialPrice: 1 },
              COMP: { decimals: 18, initialPrice: compPrice, borrowCF: exp(0.8, 18), liquidateCF: exp(0.81, 18), liquidationFactor: LIQUIDATION_FACTOR }
            }
          }
        );
        comet = protocol.cometWithExtendedAssetList;
        baseToken = protocol.tokens[protocol.base] as FaucetToken;
        comp = protocol.tokens['COMP'] as FaucetToken;
        compPriceFeed = protocol.priceFeeds['COMP'];

        [alice, dave, absorber, baseTokenLender] = protocol.users;
      });

      describe('small price drop makes liquidate account as lender after absorb', function () {
        const BASE_TOKEN_LEND_AMOUNT: bigint = exp(80, baseTokenDecimals);
        const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, 18);
        const BORROW_AMOUNT: bigint = BASE_TOKEN_LEND_AMOUNT;

        let abosorbTx: ContractTransaction;
        let baseSupplyIndex: bigint;
        let baseBorrowIndex: bigint;
        let newBalance: bigint;
        let newPrincipal: bigint;

        before(async () => {
          // Supply base so that borrowing is possible
          await baseToken.allocateTo(baseTokenLender.address, BASE_TOKEN_LEND_AMOUNT);
          await baseToken.connect(baseTokenLender).approve(comet.address, BASE_TOKEN_LEND_AMOUNT);
          await comet.connect(baseTokenLender).supply(baseToken.address, BASE_TOKEN_LEND_AMOUNT);

          // Make Alice liquidatable
          await comp.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await comp.connect(alice).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(alice).supply(comp.address, SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);

          const totalsBasic = await comet.totalsBasic();
          baseSupplyIndex = totalsBasic.baseSupplyIndex.toBigInt();
          baseBorrowIndex = totalsBasic.baseBorrowIndex.toBigInt();
          const principal = (await comet.userBasic(alice.address)).principal;
          oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
        });

        it('drop comp price by 5%', async () => {
          compPrice = compPrice * 95 / 100;
          await compPriceFeed.setRoundData(0, exp(compPrice, 8), 0, 0, 0);
          compPrice = 100; // restore to 100 for next tests
        });

        it('alice is liquidatable', async () => {
          expect(await comet.isLiquidatable(alice.address)).to.be.true;
        });

        it('absorb is successful', async () => {
          abosorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
          await expect(abosorbTx).to.not.be.reverted;
        });

        it('new balance becomes > 0', async () => {
          const compTokenPrice = (await compPriceFeed.latestRoundData())[1];
          const compValue = mulPrice(SUPPLY_COLLATERAL_AMOUNT, compTokenPrice, exp(1, 18)); // Value becomes 9500000000 = 95 in USD
          const deltaValue = mulFactor(compValue, LIQUIDATION_FACTOR); // Value becomes 8550000000 = 85.5 in USD
          const deltaBalance = divPrice(deltaValue, usdcPrice, baseScale);
          newBalance = oldBalance + deltaBalance;

          expect(newBalance).to.be.greaterThan(0);
        });

        it('new principal becomes > 0', async () => {
          newPrincipal = await principalValue(newBalance, baseSupplyIndex, baseBorrowIndex);
          expect(newPrincipal).to.be.greaterThan(0);
        });

        it('new principal is equal to alice principal', async () => {
          expect(newPrincipal).to.be.approximately((await comet.userBasic(alice.address)).principal, 5); // possible loss in 5 wei
        });

        it('Transfer event is emitted', async () => {
          const receipt = await abosorbTx.wait();
          const transferEvent = receipt.events?.find((e: any) => e.event === 'Transfer');
            
          const transferFrom = transferEvent?.args?.from;
          const transferTo = transferEvent?.args?.to;
          const transferAmount = transferEvent?.args?.amount;
      
          expect(transferFrom).to.be.equal(ZERO_ADDRESS);
          expect(transferTo).to.be.equal(alice.address);
          expect(transferAmount).to.be.approximately(presentValueSupply(baseSupplyIndex, newPrincipal), 5);
        });

        it('alice balanceOf base is equal to new principal', async () => {
          expect(await comet.balanceOf(alice.address)).to.be.approximately(newPrincipal, 5);
        });

        it('alice borrow balance is equal to 0', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });
      });

      describe('large price drop makes user principal as 0', function () {
        const BASE_TOKEN_LEND_AMOUNT: bigint = exp(80, baseTokenDecimals);
        const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, 18);
        const BORROW_AMOUNT: bigint = BASE_TOKEN_LEND_AMOUNT;

        let abosorbTx: ContractTransaction;
        let baseSupplyIndex: bigint;
        let baseBorrowIndex: bigint;
        let newBalance: bigint;
        let newPrincipal: bigint;

        before(async () => {
          // Restore comp price to 100
          await compPriceFeed.setRoundData(0, exp(compPrice, 8), 0, 0, 0);
          // Supply base so that borrowing is possible
          await baseToken.allocateTo(baseTokenLender.address, BASE_TOKEN_LEND_AMOUNT);
          await baseToken.connect(baseTokenLender).approve(comet.address, BASE_TOKEN_LEND_AMOUNT);
          await comet.connect(baseTokenLender).supply(baseToken.address, BASE_TOKEN_LEND_AMOUNT);

          // Make Alice liquidatable
          await comp.allocateTo(dave.address, SUPPLY_COLLATERAL_AMOUNT);
          await comp.connect(dave).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(dave).supply(comp.address, SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(dave).withdraw(baseToken.address, BORROW_AMOUNT);

          const totalsBasic = await comet.totalsBasic();
          baseSupplyIndex = totalsBasic.baseSupplyIndex.toBigInt();
          baseBorrowIndex = totalsBasic.baseBorrowIndex.toBigInt();
          const principal = (await comet.userBasic(dave.address)).principal;
          oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
        });

        it('drop comp price by 30%', async () => {
          compPrice = compPrice * 70 / 100;
          await compPriceFeed.setRoundData(0, exp(compPrice, 8), 0, 0, 0);
          compPrice = 100; // restore to 100 for next tests
        });

        it('dave is liquidatable', async () => {
          expect(await comet.isLiquidatable(dave.address)).to.be.true;
        });

        it('absorb is successful', async () => {
          abosorbTx = await comet.connect(absorber).absorb(absorber.address, [dave.address]);
          await expect(abosorbTx).to.not.be.reverted;
        });

        it('new balance becomes < 0', async () => {
          const compTokenPrice = (await compPriceFeed.latestRoundData())[1];
          const compValue = mulPrice(SUPPLY_COLLATERAL_AMOUNT, compTokenPrice, exp(1, 18)); // Value becomes 9500000000 = 95 in USD
          const deltaValue = mulFactor(compValue, LIQUIDATION_FACTOR); // Value becomes 8550000000 = 85.5 in USD
          const deltaBalance = divPrice(deltaValue, usdcPrice, baseScale);
          newBalance = oldBalance + deltaBalance;

          expect(newBalance).to.be.lessThan(0);
        });

        it('new principal becomes 0', async () => {
          newBalance = 0n; // new balance becomes 0 as it is less than 0
          newPrincipal = await principalValue(newBalance, baseSupplyIndex, baseBorrowIndex);
          expect(newPrincipal).to.be.equal(0);
        });

        it('new principal is equal to dave principal', async () => {
          expect(newPrincipal).to.be.equal((await comet.userBasic(dave.address)).principal);
        });

        it('Transfer event is not emitted', async () => {
          await expect(abosorbTx).to.not.emit(comet, 'Transfer');
        });

        it('dave balanceOf base is equal to 0', async () => {
          expect(await comet.balanceOf(dave.address)).to.equal(0);
        });

        it('dave borrow balance is equal to 0', async () => {
          expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
        });
      });
    });

    describe('absorb with 24 collaterals', function () {
      const MAX_ASSETS = 24;
      const BASE_TOKEN_LEND_AMOUNT: bigint = exp(250, baseTokenDecimals);
      const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, 18);
      const BORROW_AMOUNT: bigint = exp(190, baseTokenDecimals);
      const collateralPrice = 10;

      let comet: CometHarnessInterfaceExtendedAssetList;
      let baseToken: FaucetToken;
      let collaterals: { [symbol: string]: FaucetToken } = {};
      let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

      let alice: SignerWithAddress;
      let baseTokenLender: SignerWithAddress;
      let absorber: SignerWithAddress;

      let absorbTx: ContractTransaction;
      let newCollateralPrice: bigint;

      before(async () => {
        // Setup protocol with MAX_ASSETS collaterals
        const cometCollaterals = Object.fromEntries(
          Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {
            decimals: 18,
            initialPrice: collateralPrice,
            borrowCF: exp(0.8, 18),
          }])
        );
        const protocol = await makeProtocol({
          base: 'USDC',
          assets: { 
            USDC: {decimals: 6, initialPrice: 1},
            ...cometCollaterals },
        });

        comet = protocol.cometWithExtendedAssetList;
        baseToken = protocol.tokens[protocol.base] as FaucetToken;
        for (let asset in protocol.tokens) {
          if (asset === 'USDC') continue;
          collaterals[asset] = protocol.tokens[asset] as FaucetToken;
          priceFeeds[asset] = protocol.priceFeeds[asset];
        }

        [alice, baseTokenLender, absorber] = protocol.users;

        // Supply base so that borrowing is possible
        await baseToken.allocateTo(baseTokenLender.address, BASE_TOKEN_LEND_AMOUNT);
        await baseToken.connect(baseTokenLender).approve(comet.address, BASE_TOKEN_LEND_AMOUNT);
        await comet.connect(baseTokenLender).supply(baseToken.address, BASE_TOKEN_LEND_AMOUNT);
      });

      it('alice supply each of collaterals', async () => {
        for (const asset in collaterals) {
          await collaterals[asset].allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await collaterals[asset].connect(alice).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(alice).supply(collaterals[asset].address, SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('alice withdraw base', async () => {
        await comet.connect(alice).withdraw(baseToken.address, BORROW_AMOUNT);
      });

      it('each collateral balance is equal to supply amount', async () => {
        for (const asset in collaterals) {
          expect(await comet.collateralBalanceOf(alice.address, collaterals[asset].address)).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('each collateral total supply is equal to supply amount', async () => {
        for (const asset in collaterals) {
          expect((await comet.totalsCollateral(collaterals[asset].address)).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('each collateral reserve is equal to 0', async () => {
        for (const asset in collaterals) {
          expect(await comet.getCollateralReserves(collaterals[asset].address)).to.equal(0);
        }
      });

      it('borrow balance is equal to borrow amount', async () => {
        expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(BORROW_AMOUNT);
      });

      it('assets in is > 0', async () => {
        expect((await comet.userBasic(alice.address)).assetsIn).to.be.greaterThan(0);
      });

      it('reserved is > 0', async () => {
        expect((await comet.userBasic(alice.address))._reserved).to.be.greaterThan(0);
      });

      it('each collateral price drop by 50%', async () => {
        newCollateralPrice = exp(collateralPrice * 50 / 100, 8);
        for (const asset in collaterals) {
          await priceFeeds[asset].setRoundData(0, newCollateralPrice, 0, 0, 0);
        }
      });

      it('alice is liquidatable', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.true;
      });

      it('absorb is successful', async () => {
        absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
        await expect(absorbTx).to.not.be.reverted;
      });

      it('AbsorbCollateral event is emitted for each collateral', async () => {
        const value = mulPrice(SUPPLY_COLLATERAL_AMOUNT, newCollateralPrice, exp(1, 18));

        for (const asset in collaterals) {
          await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(absorber.address, alice.address, collaterals[asset].address, SUPPLY_COLLATERAL_AMOUNT, value);
        }
      });

      it('each collateral balance is equal to 0', async () => {
        for (const asset in collaterals) {
          expect(await comet.collateralBalanceOf(alice.address, collaterals[asset].address)).to.equal(0);
        }
      });

      it('each collateral total supply is equal to 0', async () => {
        for (const asset in collaterals) {
          expect((await comet.totalsCollateral(collaterals[asset].address)).totalSupplyAsset).to.equal(0);
        }
      });

      it('each collateral reserve is equal to supply amount', async () => {
        for (const asset in collaterals) {
          expect(await comet.getCollateralReserves(collaterals[asset].address)).to.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('borrow balance is equal to 0', async () => {
        expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
      });

      it('assets in is equal to 0', async () => {
        expect((await comet.userBasic(alice.address)).assetsIn).to.equal(0);
      });

      it('reserved is equal to 0', async () => {
        expect((await comet.userBasic(alice.address))._reserved).to.equal(0);
      });
    });
  });

  /*
   * Written after the USDM incident, where a removed Chainlink price feed caused absorb to revert
   * while calculating the USD value of seized collateral, freezing liquidations.
   *
   * This suite covers four (LCF, LF) combinations and how each affects absorption:
   *   1. LCF > 0, LF > 0  - active collateral: price fetched, collateral seized at full USD value.
   *   2. LCF > 0, LF = 0  - soft de-list: price still fetched (isLiquidatable counts it), but
   *                          absorbInternal skips seizure; full debt absorbed by reserves.
   *   3. LCF = 0, LF > 0  - worthless seizure: price fetch skipped (assetPrices[i] = 0), collateral
   *                          still seized and moved to reserves but with usdValue = 0.
   *   4. LCF = 0, LF = 0  - full de-list: both price fetch and seizure skipped; asset completely
   *                          ignored during absorption, collateral left stranded in user's account.
   *
   * Also covers edge cases:
   *   - mixed liquidation factors across multiple assets: only assets with LF > 0 are seized.
   *   - price feed paralysis: a reverting price feed freezes isLiquidatable, isBorrowCollateralized,
   *     and absorb; restoring the feed unblocks all three. Governance can also set LCF = 0 to skip
   *     the price fetch entirely, resolving the paralysis without replacing the broken feed.
   */
  describe('absorb semantics across liquidationFactor values', function () {
    // Snapshot
    let snapshot: SnapshotRestorer;

    // Configurator and protocol
    let configurator: Configurator;
    let configuratorProxy: ConfiguratorProxy;
    let proxyAdmin: CometProxyAdmin;
    let cometProxyAddress: string;
    let assetListFactoryAddress: string;
    let comet: CometWithExtendedAssetList;
    let comet24Assets: CometWithExtendedAssetList;
    let configuratorProxy24Assets: Configurator;
    let proxyAdmin24Assets: CometProxyAdmin;
    let cometExt: CometExtAssetList;

    // Tokens
    let baseToken: FaucetToken | NonStandardFaucetFeeToken;
    let compToken: FaucetToken | NonStandardFaucetFeeToken;
    let baseToken24Assets: FaucetToken | NonStandardFaucetFeeToken;
    let tokens24Assets: Record<string, FaucetToken | NonStandardFaucetFeeToken>;

    // Users
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let underwater24Assets: SignerWithAddress;
    let absorber24Assets: SignerWithAddress;

    // Price feeds
    let compPriceFeed: SimplePriceFeed;
    let priceFeeds24Assets: Record<string, SimplePriceFeed>;

    // Constants
    const aliceCompSupply = exp(1, 18);

    // Liquidation transaction
    let liquidationTx: ContractTransaction;

    // Data before absorption
    let userCollateralBeforeAbsorption: BigNumber;
    let totalsSupplyAssetBeforeAbsorption: BigNumber;
    let totalSupplyBase: BigNumber;
    let totalBorrowBase: BigNumber;
    let expectedUsdValue: bigint;
    let oldBalance: bigint;
    let oldPrincipal: bigint;
    let newPrincipal: bigint;
    let basePrice: BigNumber;
    let baseScale: BigNumber;
    let newBalance: bigint;

    before(async () => {
      const configuratorAndProtocol = await makeConfigurator({
        base: 'USDC',
        storeFrontPriceFactor: exp(0.8, 18),
        assets: {
          USDC: { initial: 1e6, decimals: 6, initialPrice: 1 },
          COMP: {
            initial: 1e7,
            decimals: 18,
            initialPrice: 200,
            liquidationFactor: exp(0.6, 18),
          },
        },
      });
      // Note: Always interact with the proxy address, we'll upgrade implementation later
      cometProxyAddress = configuratorAndProtocol.cometProxy.address;
      comet = configuratorAndProtocol.cometWithExtendedAssetList.attach(cometProxyAddress) as CometWithExtendedAssetList;
      configurator = configuratorAndProtocol.configurator;
      configuratorProxy = configuratorAndProtocol.configuratorProxy;
      proxyAdmin = configuratorAndProtocol.proxyAdmin;
      assetListFactoryAddress = configuratorAndProtocol.assetListFactory.address;
      comet = comet.attach(cometProxyAddress);

      // Tokens
      baseToken = configuratorAndProtocol.tokens.USDC;
      compToken = configuratorAndProtocol.tokens.COMP;

      compPriceFeed = configuratorAndProtocol.priceFeeds.COMP;

      alice = configuratorAndProtocol.users[0];
      bob = configuratorAndProtocol.users[1];

      // Allocate base token to comet
      await baseToken.allocateTo(comet.address, exp(1000, 6));

      // Supply COMP from Alice
      await compToken.allocateTo(alice.address, aliceCompSupply);
      await compToken.connect(alice).approve(comet.address, aliceCompSupply);
      await comet.connect(alice).supply(compToken.address, aliceCompSupply);

      // Borrow COMP from Alice
      await comet.connect(alice).withdraw(baseToken.address, exp(150, 6));

      // Drop COMP price from 200 to 100 to make Alice liquidatable
      await compPriceFeed.setRoundData(
        0, // roundId
        exp(100, 8), // answer
        0, // startedAt
        0, // updatedAt
        0 // answeredInRound
      );

      // Verify Alice is liquidatable
      expect(await comet.isLiquidatable(alice.address)).to.be.true;

      // Save data before absorption
      userCollateralBeforeAbsorption = (await comet.userCollateral(alice.address, compToken.address)).balance;
      totalsSupplyAssetBeforeAbsorption = (await comet.totalsCollateral(compToken.address)).totalSupplyAsset;

      configurator = configurator.attach(configuratorProxy.address);
      const CometExtAssetList = await (
        await ethers.getContractFactory('CometExtAssetList')
      ).deploy(
        {
          name32: ethers.utils.formatBytes32String('Compound Comet'),
          symbol32: ethers.utils.formatBytes32String('BASE'),
        },
        assetListFactoryAddress
      );
      await CometExtAssetList.deployed();
      await configurator.setExtensionDelegate(cometProxyAddress, CometExtAssetList.address);
      // 2) switch factory to CometFactoryWithExtendedAssetList
      const CometFactoryWithExtendedAssetList = await (await ethers.getContractFactory('CometFactoryWithExtendedAssetList')).deploy();
      await CometFactoryWithExtendedAssetList.deployed();
      await configurator.setFactory(cometProxyAddress, CometFactoryWithExtendedAssetList.address);

      /*//////////////////////////////////////////////////////////////
                            24 ASSETS COMET
      //////////////////////////////////////////////////////////////*/
      const collaterals = Object.fromEntries(
        Array.from({ length: MAX_ASSETS }, (_, j) => [
          `ASSET${j}`,
          {
            decimals: 18,
            initialPrice: 200,
          },
        ])
      );
      // Create protocol with configurator so we can update liquidationFactor later
      const configuratorAndProtocol24Assets = await makeConfigurator({ assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals }});
      comet24Assets = configuratorAndProtocol24Assets.cometWithExtendedAssetList.attach(configuratorAndProtocol24Assets.cometProxy.address) as CometWithExtendedAssetList;
      underwater24Assets = configuratorAndProtocol24Assets.users[0];
      absorber24Assets = configuratorAndProtocol24Assets.users[1];
      tokens24Assets = configuratorAndProtocol24Assets.tokens;
      priceFeeds24Assets = configuratorAndProtocol24Assets.priceFeeds;
      configuratorProxy24Assets = configuratorAndProtocol24Assets.configurator.attach(configuratorAndProtocol24Assets.configuratorProxy.address);
      proxyAdmin24Assets = configuratorAndProtocol24Assets.proxyAdmin;

      const CometExtAssetList24Assets = await (
        await ethers.getContractFactory('CometExtAssetList')
      ).deploy(
        {
          name32: ethers.utils.formatBytes32String('Compound Comet'),
          symbol32: ethers.utils.formatBytes32String('BASE'),
        },
        configuratorAndProtocol24Assets.assetListFactory.address
      );
      await CometExtAssetList24Assets.deployed();
      await configuratorProxy24Assets.setExtensionDelegate(configuratorAndProtocol24Assets.cometProxy.address, CometExtAssetList24Assets.address);
      await configuratorProxy24Assets.setFactory(configuratorAndProtocol24Assets.cometProxy.address, CometFactoryWithExtendedAssetList.address);
      await configuratorAndProtocol24Assets.proxyAdmin.deployAndUpgradeTo(configuratorAndProtocol24Assets.configuratorProxy.address, configuratorAndProtocol24Assets.cometProxy.address);

      baseToken24Assets = configuratorAndProtocol24Assets.tokens['USDC'];

      cometExt = (await ethers.getContractAt('CometExtAssetList', comet.address)) as CometExtAssetList;
      const totalBasics = await cometExt.totalsBasic();
      oldPrincipal = (await comet.userBasic(alice.address)).principal.toBigInt();
      totalSupplyBase = totalBasics.totalSupplyBase;
      totalBorrowBase = totalBasics.totalBorrowBase;
      oldBalance = presentValue(oldPrincipal, totalBasics.baseSupplyIndex, totalBasics.baseBorrowIndex);
      basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      baseScale = await comet.baseScale();

      snapshot = await takeSnapshot();
    });

    describe('asset can be liquidated with positive liquidation collateral factor and liquidation factor', function () {
      /*
       * normal "active collateral" state.
       *
       * Key factor roles in absorption:
       *   - LCF > 0: the asset counts toward the account's liquidation threshold in isLiquidatable;
       *              its price is fetched and stored in assetPrices[i].
       *   - LF  > 0: absorbInternal seizes the collateral, reads assetPrices[i], and uses the
       *              USD value to offset the absorbed debt.
       *   - borrowCF: governs only isBorrowCollateralized (new-borrow gate); irrelevant to
       *               isLiquidatable and absorb.
       *
       * Flow:
       *    With LCF > 0 and LF > 0:
       *    - Collateral is seized: Alice's COMP collateral is transferred to protocol reserves
       *    - AbsorbCollateral event is emitted with the seized amount and its USD value
       *    - User collateral balance is set to 0
       *    - totalsCollateral.totalSupplyAsset is reduced to 0
       *    - User's assetsIn is reset to 0
       *    - User principal is updated by the USD value of the seized collateral
       *    - AbsorbDebt event is emitted with the base amount paid out to the absorber
       *    - Total borrow base is reduced by the repay amount
       *    - Transfer event is NOT emitted (new principal clamps to 0, no supply side created)
       */
      it('absorbs undercollateralized account', async () => {
        liquidationTx = await comet.connect(bob).absorb(bob.address, [alice.address]);

        expect(liquidationTx).to.not.be.reverted;
      });

      it('emits AbsorbCollateral event', async () => {
        const assetInfo = await comet.getAssetInfoByAddress(compToken.address);
        const [_, price] = await compPriceFeed.latestRoundData();
        expectedUsdValue = mulPrice(aliceCompSupply, price, assetInfo.scale);

        expect(liquidationTx).to.emit(comet, 'AbsorbCollateral').withArgs(bob.address, alice.address, compToken.address, aliceCompSupply, expectedUsdValue);
      });

      it('reduces totals supply of the asset for seized asset', async () => {
        const totals = await comet.totalsCollateral(compToken.address);
        expect(totals.totalSupplyAsset).to.equal(0);
      });

      it('sets user collateral balance to 0', async () => {
        expect((await comet.userCollateral(alice.address, compToken.address)).balance).to.equal(0);
      });

      it('reset user assetsIn to 0', async () => {
        expect((await comet.userBasic(alice.address)).assetsIn).to.equal(0);
        expect((await comet.userBasic(alice.address))._reserved).to.equal(0);
      });

      it('updates totals correctly after absorption', async () => {
        // Calculate expected totals
        const deltaBalance = divPrice(expectedUsdValue, basePrice, baseScale);
        const totalsBasic = await cometExt.totalsBasic();

        newBalance = oldBalance + deltaBalance;
        if (newBalance < 0) newBalance = 0n;
        newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

        // Check that user principal is updated correctly
        expect((await comet.userBasic(alice.address)).principal).to.equal(newPrincipal);
        // Calculate repay and supply amounts
        // We expect that new principal is greater than old principal
        expect(newPrincipal > oldPrincipal).to.be.true;
        // New principal becomes zero as we check before, thus we go strongly in case `newPrincipal <= 0`
        expect(newPrincipal <= 0).to.be.true;
        const repayAmount = newPrincipal - oldPrincipal;
        const supplyAmount = 0n;

        const newTotalsBasic = await cometExt.totalsBasic();
        expect(newTotalsBasic.totalSupplyBase).to.equal(totalSupplyBase.toBigInt() + supplyAmount);
        expect(newTotalsBasic.totalBorrowBase).to.equal(totalBorrowBase.toBigInt() - repayAmount);
      });

      it('updates user principal correctly after absorption', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.equal(newPrincipal);

        await snapshot.restore();
      });

      it('emits AbsorbDebt event', async () => {
        const basePaidOut = newBalance - oldBalance;
        const valueOfBasePaidOut = mulPrice(basePaidOut, basePrice, baseScale);
        expect(liquidationTx).to.emit(comet, 'AbsorbDebt').withArgs(bob.address, alice.address, basePaidOut, valueOfBasePaidOut);
      });

      it('Transfer event is not emitted', async () => {
        // Transfer event emits only when new principal is greater than 0
        expect(newPrincipal).to.equal(0);
        expect(liquidationTx).to.not.emit(comet, 'Transfer');
      });
    });

    describe('skips liquidation for asset with liquidationF = 0 and liquidateCF > 0', function () {
      /*
       * "soft de-list" state.
       *
       * Key factor roles in absorption:
       *   - LCF > 0: the asset still counts toward the account's liquidation threshold;
       *              its price is fetched and stored in assetPrices[i].
       *   - LF  = 0: absorbInternal skips seizure for this asset entirely — no collateral
       *              transfer, assetPrices[i] is not used to offset debt.
       *   - borrowCF: governs only isBorrowCollateralized (new-borrow gate); irrelevant to
       *               isLiquidatable and absorb.
       *
       * Flow:
       *    When LF = 0 and LCF still > 0:
       *    - Collateral is NOT seized: Alice's COMP collateral remains untouched
       *    - AbsorbCollateral event is NOT emitted (asset is skipped during absorption)
       *    - User collateral balance remains unchanged (same as before absorption)
       *    - totalsCollateral.totalSupplyAsset remains unchanged
       *    - User principal is still updated (debt is absorbed, but no collateral value is applied)
       *    - AbsorbDebt event is still emitted (debt absorption occurs, but with 0 base paid out)
       *    - Total borrow base is still reduced (debt is repaid)
       *    - Transfer event is NOT emitted (since new principal becomes 0)
       */
      it('liquidation factor can be updated to 0', async () => {
        await configurator.updateAssetLiquidationFactor(cometProxyAddress, compToken.address, exp(0, 18));
        await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);
      });

      it('liquidation factor becomes 0 after upgrade', async () => {
        expect((await comet.getAssetInfoByAddress(compToken.address)).liquidationFactor).to.equal(0);
      });

      it('absorbs undercollateralized account with 0 liquidation factor on asset', async () => {
        liquidationTx = await comet.connect(bob).absorb(bob.address, [alice.address]);

        expect(liquidationTx).to.not.be.reverted;
      });

      it('does not emit AbsorbCollateral event', async () => {
        expect(liquidationTx).to.not.emit(comet, 'AbsorbCollateral');
      });

      it('does not affect user collateral balance', async () => {
        expect((await comet.userCollateral(alice.address, compToken.address)).balance).to.equal(userCollateralBeforeAbsorption);
      });

      it('does not affect totals supply of the asset', async () => {
        expect((await comet.totalsCollateral(compToken.address)).totalSupplyAsset).to.equal(totalsSupplyAssetBeforeAbsorption);
      });

      it('updates totals correctly after absorption', async () => {
        // Expected USD value is 0 because of skipping absorption of the asset
        expectedUsdValue = 0n;

        // Calculate expected totals
        const deltaBalance = divPrice(expectedUsdValue, basePrice, baseScale);
        const totalsBasic = await cometExt.totalsBasic();

        let newBalance = oldBalance + deltaBalance;
        if (newBalance < 0) newBalance = 0n;
        newPrincipal = principalValue(newBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);

        // Check that user principal is updated correctly
        expect((await comet.userBasic(alice.address)).principal).to.equal(newPrincipal);
        // Calculate repay and supply amounts
        // We expect that new principal is greater than old principal
        expect(newPrincipal > oldPrincipal).to.be.true;
        // New principal becomes zero as we check before, thus we go strongly in case `newPrincipal <= 0`
        expect(newPrincipal <= 0).to.be.true;
        const repayAmount = newPrincipal - oldPrincipal;
        const supplyAmount = 0n;

        const newTotalsBasic = await cometExt.totalsBasic();
        expect(newTotalsBasic.totalSupplyBase).to.equal(totalSupplyBase.toBigInt() + supplyAmount);
        expect(newTotalsBasic.totalBorrowBase).to.equal(totalBorrowBase.toBigInt() - repayAmount);
      });

      it('updates user principal correctly after absorption', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.equal(newPrincipal);
      });

      it('emits AbsorbDebt event', async () => {
        const basePaidOut = newBalance - oldBalance;
        const valueOfBasePaidOut = mulPrice(basePaidOut, basePrice, baseScale);
        expect(liquidationTx).to.emit(comet, 'AbsorbDebt').withArgs(bob.address, alice.address, basePaidOut, valueOfBasePaidOut);
      });

      it('Transfer event is not emitted', async () => {
        // Transfer event emits only when new principal is greater than 0
        expect(newPrincipal).to.equal(0);
        expect(liquidationTx).to.not.emit(comet, 'Transfer');
      });
    });

    describe('asset abosorbs with zero value when liquidateCF > 0 and liquidationF is positive', function () {
      /*
       * the collateral is still seizable but treated as worthless.
       *
       * Key factor roles in absorption:
       *   - LCF = 0: isLiquidatableInternal skips price fetching for this asset,
       *              so assetPrices[i] stays 0; the asset contributes no coverage.
       *   - LF  > 0: absorbInternal seizes the collateral but uses assetPrices[i] = 0 —
       *              the collateral moves to reserves with zero USD value offset.
       *   - borrowCF: governs only isBorrowCollateralized (new-borrow gate); irrelevant to
       *               isLiquidatable and absorb.
       *
       * Flow:
       *    When LCF = 0 and LF > 0:
       *    - Collateral IS seized: Alice's COMP collateral is transferred to protocol reserves
       *    - AbsorbCollateral event IS emitted but with usdValue = 0 (assetPrices[i] = 0 since
       *      isLiquidatableInternal skipped price fetching for this LCF = 0 asset)
       *    - User collateral balance is set to 0
       *    - totalsCollateral.totalSupplyAsset is reduced to 0
       *    - User's assetsIn is reset to 0
       *    - User principal is not offset by collateral value — deltaBalance = 0, full debt remains
       *    - New balance is clamped to 0; debt is fully absorbed by protocol reserves
       *    - AbsorbDebt event is emitted (full debt absorbed by reserves)
       *    - Total borrow base is reduced by the repay amount
       *    - Transfer event is NOT emitted (new principal clamps to 0, no supply side created)
       *    - Comet ERC20 collateral balance is unchanged (tokens stay locked in comet)
       *    - Collateral reserves increase by the seized amount
       */
      let cometBaseTokenBalanceBefore: BigNumber;
      let cometCompBalanceBefore: BigNumber;
      let cometCompReservesBefore: BigNumber;
      let computedDeltaBalance: bigint;
      let computedNewBalance: bigint;
      let computedRepayAmount: bigint;

      before(async () => {
        await snapshot.restore();
        cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
        cometCompBalanceBefore = await compToken.balanceOf(comet.address);
        cometCompReservesBefore = await comet.getCollateralReserves(compToken.address);
      });

      it('borrowCollateralFactor and liquidateCollateralFactor updated to 0', async () => {
        await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, compToken.address, 0n);
        await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, compToken.address, 0n);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);
      });

      it('liquidateCollateralFactor is 0 after upgrade', async () => {
        expect((await comet.getAssetInfoByAddress(compToken.address)).liquidateCollateralFactor).to.equal(0);
      });

      it('liquidationFactor remains non-zero after upgrade', async () => {
        expect((await comet.getAssetInfoByAddress(compToken.address)).liquidationFactor).to.be.gt(0);
      });

      it('alice is liquidatable with zero liquidateCollateralFactor', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.true;
      });

      it('absorbs undercollateralized account', async () => {
        liquidationTx = await comet.connect(bob).absorb(bob.address, [alice.address]);
        expect(liquidationTx).to.not.be.reverted;
      });

      it('emits AbsorbCollateral event with usdValue of 0', async () => {
        // assetPrices[i] stays 0 because isLiquidatableInternal skips LCF=0 assets before calling getPrice()
        // value = mulPrice(seizeAmount, 0, scale) = 0
        expect(liquidationTx).to.emit(comet, 'AbsorbCollateral').withArgs(bob.address, alice.address, compToken.address, aliceCompSupply, 0n);
      });

      it('reduces totals supply of the asset for seized asset', async () => {
        const totals = await comet.totalsCollateral(compToken.address);
        expect(totals.totalSupplyAsset).to.equal(0);
      });

      it('sets user collateral balance to 0', async () => {
        expect((await comet.userCollateral(alice.address, compToken.address)).balance).to.equal(0);
      });

      it('resets user assetsIn to 0', async () => {
        expect((await comet.userBasic(alice.address)).assetsIn).to.equal(0);
        expect((await comet.userBasic(alice.address))._reserved).to.equal(0);
      });

      it('deltaBalance is 0 when deltaValue is 0', () => {
        // assetPrices[i] = 0 for LCF = 0 assets → deltaValue = 0 → deltaBalance = divPrice(0, price, scale) = 0
        computedDeltaBalance = divPrice(0n, basePrice, baseScale);
        expect(computedDeltaBalance).to.equal(0n);
      });

      it('new balance is clamped to 0 from the negative old borrow balance', () => {
        // oldBalance < 0, deltaBalance = 0 → unclamped = oldBalance (still negative) → clamped to 0
        const unclamped = oldBalance + computedDeltaBalance;
        expect(unclamped < 0).to.be.true;
        computedNewBalance = 0n;
      });

      it('new principal is 0 and matches stored principal', async () => {
        const totalsBasic = await cometExt.totalsBasic();
        newPrincipal = principalValue(computedNewBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
        expect(newPrincipal).to.equal(0n);
        expect((await comet.userBasic(alice.address)).principal).to.equal(0n);
      });

      it('repay amount equals the absorbed borrow', () => {
        // repayAmount = newPrincipal - oldPrincipal = 0 - oldPrincipal = -oldPrincipal > 0
        computedRepayAmount = newPrincipal - oldPrincipal;
        expect(computedRepayAmount > 0n).to.be.true;
      });

      it('supply amount is 0 since new principal does not exceed 0', () => {
        // supplyAmount = 0 when newPrincipal <= 0 (see repayAndSupplyAmount)
        expect(newPrincipal <= 0n).to.be.true;
      });

      it('totalSupplyBase is unchanged after absorption', async () => {
        const current = await cometExt.totalsBasic();
        expect(current.totalSupplyBase).to.equal(totalSupplyBase);
      });

      it('totalBorrowBase is reduced by repay amount after absorption', async () => {
        const current = await cometExt.totalsBasic();
        expect(current.totalBorrowBase).to.equal(totalBorrowBase.toBigInt() - computedRepayAmount);
      });

      it('emits AbsorbDebt event', async () => {
        // basePaidOut = computedNewBalance - oldBalance = 0 - oldBalance = -oldBalance (full debt absorbed by reserves)
        const basePaidOut = computedNewBalance - oldBalance;
        const valueOfBasePaidOut = mulPrice(basePaidOut, basePrice, baseScale);
        expect(liquidationTx).to.emit(comet, 'AbsorbDebt').withArgs(bob.address, alice.address, basePaidOut, valueOfBasePaidOut);
      });

      it('Transfer event is not emitted', async () => {
        expect(liquidationTx).to.not.emit(comet, 'Transfer');
      });

      it('comet base token ERC20 balance is unchanged after absorption', async () => {
        // absorb does not transfer base tokens; debt absorption is an accounting change only
        expect(await baseToken.balanceOf(comet.address)).to.equal(cometBaseTokenBalanceBefore);
      });

      it('comet collateral token ERC20 balance is unchanged after absorption', async () => {
        // seized tokens remain locked in the comet contract; they are reclassified to reserves, not transferred out
        expect(await compToken.balanceOf(comet.address)).to.equal(cometCompBalanceBefore);
      });

      it('comet collateral reserves increase by the seized amount', async () => {
        // getCollateralReserves = balanceOf(comet) - totalsCollateral.totalSupplyAsset
        // after seizure: totalSupplyAsset = 0, balanceOf unchanged → reserves grow by aliceCompSupply
        expect(await comet.getCollateralReserves(compToken.address)).to.equal(cometCompReservesBefore.add(aliceCompSupply));
      });
    });

    describe('asset ignored during absorption when liquidateCF = 0 and liquidationF = 0', function () {
      /*
       * Full de-listing: both liquidateCF and liquidationFactor are zero.
       *
       * Key factor roles in absorption (borrowCollateralFactor plays no role here):
       *   - LCF = 0: the asset contributes no coverage; isLiquidatableInternal skips price
       *              fetching, so assetPrices[i] stays 0.
       *   - LF  = 0: absorbInternal skips seizure entirely — no price lookup, no collateral
       *              transfer; the balance remains in the user's protocol account.
       *   - borrowCF: governs only isBorrowCollateralized (new-borrow gate); irrelevant to
       *               isLiquidatable and absorb.
       *
       * Flow:
       *    When LCF = 0 and LF = 0:
       *    - Collateral is NOT seized: Alice's COMP collateral remains in the user's protocol account
       *    - AbsorbCollateral event is NOT emitted (asset is skipped entirely during absorption)
       *    - User collateral balance remains unchanged (same as before absorption)
       *    - totalsCollateral.totalSupplyAsset remains unchanged
       *    - User's assetsIn is reset to 0 even though collateral was not seized
       *    - User principal is not offset by collateral value — deltaBalance = 0, full debt remains
       *    - New balance is clamped to 0; debt is fully absorbed by protocol reserves
       *    - AbsorbDebt event is emitted (full debt absorbed by reserves)
       *    - Total borrow base is reduced by the repay amount
       *    - Transfer event is NOT emitted (new principal clamps to 0, no supply side created)
       *    - Comet ERC20 collateral balance is unchanged (tokens stay locked in comet)
       *    - Collateral reserves unchanged (no seizure occurred)
       */
      let cometBaseTokenBalanceBefore: BigNumber;
      let cometCompBalanceBefore: BigNumber;
      let cometCompReservesBefore: BigNumber;
      let computedDeltaBalance: bigint;
      let computedNewBalance: bigint;
      let computedRepayAmount: bigint;

      before(async () => {
        await snapshot.restore();
        cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
        cometCompBalanceBefore = await compToken.balanceOf(comet.address);
        cometCompReservesBefore = await comet.getCollateralReserves(compToken.address);
      });

      it('borrowCollateralFactor, liquidateCollateralFactor and liquidationFactor can be updated to 0', async () => {
        await configurator.updateAssetBorrowCollateralFactor(cometProxyAddress, compToken.address, 0n);
        await configurator.updateAssetLiquidateCollateralFactor(cometProxyAddress, compToken.address, 0n);
        await configurator.updateAssetLiquidationFactor(cometProxyAddress, compToken.address, 0n);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);
      });

      it('liquidateCollateralFactor is 0 after upgrade', async () => {
        expect((await comet.getAssetInfoByAddress(compToken.address)).liquidateCollateralFactor).to.equal(0);
      });

      it('liquidationFactor is 0 after upgrade', async () => {
        expect((await comet.getAssetInfoByAddress(compToken.address)).liquidationFactor).to.equal(0);
      });

      it('alice is liquidatable with zero liquidateCollateralFactor and zero liquidationFactor', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.true;
      });

      it('absorbs is successful', async () => {
        liquidationTx = await comet.connect(bob).absorb(bob.address, [alice.address]);
        expect(liquidationTx).to.not.be.reverted;
      });

      it('does not emit AbsorbCollateral event', async () => {
        expect(liquidationTx).to.not.emit(comet, 'AbsorbCollateral');
      });

      it('does not affect user collateral balance', async () => {
        expect((await comet.userCollateral(alice.address, compToken.address)).balance).to.equal(userCollateralBeforeAbsorption);
      });

      it('does not affect totals supply of the asset', async () => {
        expect((await comet.totalsCollateral(compToken.address)).totalSupplyAsset).to.equal(totalsSupplyAssetBeforeAbsorption);
      });

      it('resets user assetsIn to 0 even though collateral was not seized', async () => {
        // absorbInternal always resets assetsIn regardless of liquidationFactor
        expect((await comet.userBasic(alice.address)).assetsIn).to.equal(0);
        expect((await comet.userBasic(alice.address))._reserved).to.equal(0);
      });

      it('deltaBalance is 0 when deltaValue is 0', () => {
        // asset skipped in absorbInternal (LF = 0) → deltaValue = 0 → deltaBalance = divPrice(0, price, scale) = 0
        computedDeltaBalance = divPrice(0n, basePrice, baseScale);
        expect(computedDeltaBalance).to.equal(0n);
      });

      it('new balance is clamped to 0 from the negative old borrow balance', () => {
        // oldBalance < 0, deltaBalance = 0 → unclamped = oldBalance (still negative) → clamped to 0
        const unclamped = oldBalance + computedDeltaBalance;
        expect(unclamped < 0).to.be.true;
        computedNewBalance = 0n;
      });

      it('new principal is 0 and matches stored principal', async () => {
        const totalsBasic = await cometExt.totalsBasic();
        newPrincipal = principalValue(computedNewBalance, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
        expect(newPrincipal).to.equal(0n);
        expect((await comet.userBasic(alice.address)).principal).to.equal(0n);
      });

      it('repay amount equals the absorbed borrow', () => {
        // repayAmount = newPrincipal - oldPrincipal = 0 - oldPrincipal = -oldPrincipal > 0
        computedRepayAmount = newPrincipal - oldPrincipal;
        expect(computedRepayAmount > 0n).to.be.true;
      });

      it('supply amount is 0 since new principal does not exceed 0', () => {
        // supplyAmount = 0 when newPrincipal <= 0 (see repayAndSupplyAmount)
        expect(newPrincipal <= 0n).to.be.true;
      });

      it('totalSupplyBase is unchanged after absorption', async () => {
        const current = await cometExt.totalsBasic();
        expect(current.totalSupplyBase).to.equal(totalSupplyBase);
      });

      it('totalBorrowBase is reduced by repay amount after absorption', async () => {
        const current = await cometExt.totalsBasic();
        expect(current.totalBorrowBase).to.equal(totalBorrowBase.toBigInt() - computedRepayAmount);
      });

      it('emits AbsorbDebt event', async () => {
        // basePaidOut = computedNewBalance - oldBalance = 0 - oldBalance = -oldBalance (full debt absorbed by reserves)
        const basePaidOut = computedNewBalance - oldBalance;
        const valueOfBasePaidOut = mulPrice(basePaidOut, basePrice, baseScale);
        expect(liquidationTx).to.emit(comet, 'AbsorbDebt').withArgs(bob.address, alice.address, basePaidOut, valueOfBasePaidOut);
      });

      it('Transfer event is not emitted', async () => {
        expect(liquidationTx).to.not.emit(comet, 'Transfer');
      });

      it('comet base token ERC20 balance is unchanged after absorption', async () => {
        // absorb does not transfer base tokens; debt absorption is an accounting change only
        expect(await baseToken.balanceOf(comet.address)).to.equal(cometBaseTokenBalanceBefore);
      });

      it('comet collateral token ERC20 balance is unchanged after absorption', async () => {
        // collateral was not seized; tokens remain in the protocol account, still locked in comet
        expect(await compToken.balanceOf(comet.address)).to.equal(cometCompBalanceBefore);
      });

      it('comet collateral reserves are unchanged after absorption', async () => {
        // no seizure occurred; getCollateralReserves = balanceOf(comet) - totalSupplyAsset remains the same
        expect(await comet.getCollateralReserves(compToken.address)).to.equal(cometCompReservesBefore);
      });
    });

    describe('24 collateral assets', function () {
      for (let i = 1; i <= MAX_ASSETS; i++) {
        it(`skips absorption of asset ${i - 1} with liquidation factor = 0 with collaterals ${i}`, async () => {
        /**
         * This parameterized test verifies that absorb skips assets with liquidation factor = 0.
         * For each iteration (i = 1 to 24), it tests asset i-1 in a protocol with i total collaterals.
         * The test: (1) supplies collateral and borrows to make the account liquidatable,
         * (2) sets the target asset's liquidation factor to 0, (3) calls absorb, and
         * (4) verifies that the target asset is skipped (user collateral balance and totalsCollateral totalSupplyAsset remain unchanged).
         */

          const targetSymbol = `ASSET${i - 1}`;
          const targetToken = tokens24Assets[targetSymbol];

          // Supply, borrow, and make liquidatable
          const supplyAmount = exp(1, 18);
          await targetToken.allocateTo(underwater24Assets.address, supplyAmount);
          await targetToken.connect(underwater24Assets).approve(comet24Assets.address, supplyAmount);
          await comet24Assets.connect(underwater24Assets).supply(targetToken.address, supplyAmount);

          const borrowAmount = exp(150, 6);
          await baseToken24Assets.allocateTo(comet24Assets.address, borrowAmount);
          await comet24Assets.connect(underwater24Assets).withdraw(baseToken24Assets.address, borrowAmount);

          // Drop price of token to make liquidatable
          await priceFeeds24Assets[targetSymbol].setRoundData(0, 100, 0, 0, 0);

          expect(await comet24Assets.isLiquidatable(underwater24Assets.address)).to.be.true;

          // Step 3: Update liquidationFactor to 0 for target asset
          await configuratorProxy24Assets.updateAssetLiquidationFactor(comet24Assets.address, targetToken.address, exp(0, 18));

          // Upgrade proxy again after updating liquidationFactor
          await proxyAdmin24Assets.deployAndUpgradeTo(configuratorProxy24Assets.address, comet24Assets.address);

          // Verify liquidationFactor is 0
          expect((await comet24Assets.getAssetInfoByAddress(targetToken.address)).liquidationFactor).to.equal(0);

          // Step 4: Save balances before absorb
          const userCollateralBefore = (await comet24Assets.userCollateral(underwater24Assets.address, targetToken.address)).balance;
          const totalsBefore = (await comet24Assets.totalsCollateral(targetToken.address)).totalSupplyAsset;

          expect(userCollateralBefore).to.equal(supplyAmount);
          expect(totalsBefore).to.equal(supplyAmount);

          // Step 5: Absorb should skip this asset (no seizure) and balances remain unchanged
          await comet24Assets.connect(absorber24Assets).absorb(absorber24Assets.address, [underwater24Assets.address]);

          // Verify balances remain unchanged
          expect((await comet24Assets.userCollateral(underwater24Assets.address, targetToken.address)).balance).to.equal(userCollateralBefore);
          expect((await comet24Assets.totalsCollateral(targetToken.address)).totalSupplyAsset).to.equal(totalsBefore);
        });
      }
    });

    describe('edge cases', function () {
      it('absorbs with mixed liquidation factors and skips zeroed assets', async () => {
        /**
         * This test checks that when there are five collateral assets with mixed liquidation factors,
         * the absorb function only seizes (liquidates) those assets whose liquidationFactor is nonzero,
         * and skips assets whose liquidationFactor is zero (leaving their balances unchanged after absorb).
         * It sets up the protocol, configures various assets, updates some to have zero liquidation factor,
         * and verifies that 'absorb' seizes only the correct collateral, without affecting those set to be skipped.
         */
  
        await snapshot.restore();
  
        // Supply, borrow, and make liquidatable
        const supplyAmount = exp(1, 18);
        const targetSymbols = ['ASSET0', 'ASSET1', 'ASSET2', 'ASSET3', 'ASSET4'];
        for (const sym of targetSymbols) {
          const token = tokens24Assets[sym];
          await token.allocateTo(underwater24Assets.address, supplyAmount);
          await token.connect(underwater24Assets).approve(comet24Assets.address, supplyAmount);
          await comet24Assets.connect(underwater24Assets).supply(token.address, supplyAmount);
        }
  
        const borrowAmount = exp(500, 6);
        await baseToken24Assets.allocateTo(comet24Assets.address, borrowAmount);
        await comet24Assets.connect(underwater24Assets).withdraw(baseToken24Assets.address, borrowAmount);
  
        // Drop price of all tokens to make liquidatable
        for (const sym of targetSymbols) {
          await priceFeeds24Assets[sym].setRoundData(0, 100, 0, 0, 0);
        }
  
        expect(await comet24Assets.isLiquidatable(underwater24Assets.address)).to.be.true;
  
        // Update liquidationFactor to 0 for three assets (ASSET1, ASSET3, ASSET4)
        const zeroLfSymbols = ['ASSET1', 'ASSET3', 'ASSET4'];
        for (const sym of zeroLfSymbols) {
          await configuratorProxy24Assets.updateAssetLiquidationFactor(comet24Assets.address, tokens24Assets[sym].address, exp(0, 18));
        }
  
        // Upgrade proxy again after updating liquidationFactor
        await proxyAdmin24Assets.deployAndUpgradeTo(configuratorProxy24Assets.address, comet24Assets.address);
  
        // Save balances before absorb for two categories
        // - Should be seized: ASSET0, ASSET2
        // - Should be skipped (unchanged): ASSET1, ASSET3, ASSET4
        const userBefore: Record<string, BigNumber> = {} as any;
        const totalsBefore: Record<string, BigNumber> = {} as any;
        for (const sym of ['ASSET0', 'ASSET1', 'ASSET2', 'ASSET3', 'ASSET4']) {
          userBefore[sym] = (await comet24Assets.userCollateral(underwater24Assets.address, tokens24Assets[sym].address)).balance;
          totalsBefore[sym] = (await comet24Assets.totalsCollateral(tokens24Assets[sym].address)).totalSupplyAsset;
          expect(userBefore[sym]).to.equal(supplyAmount);
          expect(totalsBefore[sym]).to.equal(supplyAmount);
        }
  
        // Absorb - should skip assets with LF = 0
        await comet24Assets.connect(absorber24Assets).absorb(absorber24Assets.address, [underwater24Assets.address]);
  
        // Verify skipped assets remain unchanged
        for (const sym of ['ASSET1', 'ASSET3', 'ASSET4']) {
          expect((await comet24Assets.userCollateral(underwater24Assets.address, tokens24Assets[sym].address)).balance).to.equal(userBefore[sym]);
          expect((await comet24Assets.totalsCollateral(tokens24Assets[sym].address)).totalSupplyAsset).to.equal(totalsBefore[sym]);
        }
  
        // Verify seized assets set user balance to 0 and reduce totals
        for (const sym of ['ASSET0', 'ASSET2']) {
          expect((await comet24Assets.userCollateral(underwater24Assets.address, tokens24Assets[sym].address)).balance).to.equal(0);
          expect((await comet24Assets.totalsCollateral(tokens24Assets[sym].address)).totalSupplyAsset).to.equal(0);
        }
      });
    });

    describe('revert on price feed side', function () {
      /*
       * This test suite reproduces the "price feed paralysis" edge case on top of the
       * Comet/Configurator deployment and user positions that are already set up in the
       * outer `before` block.
       *
       * At the point we enter this `describe`, Alice already has a borrow position that is
       * liquidatable under normal (non-reverting) price feeds; this suite does NOT open that
       * position, it just reuses it.
       *
       * The tests then walk through the problematic sequence:
       * 1. Assert that Alice is liquidatable with the normal COMP price feed.
       * 2. Have governance update COMP's price feed to `PriceFeedWithRevert`, which always
       *    reverts on `latestRoundData`, and verify that the feed address on Comet changed.
       * 3. Show that any call that needs the COMP price (`isLiquidatable`, `isBorrowCollateralized`,
       *    or `absorb`) now reverts with the `Reverted` custom error, effectively freezing
       *    liquidations for that collateral.
       * 4. Finally, revert the price feed back to the normal implementation and verify that
       *    the same calls succeed again, demonstrating that the paralysis is solely due to
       *    the reverting price feed.
       *
       * Each `it` in this `describe` advances the shared state one step on top of the common
       * baseline snapshot: from "liquidatable and working normally" → "paralyzed by a reverting
       * price feed" → "recovered after restoring a healthy feed".
       */
      let priceFeedWithRevert: PriceFeedWithRevert;
      before(async () => {
        // Start from the common baseline state for this suite
        await snapshot.restore();

        const PriceFeedWithRevert = await ethers.getContractFactory('PriceFeedWithRevert') as PriceFeedWithRevert__factory;
        priceFeedWithRevert = await PriceFeedWithRevert.deploy(100, 8);
        await priceFeedWithRevert.deployed();
      });

      it('alice is liquidable', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.be.true;
      });

      it('governance updates price feed to reverting implementation', async () => {
        await configurator.updateAssetPriceFeed(cometProxyAddress, compToken.address, priceFeedWithRevert.address);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);
      });

      it('price feed updated to reverting implementation', async () => {
        expect((await comet.getAssetInfoByAddress(compToken.address)).priceFeed).to.equal(priceFeedWithRevert.address);
      });

      it('isLiquidatable now reverts due to reverting price feed', async () => {
        await expect(comet.isLiquidatable(alice.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
      });

      it('isBorrowCollateralized now reverts due to reverting price feed', async () => {
        await expect(comet.isBorrowCollateralized(alice.address)).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
      });

      it('absorb reverts when collateral price cannot be fetched', async () => {
        await expect(
          comet.connect(bob).absorb(bob.address, [alice.address])
        ).to.be.revertedWithCustomError(priceFeedWithRevert, 'Reverted');
      });

      it('governance updates price feed to normal implementation', async () => {
        await configurator.updateAssetPriceFeed(cometProxyAddress, compToken.address, compPriceFeed.address);
        await proxyAdmin.deployAndUpgradeTo(configuratorProxy.address, cometProxyAddress);
      });

      it('price feed updated to normal implementation', async () => {
        expect((await comet.getAssetInfoByAddress(compToken.address)).priceFeed).to.equal(compPriceFeed.address);
      });

      it('isLiquidatable now does not revert', async () => {
        expect(await comet.isLiquidatable(alice.address)).to.not.be.reverted;
      });

      it('isBorrowCollateralized now does not revert', async () => {
        expect(await comet.isBorrowCollateralized(alice.address)).to.not.be.reverted;
      });

      it('absorb does not revert', async () => {
        await expect(comet.connect(bob).absorb(bob.address, [alice.address])).to.not.be.reverted;
      });
    });
  });
});
