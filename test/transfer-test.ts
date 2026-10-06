import { CometHarnessInterfaceExtendedAssetList, FaucetToken } from '../build/types';
import { baseBalanceOf, ethers, event, expect, exp, makeProtocol, portfolio, setTotalsBasic, wait, fastForward, TransactionResponseExt } from './helpers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

describe('transfer', function () {
  it('transfers base from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = protocol;
    const { USDC } = tokens;

    const _i0 = await comet.setBasePrincipal(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, USDC.address, 100e6));
    const t1 = await comet.totalsBasic();
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: ethers.constants.AddressZero,
        amount: BigInt(100e6),
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Transfer: {
        from: ethers.constants.AddressZero,
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

    await comet.setCollateralBalance(bob.address, WETH.address, exp(1, 18));
    await comet.setBasePrincipal(alice.address, -100e6);
    await setTotalsBasic(comet, {
      totalSupplyBase: 100e6,
      totalBorrowBase: 100e6,
    });

    const cometAsB = comet.connect(bob);

    const s0 = await wait(cometAsB.transferAsset(alice.address, USDC.address, 100e6));

    expect(s0.receipt['events'].length).to.be.equal(0);
  });

  it('transfers max base balance (including accrued) from sender if the asset is base', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    await USDC.allocateTo(comet.address, 100e6);
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
    const bobAccruedBalance = (await comet.callStatic.balanceOf(bob.address)).toBigInt();
    const s0 = await wait(cometAsB.transferAsset(alice.address, USDC.address, ethers.constants.MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    // additional 1 wei burned, amount to clear bob gets alice to same balance - 1
    expect(event(s0, 0)).to.be.deep.equal({
      Transfer: {
        from: bob.address,
        to: ethers.constants.AddressZero,
        amount: bobAccruedBalance,
      }
    });
    expect(event(s0, 1)).to.be.deep.equal({
      Transfer: {
        from: ethers.constants.AddressZero,
        to: alice.address,
        amount: bobAccruedBalance - 1n,
      }
    });

    // Hitting the rounding down behavior in this specific case (which is favorable to the protocol)
    expect(a0.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b0.internal).to.be.deep.equal({ USDC: bobAccruedBalance, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(a1.internal).to.be.deep.equal({ USDC: bobAccruedBalance - 1n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(b1.internal).to.be.deep.equal({ USDC: 0n, COMP: 0n, WETH: 0n, WBTC: 0n });
    expect(t1.totalSupplyBase).to.be.equal(t0.totalSupplyBase.sub(1));
    expect(t1.totalBorrowBase).to.be.equal(t0.totalBorrowBase);
    expect(Number(s0.receipt.gasUsed)).to.be.lessThan(105000);
  });

  it('transfer max base should transfer 0 if user has a borrow position', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { USDC, WETH } = tokens;

    await comet.setBasePrincipal(bob.address, -100e6);
    await comet.setCollateralBalance(bob.address, WETH.address, exp(1, 18));
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsBasic();
    const a0 = await portfolio(protocol, alice.address);
    const b0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, USDC.address, ethers.constants.MaxUint256));
    const t1 = await comet.totalsBasic();
    const a1 = await portfolio(protocol, alice.address);
    const b1 = await portfolio(protocol, bob.address);

    expect(s0.receipt['events'].length).to.be.equal(0);
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

    const _i0 = await comet.setCollateralBalance(bob.address, COMP.address, 8e8);
    const cometAsB = comet.connect(bob);

    const t0 = await comet.totalsCollateral(COMP.address);
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const s0 = await wait(cometAsB.transferAsset(alice.address, COMP.address, 8e8));
    const t1 = await comet.totalsCollateral(COMP.address);
    const p1 = await portfolio(protocol, alice.address);
    const q1 = await portfolio(protocol, bob.address);

    expect(event(s0, 0)).to.be.deep.equal({
      TransferCollateral: {
        from: bob.address,
        to: alice.address,
        asset: COMP.address,
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

    await comet.setBasePrincipal(bob.address, 50e6); // 100e6 in present value
    const cometAsB = comet.connect(bob);

    const totals0 = await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
    });

    const alice0 = await portfolio(protocol, alice.address);
    const bob0 = await portfolio(protocol, bob.address);

    await wait(cometAsB.transferAsset(alice.address, USDC.address, 100e6));
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

    await expect(cometAsB.transferAsset(alice.address, USUP.address, 1)).to.be.reverted;
  });

  it('reverts if transfer is paused', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob] } = protocol;
    const { USDC } = tokens;

    const cometAsB = comet.connect(bob);

    // Pause transfer
    await wait(comet.connect(pauseGuardian).pause(false, true, false, false, false));
    expect(await comet.isTransferPaused()).to.be.true;

    await expect(cometAsB.transferAsset(alice.address, USDC.address, 1)).to.be.revertedWith("custom error 'Paused()'");
  });

  it('reverts if transfer max for a collateral asset', async () => {
    const protocol = await makeProtocol({ base: 'USDC' });
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = protocol;
    const { COMP } = tokens;

    await COMP.allocateTo(bob.address, 100e6);
    const cometAsB = comet.connect(bob);

    await expect(cometAsB.transferAsset(alice.address, COMP.address, ethers.constants.MaxUint256)).to.be.revertedWith("custom error 'InvalidUInt128()'");
  });

  it('borrows base if collateralized', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { WETH, USDC } = tokens;

    await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));

    let t0 = await comet.totalsBasic();
    await setTotalsBasic(comet, {
      baseBorrowIndex: t0.baseBorrowIndex.mul(2),
    });

    await comet.connect(alice).transferAsset(bob.address, USDC.address, 100e6);

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

    const cometAsB = comet.connect(bob);

    const amount = (await comet.baseBorrowMin()).sub(1);
    await expect(cometAsB.transferAsset(alice.address, USDC.address, amount)).to.be.revertedWith(
      "custom error 'BorrowTooSmall()'"
    );
  });

  it('reverts on self-transfer of base token', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice],
    } = await makeProtocol({ base: 'USDC' });
    const { USDC } = tokens;

    await expect(
      comet.connect(alice).transferAsset(alice.address, USDC.address, 100)
    ).to.be.revertedWith("custom error 'NoSelfTransfer()'");
  });

  it('reverts on self-transfer of collateral', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice],
    } = await makeProtocol();
    const { COMP } = tokens;

    await expect(
      comet.connect(alice).transferAsset(alice.address, COMP.address, 100)
    ).to.be.revertedWith("custom error 'NoSelfTransfer()'");
  });

  it('reverts if transferring base results in an under collateralized borrow', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { USDC } = tokens;

    await expect(
      comet.connect(alice).transferAsset(bob.address, USDC.address, 100e6)
    ).to.be.revertedWith("custom error 'NotCollateralized()'");
  });

  it('reverts if transferring collateral results in an under collateralized borrow', async () => {
    const { cometWithExtendedAssetList: comet, tokens, users: [alice, bob] } = await makeProtocol();
    const { WETH } = tokens;

    // user has a borrow, but with collateral to cover
    await comet.setBasePrincipal(alice.address, -100e6);
    await comet.setCollateralBalance(alice.address, WETH.address, exp(1, 18));

    // reverts if transfer would leave the borrow uncollateralized
    await expect(
      comet.connect(alice).transferAsset(bob.address, WETH.address, exp(1, 18))
    ).to.be.revertedWith("custom error 'NotCollateralized()'");
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

    const _i0 = await comet.setCollateralBalance(bob.address, COMP.address, 7);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    const _a1 = await wait(cometAsB.allow(charlie.address, true));
    const p0 = await portfolio(protocol, alice.address);
    const q0 = await portfolio(protocol, bob.address);
    const _s0 = await wait(cometAsC.transferAssetFrom(bob.address, alice.address, COMP.address, 7));
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

    const _i0 = await comet.setCollateralBalance(bob.address, COMP.address, 7);
    const cometAsC = comet.connect(charlie);

    await expect(
      cometAsC.transferAssetFrom(bob.address, alice.address, COMP.address, 7)
    ).to.be.revertedWith("custom error 'Unauthorized()'");
  });

  it('reverts on transfer of base token from address to itself', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = await makeProtocol({ base: 'USDC' });
    const { USDC } = tokens;

    await comet.connect(bob).allow(alice.address, true);

    await expect(
      comet.connect(alice).transferAssetFrom(bob.address, bob.address, USDC.address, 100)
    ).to.be.revertedWith("custom error 'NoSelfTransfer()'");
  });

  it('reverts on transfer of collateral from address to itself', async () => {
    const {
      cometWithExtendedAssetList: comet,
      tokens,
      users: [alice, bob],
    } = await makeProtocol();
    const { COMP } = tokens;

    await comet.connect(bob).allow(alice.address, true);

    await expect(
      comet.connect(alice).transferAssetFrom(bob.address, bob.address, COMP.address, 100)
    ).to.be.revertedWith("custom error 'NoSelfTransfer()'");
  });

  it('reverts if transfer is paused', async () => {
    const protocol = await makeProtocol();
    const { cometWithExtendedAssetList: comet, tokens, pauseGuardian, users: [alice, bob, charlie] } = protocol;
    const { COMP } = tokens;

    await comet.setCollateralBalance(bob.address, COMP.address, 7);
    const cometAsB = comet.connect(bob);
    const cometAsC = comet.connect(charlie);

    // Pause transfer
    await wait(comet.connect(pauseGuardian).pause(false, true, false, false, false));
    expect(await comet.isTransferPaused()).to.be.true;

    await wait(cometAsB.allow(charlie.address, true));
    await expect(cometAsC.transferAssetFrom(bob.address, alice.address, COMP.address, 7)).to.be.revertedWith("custom error 'Paused()'");
  });
});

[6, 8, 18].forEach(runMinimumBaseTransferTests);

function runMinimumBaseTransferTests(baseDecimals: number) {
  describe(`Minimum base amount transfers (${baseDecimals} decimals)`, function () {
    const TRANSFER_AMOUNT = 1n;

    type TransferState = Record<string, bigint>;

    interface TransferCase {
      before: TransferState;
      after: TransferState;
      transaction: TransactionResponseExt;
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

    // F1, F2 and F3 (README section 4)
    const principalValueSupply = (presentValue: bigint, index: bigint): bigint => presentValue * exp(1, 15) / index;
    const presentValueSupply = (principal: bigint, index: bigint): bigint => principal * index / exp(1, 15);

    async function readAccountState(account: SignerWithAddress): Promise<TransferState> {
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

    function prefixState(prefix: string, state: TransferState): TransferState {
      return Object.fromEntries(
        Object.entries(state).map(([key, value]) => [
          `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
          value,
        ])
      );
    }

    async function readTransferState(): Promise<TransferState> {
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
        aliceAllowsCharlie: await comet.isAllowed(alice.address, charlie.address) ? 1n : 0n,
        cometBaseTokenBalance: toBigInt(await base.balanceOf(comet.address)),
        baseTokenSupply: toBigInt(await base.totalSupply()),
        cometCollateralTokenBalance: toBigInt(await collateral.balanceOf(comet.address)),
        collateralTokenSupply: toBigInt(await collateral.totalSupply()),
        baseReserves: toBigInt(await comet.getReserves()),
        collateralReserves: toBigInt(await comet.getCollateralReserves(collateral.address)),
      };
    }

    function stateDiff(transferCase: TransferCase): TransferState {
      return Object.fromEntries(
        Object.keys(transferCase.before).map((key) => [
          key,
          transferCase.after[key] - transferCase.before[key],
        ])
      );
    }

    async function runTransferScenario(action: () => Promise<ContractTransaction>): Promise<TransferCase> {
      await base.allocateTo(comet.address, TRANSFER_AMOUNT);
      await setTotalsBasic(comet, { totalSupplyBase: TRANSFER_AMOUNT });
      await comet.setBasePrincipal(alice.address, TRANSFER_AMOUNT);

      const before = await readTransferState();
      const transaction = await wait(action());
      const after = await readTransferState();

      return { before, after, transaction };
    }

    // Totals mirror the two positions, time stays frozen, so the transfer does not accrue (README 3.6)
    async function runPositionTransfer(
      action: () => Promise<ContractTransaction>,
      { baseSupplyIndex = exp(1, 15), baseBorrowIndex = exp(1, 15), senderPrincipal, recipientPrincipal = 0n }: {
        baseSupplyIndex?: bigint;
        baseBorrowIndex?: bigint;
        senderPrincipal: bigint;
        recipientPrincipal?: bigint;
      }
    ): Promise<TransferCase> {
      await setTotalsBasic(comet, {
        baseSupplyIndex,
        baseBorrowIndex,
        totalSupplyBase: senderPrincipal,
        totalBorrowBase: recipientPrincipal < 0n ? -recipientPrincipal : 0n,
        lastAccrualTime: await comet.getNow(),
      });
      await comet.setBasePrincipal(alice.address, senderPrincipal);
      await comet.setBasePrincipal(bob.address, recipientPrincipal);

      const before = await readTransferState();
      const transaction = await wait(action());
      const after = await readTransferState();

      return { before, after, transaction };
    }

    async function resetFixture() {
      await revert(initialSnapshot);
      initialSnapshot = await snapshot();
    }

    function shouldTransferMinimumBase(
      action: () => Promise<ContractTransaction>,
      prepare?: () => Promise<unknown>
    ) {
      context('when a supplier transfers 1 raw unit at the initial index', function () {
        let transferCase: TransferCase;

        before(async () => {
          if (prepare) await prepare();
          transferCase = await runTransferScenario(action);
        });

        after(resetFixture);

        it('uses the initial base supply index', async () => {
          expect(transferCase.before.baseSupplyIndex).to.equal(exp(1, 15));
        });

        it('decreases the sender principal by 1', async () => {
          expect(transferCase.after.alicePrincipal).to.equal(transferCase.before.alicePrincipal - TRANSFER_AMOUNT);
        });

        it('increases the recipient principal by 1', async () => {
          expect(transferCase.after.bobPrincipal).to.equal(transferCase.before.bobPrincipal + TRANSFER_AMOUNT);
        });

        it('keeps total supplied base unchanged', async () => {
          expect(transferCase.after.totalSupplyBase).to.equal(transferCase.before.totalSupplyBase);
        });

        it('emits a Transfer from the sender to the zero address', async () => {
          expect(event(transferCase.transaction, 0)).to.deep.equal({
            Transfer: {
              from: alice.address,
              to: ethers.constants.AddressZero,
              amount: TRANSFER_AMOUNT,
            },
          });
        });

        it('emits a Transfer from the zero address to the recipient', async () => {
          expect(event(transferCase.transaction, 1)).to.deep.equal({
            Transfer: {
              from: ethers.constants.AddressZero,
              to: bob.address,
              amount: TRANSFER_AMOUNT,
            },
          });
        });

        it('emits only the burn and mint Transfer pair', async () => {
          expect(eventCount(transferCase.transaction)).to.equal(2);
        });

        it('keeps the Comet base token balance unchanged', async () => {
          expect(transferCase.after.cometBaseTokenBalance).to.equal(transferCase.before.cometBaseTokenBalance);
        });

        it('keeps base reserves unchanged', async () => {
          expect(transferCase.after.baseReserves).to.equal(transferCase.before.baseReserves);
        });

        it('changes only the sender and recipient principals', async () => {
          const expectedDiff = Object.fromEntries(
            Object.keys(transferCase.before).map((key) => [key, 0n])
          ) as TransferState;
          expectedDiff.alicePrincipal = -TRANSFER_AMOUNT;
          expectedDiff.bobPrincipal = TRANSFER_AMOUNT;

          expect(stateDiff(transferCase)).to.deep.equal(expectedDiff);
        });
      });

      context('given baseSupplyIndex is above the initial index', function () {
        const BASE_SUPPLY_INDEX = exp(1.1, 15);
        const SENDER_PRINCIPAL = 10n;
        const senderPresentValue = presentValueSupply(SENDER_PRINCIPAL, BASE_SUPPLY_INDEX);
        const expectedSenderPrincipal = principalValueSupply(senderPresentValue - TRANSFER_AMOUNT, BASE_SUPPLY_INDEX);
        const senderValueLost = senderPresentValue - presentValueSupply(expectedSenderPrincipal, BASE_SUPPLY_INDEX);

        let transferCase: TransferCase;

        before(async () => {
          if (prepare) await prepare();
          transferCase = await runPositionTransfer(action, {
            baseSupplyIndex: BASE_SUPPLY_INDEX,
            senderPrincipal: SENDER_PRINCIPAL,
          });
        });

        after(resetFixture);

        context('when a supplier transfers 1 raw unit to an account with zero principal', function () {
          it('decreases sender principal to the rounded down principal of its new balance', async () => {
            expect(transferCase.after.alicePrincipal).to.equal(expectedSenderPrincipal);
          });

          it('keeps recipient principal at 0', async () => {
            expect(transferCase.after.bobPrincipal).to.equal(0n);
          });

          it('decreases totalSupplyBase by the sender principal delta', async () => {
            const { before, after } = transferCase;
            expect(after.totalSupplyBase).to.equal(before.totalSupplyBase - (SENDER_PRINCIPAL - expectedSenderPrincipal));
          });

          it('does not emit a Transfer to the recipient', async () => {
            expect(eventCount(transferCase.transaction)).to.equal(1);
            expect(event(transferCase.transaction, 0)).to.deep.equal({
              Transfer: {
                from: alice.address,
                to: ethers.constants.AddressZero,
                amount: presentValueSupply(SENDER_PRINCIPAL - expectedSenderPrincipal, BASE_SUPPLY_INDEX),
              },
            });
          });

          it('keeps the Comet ERC20 balance unchanged', async () => {
            expect(transferCase.after.cometBaseTokenBalance).to.equal(transferCase.before.cometBaseTokenBalance);
          });

          it('increases getReserves by the present value lost by the sender', async () => {
            expect(transferCase.after.baseReserves).to.equal(transferCase.before.baseReserves + senderValueLost);
          });
        });
      });

      context('given the recipient has debt', function () {
        const BASE_BORROW_INDEX = exp(1.05, 15);
        const SENDER_PRINCIPAL = 10n;

        context('given the unit reduces the borrow principal', function () {
          const RECIPIENT_PRINCIPAL = -10n;

          let transferCase: TransferCase;

          before(async () => {
            if (prepare) await prepare();
            transferCase = await runPositionTransfer(action, {
              baseBorrowIndex: BASE_BORROW_INDEX,
              senderPrincipal: SENDER_PRINCIPAL,
              recipientPrincipal: RECIPIENT_PRINCIPAL,
            });
          });

          after(resetFixture);

          context('when a supplier transfers 1 raw unit to the borrower', function () {
            it('decreases the recipient borrow principal magnitude by 1', async () => {
              expect(transferCase.after.bobPrincipal).to.equal(RECIPIENT_PRINCIPAL + 1n);
            });

            it('decreases totalBorrowBase by 1', async () => {
              expect(transferCase.after.totalBorrowBase).to.equal(transferCase.before.totalBorrowBase - 1n);
            });

            it('decreases sender principal by 1', async () => {
              expect(transferCase.after.alicePrincipal).to.equal(SENDER_PRINCIPAL - TRANSFER_AMOUNT);
            });
          });
        });

        context('given the unit is absorbed by borrow rounding', function () {
          // At Ib 1.05e15, p = 20 is absorbed: D = 21 and ceil(20 * 1e15 / 1.05e15) = 20
          const RECIPIENT_PRINCIPAL = -20n;

          let transferCase: TransferCase;

          before(async () => {
            if (prepare) await prepare();
            transferCase = await runPositionTransfer(action, {
              baseBorrowIndex: BASE_BORROW_INDEX,
              senderPrincipal: SENDER_PRINCIPAL,
              recipientPrincipal: RECIPIENT_PRINCIPAL,
            });
          });

          after(resetFixture);

          context('when a supplier transfers 1 raw unit to the borrower', function () {
            it('leaves the recipient principal unchanged', async () => {
              expect(transferCase.after.bobPrincipal).to.equal(RECIPIENT_PRINCIPAL);
            });

            it('leaves totalBorrowBase unchanged', async () => {
              expect(transferCase.after.totalBorrowBase).to.equal(transferCase.before.totalBorrowBase);
            });

            it('still decreases sender principal by 1', async () => {
              expect(transferCase.after.alicePrincipal).to.equal(SENDER_PRINCIPAL - TRANSFER_AMOUNT);
            });

            it('increases getReserves by the value lost by the sender', async () => {
              expect(transferCase.after.baseReserves).to.equal(transferCase.before.baseReserves + TRANSFER_AMOUNT);
            });
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

      await comet.setNow(await comet.getNow());
      initialSnapshot = await snapshot();
    });

    after(async () => {
      await revert(initialSnapshot);
    });

    describe('transfer', function () {
      shouldTransferMinimumBase(
        () => comet.connect(alice).transfer(bob.address, TRANSFER_AMOUNT)
      );
    });

    describe('transferFrom', function () {
      shouldTransferMinimumBase(
        () => comet.connect(charlie).transferFrom(alice.address, bob.address, TRANSFER_AMOUNT),
        () => wait(comet.connect(alice).approve(charlie.address, ethers.constants.MaxUint256))
      );
    });

    describe('transferAsset', function () {
      shouldTransferMinimumBase(
        () => comet.connect(alice).transferAsset(bob.address, base.address, TRANSFER_AMOUNT)
      );
    });

    describe('transferAssetFrom', function () {
      shouldTransferMinimumBase(
        () => comet.connect(charlie).transferAssetFrom(alice.address, bob.address, base.address, TRANSFER_AMOUNT),
        () => wait(comet.connect(alice).allow(charlie.address, true))
      );
    });
  });
}
