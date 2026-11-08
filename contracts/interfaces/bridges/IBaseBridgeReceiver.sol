// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ITimelock } from "../ITimelock.sol";
import { IBaseBridgeReceiverErrors } from "./IBaseBridgeReceiverErrors.sol";
import { IBaseBridgeReceiverEvents } from "./IBaseBridgeReceiverEvents.sol";
import { IBaseBridgeReceiverStructs } from "./IBaseBridgeReceiverStructs.sol";

/**
 * @title Base Bridge Receiver Interface
 * @author Compound
 */
interface IBaseBridgeReceiver is IBaseBridgeReceiverErrors, IBaseBridgeReceiverEvents, IBaseBridgeReceiverStructs {
    function govTimelock() external view returns (address);

    function localTimelock() external view returns (ITimelock);

    function adminAccepted() external view returns (bool);

    function proposalCount() external view returns (uint256);

    function proposals(uint256 proposalId) external view returns (uint256 id, uint256 eta, bool executed, bool canceled);

    function guardian() external view returns (address);

    function acceptLocalTimelockAdmin() external;

    function setGuardian(address newGuardian) external;

    function executeProposal(uint256 proposalId) external;

    function cancelProposal(uint256 proposalId) external;

    function state(uint256 proposalId) external view returns (ProposalState);
}
