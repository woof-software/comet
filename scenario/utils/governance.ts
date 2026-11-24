import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumberish, Contract, constants, utils } from 'ethers';
import { CometContext } from '../context/CometContext';
import { ProposalState, OpenProposal } from '../context/Gov';
import { exp } from './math';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { debug } from '../../plugins/deployment_manager/Utils';
import { COMP_WHALES } from '../../src/deploy';
import { BaseBridgeReceiver } from '../../build/types';
import relayMessage from './relayMessage';
import { updateCCIPStats } from './ccip';
import { mockAllRedstoneOracles, redeployRenzoOracle } from './oracles';
import { impersonateAddress, mineBlocks, setNextBaseFeeToZero, setNextBlockTimestamp } from './hreUtils';
import { isBridgeProposal } from './isBridgeProposal';

export async function voteForOpenProposal(
  dm: DeploymentManager,
  { id, startBlock, endBlock }: OpenProposal
) {
  const governor = await dm.getContractOrThrow('governor');
  const blockNow = await dm.hre.ethers.provider.getBlockNumber();
  const blocksUntilStart = startBlock.toNumber() - blockNow;
  const blocksUntilEnd =
    endBlock.toNumber() - Math.max(startBlock.toNumber(), blockNow);

  if (blocksUntilStart > 0) {
    await mineBlocks(dm, blocksUntilStart + 1);
  }

  const compWhales =
    dm.network === 'mainnet' ? COMP_WHALES.mainnet : COMP_WHALES.testnet;

  if (blocksUntilEnd > 0) {
    for (const whale of compWhales) {
      try {
        const voter = await impersonateAddress(dm, whale);
        await setNextBaseFeeToZero(dm);
        await governor.connect(voter).castVote(id, 1, { gasPrice: 0 });
      } catch (err) {
        debug(`Error while voting for ${whale}`, err.message);
      }
    }
  }
}

export async function executeOpenProposal(
  dm: DeploymentManager,
  { id, startBlock, endBlock }: OpenProposal
) {
  const governor = await dm.getContractOrThrow('governor');
  const blockNow = await dm.hre.ethers.provider.getBlockNumber();
  const blocksUntilEnd =
    endBlock.toNumber() - Math.max(startBlock.toNumber(), blockNow) + 1;

  if (blocksUntilEnd > 0) {
    await mineBlocks(dm, blocksUntilEnd);
  }

  if ((await governor.state(id)) == ProposalState.Succeeded) {
    await setNextBaseFeeToZero(dm);
    await governor.queue(id, { gasPrice: 0 });
  }

  // Execute proposal (maybe, w/ gas limit so we see if exec reverts, not a gas estimation error)
  if ((await governor.state(id)) == ProposalState.Queued) {
    const block = await dm.hre.ethers.provider.getBlock('latest');
    const eta = await (async () => {
      try {
        return await governor.proposalEta(id);
      }
      catch (err) {
        const proposal = await governor.proposals(id);
        return proposal.eta;
      }
    })();
    await setNextBlockTimestamp(
      dm,
      Math.max(block.timestamp, eta.toNumber()) + 1
    );

    await setNextBaseFeeToZero(dm);
    console.log(`Updating CCIP prices...`);
    await updateCCIPStats(dm);

    const tx = await governor.execute(id, { gasPrice: 0, gasLimit: 120000000 });
    const receipt = await tx.wait();

    if (receipt.gasUsed.toNumber() >= 16_777_215) {
      throw new Error('Execution may have failed due to hitting gas limit');
    }
  }

  await redeployRenzoOracle(dm);

  // mine a block
  await dm.hre.ethers.provider.send('evm_mine', []);
}

// Instantly executes some actions through the governance proposal process
export async function fastGovernanceExecute(
  dm: DeploymentManager,
  proposer: SignerWithAddress,
  targets: string[],
  values: BigNumberish[],
  signatures: string[],
  calldatas: string[]
) {
  const governor = await dm.getContractOrThrow('governor');

  await setNextBaseFeeToZero(dm);

  const proposeTxn =
    dm.network === 'mainnet'
      ? await (
        await governor.connect(proposer).propose(
          targets,
          values,
          calldatas.map((calldata, i) => {
            return utils.id(signatures[i]).slice(0, 10) + calldata.slice(2);
          }),
          'FastExecuteProposal',
          { gasPrice: 0 }
        )
      ).wait()
      : await (
        await testnetPropose(
          dm,
          proposer,
          targets,
          values,
          signatures,
          calldatas,
          'FastExecuteProposal',
          0
        )
      ).wait();
  const proposeEvent = proposeTxn.events.find(
    (event) => event.event === 'ProposalCreated'
  );
  const [id, , , , , , startBlock, endBlock] = proposeEvent.args;

  await voteForOpenProposal(dm, {
    id,
    proposer: proposer.address,
    targets,
    values,
    signatures,
    calldatas,
    startBlock,
    endBlock,
  });
  await executeOpenProposal(dm, {
    id,
    proposer: proposer.address,
    targets,
    values,
    signatures,
    calldatas,
    startBlock,
    endBlock,
  });
}

export async function createCrossChainProposal(
  context: CometContext,
  l2ProposalData: string,
  bridgeReceiver: BaseBridgeReceiver
) {
  const govDeploymentManager = context.world.auxiliaryDeploymentManager!;
  const bridgeDeploymentManager = context.world.deploymentManager!;
  const proposer = await context.getProposer();
  const bridgeNetwork = bridgeDeploymentManager.network;
  const targets: string[] = [];
  const values: BigNumberish[] = [];
  const signatures: string[] = [];
  const calldata: string[] = [];

  // Create the chain-specific wrapper around the L2 proposal data
  switch (bridgeNetwork) {
    case 'arbitrum': {
      const inbox = await govDeploymentManager.getContractOrThrow(
        'arbitrumInbox'
      );
      const refundAddress = constants.AddressZero;
      const createRetryableTicketCalldata = utils.defaultAbiCoder.encode(
        [
          'address',
          'uint256',
          'uint256',
          'address',
          'address',
          'uint256',
          'uint256',
          'bytes',
        ],
        [
          bridgeReceiver.address, // address to,
          0, // uint256 l2CallValue,
          0, // uint256 maxSubmissionCost,
          refundAddress, // address excessFeeRefundAddress,
          refundAddress, // address callValueRefundAddress,
          0, // uint256 gasLimit,
          0, // uint256 maxFeePerGas,
          l2ProposalData, // bytes calldata data
        ]
      );
      targets.push(inbox.address);
      values.push(0);
      signatures.push(
        'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)'
      );
      calldata.push(createRetryableTicketCalldata);
      break;
    }
    case 'base': {
      const sendMessageCalldata = utils.defaultAbiCoder.encode(
        ['address', 'bytes', 'uint32'],
        [bridgeReceiver.address, l2ProposalData, 1_000_000] // XXX find a reliable way to estimate the gasLimit
      );
      const baseL1CrossDomainMessenger =
        await govDeploymentManager.getContractOrThrow(
          'baseL1CrossDomainMessenger'
        );

      targets.push(baseL1CrossDomainMessenger.address);
      values.push(0);
      signatures.push('sendMessage(address,bytes,uint32)');
      calldata.push(sendMessageCalldata);
      break;
    }
    case 'polygon': {
      const sendMessageToChildCalldata = utils.defaultAbiCoder.encode(
        ['address', 'bytes'],
        [bridgeReceiver.address, l2ProposalData]
      );
      const fxRoot = await govDeploymentManager.getContractOrThrow('fxRoot');

      targets.push(fxRoot.address);
      values.push(0);
      signatures.push('sendMessageToChild(address,bytes)');
      calldata.push(sendMessageToChildCalldata);
      break;
    }
    case 'linea': {
      const sendMessageCalldata = utils.defaultAbiCoder.encode(
        ['address', 'uint256', 'bytes'],
        [bridgeReceiver.address, 0, l2ProposalData]
      );
      const lineaMessageService = await govDeploymentManager.getContractOrThrow(
        'lineaMessageService'
      );
      targets.push(lineaMessageService.address);
      values.push(0);
      signatures.push('sendMessage(address,uint256,bytes)');
      calldata.push(sendMessageCalldata);
      break;
    }
    case 'optimism': {
      const sendMessageCalldata = utils.defaultAbiCoder.encode(
        ['address', 'bytes', 'uint32'],
        [bridgeReceiver.address, l2ProposalData, 2_500_000]
      );
      const opL1CrossDomainMessenger =
        await govDeploymentManager.getContractOrThrow(
          'opL1CrossDomainMessenger'
        );

      targets.push(opL1CrossDomainMessenger.address);
      values.push(0);
      signatures.push('sendMessage(address,bytes,uint32)');
      calldata.push(sendMessageCalldata);
      break;
    }
    case 'mantle': {
      const sendMessageCalldata = utils.defaultAbiCoder.encode(
        ['address', 'bytes', 'uint256'],
        [bridgeReceiver.address, l2ProposalData, 2_500_000]
      );
      const mantleL1CrossDomainMessenger =
        await govDeploymentManager.getContractOrThrow(
          'mantleL1CrossDomainMessenger'
        );
      targets.push(mantleL1CrossDomainMessenger.address);
      values.push(0);
      signatures.push('sendMessage(address,bytes,uint32)');
      calldata.push(sendMessageCalldata);
      break;
    }
    case 'unichain': {
      const sendMessageCalldata = utils.defaultAbiCoder.encode(
        ['address', 'bytes', 'uint256'],
        [bridgeReceiver.address, l2ProposalData, 2_500_000]
      );
      const unichainL1CrossDomainMessenger =
        await govDeploymentManager.getContractOrThrow(
          'unichainL1CrossDomainMessenger'
        );
      targets.push(unichainL1CrossDomainMessenger.address);
      values.push(0);
      signatures.push('sendMessage(address,bytes,uint32)');
      calldata.push(sendMessageCalldata);
      break;
    }
    case 'scroll': {
      const sendMessageCalldata = utils.defaultAbiCoder.encode(
        ['address', 'uint256', 'bytes', 'uint256'],
        [bridgeReceiver.address, 0, l2ProposalData, 1_000_000] // XXX find a reliable way to estimate the gasLimit
      );
      const scrollMessenger = await govDeploymentManager.getContractOrThrow(
        'scrollMessenger'
      );
      targets.push(scrollMessenger.address);
      values.push(exp(1, 18)); // XXX fees are paid via msg.value
      signatures.push('sendMessage(address,uint256,bytes,uint256)');
      calldata.push(sendMessageCalldata);
      break;
    }
    case 'ronin': {
      const l1CCIPRouter = await govDeploymentManager.getContractOrThrow(
        'l1CCIPRouter'
      );

      targets.push(l1CCIPRouter.address);
      values.push(utils.parseEther('0.5'));

      const destinationChainSelector = '6916147374840168594';

      const args = [
        destinationChainSelector,
        [
          utils.defaultAbiCoder.encode(['address'], [bridgeReceiver.address]),
          l2ProposalData,
          [],
          constants.AddressZero,
          '0x',
        ],
      ];

      const data = utils.defaultAbiCoder.encode(
        ['uint64', '(bytes,bytes,(address,uint256)[],address,bytes)'],
        args
      );

      signatures.push(
        'ccipSend(uint64,(bytes,bytes,(address,uint256)[],address,bytes))'
      );
      calldata.push(data);
      break;
    }
    default:
      throw new Error(
        `No cross-chain proposal constructor implementation for ${govDeploymentManager.network} -> ${bridgeNetwork}`
      );
  }

  await fastL2GovernanceExecute(
    govDeploymentManager,
    bridgeDeploymentManager,
    proposer,
    targets,
    values,
    signatures,
    calldata
  );
}

export async function executeOpenProposalAndRelay(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  openProposal: OpenProposal
) {
  const startingBlockNumber =
    await governanceDeploymentManager.hre.ethers.provider.getBlockNumber();
  await executeOpenProposal(governanceDeploymentManager, openProposal);

  console.log(`Executed proposal ${openProposal.id} on ${governanceDeploymentManager.network}, checking if relay to ${bridgeDeploymentManager.network} is needed...`);

  const bridgeManagers = await isBridgeProposal(
    governanceDeploymentManager,
    bridgeDeploymentManager,
    openProposal
  );

  for (const bridgeManager of bridgeManagers) {
    await mockAllRedstoneOracles(bridgeManager);
    console.log(`All Redstone oracles on ${bridgeManager.network} are mocked`);
    await relayMessage(
      governanceDeploymentManager,
      bridgeManager,
      startingBlockNumber
    );
  }
}

async function fastL2GovernanceExecute(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  proposer: SignerWithAddress,
  targets: string[],
  values: BigNumberish[],
  signatures: string[],
  calldatas: string[]
) {
  const startingBlockNumber =
    await governanceDeploymentManager.hre.ethers.provider.getBlockNumber();
  await fastGovernanceExecute(
    governanceDeploymentManager,
    proposer,
    targets,
    values,
    signatures,
    calldatas
  );

  await relayMessage(
    governanceDeploymentManager,
    bridgeDeploymentManager,
    startingBlockNumber
  );
}

async function testnetPropose(
  dm: DeploymentManager,
  proposer: SignerWithAddress,
  targets: string[],
  values: BigNumberish[],
  signatures: string[],
  calldatas: string[],
  description: string,
  gasPrice: BigNumberish
) {
  const governor = await dm.getContractOrThrow('governor');
  const testnetGovernor = new Contract(
    governor.address,
    [
      'function propose(address[] memory targets, uint256[] memory values, string[] memory signatures, bytes[] memory calldatas, string memory description) external returns (uint256 proposalId)',
      'event ProposalCreated(uint256 proposalId, address proposer, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 startBlock, uint256 endBlock, string description)',
    ],
    governor.signer
  );

  return testnetGovernor
    .connect(proposer)
    .propose(targets, values, signatures, calldatas, description, { gasPrice });
}
