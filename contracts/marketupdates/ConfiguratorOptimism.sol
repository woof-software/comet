// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { ConfiguratorStorageOptimism, CometConfiguration, MarketAdminPermissionCheckerInterface } from "./ConfiguratorStorageOptimism.sol";
import { CometFactoryWithExtendedAssetList } from "../CometFactoryWithExtendedAssetList.sol";
import { IAssetListFactory } from "../IAssetListFactory.sol";
import { IAssetList, IAssetListStructs } from "../interfaces/assetList/IAssetList.sol";
import { IConfiguratorEvents } from "../interfaces/configurator/IConfiguratorEvents.sol";
import { IConfiguratorErrors } from "../interfaces/configurator/IConfiguratorErrors.sol";
import { ConfigHash } from "../libraries/ConfigHash.sol";

contract ConfiguratorOptimism is ConfiguratorStorageOptimism, IConfiguratorEvents, IConfiguratorErrors {
    event SetMarketAdminPermissionChecker(address indexed oldMarketAdminPermissionChecker, address indexed newMarketAdminPermissionChecker);

    modifier onlyGovernor {
        if (msg.sender != governor) revert Unauthorized();
        _;
    }

    /**
     * @dev Ensures that the caller is either the governor or the market admin.
     * This delegates the permission check logic to the MarketAdminPermissionChecker contract.
     */
    modifier governorOrMarketAdmin {
        if(msg.sender != governor) marketAdminPermissionChecker.checkUpdatePermission(msg.sender);
        _;
    }

    /**
     * @notice Constructs a new Configurator instance
     **/
    constructor() {
        // Set a high version to prevent the implementation contract from being initialized
        version = type(uint256).max;
    }

    /**
     * @notice Initializes the storage for Configurator
     * @param governor_ The address of the governor
     **/
    function initialize(address governor_) public {
        if (version != 0) revert AlreadyInitialized();
        if (governor_ == address(0)) revert InvalidAddress();

        governor = governor_;
        version = 1;
    }

    /**
     * @notice Sets the factory for a Comet proxy
     * @dev Note: Only callable by governor
     **/
    function setFactory(address cometProxy, address newFactory) external onlyGovernor {
        address oldFactory = factory[cometProxy];
        factory[cometProxy] = newFactory;
        emit SetFactory(cometProxy, oldFactory, newFactory);
    }

    /**
     * @notice Sets the entire Configuration for a Comet proxy
     * @dev Note: All params can later be updated by the governor except for `baseToken` and `trackingIndexScale`
     **/
    function setConfiguration(address cometProxy, Configuration calldata newConfiguration) external onlyGovernor {
        Configuration memory oldConfiguration = configuratorParams[cometProxy];
        if (oldConfiguration.baseToken != address(0) &&
            (oldConfiguration.baseToken != newConfiguration.baseToken ||
             oldConfiguration.trackingIndexScale != newConfiguration.trackingIndexScale))
            revert ConfigurationAlreadyExists();

        configuratorParams[cometProxy] = newConfiguration;
        emit SetConfiguration(cometProxy, oldConfiguration, newConfiguration);
    }

    /** Governance setters for Comet-related configuration **/

    function setGovernor(address cometProxy, address newGovernor) external onlyGovernor {
        address oldGovernor = configuratorParams[cometProxy].governor;
        configuratorParams[cometProxy].governor = newGovernor;
        emit SetGovernor(cometProxy, oldGovernor, newGovernor);
    }

    function setPauseGuardian(address cometProxy, address newPauseGuardian) external onlyGovernor {
        address oldPauseGuardian = configuratorParams[cometProxy].pauseGuardian;
        configuratorParams[cometProxy].pauseGuardian = newPauseGuardian;
        emit SetPauseGuardian(cometProxy, oldPauseGuardian, newPauseGuardian);
    }

    /**
    * @notice Sets the MarketAdminPermissionChecker contract
    * @dev Note: Only callable by governor
    **/
    function setMarketAdminPermissionChecker(MarketAdminPermissionCheckerInterface newMarketAdminPermissionChecker) external onlyGovernor {
        address oldMarketAdminPermissionChecker = address(marketAdminPermissionChecker);
        marketAdminPermissionChecker = newMarketAdminPermissionChecker;
        emit SetMarketAdminPermissionChecker(oldMarketAdminPermissionChecker, address(newMarketAdminPermissionChecker));
    }

    function setBaseTokenPriceFeed(address cometProxy, address newBaseTokenPriceFeed) external onlyGovernor {
        address oldBaseTokenPriceFeed = configuratorParams[cometProxy].baseTokenPriceFeed;
        configuratorParams[cometProxy].baseTokenPriceFeed = newBaseTokenPriceFeed;
        emit SetBaseTokenPriceFeed(cometProxy, oldBaseTokenPriceFeed, newBaseTokenPriceFeed);
    }

    function setExtensionDelegate(address cometProxy, address newExtensionDelegate) external onlyGovernor {
        address oldExtensionDelegate = configuratorParams[cometProxy].extensionDelegate;
        configuratorParams[cometProxy].extensionDelegate = newExtensionDelegate;
        emit SetExtensionDelegate(cometProxy, oldExtensionDelegate, newExtensionDelegate);
    }

    function setSupplyKink(address cometProxy, uint64 newSupplyKink) external governorOrMarketAdmin {
        uint64 oldSupplyKink = configuratorParams[cometProxy].supplyKink;
        configuratorParams[cometProxy].supplyKink = newSupplyKink;
        emit SetSupplyKink(cometProxy, oldSupplyKink, newSupplyKink);
    }

    function setSupplyPerYearInterestRateSlopeLow(address cometProxy, uint64 newSlope) external governorOrMarketAdmin {
        uint64 oldSlope = configuratorParams[cometProxy].supplyPerYearInterestRateSlopeLow;
        configuratorParams[cometProxy].supplyPerYearInterestRateSlopeLow = newSlope;
        emit SetSupplyPerYearInterestRateSlopeLow(cometProxy, oldSlope, newSlope);
    }

    function setSupplyPerYearInterestRateSlopeHigh(address cometProxy, uint64 newSlope) external governorOrMarketAdmin {
        uint64 oldSlope = configuratorParams[cometProxy].supplyPerYearInterestRateSlopeHigh;
        configuratorParams[cometProxy].supplyPerYearInterestRateSlopeHigh = newSlope;
        emit SetSupplyPerYearInterestRateSlopeHigh(cometProxy, oldSlope, newSlope);
    }

    function setSupplyPerYearInterestRateBase(address cometProxy, uint64 newBase) external governorOrMarketAdmin {
        uint64 oldBase = configuratorParams[cometProxy].supplyPerYearInterestRateBase;
        configuratorParams[cometProxy].supplyPerYearInterestRateBase = newBase;
        emit SetSupplyPerYearInterestRateBase(cometProxy, oldBase, newBase);
    }

    function setBorrowKink(address cometProxy, uint64 newBorrowKink) external governorOrMarketAdmin {
        uint64 oldBorrowKink = configuratorParams[cometProxy].borrowKink;
        configuratorParams[cometProxy].borrowKink = newBorrowKink;
        emit SetBorrowKink(cometProxy, oldBorrowKink, newBorrowKink);
    }

    function setBorrowPerYearInterestRateSlopeLow(address cometProxy, uint64 newSlope) external governorOrMarketAdmin {
        uint64 oldSlope = configuratorParams[cometProxy].borrowPerYearInterestRateSlopeLow;
        configuratorParams[cometProxy].borrowPerYearInterestRateSlopeLow = newSlope;
        emit SetBorrowPerYearInterestRateSlopeLow(cometProxy, oldSlope, newSlope);
    }

    function setBorrowPerYearInterestRateSlopeHigh(address cometProxy, uint64 newSlope) external governorOrMarketAdmin {
        uint64 oldSlope = configuratorParams[cometProxy].borrowPerYearInterestRateSlopeHigh;
        configuratorParams[cometProxy].borrowPerYearInterestRateSlopeHigh = newSlope;
        emit SetBorrowPerYearInterestRateSlopeHigh(cometProxy, oldSlope, newSlope);
    }

    function setBorrowPerYearInterestRateBase(address cometProxy, uint64 newBase) external governorOrMarketAdmin {
        uint64 oldBase = configuratorParams[cometProxy].borrowPerYearInterestRateBase;
        configuratorParams[cometProxy].borrowPerYearInterestRateBase = newBase;
        emit SetBorrowPerYearInterestRateBase(cometProxy, oldBase, newBase);
    }

    function setStoreFrontPriceFactor(address cometProxy, uint64 newStoreFrontPriceFactor) external onlyGovernor {
        uint64 oldStoreFrontPriceFactor = configuratorParams[cometProxy].storeFrontPriceFactor;
        configuratorParams[cometProxy].storeFrontPriceFactor = newStoreFrontPriceFactor;
        emit SetStoreFrontPriceFactor(cometProxy, oldStoreFrontPriceFactor, newStoreFrontPriceFactor);
    }

    function setBaseTrackingSupplySpeed(address cometProxy, uint64 newBaseTrackingSupplySpeed) external governorOrMarketAdmin {
        uint64 oldBaseTrackingSupplySpeed = configuratorParams[cometProxy].baseTrackingSupplySpeed;
        configuratorParams[cometProxy].baseTrackingSupplySpeed = newBaseTrackingSupplySpeed;
        emit SetBaseTrackingSupplySpeed(cometProxy, oldBaseTrackingSupplySpeed, newBaseTrackingSupplySpeed);
    }

    function setBaseTrackingBorrowSpeed(address cometProxy, uint64 newBaseTrackingBorrowSpeed) external governorOrMarketAdmin {
        uint64 oldBaseTrackingBorrowSpeed = configuratorParams[cometProxy].baseTrackingBorrowSpeed;
        configuratorParams[cometProxy].baseTrackingBorrowSpeed = newBaseTrackingBorrowSpeed;
        emit SetBaseTrackingBorrowSpeed(cometProxy, oldBaseTrackingBorrowSpeed, newBaseTrackingBorrowSpeed);
    }

    function setBaseMinForRewards(address cometProxy, uint104 newBaseMinForRewards) external onlyGovernor {
        uint104 oldBaseMinForRewards = configuratorParams[cometProxy].baseMinForRewards;
        configuratorParams[cometProxy].baseMinForRewards = newBaseMinForRewards;
        emit SetBaseMinForRewards(cometProxy, oldBaseMinForRewards, newBaseMinForRewards);
    }

    function setBaseBorrowMin(address cometProxy, uint104 newBaseBorrowMin) external governorOrMarketAdmin {
        uint104 oldBaseBorrowMin = configuratorParams[cometProxy].baseBorrowMin;
        configuratorParams[cometProxy].baseBorrowMin = newBaseBorrowMin;
        emit SetBaseBorrowMin(cometProxy, oldBaseBorrowMin, newBaseBorrowMin);
    }

    function setTargetReserves(address cometProxy, uint104 newTargetReserves) external onlyGovernor {
        uint104 oldTargetReserves = configuratorParams[cometProxy].targetReserves;
        configuratorParams[cometProxy].targetReserves = newTargetReserves;
        emit SetTargetReserves(cometProxy, oldTargetReserves, newTargetReserves);
    }

    /*//////////////////////////////////////////////////////////////
                         ASSET LIST MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Sets the asset list factory for a Comet proxy, used by deployAssetList
     * @param cometProxy The Comet proxy whose asset list factory to set
     * @param newAssetListFactory The asset list factory to use
     */
    function setAssetListFactory(address cometProxy, address newAssetListFactory) external onlyGovernor {
        if (newAssetListFactory == address(0)) revert InvalidAddress();

        emit SetAssetListFactory(cometProxy, cometAssetListFactories[cometProxy], newAssetListFactory);
        cometAssetListFactories[cometProxy] = newAssetListFactory;
    }

    /**
     * @notice Deploys a new AssetList implementation with the immutable asset configs of a Comet proxy
     * @param cometProxy The Comet proxy whose asset configs to use
     * @return assetListProxy The asset list proxy of the Comet proxy
     * @return newAssetListImpl The new AssetList implementation, or the zero address if the immutable configs are unchanged
     */
    function deployAssetList(address cometProxy) external returns (address assetListProxy, address newAssetListImpl) {
        assetListProxy = configuratorParams[cometProxy].assetList;
        IAssetListStructs.ImmutableAssetConfig[] memory immutableConfigs = getImmutableAssetConfig(cometProxy);

        // 1. New list, configs unchanged: hash matches, return zero address
        // 2. New list, configs changed: hash differs, deploy
        // 3. Old list without configHash: nothing to compare, deploy
        // 4. No list yet (zero address): nothing to compare, deploy
        if (ConfigHash.compareConfigHashes(assetListProxy, abi.encode(immutableConfigs))) return (assetListProxy, address(0));

        address assetListFactory = cometAssetListFactories[cometProxy];
        if (assetListFactory == address(0)) revert InvalidAddress();
        newAssetListImpl = IAssetListFactory(assetListFactory).createAssetList(immutableConfigs);
        emit AssetListDeployed(cometProxy, assetListProxy, newAssetListImpl);
    }

    /**
     * @notice Points the Comet proxy's configuration to an already deployed asset list
     * @dev Deploys nothing; the next Comet deploy uses this asset list
     * @param cometProxy The Comet proxy whose configuration to update
     * @param newAssetList The asset list to use
     */
    function updateAssetList(address cometProxy, address newAssetList) external onlyGovernor {
        if (newAssetList == address(0)) revert InvalidAddress();

        emit UpdateAssetList(cometProxy, configuratorParams[cometProxy].assetList, newAssetList);
        configuratorParams[cometProxy].assetList = newAssetList;
    }

    /*//////////////////////////////////////////////////////////////
                        ASSETS CONFIGS MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Adds a new asset config at the end of the asset configs of a Comet proxy
     * @param cometProxy The Comet proxy to add the asset config to
     * @param assetConfig The config of the new asset
     */
    function addAsset(address cometProxy, AssetConfig calldata assetConfig) external onlyGovernor {
        assetConfigs[cometProxy].push(assetConfig);
        emit AddAsset(cometProxy, assetConfig);
    }

    /**
     * @notice Adds an asset to the asset list of a Comet proxy, with the factors and supply cap of its stored config
     * @param cometProxy The Comet proxy whose asset list to add the asset to
     * @param asset The asset to add
     */
    function addAssetToAssetList(address cometProxy, address asset) external onlyGovernor {
        address assetList = configuratorParams[cometProxy].assetList;
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        IAssetList(assetList).addAsset(asset, _storagePart(assetConfig));
        emit AddAssetToAssetList(cometProxy, assetList, asset);
    }

    /**
     * @notice Replaces the config of one asset of a Comet proxy, found by its address
     * @dev The immutable part takes effect on the asset list only after deployAssetList and the asset list proxy upgrade
     * @param cometProxy The Comet proxy whose asset config to update
     * @param newAssetConfig The new config of the asset
     */
    function updateAsset(address cometProxy, AssetConfig calldata newAssetConfig) external onlyGovernor {
        uint256 assetIndex = getAssetIndex(cometProxy, newAssetConfig.asset);
        AssetConfig memory oldAssetConfig = assetConfigs[cometProxy][assetIndex];
        assetConfigs[cometProxy][assetIndex] = newAssetConfig;
        emit UpdateAsset(cometProxy, oldAssetConfig, newAssetConfig);
    }

    /**
     * @notice Sets the price feed of one asset of a Comet proxy
     * @dev Takes effect on the asset list only after deployAssetList and the asset list proxy upgrade
     * @param cometProxy The Comet proxy whose asset config to update
     * @param asset The asset whose price feed to set
     * @param newPriceFeed The new price feed
     */
    function updateAssetPriceFeed(address cometProxy, address asset, address newPriceFeed) external onlyGovernor {
        uint256 assetIndex = getAssetIndex(cometProxy, asset);
        address oldPriceFeed = assetConfigs[cometProxy][assetIndex].priceFeed;
        assetConfigs[cometProxy][assetIndex].priceFeed = newPriceFeed;
        emit UpdateAssetPriceFeed(cometProxy, asset, oldPriceFeed, newPriceFeed);
    }

    /**
     * @notice Sets the borrow collateral factor of an asset in its stored config
     * @param cometProxy The Comet proxy whose asset config to update
     * @param asset The asset whose borrow collateral factor to set
     * @param newBorrowCF The new borrow collateral factor
     */
    function updateAssetBorrowCollateralFactor(address cometProxy, address asset, uint64 newBorrowCF) external governorOrMarketAdmin {
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        uint64 oldBorrowCF = assetConfig.borrowCollateralFactor;
        assetConfig.borrowCollateralFactor = newBorrowCF;
        emit UpdateAssetBorrowCollateralFactor(cometProxy, asset, oldBorrowCF, newBorrowCF);
    }

    /**
     * @notice Sets the borrow collateral factor of an asset on the Comet proxy's asset list to the one in its stored config
     * @param cometProxy The Comet proxy whose asset list to update
     * @param asset The asset whose borrow collateral factor to set
     */
    function setBorrowCollateralFactorInAssetList(address cometProxy, address asset) external governorOrMarketAdmin {
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        IAssetList(configuratorParams[cometProxy].assetList).setBorrowCollateralFactor(asset, assetConfig.borrowCollateralFactor);
    }

    /**
     * @notice Sets the liquidate collateral factor of an asset in its stored config
     * @param cometProxy The Comet proxy whose asset config to update
     * @param asset The asset whose liquidate collateral factor to set
     * @param newLiquidateCF The new liquidate collateral factor
     */
    function updateAssetLiquidateCollateralFactor(address cometProxy, address asset, uint64 newLiquidateCF) external governorOrMarketAdmin {
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        uint64 oldLiquidateCF = assetConfig.liquidateCollateralFactor;
        assetConfig.liquidateCollateralFactor = newLiquidateCF;
        emit UpdateAssetLiquidateCollateralFactor(cometProxy, asset, oldLiquidateCF, newLiquidateCF);
    }

    /**
     * @notice Sets the liquidate collateral factor of an asset on the Comet proxy's asset list to the one in its stored config
     * @param cometProxy The Comet proxy whose asset list to update
     * @param asset The asset whose liquidate collateral factor to set
     */
    function setLiquidateCollateralFactorInAssetList(address cometProxy, address asset) external governorOrMarketAdmin {
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        IAssetList(configuratorParams[cometProxy].assetList).setLiquidateCollateralFactor(asset, assetConfig.liquidateCollateralFactor);
    }

    /**
     * @notice Sets the liquidation factor of an asset in its stored config
     * @param cometProxy The Comet proxy whose asset config to update
     * @param asset The asset whose liquidation factor to set
     * @param newLiquidationFactor The new liquidation factor
     */
    function updateAssetLiquidationFactor(address cometProxy, address asset, uint64 newLiquidationFactor) external governorOrMarketAdmin {
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        uint64 oldLiquidationFactor = assetConfig.liquidationFactor;
        assetConfig.liquidationFactor = newLiquidationFactor;
        emit UpdateAssetLiquidationFactor(cometProxy, asset, oldLiquidationFactor, newLiquidationFactor);
    }

    /**
     * @notice Sets the liquidation factor of an asset on the Comet proxy's asset list to the one in its stored config
     * @param cometProxy The Comet proxy whose asset list to update
     * @param asset The asset whose liquidation factor to set
     */
    function setLiquidationFactorInAssetList(address cometProxy, address asset) external governorOrMarketAdmin {
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        IAssetList(configuratorParams[cometProxy].assetList).setLiquidationFactor(asset, assetConfig.liquidationFactor);
    }

    /**
     * @notice Sets the supply cap of an asset in its stored config
     * @param cometProxy The Comet proxy whose asset config to update
     * @param asset The asset whose supply cap to set
     * @param newSupplyCap The new supply cap
     */
    function updateAssetSupplyCap(address cometProxy, address asset, uint128 newSupplyCap) external governorOrMarketAdmin {
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        uint128 oldSupplyCap = assetConfig.supplyCap;
        assetConfig.supplyCap = newSupplyCap;
        emit UpdateAssetSupplyCap(cometProxy, asset, oldSupplyCap, newSupplyCap);
    }

    /**
     * @notice Sets the supply cap of an asset on the Comet proxy's asset list to the one in its stored config
     * @param cometProxy The Comet proxy whose asset list to update
     * @param asset The asset whose supply cap to set
     */
    function setSupplyCapInAssetList(address cometProxy, address asset) external governorOrMarketAdmin {
        AssetConfig storage assetConfig = assetConfigs[cometProxy][getAssetIndex(cometProxy, asset)];
        IAssetList(configuratorParams[cometProxy].assetList).setSupplyCap(asset, assetConfig.supplyCap);
    }

    /*//////////////////////////////////////////////////////////////
                             OTHER HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Returns all asset configs of a Comet proxy
     * @dev The public assetConfigs getter returns one config by index; this returns the whole list
     * @param cometProxy The Comet proxy whose asset configs to return
     * @return The asset configs, in asset list order
     */
    function getAssetConfigs(address cometProxy) external view returns (AssetConfig[] memory) {
        return assetConfigs[cometProxy];
    }

    /**
     * @notice Returns the immutable part of every asset config of a Comet proxy, as the asset list is built from it
     * @param cometProxy The Comet proxy whose asset configs to return
     * @return immutableConfigs The asset, decimals and price feed of each asset, in asset list order
     */
    function getImmutableAssetConfig(address cometProxy) public view returns (IAssetListStructs.ImmutableAssetConfig[] memory immutableConfigs) {
        AssetConfig[] storage cometAssetConfigs = assetConfigs[cometProxy];
        uint256 numAssets = cometAssetConfigs.length;
        immutableConfigs = new IAssetListStructs.ImmutableAssetConfig[](numAssets);
        for (uint256 i; i < numAssets; ++i) {
            AssetConfig storage assetConfig = cometAssetConfigs[i];
            immutableConfigs[i] = IAssetListStructs.ImmutableAssetConfig({
                asset: assetConfig.asset,
                decimals: assetConfig.decimals,
                priceFeed: assetConfig.priceFeed
            });
        }
    }

    /**
     * @notice Returns the storage part of every asset config of a Comet proxy, as the asset list keeps it in storage
     * @param cometProxy The Comet proxy whose asset configs to return
     * @return storageConfigs The factors and supply cap of each asset, in asset list order
     */
    function getStorageAssetConfig(address cometProxy) public view returns (IAssetListStructs.StorageAssetConfig[] memory storageConfigs) {
        AssetConfig[] storage cometAssetConfigs = assetConfigs[cometProxy];
        uint256 numAssets = cometAssetConfigs.length;
        storageConfigs = new IAssetListStructs.StorageAssetConfig[](numAssets);
        for (uint256 i; i < numAssets; ++i) {
            storageConfigs[i] = _storagePart(cometAssetConfigs[i]);
        }
    }

    /**
     * @notice Returns the index of an asset in the asset configs of a Comet proxy
     * @dev Reverts with AssetDoesNotExist if the asset is not in the configs
     * @param cometProxy The Comet proxy whose asset configs to search
     * @param asset The asset to find
     * @return The index of the asset, which is also its index in the asset list
     */
    function getAssetIndex(address cometProxy, address asset) public view returns (uint256) {
        AssetConfig[] storage cometAssetConfigs = assetConfigs[cometProxy];
        uint256 numAssets = cometAssetConfigs.length;
        for (uint256 i; i < numAssets; ++i) {
            if (cometAssetConfigs[i].asset == asset) return i;
        }
        revert AssetDoesNotExist();
    }

    /**
     * @return The currently configured params for a Comet proxy
     **/
    function getConfiguration(address cometProxy) external view returns (Configuration memory) {
        return configuratorParams[cometProxy];
    }

    /**
     * @notice Deploy a new Comet implementation using the factory and Configuration for that Comet proxy
     * @dev Note: Callable by anyone
     */
    function deploy(address cometProxy) external returns (address) {
        address newComet = CometFactoryWithExtendedAssetList(factory[cometProxy]).clone(configuratorParams[cometProxy]);
        emit CometDeployed(cometProxy, newComet);
        return newComet;
    }

    /**
     * @notice Transfers the governor rights to a new address
     */
    function transferGovernor(address newGovernor) external onlyGovernor {
        address oldGovernor = governor;
        governor = newGovernor;
        emit GovernorTransferred(oldGovernor, newGovernor);
    }

    /// @dev The storage part of an asset config: the factors and supply cap the asset list keeps in storage
    function _storagePart(AssetConfig storage assetConfig) private view returns (IAssetListStructs.StorageAssetConfig memory) {
        return IAssetListStructs.StorageAssetConfig({
            borrowCollateralFactor: assetConfig.borrowCollateralFactor,
            liquidateCollateralFactor: assetConfig.liquidateCollateralFactor,
            liquidationFactor: assetConfig.liquidationFactor,
            supplyCap: assetConfig.supplyCap
        });
    }
}
