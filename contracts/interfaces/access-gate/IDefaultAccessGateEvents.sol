// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessGateAction } from "./AccessGateTypes.sol";

/**
 * @title Default Access Gate Events
 * @author Woof
 */
interface IDefaultAccessGateEvents {
    /// @notice Emitted when an action is paused or unpaused entirely.
    /// @param action The action identifier, see `AccessGateAction`.
    /// @param paused Whether the action is now paused.
    event PauseAction(AccessGateAction action, bool paused);

    /// @notice Emitted when a collateral action is paused or unpaused for a collateral asset.
    /// @param action The collateral action identifier, see `AccessGateAction`.
    /// @param assetIndex The collateral asset offset.
    /// @param paused Whether the action is now paused for the asset.
    event PauseCollateralAction(AccessGateAction action, uint8 assetIndex, bool paused);
}
