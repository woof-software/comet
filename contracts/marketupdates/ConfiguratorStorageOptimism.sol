// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { CometConfiguration } from "../CometConfiguration.sol";
import { MarketAdminPermissionCheckerInterface } from "./MarketAdminPermissionCheckerInterface.sol";
import { IAssetListStructs } from "../interfaces/assetList/IAssetListStructs.sol";

/**
 * @title Compound's Comet Configuration Storage Interface
 * @dev Versions can enforce append-only storage slots via inheritance.
 * @author Compound
 */
contract ConfiguratorStorageOptimism is CometConfiguration {
    /// @notice The current version of Configurator. This version should be
    /// checked in the initializer function.
    uint public version;

    /// @notice Mapping of Comet proxy addresses to their Configuration settings
    /// @dev This needs to be internal to avoid a `CompilerError: Stack too deep
    /// when compiling inline assembly` error that is caused by the default
    /// getters created for public variables.
    mapping(address => Configuration) internal configuratorParams;

    /// @notice The governor of the protocol
    address public governor;

    /// @notice Mapping of Comet proxy addresses to their Comet factory contracts
    mapping(address => address) public factory;

    /// @notice MarketAdminPermissionChecker contract which is used to check if the caller has permission to perform market updates
    MarketAdminPermissionCheckerInterface public marketAdminPermissionChecker;

    /// @notice Mapping of Comet proxy addresses to their full asset configs, immutable and storage parts together
    mapping(address => AssetConfig[]) public assetConfigs;

    /// @notice Mapping of Comet proxy addresses to their AssetList factory contracts
    mapping(address => address) public cometAssetListFactories;
}
