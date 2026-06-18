// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ILiquidationAccessControl } from "../interfaces/liquidation-module/ILiquidationAccessControl.sol";

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
abstract contract LiquidationAccessControl is ILiquidationAccessControl {
    /// @notice Controls parameter setters (HF boundaries, liquidation mode, DEX adapter).
    address public multisig;

    /// @notice Controls roles and the pause switch.
    address public dao;

    /// @notice When true, the DEX liquidation path is disabled and keeper liquidations fall back
    ///         to the default absorb flow regardless of the account's health factor.
    bool public dexPaused;

    /// @notice Accounts allowed to call the keeper liquidation entry point. There can be several.
    mapping(address => bool) public isExecutor;

    /// @notice Accounts allowed to toggle the DEX pause switch. There can be several.
    mapping(address => bool) public isPauser;

    modifier onlyExecutor() {
        if (!isExecutor[msg.sender]) revert OnlyExecutor();
        _;
    }

    /// @dev Pausers and the DAO may toggle the pause switch.
    modifier onlyPauserOrDAO() {
        if (!isPauser[msg.sender] && msg.sender != dao) revert OnlyPauser();
        _;
    }

    modifier onlyMultisig() {
        if (msg.sender != multisig) revert OnlyMultisig();
        _;
    }

    modifier onlyDAO() {
        if (msg.sender != dao) revert OnlyDAO();
        _;
    }

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
        // The module must be deployed with at least one Executor and one Pauser.
        if (_executors.length == 0 || _pausers.length == 0) revert EmptyArray();

        _setMultisig(_multisig);

        // TODO: Can we use uint8 for the length of the arrays?

        for (uint256 i; i < _executors.length; ) {
            _setExecutor(_executors[i], true);
            unchecked { ++i; }
        }

        for (uint256 i; i < _pausers.length; ) {
            _setPauser(_pausers[i], true);
            unchecked { ++i; }
        }
    }

    /// @notice Grants or revokes the Executor role for a batch of accounts. DAO only.
    /// @param accounts The accounts to update.
    /// @param statuses The new Executor status for each account (parallel to `accounts`).
    function setExecutors(address[] calldata accounts, bool[] calldata statuses) external onlyDAO {
        _requireValidBatch(accounts.length, statuses.length);

        for (uint256 i; i < accounts.length; ) {
            _setExecutor(accounts[i], statuses[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Grants or revokes the Pauser role for a batch of accounts. DAO only.
    /// @param accounts The accounts to update.
    /// @param statuses The new Pauser status for each account (parallel to `accounts`).
    function setPausers(address[] calldata accounts, bool[] calldata statuses) external onlyDAO {
        _requireValidBatch(accounts.length, statuses.length);
        
        for (uint256 i; i < accounts.length; ) {
            _setPauser(accounts[i], statuses[i]);
            unchecked { ++i; }
        }
    }

    /// @notice Updates the Multisig address. DAO only.
    function setMultisig(address newMultisig) external onlyDAO {
        _setMultisig(newMultisig);
    }

    /// @notice Transfers the DAO role to a new account. DAO only.
    function transferDAO(address newDAO) external onlyDAO {
        _setDAO(newDAO);
    }

    /// @notice Toggles the DEX pause switch. Callable by a Pauser or the DAO.
    /// @dev While paused, keeper liquidations bypass the DEX/HF routing and run the default absorb flow.
    function setDexPaused(bool paused) external onlyPauserOrDAO {
        if (dexPaused == paused) revert AlreadySet();

        dexPaused = paused;
        
        emit DexPausedSet(paused);
    }

    /// @dev Sets the DAO. Used for both the initial value (module constructor) and later transfers.
    function _setDAO(address newDAO) internal {
        if (newDAO == address(0)) revert ZeroAddress();
        if (newDAO == dao) revert AlreadySet();

        emit DAOTransferred(dao, newDAO);
        
        dao = newDAO;
    }

    function _setMultisig(address newMultisig) internal {
        if (newMultisig == address(0)) revert ZeroAddress();
        if (newMultisig == multisig) revert AlreadySet();
        
        emit MultisigUpdated(multisig, newMultisig);
        
        multisig = newMultisig;
    }

    function _setExecutor(address account, bool enabled) internal {
        if (account == address(0)) revert ZeroAddress();
        if (isExecutor[account] == enabled) revert AlreadySet();
        
        isExecutor[account] = enabled;
        
        emit ExecutorSet(account, enabled);
    }

    function _setPauser(address account, bool enabled) internal {
        if (account == address(0)) revert ZeroAddress();
        if (isPauser[account] == enabled) revert AlreadySet();
        
        isPauser[account] = enabled;
        
        emit PauserSet(account, enabled);
    }

    /// @dev Reverts when a batch is empty or the parallel arrays differ in length.
    function _requireValidBatch(uint256 accountsLength, uint256 statusesLength) internal pure {
        if (accountsLength == 0) revert EmptyArray();
        if (accountsLength != statusesLength) revert ArrayLengthMismatch();
    }
}
