// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Base Bridge Receiver Events
 * @author Compound
 */
interface IBaseBridgeReceiverEvents {
    /// @notice Emitted when a bridged proposal of a batch is queued, right after its ProposalCreated.
    /// @param id The proposal id.
    /// @param batchId The batch identifier.
    /// @param index The zero-based position of the proposal in the batch.
    /// @param size The number of proposals in the batch.
    event ProposalBatched(uint256 indexed id, bytes32 indexed batchId, uint256 index, uint256 size);

    /// @notice Emitted when the transactions of a bridged proposal are queued in the local timelock.
    /// @param rootMessageSender The sender of the bridged message, the governing timelock.
    /// @param id The proposal id.
    /// @param targets The target addresses of the transactions.
    /// @param values The values sent with the transactions.
    /// @param signatures The function signatures of the transactions.
    /// @param calldatas The calldata of the transactions.
    /// @param eta The timestamp from which the proposal can be executed.
    event ProposalCreated(address indexed rootMessageSender, uint256 id, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 eta);

    /// @notice Emitted when a queued proposal is executed.
    /// @param id The proposal id.
    event ProposalExecuted(uint256 indexed id);
}
