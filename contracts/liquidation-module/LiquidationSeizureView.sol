// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICometData } from "../interfaces/ICometData.sol";
import { ICometInterface } from "../interfaces/ICometInterface.sol";
import { IAssetList } from "../IAssetList.sol";
import { IPriceFeed } from "../IPriceFeed.sol";
import { ICoreLiquidationModule } from "../interfaces/liquidation-module/ICoreLiquidationModule.sol";
import { ICoreLiquidationModuleErrors } from "../interfaces/liquidation-module/ICoreLiquidationModuleErrors.sol";
import { ILiquidationModuleView } from "../interfaces/liquidation-module/ILiquidationModuleView.sol";
import { CometMath } from "../CometMath.sol";

/**
 * @title Liquidation Seizure View
 * @author Woof
 * @notice Read-only helper bound 1:1 to a liquidation module.
 * @custom:security-contact dmitriy@woof.software
 */
contract LiquidationSeizureView is CometMath, ICoreLiquidationModuleErrors {
    uint64 internal constant BASE_INDEX_SCALE = 1e15;
    ILiquidationModuleView public immutable MODULE;
    ICometInterface public immutable COMET;
    IAssetList public immutable ASSET_LIST;
    uint256 public immutable TARGET_HEALTH_FACTOR;
    uint64 public immutable BASE_SCALE;
    uint8 public immutable NUM_ASSETS;

    error ZeroAddress();
    error TimestampInPast();

    /// @param module_ The liquidation module to bind view helper to.
    constructor(address module_) {
        if (module_ == address(0)) revert ZeroAddress();
        ILiquidationModuleView m = ILiquidationModuleView(module_);
        MODULE = m;
        COMET = ICometInterface(m.comet());
        ASSET_LIST = IAssetList(m.assetList());
        TARGET_HEALTH_FACTOR = m.TARGET_HEALTH_FACTOR();
        BASE_SCALE = m.baseScale();
        NUM_ASSETS = m.numAssets();
    }

    /**
     * @notice Returns the seizure plan the liquidation module would produce for `account` at `timestamp`.
     * @dev Projects the account's base present value from Comet's last accrual to `timestamp` with the same
     *      single-step accrual Comet applies, then evaluates the seizure plan for that debt.
     * @param account The underwater account to plan a seizure for.
     * @param timestamp The block timestamp at which the liquidation is expected to be mined.
     * @return plan The ordered list of collateral seizures.
     */
    function seizurePlanAt(address account, uint256 timestamp) external view returns (ICoreLiquidationModule.Seizure[] memory plan) {
        ICometData.TotalsBasic memory totals = COMET.totalsBasic();
        if (timestamp < totals.lastAccrualTime) revert TimestampInPast();

        uint64 baseSupplyIndex_ = totals.baseSupplyIndex;
        uint64 baseBorrowIndex_ = totals.baseBorrowIndex;

        // Mirror Comet.accruedInterestIndices: a single linear accrual step at the current utilization/rates.
        uint256 timeElapsed = timestamp - totals.lastAccrualTime;
        if (timeElapsed > 0) {
            uint256 utilization = COMET.getUtilization();
            uint256 supplyRate = COMET.getSupplyRate(utilization);
            uint256 borrowRate = COMET.getBorrowRate(utilization);
            baseSupplyIndex_ += safe64(mulFactor(baseSupplyIndex_, supplyRate * timeElapsed));
            baseBorrowIndex_ += safe64(mulFactor(baseBorrowIndex_, borrowRate * timeElapsed));
        }

        // Mirror Comet.presentValue with the projected indices.
        ICometData.UserBasic memory accountUser = COMET.userBasic(account);
        int256 presentValueBase = accountUser.principal >= 0
            ? signed256(uint256(uint104(accountUser.principal)) * baseSupplyIndex_ / BASE_INDEX_SCALE)
            : -signed256(uint256(uint104(-accountUser.principal)) * baseBorrowIndex_ / BASE_INDEX_SCALE);

        plan = _computeSeizurePlan(accountUser, account, presentValueBase);
    }

    /**
     * @notice Duplicates CoreLiquidationModule._computeSeizurePlan, evaluating the debt from `presentValueBase`
     *         and returning only the seizure plan.
     */
    function _computeSeizurePlan(ICometData.UserBasic memory accountUser, address account, int256 presentValueBase)
        internal
        view
        returns (ICoreLiquidationModule.Seizure[] memory)
    {
        if (accountUser.principal > 0) revert NotLiquidatable();

        (uint256 liquidity, uint256[] memory collateralPrices) = _getLiquidity(accountUser, account, true, new uint256[](0));
        uint256 basePrice = getPrice(COMET.baseTokenPriceFeed());

        uint256 debtRemainingValue = mulPrice(uint256(-presentValueBase), basePrice, BASE_SCALE);
        if (debtRemainingValue <= liquidity) revert NotLiquidatable();

        (uint256 totalCollateralizedValue, ) = _getLiquidity(accountUser, account, false, collateralPrices);
        uint256 minDebtValue = mulPrice(COMET.baseBorrowMin(), basePrice, BASE_SCALE);
        bool partialLiquidationEnabled = MODULE.partialLiquidationEnabled();

        ICoreLiquidationModule.Seizure[] memory seizures = new ICoreLiquidationModule.Seizure[](NUM_ASSETS);
        uint256 seizuresCount;

        ICometData.AssetInfo memory collateralInfo;
        uint256 collateralAmount;
        uint256 collateralValue;
        uint256 wantedCollateralValue;
        uint256 seizedAmount;
        uint256 seizedValue;

        for (uint8 i; i < NUM_ASSETS; ++i) {
            if (debtRemainingValue == 0) break;
            if (!isInAsset(accountUser.assetsIn, i, accountUser._reserved)) continue;

            collateralInfo = ASSET_LIST.getAssetInfo(i);

            // Assets with LF == 0 are never seized.
            if (collateralInfo.liquidationFactor == 0) continue;

            collateralAmount = COMET.userCollateral(account, collateralInfo.asset).balance;
            collateralValue = mulPrice(collateralAmount, collateralPrices[i], collateralInfo.scale);

            if (!partialLiquidationEnabled || debtRemainingValue <= minDebtValue) {
                (seizedAmount, seizedValue, wantedCollateralValue) = _processDebtClosing(debtRemainingValue, collateralInfo, collateralPrices[i], collateralAmount);
            } else if (mulFactor(debtRemainingValue, TARGET_HEALTH_FACTOR) <= totalCollateralizedValue) {
                // target HF is reached
                break;
            } else {
                wantedCollateralValue = (mulFactor(debtRemainingValue, TARGET_HEALTH_FACTOR) - totalCollateralizedValue) * FACTOR_SCALE
                                    / (mulFactor(collateralInfo.liquidationFactor, TARGET_HEALTH_FACTOR) - collateralInfo.borrowCollateralFactor);

                uint256 maxWantedCollateralValue = debtRemainingValue * FACTOR_SCALE / collateralInfo.liquidationFactor;
                if (wantedCollateralValue > maxWantedCollateralValue) wantedCollateralValue = maxWantedCollateralValue;

                if (wantedCollateralValue < collateralValue) {
                    seizedAmount = divPrice(wantedCollateralValue, collateralPrices[i], collateralInfo.scale);
                    seizedValue = mulFactor(wantedCollateralValue, collateralInfo.liquidationFactor);

                    if (debtRemainingValue - seizedValue <= minDebtValue) {
                        (seizedAmount, seizedValue, wantedCollateralValue) = _processDebtClosing(debtRemainingValue, collateralInfo, collateralPrices[i], collateralAmount);
                    }
                } else {
                    seizedAmount = collateralAmount;
                    seizedValue = mulFactor(collateralValue, collateralInfo.liquidationFactor);
                    wantedCollateralValue = collateralValue;
                }
            }
            seizures[seizuresCount] = ICoreLiquidationModule.Seizure({ asset: collateralInfo.asset, index: i, seizedAmount: seizedAmount, seizedValue: seizedValue, wantedCollateralValue: wantedCollateralValue });
            unchecked { ++seizuresCount; }

            totalCollateralizedValue -= mulFactor(wantedCollateralValue, collateralInfo.borrowCollateralFactor);
            debtRemainingValue -= seizedValue;
        }

        ICoreLiquidationModule.Seizure[] memory plan = new ICoreLiquidationModule.Seizure[](seizuresCount);
        for (uint256 j; j < seizuresCount; ++j) plan[j] = seizures[j];
        return plan;
    }

    /// @notice Duplicates CoreLiquidationModule._getLiquidity.
    function _getLiquidity(ICometData.UserBasic memory account, address accountAddress, bool liquidation, uint256[] memory fetchedCollateralPrices) internal view returns (uint256 liquidity, uint256[] memory collateralPrices) {
        uint16 assetsIn = account.assetsIn;
        uint8 _reserved = account._reserved;
        uint256 newAmount;
        uint128 collateralBalance;
        ICometData.AssetInfo memory asset;

        fetchedCollateralPrices.length == 0 ? collateralPrices = new uint256[](NUM_ASSETS) : collateralPrices = fetchedCollateralPrices;
        for (uint8 i; i < NUM_ASSETS; ++i) {
            if (isInAsset(assetsIn, i, _reserved)) {
                asset = ASSET_LIST.getAssetInfo(i);

                if (liquidation) {
                    if (asset.liquidateCollateralFactor == 0) continue;
                } else {
                    if (asset.borrowCollateralFactor == 0) {
                        continue;
                    }
                }

                if (fetchedCollateralPrices.length == 0) collateralPrices[i] = getPrice(asset.priceFeed);

                collateralBalance = COMET.userCollateral(accountAddress, asset.asset).balance;

                newAmount = mulPrice(collateralBalance, collateralPrices[i], asset.scale);
                liquidity += mulFactor(newAmount, liquidation ? asset.liquidateCollateralFactor : asset.borrowCollateralFactor);
            }
        }
    }

    /// @notice Duplicates CoreLiquidationModule._processDebtClosing.
    function _processDebtClosing(
        uint256 debtRemainingValue,
        ICometData.AssetInfo memory collateralInfo,
        uint256 collateralPrice,
        uint256 collateralAmount
    ) internal pure returns (uint256 seizedAmount, uint256 seizedValue, uint256 wantedCollateralValue) {
        wantedCollateralValue = mulPrice(collateralAmount, collateralPrice, collateralInfo.scale);
        uint256 collateralValueLeft = mulFactor(wantedCollateralValue, collateralInfo.liquidationFactor);

        if (debtRemainingValue < collateralValueLeft) {
            seizedAmount = divPrice(debtRemainingValue * FACTOR_SCALE / collateralInfo.liquidationFactor, collateralPrice, collateralInfo.scale);
            seizedValue = debtRemainingValue;
            wantedCollateralValue = mulPrice(seizedAmount, collateralPrice, collateralInfo.scale);
        } else {
            seizedAmount = collateralAmount;
            seizedValue = collateralValueLeft;
        }
    }

    /// @notice Duplicates CoreLiquidationModule.getPrice.
    function getPrice(address priceFeed) public view returns (uint256) {
        (, int256 price, , , ) = IPriceFeed(priceFeed).latestRoundData();
        if (price <= 0) revert BadPrice();
        return uint256(price);
    }
}
