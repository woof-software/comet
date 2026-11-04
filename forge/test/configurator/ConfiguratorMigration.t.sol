// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import { ConfiguratorProxy } from "contracts/ConfiguratorProxy.sol";
import { CometProxyAdmin } from "contracts/CometProxyAdmin.sol";
import { Deployable } from "contracts/interfaces/Deployable.sol";
import { TransparentUpgradeableProxy } from "contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ConfiguratorV1 } from "contracts/test/configurator/ConfiguratorV1.sol";
import { ConfiguratorIntermediate } from "contracts/migration/ConfiguratorIntermediate.sol";
import { CometConfigurationIntermediate } from "contracts/migration/CometConfigurationIntermediate.sol";
import { Configurator } from "contracts/Configurator.sol";
import { AssetList } from "contracts/AssetList.sol";
import { AssetListFactory } from "contracts/AssetListFactory.sol";
import { CometFactoryWithExtendedAssetList } from "contracts/CometFactoryWithExtendedAssetList.sol";
import { CometWithExtendedAssetList } from "contracts/CometWithExtendedAssetList.sol";
import { FaucetToken } from "contracts/test/FaucetToken.sol";
import { SimplePriceFeed } from "contracts/test/SimplePriceFeed.sol";
import { IAssetList } from "contracts/interfaces/assetList/IAssetList.sol";
import { IAssetListStructs } from "contracts/interfaces/assetList/IAssetListStructs.sol";
import { Test } from "forge-std/Test.sol";

contract ConfiguratorMigrationTest is Test {
    address internal governor = makeAddr("governor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    address internal cometA;
    address internal cometB;
    address internal cometC;

    CometProxyAdmin internal proxyAdmin;
    ConfiguratorProxy internal proxy;

    /// @dev One base token and price feed shared by all three markets
    FaucetToken internal baseToken;
    SimplePriceFeed internal baseTokenPriceFeed;

    /// @dev The full V1 Configuration of each market, ABI-encoded because a struct holding a struct array
    ///      can't be copied from memory to storage
    mapping(address => bytes) internal v1Configurations;
    /// @dev The asset configs each market had in V1, read from the V1 Configurator before the migration
    mapping(address => CometConfigurationIntermediate.AssetConfig[]) internal expectedAssetConfigs;

    /// @dev Storage slot of the configuratorParams mapping, the same in all three versions
    uint256 internal constant CONFIGURATOR_PARAMS_SLOT = 1;
    /// @dev Offset of assetConfigs inside the V1 Configuration, which is assetList in the final one
    uint256 internal constant ASSET_CONFIGS_OFFSET = 10;
    /// @dev Storage slots taken by one V1 AssetConfig
    uint256 internal constant V1_ASSET_CONFIG_SLOTS = 3;
    /// @dev Assets per market, the most an asset list can hold
    uint256 internal constant NUM_ASSETS = 24;

    function test_configuratorMigration() public {
        baseToken = new FaucetToken(0, "Base", 6, "BASE");
        baseTokenPriceFeed = new SimplePriceFeed(1e8, 8);

        // The proxy admin owns the upgrades; the governor is set once at initialization and must survive both upgrades
        proxyAdmin = new CometProxyAdmin(address(this));
        proxy = new ConfiguratorProxy(
            address(new ConfiguratorV1()),
            address(proxyAdmin),
            abi.encodeCall(ConfiguratorV1.initialize, (governor))
        );

        // The Comet proxies exist from the start, as on chain. There is no V1 Comet in this repo,
        // so they point at a placeholder until deployAndUpgradeTo gives them a real implementation
        cometA = newCometProxy();
        cometB = newCometProxy();
        cometC = newCometProxy();

        // Three markets configured the V1 way, each with its asset configs inside the Configuration
        configureV1Market(cometA);
        configureV1Market(cometB);
        configureV1Market(cometC);

        // Snapshot the V1 Configurations, the reference for every check after the migration
        snapshotV1Configuration(cometA);
        snapshotV1Configuration(cometB);
        snapshotV1Configuration(cometC);

        // Move the asset configs out of the Configuration into their own mapping, then switch to the final Configurator
        proxyAdmin.upgrade(TransparentUpgradeableProxy(payable(address(proxy))), address(new ConfiguratorIntermediate()));
        vm.prank(governor);
        address[] memory cometList = new address[](3);
        cometList[0] = cometA;
        cometList[1] = cometB;
        cometList[2] = cometC;
        ConfiguratorIntermediate(address(proxy)).migrateAssetConfig(cometList);
        proxyAdmin.upgrade(TransparentUpgradeableProxy(payable(address(proxy))), address(new Configurator()));

        // Every field of the Configuration survives the migration, and the asset configs are gone from it
        validateConfiguration(cometA);
        validateConfiguration(cometB);
        validateConfiguration(cometC);

        // The asset configs now live in their own mapping, in their original order with every field unchanged
        validateAssetConfigs(cometA);
        validateAssetConfigs(cometB);
        validateAssetConfigs(cometC);

        // Give every market its asset list and a real Comet built on it
        AssetListFactory assetListFactory = new AssetListFactory();
        CometFactoryWithExtendedAssetList cometFactory = new CometFactoryWithExtendedAssetList();
        deployAssetListAndComet(cometA, assetListFactory, cometFactory);
        deployAssetListAndComet(cometB, assetListFactory, cometFactory);
        deployAssetListAndComet(cometC, assetListFactory, cometFactory);

        // The asset list and the Comet built on it report the V1 asset configs
        assertAssetListMatchesSnapshot(cometA);
        assertAssetListMatchesSnapshot(cometB);
        assertAssetListMatchesSnapshot(cometC);

        // Each market gets a base supplier and a collateral supplier
        supplyToMarket(cometA);
        supplyToMarket(cometB);
        supplyToMarket(cometC);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev Any contract will do as the placeholder implementation, the proxy only needs code behind it
    function newCometProxy() internal returns (address) {
        return address(new TransparentUpgradeableProxy(address(baseToken), address(proxyAdmin), ""));
    }

    /// @dev Sets a market's V1 Configuration
    function configureV1Market(address comet) internal {
        CometConfigurationIntermediate.Configuration memory configuration = createV1ConfigurationForMarket(NUM_ASSETS);
        vm.prank(governor);
        ConfiguratorV1(address(proxy)).setConfiguration(comet, configuration);
    }

    /// @dev A V1 Configuration with a real token and price feed for every asset, so each asset has its own address.
    ///      Everything except the assets is the same for all markets, and is enough for a real Comet to be built from it.
    ///      V1 and the intermediate version share these structs, so it is built from CometConfigurationIntermediate
    function createV1ConfigurationForMarket(uint256 numAssets) internal returns (CometConfigurationIntermediate.Configuration memory configuration) {
        uint8[3] memory decimalsList = [6, 8, 18];

        configuration.governor = governor;
        configuration.pauseGuardian = governor;
        configuration.baseToken = address(baseToken);
        configuration.baseTokenPriceFeed = address(baseTokenPriceFeed);
        configuration.storeFrontPriceFactor = 0.5e18;
        configuration.trackingIndexScale = 1e15;
        configuration.baseMinForRewards = 1e6;
        configuration.baseBorrowMin = 1e6;
        configuration.assetConfigs = new CometConfigurationIntermediate.AssetConfig[](numAssets);
        for (uint256 i; i < numAssets; ++i) {
            // Each asset gets one of the decimals from the list, picked pseudo-randomly from its index
            uint8 decimals = decimalsList[uint256(keccak256(abi.encode(i))) % decimalsList.length];
            FaucetToken token = new FaucetToken(0, "Token", decimals, "TKN");
            SimplePriceFeed priceFeed = new SimplePriceFeed(1000e8, 8);

            configuration.assetConfigs[i] = CometConfigurationIntermediate.AssetConfig({
                asset: address(token),
                priceFeed: address(priceFeed),
                decimals: decimals,
                borrowCollateralFactor: 0.7e18,
                liquidateCollateralFactor: 0.8e18,
                liquidationFactor: 0.9e18,
                supplyCap: uint128(1_000_000 * 10 ** decimals)
            });
        }
    }

    /// @dev Records the Configuration the V1 Configurator holds for a market, and its asset configs separately
    function snapshotV1Configuration(address comet) internal {
        CometConfigurationIntermediate.Configuration memory configuration = ConfiguratorV1(address(proxy)).getConfiguration(comet);
        v1Configurations[comet] = abi.encode(configuration);
        for (uint256 i; i < configuration.assetConfigs.length; ++i) {
            expectedAssetConfigs[comet].push(configuration.assetConfigs[i]);
        }
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
        assertOldElementsZeroed(comet, NUM_ASSETS);
    }

    function validateAssetConfigs(address comet) internal {
        CometConfigurationIntermediate.AssetConfig[] storage expected = expectedAssetConfigs[comet];
        Configurator.AssetConfig[] memory actual = configurator().getAssetConfigs(comet);

        assertEq(actual.length, expected.length);
        for (uint256 i; i < actual.length; ++i) {
            assertEq(actual[i].asset, expected[i].asset);
            assertEq(actual[i].priceFeed, expected[i].priceFeed);
            assertEq(actual[i].decimals, expected[i].decimals);
            assertEq(actual[i].borrowCollateralFactor, expected[i].borrowCollateralFactor);
            assertEq(actual[i].liquidateCollateralFactor, expected[i].liquidateCollateralFactor);
            assertEq(actual[i].liquidationFactor, expected[i].liquidationFactor);
            assertEq(actual[i].supplyCap, expected[i].supplyCap);
        }
    }

    /// @dev The full setup of a migrated market: a new asset list implementation and its proxy,
    ///      then a Comet built on that list through the proxy admin
    function deployAssetListAndComet(address comet, AssetListFactory assetListFactory, CometFactoryWithExtendedAssetList cometFactory) internal {
        vm.startPrank(governor);
        configurator().setAssetListFactory(comet, address(assetListFactory));

        // The market has no list yet, so there is no proxy and a new implementation is deployed
        (address assetListProxy, address assetListImpl) = configurator().deployAssetList(comet);
        assertEq(assetListProxy, address(0));
        assertTrue(assetListImpl != address(0));

        // The list proxy is owned by the proxy admin, so later deploys can upgrade it
        address assetList = address(new TransparentUpgradeableProxy(
            assetListImpl,
            address(proxyAdmin),
            abi.encodeCall(AssetList.initialize, (configurator().getStorageAssetConfig(comet), address(proxy)))
        ));
        configurator().updateAssetList(comet, assetList);
        configurator().setFactory(comet, address(cometFactory));
        vm.stopPrank();

        proxyAdmin.deployAndUpgradeTo(Deployable(address(proxy)), TransparentUpgradeableProxy(payable(comet)));
        market(comet).initializeStorage();
    }

    /// @dev Alice supplies base, Bob supplies the market's first collateral
    function supplyToMarket(address comet) internal {
        address collateral = expectedAssetConfigs[comet][0].asset;
        uint256 baseAmount = 1000e6;
        uint256 collateralAmount = 10 ** expectedAssetConfigs[comet][0].decimals;

        baseToken.allocateTo(alice, baseAmount);
        vm.startPrank(alice);
        baseToken.approve(comet, baseAmount);
        market(comet).supply(address(baseToken), baseAmount);
        vm.stopPrank();

        FaucetToken(collateral).allocateTo(bob, collateralAmount);
        vm.startPrank(bob);
        FaucetToken(collateral).approve(comet, collateralAmount);
        market(comet).supply(collateral, collateralAmount);
        vm.stopPrank();
    }

    function assertAssetListMatchesSnapshot(address comet) internal {
        CometConfigurationIntermediate.AssetConfig[] storage expected = expectedAssetConfigs[comet];
        IAssetList assetList = IAssetList(configurator().getConfiguration(comet).assetList);

        assertTrue(address(assetList).code.length > 0);
        assertEq(assetList.numAssets(), NUM_ASSETS);
        assertEq(market(comet).numAssets(), NUM_ASSETS);
        for (uint256 i; i < NUM_ASSETS; ++i) {
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
            assertEq(vm.load(address(proxy), bytes32(elementsStart + k)), bytes32(0));
        }
    }

    function configurator() internal view returns (Configurator) {
        return Configurator(address(proxy));
    }

    function market(address comet) internal pure returns (CometWithExtendedAssetList) {
        return CometWithExtendedAssetList(payable(comet));
    }
}
