// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ILiquidationAccessControlErrors } from "./ILiquidationAccessControlErrors.sol";
import { ILiquidationAccessControlEvents } from "./ILiquidationAccessControlEvents.sol";

/**
 * @title Liquidation Access Control Interface
 * @author Woof
 * @notice External surface of the liquidation module's role-based access control:
 *         Pausers (DEX pause switch), Executors (keeper liquidation), Multisig (parameter setters)
 *         and DAO (roles, pause and the one-way module shutdown).
 * @dev Function documentation is maintained in the implementation contract.
 * @custom:security-contact dmitriy@woof.software
 */
interface ILiquidationAccessControl is ILiquidationAccessControlErrors, ILiquidationAccessControlEvents {
    function isExecutor(address account) external view returns (bool);

    function isPauser(address account) external view returns (bool);

    function multisig() external view returns (address);

    function dao() external view returns (address);

    function dexPaused() external view returns (bool);

    function setExecutors(address[] calldata accounts, bool[] calldata statuses) external;

    function setPausers(address[] calldata accounts, bool[] calldata statuses) external;

    function setMultisig(address newMultisig) external;

    function transferDAO(address newDAO) external;

    function setDexPaused(bool paused) external;
}
