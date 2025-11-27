import { CometExt, CometHarnessInterfaceExtendedAssetList } from 'build/types';
import { MAX_ASSETS, expect, makeProtocol } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

describe('collateral deactivation functionality', function () {
  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let cometExt: CometExt;

  // Signers
  let governor: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;

  // Constants
  const ASSET_INDEX = 0;

  before(async function () {
    const collaterals = Object.fromEntries(
      Array.from({ length: MAX_ASSETS }, (_, j) => [`ASSET${j}`, {}])
    );
    const protocol = await makeProtocol({
      assets: { USDC: {}, ...collaterals },
    });
    comet = protocol.cometWithExtendedAssetList;
    cometExt= comet.attach(comet.address) as CometExt;
    governor = protocol.governor;
    pauseGuardian = protocol.pauseGuardian;
  });

  describe('collateral deactivation', function () {
    describe('happy path', function () {
      let deactivateCollateralTx: ContractTransaction;
      it('allows to deactivate by pause guardian', async function () {
        deactivateCollateralTx = await cometExt.connect(pauseGuardian).deactivateCollateral(ASSET_INDEX);
        await expect(deactivateCollateralTx).to.not.be.reverted;
      });

      it('emits CollateralDeactivated event', async function () {
        expect(deactivateCollateralTx).to.emit(cometExt, 'CollateralDeactivated').withArgs(ASSET_INDEX);
      });

      it('emits CollateralAssetSupplyPauseAction event', async function () {
        expect(deactivateCollateralTx).to.emit(cometExt, 'CollateralAssetSupplyPauseAction').withArgs(ASSET_INDEX, true);
      });

      it('emits CollateralAssetTransferPauseAction event', async function () {
        expect(deactivateCollateralTx).to.emit(cometExt, 'CollateralAssetTransferPauseAction').withArgs(ASSET_INDEX, true);
      });

      it('sets collateral as deactivated in comet', async function () {
        expect(await comet.isCollateralDeactivated(ASSET_INDEX)).to.be.true;
      });

      it('updates deactivated collaterals flag in comet storage', async function () {
        expect(await comet.deactivatedCollaterals()).to.equal(1);
      });

      it('updates pause flags for deactivated collateral', async function () {
        expect(await comet.isCollateralAssetSupplyPaused(ASSET_INDEX)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(ASSET_INDEX)).to.be.true;
      });
    });

    describe('reverts when', function () {
      it('caller is not pause guardian', async function () {
        await expect(cometExt.connect(governor).deactivateCollateral(ASSET_INDEX)).to.be.revertedWithCustomError(cometExt, 'OnlyPauseGuardian');
      });

      it('asset index is invalid', async function () {
        await expect(cometExt.connect(pauseGuardian).deactivateCollateral(MAX_ASSETS)).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      });
    });
  });

  describe('collateral activation', function () {
    describe('happy path', function () {
      let activateCollateralTx: ContractTransaction;
      it('allows to activate by governor', async function () {
        activateCollateralTx = await cometExt.connect(governor).activateCollateral(ASSET_INDEX);
        await expect(activateCollateralTx).to.not.be.reverted;
      });

      it('emits CollateralActivated event', async function () {
        expect(activateCollateralTx).to.emit(cometExt, 'CollateralActivated').withArgs(ASSET_INDEX);
      });

      it('emits CollateralAssetSupplyPauseAction event', async function () {
        expect(activateCollateralTx).to.emit(cometExt, 'CollateralAssetSupplyPauseAction').withArgs(ASSET_INDEX, false);
      });

      it('emits CollateralAssetTransferPauseAction event', async function () {
        expect(activateCollateralTx).to.emit(cometExt, 'CollateralAssetTransferPauseAction').withArgs(ASSET_INDEX, false);
      });

      it('sets collateral as activated in comet', async function () {
        expect(await comet.isCollateralDeactivated(ASSET_INDEX)).to.be.false;
      });
      
      it('updates deactivated collaterals flag in comet storage', async function () {
        expect(await comet.deactivatedCollaterals()).to.equal(0);
      });

      it('updates pause flags for activated collateral', async function () {
        expect(await comet.isCollateralAssetSupplyPaused(ASSET_INDEX)).to.be.false;
        expect(await comet.isCollateralAssetTransferPaused(ASSET_INDEX)).to.be.false;
      });
    });

    describe('reverts when', function () {
      it('caller is not governor', async function () {
        await expect(cometExt.connect(pauseGuardian).activateCollateral(ASSET_INDEX)).to.be.revertedWithCustomError(cometExt, 'OnlyGovernor');
      });

      it('asset index is invalid', async function () {
        await expect(cometExt.connect(governor).activateCollateral(MAX_ASSETS)).to.be.revertedWithCustomError(cometExt, 'InvalidAssetIndex');
      });
    });
  });

  describe(`${MAX_ASSETS} assets support`, function () {
    describe('deactivation', function () {
      for (let i = 1; i <= MAX_ASSETS; i++) {
        it(`allows to deactivate for asset ${i}`, async function () {
          const assetIndex = i - 1;
              
          // Deactivate
          await cometExt.connect(pauseGuardian).deactivateCollateral(assetIndex);
              
          // Verify that the collateral at index i is deactivated
          expect(await comet.isCollateralDeactivated(assetIndex)).to.be.true;
        });
      }
    });

    describe('activation', function () {
      for (let i = 1; i <= MAX_ASSETS; i++) {
        it(`allows to activate for asset ${i}`, async function () {
          const assetIndex = i - 1;
                
          // Activate
          await cometExt.connect(governor).activateCollateral(assetIndex);
                
          // Verify that the collateral at index i is activated
          expect(await comet.isCollateralDeactivated(assetIndex)).to.be.false;
        });
      }
    });
  });
});