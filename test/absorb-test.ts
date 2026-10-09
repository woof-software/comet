import { MaxUint256, ZeroAddress } from 'ethers';
import type { ContractTransactionResponse, EventLog } from 'ethers';
import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import type { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from '../build/types/index.js';
import { event, expect, exp, factor, defaultAssets, makeProtocol, mulPrice, portfolio, totalsAndReserves, wait, bumpTotalsCollateral, setTotalsBasic } from './helpers.js';
import { mulFactor, divPrice, presentValue, principalValue, presentValueSupply } from './helpers/math.js';

function expectApproximately(actual: bigint, expected: bigint, tolerance: bigint): void {
  const difference = actual >= expected ? actual - expected : expected - actual;
  expect(difference <= tolerance).to.equal(true, `difference ${difference} exceeds tolerance ${tolerance}`);
}

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
describe('absorb', function () {
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
  let protocol: Awaited<ReturnType<typeof makeProtocol>>; // Store protocol to access more users
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

    baseScale = (await comet.baseScale());
  });

  describe('setup: alice becomes underwater', function () {
    it('dave supplies base token to allow borrowing', async () => {
      await baseToken.connect(dave).approve((await comet.getAddress()), DAVE_BASE_SUPPLY_AMOUNT);
      await comet.connect(dave).supply((await baseToken.getAddress()), DAVE_BASE_SUPPLY_AMOUNT);
    });

    it('alice supplies collateral and make borrow position', async () => {
      await collaterals['COMP'].connect(alice).approve((await comet.getAddress()), COLLATERAL_AMOUNT); // $100 worth
      await comet.connect(alice).supplyTo(alice.address, (await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT);

      await comet.connect(alice).withdraw((await baseToken.getAddress()), BORROW_AMOUNT);
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
    let totalsCollateralBefore: bigint;
    let absorbTx: ContractTransactionResponse;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let collateralReservesBefore: bigint;
    let deltaValue: bigint;
    let oldBalance: bigint;
    let newBalance: bigint;

    before(async () => {
      const principal = (await comet.userBasic(alice.address)).principal;
      const totalsBasic = await comet.totalsBasic();
      oldBalance = presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex);
    });

    it('alice collateral balance is equal to supplied amount', async () => {
      const collateralBalance = await comet.collateralBalanceOf(alice.address, (await collaterals['COMP'].getAddress()));
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
      totalsCollateralBefore = (await comet.totalsCollateral((await collaterals['COMP'].getAddress()))).totalSupplyAsset;
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
      collateralReservesBefore = await comet.getCollateralReserves((await collaterals['COMP'].getAddress()));
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
        .withArgs(absorber.address, alice.address, (await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT, value);
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
      expect(await comet.collateralBalanceOf(alice.address, (await collaterals['COMP'].getAddress()))).to.be.equal(0);
    });

    it('comet collateral reserves are increased by absorb amount', async () => {
      expect(await comet.getCollateralReserves((await collaterals['COMP'].getAddress()))).to.be.equal((collateralReservesBefore + COLLATERAL_AMOUNT));
    });

    it('comet total supply collateral is decreased by collateral amount', async () => {
      expect((await comet.totalsCollateral((await collaterals['COMP'].getAddress()))).totalSupplyAsset).to.be.equal((totalsCollateralBefore - COLLATERAL_AMOUNT));
    });

    it('resets assetsIn and reserved to 0', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    it('comet total supply base is not changed', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.be.equal(totalSupplyBaseBefore);
    });

    it('comet total borrow base deacreased by borrow amount', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.be.equal((totalBorrowBaseBefore - BORROW_AMOUNT));
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

    let compTotalsBefore: bigint;
    let wethTotalsBefore: bigint;
    let wbtcTotalsBefore: bigint;
    let compReservesBefore: bigint;
    let wethReservesBefore: bigint;
    let wbtcReservesBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let absorbTxMulti: ContractTransactionResponse;
    let oldBalanceMulti: bigint;
    let newAliceBalance: bigint;

    let baseSupplyIndexBefore: bigint;
    let baseBorrowIndexBefore: bigint;

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
      await baseToken.connect(dave).approve((await comet.getAddress()), DAVE_BASE_SUPPLY_AMOUNT);
      await comet.connect(dave).supply((await baseToken.getAddress()), DAVE_BASE_SUPPLY_AMOUNT);

      // Allocate COMP, WETH, and WBTC collateral to alice
      await collaterals['COMP'].allocateTo(alice.address, COLLATERAL_AMOUNT_COMP);
      await collaterals['WETH'].allocateTo(alice.address, COLLATERAL_AMOUNT_WETH);
      await collaterals['WBTC'].allocateTo(alice.address, COLLATERAL_AMOUNT_WBTC);

      // Approve and supply all three collaterals
      await collaterals['COMP'].connect(alice).approve((await comet.getAddress()), COLLATERAL_AMOUNT_COMP);
      await collaterals['WETH'].connect(alice).approve((await comet.getAddress()), COLLATERAL_AMOUNT_WETH);
      await collaterals['WBTC'].connect(alice).approve((await comet.getAddress()), COLLATERAL_AMOUNT_WBTC);

      await comet.connect(alice).supplyTo(alice.address, (await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT_COMP);
      await comet.connect(alice).supplyTo(alice.address, (await collaterals['WETH'].getAddress()), COLLATERAL_AMOUNT_WETH);
      await comet.connect(alice).supplyTo(alice.address, (await collaterals['WBTC'].getAddress()), COLLATERAL_AMOUNT_WBTC);

      // Borrow against the collateral
      await comet.connect(alice).withdraw((await baseToken.getAddress()), BORROW_AMOUNT);

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

      compTotalsBefore = (await comet.totalsCollateral((await collaterals['COMP'].getAddress()))).totalSupplyAsset;
      wethTotalsBefore = (await comet.totalsCollateral((await collaterals['WETH'].getAddress()))).totalSupplyAsset;
      wbtcTotalsBefore = (await comet.totalsCollateral((await collaterals['WBTC'].getAddress()))).totalSupplyAsset;
      compReservesBefore = await comet.getCollateralReserves((await collaterals['COMP'].getAddress()));
      wethReservesBefore = await comet.getCollateralReserves((await collaterals['WETH'].getAddress()));
      wbtcReservesBefore = await comet.getCollateralReserves((await collaterals['WBTC'].getAddress()));

      baseSupplyIndexBefore = totalsBasic.baseSupplyIndex;
      baseBorrowIndexBefore = totalsBasic.baseBorrowIndex;
    });

    it('alice has COMP, WETH, and WBTC collateral supplied', async () => {
      expect(await comet.collateralBalanceOf(alice.address, (await collaterals['COMP'].getAddress()))).to.be.equal(COLLATERAL_AMOUNT_COMP);
      expect(await comet.collateralBalanceOf(alice.address, (await collaterals['WETH'].getAddress()))).to.be.equal(COLLATERAL_AMOUNT_WETH);
      expect(await comet.collateralBalanceOf(alice.address, (await collaterals['WBTC'].getAddress()))).to.be.equal(COLLATERAL_AMOUNT_WBTC);
    });

    it('alice borrow balance is equal to borrowed amount', async () => {
      expectApproximately(await comet.borrowBalanceOf(alice.address), BORROW_AMOUNT, 1n);
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
      let compOffset: bigint | null = null;
      let wethOffset: bigint | null = null;
      let wbtcOffset: bigint | null = null;

      for (let i = 0; i < numAssets; i++) {
        const info = await comet.getAssetInfo(i);
        if (info.asset.toLowerCase() === (await collaterals['COMP'].getAddress()).toLowerCase()) {
          compOffset = info.offset;
        } else if (info.asset.toLowerCase() === (await collaterals['WETH'].getAddress()).toLowerCase()) {
          wethOffset = info.offset;
        } else if (info.asset.toLowerCase() === (await collaterals['WBTC'].getAddress()).toLowerCase()) {
          wbtcOffset = info.offset;
        }
      }

      // Calculate expected bitmask value
      const expectedAssetsIn = (1n << compOffset!) | (1n << wethOffset!) | (1n << wbtcOffset!);

      // Verify the bitmask matches expected value
      const actualAssetsIn = (await comet.userBasic(alice.address)).assetsIn;
      expect(actualAssetsIn).to.be.equal(expectedAssetsIn);
    });

    it('alice reserved is equal to 0', async () => {
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    it('alice asset list contains COMP, WETH, and WBTC', async () => {
      const assetList = await comet.getAssetList(alice.address);
      expect(assetList).to.include((await collaterals['COMP'].getAddress()));
      expect(assetList).to.include((await collaterals['WETH'].getAddress()));
      expect(assetList).to.include((await collaterals['WBTC'].getAddress()));
      expect(assetList.length).to.be.equal(3);
    });

    it('comet total supplied collateral amounts are equal to alice supplied amounts', async () => {
      expect(compTotalsBefore).to.be.equal(COLLATERAL_AMOUNT_COMP);
      expect(wethTotalsBefore).to.be.equal(COLLATERAL_AMOUNT_WETH);
      expect(wbtcTotalsBefore).to.be.equal(COLLATERAL_AMOUNT_WBTC);
    });

    it('comet total supply base is equal to dave supplied amount', async () => {
      const expectedTotalSupply = (totalSupplyBaseBefore + DAVE_BASE_SUPPLY_AMOUNT);
      totalSupplyBaseBefore = (await comet.totalsBasic()).totalSupplyBase;
      expectApproximately(totalSupplyBaseBefore, expectedTotalSupply, 2n); // possible precision loss
    });

    it('comet total borrow base is equal to alice borrowed amount', async () => {
      const expectedTotalBorrow = (totalBorrowBaseBefore + BORROW_AMOUNT);
      totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      expectApproximately(totalBorrowBaseBefore, expectedTotalBorrow, 2n); // possible precision loss
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
        .withArgs(absorber.address, alice.address, (await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT_COMP, compValue)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, (await collaterals['WETH'].getAddress()), COLLATERAL_AMOUNT_WETH, wethValue)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, alice.address, (await collaterals['WBTC'].getAddress()), COLLATERAL_AMOUNT_WBTC, wbtcValue);
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
      expectApproximately((await comet.userBasic(alice.address)).principal, newAlicePrincipal, 2n); // possible precision loss
    });

    it('Transfer event is emitted', async () => {
      const receipt = await absorbTxMulti.wait();
      if (!receipt) throw new Error('Absorb transaction receipt not found');
      const cometAddress = await comet.getAddress();
      const transferEvent = receipt.logs.find((log): log is EventLog =>
        log.address.toLowerCase() === cometAddress.toLowerCase() &&
        'args' in log && log.fragment.name === 'Transfer'
      );
      if (!transferEvent) throw new Error('Transfer event not found');

      expect(transferEvent).to.not.be.undefined;

      const transferFrom = transferEvent.args.from;
      const transferTo = transferEvent.args.to;
      const transferAmount = transferEvent.args.amount;

      expect(transferFrom).to.be.equal(ZeroAddress);
      expect(transferTo).to.be.equal(alice.address);
      expectApproximately(transferAmount, presentValueSupply(baseSupplyIndexBefore, newAlicePrincipal), 2n);
    });

    it('alice collateral balances become 0', async () => {
      expect(await comet.collateralBalanceOf(alice.address, (await collaterals['COMP'].getAddress()))).to.be.equal(0);
      expect(await comet.collateralBalanceOf(alice.address, (await collaterals['WETH'].getAddress()))).to.be.equal(0);
      expect(await comet.collateralBalanceOf(alice.address, (await collaterals['WBTC'].getAddress()))).to.be.equal(0);
    });

    it('comet collateral reserves are increased by absorb amounts', async () => {
      expect(await comet.getCollateralReserves((await collaterals['COMP'].getAddress()))).to.be.equal((compReservesBefore + COLLATERAL_AMOUNT_COMP));
      expect(await comet.getCollateralReserves((await collaterals['WETH'].getAddress()))).to.be.equal((wethReservesBefore + COLLATERAL_AMOUNT_WETH));
      expect(await comet.getCollateralReserves((await collaterals['WBTC'].getAddress()))).to.be.equal((wbtcReservesBefore + COLLATERAL_AMOUNT_WBTC));
    });

    it('comet total supply collateral is decreased by collateral amounts', async () => {
      expect((await comet.totalsCollateral((await collaterals['COMP'].getAddress()))).totalSupplyAsset).to.be.equal((compTotalsBefore - COLLATERAL_AMOUNT_COMP));
      expect((await comet.totalsCollateral((await collaterals['WETH'].getAddress()))).totalSupplyAsset).to.be.equal((wethTotalsBefore - COLLATERAL_AMOUNT_WETH));
      expect((await comet.totalsCollateral((await collaterals['WBTC'].getAddress()))).totalSupplyAsset).to.be.equal((wbtcTotalsBefore - COLLATERAL_AMOUNT_WBTC));
    });

    it('resets assetsIn and reserved to 0', async () => {
      expect((await comet.userBasic(alice.address)).assetsIn).to.be.equal(0);
      expect((await comet.userBasic(alice.address))._reserved).to.be.equal(0);
    });

    it('alice asset list is empty', async () => {
      expect(await comet.getAssetList(alice.address)).to.be.empty;
    });

    it('comet total supply base increased by alice new principal', async () => {
      expectApproximately((await comet.totalsBasic()).totalSupplyBase, (totalSupplyBaseBefore + newAlicePrincipal), 2n);
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
    let compTotalsBefore: bigint;
    let compReservesBefore: bigint;
    let totalSupplyBaseBefore: bigint;
    let totalBorrowBaseBefore: bigint;
    let absorbTxMultiple: ContractTransactionResponse;
    let oldBalanceUser1: bigint;
    let oldBalanceUser2: bigint;
    let oldBalanceUser3: bigint;

    let users: SignerWithAddress[] = [];

    let newBalanceUser1: bigint;
    let newBalanceUser2: bigint;
    let newBalanceUser3: bigint;

    let newTotalSupply: bigint;

    let compValue: bigint;

    before(async () => {
      // WIthdraw all base tokens from Alice to make sure it has no balance
      await comet.connect(alice).withdraw((await baseToken.getAddress()), MaxUint256);

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
      await baseToken.connect(dave).approve((await comet.getAddress()), DAVE_BASE_SUPPLY_AMOUNT);
      await comet.connect(dave).supply((await baseToken.getAddress()), DAVE_BASE_SUPPLY_AMOUNT);

      for (const user of users) {
        await collaterals['COMP'].allocateTo(user.address, COLLATERAL_AMOUNT_PER_USER);
        await collaterals['COMP'].connect(user).approve((await comet.getAddress()), COLLATERAL_AMOUNT_PER_USER);
        await comet.connect(user).supplyTo(user.address, (await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT_PER_USER);
        await comet.connect(user).withdraw((await baseToken.getAddress()), BORROW_AMOUNT_PER_USER);
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

      compTotalsBefore = (await comet.totalsCollateral((await collaterals['COMP'].getAddress()))).totalSupplyAsset;
      compReservesBefore = await comet.getCollateralReserves((await collaterals['COMP'].getAddress()));
    });

    it('all three users have COMP collateral supplied', async () => {
      expect(await comet.collateralBalanceOf(user1.address, (await collaterals['COMP'].getAddress()))).to.be.equal(COLLATERAL_AMOUNT_PER_USER);
      expect(await comet.collateralBalanceOf(user2.address, (await collaterals['COMP'].getAddress()))).to.be.equal(COLLATERAL_AMOUNT_PER_USER);
      expect(await comet.collateralBalanceOf(user3.address, (await collaterals['COMP'].getAddress()))).to.be.equal(COLLATERAL_AMOUNT_PER_USER);
    });

    it('all three users have borrow positions', async () => {
      expectApproximately(await comet.borrowBalanceOf(user1.address), BORROW_AMOUNT_PER_USER, 1n);
      expectApproximately(await comet.borrowBalanceOf(user2.address), BORROW_AMOUNT_PER_USER, 1n);
      expectApproximately(await comet.borrowBalanceOf(user3.address), BORROW_AMOUNT_PER_USER, 1n);
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
      const expectedTotalSupply = (totalSupplyBaseBefore + DAVE_BASE_SUPPLY_AMOUNT);
      newTotalSupply = (await comet.totalsBasic()).totalSupplyBase;
      expectApproximately(newTotalSupply, expectedTotalSupply, 10n);
    });

    it('comet total borrow base is equal to sum of all users borrows', async () => {
      const expectedTotalBorrow = (totalBorrowBaseBefore + BORROW_AMOUNT_PER_USER * 3n);
      const actualTotalBorrow = (await comet.totalsBasic()).totalBorrowBase;
      expectApproximately(actualTotalBorrow, expectedTotalBorrow, 5n); // possible rounding loss
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
        .withArgs(absorber.address, user1.address, (await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT_PER_USER, compValue)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, user2.address, (await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT_PER_USER, compValue)
        .to.emit(comet, 'AbsorbCollateral')
        .withArgs(absorber.address, user3.address, (await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT_PER_USER, compValue);
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
      expect(await comet.collateralBalanceOf(user1.address, (await collaterals['COMP'].getAddress()))).to.be.equal(0);
      expect(await comet.collateralBalanceOf(user2.address, (await collaterals['COMP'].getAddress()))).to.be.equal(0);
      expect(await comet.collateralBalanceOf(user3.address, (await collaterals['COMP'].getAddress()))).to.be.equal(0);
    });

    it('comet collateral reserves are increased by all absorbed amounts', async () => {
      const expectedReserves = (compReservesBefore + COLLATERAL_AMOUNT_PER_USER * 3n);
      expect(await comet.getCollateralReserves((await collaterals['COMP'].getAddress()))).to.be.equal(expectedReserves);
    });

    it('comet total supply collateral is decreased by all collateral amounts', async () => {
      const expectedTotal = (compTotalsBefore - COLLATERAL_AMOUNT_PER_USER * 3n);
      expect((await comet.totalsCollateral((await collaterals['COMP'].getAddress()))).totalSupplyAsset).to.be.equal(expectedTotal);
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
    let liquidatorPoints: Awaited<ReturnType<CometHarnessInterfaceExtendedAssetList['liquidatorPoints']>>;
    let newLiquidatorPoints: Awaited<ReturnType<CometHarnessInterfaceExtendedAssetList['liquidatorPoints']>>;

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
      await baseToken.connect(dave).approve((await comet.getAddress()), DAVE_BASE_SUPPLY_AMOUNT);
      await comet.connect(dave).supply((await baseToken.getAddress()), DAVE_BASE_SUPPLY_AMOUNT);

      // Setup testUser1: supply collateral and borrow
      const collateral = collaterals['COMP'];
      await collateral.allocateTo(testUser1.address, COLLATERAL_AMOUNT);
      await collateral.connect(testUser1).approve((await comet.getAddress()), COLLATERAL_AMOUNT);
      await comet.connect(testUser1).supplyTo(testUser1.address, (await collateral.getAddress()), COLLATERAL_AMOUNT);
      await comet.connect(testUser1).withdraw((await baseToken.getAddress()), BORROW_AMOUNT);

      // Setup testUser2: supply collateral and borrow
      await collateral.allocateTo(testUser2.address, COLLATERAL_AMOUNT);
      await collateral.connect(testUser2).approve((await comet.getAddress()), COLLATERAL_AMOUNT);
      await comet.connect(testUser2).supplyTo(testUser2.address, (await collateral.getAddress()), COLLATERAL_AMOUNT);
      await comet.connect(testUser2).withdraw((await baseToken.getAddress()), BORROW_AMOUNT);

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
      expect(newLiquidatorPoints.numAbsorbs).to.be.equal(liquidatorPoints.numAbsorbs + 1n);
    });

    it('first absorb increments numAbsorbed by number of accounts', async () => {
      expect(newLiquidatorPoints.numAbsorbed).to.be.equal((liquidatorPoints.numAbsorbed + 1n));
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
      expect(newLiquidatorPoints.numAbsorbs).to.be.equal(liquidatorPoints.numAbsorbs + 1n);
    });

    it('second absorb increments numAbsorbed by 1 again', async () => {
      expect(newLiquidatorPoints.numAbsorbed).to.be.equal((liquidatorPoints.numAbsorbed + 1n));
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
        expect(newLiquidatorPoints.numAbsorbs).to.be.equal(liquidatorPoints.numAbsorbs + 1n);
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

    describe('total borrows underflow', function () {
      // Fresh protocol so totalBorrowBase is 0 while the underwater user has a negative principal
      let underflowComet: CometHarnessInterfaceExtendedAssetList;
      let underflowAbsorber: SignerWithAddress;
      let underwater: SignerWithAddress;

      before(async () => {
        const underflowProtocol = await makeProtocol();
        underflowComet = underflowProtocol.cometWithExtendedAssetList;
        [underflowAbsorber, underwater] = underflowProtocol.users;

        await underflowComet.setBasePrincipal(underwater.address, -100);
      });

      it('total borrow base is zero', async () => {
        expect((await underflowComet.totalsBasic()).totalBorrowBase).to.be.equal(0);
      });

      it('reverts if total borrows underflows', async () => {
        await expect(underflowComet.absorb(underflowAbsorber.address, [underwater.address])).to.be.revertedWithPanic(0x11);
      });
    });
  });

  describe('edge cases', function () {
    describe('price feed deprecation can not absorb user immidiately', function () {
      const COLLATERAL_AMOUNT: bigint = exp(1, 18);
      const BORROW_AMOUNT: bigint = exp(10, baseTokenDecimals);

      it('alice supply collateral and borrow', async () => {
        await collaterals['COMP'].allocateTo(alice.address, COLLATERAL_AMOUNT);
        await collaterals['COMP'].connect(alice).approve((await comet.getAddress()), COLLATERAL_AMOUNT);
        await comet.connect(alice).supply((await collaterals['COMP'].getAddress()), COLLATERAL_AMOUNT);
        await comet.connect(alice).withdraw((await baseToken.getAddress()), BORROW_AMOUNT);
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

        let abosorbTx: ContractTransactionResponse;
        let baseSupplyIndex: bigint;
        let baseBorrowIndex: bigint;
        let newBalance: bigint;
        let newPrincipal: bigint;

        before(async () => {
          // Supply base so that borrowing is possible
          await baseToken.allocateTo((await baseTokenLender.getAddress()), BASE_TOKEN_LEND_AMOUNT);
          await baseToken.connect(baseTokenLender).approve((await comet.getAddress()), BASE_TOKEN_LEND_AMOUNT);
          await comet.connect(baseTokenLender).supply((await baseToken.getAddress()), BASE_TOKEN_LEND_AMOUNT);

          // Make Alice liquidatable
          await comp.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await comp.connect(alice).approve((await comet.getAddress()), SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(alice).supply((await comp.getAddress()), SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(alice).withdraw((await baseToken.getAddress()), BORROW_AMOUNT);

          const totalsBasic = await comet.totalsBasic();
          baseSupplyIndex = totalsBasic.baseSupplyIndex;
          baseBorrowIndex = totalsBasic.baseBorrowIndex;
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
          expectApproximately(newPrincipal, (await comet.userBasic(alice.address)).principal, 5n); // possible loss in 5 wei
        });

        it('Transfer event is emitted', async () => {
          const receipt = await abosorbTx.wait();
          if (!receipt) throw new Error('Absorb transaction receipt not found');
          const cometAddress = await comet.getAddress();
          const transferEvent = receipt.logs.find((log): log is EventLog =>
            log.address.toLowerCase() === cometAddress.toLowerCase() &&
            'args' in log && log.fragment.name === 'Transfer'
          );
          if (!transferEvent) throw new Error('Transfer event not found');

          const transferFrom = transferEvent.args.from;
          const transferTo = transferEvent.args.to;
          const transferAmount = transferEvent.args.amount;

          expect(transferFrom).to.be.equal(ZeroAddress);
          expect(transferTo).to.be.equal(alice.address);
          expectApproximately(transferAmount, presentValueSupply(baseSupplyIndex, newPrincipal), 5n);
        });

        it('alice balanceOf base is equal to new principal', async () => {
          expectApproximately(await comet.balanceOf(alice.address), newPrincipal, 5n);
        });

        it('alice borrow balance is equal to 0', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0);
        });
      });

      describe('large price drop makes user principal as 0', function () {
        const BASE_TOKEN_LEND_AMOUNT: bigint = exp(80, baseTokenDecimals);
        const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, 18);
        const BORROW_AMOUNT: bigint = BASE_TOKEN_LEND_AMOUNT;

        let abosorbTx: ContractTransactionResponse;
        let baseSupplyIndex: bigint;
        let baseBorrowIndex: bigint;
        let newBalance: bigint;
        let newPrincipal: bigint;

        before(async () => {
          // Restore comp price to 100
          await compPriceFeed.setRoundData(0, exp(compPrice, 8), 0, 0, 0);
          // Supply base so that borrowing is possible
          await baseToken.allocateTo((await baseTokenLender.getAddress()), BASE_TOKEN_LEND_AMOUNT);
          await baseToken.connect(baseTokenLender).approve((await comet.getAddress()), BASE_TOKEN_LEND_AMOUNT);
          await comet.connect(baseTokenLender).supply((await baseToken.getAddress()), BASE_TOKEN_LEND_AMOUNT);

          // Make Alice liquidatable
          await comp.allocateTo(dave.address, SUPPLY_COLLATERAL_AMOUNT);
          await comp.connect(dave).approve((await comet.getAddress()), SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(dave).supply((await comp.getAddress()), SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(dave).withdraw((await baseToken.getAddress()), BORROW_AMOUNT);

          const totalsBasic = await comet.totalsBasic();
          baseSupplyIndex = totalsBasic.baseSupplyIndex;
          baseBorrowIndex = totalsBasic.baseBorrowIndex;
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

      let absorbTx: ContractTransactionResponse;
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
        await baseToken.allocateTo((await baseTokenLender.getAddress()), BASE_TOKEN_LEND_AMOUNT);
        await baseToken.connect(baseTokenLender).approve((await comet.getAddress()), BASE_TOKEN_LEND_AMOUNT);
        await comet.connect(baseTokenLender).supply((await baseToken.getAddress()), BASE_TOKEN_LEND_AMOUNT);
      });

      it('alice supply each of collaterals', async () => {
        for (const asset in collaterals) {
          await collaterals[asset].allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await collaterals[asset].connect(alice).approve((await comet.getAddress()), SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(alice).supply((await collaterals[asset].getAddress()), SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('alice withdraw base', async () => {
        await comet.connect(alice).withdraw((await baseToken.getAddress()), BORROW_AMOUNT);
      });

      it('each collateral balance is equal to supply amount', async () => {
        for (const asset in collaterals) {
          expect(await comet.collateralBalanceOf(alice.address, (await collaterals[asset].getAddress()))).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('each collateral total supply is equal to supply amount', async () => {
        for (const asset in collaterals) {
          expect((await comet.totalsCollateral((await collaterals[asset].getAddress()))).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('each collateral reserve is equal to 0', async () => {
        for (const asset in collaterals) {
          expect(await comet.getCollateralReserves((await collaterals[asset].getAddress()))).to.equal(0);
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
          await expect(absorbTx).to.emit(comet, 'AbsorbCollateral').withArgs(absorber.address, alice.address, (await collaterals[asset].getAddress()), SUPPLY_COLLATERAL_AMOUNT, value);
        }
      });

      it('each collateral balance is equal to 0', async () => {
        for (const asset in collaterals) {
          expect(await comet.collateralBalanceOf(alice.address, (await collaterals[asset].getAddress()))).to.equal(0);
        }
      });

      it('each collateral total supply is equal to 0', async () => {
        for (const asset in collaterals) {
          expect((await comet.totalsCollateral((await collaterals[asset].getAddress()))).totalSupplyAsset).to.equal(0);
        }
      });

      it('each collateral reserve is equal to supply amount', async () => {
        for (const asset in collaterals) {
          expect(await comet.getCollateralReserves((await collaterals[asset].getAddress()))).to.equal(SUPPLY_COLLATERAL_AMOUNT);
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
});

// Preserve the existing exact-accounting and asset-list regression coverage.
describe('absorb accounting regressions', function () {
  it('reverts if total borrows underflows', async () => {
    const { cometWithExtendedAssetList : comet, users: [absorber, underwater] } = await makeProtocol();

    const _f0 = await comet.setBasePrincipal(underwater.address, -100);
    await expect(comet.absorb(absorber.address, [underwater.address])).to.be.revertedWithPanic(0x11);
  });

  it('absorbs 1 account and pays out the absorber', async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const { cometWithExtendedAssetList : comet, priceFeeds, users: [absorber, underwater] } = protocol;

    await setTotalsBasic(comet, { totalBorrowBase: 100n });

    await comet.setBasePrincipal(underwater.address, -100);

    const r0 = await comet.getReserves();

    const pA0 = await portfolio(protocol, absorber.address);
    const pU0 = await portfolio(protocol, underwater.address);

    const a0 = await wait(comet.absorb(absorber.address, [underwater.address]));

    const t1 = await comet.totalsBasic();
    const r1 = await comet.getReserves();

    const pA1 = await portfolio(protocol, absorber.address);
    const pU1 = await portfolio(protocol, underwater.address);
    const lA1 = await comet.liquidatorPoints(absorber.address);
    const lU1 = await comet.liquidatorPoints(underwater.address);

    expect(r0).to.be.equal(100n);

    expect(t1.totalSupplyBase).to.be.equal(0n);
    expect(t1.totalBorrowBase).to.be.equal(0n);
    expect(r1).to.be.equal(0n);

    expect(pA0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU0.internal).to.be.deep.equal({ COMP: 0n, USDC: -100n, WBTC: 0n, WETH: 0n });
    expect(pU0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(pA1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(lA1.numAbsorbs).to.be.equal(1n);
    expect(lA1.numAbsorbed).to.be.equal(1n);
    //expect(lA1.approxSpend).to.be.equal(1672498842684n);
    expect(lA1.approxSpend).to.be.lt(a0.receipt.gasUsed * a0.receipt.gasPrice);

    expect(lU1.numAbsorbs).to.be.equal(0n);
    expect(lU1.numAbsorbed).to.be.equal(0n);
    expect(lU1.approxSpend).to.be.equal(0n);

    const [_, usdcPrice] = await priceFeeds['USDC'].latestRoundData();
    const baseScale = await comet.baseScale();
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater.address,
        basePaidOut: 100n,
        usdValue: mulPrice(100n, usdcPrice, baseScale),
      }
    });
  });

  it('absorbs 2 accounts and pays out the absorber', async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const { cometWithExtendedAssetList : comet, priceFeeds, users: [absorber, underwater1, underwater2] } = protocol;

    await setTotalsBasic(comet, { totalBorrowBase: 2000n });

    const r0 = await comet.getReserves();

    await comet.setBasePrincipal(underwater1.address, -100);
    await comet.setBasePrincipal(underwater2.address, -700);

    const pA0 = await portfolio(protocol, absorber.address);
    const pU1_0 = await portfolio(protocol, underwater1.address);
    const pU2_0 = await portfolio(protocol, underwater2.address);

    const a0 = await wait(comet.absorb(absorber.address, [underwater1.address, underwater2.address]));

    const t1 = await comet.totalsBasic();
    const r1 = await comet.getReserves();

    const pA1 = await portfolio(protocol, absorber.address);
    const pU1_1 = await portfolio(protocol, underwater1.address);
    const pU2_1 = await portfolio(protocol, underwater2.address);
    const lA1 = await comet.liquidatorPoints(absorber.address);
    const _lU1_1 = await comet.liquidatorPoints(underwater1.address);
    const _lU2_1 = await comet.liquidatorPoints(underwater2.address);

    expect(r0).to.be.equal(2000n);

    expect(t1.totalSupplyBase).to.be.equal(0n);
    expect(t1.totalBorrowBase).to.be.equal(1200n);
    expect(r1).to.be.equal(1200n);

    expect(pA0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_0.internal).to.be.deep.equal({ COMP: 0n, USDC: -100n, WBTC: 0n, WETH: 0n });
    expect(pU1_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_0.internal).to.be.deep.equal({ COMP: 0n, USDC: -700n, WBTC: 0n, WETH: 0n });
    expect(pU2_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(pA1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(lA1.numAbsorbs).to.be.equal(1n);
    expect(lA1.numAbsorbed).to.be.equal(2n);
    //expect(lA1.approxSpend).to.be.equal(459757131288n);
    expect(lA1.approxSpend).to.be.lt(a0.receipt.gasUsed * a0.receipt.gasPrice);

    const [_, usdcPrice] = await priceFeeds['USDC'].latestRoundData();
    const baseScale = await comet.baseScale();
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater1.address,
        basePaidOut: 100n,
        usdValue: mulPrice(100n, usdcPrice, baseScale),
      }
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater2.address,
        basePaidOut: 700n,
        usdValue: mulPrice(700n, usdcPrice, baseScale),
      }
    });
  });

  it('absorbs 3 accounts with collateral and pays out the absorber', async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
    };
    const protocol = await makeProtocol(params);
    const { cometWithExtendedAssetList : comet, tokens, priceFeeds, users: [absorber, underwater1, underwater2, underwater3] } = protocol;
    const { COMP, WBTC, WETH } = tokens;
    const cometAddress = await comet.getAddress();
    const compAddress = await COMP.getAddress();
    const wbtcAddress = await WBTC.getAddress();
    const wethAddress = await WETH.getAddress();

    await setTotalsBasic(comet, {
      totalBorrowBase: exp(3e15, 6),
      totalSupplyBase: exp(4e15, 6),
    });
    await bumpTotalsCollateral(comet, COMP, exp(1e-6, 18) + exp(10, 18) + exp(10000, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18) + exp(50, 18));
    await bumpTotalsCollateral(comet, WBTC, exp(50, 8));

    await comet.setBasePrincipal(underwater1.address, -exp(1, 6));
    await comet.setCollateralBalance(underwater1.address, compAddress, exp(1e-6, 18));

    await comet.setBasePrincipal(underwater2.address, -exp(1, 12));
    await comet.setCollateralBalance(underwater2.address, compAddress, exp(10, 18));
    await comet.setCollateralBalance(underwater2.address, wethAddress, exp(1, 18));

    await comet.setBasePrincipal(underwater3.address, -exp(1, 18));
    await comet.setCollateralBalance(underwater3.address, compAddress, exp(10000, 18));
    await comet.setCollateralBalance(underwater3.address, wethAddress, exp(50, 18));
    await comet.setCollateralBalance(underwater3.address, wbtcAddress, exp(50, 8));

    const pP0 = await portfolio(protocol, cometAddress);
    const pA0 = await portfolio(protocol, absorber.address);
    const pU1_0 = await portfolio(protocol, underwater1.address);
    const pU2_0 = await portfolio(protocol, underwater2.address);
    const pU3_0 = await portfolio(protocol, underwater3.address);
    const cTR0 = await totalsAndReserves(protocol);

    const a0 = await wait(comet.absorb(absorber.address, [underwater1.address, underwater2.address, underwater3.address]));

    const t1 = await comet.totalsBasic();

    const pP1 = await portfolio(protocol, cometAddress);
    const pA1 = await portfolio(protocol, absorber.address);
    const pU1_1 = await portfolio(protocol, underwater1.address);
    const pU2_1 = await portfolio(protocol, underwater2.address);
    const pU3_1 = await portfolio(protocol, underwater3.address);
    const lA1 = await comet.liquidatorPoints(absorber.address);
    const _lU1_1 = await comet.liquidatorPoints(underwater1.address);
    const _lU2_1 = await comet.liquidatorPoints(underwater2.address);
    const _lU3_1 = await comet.liquidatorPoints(underwater3.address);
    const cTR1 = await totalsAndReserves(protocol);

    expect(cTR0.totals).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: exp(4e15, 6),
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18)
    });
    expect(cTR0.reserves).to.be.deep.equal({ COMP: 0n, USDC: -exp(1e15, 6), WBTC: 0n, WETH: 0n });

    expect(t1.totalSupplyBase).to.be.equal(exp(4e15, 6));
    expect(t1.totalBorrowBase).to.be.equal(exp(3e15, 6) - exp(1, 18) - exp(1, 12) - exp(1, 6));
    expect(cTR1.totals).to.be.deep.equal({ COMP: 0n, USDC: exp(4e15, 6), WBTC: 0n, WETH: 0n });
    expect(cTR1.reserves).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: -exp(1e15, 6) - exp(1, 6) - exp(1, 12) - exp(1, 18),
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18)
    });

    expect(pP0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pP0.external).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: 0n,
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18)
    });
    expect(pA0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_0.internal).to.be.deep.equal({ COMP: exp(1, 12), USDC: -exp(1, 6), WBTC: 0n, WETH: 0n });
    expect(pU1_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_0.internal).to.be.deep.equal({ COMP: exp(10, 18), USDC: -exp(1, 12), WBTC: 0n, WETH: exp(1, 18) });
    expect(pU2_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU3_0.internal).to.be.deep.equal({ COMP: exp(10000, 18), USDC: -exp(1, 18), WBTC: exp(50, 8), WETH: exp(50, 18) });
    expect(pU3_0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(pP1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pP1.external).to.be.deep.equal({
      COMP: exp(1, 12) + exp(10, 18) + exp(10000, 18),
      USDC: 0n,
      WBTC: exp(50, 8),
      WETH: exp(1, 18) + exp(50, 18)
    });
    expect(pA1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU2_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU3_1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU3_1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(lA1.numAbsorbs).to.be.equal(1n);
    expect(lA1.numAbsorbed).to.be.equal(3n);
    //expect(lA1.approxSpend).to.be.equal(130651238630n);
    expect(lA1.approxSpend).to.be.lt(a0.receipt.gasUsed * a0.receipt.gasPrice);

    const [_a, usdcPrice] = await priceFeeds['USDC'].latestRoundData();
    const [_b, compPrice] = await priceFeeds['COMP'].latestRoundData();
    const [_c, wbtcPrice] = await priceFeeds['WBTC'].latestRoundData();
    const [_d, wethPrice] = await priceFeeds['WETH'].latestRoundData();
    const baseScale = await comet.baseScale();
    const compScale = exp(1, await COMP.decimals());
    const wbtcScale = exp(1, await WBTC.decimals());
    const wethScale = exp(1, await WETH.decimals());
    // Underwater account 1
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater1.address,
        asset: compAddress,
        collateralAbsorbed: exp(1, 12),
        usdValue: mulPrice(exp(1, 12), compPrice, compScale),
      }
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater1.address,
        basePaidOut: exp(1, 6),
        usdValue: mulPrice(exp(1, 6), usdcPrice, baseScale),
      }
    });
    // Underwater account 2
    expect(event(a0, 2)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater2.address,
        asset: compAddress,
        collateralAbsorbed: exp(10, 18),
        usdValue: mulPrice(exp(10, 18), compPrice, compScale),
      }
    });
    expect(event(a0, 3)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater2.address,
        asset: wethAddress,
        collateralAbsorbed: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), wethPrice, wethScale),
      }
    });
    expect(event(a0, 4)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater2.address,
        basePaidOut: exp(1, 12),
        usdValue: mulPrice(exp(1, 12), usdcPrice, baseScale),
      }
    });
    // Underwater account 3
    expect(event(a0, 5)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: compAddress,
        collateralAbsorbed: exp(10000, 18),
        usdValue: mulPrice(exp(10000, 18), compPrice, compScale),
      }
    });
    expect(event(a0, 6)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: wethAddress,
        collateralAbsorbed: exp(50, 18),
        usdValue: mulPrice(exp(50, 18), wethPrice, wethScale),
      }
    });
    expect(event(a0, 7)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater3.address,
        asset: wbtcAddress,
        collateralAbsorbed: exp(50, 8),
        usdValue: mulPrice(exp(50, 8), wbtcPrice, wbtcScale),
      }
    });
    expect(event(a0, 8)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater3.address,
        basePaidOut: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), usdcPrice, baseScale),
      }
    });
  });

  it('absorbs an account with more than enough collateral to still cover debt', async () => {
    const params = {
      supplyInterestRateBase: 0,
      supplyInterestRateSlopeLow: 0,
      supplyInterestRateSlopeHigh: 0,
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
      borrowInterestRateSlopeHigh: 0,
      assets: defaultAssets({
        borrowCF: factor(1 / 2),
        liquidateCF: factor(2 / 3),
      })
    };
    const protocol = await makeProtocol(params);
    const { cometWithExtendedAssetList : comet, tokens, users: [absorber, underwater], priceFeeds } = protocol;
    const { COMP, WBTC, WETH } = tokens;
    const cometAddress = await comet.getAddress();
    const compAddress = await COMP.getAddress();
    const wbtcAddress = await WBTC.getAddress();
    const wethAddress = await WETH.getAddress();

    const finalDebt = 1n;
    const startingDebt = finalDebt - (exp(41000, 6) + exp(3000, 6) + exp(175, 6));
    await setTotalsBasic(comet, {
      totalBorrowBase: -startingDebt,
    });
    await bumpTotalsCollateral(comet, COMP, exp(1, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18));
    await bumpTotalsCollateral(comet, WBTC, exp(1, 8));

    const r0 = await comet.getReserves();

    await comet.setBasePrincipal(underwater.address, startingDebt);
    await comet.setCollateralBalance(underwater.address, compAddress, exp(1, 18));
    await comet.setCollateralBalance(underwater.address, wethAddress, exp(1, 18));
    await comet.setCollateralBalance(underwater.address, wbtcAddress, exp(1, 8));

    const pP0 = await portfolio(protocol, cometAddress);
    const pA0 = await portfolio(protocol, absorber.address);
    const pU0 = await portfolio(protocol, underwater.address);

    const a0 = await wait(comet.absorb(absorber.address, [underwater.address]));

    const t1 = await comet.totalsBasic();
    const r1 = await comet.getReserves();

    const pP1 = await portfolio(protocol, cometAddress);
    const pA1 = await portfolio(protocol, absorber.address);
    const pU1 = await portfolio(protocol, underwater.address);
    const lA1 = await comet.liquidatorPoints(absorber.address);
    const _lU1 = await comet.liquidatorPoints(underwater.address);

    expect(r0).to.be.equal(-startingDebt);
    expect(t1.totalSupplyBase).to.be.equal(finalDebt);
    expect(t1.totalBorrowBase).to.be.equal(0n);
    expect(r1).to.be.equal(-finalDebt);

    expect(pP0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pP0.external).to.be.deep.equal({ COMP: exp(1, 18), USDC: 0n, WBTC: exp(1, 8), WETH: exp(1, 18) });
    expect(pA0.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU0.internal).to.be.deep.equal({ COMP: exp(1, 18), USDC: startingDebt, WBTC: exp(1, 8), WETH: exp(1, 18) });
    expect(pU0.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(pP1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pP1.external).to.be.deep.equal({ COMP: exp(1, 18), USDC: 0n, WBTC: exp(1, 8), WETH: exp(1, 18) });
    expect(pA1.internal).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pA1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });
    expect(pU1.internal).to.be.deep.equal({ COMP: 0n, USDC: 1n, WBTC: 0n, WETH: 0n });
    expect(pU1.external).to.be.deep.equal({ COMP: 0n, USDC: 0n, WBTC: 0n, WETH: 0n });

    expect(lA1.numAbsorbs).to.be.equal(1n);
    expect(lA1.numAbsorbed).to.be.equal(1n);
    //expect(lA1.approxSpend).to.be.equal(1672498842684n);
    expect(lA1.approxSpend).to.be.lt(a0.receipt.gasUsed * a0.receipt.gasPrice);

    const [_a, usdcPrice] = await priceFeeds['USDC'].latestRoundData();
    const [_b, compPrice] = await priceFeeds['COMP'].latestRoundData();
    const [_c, wbtcPrice] = await priceFeeds['WBTC'].latestRoundData();
    const [_d, wethPrice] = await priceFeeds['WETH'].latestRoundData();
    const baseScale = await comet.baseScale();
    const compScale = exp(1, await COMP.decimals());
    const wbtcScale = exp(1, await WBTC.decimals());
    const wethScale = exp(1, await WETH.decimals());
    expect(event(a0, 0)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater.address,
        asset: compAddress,
        collateralAbsorbed: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), compPrice, compScale),
      }
    });
    expect(event(a0, 1)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater.address,
        asset: wethAddress,
        collateralAbsorbed: exp(1, 18),
        usdValue: mulPrice(exp(1, 18), wethPrice, wethScale),
      }
    });
    expect(event(a0, 2)).to.be.deep.equal({
      AbsorbCollateral: {
        absorber: absorber.address,
        borrower: underwater.address,
        asset: wbtcAddress,
        collateralAbsorbed: exp(1, 8),
        usdValue: mulPrice(exp(1, 8), wbtcPrice, wbtcScale),
      }
    });
    expect(event(a0, 3)).to.be.deep.equal({
      AbsorbDebt: {
        absorber: absorber.address,
        borrower: underwater.address,
        basePaidOut: pU1.internal.USDC - startingDebt,
        usdValue: mulPrice(pU1.internal.USDC - startingDebt, usdcPrice, baseScale),
      }
    });
    expect(event(a0, 4)).to.be.deep.equal({
      Transfer: {
        amount: finalDebt,
        from: ZeroAddress,
        to: underwater.address,
      }
    });
  });

  it('reverts if an account is not underwater', async () => {
    const { cometWithExtendedAssetList : comet, users: [alice, bob] } = await makeProtocol();

    await expect(comet.absorb(alice.address, [bob.address]))
      .to.be.revertedWithCustomError(comet, 'NotLiquidatable');
  });

  it.skip('reverts if collateral asset value overflows base balance', async () => {
    // XXX
  });

  it('reverts if absorb is paused', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList : comet, pauseGuardian, users: [alice, bob] } = protocol;

    const cometAsB = comet.connect(bob);

    // Pause transfer
    await wait(comet.connect(pauseGuardian).pause(false, false, false, true, false));
    expect(await comet.isAbsorbPaused()).to.be.true;

    await expect(cometAsB.absorb(bob.address, [alice.address]))
      .to.be.revertedWithCustomError(comet, 'Paused');
  });

  it('updates assetsIn for liquidated account', async () => {
    const { cometWithExtendedAssetList : comet, users: [absorber, underwater], tokens } = await makeProtocol();
    const { COMP, WETH } = tokens;
    const compAddress = await COMP.getAddress();
    const wethAddress = await WETH.getAddress();

    await bumpTotalsCollateral(comet, COMP, exp(1, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18));

    await comet.setCollateralBalance(underwater.address, compAddress, exp(1, 18));
    await comet.setCollateralBalance(underwater.address, wethAddress, exp(1, 18));

    expect(await comet.getAssetList(underwater.address)).to.deep.equal([
      compAddress,
      wethAddress,
    ]);

    const borrowAmount = exp(4000, 6); // borrow of $4k > collateral of $3k + $175
    await comet.setBasePrincipal(underwater.address, -borrowAmount);
    await setTotalsBasic(comet, { totalBorrowBase: borrowAmount });

    const isLiquidatable = await comet.isLiquidatable(underwater.address);

    expect(isLiquidatable).to.be.true;

    await comet.absorb(absorber.address, [underwater.address]);

    expect(await comet.getAssetList(underwater.address)).to.be.empty;
  });

  it('updates assetsIn for liquidated account in 24 assets', async () => {
    const protocol = await makeProtocol({
      assets: {
        // 24 assets
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 175,
        },
        WETH: {
          initial: 1e4,
          decimals: 18,
          initialPrice: 3000,
        },
        WBTC: {
          initial: 1e3,
          decimals: 8,
          initialPrice: 41000,
        },
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
        ASSET10: {},
        ASSET11: {},
        ASSET12: {},
        ASSET13: {},
        ASSET14: {},
        ASSET15: {},
        ASSET16: {},
        ASSET17: {},
        ASSET18: {},
        ASSET19: {},
        ASSET20: {},
        ASSET21: {},
        ASSET22: {},
        ASSET23: {},
        USDC: {
          initial: 1e6,
          decimals: 6,
        },
      },
      reward: 'COMP',
    });
    const { cometWithExtendedAssetList : comet, tokens: {
      COMP,
      WETH,
    }, users: [absorber, underwater] } = protocol;
    const compAddress = await COMP.getAddress();
    const wethAddress = await WETH.getAddress();

    await bumpTotalsCollateral(comet, COMP, exp(1, 18));
    await bumpTotalsCollateral(comet, WETH, exp(1, 18));

    await comet.setCollateralBalance(underwater.address, compAddress, exp(1, 18));
    await comet.setCollateralBalance(underwater.address, wethAddress, exp(1, 18));

    const extraAssetAddresses = [];
    for (let i = 3; i < 24; i++) {
      const asset = `ASSET${i}`;
      const token = protocol.tokens[asset];
      const tokenAddress = await token.getAddress();
      extraAssetAddresses.push(tokenAddress);
      await bumpTotalsCollateral(comet, token, exp(1, 18));
      await comet.setCollateralBalance(underwater.address, tokenAddress, exp(1, 18));
    }

    expect(await comet.getAssetList(underwater.address)).to.deep.equal([
      compAddress,
      wethAddress,
      ...extraAssetAddresses,
    ]);

    const borrowAmount = exp(4000, 6); // borrow of $4k > collateral of $3k + $175
    await comet.setBasePrincipal(underwater.address, -borrowAmount);
    await setTotalsBasic(comet, { totalBorrowBase: borrowAmount });

    const isLiquidatable = await comet.isLiquidatable(underwater.address);

    expect(isLiquidatable).to.be.true;

    await comet.absorb(absorber.address, [underwater.address]);

    expect(await comet.getAssetList(underwater.address)).to.be.empty;
  });
});
