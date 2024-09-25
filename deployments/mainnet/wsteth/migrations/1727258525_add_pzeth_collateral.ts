import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const PZETH_ADDRESS = '0x8c9532a60E0E7C6BbD2B2c1303F63aCE1c3E9811';
const PZETH_PRICE_FEED_ADDRESS = '0x0B6c5C37215B27C944497D2d7011cBD366b0870A';

let newPriceFeed: string;

export default migration('1727258525_add_pzeth_collateral', {
  async prepare(deploymentManager: DeploymentManager) {
    const _pzETHScalingPriceFeed = await deploymentManager.deploy(
      'pzETH:priceFeed',
      'pricefeeds/ScalingPriceFeed.sol',
      [
        PZETH_PRICE_FEED_ADDRESS, // pzETH / ETH price feed
        8                         // decimals
      ]
    );
    console.log(await _pzETHScalingPriceFeed.latestRoundData());
    return { pzETHScalingPriceFeed: _pzETHScalingPriceFeed.address };
  },

  async enact(deploymentManager: DeploymentManager, _, { pzETHScalingPriceFeed }) {

    const trace = deploymentManager.tracer();

    const pzETH = await deploymentManager.existing(
      'pzETH',
      PZETH_ADDRESS,
      'mainnet',
      'contracts/ERC20.sol:ERC20'
    );
    newPriceFeed = pzETHScalingPriceFeed;

    const {
      governor,
      comet,
      cometAdmin,
      configurator,
    } = await deploymentManager.getContracts();

    const pzETHAssetConfig = {
      asset: pzETH.address,
      priceFeed: pzETHScalingPriceFeed,
      decimals: await pzETH.decimals(),
      borrowCollateralFactor: exp(0.85, 18),
      liquidateCollateralFactor: exp(0.88, 18),
      liquidationFactor: exp(0.92, 18),
      supplyCap: exp(600, 18), 
    };

    const mainnetActions = [
      // 1. Add pzETH as asset
      {
        contract: configurator,
        signature: 'addAsset(address,(address,address,uint8,uint64,uint64,uint64,uint128))',
        args: [comet.address, pzETHAssetConfig],
      },
      // 2. Deploy and upgrade to a new version of Comet
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, comet.address],
      },
    ];

    const description = '# Add pzETH as collateral into cwstETHv3 on Mainnet\n\n## Proposal summary\n\nCompound Growth Program [AlphaGrowth] proposes to add pzETH into cwstETHv3 on Ethereum network. This proposal takes the governance steps recommended and necessary to update a Compound III wstETH market on Ethereum. Simulations have confirmed the market’s readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario). The new parameters include setting the risk parameters based on the [recommendations from Gauntlet](https://www.comp.xyz/t/add-wsteth-market-on-mainnet/5504/4).\n\nFurther detailed information can be found on the corresponding [proposal pull request](https://github.com/compound-finance/comet/pull/928) and [forum discussion](https://www.comp.xyz/t/add-wsteth-market-on-mainnet/5504).\n\n\n## Proposal Actions\n\nThe first proposal action adds pzETH asset as collateral with corresponding configurations.\n\nThe second action deploys and upgrades Comet to a new version.';
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
    const { comet, configurator } = await deploymentManager.getContracts()
    console.log(await comet.getUtilization());

    const pzETHAssetIndex = Number(await comet.numAssets()) - 1;

    const pzETH = await deploymentManager.existing(
      'pzETH',
      PZETH_ADDRESS,
      'mainnet',
      'contracts/ERC20.sol:ERC20'
    );
    
    const pzETHAssetConfig = {
      asset: pzETH.address,
      priceFeed: newPriceFeed,
      decimals: await pzETH.decimals(),
      borrowCollateralFactor: exp(0.85, 18),
      liquidateCollateralFactor: exp(0.88, 18),
      liquidationFactor: exp(0.92, 18),
      supplyCap: exp(600, 18), 
    };

    // 1. & 2. Compare pzETH asset config with Comet and Configurator asset info
    const cometPzETHAssetInfo = await comet.getAssetInfoByAddress(PZETH_ADDRESS);
    expect(pzETHAssetIndex).to.be.equal(cometPzETHAssetInfo.offset);
    expect(pzETHAssetConfig.asset).to.be.equal(cometPzETHAssetInfo.asset);
    expect(pzETHAssetConfig.priceFeed).to.be.equal(cometPzETHAssetInfo.priceFeed);
    expect(exp(1, pzETHAssetConfig.decimals)).to.be.equal(cometPzETHAssetInfo.scale);
    expect(pzETHAssetConfig.borrowCollateralFactor).to.be.equal(cometPzETHAssetInfo.borrowCollateralFactor);
    expect(pzETHAssetConfig.liquidateCollateralFactor).to.be.equal(cometPzETHAssetInfo.liquidateCollateralFactor);
    expect(pzETHAssetConfig.liquidationFactor).to.be.equal(cometPzETHAssetInfo.liquidationFactor);
    expect(pzETHAssetConfig.supplyCap).to.be.equal(cometPzETHAssetInfo.supplyCap);
    
    const configuratorPzETHAssetConfig = (await configurator.getConfiguration(comet.address)).assetConfigs[pzETHAssetIndex];
    expect(pzETHAssetConfig.asset).to.be.equal(configuratorPzETHAssetConfig.asset);
    expect(pzETHAssetConfig.priceFeed).to.be.equal(configuratorPzETHAssetConfig.priceFeed);
    expect(pzETHAssetConfig.decimals).to.be.equal(configuratorPzETHAssetConfig.decimals);
    expect(pzETHAssetConfig.borrowCollateralFactor).to.be.equal(configuratorPzETHAssetConfig.borrowCollateralFactor);
    expect(pzETHAssetConfig.liquidateCollateralFactor).to.be.equal(configuratorPzETHAssetConfig.liquidateCollateralFactor);
    expect(pzETHAssetConfig.liquidationFactor).to.be.equal(configuratorPzETHAssetConfig.liquidationFactor);
    expect(pzETHAssetConfig.supplyCap).to.be.equal(configuratorPzETHAssetConfig.supplyCap);
  },
});
