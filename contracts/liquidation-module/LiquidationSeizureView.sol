// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICometData } from "../interfaces/ICometData.sol";
import { ICometInterface } from "../interfaces/ICometInterface.sol";
import { IAssetList } from "../IAssetList.sol";
import { ICoreLiquidationModule } from "../interfaces/liquidation-module/ICoreLiquidationModule.sol";
import { ILiquidationModuleView } from "../interfaces/liquidation-module/ILiquidationModuleView.sol";

import { SeizureCalculations } from "./SeizureCalculations.sol";

/**
 * @title Liquidation Seizure View
 * @author Woof
 * @notice Read-only helper bound 1:1 to a liquidation module.
 * @custom:security-contact dmitriy@woof.software
 */
contract LiquidationSeizureView is SeizureCalculations {
    /// @notice Index scale used by Comet present-value math.
    uint64 internal constant BASE_INDEX_SCALE = 1e15;

    /// @notice The liquidation module this view is bound to.
    ILiquidationModuleView public immutable MODULE;

    error ZeroAddress();
    error TimestampInPast();

    /// @param module_ The liquidation module to bind view helper to.
    constructor(address module_) {
        if (module_ == address(0)) revert ZeroAddress();
        ILiquidationModuleView m = ILiquidationModuleView(module_);

        MODULE = m;
        comet = ICometInterface(m.comet());
        assetList = IAssetList(m.assetList());
        baseScale = m.baseScale();
        numAssets = m.numAssets();
    }

    /**
     * @notice Returns the seizure plan the liquidation module would produce for `account` at `timestamp`.
     * @dev Projects the account's base present value from Comet's last accrual to `timestamp` with the same
     *      single-step accrual Comet applies, then evaluates the shared seizure plan for that debt.
     * @param account The underwater account to plan a seizure for.
     * @param timestamp The block timestamp at which the liquidation is expected to be mined.
     * @return plan The ordered list of collateral seizures.
     */
    function seizurePlanAt(address account, uint256 timestamp) external view returns (ICoreLiquidationModule.Seizure[] memory plan) {
        ICometData.TotalsBasic memory totals = comet.totalsBasic();
        if (timestamp < totals.lastAccrualTime) revert TimestampInPast();

        uint64 baseSupplyIndex_ = totals.baseSupplyIndex;
        uint64 baseBorrowIndex_ = totals.baseBorrowIndex;

        // Mirror Comet.accruedInterestIndices: a single linear accrual step at the current utilization/rates.
        uint256 timeElapsed = timestamp - totals.lastAccrualTime;
        if (timeElapsed > 0) {
            uint256 utilization = comet.getUtilization();
            uint256 supplyRate = comet.getSupplyRate(utilization);
            uint256 borrowRate = comet.getBorrowRate(utilization);
            baseSupplyIndex_ += safe64(mulFactor(baseSupplyIndex_, supplyRate * timeElapsed));
            baseBorrowIndex_ += safe64(mulFactor(baseBorrowIndex_, borrowRate * timeElapsed));
        }

        // Mirror Comet.presentValue with the projected indices.
        ICometData.UserBasic memory accountUser = comet.userBasic(account);
        int256 presentValueBase = accountUser.principal >= 0
            ? signed256(uint256(uint104(accountUser.principal)) * baseSupplyIndex_ / BASE_INDEX_SCALE)
            : -signed256(uint256(uint104(-accountUser.principal)) * baseBorrowIndex_ / BASE_INDEX_SCALE);

        (plan, , , ) = _computeSeizurePlan(accountUser, account, presentValueBase, MODULE.partialLiquidationEnabled());
    }
}
