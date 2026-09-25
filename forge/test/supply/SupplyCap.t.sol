// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometMainInterface } from "@comet-contracts/CometMainInterface.sol";
import { CometProxyAdmin, Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { CometWithExtendedAssetList } from "@comet-contracts/CometWithExtendedAssetList.sol";
import { FaucetToken } from "@comet-contracts/test/FaucetToken.sol";

import { ProtocolFixture } from "../helpers/ProtocolFixture.sol";

/**
 * @title Supply cap enforcement invariants
 * @notice The cap is the ceiling on how much of a collateral the market holds. It is checked on the
 *         total, after the supplied amount is added, so a cap can be reached exactly but never passed.
 */
contract SupplyCapTest is ProtocolFixture {
    function setUp() public {
        prepareFixture();
    }

    /// Whatever the sequence of supplies and withdrawals is, no collateral ends up
    /// holding more than its cap. Amounts run up to twice the cap, so supplies that must fail are
    /// part of the sequence; a supply that should revert but does not shows up in the totals.
    function testFuzz_totalSupplyNeverExceedsCap(uint256 seed) public {
        address[3] memory actors = [alice, bob, charlie];
        uint128[] memory supplyCaps = new uint128[](collaterals.length);

        for (uint256 i; i < supplyCaps.length; ++i) {
            uint256 oneToken = 10 ** assetSpecs[i + 1].decimals; // index 0 is the base token
            supplyCaps[i] = uint128(bound(uint256(keccak256(abi.encode(seed, i))), 1, 1_000_000 * oneToken));
        }

        _setSupplyCaps(supplyCaps);

        for (uint256 i; i < collaterals.length; ++i) {
            FaucetToken collateral = collaterals[i];

            for (uint256 actor; actor < actors.length; ++actor) {
                uint256 amount = bound(uint256(keccak256(abi.encode(seed, i, actor))), 0, uint256(supplyCaps[i]) * 2);

                collateral.allocateTo(actors[actor], amount);
                vm.startPrank(actors[actor]);
                collateral.approve(address(comet), amount);
                // The cap is what the sequence is probing, so a rejected supply is an expected step
                try comet.supply(address(collateral), amount) {} catch {}
                vm.stopPrank();
            }

            // Withdraw part of what went in, so the sequence is not supplies alone
            uint128 balance = comet.collateralBalanceOf(actors[0], address(collateral));
            if (balance > 0) {
                vm.prank(actors[0]);
                comet.withdraw(address(collateral), balance / 2);
            }
        }

        for (uint256 i; i < collaterals.length; ++i) {
            assertLe(_totalSupplyAsset(address(collaterals[i])), supplyCaps[i], "collateral held above its supply cap");
        }
    }

    /// The cap can be reached to the wei, and the next wei is refused. The cap is
    /// checked after the amount is added, so supplying exactly the cap is the last accepted supply.
    function testFuzz_supplyUpToCapSucceedsAndOneWeiMoreReverts(uint256 collateralIndex, uint128 supplyCap) public {
        FaucetToken collateral = collaterals[bound(collateralIndex, 0, collaterals.length - 1)];
        // One wei short of the uint128 ceiling, so there is room to try to pass the cap
        supplyCap = uint128(bound(supplyCap, 1, type(uint128).max - 1));

        _setSupplyCaps(_uniformCaps(supplyCap));

        _supply(alice, collateral, supplyCap);
        assertEq(_totalSupplyAsset(address(collateral)), supplyCap, "supplying the whole cap did not go through");

        collateral.allocateTo(bob, 1);
        vm.startPrank(bob);
        collateral.approve(address(comet), 1);
        vm.expectRevert(CometMainInterface.SupplyCapExceeded.selector);
        comet.supply(address(collateral), 1);
        vm.stopPrank();
    }

    /// A cap of zero closes the collateral, so nothing can be supplied at all
    function testFuzz_zeroCapBlocksAnySupply(uint256 collateralIndex, uint128 amount) public {
        FaucetToken collateral = collaterals[bound(collateralIndex, 0, collaterals.length - 1)];
        amount = uint128(bound(amount, 1, type(uint128).max));

        _setSupplyCaps(_uniformCaps(0));

        collateral.allocateTo(alice, amount);
        vm.startPrank(alice);
        collateral.approve(address(comet), amount);
        vm.expectRevert(CometMainInterface.SupplyCapExceeded.selector);
        comet.supply(address(collateral), amount);
        vm.stopPrank();

        assertEq(_totalSupplyAsset(address(collateral)), 0, "collateral held against a zero cap");
    }

    /// Puts the caps in the configurator and upgrades the market onto them
    function _setSupplyCaps(uint128[] memory supplyCaps) internal {
        vm.startPrank(timelock);

        for (uint256 i; i < supplyCaps.length; ++i) {
            configurator.updateAssetSupplyCap(address(cometProxy), address(collaterals[i]), supplyCaps[i]);
        }
        proxyAdmin.deployAndUpgradeTo(Deployable(address(configuratorProxy)), cometProxy);

        vm.stopPrank();
    }

    /// The same cap for every collateral in the market
    function _uniformCaps(uint128 supplyCap) internal view returns (uint128[] memory supplyCaps) {
        supplyCaps = new uint128[](collaterals.length);

        for (uint256 i; i < supplyCaps.length; ++i) {
            supplyCaps[i] = supplyCap;
        }
    }

    function _supply(address account, FaucetToken collateral, uint256 amount) internal {
        collateral.allocateTo(account, amount);

        vm.startPrank(account);
        collateral.approve(address(comet), amount);
        comet.supply(address(collateral), amount);
        vm.stopPrank();
    }

    function _totalSupplyAsset(address asset) internal view returns (uint128 totalSupplyAsset) {
        (totalSupplyAsset,) = CometWithExtendedAssetList(payable(address(cometProxy))).totalsCollateral(asset);
    }
}
