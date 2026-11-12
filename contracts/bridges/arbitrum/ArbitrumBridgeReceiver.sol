// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "../SweepableBridgeReceiver.sol";
import "./AddressAliasHelper.sol";

contract ArbitrumBridgeReceiver is SweepableBridgeReceiver {
    constructor(
        address _govTimelock,
        address _localTimelock
    ) BaseBridgeReceiver(_govTimelock, _localTimelock) {}

    fallback() external payable {
        processMessage(AddressAliasHelper.undoL1ToL2Alias(msg.sender), msg.data);
    }
}