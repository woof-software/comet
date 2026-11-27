// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import { CometProxyAdmin } from "@comet-contracts/CometProxyAdmin.sol";
import { CometProxyAdminOptimism } from "@comet-contracts/marketupdates/CometProxyAdminOptimism.sol";
import { MarketAdminPermissionCheckerInterface } from "@comet-contracts/marketupdates/MarketAdminPermissionCheckerInterface.sol";
import { Deployable } from "@comet-contracts/interfaces/Deployable.sol";
import { TransparentUpgradeableProxy } from "@comet-contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ConfiguratorV1 } from "@comet-contracts/test/configurator/ConfiguratorV1.sol";
import { ConfiguratorIntermediate } from "@comet-contracts/migration/ConfiguratorIntermediate.sol";
import { ConfiguratorIntermediateOptimism } from "@comet-contracts/migration/ConfiguratorIntermediateOptimism.sol";
import { CometConfigurationIntermediate } from "@comet-contracts/migration/CometConfigurationIntermediate.sol";
import { Configurator } from "@comet-contracts/Configurator.sol";
import { ConfiguratorOptimism } from "@comet-contracts/marketupdates/ConfiguratorOptimism.sol";
import { AssetList } from "@comet-contracts/AssetList.sol";
import { AssetListFactory } from "@comet-contracts/test/assetList/AssetListFactory.sol";
import { CometFactoryWithExtendedAssetList } from "@comet-contracts/test/CometFactoryWithExtendedAssetList.sol";
import { CometWithExtendedAssetList } from "@comet-contracts/CometWithExtendedAssetList.sol";
import { IAssetList } from "@comet-contracts/interfaces/assetList/IAssetList.sol";
import { IAssetListStructs } from "@comet-contracts/interfaces/assetList/IAssetListStructs.sol";
import { IERC20NonStandard } from "@comet-contracts/interfaces/IERC20NonStandard.sol";
import { ForkBase } from "./ForkBase.sol";

/**
 * @dev Replays the protocol upgrade on the live markets of every chain, then checks that their state survived it.
 *      Each later upgrade adds its steps and checks to runProtocolUpgrade
 */
contract ProtocolUpgradeForkTest is ForkBase {
    /// @dev The live Configurator proxy of the selected fork
    address internal proxy;
    /// @dev The same proxy as the final Configurator. Configurator and ConfiguratorOptimism share every function used
    ///      here, so one type serves both
    Configurator internal configurator;
    /// @dev The live Comet proxies of the selected fork
    address[] internal cometList;
    /// @dev The governor of the live Configurator, also the Configuration's governor
    address internal governor;

    /// @dev The full V1 Configuration of each market, ABI-encoded because a struct holding a struct array
    ///      can't be copied from memory to storage
    mapping(address => bytes) internal v1Configurations;
    /// @dev The asset configs each market had in V1, read from the live Configurator before the migration
    mapping(address => CometConfigurationIntermediate.AssetConfig[]) internal expectedAssetConfigs;

    /// @dev EIP-1967 slot holding a proxy's admin
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    /// @dev The max utilization every migrated market is given. V1 had no such field, so it reads as zero after the
    ///      migration, and a zero cap makes the Comet reject any borrow
    uint64 internal constant MAX_SUPPORTED_UTILIZATION = 2e18;
    /// @dev The target health factor every migrated market is given. V1 had no such field, so it reads as zero after
    ///      the migration, and a zero target makes the Comet constructor revert with BadHealthFactor
    uint64 internal constant TARGET_HEALTH_FACTOR = 1.05e18;

    function test_protocolUpgrade() public {
        runProtocolUpgrade("mainnet");
        runProtocolUpgrade("arbitrum");
        runProtocolUpgrade("base");
        runProtocolUpgrade("optimism");
    }

    function runProtocolUpgrade(string memory rpc) internal {
        (proxy, cometList) = createFork(rpc);
        configurator = Configurator(proxy);
        governor = configurator.governor();

        // We have separate Configurator and ProxyAdmin implementations for Optimism; watch 'contracts/marketupdates/' folder
        bool isOptimism = block.chainid == OPTIMISM;

        // Snapshot the live Configurations for markets. Split into asset configs and Comet configurations
        for (uint256 i; i < cometList.length; ++i) {
            CometConfigurationIntermediate.Configuration memory configuration = ConfiguratorV1(proxy).getConfiguration(cometList[i]);

            // Before all updates clean up previous chain's snapshots
            delete expectedAssetConfigs[cometList[i]];
            
            v1Configurations[cometList[i]] = abi.encode(configuration);
            
            for (uint256 j; j < configuration.assetConfigs.length; ++j) {
                expectedAssetConfigs[cometList[i]].push(configuration.assetConfigs[j]);
            }
        }

        // The live proxy admin can't deploy or upgrade asset lists, so the Configurator and every Comet move to a new one,
        // owned by the owner of the live one. On Optimism it also keeps the live market admin permission checker
        CometProxyAdmin oldProxyAdmin = adminOf(proxy);
        address proxyAdminOwner = oldProxyAdmin.owner();
        CometProxyAdmin proxyAdmin;
        if (isOptimism) {
            CometProxyAdminOptimism proxyAdminOptimism = new CometProxyAdminOptimism(proxyAdminOwner);
            // Read before the prank, which only covers the next call
            MarketAdminPermissionCheckerInterface marketAdminPermissionChecker =
                CometProxyAdminOptimism(address(oldProxyAdmin)).marketAdminPermissionChecker();
            vm.prank(proxyAdminOwner);
            proxyAdminOptimism.setMarketAdminPermissionChecker(marketAdminPermissionChecker);
            proxyAdmin = CometProxyAdmin(address(proxyAdminOptimism));
        } else {
            proxyAdmin = new CometProxyAdmin(proxyAdminOwner);
        }

        vm.startPrank(proxyAdminOwner);
        oldProxyAdmin.changeProxyAdmin(TransparentUpgradeableProxy(payable(proxy)), address(proxyAdmin));
        for (uint256 i; i < cometList.length; ++i) {
            oldProxyAdmin.changeProxyAdmin(TransparentUpgradeableProxy(payable(cometList[i])), address(proxyAdmin));
        }
        vm.stopPrank();

        // The new proxy admin is a new contract with the same owner, and now the admin of the Configurator and every Comet
        assertTrue(address(proxyAdmin) != address(oldProxyAdmin));
        assertEq(proxyAdmin.owner(), proxyAdminOwner);
        assertEq(address(adminOf(proxy)), address(proxyAdmin));
        for (uint256 i; i < cometList.length; ++i) {
            assertEq(address(adminOf(cometList[i])), address(proxyAdmin));
        }
        if (isOptimism) {
            assertEq(
                address(CometProxyAdminOptimism(address(proxyAdmin)).marketAdminPermissionChecker()),
                address(CometProxyAdminOptimism(address(oldProxyAdmin)).marketAdminPermissionChecker())
            );
        }

        // Move the asset configs out of the Configuration into their own mapping, then switch to the final Configurator
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
            validateCometConfiguration(cometList[i]);
        }

        // The asset configs now live in their own mapping, in their original order with every field unchanged
        for (uint256 i; i < cometList.length; ++i) {
            validateAssetConfigs(cometList[i]);
        }

        // Give every market its asset list and a new Comet built on it
        AssetListFactory assetListFactory = new AssetListFactory(address(configurator));
        CometFactoryWithExtendedAssetList cometFactory = new CometFactoryWithExtendedAssetList();
        for (uint256 i; i < cometList.length; ++i) {
            address comet = cometList[i];

            vm.startPrank(governor);
            configurator.setAssetListFactory(comet, address(assetListFactory));

            // The market has no list yet and deployAssetList only redeploys an existing one, so the first implementation
            // comes straight from the factory, built from the migrated immutable configs
            address assetListImpl = assetListFactory.createAssetList(configurator.getImmutableAssetConfig(comet));

            // The list proxy is owned by the Comet's proxy admin, so later deploys can upgrade it
            address assetList = address(new TransparentUpgradeableProxy(
                assetListImpl,
                address(proxyAdmin),
                abi.encodeCall(AssetList.initialize, (configurator.getStorageAssetConfig(comet)))
            ));
            // setConfiguration sets the list proxy once, for a market that has none yet
            Configurator.Configuration memory configuration = configurator.getConfiguration(comet);
            configuration.assetList = assetList;
            configurator.setConfiguration(comet, configuration);
            configurator.setFactory(comet, address(cometFactory));
            configurator.setMaxSupportedUtilization(comet, MAX_SUPPORTED_UTILIZATION);
            configurator.setTargetHealthFactor(comet, TARGET_HEALTH_FACTOR);
            vm.stopPrank();

            // A Comet built on that list, through the market's proxy admin
            vm.prank(proxyAdminOwner);
            proxyAdmin.deployAndUpgradeTo(Deployable(proxy), TransparentUpgradeableProxy(payable(comet)));
        }

        // The asset list and the Comet built on it report the V1 asset configs
        for (uint256 i; i < cometList.length; ++i) {
            CometConfigurationIntermediate.AssetConfig[] storage expected = expectedAssetConfigs[cometList[i]];
            IAssetList assetList = IAssetList(configurator.getConfiguration(cometList[i]).assetList);
            CometWithExtendedAssetList market = CometWithExtendedAssetList(payable(cometList[i]));

            assertEq(assetList.numAssets(), expected.length);
            assertEq(market.numAssets(), expected.length);
            for (uint256 j; j < expected.length; ++j) {
                assertAssetInfo(assetList.getAssetInfo(uint8(j)), expected[j], j);
                assertAssetInfo(market.getAssetInfo(uint8(j)), expected[j], j);
            }
        }

        // The Comet built after the migration has the max utilization set for it
        for (uint256 i; i < cometList.length; ++i) {
            assertEq(CometWithExtendedAssetList(payable(cometList[i])).maxSupportedUtilization(), MAX_SUPPORTED_UTILIZATION);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function validateCometConfiguration(address comet) internal {
        CometConfigurationIntermediate.Configuration memory expected = abi.decode(v1Configurations[comet], (CometConfigurationIntermediate.Configuration));
        Configurator.Configuration memory actual = configurator.getConfiguration(comet);

        assertEq(configurator.governor(), governor);
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
        // V1 had no maxSupportedUtilization, so the migration leaves it at zero until it is set
        assertEq(actual.maxSupportedUtilization, 0);

        // The slot the old array used is now assetList, and it must read as no list yet.
        // Every slot the old array's elements used is zeroed
        assertEq(actual.assetList, address(0));
    }

    function validateAssetConfigs(address comet) internal {
        CometConfigurationIntermediate.AssetConfig[] storage expected = expectedAssetConfigs[comet];
        Configurator.AssetConfig[] memory actual = configurator.getAssetConfigs(comet);

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

    /// @dev The proxy admin of a live proxy, read from its EIP-1967 admin slot
    function adminOf(address proxyAddress) internal view returns (CometProxyAdmin) {
        return CometProxyAdmin(address(uint160(uint256(vm.load(proxyAddress, ADMIN_SLOT)))));
    }
}
