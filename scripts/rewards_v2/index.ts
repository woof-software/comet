// To run script
// yarn run rewards-v2 -- --network mainnet
// Or use hardhat task
// yarn hardhat generateMerkleTree --network mainnet --deployment usdc --type finish --blocknumber 21114579

import hre from 'hardhat';
import { CampaignType } from './types';
import { generateMerkleTreeForCampaign } from './utils';

const main = async () => {
  console.log('Start Rewards V2 hash generation');

  let { NETWORK, DEPLOYMENT, BLOCK_NUMBER, TYPE } = process.env;

  await generateMerkleTreeForCampaign(NETWORK, DEPLOYMENT, +BLOCK_NUMBER, TYPE as CampaignType, hre);
};

main().then().catch(console.error);