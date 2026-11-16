// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Deployable
 * @notice The part of the Configurator which the proxy admin calls to deploy new implementations
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface Deployable {
    function deploy(address cometProxy) external returns (address);

    function deployAssetList(address cometProxy) external returns (address assetListProxy, address newAssetListImpl);
}
