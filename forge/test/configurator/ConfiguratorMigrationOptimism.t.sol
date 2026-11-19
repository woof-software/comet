// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import { ConfiguratorProxy } from "contracts/ConfiguratorProxy.sol";
import { CometProxyAdmin } from "contracts/CometProxyAdmin.sol";
import { TransparentUpgradeableProxy } from "contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol";
import { ConfiguratorV1 } from "contracts/test/configurator/ConfiguratorV1.sol";
import { ConfiguratorIntermediateOptimism } from "contracts/migration/ConfiguratorIntermediateOptimism.sol";
import { ConfiguratorOptimism } from "contracts/marketupdates/ConfiguratorOptimism.sol";
import { FaucetToken } from "contracts/test/FaucetToken.sol";
import { SimplePriceFeed } from "contracts/test/SimplePriceFeed.sol";
import { ConfiguratorMigrationTest } from "./ConfiguratorMigration.t.sol";

/// @dev The migration on the Optimism upgrade path, where the Configurator keeps the marketAdminPermissionChecker slot
contract ConfiguratorMigrationOptimismTest is ConfiguratorMigrationTest {
    address internal marketAdminPermissionChecker = makeAddr("marketAdminPermissionChecker");

    /// @dev Storage slot of marketAdminPermissionChecker in the Optimism Configurator
    uint256 internal constant MARKET_ADMIN_PERMISSION_CHECKER_SLOT = 4;

    function test_configuratorMigration_keepsMarketAdminPermissionChecker() public {
        baseToken = new FaucetToken(0, "Base", 6, "BASE");
        baseTokenPriceFeed = new SimplePriceFeed(1e8, 8);

        proxyAdmin = new CometProxyAdmin(address(this));
        proxy = new ConfiguratorProxy(
            address(new ConfiguratorV1()),
            address(proxyAdmin),
            abi.encodeCall(ConfiguratorV1.initialize, (governor))
        );

        cometA = newCometProxy();
        configureV1Market(cometA);
        snapshotV1Configuration(cometA);

        // ConfiguratorV1 has no market admin, so the checker is written straight to the slot it has on Optimism
        vm.store(address(proxy), bytes32(MARKET_ADMIN_PERMISSION_CHECKER_SLOT), bytes32(uint256(uint160(marketAdminPermissionChecker))));

        proxyAdmin.upgrade(TransparentUpgradeableProxy(payable(address(proxy))), address(new ConfiguratorIntermediateOptimism()));
        address[] memory cometList = new address[](1);
        cometList[0] = cometA;
        vm.prank(governor);
        ConfiguratorIntermediateOptimism(address(proxy)).migrateAssetConfig(cometList);
        proxyAdmin.upgrade(TransparentUpgradeableProxy(payable(address(proxy))), address(new ConfiguratorOptimism()));

        // The checker sits between the old storage and the migrated asset configs, and both must survive
        assertEq(address(ConfiguratorOptimism(address(proxy)).marketAdminPermissionChecker()), marketAdminPermissionChecker);
        validateConfiguration(cometA);
        validateAssetConfigs(cometA);
    }
}
