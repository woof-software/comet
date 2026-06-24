// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICoreLiquidationModule } from "../interfaces/liquidation-module/ICoreLiquidationModule.sol";
import { ICometInterface, ICometData } from "../interfaces/ICometInterface.sol";
import { ICometLiquidationInterface } from "../interfaces/ICometLiquidationInterface.sol";

import { LiquidationAccessControl } from "./LiquidationAccessControl.sol";
import { IAssetList } from "../IAssetList.sol";
import { CometMath } from "../CometMath.sol";
import { IPriceFeed } from "../IPriceFeed.sol";
import { CometExtInterface } from "../CometExtInterface.sol";

/**
 * @title Core Liquidation Module
 * @author Woof
 * @notice Implements Comet's default account absorption and liquidation checks.
 * @dev The module is called only by its bound Comet instance and writes state back through
 *      Comet's liquidation hooks. It handles the following liquidation cases:
 *      - partial liquidation when collateral can restore the account to the target health factor;
 *      - full liquidation when the account must be totally liquidated;
 *      - bad debt write-off when collateral cannot cover the account debt;
 *      - minimum debt handling when the remaining borrow falls below the configured borrow minimum.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract CoreLiquidationModule is ICoreLiquidationModule, LiquidationAccessControl, CometMath {
    /// @notice The target health factor for partial liquidation
    uint256 public constant TARGET_HEALTH_FACTOR = 105e16;

    ICometInterface public immutable comet;

    IAssetList immutable public assetList;

    /// @notice Decimals of the base token
    uint64 public immutable baseScale;

    /// @notice The amount of assets in the comet; required for looping over assets
    uint8 public immutable numAssets;

    /// @notice Whether partial liquidation or full liquidation is enabled. Enabled by default.
    bool public partialLiquidationEnabled;

    modifier onlyComet() {
        if (msg.sender != address(comet)) revert OnlyComet();
        _;
    }

    /**
     * @param _comet     The Comet instance this module is bound to. The DAO is taken from its governor.
     * @param _multisig  The Multisig address: controls parameter setters.
     * @param _executors Initial set of Executor accounts (keeper liquidation callers).
     * @param _pausers   Initial set of Pauser accounts (DEX pause switch).
     */
    constructor(
        address _comet,
        address _multisig,
        address[] memory _executors,
        address[] memory _pausers
    ) LiquidationAccessControl(_multisig, _executors, _pausers) {
        if (_comet == address(0)) revert ZeroAddress();

        comet = ICometInterface(_comet);
        assetList = IAssetList(comet.assetList());
        numAssets = comet.numAssets();
        baseScale = uint64(comet.baseScale());

        partialLiquidationEnabled = true;

        // The DAO is Comet's governor.
        _setDAO(comet.governor());
    }

    /**
     * @notice Entry point for the protocol-driven liquidation path: it absorbs an underwater account.
     * @dev Restricted to Comet — it can only be executed by `Comet.absorb()`, which routes each account
     *      here. Any other caller reverts with `OnlyComet`. This is a thin wrapper that delegates to the
     *      shared `_liquidate` routine; the alternative entry point is `LiquidationModule.liquidate`
     *      (the keeper/DEX-driven path), which also funnels into `_liquidate`.
     * @param absorber The recipient of the incentive paid to the caller of `Comet.absorb()`.
     * @param account  The underwater account whose collateral and debt are being absorbed.
     */
    function liquidate(address absorber, address account) external onlyComet {
        _liquidate(absorber, account);
    }

    /**
    * @notice Seizes collateral assets one by one until the account reaches targetHealthFactor
    *         or all debt is fully repaid. Any unrecoverable shortfall is written off
    *         as bad debt absorbed by the protocol
    * @dev Iterates over account collateral assets in index order.
    * @param absorber The recipient of the incentive paid to the caller of absorb()
    * @param account  The underwater account whose collateral and debt are being absorbed
    */
    function _liquidate(address absorber, address account) internal {
        ICometData.UserBasic memory accountUser = comet.userBasic(account);
        if (accountUser.principal > 0) revert NotLiquidatable();

        // replicate isLiquidatable() and cache collateral prices for this function execution
        // liquidity represents value of all collateral's weighted by LCF
        (uint256 liquidity, uint256[] memory collateralPrices) = _getLiquidity(accountUser,account, true, new uint256[](0));
        // cache base asset price
        uint256 basePrice = getPrice(comet.baseTokenPriceFeed());
        
        uint256 debtRemainingValue = mulPrice(uint256(-comet.presentValue(accountUser.principal)), basePrice, baseScale);
        if (debtRemainingValue <= liquidity) revert NotLiquidatable();

        // Account's value of all collaterals weighted by BCF - using cached prices
        (uint256 totalCollateralizedValue, ) = _getLiquidity(accountUser, account, false, collateralPrices);
        uint256 minDebtValue = mulPrice(comet.baseBorrowMin(), basePrice, baseScale);
        
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
            
            // Skip non-liquidatable assets - we must not sieze collaterals with LF = 0:
            // 1. The collateral remains with the borrower: non-liquidatable assets should
            //    not be absorbed, and their value should not offset the account's debt.
            // 2. Avoids calling getPrice(): if the oracle is disabled or reverting,
            //    it would otherwise block liquidation even for assets that *should* be seized.
            if (collateralInfo.liquidationFactor == 0) continue;

            collateralAmount = comet.userCollateral(account, collateralInfo.asset).balance;
            collateralValue = mulPrice(collateralAmount, collateralPrices[i], collateralInfo.scale);

            // fully close the account's debt.
            // If collateral is sufficient to cover the remaining debt, seize only as much as needed; otherwise seize all and move to the next asset.
            // Otherise we derive value from the baseBorrowMin instead of comparing it directly with balance 
            // as this branch can be taken at any cycle step, not just the 1st step

            if (!partialLiquidationEnabled || debtRemainingValue <= minDebtValue) {
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
                wantedCollateralValue = (mulFactor(debtRemainingValue, TARGET_HEALTH_FACTOR) - totalCollateralizedValue) * FACTOR_SCALE
                                    / (mulFactor(collateralInfo.liquidationFactor, TARGET_HEALTH_FACTOR) - collateralInfo.borrowCollateralFactor);

                // we do not want more collateral than user's debt, though we must descale the value by penalty
                uint256 maxWantedCollateralValue = debtRemainingValue * FACTOR_SCALE / collateralInfo.liquidationFactor;
                if (wantedCollateralValue > maxWantedCollateralValue) wantedCollateralValue = maxWantedCollateralValue;

                // So, we want to seize a collateral of value calculated above.
                //   if user has more collateral than we want, we seize only calculated value
                //   if user has less collateral value than we want - we seize what we can and move to the next collateral
                if (wantedCollateralValue < collateralValue) {
                    seizedAmount = divPrice(wantedCollateralValue, collateralPrices[i], collateralInfo.scale);
                    seizedValue = mulFactor(wantedCollateralValue, collateralInfo.liquidationFactor);

                    // we can fall below minDebt at this step, so check it on current iteration
                    if (debtRemainingValue - seizedValue <= minDebtValue) {
                        (seizedAmount, seizedValue, wantedCollateralValue) = _processDebtClosing(debtRemainingValue, collateralInfo, collateralPrices[i], collateralAmount);
                    }
                } else {
                    seizedAmount = collateralAmount;
                    seizedValue = mulFactor(collateralValue, collateralInfo.liquidationFactor);
                    
                    wantedCollateralValue = collateralValue;
                }
            }
            emit AbsorbCollateral(absorber, account, collateralInfo.asset, seizedAmount, wantedCollateralValue);
            
            // Collaterals storage update
            ICometLiquidationInterface(address(comet)).updateCollateral(account, i, uint128(seizedAmount));

            // cycle values update
            totalCollateralizedValue -= mulFactor(wantedCollateralValue, collateralInfo.borrowCollateralFactor);
            debtRemainingValue -= seizedValue;
        }

        int104 oldPrincipal = accountUser.principal;
        int256 oldBalance = comet.presentValue(oldPrincipal);

        // After the liquidation user can either have debt closed (balance == 0) or "healthy" debt (negative balance)
        int256 newBalance = -signed256(divPrice(debtRemainingValue, basePrice, baseScale));

        // If balance is negative but not "healthy" - bad debt occured. (no asset brought HF to targetHF)
        // Zero out any residual shortfall as bad debt absorbed by the protocol.
        if (newBalance < 0 && totalCollateralizedValue == 0) {
            newBalance = 0;
        }

        ICometLiquidationInterface(address(comet)).updateDebtAndPrincipal(account, newBalance);

        uint256 basePaidOut = unsigned256(newBalance - oldBalance); // Base tokens effectively paid out to the account
        uint256 valueOfBasePaidOut = mulPrice(basePaidOut, basePrice, baseScale);

        emit AbsorbDebt(absorber, account, basePaidOut, valueOfBasePaidOut);
    }

    /**
     * @notice Toggle the liquidation mode. Multisig only (parameter setter).
     */
    function liquidationModeToggle(bool _partialLiquidationEnabled) external onlyMultisig {
        if (partialLiquidationEnabled == _partialLiquidationEnabled) revert LiquidationModeAlreadySet();

        partialLiquidationEnabled = _partialLiquidationEnabled;

        emit LiquidationModeToggled(_partialLiquidationEnabled);
    }

    /**
     * @notice Check whether an account has enough collateral to not be liquidated
     * @param account The address to check
     * @return Whether the account is minimally collateralized enough to not be liquidated
     *
     * @dev Intentionally does NOT check isCollateralDeactivated. Unlike isBorrowCollateralized,
     *      which reverts on deactivated collateral to block borrower actions, this function
     *      must always return a result so that liquidation remains possible. A stuck borrower
     *      who cannot withdraw deactivated collateral (see withdrawCollateral) relies on
     *      liquidation as their only exit path. If isLiquidatable reverted on deactivated
     *      collateral, the borrower would be permanently frozen with no way out.
     *
     *      When liquidateCollateralFactor is 0 for the deactivated asset, it contributes
     *      nothing to the liquidity calculation, making the account easier to liquidate.
     */
    function isLiquidatable(address account) public view returns (bool) {
        ICometData.UserBasic memory accountUser = comet.userBasic(account);

        if (accountUser.principal >= 0) return false;

        int256 debt = signedMulPrice(
            comet.presentValue(accountUser.principal),
            getPrice(comet.baseTokenPriceFeed()),
            baseScale
        );

        (uint256 liquidity, ) = _getLiquidity(accountUser, account, true, new uint256[](0));
        return debt + int256(liquidity) < 0;
    }

    /**
     * @notice Get the current price from a feed
     * @param priceFeed The address of a price feed
     * @return The price, scaled by `PRICE_SCALE`
     */
    function getPrice(address priceFeed) public view returns (uint256) {
        (, int256 price, , , ) = IPriceFeed(priceFeed).latestRoundData();
        if (price <= 0) revert BadPrice();
        return uint256(price);
    }

    /**
    * @notice The internal method which abstracts the account's collateral value calculation
    * @param account The address of the account
    * @param liquidation Whether to use liquidation factors or borrow factors in the calculation
    * @param fetchedCollateralPrices Optional array of collateral prices to use instead of fetching them from the price feeds
    * @return liquidity collateral-factor-weighted sum of collateral USD value for the account
    * @return collateralPrices array of cached collaterals prices
    */
    function _getLiquidity(ICometData.UserBasic memory account, address accountAddress, bool liquidation, uint256[] memory fetchedCollateralPrices) internal view returns (uint256 liquidity, uint256[] memory collateralPrices) {
        uint16 assetsIn = account.assetsIn;
        uint8 _reserved = account._reserved;
        uint256 newAmount;
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
                    // Block ALL borrow-side actions when the borrower still holds deactivated collateral.
                    // This revert is intentionally broad: it prevents borrowing, withdrawing other
                    // collateral, and transferring — even if the remaining active collateral would
                    // pass the collateralization check on its own. The purpose is to force the
                    // borrower to withdraw the deactivated collateral FIRST before doing anything
                    // else (see the deactivation lifecycle comment on isCollateralDeactivated).
                    //
                    // If the borrower cannot withdraw the deactivated collateral without becoming
                    // under-collateralized, they are stuck and must wait for liquidation.
                    if (CometExtInterface(address(comet)).isCollateralDeactivated(asset.offset)) revert TokenIsDeactivated(asset.asset);

                    // Mechanism to skip assets with no borrowing power. It avoids getPrice() call price feed,
                    // so in case if excluded asset's oracle reverts (e.g. stale, broken, decommissioned),
                    // it won't block the entire collateralization check, and won't paralyze borrows and transfers.
                    if (asset.borrowCollateralFactor == 0) { 
                        continue; 
                    }
                }

                if (fetchedCollateralPrices.length == 0) collateralPrices[i] = getPrice(asset.priceFeed);

                collateralBalance = comet.userCollateral(accountAddress, asset.asset).balance;

                newAmount = mulPrice(
                    collateralBalance,
                    collateralPrices[i],
                    asset.scale
                );
                liquidity += mulFactor(
                    newAmount,
                    liquidation ? asset.liquidateCollateralFactor : asset.borrowCollateralFactor
                );
            }
        }
    }

    /**
    * @notice Internal helper used in absorbInternal() per-collateral cycle
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
        uint256 collateralValueLeft = mulFactor(wantedCollateralValue, collateralInfo.liquidationFactor);

        if (debtRemainingValue < collateralValueLeft) {
            // collateral amount to seize = (debt value / LF) / price
            // we need to scale down debt value by LF, as seized collateral value is treated as penalized
            seizedAmount = divPrice(debtRemainingValue * FACTOR_SCALE / collateralInfo.liquidationFactor, collateralPrice, collateralInfo.scale);
            seizedValue = debtRemainingValue;
            wantedCollateralValue = mulPrice(seizedAmount, collateralPrice, collateralInfo.scale);
        } else {
            // Collateral is insufficient for full closure — seize all and continue to the next asset.
            seizedAmount = collateralAmount;
            seizedValue = collateralValueLeft;
        }
    }
}
