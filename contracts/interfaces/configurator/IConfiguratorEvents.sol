// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { CometConfiguration } from "../../CometConfiguration.sol";
import { IAssetListStructs } from "../assetList/IAssetListStructs.sol";

/**
 * @title Compound's Configurator Events
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IConfiguratorEvents {
    /*//////////////////////////////////////////////////////////////
                          COMET CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    event SetFactory(address indexed cometProxy, address indexed oldFactory, address indexed newFactory);
    event SetConfiguration(address indexed cometProxy, CometConfiguration.Configuration oldConfiguration, CometConfiguration.Configuration newConfiguration);
    event SetGovernor(address indexed cometProxy, address indexed oldGovernor, address indexed newGovernor);
    event SetPauseGuardian(address indexed cometProxy, address indexed oldPauseGuardian, address indexed newPauseGuardian);
    event SetMarketAdminPermissionChecker(address indexed oldMarketAdminPermissionChecker, address indexed newMarketAdminPermissionChecker);
    event SetBaseTokenPriceFeed(address indexed cometProxy, address indexed oldBaseTokenPriceFeed, address indexed newBaseTokenPriceFeed);
    event SetExtensionDelegate(address indexed cometProxy, address indexed oldExt, address indexed newExt);
    event SetStoreFrontPriceFactor(address indexed cometProxy, uint64 oldStoreFrontPriceFactor, uint64 newStoreFrontPriceFactor);
    event SetBaseTrackingSupplySpeed(address indexed cometProxy, uint64 oldBaseTrackingSupplySpeed, uint64 newBaseTrackingSupplySpeed);
    event SetBaseTrackingBorrowSpeed(address indexed cometProxy, uint64 oldBaseTrackingBorrowSpeed, uint64 newBaseTrackingBorrowSpeed);
    event SetBaseMinForRewards(address indexed cometProxy, uint104 oldBaseMinForRewards, uint104 newBaseMinForRewards);
    event SetBaseBorrowMin(address indexed cometProxy, uint104 oldBaseBorrowMin, uint104 newBaseBorrowMin);
    event SetTargetReserves(address indexed cometProxy, uint104 oldTargetReserves, uint104 newTargetReserves);

    /*//////////////////////////////////////////////////////////////
                          INTEREST RATE MODEL
    //////////////////////////////////////////////////////////////*/

    event SetSupplyKink(address indexed cometProxy, uint64 oldKink, uint64 newKink);
    event SetSupplyPerYearInterestRateSlopeLow(address indexed cometProxy, uint64 oldIRSlopeLow, uint64 newIRSlopeLow);
    event SetSupplyPerYearInterestRateSlopeHigh(address indexed cometProxy, uint64 oldIRSlopeHigh, uint64 newIRSlopeHigh);
    event SetSupplyPerYearInterestRateBase(address indexed cometProxy, uint64 oldIRBase, uint64 newIRBase);
    event SetBorrowKink(address indexed cometProxy, uint64 oldKink, uint64 newKink);
    event SetBorrowPerYearInterestRateSlopeLow(address indexed cometProxy, uint64 oldIRSlopeLow, uint64 newIRSlopeLow);
    event SetBorrowPerYearInterestRateSlopeHigh(address indexed cometProxy, uint64 oldIRSlopeHigh, uint64 newIRSlopeHigh);
    event SetBorrowPerYearInterestRateBase(address indexed cometProxy, uint64 oldIRBase, uint64 newIRBase);

    /*//////////////////////////////////////////////////////////////
                       DEPLOYMENT AND GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    event CometDeployed(address indexed cometProxy, address indexed newComet);
    event GovernorTransferred(address indexed oldGovernor, address indexed newGovernor);

    /*//////////////////////////////////////////////////////////////
                         ASSET LIST MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    event SetAssetListFactory(address indexed cometProxy, address indexed oldAssetListFactory, address indexed newAssetListFactory);
    event AssetListDeployed(address indexed cometProxy, address indexed newAssetList);
    event UpdateAssetList(address indexed cometProxy, address indexed oldAssetList, address indexed newAssetList);

    /*//////////////////////////////////////////////////////////////
                       ASSETS CONFIGS MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    event SetAssetConfigs(address indexed cometProxy, IAssetListStructs.AssetImmutableConfig[] oldAssetConfigs, IAssetListStructs.AssetImmutableConfig[] newAssetConfigs);
    event UpdateAsset(address indexed cometProxy, IAssetListStructs.AssetImmutableConfig oldAssetConfig, IAssetListStructs.AssetImmutableConfig newAssetConfig);
    event UpdateAssetPriceFeed(address indexed cometProxy, address indexed asset, address oldPriceFeed, address newPriceFeed);
    event AddAsset(address indexed cometProxy, address indexed asset, IAssetListStructs.StorageConfig storageConfig);
    event UpdateAssetBorrowCollateralFactor(address indexed cometProxy, address indexed asset, uint64 oldBorrowCF, uint64 newBorrowCF);
    event UpdateAssetLiquidateCollateralFactor(address indexed cometProxy, address indexed asset, uint64 oldLiquidateCF, uint64 newLiquidateCF);
    event UpdateAssetLiquidationFactor(address indexed cometProxy, address indexed asset, uint64 oldLiquidationFactor, uint64 newLiquidationFactor);
    event UpdateAssetSupplyCap(address indexed cometProxy, address indexed asset, uint128 oldSupplyCap, uint128 newSupplyCap);
}
