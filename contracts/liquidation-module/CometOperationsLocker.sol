// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICometOperationsLock } from "../interfaces/comet-operations-locker/ICometOperationsLock.sol";

/**
 * @title Comet Operations Locker
 * @author Woof
 * @notice Mixin for modules that hand control to untrusted code while Comet's accounting is mid-update.
 *         It wraps such a call in Comet's operations lock, so the market stays closed until the module is done.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract CometOperationsLocker {
    /**
     * @notice Closes Comet's user operations for the whole call and reopens them at the end.
     * @dev The DEX liquidation route writes the outcome into Comet first — collateral seized, debt cleared —
     *      and only then sells the collateral through a router, which is arbitrary externally supplied code.
     *      While the lock is held every guarded Comet operation reverts with `OperationsLocked`, leaving the liquidation as the only
     *      party able to move the market.
     * @dev The lock is released on the way out, and any revert inside unwinds the whole transaction, so it
     *      can never outlive the call that took it.
     */
    modifier lockCometOperations() {
        ICometOperationsLock comet = _lockedComet();
        comet.lockOperations();
        _;
        comet.unlockOperations();
    }

    /**
     * @notice The Comet instance whose operations this contract locks.
     * @dev Supplied by the inheriting module, which is the only party Comet accepts the lock from.
     */
    function _lockedComet() internal view virtual returns (ICometOperationsLock);
}
