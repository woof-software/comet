// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

import { CometMainInterfaceBase } from "../CometMainInterface.sol";
import { IAccessGate } from "../interfaces/access-gate/IAccessGate.sol";
import { IDefaultAccessGate } from "../interfaces/access-gate/IDefaultAccessGate.sol";
import { AccessGateAction, NO_ASSET, PauseState } from "../interfaces/access-gate/AccessGateTypes.sol";

/**
 * @title Default Access Gate
 * @author Woof
 * @notice Access Gate holding the pause state of its Comet.
 * @dev Roles:
 *  - DEFAULT_ADMIN_ROLE (governor): admin of OPERATOR_ADMIN_ROLE
 *  - OPERATOR_ADMIN_ROLE (governor, operational multisig): admin of PAUSER_ROLE and gate-specific operational roles
 *  - PAUSER_ROLE: pauses and unpauses actions
 *  The governor is always allowed to pause and unpause, regardless of the roles it holds.
 */
contract DefaultAccessGate is IDefaultAccessGate, AccessControl {
    bytes32 public constant OPERATOR_ADMIN_ROLE = keccak256("OPERATOR_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice The Comet proxy this gate is bound to
    address public immutable override comet;
    /// @notice The governor of the Comet
    address public immutable override governor;
    
    /// @notice The pause flags
    PauseState public pauseState;

    /**
     * @param comet_ The Comet proxy the gate is bound to
     * @param governor_ The governor of the Comet
     * @param operatorAdmin_ The operational admin (e.g. multisig), or zero address for none
     * @param pausers_ The initial holders of PAUSER_ROLE
     */
    constructor(address comet_, address governor_, address operatorAdmin_, address[] memory pausers_) {
        if (comet_ == address(0) || governor_ == address(0)) revert ZeroAddress();

        comet = comet_;
        governor = governor_;

        _grantRole(DEFAULT_ADMIN_ROLE, governor_);
        _grantRole(OPERATOR_ADMIN_ROLE, governor_);
        if (operatorAdmin_ != address(0)) _grantRole(OPERATOR_ADMIN_ROLE, operatorAdmin_);

        _setRoleAdmin(PAUSER_ROLE, OPERATOR_ADMIN_ROLE);
        for (uint256 i; i < pausers_.length; ++i) {
            if (pausers_[i] == address(0)) revert ZeroAddress();
            _grantRole(PAUSER_ROLE, pausers_[i]);
        }
    }

    modifier onlyComet() {
        if (msg.sender != comet) revert Unauthorized();
        _;
    }

    modifier onlyPauser() {
        if (msg.sender != governor && !hasRole(PAUSER_ROLE, msg.sender)) revert Unauthorized();
        _;
    }

    /**
     * @inheritdoc IAccessGate
     */
    function checkAccess(
        AccessGateAction action,
        address operator,
        address account,
        address counterparty,
        uint8 assetIndex,
        uint256 amount
    ) external override onlyComet {
        checkAccessInternal(action, operator, account, counterparty, assetIndex, amount);
    }

    /**
     * @inheritdoc IAccessGate
     */
    function postAccessAction(
        AccessGateAction action,
        address operator,
        address account,
        address counterparty,
        uint8 assetIndex,
        uint256 amount
    ) external override onlyComet {
        postAccessActionInternal(action, operator, account, counterparty, assetIndex, amount);
    }

    /**
     * @notice Whether the action is paused, either entirely or for the given collateral asset
     * @param action The action identifier, see `AccessGateAction`
     * @param assetIndex The collateral asset offset, or `NO_ASSET`
     */
    function isPaused(AccessGateAction action, uint8 assetIndex) public view override returns (bool) {
        PauseState memory state = pauseState;
        if (state.actions & (uint16(1) << uint8(action)) != 0) return true;
        return collateralFlags(state, action) & (uint24(1) << assetIndex) != 0;
    }

    /**
     * @notice Pause or unpause an action entirely
     * @param action The action identifier, see `AccessGateAction`
     * @param paused Whether to pause (`true`) or unpause (`false`)
     */
    function setActionPaused(AccessGateAction action, bool paused) external override onlyPauser {
        uint16 actions = pauseState.actions;
        uint16 flag = uint16(1) << uint8(action);
        if ((actions & flag != 0) == paused) revert PauseStatusAlreadySet(action, NO_ASSET, paused);

        pauseState.actions = paused ? actions | flag : actions & ~flag;

        emit PauseAction(action, paused);
    }

    /**
     * @notice Pause or unpause a collateral action for a collateral asset
     * @param action One of SUPPLY_COLLATERAL, WITHDRAW_COLLATERAL, TRANSFER_COLLATERAL, BUY_COLLATERAL
     * @param assetIndex The collateral asset offset
     * @param paused Whether to pause (`true`) or unpause (`false`)
     */
    function setCollateralPaused(AccessGateAction action, uint8 assetIndex, bool paused) external override onlyPauser {
        if (assetIndex >= CometMainInterfaceBase(comet).numAssets()) revert InvalidAssetIndex(assetIndex);

        setCollateralPausedInternal(action, assetIndex, paused);
    }

    /**
     * @notice Pause or unpause a collateral action for a collateral asset, looking up its offset in Comet
     * @dev Reverts with Comet's `BadAsset` if the asset is not a collateral of the Comet
     * @param action One of SUPPLY_COLLATERAL, WITHDRAW_COLLATERAL, TRANSFER_COLLATERAL, BUY_COLLATERAL
     * @param asset The collateral asset address
     * @param paused Whether to pause (`true`) or unpause (`false`)
     */
    function setCollateralPausedByAddress(AccessGateAction action, address asset, bool paused) external override onlyPauser {
        setCollateralPausedInternal(action, CometMainInterfaceBase(comet).getAssetInfoByAddress(asset).offset, paused);
    }

    /**
     * @dev Access check, reverts if the action is not permitted. Extended by derived gates
     */
    function checkAccessInternal(
        AccessGateAction action,
        address /* operator */,
        address /* account */,
        address /* counterparty */,
        uint8 assetIndex,
        uint256 /* amount */
    ) internal virtual {
        if (isPaused(action, assetIndex)) revert Paused(action, assetIndex);
    }

    /**
     * @dev Post-action hook, no-op by default. Extended by derived gates
     */
    function postAccessActionInternal(
        AccessGateAction /* action */,
        address /* operator */,
        address /* account */,
        address /* counterparty */,
        uint8 /* assetIndex */,
        uint256 /* amount */
    ) internal virtual {}

    /**
     * @dev Pause or unpause a collateral action for a collateral asset with a validated offset
     */
    function setCollateralPausedInternal(AccessGateAction action, uint8 assetIndex, bool paused) internal {
        if (
            action != AccessGateAction.SUPPLY_COLLATERAL &&
            action != AccessGateAction.WITHDRAW_COLLATERAL &&
            action != AccessGateAction.TRANSFER_COLLATERAL &&
            action != AccessGateAction.BUY_COLLATERAL
        ) revert InvalidAction(action);

        PauseState memory state = pauseState;
        uint24 flags = collateralFlags(state, action);
        uint24 flag = uint24(1) << assetIndex;
        if ((flags & flag != 0) == paused) revert PauseStatusAlreadySet(action, assetIndex, paused);

        flags = paused ? flags | flag : flags & ~flag;
        if (action == AccessGateAction.SUPPLY_COLLATERAL) state.collateralsSupply = flags;
        else if (action == AccessGateAction.WITHDRAW_COLLATERAL) state.collateralsWithdraw = flags;
        else if (action == AccessGateAction.TRANSFER_COLLATERAL) state.collateralsTransfer = flags;
        else state.collateralsBuy = flags;
        pauseState = state;

        emit PauseCollateralAction(action, assetIndex, paused);
    }

    /**
     * @dev The per-asset flags of the collateral action, 0 for other actions
     */
    function collateralFlags(PauseState memory state, AccessGateAction action) internal pure returns (uint24) {
        if (action == AccessGateAction.SUPPLY_COLLATERAL) return state.collateralsSupply;
        if (action == AccessGateAction.WITHDRAW_COLLATERAL) return state.collateralsWithdraw;
        if (action == AccessGateAction.TRANSFER_COLLATERAL) return state.collateralsTransfer;
        if (action == AccessGateAction.BUY_COLLATERAL) return state.collateralsBuy;
        return 0;
    }
}
