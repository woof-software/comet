// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @dev Contract with no receive() or payable fallback.
 * Any raw ETH transfer to this address reverts, used to trigger
 * FailedToSendNativeToken() in the Bulker's withdrawNativeTokenTo handler.
 */
contract NonPayableReceiver {
}
