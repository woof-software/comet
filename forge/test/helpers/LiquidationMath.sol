// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { ICometData } from "@comet-contracts/interfaces/ICometData.sol";

library LiquidationMath {
    uint256 internal constant FACTOR_SCALE = 1e18;

    /**
     * @notice Everything the account holds that counts towards a borrow, each balance priced and
     *         weighted by its borrow collateral factor in a single division. Carries the factors' 1e18.
     */
    function weightedCollateral(CometInterface comet, address account) internal view returns (uint256 weighted) {
        for (uint8 i; i < comet.numAssets(); ++i) {
            ICometData.AssetInfo memory info = comet.getAssetInfo(i);
            uint256 balance = comet.collateralBalanceOf(account, info.asset);
            if (balance == 0) continue;

            weighted += balance * comet.getPrice(info.priceFeed) * info.borrowCollateralFactor / info.scale;
        }
    }

    /**
     * @notice The account's health on the 1e18 scale: collateral weighted by the borrow collateral
     *         factors over the value of the debt. Zero when nothing is owed.
     * @dev The collateral still carries the factors' 1e18, which is the scale health is reported on,
     *      so it cancels against the debt instead of being divided out.
     */
    function healthFactor(CometInterface comet, address account) internal view returns (uint256) {
        uint256 debt = comet.borrowBalanceOf(account);
        if (debt == 0) return 0;

        return weightedCollateral(comet, account) * comet.baseScale()
            / (debt * comet.getPrice(comet.baseTokenPriceFeed()));
    }
}
