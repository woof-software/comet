import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractReceipt } from 'ethers';
import { Comet, ethers, event, expect, makeProtocol } from './helpers';

describe('CometExt allow / approve permissions', function () {
  // shared environment, built ONCE
  let comet: Comet;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let baseId: string; // snapshot of the prepared env

  // shared across the sequential happy-path `it`s
  let receipt: ContractReceipt;

  const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
  const revert = (id: string): Promise<void> => ethers.provider.send('evm_revert', [id]);

  // prepare: allow/approve are pure permission flips, so no balance seeding is required
  before(async () => {
    const protocol = await makeProtocol();
    comet = protocol.cometWithExtendedAssetList;
    [alice, bob, carol] = protocol.users;

    baseId = await snapshot();
  });

  // read-only: these never mutate storage, so no snapshot/revert is needed between them
  describe('defaults', function () {
    it('isAllowed defaults to false', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
    });

    it('allowance defaults to 0', async () => {
      expect(await comet.allowance(alice.address, bob.address)).to.equal(0);
    });

    it('hasPermission is false by default for others', async () => {
      expect(await comet.hasPermission(alice.address, bob.address)).to.be.false;
    });

    it('hasPermission is true for self', async () => {
      expect(await comet.hasPermission(alice.address, alice.address)).to.be.true;
    });

    it('allowance(self, self) is MaxUint256', async () => {
      expect(await comet.allowance(alice.address, alice.address)).to.equal(ethers.constants.MaxUint256);
    });
  });

  // happy path: allow(true).
  describe('happy path: allow grant', function () {
    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('executes without reverting', async () => {
      const txn = await comet.connect(alice).allow(bob.address, true);
      receipt = await txn.wait();
    });

    it('emits Approval with MaxUint256', async () => {
      expect(event({ receipt }, 0)).to.be.deep.equal({
        Approval: { owner: alice.address, spender: bob.address, amount: ethers.constants.MaxUint256.toBigInt() },
      });
    });

    it('sets isAllowed to true', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;
    });

    it('sets hasPermission to true', async () => {
      expect(await comet.hasPermission(alice.address, bob.address)).to.be.true;
    });

    it('sets allowance to MaxUint256', async () => {
      expect(await comet.allowance(alice.address, bob.address)).to.equal(ethers.constants.MaxUint256);
    });
  });

  // happy path: rescind. Prereq grant is seeded in `before`; the call under test runs once.
  describe('happy path: allow rescind', function () {
    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
      await comet.connect(alice).allow(bob.address, true);
    });

    it('executes without reverting', async () => {
      const txn = await comet.connect(alice).allow(bob.address, false);
      receipt = await txn.wait();
    });

    it('emits Approval with 0', async () => {
      expect(event({ receipt }, 0)).to.be.deep.equal({
        Approval: { owner: alice.address, spender: bob.address, amount: 0n },
      });
    });

    it('sets isAllowed to false', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
    });

    it('sets hasPermission to false', async () => {
      expect(await comet.hasPermission(alice.address, bob.address)).to.be.false;
    });

    it('sets allowance to 0', async () => {
      expect(await comet.allowance(alice.address, bob.address)).to.equal(0);
    });
  });

  describe('happy path: approve(max)', function () {
    let ret: boolean;

    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
      ret = await comet.connect(alice).callStatic.approve(bob.address, ethers.constants.MaxUint256);
    });

    it('executes without reverting', async () => {
      const txn = await comet.connect(alice).approve(bob.address, ethers.constants.MaxUint256);
      receipt = await txn.wait();
    });

    it('returns true', async () => {
      expect(ret).to.be.true;
    });

    it('emits Approval with MaxUint256', async () => {
      expect(event({ receipt }, 0)).to.be.deep.equal({
        Approval: { owner: alice.address, spender: bob.address, amount: ethers.constants.MaxUint256.toBigInt() },
      });
    });

    it('sets isAllowed to true', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;
    });

    it('sets allowance to MaxUint256', async () => {
      expect(await comet.allowance(alice.address, bob.address)).to.equal(ethers.constants.MaxUint256);
    });
  });

  // happy path: approve(0) after a grant disallows the spender.
  describe('happy path: approve(0)', function () {
    before(async () => {
      await revert(baseId);
      baseId = await snapshot();
      await comet.connect(alice).allow(bob.address, true);
    });

    it('executes without reverting', async () => {
      const txn = await comet.connect(alice).approve(bob.address, 0);
      receipt = await txn.wait();
    });

    it('emits Approval with 0', async () => {
      expect(event({ receipt }, 0)).to.be.deep.equal({
        Approval: { owner: alice.address, spender: bob.address, amount: 0n },
      });
    });

    it('sets isAllowed to false', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
    });

    it('sets allowance to 0', async () => {
      expect(await comet.allowance(alice.address, bob.address)).to.equal(0);
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
        comet.connect(alice).approve(bob.address, 1)
      ).to.be.revertedWith("custom error 'BadAmount()'");
    });

    it('reverts with BadAmount for 2', async () => {
      await expect(
        comet.connect(alice).approve(bob.address, 2)
      ).to.be.revertedWith("custom error 'BadAmount()'");
    });

    it('reverts with BadAmount for MaxUint256 - 1', async () => {
      await expect(
        comet.connect(alice).approve(bob.address, ethers.constants.MaxUint256.sub(1))
      ).to.be.revertedWith("custom error 'BadAmount()'");
    });

    it('reverts with BadAmount for 2**255', async () => {
      await expect(
        comet.connect(alice).approve(bob.address, ethers.BigNumber.from(2).pow(255))
      ).to.be.revertedWith("custom error 'BadAmount()'");
    });

    it('does not authorize the spender on the BadAmount path', async () => {
      await expect(
        comet.connect(alice).approve(bob.address, 1)
      ).to.be.revertedWith("custom error 'BadAmount()'");
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      expect(await comet.allowance(alice.address, bob.address)).to.equal(0);
    });
  });

  // idempotency / cycle / edge cases: each is an independent scenario from a clean env
  describe('allow edge cases', function () {
    afterEach(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('idempotent grant re-emits Approval(max) and stays allowed', async () => {
      await comet.connect(alice).allow(bob.address, true);
      const second = await (await comet.connect(alice).allow(bob.address, true)).wait();

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;
      expect(event({ receipt: second }, 0)).to.be.deep.equal({
        Approval: { owner: alice.address, spender: bob.address, amount: ethers.constants.MaxUint256.toBigInt() },
      });
    });

    it('idempotent revoke re-emits Approval(0) and stays disallowed', async () => {
      const txn = await (await comet.connect(alice).allow(bob.address, false)).wait();

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      expect(event({ receipt: txn }, 0)).to.be.deep.equal({
        Approval: { owner: alice.address, spender: bob.address, amount: 0n },
      });
    });

    it('handles a true -> false -> true cycle', async () => {
      await comet.connect(alice).allow(bob.address, true);
      await comet.connect(alice).allow(bob.address, false);
      await comet.connect(alice).allow(bob.address, true);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;
    });

    it('does not special-case the zero address', async () => {
      const txn = await (await comet.connect(alice).allow(ethers.constants.AddressZero, true)).wait();

      expect(await comet.isAllowed(alice.address, ethers.constants.AddressZero)).to.be.true;
      expect(event({ receipt: txn }, 0)).to.be.deep.equal({
        Approval: { owner: alice.address, spender: ethers.constants.AddressZero, amount: ethers.constants.MaxUint256.toBigInt() },
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
      await comet.connect(alice).approve(bob.address, ethers.constants.MaxUint256);
      await comet.connect(alice).allow(bob.address, false);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      expect(await comet.allowance(alice.address, bob.address)).to.equal(0);
    });

    it('allow(true) then approve(0) disallows', async () => {
      await comet.connect(alice).allow(bob.address, true);
      await comet.connect(alice).approve(bob.address, 0);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      expect(await comet.allowance(alice.address, bob.address)).to.equal(0);
    });

    it('approve(max) then allow(true) stays allowed', async () => {
      await comet.connect(alice).approve(bob.address, ethers.constants.MaxUint256);
      await comet.connect(alice).allow(bob.address, true);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;
      expect(await comet.allowance(alice.address, bob.address)).to.equal(ethers.constants.MaxUint256);
    });
  });

  // self-permission is implicit (owner == manager) and cannot be revoked
  describe('self-permission invariant', function () {
    afterEach(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('allow(self, false) does not revoke self-permission', async () => {
      await comet.connect(alice).allow(alice.address, false);

      expect(await comet.hasPermission(alice.address, alice.address)).to.be.true;
      expect(await comet.allowance(alice.address, alice.address)).to.equal(ethers.constants.MaxUint256);
    });

    it('approve(self, 0) does not revoke self-permission', async () => {
      await comet.connect(alice).approve(alice.address, 0);

      expect(await comet.hasPermission(alice.address, alice.address)).to.be.true;
      expect(await comet.allowance(alice.address, alice.address)).to.equal(ethers.constants.MaxUint256);
    });
  });

  // permissions are keyed per (owner, manager) and do not leak across either axis
  describe('isolation', function () {
    afterEach(async () => {
      await revert(baseId);
      baseId = await snapshot();
    });

    it('revoking one manager leaves another authorized', async () => {
      await comet.connect(alice).allow(bob.address, true);
      await comet.connect(alice).allow(carol.address, true);
      await comet.connect(alice).allow(bob.address, false);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      expect(await comet.isAllowed(alice.address, carol.address)).to.be.true;
    });

    it('a grant by one owner does not authorize the manager for another owner', async () => {
      // alice grants carol; bob never did
      await comet.connect(alice).allow(carol.address, true);

      expect(await comet.isAllowed(alice.address, carol.address)).to.be.true;
      expect(await comet.isAllowed(bob.address, carol.address)).to.be.false;
      expect(await comet.hasPermission(bob.address, carol.address)).to.be.false;
    });
  });
});
