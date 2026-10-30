import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { AssetConfigStruct } from '../../../../build/types/Configurator';
import { BigNumber, constants, Contract, utils } from 'ethers';

const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDS_COMET = '0x5D409e56D886231aDAf00c8775665AD0f9897b56';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const WBTC_COMET = '0xe85Dc543813B8c2CFEaAc371517b925a166a9293';
const WETH_COMET = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';
const WSTETH_COMET = '0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3';
// EIP-1967 admin slot
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

export default migration('1792676913_asset_list_v2_configurator_migration', {
  async prepare(deploymentManager: DeploymentManager) {
    const {
      configurator,
      timelock
    } = await deploymentManager.getContracts();

    // Forced, so aliases always point to fresh contracts

    // Configurator
    const configuratorIntermediate = await deploymentManager.deploy(
      'configuratorIntermediate',
      'migration/ConfiguratorIntermediate.sol',
      [],
      true
    );
    const configuratorImplementation = await deploymentManager.deploy(
      'configurator:implementation',
      'Configurator.sol',
      [],
      true
    );

    // Factories
    const assetListFactory = await deploymentManager.deploy(
      'assetListFactory',
      'test/assetList/AssetListFactory.sol',
      [],
      true
    );
    const cometFactory = await deploymentManager.deploy(
      'cometFactory',
      'test/CometFactoryWithExtendedAssetList.sol',
      [],
      true
    );

    // New CometProxyAdmin, owned by the Timelock
    const cometAdmin = await deploymentManager.deploy(
      'cometAdmin',
      'CometProxyAdmin.sol',
      [timelock.address],
      true
    );

    // Asset lists are built from the current configs: immutable part in the implementation, storage part in initialize
    const usdcAssetConfigs: AssetConfigStruct[] = (await configurator.getConfiguration(USDC_COMET)).assetConfigs;
    const usdtAssetConfigs: AssetConfigStruct[] = (await configurator.getConfiguration(USDT_COMET)).assetConfigs;

    // USDC
    const usdcAssetListImplementation = await deploymentManager.deploy(
      'assetList:implementation',
      'AssetList.sol',
      [usdcAssetConfigs.map(({ asset, decimals, priceFeed }) => ({ asset, decimals, priceFeed }))],
      true
    );
    const usdcAssetList = await deploymentManager.deploy(
      'assetList',
      'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
      [
        usdcAssetListImplementation.address,
        cometAdmin.address,
        usdcAssetListImplementation.interface.encodeFunctionData('initialize', [
          usdcAssetConfigs.map(({ borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }) => (
            { borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }
          )),
          configurator.address,
        ]),
      ],
      true
    );
    const usdcCometExt = await deploymentManager.deploy(
      'comet:implementation:implementation',
      'CometExt.sol',
      [{
        name32: utils.formatBytes32String('Compound USDC'),
        symbol32: utils.formatBytes32String('cUSDCv3'),
      }],
      true
    );

    // USDT
    const usdtAssetListImplementation = await deploymentManager.deploy(
      'usdtAssetList:implementation',
      'AssetList.sol',
      [usdtAssetConfigs.map(({ asset, decimals, priceFeed }) => ({ asset, decimals, priceFeed }))],
      true
    );
    const usdtAssetList = await deploymentManager.deploy(
      'usdtAssetList',
      'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
      [
        usdtAssetListImplementation.address,
        cometAdmin.address,
        usdtAssetListImplementation.interface.encodeFunctionData('initialize', [
          usdtAssetConfigs.map(({ borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }) => (
            { borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }
          )),
          configurator.address,
        ]),
      ],
      true
    );
    const usdtCometExt = await deploymentManager.deploy(
      'usdtCometExt',
      'CometExt.sol',
      [{
        name32: utils.formatBytes32String('Compound USDT'),
        symbol32: utils.formatBytes32String('cUSDTv3'),
      }],
      true
    );

    // Switch the alias to the new Configurator ABI for enact, verify and scenarios
    await deploymentManager.putAlias(
      'configurator',
      await deploymentManager.hre.ethers.getContractAt('Configurator', configurator.address)
    );

    return {
      configuratorIntermediate: configuratorIntermediate.address,
      configuratorImplementation: configuratorImplementation.address,
      assetListFactory: assetListFactory.address,
      cometFactory: cometFactory.address,
      cometAdmin: cometAdmin.address,
      usdcAssetList: usdcAssetList.address,
      usdtAssetList: usdtAssetList.address,
      usdcCometExt: usdcCometExt.address,
      usdtCometExt: usdtCometExt.address,
    };
  },

  async enact(deploymentManager: DeploymentManager, _,
    {
      configuratorIntermediate: configuratorIntermediateAddress,
      configuratorImplementation: configuratorImplementationAddress,
      assetListFactory: assetListFactoryAddress,
      cometFactory: cometFactoryAddress,
      cometAdmin: cometAdminAddress,
      usdcAssetList,
      usdtAssetList,
      usdcCometExt,
      usdtCometExt,
    }
  ) {
    const trace = deploymentManager.tracer();
    const ethers = deploymentManager.hre.ethers;
    const { governor, configurator } = await deploymentManager.getContracts();

    // The cometAdmin alias already points to the new admin, so the current one is read from the proxy
    const oldCometAdmin = await ethers.getContractAt(
      'CometProxyAdmin',
      utils.getAddress(utils.hexDataSlice(await ethers.provider.getStorageAt(configurator.address, ADMIN_SLOT), 12))
    );
    const newCometAdmin = await ethers.getContractAt('CometProxyAdmin', cometAdminAddress);
    const configuratorIntermediate = await ethers.getContractAt('ConfiguratorIntermediate', configurator.address);
    const newConfigurator = await ethers.getContractAt('Configurator', configurator.address);

    const mainnetActions = [
      // 1. Upgrade the Configurator to the intermediate implementation
      {
        contract: oldCometAdmin,
        signature: 'upgrade(address,address)',
        args: [configurator.address, configuratorIntermediateAddress],
      },
      // 2. Move the asset configs of every Comet on this Configurator to the new storage
      {
        contract: configuratorIntermediate,
        signature: 'migrateAssetConfig(address[])',
        args: [[USDC_COMET, USDS_COMET, USDT_COMET, WBTC_COMET, WETH_COMET, WSTETH_COMET]],
      },
      // 3. Upgrade the Configurator to the new implementation
      {
        contract: oldCometAdmin,
        signature: 'upgrade(address,address)',
        args: [configurator.address, configuratorImplementationAddress],
      },
      // 4. Move the Configurator to the new CometProxyAdmin
      {
        contract: oldCometAdmin,
        signature: 'changeProxyAdmin(address,address)',
        args: [configurator.address, cometAdminAddress],
      },
      // 5. Move the USDC Comet to the new CometProxyAdmin
      {
        contract: oldCometAdmin,
        signature: 'changeProxyAdmin(address,address)',
        args: [USDC_COMET, cometAdminAddress],
      },
      // 6. Move the USDT Comet to the new CometProxyAdmin
      {
        contract: oldCometAdmin,
        signature: 'changeProxyAdmin(address,address)',
        args: [USDT_COMET, cometAdminAddress],
      },
      // 7. Set the asset list factory for the USDC Comet
      {
        contract: newConfigurator,
        signature: 'setAssetListFactory(address,address)',
        args: [USDC_COMET, assetListFactoryAddress],
      },
      // 8. Point the USDC Comet to its new asset list
      {
        contract: newConfigurator,
        signature: 'updateAssetList(address,address)',
        args: [USDC_COMET, usdcAssetList],
      },
      // 9. Set the Comet factory for the USDC Comet
      {
        contract: newConfigurator,
        signature: 'setFactory(address,address)',
        args: [USDC_COMET, cometFactoryAddress],
      },
      // 10. Set the new CometExt as the extension delegate of the USDC Comet
      {
        contract: newConfigurator,
        signature: 'setExtensionDelegate(address,address)',
        args: [USDC_COMET, usdcCometExt],
      },
      // 11. Set the asset list factory for the USDT Comet
      {
        contract: newConfigurator,
        signature: 'setAssetListFactory(address,address)',
        args: [USDT_COMET, assetListFactoryAddress],
      },
      // 12. Point the USDT Comet to its new asset list
      {
        contract: newConfigurator,
        signature: 'updateAssetList(address,address)',
        args: [USDT_COMET, usdtAssetList],
      },
      // 13. Set the Comet factory for the USDT Comet
      {
        contract: newConfigurator,
        signature: 'setFactory(address,address)',
        args: [USDT_COMET, cometFactoryAddress],
      },
      // 14. Set the new CometExt as the extension delegate of the USDT Comet
      {
        contract: newConfigurator,
        signature: 'setExtensionDelegate(address,address)',
        args: [USDT_COMET, usdtCometExt],
      },
      // 15. Deploy and upgrade the USDC Comet to a new version
      {
        contract: newCometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, USDC_COMET],
      },
      // 16. Deploy and upgrade the USDT Comet to a new version
      {
        contract: newCometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, USDT_COMET],
      },
    ];

    const description = `# Update Mainnet USDC and USDT Comets to the service patch V2

## Proposal summary

WOOF! proposes upgrading the Mainnet cUSDCv3 and cUSDTv3 markets to the service patch V2, which moves them to a new, upgradeable asset list, together with the Mainnet Configurator they share.

The new Configurator keeps the asset configs of each market apart from the rest of its configuration. With the upgradeable asset list:

- Collateral factors and supply caps are changed on the asset list directly, without deploying a new asset list and Comet.
- The asset list code can be upgraded on its own, without upgrading Comet.
- Collateral factors and supply caps are kept with their exact values. The old asset list kept collateral factors with 4 decimals and supply caps in whole tokens.

The asset configs of cUSDCv3 and cUSDTv3 are copied as they are. The asset configs of the other markets that share this Configurator (cUSDSv3, cWBTCv3, cWETHv3 and cwstETHv3) are moved to the new storage as well, so the Configurator keeps managing them. These markets keep running on their current Comet and asset list until a follow-up proposal updates them to the service patch V2.

This proposal takes the governance steps recommended and necessary to update Compound III markets. Simulations have confirmed the market's readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Further detailed information can be found on the corresponding [proposal pull request](<>) and [forum discussion](<>).

## Proposal Actions

The first action upgrades the Configurator to an intermediate implementation.

The second action moves the asset configs of cUSDCv3, cUSDSv3, cUSDTv3, cWBTCv3, cWETHv3 and cwstETHv3 to the new storage of the Configurator.

The third action upgrades the Configurator to the new implementation.

The fourth action moves the Configurator to a new CometProxyAdmin, owned by the Timelock.

The fifth action moves cUSDCv3 to the new CometProxyAdmin.

The sixth action moves cUSDTv3 to the new CometProxyAdmin.

The seventh action sets the asset list factory for cUSDCv3 to the newly deployed factory.

The eighth action sets the asset list of cUSDCv3 to the newly deployed asset list.

The ninth action sets the factory for cUSDCv3 to the newly deployed factory.

The tenth action sets the extension delegate of cUSDCv3 to the newly deployed contract.

The eleventh action sets the asset list factory for cUSDTv3 to the newly deployed factory.

The twelfth action sets the asset list of cUSDTv3 to the newly deployed asset list.

The thirteenth action sets the factory for cUSDTv3 to the newly deployed factory.

The fourteenth action sets the extension delegate of cUSDTv3 to the newly deployed contract.

The fifteenth action deploys and upgrades cUSDCv3 to a new version.

The sixteenth action deploys and upgrades cUSDTv3 to a new version.
`;
    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      ), 0, 600_000
    );

    const event = txn.events.find(
      (event: { event: string }) => event.event === 'ProposalCreated'
    );
    const [proposalId] = event.args;
    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return false;
  },

  async verify(deploymentManager: DeploymentManager, _, preMigrationBlockNumber: number): Promise<void> {
    const ethers = deploymentManager.hre.ethers;
    const {
      configurator,
      timelock,
      cometAdmin,
      'configurator:implementation': configuratorImplementation,
      assetListFactory,
      cometFactory,
      assetList: usdcAssetList,
      usdtAssetList,
      'comet:implementation:implementation': usdcCometExt,
      usdtCometExt,
    } = await deploymentManager.getContracts();
    const signer = await deploymentManager.getSigner();
    const preMigrationBlockTag = { blockTag: preMigrationBlockNumber };

    const newCometAbi = [
      'function assetList() external view returns (address)',
      'function extensionDelegate() external view returns (address)',
      'function name() external view returns (string)',
      'function symbol() external view returns (string)',
    ];
    const assetListAbi = [
      'function configurator() external view returns (address)',
    ];

    async function getProxyAdmin(proxy: string, blockNumber?: number): Promise<string> {
      const admin = await ethers.provider.getStorageAt(proxy, ADMIN_SLOT, blockNumber);
      return utils.getAddress(utils.hexDataSlice(admin, 12));
    }

    // Pre-migration state is read with the V1 ABI
    const oldConfigurator = await ethers.getContractAt('ConfiguratorV1', configurator.address);
    const newConfigurator = await ethers.getContractAt('Configurator', configurator.address);
    const oldCometAdminAddress = await getProxyAdmin(configurator.address, preMigrationBlockNumber);

    // Configurator
    expect(await cometAdmin.owner()).to.equal(timelock.address);
    expect(await getProxyAdmin(configurator.address)).to.equal(cometAdmin.address);
    expect(await cometAdmin.getProxyImplementation(configurator.address)).to.equal(configuratorImplementation.address);
    expect(await newConfigurator.governor()).to.equal(await oldConfigurator.governor(preMigrationBlockTag));

    // USDC
    expect(await getProxyAdmin(USDC_COMET)).to.equal(cometAdmin.address);
    expect(await getProxyAdmin(usdcAssetList.address)).to.equal(cometAdmin.address);
    expect(await newConfigurator.factory(USDC_COMET)).to.equal(cometFactory.address);
    expect(await newConfigurator.cometAssetListFactories(USDC_COMET)).to.equal(assetListFactory.address);
    expect((await newConfigurator.getConfiguration(USDC_COMET)).assetList).to.equal(usdcAssetList.address);
    expect((await newConfigurator.getConfiguration(USDC_COMET)).extensionDelegate).to.equal(usdcCometExt.address);

    const newCometUsdc = new Contract(USDC_COMET, newCometAbi, signer);

    expect(await newCometUsdc.assetList()).to.equal(usdcAssetList.address);
    expect(await newCometUsdc.extensionDelegate()).to.equal(usdcCometExt.address);
    expect(await newCometUsdc.name()).to.equal('Compound USDC');
    expect(await newCometUsdc.symbol()).to.equal('cUSDCv3');
    expect(await new Contract(usdcAssetList.address, assetListAbi, signer).configurator()).to.equal(configurator.address);

    // USDT
    expect(await getProxyAdmin(USDT_COMET)).to.equal(cometAdmin.address);
    expect(await getProxyAdmin(usdtAssetList.address)).to.equal(cometAdmin.address);
    expect(await newConfigurator.factory(USDT_COMET)).to.equal(cometFactory.address);
    expect(await newConfigurator.cometAssetListFactories(USDT_COMET)).to.equal(assetListFactory.address);
    expect((await newConfigurator.getConfiguration(USDT_COMET)).assetList).to.equal(usdtAssetList.address);
    expect((await newConfigurator.getConfiguration(USDT_COMET)).extensionDelegate).to.equal(usdtCometExt.address);

    const newCometUsdt = new Contract(USDT_COMET, newCometAbi, signer);

    expect(await newCometUsdt.assetList()).to.equal(usdtAssetList.address);
    expect(await newCometUsdt.extensionDelegate()).to.equal(usdtCometExt.address);
    expect(await newCometUsdt.name()).to.equal('Compound USDT');
    expect(await newCometUsdt.symbol()).to.equal('cUSDTv3');
    expect(await new Contract(usdtAssetList.address, assetListAbi, signer).configurator()).to.equal(configurator.address);

    // Markets that remain on the old asset list
    expect((await newConfigurator.getConfiguration(USDS_COMET)).assetList).to.equal(constants.AddressZero);
    expect((await newConfigurator.getConfiguration(WBTC_COMET)).assetList).to.equal(constants.AddressZero);
    expect((await newConfigurator.getConfiguration(WETH_COMET)).assetList).to.equal(constants.AddressZero);
    expect((await newConfigurator.getConfiguration(WSTETH_COMET)).assetList).to.equal(constants.AddressZero);

    expect(await getProxyAdmin(USDS_COMET)).to.equal(oldCometAdminAddress);
    expect(await getProxyAdmin(WBTC_COMET)).to.equal(oldCometAdminAddress);
    expect(await getProxyAdmin(WETH_COMET)).to.equal(oldCometAdminAddress);
    expect(await getProxyAdmin(WSTETH_COMET)).to.equal(oldCometAdminAddress);

    // Configuration is unchanged. The first 20 fields match between V1 and V2; the extension delegate (field 4)
    // changes only for USDC and USDT
    for (const cometProxy of [USDC_COMET, USDS_COMET, USDT_COMET, WBTC_COMET, WETH_COMET, WSTETH_COMET]) {
      const configurationBefore = await oldConfigurator.getConfiguration(cometProxy, preMigrationBlockTag);
      const configuration = await newConfigurator.getConfiguration(cometProxy);

      expect(configuration.slice(0, 4)).to.deep.equal(configurationBefore.slice(0, 4));
      expect(configuration.slice(5, 20)).to.deep.equal(configurationBefore.slice(5, 20));
      if (cometProxy !== USDC_COMET && cometProxy !== USDT_COMET) {
        expect(configuration.extensionDelegate).to.equal(configurationBefore.extensionDelegate);
      }

      expect(await newConfigurator.getAssetConfigs(cometProxy)).to.deep.equal(configurationBefore.assetConfigs);
    }

    for (const cometProxy of [USDC_COMET, USDT_COMET]) {
      const newComet = await ethers.getContractAt('CometWithExtendedAssetList', cometProxy);

      // No asset list redeploy needed
      expect((await newConfigurator.callStatic.deployAssetList(cometProxy)).newAssetListImpl).to.equal(constants.AddressZero);

      // Assets match the pre-migration state and the Configurator. The old list rounded supply caps to whole tokens
      const assetConfigs = await newConfigurator.getAssetConfigs(cometProxy);
      const numAssets = await newComet.numAssets();
      expect(numAssets).to.equal(assetConfigs.length);
      expect(numAssets).to.equal(await newComet.numAssets(preMigrationBlockTag));
      for (let i = 0; i < numAssets; i++) {
        const assetInfoBefore = await newComet.getAssetInfo(i, preMigrationBlockTag);
        const assetInfo = await newComet.getAssetInfo(i);

        expect(assetInfo.offset).to.equal(assetInfoBefore.offset);
        expect(assetInfo.asset).to.equal(assetInfoBefore.asset);
        expect(assetInfo.priceFeed).to.equal(assetInfoBefore.priceFeed);
        expect(assetInfo.scale).to.equal(assetInfoBefore.scale);
        expect(assetInfo.borrowCollateralFactor).to.equal(assetInfoBefore.borrowCollateralFactor);
        expect(assetInfo.liquidateCollateralFactor).to.equal(assetInfoBefore.liquidateCollateralFactor);
        expect(assetInfo.liquidationFactor).to.equal(assetInfoBefore.liquidationFactor);
        expect(assetInfo.supplyCap.div(assetInfo.scale).mul(assetInfo.scale)).to.equal(assetInfoBefore.supplyCap);

        expect(assetInfo.asset).to.equal(assetConfigs[i].asset);
        expect(assetInfo.priceFeed).to.equal(assetConfigs[i].priceFeed);
        expect(assetInfo.scale).to.equal(BigNumber.from(10).pow(assetConfigs[i].decimals));
        expect(assetInfo.borrowCollateralFactor).to.equal(assetConfigs[i].borrowCollateralFactor);
        expect(assetInfo.liquidateCollateralFactor).to.equal(assetConfigs[i].liquidateCollateralFactor);
        expect(assetInfo.liquidationFactor).to.equal(assetConfigs[i].liquidationFactor);
        expect(assetInfo.supplyCap).to.equal(assetConfigs[i].supplyCap);
      }
    }
  },
});
