import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import { EventLog, MaxUint256, ZeroAddress } from 'ethers';
import type { ContractTransactionReceipt } from 'ethers';

import { ethers, expect, makeProtocol } from './helpers.js';
import type { Comet } from './helpers.js';

describe('CometExt allow / approve permissions', function () {
  // shared environment, built ONCE
  let comet: Comet;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let aliceAddress: string;
  let bobAddress: string;
  let carolAddress: string;
  let baseId: string; // snapshot of the prepared env

  // shared across the sequential happy-path `it`s
  let receipt: ContractTransactionReceipt;

  const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
  const revert = (id: string): Promise<void> => ethers.provider.send('evm_revert', [id]);
  const approvalEvent = (receipt: ContractTransactionReceipt) => {
    const log = receipt.logs[0];
    if (!(log instanceof EventLog) || log.eventName !== 'Approval') {
      throw new Error('Approval event not found');
    }
    return {
      Approval: {
        owner: log.args.owner,
        spender: log.args.spender,
        amount: log.args.amount,
      },
    };
  };

  // prepare: allow/approve are pure permission flips, so no balance seeding is required
  before(async () => {
    const protocol = await makeProtocol();
    comet = protocol.cometWithExtendedAssetList;
    [alice, bob, carol] = protocol.users;
    aliceAddress = await alice.getAddress();
    bobAddress = await bob.getAddress();
    carolAddress = await carol.getAddress();

    baseId = await snapshot();
  });

  // read-only: these never mutate storage, so no snapshot/revert is needed between them
  describe('defaults', function () {
    it('isAllowed defaults to false', async () => {
      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.false;
    });

    it('allowance defaults to 0', async () => {
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(0n);
    });

    it('hasPermission is false by default for others', async () => {
      expect(await comet.hasPermission(aliceAddress, bobAddress)).to.be.false;
    });

    it('hasPermission is true for self', async () => {
      expect(await comet.hasPermission(aliceAddress, aliceAddress)).to.be.true;
    });

    it('allowance(self, self) is MaxUint256', async () => {
      expect(await comet.allowance(aliceAddress, aliceAddress)).to.equal(MaxUint256);
    });
  });

  // happy path: allow(true).
  describe('happy path: allow grant', function () {
    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('executes without reverting', async () => {
      const txn = await comet.connect(alice).allow(bobAddress, true);
      receipt = (await txn.wait())!;
    });

    it('emits Approval with MaxUint256', async () => {
      expect(approvalEvent(receipt)).to.be.deep.equal({
        Approval: { owner: aliceAddress, spender: bobAddress, amount: MaxUint256 },
      });
    });

    it('sets isAllowed to true', async () => {
      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.true;
    });

    it('sets hasPermission to true', async () => {
      expect(await comet.hasPermission(aliceAddress, bobAddress)).to.be.true;
    });

    it('sets allowance to MaxUint256', async () => {
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(MaxUint256);
    });
  });

  // happy path: rescind. Prereq grant is seeded in `before`; the call under test runs once.
  describe('happy path: allow rescind', function () {
    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
      await comet.connect(alice).allow(bobAddress, true);
    });

    it('executes without reverting', async () => {
      const txn = await comet.connect(alice).allow(bobAddress, false);
      receipt = (await txn.wait())!;
    });

    it('emits Approval with 0', async () => {
      expect(approvalEvent(receipt)).to.be.deep.equal({
        Approval: { owner: aliceAddress, spender: bobAddress, amount: 0n },
      });
    });

    it('sets isAllowed to false', async () => {
      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.false;
    });

    it('sets hasPermission to false', async () => {
      expect(await comet.hasPermission(aliceAddress, bobAddress)).to.be.false;
    });

    it('sets allowance to 0', async () => {
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(0n);
    });
  });

  describe('happy path: approve(max)', function () {
    let ret: boolean;

    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
      ret = await comet.connect(alice).approve.staticCall(bobAddress, MaxUint256);
    });

    it('executes without reverting', async () => {
      const txn = await comet.connect(alice).approve(bobAddress, MaxUint256);
      receipt = (await txn.wait())!;
    });

    it('returns true', async () => {
      expect(ret).to.be.true;
    });

    it('emits Approval with MaxUint256', async () => {
      expect(approvalEvent(receipt)).to.be.deep.equal({
        Approval: { owner: aliceAddress, spender: bobAddress, amount: MaxUint256 },
      });
    });

    it('sets isAllowed to true', async () => {
      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.true;
    });

    it('sets allowance to MaxUint256', async () => {
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(MaxUint256);
    });
  });

  // happy path: approve(0) after a grant disallows the spender.
  describe('happy path: approve(0)', function () {
    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
      await comet.connect(alice).allow(bobAddress, true);
    });

    it('executes without reverting', async () => {
      const txn = await comet.connect(alice).approve(bobAddress, 0);
      receipt = (await txn.wait())!;
    });

    it('emits Approval with 0', async () => {
      expect(approvalEvent(receipt)).to.be.deep.equal({
        Approval: { owner: aliceAddress, spender: bobAddress, amount: 0n },
      });
    });

    it('sets isAllowed to false', async () => {
      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.false;
    });

    it('sets allowance to 0', async () => {
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(0n);
    });
  });

  // negative cases: a reverted call commits nothing, so no per-test revert is needed.
  // one `before` revert gives the storage-reading case a known-clean baseline.
  describe('approve revert cases', function () {
    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('reverts with BadAmount for 1', async () => {
      await expect(
        comet.connect(alice).approve(bobAddress, 1)
      ).to.be.revertedWithCustomError(comet, 'BadAmount');
    });

    it('reverts with BadAmount for 2', async () => {
      await expect(
        comet.connect(alice).approve(bobAddress, 2)
      ).to.be.revertedWithCustomError(comet, 'BadAmount');
    });

    it('reverts with BadAmount for MaxUint256 - 1', async () => {
      await expect(
        comet.connect(alice).approve(bobAddress, MaxUint256 - 1n)
      ).to.be.revertedWithCustomError(comet, 'BadAmount');
    });

    it('reverts with BadAmount for 2**255', async () => {
      await expect(
        comet.connect(alice).approve(bobAddress, 2n ** 255n)
      ).to.be.revertedWithCustomError(comet, 'BadAmount');
    });

    it('does not authorize the spender on the BadAmount path', async () => {
      await expect(
        comet.connect(alice).approve(bobAddress, 1)
      ).to.be.revertedWithCustomError(comet, 'BadAmount');
      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.false;
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(0n);
    });
  });

  // idempotency / cycle / edge cases: each is an independent scenario from a clean env
  describe('allow edge cases', function () {
    afterEach(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('idempotent grant re-emits Approval(max) and stays allowed', async () => {
      await comet.connect(alice).allow(bobAddress, true);
      const second = (await (await comet.connect(alice).allow(bobAddress, true)).wait())!;

      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.true;
      expect(approvalEvent(second)).to.be.deep.equal({
        Approval: { owner: aliceAddress, spender: bobAddress, amount: MaxUint256 },
      });
    });

    it('idempotent revoke re-emits Approval(0) and stays disallowed', async () => {
      const txn = (await (await comet.connect(alice).allow(bobAddress, false)).wait())!;

      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.false;
      expect(approvalEvent(txn)).to.be.deep.equal({
        Approval: { owner: aliceAddress, spender: bobAddress, amount: 0n },
      });
    });

    it('handles a true -> false -> true cycle', async () => {
      await comet.connect(alice).allow(bobAddress, true);
      await comet.connect(alice).allow(bobAddress, false);
      await comet.connect(alice).allow(bobAddress, true);

      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.true;
    });

    it('does not special-case the zero address', async () => {
      const txn = (await (await comet.connect(alice).allow(ZeroAddress, true)).wait())!;

      expect(await comet.isAllowed(aliceAddress, ZeroAddress)).to.be.true;
      expect(approvalEvent(txn)).to.be.deep.equal({
        Approval: { owner: aliceAddress, spender: ZeroAddress, amount: MaxUint256 },
      });
    });
  });

  // allow / approve operate on the same binary permission slot
  describe('allow / approve equivalence', function () {
    afterEach(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('approve(max) then allow(false) disallows', async () => {
      await comet.connect(alice).approve(bobAddress, MaxUint256);
      await comet.connect(alice).allow(bobAddress, false);

      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.false;
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(0n);
    });

    it('allow(true) then approve(0) disallows', async () => {
      await comet.connect(alice).allow(bobAddress, true);
      await comet.connect(alice).approve(bobAddress, 0);

      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.false;
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(0n);
    });

    it('approve(max) then allow(true) stays allowed', async () => {
      await comet.connect(alice).approve(bobAddress, MaxUint256);
      await comet.connect(alice).allow(bobAddress, true);

      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.true;
      expect(await comet.allowance(aliceAddress, bobAddress)).to.equal(MaxUint256);
    });
  });

  // self-permission is implicit (owner == manager) and cannot be revoked
  describe('self-permission invariant', function () {
    afterEach(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('allow(self, false) does not revoke self-permission', async () => {
      await comet.connect(alice).allow(aliceAddress, false);

      expect(await comet.hasPermission(aliceAddress, aliceAddress)).to.be.true;
      expect(await comet.allowance(aliceAddress, aliceAddress)).to.equal(MaxUint256);
    });

    it('approve(self, 0) does not revoke self-permission', async () => {
      await comet.connect(alice).approve(aliceAddress, 0);

      expect(await comet.hasPermission(aliceAddress, aliceAddress)).to.be.true;
      expect(await comet.allowance(aliceAddress, aliceAddress)).to.equal(MaxUint256);
    });
  });

  // permissions are keyed per (owner, manager) and do not leak across either axis
  describe('isolation', function () {
    afterEach(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('revoking one manager leaves another authorized', async () => {
      await comet.connect(alice).allow(bobAddress, true);
      await comet.connect(alice).allow(carolAddress, true);
      await comet.connect(alice).allow(bobAddress, false);

      expect(await comet.isAllowed(aliceAddress, bobAddress)).to.be.false;
      expect(await comet.isAllowed(aliceAddress, carolAddress)).to.be.true;
    });

    it('a grant by one owner does not authorize the manager for another owner', async () => {
      // alice grants carol; bob never did
      await comet.connect(alice).allow(carolAddress, true);

      expect(await comet.isAllowed(aliceAddress, carolAddress)).to.be.true;
      expect(await comet.isAllowed(bobAddress, carolAddress)).to.be.false;
      expect(await comet.hasPermission(bobAddress, carolAddress)).to.be.false;
    });
  });
});
