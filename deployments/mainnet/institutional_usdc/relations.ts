import { RelationConfigMap } from '../../../plugins/deployment_manager/RelationConfig';
import baseRelationConfig from '../../relations';

// Compound GovernorBravo on mainnet. This market is not governed by it; it is
// only aliased so the scenario ProposalConstraint can read open proposals.
const COMPOUND_GOVERNOR_BRAVO = '0x309a862bbC1A00e45506cB8A802D1ff10004c8C0';

export default {
  ...baseRelationConfig,
  // The institutional market is administered by Safes, not the Compound Timelock:
  //  - comet.governor() is a Safe; it is aliased as `timelock` because scenarios
  //    treat the comet governor as the timelock (e.g. `Comet#governor > points to timelock`)
  //  - cometAdmin.owner() is a different Safe, aliased as `cometAdminOwner`
  // The base relations would call timelock.admin() on the Safe, which does not exist.
  // `timelock` hangs off `comet` (not `cometAdmin`): the spider only fills the
  // relation context after a node finishes crawling, so `comet` is not in the
  // context yet while its own `cometAdmin` relation is being crawled.
  comet: {
    ...baseRelationConfig.comet,
    relations: {
      ...baseRelationConfig.comet.relations,
      timelock: {
        field: async (comet) => comet.governor()
      }
    }
  },
  cometAdmin: {
    relations: {
      cometAdminOwner: {
        field: async (cometAdmin) => cometAdmin.owner()
      }
    }
  },
  timelock: {
    relations: {
      governor: {
        field: async () => COMPOUND_GOVERNOR_BRAVO
      }
    }
  },
  'wstETH': {
    artifact: 'contracts/bulkers/IWstETH.sol',
    relations: {
      stETH: {
        field: async (wstETH) => wstETH.stETH()
      }
    }
  },
  'AppProxyUpgradeable': {
    artifact: 'contracts/interfaces/ERC20.sol:ERC20',
  },
  'ERC1967Proxy': {
    artifact: 'contracts/interfaces/ERC20.sol:ERC20',
    delegates: {
      field: {
        slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
      }
    }
  },
} as RelationConfigMap;
