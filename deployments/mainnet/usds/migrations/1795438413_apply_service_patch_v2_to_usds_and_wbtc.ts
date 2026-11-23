import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal, ProposalAction } from '../../../../src/deploy';
import { getSignerForProposal } from '../../../../scenario/utils';
import { Contract } from 'ethers';

const USDS_COMET = '0x5D409e56D886231aDAf00c8775665AD0f9897b56';
const WBTC_COMET = '0xe85Dc543813B8c2CFEaAc371517b925a166a9293';

// Deployed by 1792676913_asset_list_v2_configurator_migration
const COMET_PROXY_ADMIN = '0xd4741C7a94aE8E5D3D26DAc7f6D32Cb33557e1a4';
const USDS_ASSET_LIST = '0x50A09C4c35a9E7497755EE900dCB0e9587b3a44f';
const WBTC_ASSET_LIST = '0xC6d2B14232d2453DcC0200092131bBC1Ffe38e68';
const USDS_COMET_EXT = '0x06eeAf7b459971e8548324798FF909AE26Ac041a';
const WBTC_COMET_EXT = '0xE31F20F48b4E0CABC6811E26e110e71192D18eBC';

export default migration('1795438413_apply_service_patch_v2_to_usds_and_wbtc', {
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
      // 1. Deploy and upgrade cUSDSv3 to the new implementation
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, USDS_COMET],
      },
      // 2. Deploy and upgrade cWBTCv3 to the new implementation
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, WBTC_COMET],
      },
    ];

    const description = `# Apply the Service Patch V2 to cUSDSv3 and cWBTCv3 on Mainnet

## Proposal summary

Woof proposes applying the service patch V2 to the cUSDSv3 and cWBTCv3 markets on Mainnet. A [previous proposal](<>) moved all Mainnet markets to the new Configurator and CometProxyAdmin, and set the new asset list, factories and extension delegate for each market. This proposal deploys the new Comet implementation for cUSDSv3 and cWBTCv3 and upgrades them to it, so they start using the upgradeable asset list.

This proposal takes the governance steps recommended and necessary to update Compound III markets. Simulations have confirmed the market's readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Further detailed information can be found on the corresponding [proposal pull request](<>) and [forum discussion](<>).

### Audit

The Service Patch V2 update has been audited by Certora and full reports can be found here:

- [Certora Comet Service Patch V2 Audit](<>)


## Proposal Actions

The first action deploys and upgrades cUSDSv3 to the new implementation.

The second action deploys and upgrades cWBTCv3 to the new implementation.
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

    // cUSDSv3
    const usdsAssetList = await ethers.getContractAt('AssetList', USDS_ASSET_LIST);
    const usdsComet = await ethers.getContractAt('CometInterface', USDS_COMET);
    const usdsCometWithAssetList = new Contract(USDS_COMET, cometAbi, signer);

    expect(await cometAdmin.getProxyImplementation(USDS_COMET))
      .to.not.equal(await cometAdmin.getProxyImplementation(USDS_COMET, preMigrationBlockTag));
    expect(await usdsCometWithAssetList.assetList()).to.equal(USDS_ASSET_LIST);
    expect(await usdsCometWithAssetList.extensionDelegate()).to.equal(USDS_COMET_EXT);

    const usdsNumAssets = await usdsComet.numAssets();
    expect(usdsNumAssets).to.equal(await usdsAssetList.numAssets());
    expect(usdsNumAssets).to.equal(await usdsComet.numAssets(preMigrationBlockTag));
    for (let i = 0; i < usdsNumAssets; i++) {
      const before = await usdsComet.getAssetInfo(i, preMigrationBlockTag);
      const after = await usdsComet.getAssetInfo(i);
      expect(after.asset).to.equal(before.asset);
      expect(after.priceFeed).to.equal(before.priceFeed);
      expect(after.scale).to.equal(before.scale);
      expect(after.borrowCollateralFactor).to.equal(before.borrowCollateralFactor);
      expect(after.liquidateCollateralFactor).to.equal(before.liquidateCollateralFactor);
      expect(after.liquidationFactor).to.equal(before.liquidationFactor);
      // The old list rounded supply caps to whole tokens
      expect(after.supplyCap.div(after.scale).mul(after.scale)).to.equal(before.supplyCap);
    }

    // cWBTCv3
    const wbtcAssetList = await ethers.getContractAt('AssetList', WBTC_ASSET_LIST);
    const wbtcComet = await ethers.getContractAt('CometInterface', WBTC_COMET);
    const wbtcCometWithAssetList = new Contract(WBTC_COMET, cometAbi, signer);

    expect(await cometAdmin.getProxyImplementation(WBTC_COMET))
      .to.not.equal(await cometAdmin.getProxyImplementation(WBTC_COMET, preMigrationBlockTag));
    expect(await wbtcCometWithAssetList.assetList()).to.equal(WBTC_ASSET_LIST);
    expect(await wbtcCometWithAssetList.extensionDelegate()).to.equal(WBTC_COMET_EXT);

    const wbtcNumAssets = await wbtcComet.numAssets();
    expect(wbtcNumAssets).to.equal(await wbtcAssetList.numAssets());
    expect(wbtcNumAssets).to.equal(await wbtcComet.numAssets(preMigrationBlockTag));
    for (let i = 0; i < wbtcNumAssets; i++) {
      const before = await wbtcComet.getAssetInfo(i, preMigrationBlockTag);
      const after = await wbtcComet.getAssetInfo(i);
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
