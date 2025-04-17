import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal } from '../../../../src/deploy';

const TETH_ADDRESS = '0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8';
const TETH_TO_WSTETH_PRICE_FEED = '0x7B2Fb2c667af80Bccc0B2556378352dFDE2be914';
const NEW_TETH_PRICE_FEED = '0x7783a5c7656d75ed1144379c25142B7e43Da5F5E';

let newPriceFeedAddress: string;

export default migration('1744125028_update_teth_price_feed', {
  async prepare(deploymentManager: DeploymentManager) {
    const _wstETHToETHPriceFeed = await deploymentManager.fromDep('wstETH:priceFeed', 'mainnet', 'weth');
    const tETHMultiplicativePriceFeed = await deploymentManager.deploy(
      'tETH:priceFeed',
      'pricefeeds/MultiplicativePriceFeed.sol',
      [
        TETH_TO_WSTETH_PRICE_FEED,     // tETH / wstETH price feed
        _wstETHToETHPriceFeed.address, // wstETH / ETH price feed 
        8,                             // decimals
        'tETH / ETH price feed'        // description
      ],
      true
    );
    return { tETHPriceFeedAddress: tETHMultiplicativePriceFeed.address };
  },

  async enact(deploymentManager: DeploymentManager, _, { tETHPriceFeedAddress }) {

    const trace = deploymentManager.tracer();

    const tETH = await deploymentManager.existing(
      'tETH',
      TETH_ADDRESS,
      'mainnet',
      'contracts/ERC20.sol:ERC20'
    );

    newPriceFeedAddress = NEW_TETH_PRICE_FEED;

    const {
      governor,
      comet,
      cometAdmin,
      configurator,
    } = await deploymentManager.getContracts();

    const mainnetActions = [
      // 1. Add tETH as asset
      {
        contract: configurator,
        signature: 'updateAssetPriceFeed(address,address,address)',
        args: [comet.address, tETH.address, NEW_TETH_PRICE_FEED],
      },
      // 2. Deploy and upgrade to a new version of Comet
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, comet.address],
      },
    ];

    const description = '# Update tETH price feed on WETH Mainnet market\n\n## Proposal summary\n\nUpdate price feed for tETH on WETH Mainnet from tETH / wstETH -> ETH / wstETH to tETH / wstETH -> wstETH / ETH.\n\n';
    const txn = await deploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      )
    );

    const event = txn.events.find(
      (event) => event.event === 'ProposalCreated'
    );
    const [proposalId] = event.args;
    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(): Promise<boolean> {
    return false;
  },

  async verify(deploymentManager: DeploymentManager) {
    const { comet, configurator } = await deploymentManager.getContracts();

    // 1. Compare tETH asset config with Comet and Configurator asset info
    const cometTETHAssetInfo = await comet.getAssetInfoByAddress(TETH_ADDRESS);
    expect(newPriceFeedAddress).to.be.equal(cometTETHAssetInfo.priceFeed);

    const configuratorTETHAssetConfig = (await configurator.getConfiguration(comet.address)).assetConfigs[cometTETHAssetInfo.offset];
    expect(newPriceFeedAddress).to.be.equal(configuratorTETHAssetConfig.priceFeed);
  },
});
