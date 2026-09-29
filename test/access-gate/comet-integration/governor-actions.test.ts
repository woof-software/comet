import { exp, expect, makeProtocol } from '../../helpers';
import { CometHarnessInterfaceExtendedAssetList, DefaultAccessGate, FaucetToken } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import { Action, NO_ASSET } from '../../helpers/access-gate';

// Comet checks the governor actions against its access gate: they pass when the gate permits them and revert
// with the gate error otherwise.
describe('comet with access gate: governor actions', function () {
  const RESERVES = exp(1_000, 6);
  const AMOUNT = exp(100, 6);

  let comet: CometHarnessInterfaceExtendedAssetList;
  let gate: DefaultAccessGate;
  let COMP: FaucetToken;
  let governor: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let alice: SignerWithAddress; // recipient of the reserves and approved manager

  let snapshot: SnapshotRestorer;

  before(async () => {
    const protocol = await makeProtocol();
    comet = protocol.cometWithExtendedAssetList;
    gate = protocol.accessGate;
    ({ governor, pauseGuardian } = protocol);
    [alice] = protocol.users;
    COMP = protocol.tokens.COMP as FaucetToken;

    await (protocol.tokens.USDC as FaucetToken).allocateTo(comet.address, RESERVES);

    snapshot = await takeSnapshot();
  });

  describe('withdrawReserves', function () {
    afterEach(async () => await snapshot.restore());

    it('the governor withdraws reserves to Alice', async () => {
      await expect(comet.connect(governor).withdrawReserves(alice.address, AMOUNT)).to.not.be.reverted;
    });

    it('reverts when WITHDRAW_RESERVES is paused', async () => {
      await gate.connect(pauseGuardian).setActionPaused(Action.WITHDRAW_RESERVES, true);
      await expect(comet.connect(governor).withdrawReserves(alice.address, AMOUNT))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.WITHDRAW_RESERVES, NO_ASSET);
    });
  });

  describe('approveThis', function () {
    afterEach(async () => await snapshot.restore());

    it('the governor approves COMP to Alice', async () => {
      await expect(comet.connect(governor).approveThis(alice.address, COMP.address, AMOUNT)).to.not.be.reverted;
    });

    it('reverts when APPROVE_THIS is paused', async () => {
      await gate.connect(pauseGuardian).setActionPaused(Action.APPROVE_THIS, true);
      await expect(comet.connect(governor).approveThis(alice.address, COMP.address, AMOUNT))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.APPROVE_THIS, NO_ASSET);
    });
  });
});
