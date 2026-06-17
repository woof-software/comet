// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Liquidation Module Interface
 * @author Woof
 * @notice Errors and events specific to LiquidationModule — the extended module that adds a
 *         DEX-based liquidation path gated by configurable health factor boundaries.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationModuleEvents {
    /// @notice Emitted when the governor updates the border health factor threshold.
    event BorderHFUpdated(uint256 oldBorderHF, uint256 newBorderHF);

    /// @notice Emitted when the governor updates the healthy position health factor threshold.
    event HealthPositionHFUpdated(uint256 oldHealthPositionHF, uint256 newHealthPositionHF);
}
