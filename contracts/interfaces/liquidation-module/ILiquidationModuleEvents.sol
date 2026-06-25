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

    /// @notice Emitted when the multisig updates the executor penalty (in BPS) taken on the DEX route.
    event PenaltyBpsUpdated(uint256 oldPenaltyBps, uint256 newPenaltyBps);

    /// @notice Emitted when an account is liquidated through the DEX route.
    /// @param absorber The recipient of the liquidation incentive.
    /// @param account The liquidated account.
    /// @param executor The keeper that triggered the liquidation and received the penalty.
    /// @param baseReceived The total base realized from swapping the seized collateral.
    /// @param baseRepaid The base sent to Comet to clear the account's debt.
    /// @param penalty The base paid to the executor (baseReceived - baseRepaid).
    event DexLiquidate(
        address indexed absorber,
        address indexed account,
        address indexed executor,
        uint256 baseReceived,
        uint256 baseRepaid,
        uint256 penalty
    );
}
