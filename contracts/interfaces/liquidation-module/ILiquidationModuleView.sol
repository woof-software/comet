// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Liquidation Module View interface
 * @author Woof
 * @notice Read-only config surface of a liquidation module, used to bind a LiquidationSeizureView helper to it.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationModuleView {
    function comet() external view returns (address);
    function assetList() external view returns (address);
    function baseScale() external view returns (uint64);
    function numAssets() external view returns (uint8);
    function partialLiquidationEnabled() external view returns (bool);
}
