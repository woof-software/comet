import { DeploymentManager } from '../../../../plugins/deployment_manager/DeploymentManager';
import { migration } from '../../../../plugins/deployment_manager/Migration';


export default migration('1759246403_deploy_comp_eth_pricefeed', {
  prepare: async (deploymentManager: DeploymentManager) => {
    const _compPriceFeed = await deploymentManager.deploy(
      'COMP:priceFeed',
      'pricefeeds/ReverseMultiplicativePriceFeed.sol',
      [
        '0xc0068A2F7e4847DF9C3A34B27CCc07b7e15e0458', // COMP / USD price feed
        '0x3c6Cd9Cc7c7a4c2Cf5a82734CD249D7D593354dA', // USD / ETH price feed
        8,                                            // decimals
        'COMP / ETH price feed'                       // description
      ],
      true
    );

    return { compPriceFeedAddress: _compPriceFeed.address };
  },

  enact: async () => {
    // No changes
  },

  enacted: async () => {
    return false;
  }
    
});
