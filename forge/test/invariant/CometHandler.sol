// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import {Test} from "forge-std/Test.sol";
import {CometWithExtendedAssetList} from "../../../contracts/CometWithExtendedAssetList.sol";
import {FaucetToken} from "../../../contracts/test/FaucetToken.sol";

/// @notice Handler — the fuzzer's steering wheel. Wraps supply/withdraw of base and collateral,
///         keeps a fixed set of actors, and makes valid (non-reverting) calls.
///         No ghost variables yet!
contract CometHandler is Test {
    CometWithExtendedAssetList public comet;
    FaucetToken public base;
    FaucetToken public weth;

    address[] public actors;
    address internal currentActor;

    // counters — to see that the fuzzer actually reaches the functions (manual coverage)
    uint256 public callsSupplyBase;
    uint256 public callsWithdrawBase;
    uint256 public callsSupplyColl;

    constructor(CometWithExtendedAssetList _comet, FaucetToken _base, FaucetToken _weth) {
        comet = _comet;
        base = _base;
        weth = _weth;

        actors.push(address(0xA11CE));
        actors.push(address(0xB0B));
        actors.push(address(0xCA401));

        // for each actor: tokens + approve Comet for both assets
        for (uint256 i = 0; i < actors.length; i++) {
            address a = actors[i];
            base.allocateTo(a, 1_000_000e6);
            weth.allocateTo(a, 1_000e18);
            vm.prank(a);
            base.approve(address(comet), type(uint256).max);
            vm.prank(a);
            weth.approve(address(comet), type(uint256).max);
        }
    }

    modifier useActor(uint256 actorSeed) {
        currentActor = actors[actorSeed % actors.length];
        vm.startPrank(currentActor);
        _;
        vm.stopPrank();
    }

    // ── supply base ──────────────────────────────────────────────
    function supplyBase(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 0, base.balanceOf(currentActor));
        if (amount == 0) return;
        comet.supply(address(base), amount);
        callsSupplyBase++;
    }

    // ── withdraw base (may turn into a borrow!) ──────────────────
    function withdrawBase(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 0, 500_000e6);
        if (amount == 0) return;
        comet.withdraw(address(base), amount);
        callsWithdrawBase++;
    }

    // ── supply collateral (WETH) ─────────────────────────────────
    function supplyCollateral(uint256 actorSeed, uint256 amount) external useActor(actorSeed) {
        amount = bound(amount, 0, weth.balanceOf(currentActor));
        if (amount == 0) return;
        comet.supply(address(weth), amount);
        callsSupplyColl++;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }
}
