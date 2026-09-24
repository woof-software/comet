// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { IListAccessGate } from "../interfaces/access-gate/IListAccessGate.sol";
import { AccessGateAction } from "../interfaces/access-gate/AccessGateTypes.sol";

import { DefaultAccessGate } from "./DefaultAccessGate.sol";

/**
 * @title List Access Gate
 * @author Woof
 * @notice Access Gate keeping a per-account list of actions on top of the pause state.
 *  Derived gates define whether being listed blocks or allows the action.
 * @dev REPAY is exempt from the list policy since it only reduces the protocol risk, and so are
 *  the governor actions (WITHDRAW_RESERVES, APPROVE_THIS). Pauses still apply to them.
 *  Absorbed accounts are never passed to the gate, so the list cannot prevent their liquidation.
 */
abstract contract ListAccessGate is IListAccessGate, DefaultAccessGate {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice The bitmap of listed actions per account
    mapping(address => uint16) public override listedActions;

    /// @param operators_ The initial holders of OPERATOR_ROLE
    constructor(
        address comet_,
        address governor_,
        address operatorAdmin_,
        address[] memory pausers_,
        address[] memory operators_
    ) DefaultAccessGate(comet_, governor_, operatorAdmin_, pausers_) {
        _setRoleAdmin(OPERATOR_ROLE, OPERATOR_ADMIN_ROLE);
        for (uint256 i; i < operators_.length; ++i) {
            if (operators_[i] == address(0)) revert ZeroAddress();
            _grantRole(OPERATOR_ROLE, operators_[i]);
        }
    }

    /**
     * @notice List or unlist the accounts for specified actions
     * @dev Reverts if an action or account is passed twice, or if an account already has the status for one of the actions
     * @param accounts The accounts to set access to actions for
     * @param actions The action identifiers, see `AccessGateAction`
     * @param listed Whether to list (`true`) or unlist (`false`)
     */
    function setListed(address[] calldata accounts, AccessGateAction[] calldata actions, bool listed) external override onlyRole(OPERATOR_ROLE) {
        uint16 mask;
        for (uint256 i; i < actions.length; ++i) {
            uint16 flag = uint16(1) << uint8(actions[i]);
            if (mask & flag != 0) revert DuplicateAction(actions[i]);
            mask |= flag;
        }

        for (uint256 i; i < accounts.length; ++i) {
            uint16 current = listedActions[accounts[i]];
            for (uint256 j; j < actions.length; ++j) {
                if ((current & (uint16(1) << uint8(actions[j])) != 0) == listed) revert ListedStatusAlreadySet(accounts[i], actions[j], listed);
            }
            listedActions[accounts[i]] = listed ? current | mask : current & ~mask;
        }

        emit ListedActionsSet(accounts, actions, listed);
    }

    /**
     * @notice Whether the account is listed for the action
     */
    function isListed(address account, AccessGateAction action) public view override returns (bool) {
        return listedActions[account] & (uint16(1) << uint8(action)) != 0;
    }

    /**
     * @notice Whether the account is blocked from the action by the list policy
     */
    function isBlocked(address account, AccessGateAction action) public view virtual override returns (bool);

    /**
     * @dev Pause check followed by the list check of both parties
     */
    function checkAccessInternal(
        AccessGateAction action,
        address operator,
        address account,
        address counterparty,
        uint8 assetIndex,
        uint256 amount
    ) internal virtual override {
        super.checkAccessInternal(action, operator, account, counterparty, assetIndex, amount);

        if (
            action == AccessGateAction.REPAY ||
            action == AccessGateAction.WITHDRAW_RESERVES ||
            action == AccessGateAction.APPROVE_THIS
        ) return;

        if (isBlocked(account, action)) revert Blocked(account, action);
        if (counterparty != address(0) && isBlocked(counterparty, action)) revert Blocked(counterparty, action);
    }
}
