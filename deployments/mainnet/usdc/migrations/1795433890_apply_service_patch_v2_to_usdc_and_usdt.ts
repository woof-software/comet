import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal, ProposalAction } from '../../../../src/deploy';
import { getSignerForProposal } from '../../../../scenario/utils';
import { Contract } from 'ethers';

const USDC_COMET = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const USDT_COMET = '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840';

// Deployed by 1792676913_asset_list_v2_configurator_migration
const COMET_PROXY_ADMIN = '0xd4741C7a94aE8E5D3D26DAc7f6D32Cb33557e1a4';
const USDC_ASSET_LIST = '0x9F53fBc6282be1e5fA2fE2e9016f537EDBe9f403';
const USDT_ASSET_LIST = '0x64F20a9544992e29b61385b4E9B836dAd2C43c72';
const USDC_COMET_EXT = '0x954A0B49E4fe408aa216e9Dd8cFb97175A1fAD5C';
const USDT_COMET_EXT = '0x7A7Ff8bf6b8456dbba240aAA27B9ddB389076E2F';

export default migration('1795433890_apply_service_patch_v2_to_usdc_and_usdt', {
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
      // 1. Deploy and upgrade cUSDCv3 to the new implementation
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, USDC_COMET],
      },
      // 2. Deploy and upgrade cUSDTv3 to the new implementation
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, USDT_COMET],
      },
    ];

    const description = `# Apply the Service Patch V2 to cUSDCv3 and cUSDTv3 on Mainnet

## Proposal summary

Woof proposes applying the service patch V2 to the cUSDCv3 and cUSDTv3 markets on Mainnet. A [previous proposal](<>) moved all Mainnet markets to the new Configurator and CometProxyAdmin, and set the new asset list, factories and extension delegate for each market. This proposal deploys the new Comet implementation for cUSDCv3 and cUSDTv3 and upgrades them to it, so they start using the upgradeable asset list.

This proposal takes the governance steps recommended and necessary to update Compound III markets. Simulations have confirmed the market's readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Further detailed information can be found on the corresponding [proposal pull request](<>) and [forum discussion](<>).

### Audit

The Service Patch V2 update has been audited by Certora and full reports can be found here:

- [Certora Comet Service Patch V2 Audit](<>)


## Proposal Actions

The first action deploys and upgrades cUSDCv3 to the new implementation.

The second action deploys and upgrades cUSDTv3 to the new implementation.
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

    // cUSDCv3
    const usdcAssetList = await ethers.getContractAt('AssetList', USDC_ASSET_LIST);
    const usdcComet = await ethers.getContractAt('CometInterface', USDC_COMET);
    const usdcCometWithAssetList = new Contract(USDC_COMET, cometAbi, signer);

    expect(await cometAdmin.getProxyImplementation(USDC_COMET))
      .to.not.equal(await cometAdmin.getProxyImplementation(USDC_COMET, preMigrationBlockTag));
    expect(await usdcCometWithAssetList.assetList()).to.equal(USDC_ASSET_LIST);
    expect(await usdcCometWithAssetList.extensionDelegate()).to.equal(USDC_COMET_EXT);

    const usdcNumAssets = await usdcComet.numAssets();
    expect(usdcNumAssets).to.equal(await usdcAssetList.numAssets());
    expect(usdcNumAssets).to.equal(await usdcComet.numAssets(preMigrationBlockTag));
    for (let i = 0; i < usdcNumAssets; i++) {
      const before = await usdcComet.getAssetInfo(i, preMigrationBlockTag);
      const after = await usdcComet.getAssetInfo(i);
      expect(after.asset).to.equal(before.asset);
      expect(after.priceFeed).to.equal(before.priceFeed);
      expect(after.scale).to.equal(before.scale);
      expect(after.borrowCollateralFactor).to.equal(before.borrowCollateralFactor);
      expect(after.liquidateCollateralFactor).to.equal(before.liquidateCollateralFactor);
      expect(after.liquidationFactor).to.equal(before.liquidationFactor);
      // The old list rounded supply caps to whole tokens
      expect(after.supplyCap.div(after.scale).mul(after.scale)).to.equal(before.supplyCap);
    }

    // cUSDTv3
    const usdtAssetList = await ethers.getContractAt('AssetList', USDT_ASSET_LIST);
    const usdtComet = await ethers.getContractAt('CometInterface', USDT_COMET);
    const usdtCometWithAssetList = new Contract(USDT_COMET, cometAbi, signer);

    expect(await cometAdmin.getProxyImplementation(USDT_COMET))
      .to.not.equal(await cometAdmin.getProxyImplementation(USDT_COMET, preMigrationBlockTag));
    expect(await usdtCometWithAssetList.assetList()).to.equal(USDT_ASSET_LIST);
    expect(await usdtCometWithAssetList.extensionDelegate()).to.equal(USDT_COMET_EXT);

    const usdtNumAssets = await usdtComet.numAssets();
    expect(usdtNumAssets).to.equal(await usdtAssetList.numAssets());
    expect(usdtNumAssets).to.equal(await usdtComet.numAssets(preMigrationBlockTag));
    for (let i = 0; i < usdtNumAssets; i++) {
      const before = await usdtComet.getAssetInfo(i, preMigrationBlockTag);
      const after = await usdtComet.getAssetInfo(i);
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
