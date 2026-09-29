import { ethers, exp, expect, makeProtocol } from '../../helpers';
import { CometHarnessInterfaceExtendedAssetList, DefaultAccessGate, FaucetToken } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { takeSnapshot, SnapshotRestorer } from '../../helpers/snapshot';
import { Action, NO_ASSET } from '../../helpers/access-gate';

// Comet checks absorb and buyCollateral against its access gate: they pass when the gate permits them and revert
// with the gate error otherwise.
describe('comet with access gate: absorb and buyCollateral', function () {
  const LENT = exp(10_000, 6);
  const BORROWED = exp(2_000, 6);
  const PAID = exp(100, 6);
  const COLLATERAL = exp(1, 18);
  const WETH_PRICE_DROPPED = exp(1_000, 8);

  let comet: CometHarnessInterfaceExtendedAssetList;
  let gate: DefaultAccessGate;
  let USDC: FaucetToken;
  let WETH: FaucetToken;
  let pauseGuardian: SignerWithAddress;
  let alice: SignerWithAddress; // lender of LENT
  let bob: SignerWithAddress; // borrower of BORROWED against WETH, underwater after the WETH price drop
  let charlie: SignerWithAddress; // absorbs Bob and buys collateral
  let dave: SignerWithAddress; // absorber and recipient of the bought collateral
  let wethIndex: number;

  let snapshot: SnapshotRestorer;

  before(async () => {
    const protocol = await makeProtocol();
    comet = protocol.cometWithExtendedAssetList;
    gate = protocol.accessGate;
    pauseGuardian = protocol.pauseGuardian;
    [alice, bob, charlie, dave] = protocol.users;
    USDC = protocol.tokens.USDC as FaucetToken;
    WETH = protocol.tokens.WETH as FaucetToken;
    wethIndex = (await comet.getAssetInfoByAddress(WETH.address)).offset;

    for (const user of [alice, charlie]) {
      await USDC.allocateTo(user.address, LENT);
      await USDC.connect(user).approve(comet.address, ethers.constants.MaxUint256);
    }
    await WETH.allocateTo(bob.address, COLLATERAL);
    await WETH.connect(bob).approve(comet.address, COLLATERAL);

    await comet.connect(alice).supply(USDC.address, LENT);
    await comet.connect(bob).supply(WETH.address, COLLATERAL);
    await comet.connect(bob).withdraw(USDC.address, BORROWED);
    await protocol.priceFeeds.WETH.setRoundData(0, WETH_PRICE_DROPPED, 0, 0, 0);

    snapshot = await takeSnapshot();
  });

  describe('absorb', function () {
    afterEach(async () => await snapshot.restore());

    it('Charlie absorbs Bob with Dave as the absorber', async () => {
      await expect(comet.connect(charlie).absorb(dave.address, [bob.address])).to.not.be.reverted;
    });

    it('reverts when ABSORB is paused', async () => {
      await gate.connect(pauseGuardian).setActionPaused(Action.ABSORB, true);
      await expect(comet.connect(charlie).absorb(dave.address, [bob.address]))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.ABSORB, NO_ASSET);
    });
  });

  // Absorbing Bob moves his WETH to the protocol reserves, which are then below the target and for sale.
  describe('buyCollateral', function () {
    beforeEach(async () => {
      await comet.connect(charlie).absorb(dave.address, [bob.address]);
    });

    afterEach(async () => await snapshot.restore());

    it('Charlie buys WETH for Dave', async () => {
      await expect(comet.connect(charlie).buyCollateral(WETH.address, 0, PAID, dave.address)).to.not.be.reverted;
    });

    it('reverts when BUY_COLLATERAL is paused for WETH', async () => {
      await gate.connect(pauseGuardian).setCollateralPaused(Action.BUY_COLLATERAL, wethIndex, true);
      await expect(comet.connect(charlie).buyCollateral(WETH.address, 0, PAID, dave.address))
        .to.be.revertedWithCustomError(gate, 'Paused').withArgs(Action.BUY_COLLATERAL, wethIndex);
    });
  });
});
