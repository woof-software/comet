// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import { ConfiguratorProxy } from "contracts/ConfiguratorProxy.sol";
import { CometProxyAdmin } from "contracts/CometProxyAdmin.sol";
import { TransparentUpgradeableProxy } from "contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ConfiguratorV1 } from "contracts/test/configurator/ConfiguratorV1.sol";
import { ConfiguratorIntermediate } from "contracts/configurator/ConfiguratorIntermediate.sol";
import { CometConfigurationIntermediate } from "contracts/configurator/CometConfigurationIntermediate.sol";
import { Configurator } from "contracts/Configurator.sol";
import { FaucetToken } from "contracts/test/FaucetToken.sol";
import { SimplePriceFeed } from "contracts/test/SimplePriceFeed.sol";
import { IAssetListStructs } from "contracts/interfaces/assetList/IAssetListStructs.sol";
import { Test } from "forge-std/Test.sol";

contract ConfiguratorMigrationTest is Test {
    address internal governor = makeAddr("governor");
    address internal cometA = makeAddr("cometA");
    address internal cometB = makeAddr("cometB");
    address internal cometC = makeAddr("cometC");
    address internal baseToken = makeAddr("baseToken");

    CometProxyAdmin internal proxyAdmin;
    ConfiguratorProxy internal proxy;

    /// @dev The asset configs each market was given in V1, which the migration must carry over unchanged
    mapping(address => CometConfigurationIntermediate.AssetConfig[]) internal expectedAssetConfigs;

    /// @dev Storage slot of the configuratorParams mapping, the same in all three versions
    uint256 internal constant CONFIGURATOR_PARAMS_SLOT = 1;
    /// @dev Offset of assetConfigs inside the V1 Configuration, which is assetList in the final one
    uint256 internal constant ASSET_CONFIGS_OFFSET = 10;
    /// @dev Storage slots taken by one V1 AssetConfig
    uint256 internal constant V1_ASSET_CONFIG_SLOTS = 3;
    /// @dev Assets per market, the most an asset list can hold
    uint256 internal constant NUM_ASSETS = 24;

    function setUp() public {
        // The proxy admin owns the upgrades; the governor is set once at initialization and must survive both upgrades
        proxyAdmin = new CometProxyAdmin(address(this));
        proxy = new ConfiguratorProxy(
            address(new ConfiguratorV1()),
            address(proxyAdmin),
            abi.encodeCall(ConfiguratorV1.initialize, (governor))
        );

        // Three markets configured the V1 way, each with its asset configs inside the Configuration
        configureV1Market(cometA);
        configureV1Market(cometB);
        configureV1Market(cometC);
    }

    function test_migrationFlow_movesAssetConfigsAndKeepsTheRest() public {
        upgradeToIntermediate();

        // Nothing has moved yet: the V1 arrays are still in place under the intermediate version
        assertEq(oldArrayLength(cometA), NUM_ASSETS);
        assertEq(oldArrayLength(cometB), NUM_ASSETS);
        assertEq(oldArrayLength(cometC), NUM_ASSETS);

        vm.prank(governor);
        intermediate().migrateAssetConfig(comets());

        // The old arrays are gone, both their length and every slot their elements used
        assertEq(oldArrayLength(cometA), 0);
        assertEq(oldArrayLength(cometB), 0);
        assertEq(oldArrayLength(cometC), 0);
        assertOldElementsZeroed(cometA, NUM_ASSETS);
        assertOldElementsZeroed(cometB, NUM_ASSETS);
        assertOldElementsZeroed(cometC, NUM_ASSETS);

        upgradeToFinal();

        // Every asset arrives in the new mapping in its original order, with every field unchanged,
        // and the helpers split each config into the parts the asset list is built from and keeps in storage
        assertMigrated(cometA, NUM_ASSETS);
        assertMigrated(cometB, NUM_ASSETS);
        assertMigrated(cometC, NUM_ASSETS);

        // The slot the old array used is now assetList, and it must read as no list yet
        Configurator.Configuration memory configuration = configurator().getConfiguration(cometA);
        assertEq(configuration.assetList, address(0));

        // The rest of the Configuration and the governor are untouched by the migration
        assertEq(configuration.baseToken, baseToken);
        assertEq(configuration.governor, governor);
        assertEq(configurator().governor(), governor);
    }

    function test_migrateAssetConfig_revertsOnSecondRun() public {
        upgradeToIntermediate();

        vm.startPrank(governor);
        intermediate().migrateAssetConfig(comets());

        // A second run would copy the already cleared, empty arrays over the migrated configs
        vm.expectRevert(ConfiguratorIntermediate.AlreadyMigrated.selector);
        intermediate().migrateAssetConfig(comets());
        vm.stopPrank();
    }

    function test_migrateAssetConfig_revertsForNonGovernor() public {
        upgradeToIntermediate();

        vm.expectRevert(ConfiguratorIntermediate.Unauthorized.selector);
        intermediate().migrateAssetConfig(comets());
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function upgradeToIntermediate() internal {
        proxyAdmin.upgrade(TransparentUpgradeableProxy(payable(address(proxy))), address(new ConfiguratorIntermediate()));
    }

    function upgradeToFinal() internal {
        proxyAdmin.upgrade(TransparentUpgradeableProxy(payable(address(proxy))), address(new Configurator()));
    }

    function intermediate() internal view returns (ConfiguratorIntermediate) {
        return ConfiguratorIntermediate(address(proxy));
    }

    function configurator() internal view returns (Configurator) {
        return Configurator(address(proxy));
    }

    function comets() internal view returns (address[] memory list) {
        list = new address[](3);
        list[0] = cometA;
        list[1] = cometB;
        list[2] = cometC;
    }

    /// @dev Sets a market's V1 Configuration and remembers its asset configs for the checks after the migration
    function configureV1Market(address comet) internal {
        CometConfigurationIntermediate.Configuration memory configuration = createV1ConfigurationForMarket(NUM_ASSETS);
        vm.prank(governor);
        ConfiguratorV1(address(proxy)).setConfiguration(comet, configuration);
        for (uint256 i; i < NUM_ASSETS; ++i) {
            expectedAssetConfigs[comet].push(configuration.assetConfigs[i]);
        }
    }

    /// @dev A V1 Configuration with a real token and price feed for every asset, so each asset has its own address.
    ///      V1 and the intermediate version share these structs, so it is built from CometConfigurationIntermediate
    function createV1ConfigurationForMarket(uint256 numAssets) internal returns (CometConfigurationIntermediate.Configuration memory configuration) {
        uint8[3] memory decimalsList = [6, 8, 18];

        configuration.governor = governor;
        configuration.baseToken = baseToken;
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

    function assertMigrated(address comet, uint256 numAssets) internal {
        CometConfigurationIntermediate.AssetConfig[] storage expected = expectedAssetConfigs[comet];
        Configurator.AssetConfig[] memory migrated = configurator().getAssetConfigs(comet);
        IAssetListStructs.ImmutableAssetConfig[] memory immutableParts = configurator().getImmutableAssetConfig(comet);
        IAssetListStructs.StorageAssetConfig[] memory storageParts = configurator().getStorageAssetConfig(comet);
        assertEq(migrated.length, numAssets);
        assertEq(immutableParts.length, numAssets);
        assertEq(storageParts.length, numAssets);
        for (uint256 i; i < numAssets; ++i) {
            assertEq(migrated[i].asset, expected[i].asset);
            assertEq(migrated[i].priceFeed, expected[i].priceFeed);
            assertEq(migrated[i].decimals, expected[i].decimals);
            assertEq(migrated[i].borrowCollateralFactor, expected[i].borrowCollateralFactor);
            assertEq(migrated[i].liquidateCollateralFactor, expected[i].liquidateCollateralFactor);
            assertEq(migrated[i].liquidationFactor, expected[i].liquidationFactor);
            assertEq(migrated[i].supplyCap, expected[i].supplyCap);

            assertEq(immutableParts[i].asset, expected[i].asset);
            assertEq(immutableParts[i].priceFeed, expected[i].priceFeed);
            assertEq(immutableParts[i].decimals, expected[i].decimals);

            assertEq(storageParts[i].borrowCollateralFactor, expected[i].borrowCollateralFactor);
            assertEq(storageParts[i].liquidateCollateralFactor, expected[i].liquidateCollateralFactor);
            assertEq(storageParts[i].liquidationFactor, expected[i].liquidationFactor);
            assertEq(storageParts[i].supplyCap, expected[i].supplyCap);
        }
    }

    /// @dev Slot of the V1 Configuration.assetConfigs array of a market, which holds the array's length
    function oldArraySlot(address comet) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(comet, CONFIGURATOR_PARAMS_SLOT))) + ASSET_CONFIGS_OFFSET;
    }

    /// @dev The intermediate version has no getters, so the old array's length is read straight from storage
    function oldArrayLength(address comet) internal view returns (uint256) {
        return uint256(vm.load(address(proxy), bytes32(oldArraySlot(comet))));
    }

    /// @dev Reads the old array's element slots straight from the proxy's storage: delete must have zeroed all of them
    function assertOldElementsZeroed(address comet, uint256 numAssets) internal {
        uint256 elementsStart = uint256(keccak256(abi.encode(oldArraySlot(comet))));
        for (uint256 k; k < numAssets * V1_ASSET_CONFIG_SLOTS; ++k) {
            assertEq(vm.load(address(proxy), bytes32(elementsStart + k)), bytes32(0));
        }
    }
}
