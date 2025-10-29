import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expect, makeProtocol } from "./helpers";
import { takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { CometExt, CometHarnessInterfaceExtendedAssetList } from "build/types";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { ContractTransaction } from "ethers";

describe("extended pause functionality", function () {
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

  let maxAssets: number;

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

    maxAssets = await comet.maxAssets();

    snapshot = await takeSnapshot();
  });

  describe("withdraw pause functions", function () {
    describe("pauseLendersWithdraw", function () {
      describe("happy cases", function () {
        let pauseLendersWithdrawTx: ContractTransaction;

        it("allows governor to call pauseLendersWithdraw", async function () {
          pauseLendersWithdrawTx = await cometExt
            .connect(governor)
            .pauseLendersWithdraw(true);
          await expect(pauseLendersWithdrawTx).to.not.be.reverted;
        });

        it("emits LendersWithdrawPauseAction event when pausing by governor", async function () {
          expect(pauseLendersWithdrawTx)
            .to.emit(cometExt, "LendersWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await expect(cometExt.connect(governor).pauseLendersWithdraw(false))
            .to.emit(cometExt, "LendersWithdrawPauseAction")
            .withArgs(false);
        });

        it("sets to false when pausing by governor", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.false;
        });

        it("allows pause guardian to call pauseLendersWithdraw", async function () {
          pauseLendersWithdrawTx = await cometExt
            .connect(pauseGuardian)
            .pauseLendersWithdraw(true);

          await expect(pauseLendersWithdrawTx).to.not.be.reverted;
        });

        it("emits LendersWithdrawPauseAction event when pausing by pause guardian", async function () {
          expect(pauseLendersWithdrawTx)
            .to.emit(cometExt, "LendersWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersWithdraw(false)
          )
            .to.emit(cometExt, "LendersWithdrawPauseAction")
            .withArgs(false);
        });

        it("sets to false when pausing by pause guardian", async function () {
          expect(await comet.isLendersWithdrawPaused()).to.be.false;
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt.connect(governor).pauseLendersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseBorrowersWithdraw", function () {
      describe("happy cases", function () {
        let pauseBorrowersWithdrawTx: ContractTransaction;

        it("allows governor to call pauseBorrowersWithdraw", async function () {
          pauseBorrowersWithdrawTx = await cometExt
            .connect(governor)
            .pauseBorrowersWithdraw(true);
          await expect(pauseBorrowersWithdrawTx).to.not.be.reverted;
        });

        it("emits BorrowersWithdrawPauseAction event when pausing by governor", async function () {
          expect(pauseBorrowersWithdrawTx)
            .to.emit(cometExt, "BorrowersWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await expect(cometExt.connect(governor).pauseBorrowersWithdraw(false))
            .to.emit(cometExt, "BorrowersWithdrawPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
        });

        it("allows pause guardian to call pauseBorrowersWithdraw", async function () {
          pauseBorrowersWithdrawTx = await cometExt
            .connect(pauseGuardian)
            .pauseBorrowersWithdraw(true);
          await expect(pauseBorrowersWithdrawTx).to.not.be.reverted;
        });

        it("emits BorrowersWithdrawPauseAction event when pausing by pause guardian", async function () {
          expect(pauseBorrowersWithdrawTx)
            .to.emit(cometExt, "BorrowersWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(false)
          )
            .to.emit(cometExt, "BorrowersWithdrawPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isBorrowersWithdrawPaused()).to.be.false;
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt.connect(governor).pauseBorrowersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralWithdraw", function () {
      describe("happy cases", function () {
        let pauseCollateralWithdrawTx: ContractTransaction;

        it("allows governor to call pauseCollateralWithdraw", async function () {
          pauseCollateralWithdrawTx = await cometExt
            .connect(governor)
            .pauseCollateralWithdraw(true);
          await expect(pauseCollateralWithdrawTx).to.not.be.reverted;
        });

        it("emits CollateralWithdrawPauseAction event when pausing by governor", async function () {
          expect(pauseCollateralWithdrawTx)
            .to.emit(cometExt, "CollateralWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralWithdraw(false)
          )
            .to.emit(cometExt, "CollateralWithdrawPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.false;
        });

        it("allows pause guardian to call pauseCollateralWithdraw", async function () {
          pauseCollateralWithdrawTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralWithdraw(true);
          await expect(pauseCollateralWithdrawTx).to.not.be.reverted;
        });

        it("emits CollateralWithdrawPauseAction event when pausing by pause guardian", async function () {
          expect(pauseCollateralWithdrawTx)
            .to.emit(cometExt, "CollateralWithdrawPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.true;
        });

        it("allows governor to unpause after pause guardian", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralWithdraw(false)
          )
            .to.emit(cometExt, "CollateralWithdrawPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralWithdrawPaused()).to.be.false;
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralWithdraw(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralAssetWithdraw", function () {
      describe("happy cases", function () {
        let pauseCollateralAssetWithdrawTx: ContractTransaction;

        it("allows governor to call pauseCollateralAssetWithdraw", async function () {
          pauseCollateralAssetWithdrawTx = await cometExt
            .connect(governor)
            .pauseCollateralAssetWithdraw(assetIndex, true);
          await expect(pauseCollateralAssetWithdrawTx).to.not.be.reverted;
        });

        it("emits CollateralAssetWithdrawPauseAction event when pausing by governor", async function () {
          expect(pauseCollateralAssetWithdrawTx)
            .to.emit(cometExt, "CollateralAssetWithdrawPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, false)
          )
            .to.emit(cometExt, "CollateralAssetWithdrawPauseAction")
            .withArgs(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .false;
        });

        it("allows pause guardian to call pauseCollateralAssetWithdraw", async function () {
          pauseCollateralAssetWithdrawTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralAssetWithdraw(assetIndex, true);
          await expect(pauseCollateralAssetWithdrawTx).to.not.be.reverted;
        });

        it("emits CollateralAssetWithdrawPauseAction event when pausing by pause guardian", async function () {
          expect(pauseCollateralAssetWithdrawTx)
            .to.emit(cometExt, "CollateralAssetWithdrawPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause after pause guardian", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, false)
          )
            .to.emit(cometExt, "CollateralAssetWithdrawPauseAction")
            .withArgs(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to.be
            .false;

          await snapshot.restore();
        });

        for (let i = 1; i <= 24; i++) {
          it(`allows to call pauseCollateralAssetWithdraw for asset ${i} with ${i} collaterals`, async function () {
            // Create collaterals: ASSET0, ASSET1, ..., ASSET{i-1}
            const collaterals = Object.fromEntries(
              Array.from({ length: i }, (_, j) => [`ASSET${j}`, {}])
            );

            // Create protocol with USDC (base token) + i collaterals
            const protocol = await makeProtocol({
              assets: { USDC: {}, ...collaterals },
            });

            const comet = protocol.cometWithExtendedAssetList;
            const cometExt = comet.attach(comet.address) as CometExt;
            const governor = protocol.governor;
            const assetIndex = i - 1;

            // Verify we have i collaterals
            const numAssets = await comet.numAssets();
            expect(numAssets).to.be.equal(i);

            // Pause the collateral at index i
            await cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, true);

            // Verify that the asset at index i is paused
            expect(await comet.isCollateralAssetWithdrawPaused(assetIndex)).to
              .be.true;
          });
        }
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetWithdraw(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            "CollateralAssetOffsetStatusAlreadySet"
          );
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
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

  describe("supply pause functions", function () {
    describe("pauseCollateralSupply", function () {
      describe("happy cases", function () {
        let pauseCollateralSupplyTx: ContractTransaction;

        it("allows governor to call pauseCollateralSupply", async function () {
          pauseCollateralSupplyTx = await cometExt
            .connect(governor)
            .pauseCollateralSupply(true);
          await expect(pauseCollateralSupplyTx).to.not.be.reverted;
        });

        it("emits LendersSupplyPauseAction event when pausing by governor", async function () {
          expect(pauseCollateralSupplyTx)
            .to.emit(cometExt, "LendersSupplyPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await expect(cometExt.connect(governor).pauseCollateralSupply(false))
            .to.emit(cometExt, "LendersSupplyPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.false;
        });

        it("allows pause guardian to call pauseCollateralSupply", async function () {
          pauseCollateralSupplyTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralSupply(true);
          await expect(pauseCollateralSupplyTx).to.not.be.reverted;
        });

        it("emits LendersSupplyPauseAction event when pausing by pause guardian", async function () {
          expect(pauseCollateralSupplyTx)
            .to.emit(cometExt, "LendersSupplyPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralSupply(false)
          )
            .to.emit(cometExt, "LendersSupplyPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isCollateralSupplyPaused()).to.be.false;
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralSupply(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralSupply(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseBaseSupply", function () {
      describe("happy cases", function () {
        let pauseBaseSupplyTx: ContractTransaction;

        it("allows governor to call pauseBaseSupply", async function () {
          pauseBaseSupplyTx = await cometExt
            .connect(governor)
            .pauseBaseSupply(true);
          await expect(pauseBaseSupplyTx).to.not.be.reverted;
        });

        it("emits BorrowersSupplyPauseAction event when pausing by governor", async function () {
          expect(pauseBaseSupplyTx)
            .to.emit(cometExt, "BorrowersSupplyPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await expect(cometExt.connect(governor).pauseBaseSupply(false))
            .to.emit(cometExt, "BorrowersSupplyPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.false;
        });

        it("allows pause guardian to call pauseBaseSupply", async function () {
          pauseBaseSupplyTx = await cometExt
            .connect(pauseGuardian)
            .pauseBaseSupply(true);
          await expect(pauseBaseSupplyTx).to.not.be.reverted;
        });

        it("emits BorrowersSupplyPauseAction event when pausing by pause guardian", async function () {
          expect(pauseBaseSupplyTx)
            .to.emit(cometExt, "BorrowersSupplyPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(cometExt.connect(pauseGuardian).pauseBaseSupply(false))
            .to.emit(cometExt, "BorrowersSupplyPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isBaseSupplyPaused()).to.be.false;
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt.connect(governor).pauseBaseSupply(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBaseSupply(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralAssetSupply", function () {
      describe("happy cases", function () {
        let pauseCollateralAssetSupplyTx: ContractTransaction;

        it("allows governor to call pauseCollateralAssetSupply", async function () {
          pauseCollateralAssetSupplyTx = await cometExt
            .connect(governor)
            .pauseCollateralAssetSupply(assetIndex, true);
          await expect(pauseCollateralAssetSupplyTx).to.not.be.reverted;
        });

        it("emits CollateralAssetSupplyPauseAction event when pausing by governor", async function () {
          expect(pauseCollateralAssetSupplyTx)
            .to.emit(cometExt, "CollateralAssetSupplyPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, false)
          )
            .to.emit(cometExt, "CollateralAssetSupplyPauseAction")
            .withArgs(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .false;
        });

        it("allows pause guardian to call pauseCollateralAssetSupply", async function () {
          pauseCollateralAssetSupplyTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralAssetSupply(assetIndex, true);
          await expect(pauseCollateralAssetSupplyTx).to.not.be.reverted;
        });

        it("emits CollateralAssetSupplyPauseAction event when pausing by pause guardian", async function () {
          expect(pauseCollateralAssetSupplyTx)
            .to.emit(cometExt, "CollateralAssetSupplyPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetSupply(assetIndex, false)
          )
            .to.emit(cometExt, "CollateralAssetSupplyPauseAction")
            .withArgs(assetIndex, false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
            .false;
        });

        for (let i = 1; i <= 24; i++) {
          it(`allows to call pauseCollateralAssetSupply for asset ${i} with ${i} collaterals`, async function () {
            const collaterals = Object.fromEntries(
              Array.from({ length: i }, (_, j) => [`ASSET${j}`, {}])
            );

            const protocol = await makeProtocol({
              assets: { USDC: {}, ...collaterals },
            });

            const comet = protocol.cometWithExtendedAssetList;
            const cometExt = comet.attach(comet.address) as CometExt;
            const governor = protocol.governor;
            const assetIndex = i - 1;

            // Verify we have i collaterals
            const numAssets = await comet.numAssets();
            expect(numAssets).to.be.equal(i);

            // Pause the collateral at index i
            await cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, true);

            // Verify that the asset at index i is paused
            expect(await comet.isCollateralAssetSupplyPaused(assetIndex)).to.be
              .true;
          });
        }
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetSupply(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            "CollateralAssetOffsetStatusAlreadySet"
          );
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
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

  describe("transfer pause functions", function () {
    describe("pauseLendersTransfer", function () {
      describe("happy cases", function () {
        let pauseLendersTransferTx: ContractTransaction;

        it("allows governor to call pauseLendersTransfer", async function () {
          pauseLendersTransferTx = await cometExt
            .connect(governor)
            .pauseLendersTransfer(true);
          await expect(pauseLendersTransferTx).to.not.be.reverted;
        });

        it("emits LendersTransferPauseAction event when pausing by governor", async function () {
          expect(pauseLendersTransferTx)
            .to.emit(cometExt, "LendersTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await expect(cometExt.connect(governor).pauseLendersTransfer(false))
            .to.emit(cometExt, "LendersTransferPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.false;
        });

        it("allows pause guardian to call pauseLendersTransfer", async function () {
          pauseLendersTransferTx = await cometExt
            .connect(pauseGuardian)
            .pauseLendersTransfer(true);
          await expect(pauseLendersTransferTx).to.not.be.reverted;
        });

        it("emits LendersTransferPauseAction event when pausing by pause guardian", async function () {
          expect(pauseLendersTransferTx)
            .to.emit(cometExt, "LendersTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersTransfer(false)
          )
            .to.emit(cometExt, "LendersTransferPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isLendersTransferPaused()).to.be.false;
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt.connect(governor).pauseLendersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseLendersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseBorrowersTransfer", function () {
      describe("happy cases", function () {
        let pauseBorrowersTransferTx: ContractTransaction;

        it("allows governor to call pauseBorrowersTransfer", async function () {
          pauseBorrowersTransferTx = await cometExt
            .connect(governor)
            .pauseBorrowersTransfer(true);
          await expect(pauseBorrowersTransferTx).to.not.be.reverted;
        });

        it("emits BorrowersTransferPauseAction event when pausing by governor", async function () {
          expect(pauseBorrowersTransferTx)
            .to.emit(cometExt, "BorrowersTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await expect(cometExt.connect(governor).pauseBorrowersTransfer(false))
            .to.emit(cometExt, "BorrowersTransferPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.false;
        });

        it("allows pause guardian to call pauseBorrowersTransfer", async function () {
          pauseBorrowersTransferTx = await cometExt
            .connect(pauseGuardian)
            .pauseBorrowersTransfer(true);
          await expect(pauseBorrowersTransferTx).to.not.be.reverted;
        });

        it("emits BorrowersTransferPauseAction event when pausing by pause guardian", async function () {
          expect(pauseBorrowersTransferTx)
            .to.emit(cometExt, "BorrowersTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersTransfer(false)
          )
            .to.emit(cometExt, "BorrowersTransferPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isBorrowersTransferPaused()).to.be.false;
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt.connect(governor).pauseBorrowersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseBorrowersTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralTransfer", function () {
      describe("happy cases", function () {
        let pauseCollateralTransferTx: ContractTransaction;

        it("allows governor to call pauseCollateralTransfer", async function () {
          pauseCollateralTransferTx = await cometExt
            .connect(governor)
            .pauseCollateralTransfer(true);
          await expect(pauseCollateralTransferTx).to.not.be.reverted;
        });

        it("emits CollateralTransferPauseAction event when pausing by governor", async function () {
          expect(pauseCollateralTransferTx)
            .to.emit(cometExt, "CollateralTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.true;
        });

        it("allows governor to unpause", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralTransfer(false)
          )
            .to.emit(cometExt, "CollateralTransferPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.false;
        });

        it("allows pause guardian to call pauseCollateralTransfer", async function () {
          pauseCollateralTransferTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralTransfer(true);
          await expect(pauseCollateralTransferTx).to.not.be.reverted;
        });

        it("emits CollateralTransferPauseAction event when pausing by pause guardian", async function () {
          expect(pauseCollateralTransferTx)
            .to.emit(cometExt, "CollateralTransferPauseAction")
            .withArgs(true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralTransfer(false)
          )
            .to.emit(cometExt, "CollateralTransferPauseAction")
            .withArgs(false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isCollateralTransferPaused()).to.be.false;
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt.connect(governor).pauseCollateralTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt.connect(pauseGuardian).pauseCollateralTransfer(false)
          ).to.be.revertedWithCustomError(cometExt, "OffsetStatusAlreadySet");
        });
      });
    });

    describe("pauseCollateralAssetTransfer", function () {
      describe("happy cases", function () {
        let pauseCollateralAssetTransferTx: ContractTransaction;

        it("allows governor to call pauseCollateralAssetTransfer", async function () {
          pauseCollateralAssetTransferTx = await cometExt
            .connect(governor)
            .pauseCollateralAssetTransfer(assetIndex, true);
          await expect(pauseCollateralAssetTransferTx).to.not.be.reverted;
        });

        it("emits CollateralAssetTransferPauseAction event when pausing by governor", async function () {
          expect(pauseCollateralAssetTransferTx)
            .to.emit(cometExt, "CollateralAssetTransferPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by governor", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .true;
        });

        it("allows governor to unpause", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, false)
          )
            .to.emit(cometExt, "CollateralAssetTransferPauseAction")
            .withArgs(assetIndex, false);
        });

        it("sets to false when unpausing by governor", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .false;
        });

        it("allows pause guardian to call pauseCollateralAssetTransfer", async function () {
          pauseCollateralAssetTransferTx = await cometExt
            .connect(pauseGuardian)
            .pauseCollateralAssetTransfer(assetIndex, true);
          await expect(pauseCollateralAssetTransferTx).to.not.be.reverted;
        });

        it("emits CollateralAssetTransferPauseAction event when pausing by pause guardian", async function () {
          expect(pauseCollateralAssetTransferTx)
            .to.emit(cometExt, "CollateralAssetTransferPauseAction")
            .withArgs(assetIndex, true);
        });

        it("changes state when called by pause guardian", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .true;
        });

        it("allows pause guardian to unpause", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
              .pauseCollateralAssetTransfer(assetIndex, false)
          )
            .to.emit(cometExt, "CollateralAssetTransferPauseAction")
            .withArgs(assetIndex, false);
        });

        it("sets to false when unpausing by pause guardian", async function () {
          expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to.be
            .false;
        });

        for (let i = 1; i <= 24; i++) {
          it(`allows to call pauseCollateralAssetTransfer for asset ${i} with ${i} collaterals`, async function () {
            const collaterals = Object.fromEntries(
              Array.from({ length: i }, (_, j) => [`ASSET${j}`, {}])
            );

            const protocol = await makeProtocol({
              assets: { USDC: {}, ...collaterals },
            });

            const comet = protocol.cometWithExtendedAssetList;
            const cometExt = comet.attach(comet.address) as CometExt;
            const governor = protocol.governor;
            const assetIndex = i - 1;

            // Verify we have i collaterals
            const numAssets = await comet.numAssets();
            expect(numAssets).to.be.equal(i);

            // Pause the collateral at index i
            await cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, true);

            // Verify that the asset at index i is paused
            expect(await comet.isCollateralAssetTransferPaused(assetIndex)).to
              .be.true;
          });
        }
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

        it("reverts duplicate status setting (governor)", async function () {
          await expect(
            cometExt
              .connect(governor)
              .pauseCollateralAssetTransfer(assetIndex, false)
          ).to.be.revertedWithCustomError(
            cometExt,
            "CollateralAssetOffsetStatusAlreadySet"
          );
        });

        it("reverts duplicate status setting (pause guardian)", async function () {
          await expect(
            cometExt
              .connect(pauseGuardian)
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
});
