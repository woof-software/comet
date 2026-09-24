// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessGateAction } from "./AccessGateTypes.sol";

/**
 * @title Compound's Comet Access Gate Interface
 * @notice Access control policy bound to a single Comet. Comet calls `checkAccess` before
 *  and `postAccessAction` after every gated action (see `AccessGateAction`)
 * @dev Parties passed for each action:
 *
 *  | action                                      | operator   | account      | counterparty |
 *  |---------------------------------------------|------------|--------------|--------------|
 *  | SUPPLY_BASE, REPAY, SUPPLY_COLLATERAL        | msg.sender | dst          | from         |
 *  | WITHDRAW_BASE, BORROW, WITHDRAW_COLLATERAL   | msg.sender | src          | to           |
 *  | TRANSFER_BASE(_BORROW), TRANSFER_COLLATERAL  | msg.sender | src          | dst          |
 *  | ABSORB                                      | msg.sender | msg.sender   | absorber     |
 *  | BUY_COLLATERAL                              | msg.sender | msg.sender   | recipient    |
 *  | WITHDRAW_RESERVES                           | msg.sender | Comet        | to           |
 *  | APPROVE_THIS                                | msg.sender | Comet        | manager      |
 *
 *  `assetIndex` is the collateral offset for the collateral actions (including BUY_COLLATERAL),
 *  and `NO_ASSET` otherwise.
 *  `amount` is the amount of the asset in its own units (base amount for BUY_COLLATERAL,
 *  the number of accounts for ABSORB). `postAccessAction` receives the actually transferred amount.
 * @author Woof
 */
interface IAccessGate {
    /// @notice The Comet proxy this gate is bound to
    function comet() external view returns (address);

    /**
     * @notice Check whether the action is permitted, reverts if not
     * @param action The action identifier, see `AccessGateAction`
     * @param operator The caller of Comet
     * @param account The account whose position is primarily affected
     * @param counterparty The other party of the action
     * @param assetIndex The collateral asset offset, or `NO_ASSET`
     * @param amount The amount of the action
     */
    function checkAccess(
        AccessGateAction action,
        address operator,
        address account,
        address counterparty,
        uint8 assetIndex,
        uint256 amount
    ) external;

    /**
     * @notice Hook called after the action has been performed
     * @dev Parameters are the same as for `checkAccess`
     */
    function postAccessAction(
        AccessGateAction action,
        address operator,
        address account,
        address counterparty,
        uint8 assetIndex,
        uint256 amount
    ) external;
}
