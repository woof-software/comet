// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ILiquidationModule } from "../interfaces/liquidation-module/ILiquidationModule.sol";
import { CoreLiquidationModule, CometStorage } from "./CoreLiquidationModule.sol";

/**
 * @title Liquidation Module
 * @author Woof
 * @notice Extends DefaultLiquidationModule with a DEX-based liquidation path gated by
 *         configurable health factor boundaries.
 * @custom:security-contact dmitriy@woof.software
 */
contract LiquidationModule is ILiquidationModule, CoreLiquidationModule {
    /// @notice used for DEX-path liquidations.
    address public dexAdapter;

    /// @notice HF threshold (1e18 scale). Positions at or below this value are routed to the
    ///         default protocol liquidation. Must always be strictly less than healthPositionHF.
    uint256 public borderHF;

    /// @notice HF threshold (1e18 scale). Positions above this value are considered healthy and
    ///         cannot be liquidated. Must always be strictly greater than borderHF.
    uint256 public healthPositionHF;

    /**
     * @param comet_           The address of the Comet for default liquidation path.
     * @param dexAdapter_      The address of the DEX adapter for DEX-based liquidation.
     * @param borderHF_        Initial HF boundary (1e18 scale) for DEX-based liquidation.
     * @param healthPositionHF_ Initial HF boundary (1e18 scale) above which the position is healthy.
     */
    constructor(
        address comet_,
        address dexAdapter_,
        uint256 borderHF_,
        uint256 healthPositionHF_
    ) CoreLiquidationModule(comet_) {
        if (dexAdapter_ == address(0)) revert ZeroAddress();
        if (borderHF_ == 0 || borderHF_ >= healthPositionHF_) revert InvalidHFBoundaries();

        dexAdapter = dexAdapter_;
        borderHF = borderHF_;
        healthPositionHF = healthPositionHF_;

        emit BorderHFUpdated(0, borderHF_);
        emit HealthPositionHFUpdated(0, healthPositionHF_);
    }

    /**
     * @notice Routes liquidation to the appropriate path based on the account's current HF.
     * @dev Caller must be the bound Comet instance.
     *
     *      HF = liquidityValue * FACTOR_SCALE / debtValue  (1e18 scale)
     *
     *      - HF > healthPositionHF              → reverts NotLiquidatable
     *      - borderHF < HF <= healthPositionHF  → reverts DexLiquidationNotImplemented (stub)
     *      - HF <= borderHF                     → delegates to DefaultLiquidationModule.liquidate
     *
     * @param absorber The recipient of the liquidation incentive.
     * @param account  The underwater account to liquidate.
     */
    function liquidate(address absorber, address account, bytes calldata) external {
        comet.accrueAccount(account);

        CometStorage.UserBasic memory accountUser = comet.getUserBasic(account);

        uint256 debtValue = mulPrice(
            uint256(-comet.presentValueExternal(accountUser.principal)),
            getPrice(comet.baseTokenPriceFeed()),
            baseScale
        );
        (uint256 liquidityValue, ) = _getLiquidity(accountUser, account, true, new uint256[](0));

        uint256 currentHF = liquidityValue * FACTOR_SCALE / debtValue;

        if (currentHF > healthPositionHF) {
            revert NotLiquidatable();
        } else if (currentHF > borderHF) {
            // add try-catch block (if revert need to think what we need to do)
            // either revert or go to default liquidation in CoreLiquidationModule
            revert DexLiquidationNotImplemented();
        } else {
            _liquidate(absorber, account);
        }
    }

    /**
     * @notice Updates the border health factor threshold.
     * @dev Reverts if the new value is zero or not strictly less than the current healthPositionHF.
     * @param newBorderHF New BORDER_HF value in 1e18 scale.
     */
    function setBorderHF(uint256 newBorderHF) external onlyGovernor {
        if (newBorderHF == 0 || newBorderHF >= healthPositionHF) revert InvalidHFBoundaries();

        emit BorderHFUpdated(borderHF, newBorderHF);
        borderHF = newBorderHF;
    }

    /**
     * @notice Updates the healthy position health factor threshold.
     * @dev Reverts if the new value is zero or not strictly greater than the current borderHF.
     * @param newHealthPositionHF New HEALTH_POSITION_HF value in 1e18 scale.
     */
    function setHealthPositionHF(uint256 newHealthPositionHF) external onlyGovernor {
        if (newHealthPositionHF <= borderHF) revert InvalidHFBoundaries();

        emit HealthPositionHFUpdated(healthPositionHF, newHealthPositionHF);
        healthPositionHF = newHealthPositionHF;
    }
}
