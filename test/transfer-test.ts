import { NonStandardFaucetFeeToken__factory } from '../build/types/index.js';
import type { CometHarnessInterfaceExtendedAssetList, FaucetToken, NonStandardFaucetFeeToken } from '../build/types/index.js';
import { ethers, expect, exp, makeProtocol, presentValue, ZERO_ADDRESS, presentValueSupply, mulPrice, mulFactor, defaultAssets, baseBalanceOf, event, portfolio, setTotalsBasic, wait, fastForward } from './helpers.js';
import type { SignerWithAddress } from './helpers.js';
import { MaxUint256, ZeroAddress } from 'ethers';
import type { ContractTransactionResponse, ContractTransactionReceipt, BaseContract } from 'ethers';
import { takeSnapshot } from './helpers/snapshot.js';
import type { SnapshotRestorer } from './helpers/snapshot.js';

function decodedEvents(receipt: ContractTransactionReceipt | null, contract: BaseContract) {
  if (!receipt) throw new Error('Transaction receipt not found');
  return receipt.logs.filter(log => log.address === contract.target)
    .map(log => contract.interface.parseLog(log)).filter(log => log !== null);
}
describe('transfer', function () {
  // Constants
  const baseTokenDecimals = 6;
  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: {
        [symbol: string]: FaucetToken;
    } = {};
  let unsupportedToken: FaucetToken;
  // Accounts
  let users: SignerWithAddress[];
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let dave: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  // Comet parameters
  let baseBorrowMin: bigint;
  before(async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens.USDC as FaucetToken;
    for (const asset in protocol.tokens) {
      if (asset === 'USDC')
        continue;
      collaterals[asset] = protocol.tokens[asset] as FaucetToken;
    }
    pauseGuardian = protocol.pauseGuardian;
    unsupportedToken = protocol.unsupportedToken;
    users = protocol.users;
    [alice, bob, dave] = protocol.users;
    baseBorrowMin = (await comet.baseBorrowMin());
  });
  describe('base token', function () {
    const SUPPLY_AMOUNT: bigint = exp(100, baseTokenDecimals);
    const TRANSFER_AMOUNT: bigint = SUPPLY_AMOUNT / 2n;
    before(async () => {
      // Allocate base tokens to Alice
      await baseToken.allocateTo(alice.address, SUPPLY_AMOUNT);
      // Supply base tokens to Comet from Alice
      await baseToken.connect(alice).approve(await comet.getAddress(), SUPPLY_AMOUNT);
      await comet.connect(alice).supply(await baseToken.getAddress(), SUPPLY_AMOUNT);
    });
    describe('revert on', function () {
      let principal: bigint;
      let baseSupplyIndex: bigint;
      let baseBorrowIndex: bigint;
      before(async () => {
        principal = (await comet.userBasic(alice.address)).principal;
        const totalsBasic = await comet.totalsBasic();
        baseSupplyIndex = totalsBasic.baseSupplyIndex;
        baseBorrowIndex = totalsBasic.baseBorrowIndex;
      });
      it('self-transfer', async () => {
        await expect(comet.connect(alice).transfer(alice.address, SUPPLY_AMOUNT)).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
      });
      it('transfer is paused', async () => {
        // Pause transfer
        await comet.connect(pauseGuardian).pause(false, true, false, false, false);
        await expect(comet.connect(alice).transfer(alice.address, SUPPLY_AMOUNT)).to.be.revertedWithCustomError(comet, 'Paused');
        // Unpause transfer
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });
      // In case when user has no collateral supplied and lend position
      // transfering will revert with BorrowTooSmall, as amount to transfer is greater than
      // user's balance, he'll become a borrower and his balance will be negative on 1 wei
      // which is less than baseBorrowMin
      it('exceeds balance (no collateral supplied & newSrcBalance < baseBorrowMin)', async () => {
        const amountToTransfer = SUPPLY_AMOUNT + 1n;
        const srcBalance = presentValue(principal, baseSupplyIndex, baseBorrowIndex) - amountToTransfer;
        // Ensure -srcBalance < baseBorrowMin
        expect(baseBorrowMin).to.be.greaterThan(-srcBalance);
        await expect(comet.connect(alice).transfer(bob.address, SUPPLY_AMOUNT + 1n)).to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
      });
      // In case when user has no collateral supplied and lend position
      // transfering will revert with NotCollateralized, as amount to transfer is greater than
      // user's balance, he'll become a borrower and his amount to borrow will be >= to baseBorrowMin
      // which will trigger NotCollateralized
      it('exceeds balance (no collateral supplied & newSrcBalance >= baseBorrowMin)', async () => {
        const amountToTransfer = SUPPLY_AMOUNT + baseBorrowMin;
        const srcBalance = presentValue(principal, baseSupplyIndex, baseBorrowIndex) - amountToTransfer;
        // Ensure -srcBalance >= baseBorrowMin
        expect(baseBorrowMin).to.lessThanOrEqual(-srcBalance);
        await expect(comet.connect(alice).transfer(bob.address, amountToTransfer)).to.be.revertedWithCustomError(comet, 'NotCollateralized');
      });
    });
    describe('happy path (without interest)', function () {
      let alicePrincipalBefore: bigint;
      let bobPrincipalBefore: bigint;
      let transferTx: ContractTransactionResponse;
      let totalSupplyBaseBefore: bigint;
      let totalBorrowBaseBefore: bigint;
      let baseSupplyIndex: bigint;
      before(async () => {
        alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
        bobPrincipalBefore = (await comet.userBasic(bob.address)).principal;
        const totalsBasic = await comet.totalsBasic();
        totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
        totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
        baseSupplyIndex = totalsBasic.baseSupplyIndex;
      });
      it('alice has principal equal to supplied amount', async () => {
        expect(alicePrincipalBefore).to.equal(SUPPLY_AMOUNT);
      });
      it('bob has 0 principal', async () => {
        expect(bobPrincipalBefore).to.equal(0n);
      });
      it('alice has 0 borrow balance', async () => {
        expect(await comet.borrowBalanceOf(alice.address)).to.equal(0n);
      });
      it('bob has 0 borrow balance', async () => {
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(0n);
      });
      it('alice balanceOf equals to supplied amount', async () => {
        expect(await comet.balanceOf(alice.address)).to.equal(SUPPLY_AMOUNT);
      });
      it('bob balanceOf equals to 0', async () => {
        expect(await comet.balanceOf(bob.address)).to.equal(0n);
      });
      it('total supply base equals to supplied amount', async () => {
        expect(totalSupplyBaseBefore).to.equal(SUPPLY_AMOUNT);
      });
      it('total borrow base equals to 0', async () => {
        expect(totalBorrowBaseBefore).to.equal(0n);
      });
      it('transfer is successful', async () => {
        transferTx = await comet.connect(alice).transfer(bob.address, TRANSFER_AMOUNT);
        await expect(transferTx).to.not.revert(ethers);
      });
      it('accrue interest', async () => {
        expect((await comet.totalsBasic()).lastAccrualTime).to.equal((await ethers.provider.getBlock('latest')).timestamp);
      });
      it('alice princiapal decreased by transfer amount', async () => {
        const alicePrincipalAfter = (await comet.userBasic(alice.address)).principal;
        expect(alicePrincipalAfter).to.equal(alicePrincipalBefore - TRANSFER_AMOUNT);
      });
      it('bob principal increased by transfer amount', async () => {
        const bobPrincipalAfter = (await comet.userBasic(bob.address)).principal;
        expect(bobPrincipalAfter).to.equal(bobPrincipalBefore + TRANSFER_AMOUNT);
      });
      it('alice balanceOf becomes transferred amount', async () => {
        expect(await comet.balanceOf(alice.address)).to.equal(TRANSFER_AMOUNT);
      });
      it('bob balanceOf becomes transferred amount', async () => {
        expect(await comet.balanceOf(bob.address)).to.equal(TRANSFER_AMOUNT);
      });
      it('alice borrow balance is not changed', async () => {
        expect(await comet.borrowBalanceOf(alice.address)).to.equal(0n);
      });
      it('bob borrow balance is not changed', async () => {
        expect(await comet.borrowBalanceOf(bob.address)).to.equal(0n);
      });
      it('total supply base is not changed', async () => {
        expect((await comet.totalsBasic()).totalSupplyBase).to.equal(totalSupplyBaseBefore);
      });
      it('total borrow base is not changed', async () => {
        expect((await comet.totalsBasic()).totalBorrowBase).to.equal(totalBorrowBaseBefore);
      });
      it('emits Transfer event for alice', async () => {
        await expect(transferTx)
          .to.emit(comet, 'Transfer')
          .withArgs(alice.address, ZERO_ADDRESS, presentValueSupply(baseSupplyIndex, TRANSFER_AMOUNT));
      });
      it('emits Transfer event for bob', async () => {
        await expect(transferTx)
          .to.emit(comet, 'Transfer')
          .withArgs(ZERO_ADDRESS, bob.address, presentValueSupply(baseSupplyIndex, TRANSFER_AMOUNT));
      });
    });
    describe('max balance variations', function () {
      describe('without interest', function () {
        let alicePrincipalBefore: bigint;
        let bobPrincipalBefore: bigint;
        let transferTx: ContractTransactionResponse;
        let totalSupplyBaseBefore: bigint;
        let totalBorrowBaseBefore: bigint;
        let baseSupplyIndex: bigint;
        before(async () => {
          alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
          bobPrincipalBefore = (await comet.userBasic(bob.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          baseSupplyIndex = totalsBasic.baseSupplyIndex;
        });
        it('alice has principal equal to supplied amount', async () => {
          expect(alicePrincipalBefore).to.equal(TRANSFER_AMOUNT);
        });
        it('bob has 0 principal', async () => {
          expect(bobPrincipalBefore).to.equal(TRANSFER_AMOUNT);
        });
        it('alice has 0 borrow balance', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0n);
        });
        it('bob has 0 borrow balance', async () => {
          expect(await comet.borrowBalanceOf(bob.address)).to.equal(0n);
        });
        it('alice balanceOf equals to transferred amount', async () => {
          expect(await comet.balanceOf(alice.address)).to.equal(TRANSFER_AMOUNT);
        });
        it('bob balanceOf equals to transferred amount', async () => {
          expect(await comet.balanceOf(bob.address)).to.equal(TRANSFER_AMOUNT);
        });
        it('total supply base equals to supplied amount', async () => {
          expect(totalSupplyBaseBefore).to.equal(SUPPLY_AMOUNT);
        });
        it('total borrow base equals to 0', async () => {
          expect(totalBorrowBaseBefore).to.equal(0n);
        });
        it('transfer is successful', async () => {
          transferTx = await comet.connect(alice).transfer(bob.address, MaxUint256);
          await expect(transferTx).to.not.revert(ethers);
        });
        it('alice princiapal becomes 0', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(0n);
        });
        it('bob principal increased by transfer amount', async () => {
          const bobPrincipalAfter = (await comet.userBasic(bob.address)).principal;
          expect(bobPrincipalAfter).to.equal(bobPrincipalBefore + TRANSFER_AMOUNT);
        });
        it('alice balanceOf becomes 0', async () => {
          expect(await comet.balanceOf(alice.address)).to.equal(0n);
        });
        it('bob balanceOf becomes alice supplied amount', async () => {
          expect(await comet.balanceOf(bob.address)).to.equal(SUPPLY_AMOUNT);
        });
        it('alice borrow balance is not changed', async () => {
          expect(await comet.borrowBalanceOf(alice.address)).to.equal(0n);
        });
        it('bob borrow balance is not changed', async () => {
          expect(await comet.borrowBalanceOf(bob.address)).to.equal(0n);
        });
        it('total supply base is not changed', async () => {
          expect((await comet.totalsBasic()).totalSupplyBase).to.equal(totalSupplyBaseBefore);
        });
        it('total borrow base is not changed', async () => {
          expect((await comet.totalsBasic()).totalBorrowBase).to.equal(totalBorrowBaseBefore);
        });
        it('emits Transfer event for alice', async () => {
          await expect(transferTx)
            .to.emit(comet, 'Transfer')
            .withArgs(alice.address, ZERO_ADDRESS, presentValueSupply(baseSupplyIndex, TRANSFER_AMOUNT));
        });
        it('emits Transfer event for bob', async () => {
          await expect(transferTx)
            .to.emit(comet, 'Transfer')
            .withArgs(ZERO_ADDRESS, bob.address, presentValueSupply(baseSupplyIndex, TRANSFER_AMOUNT));
        });
      });
      describe('with accrued interest', function () {
        const interestRateParams = {
          supplyKink: exp(0.8, 18),
          supplyInterestRateBase: exp(0.01, 18),
          supplyInterestRateSlopeLow: exp(0.04, 18),
          supplyInterestRateSlopeHigh: exp(0.4, 18),
          borrowKink: exp(0.8, 18),
          borrowInterestRateBase: exp(0.01, 18),
          borrowInterestRateSlopeLow: exp(0.05, 18),
          borrowInterestRateSlopeHigh: exp(0.3, 18),
        };
        const SUPPLY_AMOUNT: bigint = exp(100, baseTokenDecimals);
        let testComet: CometHarnessInterfaceExtendedAssetList;
        let testBaseToken: FaucetToken;
        let alice: SignerWithAddress;
        let bob: SignerWithAddress;
        let newAlicePrincipal: bigint;
        let newAliceBalanceOf: bigint;
        let bobPrincipalBefore: bigint;
        let earnedInterest: bigint;
        let transferTx: ContractTransactionResponse;
        before(async () => {
          const protocol = await makeProtocol({ ...interestRateParams, base: 'USDC' });
          testComet = protocol.cometWithExtendedAssetList;
          testBaseToken = protocol.tokens.USDC as FaucetToken;
          [alice, bob] = protocol.users;
          // Allocate tokens to Alice
          await testBaseToken.allocateTo(alice.address, SUPPLY_AMOUNT);
          // Supply base tokens to Comet from Alice
          await testBaseToken.connect(alice).approve(await testComet.getAddress(), SUPPLY_AMOUNT);
          await testComet.connect(alice).supply(await testBaseToken.getAddress(), SUPPLY_AMOUNT);
        });
        it('alice has principal equal to supplied amount', async () => {
          newAlicePrincipal = (await testComet.userBasic(alice.address)).principal;
          expect(newAlicePrincipal).to.be.approximately(SUPPLY_AMOUNT, 1n); // 1 wei precision
        });
        it('bob has 0 principal', async () => {
          bobPrincipalBefore = (await testComet.userBasic(bob.address)).principal;
          expect(bobPrincipalBefore).to.equal(0n);
        });
        it('alice balanceOf equal to supplied amount', async () => {
          newAliceBalanceOf = await testComet.balanceOf(alice.address);
          expect(newAliceBalanceOf).to.be.approximately(SUPPLY_AMOUNT, 1n); // 1 wei precision
        });
        it('bob balanceOf equal to 0', async () => {
          expect(await testComet.balanceOf(bob.address)).to.equal(0n);
        });
        it('alice borrow balance is 0', async () => {
          expect(await testComet.borrowBalanceOf(alice.address)).to.equal(0n);
        });
        it('bob borrow balance is 0', async () => {
          expect(await testComet.borrowBalanceOf(bob.address)).to.equal(0n);
        });
        it('total supply base is equal to supplied amount', async () => {
          expect((await testComet.totalsBasic()).totalSupplyBase).to.be.approximately(SUPPLY_AMOUNT, 1n); // 1 wei precision
        });
        it('total borrow base is equal to 0', async () => {
          expect((await testComet.totalsBasic()).totalBorrowBase).to.equal(0n);
        });
        it('wait some time to accrue interest', async () => {
          await ethers.provider.send('evm_increaseTime', [60 * 3600]);
          await ethers.provider.send('evm_mine', []);
          await testComet.accrueAccount(ZERO_ADDRESS);
        });
        it('alice principal is not changed', async () => {
          expect((await testComet.userBasic(alice.address)).principal).to.equal(newAlicePrincipal);
        });
        it('earned interest is > 0', async () => {
          const baseSupplyIndex = (await testComet.totalsBasic()).baseSupplyIndex;
          earnedInterest = presentValueSupply(baseSupplyIndex, newAlicePrincipal) - SUPPLY_AMOUNT;
          expect(earnedInterest).to.be.greaterThan(0n);
        });
        it('alice balanceOf is increased', async () => {
          const updatedAliceBalanceOf = await testComet.balanceOf(alice.address);
          expect(updatedAliceBalanceOf).to.be.approximately((newAliceBalanceOf + BigInt(earnedInterest)), 1n); // 1 wei precision
          newAliceBalanceOf = updatedAliceBalanceOf;
        });
        it('bob principal and balances are not changed after some time', async () => {
          expect((await testComet.userBasic(bob.address)).principal).to.equal(bobPrincipalBefore);
          expect(await testComet.balanceOf(bob.address)).to.equal(0n);
          expect(await testComet.borrowBalanceOf(bob.address)).to.equal(0n);
        });
        it('trasnfer is successful', async () => {
          transferTx = await testComet.connect(alice).transfer(bob.address, MaxUint256);
          await expect(transferTx).to.not.revert(ethers);
        });
        it('alice principal becomes 0', async () => {
          expect((await testComet.userBasic(alice.address)).principal).to.equal(0n);
        });
        it('bob principal becomes alice principal after transfer', async () => {
          expect((await testComet.userBasic(bob.address)).principal).to.be.approximately(newAlicePrincipal, 1n); // 1 wei precision
        });
        it('alice balanceOf becomes 0', async () => {
          expect(await testComet.balanceOf(alice.address)).to.equal(0n);
        });
        it('bob balanceOf becomes supplied amount + earned interest', async () => {
          expect(await testComet.balanceOf(bob.address)).to.be.approximately(SUPPLY_AMOUNT + earnedInterest, 1n); // 1 wei precision
        });
      });
    });
    describe('edge cases', function () {
      describe('becomes borrower by transferring amount greater than base balance', function () {
        const BORROW_AMOUNT = exp(10, baseTokenDecimals);
        const TRANSFER_AMOUNT = SUPPLY_AMOUNT + BORROW_AMOUNT;
        const COLLATERAL_AMOUNT = exp(1, 18); // 1 WETH
        let bobPrincipalBefore: bigint;
        let alicePrincipalBefore: bigint;
        let transferTx: ContractTransactionResponse;
        let totalSupplyBaseBefore: bigint;
        let totalBorrowBaseBefore: bigint;
        let baseSupplyIndex: bigint;
        let weth: FaucetToken;
        let snapshot: SnapshotRestorer;
        before(async () => {
          // Bob already has base balance (SUPPLY_AMOUNT) from previous "transfer max base balance" describe.
          // Supply collateral to bob so he can become a borrower when transferring more than his balance.
          weth = collaterals['WETH'] as FaucetToken;
          await weth.allocateTo(bob.address, COLLATERAL_AMOUNT);
          await weth.connect(bob).approve(await comet.getAddress(), COLLATERAL_AMOUNT);
          await comet.connect(bob).supply(await weth.getAddress(), COLLATERAL_AMOUNT);
          bobPrincipalBefore = (await comet.userBasic(bob.address)).principal;
          alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          totalSupplyBaseBefore = totalsBasic.totalSupplyBase;
          totalBorrowBaseBefore = totalsBasic.totalBorrowBase;
          baseSupplyIndex = totalsBasic.baseSupplyIndex;
          snapshot = await takeSnapshot();
        });
        it('bob has base balance equal to supplied amount', async () => {
          expect(bobPrincipalBefore).to.equal(SUPPLY_AMOUNT);
        });
        it('alice has 0 principal', async () => {
          expect(alicePrincipalBefore).to.equal(0n);
        });
        it('bob has collateral supplied', async () => {
          expect(await comet.collateralBalanceOf(bob.address, await weth.getAddress())).to.equal(COLLATERAL_AMOUNT);
        });
        it('transfer is successful (bob transfers more than base balance, becomes borrower)', async () => {
          transferTx = await comet.connect(bob).transfer(alice.address, TRANSFER_AMOUNT);
          await expect(transferTx).to.not.revert(ethers);
        });
        it('bob principal is negative (borrow position)', async () => {
          expect((await comet.userBasic(bob.address)).principal).to.be.lessThan(0n);
        });
        it('bob borrow balance equals borrow amount', async () => {
          expect(await comet.borrowBalanceOf(bob.address)).to.equal(BORROW_AMOUNT);
        });
        it('alice principal increased by transfer amount', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.equal(alicePrincipalBefore + TRANSFER_AMOUNT);
        });
        it('alice balanceOf equals transfer amount', async () => {
          expect(await comet.balanceOf(alice.address)).to.equal(TRANSFER_AMOUNT);
        });
        it('bob balanceOf is 0', async () => {
          expect(await comet.balanceOf(bob.address)).to.equal(0n);
        });
        it('total supply base increased by borrow amount (alice receives supply, bob withdraws)', async () => {
          // Net change: + (SUPPLY_AMOUNT + BORROW_AMOUNT) to alice, - SUPPLY_AMOUNT from bob = + BORROW_AMOUNT
          expect((await comet.totalsBasic()).totalSupplyBase).to.equal(totalSupplyBaseBefore + BORROW_AMOUNT);
        });
        it('total borrow base increased by bob borrow amount', async () => {
          expect((await comet.totalsBasic()).totalBorrowBase).to.be.approximately(totalBorrowBaseBefore + BORROW_AMOUNT, 400n);
        });
        it('emits Transfer event for bob (withdraw)', async () => {
          await expect(transferTx)
            .to.emit(comet, 'Transfer')
            .withArgs(bob.address, ZERO_ADDRESS, presentValueSupply(baseSupplyIndex, SUPPLY_AMOUNT));
        });
        it('emits Transfer event for alice (supply)', async () => {
          await expect(transferTx)
            .to.emit(comet, 'Transfer')
            .withArgs(ZERO_ADDRESS, alice.address, presentValueSupply(baseSupplyIndex, SUPPLY_AMOUNT + BORROW_AMOUNT));
          await snapshot.restore();
        });
      });
    });
  });
  describe('collateral', function () {
    const TRANSFER_AMOUNT: bigint = exp(1, 18);
    let collateral: FaucetToken;
    before(async () => {
      collateral = collaterals['COMP'] as FaucetToken;
      await collateral.allocateTo(alice.address, TRANSFER_AMOUNT);
      await collateral.connect(alice).approve(await comet.getAddress(), TRANSFER_AMOUNT);
      await comet.connect(alice).supply(await collateral.getAddress(), TRANSFER_AMOUNT);
    });
    describe('revert on', function () {
      it('self-transfer', async () => {
        await expect(comet.connect(alice).transferAsset(alice.address, await collateral.getAddress(), TRANSFER_AMOUNT)).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
      });
      it('pause', async () => {
        await comet.connect(pauseGuardian).pause(false, true, false, false, false);
        await expect(comet.connect(alice).transferAsset(alice.address, await collateral.getAddress(), TRANSFER_AMOUNT)).to.be.revertedWithCustomError(comet, 'Paused');
        await comet.connect(pauseGuardian).pause(false, false, false, false, false);
      });
      it('unsupported asset & amount > 0', async () => {
        // Overflow/underflow panic error
        // This happens because user can not have unsupported token balance > 0
        await expect(comet.connect(alice).transferAsset(bob.address, await unsupportedToken.getAddress(), TRANSFER_AMOUNT)).to.be.revertedWithPanic('0x11');
      });
      it('unsupported asset & amount = 0', async () => {
        await expect(comet.connect(alice).transferAsset(bob.address, await unsupportedToken.getAddress(), 0n)).to.be.revertedWithCustomError(comet, 'BadAsset');
      });
      it('amount > balance', async () => {
        const balance = await comet.collateralBalanceOf(alice.address, await collateral.getAddress());
        // 0x11: Arithmetic operation overflowed outside of an unchecked block
        await expect(comet.connect(alice).transferAsset(bob.address, await collateral.getAddress(), (balance + 1n))).to.be.revertedWithPanic('0x11');
      });
      describe('not collateralized', function () {
        const BORROW_AMOUNT: bigint = exp(50, baseTokenDecimals);
        const TRANSFER_AMOUNT: bigint = exp(0.8, 18);
        let snapshot: SnapshotRestorer;
        before(async () => snapshot = await takeSnapshot());
        it('alice withdraw base asset to become borrower', async () => {
          await comet.connect(alice).withdraw(await baseToken.getAddress(), BORROW_AMOUNT);
        });
        it('alice principal is negative (borrow position)', async () => {
          expect((await comet.userBasic(alice.address)).principal).to.be.lessThan(0n);
        });
        // Reproduce calculation performed in isLiquidatable function
        // to check that alice is not collateralized to transfer such amount
        it('final liquidity is negative', async () => {
          const principal = (await comet.userBasic(alice.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
          const baseScale = await comet.baseScale();
          const baseLiquidity = mulPrice(presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), basePrice, baseScale);
          // Calculate liquidity for collateral
          const assetInfo = await comet.getAssetInfoByAddress(await collateral.getAddress());
          const collateralAmount = ((await comet.collateralBalanceOf(alice.address, await collateral.getAddress())) - BigInt(TRANSFER_AMOUNT));
          const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
          const collateralLiquidity = mulPrice(collateralAmount, collateralPrice, exp(1, 18));
          const finalLiquidity = baseLiquidity + mulFactor(collateralLiquidity, assetInfo.borrowCollateralFactor);
          expect(finalLiquidity).to.be.lessThan(0n);
        });
        it('transfer is reverted with NotCollateralized error', async () => {
          await expect(comet.connect(alice).transferAsset(bob.address, await collateral.getAddress(), TRANSFER_AMOUNT)).to.be.revertedWithCustomError(comet, 'NotCollateralized');
          await snapshot.restore();
        });
      });
    });
    describe('transfer asset: happy path & no borrow', function () {
      let transferTx: ContractTransactionResponse;
      let totalsCollateralBefore: bigint;
      let aliceCollateralBalanceBefore: bigint;
      it('total collateral amount equals alice balance', async () => {
        totalsCollateralBefore = (await comet.totalsCollateral(await collateral.getAddress())).totalSupplyAsset;
        expect(totalsCollateralBefore).to.equal(TRANSFER_AMOUNT);
      });
      it('alice collateral balance equals transfer amount', async () => {
        aliceCollateralBalanceBefore = await comet.collateralBalanceOf(alice.address, await collateral.getAddress());
        expect(aliceCollateralBalanceBefore).to.equal(TRANSFER_AMOUNT);
      });
      it('dave collateral balance = 0', async () => {
        expect(await comet.collateralBalanceOf(dave.address, await collateral.getAddress())).to.equal(0n);
      });
      it('alice assetsIn has only one asset and collateral is the only asset', async () => {
        const assetsInList = await comet.getAssetList(alice.address);
        expect(assetsInList).to.include(await collateral.getAddress());
        expect((await comet.userBasic(alice.address)).assetsIn).to.equal(1);
      });
      it('dave assetsIn = 0', async () => {
        const assetsInList = await comet.getAssetList(dave.address);
        expect(assetsInList).to.be.empty;
        expect((await comet.userBasic(dave.address)).assetsIn).to.equal(0);
      });
      it('alice is not a borrower', async () => {
        // We should check that alice is not a borrower
        // In case when alice is a borrower, she need to make additional check for collateralization
        expect((await comet.userBasic(alice.address)).principal).to.equal(0n);
      });
      it('transfer is successful', async () => {
        transferTx = await comet.connect(alice).transferAsset(dave.address, await collateral.getAddress(), TRANSFER_AMOUNT);
        await expect(transferTx).to.not.revert(ethers);
      });
      it('TransferCollateral event is emitted', async () => {
        await expect(transferTx)
          .to.emit(comet, 'TransferCollateral')
          .withArgs(alice.address, dave.address, await collateral.getAddress(), TRANSFER_AMOUNT);
      });
      it('alice collateral balance decreased by transfer amount', async () => {
        expect(await comet.collateralBalanceOf(alice.address, await collateral.getAddress())).to.equal((aliceCollateralBalanceBefore - BigInt(TRANSFER_AMOUNT)));
      });
      it('dave collateral balance increased by transfer amount', async () => {
        expect(await comet.collateralBalanceOf(dave.address, await collateral.getAddress())).to.equal(TRANSFER_AMOUNT);
      });
      it('alice assetsIn becomes zero and asset is removed from the list', async () => {
        // We expect that transfer amount is the whole alice balance
        // So alice assetsIn is updated
        const assetsInList = await comet.getAssetList(alice.address);
        expect(assetsInList).to.be.empty;
        expect((await comet.userBasic(alice.address)).assetsIn).to.equal(0);
      });
      it('dave assetsIn increases and collateral is the only asset', async () => {
        const assetsInList = await comet.getAssetList(dave.address);
        expect(assetsInList).to.include(await collateral.getAddress());
        expect((await comet.userBasic(dave.address)).assetsIn).to.equal(1);
      });
      it('total collateral amount is not changed', async () => {
        expect((await comet.totalsCollateral(await collateral.getAddress())).totalSupplyAsset).to.equal(totalsCollateralBefore);
      });
    });
    describe('transfer asset: happy path & with borrow', function () {
      const BORROW_AMOUNT: bigint = exp(20, baseTokenDecimals);
      const PARTIAL_TRANSFER_AMOUNT: bigint = exp(0.2, 18);
      let transferTx: ContractTransactionResponse;
      let totalsCollateralBefore: bigint;
      let daveCollateralBalanceBefore: bigint;
      // Dave already has base balance (SUPPLY_AMOUNT) from previous "transfer max base balance" describe.
      // Make Dave a borrower by withdrawing base asset
      before(async () => {
        await comet.connect(dave).withdraw(await baseToken.getAddress(), BORROW_AMOUNT);
      });
      it('total collateral amount equals dave balance', async () => {
        totalsCollateralBefore = (await comet.totalsCollateral(await collateral.getAddress())).totalSupplyAsset;
        expect(totalsCollateralBefore).to.equal(TRANSFER_AMOUNT);
      });
      it('dave collateral balance equals transfer amount', async () => {
        daveCollateralBalanceBefore = await comet.collateralBalanceOf(dave.address, await collateral.getAddress());
        expect(daveCollateralBalanceBefore).to.equal(TRANSFER_AMOUNT);
      });
      it('alice collateral balance = 0', async () => {
        expect(await comet.collateralBalanceOf(alice.address, await collateral.getAddress())).to.equal(0n);
      });
      it('dave assetsIn has only one asset and collateral is the only asset', async () => {
        const assetsInList = await comet.getAssetList(dave.address);
        expect(assetsInList).to.include(await collateral.getAddress());
        expect((await comet.userBasic(dave.address)).assetsIn).to.equal(1);
      });
      it('alice assetsIn = 0', async () => {
        const assetsInList = await comet.getAssetList(alice.address);
        expect(assetsInList).to.be.empty;
        expect((await comet.userBasic(alice.address)).assetsIn).to.equal(0);
      });
      it('dave is a borrower', async () => {
        expect((await comet.userBasic(dave.address)).principal).to.be.lessThan(0n);
      });
      it('dave is collateralized for transfer amount', async () => {
        const principal = (await comet.userBasic(dave.address)).principal;
        const totalsBasic = await comet.totalsBasic();
        const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
        const baseScale = await comet.baseScale();
        const baseLiquidity = mulPrice(presentValue(principal, totalsBasic.baseSupplyIndex, totalsBasic.baseBorrowIndex), basePrice, baseScale);
        // Calculate liquidity for collateral
        const assetInfo = await comet.getAssetInfoByAddress(await collateral.getAddress());
        const collateralAmount = ((await comet.collateralBalanceOf(dave.address, await collateral.getAddress())) - BigInt(PARTIAL_TRANSFER_AMOUNT));
        const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
        const collateralLiquidity = mulPrice(collateralAmount, collateralPrice, exp(1, 18));
        const finalLiquidity = baseLiquidity + mulFactor(collateralLiquidity, assetInfo.borrowCollateralFactor);
        expect(finalLiquidity).to.be.greaterThan(0n);
      });
      it('transfer is successful', async () => {
        transferTx = await comet.connect(dave).transferAsset(alice.address, await collateral.getAddress(), PARTIAL_TRANSFER_AMOUNT);
        await expect(transferTx).to.not.revert(ethers);
      });
      it('TransferCollateral event is emitted', async () => {
        await expect(transferTx)
          .to.emit(comet, 'TransferCollateral')
          .withArgs(dave.address, alice.address, await collateral.getAddress(), PARTIAL_TRANSFER_AMOUNT);
      });
      it('dave collateral balance decreased by transfer amount', async () => {
        expect(await comet.collateralBalanceOf(dave.address, await collateral.getAddress())).to.equal((daveCollateralBalanceBefore - BigInt(PARTIAL_TRANSFER_AMOUNT)));
      });
      it('alice collateral balance increased by transfer amount', async () => {
        expect(await comet.collateralBalanceOf(alice.address, await collateral.getAddress())).to.equal(PARTIAL_TRANSFER_AMOUNT);
      });
      it('dave assetsIn is not changed', async () => {
        const assetsInList = await comet.getAssetList(dave.address);
        expect(assetsInList).to.include(await collateral.getAddress());
        expect((await comet.userBasic(dave.address)).assetsIn).to.equal(1);
      });
      it('alice assetsIn increases and collateral is the only asset', async () => {
        const assetsInList = await comet.getAssetList(dave.address);
        expect(assetsInList).to.include(await collateral.getAddress());
        expect((await comet.userBasic(dave.address)).assetsIn).to.equal(1);
      });
      it('total collateral amount is not changed', async () => {
        expect((await comet.totalsCollateral(await collateral.getAddress())).totalSupplyAsset).to.equal(totalsCollateralBefore);
      });
    });
  });
  /**
     * Note: tests assume, that transferFrom(), transferAssetFrom() are clones of
     * transfer(), transferAsset(), thus only key cases are checked
     */
  describe('transferFrom variations', function () {
    const BASE_TRANSFER_AMOUNT: bigint = exp(10, baseTokenDecimals);
    const COLLATERAL_TRANSFER_AMOUNT: bigint = exp(1, 18);
    let operator: SignerWithAddress;
    let holder: SignerWithAddress;
    let receiver: SignerWithAddress;
    before(async function () {
      operator = users[10];
      holder = users[11];
      receiver = users[12];
    });
    describe('transferFrom (base asset)', function () {
      before(async function () {
        await baseToken.allocateTo(holder.address, BASE_TRANSFER_AMOUNT);
        await baseToken.connect(holder).approve(await comet.getAddress(), BASE_TRANSFER_AMOUNT);
        await comet.connect(holder).supply(await baseToken.getAddress(), BASE_TRANSFER_AMOUNT);
        await comet.connect(holder).approve(operator.address, MaxUint256);
        // wait for a while to have impact from accrual
        await ethers.provider.send('evm_increaseTime', [60 * 60]); // 1 hr
        await ethers.provider.send('evm_mine', []);
      });
      describe('revert on', function () {
        let principal: bigint;
        let baseSupplyIndex: bigint;
        let baseBorrowIndex: bigint;
        before(async () => {
          principal = (await comet.userBasic(holder.address)).principal;
          const totalsBasic = await comet.totalsBasic();
          baseSupplyIndex = totalsBasic.baseSupplyIndex;
          baseBorrowIndex = totalsBasic.baseBorrowIndex;
        });
        it('pause', async () => {
          await comet.connect(pauseGuardian).pause(false, true, false, false, false);
          await expect(comet.connect(operator).transferFrom(holder.address, receiver.address, BASE_TRANSFER_AMOUNT)).to.be.revertedWithCustomError(comet, 'Paused');
          await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        });
        it('operator has no permission from holder', async () => {
          await comet.connect(holder).approve(operator.address, 0);
          await expect(comet.connect(operator).transferFrom(holder.address, receiver.address, BASE_TRANSFER_AMOUNT)).to.be.revertedWithCustomError(comet, 'Unauthorized');
          await comet.connect(holder).approve(operator.address, MaxUint256);
        });
        it('src == dst', async () => {
          await expect(comet.connect(operator).transferFrom(holder.address, holder.address, BASE_TRANSFER_AMOUNT)).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
        });
        it('exceeds balance (no collateral supplied & newSrcBalance < baseBorrowMin)', async () => {
          const amountToTransfer = BASE_TRANSFER_AMOUNT + 10n;
          const srcBalance = presentValue(principal, baseSupplyIndex, baseBorrowIndex) - amountToTransfer;
          // Ensure -srcBalance < baseBorrowMin
          expect(baseBorrowMin).to.be.greaterThan(-srcBalance);
          await expect(comet.connect(operator).transferFrom(holder.address, receiver.address, amountToTransfer)).to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
        });
        it('exceeds balance (no collateral supplied & newSrcBalance >= baseBorrowMin)', async () => {
          const amountToTransfer = BASE_TRANSFER_AMOUNT + baseBorrowMin + 10n;
          const srcBalance = presentValue(principal, baseSupplyIndex, baseBorrowIndex) - amountToTransfer;
          // Ensure -srcBalance >= baseBorrowMin
          expect(baseBorrowMin).to.lessThanOrEqual(-srcBalance);
          await expect(comet.connect(operator).transferFrom(holder.address, receiver.address, amountToTransfer)).to.be.revertedWithCustomError(comet, 'NotCollateralized');
        });
      });
      describe('happy cases', function () {
        it('should accrue state (same as transfer())', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          await comet.connect(operator).transferFrom(holder.address, receiver.address, BASE_TRANSFER_AMOUNT);
          expect((await comet.totalsBasic()).lastAccrualTime).to.equal((await ethers.provider.getBlock('latest')).timestamp);
          await snapshot.restore();
        });
        it('should transfer base from holder to receiver', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          const holderBalanceBeforeTx = await comet.balanceOf(holder.address);
          const receiverBalanceBeforeTx = await comet.balanceOf(receiver.address);
          await comet.connect(operator).transferFrom(holder.address, receiver.address, BASE_TRANSFER_AMOUNT);
          expect((holderBalanceBeforeTx - BigInt(await comet.balanceOf(holder.address)))).to.be.approximately(BASE_TRANSFER_AMOUNT, 1n);
          expect(((await comet.balanceOf(receiver.address)) - BigInt(receiverBalanceBeforeTx))).to.be.approximately(BASE_TRANSFER_AMOUNT, 1n);
          await snapshot.restore();
        });
        it('should transfer base when receiver == operator', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          const holderBalanceBeforeTx = await comet.balanceOf(holder.address);
          const operatorBalanceBeforeTx = await comet.balanceOf(operator.address);
          await comet.connect(operator).transferFrom(holder.address, operator.address, BASE_TRANSFER_AMOUNT);
          expect((holderBalanceBeforeTx - BigInt(await comet.balanceOf(holder.address)))).to.be.approximately(BASE_TRANSFER_AMOUNT, 1n);
          expect(((await comet.balanceOf(operator.address)) - BigInt(operatorBalanceBeforeTx))).to.be.approximately(BASE_TRANSFER_AMOUNT, 1n);
          await snapshot.restore();
        });
        it('should transfer base when operator == holder', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          const holderBalanceBeforeTx = await comet.balanceOf(holder.address);
          const receiverBalanceBeforeTx = await comet.balanceOf(receiver.address);
          await comet.connect(holder).transferFrom(holder.address, receiver.address, BASE_TRANSFER_AMOUNT);
          expect((holderBalanceBeforeTx - BigInt(await comet.balanceOf(holder.address)))).to.be.approximately(BASE_TRANSFER_AMOUNT, 1n);
          expect(((await comet.balanceOf(receiver.address)) - BigInt(receiverBalanceBeforeTx))).to.be.approximately(BASE_TRANSFER_AMOUNT, 1n);
          await snapshot.restore();
        });
        it('should emit Transfer events', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          const baseSupplyIndex = (await comet.totalsBasic()).baseSupplyIndex;
          const tx = await comet.connect(operator).transferFrom(holder.address, receiver.address, BASE_TRANSFER_AMOUNT);
          // Get all Transfer events from the transaction receipt
          const receipt = await tx.wait();
          if (!receipt)
            throw new Error('Transaction receipt not found');
          const transferEvents = decodedEvents(receipt, comet).filter(x => x.name === 'Transfer');
          // From src to zero address
          let transferEvent = transferEvents[0];
          expect(transferEvent).to.not.be.undefined;
          let transferFrom = transferEvent?.args?.from;
          let transferTo = transferEvent?.args?.to;
          let transferAmount = transferEvent?.args?.amount;
          expect(transferFrom).to.be.equal(holder.address);
          expect(transferTo).to.be.equal(ZERO_ADDRESS);
          expect(transferAmount).to.be.approximately(presentValueSupply(baseSupplyIndex, BASE_TRANSFER_AMOUNT), 1);
          // From zero address to dst
          transferEvent = transferEvents[1];
          expect(transferEvent).to.not.be.undefined;
          transferFrom = transferEvent?.args?.from;
          transferTo = transferEvent?.args?.to;
          transferAmount = transferEvent?.args?.amount;
          expect(transferFrom).to.be.equal(ZERO_ADDRESS);
          expect(transferTo).to.be.equal(receiver.address);
          expect(transferAmount).to.be.approximately(presentValueSupply(baseSupplyIndex, BASE_TRANSFER_AMOUNT), 1);
          await snapshot.restore();
        });
      });
    });
    describe('transferAssetFrom (collateral)', function () {
      const PARTIAL_COLLATERAL_AMOUNT = exp(0.5, 18);
      before(async function () {
        // Withdraw all base balance from holder
        await comet.connect(holder).withdraw(await baseToken.getAddress(), MaxUint256);
        // Holder already has base supplied from transferFrom (base asset) describe
        await collaterals['COMP'].allocateTo(holder.address, COLLATERAL_TRANSFER_AMOUNT);
        await collaterals['COMP'].connect(holder).approve(await comet.getAddress(), COLLATERAL_TRANSFER_AMOUNT);
        await comet.connect(holder).supply(await collaterals['COMP'].getAddress(), COLLATERAL_TRANSFER_AMOUNT);
        await comet.connect(holder).approve(operator.address, MaxUint256);
      });
      describe('revert on', function () {
        it('pause', async () => {
          await comet.connect(pauseGuardian).pause(false, true, false, false, false);
          await expect(comet.connect(operator).transferAssetFrom(holder.address, receiver.address, await collaterals['COMP'].getAddress(), PARTIAL_COLLATERAL_AMOUNT)).to.be.revertedWithCustomError(comet, 'Paused');
          await comet.connect(pauseGuardian).pause(false, false, false, false, false);
        });
        it('operator has no permission from holder', async () => {
          await comet.connect(holder).approve(operator.address, 0);
          await expect(comet.connect(operator).transferAssetFrom(holder.address, receiver.address, await collaterals['COMP'].getAddress(), PARTIAL_COLLATERAL_AMOUNT)).to.be.revertedWithCustomError(comet, 'Unauthorized');
          await comet.connect(holder).approve(operator.address, MaxUint256);
        });
        it('src == dst', async () => {
          await expect(comet.connect(operator).transferAssetFrom(holder.address, holder.address, await collaterals['COMP'].getAddress(), PARTIAL_COLLATERAL_AMOUNT)).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
        });
        it('unsupported asset & amount = 0', async () => {
          await expect(comet.connect(operator).transferAssetFrom(holder.address, receiver.address, await unsupportedToken.getAddress(), 0n)).to.be.revertedWithCustomError(comet, 'BadAsset');
        });
        it('unsupported asset & amount > 0', async () => {
          await expect(comet.connect(operator).transferAssetFrom(holder.address, receiver.address, await unsupportedToken.getAddress(), COLLATERAL_TRANSFER_AMOUNT)).to.be.revertedWithPanic('0x11');
        });
        it('amount > balance', async () => {
          const balance = await comet.collateralBalanceOf(holder.address, await collaterals['COMP'].getAddress());
          await expect(comet.connect(operator).transferAssetFrom(holder.address, receiver.address, await collaterals['COMP'].getAddress(), (balance + 1n))).to.be.revertedWithPanic('0x11');
        });
        it('not collateralized', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          const BORROW_AMOUNT = exp(50, baseTokenDecimals);
          await baseToken.allocateTo(await comet.getAddress(), BORROW_AMOUNT);
          await comet.connect(holder).withdraw(await baseToken.getAddress(), BORROW_AMOUNT);
          await expect(comet.connect(operator).transferAssetFrom(holder.address, receiver.address, await collaterals['COMP'].getAddress(), COLLATERAL_TRANSFER_AMOUNT)).to.be.revertedWithCustomError(comet, 'NotCollateralized');
          await snapshot.restore();
        });
      });
      describe('happy cases', function () {
        it('should transfer collateral from holder to receiver', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          const holderCollateralBeforeTx = (await comet.collateralBalanceOf(holder.address, await collaterals['COMP'].getAddress()));
          const receiverCollateralBeforeTx = (await comet.collateralBalanceOf(receiver.address, await collaterals['COMP'].getAddress()));
          const totalsCollateralBefore = (await comet.totalsCollateral(await collaterals['COMP'].getAddress())).totalSupplyAsset;
          const tx = await comet.connect(operator).transferAssetFrom(holder.address, receiver.address, await collaterals['COMP'].getAddress(), PARTIAL_COLLATERAL_AMOUNT);
          // holder's collateral balance decreases
          expect(await comet.collateralBalanceOf(holder.address, await collaterals['COMP'].getAddress())).to.equal((holderCollateralBeforeTx - BigInt(PARTIAL_COLLATERAL_AMOUNT)));
          // receiver's collateral balance grows
          expect(await comet.collateralBalanceOf(receiver.address, await collaterals['COMP'].getAddress())).to.equal((receiverCollateralBeforeTx + BigInt(PARTIAL_COLLATERAL_AMOUNT)));
          // total collateral amount is unchanged (internal transfer)
          expect((await comet.totalsCollateral(await collaterals['COMP'].getAddress())).totalSupplyAsset).to.equal(totalsCollateralBefore);
          await expect(tx)
            .to.emit(comet, 'TransferCollateral')
            .withArgs(holder.address, receiver.address, await collaterals['COMP'].getAddress(), PARTIAL_COLLATERAL_AMOUNT);
          await snapshot.restore();
        });
        it('should transfer collateral when receiver == operator', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          const holderCollateralBeforeTx = (await comet.collateralBalanceOf(holder.address, await collaterals['COMP'].getAddress()));
          const operatorCollateralBeforeTx = (await comet.collateralBalanceOf(operator.address, await collaterals['COMP'].getAddress()));
          await comet.connect(operator).transferAssetFrom(holder.address, operator.address, await collaterals['COMP'].getAddress(), PARTIAL_COLLATERAL_AMOUNT);
          // holder's collateral balance decreases
          expect(await comet.collateralBalanceOf(holder.address, await collaterals['COMP'].getAddress())).to.equal((holderCollateralBeforeTx - BigInt(PARTIAL_COLLATERAL_AMOUNT)));
          // operator (as receiver) collateral balance grows
          expect(await comet.collateralBalanceOf(operator.address, await collaterals['COMP'].getAddress())).to.equal((operatorCollateralBeforeTx + BigInt(PARTIAL_COLLATERAL_AMOUNT)));
          await snapshot.restore();
        });
        it('should transfer collateral when operator == holder', async () => {
          const snapshot: SnapshotRestorer = await takeSnapshot();
          const holderCollateralBeforeTx = (await comet.collateralBalanceOf(holder.address, await collaterals['COMP'].getAddress()));
          const receiverCollateralBeforeTx = (await comet.collateralBalanceOf(receiver.address, await collaterals['COMP'].getAddress()));
          await comet.connect(holder).transferAssetFrom(holder.address, receiver.address, await collaterals['COMP'].getAddress(), PARTIAL_COLLATERAL_AMOUNT);
          // holder's collateral balance decreases
          expect(await comet.collateralBalanceOf(holder.address, await collaterals['COMP'].getAddress())).to.equal((holderCollateralBeforeTx - BigInt(PARTIAL_COLLATERAL_AMOUNT)));
          // receiver's collateral balance grows (same as transferAsset())
          expect(await comet.collateralBalanceOf(receiver.address, await collaterals['COMP'].getAddress())).to.equal((receiverCollateralBeforeTx + BigInt(PARTIAL_COLLATERAL_AMOUNT)));
          await snapshot.restore();
        });
      });
    });
  });
  describe('absorb with 24 collaterals', function () {
    const MAX_ASSETS = 24;
    const TRANSFER_AMOUNT: bigint = exp(1, 18);
    let comet: CometHarnessInterfaceExtendedAssetList;
    let collaterals: {
            [symbol: string]: FaucetToken;
        } = {};
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    before(async () => {
      // Setup protocol with MAX_ASSETS collaterals
      const cometCollaterals = Object.fromEntries(Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {
        decimals: 18,
        initialPrice: 1,
      }]));
      const protocol = await makeProtocol({
        base: 'USDC',
        assets: {
          USDC: { decimals: baseTokenDecimals, initialPrice: 1 },
          ...cometCollaterals
        },
      });
      comet = protocol.cometWithExtendedAssetList;
      for (let asset in protocol.tokens) {
        if (asset === 'USDC')
          continue;
        collaterals[asset] = protocol.tokens[asset] as FaucetToken;
      }
      [alice, bob] = protocol.users;
    });
    it('alice supply each of collaterals', async () => {
      for (const asset in collaterals) {
        await collaterals[asset].allocateTo(alice.address, TRANSFER_AMOUNT);
        await collaterals[asset].connect(alice).approve(await comet.getAddress(), TRANSFER_AMOUNT);
        await comet.connect(alice).supply(await collaterals[asset].getAddress(), TRANSFER_AMOUNT);
      }
    });
    it('each collateral balance is equal to supply amount', async () => {
      for (const asset in collaterals) {
        expect(await comet.collateralBalanceOf(alice.address, await collaterals[asset].getAddress())).to.be.equal(TRANSFER_AMOUNT);
      }
    });
    it('each collateral bob balance is equal to 0', async () => {
      for (const asset in collaterals) {
        expect(await comet.collateralBalanceOf(bob.address, await collaterals[asset].getAddress())).to.equal(0);
      }
    });
    it('transfer is successful for each collateral', async () => {
      const snapshot: SnapshotRestorer = await takeSnapshot();
      for (const asset in collaterals) {
        await comet.connect(alice).transferAsset(bob.address, await collaterals[asset].getAddress(), TRANSFER_AMOUNT);
      }
      await snapshot.restore();
    });
    it('for each collateral emits TransferCollateral event', async () => {
      for (const asset in collaterals) {
        await expect(comet.connect(alice).transferAsset(bob.address, await collaterals[asset].getAddress(), TRANSFER_AMOUNT))
          .to.emit(comet, 'TransferCollateral')
          .withArgs(alice.address, bob.address, await collaterals[asset].getAddress(), TRANSFER_AMOUNT);
      }
    });
    it('each collateral alice balance is equal to 0', async () => {
      for (const asset in collaterals) {
        expect(await comet.collateralBalanceOf(alice.address, await collaterals[asset].getAddress())).to.equal(0);
      }
    });
    it('each collateral bob balance is equal to transfer amount', async () => {
      for (const asset in collaterals) {
        expect(await comet.collateralBalanceOf(bob.address, await collaterals[asset].getAddress())).to.equal(TRANSFER_AMOUNT);
      }
    });
  });
  describe('non-standard tokens', function () {
    describe('USDT-like token', function () {
      let comet: CometHarnessInterfaceExtendedAssetList;
      let alice: SignerWithAddress;
      let bob: SignerWithAddress;
      let usdt: NonStandardFaucetFeeToken;
      let nonStdCollateral: NonStandardFaucetFeeToken;
      const USDT_AMOUNT = exp(1, 6);
      const NON_STD_COLLATERAL_AMOUNT = exp(1, 18);
      before(async function () {
        const assets = defaultAssets();
        assets['USDT'] = {
          initial: 1e6,
          decimals: 6,
          factory: new NonStandardFaucetFeeToken__factory((await ethers.getSigners())[0]),
        };
        assets['NonStdCollateral'] = {
          initial: 1e8,
          decimals: 18,
          factory: new NonStandardFaucetFeeToken__factory((await ethers.getSigners())[0]),
        };
        const protocol = await makeProtocol({ base: 'USDT', assets: assets });
        comet = protocol.cometWithExtendedAssetList;
        const tokens = protocol.tokens;
        [alice, bob] = protocol.users;
        usdt = tokens['USDT'] as NonStandardFaucetFeeToken;
        nonStdCollateral = tokens['NonStdCollateral'] as NonStandardFaucetFeeToken;
      });
      it('can transfer base token - non-standard ERC20 (without return interface) e.g. USDT', async () => {
        await usdt.allocateTo(alice.address, USDT_AMOUNT);
        await usdt.connect(alice).approve(await comet.getAddress(), USDT_AMOUNT);
        await comet.connect(alice).supply(await usdt.getAddress(), USDT_AMOUNT);
        // as per the initial test case, 1st deposit will end with the same principal
        expect((await comet.userBasic(alice.address)).principal).to.equal(USDT_AMOUNT);
        await expect(comet.connect(alice).transfer(bob.address, USDT_AMOUNT)).to.not.revert(ethers);
        // bob's principal should be equal to the transferred amount
        expect((await comet.userBasic(bob.address)).principal).to.equal(USDT_AMOUNT);
      });
      it('can transfer collateral - non-standard ERC20 (without return interface) e.g. USDT', async () => {
        await nonStdCollateral.allocateTo(alice.address, NON_STD_COLLATERAL_AMOUNT);
        await nonStdCollateral.connect(alice).approve(await comet.getAddress(), NON_STD_COLLATERAL_AMOUNT);
        await comet.connect(alice).supply(await nonStdCollateral.getAddress(), NON_STD_COLLATERAL_AMOUNT);
        expect((await comet.userCollateral(alice.address, await nonStdCollateral.getAddress())).balance).to.equal(NON_STD_COLLATERAL_AMOUNT);
        await expect(comet.connect(alice).transferAsset(bob.address, await nonStdCollateral.getAddress(), NON_STD_COLLATERAL_AMOUNT)).to.not.revert(ethers);
        // bob's collateral balance should be equal to the transferred amount
        expect((await comet.userCollateral(bob.address, await nonStdCollateral.getAddress())).balance).to.equal(NON_STD_COLLATERAL_AMOUNT);
      });
    });
    describe('fee-on-transfer token has no impact on transfer', function () {
      const BASE_TOKEN_AMOUNT = exp(1, 6);
      const COLLATERAL_TOKEN_AMOUNT = exp(0.5, 18);
      const NUMERATOR = 10;
      const DENOMINATOR = 10000;
      let feeComet: CometHarnessInterfaceExtendedAssetList;
      let feeBaseToken: NonStandardFaucetFeeToken;
      let feeCollateral: NonStandardFaucetFeeToken;
      let alice: SignerWithAddress;
      let bob: SignerWithAddress;
      let transferFeeTx: ContractTransactionResponse;
      let baseAmountWithoutFee: bigint;
      let collateralAmountWithoutFee: bigint;
      before(async function () {
        const assets = defaultAssets();
        assets['USDT'] = {
          initial: 1e6,
          decimals: 6,
          factory: new NonStandardFaucetFeeToken__factory((await ethers.getSigners())[0]),
        };
        assets['FeeCollateral'] = {
          initial: 1e8,
          decimals: 18,
          factory: new NonStandardFaucetFeeToken__factory((await ethers.getSigners())[0]),
        };
        const protocol = await makeProtocol({ base: 'USDT', assets: assets });
        feeComet = protocol.cometWithExtendedAssetList;
        feeBaseToken = protocol.tokens['USDT'] as NonStandardFaucetFeeToken;
        feeCollateral = protocol.tokens['FeeCollateral'] as NonStandardFaucetFeeToken;
        [alice, bob] = protocol.users;
        // Allocate tokens to Alice
        await feeCollateral.allocateTo(alice.address, COLLATERAL_TOKEN_AMOUNT);
        await feeBaseToken.allocateTo(alice.address, BASE_TOKEN_AMOUNT);
        // Set fee to 0.1%
        await feeBaseToken.setParams(10, exp(100, 18));
        await feeCollateral.setParams(10, exp(100, 18));
        // Base token preparation
        // We supply the amount with fee to check that it's work even on supply phase
        const baseAmountDeposited = BigInt(BASE_TOKEN_AMOUNT);
        const baseFee = ((baseAmountDeposited * BigInt(NUMERATOR)) / BigInt(DENOMINATOR));
        baseAmountWithoutFee = (baseAmountDeposited - BigInt(baseFee));
        await feeBaseToken.connect(alice).approve(await feeComet.getAddress(), BASE_TOKEN_AMOUNT);
        await feeComet.connect(alice).supply(await feeBaseToken.getAddress(), BASE_TOKEN_AMOUNT);
        // Collateral token preparation
        // We supply the amount with fee to check that it's work even on supply phase
        const collateralAmountDeposited = BigInt(COLLATERAL_TOKEN_AMOUNT);
        const collateralFee = ((collateralAmountDeposited * BigInt(NUMERATOR)) / BigInt(DENOMINATOR));
        collateralAmountWithoutFee = (collateralAmountDeposited - BigInt(collateralFee));
        await feeCollateral.connect(alice).approve(await feeComet.getAddress(), COLLATERAL_TOKEN_AMOUNT);
        await feeComet.connect(alice).supply(await feeCollateral.getAddress(), COLLATERAL_TOKEN_AMOUNT);
        // we are checking that the (amount - fee) is considered as deposit
        expect((await feeComet.userBasic(alice.address)).principal).to.equal(baseAmountWithoutFee);
        expect((await feeComet.userCollateral(alice.address, await feeCollateral.getAddress())).balance).to.equal(collateralAmountWithoutFee);
      });
      it('no fee is charged for transfer base token - fee-on-transfer token', async () => {
        const feeBalanceBefore = await feeBaseToken.balanceOf(await feeBaseToken.getAddress());
        transferFeeTx = await feeComet.connect(alice).transfer(bob.address, baseAmountWithoutFee);
        await expect(transferFeeTx).to.not.revert(ethers);
        // bob's principal should be equal to the transferred amount (no fee is charged)
        expect((await feeComet.userBasic(bob.address)).principal).to.equal(baseAmountWithoutFee);
        const feeBalanceAfter = await feeBaseToken.balanceOf(await feeBaseToken.getAddress());
        // no fee is charged
        expect((feeBalanceAfter - BigInt(feeBalanceBefore))).to.equal(0);
      });
      it('correct amount in the Transfer event (withdraw) - fee-on-transfer token', async () => {
        // event should contain amount without fee
        await expect(transferFeeTx).to.emit(feeComet, 'Transfer').withArgs(alice.address, ZERO_ADDRESS, baseAmountWithoutFee);
      });
      it('correct amount in the Transfer event (supply) - fee-on-transfer token', async () => {
        // event should contain amount without fee
        await expect(transferFeeTx).to.emit(feeComet, 'Transfer').withArgs(ZERO_ADDRESS, bob.address, baseAmountWithoutFee);
      });
      it('no fee is charged for transfer collateral token - fee-on-transfer token', async () => {
        const feeBalanceBefore = await feeCollateral.balanceOf(await feeCollateral.getAddress());
        transferFeeTx = await feeComet.connect(alice).transferAsset(bob.address, await feeCollateral.getAddress(), collateralAmountWithoutFee);
        await expect(transferFeeTx).to.not.revert(ethers);
        const feeBalanceAfter = await feeCollateral.balanceOf(await feeCollateral.getAddress());
        // no fee is charged
        expect((feeBalanceAfter - BigInt(feeBalanceBefore))).to.equal(0);
        // bob's collateral balance should be equal to the transferred amount
        expect((await feeComet.userCollateral(bob.address, await feeCollateral.getAddress())).balance).to.equal(collateralAmountWithoutFee);
      });
      it('correct amount in the TransferCollateral event - fee-on-transfer token', async () => {
        // event should contain amount without fee - the actual received on the contract
        await expect(transferFeeTx).to.emit(feeComet, 'TransferCollateral').withArgs(alice.address, bob.address, await feeCollateral.getAddress(), collateralAmountWithoutFee);
      });
    });
  });
});

describe('transfer exact-accounting regressions', function () {
  it('transfers base from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    const _i0 = await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, usdcAddress, 100e6));
    const t1 = await comet.totalsBasic();
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: ZeroAddress,
        amount: BigInt(100e6),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Transfer: {
        from: ZeroAddress,
        to: alice.address,
        amount: BigInt(100e6),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(90000);
  });

  it('does not emit Transfer if 0 mint/burn', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { USDC, WETH } = tokens;
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await comet.setCollateralBalance(bob.address, wethAddress, exp(1, 18));
    await comet.setBasePrincipal(alice.address, -100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
      totalBorrowBase: 100e6,
    });

    const cometAsB = comet.connect(bob);

    const s0 = await wait(cometAsB.transferAsset(alice.address, usdcAddress, 100e6));

    expect(s0.receipt.logs.length).to.be.equal(0);
  });

  it('transfers max base balance (including accrued) from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const cometAddress = await comet.getAddress();
    const usdcAddress = await USDC.getAddress();

    await USDC.allocateTo(cometAddress, 100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
      totalBorrowBase: 50e6, // non-zero borrow to accrue interest
    });
    await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    // Fast forward to accrue some interest
    await fastForward(86400);
    await ethers.provider.send('evm_mine', []);

    const t0 = await comet.totalsBasic();
    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    const bobAccruedBalance = await comet.balanceOf.staticCall(bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, usdcAddress, MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    // additional 1 wei burned, amount to clear bob gets alice to same balance - 1
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: ZeroAddress,
        amount: bobAccruedBalance,
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Transfer: {
        from: ZeroAddress,
        to: alice.address,
        amount: bobAccruedBalance - 1n,
      }
    });

    // Hitting the rounding down behavior in this specific case (which is favorable to the protocol)
    expect(a0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: bobAccruedBalance, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: bobAccruedBalance - 1n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase - 1n);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(105000);
  });

  it('transfer max base should transfer 0 if user has a borrow position', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC, WETH } = tokens;
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await comet.setBasePrincipal(bob.address, -100e6);
    await comet.setCollateralBalance(bob.address, wethAddress, exp(1, 18));
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, usdcAddress, MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    expect(s0.receipt.logs.length).to.be.equal(0);
    expect(a0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: exp(-100, 6), COMP: 0n, WETH: exp(1, 18), WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: exp(-100, 6), COMP: 0n, WETH: exp(1, 18), WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase);
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(105000);
  });

  it('transfers collateral from sender if the asset is collateral', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const _i0 = await comet.setCollateralBalance(bob.address, compAddress, 8e8);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsCollateral(compAddress);
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, compAddress, 8e8));
    const t1 = await comet.totalsCollateral(compAddress);
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      TransferCollateral: {
        from: bob.address,
        to: alice.address,
        asset: compAddress,
        amount: BigInt(8e8),
      }
    });

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: exp(8, 8), WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyAsset).to.be.equal(t0.totalSupplyAsset);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(95000);
  });

  it('calculates base principal correctly', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await comet.setBasePrincipal(bob.address, 50e6); // 100e6 in present value
    const cometAsB = comet.connect(bob);

    const totals0 = await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
    });

    const alice0 = await portfolio(protocol, alice.address);
    const bob0 = await portfolio(protocol, bob.address);

    await wait(cometAsB.transferAsset(alice.address, usdcAddress, 100e6));
    const totals1 = await comet.totalsBasic();
    const alice1 = await portfolio(protocol, alice.address);
    const bob1 = await portfolio(protocol, bob.address);

    expect(alice0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob0.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(alice1.internal).to.be.deep.equal({ USDC: exp(100, 6), COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(bob1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(totals1.totalSupplyBase).to.be.equal(totals0.totalSupplyBase);
    expect(totals1.totalBorrowBase).to.be.equal(totals0.totalBorrowBase);
  });

  it('reverts if the asset is neither collateral nor base', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      users: [alice, bob],
      unsupportedToken: USUP,
    } = protocol;

    const cometAsB = comet.connect(bob);
    const unsupportedTokenAddress = await USUP.getAddress();

    await expect(cometAsB.transferAsset(alice.address, unsupportedTokenAddress, 1)).to.revert(ethers);
  });

  it('reverts if transfer is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob] } = protocol;
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    const cometAsB = comet.connect(bob);

    // Pause transfer
    await wait(comet.connect(pauseGuardian).pause(false, true, false, false, false));
    expect(await comet.isTransferPaused()).to.be.true;

    await expect(cometAsB.transferAsset(alice.address, usdcAddress, 1))
      .to.be.revertedWithCustomError(comet, 'Paused');
  });

  it('reverts if transfer max for a collateral asset', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await COMP.allocateTo(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.transferAsset(alice.address, compAddress, MaxUint256))
      .to.be.revertedWithCustomError(comet, 'InvalidUInt128');
  });

  it('borrows base if collateralized', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { WETH, USDC } = tokens;
    const usdcAddress = await USDC.getAddress();
    const wethAddress = await WETH.getAddress();

    await comet.setCollateralBalance(alice.address, wethAddress, exp(1, 18));

    let t0 = await comet.totalsBasic();
    await setTotalsBasic(comet, {
      baseBorrowIndex: t0.baseBorrowIndex * 2n,
    });

    await comet.connect(alice).transferAsset(bob.address, usdcAddress, 100e6);

    expect(await baseBalanceOf(comet, alice.address)).to.eq(BigInt(-100e6));
  });

  it('cant borrow less than the minimum', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    const cometAsB = comet.connect(bob);

    const amount = (await comet.baseBorrowMin()) - 1n;
    await expect(cometAsB.transferAsset(alice.address, usdcAddress, amount))
      .to.be.revertedWithCustomError(comet, 'BorrowTooSmall');
  });

  it('reverts on self-transfer of base token', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice],
    } = await makeProtocol({ base: 'USDC' });
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await expect(
      comet.connect(alice).transferAsset(alice.address, usdcAddress, 100)
    ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
  });

  it('reverts on self-transfer of collateral', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice],
    } = await makeProtocol();
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await expect(
      comet.connect(alice).transferAsset(alice.address, compAddress, 100)
    ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
  });

  it('reverts if transferring base results in an under collateralized borrow', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await expect(
      comet.connect(alice).transferAsset(bob.address, usdcAddress, 100e6)
    ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
  });

  it('reverts if transferring collateral results in an under collateralized borrow', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { WETH } = tokens;
    const wethAddress = await WETH.getAddress();

    // user has a borrow, but with collateral to cover
    await comet.setBasePrincipal(alice.address, -100e6);
    await comet.setCollateralBalance(alice.address, wethAddress, exp(1, 18));

    // reverts if transfer would leave the borrow uncollateralized
    await expect(
      comet.connect(alice).transferAsset(bob.address, wethAddress, exp(1, 18))
    ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
  });
});

describe('transferFrom', function () {
  it('transfers from src if specified and sender has permission', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob, charlie],
    } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const _i0 = await comet.setCollateralBalance(bob.address, compAddress, 7);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    const _a1 = await wait(cometAsB.allow(charlie.address, true));
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _s0 = await wait(cometAsC.transferAssetFrom(bob.address, alice.address, compAddress, 7));
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(p0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(q0.internal).to.be.deep.equal({ USDC: 0n, COMP: 7n, WETH: 0n, WBTC: 0n });
    expect(p1.internal).to.be.deep.equal({ USDC: 0n, COMP: 7n, WETH: 0n, WBTC: 0n });
    expect(q1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
  });

  it('reverts if src is specified and sender does not have permission', async () => {
    const protocol = await makeProtocol();
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob, charlie],
    } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    const _i0 = await comet.setCollateralBalance(bob.address, compAddress, 7);
    const cometAsC = comet.connect(charlie);

    await expect(
      cometAsC.transferAssetFrom(bob.address, alice.address, compAddress, 7)
    ).to.be.revertedWithCustomError(comet, 'Unauthorized');
  });

  it('reverts on transfer of base token from address to itself', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = await makeProtocol({ base: 'USDC' });
    const { USDC } = tokens;
    const usdcAddress = await USDC.getAddress();

    await comet.connect(bob).allow(alice.address, true);

    await expect(
      comet.connect(alice).transferAssetFrom(bob.address, bob.address, usdcAddress, 100)
    ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
  });

  it('reverts on transfer of collateral from address to itself', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = await makeProtocol();
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await comet.connect(bob).allow(alice.address, true);

    await expect(
      comet.connect(alice).transferAssetFrom(bob.address, bob.address, compAddress, 100)
    ).to.be.revertedWithCustomError(comet, 'NoSelfTransfer');
  });

  it('reverts if transfer is paused', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;
    const compAddress = await COMP.getAddress();

    await comet.setCollateralBalance(bob.address, compAddress, 7);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    // Pause transfer
    await wait(comet.connect(pauseGuardian).pause(false, true, false, false, false));
    expect(await comet.isTransferPaused()).to.be.true;

    await wait(cometAsB.allow(charlie.address, true));
    await expect(cometAsC.transferAssetFrom(bob.address, alice.address, compAddress, 7))
      .to.be.revertedWithCustomError(comet, 'Paused');
  });
});
