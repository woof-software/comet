// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { IERC20 } from "../../IERC20.sol";

struct SwapDescription {
        address srcToken;
        address dstToken;
        address srcReceiver;
        address dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
    }

interface IOneInchV6 {
    /// @notice Performs a swap
    /// @param executor Aggregation executor that executes calls described in data
    /// @param desc Swap description containing all swap parameters
    /// @param data Encoded calls that executor should execute in between of swaps
    /// @return returnAmount Resulting token amount received
    /// @return spentAmount Source token amount spent
    function swap(
        address executor,
        SwapDescription calldata desc,
        bytes calldata data
    ) external payable returns (uint256 returnAmount, uint256 spentAmount);
}