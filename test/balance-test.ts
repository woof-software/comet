import { CometHarnessInterfaceExtendedAssetList, FaucetToken } from '../build/types';
import { ethers, event, expect, exp, makeProtocol, setTotalsBasic, wait, TransactionResponseExt } from './helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

describe('totalBorrow', function () {
  it('has correct totalBorrow', async () => {
    const { cometWithExtendedAssetList : comet } = await makeProtocol();
    await setTotalsBasic(comet, {
      baseBorrowIndex: 2e15,
      totalBorrowBase: 50e6,
    });
    expect(await comet.totalBorrow()).to.eq(100e6);
  });
});

describe('borrowBalanceOf', function () {
  it('returns borrow amount (when principal amount is negative)', async () => {
    const { cometWithExtendedAssetList : comet, users: [user] } = await makeProtocol();
    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      baseBorrowIndex: 3e15,
    });
    await comet.setBasePrincipal(user.address, -100e6); // borrow of $100 USDC
    const borrowBalanceOf = await comet.borrowBalanceOf(user.address);
    expect(borrowBalanceOf).to.eq(300e6); // baseSupplyIndex = 3e15
  });

  it('returns 0 when principal amount is positive', async () => {
    const { cometWithExtendedAssetList : comet, users: [user] } = await makeProtocol();
    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      baseBorrowIndex: 3e15,
    });
    await comet.setBasePrincipal(user.address, 100e6);
    const borrowBalanceOf = await comet.borrowBalanceOf(user.address);
    expect(borrowBalanceOf).to.eq(0);
  });
});

// XXX test implicit interest accrual explicitly

[6, 8, 18].forEach(runMinimumBaseSupplyBalanceTests);

function runMinimumBaseSupplyBalanceTests(baseDecimals: number) {
  describe(`Minimum base amount supply balance (${baseDecimals} decimals)`, function () {
    const SUPPLY_AMOUNT = 1n;
    const BASE_INDEX_SCALE = exp(1, 15);

    type BalanceState = Record<string, bigint>;
    type AccountPrefix = 'alice' | 'bob';
    type EventArgs = Record<string, bigint | string>;

    interface SupplyCase {
      before: BalanceState;
      after: BalanceState;
      transaction: TransactionResponseExt;
      balanceOf: bigint;
    }

    let comet: CometHarnessInterfaceExtendedAssetList;
    let base: FaucetToken;
    let collateral: FaucetToken;
    let alice: SignerWithAddress;
    let bob: SignerWithAddress;
    let charlie: SignerWithAddress;
    let initialSnapshot: string;

    const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
    const revert = (id: string): Promise<boolean> => ethers.provider.send('evm_revert', [id]);
    const toBigInt = (value: { toString(): string }): bigint => BigInt(value.toString());
    const eventCount = (transaction: TransactionResponseExt): number => transaction.receipt['events'].length;
    const eventArgs = (transaction: TransactionResponseExt, index: number, name: string): EventArgs =>
      (event(transaction, index) as Record<string, EventArgs>)[name];

    async function readAccountState(account: SignerWithAddress): Promise<BalanceState> {
      const userBasic = await comet.userBasic(account.address);
      const userCollateral = await comet.userCollateral(account.address, collateral.address);
      const liquidatorPoints = await comet.liquidatorPoints(account.address);

      return {
        principal: toBigInt(userBasic.principal),
        baseTrackingIndex: toBigInt(userBasic.baseTrackingIndex),
        baseTrackingAccrued: toBigInt(userBasic.baseTrackingAccrued),
        assetsIn: toBigInt(userBasic.assetsIn),
        userBasicReserved: toBigInt(userBasic._reserved),
        collateralBalance: toBigInt(userCollateral.balance),
        userCollateralReserved: toBigInt(userCollateral._reserved),
        baseTokenBalance: toBigInt(await base.balanceOf(account.address)),
        collateralTokenBalance: toBigInt(await collateral.balanceOf(account.address)),
        liquidatorNumAbsorbs: toBigInt(liquidatorPoints.numAbsorbs),
        liquidatorNumAbsorbed: toBigInt(liquidatorPoints.numAbsorbed),
        liquidatorApproxSpend: toBigInt(liquidatorPoints.approxSpend),
        liquidatorReserved: toBigInt(liquidatorPoints._reserved),
      };
    }

    function prefixState(prefix: string, state: BalanceState): BalanceState {
      return Object.fromEntries(
        Object.entries(state).map(([key, value]) => [
          `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
          value,
        ])
      );
    }

    async function readBalanceState(): Promise<BalanceState> {
      const [aliceState, bobState, charlieState, totalsBasic, totalsCollateral] = await Promise.all([
        readAccountState(alice),
        readAccountState(bob),
        readAccountState(charlie),
        comet.totalsBasic(),
        comet.totalsCollateral(collateral.address),
      ]);

      return {
        ...prefixState('alice', aliceState),
        ...prefixState('bob', bobState),
        ...prefixState('charlie', charlieState),
        baseSupplyIndex: toBigInt(totalsBasic.baseSupplyIndex),
        baseBorrowIndex: toBigInt(totalsBasic.baseBorrowIndex),
        trackingSupplyIndex: toBigInt(totalsBasic.trackingSupplyIndex),
        trackingBorrowIndex: toBigInt(totalsBasic.trackingBorrowIndex),
        totalSupplyBase: toBigInt(totalsBasic.totalSupplyBase),
        totalBorrowBase: toBigInt(totalsBasic.totalBorrowBase),
        lastAccrualTime: toBigInt(totalsBasic.lastAccrualTime),
        pauseFlags: toBigInt(totalsBasic.pauseFlags),
        totalSupplyAsset: toBigInt(totalsCollateral.totalSupplyAsset),
        totalsCollateralReserved: toBigInt(totalsCollateral._reserved),
        cometBaseTokenBalance: toBigInt(await base.balanceOf(comet.address)),
        baseTokenSupply: toBigInt(await base.totalSupply()),
        cometCollateralTokenBalance: toBigInt(await collateral.balanceOf(comet.address)),
        collateralTokenSupply: toBigInt(await collateral.totalSupply()),
        baseReserves: toBigInt(await comet.getReserves()),
        collateralReserves: toBigInt(await comet.getCollateralReserves(collateral.address)),
      };
    }

    function stateDiff(supplyCase: SupplyCase): BalanceState {
      return Object.fromEntries(
        Object.keys(supplyCase.before).map((key) => [
          key,
          supplyCase.after[key] - supplyCase.before[key],
        ])
      );
    }

    async function runSupplyScenario(
      destination: () => SignerWithAddress,
      action: () => Promise<ContractTransaction>
    ): Promise<SupplyCase> {
      await base.allocateTo(alice.address, SUPPLY_AMOUNT);
      await base.connect(alice).approve(comet.address, SUPPLY_AMOUNT);

      const before = await readBalanceState();
      const transaction = await wait(action());
      const after = await readBalanceState();
      const balanceOf = toBigInt(await comet.balanceOf(destination().address));

      return { before, after, transaction, balanceOf };
    }

    async function resetFixture() {
      await revert(initialSnapshot);
      initialSnapshot = await snapshot();
    }

    function shouldSupplyMinimumBase(
      destinationPrefix: AccountPrefix,
      destination: () => SignerWithAddress,
      action: () => Promise<ContractTransaction>,
      prepare?: () => Promise<unknown>
    ) {
      context('given baseSupplyIndex equals the initial index', function () {
        let supplyCase: SupplyCase;

        before(async () => {
          if (prepare) await prepare();
          supplyCase = await runSupplyScenario(destination, action);
        });

        after(resetFixture);

        it('uses the initial base supply index', async () => {
          expect(supplyCase.before.baseSupplyIndex).to.equal(BASE_INDEX_SCALE);
        });

        it('starts from zero destination principal', async () => {
          expect(supplyCase.before[`${destinationPrefix}Principal`]).to.equal(0n);
        });

        context('when supplying 1 raw unit to an account with zero principal', function () {
          it('sets principal to 1', async () => {
            expect(supplyCase.after[`${destinationPrefix}Principal`]).to.equal(SUPPLY_AMOUNT);
          });

          it('increases totalSupplyBase by 1', async () => {
            const { before, after } = supplyCase;
            expect(after.totalSupplyBase).to.equal(before.totalSupplyBase + SUPPLY_AMOUNT);
          });

          it('emits Supply with amount 1', async () => {
            expect(event(supplyCase.transaction, 1)).to.deep.equal({
              Supply: {
                from: alice.address,
                dst: destination().address,
                amount: SUPPLY_AMOUNT,
              },
            });
          });

          it('emits Transfer from the zero address with amount 1', async () => {
            expect(event(supplyCase.transaction, 2)).to.deep.equal({
              Transfer: {
                from: ethers.constants.AddressZero,
                to: destination().address,
                amount: SUPPLY_AMOUNT,
              },
            });
          });

          it('emits only the token Transfer, Supply and the mint Transfer', async () => {
            expect(eventCount(supplyCase.transaction)).to.equal(3);
          });

          it('debits the supplier by exactly 1 raw unit', async () => {
            const { before, after } = supplyCase;
            expect(after.aliceBaseTokenBalance).to.equal(before.aliceBaseTokenBalance - SUPPLY_AMOUNT);
          });

          it('credits Comet by exactly 1 raw unit', async () => {
            const { before, after } = supplyCase;
            expect(after.cometBaseTokenBalance).to.equal(before.cometBaseTokenBalance + SUPPLY_AMOUNT);
          });

          it('emits the base token Transfer from the supplier to Comet', async () => {
            expect(eventArgs(supplyCase.transaction, 0, 'Transfer')).to.deep.equal({
              from: alice.address,
              to: comet.address,
              amount: SUPPLY_AMOUNT,
            });
          });

          it('reports balanceOf of the user as 1', async () => {
            expect(supplyCase.balanceOf).to.equal(SUPPLY_AMOUNT);
          });

          it('leaves getReserves unchanged', async () => {
            const { before, after } = supplyCase;
            expect(after.baseReserves).to.equal(before.baseReserves);
          });

          it('changes only the destination principal, total supply and base token balances', async () => {
            const expectedDiff = Object.fromEntries(
              Object.keys(supplyCase.before).map((key) => [key, 0n])
            ) as BalanceState;
            expectedDiff[`${destinationPrefix}Principal`] = SUPPLY_AMOUNT;
            expectedDiff.totalSupplyBase = SUPPLY_AMOUNT;
            expectedDiff.aliceBaseTokenBalance = -SUPPLY_AMOUNT;
            expectedDiff.cometBaseTokenBalance = SUPPLY_AMOUNT;

            expect(stateDiff(supplyCase)).to.deep.equal(expectedDiff);
          });
        });
      });
    }

    before(async () => {
      const protocol = await makeProtocol({
        base: 'USDC',
        baseBorrowMin: 0,
        assets: {
          USDC: { decimals: baseDecimals, initialPrice: 1 },
          TOKEN: {
            decimals: 18,
            initialPrice: 1,
            supplyCap: exp(100, 18),
          },
        },
      });

      comet = protocol.cometWithExtendedAssetList;
      base = protocol.tokens.USDC as FaucetToken;
      collateral = protocol.tokens.TOKEN as FaucetToken;
      [alice, bob, charlie] = protocol.users;

      // Freeze time so the supply does not accrue between setup and action (README 3.6)
      const now = await comet.getNow();
      await comet.setNow(now);
      await setTotalsBasic(comet, { lastAccrualTime: now });

      initialSnapshot = await snapshot();
    });

    after(async () => {
      await revert(initialSnapshot);
    });

    describe('supply', function () {
      shouldSupplyMinimumBase(
        'alice',
        () => alice,
        () => comet.connect(alice).supply(base.address, SUPPLY_AMOUNT)
      );
    });

    describe('supplyTo', function () {
      shouldSupplyMinimumBase(
        'bob',
        () => bob,
        () => comet.connect(alice).supplyTo(bob.address, base.address, SUPPLY_AMOUNT)
      );
    });

    describe('supplyFrom', function () {
      shouldSupplyMinimumBase(
        'bob',
        () => bob,
        () => comet.connect(charlie).supplyFrom(alice.address, bob.address, base.address, SUPPLY_AMOUNT),
        () => wait(comet.connect(alice).allow(charlie.address, true))
      );
    });
  });
}
