// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "../SweepableBridgeReceiver.sol";
import "./AddressAliasHelper.sol";

contract ArbitrumBridgeReceiver is SweepableBridgeReceiver {
    constructor(
        address _govTimelock,
        address _localTimelock,
        address _initialGuardian
    ) BaseBridgeReceiver(_govTimelock, _localTimelock, _initialGuardian) {}

    fallback() external payable {
        processMessage(AddressAliasHelper.undoL1ToL2Alias(msg.sender), msg.data);
    }
}