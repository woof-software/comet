import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, proposal } from '../../../../src/deploy';
import { ethers, Contract, utils } from 'ethers';
import { MAX_ASSETS } from '../../../../scenario/utils';
import { expect } from 'chai';

let newCometExtAddress: string;

export default migration('1765272632_my_migration', {
  async prepare(deploymentManager: DeploymentManager) {
    const assetListFactory = await deploymentManager.deploy(
      'assetListFactory',
      'AssetListFactory.sol',
      []
    );

    const cometFactoryWithExtendedAssetList = await deploymentManager.deploy(
      'cometFactoryWithExtendedAssetList',
      'CometFactoryWithExtendedAssetList.sol',
      []
    );

    const { comet } = await deploymentManager.getContracts();

    const extensionDelegate = new Contract(
      await comet.extensionDelegate(),
      [
        'function name() external view returns (string)',
        'function symbol() external view returns (string)',
      ],
      await deploymentManager.getSigner()
    );

    const name = await extensionDelegate.name();
    const symbol = await extensionDelegate.symbol();

    const newCometExt = await deploymentManager.deploy(
      'CometExtAssetList',
      'CometExtAssetList.sol',
      [
        {
          name32: ethers.utils.formatBytes32String(name),
          symbol32: ethers.utils.formatBytes32String(symbol),
        },
        assetListFactory.address,
      ],
      true
    );

    return {
      cometFactoryWithExtendedAssetList: cometFactoryWithExtendedAssetList.address,
      newCometExt: newCometExt.address,
    };
  },

  async enact(
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager,
    { cometFactoryWithExtendedAssetList, newCometExt }
  ) {
    const trace = deploymentManager.tracer();
    const { comet, cometAdmin, configurator, bridgeReceiver } =
      await deploymentManager.getContracts();
    const { mantleL1CrossDomainMessenger, governor } =
      await govDeploymentManager.getContracts();

    newCometExtAddress = newCometExt;

    const setFactoryCalldata = await calldata(
      configurator.populateTransaction.setFactory(
        comet.address,
        cometFactoryWithExtendedAssetList
      )
    );

    const setExtensionDelegateCalldata = await calldata(
      configurator.populateTransaction.setExtensionDelegate(
        comet.address,
        newCometExt
      )
    );

    const deployAndUpgradeToCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [configurator.address, comet.address]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [configurator.address, configurator.address, cometAdmin.address],
        [0, 0, 0],
        [
          'setFactory(address,address)',
          'setExtensionDelegate(address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [setFactoryCalldata, setExtensionDelegateCalldata, deployAndUpgradeToCalldata],
      ]
    );

    const actions = [
      {
        contract: mantleL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [bridgeReceiver.address, l2ProposalData, 2_500_000],
      },
    ];

    const description =
      '# Update USDe Comet on Mantle to support up to 24 collaterals\n\n' +
      '## Proposal summary\n\n' +
      'Upgrade Mantle cUSDev3 Comet to the CometWithExtendedAssetList implementation and new extension delegate, enabling up to 24 collaterals through the asset list factory.\n\n' +
      '## Proposal Actions\n\n' +
      '1) Set factory to CometFactoryWithExtendedAssetList, set extension delegate to CometExtAssetList, then deploy and upgrade the Comet implementation on Mantle via the bridge.';

    const txn = await deploymentManager.retry(async () =>
      trace(await governor.propose(...(await proposal(actions, description))))
    );

    const event = txn.events.find((e) => e.event === 'ProposalCreated');
    const [proposalId] = event.args;
    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return true;
  },

  async verify(deploymentManager: DeploymentManager) {
    const { comet } = await deploymentManager.getContracts();

    const cometNew = new Contract(
      comet.address,
      ['function assetList() external view returns (address)', 'function maxAssets() external view returns (uint8)'],
      await deploymentManager.getSigner()
    );

    const assetListAddress = await cometNew.assetList();
    const maxAssets = await cometNew.maxAssets();

    expect(assetListAddress).to.not.eq(ethers.constants.AddressZero);
    expect(maxAssets).to.eq(MAX_ASSETS);
    expect(await comet.extensionDelegate()).to.eq(newCometExtAddress);
  },
});
