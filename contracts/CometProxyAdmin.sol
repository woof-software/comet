// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { ProxyAdmin, TransparentUpgradeableProxy } from  "contracts/vendor/proxy/transparent/ProxyAdmin.sol";
import { Deployable } from "contracts/interfaces/Deployable.sol";
import { IAssetList } from "contracts/interfaces/assetList/IAssetList.sol";

contract CometProxyAdmin is ProxyAdmin {

    /**
     * @dev Initializes the contract setting the specified address as the initial owner.
     * @param initialOwner The address to set as the owner of the contract.
     */
    constructor(address initialOwner) ProxyAdmin(initialOwner) {}

    /**
     * @dev Deploy a new Comet and upgrade the implementation of the Comet proxy
     *  The AssetList of the Comet is upgraded first, if its immutable configuration has changed
     *  Requirements:
     *   - This contract must be the admin of `CometProxy`
     *   - This contract must be the admin of the AssetList proxy of the Comet
     */
    function deployAndUpgradeTo(Deployable configuratorProxy, TransparentUpgradeableProxy cometProxy) public virtual onlyOwner {
        _deployAndUpgradeAssetList(configuratorProxy, cometProxy);
        address newCometImpl = configuratorProxy.deploy(address(cometProxy));
        upgrade(cometProxy, newCometImpl);
    }

    /**
     * @dev Deploy a new Comet and upgrade the implementation of the Comet proxy, then call the function
     *  The AssetList of the Comet is upgraded first, if its immutable configuration has changed
     *  Requirements:
     *   - This contract must be the admin of `CometProxy`
     *   - This contract must be the admin of the AssetList proxy of the Comet
     */
    function deployUpgradeToAndCall(Deployable configuratorProxy, TransparentUpgradeableProxy cometProxy, bytes memory data) public virtual onlyOwner {
        _deployAndUpgradeAssetList(configuratorProxy, cometProxy);
        address newCometImpl = configuratorProxy.deploy(address(cometProxy));
        upgradeAndCall(cometProxy, newCometImpl, data);
    }

    /**
     * @dev Deploy a new AssetList and upgrade the implementation of the AssetList proxy of the Comet,
     *  if the immutable configuration of the AssetList has changed. The Comet itself is not redeployed
     *  Requirements:
     *   - This contract must be the admin of the AssetList proxy of the Comet
     */
    function deployAndUpgradeAssetListTo(Deployable configuratorProxy, TransparentUpgradeableProxy cometProxy) public virtual onlyOwner {
        _deployAndUpgradeAssetList(configuratorProxy, cometProxy);
    }

    /**
     * @dev Deploys a new AssetList through the Configurator and upgrades the AssetList proxy to it, writing the storage
     * configs of all assets to the list in the same call. With no new implementation the proxy is upgraded to its
     * current one, only to make that call
     */
    function _deployAndUpgradeAssetList(Deployable configuratorProxy, TransparentUpgradeableProxy cometProxy) private {
        (address assetListProxy, address newAssetListImpl) = configuratorProxy.deployAssetList(address(cometProxy));
        TransparentUpgradeableProxy proxy = TransparentUpgradeableProxy(payable(assetListProxy));
        if (newAssetListImpl == address(0)) newAssetListImpl = getProxyImplementation(proxy);
        // The transparent proxy blocks plain calls from its admin, so upgradeAndCall is the only way to reach the list.
        // Initialize ran only once, so the storage configs are written on every upgrade: a new asset gets registered
        // and a changed one gets its factors and cap
        upgradeAndCall(
            proxy,
            newAssetListImpl,
            abi.encodeCall(IAssetList.setAssetConfigs, (configuratorProxy.getStorageAssetConfig(address(cometProxy))))
        );
    }
}
