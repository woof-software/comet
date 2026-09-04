import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { proposal, exp } from '../../../../src/deploy';

const MinPricePriceFeed = '0x7BaDaB7109afBbF48eCd8d6498CaAcd2630b45B9';

export default migration('1787830840_deprecate_pumpbtc_collateral', {
  async prepare() {
    return {};
  },

  enact: async (deploymentManager: DeploymentManager) => {
    const trace = deploymentManager.tracer();

    const {
      governor,
      comet,
      cometAdmin,
      pumpBTC,
      configurator
    } = await deploymentManager.getContracts();
  
    const newAssetConfig = {
      asset: pumpBTC.address,
      priceFeed: MinPricePriceFeed,
      decimals: await pumpBTC.decimals(),
      borrowCollateralFactor: 0,
      liquidateCollateralFactor: exp(0.0001, 18),
      liquidationFactor: exp(1, 18),
      supplyCap: 0,
    };

    const mainnetActions = [
      // 1. Update pumpBTC price feed to return the smallest possible price
      {
        contract: configurator,
        signature: 'updateAsset(address,(address,address,uint8,uint64,uint64,uint64,uint128))',
        args: [comet.address, newAssetConfig],
      },
      // 2. Deploy and upgrade to a new version of Comet
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, comet.address],
      },
    ];

    const description = `# Deprecate pumpBTC from cWBTCv3 on Ethereum

## Proposal summary

Woof proposes to deprecate pumpBTC from cWBTCv3 on Ethereum network, since deprecation of its Chainlink oracle.

In order to achieve this price feed will be updated to a new one, which will return the smallest acceptable price - 0.00000001 (1e-8), and the supply cap will be set to 0 to prevent further deposits.

This proposal takes the governance steps recommended and necessary to update a Compound III WBTC market on Ethereum. Simulations have confirmed the market’s readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Further detailed information can be found on the corresponding [proposal pull request](https://github.com/Compound-Foundation/comet/pull/17).


## Proposal Actions

The first proposal action updates pumpBTC config to a deprecated state.

The second action deploys and upgrades Comet to a new version.`;

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
      pumpBTC
    } = await deploymentManager.getContracts();

    expect(await comet.getPrice(MinPricePriceFeed)).to.be.equal(1);

    // 1. Compare proposed asset config with Comet asset info
    const pumpBTCAssetInfo = await comet.getAssetInfoByAddress(pumpBTC.address);
    const pumpBTCAssetIndex = pumpBTCAssetInfo.offset;
    expect(0).to.be.equal(pumpBTCAssetInfo.supplyCap);
    expect(MinPricePriceFeed).to.be.equal(pumpBTCAssetInfo.priceFeed);
    expect(1).to.be.equal(await comet.getPrice(pumpBTCAssetInfo.priceFeed));
    expect(0).to.be.equal(pumpBTCAssetInfo.borrowCollateralFactor);
    expect(exp(0.0001, 18)).to.be.equal(pumpBTCAssetInfo.liquidateCollateralFactor);
    expect(exp(1, 18)).to.be.equal(pumpBTCAssetInfo.liquidationFactor);

    // 2. Compare proposed asset config with Configurator asset config
    const configuratorPumpBTCAssetConfig = (await configurator.getConfiguration(comet.address)).assetConfigs[pumpBTCAssetIndex];
    expect(0).to.be.equal(configuratorPumpBTCAssetConfig.supplyCap);
    expect(MinPricePriceFeed).to.be.equal(configuratorPumpBTCAssetConfig.priceFeed);
    expect(1).to.be.equal(await comet.getPrice(configuratorPumpBTCAssetConfig.priceFeed));
    expect(0).to.be.equal(configuratorPumpBTCAssetConfig.borrowCollateralFactor);
    expect(exp(0.0001, 18)).to.be.equal(configuratorPumpBTCAssetConfig.liquidateCollateralFactor);
    expect(exp(1, 18)).to.be.equal(configuratorPumpBTCAssetConfig.liquidationFactor);
  },
});
