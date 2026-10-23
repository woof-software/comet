import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';
import { constants, Contract, utils } from 'ethers';

const USDS_COMET = '0x5D409e56D886231aDAf00c8775665AD0f9897b56';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';
const WBTC_COMET = '0xe85Dc543813B8c2CFEaAc371517b925a166a9293';
const WETH_COMET = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';
const WSTETH_COMET = '0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3';

// EIP-1967 slot that holds the admin of a TransparentUpgradeableProxy
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

interface Vars {
  configuratorIntermediate: string;
  configuratorImplementation: string;
  assetListFactory: string;
  cometFactory: string;
  cometAdmin: string;
  usdcAssetList: string;
  usdsAssetList: string;
  usdcCometExt: string;
  usdsCometExt: string;
}

// Set in enact and read by verify, which gets no artifact
let vars: Vars;

async function getProxyAdmin(deploymentManager: DeploymentManager, proxy: string): Promise<string> {
  const slot = await deploymentManager.hre.ethers.provider.getStorageAt(proxy, ADMIN_SLOT);
  return utils.getAddress('0x' + slot.slice(26));
}

export default migration('1792676913_asset_list_v2_configurator_migration', {
  async prepare(deploymentManager: DeploymentManager) {
    const { comet, configurator, timelock } = await deploymentManager.getContracts();

    // Every contract is forced, so a run never picks up an older contract that already holds the alias.
    // The aliases are the ones the scenarios read after the proposal, when the market runs on these contracts
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
    const assetListFactory = await deploymentManager.deploy('assetListFactory', 'AssetListFactory.sol', [], true);
    const cometFactory = await deploymentManager.deploy('cometFactory', 'CometFactoryWithExtendedAssetList.sol', [], true);

    // A ProxyAdmin is not behind a proxy, so the new admin is a new contract and the proxies are moved to it.
    // The timelock owns it from the start, so no ownership transfer is needed
    const cometAdmin = await deploymentManager.deploy('cometAdmin', 'CometProxyAdmin.sol', [timelock.address], true);

    // The new Configurator only splits each asset config in two: the immutable part builds the list and the storage
    // part initializes it. The live Configurator already holds the same configs, so the lists can be deployed now,
    // before the proposal moves the configs. The proxy keeps the Configurator proxy, whose address never changes
    async function deployAssetList(cometProxy: string, alias: string): Promise<string> {
      const { assetConfigs } = await configurator.getConfiguration(cometProxy);
      const immutableConfigs = assetConfigs.map(config => ({
        asset: config.asset,
        decimals: config.decimals,
        priceFeed: config.priceFeed,
      }));
      const storageConfigs = assetConfigs.map(config => ({
        borrowCollateralFactor: config.borrowCollateralFactor,
        liquidateCollateralFactor: config.liquidateCollateralFactor,
        liquidationFactor: config.liquidationFactor,
        supplyCap: config.supplyCap,
      }));

      const implementation = await deploymentManager.deploy(
        `${alias}:implementation`,
        'AssetList.sol',
        [immutableConfigs],
        true
      );
      const assetListProxy = await deploymentManager.deploy(
        alias,
        'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
        [
          implementation.address,
          cometAdmin.address,
          implementation.interface.encodeFunctionData('initialize', [storageConfigs, configurator.address]),
        ],
        true
      );
      return assetListProxy.address;
    }

    // The new Comet calls the pause and deactivation functions that only the new CometExt has, so each market gets a
    // new one with the name and symbol of its current extension delegate
    async function deployCometExt(cometProxy: string, alias: string): Promise<string> {
      const currentExt = new Contract(
        await (await deploymentManager.hre.ethers.getContractAt('CometWithExtendedAssetList', cometProxy)).extensionDelegate(),
        ['function name() view returns (string)', 'function symbol() view returns (string)'],
        await deploymentManager.getSigner()
      );
      const cometExt = await deploymentManager.deploy(
        alias,
        'CometExt.sol',
        [{
          name32: utils.formatBytes32String(await currentExt.name()),
          symbol32: utils.formatBytes32String(await currentExt.symbol()),
        }],
        true
      );
      return cometExt.address;
    }

    return {
      configuratorIntermediate: configuratorIntermediate.address,
      configuratorImplementation: configuratorImplementation.address,
      assetListFactory: assetListFactory.address,
      cometFactory: cometFactory.address,
      cometAdmin: cometAdmin.address,
      usdcAssetList: await deployAssetList(comet.address, 'assetList'),
      usdsAssetList: await deployAssetList(USDS_COMET, 'usdsAssetList'),
      usdcCometExt: await deployCometExt(comet.address, 'comet:implementation:implementation'),
      usdsCometExt: await deployCometExt(USDS_COMET, 'usdsCometExt'),
    };
  },

  async enact(deploymentManager: DeploymentManager, _, artifact: Vars) {
    vars = artifact;
    const trace = deploymentManager.tracer();
    const ethers = deploymentManager.hre.ethers;
    const { governor, comet, configurator } = await deploymentManager.getContracts();

    // The alias may already name the new admin, so the current one is read from the Configurator proxy
    const oldCometAdmin = await ethers.getContractAt('CometProxyAdmin', await getProxyAdmin(deploymentManager, configurator.address));
    const newCometAdmin = await ethers.getContractAt('CometProxyAdmin', artifact.cometAdmin);
    const configuratorIntermediate = await ethers.getContractAt('ConfiguratorIntermediate', configurator.address);
    const newConfigurator = await ethers.getContractAt('Configurator', configurator.address);

    const mainnetActions = [
      // 1. Upgrade the Configurator to the intermediate implementation
      {
        contract: oldCometAdmin,
        signature: 'upgrade(address,address)',
        args: [configurator.address, artifact.configuratorIntermediate],
      },
      // 2. Move the asset configs of every Comet on this Configurator to the new storage, so the new implementation
      // reads all of them, including the markets this proposal does not upgrade yet
      {
        contract: configuratorIntermediate,
        signature: 'migrateAssetConfig(address[])',
        args: [[comet.address, USDS_COMET, USDT_COMET, WBTC_COMET, WETH_COMET, WSTETH_COMET]],
      },
      // 3. Upgrade the Configurator to the new implementation
      {
        contract: oldCometAdmin,
        signature: 'upgrade(address,address)',
        args: [configurator.address, artifact.configuratorImplementation],
      },
      // 4. Move the Configurator to the new CometProxyAdmin
      {
        contract: oldCometAdmin,
        signature: 'changeProxyAdmin(address,address)',
        args: [configurator.address, artifact.cometAdmin],
      },
      // 5. Move the USDC Comet to the new CometProxyAdmin
      {
        contract: oldCometAdmin,
        signature: 'changeProxyAdmin(address,address)',
        args: [comet.address, artifact.cometAdmin],
      },
      // 6. Move the USDS Comet to the new CometProxyAdmin
      {
        contract: oldCometAdmin,
        signature: 'changeProxyAdmin(address,address)',
        args: [USDS_COMET, artifact.cometAdmin],
      },
      // 7. Set the asset list factory for the USDC Comet
      {
        contract: newConfigurator,
        signature: 'setAssetListFactory(address,address)',
        args: [comet.address, artifact.assetListFactory],
      },
      // 8. Point the USDC Comet to its new asset list
      {
        contract: newConfigurator,
        signature: 'updateAssetList(address,address)',
        args: [comet.address, artifact.usdcAssetList],
      },
      // 9. Set the Comet factory for the USDC Comet
      {
        contract: newConfigurator,
        signature: 'setFactory(address,address)',
        args: [comet.address, artifact.cometFactory],
      },
      // 10. Set the new CometExt as the extension delegate of the USDC Comet
      {
        contract: newConfigurator,
        signature: 'setExtensionDelegate(address,address)',
        args: [comet.address, artifact.usdcCometExt],
      },
      // 11. Set the asset list factory for the USDS Comet
      {
        contract: newConfigurator,
        signature: 'setAssetListFactory(address,address)',
        args: [USDS_COMET, artifact.assetListFactory],
      },
      // 12. Point the USDS Comet to its new asset list
      {
        contract: newConfigurator,
        signature: 'updateAssetList(address,address)',
        args: [USDS_COMET, artifact.usdsAssetList],
      },
      // 13. Set the Comet factory for the USDS Comet
      {
        contract: newConfigurator,
        signature: 'setFactory(address,address)',
        args: [USDS_COMET, artifact.cometFactory],
      },
      // 14. Set the new CometExt as the extension delegate of the USDS Comet
      {
        contract: newConfigurator,
        signature: 'setExtensionDelegate(address,address)',
        args: [USDS_COMET, artifact.usdsCometExt],
      },
      // 15. Deploy and upgrade the USDC Comet to a new version
      {
        contract: newCometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, comet.address],
      },
      // 16. Deploy and upgrade the USDS Comet to a new version
      {
        contract: newCometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, USDS_COMET],
      },
    ];

    const description = `# Migrate the USDC and USDS Comets on Mainnet to the upgradeable asset list

## Proposal summary

This proposal upgrades the Mainnet Configurator to a version that keeps the asset configs of each market apart from the rest of its configuration, and moves the cUSDCv3 and cUSDSv3 markets to a new, upgradeable asset list. Factors and supply caps can then be changed on the asset list without deploying a new one, and the asset list code can be upgraded on its own.

The asset configs of both markets are copied as they are. The old asset list kept the collateral factors with 4 decimals and the supply caps in whole tokens, while the new one keeps the exact values stored in the Configurator.

The asset configs of the other markets that share this Configurator (cUSDTv3, cWBTCv3, cWETHv3, cwstETHv3) are moved to the new storage as well, so the Configurator keeps managing them. These markets keep running on their current Comet and asset list until a follow-up proposal moves them to the upgradeable asset list.

Further detailed information can be found on the corresponding [proposal pull request](<>) and [forum discussion](<>).

## Proposal actions

1 - 3. Upgrade the Configurator to an intermediate implementation, move the asset configs of cUSDCv3, cUSDSv3, cUSDTv3, cWBTCv3, cWETHv3 and cwstETHv3 to the new storage, and upgrade the Configurator to the new implementation.

4 - 6. Move the Configurator, cUSDCv3 and cUSDSv3 to a new CometProxyAdmin, owned by the Timelock.

7 - 14. Set the new asset list factory, the new asset list, the new Comet factory and a new CometExt as the extension delegate for cUSDCv3 and cUSDSv3.

15 - 16. Deploy and upgrade cUSDCv3 and cUSDSv3 to a new version.
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
    return true;
  },

  async verify(deploymentManager: DeploymentManager, _, preMigrationBlockNumber: number) {
    const ethers = deploymentManager.hre.ethers;
    const { comet, configurator, timelock } = await deploymentManager.getContracts();
    const newConfigurator = await ethers.getContractAt('Configurator', configurator.address);
    const newCometAdmin = await ethers.getContractAt('CometProxyAdmin', vars.cometAdmin);

    expect(await newCometAdmin.owner()).to.equal(timelock.address);
    expect(await getProxyAdmin(deploymentManager, configurator.address)).to.equal(vars.cometAdmin);
    expect(await newCometAdmin.getProxyImplementation(configurator.address)).to.equal(vars.configuratorImplementation);

    // The markets that are not upgraded keep their Comet, so the configs moved for them hold every asset it lists
    for (const cometProxy of [USDT_COMET, WBTC_COMET, WETH_COMET, WSTETH_COMET]) {
      const marketComet = await ethers.getContractAt('CometWithExtendedAssetList', cometProxy);
      const assetConfigs = await newConfigurator.getAssetConfigs(cometProxy);
      expect(assetConfigs.length).to.equal(await marketComet.numAssets());
      for (let i = 0; i < assetConfigs.length; i++) {
        expect(assetConfigs[i].asset).to.equal((await marketComet.getAssetInfo(i)).asset);
      }
    }

    for (const [cometProxy, assetList, cometExt] of [
      [comet.address, vars.usdcAssetList, vars.usdcCometExt],
      [USDS_COMET, vars.usdsAssetList, vars.usdsCometExt],
    ]) {
      const cometWithAssetList = await ethers.getContractAt('CometWithExtendedAssetList', cometProxy);

      expect(await getProxyAdmin(deploymentManager, cometProxy)).to.equal(vars.cometAdmin);
      expect(await getProxyAdmin(deploymentManager, assetList)).to.equal(vars.cometAdmin);
      expect(await newConfigurator.factory(cometProxy)).to.equal(vars.cometFactory);
      expect(await newConfigurator.cometAssetListFactories(cometProxy)).to.equal(vars.assetListFactory);
      expect((await newConfigurator.getConfiguration(cometProxy)).assetList).to.equal(assetList);
      expect(await cometWithAssetList.assetList()).to.equal(assetList);
      expect(await cometWithAssetList.extensionDelegate()).to.equal(cometExt);

      // The Configurator deploys nothing when the list was built from exactly its immutable configs
      expect((await newConfigurator.callStatic.deployAssetList(cometProxy)).newAssetListImpl).to.equal(constants.AddressZero);

      // Every asset reads as before the migration. The old list rounded the supply cap down to whole tokens, so the old
      // value is the new one rounded the same way
      const numAssets = await cometWithAssetList.numAssets();
      expect(numAssets).to.equal(await cometWithAssetList.numAssets({ blockTag: preMigrationBlockNumber }));
      for (let i = 0; i < numAssets; i++) {
        const assetInfosBefore = await cometWithAssetList.getAssetInfo(i, { blockTag: preMigrationBlockNumber });
        const assetInfos = await cometWithAssetList.getAssetInfo(i);

        expect(assetInfos.offset).to.equal(assetInfosBefore.offset);
        expect(assetInfos.asset).to.equal(assetInfosBefore.asset);
        expect(assetInfos.priceFeed).to.equal(assetInfosBefore.priceFeed);
        expect(assetInfos.scale).to.equal(assetInfosBefore.scale);
        expect(assetInfos.borrowCollateralFactor).to.equal(assetInfosBefore.borrowCollateralFactor);
        expect(assetInfos.liquidateCollateralFactor).to.equal(assetInfosBefore.liquidateCollateralFactor);
        expect(assetInfos.liquidationFactor).to.equal(assetInfosBefore.liquidationFactor);
        expect(assetInfos.supplyCap.div(assetInfos.scale).mul(assetInfos.scale)).to.equal(assetInfosBefore.supplyCap);
      }
    }
  },
});
