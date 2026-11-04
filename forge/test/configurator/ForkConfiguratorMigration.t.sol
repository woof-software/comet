// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import { CometProxyAdmin } from "contracts/CometProxyAdmin.sol";
import { Deployable } from "contracts/interfaces/Deployable.sol";
import { TransparentUpgradeableProxy } from "contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ConfiguratorV1 } from "contracts/test/configurator/ConfiguratorV1.sol";
import { ConfiguratorIntermediate } from "contracts/migration/ConfiguratorIntermediate.sol";
import { ConfiguratorIntermediateOptimism } from "contracts/migration/ConfiguratorIntermediateOptimism.sol";
import { CometConfigurationIntermediate } from "contracts/migration/CometConfigurationIntermediate.sol";
import { Configurator } from "contracts/Configurator.sol";
import { ConfiguratorOptimism } from "contracts/marketupdates/ConfiguratorOptimism.sol";
import { AssetList } from "contracts/AssetList.sol";
import { AssetListFactory } from "contracts/test/assetList/AssetListFactory.sol";
import { CometFactoryWithExtendedAssetList } from "contracts/test/CometFactoryWithExtendedAssetList.sol";
import { CometWithExtendedAssetList } from "contracts/CometWithExtendedAssetList.sol";
import { IAssetList } from "contracts/interfaces/assetList/IAssetList.sol";
import { IAssetListStructs } from "contracts/interfaces/assetList/IAssetListStructs.sol";
import { IERC20NonStandard } from "contracts/interfaces/IERC20NonStandard.sol";
import { ConfiguratorMigrationForkBase } from "./ConfiguratorMigrationForkBase.sol";
import { console2 } from "forge-std/console2.sol";

contract ForkConfiguratorMigrationTest is ConfiguratorMigrationForkBase {
    /// @dev The live Configurator proxy of the selected fork
    address internal proxy;
    /// @dev The live Comet proxies of the selected fork
    address[] internal cometList;
    /// @dev The governor of the live Configurator, also the Configuration's governor
    address internal governor;

    /// @dev The full V1 Configuration of each market, ABI-encoded because a struct holding a struct array
    ///      can't be copied from memory to storage
    mapping(address => bytes) internal v1Configurations;
    /// @dev The asset configs each market had in V1, read from the live Configurator before the migration
    mapping(address => CometConfigurationIntermediate.AssetConfig[]) internal expectedAssetConfigs;
    /// @dev Comets of the selected fork with an asset whose factors the asset list would reject
    address[] internal invalidComets;

    /// @dev Storage slot of the configuratorParams mapping, the same in all versions
    uint256 internal constant CONFIGURATOR_PARAMS_SLOT = 1;
    /// @dev Offset of assetConfigs inside the V1 Configuration, which is assetList in the final one
    uint256 internal constant ASSET_CONFIGS_OFFSET = 10;
    /// @dev Storage slots taken by one V1 AssetConfig
    uint256 internal constant V1_ASSET_CONFIG_SLOTS = 3;
    /// @dev EIP-1967 slot holding a proxy's admin
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    function test_configuratorMigration() public {
        runConfiguratorMigration("mainnet");
        runConfiguratorMigration("arbitrum");
        runConfiguratorMigration("base");
        runConfiguratorMigration("optimism");
    }

    function runConfiguratorMigration(string memory rpc) internal {
        (proxy, cometList) = createFork(rpc);
        governor = configurator().governor();
        CometProxyAdmin proxyAdmin = adminOf(proxy);

        // Snapshot the live Configurations, the reference for every check after the migration
        delete invalidComets;
        for (uint256 i; i < cometList.length; ++i) {
            snapshotV1Configuration(cometList[i]);
        }

        // Move the asset configs out of the Configuration into their own mapping, then switch to the final Configurator.
        // Optimism's Configurator also stores the market admin permission checker, so it has its own versions
        bool isOptimism = block.chainid == OPTIMISM;
        vm.startPrank(proxyAdmin.owner());
        proxyAdmin.upgrade(
            TransparentUpgradeableProxy(payable(proxy)),
            isOptimism ? address(new ConfiguratorIntermediateOptimism()) : address(new ConfiguratorIntermediate())
        );
        vm.stopPrank();
        vm.prank(governor);
        ConfiguratorIntermediate(proxy).migrateAssetConfig(cometList);
        vm.startPrank(proxyAdmin.owner());
        proxyAdmin.upgrade(
            TransparentUpgradeableProxy(payable(proxy)),
            isOptimism ? address(new ConfiguratorOptimism()) : address(new Configurator())
        );
        vm.stopPrank();

        // Every field of the Configuration survives the migration, and the asset configs are gone from it
        for (uint256 i; i < cometList.length; ++i) {
            validateConfiguration(cometList[i]);
        }

        // The asset configs now live in their own mapping, in their original order with every field unchanged
        for (uint256 i; i < cometList.length; ++i) {
            validateAssetConfigs(cometList[i]);
        }

        // Give every market its asset list and a new Comet built on it.
        // A market with factors the asset list rejects can't get one, so it is skipped from here on
        AssetListFactory assetListFactory = new AssetListFactory();
        CometFactoryWithExtendedAssetList cometFactory = new CometFactoryWithExtendedAssetList();
        for (uint256 i; i < cometList.length; ++i) {
            if (isInvalidComet(cometList[i])) continue;
            deployAssetListAndComet(cometList[i], assetListFactory, cometFactory);
        }

        // The asset list and the Comet built on it report the V1 asset configs
        for (uint256 i; i < cometList.length; ++i) {
            if (isInvalidComet(cometList[i])) continue;
            assertAssetListMatchesSnapshot(cometList[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Records the Configuration the live Configurator holds for a market, and its asset configs separately.
    ///      The live Configurator has the V1 layout, so it is read through ConfiguratorV1
    function snapshotV1Configuration(address comet) internal {
        CometConfigurationIntermediate.Configuration memory configuration = ConfiguratorV1(proxy).getConfiguration(comet);
        v1Configurations[comet] = abi.encode(configuration);
        // The same address can be a market on another chain, so the previous chain's snapshot is cleared first
        delete expectedAssetConfigs[comet];
        bool isInvalid;
        for (uint256 i; i < configuration.assetConfigs.length; ++i) {
            expectedAssetConfigs[comet].push(configuration.assetConfigs[i]);
            if (!areFactorsValid(configuration.assetConfigs[i])) {
                isInvalid = true;
                logInvalidAsset(comet, configuration.assetConfigs[i]);
            }
        }
        if (isInvalid) invalidComets.push(comet);
    }

    /// @dev The same order AssetList enforces: BCF below LCF, LCF below LF, LF at most 100%. A zero factor skips its check
    function areFactorsValid(CometConfigurationIntermediate.AssetConfig memory assetConfig) internal pure returns (bool) {
        if (assetConfig.borrowCollateralFactor >= assetConfig.liquidateCollateralFactor && assetConfig.borrowCollateralFactor != 0) return false;
        if (assetConfig.liquidateCollateralFactor >= assetConfig.liquidationFactor && assetConfig.liquidateCollateralFactor != 0) return false;
        return assetConfig.liquidationFactor <= 1e18;
    }

    /// @dev Prints a collateral the asset list would reject, so the run lists every case
    function logInvalidAsset(address comet, CometConfigurationIntermediate.AssetConfig memory assetConfig) internal view {
        console2.log("Invalid factors: chain", block.chainid);
        console2.log("  comet", comet);
        console2.log("  asset", assetConfig.asset);
        console2.log("  BCF", assetConfig.borrowCollateralFactor);
        console2.log("  LCF", assetConfig.liquidateCollateralFactor);
        console2.log("  LF", assetConfig.liquidationFactor);
    }

    function isInvalidComet(address comet) internal view returns (bool) {
        for (uint256 i; i < invalidComets.length; ++i) {
            if (invalidComets[i] == comet) return true;
        }
        return false;
    }

    function validateConfiguration(address comet) internal {
        CometConfigurationIntermediate.Configuration memory expected = abi.decode(v1Configurations[comet], (CometConfigurationIntermediate.Configuration));
        Configurator.Configuration memory actual = configurator().getConfiguration(comet);

        assertEq(configurator().governor(), governor);
        assertEq(actual.governor, expected.governor);
        assertEq(actual.pauseGuardian, expected.pauseGuardian);
        assertEq(actual.baseToken, expected.baseToken);
        assertEq(actual.baseTokenPriceFeed, expected.baseTokenPriceFeed);
        assertEq(actual.extensionDelegate, expected.extensionDelegate);
        assertEq(actual.supplyKink, expected.supplyKink);
        assertEq(actual.supplyPerYearInterestRateSlopeLow, expected.supplyPerYearInterestRateSlopeLow);
        assertEq(actual.supplyPerYearInterestRateSlopeHigh, expected.supplyPerYearInterestRateSlopeHigh);
        assertEq(actual.supplyPerYearInterestRateBase, expected.supplyPerYearInterestRateBase);
        assertEq(actual.borrowKink, expected.borrowKink);
        assertEq(actual.borrowPerYearInterestRateSlopeLow, expected.borrowPerYearInterestRateSlopeLow);
        assertEq(actual.borrowPerYearInterestRateSlopeHigh, expected.borrowPerYearInterestRateSlopeHigh);
        assertEq(actual.borrowPerYearInterestRateBase, expected.borrowPerYearInterestRateBase);
        assertEq(actual.storeFrontPriceFactor, expected.storeFrontPriceFactor);
        assertEq(actual.trackingIndexScale, expected.trackingIndexScale);
        assertEq(actual.baseTrackingSupplySpeed, expected.baseTrackingSupplySpeed);
        assertEq(actual.baseTrackingBorrowSpeed, expected.baseTrackingBorrowSpeed);
        assertEq(actual.baseMinForRewards, expected.baseMinForRewards);
        assertEq(actual.baseBorrowMin, expected.baseBorrowMin);
        assertEq(actual.targetReserves, expected.targetReserves);

        // The slot the old array used is now assetList, and it must read as no list yet.
        // Every slot the old array's elements used is zeroed
        assertEq(actual.assetList, address(0));
        assertOldElementsZeroed(comet, expected.assetConfigs.length);
    }

    function validateAssetConfigs(address comet) internal {
        CometConfigurationIntermediate.AssetConfig[] storage expected = expectedAssetConfigs[comet];
        Configurator.AssetConfig[] memory actual = configurator().getAssetConfigs(comet);

        assertEq(actual.length, expected.length);
        for (uint256 i; i < actual.length; ++i) {
            assertEq(actual[i].asset, expected[i].asset);
            assertEq(actual[i].priceFeed, expected[i].priceFeed);
            // Decimals are dropped by the migration, as the asset list reads them from the token, so the V1 value must be the token's
            assertEq(IERC20NonStandard(actual[i].asset).decimals(), expected[i].decimals);
            assertEq(actual[i].borrowCollateralFactor, expected[i].borrowCollateralFactor);
            assertEq(actual[i].liquidateCollateralFactor, expected[i].liquidateCollateralFactor);
            assertEq(actual[i].liquidationFactor, expected[i].liquidationFactor);
            assertEq(actual[i].supplyCap, expected[i].supplyCap);
        }
    }

    /// @dev The full setup of a migrated market: a new asset list implementation and its proxy,
    ///      then a Comet built on that list through the market's proxy admin
    function deployAssetListAndComet(address comet, AssetListFactory assetListFactory, CometFactoryWithExtendedAssetList cometFactory) internal {
        CometProxyAdmin cometAdmin = adminOf(comet);

        vm.startPrank(governor);
        configurator().setAssetListFactory(comet, address(assetListFactory));

        // The market has no list yet and deployAssetList only redeploys an existing one, so the first implementation
        // comes straight from the factory, built from the migrated immutable configs
        address assetListImpl = assetListFactory.createAssetList(configurator().getImmutableAssetConfig(comet), address(configurator()));

        // The list proxy is owned by the Comet's proxy admin, so later deploys can upgrade it
        address assetList = address(new TransparentUpgradeableProxy(
            assetListImpl,
            address(cometAdmin),
            abi.encodeCall(AssetList.initialize, (configurator().getStorageAssetConfig(comet)))
        ));
        // setConfiguration sets the list proxy once, for a market that has none yet
        Configurator.Configuration memory configuration = configurator().getConfiguration(comet);
        configuration.assetList = assetList;
        configurator().setConfiguration(comet, configuration);
        configurator().setFactory(comet, address(cometFactory));
        vm.stopPrank();

        vm.prank(cometAdmin.owner());
        cometAdmin.deployAndUpgradeTo(Deployable(proxy), TransparentUpgradeableProxy(payable(comet)));
    }

    function assertAssetListMatchesSnapshot(address comet) internal {
        CometConfigurationIntermediate.AssetConfig[] storage expected = expectedAssetConfigs[comet];
        IAssetList assetList = IAssetList(configurator().getConfiguration(comet).assetList);

        assertTrue(address(assetList).code.length > 0);
        assertEq(assetList.numAssets(), expected.length);
        assertEq(market(comet).numAssets(), expected.length);
        for (uint256 i; i < expected.length; ++i) {
            assertAssetInfo(assetList.getAssetInfo(uint8(i)), expected[i], i);
            assertAssetInfo(market(comet).getAssetInfo(uint8(i)), expected[i], i);
        }
    }

    function assertAssetInfo(IAssetListStructs.AssetInfo memory info, CometConfigurationIntermediate.AssetConfig storage expected, uint256 i) internal {
        assertEq(info.offset, i);
        assertEq(info.asset, expected.asset);
        assertEq(info.priceFeed, expected.priceFeed);
        assertEq(info.scale, 10 ** expected.decimals);
        assertEq(info.borrowCollateralFactor, expected.borrowCollateralFactor);
        assertEq(info.liquidateCollateralFactor, expected.liquidateCollateralFactor);
        assertEq(info.liquidationFactor, expected.liquidationFactor);
        assertEq(info.supplyCap, expected.supplyCap);
    }

    /// @dev Slot of the V1 Configuration.assetConfigs array of a market, which holds the array's length
    function oldArraySlot(address comet) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(comet, CONFIGURATOR_PARAMS_SLOT))) + ASSET_CONFIGS_OFFSET;
    }

    /// @dev Reads the old array's element slots straight from the proxy's storage: delete must have zeroed all of them
    function assertOldElementsZeroed(address comet, uint256 numAssets) internal {
        uint256 elementsStart = uint256(keccak256(abi.encode(oldArraySlot(comet))));
        for (uint256 k; k < numAssets * V1_ASSET_CONFIG_SLOTS; ++k) {
            assertEq(vm.load(proxy, bytes32(elementsStart + k)), bytes32(0));
        }
    }

    /// @dev The proxy admin of a live proxy, read from its EIP-1967 admin slot
    function adminOf(address proxyAddress) internal view returns (CometProxyAdmin) {
        return CometProxyAdmin(address(uint160(uint256(vm.load(proxyAddress, ADMIN_SLOT)))));
    }

    /// @dev Configurator and ConfiguratorOptimism share every function used here, so one type serves both
    function configurator() internal view returns (Configurator) {
        return Configurator(proxy);
    }

    function market(address comet) internal pure returns (CometWithExtendedAssetList) {
        return CometWithExtendedAssetList(payable(comet));
    }
}
