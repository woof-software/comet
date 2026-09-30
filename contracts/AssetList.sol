// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./IPriceFeed.sol";
import "./IERC20NonStandard.sol";
import "./CometMainInterface.sol";
import "./CometCore.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title Compound's Asset List
 * @author Compound
 */
contract AssetList {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @dev Mutable part of an asset config; asset, price feed and decimals live in the immutables
    struct AssetConfig {
        uint128 supplyCap;
        uint64 borrowCollateralFactor;
        uint64 liquidateCollateralFactor;
        uint64 liquidationFactor;
    }

    struct AssetConfigStorage {
        EnumerableSet.AddressSet assets;
        mapping(address => AssetConfig) configs;
    }

    /// @dev The decimals required for a price feed
    uint8 internal constant PRICE_FEED_DECIMALS = 8;

    /// @dev The scale for factors
    uint64 internal constant FACTOR_SCALE = 1e18;

    /// @dev The max value for a collateral factor (1)
    uint64 internal constant MAX_COLLATERAL_FACTOR = FACTOR_SCALE;

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

    bytes32 public immutable configHash;

    address public configurator;

    function setConfigurator(address _configurator) external {
        configurator = _configurator;
    }

    AssetConfigStorage internal assetConfigStorage;

    constructor(CometConfiguration.AssetConfig[] memory assetConfigs) {
        uint8 _numAssets = uint8(assetConfigs.length);
        numAssets = _numAssets;
        // ponytail: placeholders, solc 0.8.15 requires immutables to be assigned; wire real values later
        configHash = bytes32(0);
        
        (asset00_a, priceFeedAddress00) = getPackedAssetInternal(assetConfigs, 0);
        (asset01_a, priceFeedAddress01) = getPackedAssetInternal(assetConfigs, 1);
        (asset02_a, priceFeedAddress02) = getPackedAssetInternal(assetConfigs, 2);
        (asset03_a, priceFeedAddress03) = getPackedAssetInternal(assetConfigs, 3);
        (asset04_a, priceFeedAddress04) = getPackedAssetInternal(assetConfigs, 4);
        (asset05_a, priceFeedAddress05) = getPackedAssetInternal(assetConfigs, 5);
        (asset06_a, priceFeedAddress06) = getPackedAssetInternal(assetConfigs, 6);
        (asset07_a, priceFeedAddress07) = getPackedAssetInternal(assetConfigs, 7);
        (asset08_a, priceFeedAddress08) = getPackedAssetInternal(assetConfigs, 8);
        (asset09_a, priceFeedAddress09) = getPackedAssetInternal(assetConfigs, 9);
        (asset10_a, priceFeedAddress10) = getPackedAssetInternal(assetConfigs, 10);
        (asset11_a, priceFeedAddress11) = getPackedAssetInternal(assetConfigs, 11);
        (asset12_a, priceFeedAddress12) = getPackedAssetInternal(assetConfigs, 12);
        (asset13_a, priceFeedAddress13) = getPackedAssetInternal(assetConfigs, 13);
        (asset14_a, priceFeedAddress14) = getPackedAssetInternal(assetConfigs, 14);
        (asset15_a, priceFeedAddress15) = getPackedAssetInternal(assetConfigs, 15);
        (asset16_a, priceFeedAddress16) = getPackedAssetInternal(assetConfigs, 16);
        (asset17_a, priceFeedAddress17) = getPackedAssetInternal(assetConfigs, 17);
        (asset18_a, priceFeedAddress18) = getPackedAssetInternal(assetConfigs, 18);
        (asset19_a, priceFeedAddress19) = getPackedAssetInternal(assetConfigs, 19);
        (asset20_a, priceFeedAddress20) = getPackedAssetInternal(assetConfigs, 20);
        (asset21_a, priceFeedAddress21) = getPackedAssetInternal(assetConfigs, 21);
        (asset22_a, priceFeedAddress22) = getPackedAssetInternal(assetConfigs, 22);
        (asset23_a, priceFeedAddress23) = getPackedAssetInternal(assetConfigs, 23);
    }

    /**
     * @dev Checks and gets the packed asset info and the price feed address,
     *      and saves the full factors and supply cap of the asset in assetConfigStorage
     * - in the packed word, the asset address is stored in the lower 160 bits (address can be interpreted as uint160),
     *      and the asset decimals in the next 8 bits
     * @param assetConfigs The asset configurations
     * @param i The index of the asset info to get
     * @return The packed asset info and the price feed address
     */
    function getPackedAssetInternal(CometConfiguration.AssetConfig[] memory assetConfigs, uint i) internal returns (uint256, address) {
        CometConfiguration.AssetConfig memory assetConfig;
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
        if (IPriceFeed(priceFeed).decimals() != PRICE_FEED_DECIMALS) revert CometMainInterface.BadDecimals();
        if (IERC20NonStandard(asset).decimals() != decimals_) revert CometMainInterface.BadDecimals();

        _validateCollateralFactors(
            assetConfig.borrowCollateralFactor,
            assetConfig.liquidateCollateralFactor,
            assetConfig.liquidationFactor
        );

        // Register the asset so the setters can change it later, and keep its factors and supply cap unscaled
        assetConfigStorage.assets.add(asset);
        assetConfigStorage.configs[asset] = AssetConfig({
            borrowCollateralFactor: assetConfig.borrowCollateralFactor,
            liquidateCollateralFactor: assetConfig.liquidateCollateralFactor,
            liquidationFactor: assetConfig.liquidationFactor,
            supplyCap: assetConfig.supplyCap
        });

        uint256 word_a = (uint160(asset) << 0 |
                          uint256(decimals_) << 160);
        return (word_a, priceFeed);
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
        if (borrowCollateralFactor >= liquidateCollateralFactor && borrowCollateralFactor != 0)
            revert CometMainInterface.BorrowCFTooLarge();
        if (liquidateCollateralFactor > MAX_COLLATERAL_FACTOR) revert CometMainInterface.LiquidateCFTooLarge();
        if (liquidationFactor > MAX_COLLATERAL_FACTOR) revert CometMainInterface.LiqPenaltyTooHigh();
    }

    /**
     * @notice Get the i-th asset info, according to the order they were passed in originally
     * @param i The index of the asset info to get
     * @return The asset info object
     */
    function getAssetInfo(uint8 i) public view returns (CometCore.AssetInfo memory) {
        if (i >= numAssets) revert CometMainInterface.BadAsset();
        uint256 word_a;
        address priceFeed;
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

        address asset = address(uint160(word_a));
        uint8 decimals_ = uint8(word_a >> 160);

        // Factors and supply cap are kept unscaled in storage so the Configurator can change them
        AssetConfig memory config = assetConfigStorage.configs[asset];

        return CometCore.AssetInfo({
            offset: i,
            asset: asset,
            priceFeed: priceFeed,
            scale: uint64(10 ** decimals_),
            borrowCollateralFactor: config.borrowCollateralFactor,
            liquidateCollateralFactor: config.liquidateCollateralFactor,
            liquidationFactor: config.liquidationFactor,
            supplyCap: config.supplyCap
         });
    }

    error OnlyConfigurator();

    modifier onlyConfigurator() {
        if (msg.sender != configurator) revert OnlyConfigurator();
        _;
    }

    /**
     * @notice Set the collateral factors of an asset
     * @param asset The asset, must be listed at construction
     */
    function setFactors(
        address asset,
        uint64 borrowCollateralFactor,
        uint64 liquidateCollateralFactor,
        uint64 liquidationFactor
    ) external onlyConfigurator {
        // Only an asset listed at construction can be changed
        if (!assetConfigStorage.assets.contains(asset)) revert CometMainInterface.BadAsset();

        _validateCollateralFactors(borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor);
        AssetConfig storage config = assetConfigStorage.configs[asset];
        config.borrowCollateralFactor = borrowCollateralFactor;
        config.liquidateCollateralFactor = liquidateCollateralFactor;
        config.liquidationFactor = liquidationFactor;
    }

    /**
     * @notice Set the supply cap of an asset
     * @param asset The asset, must be listed at construction
     */
    function setSupplyCap(address asset, uint128 supplyCap) external onlyConfigurator {
        // Only an asset listed at construction can be changed
        if (!assetConfigStorage.assets.contains(asset)) revert CometMainInterface.BadAsset();

        assetConfigStorage.configs[asset].supplyCap = supplyCap;
    }
}