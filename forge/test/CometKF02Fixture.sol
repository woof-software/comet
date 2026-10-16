// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.15;

import {Test} from "forge-std/Test.sol";
import {AssetListFactory} from "@comet-contracts/AssetListFactory.sol";
import {CometConfiguration} from "@comet-contracts/CometConfiguration.sol";
import {CometExtAssetList} from "@comet-contracts/CometExtAssetList.sol";
import {CometInterface} from "@comet-contracts/CometInterface.sol";
import {CometWithExtendedAssetList} from "@comet-contracts/CometWithExtendedAssetList.sol";
import {FaucetToken} from "@comet-contracts/test/FaucetToken.sol";
import {SimplePriceFeed} from "@comet-contracts/test/SimplePriceFeed.sol";

/// @dev Minimal interface to `SimplePriceFeed.setRoundData`. Used to crash
///      collateral prices when a borrower has to be pushed underwater.
interface SimplePriceFeedLike {
    function setRoundData(uint80, int256, uint256, uint256, uint80) external;
}

/// @title Market fixture shared by the two KF-02 suites.
/// @notice Deploys a `CometWithExtendedAssetList` market and funds a small set
///         of actors. The market ships with base cash but no base supplier,
///         which is the starting state both suites build on: a borrow can be
///         opened while `totalSupplyBase` is still zero.
/// @dev Abstract so forge does not pick it up as a test suite of its own.
abstract contract CometKF02Fixture is Test, CometConfiguration {
    // ── environment size ────────────────────────────────────────
    uint8 internal constant NUM_ASSETS = 24; // MAX_ASSETS_FOR_ASSET_LIST
    uint256 internal constant NUM_ACTORS = 3; // lender, borrower, absorber

    // ── economic parameters ─────────────────────────────────────
    // Liquidity is comparable to what the actors can move, so reserves stay
    // near zero and a borrow can be funded with no base supplier present.
    uint256 internal constant INITIAL_BASE_LIQUIDITY = 20_000e6;
    uint256 internal constant TARGET_RESERVES = 50_000e6;
    uint256 internal constant ACTOR_BASE_FUNDS = 100_000e6;
    uint256 internal constant BASE_BORROW_MIN = 100e6;
    uint256 internal constant ACTOR_COLL_UNITS = 40;
    uint256 internal constant SUPPLY_CAP_UNITS = 100; // < 4 x 40, so the cap stays reachable

    // ── expected revert selectors ───────────────────────────────
    bytes4 internal constant INVALID_UINT64 = bytes4(keccak256("InvalidUInt64()"));
    bytes4 internal constant EXCEEDS_UTIL = bytes4(keccak256("ExceedsSupportedUtilization()"));

    // ── market under test ───────────────────────────────────────
    CometWithExtendedAssetList internal comet;
    CometInterface internal cometI; // cast used to reach the extension delegate

    FaucetToken internal base; // USDC-like, 6 decimals
    SimplePriceFeed internal basePriceFeed;

    FaucetToken[] internal collaterals;
    SimplePriceFeed[] internal collateralFeeds;

    address[] internal actors;

    function setUp() public virtual {
        _deployCore();
        _setupActors(NUM_ACTORS);
    }

    // ═══════════════ asset parameters ═══════════════════════════
    // Deterministic but heterogeneous. Decimals are mixed (18/8/6) because a
    // uniform set hides scaling mistakes. Prices are held inside one order of
    // magnitude ($50..$225) so that collateral value stays comparable to the
    // base liquidity; otherwise collateral dwarfs base, borrows hit the
    // liquidity ceiling and no liquidation is ever reachable.

    function _assetDecimals(uint256 i) internal pure returns (uint8) {
        if (i % 3 == 0) return 18;
        if (i % 3 == 1) return 8;
        return 6;
    }

    /// @return Starting price in 8 decimals ($50 .. $225).
    function _assetStartPrice(uint256 i) internal pure returns (uint256) {
        return (50 + (i % 8) * 25) * 1e8;
    }

    /// @dev The asset list requires borrowCF < liquidateCF, otherwise the
    ///      constructor reverts with `BorrowCFTooLarge`.
    function _assetBorrowCF(uint256 i) internal pure returns (uint64) {
        return uint64(0.6e18 + (i % 4) * 0.05e18); // 0.60 / 0.65 / 0.70 / 0.75
    }

    function _assetLiquidateCF(uint256 i) internal pure returns (uint64) {
        return _assetBorrowCF(i) + 0.05e18; // 0.65 / 0.70 / 0.75 / 0.80
    }

    function _assetLiquidationFactor(uint256 i) internal pure returns (uint64) {
        return uint64(0.9e18 + (i % 2) * 0.05e18); // 0.90 / 0.95
    }

    // ═══════════════ deployment ═════════════════════════════════

    function _deployCore() internal {
        base = new FaucetToken(0, "USD Coin", 6, "USDC");
        basePriceFeed = new SimplePriceFeed(1e8, 8); // $1, PRICE_FEED_DECIMALS

        AssetConfig[] memory assetConfigs = new AssetConfig[](NUM_ASSETS);

        for (uint256 i = 0; i < NUM_ASSETS; i++) {
            uint8 dec = _assetDecimals(i);
            FaucetToken token = new FaucetToken(0, "Collateral", dec, "COL");
            SimplePriceFeed feed = new SimplePriceFeed(int256(_assetStartPrice(i)), 8);

            collaterals.push(token);
            collateralFeeds.push(feed);

            assetConfigs[i] = AssetConfig({
                asset: address(token),
                priceFeed: address(feed),
                decimals: dec,
                borrowCollateralFactor: _assetBorrowCF(i),
                liquidateCollateralFactor: _assetLiquidateCF(i),
                liquidationFactor: _assetLiquidationFactor(i),
                // The asset list stores the cap in whole units (uint64), so
                // multiplying by the scale round-trips exactly.
                supplyCap: uint128(SUPPLY_CAP_UNITS * (10 ** dec))
            });
        }

        AssetListFactory factory = new AssetListFactory();
        CometExtAssetList ext =
            new CometExtAssetList(ExtConfiguration({name32: "Compound USDC", symbol32: "cUSDCv3"}), address(factory));

        comet = new CometWithExtendedAssetList(_configuration(address(ext), assetConfigs));
        comet.initializeStorage();
        cometI = CometInterface(address(comet));

        // Base cash with no base supplier: this is what lets a borrow exist
        // while `totalSupplyBase` is still zero.
        base.allocateTo(address(comet), INITIAL_BASE_LIQUIDITY);
    }

    /// @dev Split out of `_deployCore` to keep the stack small.
    function _configuration(address ext, AssetConfig[] memory assetConfigs)
        internal
        view
        returns (Configuration memory)
    {
        return Configuration({
            governor: address(this),
            pauseGuardian: address(this),
            baseToken: address(base),
            baseTokenPriceFeed: address(basePriceFeed),
            extensionDelegate: ext,
            supplyKink: 0.8e18,
            supplyPerYearInterestRateSlopeLow: 0.04e18,
            supplyPerYearInterestRateSlopeHigh: 0.4e18,
            supplyPerYearInterestRateBase: 0,
            borrowKink: 0.8e18,
            borrowPerYearInterestRateSlopeLow: 0.05e18,
            borrowPerYearInterestRateSlopeHigh: 0.5e18,
            borrowPerYearInterestRateBase: 0.01e18,
            storeFrontPriceFactor: 0.5e18,
            trackingIndexScale: 1e15,
            // The (speed, baseMinForRewards) pair is not arbitrary.
            // `accrueInternal` computes
            //   trackingIndex += safe64(speed * dt * baseScale / totalSupplyBase)
            // so baseMinForRewards must be large enough that the division
            // cannot overflow the 64-bit index. With speed = 1e13 and
            // min = 100e6 the index grows ~1.9e17 against the uint64 ceiling
            // of 1.8e19 — a ~95x margin. A smaller minimum overflows on its
            // own and would mask the KF-02 overflow being measured here.
            baseTrackingSupplySpeed: 1e13,
            baseTrackingBorrowSpeed: 1e13,
            baseMinForRewards: uint104(100e6),
            baseBorrowMin: uint104(BASE_BORROW_MIN),
            targetReserves: uint104(TARGET_RESERVES),
            assetConfigs: assetConfigs
        });
    }

    function _setupActors(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            actors.push(address(uint160(0x1000 + i)));
        }

        for (uint256 i = 0; i < n; i++) {
            address a = actors[i];

            base.allocateTo(a, ACTOR_BASE_FUNDS);
            for (uint256 c = 0; c < collaterals.length; c++) {
                collaterals[c].allocateTo(a, ACTOR_COLL_UNITS * (10 ** _assetDecimals(c)));
            }

            vm.startPrank(a);
            base.approve(address(comet), type(uint256).max);
            for (uint256 c = 0; c < collaterals.length; c++) {
                collaterals[c].approve(address(comet), type(uint256).max);
            }
            vm.stopPrank();
        }
    }

    // ═══════════════ shared helpers ═════════════════════════════

    /// @dev Posts every collateral an actor holds, so it can open a borrow.
    function _collateralize(address who) internal {
        vm.startPrank(who);
        for (uint256 i = 0; i < 3; i++) {
            address c = address(collaterals[i]);
            comet.supply(c, collaterals[i].balanceOf(who));
        }
        vm.stopPrank();
    }

    /// @dev Independent uint256 reference for the supply rate, mirroring
    ///      `getSupplyRate` without its `safe64` clamp — so it can measure how
    ///      far past uint64 the production rate would land. Deliberately does
    ///      not call the contract under test.
    function _supplyRateModel(uint256 utilization) internal view returns (uint256) {
        uint256 kink = comet.supplyKink();
        uint256 rateBase = comet.supplyPerSecondInterestRateBase();
        uint256 slopeLow = comet.supplyPerSecondInterestRateSlopeLow();
        uint256 slopeHigh = comet.supplyPerSecondInterestRateSlopeHigh();
        if (utilization <= kink) return rateBase + (slopeLow * utilization) / 1e18;
        return rateBase + (slopeLow * kink) / 1e18 + (slopeHigh * (utilization - kink)) / 1e18;
    }
}
