import { expect } from 'chai';
import { Contract } from 'ethers';
import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';
import { exp, proposal } from '../../../../src/deploy';

const COMET_FACTORY_V2 = '0x298aC0E463cEAd4aaA73fb91Df7C639A8eFBd9c4';

const USDS_EXT = '0xbEf2218271f74B58ed06197903574716709c9537';

export default migration('1790001296_update_usds_to_v2_factory', {
  async prepare() {
    return {};
  },

  async enact(deploymentManager: DeploymentManager) {

    const trace = deploymentManager.tracer();

    const {
      comet,
      governor,
      cometAdmin,
      configurator,
    } = await deploymentManager.getContracts();

    const mainnetActions = [
      // 1. Update USDS Comet factory to a new one
      {
        contract: configurator,
        signature: 'setFactory(address,address)',
        args: [comet.address, COMET_FACTORY_V2],
      },
      // 2. Set service patch version of the extension delegate for the USDS Comet
      {
        contract: configurator,
        signature: 'setExtensionDelegate(address,address)',
        args: [comet.address, USDS_EXT],
      },
      // 3. Deploy and upgrade to a new version of Comet
      {
        contract: cometAdmin,
        signature: 'deployAndUpgradeTo(address,address)',
        args: [configurator.address, comet.address],
      },
    ];

    const description = `# Update cUSDSv3 Comets on Mainnet to the service patch version

## Proposal summary

WOOF! proposes to update Mainnet cUSDSv3 Comet markets to a new service patch version introducing several improvements and security enhancements:

- Extended Pause Controls: collateral interactions can now be paused independently per collateral asset.
- Price Feed Patch (Post-USDM incident response): skips price feed calls for assets with zero collateral factor, preventing unnecessary reverts.
- Collateral Deactivation Mechanism: introduces a Guardian-controlled emergency mechanism to deactivate unsafe collateral assets, with reactivation requiring a governance proposal.
- Utilization Peaking Protection: caps utilization at 200%, preventing additional borrowing when post-borrow utilization exceeds this threshold, while preserving lender withdrawals.
- Borrow Index Fix (Empty Market): prevents borrow interest accrual in markets without active borrowers.
- Supply Index Fix (Empty Market): ensures supply index only accrues when lenders are present.
- Lender Illiquidity Fix in Zero-Borrow Markets: prevents reserve depletion in markets with no borrowers by capping supply rate to zero when utilization is zero and reserves are exhausted.
- Accrue Interest on Collateral Actions (Post-USDM incident response): collateral actions (supply, withdraw, transfer) now trigger interest accrual for affected accounts.
- Technical Improvements: includes removal of redundant arguments in supplyInternal() and optimized price caching in absorbInternal(), improving gas efficiency without affecting protocol behavior.

This proposal takes the governance steps recommended and necessary to update Compound III USDS markets on Mainnet. Simulations have confirmed the market's readiness, as much as possible, using the [Comet scenario suite](https://github.com/compound-finance/comet/tree/main/scenario).

Detailed information can be found on the corresponding [proposal pull request](https://github.com/Compound-Foundation/comet/pull/14).

### Bytecode Repository

This update is done with the use of the bytecode repository, which provides trustless and deterministic deployments.

Further details on the deployment can be found in the [Bytecode Repository git](https://github.com/woof-software/bytecode-repository) and [forum discussion](https://www.comp.xyz/t/rfc-bytecode-repository-and-deployment-pipeline-modernization/6965).

### Audit

Both service patch Comet update and Bytecode Repository have been audited by Certora and full reports can be found here:

- [Certora Comet Service Patch Audit](https://www.certora.com/reports/comet-service-patch)
- [Certora Bytecode Repository Audit](https://www.certora.com/reports/compound-bytecoderepository)


## Proposal Actions

The first proposal action updates the version in the new Comet factory to the recent service patch version.

The second proposal action updates the factory of the USDS Comet to the new V2 factory.

The third proposal action sets the extension delegate for the USDS Comet to the new service patch version.

The fourth proposal action deploys and upgrades the USDS Comet to the new service patch version.
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
      comet
    } = await deploymentManager.getContracts();
    const newCometAbi = [
      'function MAX_SUPPORTED_UTILIZATION() external view returns (uint256)',
      'function symbol() external view returns (string)',
      'function name() external view returns (string)',
      'function extensionDelegate() external view returns (address)',
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

    expect(await configurator.factory(comet.address)).to.equal(COMET_FACTORY_V2);

    expect((await configurator.getConfiguration(comet.address)).extensionDelegate).to.equal(USDS_EXT);

    const expectedMaxUtilization = exp(2, 18);
    const signer = await deploymentManager.getSigner();

    const newCometUsds = new Contract(comet.address, newCometAbi, signer);

    expect(await newCometUsds.MAX_SUPPORTED_UTILIZATION()).to.equal(expectedMaxUtilization);
    expect(await newCometUsds.symbol()).to.equal('cUSDSv3');
    expect(await newCometUsds.name()).to.equal('Compound USDS');
    expect(await newCometUsds.extensionDelegate()).to.equal(USDS_EXT);
  },
});