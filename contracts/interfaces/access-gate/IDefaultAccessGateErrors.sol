// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessGateAction } from "./AccessGateTypes.sol";

/**
 * @title Default Access Gate Errors
 * @author Woof
 */
interface IDefaultAccessGateErrors {
    /// @notice Reverts when a per-asset pause is set for an action which is not a collateral action.
    error InvalidAction(AccessGateAction action);

    /// @notice Reverts when the collateral asset offset is beyond the Comet assets.
    error InvalidAssetIndex(uint8 assetIndex);

    /// @notice Reverts when the action is paused, entirely (assetIndex is NO_ASSET) or for the collateral asset.
    error Paused(AccessGateAction action, uint8 assetIndex);

    /// @notice Reverts when the pause status being set is already the current one.
    error PauseStatusAlreadySet(AccessGateAction action, uint8 assetIndex, bool paused);

    /// @notice Reverts when the caller is not permitted to call the function.
    error Unauthorized();

    /// @notice Reverts when a zero address is provided.
    error ZeroAddress();
}
