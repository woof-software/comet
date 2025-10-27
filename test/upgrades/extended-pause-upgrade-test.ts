import { expect } from "chai";
import { ethers } from "hardhat";
import { setupFork } from "../helpers";
import {
    impersonateAccount,
    setBalance,
  } from "@nomicfoundation/hardhat-network-helpers";
import { CometExtAssetList__factory, CometFactoryWithExtendedAssetList__factory, CometProxyAdmin, CometWithExtendedAssetList,Configurator, CometExtAssetList } from "build/types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

const FORK_BLOCK_NUMBER = 23655019;
const COMET_ADDRESS = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";
const CONFIGURATOR_ADDRESS = "0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3";
const GOVERNOR_ADDRESS = "0x6d903f6003cca6255d85cca4d3b5e5146dc33925";
const ADMIN_SLOT =
    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

describe("Extended pause upgrade test", function () {
  let comet: CometWithExtendedAssetList;
  let configurator: Configurator;
  let proxyAdmin: CometProxyAdmin;
  let governor: SignerWithAddress;
  let assetListFactoryAddress: string;
  let name32: string;
  let symbol32: string;

  beforeEach(async function () {
    // Setup mainnet fork
    await setupFork(FORK_BLOCK_NUMBER);

    // Get contracts
    comet = await ethers.getContractAt(
      "CometWithExtendedAssetList",
      COMET_ADDRESS
    ) as CometWithExtendedAssetList;

    configurator = await ethers.getContractAt(
      "Configurator",
      CONFIGURATOR_ADDRESS
    ) as Configurator;

    // Get proxy admin
    const adminAddress = await ethers.provider.getStorageAt(
      COMET_ADDRESS,
      ADMIN_SLOT
    );
    const proxyAdminAddress = ethers.utils.getAddress(
      "0x" + adminAddress.slice(26)
    );
    proxyAdmin = await ethers.getContractAt(
      "CometProxyAdmin",
      proxyAdminAddress
    ) as CometProxyAdmin;

    // Impersonate governor
    await impersonateAccount(GOVERNOR_ADDRESS);
    governor = await ethers.getSigner(GOVERNOR_ADDRESS);
    await setBalance(GOVERNOR_ADDRESS, ethers.utils.parseEther("10000"));

    // Get current extension delegate and its assetListFactory
    const currentExtensionDelegate = await comet.extensionDelegate();
    const CometExtAssetListInterface = await ethers.getContractAt(
      "IAssetListFactoryHolder",
      currentExtensionDelegate
    );
    assetListFactoryAddress = await CometExtAssetListInterface.assetListFactory();

    // Get name and symbol from current extension delegate
    const ExtInterface = await ethers.getContractAt(
      "CometExtInterface",
      currentExtensionDelegate
    );
    name32 = ethers.utils.formatBytes32String(await ExtInterface.name());
    symbol32 = ethers.utils.formatBytes32String(await ExtInterface.symbol());
  });

  it("Should perform real upgrade scenario: deploy new implementation and upgrade", async function () {
    // Get the storage before the upgrade
    const baseTokenBefore = await comet.baseToken();
    const governorBefore = await comet.governor();
    const numAssetsBefore = await comet.numAssets();
    const assetInfoBefore = await comet.getAssetInfo(3);

    // Get current implementation
    const originalImpl = await proxyAdmin.getProxyImplementation(COMET_ADDRESS);

    // Verify extended pause functions don't exist on current implementation
    let extendedPauseAvailable = false;
    try {
      await comet.isLendersWithdrawPaused();
      extendedPauseAvailable = true;
    } catch (error) {
      // Expected - extended pause functions not available
    }
    expect(extendedPauseAvailable).to.be.false;

    // Step 0: Deploy CometFactoryWithExtendedAssetList and set it in configurator
    const CometFactoryWithExtendedAssetList = await ethers.getContractFactory(
      "CometFactoryWithExtendedAssetList"
    ) as CometFactoryWithExtendedAssetList__factory;
    const newFactory = await CometFactoryWithExtendedAssetList.deploy();

    // Deploy new version of CometExtAssetList with the same assetListFactory
    const CometExtAssetList = await ethers.getContractFactory(
      "CometExtAssetList"
    ) as CometExtAssetList__factory;
    const newCometExt = await CometExtAssetList.deploy(
      { name32, symbol32 },
      assetListFactoryAddress
    );

    await configurator.connect(governor).setExtensionDelegate(COMET_ADDRESS, newCometExt.address);

    // Set the new factory in the configurator
    await configurator
      .connect(governor)
      .setFactory(COMET_ADDRESS, newFactory.address);

    // Step 1: Deploy new implementation using configurator
    const deployTx = await configurator.connect(governor).deploy(COMET_ADDRESS);
    const deployReceipt = await deployTx.wait();
    const deployEvent = deployReceipt.events.find(
      (e) => e.event === "CometDeployed"
    );
    const newImpl = deployEvent.args.newComet;

    expect(newImpl).to.not.equal(ethers.constants.AddressZero);
    expect(newImpl).to.not.equal(originalImpl);

    // Step 2: Use proxyAdmin.upgrade() to upgrade to the new implementation
    await proxyAdmin
      .connect(governor)
      .upgrade(COMET_ADDRESS, newImpl);

    // Step 3: Verify the new implementation is active
    const currentImpl = await proxyAdmin.getProxyImplementation(COMET_ADDRESS);
    expect(currentImpl).to.equal(newImpl);

    // Get the storage after the upgrade
    const baseTokenAfter = await comet.baseToken();
    const governorAfter = await comet.governor();
    const numAssetsAfter = await comet.numAssets();
    const assetInfoAfter = await comet.getAssetInfo(3);

    expect(baseTokenAfter).to.equal(baseTokenBefore);
    expect(governorAfter).to.equal(governorBefore);
    expect(numAssetsAfter).to.equal(numAssetsBefore);
    expect(assetInfoAfter).to.deep.equal(assetInfoBefore);

    // Step 4: Verify extended pause functions now work
    const isLendersWithdrawPaused = await comet.isLendersWithdrawPaused();
    const isBorrowersWithdrawPaused = await comet.isBorrowersWithdrawPaused();
    const isCollateralWithdrawPaused = await comet.isCollateralWithdrawPaused();
    const isCollateralSupplyPaused = await comet.isCollateralSupplyPaused();
    const isBaseSupplyPaused = await comet.isBaseSupplyPaused();

    // These should all return boolean values (not throw)
    expect(isLendersWithdrawPaused).to.be.false;
    expect(isBorrowersWithdrawPaused).to.be.false;
    expect(isCollateralWithdrawPaused).to.be.false;
    expect(isCollateralSupplyPaused).to.be.false;
    expect(isBaseSupplyPaused).to.be.false;

    // Verify basic pause functions still work
    const isSupplyPaused = await comet.isSupplyPaused();
    const isTransferPaused = await comet.isTransferPaused();
    const isWithdrawPaused = await comet.isWithdrawPaused();
    expect(isSupplyPaused).to.be.false;
    expect(isTransferPaused).to.be.false;
    expect(isWithdrawPaused).to.be.false;

    const cometExt = await ethers.getContractAt("CometExt", COMET_ADDRESS);
    await cometExt.connect(governor).pauseLendersWithdraw(true);
  });

  it("Should upgrade extension delegate to new version with extended pause functions", async function () {
    // Deploy new version of CometExtAssetList (with extended pause functionality)
    const CometExtAssetList = await ethers.getContractFactory(
      "CometExtAssetList"
    ) as CometExtAssetList__factory;
    const newCometExt = await CometExtAssetList.deploy(
      { name32, symbol32 },
      assetListFactoryAddress
    );

    // Deploy CometFactoryWithExtendedAssetList
    const CometFactoryWithExtendedAssetList = await ethers.getContractFactory(
      "CometFactoryWithExtendedAssetList"
    ) as CometFactoryWithExtendedAssetList__factory;
    const newFactory = await CometFactoryWithExtendedAssetList.deploy();

    // Step 1: Set the new extension delegate in configurator
    await configurator.connect(governor).setExtensionDelegate(COMET_ADDRESS, newCometExt.address);

    // Step 2: Set the new factory in the configurator
    await configurator
      .connect(governor)
      .setFactory(COMET_ADDRESS, newFactory.address);

    // Step 3: Get current implementation
    const originalImpl = await proxyAdmin.getProxyImplementation(COMET_ADDRESS);

    // Step 4: Deploy new implementation using configurator
    const deployTx = await configurator.connect(governor).deploy(COMET_ADDRESS);
    const deployReceipt = await deployTx.wait();
    const deployEvent = deployReceipt.events.find(
      (e) => e.event === "CometDeployed"
    );
    const newImpl = deployEvent.args.newComet;

    expect(newImpl).to.not.equal(ethers.constants.AddressZero);
    expect(newImpl).to.not.equal(originalImpl);

    // Step 5: Upgrade to the new implementation
    await proxyAdmin
      .connect(governor)
      .upgrade(COMET_ADDRESS, newImpl);

    // Step 6: Verify the extension delegate was upgraded
    const currentExtensionDelegateAfter = await comet.extensionDelegate();
    expect(currentExtensionDelegateAfter).to.equal(newCometExt.address);

    // Step 7: Verify extended pause functions now work via the proxy
    const cometExt = await ethers.getContractAt("CometExtAssetList", COMET_ADDRESS) as CometExtAssetList;
    
    // Call extended pause functions - these should work because the extension delegate has them
    await cometExt.connect(governor).pauseLendersWithdraw(true);
    expect(await comet.isLendersWithdrawPaused()).to.be.true;

    // Verify other pause functions work
    await cometExt.connect(governor).pauseBorrowersWithdraw(true);
    expect(await comet.isBorrowersWithdrawPaused()).to.be.true;

    // Verify we can unpause
    await cometExt.connect(governor).pauseLendersWithdraw(false);
    expect(await comet.isLendersWithdrawPaused()).to.be.false;

    // Verify max assets is still 24
    expect(await cometExt.maxAssets()).to.eq(24);
  });
});
