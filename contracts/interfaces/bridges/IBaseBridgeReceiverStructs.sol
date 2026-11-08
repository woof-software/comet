// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Base Bridge Receiver Structs
 * @author Compound
 */
interface IBaseBridgeReceiverStructs {
    /// @notice A bridged proposal, whose transactions are queued in the local timelock
    struct Proposal {
        uint id;
        address[] targets;
        uint[] values;
        string[] signatures;
        bytes[] calldatas;
        uint eta;
        bool executed;
        bool canceled;
    }

    /// @notice The state of a bridged proposal
    enum ProposalState {
        Queued,
        Expired,
        Executed,
        Canceled
    }
}
