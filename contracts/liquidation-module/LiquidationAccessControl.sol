// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
 
import { ILiquidationAccessControlErrors } from "../interfaces/liquidation-module/ILiquidationAccessControlErrors.sol";
import { ILiquidationAccessControlEvents } from "../interfaces/liquidation-module/ILiquidationAccessControlEvents.sol";

/**
 * @title Liquidation Access Control
 * @author Woof
 * @notice Role-based access control shared by the liquidation module.
 * @dev Four roles:
 *      - Pauser   (many): toggles the DEX pause switch; while paused every keeper liquidation
 *                          falls back to the default absorb flow independent of the health factor.
 *      - Executor (many): the only accounts allowed to call the keeper liquidation entry point.
 *      - Multisig (one):  controls parameter setters.
 *      - DAO      (one):  controls roles and the pause switch.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract LiquidationAccessControl is AccessControl, ILiquidationAccessControlErrors, ILiquidationAccessControlEvents {
    /// @notice Executor is responsible for liquidations execution
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    /// @notice Multisig is responsible for contract's settings
    bytes32 public constant MULTISIG_ROLE = keccak256("MULTISIG_ROLE");
    /// @notice Pauser is responsible for turning on/off partial liquidation
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice The address of the Compound governance (DAO) timelock contract.
    ///         Is responsible for roles distribution
    address public constant DAO = 0x6d903f6003cca6255D85CcA4D3B5E5146dC33925;

    /// @notice Controls parameter setters (HF boundaries, liquidation mode, DEX adapter).
    address public immutable multisig;

    /// @notice When true, the DEX liquidation path is disabled and keeper liquidations fall back
    ///         to the default absorb flow regardless of the account's health factor.
    bool public dexRoutePaused;

    /// @notice Whether partial liquidation or full liquidation is enabled. Enabled by default.
    bool public partialLiquidationEnabled;

    /**
     * @param _multisig  The Multisig address: controls parameter setters.
     * @param _executors Initial set of Executor accounts (keeper liquidation callers).
     * @param _pausers   Initial set of Pauser accounts (DEX pause switch).
     * @dev The DAO is not set here; the inheriting module derives it from Comet via `_setDAO`.
     */
    constructor(
        address _multisig,
        address[] memory _executors,
        address[] memory _pausers
    ) {
        partialLiquidationEnabled = true;
        
        // The module must be deployed with at least one Executor and one Pauser.
        if (_executors.length == 0 || _pausers.length == 0) revert EmptyArray();
        if (_executors.length > type(uint8).max || _pausers.length > type(uint8).max) revert ArrayLengthMismatch();
        if (_multisig == address(0)) revert ZeroAddress();


        _grantRole(DEFAULT_ADMIN_ROLE, DAO);
        _grantRole(MULTISIG_ROLE, _multisig);
        multisig = _multisig;

        for (uint8 i; i < _executors.length; ) {
            if (_executors[i] == address(0)) revert ZeroAddress();
            if (hasRole(EXECUTOR_ROLE, _executors[i])) revert AlreadySet();

            _grantRole(EXECUTOR_ROLE, _executors[i]);
            unchecked { ++i; }
        }

        for (uint8 i; i < _pausers.length; ) {
            if (_pausers[i] == address(0)) revert ZeroAddress();
            if (hasRole(PAUSER_ROLE, _pausers[i])) revert AlreadySet();

            _grantRole(PAUSER_ROLE, _pausers[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Toggles the DEX pause switch. Callable by a Pauser or the DAO.
    /// @dev While paused, keeper liquidations bypass the DEX/HF routing and run the default absorb flow.
    function setDexRoutePaused(bool paused) external onlyRole(PAUSER_ROLE) {
        if (dexRoutePaused == paused) revert AlreadySet();

        dexRoutePaused = paused;
        
        emit DexPausedSet(paused);
    }

        /**
     * @notice Toggle the liquidation mode. Multisig only (parameter setter).
     */
    function liquidationModeToggle(bool _partialLiquidationEnabled) external onlyRole(PAUSER_ROLE) {
        if (partialLiquidationEnabled == _partialLiquidationEnabled) revert AlreadySet();

        partialLiquidationEnabled = _partialLiquidationEnabled;

        emit LiquidationModeToggled(_partialLiquidationEnabled);
    }
}
