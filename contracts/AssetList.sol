// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { IPriceFeed } from "./IPriceFeed.sol";
import { IERC20NonStandard } from "./IERC20NonStandard.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { IAssetList } from "./interfaces/assetList/IAssetList.sol";
import { IConfigHash } from "./interfaces/IConfigHash.sol";
import { IConfigHash } from "./interfaces/IConfigHash.sol";
import { ConfigHash } from "./libraries/ConfigHash.sol";

/**
 * @title Compound's Asset List
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
contract AssetList is IAssetList, IConfigHash, Initializable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                         CONSTANTS / IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IConfigHash
    bytes32 public constant TYPEHASH =
        keccak256("ImmutableConfig[](address asset,uint8 decimals,address priceFeed)");

    /// @dev The decimals required for a price feed
    uint8 internal constant PRICE_FEED_DECIMALS = 8;

    /// @dev The max asset decimals whose scale (10 to the power of the decimals) fits in uint64
    uint8 internal constant MAX_ASSET_DECIMALS = 19;

    /// @dev The max value for a collateral factor (1)
    uint64 internal constant MAX_COLLATERAL_FACTOR = 1e18;

    uint256 internal immutable asset00_a;
    address internal immutable priceFeedAddress00;
    uint256 internal immutable asset01_a;
    address internal immutable priceFeedAddress01;
    uint256 internal immutable asset02_a;
    address internal immutable priceFeedAddress02;
    uint256 internal immutable asset03_a;
    address internal immutable priceFeedAddress03;
    uint256 internal immutable asset04_a;
    address internal immutable priceFeedAddress04;
    uint256 internal immutable asset05_a;
    address internal immutable priceFeedAddress05;
    uint256 internal immutable asset06_a;
    address internal immutable priceFeedAddress06;
    uint256 internal immutable asset07_a;
    address internal immutable priceFeedAddress07;
    uint256 internal immutable asset08_a;
    address internal immutable priceFeedAddress08;
    uint256 internal immutable asset09_a;
    address internal immutable priceFeedAddress09;
    uint256 internal immutable asset10_a;
    address internal immutable priceFeedAddress10;
    uint256 internal immutable asset11_a;
    address internal immutable priceFeedAddress11;
    uint256 internal immutable asset12_a;
    address internal immutable priceFeedAddress12;
    uint256 internal immutable asset13_a;
    address internal immutable priceFeedAddress13;
    uint256 internal immutable asset14_a;
    address internal immutable priceFeedAddress14;
    uint256 internal immutable asset15_a;
    address internal immutable priceFeedAddress15;
    uint256 internal immutable asset16_a;
    address internal immutable priceFeedAddress16;
    uint256 internal immutable asset17_a;
    address internal immutable priceFeedAddress17;
    uint256 internal immutable asset18_a;
    address internal immutable priceFeedAddress18;
    uint256 internal immutable asset19_a;
    address internal immutable priceFeedAddress19;
    uint256 internal immutable asset20_a;
    address internal immutable priceFeedAddress20;
    uint256 internal immutable asset21_a;
    address internal immutable priceFeedAddress21;
    uint256 internal immutable asset22_a;
    address internal immutable priceFeedAddress22;
    uint256 internal immutable asset23_a;
    address internal immutable priceFeedAddress23;

    /// @notice The number of assets this contract actually supports
    uint8 public immutable numAssets;

    /// @inheritdoc IConfigHash
    bytes32 public immutable configHash;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The only address allowed to call the setters
    address public configurator;

    /// @notice Storage of the asset list's mutable configs
    AssetConfigStorage internal assetConfigStorage;

    modifier onlyConfigurator() {
        if (msg.sender != configurator) revert OnlyConfigurator();
        _;
    }

    constructor(AssetImmutableConfig[] memory assetConfigs) {
        _disableInitializers();

        uint8 _numAssets = uint8(assetConfigs.length);
        numAssets = _numAssets;
        configHash = ConfigHash.hashConfig(TYPEHASH, abi.encode(assetConfigs));

        (asset00_a, priceFeedAddress00) = _packAsset(assetConfigs, 0);
        (asset01_a, priceFeedAddress01) = _packAsset(assetConfigs, 1);
        (asset02_a, priceFeedAddress02) = _packAsset(assetConfigs, 2);
        (asset03_a, priceFeedAddress03) = _packAsset(assetConfigs, 3);
        (asset04_a, priceFeedAddress04) = _packAsset(assetConfigs, 4);
        (asset05_a, priceFeedAddress05) = _packAsset(assetConfigs, 5);
        (asset06_a, priceFeedAddress06) = _packAsset(assetConfigs, 6);
        (asset07_a, priceFeedAddress07) = _packAsset(assetConfigs, 7);
        (asset08_a, priceFeedAddress08) = _packAsset(assetConfigs, 8);
        (asset09_a, priceFeedAddress09) = _packAsset(assetConfigs, 9);
        (asset10_a, priceFeedAddress10) = _packAsset(assetConfigs, 10);
        (asset11_a, priceFeedAddress11) = _packAsset(assetConfigs, 11);
        (asset12_a, priceFeedAddress12) = _packAsset(assetConfigs, 12);
        (asset13_a, priceFeedAddress13) = _packAsset(assetConfigs, 13);
        (asset14_a, priceFeedAddress14) = _packAsset(assetConfigs, 14);
        (asset15_a, priceFeedAddress15) = _packAsset(assetConfigs, 15);
        (asset16_a, priceFeedAddress16) = _packAsset(assetConfigs, 16);
        (asset17_a, priceFeedAddress17) = _packAsset(assetConfigs, 17);
        (asset18_a, priceFeedAddress18) = _packAsset(assetConfigs, 18);
        (asset19_a, priceFeedAddress19) = _packAsset(assetConfigs, 19);
        (asset20_a, priceFeedAddress20) = _packAsset(assetConfigs, 20);
        (asset21_a, priceFeedAddress21) = _packAsset(assetConfigs, 21);
        (asset22_a, priceFeedAddress22) = _packAsset(assetConfigs, 22);
        (asset23_a, priceFeedAddress23) = _packAsset(assetConfigs, 23);
    }

    /**
     * @notice Set the factors and supply caps of the listed assets, and the configurator allowed to change them later
     * @dev The configs go in the same order as the assets passed to the constructor, one per asset
     * @param storageConfigs The mutable part of the asset configurations
     * @param configurator_ The configurator
     */
    function initialize(StorageConfig[] calldata storageConfigs, address configurator_) external initializer {
        if (storageConfigs.length != numAssets) revert StorageConfigsLengthMismatch();
        if (configurator_ == address(0)) revert ZeroConfigurator();
        configurator = configurator_;

        for (uint8 i; i < numAssets; ++i) {
            (uint256 word_a, ) = _loadPackedAsset(i);
            address asset = address(uint160(word_a));
            // A nil asset has nothing to configure
            if (asset == address(0)) continue;

            _addAsset(asset, storageConfigs[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                             CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Register an asset that is in the immutables but has no storage config yet, and set its storage config
     * @dev Used after the list is upgraded to an implementation built with more assets: initialize ran only once,
     *      so the new assets are not registered until this is called for each of them
     * @param asset The asset, must be in the immutables of this implementation and not registered yet
     * @param config The factors and supply cap of the asset
     */
    function addAsset(address asset, StorageConfig calldata config) external onlyConfigurator {
        // Nil slots hold the zero address, so it would otherwise match an empty slot
        if (asset == address(0) || !_isInImmutables(asset)) revert BadAsset();
        _addAsset(asset, config);
    }

    /**
     * @notice Set the borrow collateral factor of an asset
     * @dev The new value is checked together with the asset's current liquidate collateral factor and liquidation factor,
     *      so raising it above the current liquidate collateral factor needs that factor raised first
     * @param asset The asset, must be listed at construction
     */
    function setBorrowCollateralFactor(address asset, uint64 borrowCollateralFactor) external onlyConfigurator {
        StorageConfig storage config = _listedConfig(asset);
        _validateCollateralFactors(borrowCollateralFactor, config.liquidateCollateralFactor, config.liquidationFactor);
        emit UpdateAssetBorrowCollateralFactor(asset, config.borrowCollateralFactor, borrowCollateralFactor);
        config.borrowCollateralFactor = borrowCollateralFactor;
    }

    /**
     * @notice Set the liquidate collateral factor of an asset
     * @dev The new value is checked together with the asset's current borrow collateral factor and liquidation factor,
     *      so lowering it to or below the current borrow collateral factor needs that factor lowered first
     * @param asset The asset, must be listed at construction
     */
    function setLiquidateCollateralFactor(address asset, uint64 liquidateCollateralFactor) external onlyConfigurator {
        StorageConfig storage config = _listedConfig(asset);
        _validateCollateralFactors(config.borrowCollateralFactor, liquidateCollateralFactor, config.liquidationFactor);
        emit UpdateAssetLiquidateCollateralFactor(asset, config.liquidateCollateralFactor, liquidateCollateralFactor);
        config.liquidateCollateralFactor = liquidateCollateralFactor;
    }

    /**
     * @notice Set the liquidation factor of an asset
     * @param asset The asset, must be listed at construction
     */
    function setLiquidationFactor(address asset, uint64 liquidationFactor) external onlyConfigurator {
        StorageConfig storage config = _listedConfig(asset);
        _validateCollateralFactors(config.borrowCollateralFactor, config.liquidateCollateralFactor, liquidationFactor);
        emit UpdateAssetLiquidationFactor(asset, config.liquidationFactor, liquidationFactor);
        config.liquidationFactor = liquidationFactor;
    }

    /**
     * @notice Set the supply cap of an asset
     * @param asset The asset, must be listed at construction
     */
    function setSupplyCap(address asset, uint128 supplyCap) external onlyConfigurator {
        StorageConfig storage config = _listedConfig(asset);
        emit UpdateAssetSupplyCap(asset, config.supplyCap, supplyCap);
        config.supplyCap = supplyCap;
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Get the i-th asset info, according to the order they were passed in originally
     * @param i The index of the asset info to get
     * @return The asset info object
     */
    function getAssetInfo(uint8 i) public view returns (AssetInfo memory) {
        if (i >= numAssets) revert BadAsset();
        (uint256 word_a, address priceFeed) = _loadPackedAsset(i);

        address asset = address(uint160(word_a));

        // Factors and supply cap are kept unscaled in storage so the Configurator can change them
        StorageConfig memory config = assetConfigStorage.configs[asset];

        return AssetInfo({
            asset: asset,
            scale: uint64(word_a >> 168),
            offset: i,
            priceFeed: priceFeed,
            borrowCollateralFactor: config.borrowCollateralFactor,
            supplyCap: config.supplyCap,
            liquidateCollateralFactor: config.liquidateCollateralFactor,
            liquidationFactor: config.liquidationFactor
        });
    }

    /**
     * @notice Get the asset info of an asset by its address
     * @param asset The asset, must be listed at construction
     * @return The asset info object
     */
    function getAssetInfoByAddress(address asset) public view returns (AssetInfo memory) {
        // Rejects unlisted assets, including the zero address that nil slots hold, without scanning
        if (!assetConfigStorage.assets.contains(asset)) revert BadAsset();

        // Only the packed words are compared, so storage is read just once for the matching asset
        for (uint8 i; i < numAssets; ) {
            (uint256 word_a, ) = _loadPackedAsset(i);
            if (address(uint160(word_a)) == asset) return getAssetInfo(i);
            unchecked { ++i; }
        }
        revert BadAsset();
    }

    /*//////////////////////////////////////////////////////////////
                                 UTILS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Checks and gets the packed asset info and the price feed address
     * - in the packed word, the asset address is stored in the lower 160 bits (address can be interpreted as uint160),
     *      the asset decimals in the next 8 bits, and the asset scale (10 to the power of the decimals) in the next 64 bits
     * @param assetConfigs The immutable part of the asset configurations
     * @param i The index of the asset info to get
     * @return The packed asset info and the price feed address
     */
    function _packAsset(AssetImmutableConfig[] memory assetConfigs, uint i) internal view returns (uint256, address) {
        AssetImmutableConfig memory assetConfig;
        if (i < assetConfigs.length) {
            assembly {
                assetConfig := mload(add(add(assetConfigs, 0x20), mul(i, 0x20)))
            }
        } else {
            return (0, address(0));
        }
        address asset = assetConfig.asset;
        address priceFeed = assetConfig.priceFeed;
        uint8 decimals_ = assetConfig.decimals;

        // Short-circuit if asset is nil
        if (asset == address(0)) {
            return (0, address(0));
        }

        // Sanity check price feed and asset decimals
        if (IPriceFeed(priceFeed).decimals() != PRICE_FEED_DECIMALS) revert BadDecimals();
        if (IERC20NonStandard(asset).decimals() != decimals_) revert BadDecimals();
        // The scale is packed as uint64, so it must fit
        if (decimals_ > MAX_ASSET_DECIMALS) revert BadDecimals();
        uint64 scale = uint64(10 ** decimals_);

        uint256 word_a = (uint160(asset) << 0 |        // bits 0-159: asset address
                          uint256(decimals_) << 160 |  // bits 160-167: asset decimals
                          uint256(scale) << 168);      // bits 168-231: asset scale (bits 232-255 unused)
        return (word_a, priceFeed);
    }

    /**
     * @dev Gets the packed asset info and the price feed address of the i-th asset from the immutables
     */
    function _loadPackedAsset(uint8 i) internal view returns (uint256 word_a, address priceFeed) {
        if(i == 0){
            word_a = asset00_a;
            priceFeed = priceFeedAddress00;
        }
        if(i == 1){
            word_a = asset01_a;
            priceFeed = priceFeedAddress01;
        }
        if(i == 2){
            word_a = asset02_a;
            priceFeed = priceFeedAddress02;
        }
        if(i == 3){
            word_a = asset03_a;
            priceFeed = priceFeedAddress03;
        }
        if(i == 4){
            word_a = asset04_a;
            priceFeed = priceFeedAddress04;
        }
        if(i == 5){
            word_a = asset05_a;
            priceFeed = priceFeedAddress05;
        }
        if(i == 6){
            word_a = asset06_a;
            priceFeed = priceFeedAddress06;
        }
        if(i == 7){
            word_a = asset07_a;
            priceFeed = priceFeedAddress07;
        }
        if(i == 8){
            word_a = asset08_a;
            priceFeed = priceFeedAddress08;
        }
        if(i == 9){
            word_a = asset09_a;
            priceFeed = priceFeedAddress09;
        }
        if(i == 10){
            word_a = asset10_a;
            priceFeed = priceFeedAddress10;
        }
        if(i == 11){
            word_a = asset11_a;
            priceFeed = priceFeedAddress11;
        }
        if(i == 12){
            word_a = asset12_a;
            priceFeed = priceFeedAddress12;
        }
        if(i == 13){
            word_a = asset13_a;
            priceFeed = priceFeedAddress13;
        }
        if(i == 14){
            word_a = asset14_a;
            priceFeed = priceFeedAddress14;
        }
        if(i == 15){
            word_a = asset15_a;
            priceFeed = priceFeedAddress15;
        }
        if(i == 16){
            word_a = asset16_a;
            priceFeed = priceFeedAddress16;
        }
        if(i == 17){
            word_a = asset17_a;
            priceFeed = priceFeedAddress17;
        }
        if(i == 18){
            word_a = asset18_a;
            priceFeed = priceFeedAddress18;
        }
        if(i == 19){
            word_a = asset19_a;
            priceFeed = priceFeedAddress19;
        }
        if(i == 20){
            word_a = asset20_a;
            priceFeed = priceFeedAddress20;
        }
        if(i == 21){
            word_a = asset21_a;
            priceFeed = priceFeedAddress21;
        }
        if(i == 22){
            word_a = asset22_a;
            priceFeed = priceFeedAddress22;
        }
        if(i == 23){
            word_a = asset23_a;
            priceFeed = priceFeedAddress23;
        }
    }

    /**
     * @dev Sanity checks for factors ordering: BCF < LCF; LCF <= MAX; LF <= MAX
     * Valid collateral factor configurations:
     *  1. Both BCF and LCF are 0 => collateral is fully de-listed
     *  2. borrowCF=0, liquidateCF>0 => soft de-list (no new borrows, controlled liquidation wind-down)
     *  3. Both non-zero, properly ordered => active collateral
     * Invalid: borrowCF>0, liquidateCF=0 => reverts (borrow power without liquidation coverage)
     */
    function _validateCollateralFactors(
        uint64 borrowCollateralFactor,
        uint64 liquidateCollateralFactor,
        uint64 liquidationFactor
    ) internal pure {
        if (borrowCollateralFactor >= liquidateCollateralFactor && borrowCollateralFactor != 0) revert BorrowCFTooLarge();
        if (liquidateCollateralFactor > MAX_COLLATERAL_FACTOR) revert LiquidateCFTooLarge();
        if (liquidationFactor > MAX_COLLATERAL_FACTOR) revert LiqPenaltyTooHigh();
    }

    /**
     * @dev Whether the asset is one of the assets packed into the immutables of this implementation
     */
    function _isInImmutables(address asset) internal view returns (bool) {
        for (uint8 i; i < numAssets; ++i) {
            (uint256 word_a, ) = _loadPackedAsset(i);
            if (address(uint160(word_a)) == asset) return true;
        }
        return false;
    }

    /**
     * @dev Validates the factors of an asset, registers it so the setters can change it later,
     *      and stores its factors and supply cap unscaled. Reverts if the asset is already registered
     */
    function _addAsset(address asset, StorageConfig calldata config) internal {
        _validateCollateralFactors(
            config.borrowCollateralFactor,
            config.liquidateCollateralFactor,
            config.liquidationFactor
        );

        if (!assetConfigStorage.assets.add(asset)) revert AssetAlreadyAdded();
        assetConfigStorage.configs[asset] = config;

        emit AssetAdded(asset, config);
    }

    /**
     * @dev Returns the stored config of an asset, reverting if the asset was not listed at construction
     */
    function _listedConfig(address asset) internal view returns (StorageConfig storage) {
        if (!assetConfigStorage.assets.contains(asset)) revert BadAsset();
        return assetConfigStorage.configs[asset];
    }
}
