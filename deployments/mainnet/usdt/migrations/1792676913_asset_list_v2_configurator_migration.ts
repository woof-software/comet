import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal, ProposalAction } from '../../../../src/deploy';
import { getSignerForProposal } from '../../../../scenario/utils';
import { BigNumber, constants, Contract, utils } from 'ethers';

// EIP-1967 admin slot
const ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

// Deployed on Mainnet ahead of the proposal
const CONFIGURATOR_INTERMEDIATE = '0x7b95C9c686c498C9DFCe88beCe21DAEF3522A90B';
const CONFIGURATOR_IMPLEMENTATION = '0x46034B2D6DA09f45ff3d438b988d8637D8Db43B5';
const ASSET_LIST_FACTORY = '0xF887A6067481146E415a383D5aAa87dBFcFdF32f';
const COMET_FACTORY = '0x01B7e8ebf1E7a3e8E7cBc717cdb097DcA8D1028c';
const COMET_PROXY_ADMIN = '0xd4741C7a94aE8E5D3D26DAc7f6D32Cb33557e1a4';

// The USDC market lives in this deployment, so it keeps the default aliases
const MARKETS = [
  {
    comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    name: 'Compound USDC',
    symbol: 'cUSDCv3',
    assetList: '0x9F53fBc6282be1e5fA2fE2e9016f537EDBe9f403',
    cometExt: '0x954A0B49E4fe408aa216e9Dd8cFb97175A1fAD5C',
    assetListAlias: 'assetList',
    cometExtAlias: 'comet:implementation:implementation',
  },
  {
    comet: '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840',
    name: 'Compound USDT',
    symbol: 'cUSDTv3',
    assetList: '0x64F20a9544992e29b61385b4E9B836dAd2C43c72',
    cometExt: '0x7A7Ff8bf6b8456dbba240aAA27B9ddB389076E2F',
    assetListAlias: 'usdtAssetList',
    cometExtAlias: 'usdtCometExt',
  },
  {
    comet: '0x5D409e56D886231aDAf00c8775665AD0f9897b56',
    name: 'Compound USDS',
    symbol: 'cUSDSv3',
    assetList: '0x50A09C4c35a9E7497755EE900dCB0e9587b3a44f',
    cometExt: '0x06eeAf7b459971e8548324798FF909AE26Ac041a',
    assetListAlias: 'usdsAssetList',
    cometExtAlias: 'usdsCometExt',
  },
  {
    comet: '0xe85Dc543813B8c2CFEaAc371517b925a166a9293',
    name: 'Compound WBTC',
    symbol: 'cWBTCv3',
    assetList: '0xC6d2B14232d2453DcC0200092131bBC1Ffe38e68',
    cometExt: '0xE31F20F48b4E0CABC6811E26e110e71192D18eBC',
    assetListAlias: 'wbtcAssetList',
    cometExtAlias: 'wbtcCometExt',
  },
  {
    comet: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
    name: 'Compound WETH',
    symbol: 'cWETHv3',
    assetList: '0x644bfFBF154f86Cb50035531d2AEDE8b0E69d260',
    cometExt: '0xdb850632343A23098E6FA92364EEdd14479f9C1f',
    assetListAlias: 'wethAssetList',
    cometExtAlias: 'wethCometExt',
  },
  {
    comet: '0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3',
    name: 'Compound wstETH',
    symbol: 'cWstETHv3',
    assetList: '0x0f396D0373806f989D6E66fCD1b1daB0274846D5',
    cometExt: '0xbC1bA6307dbbb19937F728b154f69eD909bE8e06',
    assetListAlias: 'wstethAssetList',
    cometExtAlias: 'wstethCometExt',
  },
];

export default migration('1792676913_asset_list_v2_configurator_migration', {
  async prepare(deploymentManager: DeploymentManager) {
    const ethers = deploymentManager.hre.ethers;
    const { configurator } = await deploymentManager.getContracts();

    // Contracts are already deployed, so they are only registered under their aliases
    const register = async (alias: string, artifact: string, address: string) => {
      const contract = await ethers.getContractAt(artifact, address);
      await deploymentManager.putAlias(alias, contract);
      return contract;
    };

    // Configurator
    await register('configuratorIntermediate', 'ConfiguratorIntermediate', CONFIGURATOR_INTERMEDIATE);
    await register('configurator:implementation', 'Configurator', CONFIGURATOR_IMPLEMENTATION);

    // Factories
    await register('assetListFactory', 'AssetListFactory', ASSET_LIST_FACTORY);
    await register('cometFactory', 'CometFactoryWithExtendedAssetList', COMET_FACTORY);

    // New CometProxyAdmin, owned by the Timelock
    await register('cometAdmin', 'CometProxyAdmin', COMET_PROXY_ADMIN);

    // Asset lists and CometExts
    const assetLists: Record<string, string> = {};
    const cometExts: Record<string, string> = {};
    for (const market of MARKETS) {
      await register(market.assetListAlias, 'AssetList', market.assetList);
      await register(market.cometExtAlias, 'CometExt', market.cometExt);

      assetLists[market.comet] = market.assetList;
      cometExts[market.comet] = market.cometExt;
    }

    // Switch the alias to the new Configurator ABI for enact, verify and scenarios
    await deploymentManager.putAlias(
      'configurator',
      await ethers.getContractAt('Configurator', configurator.address)
    );

    return {
      configuratorIntermediate: CONFIGURATOR_INTERMEDIATE,
      configuratorImplementation: CONFIGURATOR_IMPLEMENTATION,
      assetListFactory: ASSET_LIST_FACTORY,
      cometFactory: COMET_FACTORY,
      cometAdmin: COMET_PROXY_ADMIN,
      assetLists,
      cometExts,
    };
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager,
    {
      configuratorIntermediate: configuratorIntermediateAddress,
      configuratorImplementation: configuratorImplementationAddress,
      assetListFactory: assetListFactoryAddress,
      cometFactory: cometFactoryAddress,
      cometAdmin: cometAdminAddress,
      assetLists,
      cometExts,
    }
  ) {
    const trace = deploymentManager.tracer();
    const ethers = deploymentManager.hre.ethers;
    const { governor, configurator } = await deploymentManager.getContracts();
    // Registers the proposer, so the follow-up proposal gets another signer in simulations
    const signer = await getSignerForProposal(deploymentManager, govDeploymentManager);

    // The cometAdmin alias already points to the new admin, so the current one is read from the proxy
    const oldCometAdmin = await ethers.getContractAt(
      'CometProxyAdmin',
      utils.getAddress(utils.hexDataSlice(await ethers.provider.getStorageAt(configurator.address, ADMIN_SLOT), 12))
    );

    const configuratorIntermediate = await ethers.getContractAt('ConfiguratorIntermediate', configurator.address);
    const newConfigurator = await ethers.getContractAt('Configurator', configurator.address);
    const oldConfigurator = await ethers.getContractAt('ConfiguratorV1', configurator.address);

    // The V2 Configuration is the V1 one without the asset configs, with the new extension delegate and asset list.
    // setConfiguration is the only way to set the first asset list, so it is built from the current V1 values
    const configurationFields = newConfigurator.interface.getFunction('setConfiguration').inputs[1].components
      .map(({ name }) => name);
    const configurations: Record<string, Record<string, unknown>> = {};
    for (const { comet } of MARKETS) {
      const configurationV1 = await oldConfigurator.getConfiguration(comet);
      configurations[comet] = {
        ...Object.fromEntries(configurationFields.map((field) => [field, configurationV1[field]])),
        extensionDelegate: cometExts[comet],
        assetList: assetLists[comet],
      };
    }

    const mainnetActions: ProposalAction[] = [
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
        args: [MARKETS.map(({ comet }) => comet)],
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
      // 5-10. Move every Comet to the new CometProxyAdmin
      ...MARKETS.map(({ comet }) => ({
        contract: oldCometAdmin,
        signature: 'changeProxyAdmin(address,address)',
        args: [comet, cometAdminAddress],
      })),
      // 11-16. Set the asset list factory of every Comet
      ...MARKETS.map(({ comet }) => ({
        contract: newConfigurator,
        signature: 'setAssetListFactory(address,address)',
        args: [comet, assetListFactoryAddress],
      })),
      // 17-22. Set the configuration of every Comet with its new asset list and CometExt
      ...MARKETS.map(({ comet }) => ({
        contract: newConfigurator,
        signature: 'setConfiguration(address,(address,address,address,address,address,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint64,uint104,uint104,uint104,address))',
        args: [comet, configurations[comet]],
      })),
      // 23-28. Set the Comet factory of every Comet
      ...MARKETS.map(({ comet }) => ({
        contract: newConfigurator,
        signature: 'setFactory(address,address)',
        args: [comet, cometFactoryAddress],
      })),
    ];

    const description = `# Prepare Mainnet Comets for the Service Patch V2

## Proposal summary

WOOF! proposes preparing all Mainnet Compound III markets (cUSDCv3, cUSDSv3, cUSDTv3, cWBTCv3, cWETHv3 and cWstETHv3) for the service patch V2, which moves them to a new, upgradeable asset list, together with the Mainnet Configurator they share.

The new Configurator keeps the asset configs of each market apart from the rest of its configuration. With the upgradeable asset list:

- Collateral factors and supply caps are changed on the asset list directly, without deploying a new asset list and Comet.
- The asset list code can be upgraded on its own, without upgrading Comet.
- Collateral factors and supply caps are kept with their exact values. The old asset list kept collateral factors with 4 decimals and supply caps in whole tokens.

The asset configs of every market are copied as they are. This proposal upgrades the Configurator, moves the Configurator and all Comets to a new CometProxyAdmin, and sets the new asset list, factories and extension delegate for each market. The markets keep running on their current Comet implementation until a follow-up proposal deploys and upgrades them.

This proposal takes the governance steps recommended and necessary to update Compound III markets. Simulations have confirmed the market's readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Further detailed information can be found on the corresponding [proposal pull request](https://github.com/Compound-Foundation/comet/pull/37) and [forum discussion](<>).

### Audit

The Service Patch V2 update has been audited by Certora and full reports can be found here:

- [Certora Comet Service Patch V2 Audit](<>)


## Proposal Actions

The first action upgrades the Configurator to an intermediate implementation.

The second action moves the asset configs of cUSDCv3, cUSDSv3, cUSDTv3, cWBTCv3, cWETHv3 and cWstETHv3 to the new storage of the Configurator.

The third action upgrades the Configurator to the new implementation.

The fourth action moves the Configurator to a new CometProxyAdmin, owned by the Timelock.

The 5th - 10th actions move cUSDCv3, cUSDSv3, cUSDTv3, cWBTCv3, cWETHv3 and cWstETHv3 to the new CometProxyAdmin.

The 11th - 16th actions set the asset list factory for cUSDCv3, cUSDSv3, cUSDTv3, cWBTCv3, cWETHv3 and cWstETHv3 to the newly deployed factory.

The 17th - 22nd actions set the configurations of cUSDCv3, cUSDSv3, cUSDTv3, cWBTCv3, cWETHv3 and cWstETHv3 with the newly deployed asset lists and extension delegates. The other configuration values are kept as they are.

The 23rd - 28th actions set the factory for cUSDCv3, cUSDSv3, cUSDTv3, cWBTCv3, cWETHv3 and cWstETHv3 to the newly deployed factory.
`;
    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.connect(signer).propose(...(await proposal(mainnetActions, description)))
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
    const contracts = await deploymentManager.getContracts();
    const {
      configurator,
      timelock,
      cometAdmin,
      'configurator:implementation': configuratorImplementation,
      assetListFactory,
      cometFactory,
    } = contracts;
    const signer = await deploymentManager.getSigner();
    const preMigrationBlockTag = { blockTag: preMigrationBlockNumber };

    const cometExtAbi = [
      'function name() external view returns (string)',
      'function symbol() external view returns (string)',
    ];

    async function getProxyAdmin(proxy: string, blockNumber?: number): Promise<string> {
      const admin = await ethers.provider.getStorageAt(proxy, ADMIN_SLOT, blockNumber);
      return utils.getAddress(utils.hexDataSlice(admin, 12));
    }

    // Pre-migration state is read with the V1 ABI
    const oldConfigurator = await ethers.getContractAt('ConfiguratorV1', configurator.address);
    const newConfigurator = await ethers.getContractAt('Configurator', configurator.address);

    // Configurator
    expect(await cometAdmin.owner()).to.equal(timelock.address);
    expect(await getProxyAdmin(configurator.address)).to.equal(cometAdmin.address);
    expect(await cometAdmin.getProxyImplementation(configurator.address)).to.equal(configuratorImplementation.address);
    expect(await newConfigurator.governor()).to.equal(await oldConfigurator.governor(preMigrationBlockTag));
    expect(await assetListFactory.configurator()).to.equal(configurator.address);

    for (const market of MARKETS) {
      const assetList = await ethers.getContractAt('AssetList', contracts[market.assetListAlias].address);
      const cometExt = new Contract(contracts[market.cometExtAlias].address, cometExtAbi, signer);
      // Not upgraded yet, so the Comet still runs its current implementation
      const comet = await ethers.getContractAt('CometInterface', market.comet);

      // Proxy admins
      expect(await getProxyAdmin(market.comet)).to.equal(cometAdmin.address);
      expect(await getProxyAdmin(assetList.address)).to.equal(cometAdmin.address);

      // Configurator state
      const configurationBefore = await oldConfigurator.getConfiguration(market.comet, preMigrationBlockTag);
      const configuration = await newConfigurator.getConfiguration(market.comet);

      expect(await newConfigurator.factory(market.comet)).to.equal(cometFactory.address);
      expect(await newConfigurator.cometAssetListFactories(market.comet)).to.equal(assetListFactory.address);
      expect(configuration.assetList).to.equal(assetList.address);
      expect(configuration.extensionDelegate).to.equal(cometExt.address);

      // The first 20 fields match between V1 and V2; only the extension delegate (field 4) changes
      expect(configuration.slice(0, 4)).to.deep.equal(configurationBefore.slice(0, 4));
      expect(configuration.slice(5, 20)).to.deep.equal(configurationBefore.slice(5, 20));

      // No asset list redeploy needed
      expect((await newConfigurator.callStatic.deployAssetList(market.comet)).newAssetListImpl).to.equal(constants.AddressZero);

      // CometExt
      expect(await cometExt.name()).to.equal(market.name);
      expect(await cometExt.symbol()).to.equal(market.symbol);
      expect(await cometExt.name()).to.equal(await comet.name());
      expect(await cometExt.symbol()).to.equal(await comet.symbol());

      // Asset list matches the current Comet and the Configurator. The old list rounded supply caps to whole tokens
      expect(await assetList.configurator()).to.equal(configurator.address);
      const assetConfigs = await newConfigurator.getAssetConfigs(market.comet);
      const numAssets = await assetList.numAssets();
      expect(numAssets).to.equal(assetConfigs.length);
      expect(numAssets).to.equal(configurationBefore.assetConfigs.length);
      expect(numAssets).to.equal(await comet.numAssets());
      for (let i = 0; i < numAssets; i++) {
        const cometAssetInfo = await comet.getAssetInfo(i);
        const assetListInfo = await assetList.getAssetInfo(i);

        // Migrated asset configs match the V1 ones; V2 has no decimals, the scale comes from the token
        expect(assetConfigs[i].asset).to.equal(configurationBefore.assetConfigs[i].asset);
        expect(assetConfigs[i].priceFeed).to.equal(configurationBefore.assetConfigs[i].priceFeed);
        expect(assetConfigs[i].borrowCollateralFactor).to.equal(configurationBefore.assetConfigs[i].borrowCollateralFactor);
        expect(assetConfigs[i].liquidateCollateralFactor).to.equal(configurationBefore.assetConfigs[i].liquidateCollateralFactor);
        expect(assetConfigs[i].liquidationFactor).to.equal(configurationBefore.assetConfigs[i].liquidationFactor);
        expect(assetConfigs[i].supplyCap).to.equal(configurationBefore.assetConfigs[i].supplyCap);

        expect(assetListInfo.offset).to.equal(cometAssetInfo.offset);
        expect(assetListInfo.asset).to.equal(cometAssetInfo.asset);
        expect(assetListInfo.priceFeed).to.equal(cometAssetInfo.priceFeed);
        expect(assetListInfo.scale).to.equal(cometAssetInfo.scale);
        expect(assetListInfo.borrowCollateralFactor).to.equal(cometAssetInfo.borrowCollateralFactor);
        expect(assetListInfo.liquidateCollateralFactor).to.equal(cometAssetInfo.liquidateCollateralFactor);
        expect(assetListInfo.liquidationFactor).to.equal(cometAssetInfo.liquidationFactor);
        expect(assetListInfo.supplyCap.div(assetListInfo.scale).mul(assetListInfo.scale)).to.equal(cometAssetInfo.supplyCap);

        expect(assetListInfo.asset).to.equal(assetConfigs[i].asset);
        expect(assetListInfo.priceFeed).to.equal(assetConfigs[i].priceFeed);
        expect(assetListInfo.scale).to.equal(BigNumber.from(10).pow(configurationBefore.assetConfigs[i].decimals));
        expect(assetListInfo.borrowCollateralFactor).to.equal(assetConfigs[i].borrowCollateralFactor);
        expect(assetListInfo.liquidateCollateralFactor).to.equal(assetConfigs[i].liquidateCollateralFactor);
        expect(assetListInfo.liquidationFactor).to.equal(assetConfigs[i].liquidationFactor);
        expect(assetListInfo.supplyCap).to.equal(assetConfigs[i].supplyCap);
      }
    }
  },
});
