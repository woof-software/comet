import { expect } from 'chai';
import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const WBTC_COMET = '0xe85Dc543813B8c2CFEaAc371517b925a166a9293';

const COMET_FACTORY_V2 = '0x298aC0E463cEAd4aaA73fb91Df7C639A8eFBd9c4';

const WBTC_EXT = '0xecac24cBadFDF7a8F302fCD75C91Fea9335611C4';

export default migration('1788784809_update_and_wbtc_to_v2_factory', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {

    const trace = deploymentManager.tracer();

    const {
      governor,
      cometAdmin,
      configurator,
      pumpBTC,
    } = await deploymentManager.getContracts();

    const mainnetActions = [
      // 1. Update version in new Comet to the recent service patch version
      {
        target: COMET_FACTORY_V2,
        signature: 'setVersion(((uint64,uint64,uint64),string))',
        calldata: utils.defaultAbiCoder.encode(
          ['tuple((uint64,uint64,uint64),string)'],
          [[
            [1, 2, 1],
            '',
          ]]
        ),          
      },
      // 2. Update WBTC Comet factory to the new one
      {
        contract: configurator,
        signature: 'setFactory(address,address)',
        args: [WBTC_COMET, COMET_FACTORY_V2],
      },
      // 3. Set service patch version of the extension delegate for the WBTC Comet
      {
        contract: configurator,
        signature: 'setExtensionDelegate(address,address)',
        args: [WBTC_COMET, WBTC_EXT],
      },
      // 4. Fully deprecate pumpBTC as collateral: zero its borrow collateral factor
      {
        contract: configurator,
        signature: 'updateAssetBorrowCollateralFactor(address,address,uint64)',
        args: [WBTC_COMET, pumpBTC.address, 0],
      },
      // 5. Fully deprecate pumpBTC as collateral: zero its liquidate collateral factor
      {
        contract: configurator,
        signature: 'updateAssetLiquidateCollateralFactor(address,address,uint64)',
        args: [WBTC_COMET, pumpBTC.address, 0],
      },
      // 6. Set pumpBTC's liquidation factor to 100% so any pumpBTC seized during
      //    absorption of unrelated debt is credited to protocol reserves and
      //    remains sellable via buyCollateral, instead of getting stuck unseized
      {
        contract: configurator,
        signature: 'updateAssetLiquidationFactor(address,address,uint64)',
        args: [WBTC_COMET, pumpBTC.address, exp(1,18)],
      },
      // 7. Deploy and upgrade WBTC Comet to a new version of Comet
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, WBTC_COMET],
      },
    ];

    const description = `# Completion of pumpBTC Deprecation on cWBTCv3

## Proposal summary

WOOF! proposes to complete the deprecation of pumpBTC as collateral on cWBTCv3. pumpBTC's supply cap was already reduced to 0 and its price feed already points to a constant price feed of 1 wei ([Compound Governance Proposal 605](https://www.tally.xyz/gov/compound/proposal/605)). This proposal finishes the process by zeroing out pumpBTC's borrow collateral factor and liquidate collateral factor, fully de-listing it (both factors zero ⇒ fully de-listed), while setting its liquidation factor to 100% so that any pumpBTC seized when liquidating unrelated debt is credited to protocol reserves and remains sellable via buyCollateral rather than getting stuck with the borrower.

These configuration changes are bundled with an update of the cWBTCv3 Comet to the recent service patch version, and both are applied together in a single deployAndUpgradeTo call.

Detailed information can be found on the corresponding [proposal pull request](https://github.com/Compound-Foundation/comet/pull/21).

## Proposal Actions

The first proposal action updates the version in the new Comet factory to the recent service patch version.

The second proposal action updates the factory of the WBTC Comet to the new V2 factory.

The third proposal action sets the extension delegate for the WBTC Comet to the new service patch version.

The fourth and fifth proposal actions zero out pumpBTC's borrow collateral factor and liquidate collateral factor, respectively, completing its deprecation as collateral on cWBTCv3. The sixth proposal action sets pumpBTC's liquidation factor to 100%, so pumpBTC seized while liquidating unrelated debt is credited to protocol reserves and remains sellable via buyCollateral.

The seventh proposal action deploys and upgrades the WBTC Comet, applying all of the above configuration changes.
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
    const {
      configurator,
      pumpBTC,
    } = await deploymentManager.getContracts();
    const newCometAbi = [
      'function MAX_SUPPORTED_UTILIZATION() external view returns (uint256)',
      'function symbol() external view returns (string)',
      'function name() external view returns (string)',
      'function extensionDelegate() external view returns (address)',
      'function getAssetInfoByAddress(address asset) external view returns ((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
      'function getPrice(address priceFeed) external view returns (uint256)',
    ];

    const factoryV2 = new Contract(
      COMET_FACTORY_V2,
      [
        'function version() view returns ((uint64,uint64,uint64),string)',
      ],
      await deploymentManager.getSigner()
    );

    const [baseVersion, baseAlternative] = await factoryV2.version();
    expect(baseVersion).to.deep.equal([1, 2, 1]);
    expect(baseAlternative).to.equal('');

    expect(await configurator.factory(WBTC_COMET)).to.equal(COMET_FACTORY_V2);

    expect((await configurator.getConfiguration(WBTC_COMET)).extensionDelegate).to.equal(WBTC_EXT);

    const expectedMaxUtilization = exp(2, 18);
    const signer = await deploymentManager.getSigner();

    const newCometWbtc = new Contract(WBTC_COMET, newCometAbi, signer);

    expect(await newCometWbtc.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometWbtc.symbol()).to.equal('cWBTCv3');
    expect(await newCometWbtc.name()).to.equal('Compound WBTC');
    expect(await newCometWbtc.extensionDelegate()).to.equal(WBTC_EXT);

    // pumpBTC is fully deprecated: BCF and LCF are zeroed; liquidation factor is set
    // to 100% so seized pumpBTC lands in protocol reserves and stays sellable
    const pumpBTCInCometInfo = await newCometWbtc.getAssetInfoByAddress(pumpBTC.address);
    expect(pumpBTCInCometInfo.borrowCollateralFactor).to.equal(0);
    expect(pumpBTCInCometInfo.liquidateCollateralFactor).to.equal(0);
    expect(pumpBTCInCometInfo.liquidationFactor).to.equal(exp(1, 18));
    expect(pumpBTCInCometInfo.supplyCap).to.equal(0);
    expect(await newCometWbtc.getPrice(pumpBTCInCometInfo.priceFeed)).to.equal(1);

    const pumpBTCIndex = await configurator.getAssetIndex(WBTC_COMET, pumpBTC.address);
    const pumpBTCInConfiguratorInfo = (await configurator.getConfiguration(WBTC_COMET)).assetConfigs[pumpBTCIndex];
    expect(pumpBTCInConfiguratorInfo.borrowCollateralFactor).to.equal(0);
    expect(pumpBTCInConfiguratorInfo.liquidateCollateralFactor).to.equal(0);
    expect(pumpBTCInConfiguratorInfo.liquidationFactor).to.equal(exp(1, 18));
  },
});
