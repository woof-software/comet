// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import {CometKF02Fixture} from "./CometKF02Fixture.sol";
import {CometStorage} from "@comet-contracts/CometStorage.sol";

/// @title KF-02 — dust base supply against a funded borrow halts accrual.
/// @notice Deterministic witness for the accrual-halt finding. Full write-up,
///         scenario and math: `forge/test/KF-02-accrual-halt.md`.
/// @dev The state is built from explicit protocol calls and the halt is proven
///      with direct protocol calls, so the test depends on nothing but the
///      market fixture.
contract CometKF02AccrualHaltTest is CometKF02Fixture {
    /// @notice A market with base liquidity but no base supplier is driven into
    ///         a permanently accrual-halted state by a single dust base supply
    ///         against an outstanding borrow.
    /// @dev Target state:
    ///
    ///        totalSupplyBase = 2 wei,  totalBorrowBase = 3776 USDC.
    ///
    ///      `getSupplyRate` wraps the raw per-second rate in `safe64`
    ///      (CometWithExtendedAssetList.sol:334/337) with no upper clamp on
    ///      utilization. `getUtilization` (:363-371) guards only the zero-supply
    ///      divide, not a near-zero denominator. A dust supply drops utilization
    ///      from 0 straight to ~1.9e27 (about 1.9e11 %), which pushes the supply
    ///      rate past uint64 and reverts every subsequent `accrueInternal` —
    ///      supply, withdraw, absorb and liquidation alike, with no exit.
    ///
    ///      The test is falsifiable: were the protocol guarded, the precondition
    ///      self-check or the three `expectRevert(InvalidUInt64)` assertions
    ///      would fail instead.
    function test_KF02_dustSupplyAgainstFundedBorrowHaltsAccrualIrreversibly() public {
        address borrower = actors[1];
        address supplier = actors[0];
        address baseToken = address(base);

        // ── PHASE 1: open a borrow against the deployment's own base liquidity.
        //    The market ships with INITIAL_BASE_LIQUIDITY cash, so a borrow can
        //    exist with zero base suppliers — totalSupplyBase stays 0.
        _collateralize(borrower);
        vm.prank(borrower);
        comet.withdraw(baseToken, 3_776e6);

        CometStorage.TotalsBasic memory t = cometI.totalsBasic();
        assertEq(t.totalSupplyBase, 0, "KF-02 setup: base supply must start at zero");
        assertGt(t.totalBorrowBase, 0, "KF-02 setup: borrow was not opened");
        assertTrue(comet.isBorrowCollateralized(borrower), "KF-02 setup: borrower undercollateralized");

        // ── CONTROL: with supply == 0 the market is fully healthy.
        //    This isolates the defect to the 0 -> dust transition, not the borrow.
        assertEq(comet.getUtilization(), 0, "KF-02 control: zero-supply utilization must be 0");
        comet.getSupplyRate(0); // in-domain, must not revert
        vm.warp(block.timestamp + 60);
        comet.accrueAccount(borrower); // healthy accrual before the trigger

        // ── PHASE 2: the trigger — 2 wei of base supply.
        //    This call itself succeeds: accrueInternal prices utilization on the
        //    OLD supply == 0 before the principal is written. Because the supply
        //    rate stays 0 while supply is 0, baseSupplyIndex never grows, so a
        //    2-wei present value maps to a 1-2 wei principal.
        vm.prank(supplier);
        comet.supply(baseToken, 2);

        t = cometI.totalsBasic();
        assertGt(t.totalSupplyBase, 0, "KF-02 trigger: dust supply principal not created");
        assertLe(t.totalSupplyBase, 2, "KF-02 trigger: supply principal is not dust");

        // ── PRECONDITION SELF-CHECK: the state is genuinely past the uint64
        //    threshold, proven by an independent uint256 rate model (no safe64).
        uint256 util = comet.getUtilization();
        assertGt(util, 0, "KF-02: utilization collapsed to zero");
        assertGt(_supplyRateModel(util), type(uint64).max, "KF-02: state is NOT past the overflow threshold");

        // ── PROOF 1: the pure rate view reverts — overflow is in the rate,
        //    independent of any time delta.
        vm.expectRevert(INVALID_UINT64);
        comet.getSupplyRate(util);

        // ── PROOF 2: real accrual is permanently bricked.
        vm.warp(block.timestamp + 60);
        vm.expectRevert(INVALID_UINT64);
        comet.accrueAccount(borrower);

        // ── PROOF 3: irreversibility — even topping up supply cannot recover,
        //    because that path must accrue first. The market is wedged.
        vm.prank(supplier);
        vm.expectRevert(INVALID_UINT64);
        comet.supply(baseToken, 1_000e6);
    }
}
