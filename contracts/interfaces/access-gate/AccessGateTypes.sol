// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @notice Comet actions checked by the Access Gate
 * @dev Append-only: gates keep per-action flags keyed by the member values.
 *  A Comet introducing a new action must be deployed together with a gate supporting it,
 *  since the ABI decoder of an older gate reverts on the unknown value.
 */
enum AccessGateAction {
    // Supply of base asset leaving the account with a positive balance
    SUPPLY_BASE,
    // Supply of base asset leaving the account with no positive balance (debt repayment)
    REPAY,
    // Supply of collateral asset
    SUPPLY_COLLATERAL,
    // Withdraw of base asset leaving the account with a non-negative balance (lender withdraw)
    WITHDRAW_BASE,
    // Withdraw of base asset leaving the account with a negative balance
    BORROW,
    // Withdraw of collateral asset
    WITHDRAW_COLLATERAL,
    // Transfer of base asset leaving the source with a non-negative balance (lender transfer)
    TRANSFER_BASE,
    // Transfer of base asset leaving the source with a negative balance
    TRANSFER_BASE_BORROW,
    // Transfer of collateral asset
    TRANSFER_COLLATERAL,
    // Absorption of underwater accounts
    ABSORB,
    // Purchase of collateral from protocol reserves
    BUY_COLLATERAL,
    // Withdraw of base reserves by the governor
    WITHDRAW_RESERVES,
    // Approval of Comet's tokens by the governor
    APPROVE_THIS
}

/// @dev The asset index passed for actions which are not bound to a collateral asset
uint8 constant NO_ASSET = type(uint8).max;

/// @dev Pause flags packed into a single storage slot
struct PauseState {
    /// @dev Bit per action, in the same order as `AccessGateAction`
    uint16 actions;
    /// @dev Bit per collateral asset offset, for SUPPLY_COLLATERAL
    uint24 collateralsSupply;
    /// @dev Bit per collateral asset offset, for WITHDRAW_COLLATERAL
    uint24 collateralsWithdraw;
    /// @dev Bit per collateral asset offset, for TRANSFER_COLLATERAL
    uint24 collateralsTransfer;
    /// @dev Bit per collateral asset offset, for BUY_COLLATERAL
    uint24 collateralsBuy;
}
