// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Base Bridge Receiver Errors
 * @author Compound
 */
interface IBaseBridgeReceiverErrors {
    /// @notice Reverts when the receiver has already accepted the admin role of the local timelock.
    error AdminAlreadyAccepted();

    /// @notice Reverts when the arrays of a bridged proposal differ in length.
    error BadData();

    /// @notice Reverts when the caller cancelling a proposal is not the guardian.
    error GuardianUnauthorized();

    /// @notice Reverts when the proposal id is zero or above the proposal count.
    error InvalidProposalId();

    /// @notice Reverts when the guardian tries to cancel a proposal that replaces the guardian (calls `setGuardian`
    /// on the receiver), so the guardian can't block its own replacement.
    error ProposalNotCancelable();

    /// @notice Reverts when executing a proposal that is already executed, canceled or expired.
    error ProposalNotExecutable();

    /// @notice Reverts when canceling a proposal that is already executed, canceled or expired.
    error ProposalNotQueued();

    /// @notice Reverts when the guardian is set to its current address.
    error SameValue();

    /// @notice Reverts when a transaction of a bridged proposal is already queued in the local timelock with the same eta.
    error TransactionAlreadyQueued();

    /// @notice Reverts when the caller, or the sender of a bridged message, is not permitted.
    error Unauthorized();

    /// @notice Reverts when the governing timelock, the local timelock or the guardian is the zero address on deployment.
    error ZeroValue();
}
