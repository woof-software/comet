// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import {CometKF02Fixture, SimplePriceFeedLike} from "./CometKF02Fixture.sol";
import {CometStorage} from "@comet-contracts/CometStorage.sol";

/// @title Independent cross-check of the KF-02 accrual-halt finding.
/// @notice Reproduces the halt WITHOUT the "borrow against reserves at zero
///         supply" setup used by CometKF02AccrualHalt.t.sol, pins down what
///         MAX_SUPPORTED_UTILIZATION does and does not cover, and records the
///         figures quoted in `forge/test/KF-02-accrual-halt.md`.
contract CometKF02VerifyTest is CometKF02Fixture {
    /// @notice CONTROL A — the guard works on the path it covers: a borrow that
    ///         would push utilization past 2e18 is rejected.
    function test_control_borrowPathGuardIsEnforced() public {
        vm.prank(actors[0]);
        comet.supply(address(base), 1_000e6);
        _collateralize(actors[1]);

        vm.prank(actors[1]);
        vm.expectRevert(EXCEEDS_UTIL);
        comet.withdraw(address(base), 2_500e6); // util would be 2.5e18 > 2e18
    }

    /// @notice CONTROL B — the same guard is NOT applied on the lender-withdraw
    ///         branch. `withdrawBase` only checks utilization inside
    ///         `if (srcBalance < 0)`, so a lender reaches the halt on a market
    ///         that stayed inside the ceiling at every step.
    function test_lenderWithdrawToDustBypassesGuardAndHaltsAccrual() public {
        address lender = actors[0];
        address borrower = actors[1];
        address baseToken = address(base);

        // A perfectly ordinary market: a real lender, a real borrow, utilization
        // inside the supported ceiling.
        vm.prank(lender);
        comet.supply(baseToken, 1_000e6);
        _collateralize(borrower);
        vm.prank(borrower);
        comet.withdraw(baseToken, 1_900e6);

        assertLe(comet.getUtilization(), comet.MAX_SUPPORTED_UTILIZATION(), "setup: util must be inside the ceiling");

        vm.warp(block.timestamp + 1 days);
        comet.accrueAccount(borrower); // healthy

        // The lender walks the supply down to dust. No utilization guard here.
        uint256 bal = comet.balanceOf(lender);
        vm.prank(lender);
        comet.withdraw(baseToken, bal - 2);

        CometStorage.TotalsBasic memory t = cometI.totalsBasic();
        assertGt(t.totalSupplyBase, 0, "dust supply must survive");
        assertLe(t.totalSupplyBase, 2, "supply must be dust");
        emit log_named_uint("utilization after dust withdraw", comet.getUtilization());
        assertGt(comet.getUtilization(), comet.MAX_SUPPORTED_UTILIZATION(), "guard was bypassed");

        // Accrual is dead.
        vm.warp(block.timestamp + 60);
        vm.expectRevert(INVALID_UINT64);
        comet.accrueAccount(borrower);

        // Nobody can repay, supply, or withdraw any more.
        vm.prank(borrower);
        vm.expectRevert(INVALID_UINT64);
        comet.supply(baseToken, 500e6);

        vm.prank(lender);
        vm.expectRevert(INVALID_UINT64);
        comet.withdraw(baseToken, 1);
    }

    /// @notice CONTROL C — liquidation is dead too: an underwater borrower
    ///         cannot be absorbed at any price, which is the D-1 property the
    ///         fuzzer originally broke.
    function test_absorbIsBlockedAfterHalt() public {
        address lender = actors[0];
        address borrower = actors[1];
        address absorber = actors[2];
        address baseToken = address(base);

        vm.prank(lender);
        comet.supply(baseToken, 1_000e6);
        _collateralize(borrower);
        vm.prank(borrower);
        comet.withdraw(baseToken, 1_900e6);

        vm.warp(block.timestamp + 1 days);
        uint256 bal = comet.balanceOf(lender);
        vm.prank(lender);
        comet.withdraw(baseToken, bal - 2);

        // Crash every collateral price, so the borrower is deeply underwater.
        for (uint256 i = 0; i < collateralFeeds.length; i++) {
            SimplePriceFeedLike(address(collateralFeeds[i])).setRoundData(1, 1, block.timestamp, block.timestamp, 1);
        }

        address[] memory accounts = new address[](1);
        accounts[0] = borrower;
        vm.warp(block.timestamp + 60);
        vm.prank(absorber);
        vm.expectRevert(INVALID_UINT64);
        comet.absorb(absorber, accounts);
    }

    /// @notice CONTROL D — falsification probe: how much residual base supply is
    ///         enough to keep the market alive against the same borrow. A
    ///         guarded protocol would keep every row alive, so `expectHalt`
    ///         fails as a whole on a patched contract.
    /// @dev The two surviving rows are still far past the ceiling, which is the
    ///      point: survival is decided by whether the 64-bit index happens to
    ///      overflow, not by any protocol rule.
    function test_probe_dustThreshold() public {
        uint256[6] memory dust = [uint256(1), 2, 10, 1e3, 1e6, 1e9];
        // Pins the frontier documented in KF-02-accrual-halt.md §4.2.
        bool[6] memory expectHalt = [true, true, true, true, false, false];
        address lender = actors[0];
        address borrower = actors[1];
        address baseToken = address(base);

        for (uint256 i = 0; i < dust.length; i++) {
            uint256 snap = vm.snapshotState();

            vm.prank(lender);
            comet.supply(baseToken, 1_000e6);
            _collateralize(borrower);
            vm.prank(borrower);
            comet.withdraw(baseToken, 1_900e6);

            uint256 bal = comet.balanceOf(lender);
            vm.prank(lender);
            comet.withdraw(baseToken, bal - dust[i]);

            emit log_named_uint("--- dust (base units)", dust[i]);
            emit log_named_uint("    utilization", comet.getUtilization());

            bool halted = false;
            for (uint256 step = 0; step < 200 && !halted; step++) {
                vm.warp(block.timestamp + 60);
                try comet.accrueAccount(borrower) {}
                catch {
                    emit log_named_uint("    HALTED after seconds", (step + 1) * 60);
                    halted = true;
                }
            }
            if (!halted) emit log_string("    still ALIVE after 200 minutes");
            assertEq(halted, expectHalt[i], "probe: frontier moved from the documented one");

            vm.revertToState(snap);
        }
    }

    /// @notice EVIDENCE — the exact figures quoted in KF-02-accrual-halt.md §3
    ///         and §4.1. Asserted, not merely logged: if a figure moves, this
    ///         test fails and the write-up must be corrected with it.
    function test_evidence_reportNumbers() public {
        address borrower = actors[1];
        address baseToken = address(base);

        emit log_named_uint("uint64 max", type(uint64).max);
        emit log_named_uint("MAX_SUPPORTED_UTILIZATION", comet.MAX_SUPPORTED_UTILIZATION());
        emit log_named_uint("supplyPerSecondSlopeHigh", comet.supplyPerSecondInterestRateSlopeHigh());
        emit log_named_uint("borrowPerSecondSlopeHigh", comet.borrowPerSecondInterestRateSlopeHigh());

        _collateralize(borrower);
        vm.prank(borrower);
        comet.withdraw(baseToken, 3_776e6);
        emit log_named_uint("P1 utilization while supply==0", comet.getUtilization());
        assertEq(comet.getUtilization(), 0, "P1: zero-supply utilization must read as 0");

        vm.warp(block.timestamp + 60);
        comet.accrueAccount(borrower);
        vm.prank(actors[0]);
        comet.supply(baseToken, 2);

        uint256 util = comet.getUtilization();
        uint256 rate = _supplyRateModel(util);
        emit log_named_uint("P1 utilization after 2 wei supply", util);
        emit log_named_uint("P1 modelled supply rate (uint256)", rate);
        emit log_named_uint("P1 ratio to uint64 max (x100)", rate * 100 / type(uint64).max);

        assertEq(util, 1_888_000_035_500_000_000_000_000_000, "P1: utilization moved from the documented figure");
        assertEq(rate, 23_947_235_346_330_626_060, "P1: modelled rate moved from the documented figure");
        assertGt(rate, type(uint64).max, "P1: state is NOT past the overflow threshold");
        assertEq(rate * 100 / type(uint64).max, 129, "P1: ratio to uint64 max moved from the documented figure");
    }

    /// @notice EVIDENCE for scenario E — a borrow drawn entirely from reserves
    ///         is priced at the base rate only, because `getUtilization()`
    ///         reports 0 while supply is 0. An economic mispricing independent
    ///         of the accrual halt, sharing the same zero-supply convention.
    function test_evidence_zeroSupplyBorrowPricedAtBaseRateOnly() public {
        address borrower = actors[1];
        address baseToken = address(base);

        _collateralize(borrower);
        vm.prank(borrower);
        comet.withdraw(baseToken, 3_776e6);

        CometStorage.TotalsBasic memory t = cometI.totalsBasic();
        assertEq(t.totalSupplyBase, 0, "E: no base supplier must exist");
        assertGt(t.totalBorrowBase, 0, "E: the borrow must be live");
        assertEq(comet.getUtilization(), 0, "E: zero-supply utilization reads as 0");

        // 3776 USDC of reserves are lent out, yet the curve prices the market idle.
        uint64 charged = comet.getBorrowRate(comet.getUtilization());
        assertEq(charged, comet.borrowPerSecondInterestRateBase(), "E: not the bare base rate");

        emit log_named_uint("E: borrow drawn from reserves (base units)", t.totalBorrowBase);
        emit log_named_uint("E: charged rate  (per second, 1e18)", charged);
        emit log_named_uint("E: charged APR   (1e18 = 100%)", uint256(charged) * 31_536_000);
        emit log_named_uint(
            "E: APR the curve would charge at util 1.9e18", uint256(comet.getBorrowRate(1.9e18)) * 31_536_000
        );
    }
}
