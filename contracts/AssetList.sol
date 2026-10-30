// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { IPriceFeed } from "./interfaces/IPriceFeed.sol";
import { IERC20NonStandard } from "./interfaces/IERC20NonStandard.sol";
import { IAssetList } from "./interfaces/assetList/IAssetList.sol";
import { ConfigHash, IConfigHash } from "./libraries/ConfigHash.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { StorageSlot } from "./vendor/utils/StorageSlot.sol";

/**
 * @title Compound's Asset List
 * @author Compound
 */
contract AssetList is IAssetList, IConfigHash, Initializable {
    using EnumerableSet for EnumerableSet.AddressSet;

    /*//////////////////////////////////////////////////////////////
                         CONSTANTS / IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @dev Required by IConfigHash library. Determines the type of the config.
    /// @dev Update if new immutable config types are added.
    bytes32 public constant TYPEHASH =
        keccak256("ImmutableConfig[](address asset,address priceFeed)");

    /// @dev The decimals required for a price feed
    uint8 internal constant PRICE_FEED_DECIMALS = 8;

    /// @dev The ERC-1967 slot where the list proxy keeps its admin
    bytes32 internal constant PROXY_ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);

    /// @dev The max asset decimals whose scale (10 to the power of the decimals) fits in uint64
    uint8 internal constant MAX_ASSET_DECIMALS = 19;

    /// @dev The scale for factors, so 1e18 is a factor of 1, the max for any of them
    uint64 internal constant FACTOR_SCALE = 1e18;

    /// @dev The max number of assets, one per pair of immutables below
    uint8 internal constant MAX_ASSETS = 24;

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

    /// @notice The only address allowed to call the setters
    address public immutable configurator;

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @dev Registered assets, so a setter rejects an unlisted asset with one lookup
    EnumerableSet.AddressSet internal assets;

    /// @dev Factors and supply cap of each asset, keyed by address so they stay with the asset whatever its index
    mapping(address => StorageAssetConfig) internal assetConfigs;

    modifier onlyConfigurator() {
        if (msg.sender != configurator) revert OnlyConfigurator();
        _;
    }

    /// @dev The transparent proxy blocks plain calls from its admin, so this passes only inside the proxy admin's
    ///      upgradeAndCall, and never on the implementation itself, whose admin slot is empty
    modifier onlyProxyAdmin() {
        if (msg.sender != StorageSlot.getAddressSlot(PROXY_ADMIN_SLOT).value) revert OnlyProxyAdmin();
        _;
    }

    constructor(ImmutableAssetConfig[] memory assetConfigs_, address configurator_) {
        _disableInitializers();

        if (assetConfigs_.length == 0) revert NoAssets();
        if (assetConfigs_.length > MAX_ASSETS) revert TooManyAssets();
        if (configurator_ == address(0)) revert ZeroConfigurator();
        configurator = configurator_;

        uint8 _numAssets = uint8(assetConfigs_.length);
        numAssets = _numAssets;
        configHash = ConfigHash.hashConfig(TYPEHASH, abi.encode(assetConfigs_));

        (asset00_a, priceFeedAddress00) = 0 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[0]);
        (asset01_a, priceFeedAddress01) = 1 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[1]);
        (asset02_a, priceFeedAddress02) = 2 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[2]);
        (asset03_a, priceFeedAddress03) = 3 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[3]);
        (asset04_a, priceFeedAddress04) = 4 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[4]);
        (asset05_a, priceFeedAddress05) = 5 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[5]);
        (asset06_a, priceFeedAddress06) = 6 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[6]);
        (asset07_a, priceFeedAddress07) = 7 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[7]);
        (asset08_a, priceFeedAddress08) = 8 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[8]);
        (asset09_a, priceFeedAddress09) = 9 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[9]);
        (asset10_a, priceFeedAddress10) = 10 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[10]);
        (asset11_a, priceFeedAddress11) = 11 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[11]);
        (asset12_a, priceFeedAddress12) = 12 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[12]);
        (asset13_a, priceFeedAddress13) = 13 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[13]);
        (asset14_a, priceFeedAddress14) = 14 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[14]);
        (asset15_a, priceFeedAddress15) = 15 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[15]);
        (asset16_a, priceFeedAddress16) = 16 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[16]);
        (asset17_a, priceFeedAddress17) = 17 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[17]);
        (asset18_a, priceFeedAddress18) = 18 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[18]);
        (asset19_a, priceFeedAddress19) = 19 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[19]);
        (asset20_a, priceFeedAddress20) = 20 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[20]);
        (asset21_a, priceFeedAddress21) = 21 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[21]);
        (asset22_a, priceFeedAddress22) = 22 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[22]);
        (asset23_a, priceFeedAddress23) = 23 >= _numAssets ? (0, address(0)) : _packAsset(assetConfigs_[23]);
    }

    /**
     * @notice Set the factors and supply caps of the listed assets
     * @dev The configs go in the same order as the assets passed to the constructor, one per asset
     * @param storageConfigs The mutable part of the asset configurations
     */
    function initialize(StorageAssetConfig[] calldata storageConfigs) external initializer {
        if (storageConfigs.length != numAssets) revert StorageConfigsLengthMismatch();

        for (uint8 i; i < numAssets; ++i) {
            (uint256 word_a, ) = _loadPackedAsset(i);
            // The same asset listed twice is registered only once, so the second time is rejected
            if (!_setAssetConfig(address(uint160(word_a)), storageConfigs[i])) revert AssetAlreadyAdded();
        }
    }

    /*//////////////////////////////////////////////////////////////
                             CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Set the storage configs of all assets in the immutables, registering the new ones
     * @dev The proxy admin calls this through upgradeAndCall on every list upgrade, so a new asset gets registered
     *      and an updated one gets its factors and cap.
     *      Every config is written, even an unchanged one.
     *      Every asset's position in the registered assets is checked against its index in the immutables,
     *      so a wrong order is caught here, at upgrade time
     * @param storageConfigs The factors and supply cap of each asset, in the order of the immutables
     */
    function setAssetConfigs(StorageAssetConfig[] calldata storageConfigs) external onlyProxyAdmin {
        if (storageConfigs.length != numAssets) revert StorageConfigsLengthMismatch();

        for (uint8 i; i < numAssets; ++i) {
            (uint256 word_a, ) = _loadPackedAsset(i);
            address asset = address(uint160(word_a));
            _setAssetConfig(asset, storageConfigs[i]);
            // getAssetInfoByAddress finds an asset by its position in the registered assets, so that position must be
            // its index in the immutables
            if (_registeredPosition(asset) != i + 1) revert AssetIndexMismatch();
        }
    }

    /**
     * @notice Set the borrow collateral factor of an asset
     * @dev The new value is checked together with the asset's current liquidate collateral factor and liquidation factor,
     *      so raising it above the current liquidate collateral factor needs that factor raised first
     * @param asset The asset, must be listed at construction
     */
    function setBorrowCollateralFactor(address asset, uint64 borrowCollateralFactor) external onlyConfigurator {
        StorageAssetConfig storage config = _listedConfig(asset);
        _validateCollateralFactors(borrowCollateralFactor, config.liquidateCollateralFactor, config.liquidationFactor);
        config.borrowCollateralFactor = borrowCollateralFactor;
    }

    /**
     * @notice Set the liquidate collateral factor of an asset
     * @dev The new value is checked together with the asset's current borrow collateral factor and liquidation factor,
     *      so lowering it to or below the current borrow collateral factor needs that factor lowered first
     * @param asset The asset, must be listed at construction
     */
    function setLiquidateCollateralFactor(address asset, uint64 liquidateCollateralFactor) external onlyConfigurator {
        StorageAssetConfig storage config = _listedConfig(asset);
        _validateCollateralFactors(config.borrowCollateralFactor, liquidateCollateralFactor, config.liquidationFactor);
        config.liquidateCollateralFactor = liquidateCollateralFactor;
    }

    /**
     * @notice Set the liquidation factor of an asset
     * @param asset The asset, must be listed at construction
     */
    function setLiquidationFactor(address asset, uint64 liquidationFactor) external onlyConfigurator {
        StorageAssetConfig storage config = _listedConfig(asset);
        _validateCollateralFactors(config.borrowCollateralFactor, config.liquidateCollateralFactor, liquidationFactor);
        config.liquidationFactor = liquidationFactor;
    }

    /**
     * @notice Set the supply cap of an asset
     * @param asset The asset, must be listed at construction
     */
    function setSupplyCap(address asset, uint128 supplyCap) external onlyConfigurator {
        StorageAssetConfig storage config = _listedConfig(asset);
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
        if (i >= numAssets) revert AssetIndexOutOfRange();
        return _composeAssetInfo(i);
    }

    /**
     * @notice Get the asset info of an asset by its address
     * @param asset The asset, must be listed at construction
     * @return The asset info object
     */
    function getAssetInfoByAddress(address asset) public view returns (AssetInfo memory) {
        uint8 position = _registeredPosition(asset);
        if (position == 0) revert AssetNotFound();
        return _composeAssetInfo(position - 1);
    }

    /*//////////////////////////////////////////////////////////////
                                 UTILS
    //////////////////////////////////////////////////////////////*/

    /**
     * @dev Checks and gets the packed asset info and the price feed address
     * - in the packed word, the asset address is stored in the lower 160 bits (address can be interpreted as uint160),
     *      the asset decimals in the next 8 bits, and the asset scale (10 to the power of the decimals) in the next 64 bits
     * @param assetConfig The immutable part of the asset configuration
     * @return The packed asset info and the price feed address
     */
    function _packAsset(ImmutableAssetConfig memory assetConfig) internal view returns (uint256, address) {
        address asset = assetConfig.asset;
        address priceFeed = assetConfig.priceFeed;

        if (asset == address(0) || priceFeed == address(0)) revert ZeroAddress();

        // Sanity check price feed decimals
        if (IPriceFeed(priceFeed).decimals() != PRICE_FEED_DECIMALS) revert PriceFeedDecimalsNotMatched();
        // The asset decimals come from the token itself, so they can never disagree with it
        uint8 decimals = IERC20NonStandard(asset).decimals();
        // The scale is packed as uint64, so it must fit
        if (decimals > MAX_ASSET_DECIMALS) revert MaxAssetDecimalsExceeds();
        uint64 scale = uint64(10 ** decimals);

        uint256 word_a = (uint160(asset) << 0 |        // bits 0-159: asset address
                          uint256(decimals) << 160 |  // bits 160-167: asset decimals
                          uint256(scale) << 168);      // bits 168-231: asset scale (bits 232-255 unused)
        return (word_a, priceFeed);
    }

    /**
     * @dev Sanity checks for factors ordering: BCF < LCF < LF <= FACTOR_SCALE
     * Valid collateral factor configurations:
     *  1. Both BCF and LCF are 0 => collateral is fully de-listed
     *  2. borrowCF=0, liquidateCF>0 => soft de-list (no new borrows, controlled liquidation wind-down)
     *  3. Both non-zero, properly ordered => active collateral
     *  4. Liquidation penalty (LF) can be set to 0 only with BCF and LCF set to 0, meaning non-liquidatable asset
     *  Invalid: borrowCF>0, liquidateCF=0 => reverts (borrow power without liquidation coverage)
     */
    function _validateCollateralFactors(
        uint64 borrowCollateralFactor,
        uint64 liquidateCollateralFactor,
        uint64 liquidationFactor
    ) internal pure {
        if (borrowCollateralFactor >= liquidateCollateralFactor && borrowCollateralFactor != 0) revert BorrowCFTooLarge();
        if (liquidateCollateralFactor >= liquidationFactor && liquidateCollateralFactor != 0) revert LiquidateCFTooLarge();
        if (liquidationFactor > FACTOR_SCALE) revert LiqPenaltyTooHigh();
    }

    /**
     * @dev Builds the asset info of the i-th asset from its packed word and price feed, adding its storage config
     */
    function _composeAssetInfo(uint8 i) internal view returns (AssetInfo memory) {
        (uint256 word_a, address priceFeed) = _loadPackedAsset(i);
        address asset = address(uint160(word_a));

        // Factors and supply cap are kept unscaled in storage so the Configurator can change them
        StorageAssetConfig memory config = assetConfigs[asset];

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

    /// @dev The asset's position in the registered assets, from 1, or 0 if unregistered; EnumerableSet has no getter for it
    function _registeredPosition(address asset) internal view returns (uint8) {
        return uint8(assets._inner._indexes[bytes32(uint256(uint160(asset)))]);
    }

    /**
     * @dev Validates the factors of an asset, registers it so the setters can change it later,
     *      and stores its factors and supply cap unscaled, replacing the config of an asset already registered
     * @return True if the asset was registered by this call, false if it was registered before
     */
    function _setAssetConfig(address asset, StorageAssetConfig calldata config) internal returns (bool) {
        _validateCollateralFactors(
            config.borrowCollateralFactor,
            config.liquidateCollateralFactor,
            config.liquidationFactor
        );

        assetConfigs[asset] = config;
        // Registers a new asset; an asset already registered stays as it is
        return assets.add(asset);
    }

    /**
     * @dev Returns the stored config of an asset, reverting if the asset was not listed at construction
     */
    function _listedConfig(address asset) internal view returns (StorageAssetConfig storage) {
        if (!assets.contains(asset)) revert AssetNotFound();
        return assetConfigs[asset];
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
}
