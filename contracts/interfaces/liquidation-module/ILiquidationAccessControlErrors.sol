// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Liquidation Access Control Errors
 * @author Woof
 * @notice Errors emitted by the liquidation module's role-based access control.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationAccessControlErrors {
    error ZeroAddress();

    /// @notice Reverts when a non-Executor calls the keeper liquidation entry point.
    error OnlyExecutor();

    /// @notice Reverts when a non-Pauser (and non-DAO) tries to toggle the DEX pause switch.
    error OnlyPauser();

    /// @notice Reverts when a non-Multisig calls a parameter setter.
    error OnlyMultisig();

    /// @notice Reverts when a non-DAO calls a role-management function.
    error OnlyDAO();

    error EmptyArray();

    /// @notice Reverts when a batch role update's `accounts` and `statuses` arrays differ in length.
    error ArrayLengthMismatch();

    /// @notice Reverts when a role/address is already set to the requested value (no-op).
    error AlreadySet();
}
