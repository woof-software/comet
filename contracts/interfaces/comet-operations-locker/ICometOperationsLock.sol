// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICometOperationsLockEvents } from "./ICometOperationsLockEvents.sol";
import { ICometOperationsLockErrors } from "./ICometOperationsLockErrors.sol";

/**
 * @title Comet Operations Lock Interface
 * @author Woof
 * @notice Lets the market's liquidation module close Comet's user operations for the duration of a single
 *         liquidation, so nobody can act on the market while its books are still mid-update.
 * @dev Implemented by Comet through its extension delegate. Function documentation is maintained in the
 *      implementation contract (`CometExt`); the reason a module takes the lock is documented on
 *      `CometOperationsLocker.lockCometOperations`.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICometOperationsLock is ICometOperationsLockEvents, ICometOperationsLockErrors {
    /// @notice Closes Comet's guarded operations until the caller releases the lock.
    function lockOperations() external;

    /// @notice Reopens Comet's guarded operations.
    function unlockOperations() external;
}
