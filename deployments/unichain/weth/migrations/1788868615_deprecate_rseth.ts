import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, exp, proposal } from '../../../../src/deploy';
import { utils } from 'ethers';

let newRsEthPriceFeed: string;

export default migration('1788868615_deprecate_rseth', {
  async prepare(deploymentManager: DeploymentManager) {
    const _rsEthMinPriceFeed = await deploymentManager.deploy(
      'rsETH:priceFeed',
      'pricefeeds/ConstantPriceFeed.sol',
      [
        8, // decimals
        1  // constantPrice - smallest acceptable price
      ],
      true
    );

    return {
      rsEthMinPriceFeedAddress: _rsEthMinPriceFeed.address
    };
  },

  enact: async (deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager, {
    rsEthMinPriceFeedAddress
  }) => {
    newRsEthPriceFeed = rsEthMinPriceFeedAddress;

    const trace = deploymentManager.tracer();

    const {
      configurator,
      comet,
      bridgeReceiver,
      cometAdmin,
      rsETH
    } = await deploymentManager.getContracts();

    const {
      governor,
      unichainL1CrossDomainMessenger
    } = await govDeploymentManager.getContracts();

    const newAssetConfig = {
      asset: rsETH.address,
      priceFeed: rsEthMinPriceFeedAddress,
      decimals: await rsETH.decimals(),
      borrowCollateralFactor: 0,
      liquidateCollateralFactor: exp(0.0001, 18),
      liquidationFactor: exp(1, 18),
      supplyCap: 0,
    };

    const updateRsEthAssetCalldata = await calldata(
      configurator.populateTransaction.updateAsset(comet.address, newAssetConfig)
    );

    const deployAndUpgradeToCalldata = await calldata(
      cometAdmin.populateTransaction.deployAndUpgradeTo(
        configurator.address,
        comet.address
      )
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [configurator.address, cometAdmin.address],
        [0, 0],
        [
          'updateAsset(address,(address,address,uint8,uint64,uint64,uint64,uint128))',
          'deployAndUpgradeTo(address,address)',
        ],
        [updateRsEthAssetCalldata, deployAndUpgradeToCalldata],
      ]
    );

    const mainnetActions = [
      // 1. Update rsETH config to a deprecated state and deployAndUpgradeTo new Comet on Unichain.
      {
        contract: unichainL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [bridgeReceiver.address, l2ProposalData, 3_000_000],
      },
    ];

    const description = `# Deprecate rsETH from cWETHv3 on Unichain

## Proposal summary

Woof proposes to deprecate rsETH from cWETHv3 on Unichain network, due to its Kelp oracle deprecation.

In order to achieve this, rsETH's price feed will be updated to a new one, which will return the smallest acceptable price - 0.00000001 (1e-8), the borrow collateral factor will be set to 0, the liquidate collateral factor will be lowered to 0.0001, the liquidation factor will be set to 1, and the supply cap will be set to 0 to prevent further deposits.

This proposal takes the governance steps recommended and necessary to update a Compound III WETH market on Unichain. Simulations have confirmed the market's readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Further detailed information can be found on the corresponding [proposal pull request](https://github.com/compound-finance/comet/pull/22).


## Proposal Actions

The first proposal action updates rsETH config to a deprecated state and deploys and upgrades Comet to a new version. This sends the encoded 'updateAsset' and 'deployAndUpgradeTo' calls across the bridge to the governance receiver on Unichain.`;

    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      ), 0, 300_000
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

  async verify(deploymentManager: DeploymentManager) {
    const {
      comet,
      configurator,
      rsETH
    } = await deploymentManager.getContracts();

    expect(await comet.getPrice(newRsEthPriceFeed)).to.be.equal(1);

    // 1. Compare proposed asset config with Comet asset info
    const rsEthAssetInfo = await comet.getAssetInfoByAddress(rsETH.address);
    const rsEthAssetIndex = rsEthAssetInfo.offset;
    expect(0).to.be.equal(rsEthAssetInfo.supplyCap);
    expect(newRsEthPriceFeed).to.be.equal(rsEthAssetInfo.priceFeed);
    expect(1).to.be.equal(await comet.getPrice(rsEthAssetInfo.priceFeed));
    expect(0).to.be.equal(rsEthAssetInfo.borrowCollateralFactor);
    expect(exp(0.0001, 18)).to.be.equal(rsEthAssetInfo.liquidateCollateralFactor);
    expect(exp(1, 18)).to.be.equal(rsEthAssetInfo.liquidationFactor);

    // 2. Compare proposed asset config with Configurator asset config
    const configuratorRsEthAssetConfig = (await configurator.getConfiguration(comet.address)).assetConfigs[rsEthAssetIndex];
    expect(0).to.be.equal(configuratorRsEthAssetConfig.supplyCap);
    expect(newRsEthPriceFeed).to.be.equal(configuratorRsEthAssetConfig.priceFeed);
    expect(1).to.be.equal(await comet.getPrice(configuratorRsEthAssetConfig.priceFeed));
    expect(0).to.be.equal(configuratorRsEthAssetConfig.borrowCollateralFactor);
    expect(exp(0.0001, 18)).to.be.equal(configuratorRsEthAssetConfig.liquidateCollateralFactor);
    expect(exp(1, 18)).to.be.equal(configuratorRsEthAssetConfig.liquidationFactor);
  },
});
