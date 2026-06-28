// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Liquidation Access Control Events
 * @author Woof
 * @notice Events emitted by the liquidation module's role-based access control.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationAccessControlEvents {
    /// @notice Emitted when the DAO grants or revokes the Executor role for an account.
    event ExecutorSet(address indexed account, bool enabled);

    /// @notice Emitted when the DAO grants or revokes the Pauser role for an account.
    event PauserSet(address indexed account, bool enabled);

    /// @notice Emitted when the DAO updates the Multisig address.
    event MultisigUpdated(address indexed oldMultisig, address indexed newMultisig);

    /// @notice Emitted when the DAO role is transferred to a new account.
    event DAOTransferred(address indexed oldDAO, address indexed newDAO);

    /// @notice Emitted when the DEX pause switch is toggled by a Pauser or the DAO.
    event DexPausedSet(bool paused);

    /**
     * @notice Emitted when the liquidation mode is toggled.
     * @param partialLiquidationEnabled Whether partial liquidation is enabled.
     */
    event LiquidationModeToggled(bool partialLiquidationEnabled);
}
