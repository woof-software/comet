// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { Address } from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title ReentrantDexAdapter
 * @author Woof
 * @notice TEST-ONLY DEX adapter that re-enters an arbitrary call while a liquidation is mid-flight.
 *         `swap` is the point where the real adapter hands control to an externally supplied router, so it
 *         is the window an attacker controls. The router calldata the liquidation forwards carries the whole
 *         attack — an encoded (target, calldata) pair — so one stateless adapter covers every operation the
 *         Comet lock closes. A rejected call reverts the swap, and the liquidation with it. It matches the
 *         ICoreDexAdapter surface the LiquidationModule calls (by selector) without importing the interface.
 *         NOT FOR PRODUCTION.
 */
contract ReentrantDexAdapter {
    // ── ICoreDexAdapter surface the market wires up on deployment ──

    /// @dev Comet's `initializeStorage` reaches this through `LiquidationModule.initiateModule`.
    function initiateAdapter(address) external {}

    /// @dev Comet's constructor reaches this through `LiquidationModule.setAssetList`.
    function setAssetList(address, uint8, address) external {}

    /**
     * @dev Makes the encoded call while Comet's books are mid-update. Empty swap data disarms the
     *      re-entrancy; `functionCall` bubbles the original revert, so a rejected operation surfaces as
     *      its own error on the liquidation.
     * @param swapData abi.encode(target, callData): the contract to call, and the call to make on it.
     */
    function swap(address, uint256, bytes calldata swapData) external returns (bool) {
        if (swapData.length != 0) {
            (address target, bytes memory callData) = abi.decode(swapData, (address, bytes));
            Address.functionCall(target, callData);
        }

        return true;
    }
}
