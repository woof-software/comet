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
        // Batch identifier, zero for a proposal outside any batch
        bytes32 batchId;
        // Zero-based position of the proposal in its batch, used only when a proposal is a part of a batch
        uint256 batchIndex;
    }

    /// @notice Progress of a batch: proposals that must execute one after another, in the order set on L1
    struct Batch {
        // Number of proposals in the batch
        uint256 size;
        // Bit `i` is set once the proposal at position `i` of the batch is queued
        uint256 queuedPositions;
        // Number of proposals of the batch executed so far, also the index of the next one to execute
        uint256 executedCount;
    }

    /// @notice The state of a bridged proposal
    enum ProposalState {
        Queued,
        Expired,
        Executed
    }
}
