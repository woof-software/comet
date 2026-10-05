// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Compound's Asset List Events
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IAssetListEvents {
    /**
     * @notice Emitted when the configurator changes the borrow collateral factor of an asset
     * @param asset The asset
     * @param oldBorrowCF The borrow collateral factor before the change
     * @param newBorrowCF The borrow collateral factor after the change
     */
    event UpdateAssetBorrowCollateralFactor(address indexed asset, uint64 oldBorrowCF, uint64 newBorrowCF);

    /**
     * @notice Emitted when the configurator changes the liquidate collateral factor of an asset
     * @param asset The asset
     * @param oldLiquidateCF The liquidate collateral factor before the change
     * @param newLiquidateCF The liquidate collateral factor after the change
     */
    event UpdateAssetLiquidateCollateralFactor(address indexed asset, uint64 oldLiquidateCF, uint64 newLiquidateCF);

    /**
     * @notice Emitted when the configurator changes the liquidation factor of an asset
     * @param asset The asset
     * @param oldLiquidationFactor The liquidation factor before the change
     * @param newLiquidationFactor The liquidation factor after the change
     */
    event UpdateAssetLiquidationFactor(address indexed asset, uint64 oldLiquidationFactor, uint64 newLiquidationFactor);

    /**
     * @notice Emitted when the configurator changes the supply cap of an asset
     * @param asset The asset
     * @param oldSupplyCap The supply cap before the change
     * @param newSupplyCap The supply cap after the change
     */
    event UpdateAssetSupplyCap(address indexed asset, uint128 oldSupplyCap, uint128 newSupplyCap);
}
