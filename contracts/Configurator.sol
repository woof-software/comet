// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { CometFactoryWithExtendedAssetList } from "./CometFactoryWithExtendedAssetList.sol";
import { CometConfiguration } from "./CometConfiguration.sol";
import "./ConfiguratorStorage.sol";
import "./marketupdates/MarketAdminPermissionCheckerInterface.sol";
import "./IAssetListFactory.sol";
import { IConfigHash } from "./interfaces/IConfigHash.sol";
import { Hash } from "./libraries/Hash.sol";
import { IAssetList } from "./interfaces/assetList/IAssetList.sol";

contract Configurator is ConfiguratorStorage {

    /** Custom events **/
    event AddAsset(address indexed cometProxy, address indexed asset, IAssetListStructs.StorageConfig storageConfig);
    event CometDeployed(address indexed cometProxy, address indexed newComet);
    event AssetListDeployed(address indexed cometProxy, address indexed newAssetList);
    event UpdateAssetList(address indexed cometProxy, address indexed oldAssetList, address indexed newAssetList);
    event GovernorTransferred(address indexed oldGovernor, address indexed newGovernor);
    event SetFactory(address indexed cometProxy, address indexed oldFactory, address indexed newFactory);
    event SetAssetListFactory(address indexed cometProxy, address indexed oldAssetListFactory, address indexed newAssetListFactory);
    event SetGovernor(address indexed cometProxy, address indexed oldGovernor, address indexed newGovernor);
    event SetConfiguration(address indexed cometProxy, Configuration oldConfiguration, Configuration newConfiguration);
    event SetPauseGuardian(address indexed cometProxy, address indexed oldPauseGuardian, address indexed newPauseGuardian);
    event SetMarketAdminPermissionChecker(address indexed oldMarketAdminPermissionChecker, address indexed newMarketAdminPermissionChecker);
    event SetBaseTokenPriceFeed(address indexed cometProxy, address indexed oldBaseTokenPriceFeed, address indexed newBaseTokenPriceFeed);
    event SetExtensionDelegate(address indexed cometProxy, address indexed oldExt, address indexed newExt);
    event SetSupplyKink(address indexed cometProxy,uint64 oldKink, uint64 newKink);
    event SetSupplyPerYearInterestRateSlopeLow(address indexed cometProxy,uint64 oldIRSlopeLow, uint64 newIRSlopeLow);
    event SetSupplyPerYearInterestRateSlopeHigh(address indexed cometProxy,uint64 oldIRSlopeHigh, uint64 newIRSlopeHigh);
    event SetSupplyPerYearInterestRateBase(address indexed cometProxy,uint64 oldIRBase, uint64 newIRBase);
    event SetBorrowKink(address indexed cometProxy,uint64 oldKink, uint64 newKink);
    event SetBorrowPerYearInterestRateSlopeLow(address indexed cometProxy,uint64 oldIRSlopeLow, uint64 newIRSlopeLow);
    event SetBorrowPerYearInterestRateSlopeHigh(address indexed cometProxy,uint64 oldIRSlopeHigh, uint64 newIRSlopeHigh);
    event SetBorrowPerYearInterestRateBase(address indexed cometProxy,uint64 oldIRBase, uint64 newIRBase);
    event SetStoreFrontPriceFactor(address indexed cometProxy, uint64 oldStoreFrontPriceFactor, uint64 newStoreFrontPriceFactor);
    event SetBaseTrackingSupplySpeed(address indexed cometProxy, uint64 oldBaseTrackingSupplySpeed, uint64 newBaseTrackingSupplySpeed);
    event SetBaseTrackingBorrowSpeed(address indexed cometProxy, uint64 oldBaseTrackingBorrowSpeed, uint64 newBaseTrackingBorrowSpeed);
    event SetBaseMinForRewards(address indexed cometProxy, uint104 oldBaseMinForRewards, uint104 newBaseMinForRewards);
    event SetBaseBorrowMin(address indexed cometProxy, uint104 oldBaseBorrowMin, uint104 newBaseBorrowMin);
    event SetTargetReserves(address indexed cometProxy, uint104 oldTargetReserves, uint104 newTargetReserves);
    event SetAssetConfigs(address indexed cometProxy, IAssetListStructs.AssetImmutableConfig[] oldAssetConfigs, IAssetListStructs.AssetImmutableConfig[] newAssetConfigs);
    event UpdateAsset(address indexed cometProxy, IAssetListStructs.AssetImmutableConfig oldAssetConfig, IAssetListStructs.AssetImmutableConfig newAssetConfig);
    event UpdateAssetPriceFeed(address indexed cometProxy, address indexed asset, address oldPriceFeed, address newPriceFeed);
    event UpdateAssetBorrowCollateralFactor(address indexed cometProxy, address indexed asset, uint64 oldBorrowCF, uint64 newBorrowCF);
    event UpdateAssetLiquidateCollateralFactor(address indexed cometProxy, address indexed asset, uint64 oldLiquidateCF, uint64 newLiquidateCF);
    event UpdateAssetLiquidationFactor(address indexed cometProxy, address indexed asset, uint64 oldLiquidationFactor, uint64 newLiquidationFactor);
    event UpdateAssetSupplyCap(address indexed cometProxy, address indexed asset, uint128 oldSupplyCap, uint128 newSupplyCap);

    /** Custom errors **/
    error AlreadyInitialized();
    error AssetDoesNotExist();
    error ConfigurationAlreadyExists();
    error InvalidAddress();
    error Unauthorized();

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
     * @notice Deploy a new AssetList implementation from the asset configs stored for a Comet proxy,
     *         unless the current asset list was already built from the same immutable configs
     * @dev Note: Callable by anyone, like deploy: it only creates an implementation and changes no state here.
     *      Only the immutable part of each asset config (asset, decimals, price feed) goes into the list,
     *      so changing factors or supply caps alone never needs a new implementation.
     *      The factory is the one set for the Comet proxy in cometAssetListFactories
     * @param cometProxy The Comet proxy whose asset configs to use
     * @return newAssetList The address of the new AssetList implementation, or the zero address if no upgrade is needed
     */
    function deployAssetList(address cometProxy) external returns (address newAssetList) {
        IAssetListStructs.AssetImmutableConfig[] memory immutableConfigs = assetConfigs[cometProxy];

        // 1. New list, configs unchanged: hash matches, return zero address
        // 2. New list, configs changed: hash differs, deploy
        // 3. Old list without configHash: nothing to compare, deploy
        // 4. No list yet (zero address): nothing to compare, deploy
        // A list has both configHash and TYPEHASH or neither, so TYPEHASH is called directly once configHash is found
        address currentAssetList = configuratorParams[cometProxy].assetList;
        (bool hasHash, bytes32 currentHash) = _trySupportsConfigHash(currentAssetList, IConfigHash.configHash.selector);
        if (
            hasHash &&
            Hash.verify(currentHash, IConfigHash(currentAssetList).TYPEHASH(), abi.encode(immutableConfigs))
        ) return address(0);

        address assetListFactory = cometAssetListFactories[cometProxy];
        if (assetListFactory == address(0)) revert InvalidAddress();
        newAssetList = IAssetListFactory(assetListFactory).createAssetList(immutableConfigs);
        emit AssetListDeployed(cometProxy, newAssetList);
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
     * @notice Replaces all asset configs of a Comet proxy
     * @dev Note: Only callable by governor. The order of the configs is the order of the assets in the asset list
     * @param cometProxy The Comet proxy whose asset configs to set
     * @param newAssetConfigs The new asset configs
     */
    function setAssetConfigs(address cometProxy, IAssetListStructs.AssetImmutableConfig[] calldata newAssetConfigs) external onlyGovernor {
        IAssetListStructs.AssetImmutableConfig[] memory oldAssetConfigs = assetConfigs[cometProxy];
        assetConfigs[cometProxy] = newAssetConfigs;
        emit SetAssetConfigs(cometProxy, oldAssetConfigs, newAssetConfigs);
    }

    /**
     * @notice Replaces the immutable config of one asset of a Comet proxy, found by its address
     * @dev Takes effect on the asset list only after deployAssetList and the asset list proxy upgrade
     * @param cometProxy The Comet proxy whose asset config to update
     * @param newAssetConfig The new immutable config of the asset
     */
    function updateAsset(address cometProxy, IAssetListStructs.AssetImmutableConfig calldata newAssetConfig) external onlyGovernor {
        uint256 assetIndex = getAssetIndex(cometProxy, newAssetConfig.asset);
        IAssetListStructs.AssetImmutableConfig memory oldAssetConfig = assetConfigs[cometProxy][assetIndex];
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
     * @notice Returns all asset configs of a Comet proxy
     * @dev The public assetConfigs getter returns one config by index; this returns the whole list
     * @param cometProxy The Comet proxy whose asset configs to return
     * @return The asset configs, in asset list order
     */
    function getAssetConfigs(address cometProxy) external view returns (IAssetListStructs.AssetImmutableConfig[] memory) {
        return assetConfigs[cometProxy];
    }

    /**
     * @notice Returns the index of an asset in the asset configs of a Comet proxy
     * @dev Reverts with AssetDoesNotExist if the asset is not in the configs
     * @param cometProxy The Comet proxy whose asset configs to search
     * @param asset The asset to find
     * @return The index of the asset, which is also its index in the asset list
     */
    function getAssetIndex(address cometProxy, address asset) public view returns (uint256) {
        IAssetListStructs.AssetImmutableConfig[] storage cometAssetConfigs = assetConfigs[cometProxy];
        uint256 numAssets = cometAssetConfigs.length;
        for (uint256 i; i < numAssets; ++i) {
            if (cometAssetConfigs[i].asset == asset) return i;
        }
        revert AssetDoesNotExist();
    }

    /**
     * @notice Registers an asset on the Comet proxy's asset list and sets its factors and supply cap.
     *         This is the last step of adding a new asset:
     *         1. Update the immutable asset configs
     *         2. Deploy a new asset list implementation
     *         3. Upgrade the asset list proxy to it through CometProxyAdmin
     *         4. Call this function to store the asset's factors and supply cap on the asset list
     * @param cometProxy The Comet proxy whose asset list to add the asset to
     * @param asset The asset to add
     * @param storageConfig The factors and supply cap of the asset
     */
    function addAsset(
        address cometProxy,
        address asset,
        IAssetListStructs.StorageConfig calldata storageConfig
    ) external onlyGovernor {
        IAssetList(configuratorParams[cometProxy].assetList).addAsset(asset, storageConfig);
        emit AddAsset(cometProxy, asset, storageConfig);
    }

    /**
     * @notice Sets the borrow collateral factor of an asset on the Comet proxy's asset list
     */
    function updateAssetBorrowCollateralFactor(address cometProxy, address asset, uint64 newBorrowCF) external governorOrMarketAdmin {
        IAssetList assetList = IAssetList(configuratorParams[cometProxy].assetList);
        uint64 oldBorrowCF = assetList.getAssetInfoByAddress(asset).borrowCollateralFactor;
        assetList.setBorrowCollateralFactor(asset, newBorrowCF);
        emit UpdateAssetBorrowCollateralFactor(cometProxy, asset, oldBorrowCF, newBorrowCF);
    }

    /**
     * @notice Sets the liquidate collateral factor of an asset on the Comet proxy's asset list
     */
    function updateAssetLiquidateCollateralFactor(address cometProxy, address asset, uint64 newLiquidateCF) external governorOrMarketAdmin {
        IAssetList assetList = IAssetList(configuratorParams[cometProxy].assetList);
        uint64 oldLiquidateCF = assetList.getAssetInfoByAddress(asset).liquidateCollateralFactor;
        assetList.setLiquidateCollateralFactor(asset, newLiquidateCF);
        emit UpdateAssetLiquidateCollateralFactor(cometProxy, asset, oldLiquidateCF, newLiquidateCF);
    }

    /**
     * @notice Sets the liquidation factor of an asset on the Comet proxy's asset list
     */
    function updateAssetLiquidationFactor(address cometProxy, address asset, uint64 newLiquidationFactor) external governorOrMarketAdmin {
        IAssetList assetList = IAssetList(configuratorParams[cometProxy].assetList);
        uint64 oldLiquidationFactor = assetList.getAssetInfoByAddress(asset).liquidationFactor;
        assetList.setLiquidationFactor(asset, newLiquidationFactor);
        emit UpdateAssetLiquidationFactor(cometProxy, asset, oldLiquidationFactor, newLiquidationFactor);
    }

    /**
     * @notice Sets the supply cap of an asset on the Comet proxy's asset list
     */
    function updateAssetSupplyCap(address cometProxy, address asset, uint128 newSupplyCap) external governorOrMarketAdmin {
        IAssetList assetList = IAssetList(configuratorParams[cometProxy].assetList);
        uint128 oldSupplyCap = assetList.getAssetInfoByAddress(asset).supplyCap;
        assetList.setSupplyCap(asset, newSupplyCap);
        emit UpdateAssetSupplyCap(cometProxy, asset, oldSupplyCap, newSupplyCap);
    }

    /** Other helpers **/

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

    /// @dev Calls a bytes32 getter via staticcall without reverting; returns found = false if the call reverts,
    ///      the target has no code, or the return data is not exactly one word.
    ///      Inspired by OpenZeppelin's ERC165Checker, which probes supportsInterface the same way
    function _trySupportsConfigHash(address target, bytes4 interfaceId) private view returns (bool found, bytes32 value) {
        (bool success, bytes memory data) = target.staticcall(abi.encodeWithSelector(interfaceId));
        if (!success || data.length != 32) return (false, bytes32(0));
        return (true, abi.decode(data, (bytes32)));
    }
}
