import { ethers, event, expect, exp, makeProtocol, portfolio, wait, fastForward, ReentryAttack, defaultAssets, ZERO_ADDRESS, takeSnapshot, SnapshotRestorer, UserCollateral, MAX_ASSETS, presentValueSupply } from './helpers';
import { EvilToken, EvilToken__factory, NonStandardFaucetFeeToken__factory, NonStandardFaucetFeeToken, FaucetToken, CometHarnessInterfaceExtendedAssetList } from '../build/types';
import { BigNumber, ContractTransaction } from 'ethers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { TotalsCollateralStruct } from 'build/types/CometHarnessInterfaceExtendedAssetList';

// Note: isolated supply functionality, withdraw and repay are tested in separate testsets
describe('supply', function () {
  // Constants
  const baseTokenDecimals = 6;
  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken | NonStandardFaucetFeeToken;
  // Tokens
  let collaterals: {
    [symbol: string]: FaucetToken | NonStandardFaucetFeeToken;
  };
  let unsupportedToken: FaucetToken;
  // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let governor: SignerWithAddress;

  /*//////////////////////////////////////////////////////////////
                       24 COLLATERALS COMET SETUP
  //////////////////////////////////////////////////////////////*/
  // Contracts
  let cometWith24Collaterals: CometHarnessInterfaceExtendedAssetList;
  let tokensWith24Collaterals: { [symbol: string]: FaucetToken } = {};
  // Constants
  const collateralTokenSupplyAmount = BigInt(8e8);
  // Storage
  let deactivatedCollateralIndex: number;
  let totalsCollateralBefore: TotalsCollateralStruct;
  let bobUserCollateralBefore: UserCollateral;
  let aliceUserCollateralBefore: UserCollateral;
  // Tokens
  let collateralToken: FaucetToken;
  let deactivateCollateralTx: ContractTransaction;
  let activateCollateralTx: ContractTransaction;

  let snapshot: SnapshotRestorer;

  // A non-zero base supply rate and seed reserves, so that lenders really earn interest at 0 utilization
  // (lenders' value stays below the comet's balance, the cut-off in getSupplyRate is not reached) and
  // every accrual check below sees a moving index.
  // The reserves must outlast all the time skipped in this file (the cut-off flow alone skips 80 days):
  // ~8e9 USDC of lenders at 1% earn ~80M USDC a year.
  const SUPPLY_BASE_RATE: bigint = exp(0.01, 18); // 1% per year
  const SEED_RESERVES: bigint = exp(1e8, baseTokenDecimals); // 100,000,000 USDC

  before(async function () {
    const protocol = await makeProtocol({ base: 'USDC', supplyInterestRateBase: SUPPLY_BASE_RATE, baseTokenBalance: SEED_RESERVES });

    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens[protocol.base];
    collaterals = Object.fromEntries(
      Object.entries(protocol.tokens).filter(([_symbol, token]) => token.address !== baseToken.address)
    );
    pauseGuardian = protocol.pauseGuardian;
    unsupportedToken = protocol.unsupportedToken;
    governor = protocol.governor;
    [alice, bob, dave] = protocol.users;

    await baseToken.allocateTo(alice.address, exp(1e10, baseTokenDecimals));
    await baseToken.allocateTo(bob.address, exp(1e10, baseTokenDecimals));

    /*//////////////////////////////////////////////////////////////
                       24 COLLATERALS COMET SETUP
    //////////////////////////////////////////////////////////////*/

    const collaterals24Assets = Object.fromEntries(
      Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {
        initialPrice: 100,
        decimals: 18,
      }])
    );
    const protocolWith24Collaterals = await makeProtocol({
      assets: { USDC: {initialPrice: 1, decimals: 6 }, ...collaterals24Assets, },
    });
    cometWith24Collaterals = protocolWith24Collaterals.cometWithExtendedAssetList;
    for (const asset in protocolWith24Collaterals.tokens) {
      if (asset === 'USDC') continue;
      tokensWith24Collaterals[asset] = protocolWith24Collaterals.tokens[asset] as FaucetToken;
    }

    collateralToken = collaterals['COMP'] as FaucetToken;

    const collateralAssetInfo = await comet.getAssetInfoByAddress(collateralToken.address);
    deactivatedCollateralIndex = collateralAssetInfo.offset;
    totalsCollateralBefore = await comet.totalsCollateral(collateralToken.address);
    bobUserCollateralBefore = await comet.userCollateral(bob.address, collateralToken.address);
    aliceUserCollateralBefore = await comet.userCollateral(alice.address, collateralToken.address);

    snapshot = await takeSnapshot();
  });

  describe('supply base asset', function () {
    describe('default state (un-accrued)', function () {
      it('supply is not paused by default', async () => {
        expect(await comet.isSupplyPaused()).to.be.false;
      });

      it('base supply is not paused by default', async () => {
        expect(await comet.isBaseSupplyPaused()).to.be.false;
      });

      it('the comet holds only the seed reserves', async () => {
        expect(await baseToken.balanceOf(comet.address)).to.equal(SEED_RESERVES);
        expect(await comet.getReserves()).to.equal(SEED_RESERVES);
      });

      it('base supply rate is configured, but the supply rate is 0 while nobody supplies', async () => {
        expect(await comet.supplyPerSecondInterestRateBase()).to.be.greaterThan(0);
        // getSupplyRate: totalSupplyBase == 0 => 0, even with reserves on the comet
        expect(await comet.getSupplyRate(0)).to.equal(0);
      });

      it('no collateral tokens on the comet', async () => {
        for (const collateral of Object.values(collaterals)) {
          expect(await collateral.balanceOf(comet.address)).to.equal(0);
        }
      });

      it('default supply index', async () => {
        expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(exp(1, 15));
      });

      it('no stored total supply with interest by default', async () => {
        expect((await comet.totalsBasic()).totalSupplyBase).to.equal(0);
      });

      it('no displayed total supply with interest by default', async () => {
        expect(await comet.totalSupply()).to.equal(0);
      });

      it('no stored user\'s balance by default', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.equal(0);
      });

      it('no displayed user\'s balance by default', async () => {
        expect(await comet.balanceOf(alice.address)).to.equal(0);
      });
    });

    describe('supply base asset: reverts', function () {
      it('reverts if supply is paused', async () => {
        await comet.connect(pauseGuardian).pause(true, false, false, false, false);
        expect(await comet.isSupplyPaused()).to.be.true;

        await baseToken.connect(alice).approve(comet.address, 1);
        await expect(comet.connect(alice).supply(baseToken.address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if base supply is paused', async () => {
        await comet.connect(pauseGuardian).pauseBaseSupply(true);
        expect(await comet.isBaseSupplyPaused()).to.be.true;

        await expect(comet.connect(alice).supply(baseToken.address, 1)).to.be.revertedWithCustomError(comet, 'BaseSupplyPaused');
        await comet.connect(pauseGuardian).pauseBaseSupply(false);
      });

      it('reverts for not enough base asset balance', async () => {
        const balanceBefore = await baseToken.balanceOf(alice.address);

        await baseToken.connect(alice).approve(comet.address, balanceBefore.add(1));
        await expect(comet.connect(alice).supply(baseToken.address, balanceBefore.add(1))).to.be.reverted;
        await baseToken.connect(alice).approve(comet.address, 0);
      });

      it('reverts if the asset is neither collateral nor base', async () => {
        await unsupportedToken.allocateTo(alice.address, exp(1, 18));

        await unsupportedToken.connect(alice).approve(comet.address, exp(1, 18));
        await expect(comet.connect(alice).supply(unsupportedToken.address, 1)).to.be.revertedWithCustomError(comet, 'BadAsset');
      });
    });

    describe('supply base asset into empty pool', function () {
      const BASE_AMOUNT: bigint = exp(5e9, baseTokenDecimals);
      let aliceBalanceBefore: BigNumber;
      let aliceBalanceAfter: BigNumber;
      let supplyTx: ContractTransaction;

      it('wait and accrue state', async () => {
        // wait with empty comet for a while
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);

        await comet.accrueAccount(alice.address);

        // no suppliers => supply rate 0 => the index did not move
        expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(exp(1, 15));
      });

      it('supply base asset into empty pool is successful', async () => {
        aliceBalanceBefore = await baseToken.balanceOf(alice.address);

        await baseToken.connect(alice).approve(comet.address, BASE_AMOUNT);
        supplyTx = await comet.connect(alice).supply(baseToken.address, BASE_AMOUNT);
        await expect(supplyTx).to.not.be.reverted;

        aliceBalanceAfter = await baseToken.balanceOf(alice.address);
      });
      
      it('emits Supply event when supplies base asset into empty pool', async () => {
        await expect(supplyTx)
          .emit(comet, 'Supply')
          .withArgs(alice.address, alice.address, BASE_AMOUNT);
      });

      it('emits Transfer event when supplies base asset into empty pool (as supply grows)', async () => {
        const principalFromBase = BASE_AMOUNT; // default index for the empty pool gives same supply amount

        await expect(supplyTx)
          .emit(comet, 'Transfer')
          .withArgs(ZERO_ADDRESS, alice.address, principalFromBase);
      });

      it('should supply the exact balance as passed as a parameter', async () => {
        expect(aliceBalanceBefore.sub(aliceBalanceAfter)).to.equal(BASE_AMOUNT);
      });

      it("comet's token balance is increased", async () => {
        expect(await baseToken.balanceOf(comet.address)).to.equal(SEED_RESERVES + BASE_AMOUNT);
      });

      it("user's stored principal is increased", async () => {
        const principalFromBase = BASE_AMOUNT; // default index for the empty pool gives same supply amount

        expect((await comet.userBasic(alice.address)).principal).to.equal(principalFromBase);
      });

      it("user's displayed principal is increased", async () => {
        const presentFromBase = BASE_AMOUNT; // default index for the empty pool gives same supply amount

        expect(await comet.balanceOf(alice.address)).to.equal(presentFromBase);
      });

      it("comet's stored total supply is increased", async () => {
        const principalFromBase = BASE_AMOUNT; // default index for the empty pool gives same supply amount

        expect((await comet.totalsBasic()).totalSupplyBase).to.equal(principalFromBase);
      });

      it("comet's displayed total supply is increased", async () => {
        const presentFromBase = BASE_AMOUNT; // default index for the empty pool gives same supply amount

        expect(await comet.totalSupply()).to.equal(presentFromBase);
      });

      it('user supply is same as total supply', async () => {
        expect(await comet.balanceOf(alice.address)).to.equal(await comet.totalSupply());
      });
    });

    describe('supply base asset: happy path', function () {
      const SUPPLIED_AMOUNT_ALICE: bigint = exp(2e9, baseTokenDecimals);
      let aliceBalanceBefore: BigNumber;
      let cometBalanceBefore: BigNumber;
      let aliceDisplayBalanceBefore: BigNumber;
      let alicePrincipalBefore: BigNumber;
      let cometSupplyIndexBefore: BigNumber;
      let cometSupplyRateBefore: BigNumber;
      let cometUpdatedTimeBefore: number;

      const SUPPLIED_AMOUNT_BOB: bigint = exp(1e9, baseTokenDecimals);
      let bobBalanceBefore: BigNumber;

      // one deposit per user; the event and accrual steps all check that same tx
      let lastAccrualBeforeDeposit: number;
      let depositStateBefore: Awaited<ReturnType<typeof getSupplyStateBefore>>;
      let depositTx: ContractTransaction;

      before(async function () {
        aliceBalanceBefore = await baseToken.balanceOf(alice.address);
        cometBalanceBefore = await baseToken.balanceOf(comet.address);
        aliceDisplayBalanceBefore = await comet.balanceOf(alice.address);
        alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
        cometSupplyIndexBefore = (await comet.totalsBasic()).baseSupplyIndex;
        cometSupplyRateBefore = await comet.getSupplyRate(await comet.getUtilization());
        cometUpdatedTimeBefore = (await comet.totalsBasic()).lastAccrualTime;

        // wait for a while so lenders' interest accrues
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);
      });

      it("initial state: totalSupply > 0, no borrows, lenders' value below the comet balance", async () => {
        const { totalSupplyBase, baseSupplyIndex } = await comet.totalsBasic();
        expect(totalSupplyBase).to.be.greaterThan(0);
        expect(await comet.getUtilization()).to.equal(0);

        // the seed reserves keep lenders' value below the balance, so the cut-off is not reached
        expect(presentValueSupply(baseSupplyIndex, totalSupplyBase)).to.be.lessThan(await baseToken.balanceOf(comet.address));
      });

      it('initial state: supply rate = base rate (no borrows, lenders are paid from the reserves)', async () => {
        expect(cometSupplyRateBefore).to.be.greaterThan(0);
        expect(await comet.getSupplyRate(0)).to.equal(await comet.supplyPerSecondInterestRateBase());
      });

      it('initial state: displayed total supply already includes the not yet accrued interest', async () => {
        const { totalSupplyBase, baseSupplyIndex } = await comet.totalsBasic();
        expect(await comet.totalSupply()).to.be.greaterThan(presentValueSupply(baseSupplyIndex, totalSupplyBase));
      });

      it('alice makes a 2nd deposit', async () => {
        await baseToken.connect(alice).approve(comet.address, SUPPLIED_AMOUNT_ALICE);
        lastAccrualBeforeDeposit = (await comet.totalsBasic()).lastAccrualTime;
        depositStateBefore = await getSupplyStateBefore(comet, alice.address);
        depositTx = await comet.connect(alice).supply(baseToken.address, SUPPLIED_AMOUNT_ALICE);
      });

      it('2nd deposit from alice: emits Supply event for existing supply', async () => {
        await expect(depositTx)
          .to.emit(comet, 'Supply')
          .withArgs(alice.address, alice.address, SUPPLIED_AMOUNT_ALICE);
      });

      it('2nd deposit from alice: emits Transfer event for existing supply', async () => {
        await expect(depositTx)
          .to.emit(comet, 'Transfer')
          .withArgs(ZERO_ADDRESS, alice.address, await getSupplyTransferAmount(depositStateBefore, SUPPLIED_AMOUNT_ALICE, depositTx));
      });

      it('2nd deposit from alice: accrues the state', async () => {
        const depositTime = (await ethers.provider.getBlock((await depositTx.wait()).blockNumber)).timestamp;
        expect((await comet.totalsBasic()).lastAccrualTime).to.be.greaterThan(lastAccrualBeforeDeposit);
        expect((await comet.totalsBasic()).lastAccrualTime).to.equal(depositTime);
      });

      it('supplies from alice the exact balance as in parameter', async () => {
        const aliceBalanceAfter = await baseToken.balanceOf(alice.address);

        expect(aliceBalanceBefore.sub(aliceBalanceAfter)).to.equal(SUPPLIED_AMOUNT_ALICE);
      });

      it('Comet token balance grows', async () => {
        const cometBalanceAfter = await baseToken.balanceOf(comet.address);

        expect(cometBalanceAfter.sub(cometBalanceBefore)).to.equal(SUPPLIED_AMOUNT_ALICE);
      });

      it("alice's principal grows", async () => {
        const curTime = (await ethers.provider.getBlock('latest')).timestamp;
        const timeElapsed = curTime - cometUpdatedTimeBefore;
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // health check that the current index is re-calculated correctly, and that it really moved
        const index = (await comet.totalsBasic()).baseSupplyIndex;
        expect(index).to.be.greaterThan(cometSupplyIndexBefore);
        expect(index).to.equal(accruedIndex);

        const oldBalance = alicePrincipalBefore.mul(accruedIndex).div(1e15);
        const newPrincipal = oldBalance.add(SUPPLIED_AMOUNT_ALICE).mul(1e15).div(accruedIndex);

        expect((await comet.userBasic(alice.address)).principal).to.be.greaterThan(alicePrincipalBefore);
        expect((await comet.userBasic(alice.address)).principal).to.equal(newPrincipal);
      });

      it("alice's displayed balance grows", async () => {
        const curTime = (await ethers.provider.getBlock('latest')).timestamp;
        const timeElapsed = curTime - cometUpdatedTimeBefore;
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // health check that the current index is re-calculated correctly, and that it really moved
        const index = (await comet.totalsBasic()).baseSupplyIndex;
        expect(index).to.be.greaterThan(cometSupplyIndexBefore);
        expect(index).to.equal(accruedIndex);

        const oldBalance = alicePrincipalBefore.mul(cometSupplyIndexBefore).div(exp(1, 15));
        const newBalanceNaive = oldBalance.add(SUPPLIED_AMOUNT_ALICE);

        const newPrincipal = (await comet.userBasic(alice.address)).principal;
        const newBalanceFromPrincipal = newPrincipal.mul(accruedIndex).div(exp(1, 15));

        const newBalance = await comet.balanceOf(alice.address);
        expect(newBalance).to.be.greaterThanOrEqual(newBalanceNaive);
        expect(newBalance.sub(aliceDisplayBalanceBefore)).to.be.greaterThanOrEqual(SUPPLIED_AMOUNT_ALICE);
        expect(newBalance).to.equal(newBalanceFromPrincipal);
      });

      it("Comet's stored total supply corresponds to provided principal", async () => {
        /// currently it is an accrued state, so we can compare directly
        /// single supplier at the moment
        expect((await comet.totalsBasic()).totalSupplyBase).to.equal((await comet.userBasic(alice.address)).principal);
      });

      it("Comet's displayed total supply corresponds to provided token balance", async () => {
        /// currently it is an accrued state, so we can compare directly
        /// single supplier at the moment
        expect(await comet.totalSupply()).to.equal(await comet.balanceOf(alice.address));
      });

      it('wait for new state for bob and update global variables', async () => {
        bobBalanceBefore = await baseToken.balanceOf(bob.address);
        cometBalanceBefore = await baseToken.balanceOf(comet.address);
        /// no deposits from bob yet
        expect((await comet.userBasic(bob.address)).principal).to.equal(0);

        cometSupplyIndexBefore = (await comet.totalsBasic()).baseSupplyIndex;
        cometSupplyRateBefore = await comet.getSupplyRate(await comet.getUtilization());
        cometUpdatedTimeBefore = (await comet.totalsBasic()).lastAccrualTime;

        // wait for a while so lenders' interest accrues
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);
      });

      it('bob (new user) deposits', async () => {
        await baseToken.connect(bob).approve(comet.address, SUPPLIED_AMOUNT_BOB);
        lastAccrualBeforeDeposit = (await comet.totalsBasic()).lastAccrualTime;
        depositStateBefore = await getSupplyStateBefore(comet, bob.address);
        depositTx = await comet.connect(bob).supply(baseToken.address, SUPPLIED_AMOUNT_BOB);
      });

      it('deposit from bob (new user): emits Supply event for existing supply', async () => {
        await expect(depositTx)
          .to.emit(comet, 'Supply')
          .withArgs(bob.address, bob.address, SUPPLIED_AMOUNT_BOB);
      });

      it('deposit from bob (new user): emits Transfer event for existing supply', async () => {
        await expect(depositTx)
          .to.emit(comet, 'Transfer')
          .withArgs(ZERO_ADDRESS, bob.address, await getSupplyTransferAmount(depositStateBefore, SUPPLIED_AMOUNT_BOB, depositTx));
      });

      it('deposit from bob (new user): accrues the state', async () => {
        const depositTime = (await ethers.provider.getBlock((await depositTx.wait()).blockNumber)).timestamp;
        expect((await comet.totalsBasic()).lastAccrualTime).to.be.greaterThan(lastAccrualBeforeDeposit);
        expect((await comet.totalsBasic()).lastAccrualTime).to.equal(depositTime);
      });

      it('supplies from bob the exact balance as in parameter', async () => {
        const bobBalanceAfter = await baseToken.balanceOf(bob.address);

        expect(bobBalanceBefore.sub(bobBalanceAfter)).to.equal(SUPPLIED_AMOUNT_BOB);
      });

      it('Comet token balance grows', async () => {
        const cometBalanceAfter = await baseToken.balanceOf(comet.address);

        expect(cometBalanceAfter.sub(cometBalanceBefore)).to.equal(SUPPLIED_AMOUNT_BOB);
      });

      it("bob's principal grows", async () => {
        const curTime = (await ethers.provider.getBlock('latest')).timestamp;
        const timeElapsed = curTime - cometUpdatedTimeBefore;
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // health check that the current index is re-calculated correctly, and that it really moved
        const index = (await comet.totalsBasic()).baseSupplyIndex;
        expect(index).to.be.greaterThan(cometSupplyIndexBefore);
        expect(index).to.equal(accruedIndex);

        /// old balance == 0
        const oldBalance: BigNumber = BigNumber.from(0);
        const newPrincipal = oldBalance.add(SUPPLIED_AMOUNT_BOB).mul(exp(1, 15)).div(accruedIndex);

        expect((await comet.userBasic(bob.address)).principal).to.be.greaterThan(0);
        expect((await comet.userBasic(bob.address)).principal).to.equal(newPrincipal);
      });

      it("bob's displayed balance grows", async () => {
        const curTime = (await ethers.provider.getBlock('latest')).timestamp;
        const timeElapsed = curTime - cometUpdatedTimeBefore;
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // health check that the current index is re-calculated correctly, and that it really moved
        const index = (await comet.totalsBasic()).baseSupplyIndex;
        expect(index).to.be.greaterThan(cometSupplyIndexBefore);
        expect(index).to.equal(accruedIndex);

        const newPrincipal = (await comet.userBasic(bob.address)).principal;

        // old balance for bob is 0
        const newBalanceFromPrincipal = newPrincipal.mul(accruedIndex).div(exp(1, 15));

        const newBalance = await comet.balanceOf(bob.address);
        expect(newBalance).to.equal(newBalanceFromPrincipal);
      });

      it("Comet's stored total supply corresponds to provided principals from all users", async () => {
        /// currently it is an accrued state, so we can compare directly
        /// get alice's and bob's supplies together
        const alicePrincipal = (await comet.userBasic(alice.address)).principal;
        const bobPrincipal = (await comet.userBasic(bob.address)).principal;
        const totalStoredSupply = alicePrincipal.add(bobPrincipal);
        expect((await comet.totalsBasic()).totalSupplyBase).to.equal(totalStoredSupply);
      });

      it("balanceOf() equals bob's deposit (within 1 wei rounding)", async () => {
        const newBalanceNaive = SUPPLIED_AMOUNT_BOB;

        /// Note: since there is a rounding error, the immediate comet.balanceOf() may return value
        /// which is 1 wei less than the deposited amount. Though the difference will be neglected
        /// in around 1 block of supply interest.

        const newBalance = await comet.balanceOf(bob.address);

        expect(newBalance.sub(newBalanceNaive)).to.be.approximately(0, 1);
      });

      it("Comet's displayed total supply corresponds to displayed balances from all users", async () => {
        /// currently it is an accrued state, so we can compare directly
        /// get alice's and bob's supplies together
        const alicePresent = await comet.balanceOf(alice.address);
        const bobPresent = await comet.balanceOf(bob.address);
        const totalPresentSupply = alicePresent.add(bobPresent);

        /// Note: because of the rounding errors accumulated (supplied amount -> principal -> present value)
        /// There is a high chance to have around 1 wei difference in the displayed market supply (totalSupply())
        /// and the sum of all balances from all users
        expect(await comet.totalSupply()).to.be.approximately(totalPresentSupply, 1);
      });
    });

    /**
     * getSupplyRate cut-off (CometWithExtendedAssetList.sol:328-330): at 0 utilization with a non-zero base rate,
     * the supply rate is 0 once lenders' value reaches the comet's base balance.
     * Only behaviour that holds with and without a fix for the inflow bypass is asserted here: the exact amount of
     * the overshoot on the crossing accrual (F-3) and the bypass by a base inflow are covered by
     * test/poc-supply-cutoff-bypass-test.ts.
     */
    describe('supply rate cut-off at zero utilization', function () {
      const CUTOFF_RESERVES: bigint = exp(1_000, baseTokenDecimals); // 1,000 USDC
      const LENDER_SUPPLY: bigint = exp(1e6, baseTokenDecimals); // 1,000,000 USDC earns 10,000 USDC a year at 1%
      const DAY = 24 * 60 * 60;
      let cutoffComet: CometHarnessInterfaceExtendedAssetList;
      let cutoffBase: FaucetToken | NonStandardFaucetFeeToken;
      let lender: SignerWithAddress;

      async function lendersValueAndBalance(): Promise<[BigNumber, BigNumber]> {
        return [await cutoffComet.totalSupply(), await cutoffBase.balanceOf(cutoffComet.address)];
      }

      before(async function () {
        const protocol = await makeProtocol({ base: 'USDC', supplyInterestRateBase: SUPPLY_BASE_RATE, baseTokenBalance: CUTOFF_RESERVES });
        cutoffComet = protocol.cometWithExtendedAssetList;
        cutoffBase = protocol.tokens[protocol.base];
        [lender] = protocol.users;

        await cutoffBase.allocateTo(lender.address, LENDER_SUPPLY);
        await cutoffBase.connect(lender).approve(cutoffComet.address, LENDER_SUPPLY);
        await cutoffComet.connect(lender).supply(cutoffBase.address, LENDER_SUPPLY);
      });

      it("below the balance: no borrows, lenders' value < balance, supply rate = base rate", async () => {
        const [lendersValue, balance] = await lendersValueAndBalance();

        expect(await cutoffComet.getUtilization()).to.equal(0);
        expect(lendersValue).to.be.lessThan(balance);
        expect(await cutoffComet.getSupplyRate(0)).to.equal(await cutoffComet.supplyPerSecondInterestRateBase());
      });

      it('below the balance: the index grows at the base rate (10 days)', async () => {
        const { baseSupplyIndex: indexBefore, lastAccrualTime } = await cutoffComet.totalsBasic();
        const rate = await cutoffComet.getSupplyRate(0);

        await ethers.provider.send('evm_increaseTime', [10 * DAY]);
        const accrueTx = await cutoffComet.accrueAccount(lender.address);
        const now = (await ethers.provider.getBlock((await accrueTx.wait()).blockNumber)).timestamp;

        const index = (await cutoffComet.totalsBasic()).baseSupplyIndex;
        expect(index).to.be.greaterThan(indexBefore);
        expect(index).to.equal(indexBefore.add(indexBefore.mul(rate).mul(now - lastAccrualTime).div(exp(1, 18))));

        // ~274 USDC of the 1,000 USDC reserves paid to the lender so far
        const [lendersValue, balance] = await lendersValueAndBalance();
        expect(lendersValue).to.be.lessThan(balance);
      });

      it("crossing: once lenders' value reaches the balance, the supply rate is 0", async () => {
        // 40 more days: 10,000 USDC a year pays out the 1,000 USDC reserves after ~36.5 days in total
        await ethers.provider.send('evm_increaseTime', [40 * DAY]);
        await cutoffComet.accrueAccount(lender.address);

        const [lendersValue, balance] = await lendersValueAndBalance();
        expect(lendersValue).to.be.greaterThanOrEqual(balance);
        expect(await cutoffComet.getSupplyRate(0)).to.equal(0);
      });

      it('cut off: with no inflow, the index and the lender balance stay frozen (30 days)', async () => {
        const indexBefore = (await cutoffComet.totalsBasic()).baseSupplyIndex;
        const lenderBalanceBefore = await cutoffComet.balanceOf(lender.address);

        await ethers.provider.send('evm_increaseTime', [30 * DAY]);
        await ethers.provider.send('evm_mine', []);
        // the view already shows no virtual interest
        expect(await cutoffComet.balanceOf(lender.address)).to.equal(lenderBalanceBefore);

        await cutoffComet.accrueAccount(lender.address);
        expect((await cutoffComet.totalsBasic()).baseSupplyIndex).to.equal(indexBefore);
        expect(await cutoffComet.balanceOf(lender.address)).to.equal(lenderBalanceBefore);
        expect(await cutoffComet.getSupplyRate(0)).to.equal(0);
      });

      it('cut off: the cut-off applies only at 0 utilization', async () => {
        // lenders' value >= balance still, but any utilization > 0 skips the cut-off branch
        const utilization = exp(0.1, 18); // 10%, below the supply kink
        const expected = (await cutoffComet.supplyPerSecondInterestRateBase()).add(
          (await cutoffComet.supplyPerSecondInterestRateSlopeLow()).mul(utilization).div(exp(1, 18))
        );
        expect(await cutoffComet.getSupplyRate(utilization)).to.be.greaterThan(0);
        expect(await cutoffComet.getSupplyRate(utilization)).to.equal(expected);
      });
    });

    // Restores the supply-max tests removed in the refactor (C2-C4), as flows on cometWithExtendedAssetList.
    describe('supply max base (repay borrow)', function () {
      let maxProtocol: Awaited<ReturnType<typeof makeProtocol>>;
      let maxComet: CometHarnessInterfaceExtendedAssetList;
      let usdc: FaucetToken | NonStandardFaucetFeeToken;
      let maxCollateral: FaucetToken | NonStandardFaucetFeeToken;
      let borrower: SignerWithAddress;
      let payer: SignerWithAddress;
      let maxFixture: SnapshotRestorer;
      const PAYER_FUNDS: bigint = exp(100, baseTokenDecimals);

      const holdings = (account: string) => portfolio(maxProtocol, account);
      async function overrideTotals(overrides: object) {
        await wait(maxComet.setTotalsBasic(Object.assign({}, await maxComet.totalsBasic(), overrides)));
      }

      before(async function () {
        maxProtocol = await makeProtocol({ base: 'USDC' });
        maxComet = maxProtocol.cometWithExtendedAssetList;
        usdc = maxProtocol.tokens['USDC'];
        maxCollateral = maxProtocol.tokens['COMP'];
        [borrower, payer] = maxProtocol.users;

        await usdc.allocateTo(payer.address, PAYER_FUNDS);
        await usdc.connect(payer).approve(maxComet.address, PAYER_FUNDS);

        maxFixture = await takeSnapshot();
      });

      describe('MaxUint repays the borrower\'s full accrued debt', function () {
        const BORROW_PRINCIPAL = 50e6;
        let totalsBefore: Awaited<ReturnType<CometHarnessInterfaceExtendedAssetList['totalsBasic']>>;
        let borrowerBefore: Awaited<ReturnType<typeof portfolio>>;
        let accruedDebt: bigint;
        let supplyTx: Awaited<ReturnType<typeof wait>>;

        before(async function () {
          await maxFixture.restore();
          await overrideTotals({ totalSupplyBase: 100e6, totalBorrowBase: BORROW_PRINCIPAL });
          await maxComet.setBasePrincipal(borrower.address, -BORROW_PRINCIPAL);

          await fastForward(86400);
          await ethers.provider.send('evm_mine', []);

          totalsBefore = await maxComet.totalsBasic();
          borrowerBefore = await holdings(borrower.address);
          accruedDebt = (await maxComet.callStatic.borrowBalanceOf(borrower.address)).toBigInt();
          supplyTx = await wait(maxComet.connect(payer).supplyTo(borrower.address, usdc.address, ethers.constants.MaxUint256));
        });

        it('debt accrued interest over the day', async () => {
          expect(accruedDebt).to.be.greaterThan(BigInt(BORROW_PRINCIPAL));
          expect(borrowerBefore.internal.USDC).to.equal(-accruedDebt);
        });

        it('emits only the pull Transfer and Supply, for the accrued debt (no mint)', async () => {
          expect(supplyTx.receipt['events'].length).to.equal(2);
          expect(event(supplyTx, 0)).to.deep.equal({ Transfer: { from: payer.address, to: maxComet.address, amount: accruedDebt } });
          expect(event(supplyTx, 1)).to.deep.equal({ Supply: { from: payer.address, dst: borrower.address, amount: accruedDebt } });
        });

        it('the borrower is left with no debt and no supply', async () => {
          expect((await holdings(borrower.address)).internal).to.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
        });

        it('the payer paid exactly the accrued debt', async () => {
          expect((await holdings(payer.address)).external.USDC).to.equal(PAYER_FUNDS - accruedDebt);
        });

        it('total borrow is cleared, total supply is unchanged', async () => {
          const totalsAfter = await maxComet.totalsBasic();
          expect(totalsAfter.totalSupplyBase).to.equal(totalsBefore.totalSupplyBase);
          expect(totalsAfter.totalBorrowBase).to.equal(0);
        });
      });

      describe('MaxUint supplies 0 when the dst has no borrow', function () {
        let totalsBefore: Awaited<ReturnType<CometHarnessInterfaceExtendedAssetList['totalsBasic']>>;
        let supplyTx: Awaited<ReturnType<typeof wait>>;

        before(async function () {
          await maxFixture.restore();
          totalsBefore = await maxComet.totalsBasic();
          supplyTx = await wait(maxComet.connect(payer).supplyTo(borrower.address, usdc.address, ethers.constants.MaxUint256));
        });

        it('emits Transfer and Supply for 0', async () => {
          expect(supplyTx.receipt['events'].length).to.equal(2);
          expect(event(supplyTx, 0)).to.deep.equal({ Transfer: { from: payer.address, to: maxComet.address, amount: 0n } });
          expect(event(supplyTx, 1)).to.deep.equal({ Supply: { from: payer.address, dst: borrower.address, amount: 0n } });
        });

        it('no tokens move and no balance is created', async () => {
          expect((await holdings(borrower.address)).internal).to.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
          expect((await holdings(payer.address)).external.USDC).to.equal(PAYER_FUNDS);
        });

        it('totals are unchanged', async () => {
          const totalsAfter = await maxComet.totalsBasic();
          expect(totalsAfter.totalSupplyBase).to.equal(totalsBefore.totalSupplyBase);
          expect(totalsAfter.totalBorrowBase).to.equal(totalsBefore.totalBorrowBase);
        });
      });

      describe('repaying exactly the borrow', function () {
        const DEBT = 100e6;
        let supplyTx: Awaited<ReturnType<typeof wait>>;

        before(async function () {
          await maxFixture.restore();
          await maxComet.setBasePrincipal(borrower.address, -DEBT);
          await overrideTotals({ totalBorrowBase: DEBT });
          supplyTx = await wait(maxComet.connect(payer).supplyTo(borrower.address, usdc.address, DEBT));
        });

        it('emits no mint Transfer (only the pull Transfer and Supply)', async () => {
          expect(supplyTx.receipt['events'].length).to.equal(2);
          expect(event(supplyTx, 0)).to.deep.equal({ Transfer: { from: payer.address, to: maxComet.address, amount: BigInt(DEBT) } });
          expect(event(supplyTx, 1)).to.deep.equal({ Supply: { from: payer.address, dst: borrower.address, amount: BigInt(DEBT) } });
        });
      });

      // Edge case: when supplying 0, dstPrincipalNew can be less than dstPrincipal due to rounding
      describe('supplying 0 when rounding gives dstPrincipalNew < dstPrincipal', function () {
        let supplyTx: Awaited<ReturnType<typeof wait>>;

        before(async function () {
          await maxFixture.restore();
          await maxComet.setBasePrincipal(borrower.address, 99999992291226);
          await overrideTotals({ totalSupplyBase: 699999944771920, baseSupplyIndex: 1000000131467072 });
          supplyTx = await wait(maxComet.connect(borrower).supply(usdc.address, 0));
        });

        it('does not revert and emits Transfer and Supply for 0', async () => {
          expect(supplyTx.receipt['events'].length).to.equal(2);
          expect(event(supplyTx, 0)).to.deep.equal({ Transfer: { from: borrower.address, to: maxComet.address, amount: 0n } });
          expect(event(supplyTx, 1)).to.deep.equal({ Supply: { from: borrower.address, dst: borrower.address, amount: 0n } });
        });
      });

      describe('MaxUint for a collateral asset', function () {
        before(async function () {
          await maxFixture.restore();
          await maxCollateral.allocateTo(payer.address, 100e6);
          await maxCollateral.connect(payer).approve(maxComet.address, 100e6);
        });

        it('reverts with InvalidUInt128 (the safe128 cast)', async () => {
          await expect(maxComet.connect(payer).supplyTo(borrower.address, maxCollateral.address, ethers.constants.MaxUint256))
            .to.be.revertedWithCustomError(maxComet, 'InvalidUInt128');
        });
      });
    });
  });

  describe('repay', function () {
    const COLLATERAL_AMOUNT: bigint = exp(1, 18); // 1 COMP token 
    const BORROW_AMOUNT: bigint = exp(10, baseTokenDecimals); // $10 borrow amount
    let collateral: FaucetToken;

    let snapshot: SnapshotRestorer;

    before(async function () {
      collateral = collaterals['COMP'] as FaucetToken;

      await collateral.allocateTo(dave.address, exp(1e10, 18));

      snapshot = await takeSnapshot();
    });

    this.afterAll(async () => snapshot.restore());

    describe('setup: dave becomes a borrower', function () {
      it('dave supply collateral and withdraw base to become borrower', async () => {
        await collateral.connect(dave).approve(comet.address, COLLATERAL_AMOUNT);
        await comet.connect(dave).supply(collateral.address, COLLATERAL_AMOUNT);

        await comet.connect(dave).withdraw(baseToken.address, BORROW_AMOUNT);
      });

      it('dave has negative principal', async () => {
        expect((await comet.userBasic(dave.address)).principal).to.be.lessThan(0);
      });

      it('dave borrow balance is equal to borrow amount', async () => {
        expect(await comet.borrowBalanceOf(dave.address)).to.be.equal(BORROW_AMOUNT);
      });

      it('dave balanceOf is 0 (no supply position)', async () => {
        expect(await comet.balanceOf(dave.address)).to.be.equal(0);
      });

      it('dave has collateral registered', async () => {
        expect((await comet.userCollateral(dave.address, collateral.address)).balance).to.be.equal(COLLATERAL_AMOUNT);
      });
    });

    describe('partial repay', function () {
      const PARTIAL_REPAY_AMOUNT: bigint = exp(5, baseTokenDecimals); // $5 repay (half of borrow)
      let davePrincipalBefore: BigNumber;
      let daveBorrowBalanceBefore: BigNumber;
      let daveBaseTokenBalanceBefore: BigNumber;
      let cometBaseTokenBalanceBefore: BigNumber;
      let totalBorrowBaseBefore: BigNumber;
      let totalSupplyBaseBefore: BigNumber;

      let repayTx: ContractTransaction;

      before(async function () {
        // Allocate base tokens to dave for repayment
        await baseToken.allocateTo(dave.address, PARTIAL_REPAY_AMOUNT);

        // Wait to accrue some interest
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);

        davePrincipalBefore = (await comet.userBasic(dave.address)).principal;
        daveBorrowBalanceBefore = await comet.borrowBalanceOf(dave.address);
        daveBaseTokenBalanceBefore = await baseToken.balanceOf(dave.address);
        cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
        totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
        totalSupplyBaseBefore = (await comet.totalsBasic()).totalSupplyBase;
      });

      it('borrow balance has accrued interest', async () => {
        // Borrow balance should be greater than initial borrow amount due to interest
        expect(daveBorrowBalanceBefore).to.be.greaterThanOrEqual(BORROW_AMOUNT);
      });

      it('partial repay succeeds', async () => {
        await baseToken.connect(dave).approve(comet.address, PARTIAL_REPAY_AMOUNT);
        repayTx = await comet.connect(dave).supply(baseToken.address, PARTIAL_REPAY_AMOUNT);
        await expect(repayTx).to.not.be.reverted;
      });

      it('emits Supply event when repaying', async () => {
        await expect(repayTx).to.emit(comet, 'Supply').withArgs(dave.address, dave.address, PARTIAL_REPAY_AMOUNT);
      });

      it('does NOT emit Transfer event (no mint) when only repaying debt', async () => {
        await expect(repayTx).to.not.emit(comet, 'Transfer');
      });

      it('dave base token balance decreased by repay amount', async () => {
        const daveBaseTokenBalanceAfter = await baseToken.balanceOf(dave.address);
        expect(daveBaseTokenBalanceBefore.sub(daveBaseTokenBalanceAfter)).to.equal(PARTIAL_REPAY_AMOUNT);
      });

      it('comet base token balance increased by repay amount', async () => {
        const cometBaseTokenBalanceAfter = await baseToken.balanceOf(comet.address);
        expect(cometBaseTokenBalanceAfter.sub(cometBaseTokenBalanceBefore)).to.equal(PARTIAL_REPAY_AMOUNT);
      });

      it('dave principal is still negative (still has debt)', async () => {
        const davePrincipalAfter = (await comet.userBasic(dave.address)).principal;
        expect(davePrincipalAfter).to.be.lessThan(0);
      });

      it('dave principal increased (less debt)', async () => {
        const davePrincipalAfter = (await comet.userBasic(dave.address)).principal;
        // Principal increased means less negative (closer to 0)
        expect(davePrincipalAfter).to.be.approximately(davePrincipalBefore.add(PARTIAL_REPAY_AMOUNT), 40);
      });

      it('dave borrow balance decreased', async () => {
        const daveBorrowBalanceAfter = await comet.borrowBalanceOf(dave.address);
        expect(daveBorrowBalanceAfter).to.be.lessThan(daveBorrowBalanceBefore);
      });

      it('dave balanceOf is still 0 (no supply position)', async () => {
        expect(await comet.balanceOf(dave.address)).to.be.equal(0);
      });

      it('total borrow base decreased', async () => {
        const totalBorrowBaseAfter = (await comet.totalsBasic()).totalBorrowBase;
        expect(totalBorrowBaseAfter).to.be.lessThan(totalBorrowBaseBefore);
      });

      it('total supply base unchanged (repay does not add supply)', async () => {
        const totalSupplyBaseAfter = (await comet.totalsBasic()).totalSupplyBase;
        expect(totalSupplyBaseAfter).to.equal(totalSupplyBaseBefore);
      });

      it('dave collateral is unchanged after repay', async () => {
        expect((await comet.userCollateral(dave.address, collateral.address)).balance).to.be.equal(COLLATERAL_AMOUNT);
      });
    });

    describe('full repay (exactly remaining debt)', function () {
      let davePrincipalBefore: BigNumber;
      let daveBorrowBalanceBefore: BigNumber;
      let daveBaseTokenBalanceBefore: BigNumber;
      let cometBaseTokenBalanceBefore: BigNumber;

      before(async function () {
        // Wait to accrue more interest
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);

        davePrincipalBefore = (await comet.userBasic(dave.address)).principal;
        daveBorrowBalanceBefore = await comet.borrowBalanceOf(dave.address);

        // Allocate exactly the borrow balance to dave
        await baseToken.allocateTo(dave.address, daveBorrowBalanceBefore);

        daveBaseTokenBalanceBefore = await baseToken.balanceOf(dave.address);
        cometBaseTokenBalanceBefore = await baseToken.balanceOf(comet.address);
      });

      it('dave still has debt before full repay', async () => {
        expect(davePrincipalBefore).to.be.lessThan(0);
        expect(daveBorrowBalanceBefore).to.be.greaterThan(0);
      });

      it('full repay using max uint256 succeeds', async () => {
        await baseToken.connect(dave).approve(comet.address, ethers.constants.MaxUint256);
        await expect(comet.connect(dave).supply(baseToken.address, ethers.constants.MaxUint256)).to.not.be.reverted;
      });

      it('dave principal is 0 after full repay', async () => {
        expect((await comet.userBasic(dave.address)).principal).to.equal(0);
      });

      it('dave borrow balance is 0 after full repay', async () => {
        expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
      });

      it('dave balanceOf is 0 (no excess was supplied)', async () => {
        expect(await comet.balanceOf(dave.address)).to.equal(0);
      });

      it('dave base token balance decreased by exactly the borrow balance', async () => {
        const daveBaseTokenBalanceAfter = await baseToken.balanceOf(dave.address);
        expect(daveBaseTokenBalanceBefore.sub(daveBaseTokenBalanceAfter)).to.equal(daveBorrowBalanceBefore);
      });

      it('comet base token balance increased by borrow balance', async () => {
        const cometBaseTokenBalanceAfter = await baseToken.balanceOf(comet.address);
        expect(cometBaseTokenBalanceAfter.sub(cometBaseTokenBalanceBefore)).to.equal(daveBorrowBalanceBefore);
      });

      it('total borrow base is 0 (dave was the only borrower)', async () => {
        const totalBorrowBaseAfter = (await comet.totalsBasic()).totalBorrowBase;
        expect(totalBorrowBaseAfter).to.equal(0);
      });

      it('dave collateral is still intact', async () => {
        expect((await comet.userCollateral(dave.address, collateral.address)).balance).to.be.equal(COLLATERAL_AMOUNT);
      });
    });

    describe('over-repay (repay more than debt - becomes supplier)', function () {
      const NEW_BORROW_AMOUNT: bigint = exp(5, baseTokenDecimals); // $5 new borrow
      const OVER_REPAY_AMOUNT: bigint = exp(10, baseTokenDecimals); // $10 repay (more than $5 debt)
      let davePrincipalBefore: BigNumber;
      let daveBorrowBalanceBefore: BigNumber;
      let daveBaseTokenBalanceBefore: BigNumber;
      let totalSupplyBaseBefore: BigNumber;

      let overRepayTx: ContractTransaction;

      before(async function () {
        // Dave creates new borrow position
        await comet.connect(dave).withdraw(baseToken.address, NEW_BORROW_AMOUNT);

        // Wait to accrue some interest
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);

        davePrincipalBefore = (await comet.userBasic(dave.address)).principal;
        daveBorrowBalanceBefore = await comet.borrowBalanceOf(dave.address);

        // Allocate over-repay amount to dave
        await baseToken.allocateTo(dave.address, OVER_REPAY_AMOUNT);
        daveBaseTokenBalanceBefore = await baseToken.balanceOf(dave.address);
        totalSupplyBaseBefore = (await comet.totalsBasic()).totalSupplyBase;
      });

      it('dave has debt before over-repay', async () => {
        expect(davePrincipalBefore).to.be.lessThan(0);
        expect(daveBorrowBalanceBefore).to.be.greaterThan(0);
      });

      it('over-repay amount is greater than borrow balance', async () => {
        expect(OVER_REPAY_AMOUNT).to.be.greaterThan(daveBorrowBalanceBefore);
      });

      it('over-repay succeeds', async () => {
        await baseToken.connect(dave).approve(comet.address, OVER_REPAY_AMOUNT);
        overRepayTx = await comet.connect(dave).supply(baseToken.address, OVER_REPAY_AMOUNT);
        await expect(overRepayTx).to.not.be.reverted;
      });

      it('emits both Supply and Transfer (mint) events when over-repaying', async () => {
        // the excess over the debt becomes dave's supply principal, minted at the post-accrual supply index
        const davePrincipalAfter = (await comet.userBasic(dave.address)).principal;
        const { baseSupplyIndex } = await comet.totalsBasic();
        const mintedAmount = presentValueSupply(baseSupplyIndex, davePrincipalAfter);

        await expect(overRepayTx).to.emit(comet, 'Supply').withArgs(dave.address, dave.address, OVER_REPAY_AMOUNT);
        await expect(overRepayTx).to.emit(comet, 'Transfer').withArgs(ZERO_ADDRESS, dave.address, mintedAmount);
      });

      it('dave principal is now positive (became supplier)', async () => {
        const davePrincipalAfter = (await comet.userBasic(dave.address)).principal;
        expect(davePrincipalAfter).to.be.greaterThan(0);
      });

      it('dave borrow balance is 0', async () => {
        expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
      });

      it('dave balanceOf is greater than 0 (has supply position)', async () => {
        expect(await comet.balanceOf(dave.address)).to.be.greaterThan(0);
      });

      it('dave base token balance decreased by over-repay amount', async () => {
        const daveBaseTokenBalanceAfter = await baseToken.balanceOf(dave.address);
        expect(daveBaseTokenBalanceBefore.sub(daveBaseTokenBalanceAfter)).to.equal(OVER_REPAY_AMOUNT);
      });

      it('total borrow base is 0', async () => {
        const totalBorrowBaseAfter = (await comet.totalsBasic()).totalBorrowBase;
        expect(totalBorrowBaseAfter).to.equal(0);
      });

      it('total supply base increased', async () => {
        const totalSupplyBaseAfter = (await comet.totalsBasic()).totalSupplyBase;
        expect(totalSupplyBaseAfter).to.be.greaterThan(totalSupplyBaseBefore);
      });

      it('dave collateral is still intact', async () => {
        expect((await comet.userCollateral(dave.address, collateral.address)).balance).to.be.equal(COLLATERAL_AMOUNT);
      });
    });

    describe('repay on behalf (supplyTo)', function () {
      const NEW_BORROW_AMOUNT: bigint = exp(5, baseTokenDecimals); // $5 new borrow
      const REPAY_ON_BEHALF_AMOUNT: bigint = exp(3, baseTokenDecimals); // $3 repay
      let davePrincipalBefore: BigNumber;
      let daveBorrowBalanceBefore: BigNumber;
      let aliceBaseTokenBalanceBefore: BigNumber;
      let daveBaseTokenBalanceBefore: BigNumber;
      let alicePrincipalBefore: BigNumber;
      let _totalBorrowBaseBefore: BigNumber;

      before(async function () {
        // First, dave withdraws his supply and creates new borrow
        const daveBalance = await comet.balanceOf(dave.address);
        if (daveBalance.gt(0)) {
          await comet.connect(dave).withdraw(baseToken.address, daveBalance);
        }

        // Dave creates new borrow position
        await comet.connect(dave).withdraw(baseToken.address, NEW_BORROW_AMOUNT);

        // Wait to accrue some interest
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);

        davePrincipalBefore = (await comet.userBasic(dave.address)).principal;
        daveBorrowBalanceBefore = await comet.borrowBalanceOf(dave.address);
        aliceBaseTokenBalanceBefore = await baseToken.balanceOf(alice.address);
        daveBaseTokenBalanceBefore = await baseToken.balanceOf(dave.address);
        alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
        _totalBorrowBaseBefore = (await comet.totalsBasic()).totalBorrowBase;
      });

      it('dave has debt', async () => {
        expect(davePrincipalBefore).to.be.lessThan(0);
      });

      it('alice repays on behalf of dave using supplyTo', async () => {
        await baseToken.connect(alice).approve(comet.address, REPAY_ON_BEHALF_AMOUNT);
        await expect(comet.connect(alice).supplyTo(dave.address, baseToken.address, REPAY_ON_BEHALF_AMOUNT)).to.not.be.reverted;
      });

      it('alice base token balance decreased', async () => {
        const aliceBaseTokenBalanceAfter = await baseToken.balanceOf(alice.address);
        expect(aliceBaseTokenBalanceBefore.sub(aliceBaseTokenBalanceAfter)).to.equal(REPAY_ON_BEHALF_AMOUNT);
      });

      it('dave base token balance unchanged', async () => {
        const daveBaseTokenBalanceAfter = await baseToken.balanceOf(dave.address);
        expect(daveBaseTokenBalanceAfter).to.equal(daveBaseTokenBalanceBefore);
      });

      it('dave principal increased (debt reduced)', async () => {
        const davePrincipalAfter = (await comet.userBasic(dave.address)).principal;
        expect(davePrincipalAfter).to.be.greaterThan(davePrincipalBefore);
      });

      it('dave borrow balance decreased', async () => {
        const daveBorrowBalanceAfter = await comet.borrowBalanceOf(dave.address);
        expect(daveBorrowBalanceAfter).to.be.lessThan(daveBorrowBalanceBefore);
      });

      it('alice principal unchanged (she did not become supplier from this)', async () => {
        const alicePrincipalAfter = (await comet.userBasic(alice.address)).principal;
        expect(alicePrincipalAfter).to.equal(alicePrincipalBefore);
      });
    });

    describe('repay with accrued interest', function () {
      const NEW_BORROW_AMOUNT: bigint = exp(5, baseTokenDecimals);
      let borrowBalanceInitial: BigNumber;
      let borrowBalanceAfterTime: BigNumber;

      before(async function () {
        // First, fully repay dave's existing debt
        const currentBorrowBalance = await comet.borrowBalanceOf(dave.address);
        if (currentBorrowBalance.gt(0)) {
          await baseToken.allocateTo(dave.address, currentBorrowBalance);
          await baseToken.connect(dave).approve(comet.address, currentBorrowBalance);
          await comet.connect(dave).supply(baseToken.address, ethers.constants.MaxUint256);
        }

        // Dave creates new borrow
        await comet.connect(dave).withdraw(baseToken.address, NEW_BORROW_AMOUNT);
        borrowBalanceInitial = await comet.borrowBalanceOf(dave.address);

        // Wait significant time for interest to accrue
        await ethers.provider.send('evm_increaseTime', [3600]);
        await ethers.provider.send('evm_mine', []);

        borrowBalanceAfterTime = await comet.borrowBalanceOf(dave.address);
      });

      it('borrow balance increased due to interest', async () => {
        expect(borrowBalanceAfterTime).to.be.greaterThan(borrowBalanceInitial);
      });

      it('interest is reflected in borrow balance', async () => {
        const interestAccrued = borrowBalanceAfterTime.sub(borrowBalanceInitial);
        expect(interestAccrued).to.be.greaterThan(0);
      });

      it('repaying full borrow balance (including interest) clears debt', async () => {
        await baseToken.allocateTo(dave.address, borrowBalanceAfterTime.mul(2)); // Extra to cover any new interest
        await baseToken.connect(dave).approve(comet.address, borrowBalanceAfterTime.mul(2));
        await comet.connect(dave).supply(baseToken.address, ethers.constants.MaxUint256);

        expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
        expect((await comet.userBasic(dave.address)).principal).to.equal(0);
      });
    });

    describe('repay edge cases', function () {
      // each case starts from the state the repay flows left (dave holds collateral); the `repay` afterAll restores after
      let edgeFixture: SnapshotRestorer;

      before(async function () {
        edgeFixture = await takeSnapshot();
      });

      describe('repay while supply is paused', function () {
        before(async function () {
          await edgeFixture.restore();
          // Create new borrow
          await comet.connect(dave).withdraw(baseToken.address, exp(1, baseTokenDecimals));
          await baseToken.allocateTo(dave.address, exp(1, baseTokenDecimals));
          await baseToken.connect(dave).approve(comet.address, exp(1, baseTokenDecimals));

          await comet.connect(pauseGuardian).pause(true, false, false, false, false);
        });

        it('supply is paused', async () => {
          expect(await comet.isSupplyPaused()).to.be.true;
        });

        it('repay reverts with Paused', async () => {
          await expect(comet.connect(dave).supply(baseToken.address, exp(1, baseTokenDecimals)))
            .to.be.revertedWithCustomError(comet, 'Paused');
        });
      });

      describe('withdraw collateral after repaying all debt', function () {
        let collateralBalance: BigNumber;

        before(async function () {
          await edgeFixture.restore();
          // Create new borrow, then repay all of it with MaxUint
          await comet.connect(dave).withdraw(baseToken.address, exp(1, baseTokenDecimals));
          const borrowBalance = await comet.borrowBalanceOf(dave.address);
          await baseToken.allocateTo(dave.address, borrowBalance.mul(2));
          await baseToken.connect(dave).approve(comet.address, ethers.constants.MaxUint256);
          await comet.connect(dave).supply(baseToken.address, ethers.constants.MaxUint256);

          collateralBalance = (await comet.userCollateral(dave.address, collateral.address)).balance;
        });

        it('dave has no debt left', async () => {
          expect(await comet.borrowBalanceOf(dave.address)).to.equal(0);
          expect(collateralBalance).to.be.greaterThan(0);
        });

        it('dave withdraws all of his collateral', async () => {
          await expect(comet.connect(dave).withdraw(collateral.address, collateralBalance)).to.not.be.reverted;
        });

        it("dave's collateral balance is 0", async () => {
          expect((await comet.userCollateral(dave.address, collateral.address)).balance).to.equal(0);
        });
      });
    });
  });

  describe('supply collateral', function () {
    const ASSET_SYMBOL = 'COMP';
    let collateral: FaucetToken | NonStandardFaucetFeeToken;

    before(async function () {
      collateral = collaterals[ASSET_SYMBOL];
      const collateralIndex = (await comet.getAssetInfoByAddress(collateral.address)).offset;
      const supplyCap = (await comet.getAssetInfo(collateralIndex)).supplyCap;
      await collateral.allocateTo(alice.address, supplyCap.add(exp(1, 18)));
      await collateral.allocateTo(bob.address, exp(1e10, 18));
    });
    
    describe('reverts', function () {
      it('reverts if supply is paused', async () => {
        await comet.connect(pauseGuardian).pause(true, false, false, false, false);
        expect(await comet.isSupplyPaused()).to.be.true;

        await expect(comet.connect(alice).supply(collateral.address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if collateral supply is paused', async () => {
        await comet.connect(pauseGuardian).pauseCollateralSupply(true);
        expect(await comet.isCollateralSupplyPaused()).to.be.true;

        await expect(comet.connect(alice).supply(collateral.address, 1)).to.be.revertedWithCustomError(comet, 'CollateralSupplyPaused');
        await comet.connect(pauseGuardian).pauseCollateralSupply(false);
      });

      it('reverts if specific collateral supply is paused', async () => {
        await comet.connect(pauseGuardian).pauseCollateralAssetSupply(0, true);
        expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.true;

        await collateral.connect(alice).approve(comet.address, 1);
        await expect(comet.connect(alice).supply(collateral.address, 1)).to.be.revertedWithCustomError(comet, 'CollateralAssetSupplyPaused');
        await comet.connect(pauseGuardian).pauseCollateralAssetSupply(0, false);
      });

      it('reverts for not enough collateral balance', async () => {
        const balanceBefore = await collateral.balanceOf(alice.address);

        await collateral.connect(alice).approve(comet.address, balanceBefore.add(1));
        await expect(comet.connect(alice).supply(collateral.address, balanceBefore.add(1))).to.be.reverted;
        await collateral.connect(alice).approve(comet.address, 0);
      });

      it('reverts if supplying collateral exceeds the supply cap', async () => {
        const collateralIndex = (await comet.getAssetInfoByAddress(collateral.address)).offset;
        const supplyCap = (await comet.getAssetInfo(collateralIndex)).supplyCap;

        // health check
        expect(await collateral.balanceOf(alice.address)).is.greaterThan(supplyCap);

        await collateral.connect(alice).approve(comet.address, supplyCap.add(1));
        await expect(comet.connect(alice).supply(collateral.address, supplyCap.add(1))).to.be.revertedWithCustomError(
          comet,
          'SupplyCapExceeded'
        );
        await collateral.connect(alice).approve(comet.address, 0);
      });
    });

    describe('supply collateral: happy path', function () {
      const ALICE_COLLATERAL_AMOUNT: bigint = exp(5, 17); //0.5 of token
      const ALICE_ANOTHER_COLLATERAL_AMOUNT: bigint = exp(1, 17);
      const SKIP_TIME: number = 60 * 60; // 1 hr
      let aliceCollateralBalanceBefore: BigNumber;
      let totalSupplyBefore: BigNumber;
      let alicePrincipalBefore: BigNumber;
      let cometUpdatedTimeBefore: number;
      let supplyTx: ContractTransaction;
      let cometSupplyIndexBefore: BigNumber;
      let cometSupplyRateBefore: BigNumber;
      let aliceDisplayBalanceBefore: BigNumber;
      let supplyTimestamp: BigNumber;
      let cometBorrowIndexBefore: BigNumber;
      let trackingSupplyIndexBefore: BigNumber;
      let trackingBorrowIndexBefore: BigNumber;
      let aliceBaseTrackingIndexBefore: BigNumber;
      let aliceBaseTrackingAccruedBefore: BigNumber;
      let baseTrackingSupplySpeedVal: BigNumber;
      let trackingIndexScaleVal: BigNumber;
      let borrowRateBefore: BigNumber;
      let utilizationBefore: BigNumber;

      before(async function () {
        // Accrue state before supply
        await comet.accrueAccount(ethers.constants.AddressZero);

        const totals = await comet.totalsBasic();
        aliceCollateralBalanceBefore = await collateral.balanceOf(alice.address);

        totalSupplyBefore = totals.totalSupplyBase;
        cometSupplyIndexBefore = totals.baseSupplyIndex;
        cometSupplyRateBefore = await comet.getSupplyRate(await comet.getUtilization());
        alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
        aliceDisplayBalanceBefore = await comet.balanceOf(alice.address);

        cometUpdatedTimeBefore = totals.lastAccrualTime;

        cometBorrowIndexBefore = totals.baseBorrowIndex;
        trackingSupplyIndexBefore = totals.trackingSupplyIndex;
        trackingBorrowIndexBefore = totals.trackingBorrowIndex;
        utilizationBefore = await comet.getUtilization();
        borrowRateBefore = await comet.getBorrowRate(utilizationBefore);
        baseTrackingSupplySpeedVal = await comet.baseTrackingSupplySpeed();
        trackingIndexScaleVal = await comet.trackingIndexScale();
        const aliceBasic = await comet.userBasic(alice.address);
        aliceBaseTrackingIndexBefore = aliceBasic.baseTrackingIndex;
        aliceBaseTrackingAccruedBefore = aliceBasic.baseTrackingAccrued;

        // wait for a while to have impact from accrual
        await ethers.provider.send('evm_increaseTime', [SKIP_TIME]); // 1 hr
        await ethers.provider.send('evm_mine', []);
      });

      it('should not have collateral registered for a user', async () => {
        const collateralIndex = (await comet.getAssetInfoByAddress(collateral.address)).offset;
        const userData = await comet.userBasic(alice.address);
        const offset = 1 << collateralIndex;

        expect(userData.assetsIn & offset).to.equal(0);
      });

      it('should not have collateral in the storage', async () => {
        expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(0);
        expect((await comet.userCollateral(alice.address, collateral.address)).balance).to.equal(0);
      });

      it('should not have collateral on the balance', async () => {
        expect(await collateral.balanceOf(comet.address)).to.equal(0);
      });

      it('should allow collateral deposit', async () => {
        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        supplyTx = await comet.connect(alice).supply(collateral.address, ALICE_COLLATERAL_AMOUNT);
        await expect(supplyTx).to.not.be.reverted;
      });

      it('should emit event during 1st collateral deposit', async () => {
        await expect(supplyTx)
          .to.emit(comet, 'SupplyCollateral')
          .withArgs(alice.address, alice.address, collateral.address, ALICE_COLLATERAL_AMOUNT);
      });

      it("collateral is added to user's tokens", async () => {
        const collateralIndex = (await comet.getAssetInfoByAddress(collateral.address)).offset;
        const userData = await comet.userBasic(alice.address);
        const offset = 1 << collateralIndex;

        expect(userData.assetsIn & offset).to.equal(offset);
      });

      it('exact collateral token balance is supplied from alice', async () => {
        const aliceCollateralBalanceAfter = await collateral.balanceOf(alice.address);
        expect(aliceCollateralBalanceBefore.sub(aliceCollateralBalanceAfter)).to.equal(ALICE_COLLATERAL_AMOUNT);
      });

      it("Comet's collateral token balance grows", async () => {
        expect(await collateral.balanceOf(comet.address)).to.equal(ALICE_COLLATERAL_AMOUNT);
      });

      it("should correctly set alice's collateral balance", async () => {
        expect((await comet.userCollateral(alice.address, collateral.address)).balance).to.equal(ALICE_COLLATERAL_AMOUNT);
      });

      it("should correctly set comet's total balance", async () => {
        expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(ALICE_COLLATERAL_AMOUNT);
      });

      it('should accrue state during collateral supply', async () => {
        const lastUpdated = (await comet.totalsBasic()).lastAccrualTime;
        supplyTimestamp = BigNumber.from(
          (await ethers.provider.getBlock((await supplyTx.wait()).blockNumber)).timestamp
        );

        expect(lastUpdated - cometUpdatedTimeBefore).to.be.approximately(SKIP_TIME, 5); // 5 seconds tolerance
        expect(lastUpdated).to.equal(supplyTimestamp);
      });

      it('should not change alice principal after accrual (no collateral effect on principal)', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.equal(alicePrincipalBefore);
      });

      it('should have correct display of alice principal', async () => {
        const timeElapsed = supplyTimestamp.sub(cometUpdatedTimeBefore);
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // health check that the current index is re-calculated correctly, and that it really moved
        const index = (await comet.totalsBasic()).baseSupplyIndex;
        expect(index).to.be.greaterThan(cometSupplyIndexBefore);
        expect(index).to.equal(accruedIndex);

        const newBalanceFromPrincipal = alicePrincipalBefore.mul(accruedIndex).div(exp(1, 15));

        // current balance
        const newBalance = await comet.balanceOf(alice.address);

        expect(newBalance).to.equal(newBalanceFromPrincipal);
        // the base supply rate pays alice interest over the skipped hour
        expect(newBalance).to.be.greaterThan(aliceDisplayBalanceBefore);
      });

      it("comet's stored total supply is unchanged after accrual (no collateral effect on supply)", async () => {
        expect((await comet.totalsBasic()).totalSupplyBase).to.equal(totalSupplyBefore);
      });

      it('should have correct display of total supply (present value of the unchanged principal)', async () => {
        // totalSupply() is a present value; totalSupplyBefore is a principal, so convert with the current index
        const { baseSupplyIndex, totalSupplyBase } = await comet.totalsBasic();
        expect(totalSupplyBase).to.equal(totalSupplyBefore);
        expect(await comet.totalSupply()).to.equal(presentValueSupply(baseSupplyIndex, totalSupplyBase));
      });

      it('trackingSupplyIndex grows correctly during collateral supply accrual', async () => {
        // accrueInternal() updates trackingSupplyIndex when totalSupplyBase >= baseMinForRewards:
        //   trackingSupplyIndex += divBaseWei(baseTrackingSupplySpeed * timeElapsed, totalSupplyBase)
        //                        = baseTrackingSupplySpeed * timeElapsed * baseScale / totalSupplyBase
        // baseScale = 1e6 for USDC; trackingSupplyIndex is independent of the interest rate
        // Example: speed=1e15, elapsed~3600, totalSupplyBase~8e15 (~8e9 USDC principal: alice ~7e9 + bob ~1e9)
        // → delta = 1e15 * 3600 * 1e6 / 8e15 = 450
        const timeElapsed = supplyTimestamp.sub(cometUpdatedTimeBefore);
        const baseScale = exp(1, 6);
        const expectedTrackingSupplyIndex = trackingSupplyIndexBefore.add(
          baseTrackingSupplySpeedVal.mul(timeElapsed).mul(baseScale).div(totalSupplyBefore)
        );
        expect((await comet.totalsBasic()).trackingSupplyIndex).to.equal(expectedTrackingSupplyIndex);
      });

      it('trackingBorrowIndex is unchanged when totalBorrowBase is zero', async () => {
        // sanity check that totalBorrowBase < baseMinForRewards
        expect((await comet.totalsBasic()).totalBorrowBase).to.be.lessThan(await comet.baseMinForRewards());

        // accrueInternal() only updates trackingBorrowIndex if totalBorrowBase >= baseMinForRewards
        // With no active borrows, totalBorrowBase = 0 and the condition is not satisfied
        expect((await comet.totalsBasic()).trackingBorrowIndex).to.equal(trackingBorrowIndexBefore);
      });

      it('baseSupplyIndex accrues correctly during collateral supply', async () => {
        // baseSupplyIndex += mulFactor(baseSupplyIndex, supplyRate * timeElapsed)
        //                  = baseSupplyIndex + baseSupplyIndex * supplyRate * timeElapsed / 1e18
        // supplyRate is the rate at the real utilization read in `before` (the base rate here), so the index moves
        const timeElapsed = supplyTimestamp.sub(cometUpdatedTimeBefore);
        const expectedBaseSupplyIndex = cometSupplyIndexBefore.add(
          cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18))
        );
        expect(cometSupplyRateBefore).to.be.greaterThan(0);
        expect((await comet.totalsBasic()).baseSupplyIndex).to.be.greaterThan(cometSupplyIndexBefore);
        expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(expectedBaseSupplyIndex);
      });

      it('baseBorrowIndex accrues correctly during collateral supply', async () => {
        // baseBorrowIndex += mulFactor(baseBorrowIndex, borrowRate * timeElapsed)
        //                  = baseBorrowIndex + baseBorrowIndex * borrowRate * timeElapsed / 1e18
        // With no borrows, getBorrowRate returns 0 and the borrow index is unchanged
        const timeElapsed = supplyTimestamp.sub(cometUpdatedTimeBefore);
        const expectedBaseBorrowIndex = cometBorrowIndexBefore.add(
          cometBorrowIndexBefore.mul(borrowRateBefore).mul(timeElapsed).div(exp(1, 18))
        );
        expect((await comet.totalsBasic()).baseBorrowIndex).to.equal(expectedBaseBorrowIndex);
      });

      it('alice baseTrackingAccrued increases via supply tracking during collateral supply', async () => {
        // accrueAccountInternal(alice) calls updateBasePrincipal, accumulating rewards since her last sync.
        // alice.principal >= 0 so supply tracking applies:
        //   indexDelta = trackingSupplyIndex_new - alice.baseTrackingIndex_before
        //   baseTrackingAccrued += principal * indexDelta / trackingIndexScale / accrualDescaleFactor
        // accrualDescaleFactor = baseScale / BASE_ACCRUAL_SCALE = 1e6 / 1e6 = 1 for USDC
        // trackingIndexScale = 1e15 (default)
        const timeElapsed = supplyTimestamp.sub(cometUpdatedTimeBefore);
        const baseScale = exp(1, 6);
        const trackingSupplyIndexNew = trackingSupplyIndexBefore.add(
          baseTrackingSupplySpeedVal.mul(timeElapsed).mul(baseScale).div(totalSupplyBefore)
        );
        // indexDelta spans from alice's last synced tracking index to the new global index
        const indexDelta = trackingSupplyIndexNew.sub(aliceBaseTrackingIndexBefore);
        // accrualDescaleFactor = 1 for USDC (baseScale / BASE_ACCRUAL_SCALE = 1e6 / 1e6)
        const expectedAccrued = aliceBaseTrackingAccruedBefore.add(
          alicePrincipalBefore.mul(indexDelta).div(trackingIndexScaleVal)
        );
        expect((await comet.userBasic(alice.address)).baseTrackingAccrued).to.equal(expectedAccrued);
      });

      it('utilization is zero after collateral supply when there are no borrows', async () => {
        // Supplying collateral does not change totalSupplyBase or totalBorrowBase (principals unchanged)
        // With totalBorrowBase = 0, getUtilization() returns 0
        expect(await comet.getUtilization()).to.equal(0);
        expect(await comet.getUtilization()).to.equal(utilizationBefore);
      });

      it('should allow deposit more of the same collateral', async () => {
        aliceCollateralBalanceBefore = (await comet.userCollateral(alice.address, collateral.address)).balance;
        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collateral.address, ALICE_COLLATERAL_AMOUNT);

        expect((await comet.userCollateral(alice.address, collateral.address)).balance).to.equal(
          aliceCollateralBalanceBefore.add(ALICE_COLLATERAL_AMOUNT)
        );
      });

      it('should allow deposit another collateral token', async () => {
        await collaterals['WETH'].allocateTo(alice.address, ALICE_ANOTHER_COLLATERAL_AMOUNT); //0.1 token

        // health check
        expect((await comet.userCollateral(alice.address, collaterals['WETH'].address)).balance).to.equal(0);

        await collaterals['WETH'].connect(alice).approve(comet.address, ALICE_ANOTHER_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(collaterals['WETH'].address, ALICE_ANOTHER_COLLATERAL_AMOUNT);

        expect((await comet.userCollateral(alice.address, collaterals['WETH'].address)).balance).to.equal(ALICE_ANOTHER_COLLATERAL_AMOUNT);
      });

      it('should have no impact on a previous collateral deposit', async () => {
        expect((await comet.userCollateral(alice.address, collateral.address)).balance).to.equal(
          aliceCollateralBalanceBefore.add(ALICE_COLLATERAL_AMOUNT)
        );
      });

      it('supply of collateral from Bob should not affect Alice', async () => {
        const aliceBalanceBefore = (await comet.userCollateral(alice.address, collateral.address)).balance;
        const totalCollateralSupplyBefore = (await comet.totalsCollateral(collateral.address)).totalSupplyAsset;

        await collateral.connect(bob).approve(comet.address, ALICE_ANOTHER_COLLATERAL_AMOUNT);
        await comet.connect(bob).supply(collateral.address, ALICE_ANOTHER_COLLATERAL_AMOUNT);

        expect((await comet.userCollateral(alice.address, collateral.address)).balance).to.equal(aliceBalanceBefore);
        expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(totalCollateralSupplyBefore.add(ALICE_ANOTHER_COLLATERAL_AMOUNT));
      });
    });

    // Tests that supplyCollateral correctly accrues indices when the recipient holds a net borrow
    // position (negative base principal). This complements the zero-borrow describe above by
    // showing indices that were flat there (baseSupplyIndex, baseBorrowIndex, trackingBorrowIndex)
    // now grow, and alice's baseTrackingAccrued accrues via borrow tracking (not supply tracking).
    describe('supply collateral: accrual with active borrow (non-zero utilization)', function () {
      const SKIP_TIME = 3600; // 1 hour
      // 400 USDC borrow — alice's collateral (1 COMP + 0.1 WETH) supports up to ~$475 of borrows
      const ALICE_BORROW_AMOUNT: bigint = exp(400, 6);
      const ALICE_COLLATERAL_SUPPLY: bigint = exp(1, 18); // 1 COMP

      let baseSupplyIndexBefore: BigNumber;
      let baseBorrowIndexBefore: BigNumber;
      let trackingSupplyIndexBefore: BigNumber;
      let trackingBorrowIndexBefore: BigNumber;
      let totalSupplyBaseBefore: BigNumber;
      let totalBorrowBaseBefore: BigNumber;
      let lastAccrualTimeBefore: number;
      let alicePrincipalBefore: BigNumber;
      let aliceBaseTrackingIndexBefore: BigNumber;
      let aliceBaseTrackingAccruedBefore: BigNumber;
      let baseTrackingSupplySpeedVal: BigNumber;
      let baseTrackingBorrowSpeedVal: BigNumber;
      let trackingIndexScaleVal: BigNumber;
      let supplyRateBefore: BigNumber;
      let borrowRateBefore: BigNumber;
      let utilizationBefore: BigNumber;
      let supplyCollateralTx: ContractTransaction;
      let supplyTimestamp: number;

      // As this is additional edge case block, we take snapshot to restore state after it
      let snapshot: SnapshotRestorer;

      before(async function () {
        snapshot = await takeSnapshot();
        // Alice withdraws her entire base supply balance plus ALICE_BORROW_AMOUNT in a single call.
        // This transitions alice from a net supplier to a net borrower (negative principal),
        // which makes totalBorrowBase > 0 and creates non-zero utilization and rates.
        // Her existing collateral (1 COMP + 0.1 WETH ≈ $475) covers the $400 USDC net borrow.
        const aliceDisplayBalance = await comet.balanceOf(alice.address);
        await comet.connect(alice).withdraw(baseToken.address, aliceDisplayBalance.add(ALICE_BORROW_AMOUNT));

        // Capture global indices and alice state right before the time advance
        const totals = await comet.totalsBasic();
        baseSupplyIndexBefore = totals.baseSupplyIndex;
        baseBorrowIndexBefore = totals.baseBorrowIndex;
        trackingSupplyIndexBefore = totals.trackingSupplyIndex;
        trackingBorrowIndexBefore = totals.trackingBorrowIndex;
        totalSupplyBaseBefore = totals.totalSupplyBase;
        totalBorrowBaseBefore = totals.totalBorrowBase;
        lastAccrualTimeBefore = totals.lastAccrualTime;

        utilizationBefore = await comet.getUtilization();
        supplyRateBefore = await comet.getSupplyRate(utilizationBefore);
        borrowRateBefore = await comet.getBorrowRate(utilizationBefore);

        baseTrackingSupplySpeedVal = await comet.baseTrackingSupplySpeed();
        baseTrackingBorrowSpeedVal = await comet.baseTrackingBorrowSpeed();
        trackingIndexScaleVal = await comet.trackingIndexScale();

        // alice.principal is now negative; baseTrackingIndex was set to trackingBorrowIndex during withdrawal
        const aliceBasic = await comet.userBasic(alice.address);
        alicePrincipalBefore = aliceBasic.principal;
        aliceBaseTrackingIndexBefore = aliceBasic.baseTrackingIndex;
        aliceBaseTrackingAccruedBefore = aliceBasic.baseTrackingAccrued;

        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_SUPPLY);
      });

      it('health check: alice has a negative base principal (net borrower)', () => {
        expect(alicePrincipalBefore).to.be.lessThan(0);
      });

      it('health check: totalBorrowBase exceeds baseMinForRewards', async () => {
        const baseMinForRewards = await comet.baseMinForRewards();
        expect(totalBorrowBaseBefore).to.be.greaterThan(baseMinForRewards);
      });

      it('health check: utilization is greater than zero', () => {
        expect(utilizationBefore).to.be.greaterThan(0);
      });

      it('1 hour passes', async () => {
        await ethers.provider.send('evm_increaseTime', [SKIP_TIME]);
        await ethers.provider.send('evm_mine', []);
      });

      it('alice supplies COMP collateral, triggering accrueAccountInternal', async () => {
        supplyCollateralTx = await comet.connect(alice).supply(collateral.address, ALICE_COLLATERAL_SUPPLY);
        await expect(supplyCollateralTx).to.not.be.reverted;
        supplyTimestamp = (await ethers.provider.getBlock((await supplyCollateralTx.wait()).blockNumber)).timestamp;
      });

      it('baseSupplyIndex grows when supply rate is non-zero', async () => {
        // baseSupplyIndex += mulFactor(baseSupplyIndex, supplyRate * timeElapsed)
        //                  = baseSupplyIndex + baseSupplyIndex * supplyRate * timeElapsed / 1e18
        // supplyRate > 0 because utilization > 0 (alice's 400 USDC borrow)
        // Unlike the zero-borrow case above, this index now actually grows
        const timeElapsed = BigNumber.from(supplyTimestamp - lastAccrualTimeBefore);
        const expectedIndex = baseSupplyIndexBefore.add(
          baseSupplyIndexBefore.mul(supplyRateBefore).mul(timeElapsed).div(exp(1, 18))
        );
        expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(expectedIndex);
      });

      it('baseBorrowIndex grows when borrow rate is non-zero', async () => {
        // baseBorrowIndex += mulFactor(baseBorrowIndex, borrowRate * timeElapsed)
        //                  = baseBorrowIndex + baseBorrowIndex * borrowRate * timeElapsed / 1e18
        // borrowRate > 0 because totalBorrowBase > 0 and utilization > 0
        const timeElapsed = BigNumber.from(supplyTimestamp - lastAccrualTimeBefore);
        const expectedIndex = baseBorrowIndexBefore.add(
          baseBorrowIndexBefore.mul(borrowRateBefore).mul(timeElapsed).div(exp(1, 18))
        );
        expect((await comet.totalsBasic()).baseBorrowIndex).to.equal(expectedIndex);
      });

      it('trackingBorrowIndex grows when totalBorrowBase exceeds baseMinForRewards', async () => {
        // trackingBorrowIndex += divBaseWei(baseTrackingBorrowSpeed * timeElapsed, totalBorrowBase)
        //                      = baseTrackingBorrowSpeed * timeElapsed * baseScale / totalBorrowBase
        const timeElapsed = BigNumber.from(supplyTimestamp - lastAccrualTimeBefore);
        const baseScale = exp(1, 6);
        const expectedIndex = trackingBorrowIndexBefore.add(
          baseTrackingBorrowSpeedVal.mul(timeElapsed).mul(baseScale).div(totalBorrowBaseBefore)
        );
        expect((await comet.totalsBasic()).trackingBorrowIndex).to.equal(expectedIndex);
      });

      it('trackingSupplyIndex also grows when totalSupplyBase exceeds baseMinForRewards', async () => {
        // trackingSupplyIndex += divBaseWei(baseTrackingSupplySpeed * timeElapsed, totalSupplyBase)
        //                      = baseTrackingSupplySpeed * timeElapsed * baseScale / totalSupplyBase
        const timeElapsed = BigNumber.from(supplyTimestamp - lastAccrualTimeBefore);
        const baseScale = exp(1, 6);
        const expectedIndex = trackingSupplyIndexBefore.add(
          baseTrackingSupplySpeedVal.mul(timeElapsed).mul(baseScale).div(totalSupplyBaseBefore)
        );
        expect((await comet.totalsBasic()).trackingSupplyIndex).to.equal(expectedIndex);
      });

      it('alice baseTrackingAccrued accumulates borrow rewards via trackingBorrowIndex', async () => {
        // alice.principal < 0 (net borrower), so updateBasePrincipal uses borrow tracking:
        //   indexDelta = trackingBorrowIndex_new - alice.baseTrackingIndex_before
        //   baseTrackingAccrued += |principal| * indexDelta / trackingIndexScale / accrualDescaleFactor
        // alice.baseTrackingIndex was set to trackingBorrowIndex at withdrawal time (same block as capture),
        // so indexDelta = trackingBorrowIndex_new - trackingBorrowIndexBefore
        // accrualDescaleFactor = baseScale / BASE_ACCRUAL_SCALE = 1e6 / 1e6 = 1 for USDC
        const timeElapsed = BigNumber.from(supplyTimestamp - lastAccrualTimeBefore);
        const baseScale = exp(1, 6);
        const trackingBorrowIndexNew = trackingBorrowIndexBefore.add(
          baseTrackingBorrowSpeedVal.mul(timeElapsed).mul(baseScale).div(totalBorrowBaseBefore)
        );
        // indexDelta spans from alice's last synced borrow tracking index to the new global value
        const indexDelta = trackingBorrowIndexNew.sub(aliceBaseTrackingIndexBefore);
        // accrualDescaleFactor = 1 for USDC (baseScale / BASE_ACCRUAL_SCALE = 1e6 / 1e6)
        const expectedAccrued = aliceBaseTrackingAccruedBefore.add(
          alicePrincipalBefore.abs().mul(indexDelta).div(trackingIndexScaleVal)
        );
        expect((await comet.userBasic(alice.address)).baseTrackingAccrued).to.equal(expectedAccrued);
      });

      it('utilization is greater than zero after collateral supply accrual', async () => {
        // Active borrow (alice's 400 USDC net position) keeps utilization above zero.
        // Supplying collateral does not change totalSupplyBase or totalBorrowBase principals.
        expect(await comet.getUtilization()).to.be.greaterThan(0);
      });

      it('collateral supply leaves both base principals unchanged', async () => {
        const totals = await comet.totalsBasic();
        expect(totals.totalSupplyBase).to.equal(totalSupplyBaseBefore);
        expect(totals.totalBorrowBase).to.equal(totalBorrowBaseBefore);
      });

      it('utilization moved only through accrual: it falls, as the supply rate is above the borrow rate', async () => {
        // principals are unchanged, so utilization = B * borrowIndex / (S * supplyIndex) changes by (borrowRate - supplyRate).
        // The fixture's 1% base supply rate (paid from the seed reserves) is above the borrow rate at this utilization,
        // so the supply index grows faster and utilization goes down.
        expect(supplyRateBefore).to.be.greaterThan(borrowRateBefore);
        expect(await comet.getUtilization()).to.be.lessThan(utilizationBefore);
      });

      it("utilization is consistent with the comet's displayed totals", async () => {
        // cross-check against the public views instead of re-deriving it from the stored indices
        const expectedUtilization = (await comet.totalBorrow()).mul(exp(1, 18)).div(await comet.totalSupply());
        expect(await comet.getUtilization()).to.equal(expectedUtilization);
      });

      // alice is a borrower in this flow only: put the state back for the flows after it, even if a step failed
      after(async function () {
        await snapshot.restore();
      });
    });
  });

  describe('supply flows variations (from/to)', function () {
    const ALICE_BASE_AMOUNT: BigNumber = ethers.utils.parseUnits('0.05', baseTokenDecimals); //0.05 of base token
    const ALICE_COLLATERAL_AMOUNT: BigNumber = ethers.utils.parseUnits('0.2', 18); //0.2 of token
    let cometBaseBalanceBefore: BigNumber;
    let aliceBaseBalanceBefore: BigNumber;
    let cometCollateralBalanceBefore: BigNumber;
    let aliceCollateralBalanceBefore: BigNumber;
    let aliceCollateralBefore: BigNumber;
    let bobCollateralBefore: BigNumber;

    let alicePrincipalBefore: BigNumber;
    let bobPrincipalBefore: BigNumber;
    let cometSupplyIndexBefore: BigNumber;
    let cometSupplyRateBefore: BigNumber;
    let cometUpdatedTimeBefore: number;

    let collateral: FaucetToken | NonStandardFaucetFeeToken;

    /** Index after accruing at the rate read in `before` from the last accrual up to `timestamp`. */
    function accruedSupplyIndex(timestamp: number): BigNumber {
      return cometSupplyIndexBefore.add(
        cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timestamp - cometUpdatedTimeBefore).div(exp(1, 18))
      );
    }

    before(async function () {
      collateral = collaterals['COMP'];
      const collateralIndex = (await comet.getAssetInfoByAddress(collateral.address)).offset;
      const supplyCap = (await comet.getAssetInfo(collateralIndex)).supplyCap;
      await collateral.allocateTo(alice.address, supplyCap.add(exp(1, 18)));
      await collateral.allocateTo(bob.address, exp(1e10, 18));

      const totals = await comet.totalsBasic();
      cometBaseBalanceBefore = await baseToken.balanceOf(comet.address);
      aliceBaseBalanceBefore = await baseToken.balanceOf(alice.address);
      cometCollateralBalanceBefore = await collateral.balanceOf(comet.address);
      aliceCollateralBalanceBefore = await collateral.balanceOf(alice.address);

      aliceCollateralBefore = (await comet.userCollateral(alice.address, collateral.address)).balance;
      bobCollateralBefore = (await comet.userCollateral(bob.address, collateral.address)).balance;

      cometSupplyIndexBefore = totals.baseSupplyIndex;
      cometSupplyRateBefore = await comet.getSupplyRate(await comet.getUtilization());
      cometUpdatedTimeBefore = totals.lastAccrualTime;
      alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
      bobPrincipalBefore = (await comet.userBasic(bob.address)).principal;

      // wait for a while to have impact from accrual
      await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
      await ethers.provider.send('evm_mine', []);
    });

    describe('supplyTo', function () {
      it('reverts for asset other than base or collateral', async () => {
        await unsupportedToken.allocateTo(alice.address, exp(1, 18));
        await unsupportedToken.connect(alice).approve(comet.address, exp(1, 18));
        await expect(comet.connect(alice).supplyTo(bob.address, unsupportedToken.address, 1)).to.be.revertedWithCustomError(comet, 'BadAsset');
      });

      it('reverts when protocol paused', async () => {
        await comet.connect(pauseGuardian).pause(true, false, false, false, false);
        expect(await comet.isSupplyPaused()).to.be.true;

        await baseToken.connect(alice).approve(comet.address, 1);
        await expect(comet.connect(alice).supplyTo(bob.address, baseToken.address, 1)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if base supply is paused', async () => {
        await comet.connect(pauseGuardian).pauseBaseSupply(true);
        expect(await comet.isBaseSupplyPaused()).to.be.true;

        await expect(comet.connect(alice).supplyTo(bob.address, baseToken.address, 1)).to.be.revertedWithCustomError(comet, 'BaseSupplyPaused');
        await comet.connect(pauseGuardian).pauseBaseSupply(false);
      });

      it('should accrue state (same as supply())', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await comet.connect(alice).supplyTo(bob.address, baseToken.address, ALICE_BASE_AMOUNT);

        const now = (await ethers.provider.getBlock('latest')).timestamp;
        expect((await comet.totalsBasic()).lastAccrualTime).to.equal(now);
        // the index accrued at the base rate over the skipped hour, as in supply()
        expect(cometSupplyRateBefore).to.be.greaterThan(0);
        expect((await comet.totalsBasic()).baseSupplyIndex).to.be.greaterThan(cometSupplyIndexBefore);
        expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(accruedSupplyIndex(now));

        await snapshot.restore();
      });

      it('should supply base asset to the dst', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await comet.connect(alice).supplyTo(bob.address, baseToken.address, ALICE_BASE_AMOUNT);

        // token is transferred
        expect(aliceBaseBalanceBefore.sub(await baseToken.balanceOf(alice.address))).to.equal(ALICE_BASE_AMOUNT);
        expect((await baseToken.balanceOf(comet.address)).sub(cometBaseBalanceBefore)).to.equal(ALICE_BASE_AMOUNT);

        // alice principal is unchanged
        const alicePrincipalAfter = (await comet.userBasic(alice.address)).principal;
        expect(alicePrincipalBefore.sub(alicePrincipalAfter)).to.equal(0);

        // bob's principal grows
        // correctness of principal calculation is already checked in previous testcases
        expect((await comet.userBasic(bob.address)).principal).to.be.greaterThan(bobPrincipalBefore);

        await snapshot.restore();
      });

      it('should supply base asset if dst == msg.sender', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await comet.connect(alice).supplyTo(alice.address, baseToken.address, ALICE_BASE_AMOUNT);

        // token is transferred
        expect(aliceBaseBalanceBefore.sub(await baseToken.balanceOf(alice.address))).to.equal(ALICE_BASE_AMOUNT);
        expect((await baseToken.balanceOf(comet.address)).sub(cometBaseBalanceBefore)).to.equal(ALICE_BASE_AMOUNT);

        // alice principal grows
        // correctness of principal calculation is already checked in previous testcases
        expect((await comet.userBasic(alice.address)).principal).to.be.greaterThan(alicePrincipalBefore);

        await snapshot.restore();
      });

      it('should supply collateral asset to the dst', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supplyTo(bob.address, collateral.address, ALICE_COLLATERAL_AMOUNT);

        // token is transferred
        expect(aliceCollateralBalanceBefore.sub(await collateral.balanceOf(alice.address))).to.equal(ALICE_COLLATERAL_AMOUNT);
        expect((await collateral.balanceOf(comet.address)).sub(cometCollateralBalanceBefore)).to.equal(ALICE_COLLATERAL_AMOUNT);

        // alice collateral balance is unchanged
        const aliceCollateralAfter = (await comet.userCollateral(alice.address, collateral.address)).balance;
        expect(aliceCollateralBefore.sub(aliceCollateralAfter)).to.equal(0);

        // bob's collateral balance grows
        const bobCollateralAfter = (await comet.userCollateral(bob.address, collateral.address)).balance;
        expect(bobCollateralAfter.sub(bobCollateralBefore)).to.equal(ALICE_COLLATERAL_AMOUNT);

        await snapshot.restore();
      });

      it('should supply collateral asset if dst == msg.sender', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supplyTo(alice.address, collateral.address, ALICE_COLLATERAL_AMOUNT);

        // token is transferred
        expect(aliceCollateralBalanceBefore.sub(await collateral.balanceOf(alice.address))).to.equal(ALICE_COLLATERAL_AMOUNT);
        expect((await collateral.balanceOf(comet.address)).sub(cometCollateralBalanceBefore)).to.equal(ALICE_COLLATERAL_AMOUNT);

        // alice's collateral balance grows
        const aliceCollateralAfter = (await comet.userCollateral(alice.address, collateral.address)).balance;
        expect(aliceCollateralAfter.sub(aliceCollateralBefore)).to.equal(ALICE_COLLATERAL_AMOUNT);

        await snapshot.restore();
      });
    });

    describe('supplyFrom', function () {
      // Note: tests assume, that supplyFrom() is a clone of supply(), thus only key cases are checked
      it('allows supply to zero address (burns tokens)', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.allocateTo(alice.address, 1);
        await baseToken.connect(alice).approve(comet.address, 1);

        await expect(comet.connect(alice).supplyFrom(alice.address, ethers.constants.AddressZero, baseToken.address, 1))
          .to.emit(comet, 'Supply')
          .withArgs(alice.address, ethers.constants.AddressZero, 1);

        await snapshot.restore();
      });
 
      it('reverts for asset other than base or collateral', async () => {
        await unsupportedToken.allocateTo(alice.address, exp(1, 18));
        await unsupportedToken.connect(alice).approve(comet.address, exp(1, 18));
        await expect(comet.connect(alice).supplyFrom(alice.address, bob.address, unsupportedToken.address, 1)).to.be.revertedWithCustomError(
          comet,
          'BadAsset'
        );
      });

      it('reverts with Unauthorized when the sender has no permission from `from` (base asset)', async () => {
        // alice approved the comet, so only the permission check can stop bob from pulling her tokens
        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
        const aliceTokensBefore = await baseToken.balanceOf(alice.address);
        const bobPrincipalBeforeCall = (await comet.userBasic(bob.address)).principal;

        await expect(comet.connect(bob).supplyFrom(alice.address, bob.address, baseToken.address, ALICE_BASE_AMOUNT))
          .to.be.revertedWithCustomError(comet, 'Unauthorized');

        expect(await baseToken.balanceOf(alice.address)).to.equal(aliceTokensBefore);
        expect((await comet.userBasic(bob.address)).principal).to.equal(bobPrincipalBeforeCall);
      });

      it('reverts with Unauthorized when the sender has no permission from `from` (collateral asset)', async () => {
        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
        const aliceTokensBefore = await collateral.balanceOf(alice.address);
        const bobCollateralBeforeCall = (await comet.userCollateral(bob.address, collateral.address)).balance;

        await expect(comet.connect(bob).supplyFrom(alice.address, bob.address, collateral.address, ALICE_COLLATERAL_AMOUNT))
          .to.be.revertedWithCustomError(comet, 'Unauthorized');

        expect(await collateral.balanceOf(alice.address)).to.equal(aliceTokensBefore);
        expect((await comet.userCollateral(bob.address, collateral.address)).balance).to.equal(bobCollateralBeforeCall);
      });

      it('reverts with Unauthorized after the permission is revoked', async () => {
        await comet.connect(alice).allow(bob.address, true);
        await comet.connect(alice).allow(bob.address, false);
        expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await expect(comet.connect(bob).supplyFrom(alice.address, bob.address, baseToken.address, ALICE_BASE_AMOUNT))
          .to.be.revertedWithCustomError(comet, 'Unauthorized');
      });

      it('the sender cannot supply from `from` even to `from` itself without permission', async () => {
        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await expect(comet.connect(bob).supplyFrom(alice.address, alice.address, baseToken.address, ALICE_BASE_AMOUNT))
          .to.be.revertedWithCustomError(comet, 'Unauthorized');
      });

      it('reverts when protocol paused', async () => {
        await comet.connect(pauseGuardian).pause(true, false, false, false, false);
        expect(await comet.isSupplyPaused()).to.be.true;

        await baseToken.connect(alice).approve(comet.address, 1);
        await expect(comet.connect(alice).supplyFrom(alice.address, bob.address, baseToken.address, 1)).to.be.revertedWithCustomError(
          comet,
          'Paused'
        );
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });

      it('reverts if base supply is paused', async () => {
        await comet.connect(pauseGuardian).pauseBaseSupply(true);
        expect(await comet.isBaseSupplyPaused()).to.be.true;

        await expect(comet.connect(alice).supplyFrom(alice.address, bob.address, baseToken.address, 1)).to.be.revertedWithCustomError(comet, 'BaseSupplyPaused');
        await comet.connect(pauseGuardian).pauseBaseSupply(false);
      });

      it('should accrue state (same as supply())', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await comet.connect(alice).supplyFrom(alice.address, bob.address, baseToken.address, ALICE_BASE_AMOUNT);

        const now = (await ethers.provider.getBlock('latest')).timestamp;
        expect((await comet.totalsBasic()).lastAccrualTime).to.equal(now);
        // the index accrued at the base rate over the skipped hour, as in supply()
        expect(cometSupplyRateBefore).to.be.greaterThan(0);
        expect((await comet.totalsBasic()).baseSupplyIndex).to.be.greaterThan(cometSupplyIndexBefore);
        expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(accruedSupplyIndex(now));

        await snapshot.restore();
      });

      it('should supply base asset to the dst', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await comet.connect(alice).supplyFrom(alice.address, bob.address, baseToken.address, ALICE_BASE_AMOUNT);

        // token is transferred
        expect(aliceBaseBalanceBefore.sub(await baseToken.balanceOf(alice.address))).to.equal(ALICE_BASE_AMOUNT);
        expect((await baseToken.balanceOf(comet.address)).sub(cometBaseBalanceBefore)).to.equal(ALICE_BASE_AMOUNT);

        // alice principal is unchanged
        const alicePrincipalAfter = (await comet.userBasic(alice.address)).principal;
        expect(alicePrincipalBefore.sub(alicePrincipalAfter)).to.equal(0);

        // bob's principal grows
        // correctness of principal calculation is already checked in previous testcases
        expect((await comet.userBasic(bob.address)).principal).to.be.greaterThan(bobPrincipalBefore);

        await snapshot.restore();
      });

      it('should supply base asset if dst == msg.sender', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await comet.connect(alice).supplyFrom(alice.address, alice.address, baseToken.address, ALICE_BASE_AMOUNT);

        // token is transferred
        expect(aliceBaseBalanceBefore.sub(await baseToken.balanceOf(alice.address))).to.equal(ALICE_BASE_AMOUNT);
        expect((await baseToken.balanceOf(comet.address)).sub(cometBaseBalanceBefore)).to.equal(ALICE_BASE_AMOUNT);

        // alice principal grows
        // correctness of principal calculation is already checked in previous testcases
        expect((await comet.userBasic(alice.address)).principal).to.be.greaterThan(alicePrincipalBefore);

        await snapshot.restore();
      });

      it('should supply collateral asset to the dst', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supplyFrom(alice.address, bob.address, collateral.address, ALICE_COLLATERAL_AMOUNT);

        // token is transferred
        expect(aliceCollateralBalanceBefore.sub(await collateral.balanceOf(alice.address))).to.equal(ALICE_COLLATERAL_AMOUNT);
        expect((await collateral.balanceOf(comet.address)).sub(cometCollateralBalanceBefore)).to.equal(ALICE_COLLATERAL_AMOUNT);

        // alice collateral balance is unchanged
        const aliceCollateralAfter = (await comet.userCollateral(alice.address, collateral.address)).balance;
        expect(aliceCollateralBefore.sub(aliceCollateralAfter)).to.equal(0);

        // bob's collateral balance grows
        const bobCollateralAfter = (await comet.userCollateral(bob.address, collateral.address)).balance;
        expect(bobCollateralAfter.sub(bobCollateralBefore)).to.equal(ALICE_COLLATERAL_AMOUNT);

        await snapshot.restore();
      });

      it('should supply collateral asset if dst == msg.sender', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await comet.connect(alice).supplyFrom(alice.address, alice.address, collateral.address, ALICE_COLLATERAL_AMOUNT);

        // token is transferred
        expect(aliceCollateralBalanceBefore.sub(await collateral.balanceOf(alice.address))).to.equal(ALICE_COLLATERAL_AMOUNT);
        expect((await collateral.balanceOf(comet.address)).sub(cometCollateralBalanceBefore)).to.equal(ALICE_COLLATERAL_AMOUNT);

        // alice's collateral balance grows
        const aliceCollateralAfter = (await comet.userCollateral(alice.address, collateral.address)).balance;
        expect(aliceCollateralAfter.sub(aliceCollateralBefore)).to.equal(ALICE_COLLATERAL_AMOUNT);

        await snapshot.restore();
      });
    });
  });

  describe('supply 24 collaterals', function () {
    const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, 18);
    let supplyTxs: ContractTransaction[] = [];
    let alicePrincipalBefore: BigNumber;
    let davePrincipalBefore: BigNumber;

    before(async () => {
      alicePrincipalBefore = (await cometWith24Collaterals.userBasic(alice.address)).principal;
      davePrincipalBefore = (await cometWith24Collaterals.userBasic(dave.address)).principal;
    });

    describe('pause can be set for each collateral', function () {
      it('should allow to pause each collateral supply', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await cometWith24Collaterals.connect(pauseGuardian).pauseCollateralAssetSupply(i, true);
          expect(await cometWith24Collaterals.isCollateralAssetSupplyPaused(i)).to.be.true;
        }
      });

      it('should revert if specific collateral supply is paused', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await tokensWith24Collaterals[`ASSET${i}`].allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await tokensWith24Collaterals[`ASSET${i}`].connect(alice).approve(cometWith24Collaterals.address, SUPPLY_COLLATERAL_AMOUNT);
          await expect(cometWith24Collaterals.connect(alice).supply(tokensWith24Collaterals[`ASSET${i}`].address, SUPPLY_COLLATERAL_AMOUNT)).to.be.revertedWithCustomError(cometWith24Collaterals, 'CollateralAssetSupplyPaused').withArgs(i);
        }
      });

      it('should allow to unpause each collateral supply', async () => {
        for (let i = 0; i < MAX_ASSETS; i++) {
          await cometWith24Collaterals.connect(pauseGuardian).pauseCollateralAssetSupply(i, false);
          expect(await cometWith24Collaterals.isCollateralAssetSupplyPaused(i)).to.be.false;
        }
      });
    });

    describe('supply', function () {
      this.afterAll(async () => snapshot.restore());

      it(`each collateral supply is successful`, async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          await asset.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await asset.connect(alice).approve(cometWith24Collaterals.address, SUPPLY_COLLATERAL_AMOUNT);
          const supplyTx = await cometWith24Collaterals.connect(alice).supply(asset.address, SUPPLY_COLLATERAL_AMOUNT);
          await expect(supplyTx).to.not.be.reverted;
          supplyTxs.push(supplyTx);
        }
      });

      it(`SupplyCollateral event is emitted for each collateral`, async () => {
        for (let i = 0; i < supplyTxs.length; i++) {
          await expect(supplyTxs[i])
            .to.emit(cometWith24Collaterals, 'SupplyCollateral')
            .withArgs(alice.address, alice.address, Object.values(tokensWith24Collaterals)[i].address, SUPPLY_COLLATERAL_AMOUNT);
        }
        // reset supplyTxs
        supplyTxs = [];
      });

      it(`each collateral balance is equal to supplied amount`, async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect(await cometWith24Collaterals.collateralBalanceOf(alice.address, asset.address)).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('alice asset list contains all collaterals', async () => {
        const assetList = await cometWith24Collaterals.getAssetList(alice.address);
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect(assetList).to.include(asset.address);
        }
      });

      it('each collateral comet total supplied collateral amount is equal to alice supplied amount', async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect((await cometWith24Collaterals.totalsCollateral(asset.address)).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('alice principal is not changed', async () => {
        expect((await cometWith24Collaterals.userBasic(alice.address)).principal).to.be.equal(alicePrincipalBefore);
      });
    });

    describe('supplyTo', function () {
      before(async () => {
        await cometWith24Collaterals.connect(dave).allow(alice.address, true);
      });

      this.afterAll(async () => snapshot.restore());

      it(`each collateral supplyTo is successful`, async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          await asset.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await asset.connect(alice).approve(cometWith24Collaterals.address, SUPPLY_COLLATERAL_AMOUNT);
          const supplyToTx = await cometWith24Collaterals.connect(alice).supplyTo(dave.address, asset.address, SUPPLY_COLLATERAL_AMOUNT);
          await expect(supplyToTx).to.not.be.reverted;
          supplyTxs.push(supplyToTx);
        }
      });

      it(`SupplyCollateral event is emitted for each collateral`, async () => {
        const assets = Object.values(tokensWith24Collaterals);
        for (let i = 0; i < assets.length; i++) {
          await expect(supplyTxs[i])
            .to.emit(cometWith24Collaterals, 'SupplyCollateral')
            .withArgs(alice.address, dave.address, assets[i].address, SUPPLY_COLLATERAL_AMOUNT);
        }
        // reset supplyTxs
        supplyTxs = [];
      });

      it(`each collateral balance for dave is equal to supplied amount`, async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect(await cometWith24Collaterals.collateralBalanceOf(dave.address, asset.address)).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('dave asset list contains all collaterals', async () => {
        const assetList = await cometWith24Collaterals.getAssetList(dave.address);
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect(assetList).to.include(asset.address);
        }
      });

      it('each collateral comet total supplied collateral amount is equal to alice supplied amount', async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect((await cometWith24Collaterals.totalsCollateral(asset.address)).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      }); 

      it('dave principal is not changed', async () => {
        expect((await cometWith24Collaterals.userBasic(dave.address)).principal).to.be.equal(davePrincipalBefore);
      });
    });

    describe('supplyFrom', function () {
      before(async () => {
        await cometWith24Collaterals.connect(alice).allow(dave.address, true);
      });

      this.afterAll(async () => snapshot.restore());

      it(`each collateral supplyFrom is successful`, async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          await asset.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await asset.connect(alice).approve(cometWith24Collaterals.address, SUPPLY_COLLATERAL_AMOUNT);
          const supplyFromTx = await cometWith24Collaterals.connect(dave).supplyFrom(alice.address, alice.address, asset.address, SUPPLY_COLLATERAL_AMOUNT);
          await expect(supplyFromTx).to.not.be.reverted;
          supplyTxs.push(supplyFromTx);
        }
      });

      it(`SupplyCollateral event is emitted for each collateral`, async () => {
        const assets = Object.values(tokensWith24Collaterals);
        for (let i = 0; i < assets.length; i++) {
          await expect(supplyTxs[i])
            .to.emit(cometWith24Collaterals, 'SupplyCollateral')
            .withArgs(alice.address, alice.address, assets[i].address, SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it(`each collateral balance for alice is equal to supplied amount`, async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect(await cometWith24Collaterals.collateralBalanceOf(alice.address, asset.address)).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      });

      it('alice asset list contains all collaterals', async () => {
        const assetList = await cometWith24Collaterals.getAssetList(alice.address);
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect(assetList).to.include(asset.address);
        }
      });

      it('each collateral comet total supplied collateral amount is equal to alice supplied amount', async () => {
        for (const asset of Object.values(tokensWith24Collaterals)) {
          expect((await cometWith24Collaterals.totalsCollateral(asset.address)).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }
      }); 

      it('alice principal is not changed', async () => {
        expect((await cometWith24Collaterals.userBasic(alice.address)).principal).to.be.equal(alicePrincipalBefore);
      });
    });
  });

  describe('non-standard tokens', function () {
    describe('USDT-like token', function () {
      let comet: CometHarnessInterfaceExtendedAssetList;
      let alice: SignerWithAddress;
      let usdt: NonStandardFaucetFeeToken;
      let nonStdCollateral: NonStandardFaucetFeeToken;
      const USDT_AMOUNT = exp(1, 6);
      const NON_STD_COLLATERAL_AMOUNT = exp(1, 18);

      before(async function () {
        const assets = defaultAssets();
        assets['USDT'] = {
          initial: 1e6,
          decimals: 6,
          factory: (await ethers.getContractFactory('NonStandardFaucetFeeToken')) as NonStandardFaucetFeeToken__factory,
        };
        assets['NonStdCollateral'] = {
          initial: 1e8,
          decimals: 18,
          factory: (await ethers.getContractFactory('NonStandardFaucetFeeToken')) as NonStandardFaucetFeeToken__factory,
        };

        const protocol = await makeProtocol({ base: 'USDT', assets: assets });
        comet = protocol.cometWithExtendedAssetList;
        alice = protocol.users[0];

        const tokens = protocol.tokens;

        usdt = tokens['USDT'] as NonStandardFaucetFeeToken;
        nonStdCollateral = tokens['NonStdCollateral'] as NonStandardFaucetFeeToken;
      });

      it('can supply base token - non-standard ERC20 (without return interface) e.g. USDT', async () => {
        await usdt.allocateTo(alice.address, USDT_AMOUNT);

        await usdt.connect(alice).approve(comet.address, USDT_AMOUNT);
        await expect(comet.connect(alice).supply(usdt.address, USDT_AMOUNT)).to.not.be.reverted;

        // as per the initial test case, 1st deposit will end with the same principal
        expect((await comet.userBasic(alice.address)).principal).to.equal(USDT_AMOUNT);
      });

      it('can supply collateral - non-standard ERC20 (without return interface) e.g. USDT', async () => {
        await nonStdCollateral.allocateTo(alice.address, NON_STD_COLLATERAL_AMOUNT);

        await nonStdCollateral.connect(alice).approve(comet.address, NON_STD_COLLATERAL_AMOUNT);
        await expect(comet.connect(alice).supply(nonStdCollateral.address, NON_STD_COLLATERAL_AMOUNT)).to.not.be.reverted;

        expect((await comet.userCollateral(alice.address, nonStdCollateral.address)).balance).to.equal(NON_STD_COLLATERAL_AMOUNT);
      });
    });

    describe('fee-on-transfer token', function () {
      const BASE_TOKEN_AMOUNT = exp(1, 6);
      const COLLATERAL_TOKEN_AMOUNT = exp(0.5, 18);
      const NUMERATOR = 10;
      const DENOMINATOR = 10000;
      let feeComet: CometHarnessInterfaceExtendedAssetList;
      let feeBaseToken: NonStandardFaucetFeeToken;
      let feeCollateral: NonStandardFaucetFeeToken;
      let alice: SignerWithAddress;
      let baseTokenFeeTx: ContractTransaction;
      let collateralFeeTx: ContractTransaction;

      before(async function () {
        const assets = defaultAssets();
        assets['USDT'] = {
          initial: 1e6,
          decimals: 6,
          factory: (await ethers.getContractFactory('NonStandardFaucetFeeToken')) as NonStandardFaucetFeeToken__factory,
        };
        assets['FeeCollateral'] = {
          initial: 1e8,
          decimals: 18,
          factory: (await ethers.getContractFactory('NonStandardFaucetFeeToken')) as NonStandardFaucetFeeToken__factory,
        };

        const protocol = await makeProtocol({ base: 'USDT', assets: assets });
        
        feeComet = protocol.cometWithExtendedAssetList;
        feeBaseToken = protocol.tokens['USDT'] as NonStandardFaucetFeeToken;
        feeCollateral = protocol.tokens['FeeCollateral'] as NonStandardFaucetFeeToken;
        alice = protocol.users[0];
      });

      it('can supply base token - fee-on-transfer token', async () => {
        // Set fee to 0.1%
        await feeBaseToken.setParams(10, exp(100, 18));

        await feeBaseToken.allocateTo(alice.address, BASE_TOKEN_AMOUNT);
        const feeBalanceBefore = await feeBaseToken.balanceOf(feeBaseToken.address);
        const userBalanceBefore = await feeBaseToken.balanceOf(alice.address);

        const amountDeposited = BigNumber.from(BASE_TOKEN_AMOUNT);
        const fee = amountDeposited.mul(NUMERATOR).div(DENOMINATOR);
        const amountWithoutFee = amountDeposited.sub(fee);

        await feeBaseToken.connect(alice).approve(feeComet.address, amountDeposited);
        baseTokenFeeTx = await feeComet.connect(alice).supply(feeBaseToken.address, amountDeposited);
        await expect(baseTokenFeeTx).to.not.be.reverted;

        const feeBalanceAfter = await feeBaseToken.balanceOf(feeBaseToken.address);
        const userBalanceAfter = await feeBaseToken.balanceOf(alice.address);

        // we are checking that the (amount - fee) is considered as deposit
        expect((await feeComet.userBasic(alice.address)).principal).to.equal(amountWithoutFee);

        // full amount is charged from user
        expect(userBalanceBefore.sub(userBalanceAfter)).to.equal(amountDeposited);

        // commission is in right place
        expect(feeBalanceAfter.sub(feeBalanceBefore)).to.equal(fee);
      });

      it('correct amount in the Supply event - fee-on-transfer token', async () => {
        const amountDeposited = BigNumber.from(BASE_TOKEN_AMOUNT);
        const fee = amountDeposited.mul(NUMERATOR).div(DENOMINATOR);
        const amountWithoutFee = amountDeposited.sub(fee);

        // event should contain amount without fee - the actual received on the contract
        await expect(baseTokenFeeTx).to.emit(feeComet, 'Supply').withArgs(alice.address, alice.address, amountWithoutFee.toBigInt());
      });

      it('can supply collateral token - fee-on-transfer token', async () => {
        // Set fee to 0.1%
        await feeCollateral.setParams(10, exp(100, 18));

        await feeCollateral.allocateTo(alice.address, COLLATERAL_TOKEN_AMOUNT);
        const feeBalanceBefore = await feeCollateral.balanceOf(feeCollateral.address);
        const userBalanceBefore = await feeCollateral.balanceOf(alice.address);

        const amountDeposited = BigNumber.from(COLLATERAL_TOKEN_AMOUNT);
        const fee = amountDeposited.mul(NUMERATOR).div(DENOMINATOR);
        const amountWithoutFee = amountDeposited.sub(fee);

        await feeCollateral.connect(alice).approve(feeComet.address, amountDeposited);
        collateralFeeTx = await feeComet.connect(alice).supply(feeCollateral.address, amountDeposited);
        await expect(collateralFeeTx).to.not.be.reverted;

        const feeBalanceAfter = await feeCollateral.balanceOf(feeCollateral.address);
        const userBalanceAfter = await feeCollateral.balanceOf(alice.address);

        // we are checking that the (amount - fee) is considered as collateral deposit
        expect((await feeComet.userCollateral(alice.address, feeCollateral.address)).balance).to.equal(amountWithoutFee);

        // full amount is charged from user
        expect(userBalanceBefore.sub(userBalanceAfter)).to.equal(amountDeposited);

        // commission is in right place
        expect(feeBalanceAfter.sub(feeBalanceBefore)).to.equal(fee);
      });

      it('correct amount in the SupplyCollateral event - fee-on-transfer token', async () => {
        const amountDeposited = BigNumber.from(COLLATERAL_TOKEN_AMOUNT);
        const fee = amountDeposited.mul(NUMERATOR).div(DENOMINATOR);
        const amountWithoutFee = amountDeposited.sub(fee);

        // event should contain amount without fee - the actual received on the contract
        await expect(collateralFeeTx).to.emit(feeComet, 'SupplyCollateral').withArgs(alice.address, alice.address, feeCollateral.address, amountWithoutFee.toBigInt());
      });
    });
  });

  describe('reentrancy protection', function () {
    // Own comet with an EVIL collateral whose transfer re-enters supplyFrom (cometWithExtendedAssetList, not the legacy Comet)
    let evilComet: CometHarnessInterfaceExtendedAssetList;
    let EVIL: EvilToken;
    let attacker: SignerWithAddress;
    let receiver: SignerWithAddress;

    before(async function () {
      const protocol = await makeProtocol({
        assets: {
          USDC: { decimals: 6 },
          EVIL: {
            decimals: 6,
            initialPrice: 2,
            factory: await ethers.getContractFactory('EvilToken') as EvilToken__factory,
            supplyCap: 100e6
          }
        }
      });
      evilComet = protocol.cometWithExtendedAssetList;
      EVIL = <EvilToken>protocol.tokens['EVIL'];
      [attacker, receiver] = protocol.users;

      const attack = Object.assign({}, await EVIL.getAttack(), {
        attackType: ReentryAttack.SupplyFrom,
        source: attacker.address,
        destination: receiver.address,
        asset: EVIL.address,
        amount: 75e6,
        maxCalls: 1
      });
      await EVIL.setAttack(attack);

      await evilComet.connect(attacker).allow(EVIL.address, true);
      await EVIL.connect(attacker).approve(evilComet.address, 75e6);
      await EVIL.allocateTo(attacker.address, 75e6);
    });

    it('blocks reentrancy from exceeding the supply cap', async () => {
      await expect(
        evilComet.connect(attacker).supplyTo(receiver.address, EVIL.address, 75e6)
      ).to.be.revertedWithCustomError(evilComet, 'ReentrantCallBlocked');
    });

    it('nothing was supplied', async () => {
      expect((await evilComet.totalsCollateral(EVIL.address)).totalSupplyAsset).to.equal(0);
      expect((await evilComet.userCollateral(receiver.address, EVIL.address)).balance).to.equal(0);
    });
  });

  /*//////////////////////////////////////////////////////////////
                     DEACTIVATE COLLATERAL FEATURE
  //////////////////////////////////////////////////////////////*/

  /**
    * @notice Supply path behavior when collateral is deactivated and reactivated.
    * @dev
    *  While a collateral is deactivated by the `pauseGuardian`, `supply` of that
    *  asset reverts with `CollateralAssetSupplyPaused(index)`. After the `governor`
    *  reactivates it, `supply` succeeds and updates `totalsCollateral` and
    *  `userCollateral` accordingly. The MAX_ASSETS loop asserts the same
    *  deactivate-revert / reactivate-succeed behavior for every asset index in a
    *  full `cometWith24Collaterals` configuration.
    *
    *  Context: in the wUSDM / deUSD incident scenario, deactivation must block any
    *  new supply of the affected collateral until governance reactivates it.
    */
  describe('deactivated token supply flow', function () {
    it('allows pause guardian to deactivate a token', async function () {
      await expect(comet.connect(pauseGuardian).deactivateCollateral(deactivatedCollateralIndex)).to.not.be.reverted;
    });

    it('supply call reverts', async function () {
      await expect(
        comet.connect(bob).supply(collateralToken.address, collateralTokenSupplyAmount)
      ).to.be.revertedWithCustomError(comet, 'CollateralAssetSupplyPaused').withArgs(deactivatedCollateralIndex);
    });

    it('allows governor to activate a token', async function () {
      await expect(comet.connect(governor).activateCollateral(deactivatedCollateralIndex)).to.not.be.reverted;
    });

    it('allows to supply activated collateral', async function () {
      await collateralToken.allocateTo(bob.address, collateralTokenSupplyAmount);
      await collateralToken.connect(bob).approve(comet.address, collateralTokenSupplyAmount);
      await expect(comet.connect(bob).supply(collateralToken.address, collateralTokenSupplyAmount)).to.not.be.reverted;
    });

    it('updates total supply asset amount in comet', async function () {
      const expectedTotalSupplyAsset = BigNumber.from(totalsCollateralBefore.totalSupplyAsset).add(collateralTokenSupplyAmount);
      expect((await comet.totalsCollateral(collateralToken.address)).totalSupplyAsset).to.be.equal(expectedTotalSupplyAsset);
    });

    it('updates user collateral in comet', async function () {
      const expectedBobUserCollateral = BigNumber.from(bobUserCollateralBefore.balance).add(collateralTokenSupplyAmount);
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.be.equal(expectedBobUserCollateral);
    });

    for(let i = 1; i <= MAX_ASSETS; i++) {
      const assetIndex = i - 1;

      it(`reverts on deactivated collateral supply with index ${assetIndex}`, async function () {
        await cometWith24Collaterals.connect(pauseGuardian).deactivateCollateral(assetIndex);

        const supplyToken = tokensWith24Collaterals[`ASSET${assetIndex}`];
        await supplyToken.allocateTo(bob.address, collateralTokenSupplyAmount);
        await supplyToken.connect(bob).approve(cometWith24Collaterals.address, collateralTokenSupplyAmount);

        await expect(
          cometWith24Collaterals.connect(bob).supply(supplyToken.address, collateralTokenSupplyAmount)
        ).to.be.revertedWithCustomError(cometWith24Collaterals, 'CollateralAssetSupplyPaused').withArgs(assetIndex);
      });

      it(`allows to supply re-activated collateral with index ${assetIndex}`, async function () {
        await cometWith24Collaterals.connect(governor).activateCollateral(assetIndex);

        const supplyToken = tokensWith24Collaterals[`ASSET${assetIndex}`];

        await expect(
          cometWith24Collaterals.connect(bob).supply(supplyToken.address, collateralTokenSupplyAmount)
        ).to.not.be.reverted;

        expect((await cometWith24Collaterals.userCollateral(bob.address, supplyToken.address)).balance).to.be.equal(collateralTokenSupplyAmount);
      });
    }
  });

  describe('deactivated token supplyTo flow', function () {
    before(async function () {
      await snapshot.restore();
    });

    it('allows pause guardian to deactivate a token', async function () {
      deactivateCollateralTx = await comet.connect(pauseGuardian).deactivateCollateral(deactivatedCollateralIndex);
      await expect(deactivateCollateralTx).to.not.be.reverted;
    });

    it('emits CollateralAssetSupplyPauseAction event with true argument', async function () {
      await expect(deactivateCollateralTx).to.emit(comet, 'CollateralAssetSupplyPauseAction').withArgs(deactivatedCollateralIndex, true);
    });

    it('emits CollateralDeactivated event', async function () {
      await expect(deactivateCollateralTx).to.emit(comet, 'CollateralDeactivated').withArgs(deactivatedCollateralIndex);
    });

    it('sets collateral as deactivated in comet', async function () {
      expect(await comet.isCollateralDeactivated(deactivatedCollateralIndex)).to.be.true;
    });

    it('updates collateral supply pause flag in comet storage', async function () {
      expect(await comet.isCollateralAssetSupplyPaused(deactivatedCollateralIndex)).to.be.true;
    });

    it('supplyTo call reverts', async function () {
      await expect(
        comet.connect(bob).supplyTo(alice.address, collateralToken.address, collateralTokenSupplyAmount)
      ).to.be.revertedWithCustomError(comet, 'CollateralAssetSupplyPaused').withArgs(deactivatedCollateralIndex);
    });

    it('allows governor to activate a token', async function () {
      activateCollateralTx = await comet.connect(governor).activateCollateral(deactivatedCollateralIndex);
      await expect(activateCollateralTx).to.not.be.reverted;
    });

    it('emits CollateralAssetSupplyPauseAction event with false argument', async function () {
      await expect(activateCollateralTx).to.emit(comet, 'CollateralAssetSupplyPauseAction').withArgs(deactivatedCollateralIndex, false);
    });

    it('emits CollateralActivated event', async function () {
      await expect(activateCollateralTx).to.emit(comet, 'CollateralActivated').withArgs(deactivatedCollateralIndex);
    });

    it('sets collateral as activated in comet', async function () {
      expect(await comet.isCollateralDeactivated(deactivatedCollateralIndex)).to.be.false;
    });

    it('updates collateral supply pause flag in comet storage', async function () {
      expect(await comet.isCollateralAssetSupplyPaused(deactivatedCollateralIndex)).to.be.false;
    });

    it('allows to supplyTo activated collateral', async function () {
      await collateralToken.allocateTo(bob.address, collateralTokenSupplyAmount);
      await collateralToken.connect(bob).approve(comet.address, collateralTokenSupplyAmount);
      await expect(
        comet.connect(bob).supplyTo(alice.address, collateralToken.address, collateralTokenSupplyAmount)
      ).to.not.be.reverted;
    });

    it('updates total supply asset amount in comet', async function () {
      const expectedTotalSupplyAsset = BigNumber.from(totalsCollateralBefore.totalSupplyAsset).add(collateralTokenSupplyAmount);
      expect((await comet.totalsCollateral(collateralToken.address)).totalSupplyAsset).to.be.equal(expectedTotalSupplyAsset);
    });

    it('credits the recipient (alice) collateral in comet', async function () {
      const expectedAliceUserCollateral = BigNumber.from(aliceUserCollateralBefore.balance).add(collateralTokenSupplyAmount);
      expect((await comet.userCollateral(alice.address, collateralToken.address)).balance).to.be.equal(expectedAliceUserCollateral);
    });

    it('leaves the sender (bob) collateral unchanged', async function () {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.be.equal(bobUserCollateralBefore.balance);
    });

    for(let i = 1; i <= MAX_ASSETS; i++) {
      const assetIndex = i - 1;

      it(`reverts on deactivated collateral supplyTo with index ${assetIndex}`, async function () {
        await cometWith24Collaterals.connect(pauseGuardian).deactivateCollateral(assetIndex);

        const supplyToken = tokensWith24Collaterals[`ASSET${assetIndex}`];
        await supplyToken.allocateTo(bob.address, collateralTokenSupplyAmount);
        await supplyToken.connect(bob).approve(cometWith24Collaterals.address, collateralTokenSupplyAmount);

        await expect(
          cometWith24Collaterals.connect(bob).supplyTo(alice.address, supplyToken.address, collateralTokenSupplyAmount)
        ).to.be.revertedWithCustomError(cometWith24Collaterals, 'CollateralAssetSupplyPaused').withArgs(assetIndex);
      });

      it(`allows to supplyTo re-activated collateral with index ${assetIndex}`, async function () {
        await cometWith24Collaterals.connect(governor).activateCollateral(assetIndex);

        const supplyToken = tokensWith24Collaterals[`ASSET${assetIndex}`];
        const aliceCollateralBefore = (await cometWith24Collaterals.userCollateral(alice.address, supplyToken.address)).balance;
        const bobCollateralBefore = (await cometWith24Collaterals.userCollateral(bob.address, supplyToken.address)).balance;

        await expect(
          cometWith24Collaterals.connect(bob).supplyTo(alice.address, supplyToken.address, collateralTokenSupplyAmount)
        ).to.not.be.reverted;

        // the recipient (alice) is credited, the sender (bob) is not
        expect((await cometWith24Collaterals.userCollateral(alice.address, supplyToken.address)).balance)
          .to.be.equal(BigNumber.from(aliceCollateralBefore).add(collateralTokenSupplyAmount));
        expect((await cometWith24Collaterals.userCollateral(bob.address, supplyToken.address)).balance)
          .to.be.equal(bobCollateralBefore);
      });
    }
  });

  describe('deactivated token supplyFrom flow', function () {
    before(async function () {
      await snapshot.restore();
    });

    it('allows pause guardian to deactivate a token', async function () {
      await expect(comet.connect(pauseGuardian).deactivateCollateral(deactivatedCollateralIndex)).to.not.be.reverted;
    });

    it('supplyFrom call reverts', async function () {
      await comet.connect(bob).allow(alice.address, true);
      await expect(
        comet.connect(alice).supplyFrom(bob.address, alice.address, collateralToken.address, collateralTokenSupplyAmount)
      ).to.be.revertedWithCustomError(comet, 'CollateralAssetSupplyPaused').withArgs(deactivatedCollateralIndex);
    });

    it('allows governor to activate a token', async function () {
      await expect(comet.connect(governor).activateCollateral(deactivatedCollateralIndex)).to.not.be.reverted;
    });

    it('allows to supplyFrom activated collateral', async function () {
      await collateralToken.allocateTo(bob.address, collateralTokenSupplyAmount);
      await collateralToken.connect(bob).approve(comet.address, collateralTokenSupplyAmount);
      await expect(
        comet.connect(alice).supplyFrom(bob.address, alice.address, collateralToken.address, collateralTokenSupplyAmount)
      ).to.not.be.reverted;
    });

    it('updates total supply asset amount in comet', async function () {
      const expectedTotalSupplyAsset = BigNumber.from(totalsCollateralBefore.totalSupplyAsset).add(collateralTokenSupplyAmount);
      expect((await comet.totalsCollateral(collateralToken.address)).totalSupplyAsset).to.be.equal(expectedTotalSupplyAsset);
    });

    it('credits the recipient (alice) collateral in comet', async function () {
      const expectedAliceUserCollateral = BigNumber.from(aliceUserCollateralBefore.balance).add(collateralTokenSupplyAmount);
      expect((await comet.userCollateral(alice.address, collateralToken.address)).balance).to.be.equal(expectedAliceUserCollateral);
    });

    it('leaves the `from` account (bob) collateral unchanged', async function () {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.be.equal(bobUserCollateralBefore.balance);
    });

    for(let i = 1; i <= MAX_ASSETS; i++) {
      const assetIndex = i - 1;

      it(`reverts on deactivated collateral supplyFrom with index ${assetIndex}`, async function () {
        await cometWith24Collaterals.connect(pauseGuardian).deactivateCollateral(assetIndex);

        const supplyToken = tokensWith24Collaterals[`ASSET${assetIndex}`];
        await supplyToken.allocateTo(bob.address, collateralTokenSupplyAmount);
        await supplyToken.connect(bob).approve(cometWith24Collaterals.address, collateralTokenSupplyAmount);
        await cometWith24Collaterals.connect(bob).allow(alice.address, true);

        await expect(
          cometWith24Collaterals.connect(alice).supplyFrom(bob.address, alice.address, supplyToken.address, collateralTokenSupplyAmount)
        ).to.be.revertedWithCustomError(cometWith24Collaterals, 'CollateralAssetSupplyPaused').withArgs(assetIndex);
      });

      it(`allows to supplyFrom re-activated collateral with index ${assetIndex}`, async function () {
        await cometWith24Collaterals.connect(governor).activateCollateral(assetIndex);

        const supplyToken = tokensWith24Collaterals[`ASSET${assetIndex}`];

        await expect(
          cometWith24Collaterals.connect(alice).supplyFrom(bob.address, alice.address, supplyToken.address, collateralTokenSupplyAmount)
        ).to.not.be.reverted;

        expect((await cometWith24Collaterals.userCollateral(alice.address, supplyToken.address)).balance).to.be.equal(collateralTokenSupplyAmount);
      });
    }
  });
});

type SupplyStateBefore = {
  principal: BigNumber;
  baseSupplyIndex: BigNumber;
  lastAccrualTime: number;
  supplyRate: BigNumber;
};

/**
 * Reads the state that `supplyBase` works from. Call it right before sending the supply tx.
 */
async function getSupplyStateBefore(comet: CometHarnessInterfaceExtendedAssetList, user: string): Promise<SupplyStateBefore> {
  const totals = await comet.totalsBasic();
  return {
    principal: (await comet.userBasic(user)).principal,
    baseSupplyIndex: totals.baseSupplyIndex,
    lastAccrualTime: totals.lastAccrualTime,
    supplyRate: await comet.getSupplyRate(await comet.getUtilization()),
  };
}

/**
 * Expected value of the `Transfer(0, user, value)` mint emitted by a base supply from a user with principal >= 0.
 * Mirrors `CometWithExtendedAssetList.supplyBase`: accrue the index up to the supply block, take the principal
 * delta at that index, and emit it as a present value.
 */
async function getSupplyTransferAmount(
  stateBefore: SupplyStateBefore,
  amount: bigint | BigNumber,
  supplyTx: ContractTransaction
): Promise<bigint> {
  const INDEX_SCALE = exp(1, 15);
  const supplyTime = (await ethers.provider.getBlock((await supplyTx.wait()).blockNumber)).timestamp;
  const timeElapsed = BigInt(supplyTime - stateBefore.lastAccrualTime);

  const indexBefore = stateBefore.baseSupplyIndex.toBigInt();
  const index = indexBefore + (indexBefore * stateBefore.supplyRate.toBigInt() * timeElapsed) / exp(1, 18);

  const principalBefore = stateBefore.principal.toBigInt();
  const balanceAfter = presentValueSupply(index, principalBefore) + BigInt(amount.toString());
  const principalAfter = (balanceAfter * INDEX_SCALE) / index;

  return presentValueSupply(index, principalAfter - principalBefore);
}
