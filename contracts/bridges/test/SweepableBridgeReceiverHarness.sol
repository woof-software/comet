// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "../SweepableBridgeReceiver.sol";

contract SweepableBridgeReceiverHarness is SweepableBridgeReceiver {
    constructor(
        address _govTimelock,
        address _localTimelock,
        address _initialGuardian
    ) BaseBridgeReceiver(_govTimelock, _localTimelock, _initialGuardian) {}

    function processMessageExternal(
        address rootMessageSender,
        bytes calldata data
    ) external {
        processMessage(rootMessageSender, data);
    }

    fallback() external payable { }
}
