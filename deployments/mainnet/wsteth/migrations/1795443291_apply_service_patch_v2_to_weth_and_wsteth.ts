import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal, ProposalAction } from '../../../../src/deploy';
import { getSignerForProposal } from '../../../../scenario/utils';
import { Contract } from 'ethers';

const WETH_COMET = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';
const WSTETH_COMET = '0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3';

// Deployed by 1792676913_asset_list_v2_configurator_migration
const COMET_PROXY_ADMIN = '0xd4741C7a94aE8E5D3D26DAc7f6D32Cb33557e1a4';
const WETH_ASSET_LIST = '0x644bfFBF154f86Cb50035531d2AEDE8b0E69d260';
const WSTETH_ASSET_LIST = '0x0f396D0373806f989D6E66fCD1b1daB0274846D5';
const WETH_COMET_EXT = '0xdb850632343A23098E6FA92364EEdd14479f9C1f';
const WSTETH_COMET_EXT = '0xbC1bA6307dbbb19937F728b154f69eD909bE8e06';

export default migration('1795443291_apply_service_patch_v2_to_weth_and_wsteth', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {
    const trace = deploymentManager.tracer();
    const { governor, configurator } = await deploymentManager.getContracts();
    // The previous proposal is still live in simulations, so it is proposed by another signer
    const signer = await getSignerForProposal(deploymentManager, govDeploymentManager);
    const cometAdmin = await deploymentManager.hre.ethers.getContractAt('CometProxyAdmin', COMET_PROXY_ADMIN);

    const mainnetActions: ProposalAction[] = [
      // 1. Deploy and upgrade cWETHv3 to the new implementation
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, WETH_COMET],
      },
      // 2. Deploy and upgrade cWstETHv3 to the new implementation
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, WSTETH_COMET],
      },
    ];

    const description = `# Apply the Service Patch V2 to cWETHv3 and cWstETHv3 on Mainnet

## Proposal summary

Woof proposes applying the service patch V2 to the cWETHv3 and cWstETHv3 markets on Mainnet. A [previous proposal](<>) moved all Mainnet markets to the new Configurator and CometProxyAdmin, and set the new asset list, factories and extension delegate for each market. This proposal deploys the new Comet implementation for cWETHv3 and cWstETHv3 and upgrades them to it, so they start using the upgradeable asset list.

This proposal takes the governance steps recommended and necessary to update Compound III markets. Simulations have confirmed the market's readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Further detailed information can be found on the corresponding [proposal pull request](<>) and [forum discussion](<>).

### Audit

The Service Patch V2 update has been audited by Certora and full reports can be found here:

- [Certora Comet Service Patch V2 Audit](<>)


## Proposal Actions

The first action deploys and upgrades cWETHv3 to the new implementation.

The second action deploys and upgrades cWstETHv3 to the new implementation.
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
    const cometAdmin = await ethers.getContractAt('CometProxyAdmin', COMET_PROXY_ADMIN);
    const signer = await deploymentManager.getSigner();
    const preMigrationBlockTag = { blockTag: preMigrationBlockNumber };

    const cometAbi = [
      'function assetList() external view returns (address)',
      'function extensionDelegate() external view returns (address)',
    ];

    // cWETHv3
    const wethAssetList = await ethers.getContractAt('AssetList', WETH_ASSET_LIST);
    const wethComet = await ethers.getContractAt('CometInterface', WETH_COMET);
    const wethCometWithAssetList = new Contract(WETH_COMET, cometAbi, signer);

    expect(await cometAdmin.getProxyImplementation(WETH_COMET))
      .to.not.equal(await cometAdmin.getProxyImplementation(WETH_COMET, preMigrationBlockTag));
    expect(await wethCometWithAssetList.assetList()).to.equal(WETH_ASSET_LIST);
    expect(await wethCometWithAssetList.extensionDelegate()).to.equal(WETH_COMET_EXT);

    const wethNumAssets = await wethComet.numAssets();
    expect(wethNumAssets).to.equal(await wethAssetList.numAssets());
    expect(wethNumAssets).to.equal(await wethComet.numAssets(preMigrationBlockTag));
    for (let i = 0; i < wethNumAssets; i++) {
      const before = await wethComet.getAssetInfo(i, preMigrationBlockTag);
      const after = await wethComet.getAssetInfo(i);
      expect(after.asset).to.equal(before.asset);
      expect(after.priceFeed).to.equal(before.priceFeed);
      expect(after.scale).to.equal(before.scale);
      expect(after.borrowCollateralFactor).to.equal(before.borrowCollateralFactor);
      expect(after.liquidateCollateralFactor).to.equal(before.liquidateCollateralFactor);
      expect(after.liquidationFactor).to.equal(before.liquidationFactor);
      // The old list rounded supply caps to whole tokens
      expect(after.supplyCap.div(after.scale).mul(after.scale)).to.equal(before.supplyCap);
    }

    // cWstETHv3
    const wstethAssetList = await ethers.getContractAt('AssetList', WSTETH_ASSET_LIST);
    const wstethComet = await ethers.getContractAt('CometInterface', WSTETH_COMET);
    const wstethCometWithAssetList = new Contract(WSTETH_COMET, cometAbi, signer);

    expect(await cometAdmin.getProxyImplementation(WSTETH_COMET))
      .to.not.equal(await cometAdmin.getProxyImplementation(WSTETH_COMET, preMigrationBlockTag));
    expect(await wstethCometWithAssetList.assetList()).to.equal(WSTETH_ASSET_LIST);
    expect(await wstethCometWithAssetList.extensionDelegate()).to.equal(WSTETH_COMET_EXT);

    const wstethNumAssets = await wstethComet.numAssets();
    expect(wstethNumAssets).to.equal(await wstethAssetList.numAssets());
    expect(wstethNumAssets).to.equal(await wstethComet.numAssets(preMigrationBlockTag));
    for (let i = 0; i < wstethNumAssets; i++) {
      const before = await wstethComet.getAssetInfo(i, preMigrationBlockTag);
      const after = await wstethComet.getAssetInfo(i);
      expect(after.asset).to.equal(before.asset);
      expect(after.priceFeed).to.equal(before.priceFeed);
      expect(after.scale).to.equal(before.scale);
      expect(after.borrowCollateralFactor).to.equal(before.borrowCollateralFactor);
      expect(after.liquidateCollateralFactor).to.equal(before.liquidateCollateralFactor);
      expect(after.liquidationFactor).to.equal(before.liquidationFactor);
      // The old list rounded supply caps to whole tokens
      expect(after.supplyCap.div(after.scale).mul(after.scale)).to.equal(before.supplyCap);
    }
  },
});
