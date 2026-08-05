// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ILiquidationModule } from "../interfaces/liquidation-module/ILiquidationModule.sol";

import { CoreLiquidationModule } from "./CoreLiquidationModule.sol";

/**
 * @title Liquidation Module
 * @author Woof
 * @notice Base liquidation module exposing a keeper-driven absorb liquidation entry point on top of
 *         CoreLiquidationModule. Every keeper liquidation runs the default
 *         absorb flow.
 * @custom:security-contact dmitriy@woof.software
 */
contract LiquidationModule is ILiquidationModule, CoreLiquidationModule {
    /**
     * @param multisig_   The Multisig address: controls parameter setters.
     * @param executors_  Initial set of Executor accounts (keeper liquidation callers).
     * @param pausers_    Initial set of Pauser accounts (DEX pause switch).
     */
    constructor(
        address multisig_,
        address[] memory executors_,
        address[] memory pausers_
    ) CoreLiquidationModule(multisig_, executors_, pausers_) {}

    /**
     * @notice Keeper liquidation entry point: absorbs an underwater account.
     * @dev Caller must be an Executor. Reverts if absorb is paused on the Comet.
     * @param absorber The recipient of the liquidation incentive.
     * @param account  The underwater account to liquidate.
     */
    function liquidate(address absorber, address account, bytes[] calldata /*swapData*/) external virtual nonReentrant onlyRole(EXECUTOR_ROLE) {
        if (comet.isAbsorbPaused()) revert Paused();

        comet.accrueAccount(account);

        _liquidate(absorber, account);
    }
}
