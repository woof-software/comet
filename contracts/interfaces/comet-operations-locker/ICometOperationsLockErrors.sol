// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Comet Operations Lock Errors
 * @author Woof
 * @notice Errors shared by Comet, which owns the lock, and by the modules that take it.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICometOperationsLockErrors {
    /**
     * @dev Thrown when a guarded Comet operation is attempted while a liquidation holds the lock, and when
     *      the lock is requested while Comet is already busy.
     */
    error OperationsLocked();

    /**
     * @dev Thrown when the caller is not the market's liquidation module, or when it tries to release a lock
     *      it does not hold.
     */
    error NotAuthorizedModule();
}
