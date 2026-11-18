import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { ethers, expect, exp, makeProtocol, allocateAndSupply, bumpBorrow, setTotalsBasic, fastForward, ONE } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { SnapshotRestorer, takeSnapshot } from './helpers/snapshot';

/*//////////////////////////////////////////////////////////////
                    MAX SUPPORTED UTILIZATION
//////////////////////////////////////////////////////////////*/

/**
 * @notice Base transfer and base withdraw behavior around the maxSupportedUtilization limit.
 * @dev
 *  A base transfer or a base withdraw reverts with `ExceedsSupportedUtilization`
 *  when the resulting utilization (total borrow / total supply) exceeds the market limit.
 *  A transfer changes total supply and total borrow by the same amount, so while total borrow exceeds total supply
 *  a borrow transfer lowers utilization and a repay raises it. A transfer between lenders does not change
 *  utilization and reverts only when it is already above the limit.
 *  Operations other than base transfer and base withdraw are not limited, even above the limit.
 *  Interest accrual can take utilization above the limit. With zero interest rates such states
 *  cannot be reached through regular operations, so they are set through the harness.
 */
describe('max supported utilization', function () {
  const MARKET_RESERVES = exp(10_000, 6); // Borrows above total supply are paid out of reserves
  const BORROWER_COLLATERAL = exp(100, 18); // Enough for any borrow in these tests
  // The smallest step past the limit: a withdraw takes one more wei, a transfer runs with one more wei of debt in the market.
  // Also the smallest withdraw when utilization is already above the limit
  const ONE_WEI = 1n;
  // Options shared by every market in this file. Zero interest rates (the base supply rate is zero by default),
  // so indexes do not move, principal equals present value and amounts are exact
  const MARKET_PROTOCOL_OPTS = {
    supplyInterestRateSlopeLow: 0,
    supplyInterestRateSlopeHigh: 0,
    borrowInterestRateBase: 0,
    borrowInterestRateSlopeLow: 0,
    borrowInterestRateSlopeHigh: 0,
    // Above the market reserves, so absorbed collateral is for sale
    targetReserves: exp(1_000_000, 6),
  };
  // Market above the default limit, a state regular operations cannot reach: alice and carol are lenders,
  // bob borrows up to the limit and the harness adds debt on top
  const ABOVE_LIMIT_MARKET = {
    aliceSupply: exp(600, 6),
    carolSupply: exp(400, 6),
    bobCollateral: exp(100, 18),
    bobDebt: exp(2000, 6),
    bobHarnessDebt: exp(100, 6),
  };

  // Market with the default limit, shared by the cases outside the *_LIMITS tables.
  // Every case that changes it takes a snapshot in before() and restores it in after()
  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collateral: FaucetToken;
  let collateralPriceFeed: SimplePriceFeed;

  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let dave: SignerWithAddress;
  let eve: SignerWithAddress;
  let frank: SignerWithAddress;
  let governor: SignerWithAddress;

  async function setUpUtilizationAboveLimit() {
    await allocateAndSupply(comet, baseToken, alice, ABOVE_LIMIT_MARKET.aliceSupply);
    await allocateAndSupply(comet, baseToken, carol, ABOVE_LIMIT_MARKET.carolSupply);
    await allocateAndSupply(comet, collateral, bob, ABOVE_LIMIT_MARKET.bobCollateral);
    await comet.connect(bob).withdraw(baseToken.address, ABOVE_LIMIT_MARKET.bobDebt);
    await bumpBorrow(comet, bob.address, ABOVE_LIMIT_MARKET.bobHarnessDebt);
  }

  before(async () => {
    const protocol = await makeProtocol(MARKET_PROTOCOL_OPTS);
    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens.USDC as FaucetToken;
    collateral = protocol.tokens.COMP as FaucetToken;
    collateralPriceFeed = protocol.priceFeeds.COMP;
    await baseToken.allocateTo(comet.address, MARKET_RESERVES);
    [alice, bob, carol, dave, eve, frank] = protocol.users;
    governor = protocol.governor;
  });

  describe('base transfer', function () {
    describe('borrower transfer', function () {
      // alice and frank are lenders, carol and dave are borrowers. A borrow transfer raises utilization while total borrow
      // is below total supply and lowers it while total borrow exceeds total supply, so a limit below full utilization is
      // reached from below and a limit above it from above, with the extra debt set through the harness.
      // At full utilization a borrow transfer keeps utilization unchanged for any amount, so for every limit
      // the same transfer exceeds it once the market holds one more wei of debt. The extra wei is added to the debt of carol,
      // since the amounts sent to dave and eve do not depend on it
      const BORROW_TRANSFER_LIMITS = [
        { maxSupportedUtilization: exp(0.8, 18), totalBorrow: exp(500, 6), harnessBorrow: 0n, transferAmount: exp(1500, 6) },
        { maxSupportedUtilization: exp(1, 18), totalBorrow: exp(1000, 6), harnessBorrow: 0n, transferAmount: exp(500, 6) },
        { maxSupportedUtilization: exp(2, 18), totalBorrow: exp(2100, 6), harnessBorrow: exp(100, 6), transferAmount: exp(100, 6) },
      ];
      const ALICE_SUPPLY = exp(900, 6);
      // bob transfers as a new borrower with collateral only, carol as an existing borrower whose debt is part of the total borrow,
      // frank as a lender whose deposit is part of the total supply. frank sends the deposit on top of the borrowed amount,
      // so the totals change by the borrowed amount only, as for bob and carol
      const CAROL_DEBT = exp(300, 6);
      const FRANK_SUPPLY = exp(100, 6);
      const BORROW_TRANSFER_SENDERS = [
        { name: 'new borrower', sender: () => bob, deposit: 0n },
        { name: 'existing borrower', sender: () => carol, deposit: 0n },
        { name: 'lender becomes borrower', sender: () => frank, deposit: FRANK_SUPPLY },
      ];

      for (const { maxSupportedUtilization, totalBorrow, harnessBorrow, transferAmount } of BORROW_TRANSFER_LIMITS) {
        describe(`${maxSupportedUtilization / exp(1, 16)}% limit`, function () {
          // dave holds the rest of the total borrow, so a transfer to dave of the dave debt plus an amount repays the whole
          // dave debt and changes the totals by the same amount as a transfer of that amount to eve, who has no debt.
          // Exact with zero rates
          const daveDebt = totalBorrow - CAROL_DEBT;

          let limitComet: CometHarnessInterfaceExtendedAssetList;

          before(async () => {
            const protocol = await makeProtocol({ ...MARKET_PROTOCOL_OPTS, maxSupportedUtilization });
            limitComet = protocol.cometWithExtendedAssetList;
            const limitBaseToken = protocol.tokens.USDC as FaucetToken;
            const limitCollateral = protocol.tokens.COMP as FaucetToken;
            await limitBaseToken.allocateTo(limitComet.address, MARKET_RESERVES);
            await allocateAndSupply(limitComet, limitBaseToken, alice, ALICE_SUPPLY);
            await allocateAndSupply(limitComet, limitBaseToken, frank, FRANK_SUPPLY);
            await allocateAndSupply(limitComet, limitCollateral, frank, BORROWER_COLLATERAL);
            await allocateAndSupply(limitComet, limitCollateral, bob, BORROWER_COLLATERAL);
            await allocateAndSupply(limitComet, limitCollateral, carol, BORROWER_COLLATERAL);
            await limitComet.connect(carol).withdraw(limitBaseToken.address, CAROL_DEBT);
            await allocateAndSupply(limitComet, limitCollateral, dave, BORROWER_COLLATERAL);
            await limitComet.connect(dave).withdraw(limitBaseToken.address, totalBorrow - harnessBorrow - CAROL_DEBT);
            if (harnessBorrow > 0n) await bumpBorrow(limitComet, dave.address, harnessBorrow);
          });

          it('sanity check: total supply and total borrow match the setup', async () => {
            expect(await limitComet.totalSupply()).to.equal(ALICE_SUPPLY + FRANK_SUPPLY);
            expect(await limitComet.totalBorrow()).to.equal(totalBorrow);
          });

          describe('borrow transfer reaches the limit exactly', function () {
            let snapshot: SnapshotRestorer;

            before(async () => {
              snapshot = await takeSnapshot();
            });

            afterEach(async () => {
              await snapshot.restore();
            });

            for (const { name, sender, deposit } of BORROW_TRANSFER_SENDERS) {
              it(`${name} transfer to an account without debt brings utilization to the limit`, async () => {
                await limitComet.connect(sender()).transfer(eve.address, deposit + transferAmount);

                expect(await limitComet.getUtilization()).to.equal(maxSupportedUtilization);
              });

              it(`${name} transfer to an account with debt brings utilization to the limit`, async () => {
                await limitComet.connect(sender()).transfer(dave.address, deposit + daveDebt + transferAmount);

                expect(await limitComet.getUtilization()).to.equal(maxSupportedUtilization);
              });
            }
          });

          describe('borrow transfer exceeds the limit with 1 wei more debt', function () {
            let snapshot: SnapshotRestorer;

            before(async () => {
              snapshot = await takeSnapshot();

              await bumpBorrow(limitComet, carol.address, ONE_WEI);
            });

            after(async () => {
              await snapshot.restore();
            });

            for (const { name, sender, deposit } of BORROW_TRANSFER_SENDERS) {
              it(`${name} transfer to an account without debt reverts with ExceedsSupportedUtilization`, async () => {
                await expect(limitComet.connect(sender()).transfer(eve.address, deposit + transferAmount))
                  .to.be.revertedWithCustomError(limitComet, 'ExceedsSupportedUtilization');
              });

              it(`${name} transfer to an account with debt reverts with ExceedsSupportedUtilization`, async () => {
                await expect(limitComet.connect(sender()).transfer(dave.address, deposit + daveDebt + transferAmount))
                  .to.be.revertedWithCustomError(limitComet, 'ExceedsSupportedUtilization');
              });
            }
          });
        });
      }

      describe('borrow transfer with zero total supply', function () {
        const TRANSFER_AMOUNT = exp(100, 6);

        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await allocateAndSupply(comet, collateral, bob, BORROWER_COLLATERAL);
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: total supply is 0', async () => {
          expect(await comet.totalSupply()).to.equal(0);
        });

        it('sanity check: total borrow is 0', async () => {
          expect(await comet.totalBorrow()).to.equal(0);
        });

        it('borrow transfer sets utilization to 100%', async () => {
          await comet.connect(bob).transfer(eve.address, TRANSFER_AMOUNT);

          expect(await comet.getUtilization()).to.equal(ONE);
        });
      });

      describe('borrow transfer with zero total supply and outstanding debt', function () {
        // The transfer repays only part of the dave debt, so total supply stays zero while debt remains
        const DAVE_HARNESS_DEBT = exp(500, 6);
        const TRANSFER_AMOUNT = exp(100, 6);

        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await bumpBorrow(comet, dave.address, DAVE_HARNESS_DEBT);
          await allocateAndSupply(comet, collateral, bob, BORROWER_COLLATERAL);
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: total supply is 0', async () => {
          expect(await comet.totalSupply()).to.equal(0);
        });

        it('sanity check: total borrow is positive', async () => {
          expect(await comet.totalBorrow()).to.be.above(0);
        });

        it('borrow transfer reverts with ExceedsSupportedUtilization', async () => {
          await expect(comet.connect(bob).transfer(dave.address, TRANSFER_AMOUNT))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });
      });
    });

    describe('lender transfer', function () {
      // A transfer to a lender does not change the totals, a transfer to a borrower repays the debt
      // and lowers total supply and total borrow by the repaid amount
      const LENDER_TRANSFER_AMOUNT = exp(100, 6);

      describe('utilization within the limit', function () {
        // alice and carol are lenders, bob borrows within the default limit.
        // A repay within the limit is covered by 'repay of another account debt'
        const ALICE_SUPPLY = exp(600, 6);
        const CAROL_SUPPLY = exp(400, 6);
        const BOB_DEBT = exp(1500, 6);

        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await allocateAndSupply(comet, baseToken, alice, ALICE_SUPPLY);
          await allocateAndSupply(comet, baseToken, carol, CAROL_SUPPLY);
          await allocateAndSupply(comet, collateral, bob, BORROWER_COLLATERAL);
          await comet.connect(bob).withdraw(baseToken.address, BOB_DEBT);
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: utilization is within the limit', async () => {
          expect(await comet.getUtilization()).to.be.lte(await comet.maxSupportedUtilization());
        });

        it("lender's transfer to an account without debt keeps utilization unchanged", async () => {
          const utilizationBefore = await comet.getUtilization();

          await comet.connect(alice).transfer(carol.address, LENDER_TRANSFER_AMOUNT);

          expect(await comet.getUtilization()).to.equal(utilizationBefore);
        });
      });

      describe('utilization is already above the limit', function () {
        // A transfer to carol keeps utilization above the limit, a repay raises it further while total borrow exceeds total supply
        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await setUpUtilizationAboveLimit();
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: utilization is above the limit', async () => {
          expect(await comet.getUtilization()).to.be.above(await comet.maxSupportedUtilization());
        });

        it("lender's transfer to an account without debt reverts with ExceedsSupportedUtilization", async () => {
          await expect(comet.connect(alice).transfer(carol.address, LENDER_TRANSFER_AMOUNT))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });

        it("lender's transfer to an account with debt reverts with ExceedsSupportedUtilization", async () => {
          await expect(comet.connect(alice).transfer(bob.address, LENDER_TRANSFER_AMOUNT))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });
      });

      describe('repay of another account debt', function () {
        // alice is the only lender, bob and dave are borrowers, and dave owes exactly repayAmount.
        // A repay lowers both totals by the repaid amount: utilization falls while total borrow is below total supply,
        // stays unchanged at full utilization and rises while total borrow exceeds total supply. So a limit below full
        // utilization is reached from above (set through the harness) and a limit above it from below.
        // A partial repay of bob debt (bob owes more than repayAmount) and a full repay of dave debt with the remainder
        // going to the deposit of dave change the totals by the same repayAmount.
        // The repaid amount of dave is capped by the debt, so both cases exceed the limit through one more wei of debt of bob
        const LENDER_REPAY_LIMITS = [
          { maxSupportedUtilization: exp(0.8, 18), totalBorrow: exp(850, 6), harnessBorrow: exp(50, 6), repayAmount: exp(250, 6) },
          { maxSupportedUtilization: exp(1, 18), totalBorrow: exp(1000, 6), harnessBorrow: 0n, repayAmount: exp(400, 6) },
          { maxSupportedUtilization: exp(2, 18), totalBorrow: exp(1900, 6), harnessBorrow: 0n, repayAmount: exp(100, 6) },
        ];
        const ALICE_SUPPLY = exp(1000, 6);
        const DEPOSIT_REMAINDER = exp(5, 6);

        for (const { maxSupportedUtilization, totalBorrow, harnessBorrow, repayAmount } of LENDER_REPAY_LIMITS) {
          describe(`${maxSupportedUtilization / exp(1, 16)}% limit`, function () {
            let limitComet: CometHarnessInterfaceExtendedAssetList;

            before(async () => {
              const protocol = await makeProtocol({ ...MARKET_PROTOCOL_OPTS, maxSupportedUtilization });
              limitComet = protocol.cometWithExtendedAssetList;
              const limitBaseToken = protocol.tokens.USDC as FaucetToken;
              const limitCollateral = protocol.tokens.COMP as FaucetToken;
              await limitBaseToken.allocateTo(limitComet.address, MARKET_RESERVES);
              await allocateAndSupply(limitComet, limitBaseToken, alice, ALICE_SUPPLY);
              await allocateAndSupply(limitComet, limitCollateral, dave, BORROWER_COLLATERAL);
              await limitComet.connect(dave).withdraw(limitBaseToken.address, repayAmount);
              await allocateAndSupply(limitComet, limitCollateral, bob, BORROWER_COLLATERAL);
              await limitComet.connect(bob).withdraw(limitBaseToken.address, totalBorrow - harnessBorrow - repayAmount);
              if (harnessBorrow > 0n) await bumpBorrow(limitComet, bob.address, harnessBorrow);
            });

            it('sanity check: total supply and total borrow match the setup', async () => {
              expect(await limitComet.totalSupply()).to.equal(ALICE_SUPPLY);
              expect(await limitComet.totalBorrow()).to.equal(totalBorrow);
            });

            describe('repay reaches the limit exactly', function () {
              let snapshot: SnapshotRestorer;

              before(async () => {
                snapshot = await takeSnapshot();
              });

              afterEach(async () => {
                await snapshot.restore();
              });

              it("lender's transfer repays part of the debt and brings utilization to the limit", async () => {
                await limitComet.connect(alice).transfer(bob.address, repayAmount);

                expect(await limitComet.getUtilization()).to.equal(maxSupportedUtilization);
              });

              it("lender's transfer repays the whole debt with the remainder to the deposit and brings utilization to the limit", async () => {
                await limitComet.connect(alice).transfer(dave.address, repayAmount + DEPOSIT_REMAINDER);

                expect(await limitComet.getUtilization()).to.equal(maxSupportedUtilization);
              });
            });

            describe('repay exceeds the limit with 1 wei more debt', function () {
              let snapshot: SnapshotRestorer;

              before(async () => {
                snapshot = await takeSnapshot();

                await bumpBorrow(limitComet, bob.address, ONE_WEI);
              });

              after(async () => {
                await snapshot.restore();
              });

              it("lender's transfer repaying part of the debt reverts with ExceedsSupportedUtilization", async () => {
                await expect(limitComet.connect(alice).transfer(bob.address, repayAmount))
                  .to.be.revertedWithCustomError(limitComet, 'ExceedsSupportedUtilization');
              });

              it("lender's transfer repaying the whole debt with the remainder to the deposit reverts with ExceedsSupportedUtilization", async () => {
                await expect(limitComet.connect(alice).transfer(dave.address, repayAmount + DEPOSIT_REMAINDER))
                  .to.be.revertedWithCustomError(limitComet, 'ExceedsSupportedUtilization');
              });
            });
          });
        }
      });

      describe('repay of another account debt with the whole supply', function () {
        // alice is the only lender and dave borrows more than the whole supply:
        // repaying with the whole supply leaves debt without any supply
        const ALICE_SUPPLY = exp(100, 6);
        const DAVE_DEBT = exp(190, 6);

        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await allocateAndSupply(comet, baseToken, alice, ALICE_SUPPLY);
          await allocateAndSupply(comet, collateral, dave, BORROWER_COLLATERAL);
          await comet.connect(dave).withdraw(baseToken.address, DAVE_DEBT);
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: alice holds the whole supply', async () => {
          expect(await comet.balanceOf(alice.address)).to.equal(await comet.totalSupply());
        });

        it('sanity check: total borrow exceeds total supply', async () => {
          expect(await comet.totalBorrow()).to.be.above(await comet.totalSupply());
        });

        it("lender's repay with max amount reverts with ExceedsSupportedUtilization", async () => {
          await expect(comet.connect(alice).transfer(dave.address, ethers.constants.MaxUint256))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });
      });
    });
  });

  describe('base withdraw', function () {
    describe('lender withdraw', function () {
      // alice is the only lender, dave is the borrower
      const LENDER_WITHDRAW_LIMITS = [
        { maxSupportedUtilization: exp(0.8, 18), withdrawAmount: exp(375, 6) },
        { maxSupportedUtilization: exp(1, 18), withdrawAmount: exp(500, 6) },
        { maxSupportedUtilization: exp(2, 18), withdrawAmount: exp(750, 6) },
      ];
      const ALICE_SUPPLY = exp(1000, 6);
      const DAVE_DEBT = exp(500, 6);

      for (const { maxSupportedUtilization, withdrawAmount } of LENDER_WITHDRAW_LIMITS) {
        describe(`${maxSupportedUtilization / exp(1, 16)}% limit`, function () {
          let limitComet: CometHarnessInterfaceExtendedAssetList;
          let limitBaseToken: FaucetToken;
          let limitSnapshot: SnapshotRestorer;

          before(async () => {
            const protocol = await makeProtocol({ ...MARKET_PROTOCOL_OPTS, maxSupportedUtilization });
            limitComet = protocol.cometWithExtendedAssetList;
            limitBaseToken = protocol.tokens.USDC as FaucetToken;
            const limitCollateral = protocol.tokens.COMP as FaucetToken;
            await limitBaseToken.allocateTo(limitComet.address, MARKET_RESERVES);
            await allocateAndSupply(limitComet, limitBaseToken, alice, ALICE_SUPPLY);
            await allocateAndSupply(limitComet, limitCollateral, dave, BORROWER_COLLATERAL);
            await limitComet.connect(dave).withdraw(limitBaseToken.address, DAVE_DEBT);

            limitSnapshot = await takeSnapshot();
          });

          after(async () => {
            await limitSnapshot.restore();
          });

          it('sanity check: total supply and total borrow match the setup', async () => {
            expect(await limitComet.totalSupply()).to.equal(ALICE_SUPPLY);
            expect(await limitComet.totalBorrow()).to.equal(DAVE_DEBT);
          });

          it('lender withdraw exceeding the limit by 1 wei reverts with ExceedsSupportedUtilization', async () => {
            await expect(limitComet.connect(alice).withdraw(limitBaseToken.address, withdrawAmount + ONE_WEI))
              .to.be.revertedWithCustomError(limitComet, 'ExceedsSupportedUtilization');
          });

          it('lender withdraw brings utilization to the limit', async () => {
            await limitComet.connect(alice).withdraw(limitBaseToken.address, withdrawAmount);

            expect(await limitComet.getUtilization()).to.equal(maxSupportedUtilization);
          });
        });
      }

      describe('utilization is already above the limit', function () {
        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await setUpUtilizationAboveLimit();
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: utilization is above the limit', async () => {
          expect(await comet.getUtilization()).to.be.above(await comet.maxSupportedUtilization());
        });

        it('lender withdraw of 1 wei reverts with ExceedsSupportedUtilization', async () => {
          await expect(comet.connect(alice).withdraw(baseToken.address, ONE_WEI))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });
      });

      describe("last lender can't withdraw everything while there is debt", function () {
        // alice is the only lender, bob is the borrower
        const BOB_DEBT = exp(500, 6);

        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await allocateAndSupply(comet, baseToken, alice, ALICE_SUPPLY);
          await allocateAndSupply(comet, collateral, bob, BORROWER_COLLATERAL);
          await comet.connect(bob).withdraw(baseToken.address, BOB_DEBT);
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: alice holds the whole supply', async () => {
          expect(await comet.balanceOf(alice.address)).to.equal(await comet.totalSupply());
        });

        it('sanity check: total borrow is positive', async () => {
          expect(await comet.totalBorrow()).to.be.above(0);
        });

        it('withdraw of the whole deposit reverts with ExceedsSupportedUtilization', async () => {
          await expect(comet.connect(alice).withdraw(baseToken.address, ALICE_SUPPLY))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });
      });

      describe('total borrow exceeds total supply', function () {
        // alice is the only lender and bob borrows more than the whole supply, so the market already borrows
        // from reserves. WITHDRAW_UP_TO_LIMIT brings utilization exactly to the default limit
        const BOB_DEBT = exp(1500, 6);
        const WITHDRAW_UP_TO_LIMIT = exp(250, 6);

        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await allocateAndSupply(comet, baseToken, alice, ALICE_SUPPLY);
          await allocateAndSupply(comet, collateral, bob, BORROWER_COLLATERAL);
          await comet.connect(bob).withdraw(baseToken.address, BOB_DEBT);
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: total borrow exceeds total supply', async () => {
          expect(await comet.totalBorrow()).to.be.above(await comet.totalSupply());
        });

        it('lender withdraw exceeding the limit by 1 wei reverts with ExceedsSupportedUtilization', async () => {
          await expect(comet.connect(alice).withdraw(baseToken.address, WITHDRAW_UP_TO_LIMIT + ONE_WEI))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });

        it('lender withdraw brings utilization to the limit', async () => {
          await comet.connect(alice).withdraw(baseToken.address, WITHDRAW_UP_TO_LIMIT);

          expect(await comet.getUtilization()).to.equal(await comet.maxSupportedUtilization());
        });
      });
    });

    describe('borrower withdraw', function () {
      // alice and carol are lenders, dave is the borrower.
      // bob borrows as a new borrower with collateral only, dave as an existing borrower whose debt is part of the total borrow,
      // carol as a lender whose deposit is part of the total supply: the withdraw of carol first takes the deposit and borrows the rest
      const BORROWER_WITHDRAW_LIMITS = [
        { maxSupportedUtilization: exp(0.8, 18), borrowAmount: exp(300, 6), lenderWithdrawAmount: exp(320, 6) },
        { maxSupportedUtilization: exp(1, 18), borrowAmount: exp(500, 6), lenderWithdrawAmount: exp(500, 6) },
        { maxSupportedUtilization: exp(2, 18), borrowAmount: exp(1500, 6), lenderWithdrawAmount: exp(1400, 6) },
      ];
      const ALICE_SUPPLY = exp(900, 6);
      const CAROL_SUPPLY = exp(100, 6);
      const DAVE_DEBT = exp(500, 6);

      for (const { maxSupportedUtilization, borrowAmount, lenderWithdrawAmount } of BORROWER_WITHDRAW_LIMITS) {
        describe(`${maxSupportedUtilization / exp(1, 16)}% limit`, function () {
          let limitComet: CometHarnessInterfaceExtendedAssetList;
          let limitBaseToken: FaucetToken;

          before(async () => {
            const protocol = await makeProtocol({ ...MARKET_PROTOCOL_OPTS, maxSupportedUtilization });
            limitComet = protocol.cometWithExtendedAssetList;
            limitBaseToken = protocol.tokens.USDC as FaucetToken;
            const limitCollateral = protocol.tokens.COMP as FaucetToken;
            await limitBaseToken.allocateTo(limitComet.address, MARKET_RESERVES);
            await allocateAndSupply(limitComet, limitBaseToken, alice, ALICE_SUPPLY);
            await allocateAndSupply(limitComet, limitBaseToken, carol, CAROL_SUPPLY);
            await allocateAndSupply(limitComet, limitCollateral, carol, BORROWER_COLLATERAL);
            await allocateAndSupply(limitComet, limitCollateral, bob, BORROWER_COLLATERAL);
            await allocateAndSupply(limitComet, limitCollateral, dave, BORROWER_COLLATERAL);
            await limitComet.connect(dave).withdraw(limitBaseToken.address, DAVE_DEBT);
          });

          it('sanity check: total supply and total borrow match the setup', async () => {
            expect(await limitComet.totalSupply()).to.equal(ALICE_SUPPLY + CAROL_SUPPLY);
            expect(await limitComet.totalBorrow()).to.equal(DAVE_DEBT);
          });

          it('new borrower withdraw exceeding the limit by 1 wei reverts with ExceedsSupportedUtilization', async () => {
            await expect(limitComet.connect(bob).withdraw(limitBaseToken.address, borrowAmount + ONE_WEI))
              .to.be.revertedWithCustomError(limitComet, 'ExceedsSupportedUtilization');
          });

          it('existing borrower withdraw exceeding the limit by 1 wei reverts with ExceedsSupportedUtilization', async () => {
            await expect(limitComet.connect(dave).withdraw(limitBaseToken.address, borrowAmount + ONE_WEI))
              .to.be.revertedWithCustomError(limitComet, 'ExceedsSupportedUtilization');
          });

          it('lender becomes borrower withdraw exceeding the limit by 1 wei reverts with ExceedsSupportedUtilization', async () => {
            await expect(limitComet.connect(carol).withdraw(limitBaseToken.address, lenderWithdrawAmount + ONE_WEI))
              .to.be.revertedWithCustomError(limitComet, 'ExceedsSupportedUtilization');
          });

          describe('withdraw reaches the limit exactly', function () {
            let snapshot: SnapshotRestorer;

            before(async () => {
              snapshot = await takeSnapshot();
            });

            afterEach(async () => {
              await snapshot.restore();
            });

            it('new borrower withdraw brings utilization to the limit', async () => {
              await limitComet.connect(bob).withdraw(limitBaseToken.address, borrowAmount);

              expect(await limitComet.getUtilization()).to.equal(maxSupportedUtilization);
            });

            it('existing borrower withdraw brings utilization to the limit', async () => {
              await limitComet.connect(dave).withdraw(limitBaseToken.address, borrowAmount);

              expect(await limitComet.getUtilization()).to.equal(maxSupportedUtilization);
            });

            it('lender becomes borrower withdraw brings utilization to the limit', async () => {
              await limitComet.connect(carol).withdraw(limitBaseToken.address, lenderWithdrawAmount);

              expect(await limitComet.getUtilization()).to.equal(maxSupportedUtilization);
            });
          });
        });
      }

      describe('limit is checked against present values', function () {
        // The borrow index is set higher than the supply index, so after BORROW_UP_TO_LIMIT the market reaches the default
        // limit in present values while utilization in principals stays below it
        const BASE_INDEX_SCALE = exp(1, 15);
        const SUPPLY_INDEX = 2n * BASE_INDEX_SCALE;
        const BORROW_INDEX = 4n * BASE_INDEX_SCALE;
        const BOB_DEBT = exp(1500, 6);
        const BORROW_UP_TO_LIMIT = exp(500, 6);

        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await setTotalsBasic(comet, { baseSupplyIndex: SUPPLY_INDEX, baseBorrowIndex: BORROW_INDEX });
          await allocateAndSupply(comet, baseToken, alice, ALICE_SUPPLY);
          await allocateAndSupply(comet, baseToken, carol, CAROL_SUPPLY);
          await allocateAndSupply(comet, collateral, bob, BORROWER_COLLATERAL);
          await comet.connect(bob).withdraw(baseToken.address, BOB_DEBT);
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: utilization in principals is below utilization in present values', async () => {
          const { totalSupplyBase, totalBorrowBase } = await comet.totalsBasic();
          expect(totalBorrowBase.mul(ONE).div(totalSupplyBase)).to.be.below(await comet.getUtilization());
        });

        it('borrower withdraw exceeding the limit in present values by 1 wei reverts with ExceedsSupportedUtilization', async () => {
          await expect(comet.connect(bob).withdraw(baseToken.address, BORROW_UP_TO_LIMIT + ONE_WEI))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });

        it('borrower withdraw brings utilization to the limit in present values', async () => {
          await comet.connect(bob).withdraw(baseToken.address, BORROW_UP_TO_LIMIT);

          expect(await comet.getUtilization()).to.equal(await comet.maxSupportedUtilization());
        });
      });

      describe('borrow with zero total supply', function () {
        // A withdraw does not create supply, so a borrow with zero total supply exceeds any limit
        const BORROW_AMOUNT = exp(100, 6);

        let snapshot: SnapshotRestorer;

        before(async () => {
          snapshot = await takeSnapshot();

          await allocateAndSupply(comet, collateral, bob, BORROWER_COLLATERAL);
        });

        after(async () => {
          await snapshot.restore();
        });

        it('sanity check: total supply is 0', async () => {
          expect(await comet.totalSupply()).to.equal(0);
        });

        it('sanity check: total borrow is 0', async () => {
          expect(await comet.totalBorrow()).to.equal(0);
        });

        it('borrow reverts with ExceedsSupportedUtilization', async () => {
          await expect(comet.connect(bob).withdraw(baseToken.address, BORROW_AMOUNT))
            .to.be.revertedWithCustomError(comet, 'ExceedsSupportedUtilization');
        });
      });
    });
  });

  describe('interest accrual', function () {
    // Debt grows at the borrow rate while deposits earn nothing, so accrual alone takes utilization past the limit.
    // alice is the only lender, bob borrows up to the limit
    const ALICE_SUPPLY = exp(1000, 6);
    const BORROW_RATE = exp(0.1, 18);
    const ACCRUAL_PERIOD = 86400;

    let rateComet: CometHarnessInterfaceExtendedAssetList;

    before(async () => {
      const protocol = await makeProtocol({ ...MARKET_PROTOCOL_OPTS, borrowInterestRateBase: BORROW_RATE });
      rateComet = protocol.cometWithExtendedAssetList;
      const rateBaseToken = protocol.tokens.USDC as FaucetToken;
      const rateCollateral = protocol.tokens.COMP as FaucetToken;
      await rateBaseToken.allocateTo(rateComet.address, MARKET_RESERVES);
      await allocateAndSupply(rateComet, rateBaseToken, alice, ALICE_SUPPLY);
      await allocateAndSupply(rateComet, rateCollateral, bob, BORROWER_COLLATERAL);
      const borrowUpToLimit = ALICE_SUPPLY * (await rateComet.maxSupportedUtilization()).toBigInt() / ONE;
      await rateComet.connect(bob).withdraw(rateBaseToken.address, borrowUpToLimit);
      await fastForward(ACCRUAL_PERIOD);
    });

    it('sanity check: utilization is at the limit before the accrual', async () => {
      expect(await rateComet.getUtilization()).to.equal(await rateComet.maxSupportedUtilization());
    });

    it('interest accrual does not revert and takes utilization above the limit', async () => {
      await expect(rateComet.accrueAccount(bob.address)).to.not.be.reverted;

      expect(await rateComet.getUtilization()).to.be.above(await rateComet.maxSupportedUtilization());
    });
  });

  describe('operations when utilization is above the limit', function () {
    // Only base transfer and base withdraw are limited, every other operation still works above the limit
    const REPAY_AMOUNT = exp(60, 6);
    const SUPPLY_AMOUNT = exp(50, 6);
    const COLLATERAL_SUPPLY_AMOUNT = exp(10, 18);
    const COLLATERAL_WITHDRAW_AMOUNT = exp(5, 18);
    const LENDER_COLLATERAL = exp(10, 18);
    const RESERVES_WITHDRAW_AMOUNT = exp(1000, 6);

    let operationsSnapshot: SnapshotRestorer;

    before(async () => {
      operationsSnapshot = await takeSnapshot();

      await setUpUtilizationAboveLimit();
      // carol is a lender who also holds collateral
      await allocateAndSupply(comet, collateral, carol, LENDER_COLLATERAL);
      await baseToken.allocateTo(bob.address, REPAY_AMOUNT);
      await baseToken.connect(bob).approve(comet.address, REPAY_AMOUNT);
      await baseToken.allocateTo(dave.address, SUPPLY_AMOUNT);
      await baseToken.connect(dave).approve(comet.address, SUPPLY_AMOUNT);
      await collateral.allocateTo(bob.address, COLLATERAL_SUPPLY_AMOUNT);
      await collateral.connect(bob).approve(comet.address, COLLATERAL_SUPPLY_AMOUNT);
    });

    after(async () => {
      await operationsSnapshot.restore();
    });

    it('sanity check: utilization is above the limit', async () => {
      expect(await comet.getUtilization()).to.be.above(await comet.maxSupportedUtilization());
    });

    it('sanity check: bob borrow is collateralized', async () => {
      expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
    });

    describe('operations other than base transfer and base withdraw do not revert above the limit', function () {
      // Each operation starts from the market above the limit
      let aboveLimitSnapshot: SnapshotRestorer;

      before(async () => {
        aboveLimitSnapshot = await takeSnapshot();
      });

      afterEach(async () => {
        await aboveLimitSnapshot.restore();
      });

      it('borrower repays debt', async () => {
        await expect(comet.connect(bob).supply(baseToken.address, REPAY_AMOUNT)).to.not.be.reverted;
      });

      it('new lender supplies', async () => {
        await expect(comet.connect(dave).supply(baseToken.address, SUPPLY_AMOUNT)).to.not.be.reverted;
      });

      it('collateral supply', async () => {
        await expect(comet.connect(bob).supply(collateral.address, COLLATERAL_SUPPLY_AMOUNT)).to.not.be.reverted;
      });

      it('lender withdraws collateral', async () => {
        await expect(comet.connect(carol).withdraw(collateral.address, COLLATERAL_WITHDRAW_AMOUNT)).to.not.be.reverted;
      });

      it('borrower with collateralized debt withdraws collateral', async () => {
        await expect(comet.connect(bob).withdraw(collateral.address, COLLATERAL_WITHDRAW_AMOUNT)).to.not.be.reverted;
      });

      it('governor withdraws reserves', async () => {
        await expect(comet.connect(governor).withdrawReserves(governor.address, RESERVES_WITHDRAW_AMOUNT)).to.not.be.reverted;
      });
    });
  });

  describe('liquidation operations when utilization is above the limit', function () {
    // Collateral price at which bob is liquidatable
    const LIQUIDATION_PRICE = exp(0.5, 8);
    const BUY_COLLATERAL_AMOUNT = exp(10, 6);
    // dave holds the same debt as bob, so the market stays above the limit after the absorb clears the debt of bob
    const DAVE_HARNESS_DEBT = ABOVE_LIMIT_MARKET.bobDebt + ABOVE_LIMIT_MARKET.bobHarnessDebt;

    let snapshot: SnapshotRestorer;

    before(async () => {
      snapshot = await takeSnapshot();

      await setUpUtilizationAboveLimit();
      await bumpBorrow(comet, dave.address, DAVE_HARNESS_DEBT);
      await collateralPriceFeed.setRoundData(0, LIQUIDATION_PRICE, 0, 0, 0);
      await baseToken.allocateTo(eve.address, BUY_COLLATERAL_AMOUNT);
      await baseToken.connect(eve).approve(comet.address, BUY_COLLATERAL_AMOUNT);
    });

    after(async () => {
      await snapshot.restore();
    });

    it('sanity check: utilization is above the limit', async () => {
      expect(await comet.getUtilization()).to.be.above(await comet.maxSupportedUtilization());
    });

    it('sanity check: bob is liquidatable', async () => {
      expect(await comet.isLiquidatable(bob.address)).to.be.true;
    });

    it('liquidatable borrower is absorbed without revert', async () => {
      await expect(comet.connect(eve).absorb(eve.address, [bob.address])).to.not.be.reverted;
    });

    it('sanity check: utilization is above the limit after the absorb', async () => {
      expect(await comet.getUtilization()).to.be.above(await comet.maxSupportedUtilization());
    });

    it('absorbed collateral is bought without revert', async () => {
      await expect(comet.connect(eve).buyCollateral(collateral.address, 0, BUY_COLLATERAL_AMOUNT, eve.address)).to.not.be.reverted;
    });
  });
});
