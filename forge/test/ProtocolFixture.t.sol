// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { ProtocolFixture } from "./helpers/ProtocolFixture.sol";

/// Checks the fixture produces a live market: the proxy runs the configured implementation, every
/// collateral is on the asset list, and the liquidation module is bound to the proxy.
contract ProtocolFixtureTest is ProtocolFixture {
    function setUp() public {
        prepareFixture();
    }

    function test_marketIsDeployed() public {
        assertEq(comet.baseToken(), address(baseToken));
        assertEq(comet.governor(), timelock);
        assertEq(comet.numAssets(), collaterals.length);
        assertEq(comet.liquidationModule(), address(liquidationModule));
        // Storage was initialized through the proxy, which is also what bound the module to it.
        assertEq(comet.totalsBasic().lastAccrualTime, uint40(block.timestamp));
        assertEq(address(liquidationModule.comet()), address(cometProxy));

        for (uint8 i; i < collaterals.length; ++i) {
            assertEq(comet.getAssetInfo(i).asset, address(collaterals[i]));
        }
    }

    function test_supplyAndBorrow() public {
        collaterals[1].allocateTo(alice, 10e18); // WETH
        baseToken.allocateTo(address(comet), 100_000e6);

        vm.startPrank(alice);
        collaterals[1].approve(address(comet), type(uint256).max);
        comet.supply(address(collaterals[1]), 10e18);
        comet.withdraw(address(baseToken), 1_000e6);
        vm.stopPrank();

        assertEq(baseToken.balanceOf(alice), 1_000e6);
        assertTrue(comet.isBorrowCollateralized(alice));
    }
}
