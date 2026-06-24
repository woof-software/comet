// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICometData } from "./ICometData.sol";

/**
 * @title Comet liquidation helpers
 * @author Woof
 * @notice Comet interface for liquidation helpers calls.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICometLiquidationInterface {
    /*//////////////////////////////////////////////////////////////
                        LIQUIDATION MODULE PART
    //////////////////////////////////////////////////////////////*/

    function updateCollateral(address account, uint8 index, uint128 seizedAmount) external;
    function updateDebtAndPrincipal(address account, int256 newBalance) external;

}
