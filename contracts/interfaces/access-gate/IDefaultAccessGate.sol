// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessGateAction } from "./AccessGateTypes.sol";
import { IAccessGate } from "./IAccessGate.sol";
import { IDefaultAccessGateErrors } from "./IDefaultAccessGateErrors.sol";
import { IDefaultAccessGateEvents } from "./IDefaultAccessGateEvents.sol";

/**
 * @title Default Access Gate Interface
 * @author Woof
 * @notice Access Gate holding the pause state of its Comet.
 */
interface IDefaultAccessGate is IAccessGate, IDefaultAccessGateErrors, IDefaultAccessGateEvents {
    function governor() external view returns (address);

    function isPaused(AccessGateAction action, uint8 assetIndex) external view returns (bool);

    function setActionPaused(AccessGateAction action, bool paused) external;

    function setCollateralPaused(AccessGateAction action, uint8 assetIndex, bool paused) external;

    function setCollateralPausedByAddress(AccessGateAction action, address asset, bool paused) external;
}
