// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./CometExt.sol";

contract CometExtAssetListCustomVersion is CometExt {

    /// @notice The address of the asset list factory
    address immutable public assetListFactory;
    bytes32 internal immutable _customVersion;

    /**
     * @notice Construct a new protocol instance
     * @param config The mapping of initial/constant parameters
     * @param assetListFactoryAddress The address of the asset list factory
     * @param customVersion The version string for this contract
     **/
    constructor(ExtConfiguration memory config, address assetListFactoryAddress, bytes32 customVersion) CometExt(config) {
        assetListFactory = assetListFactoryAddress;
        _customVersion = customVersion;
    }
    
    uint8 internal constant MAX_ASSETS_FOR_ASSET_LIST = 24;

    function version() override public view returns (string memory) {
        uint8 i;
        for (i = 0; i < 32; ) {
            if (_customVersion[i] == 0) {
                break;
            }
            unchecked { i++; }
        }
        bytes memory version_ = new bytes(i);
        for (uint8 j = 0; j < i; ) {
            version_[j] = _customVersion[j];
            unchecked { j++; }
        }
        return string(version_);
    }

    function maxAssets() override external pure returns (uint8) { return MAX_ASSETS_FOR_ASSET_LIST; }
}