import { expect } from "chai";
import { ethers } from "hardhat";
import { setupFork } from "../helpers";
import {
  impersonateAccount,
  setBalance,
  takeSnapshot
} from "@nomicfoundation/hardhat-network-helpers";
import {
  CometExtAssetList__factory,
  CometFactoryWithExtendedAssetList__factory,
  CometProxyAdmin,
  CometWithExtendedAssetList,
  Configurator,
  CometExtAssetList,
} from "build/types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { ContractTransaction } from "ethers";
import type { SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";

describe("Extended pause upgrade test", function () {
  // Snapshot
  let snapshot: SnapshotRestorer;

  // Constants
  const FORK_BLOCK_NUMBER = 23655019;
  const COMET_ADDRESS = "0xc3d688B66703497DAA19211EEdff47f25384cdc3";
  const CONFIGURATOR_ADDRESS = "0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3";
  const GOVERNOR_ADDRESS = "0x6d903f6003cca6255d85cca4d3b5e5146dc33925";
  const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

  // Contracts
  let comet: CometWithExtendedAssetList;
  let cometExt: CometExtAssetList;
  let configurator: Configurator;
  let proxyAdmin: CometProxyAdmin;
  let newCometExt: CometExtAssetList;

  // Signers
  let governor: SignerWithAddress;

  // Variables
  let assetListFactoryAddress: string;
  let name32: string;
  let symbol32: string;
  let originalImpl: string;
  let newImpl: string;

  // Transactions
  let upgradeTx: ContractTransaction;

  before(async function () {
    // Setup mainnet fork
    await setupFork(FORK_BLOCK_NUMBER);

    // Get contracts
    comet = (await ethers.getContractAt(
      "CometWithExtendedAssetList",
      COMET_ADDRESS
    )) as CometWithExtendedAssetList;

    configurator = (await ethers.getContractAt(
      "Configurator",
      CONFIGURATOR_ADDRESS
    )) as Configurator;

    // Get proxy admin
    const adminAddress = await ethers.provider.getStorageAt(
      COMET_ADDRESS,
      ADMIN_SLOT
    );
    const proxyAdminAddress = ethers.utils.getAddress(
      "0x" + adminAddress.slice(26)
    );
    proxyAdmin = (await ethers.getContractAt(
      "CometProxyAdmin",
      proxyAdminAddress
    )) as CometProxyAdmin;

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
    assetListFactoryAddress =
      await CometExtAssetListInterface.assetListFactory();

    // Get name and symbol from current extension delegate
    const ExtInterface = await ethers.getContractAt(
      "CometExtInterface",
      currentExtensionDelegate
    );
    name32 = ethers.utils.formatBytes32String(await ExtInterface.name());
    symbol32 = ethers.utils.formatBytes32String(await ExtInterface.symbol());

    // Get current implementation
    originalImpl = await proxyAdmin.getProxyImplementation(COMET_ADDRESS);

    // Deploy new version of CometExtAssetList (with extended pause functionality)
    const CometExtAssetList = (await ethers.getContractFactory(
      "CometExtAssetList"
    )) as CometExtAssetList__factory;
    newCometExt = await CometExtAssetList.deploy(
      { name32, symbol32 },
      assetListFactoryAddress
    );

    // Deploy CometFactoryWithExtendedAssetList
    const CometFactoryWithExtendedAssetList = (await ethers.getContractFactory(
      "CometFactoryWithExtendedAssetList"
    )) as CometFactoryWithExtendedAssetList__factory;
    const newFactory = await CometFactoryWithExtendedAssetList.deploy();

    // Step 1: Set the new extension delegate in configurator
    await configurator
      .connect(governor)
      .setExtensionDelegate(COMET_ADDRESS, newCometExt.address);

    // Step 2: Set the new factory in the configurator
    await configurator
      .connect(governor)
      .setFactory(COMET_ADDRESS, newFactory.address);

    // Deploy new implementation using configurator
    const deployTx = await configurator.connect(governor).deploy(COMET_ADDRESS);
    const deployReceipt = await deployTx.wait();
    const deployEvent = deployReceipt.events.find((e) => e.event === "CometDeployed");
    newImpl = deployEvent.args.newComet;

    upgradeTx = await proxyAdmin.connect(governor).upgrade(COMET_ADDRESS, newImpl);

    cometExt = await ethers.getContractAt("CometExtAssetList", COMET_ADDRESS) as CometExtAssetList;

    snapshot = await takeSnapshot()
  });

  it('verify new deployed comet implementation', async function () {
    expect(newImpl).to.not.equal(ethers.constants.AddressZero);
    expect(newImpl).to.not.equal(originalImpl);
  });

  it('should upgrade proxy to new implementation by governor', async function () {
    await upgradeTx.wait();
    
    await snapshot.restore();
  });

  it('should update comet and comet extension delegate implementations', async function () {
    await upgradeTx.wait();

    expect(await comet.extensionDelegate()).to.equal(newCometExt.address);
    expect(await proxyAdmin.getProxyImplementation(COMET_ADDRESS)).to.equal(newImpl);

    await snapshot.restore();
  });

  it('should save comet extension storage safely after upgrade', async function () {
    const assetListFactoryBefore = await cometExt.assetListFactory();
    const maxAssetsBefore = await cometExt.maxAssets();
    const versionBefore = await cometExt.version();
    const nameBefore = await cometExt.name();
    const symbolBefore = await cometExt.symbol();
    const baseAccrualScaleBefore = await cometExt.baseAccrualScale();
    const baseIndexScaleBefore = await cometExt.baseIndexScale();
    const factorScaleBefore = await cometExt.factorScale();
    const priceScaleBefore = await cometExt.priceScale();

    await upgradeTx.wait();

    expect(await cometExt.assetListFactory()).to.equal(assetListFactoryBefore);
    expect(await cometExt.maxAssets()).to.equal(maxAssetsBefore);
    expect(await cometExt.version()).to.equal(versionBefore);
    expect(await cometExt.name()).to.equal(nameBefore);
    expect(await cometExt.symbol()).to.equal(symbolBefore);
    expect(await cometExt.baseAccrualScale()).to.equal(baseAccrualScaleBefore);
    expect(await cometExt.baseIndexScale()).to.equal(baseIndexScaleBefore);
    expect(await cometExt.factorScale()).to.equal(factorScaleBefore);
    expect(await cometExt.priceScale()).to.equal(priceScaleBefore);

    await snapshot.restore();
  });

  it('should save comet storage safely after upgrade', async function () {
    // Immutable or constants 
    const governorBefore = await comet.governor();
    const pauseGuardianBefore = await comet.pauseGuardian();
    const baseTokenBefore = await comet.baseToken();
    const baseTokenPriceFeedBefore = await comet.baseTokenPriceFeed();
    const extensionDelegateBefore = await comet.extensionDelegate();
    const supplyKinkBefore = await comet.supplyKink();

    // Storage
    const totalsBasicBefore = await cometExt.totalsBasic();

    // Upgrade
    await upgradeTx.wait();

    // Check
    expect(await comet.governor()).to.equal(governorBefore);
    expect(await comet.pauseGuardian()).to.equal(pauseGuardianBefore);
    expect(await comet.baseToken()).to.equal(baseTokenBefore);
    expect(await comet.baseTokenPriceFeed()).to.equal(baseTokenPriceFeedBefore);
    expect(await comet.extensionDelegate()).to.equal(extensionDelegateBefore);
    expect(await comet.supplyKink()).to.equal(supplyKinkBefore);
    expect(await cometExt.totalsBasic()).to.deep.equal(totalsBasicBefore);

    await snapshot.restore();
  });

  it('should allow to call extended pause functions after upgrade', async function () {
    // Upgrade
    await upgradeTx.wait();

    // Call extended pause functions
    await cometExt.connect(governor).pauseLendersWithdraw(true);
    await cometExt.connect(governor).pauseBorrowersWithdraw(true);
    await cometExt.connect(governor).pauseCollateralSupply(true);
    await cometExt.connect(governor).pauseBaseSupply(true);
    await cometExt.connect(governor).pauseCollateralAssetSupply(0, true);
    await cometExt.connect(governor).pauseLendersTransfer(true);
    await cometExt.connect(governor).pauseBorrowersTransfer(true);
    await cometExt.connect(governor).pauseCollateralTransfer(true);
    await cometExt.connect(governor).pauseCollateralAssetTransfer(0, true);
  });

  it('should update pause flags in comet storage', async function () {
    expect(await comet.isLendersWithdrawPaused()).to.be.true;
    expect(await comet.isBorrowersWithdrawPaused()).to.be.true;
    expect(await comet.isCollateralSupplyPaused()).to.be.true;
    expect(await comet.isBaseSupplyPaused()).to.be.true;
    expect(await comet.isCollateralAssetSupplyPaused(0)).to.be.true;
    expect(await comet.isLendersTransferPaused()).to.be.true;
    expect(await comet.isBorrowersTransferPaused()).to.be.true;
    expect(await comet.isCollateralTransferPaused()).to.be.true;
    expect(await comet.isCollateralAssetTransferPaused(0)).to.be.true;
  });
});
