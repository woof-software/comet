// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Base Bridge Receiver Errors
 * @author Compound
 */
interface IBaseBridgeReceiverErrors {
    /// @notice Reverts when the receiver has already accepted the admin role of the local timelock.
    error AdminAlreadyAccepted();

    /// @notice Reverts when a bridged message is malformed: its arrays differ in length, its layout is unknown, or its
    /// batch data is invalid (zero batch id, index out of the batch size, size above 256, or a size different from the
    /// batch's).
    error BadData();

    /// @notice Reverts when executing a proposal of a batch whose proposals are not all queued yet.
    error BatchIncomplete();

    /// @notice Reverts when a bridged message takes a batch position that is already queued.
    error BatchPositionAlreadyQueued();

    /// @notice Reverts when the proposal id is zero or above the proposal count.
    error InvalidProposalId();

    /// @notice Reverts when executing a proposal that is already executed or expired.
    error ProposalNotExecutable();

    /// @notice Reverts when executing a proposal of a batch before the previous proposals of the batch.
    error ProposalOutOfOrder();

    /// @notice Reverts when a transaction of a bridged proposal is already queued in the local timelock with the same eta.
    error TransactionAlreadyQueued();

    /// @notice Reverts when the caller, or the sender of a bridged message, is not permitted.
    error Unauthorized();

    /// @notice Reverts when the governing timelock or the local timelock is the zero address on deployment.
    error ZeroValue();
}
