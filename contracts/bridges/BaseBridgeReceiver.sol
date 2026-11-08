// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { ITimelock } from "../interfaces/ITimelock.sol";
import { IBaseBridgeReceiver } from "../interfaces/bridges/IBaseBridgeReceiver.sol";

/**
 * @title Base Bridge Receiver
 * @author Compound
 * @notice Local governor of an L2: queues proposals bridged from the governing timelock in the local timelock,
 *  executes them, and lets the guardian cancel them.
 */
contract BaseBridgeReceiver is IBaseBridgeReceiver {
    /*//////////////////////////////////////////////////////////////
                         CONSTANTS / IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @dev Selector of `setGuardian`, whose proposals the guardian can't cancel
    bytes4 internal constant SET_GUARDIAN_SELECTOR = IBaseBridgeReceiver.setGuardian.selector;

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

    /// @notice Address that can cancel queued proposals, except the ones setting the guardian
    address public guardian;

    /**
     * @notice Construct a new BaseBridgeReceiver instance
     * @dev The local timelock must be deployed before this contract. On a new chain it is deployed with this contract
     * (at its predicted address) as admin, which marks the admin role accepted here. An existing timelock makes this
     * contract its pending admin through a proposal, accepted with `acceptLocalTimelockAdmin`
     * @param _govTimelock Address of the governing contract that this contract
     * will receive messages from (likely on another chain)
     * @param _localTimelock Address of the timelock contract that this contract
     * will send messages to
     * @param _initialGuardian Address that can cancel queued proposals
     */
    constructor(address _govTimelock, address _localTimelock, address _initialGuardian) {
        if (_govTimelock == address(0) || _localTimelock == address(0) || _initialGuardian == address(0)) revert ZeroValue();
        govTimelock = _govTimelock;
        localTimelock = ITimelock(_localTimelock);
        guardian = _initialGuardian;
        adminAccepted = ITimelock(_localTimelock).admin() == address(this);
        emit NewGuardian(address(0), _initialGuardian);
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
     * @notice Set the guardian
     * @dev Callable only by the local timelock, so only a proposal can change it
     * @param newGuardian Address that can cancel queued proposals
     */
    function setGuardian(address newGuardian) external {
        if (msg.sender != address(localTimelock)) revert Unauthorized();
        address oldGuardian = guardian;
        if (newGuardian == oldGuardian) revert SameValue();
        guardian = newGuardian;
        emit NewGuardian(oldGuardian, newGuardian);
    }

    /**
     * @notice Process a message sent from the governing timelock (across a bridge)
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

        (targets, values, signatures, calldatas) = abi.decode(
            data,
            (address[], uint256[], string[], bytes[])
        );

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
            canceled: false
        });

        proposals[proposal.id] = proposal;
        emit ProposalCreated(rootMessageSender, proposal.id, targets, values, signatures, calldatas, eta);
    }

    /**
     * @notice Execute a queued proposal
     * @param proposalId The id of the proposal to execute
     */
    function executeProposal(uint256 proposalId) external {
        if (state(proposalId) != ProposalState.Queued) revert ProposalNotExecutable();
        Proposal storage proposal = proposals[proposalId];
        proposal.executed = true;
        for (uint256 i = 0; i < proposal.targets.length; ++i) {
            localTimelock.executeTransaction(proposal.targets[i], proposal.values[i], proposal.signatures[i], proposal.calldatas[i], proposal.eta);
        }
        emit ProposalExecuted(proposalId);
    }

    /**
     * @notice Cancel a queued proposal and its transactions in the local timelock
     * @dev Callable only by the guardian, until the proposal is executed or expires. A proposal calling
     * `setGuardian` on this contract can't be canceled, so the guardian can't block its own replacement
     * @param proposalId The id of the proposal to cancel
     */
    function cancelProposal(uint256 proposalId) external {
        if (msg.sender != guardian) revert GuardianUnauthorized();
        if (state(proposalId) != ProposalState.Queued) revert ProposalNotQueued();

        Proposal storage proposal = proposals[proposalId];
        proposal.canceled = true;
        for (uint256 i = 0; i < proposal.targets.length; ++i) {
            // Disallow canceling proposals that set the guardian itself; the revert also undoes the transactions canceled so far
            if (proposal.targets[i] == address(this) &&
                _selectorOf(proposal.signatures[i], proposal.calldatas[i]) == SET_GUARDIAN_SELECTOR) {
                revert ProposalNotCancelable();
            }
            localTimelock.cancelTransaction(proposal.targets[i], proposal.values[i], proposal.signatures[i], proposal.calldatas[i], proposal.eta);
        }
        emit ProposalCanceled(proposalId);
    }

    /**
     * @notice Get the state of a proposal
     * @param proposalId Id of the proposal
     * @return The state of the given proposal (queued, expired, executed or canceled)
     */
    function state(uint256 proposalId) public view returns (ProposalState) {
        if (proposalId > proposalCount || proposalId == 0) revert InvalidProposalId();
        Proposal memory proposal = proposals[proposalId];
        if (proposal.executed) {
            return ProposalState.Executed;
        } else if (proposal.canceled) {
            return ProposalState.Canceled;
        } else if (block.timestamp > (proposal.eta + localTimelock.GRACE_PERIOD())) {
            return ProposalState.Expired;
        } else {
            return ProposalState.Queued;
        }
    }

    /**
     * @notice Get the selector the local timelock calls for a transaction
     * @dev Mirrors Timelock.executeTransaction: the selector of the signature, or the first 4 bytes
     * of the calldata when the signature is empty
     * @param signature Function signature of the transaction
     * @param data Calldata of the transaction
     * @return The selector of the called function
     */
    function _selectorOf(string memory signature, bytes memory data) internal pure returns (bytes4) {
        return bytes(signature).length == 0 ? bytes4(data) : bytes4(keccak256(bytes(signature)));
    }
}
