import { ethers, expect, exp, makeProtocol, ReentryAttack, defaultAssets, ZERO_ADDRESS, takeSnapshot, SnapshotRestorer } from './helpers';
import { EvilToken, EvilToken__factory, NonStandardFaucetFeeToken__factory, NonStandardFaucetFeeToken, CometHarnessInterface, FaucetToken, CometExtAssetList, CometHarnessInterfaceExtendedAssetList } from '../build/types';
import { BigNumber, ContractTransaction } from 'ethers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

// Note: isolated supply functionality and withdraw are tested in separate testsets
describe('5. supply', function () {
  const baseTokenDecimals = 6;

  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken | NonStandardFaucetFeeToken;
  let collaterals: {
    [symbol: string]: FaucetToken | NonStandardFaucetFeeToken;
  };
  let unsupportedToken: FaucetToken;

  // Accounts
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;

  before(async function () {
    const protocol = await makeProtocol({base: 'USDC'});

    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens[protocol.base];
    collaterals = Object.fromEntries(
      Object.entries(protocol.tokens).filter(([_symbol, token]) => token.address !== baseToken.address)
    );
    pauseGuardian = protocol.pauseGuardian;
    unsupportedToken = protocol.unsupportedToken;

    [alice, bob, dave] = protocol.users;

    await baseToken.allocateTo(alice.address, exp(1e10, baseTokenDecimals));
    await baseToken.allocateTo(bob.address, exp(1e10, baseTokenDecimals));
  });

  describe('supply base asset', function () {
    describe('default state (un-accrued)', function () {
      it('supply is not paused by default', async () => {
        expect(await comet.isSupplyPaused()).to.be.false;
      });

      it('no base token on the comet', async () => {
        expect(await baseToken.balanceOf(comet.address)).to.equal(0);
      });

      it('no collateral tokens on the comet', async () => {
        Object.values(collaterals).forEach(async (collateral) => {
          expect(await collateral.balanceOf(comet.address)).to.equal(0);
        });
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

      // Note: we skip this test for now, because this feature is not implemented in the comet contract yet
      // This is different from Sandbox behavior - original Comet allows 0 supply
      it.skip('reverts for 0 base asset supply', async () => {
        await expect(comet.connect(alice).supply(baseToken.address, 0)).to.be.revertedWithCustomError(comet, 'ZeroAmount');
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

      // Note: this feature is not implemented in the comet contract yet
      it.skip('revert if asset = 0', async () => {
        await expect(comet.connect(alice).supply(ZERO_ADDRESS, 1)).to.be.revertedWithCustomError(comet, 'ZeroAddress');
      });
    });

    describe('supply base asset into empty pool', function () {
      const BASE_AMOUNT: bigint = exp(5e9, baseTokenDecimals);
      let aliceBalanceBefore: BigNumber;
      let aliceBalanceAfter: BigNumber;

      it('wait and accrue state', async () => {
        // wait with empty comet for a while
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);

        await comet.accrueAccount(alice.address);
      });
      
      it('emits Supply event when supplies base asset into empty pool', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, BASE_AMOUNT);
        expect(await comet.connect(alice).supply(baseToken.address, BASE_AMOUNT))
          .emit(comet, 'Supply')
          .withArgs(alice.address, alice.address, BASE_AMOUNT);

        await snapshot.restore();
      });

      it('emits Transfer event when supplies base asset into empty pool (as supply growths)', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        const principalFromBase = BASE_AMOUNT; // default index for the empty pool gives same supply amount

        await baseToken.connect(alice).approve(comet.address, BASE_AMOUNT);
        expect(await comet.connect(alice).supply(baseToken.address, BASE_AMOUNT))
          .emit(comet, 'Transfer')
          .withArgs(ZERO_ADDRESS, alice.address, principalFromBase);

        await snapshot.restore();
      });

      it('supplies base asset into empty pool', async () => {
        aliceBalanceBefore = await baseToken.balanceOf(alice.address);

        await baseToken.connect(alice).approve(comet.address, BASE_AMOUNT);
        await expect(comet.connect(alice).supply(baseToken.address, BASE_AMOUNT)).to.not.be.reverted;

        aliceBalanceAfter = await baseToken.balanceOf(alice.address);
      });

      it('should supply the exact balance as passed as a parameter', async () => {
        expect(aliceBalanceBefore.sub(aliceBalanceAfter)).to.equal(BASE_AMOUNT);
      });

      it("comet's token balance is increased", async () => {
        expect(await baseToken.balanceOf(comet.address)).to.equal(BASE_AMOUNT);
      });

      it("user's stored principle is increased", async () => {
        const principalFromBase = BASE_AMOUNT; // default index for the empty pool gives same supply amount

        expect((await comet.userBasic(alice.address)).principal).to.equal(principalFromBase);
      });

      it("user's displayed principle is increased", async () => {
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

      before(async function () {
        aliceBalanceBefore = await baseToken.balanceOf(alice.address);
        cometBalanceBefore = await baseToken.balanceOf(comet.address);
        aliceDisplayBalanceBefore = await comet.balanceOf(alice.address);
        alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
        cometSupplyIndexBefore = (await comet.totalsBasic()).baseSupplyIndex;
        cometSupplyRateBefore = await comet.getSupplyRate(0);
        cometUpdatedTimeBefore = (await comet.totalsBasic()).lastAccrualTime;

        // wait with empty comet for a while
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);
      });

      it('initial state: totalSupply > 0 and supplyRate = 0', async () => {
        const storedSupply = (await comet.totalsBasic()).totalSupplyBase;
        expect(storedSupply).to.be.greaterThan(0);

        const displayedSupply = storedSupply.mul((await comet.totalsBasic()).baseSupplyIndex).div(exp(1, 15));
        expect(await comet.totalSupply()).to.eq(displayedSupply);

        /// No borrows, but lenders got stimulus from seed reserves
        expect(await comet.getSupplyRate(0)).to.eq(0);
      });

      it('should allow 2nd deposit from alice: emits Supply event for existing supply', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, SUPPLIED_AMOUNT_ALICE);
        expect(await comet.connect(alice).supply(baseToken.address, SUPPLIED_AMOUNT_ALICE))
          .emit(comet, 'Supply')
          .withArgs(alice.address, alice.address, SUPPLIED_AMOUNT_ALICE);

        await snapshot.restore();
      });

      it('should allow 2nd deposit from alice: emits Transfer event for existing supply', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        const lastUpdated = (await comet.totalsBasic()).lastAccrualTime;

        await baseToken.connect(alice).approve(comet.address, SUPPLIED_AMOUNT_ALICE);
        expect(await comet.connect(alice).supply(baseToken.address, SUPPLIED_AMOUNT_ALICE))
          .emit(comet, 'Transfer')
          .withArgs(
            ethers.constants.AddressZero,
            alice.address,
            await getPrincipalChange(comet, lastUpdated, 0, alice.address, BigNumber.from(SUPPLIED_AMOUNT_ALICE))
          );

        await snapshot.restore();
      });

      it('should allow 2nd deposit from alice: accrues the state', async () => {
        const lastUpdated = (await comet.totalsBasic()).lastAccrualTime;

        await baseToken.connect(alice).approve(comet.address, SUPPLIED_AMOUNT_ALICE);
        await comet.connect(alice).supply(baseToken.address, SUPPLIED_AMOUNT_ALICE);

        expect((await comet.totalsBasic()).lastAccrualTime).to.be.greaterThan(lastUpdated);
        expect((await comet.totalsBasic()).lastAccrualTime).to.equal((await ethers.provider.getBlock('latest')).timestamp);
      });

      it('supples from alice the exact balance as in parameter', async () => {
        const aliceBalanceAfter = await baseToken.balanceOf(alice.address);

        expect(aliceBalanceBefore.sub(aliceBalanceAfter)).to.equal(SUPPLIED_AMOUNT_ALICE);
      });

      it('Comet token balance growths', async () => {
        const cometBalanceAfter = await baseToken.balanceOf(comet.address);

        expect(cometBalanceAfter.sub(cometBalanceBefore)).to.equal(SUPPLIED_AMOUNT_ALICE);
      });

      it("alice's principal growths", async () => {
        const curTime = (await ethers.provider.getBlock('latest')).timestamp;
        const timeElapsed = curTime - cometUpdatedTimeBefore;
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // healthcheck than current index is re-calculated correctly
        const index = (await comet.totalsBasic()).baseSupplyIndex;
        expect(index).to.equal(accruedIndex);

        const oldBalance = alicePrincipalBefore.mul(accruedIndex).div(1e15);
        const newPrincipal = oldBalance.add(SUPPLIED_AMOUNT_ALICE).mul(1e15).div(accruedIndex);

        expect((await comet.userBasic(alice.address)).principal).to.be.greaterThan(alicePrincipalBefore);
        expect((await comet.userBasic(alice.address)).principal).to.equal(newPrincipal);
      });

      it("alice's displayed balance growths", async () => {
        const curTime = (await ethers.provider.getBlock('latest')).timestamp;
        const timeElapsed = curTime - cometUpdatedTimeBefore;
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // healthcheck than current index is re-calculated correctly
        const index = (await comet.totalsBasic()).baseSupplyIndex;
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
        cometSupplyRateBefore = await comet.getSupplyRate(0);
        cometUpdatedTimeBefore = (await comet.totalsBasic()).lastAccrualTime;

        // wait with empty comet for a while
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);
      });

      it('should allow deposit from bob (new user): emits Supply event for existing supply', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(bob).approve(comet.address, SUPPLIED_AMOUNT_BOB);
        expect(await comet.connect(bob).supply(baseToken.address, SUPPLIED_AMOUNT_BOB))
          .emit(comet, 'Supply')
          .withArgs(bob.address, bob.address, SUPPLIED_AMOUNT_BOB);

        await snapshot.restore();
      });

      it('should allow deposit from bob (new user): emits Transfer event for existing supply', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        const lastUpdated = (await comet.totalsBasic()).lastAccrualTime;

        await baseToken.connect(bob).approve(comet.address, SUPPLIED_AMOUNT_BOB);
        expect(await comet.connect(bob).supply(baseToken.address, SUPPLIED_AMOUNT_BOB))
          .emit(comet, 'Transfer')
          .withArgs(
            ethers.constants.AddressZero,
            bob.address,
            await getPrincipalChange(comet, lastUpdated, 0, bob.address, BigNumber.from(SUPPLIED_AMOUNT_BOB))
          );

        await snapshot.restore();
      });

      it('should allow deposit from bob (new user): accrues the state', async () => {
        const lastUpdated = (await comet.totalsBasic()).lastAccrualTime;

        await baseToken.connect(bob).approve(comet.address, SUPPLIED_AMOUNT_BOB);
        await comet.connect(bob).supply(baseToken.address, SUPPLIED_AMOUNT_BOB);

        expect((await comet.totalsBasic()).lastAccrualTime).to.be.greaterThan(lastUpdated);
        expect((await comet.totalsBasic()).lastAccrualTime).to.equal((await ethers.provider.getBlock('latest')).timestamp);
      });

      it('supples from bob the exact balance as in parameter', async () => {
        const bobBalanceAfter = await baseToken.balanceOf(bob.address);

        expect(bobBalanceBefore.sub(bobBalanceAfter)).to.equal(SUPPLIED_AMOUNT_BOB);
      });

      it('Comet token balance growths', async () => {
        const cometBalanceAfter = await baseToken.balanceOf(comet.address);

        expect(cometBalanceAfter.sub(cometBalanceBefore)).to.equal(SUPPLIED_AMOUNT_BOB);
      });

      it("bob's principal growths", async () => {
        const curTime = (await ethers.provider.getBlock('latest')).timestamp;
        const timeElapsed = curTime - cometUpdatedTimeBefore;
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // healthcheck than current index is re-calculated correctly
        const index = (await comet.totalsBasic()).baseSupplyIndex;
        expect(index).to.equal(accruedIndex);

        /// old balance == 0
        const oldBalance: BigNumber = BigNumber.from(0);
        const newPrincipal = oldBalance.add(SUPPLIED_AMOUNT_BOB).mul(exp(1, 15)).div(accruedIndex);

        expect((await comet.userBasic(bob.address)).principal).to.be.greaterThan(0);
        expect((await comet.userBasic(bob.address)).principal).to.equal(newPrincipal);
      });

      it("bob's displayed balance growths", async () => {
        const curTime = (await ethers.provider.getBlock('latest')).timestamp;
        const timeElapsed = curTime - cometUpdatedTimeBefore;
        const accruedIndex = cometSupplyIndexBefore.add(cometSupplyIndexBefore.mul(cometSupplyRateBefore).mul(timeElapsed).div(exp(1, 18)));

        // healthcheck than current index is re-calculated correctly
        const index = (await comet.totalsBasic()).baseSupplyIndex;
        expect(index).to.equal(accruedIndex);

        const newPrincipal = (await comet.userBasic(bob.address)).principal;

        // old balance for bob is 0
        const newBalanceFromPrincipal = newPrincipal.mul(accruedIndex).div(exp(1, 15));

        const newBalance = await comet.balanceOf(bob.address);
        expect(newBalance).to.equal(newBalanceFromPrincipal);
      });

      it("Comet's stored total supply corresponds to provided principals from all users", async () => {
        /// currently it is an accrued state, so we can compare directly
        /// get alice's and bob's suppleis together
        const alicePrincipal = (await comet.userBasic(alice.address)).principal;
        const bobPrincipal = (await comet.userBasic(bob.address)).principal;
        const totalStoredSupply = alicePrincipal.add(bobPrincipal);
        expect((await comet.totalsBasic()).totalSupplyBase).to.equal(totalStoredSupply);
      });

      it("balanceOf() is >= bob's deposit", async () => {
        const newBalanceNaive = SUPPLIED_AMOUNT_BOB;

        /// Note: since there is a rounding error, the immediate comet.balanceOf() may return value
        /// which is 1 wei less than the deposited amount. Though the difference will be neglected
        /// in around 1 block of supply interest (in case if )

        const newBalance = await comet.balanceOf(bob.address);

        expect(newBalance.sub(newBalanceNaive)).to.be.approximately(0, 1);
      });

      it("Comet's displayed total supply corresponds to displayed balances from all users", async () => {
        /// currently it is an accrued state, so we can compare directly
        /// get alice's and bob's suppleis together
        const alicePresent = await comet.balanceOf(alice.address);
        const bobPresent = await comet.balanceOf(bob.address);
        const totalPresentSupply = alicePresent.add(bobPresent);

        /// Note: because of the rounding errors accumulated (supplied amount -> principle -> present value)
        /// There is a high chance to have around 1 wei difference in the displayed market supply (totalSupply())
        /// and the sum of all balances from all users
        expect(await comet.totalSupply()).to.be.approximately(totalPresentSupply, 1);
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
        expect(repayTx).to.not.be.reverted;
      });

      it('emits Supply event when repaying', async () => {
        expect(repayTx).to.emit(comet, 'Supply').withArgs(dave.address, dave.address, PARTIAL_REPAY_AMOUNT);
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
        expect(overRepayTx).to.not.be.reverted;
      });

      it('emits both Supply and Transfer (mint) events when over-repaying', async () => {
        expect(overRepayTx)
          .to.emit(comet, 'Supply').withArgs(dave.address, dave.address, OVER_REPAY_AMOUNT)
          .to.not.emit(comet, 'Transfer');
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
      it('repay reverts when supply is paused', async () => {
        const snapshot = await takeSnapshot();

        // Create new borrow
        await comet.connect(dave).withdraw(baseToken.address, exp(1, baseTokenDecimals));
        await baseToken.allocateTo(dave.address, exp(1, baseTokenDecimals));

        await comet.connect(pauseGuardian).pause(true, false, false, false, false);
        expect(await comet.isSupplyPaused()).to.be.true;

        await baseToken.connect(dave).approve(comet.address, exp(1, baseTokenDecimals));
        await expect(comet.connect(dave).supply(baseToken.address, exp(1, baseTokenDecimals)))
          .to.be.revertedWithCustomError(comet, 'Paused');

        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        await snapshot.restore();
      });

      it('can withdraw collateral after repaying all debt', async () => {
        const snapshot = await takeSnapshot();

        // Create new borrow
        await comet.connect(dave).withdraw(baseToken.address, exp(1, baseTokenDecimals));
        const borrowBalance = await comet.borrowBalanceOf(dave.address);

        // Repay all debt
        await baseToken.allocateTo(dave.address, borrowBalance.mul(2));
        await baseToken.connect(dave).approve(comet.address, ethers.constants.MaxUint256);
        await comet.connect(dave).supply(baseToken.address, ethers.constants.MaxUint256);

        // Now dave should be able to withdraw collateral
        const collateralBalance = (await comet.userCollateral(dave.address, collateral.address)).balance;
        await expect(comet.connect(dave).withdraw(collateral.address, collateralBalance)).to.not.be.reverted;

        expect((await comet.userCollateral(dave.address, collateral.address)).balance).to.equal(0);

        await snapshot.restore();
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

      it('reverts for not enough collateral balance', async () => {
        const balanceBefore = await collateral.balanceOf(alice.address);

        await collateral.connect(alice).approve(comet.address, balanceBefore.add(1));
        await expect(comet.connect(alice).supply(collateral.address, balanceBefore.add(1))).to.be.reverted;
        await collateral.connect(alice).approve(comet.address, 0);
      });

      // Note: this logic is not implemented in the comet contract yet
      it.skip('reverts for 0 collateral amount', async () => {
        await expect(comet.connect(alice).supply(collateral.address, 0)).to.be.revertedWithCustomError(comet, 'ZeroAmount');
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
      let aliceCollateralBalanceBefore: BigNumber;
      let totalSupplyBefore: BigNumber;
      let alicePrincipalBefore: BigNumber;
      let cometUpdatedTimeBefore: number;

      before(async function () {
        const totals = await comet.totalsBasic();
        aliceCollateralBalanceBefore = await collateral.balanceOf(alice.address);

        totalSupplyBefore = totals.totalSupplyBase;
        alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;

        cometUpdatedTimeBefore = totals.lastAccrualTime;

        // wait for a while to have impact from accrual
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);
      });

      it('should not have collateral registered for a user', async () => {
        const collateralIndex = (await comet.getAssetInfoByAddress(collateral.address)).offset;
        const userData = await comet.userBasic(alice.address);
        const offset = 1 << collateralIndex;

        expect(userData.assetsIn & offset).to.equal(0);
      });

      it('should not collateral in the storage', async () => {
        expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(0);
        expect((await comet.userCollateral(alice.address, collateral.address)).balance).to.equal(0);
      });

      it('should not have collateral on the balance', async () => {
        expect(await collateral.balanceOf(comet.address)).to.equal(0);
      });

      it('should emit event during 1st collateral deposit', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        expect(await comet.connect(alice).supply(collateral.address, ALICE_COLLATERAL_AMOUNT))
          .to.emit(comet, 'SupplyCollateral')
          .withArgs(alice.address, alice.address, collateral.address, ALICE_COLLATERAL_AMOUNT);

        await snapshot.restore();
      });
      
      it('should allow collateral deposit', async () => {
        await collateral.connect(alice).approve(comet.address, ALICE_COLLATERAL_AMOUNT);
        await expect(comet.connect(alice).supply(collateral.address, ALICE_COLLATERAL_AMOUNT)).to.not.be.reverted;
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

      it("Comet's collateral token balance growths", async () => {
        expect(await collateral.balanceOf(comet.address)).to.equal(ALICE_COLLATERAL_AMOUNT);
      });

      it("should correctly set alice's collateral balance", async () => {
        expect((await comet.userCollateral(alice.address, collateral.address)).balance).to.equal(ALICE_COLLATERAL_AMOUNT);
      });

      it("should correctly set comet's total balance", async () => {
        expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(ALICE_COLLATERAL_AMOUNT);
      });

      it('accrue state should be same as before during collateral supply', async () => {
        const lastUpdated = (await comet.totalsBasic()).lastAccrualTime;

        expect(lastUpdated).to.equal(cometUpdatedTimeBefore);
        expect(lastUpdated).to.be.lessThan((await ethers.provider.getBlock('latest')).timestamp);
      });

      it('should not change alice principal after accrual (no collateral effect on principal)', async () => {
        expect((await comet.userBasic(alice.address)).principal).to.equal(alicePrincipalBefore);
      });

      it("should change comet's total supply correctly after accrual (no collateral effect on supply)", async () => {
        expect((await comet.totalsBasic()).totalSupplyBase).to.equal(totalSupplyBefore);
      });

      it('should have correct display of total supply', async () => {
        // current displayed supply
        const newSupply = await comet.totalSupply();

        // check the invariant that lender's balance can only grow
        expect(newSupply).to.be.equal(totalSupplyBefore);
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

    let collateral: FaucetToken | NonStandardFaucetFeeToken;

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
      alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
      bobPrincipalBefore = (await comet.userBasic(bob.address)).principal;

      // wait for a while to have impact from accrual
      await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
      await ethers.provider.send('evm_mine', []);
    });

    describe('supplyTo', function () {
      // Note: tests assume, that supplyTo() is a clone of supply(), thus only key cases are checked
      // Note: this logic is not implemented in the comet contract yet
      it.skip('reverts for dst = 0', async () => {
        await baseToken.connect(alice).approve(comet.address, 1);
        await expect(comet.connect(alice).supplyTo(ethers.constants.AddressZero, baseToken.address, 1)).to.be.revertedWithCustomError(
          comet,
          'ZeroAddress'
        );
      });

      // Note: this logic is not implemented in the comet contract yet
      it.skip('reverts for asset = 0', async () => {
        await baseToken.connect(alice).approve(comet.address, 1);
        await expect(comet.connect(alice).supplyTo(bob.address, ethers.constants.AddressZero, 1)).to.be.revertedWithCustomError(
          comet,
          'ZeroAddress'
        );
      });

      // Note: this logic is not implemented in the comet contract yet
      it.skip('reverts for amount = 0', async () => {
        await expect(comet.connect(alice).supplyTo(bob.address, baseToken.address, 0)).to.be.revertedWithCustomError(comet, 'ZeroAmount');
      });

      it('reverts for asset other than base of collateral', async () => {
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

      it('should accrue state (same as supply())', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await comet.connect(alice).supplyTo(bob.address, baseToken.address, ALICE_BASE_AMOUNT);

        expect((await comet.totalsBasic()).lastAccrualTime).to.equal((await ethers.provider.getBlock('latest')).timestamp);
        // correctness of index calculation is already checked in previous testcases
        expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(cometSupplyIndexBefore);

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

        // bob's princiapl grows
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

        // alice principal is grows
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

      // Note: this logic is not implemented in the comet contract yet
      it.skip('reverts for from = 0', async () => {
        await baseToken.connect(alice).approve(comet.address, 1);
        await expect(
          comet.connect(alice).supplyFrom(ethers.constants.AddressZero, alice.address, baseToken.address, 1)
        ).to.be.revertedWithCustomError(comet, 'ZeroAddress');
      });

      // Note: this logic is not implemented in the comet contract yet
      it.skip('reverts for dst = 0', async () => {
        await baseToken.connect(alice).approve(comet.address, 1);
        await expect(
          comet.connect(alice).supplyFrom(alice.address, ethers.constants.AddressZero, baseToken.address, 1)
        ).to.be.revertedWithCustomError(comet, 'ZeroAddress');
      });

      // Note: this logic is not implemented in the comet contract yet
      it.skip('reverts for asset = 0', async () => {
        await baseToken.connect(alice).approve(comet.address, 1);
        await expect(
          comet.connect(alice).supplyFrom(alice.address, bob.address, ethers.constants.AddressZero, 1)
        ).to.be.revertedWithCustomError(comet, 'ZeroAddress');
      });

      // Note: this logic is not implemented in the comet contract yet
      it.skip('reverts for amount = 0', async () => {
        await expect(comet.connect(alice).supplyFrom(alice.address, bob.address, baseToken.address, 0)).to.be.revertedWithCustomError(
          comet,
          'ZeroAmount'
        );
      });

      it('reverts for asset other than base of collateral', async () => {
        await unsupportedToken.allocateTo(alice.address, exp(1, 18));
        await unsupportedToken.connect(alice).approve(comet.address, exp(1, 18));
        await expect(comet.connect(alice).supplyFrom(alice.address, bob.address, unsupportedToken.address, 1)).to.be.revertedWithCustomError(
          comet,
          'BadAsset'
        );
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

      it('should accrue state (same as supply())', async () => {
        const snapshot: SnapshotRestorer = await takeSnapshot();

        await baseToken.connect(alice).approve(comet.address, ALICE_BASE_AMOUNT);
        await comet.connect(alice).supplyFrom(alice.address, bob.address, baseToken.address, ALICE_BASE_AMOUNT);

        expect((await comet.totalsBasic()).lastAccrualTime).to.equal((await ethers.provider.getBlock('latest')).timestamp);
        // correctness of index calculation is already checked in previous testcases
        expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(cometSupplyIndexBefore);

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

        // bob's princiapl grows
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

        // alice principal is grows
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

      // Note: supplyFrom() with different operator is tested in allowance tests.
    });
  });

  describe('supply 24 collaterals', function () {
    const MAX_ASSETS = 24;
    const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, 18);

    let comet: CometHarnessInterfaceExtendedAssetList;
    let collaterals: { [symbol: string]: FaucetToken } = {};

    let alice: SignerWithAddress;
    let dave: SignerWithAddress;

    let asset: FaucetToken;
    let supplyTx: ContractTransaction;
    let alicePrincipalBefore: BigNumber;
    let davePrincipalBefore: BigNumber;

    let snapshot: SnapshotRestorer;

    before(async () => {
      // Setup protocol with MAX_ASSETS collaterals
      const cometCollaterals = Object.fromEntries(
        Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {
          decimals: 18,
          initialPrice: 1,
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
      }

      [alice, dave] = protocol.users;

      alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
      davePrincipalBefore = (await comet.userBasic(dave.address)).principal;

      snapshot = await takeSnapshot();
    });

    describe('supply', function () {
      this.afterAll(async () => snapshot.restore());

      for(let i = 0; i < MAX_ASSETS; i++) {
        it(`supply collateral with index ${i + 1} is successful`, async () => {
          asset = collaterals[`ASSET${i}`];
          await asset.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await asset.connect(alice).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
          supplyTx = await comet.connect(alice).supply(asset.address, SUPPLY_COLLATERAL_AMOUNT);
          expect(supplyTx).to.not.be.reverted;
        });

        it(`SupplyCollateral event is emitted`, async () => {
          await expect(supplyTx)
            .to.emit(comet, 'SupplyCollateral')
            .withArgs(alice.address, alice.address, asset.address, SUPPLY_COLLATERAL_AMOUNT);
        });

        it(`alice collateral balance is equal to supplied amount`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, asset.address)).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        });

        it('alice asset list contains asset', async () => {
          const assetList = await comet.getAssetList(alice.address);
          expect(assetList).to.include(asset.address);
        });

        it('comet total supplied collateral amount is equal to alice supplied amount', async () => {
          expect((await comet.totalsCollateral(asset.address)).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }); 

        it('alice principal is not changed', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(alicePrincipalBefore);
        });
      }
    });

    describe('supplyTo', function () {
      before(async () => {
        await comet.connect(dave).allow(alice.address, true);
      });

      this.afterAll(async () => snapshot.restore());
      
      for(let i = 0; i < MAX_ASSETS; i++) {
        it(`supply collateral with index ${i + 1} is successful`, async () => {
          asset = collaterals[`ASSET${i}`];
          await asset.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await asset.connect(alice).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
          supplyTx = await comet.connect(alice).supplyTo(dave.address, asset.address, SUPPLY_COLLATERAL_AMOUNT);
          expect(supplyTx).to.not.be.reverted;
        });

        it(`SupplyCollateral event is emitted`, async () => {
          await expect(supplyTx)
            .to.emit(comet, 'SupplyCollateral')
            .withArgs(alice.address, dave.address, asset.address, SUPPLY_COLLATERAL_AMOUNT);
        });

        it(`dave collateral balance is equal to supplied amount`, async () => {
          expect(await comet.collateralBalanceOf(dave.address, asset.address)).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        });

        it('alice asset list contains asset', async () => {
          const assetList = await comet.getAssetList(dave.address);
          expect(assetList).to.include(asset.address);
        });

        it('comet total supplied collateral amount is equal to alice supplied amount', async () => {
          expect((await comet.totalsCollateral(asset.address)).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }); 

        it('alice principal is not changed', async () => {
          expect((await comet.userBasic(dave.address)).principal).to.be.equal(davePrincipalBefore);
        });
      }
    });

    describe('supplyFrom', function () {
      before(async () => {
        await comet.connect(alice).allow(dave.address, true);
      });

      this.afterAll(async () => snapshot.restore());
      
      for(let i = 0; i < MAX_ASSETS; i++) {
        it(`supply collateral with index ${i + 1} is successful`, async () => {
          asset = collaterals[`ASSET${i}`];
          await asset.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await asset.connect(alice).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
          supplyTx = await comet.connect(dave).supplyFrom(alice.address, alice.address, asset.address, SUPPLY_COLLATERAL_AMOUNT);
          expect(supplyTx).to.not.be.reverted;
        });

        it(`SupplyCollateral event is emitted`, async () => {
          await expect(supplyTx)
            .to.emit(comet, 'SupplyCollateral')
            .withArgs(alice.address, alice.address, asset.address, SUPPLY_COLLATERAL_AMOUNT);
        });

        it(`alice collateral balance is equal to supplied amount`, async () => {
          expect(await comet.collateralBalanceOf(alice.address, asset.address)).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        });

        it('alice asset list contains asset', async () => {
          const assetList = await comet.getAssetList(alice.address);
          expect(assetList).to.include(asset.address);
        });

        it('comet total supplied collateral amount is equal to alice supplied amount', async () => {
          expect((await comet.totalsCollateral(asset.address)).totalSupplyAsset).to.be.equal(SUPPLY_COLLATERAL_AMOUNT);
        }); 

        it('alice principal is not changed', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.equal(alicePrincipalBefore);
        });
      }
    });
  });

  describe('non-standard tokens', function () {
    describe('USDT-like token', function () {
      let comet: CometHarnessInterface;
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
        comet = protocol.comet;
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
      let feeComet: CometHarnessInterface;
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
        
        feeComet = protocol.comet;
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
        expect(baseTokenFeeTx).to.not.be.reverted;

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
        expect(baseTokenFeeTx).to.emit(feeComet, 'Supply').withArgs(alice.address, alice.address, amountWithoutFee.toBigInt());
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
        expect(collateralFeeTx).to.not.be.reverted;

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
        expect(collateralFeeTx).to.emit(feeComet, 'SupplyCollateral').withArgs(alice.address, alice.address, feeCollateral.address, amountWithoutFee.toBigInt());
      });
    });
  });

  describe('reentrancy protection', function () {
    it('blocks reentrancy from exceeding the supply cap', async () => {
      const { comet, tokens, users: [alice, bob] } = await makeProtocol({
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
      const { EVIL } = <{ EVIL: EvilToken }>tokens;

      const attack = Object.assign({}, await EVIL.getAttack(), {
        attackType: ReentryAttack.SupplyFrom,
        source: alice.address,
        destination: bob.address,
        asset: EVIL.address,
        amount: 75e6,
        maxCalls: 1
      });
      await EVIL.setAttack(attack);

      await comet.connect(alice).allow(EVIL.address, true);
      await EVIL.connect(alice).approve(comet.address, 75e6);
      await EVIL.allocateTo(alice.address, 75e6);

      await expect(
        comet.connect(alice).supplyTo(bob.address, EVIL.address, 75e6)
      ).to.be.revertedWithCustomError(comet, 'ReentrantCallBlocked');
    });
  });
});

async function getPrincipalChange(
  comet: CometHarnessInterface,
  lastUpdated: number,
  utilization: number,
  user: string,
  amount: BigNumber
): Promise<BigNumber> {
  const cometExtension: CometExtAssetList = (await ethers.getContractAt('CometExtAssetList', comet.address)) as CometExtAssetList;
  const curTime = (await ethers.provider.getBlock('latest')).timestamp;

  const timeElapsed = curTime - lastUpdated;

  const prevIndex = (await cometExtension.totalsBasic()).baseSupplyIndex;
  const accruedIndex = prevIndex.add(
    prevIndex
      .mul(await comet.getSupplyRate(utilization))
      .mul(timeElapsed)
      .div(exp(1, 18))
  );

  const oldPrincipal = (await comet.userBasic(user)).principal;
  const oldBalance = oldPrincipal.mul(accruedIndex).div(1e15);
  const newPrincipal = oldBalance.add(amount).mul(1e15).div(accruedIndex);

  return newPrincipal.sub(oldPrincipal);
}
