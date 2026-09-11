// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Comet Operations Lock Events
 * @author Woof
 * @notice Events marking the window in which Comet is closed to user operations.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICometOperationsLockEvents {
    /**
     * @notice Emitted when Comet's guarded operations are closed for a liquidation
     * @param module The liquidation module that took the lock
     */
    event OperationsLockAcquired(address indexed module);

    /**
     * @notice Emitted when Comet's guarded operations are reopened
     * @param module The liquidation module that released the lock
     */
    event OperationsLockReleased(address indexed module);
}
