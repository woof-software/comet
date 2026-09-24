// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessGateAction } from "./AccessGateTypes.sol";

/**
 * @title List Access Gate Events
 * @author Woof
 */
interface IListAccessGateEvents {
    /// @notice Emitted when accounts are listed or unlisted for actions.
    /// @param accounts The accounts.
    /// @param actions The action identifiers, see `AccessGateAction`.
    /// @param listed Whether the accounts are now listed for the actions.
    event ListedActionsSet(address[] accounts, AccessGateAction[] actions, bool listed);
}
