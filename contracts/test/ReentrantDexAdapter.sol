// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title ReentrantDexAdapter
 * @author Woof
 * @notice TEST-ONLY DEX adapter that re-enters an arbitrary call while a liquidation is mid-flight.
 *         `swap` is the point where the real adapter hands control to an externally supplied router, so it
 *         is the window an attacker controls. Here the call made in that window is supplied by the test as
 *         raw calldata, which lets one adapter cover every operation the Comet lock is meant to close.
 *         It matches the ICoreDexAdapter surface the LiquidationModule calls (by selector) without
 *         importing the interface. NOT FOR PRODUCTION.
 */
contract ReentrantDexAdapter {
    address public comet;

    /// @notice The contract the re-entrant call is made against; Comet when left unset.
    address public reentrantTarget;

    /// @notice Raw calldata replayed inside `swap`. Empty calldata disarms the re-entrancy.
    bytes public reentrantCallData;

    /// @notice What `swap` reports back to the module: true if the collateral was sold, false if swept.
    bool public swapResult = true;

    /// @notice Whether a failed re-entrant call takes the liquidation down with it, or is only recorded.
    /// @dev Bubbling shows what a caller sees; recording lets the liquidation finish so the test can read
    ///      the exact revert data the locked operation produced.
    bool public bubbleUpRevert = true;

    /// @notice Whether the re-entrant call was attempted during the last swap.
    bool public reentered;

    /// @notice Whether that call went through; false means Comet rejected it.
    bool public reentrantCallSucceeded;

    /// @notice The call's return data, or its revert data when it failed.
    bytes public reentrantReturnData;

    /**
     * @notice Arms the re-entrancy for the next swap.
     * @param target The contract to call; the zero address means Comet.
     * @param callData The call to make, encoded by the test.
     */
    function setReentrantCall(address target, bytes calldata callData) external {
        reentrantTarget = target;
        reentrantCallData = callData;
    }

    /// @notice Sets what `swap` reports back to the liquidation module.
    function setSwapResult(bool result) external {
        swapResult = result;
    }

    /// @notice Chooses whether a rejected re-entrant call reverts the whole liquidation or is recorded.
    function setBubbleUpRevert(bool bubble) external {
        bubbleUpRevert = bubble;
    }

    // ── ICoreDexAdapter surface (no-ops except swap) ──

    function initiateAdapter(address comet_) external {
        comet = comet_;
    }

    function setAssetList(address, uint8, address) external {}

    function setSlippageBps(uint16, address) external {}

    /// @dev Makes the armed call while Comet's books are mid-update, then reports the swap outcome.
    function swap(address, uint256, bytes calldata) external returns (bool) {
        if (reentrantCallData.length != 0) {
            address target = reentrantTarget == address(0) ? comet : reentrantTarget;
            (bool ok, bytes memory returnData) = target.call(reentrantCallData);

            reentered = true;
            reentrantCallSucceeded = ok;
            reentrantReturnData = returnData;

            if (!ok && bubbleUpRevert) {
                assembly ("memory-safe") {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
        }

        return swapResult;
    }
}
