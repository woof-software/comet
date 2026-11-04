import { expect } from 'chai';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { calldata, exp, proposal } from '../../../../src/deploy';
import { utils, Contract } from 'ethers';

// Price feeds deployed for proposal 593 (already in use by the USDC and USDS markets on Base)
const CBBTC_USD_SVR_PRICE_FEED_ADDRESS = '0x8C74B2811D2F1aD65517ADB5C65773c1E520ed2f'; // wraps cbBTC / USD SVR 0x2231aEdEf63Bef7F32fA1cEc5851C5CD72746263
const CBBTC_ETH_SVR_PRICE_FEED_ADDRESS = '0xc8E4c3F58d5FC4409522503927Ecea057EbbA1fc'; // cbBTC / USD SVR 0x2231...6263 and ETH / USD SVR 0x1428...98C0

const AERO_COMET_ADDRESS = '0x784efeB622244d2348d4F2522f8860B96fbEcE89';
const WETH_COMET_ADDRESS = '0x46e6b214b524310239732D51387075E0e70970bf';

const cometAbi = [
  'function getAssetInfoByAddress(address asset) public view returns((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
  'function getPrice(address priceFeed) public view returns (uint256)'
];

let oldAeroCbBTCToUsdPriceFeed: string;
let oldWethCbBTCToEthPriceFeed: string;

export default migration('1793718060_resubmit_update_cbbtc_to_svr', {
  async prepare() {
    return {};
  },

  enact: async (
    deploymentManager: DeploymentManager,
    govDeploymentManager: DeploymentManager,
  ) => {
    const trace = deploymentManager.tracer();

    const {
      bridgeReceiver,
      cbBTC,
      cometAdmin,
      configurator,
    } = await deploymentManager.getContracts();

    const { governor, baseL1CrossDomainMessenger } = await govDeploymentManager.getContracts();

    const signer = await deploymentManager.getSigner();
    const aeroComet = new Contract(AERO_COMET_ADDRESS, cometAbi, signer);
    const wethComet = new Contract(WETH_COMET_ADDRESS, cometAbi, signer);

    oldAeroCbBTCToUsdPriceFeed = (await aeroComet.getAssetInfoByAddress(cbBTC.address)).priceFeed;
    oldWethCbBTCToEthPriceFeed = (await wethComet.getAssetInfoByAddress(cbBTC.address)).priceFeed;

    const updateAssetPriceFeedCalldataAero = await calldata(
      configurator.populateTransaction.updateAssetPriceFeed(
        AERO_COMET_ADDRESS,
        cbBTC.address,
        CBBTC_USD_SVR_PRICE_FEED_ADDRESS
      )
    );
    const deployAndUpgradeToCalldataAero = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [configurator.address, AERO_COMET_ADDRESS]
    );

    const updateAssetPriceFeedCalldataWeth = await calldata(
      configurator.populateTransaction.updateAssetPriceFeed(
        WETH_COMET_ADDRESS,
        cbBTC.address,
        CBBTC_ETH_SVR_PRICE_FEED_ADDRESS
      )
    );
    const deployAndUpgradeToCalldataWeth = utils.defaultAbiCoder.encode(
      ['address', 'address'],
      [configurator.address, WETH_COMET_ADDRESS]
    );

    const l2ProposalData = utils.defaultAbiCoder.encode(
      ['address[]', 'uint256[]', 'string[]', 'bytes[]'],
      [
        [
          configurator.address, cometAdmin.address, // AERO
          configurator.address, cometAdmin.address, // WETH
        ],
        [
          0, 0, // AERO
          0, 0, // WETH
        ],
        [
          'updateAssetPriceFeed(address,address,address)', 'deployAndUpgradeTo(address,address)', // AERO
          'updateAssetPriceFeed(address,address,address)', 'deployAndUpgradeTo(address,address)', // WETH
        ],
        [
          updateAssetPriceFeedCalldataAero, deployAndUpgradeToCalldataAero, // AERO
          updateAssetPriceFeedCalldataWeth, deployAndUpgradeToCalldataWeth, // WETH
        ],
      ]
    );

    const mainnetActions = [
      // 1. Update price feed for cbBTC in AERO and WETH markets
      {
        contract: baseL1CrossDomainMessenger,
        signature: 'sendMessage(address,bytes,uint32)',
        args: [bridgeReceiver.address, l2ProposalData, 3_000_000]
      },
    ];

    const description = `DESCRIPTION`;

    const txn = await govDeploymentManager.retry(async () =>
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
    const { cbBTC } = await deploymentManager.getContracts();

    const signer = await deploymentManager.getSigner();
    const aeroComet = new Contract(AERO_COMET_ADDRESS, cometAbi, signer);
    const wethComet = new Contract(WETH_COMET_ADDRESS, cometAbi, signer);

    const cbBTCAssetInfoAero = await aeroComet.getAssetInfoByAddress(cbBTC.address);
    const cbBTCAssetInfoWeth = await wethComet.getAssetInfoByAddress(cbBTC.address);

    expect(cbBTCAssetInfoAero.priceFeed).to.equal(CBBTC_USD_SVR_PRICE_FEED_ADDRESS);
    expect(cbBTCAssetInfoWeth.priceFeed).to.equal(CBBTC_ETH_SVR_PRICE_FEED_ADDRESS);

    const oldPriceCbBTCToUsdAero = await aeroComet.getPrice(oldAeroCbBTCToUsdPriceFeed);
    const newPriceCbBTCToUsdAero = await aeroComet.getPrice(CBBTC_USD_SVR_PRICE_FEED_ADDRESS);
    expect(oldPriceCbBTCToUsdAero).to.be.closeTo(newPriceCbBTCToUsdAero, exp(400, 8)); // within $400

    const oldPriceCbBTCToEthWeth = await wethComet.getPrice(oldWethCbBTCToEthPriceFeed);
    const newPriceCbBTCToEthWeth = await wethComet.getPrice(CBBTC_ETH_SVR_PRICE_FEED_ADDRESS);
    expect(oldPriceCbBTCToEthWeth).to.be.closeTo(newPriceCbBTCToEthWeth, exp(0.188, 8)); // within 0.188 ETH ~ $400
  },
});
