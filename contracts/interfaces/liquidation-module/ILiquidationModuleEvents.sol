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
    /// @notice Emitted when the multisig updates the executor incentive (in BPS) taken on the DEX route.
    event IncentiveBpsUpdated(uint16 oldIncentiveBps, uint16 newIncentiveBps);

    /// @notice Emitted when an account is liquidated through the DEX route.
    /// @param absorber The recipient of the liquidation incentive.
    /// @param account The liquidated account.
    /// @param executor The keeper that triggered the liquidation and received the incentive.
    /// @param baseReceived The total base realized from swapping the seized collateral.
    /// @param baseRepaid The base sent to Comet to clear the account's debt.
    /// @param incentive The base paid to the executor (baseReceived - baseRepaid).
    event DexLiquidate(
        address indexed absorber,
        address indexed account,
        address indexed executor,
        uint256 baseReceived,
        uint256 baseRepaid,
        uint256 incentive
    );

    event BadDebtLiquidate(
        address indexed absorber,
        address indexed account,
        address indexed executor,
        uint256 baseReceived
    );
}
