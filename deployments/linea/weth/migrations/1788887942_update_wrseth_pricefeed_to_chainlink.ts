import { expect } from 'chai';
import { utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, exp, proposal } from '../../../../src/deploy';

const WRSETH_ETH_PRICE_FEED_ADDRESS = '0xEEDF0B095B5dfe75F3881Cb26c19DA209A27463a';

let newWrsEthPriceFeed: string;
let oldWrsEthPriceFeed: string;

export default migration('1788887942_update_wrseth_pricefeed_to_chainlink', {
  async prepare(deploymentManager: DeploymentManager) {
    const _wrsEthPriceFeed = await deploymentManager.deploy(
      'wrsETH:priceFeed',
      'pricefeeds/ScalingPriceFeedWithCustomDescription.sol',
      [
        WRSETH_ETH_PRICE_FEED_ADDRESS, // wrsETH / ETH price feed
        8,                             // decimals
        'wrsETH / ETH price feed'      // description
      ],
      true
    );

    return {
      wrsEthPriceFeedAddress: _wrsEthPriceFeed.address
    };
  },

  enact: async (deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager, {
    wrsEthPriceFeedAddress
  }) => {
    newWrsEthPriceFeed = wrsEthPriceFeedAddress;

    const trace = deploymentManager.tracer();

    const {
      configurator,
      comet,
      bridgeReceiver,
      cometAdmin,
      wrsETH
    } = await deploymentManager.getContracts();

    const {
      governor,
      lineaMessageService
    } = await govDeploymentManager.getContracts();

    [,, oldWrsEthPriceFeed] = await comet.getAssetInfoByAddress(wrsETH.address);

    const updateWrsEthPriceFeedCalldata = await calldata(
      configurator.populateTransaction.updateAssetPriceFeed(
        comet.address,
        wrsETH.address,
        wrsEthPriceFeedAddress
      )
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
          'updateAssetPriceFeed(address,address,address)',
          'deployAndUpgradeTo(address,address)',
        ],
        [updateWrsEthPriceFeedCalldata, deployAndUpgradeToCalldata],
      ]
    );

    const mainnetActions = [
      // 1. Update wrsETH's price feed and deployAndUpgradeTo new Comet on Linea.
      {
        contract: lineaMessageService,
        signature: 'sendMessage(address,uint256,bytes)',
        args: [bridgeReceiver.address, 0, l2ProposalData],
      },
    ];

    const description = `# Update wrsETH Price Feed in cWETHv3 on Linea

## Proposal summary

Woof proposes to update wrsETH's price feed on cWETHv3 on the Linea network from the deprecated Kelp oracle to a new Chainlink price feed.

In order to achieve this, wrsETH's price feed will be updated to a new price feed contract with underlying Chainlink ([oracle](https://lineascan.build/address/0xEEDF0B095B5dfe75F3881Cb26c19DA209A27463a#readContract)).

This proposal takes the governance steps recommended and necessary to update a Compound III WETH market on Linea. Simulations have confirmed the market's readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Further detailed information can be found on the corresponding [proposal pull request](https://github.com/compound-finance/comet/pull/22).


## Proposal Actions

The first proposal action updates wrsETH's price feed and deploys and upgrades Comet to a new version. This sends the encoded 'updateAssetPriceFeed' and 'deployAndUpgradeTo' calls across the bridge to the governance receiver on Linea.`;

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
      wrsETH
    } = await deploymentManager.getContracts();

    // 1. Compare proposed price feed with Comet asset info
    const wrsEthAssetInfo = await comet.getAssetInfoByAddress(wrsETH.address);
    const wrsEthAssetIndex = wrsEthAssetInfo.offset;
    expect(newWrsEthPriceFeed).to.be.equal(wrsEthAssetInfo.priceFeed);

    // 2. Compare proposed price feed with Configurator asset config
    const configuratorWrsEthAssetConfig = (await configurator.getConfiguration(comet.address)).assetConfigs[wrsEthAssetIndex];
    expect(newWrsEthPriceFeed).to.be.equal(configuratorWrsEthAssetConfig.priceFeed);

    // 3. Confirm the new price feed returns a price close to the old one
    expect(await comet.getPrice(newWrsEthPriceFeed)).to.be.closeTo(await comet.getPrice(oldWrsEthPriceFeed), exp(0.01, 8));
  },
});
