// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./IMessageService.sol";
import "../SweepableBridgeReceiver.sol";

contract LineaBridgeReceiver is SweepableBridgeReceiver {
    /// @notice Address of Linea Message Service
    IMessageService public messageService;

    constructor(
        address _messageService,
        address _govTimelock,
        address _localTimelock,
        address _initialGuardian
    ) BaseBridgeReceiver(_govTimelock, _localTimelock, _initialGuardian) {
        messageService = IMessageService(_messageService);
    }

    fallback() external payable {
        if (msg.sender != address(messageService)) revert Unauthorized();
        processMessage(messageService.sender(), msg.data);
    }
}
