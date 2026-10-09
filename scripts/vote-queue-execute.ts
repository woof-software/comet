import hre from 'hardhat';
import { DeploymentManager } from '../plugins/deployment_manager/DeploymentManager.js';
import { ProposalState } from '../scenario/context/Gov.js';
import config from '../hardhat.config.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function until(fn: () => Promise<boolean>, interval = 6000) {
  while (!await fn()) {
    await new Promise(ok => setTimeout(ok, interval));
  }
}

async function main() {
  const PROPOSAL_ID = requireEnv('PROPOSAL_ID');
  const connection = await hre.network.getOrCreate();
  const { ethers, networkName: network } = connection;
  const networkBase = config.scenario.bases.find(b => b.network === network);
  if (!networkBase) {
    throw new Error(`Scenario base not found for network: ${network}`);
  }
  const deployment = networkBase.deployment; // just for gov

  const dm = new DeploymentManager(
    network,
    deployment,
    hre,
    {
      writeCacheToDisk: true,
    }
  );
  await dm.spider();

  const trace = dm.tracer();
  const governor = await dm.contract('governor');
  console.log(`Governor via ${network}/${deployment}: ${await governor.getAddress()}`);

  const { startBlock, endBlock, eta } = await governor.proposals(PROPOSAL_ID);

  await until(async () => {
    const blockNow = await ethers.provider.getBlockNumber();
    console.log(`Current block is: ${blockNow} (starts: ${startBlock})`);
    return BigInt(blockNow) > startBlock;
  });

  console.log(`Attempting to vote in favor of proposal ${PROPOSAL_ID}`);
  trace(await governor.castVote(PROPOSAL_ID, 1));

  await until(async () => {
    const state = await governor.state(PROPOSAL_ID);
    const blockNum = await ethers.provider.getBlockNumber();
    console.log(`Current proposal state is: ${ProposalState[Number(state)]} at ${blockNum} (ends: ${endBlock})`);
    return Number(state) === ProposalState.Succeeded;
  });

  console.log(`Attempting to queue proposal ${PROPOSAL_ID}`);
  trace(await governor.queue(PROPOSAL_ID));

  await until(async () => {
    const block = await ethers.provider.getBlock('latest');
    if (!block) {
      throw new Error('Latest block not found');
    }
    console.log(`Current block time is: ${block.timestamp} (eta: ${eta})`);
    return BigInt(block.timestamp) > eta;
  });

  console.log(`Attempting to execute proposal ${PROPOSAL_ID}`);
  trace(await governor.execute(PROPOSAL_ID));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
