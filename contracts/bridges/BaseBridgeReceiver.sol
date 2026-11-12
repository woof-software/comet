// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { ITimelock } from "../interfaces/ITimelock.sol";
import { IBaseBridgeReceiver } from "../interfaces/bridges/IBaseBridgeReceiver.sol";

/**
 * @title Base Bridge Receiver
 * @author Compound
 * @notice Local governor of an L2: queues proposals bridged from the governing timelock in the local timelock and
 *  executes them, in the order set on L1 for the proposals of a batch.
 */
contract BaseBridgeReceiver is IBaseBridgeReceiver {
    /*//////////////////////////////////////////////////////////////
                         CONSTANTS / IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @dev Head size of a message outside any batch: one word for each of its 4 arrays
    uint256 internal constant MESSAGE_HEAD_SIZE = 4 * 32;

    /// @dev Head size of a message in a batch: its 4 arrays, then batchId, index and size
    uint256 internal constant BATCHED_MESSAGE_HEAD_SIZE = 7 * 32;

    /// @dev Largest number of proposals in a batch: one bit of `Batch.queuedPositions` for each position
    uint256 internal constant MAX_BATCH_SIZE = 256;

    /// @notice Address of the governing contract that this bridge receiver expects to
    ///  receive messages from; likely an address from another chain (e.g. mainnet)
    address public immutable govTimelock;

    /// @notice Timelock on this chain that the bridge receiver will send messages to
    ITimelock public immutable localTimelock;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Whether contract has taken the admin role of the local timelock, at deployment or with `acceptLocalTimelockAdmin`
    bool public adminAccepted;

    /// @notice Total count of proposals generated
    uint256 public proposalCount;

    /// @notice Mapping of proposal ids to their full proposal data
    mapping (uint256 => Proposal) public proposals;

    /// @notice Mapping of batch ids to the progress of the batch
    mapping (bytes32 => Batch) public batches;

    /**
     * @notice Construct a new BaseBridgeReceiver instance
     * @dev The local timelock must be deployed before this contract. On a new chain it is deployed with this contract
     * (at its predicted address) as admin, which marks the admin role accepted here. An existing timelock makes this
     * contract its pending admin through a proposal, accepted with `acceptLocalTimelockAdmin`
     * @param _govTimelock Address of the governing contract that this contract
     * will receive messages from (likely on another chain)
     * @param _localTimelock Address of the timelock contract that this contract
     * will send messages to
     */
    constructor(address _govTimelock, address _localTimelock) {
        if (_govTimelock == address(0) || _localTimelock == address(0)) revert ZeroValue();
        govTimelock = _govTimelock;
        localTimelock = ITimelock(_localTimelock);
        adminAccepted = ITimelock(_localTimelock).admin() == address(this);
    }

    /**
     * @notice Accept the admin role of the local timelock, once.
     * @dev Should be used for existing timelocks to migrate the admin role.
     * @dev Succeeds only after governance made this contract the pending admin of the local timelock.
     */
    function acceptLocalTimelockAdmin() external {
        if (adminAccepted) revert AdminAlreadyAccepted();
        adminAccepted = true;
        localTimelock.acceptAdmin();
    }

    /**
     * @notice Process a message sent from the governing timelock (across a bridge)
     * @dev A message is `abi.encode(targets, values, signatures, calldatas)` for a proposal outside any batch, or
     * `abi.encode(targets, values, signatures, calldatas, batchId, index, size)` for the proposal at the zero-based
     * `index` of a batch of `size` proposals, at most `MAX_BATCH_SIZE`. The messages of a batch may arrive in any order.
     * @param rootMessageSender Address of the contract that sent the bridged message
     * @param data ABI-encoded bytes containing the transactions to be queued on the local timelock
     */
    function processMessage(
        address rootMessageSender,
        bytes calldata data
    ) internal {
        if (rootMessageSender != govTimelock) revert Unauthorized();

        address[] memory targets;
        uint256[] memory values;
        string[] memory signatures;
        bytes[] memory calldatas;
        bytes32 batchId;
        uint256 index;
        uint256 size;

        // The first word of the encoding is the offset of the first array, which starts right after the head
        uint256 headSize = uint256(bytes32(data[:32]));
        if (headSize == MESSAGE_HEAD_SIZE) {
            (targets, values, signatures, calldatas) = abi.decode(
                data,
                (address[], uint256[], string[], bytes[])
            );
        } else if (headSize == BATCHED_MESSAGE_HEAD_SIZE) {
            (targets, values, signatures, calldatas, batchId, index, size) = abi.decode(
                data,
                (address[], uint256[], string[], bytes[], bytes32, uint256, uint256)
            );
            // The first message of a batch sets its size, the others must carry the same one
            Batch storage batch = batches[batchId];
            if (
                batchId == bytes32(0) ||
                index >= size ||
                size > MAX_BATCH_SIZE ||
                (batch.size != 0 && batch.size != size)
            ) revert BadData();
            if (batch.queuedPositions & (1 << index) != 0) revert BatchPositionAlreadyQueued();
        } else {
            revert BadData();
        }

        if (values.length != targets.length) revert BadData();
        if (signatures.length != targets.length) revert BadData();
        if (calldatas.length != targets.length) revert BadData();

        uint256 delay = localTimelock.delay();
        uint256 eta = block.timestamp + delay;

        for (uint256 i = 0; i < targets.length; ++i) {
            if (localTimelock.queuedTransactions(keccak256(abi.encode(targets[i], values[i], signatures[i], calldatas[i], eta)))) revert TransactionAlreadyQueued();
            localTimelock.queueTransaction(targets[i], values[i], signatures[i], calldatas[i], eta);
        }

        ++proposalCount;
        Proposal memory proposal = Proposal({
            id: proposalCount,
            targets: targets,
            values: values,
            signatures: signatures,
            calldatas: calldatas,
            eta: eta,
            executed: false,
            batchId: batchId,
            batchIndex: index
        });

        proposals[proposal.id] = proposal;
        emit ProposalCreated(rootMessageSender, proposal.id, targets, values, signatures, calldatas, eta);

        // Record the proposal's position if it belongs to a batch
        if (batchId != bytes32(0)) {
            Batch storage batch = batches[batchId];
            batch.size = size;
            batch.queuedPositions |= 1 << index;
            emit ProposalBatched(proposal.id, batchId, index, size);
        }
    }

    /**
     * @notice Execute a queued proposal
     * @dev A proposal of a batch executes only once all proposals of the batch are queued, and only after the
     * previous proposals of the batch
     * @param proposalId The id of the proposal to execute
     */
    function executeProposal(uint256 proposalId) external {
        if (state(proposalId) != ProposalState.Queued) revert ProposalNotExecutable();

        Proposal storage proposal = proposals[proposalId];
        if (proposal.batchId != bytes32(0)) {
            Batch storage batch = batches[proposal.batchId];
            // All positions are queued when the `size` lowest bits are set
            if (batch.queuedPositions != type(uint256).max >> (MAX_BATCH_SIZE - batch.size)) revert BatchIncomplete();
            if (proposal.batchIndex != batch.executedCount) revert ProposalOutOfOrder();
            ++batch.executedCount;
        }

        proposal.executed = true;
        for (uint256 i = 0; i < proposal.targets.length; ++i) {
            localTimelock.executeTransaction(proposal.targets[i], proposal.values[i], proposal.signatures[i], proposal.calldatas[i], proposal.eta);
        }
        emit ProposalExecuted(proposalId);
    }

    /**
     * @notice Get the state of a proposal
     * @param proposalId Id of the proposal
     * @return The state of the given proposal (queued, expired or executed)
     */
    function state(uint256 proposalId) public view returns (ProposalState) {
        if (proposalId > proposalCount || proposalId == 0) revert InvalidProposalId();
        Proposal memory proposal = proposals[proposalId];
        if (proposal.executed) {
            return ProposalState.Executed;
        } else if (block.timestamp > (proposal.eta + localTimelock.GRACE_PERIOD())) {
            return ProposalState.Expired;
        } else {
            return ProposalState.Queued;
        }
    }

    /**
     * @notice Get the number of proposals of a batch queued so far
     * @param batchId Identifier of the batch
     * @return count The number of queued positions of the batch, zero for an unknown batch
     */
    function batchQueuedCount(bytes32 batchId) external view returns (uint256 count) {
        Batch memory batch = batches[batchId];
        for (uint256 i = 0; i < batch.size; ++i) {
            if (batch.queuedPositions & (1 << i) != 0) ++count;
        }
    }
}
