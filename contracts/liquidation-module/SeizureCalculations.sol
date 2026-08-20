// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICometInterface, ICometData } from "../interfaces/ICometInterface.sol";
import { IAssetList } from "../IAssetList.sol";
import { IPriceFeed } from "../IPriceFeed.sol";
import { ICoreLiquidationModule } from "../interfaces/liquidation-module/ICoreLiquidationModule.sol";
import { ICoreLiquidationModuleErrors } from "../interfaces/liquidation-module/ICoreLiquidationModuleErrors.sol";

import { CometMath } from "../CometMath.sol";

/**
 * @title SeizureCalculations
 * @author Woof
 * @notice Collateral seizure planning basic calculations.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract SeizureCalculations is CometMath, ICoreLiquidationModuleErrors {
    /// @notice The target health factor for partial liquidation
    uint256 public constant TARGET_HEALTH_FACTOR = 105e16;

    ICometInterface public comet;

    IAssetList public assetList;

    /// @notice Decimals of the base token
    uint64 public baseScale;

    /// @notice The amount of assets in the comet; required for looping over assets
    uint8 public numAssets;

    /**
     * @notice Computes the per-collateral seizure plan for an underwater account, valuing its debt from the
     *         supplied `presentValueBase`. Collateral balances and prices are read at the current block.
     * @param accountUser The account's cached UserBasic (principal, assetsIn).
     * @param account The underwater account to plan a seizure for.
     * @param presentValueBase The account's base present value (negative for a borrow).
     * @return values: the ordered seizure plan, the account's new balance, debt payout, its value
     */
    function _computeSeizurePlan(ICometData.UserBasic memory accountUser, address account, int256 presentValueBase, bool partialEnabled)
        internal
        view
        returns (ICoreLiquidationModule.Seizure[] memory, int256, uint256, uint256)
    {
        if (accountUser.principal > 0) revert NotLiquidatable();

        // replicate isLiquidatable() and cache collateral prices for this function execution
        // liquidity represents value of all collateral's weighted by LCF
        (uint256 liquidity, uint256[] memory collateralPrices) = _getLiquidity(accountUser, account, true, new uint256[](0));
        // cache base asset price
        uint256 basePrice = getPrice(comet.baseTokenPriceFeed());

        uint256 debtRemainingValue = mulPrice(uint256(-presentValueBase), basePrice, baseScale);
        if (debtRemainingValue <= liquidity) revert NotLiquidatable();

        // Account's value of all collaterals weighted by BCF - using cached prices
        (uint256 totalCollateralizedValue, ) = _getLiquidity(accountUser, account, false, collateralPrices);
        uint256 minDebtValue = mulPrice(comet.baseBorrowMin(), basePrice, baseScale);

        ICoreLiquidationModule.Seizure[] memory seizures = new ICoreLiquidationModule.Seizure[](numAssets);
        uint256 seizuresCount;

        ICometData.AssetInfo memory collateralInfo;
        uint256 collateralAmount;
        uint256 collateralValue;
        uint256 wantedCollateralValue;
        uint256 seizedAmount;
        uint256 seizedValue;

        for (uint8 i; i < numAssets; ++i) {
            if (debtRemainingValue == 0) break;
            if (!isInAsset(accountUser.assetsIn, i, accountUser._reserved)) continue;

            collateralInfo = assetList.getAssetInfo(i);

            // Skip non-liquidatable assets - we must not seize collaterals with LF = 0:
            // 1. The collateral remains with the borrower: non-liquidatable assets should
            //    not be absorbed, and their value should not offset the account's debt.
            // 2. Avoids calling getPrice(): if the oracle is disabled or reverting,
            //    it would otherwise block liquidation even for assets that *should* be seized.
            if (collateralInfo.liquidationFactor == 0) continue;

            collateralAmount = comet.userCollateral(account, collateralInfo.asset).balance;
            collateralValue = mulPrice(collateralAmount, collateralPrices[i], collateralInfo.scale);

            // fully close the account's debt.
            // If collateral is sufficient to cover the remaining debt, seize only as much as needed; otherwise seize all and move to the next asset.
            // Otherwise we derive value from the baseBorrowMin instead of comparing it directly with balance
            // as this branch can be taken at any cycle step, not just the 1st step

            if (!partialEnabled || debtRemainingValue <= minDebtValue) {
                (seizedAmount, seizedValue, wantedCollateralValue) = _processDebtClosing(debtRemainingValue, collateralInfo, collateralPrices[i], collateralAmount);
            }
            else if (mulFactor(debtRemainingValue, TARGET_HEALTH_FACTOR) <= totalCollateralizedValue) {
                // target HF is reached
                break;
            }
            // Calculate the collateral value S to seize in order to restore the account to targetHF
            //   HF   = health factor = totalCollateralValue / debt
            //   LF   = liquidationFactor (penalty to seized collateral)
            //   LCF  = liquidateCollateralFactor
            //   BCF  = borrowCollateralFactor
            //
            // After seizing of one collateral of value S, debt is reduced by: S * LF
            // Collateralized value of user's position is reduced by: S * BCF
            // So, expected HF (which we want to be targetHF) after seizing collateral of value S:
            //   targetHF = (totalCollateralValue - S * BCF) / (debt - S * LF)
            //
            // After solving the formula for S:
            //   S = (targetHF * debt - totalCollateralValue) / (targetHF * LF - BCF)
            //
            // The denominator is always positive since with targetHF >= 1:
            //   LF * targetHF >= LF > LCF > BCF (enforced in Configurator)
            else {
                // Both carry an extra FACTOR_SCALE, which keeps the solve below to a single division.
                uint256 collateralizationGap = debtRemainingValue * TARGET_HEALTH_FACTOR - totalCollateralizedValue * FACTOR_SCALE;
                uint256 gapClosedPerSeizedValue = uint256(collateralInfo.liquidationFactor) * TARGET_HEALTH_FACTOR
                                    - uint256(collateralInfo.borrowCollateralFactor) * FACTOR_SCALE;

                // Up: S is a lower bound, and no later step makes up a shortfall.
                wantedCollateralValue = ceilDiv(collateralizationGap * FACTOR_SCALE, gapClosedPerSeizedValue);

                // we do not want more collateral than user's debt, though we must descale the value by penalty
                uint256 maxWantedCollateralValue = debtRemainingValue * FACTOR_SCALE / collateralInfo.liquidationFactor;
                if (wantedCollateralValue > maxWantedCollateralValue) wantedCollateralValue = maxWantedCollateralValue;

                // So, we want to seize a collateral of value calculated above.
                //   if user has more collateral than we want, we seize only calculated value
                //   if user has less collateral value than we want - we seize what we can and move to the next collateral
                if (wantedCollateralValue < collateralValue) {
                    // Up: a collateral unit is coarse — a satoshi is worth ~1e4 value units — so
                    // truncating here seizes visibly less than asked. The branch condition bounds it.
                    seizedAmount = ceilDiv(wantedCollateralValue * collateralInfo.scale, collateralPrices[i]);

                    wantedCollateralValue = mulPrice(seizedAmount, collateralPrices[i], collateralInfo.scale);

                    // From seizedAmount, not from the line above: that one is truncated, and crediting
                    // through it repays less than was seized.
                    seizedValue = ceilDiv(
                        seizedAmount * collateralPrices[i] * collateralInfo.liquidationFactor,
                        uint256(collateralInfo.scale) * FACTOR_SCALE
                    );
                    // Nothing bounds this one: a whole collateral unit can be worth more than is left
                    // owing, and the subtraction below would underflow.
                    if (seizedValue > debtRemainingValue) seizedValue = debtRemainingValue;

                    // we can fall below minDebt at this step, so check it on current iteration
                    if (debtRemainingValue - seizedValue <= minDebtValue) {
                        (seizedAmount, seizedValue, wantedCollateralValue) = _processDebtClosing(debtRemainingValue, collateralInfo, collateralPrices[i], collateralAmount);
                    }
                } else {
                    seizedAmount = collateralAmount;
                    seizedValue = collateralAmount * collateralPrices[i] * collateralInfo.liquidationFactor
                                        / (uint256(collateralInfo.scale) * FACTOR_SCALE);

                    wantedCollateralValue = collateralValue;
                }
            }
            seizures[seizuresCount] = ICoreLiquidationModule.Seizure({ asset: collateralInfo.asset, index: i, seizedAmount: seizedAmount, seizedValue: seizedValue, wantedCollateralValue: wantedCollateralValue });
            unchecked { ++seizuresCount; }

            totalCollateralizedValue -= seizedAmount * collateralPrices[i] * collateralInfo.borrowCollateralFactor
                                / (uint256(collateralInfo.scale) * FACTOR_SCALE);
            debtRemainingValue -= seizedValue;
        }

        int256 oldBalance = presentValueBase;
        // After the liquidation user can either have debt closed (balance == 0) or "healthy" debt (negative balance)
        int256 newBalance = -signed256(divPrice(debtRemainingValue, basePrice, baseScale));

        // If balance is negative but not "healthy" - bad debt occurred. (no asset brought HF to targetHF)
        // Zero out any residual shortfall as bad debt absorbed by the protocol.
        if (newBalance < 0 && totalCollateralizedValue == 0) {
            newBalance = 0;
        }
        uint256 basePaidOut = unsigned256(newBalance - oldBalance); // Base tokens effectively paid out to the account

        ICoreLiquidationModule.Seizure[] memory plan = new ICoreLiquidationModule.Seizure[](seizuresCount);
        for (uint256 j; j < seizuresCount; ++j) plan[j] = seizures[j];

        return (plan, newBalance, basePaidOut, mulPrice(basePaidOut, basePrice, baseScale));
    }

    /**
     * @notice Get the current price from a feed
     * @param priceFeed The address of a price feed
     * @return price, scaled by `PRICE_SCALE`
     */
    function getPrice(address priceFeed) public view returns (uint256) {
        (, int256 price, , , ) = IPriceFeed(priceFeed).latestRoundData();
        if (price <= 0) revert BadPrice();
        return uint256(price);
    }

    /**
    * @notice The internal method which abstracts the account's collateral value calculation
    * @param account The account's cached UserBasic
    * @param accountAddress The address of the account
    * @param liquidation Whether to use liquidation factors or borrow factors in the calculation
    * @param fetchedCollateralPrices Optional array of collateral prices to use instead of fetching them from the price feeds
    * @return liquidity collateral-factor-weighted sum of collateral USD value for the account
    * @return collateralPrices array of cached collaterals prices
    */
    function _getLiquidity(ICometData.UserBasic memory account, address accountAddress, bool liquidation, uint256[] memory fetchedCollateralPrices) internal view returns (uint256 liquidity, uint256[] memory collateralPrices) {
        uint16 assetsIn = account.assetsIn;
        uint8 _reserved = account._reserved;
        uint128 collateralBalance;
        ICometData.AssetInfo memory asset;

        fetchedCollateralPrices.length == 0 ? collateralPrices = new uint256[](numAssets) : collateralPrices = fetchedCollateralPrices;
        for (uint8 i; i < numAssets; ++i) {
            if (isInAsset(assetsIn, i, _reserved)) {
                asset = assetList.getAssetInfo(i);

                if (liquidation) {
                    // Skip assets that do not count toward the liquidation threshold. It avoids getPrice() call for price feed
                    // so in case if excluded asset's oracle reverts (e.g. stale, broken, decommissioned),
                    // it won't block the entire liquidation check, and won't paralyze liquidations of accounts which hold it.
                    if (asset.liquidateCollateralFactor == 0) continue;
                } else {
                    // Note: Intentionally skip isCollateralDeactivated() check: this method is for liquidation only, so we
                    // only need the collaterized value. The user should still be able to liquidate the deactivated asset

                    // Mechanism to skip assets with no borrowing power. It avoids getPrice() call price feed,
                    // so in case if excluded asset's oracle reverts (e.g. stale, broken, decommissioned),
                    // it won't block the entire collateralization check, and won't paralyze borrows and transfers.
                    if (asset.borrowCollateralFactor == 0) {
                        continue;
                    }
                }

                if (fetchedCollateralPrices.length == 0) collateralPrices[i] = getPrice(asset.priceFeed);

                collateralBalance = comet.userCollateral(accountAddress, asset.asset).balance;

                // One division: pricing and weighting separately truncates the balance twice, costing
                // a unit of value per collateral held.
                liquidity += collateralBalance
                    * collateralPrices[i]
                    * (liquidation ? asset.liquidateCollateralFactor : asset.borrowCollateralFactor)
                    / (uint256(asset.scale) * FACTOR_SCALE);
            }
        }
    }

    /**
    * @notice Internal helper used in _computeSeizurePlan() per-collateral cycle
    * @param debtRemainingValue The account's debt value left to cover
    * @param collateralInfo The collateral's asset configuration
    * @param collateralPrice The collateral's cached price
    * @param collateralAmount The account's balance of the collateral
    * @return seizedAmount Collateral amount to cover the debt
    * @return seizedValue Collateral value scaled by LF, which covers the debt
    * @return wantedCollateralValue seizedAmount * collateral price
    */
    function _processDebtClosing(
        uint256 debtRemainingValue,
        ICometData.AssetInfo memory collateralInfo,
        uint256 collateralPrice,
        uint256 collateralAmount
    ) internal pure returns (uint256 seizedAmount, uint256 seizedValue, uint256 wantedCollateralValue) {
        wantedCollateralValue = mulPrice(collateralAmount, collateralPrice, collateralInfo.scale);

        // One division: this picks the branch below, and understating it sends a position the
        // collateral does cover into the write-off branch.
        uint256 collateralValueLeft = collateralAmount * collateralPrice * collateralInfo.liquidationFactor
                            / (uint256(collateralInfo.scale) * FACTOR_SCALE);

        if (debtRemainingValue < collateralValueLeft) {
            // Up: the whole debt is credited below, so anything truncated here is debt forgiven
            // against collateral that was never taken. The branch condition bounds it.
            seizedAmount = ceilDiv(
                debtRemainingValue * FACTOR_SCALE * uint256(collateralInfo.scale),
                uint256(collateralInfo.liquidationFactor) * collateralPrice
            );

            seizedValue = debtRemainingValue;
            wantedCollateralValue = mulPrice(seizedAmount, collateralPrice, collateralInfo.scale);
        } else {
            // Collateral is insufficient for full closure — seize all and continue to the next asset.
            seizedAmount = collateralAmount;
            seizedValue = collateralValueLeft;
        }
    }
}
