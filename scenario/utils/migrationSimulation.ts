import axios from 'axios';
import path from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { BigNumber, Contract, ContractReceipt, Event, utils } from 'ethers';
import { Interface } from 'ethers/lib/utils';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { debug } from '../../plugins/deployment_manager/Utils';
import { vnetHreForBase } from '../../plugins/scenario/utils/hreForBase';
import { COMP_WHALES } from '../../src/deploy';
import relayMessage from './relayMessage';
import { updateCCIPStats } from './ccip';
import { setEtherBalance } from './hreUtils';
import { getOrCreateVirtualTestnet } from './tenderlyVnet';

// storage slot:
//   keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.GovernorCountingFractional")) - 1))
//   & ~bytes32(uint256(0xff))
const GOV_COUNTING_FRACTIONAL_STORAGE_LOCATION =
  '0xd073797d8f9d07d835a3fc13195afeafd2f137da609f97a44f7a3aa434170800';

export async function tenderlyExecute(
  gdm: DeploymentManager,
  bdm: DeploymentManager,
  governor: Contract,
  timelock: Contract
): Promise<void> {
  const latest = await gdm.hre.ethers.provider.getBlock('latest');
  const B0 = BigInt(latest.number);
  const T0 = BigInt(latest.timestamp);

  const blockStart = B0 + 1n;
  const blockEnd = blockStart + 1n;
  const blockCast = blockEnd;
  const blockQueue = blockCast + 1n;
  const blockExec = blockQueue + 3n;

  const tsShift = (t: bigint, dBlocks: bigint) => t + dBlocks * 12n;
  const timestampCast = tsShift(T0, blockCast - B0);
  const timestampQueue = tsShift(T0, blockQueue - B0);
  const timestampExec = tsShift(T0, blockExec - B0);

  const proposalArgs = loadCachedProposal();
  proposalArgs.pop();
  const id = BigInt(await governor.proposalCount());
  const govIF = new Interface(governor.interface.fragments);
  const signer = await gdm.getSigner();
  const fromAddr = await signer.getAddress();

  const patchTL = { '0x2': '0x' + '00'.repeat(64) };

  const packed = (1n << 48n) | 1n;
  const rawGS = gdm.hre.ethers.utils.hexZeroPad(
    gdm.hre.ethers.BigNumber.from(packed).toHexString(),
    32
  );
  const keyGS =
    '0x00d7616c8fe29c6c2fbe1d0c5bc8f2faa4c35b43746e70b24b4d532752affd01';

  const basePLQ = BigInt(
    '0x042f525fd47e44d02e065dd7bb464f47b4f926fbd05b5e087891ebd756adf100'
  );
  const slotVoteExt = '0x' + basePLQ.toString(16).padStart(64, '0');
  const slotMapRoot = '0x' + (basePLQ + 1n).toString(16).padStart(64, '0');
  const slotExtDead = gdm.hre.ethers.utils.keccak256(
    gdm.hre.ethers.utils.defaultAbiCoder.encode(
      ['uint256', 'bytes32'],
      [id, slotMapRoot]
    )
  );

  const patchGov = {
    [keyGS]: rawGS,
    [slotVoteExt]: '0x' + '00'.repeat(64),
    [slotExtDead]: '0x' + '00'.repeat(64),
  };

  const statePatch = {
    [timelock.address]: { storage: patchTL },
    [governor.address]: { storage: patchGov },
  };

  const whales =
    gdm.network === 'mainnet' ? COMP_WHALES.mainnet : COMP_WHALES.testnet;

  const deployBytecodes = loadCachedBytecodes();
  const chainId1 = gdm.hre.ethers.provider.network.chainId;

  const simsL1 = [
    ...deployBytecodes.map((code) => ({
      network_id: chainId1,
      from: fromAddr,
      to: '',
      block_number: Number(B0),
      block_header: { timestamp: gdm.hre.ethers.utils.hexlify(T0) },
      input: gdm.hre.ethers.utils.hexlify(code),
      state_objects: statePatch,
      save: true,
      gas_price: 0,
      gas_limit: 16_777_215,
    })),
    {
      network_id: chainId1.toString(),
      from: fromAddr,
      to: governor.address,
      block_number: Number(B0),
      block_header: { timestamp: gdm.hre.ethers.utils.hexlify(T0) },
      input: govIF.encodeFunctionData('propose', proposalArgs),
      state_objects: statePatch,
      save: true,
      gas_price: 0,
      gas_limit: 16_777_215,
    },
    ...whales.map((w) => ({
      network_id: chainId1.toString(),
      from: w,
      to: governor.address,
      block_number: Number(blockCast),
      block_header: { timestamp: gdm.hre.ethers.utils.hexlify(timestampCast) },
      input: govIF.encodeFunctionData('castVote', [id, 1]),
      state_objects: statePatch,
      save: true,
      save_if_fails: true,
      gas_price: 0,
      gas_limit: 16_777_215,
    })),
    {
      network_id: chainId1.toString(),
      from: fromAddr,
      to: governor.address,
      block_number: Number(blockQueue),
      block_header: { timestamp: gdm.hre.ethers.utils.hexlify(timestampQueue) },
      input: govIF.encodeFunctionData('queue', [id]),
      state_objects: statePatch,
      save: true,
      save_if_fails: true,
      gas_price: 0,
      gas_limit: 16_777_215,
    },
    {
      network_id: chainId1.toString(),
      from: fromAddr,
      to: governor.address,
      block_number: Number(blockExec),
      block_header: { timestamp: gdm.hre.ethers.utils.hexlify(timestampExec) },
      input: govIF.encodeFunctionData('execute', [id]),
      state_objects: statePatch,
      save: true,
      save_if_fails: true,
      gas_price: 0,
      gas_limit: 16_777_215,
    },
  ];

  console.log(`\n========================== TENDERLY ==========================\n`);

  console.log(`\nExecuting Tenderly simulation for proposal ${id}...`);
  const bundle = await simulateBundle(gdm, simsL1, Number(B0));
  console.log(`Tenderly simulation bundle size: ${bundle.length}`);
  await shareSimulation(gdm, bundle[bundle.length - 1].simulation.id);

  const exec1 = bundle[bundle.length - 1].simulation;

  console.log(` >>> PROPOSAL EXECUTED  ${id}`);
  console.log(`Simulation ${exec1.id} done, status: ${exec1.status}`);
  console.log(`Link: https://www.tdly.co/shared/simulation/${exec1.id} \n`);
  
  const bdms = [bdm];
  for (const dm of gdm.bridgedDeploymentManagers.values()) {
    if (!bdms.includes(dm)) {
      bdms.push(dm);
    }
  }

  // make bdm contain only 1 dm per network
  const uniqueBdms = new Map();
  for (const dm of bdms) {
    const chainId = dm.hre.ethers.provider.network.chainId;
    if (!uniqueBdms.has(chainId)) {
      uniqueBdms.set(chainId, dm);
    }
  }
  bdms.length = 0;
  bdms.push(...uniqueBdms.values());


  for (const currentBdm of bdms) {
    const chainId2 = currentBdm.hre.ethers.provider.network.chainId;
    let proposals;
    if (chainId1 !== chainId2) {
      const relayPath = path.resolve(__dirname, '../../cache/relay.json');
      if (existsSync(relayPath)) unlinkSync(relayPath);

      proposals = await relayMessage(gdm, currentBdm, parseFloat(B0.toString()), bundle[bundle.length - 1].transaction.transaction_info.logs);

      debug(`Proposals relayed to ${currentBdm.network}: ${proposals?.length ?? 0}`);
      
      if (proposals && proposals.length > 0) {
        const timelockL2 = await currentBdm.getContractOrThrow('timelock');
        const delay = await timelockL2.delay();
        const relayMessages = loadCachedRelayMessages();
        const executeProposalSig = utils.id('executeProposal(uint256)').substring(0, 10);

        const latestL2 = await currentBdm.hre.ethers.provider.getBlock('latest');
        const maxEta = Math.max(...proposals.map(p => Number(p.eta || 0))) + delay.toNumber();
        const T0L2 = Math.max(latestL2.timestamp, maxEta + 1);
        const B0L2 = Number(latestL2.number) + 1;

        let previousBlock = latestL2.number;
        let previousTimestamp = T0L2;
        const simsL2 = relayMessages.map((msg) => {
          let block = previousBlock;
          let timestamp = previousTimestamp;

          if (msg.callData.startsWith(executeProposalSig) && !msg.eta) {
            block = block + 1;
            timestamp = timestamp + delay.toNumber() + 1;
          }

          previousBlock = block;
          previousTimestamp = timestamp;

          return {
            network_id: chainId2.toString(),
            from: msg.signer,
            to: msg.messenger,
            block_number: Number(block),
            block_header: {
              timestamp: currentBdm.hre.ethers.utils.hexlify(Number(timestamp))
            },
            input: msg.callData,
            save: true,
            save_if_fails: true,
            gas_price: 0,
          };
        });

        if (simsL2.length > 0) {
          const bundle2 = await simulateBundle(currentBdm, simsL2, Number(B0L2));
          
          // filter from bundle every entry with simulation.input that starts with 0x0d61b519 i.e. executeProposal(uint256)
          const filteredBundle = bundle2.filter(entry => entry.simulation.input.startsWith(executeProposalSig));
          for (const sim of filteredBundle) {
            await shareSimulation(currentBdm, sim.simulation.id);
            console.log(`\nRelayed to ${currentBdm.network}`);
            console.log(`Simulation ${sim.simulation.id} done, status: ${sim.simulation.status}`);
            console.log(`Link: https://www.tdly.co/shared/simulation/${sim.simulation.id} \n`);
          }
        }
      }
    }
  }

  console.log(`\n================================================================\n`);
}

/*
Alternative to tenderlyExecute() that runs the migration's cached proposal through the real
governor on a Tenderly Virtual TestNet (a persistent, sharable fork), instead of chaining together
stateless Tenderly simulate-bundle calls. propose(), queue() and execute() are all real
transactions, exactly as governance requires; only the vote itself is skipped.

governanceDm is the deployment manager for the network that hosts the governor (e.g. mainnet).
marketDm is the deployment manager for the market actually being migrated - for a non-bridged
market (e.g. mainnet USDC) this is the exact same deployment manager as governanceDm; for a
bridged market (e.g. Base WETH) it's the L2 side, and its own Virtual TestNet is only created if
the proposal needs relaying there.
*/
export async function tenderlyVnetExecute(
  governanceDm: DeploymentManager,
  marketDm: DeploymentManager,
  governor: Contract,
  _timelock: Contract
): Promise<void> {
  console.log(`\n========================== TENDERLY VNET ==========================\n`);

  const governanceVnet = await getOrCreateVirtualTestnet(governanceDm);
  console.log(`Virtual TestNet ready for ${governanceDm.network}`);
  console.log(`  Public RPC: ${governanceVnet.publicRpcUrl}`);
  if (governanceVnet.dashboardUrl) {
    console.log(`  Dashboard:  ${governanceVnet.dashboardUrl}`);
  }

  const governanceVnetEnv = await vnetHreForBase(governanceDm.network, governanceVnet.adminRpcUrl);
  const governanceVnetDm = new DeploymentManager(governanceDm.network, governanceDm.deployment, governanceVnetEnv, {
    writeCacheToDisk: false,
    verificationStrategy: 'lazy',
  });

  const governanceVnetProvider = governanceVnetDm.hre.ethers.provider;
  const vnetGovernor = governor.connect(governanceVnetProvider);

  const proposalArgs = loadCachedProposal();
  proposalArgs.pop(); // drop signatures; governor.propose(targets, values, calldatas, description)

  const deployBytecodes = loadCachedBytecodes();
  const proposerAddress = await (await governanceDm.getSigner()).getAddress();

  await setEtherBalance(governanceVnetDm, proposerAddress, 10n ** 20n);
  const proposerSigner = await governanceVnetDm.getSigner(proposerAddress);

  for (const code of deployBytecodes) {
    const tx = await proposerSigner.sendTransaction({ data: utils.hexlify(code) });
    await tx.wait();
  }

  console.log('Submitting proposal to Virtual TestNet governor...');

  const proposeTx = await vnetGovernor.connect(proposerSigner).propose(...proposalArgs);
  const proposeReceipt: ContractReceipt = await proposeTx.wait();
  const proposeEvent = proposeReceipt.events.find((event: Event) => event.event === 'ProposalCreated');
  const [proposalId] = proposeEvent.args;
  console.log(`Proposal ${proposalId.toString()} submitted on Virtual TestNet`);

  await forceProposalVotesSucceeded(governanceVnetProvider, vnetGovernor.address, proposalId);

  const deadline = (await vnetGovernor.proposalDeadline(proposalId)).toNumber();
  const currentBlock = await governanceVnetProvider.getBlockNumber();
  if (currentBlock <= deadline) {
    await governanceVnetProvider.send('evm_increaseBlocks', [utils.hexlify(deadline - currentBlock + 1)]);
  }

  const startingBlockNumber = await governanceVnetProvider.getBlockNumber();

  console.log(`Queueing proposal ${proposalId.toString()} (vote skipped via state override)...`);
  const queueTx = await vnetGovernor.connect(proposerSigner)['queue(uint256)'](proposalId);
  await queueTx.wait();

  const eta = (await vnetGovernor.proposalEta(proposalId)).toNumber();
  const latestBlock = await governanceVnetProvider.getBlock('latest');
  if (latestBlock.timestamp <= eta) {
    await governanceVnetProvider.send('evm_setNextBlockTimestamp', [eta + 1]);
    await governanceVnetProvider.send('evm_mine', []);
  }

  console.log('Updating CCIP prices...');
  await updateCCIPStats(governanceVnetDm);

  console.log(`Executing proposal ${proposalId.toString()}...`);
  const executeTx = await vnetGovernor.connect(proposerSigner)['execute(uint256)'](proposalId, { gasLimit: 30_000_000 });
  await executeTx.wait();

  console.log(`\n >>> PROPOSAL EXECUTED ${proposalId.toString()} \n`);
  console.log(`Public RPC: ${governanceVnet.publicRpcUrl}`);
  if (governanceVnet.dashboardUrl) {
    console.log(`Dashboard:  ${governanceVnet.dashboardUrl}`);
  }

  // Collect every L2 this proposal touches: marketDm plus whatever the migration registered via
  // addBridgedDeploymentManager() (multichain proposals)
  const governanceChainId = governanceDm.hre.ethers.provider.network.chainId;
  const candidateL2Dms = [marketDm, ...governanceDm.bridgedDeploymentManagers.values()];
  const uniqueL2DmsByChainId = new Map<number, DeploymentManager>();
  for (const dm of candidateL2Dms) {
    const chainId = dm.hre.ethers.provider.network.chainId;
    if (chainId !== governanceChainId && !uniqueL2DmsByChainId.has(chainId)) {
      uniqueL2DmsByChainId.set(chainId, dm);
    }
  }
  const l2Dms = [...uniqueL2DmsByChainId.values()];

  if (l2Dms.length > 0) {
    await governanceVnetDm.spider();
  }

  for (const l2Dm of l2Dms) {
    try {
      const l2Vnet = await getOrCreateVirtualTestnet(l2Dm);
      console.log(`\nVirtual TestNet ready for ${l2Dm.network}`);
      console.log(`  Public RPC: ${l2Vnet.publicRpcUrl}`);
      if (l2Vnet.dashboardUrl) {
        console.log(`  Dashboard:  ${l2Vnet.dashboardUrl}`);
      }

      const l2VnetEnv = await vnetHreForBase(l2Dm.network, l2Vnet.adminRpcUrl);
      const l2VnetDm = new DeploymentManager(l2Dm.network, l2Dm.deployment, l2VnetEnv, {
        writeCacheToDisk: false,
        verificationStrategy: 'lazy',
      });
      await l2VnetDm.spider();
      await l2VnetDm.getSigner(proposerAddress);

      await relayMessage(governanceVnetDm, l2VnetDm, startingBlockNumber);

      console.log(`\n >>> PROPOSAL RELAYED to ${l2Dm.network} \n`);
      console.log(`Public RPC: ${l2Vnet.publicRpcUrl}`);
      if (l2Vnet.dashboardUrl) {
        console.log(`Dashboard:  ${l2Vnet.dashboardUrl}`);
      }
    } catch (e) {
      console.log(`\n >>> FAILED to relay to ${l2Dm.network}: ${e.message} \n`);
    }
  }

  console.log(`\n================================================================\n`);
}

async function simulateBundle(
  dm: DeploymentManager,
  simulations: any[],
  blockNumber: number = 0
): Promise<any> {
  const rollingStateChanges = {};
  const results = [];

  for (const sim of simulations) {
    const project = 'comet';
    const username = process.env.TENDERLY_USERNAME || '';
    const accessKey = process.env.TENDERLY_ACCESS_KEY || '';

    // Merge rolling state changes with simulation's own state_objects
    const stateObjects = sim.state_objects
      ? { ...rollingStateChanges, ...sim.state_objects }
      : rollingStateChanges;

    const body = {
      simulations: [{
        ...sim,
        state_objects: stateObjects,
        block_number: sim.block_number || blockNumber,
        simulation_type: 'full',
        save: true,
        save_if_fails: true,
      }]
    };

    const result = await axios.post(
      `https://api.tenderly.co/api/v1/account/${username}/project/${project}/simulate-bundle`,
      body,
      {
        headers: {
          'X-Access-Key': accessKey,
          'Content-Type': 'application/json',
        },
      }
    );

    // Extract and accumulate state changes from state_diff
    const simResult = result.data.simulation_results[0];
    if (simResult?.transaction?.transaction_info?.call_trace?.state_diff) {
      const stateDiff = simResult.transaction.transaction_info.call_trace.state_diff;

      // state_diff is an array of objects with { address, raw: [...] }
      for (const stateDiffEntry of stateDiff) {
        const address = stateDiffEntry.address;

        if (!rollingStateChanges[address]) {
          rollingStateChanges[address] = { storage: {} };
        }

        if (stateDiffEntry.raw && Array.isArray(stateDiffEntry.raw)) {
          for (const change of stateDiffEntry.raw) {
            // Each change has: { address, key, original, dirty }
            rollingStateChanges[address].storage[change.key] = change.dirty;
          }
        }
      }
    }

    results.push(simResult);
  }

  return results;
}

async function shareSimulation(dm: DeploymentManager, simulationId: string) {
  const project = 'comet';
  const username = process.env.TENDERLY_USERNAME || '';
  const accessKey = process.env.TENDERLY_ACCESS_KEY || '';

  return axios.post(
    `https://api.tenderly.co/api/v1/account/${username}/project/${project}/simulations/${simulationId}/share`,
    {},
    {
      headers: {
        'X-Access-Key': accessKey,
        'Content-Type': 'application/json',
      },
    }
  );
}

/*
Directly sets a proposal's forVotes tally high enough to satisfy both _quorumReached() and _voteSucceeded(),
without casting any real votes.
*/
async function forceProposalVotesSucceeded(
  vnetProvider: any,
  governorAddress: string,
  proposalId: BigNumber
): Promise<void> {
  const entrySlot = BigNumber.from(
    utils.keccak256(
      utils.defaultAbiCoder.encode(
        ['uint256', 'uint256'],
        [proposalId, GOV_COUNTING_FRACTIONAL_STORAGE_LOCATION]
      )
    )
  );
  const forVotesSlot = utils.hexZeroPad(entrySlot.add(1).toHexString(), 32);
  const forVotesValue = utils.hexZeroPad(BigNumber.from(10_000_000).mul(BigNumber.from(10).pow(18)).toHexString(), 32);
  await vnetProvider.send('tenderly_setStorageAt', [governorAddress, forVotesSlot, forVotesValue]);
}

function loadCachedProposal() {
  const file = path.resolve(
    __dirname,
    '../..',
    'cache',
    'currentProposal.json'
  );
  const json = JSON.parse(readFileSync(file, 'utf8'));

  return json;
}

function loadCachedRelayMessages() {
  const file = path.resolve(__dirname, '../../cache/relay.json');
  if (!existsSync(file)) {
    return [];
  }

  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) {
    return [];
  }
  return JSON.parse(raw);
}

function loadCachedBytecodes() {
  const file = path.resolve(__dirname, '../../cache/bytecodes.json');
  if (!existsSync(file)) {
    return [];
  }
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) {
    return [];
  }
  return JSON.parse(raw);
}
