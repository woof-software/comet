// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessGateAction } from "./AccessGateTypes.sol";
import { IDefaultAccessGate } from "./IDefaultAccessGate.sol";
import { IListAccessGateErrors } from "./IListAccessGateErrors.sol";
import { IListAccessGateEvents } from "./IListAccessGateEvents.sol";

/**
 * @title List Access Gate Interface
 * @author Woof
 * @notice Access Gate applying a per-account status of each action on top of the pause state.
 */
interface IListAccessGate is IDefaultAccessGate, IListAccessGateErrors, IListAccessGateEvents {
    function listedActions(address account) external view returns (uint16);

    function setListed(address[] calldata accounts, AccessGateAction[] calldata actions, bool listed) external;

    function isListed(address account, AccessGateAction action) external view returns (bool);

    function isBlocked(address account, AccessGateAction action) external view returns (bool);
}
