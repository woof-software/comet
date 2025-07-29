import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';
import {
  applyL1ToL2Alias,
  estimateL2Transaction,
} from '../../../../scenario/utils/arbitrumUtils';
import { ethers } from 'ethers';

const TBTC_ADDRESS = '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40';
const TBTC_TO_USD_PRICE_FEED_ADDRESS =
  '0xE808488e8627F6531bA79a13A9E0271B39abEb1C';

let newPriceFeed: string;

export default migration('1723551633_add_tbtc_as_collateral', {
  async prepare(deploymentManager: DeploymentManager) {
    const _tBTCPriceFeed = await deploymentManager.deploy(
      'tBTC:priceFeed',
      'pricefeeds/ScalingPriceFeed.sol',
      [
        TBTC_TO_USD_PRICE_FEED_ADDRESS, // BTC / USD price feed
        8, // decimals
      ]
    );
    
    return { tBTCPriceFeedAddress: _tBTCPriceFeed.address };
  },

  enact: async (
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager,
    { tBTCPriceFeedAddress }
  ) => {
    const trace = deploymentManager.tracer();
    const {
      bridgeReceiver,
      timelock: l2Timelock,
      comet,
      cometAdmin,
      configurator,
    } = await deploymentManager.getContracts();

    const { arbitrumInbox, timelock, governor } =
      await govDeploymentManager.getContracts();

    newPriceFeed = tBTCPriceFeedAddress;

    const tBTC = await deploymentManager.existing(
      'tBtc',
      TBTC_ADDRESS,
      'arbitrum',
      'contracts/ERC20.sol:ERC20'
    );

    const tBTCPriceFeed = await deploymentManager.existing(
      'tBTC:priceFeed',
      tBTCPriceFeedAddress,
      'arbitrum'
    );

    const tBTCAssetConfig = {
      asset: tBTC.address,
      priceFeed: tBTCPriceFeed.address,
      decimals: 18n,
      borrowCollateralFactor: exp(0.8, 18),
      liquidateCollateralFactor: exp(0.85, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(80, 18),
    };

    const addAssetCalldata = ethers.utils.defaultAbiCoder.encode(
      ['address', 'tuple(address,address,uint8,uint64,uint64,uint64,uint128)'],
      [
        comet.address,
        [
          tBTCAssetConfig.asset,
          tBTCAssetConfig.priceFeed,
          tBTCAssetConfig.decimals,
          tBTCAssetConfig.borrowCollateralFactor,
          tBTCAssetConfig.liquidateCollateralFactor,
          tBTCAssetConfig.liquidationFactor,
          tBTCAssetConfig.supplyCap,
        ],
      ]
    );

    const deployAndUpgradeToCalldata = ethers.utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [configurator.address, comet.address]
    );

    const l2ProposalData = ethers.utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [configurator.address, cometAdmin.address],
        [0, 0],
        [
          'addAsset(address,(address,address,uint8,uint64,uint64,uint64,uint128))',
          'deployAndUpgradeTo(address,address)',
        ],
        [addAssetCalldata, deployAndUpgradeToCalldata],
      ]
    );

    const createRetryableTicketGasParams = await estimateL2Transaction(
      {
        from: applyL1ToL2Alias(timelock.address),
        to: bridgeReceiver.address,
        data: l2ProposalData,
      },
      deploymentManager
    );
    const refundAddress = l2Timelock.address;

    const mainnetActions = [
      // 1. Set Comet configuration and deployAndUpgradeTo USDC Comet on Arbitrum.
      {
        contract: arbitrumInbox,
        signature:
          'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)',
        args: [
          bridgeReceiver.address, // address to,
          0, // uint256 l2CallValue,
          createRetryableTicketGasParams.maxSubmissionCost, // uint256 maxSubmissionCost,
          refundAddress, // address excessFeeRefundAddress,
          refundAddress, // address callValueRefundAddress,
          createRetryableTicketGasParams.gasLimit, // uint256 gasLimit,
          createRetryableTicketGasParams.maxFeePerGas, // uint256 maxFeePerGas,
          l2ProposalData, // bytes calldata data
        ],
        value: createRetryableTicketGasParams.deposit,
      },
    ];

    const description =
      '# Add tBTC as collateral into cUSDCv3 on Arbitrum\n\n## Proposal summary\n\nCompound Growth Program [AlphaGrowth] proposes to add tBTC into cUSDCv3 on Arbitrum network. This proposal takes the governance steps recommended and necessary to update a Compound III USDC market on Arbitrum. Simulations have confirmed the market’s readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario). The new parameters include setting the risk parameters based off of the [recommendations from Gauntlet](https://www.comp.xyz/t/gauntlet-tbtc-recommendations-across-comets-12-6-24/6036).\n\nFurther detailed information can be found on the corresponding [proposal pull request](https://github.com/compound-finance/comet/pull/908) and [forum discussion](https://www.comp.xyz/t/gauntlet-tbtc-recommendations-across-comets-12-6-24/6036).\n\n\n## Proposal Actions\n\nThe first proposal action adds tBTC to the USDC Comet on Arbitrum. This sends the encoded `addAsset` and `deployAndUpgradeTo` calls across the bridge to the governance receiver on Arbitrum.';
    const txn = await govDeploymentManager.retry(async () =>
      trace(
        await governor.propose(...(await proposal(mainnetActions, description)))
      )
    );

    const event = txn.events.find((event) => event.event === 'ProposalCreated');

    const [proposalId] = event.args;

    trace(`Created proposal ${proposalId}.`);
  },

  async enacted(deploymentManager: DeploymentManager): Promise<boolean> {
    return false;
  },

  async verify(deploymentManager: DeploymentManager) {
    const { comet, configurator } = await deploymentManager.getContracts();

    const tBTCAssetIndex = Number(await comet.numAssets()) - 1;

    const tBTC = await deploymentManager.existing(
      'tBTC',
      TBTC_ADDRESS,
      'arbitrum',
      'contracts/ERC20.sol:ERC20'
    );

    const tBTCAssetConfig = {
      asset: tBTC.address,
      priceFeed: newPriceFeed,
      decimals: 18n,
      borrowCollateralFactor: exp(0.8, 18),
      liquidateCollateralFactor: exp(0.85, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(500, 18),
    };

    // 1. & 2. Compare tBTC asset config with Comet and Configurator asset info
    const comettBTCAssetInfo = await comet.getAssetInfoByAddress(TBTC_ADDRESS);
    expect(tBTCAssetIndex).to.be.equal(comettBTCAssetInfo.offset);
    expect(tBTCAssetConfig.asset).to.be.equal(comettBTCAssetInfo.asset);
    expect(exp(1, tBTCAssetConfig.decimals)).to.be.equal(
      comettBTCAssetInfo.scale
    );
    expect(tBTCAssetConfig.borrowCollateralFactor).to.be.equal(
      comettBTCAssetInfo.borrowCollateralFactor
    );
    expect(tBTCAssetConfig.liquidateCollateralFactor).to.be.equal(
      comettBTCAssetInfo.liquidateCollateralFactor
    );
    expect(tBTCAssetConfig.liquidationFactor).to.be.equal(
      comettBTCAssetInfo.liquidationFactor
    );
    expect(tBTCAssetConfig.supplyCap).to.be.equal(comettBTCAssetInfo.supplyCap);

    const configuratortBTCAssetConfig = (
      await configurator.getConfiguration(comet.address)
    ).assetConfigs[tBTCAssetIndex];
    expect(tBTCAssetConfig.asset).to.be.equal(
      configuratortBTCAssetConfig.asset
    );
    expect(tBTCAssetConfig.decimals).to.be.equal(
      configuratortBTCAssetConfig.decimals
    );
    expect(tBTCAssetConfig.borrowCollateralFactor).to.be.equal(
      configuratortBTCAssetConfig.borrowCollateralFactor
    );
    expect(tBTCAssetConfig.liquidateCollateralFactor).to.be.equal(
      configuratortBTCAssetConfig.liquidateCollateralFactor
    );
    expect(tBTCAssetConfig.liquidationFactor).to.be.equal(
      configuratortBTCAssetConfig.liquidationFactor
    );
    expect(tBTCAssetConfig.supplyCap).to.be.equal(
      configuratortBTCAssetConfig.supplyCap
    );
  },
});
