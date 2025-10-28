import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect, makeProtocol } from "./helpers";
import { takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { CometExt, CometHarnessInterfaceExtendedAssetList } from "build/types";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

describe("Extended Pause Functionality", function () {
  // Snapshot
  let snapshot: SnapshotRestorer;

  // Contracts
  let comet: CometHarnessInterfaceExtendedAssetList;
  let cometExt: CometExt;

  // Signers
  let governor: SignerWithAddress;
  let pauseGuardian: SignerWithAddress;
  let users: SignerWithAddress[] = [];

  // Constants
  const assetIndex = 0;

  before(async function () {
    const assets = {
      USDC: {},
      ASSET1: {},
      ASSET2: {},
      ASSET3: {},
    };

    const protocol = await makeProtocol({ assets });
    comet = protocol.cometWithExtendedAssetList;
    cometExt = comet.attach(comet.address) as CometExt;
    governor = protocol.governor;
    pauseGuardian = protocol.pauseGuardian;
    users = protocol.users;

    snapshot = await takeSnapshot();
  });

  describe("Withdraw Pause Functions", function () {
    describe("pauseLendersWithdraw", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.false;
        });

        it("allows governor to call pauseLendersWithdraw", async function () {
          await expect(cometExt.connect(governor).pauseLendersWithdraw(true)).to
            .not.be.reverted;

          await snapshot.restore();
        });

        it("emits LendersWithdrawPauseAction event when pausing by governor", async function () {
          expect(await cometExt.connect(governor).pauseLendersWithdraw(true))
            .to.emit(cometExt, "LendersWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await cometExt.connect(governor).pauseLendersWithdraw(false);
        });

        it("sets to false when pausing by governor", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseLendersWithdraw", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersWithdraw(true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits LendersWithdrawPauseAction event when pausing by pause guardian", async function () {
          expect(
            await cometExt.connect(pauseGuardian).pauseLendersWithdraw(true)
          )
            .to.emit(cometExt, "LendersWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await cometExt.connect(pauseGuardian).pauseLendersWithdraw(false);
        });

        it("sets to false when pausing by pause guardian", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.false;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt.connect(users[0]).pauseLendersWithdraw(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt.connect(governor).pauseLendersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseBorrowersWithdraw", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
        });

        it("allows governor to call pauseBorrowersWithdraw", async function () {
          await expect(cometExt.connect(governor).pauseBorrowersWithdraw(true))
            .to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits BorrowersWithdrawPauseAction event when pausing by governor", async function () {
          await expect(cometExt.connect(governor).pauseBorrowersWithdraw(true))
            .to.emit(cometExt, "BorrowersWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await cometExt.connect(governor).pauseBorrowersWithdraw(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseBorrowersWithdraw", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits BorrowersWithdrawPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(true)
          )
            .to.emit(cometExt, "BorrowersWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.false;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt.connect(users[0]).pauseBorrowersWithdraw(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt.connect(governor).pauseBorrowersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralWithdraw", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.false;
        });

        it("allows governor to call pauseCollateralWithdraw", async function () {
          await expect(cometExt.connect(governor).pauseCollateralWithdraw(true))
            .to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralWithdrawPauseAction event when pausing by governor", async function () {
          await expect(cometExt.connect(governor).pauseCollateralWithdraw(true))
            .to.emit(cometExt, "CollateralWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await cometExt.connect(governor).pauseCollateralWithdraw(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseCollateralWithdraw", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralWithdraw(true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralWithdrawPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralWithdraw(true)
          )
            .to.emit(cometExt, "CollateralWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.true;
        });

        it("allows governor to unpause after pause guardian", async function () {
          await cometExt.connect(governor).pauseCollateralWithdraw(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.false;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralWithdraw(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralAssetWithdraw", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .false;
        });

        it("allows governor to call pauseCollateralAssetWithdraw", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralAssetWithdrawPauseAction event when pausing by governor", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, true)
          )
            .to.emit(cometExt, "CollateralAssetWithdrawPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause", async function () {
          await cometExt
            .connect(governor)
            .pauseCollateralAssetWithdraw(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseCollateralAssetWithdraw", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetWithdraw(assetIndex, true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralAssetWithdrawPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetWithdraw(assetIndex, true)
          )
            .to.emit(cometExt, "CollateralAssetWithdrawPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause after pause guardian", async function () {
          await cometExt
            .connect(governor)
            .pauseCollateralAssetWithdraw(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .false;

          await snapshot.restore();
        });

        it("handles multiple asset indices independently", async function () {
          await cometExt
            .connect(governor)
            .pauseCollateralAssetWithdraw(0, true);
          expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.true;
          expect(await comet.isCollateralAssetWithdrawPaused(1)).to.be.false;

          await cometExt
            .connect(governor)
            .pauseCollateralAssetWithdraw(1, true);
          expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.true;
          expect(await comet.isCollateralAssetWithdrawPaused(1)).to.be.true;

          await cometExt
            .connect(governor)
            .pauseCollateralAssetWithdraw(0, false);
          expect(await comet.isCollateralAssetWithdrawPaused(0)).to.be.false;
          expect(await comet.isCollateralAssetWithdrawPaused(1)).to.be.true;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt
              .connect(users[0])
              .pauseCollateralAssetWithdraw(assetIndex, true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            "CollateralAssetOffsetStatusAlreadySet"
          );
        });

        it("reverts with InvalidAssetIndex when assetIndex >= numAssets", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(await comet.numAssets(), true)
          ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
        });
      });
    });
  });

  describe("Supply Pause Functions", function () {
    describe("pauseCollateralSupply", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.false;
        });

        it("allows governor to call pauseCollateralSupply", async function () {
          await expect(cometExt.connect(governor).pauseCollateralSupply(true))
            .to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits LendersSupplyPauseAction event when pausing by governor", async function () {
          await expect(cometExt.connect(governor).pauseCollateralSupply(true))
            .to.emit(cometExt, "LendersSupplyPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await cometExt.connect(governor).pauseCollateralSupply(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseCollateralSupply", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralSupply(true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits LendersSupplyPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralSupply(true)
          )
            .to.emit(cometExt, "LendersSupplyPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await cometExt.connect(pauseGuardian).pauseCollateralSupply(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.false;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralSupply(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralSupply(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseBaseSupply", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.false;
        });

        it("allows governor to call pauseBaseSupply", async function () {
          await expect(cometExt.connect(governor).pauseBaseSupply(true)).to.not
            .be.reverted;

          await snapshot.restore();
        });

        it("emits BorrowersSupplyPauseAction event when pausing by governor", async function () {
          await expect(cometExt.connect(governor).pauseBaseSupply(true))
            .to.emit(cometExt, "BorrowersSupplyPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await cometExt.connect(governor).pauseBaseSupply(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseBaseSupply", async function () {
          await expect(cometExt.connect(pauseGuardian).pauseBaseSupply(true)).to
            .not.be.reverted;

          await snapshot.restore();
        });

        it("emits BorrowersSupplyPauseAction event when pausing by pause guardian", async function () {
          await expect(cometExt.connect(pauseGuardian).pauseBaseSupply(true))
            .to.emit(cometExt, "BorrowersSupplyPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await cometExt.connect(pauseGuardian).pauseBaseSupply(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.false;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt.connect(users[0]).pauseBaseSupply(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt.connect(governor).pauseBaseSupply(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralAssetSupply", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .false;
        });

        it("allows governor to call pauseCollateralAssetSupply", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralAssetSupplyPauseAction event when pausing by governor", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, true)
          )
            .to.emit(cometExt, "CollateralAssetSupplyPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause", async function () {
          await cometExt
            .connect(governor)
            .pauseCollateralAssetSupply(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseCollateralAssetSupply", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetSupply(assetIndex, true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralAssetSupplyPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetSupply(assetIndex, true)
          )
            .to.emit(cometExt, "CollateralAssetSupplyPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause after pause guardian", async function () {
          await cometExt
            .connect(governor)
            .pauseCollateralAssetSupply(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .false;

          await snapshot.restore();
        });

        it("handles multiple asset indices independently", async function () {
          await cometExt.connect(governor).pauseCollateralAssetSupply(0, true);
          expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.true;
          expect(await comet.isCollateralAssetSupplyPaused(1)).to.be.false;

          await cometExt.connect(governor).pauseCollateralAssetSupply(1, true);
          expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.true;
          expect(await comet.isCollateralAssetSupplyPaused(1)).to.be.true;

          await cometExt.connect(governor).pauseCollateralAssetSupply(0, false);
          expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.false;
          expect(await comet.isCollateralAssetSupplyPaused(1)).to.be.true;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt
              .connect(users[0])
              .pauseCollateralAssetSupply(assetIndex, true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            "CollateralAssetOffsetStatusAlreadySet"
          );
        });

        it("reverts with InvalidAssetIndex when assetIndex >= numAssets", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(await comet.numAssets(), true)
          ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
        });
      });
    });
  });

  describe("Transfer Pause Functions", function () {
    describe("pauseLendersTransfer", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.false;
        });

        it("allows governor to call pauseLendersTransfer", async function () {
          await expect(cometExt.connect(governor).pauseLendersTransfer(true)).to
            .not.be.reverted;

          await snapshot.restore();
        });

        it("emits LendersTransferPauseAction event when pausing by governor", async function () {
          await expect(cometExt.connect(governor).pauseLendersTransfer(true))
            .to.emit(cometExt, "LendersTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await cometExt.connect(governor).pauseLendersTransfer(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseLendersTransfer", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersTransfer(true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits LendersTransferPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersTransfer(true)
          )
            .to.emit(cometExt, "LendersTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await cometExt.connect(pauseGuardian).pauseLendersTransfer(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.false;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt.connect(users[0]).pauseLendersTransfer(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt.connect(governor).pauseLendersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseBorrowersTransfer", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.false;
        });

        it("allows governor to call pauseBorrowersTransfer", async function () {
          await expect(cometExt.connect(governor).pauseBorrowersTransfer(true))
            .to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits BorrowersTransferPauseAction event when pausing by governor", async function () {
          await expect(cometExt.connect(governor).pauseBorrowersTransfer(true))
            .to.emit(cometExt, "BorrowersTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await cometExt.connect(governor).pauseBorrowersTransfer(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseBorrowersTransfer", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersTransfer(true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits BorrowersTransferPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersTransfer(true)
          )
            .to.emit(cometExt, "BorrowersTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await cometExt.connect(pauseGuardian).pauseBorrowersTransfer(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.false;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt.connect(users[0]).pauseBorrowersTransfer(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt.connect(governor).pauseBorrowersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralTransfer", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.false;
        });

        it("allows governor to call pauseCollateralTransfer", async function () {
          await expect(cometExt.connect(governor).pauseCollateralTransfer(true))
            .to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralTransferPauseAction event when pausing by governor", async function () {
          await expect(cometExt.connect(governor).pauseCollateralTransfer(true))
            .to.emit(cometExt, "CollateralTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await cometExt.connect(governor).pauseCollateralTransfer(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseCollateralTransfer", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralTransfer(true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralTransferPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralTransfer(true)
          )
            .to.emit(cometExt, "CollateralTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await cometExt.connect(pauseGuardian).pauseCollateralTransfer(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.false;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt.connect(users[0]).pauseCollateralTransfer(true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralAssetTransfer", function () {
      describe("happy cases", function () {
        it("is false by default", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .false;
        });

        it("allows governor to call pauseCollateralAssetTransfer", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralAssetTransferPauseAction event when pausing by governor", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, true)
          )
            .to.emit(cometExt, "CollateralAssetTransferPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause", async function () {
          await cometExt
            .connect(governor)
            .pauseCollateralAssetTransfer(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .false;

          await snapshot.restore();
        });

        it("allows pause guardian to call pauseCollateralAssetTransfer", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetTransfer(assetIndex, true)
          ).to.not.be.reverted;

          await snapshot.restore();
        });

        it("emits CollateralAssetTransferPauseAction event when pausing by pause guardian", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetTransfer(assetIndex, true)
          )
            .to.emit(cometExt, "CollateralAssetTransferPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .true;
        });

        it("allows pause guardian to unpause", async function () {
          await cometExt
            .connect(pauseGuardian)
            .pauseCollateralAssetTransfer(assetIndex, false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .false;

          await snapshot.restore();
        });

        it("handles multiple asset indices independently", async function () {
          await cometExt
            .connect(governor)
            .pauseCollateralAssetTransfer(0, true);
          expect(await comet.isCollateralAssetTransferPaused(0)).to.be.true;
          expect(await comet.isCollateralAssetTransferPaused(1)).to.be.false;

          await cometExt
            .connect(governor)
            .pauseCollateralAssetTransfer(1, true);
          expect(await comet.isCollateralAssetTransferPaused(0)).to.be.true;
          expect(await comet.isCollateralAssetTransferPaused(1)).to.be.true;

          await cometExt
            .connect(governor)
            .pauseCollateralAssetTransfer(0, false);
          expect(await comet.isCollateralAssetTransferPaused(0)).to.be.false;
          expect(await comet.isCollateralAssetTransferPaused(1)).to.be.true;

          await snapshot.restore();
        });
      });

      describe("revert cases", function () {
        it("reverts when called by unauthorized user", async function () {
          await expect(
            cometExt
              .connect(users[0])
              .pauseCollateralAssetTransfer(assetIndex, true)
          ).to.be.revertedWithCustomError(
            cometExt,
            "OnlyPauseGuardianOrGovernor"
          );
        });

        it("reverts duplicate status setting", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            "CollateralAssetOffsetStatusAlreadySet"
          );
        });

        it("reverts with InvalidAssetIndex when assetIndex >= numAssets", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(await comet.numAssets(), true)
          ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
        });
      });
    });
  });

  describe("isValidAssetIndex", function () {
    it("should work with 3 collaterals - set pauses for all assets", async function () {
      // Create a new comet with 3 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
      };

      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      for (let i = 0; i < numAssets; i++) {
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(i, true);
        await cometExt.connect(governor).pauseCollateralAssetSupply(i, true);
        await cometExt.connect(governor).pauseCollateralAssetTransfer(i, true);
      }

      // Verify the pause states are set correctly
      for (let i = 0; i < numAssets; i++) {
        expect(await comet.isCollateralAssetWithdrawPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetSupplyPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(i)).to.be.true;
      }
    });

    it("should work with 5 collaterals - set pauses for all assets", async function () {
      // Create a new comet with 5 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
      };

      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      for (let i = 0; i < numAssets; i++) {
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(i, true);
        await cometExt.connect(governor).pauseCollateralAssetSupply(i, true);
        await cometExt.connect(governor).pauseCollateralAssetTransfer(i, true);
      }

      // Verify the pause states are set correctly
      for (let i = 0; i < numAssets; i++) {
        expect(await comet.isCollateralAssetWithdrawPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetSupplyPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(i)).to.be.true;
      }
    });

    it("should work with 10 collaterals - set pauses for all assets", async function () {
      // Create a new comet with 10 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
      };

      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      for (let i = 0; i < numAssets; i++) {
        await cometExt.connect(governor).pauseCollateralAssetWithdraw(i, true);
        await cometExt.connect(governor).pauseCollateralAssetSupply(i, true);
        await cometExt.connect(governor).pauseCollateralAssetTransfer(i, true);
      }

      for (let i = 0; i < numAssets; i++) {
        expect(await comet.isCollateralAssetWithdrawPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetSupplyPaused(i)).to.be.true;
        expect(await comet.isCollateralAssetTransferPaused(i)).to.be.true;
      }
    });

    it("should revert with InvalidAssetIndex for asset index numAssets+1 with 3 collaterals", async function () {
      // Create a new comet with 3 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
      };

      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetTransfer(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetWithdraw(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
    });

    it("should revert with InvalidAssetIndex for asset index numAssets+1 with 5 collaterals", async function () {
      // Create a new comet with 5 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
      };
      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetTransfer(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetWithdraw(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
    });

    it("should revert with InvalidAssetIndex for asset index numAssets+1 with 10 collaterals", async function () {
      // Create a new comet with 10 collaterals
      const assets = {
        USDC: {},
        ASSET1: {},
        ASSET2: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
        ASSET10: {},
      };
      const protocol = await makeProtocol({ assets });
      const comet = protocol.cometWithExtendedAssetList;
      const cometExt = comet.attach(comet.address) as CometExt;
      const governor = protocol.governor;

      const numAssets = await comet.numAssets();

      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetSupply(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetTransfer(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
      await expect(
        cometExt
          .connect(governor)
          .pauseCollateralAssetWithdraw(numAssets + 1, true)
      ).to.be.revertedWithCustomError(cometExt, "InvalidAssetIndex");
    });
  });

  describe("Edge cases", function () {
    it("should allow setting multiple pause flags simultaneously", async function () {
      // Set multiple pause flags
      await cometExt.connect(governor).pauseLendersWithdraw(true);
      await cometExt.connect(governor).pauseBorrowersWithdraw(true);
      await cometExt.connect(governor).pauseCollateralSupply(true);
      await cometExt.connect(governor).pauseBaseSupply(true);
      await cometExt.connect(governor).pauseLendersTransfer(true);
      await cometExt.connect(governor).pauseBorrowersTransfer(true);

      // Verify all are set
      expect(await comet.isLendersWithdrawPaused()).to.be.true;
      expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
      expect(await comet.isCollateralSupplyPaused()).to.be.true;
      expect(await comet.isBaseSupplyPaused()).to.be.true;
      expect(await comet.isLendersTransferPaused()).to.be.true;
      expect(await comet.isBorrowersTransferPaused()).to.be.true;

      await snapshot.restore();
    });

    it("should allow toggling pause flags multiple times", async function () {
      // Toggle multiple times
      await cometExt.connect(governor).pauseLendersWithdraw(true);
      expect(await comet.isLendersWithdrawPaused()).to.be.true;

      await cometExt.connect(governor).pauseLendersWithdraw(false);
      expect(await comet.isLendersWithdrawPaused()).to.be.false;

      await cometExt.connect(governor).pauseLendersWithdraw(true);
      expect(await comet.isLendersWithdrawPaused()).to.be.true;

      await cometExt.connect(governor).pauseLendersWithdraw(false);
      expect(await comet.isLendersWithdrawPaused()).to.be.false;

      await snapshot.restore();
    });
  });
});
