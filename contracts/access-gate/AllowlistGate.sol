// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessGateAction } from "../interfaces/access-gate/AccessGateTypes.sol";

import { ListAccessGate } from "./ListAccessGate.sol";

/**
 * @title Compound's Comet Allowlist Gate
 * @author Woof
 * @notice Access Gate blocking all accounts from all actions unless allowlisted for the action
 * @dev Integrations acting as a party of an action (e.g. Bulker as `from` / `to`) and liquidators
 *  must be allowlisted as well
 */
contract AllowlistGate is ListAccessGate {
    constructor(
        address comet_,
        address governor_,
        address operatorAdmin_,
        address[] memory pausers_,
        address[] memory operators_
    ) ListAccessGate(comet_, governor_, operatorAdmin_, pausers_, operators_) {}

    /**
     * @notice Whether the account is blocked from the action by the list policy
     */
    function isBlocked(address account, AccessGateAction action) public view override returns (bool) {
        return !isListed(account, action);
    }
}
