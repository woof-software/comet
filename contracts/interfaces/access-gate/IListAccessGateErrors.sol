// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessGateAction } from "./AccessGateTypes.sol";

/**
 * @title List Access Gate Errors
 * @author Woof
 */
interface IListAccessGateErrors {
    /// @notice Reverts when a party of the action is blocked from it by the list policy.
    error Blocked(address account, AccessGateAction action);

    /// @notice Reverts when an action is passed more than once.
    error DuplicateAction(AccessGateAction action);

    /// @notice Reverts when the listed status being set for the account is already the current one.
    error ListedStatusAlreadySet(address account, AccessGateAction action, bool listed);
}
