import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, proposal } from '../../../../src/deploy';
import { utils, Contract } from 'ethers';


let minPricePriceFeed: string;

const USDC_COMET = '0xF25212E676D1F7F89Cd72fFEe66158f541246445';
const USDT_COMET = '0xaeB318360f27748Acb200CE616E389A6C9409a07';

export default migration('1782122727_deprecate_maticx', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager, govDeploymentManager: DeploymentManager) {

    const trace = deploymentManager.tracer();

    const { 
      configurator,
      bridgeReceiver,
      cometAdmin,
      MaticX,
      'stMATIC:priceFeed': stMaticPriceFeed
    } = await deploymentManager.getContracts();
    minPricePriceFeed = stMaticPriceFeed.address;

    const {
      governor,
      fxRoot
    } = await govDeploymentManager.getContracts();

    const updateMaticXPriceFeedCalldataUsdc = await calldata(
      configurator.populateTransaction.updateAssetPriceFeed(
        USDC_COMET,
        MaticX.address,
        minPricePriceFeed
      )
    );

    const updateMaticXSupplyCapCalldataUsdc = await calldata(
      configurator.populateTransaction.updateAssetSupplyCap(
        USDC_COMET,
        MaticX.address,
        0
      )
    );

    const deployAndUpgradeToCalldataUsdc = await calldata(
      cometAdmin.populateTransaction.deployAndUpgradeTo(
        configurator.address,
        USDC_COMET
      )
    );

    const updateMaticXPriceFeedCalldataUsdt = await calldata(
      configurator.populateTransaction.updateAssetPriceFeed(
        USDT_COMET,
        MaticX.address,
        minPricePriceFeed
      )
    );

    const updateMaticXSupplyCapCalldataUsdt = await calldata(
      configurator.populateTransaction.updateAssetSupplyCap(
        USDT_COMET,
        MaticX.address,
        0
      )
    );

    const deployAndUpgradeToCalldataUsdt = await calldata(
      cometAdmin.populateTransaction.deployAndUpgradeTo(
        configurator.address,
        USDT_COMET
      )
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          configurator.address, configurator.address, cometAdmin.address,
          configurator.address, configurator.address, cometAdmin.address,
        ],
        [
          0, 0, 0,
          0, 0, 0,
        ],
        [
          'updateAssetPriceFeed(address,address,address)', 'updateAssetSupplyCap(address,address,uint128)', 'deployAndUpgradeTo(address,address)',
          'updateAssetPriceFeed(address,address,address)', 'updateAssetSupplyCap(address,address,uint128)', 'deployAndUpgradeTo(address,address)',
        ],
        [
          updateMaticXPriceFeedCalldataUsdc, updateMaticXSupplyCapCalldataUsdc, deployAndUpgradeToCalldataUsdc,
          updateMaticXPriceFeedCalldataUsdt, updateMaticXSupplyCapCalldataUsdt, deployAndUpgradeToCalldataUsdt,
        ],
      ]
    );

    const mainnetActions = [
      // 1. Set Comet configuration and deployAndUpgradeTo new Comet on Polygon.
      {
        contract: fxRoot,
        signature: 'sendMessageToChild(address,bytes)',
        args: [bridgeReceiver.address, l2ProposalData],
      },
    ];

    const description = `# Deprecate MaticX in cUSDCv3 and cUSDTv3 on Polygon

## Proposal summary

Woof proposes to deprecate MaticX as collateral in cUSDCv3 and cUSDTv3 on Polygon by updating its price feed to a constant price feed with a price of 1 wei and set its supply cap to 0.

Further detailed information can be found on the corresponding [proposal pull request](https://github.com/compound-finance/comet/pull/1136) and [forum discussion](<>).

## Proposal actions

The first action updates MaticX price feed to the constant price feed with a price of 1 wei and sets its supply cap to 0. This sends the encoded 'updateAssetPriceFeed', 'updateAssetSupplyCap' and 'deployAndUpgradeTo' calls across the bridge to the governance receiver for both cUSDCv3 and cUSDTv3 on Polygon.
`;

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
    const { configurator, MaticX } = await deploymentManager.getContracts();

    // USDC
    const usdcComet = new Contract(
      USDC_COMET,
      [
        'function getAssetInfoByAddress(address) external view returns(tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
        'function getPrice(address priceFeed) view returns (uint256)',
      ],
      await deploymentManager.getSigner()
    );

    const maticXIndexInUsdcComet = await configurator.getAssetIndex(usdcComet.address, MaticX.address);

    const maticXInUsdcCometInfo = await usdcComet.getAssetInfoByAddress(MaticX.address);
    const maticXInUsdcConfiguratorInfo = (await configurator.getConfiguration(usdcComet.address)).assetConfigs[maticXIndexInUsdcComet];

    expect(maticXInUsdcCometInfo.priceFeed).to.eq(minPricePriceFeed);
    expect(maticXInUsdcConfiguratorInfo.priceFeed).to.eq(minPricePriceFeed);
    expect(await usdcComet.getPrice(minPricePriceFeed)).to.equal(1);

    expect(maticXInUsdcCometInfo.supplyCap).to.eq(0);
    expect(maticXInUsdcConfiguratorInfo.supplyCap).to.eq(0);

    // USDT
    const usdtComet = new Contract(
      USDT_COMET,
      [
        'function getAssetInfoByAddress(address) external view returns(tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
        'function getPrice(address priceFeed) view returns (uint256)',
      ],
      await deploymentManager.getSigner()
    );

    const maticXIndexInUsdtComet = await configurator.getAssetIndex(usdtComet.address, MaticX.address);

    const maticXInUsdtCometInfo = await usdtComet.getAssetInfoByAddress(MaticX.address);
    const maticXInUsdtConfiguratorInfo = (await configurator.getConfiguration(usdtComet.address)).assetConfigs[maticXIndexInUsdtComet];

    expect(maticXInUsdtCometInfo.priceFeed).to.eq(minPricePriceFeed);
    expect(maticXInUsdtConfiguratorInfo.priceFeed).to.eq(minPricePriceFeed);
    expect(await usdtComet.getPrice(minPricePriceFeed)).to.equal(1);

    expect(maticXInUsdtCometInfo.supplyCap).to.eq(0);
    expect(maticXInUsdtConfiguratorInfo.supplyCap).to.eq(0);
  },
});
