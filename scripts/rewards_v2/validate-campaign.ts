// Get some campaign
// Get some RPCs to verify
// Create reward with the same conditions, but with different RPCs
// Verify, that all the current users' accrue value is less then real current accrue

import hre from 'hardhat';
import { ethers } from 'ethers'
import fs from 'fs/promises'
import { CollectDataPayload, IncentivizationCampaignData } from './types';
import { generateMerkleTree, getMerklTreeProof, collectData } from './utils';
import { DeploymentManager } from '../../plugins/deployment_manager';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const F_ADDRESS = '0xffffffffffffffffffffffffffffffffffffffff'

const setCustomProvider = (rpcUrl: string) => {
    hre.ethers.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
};

const getCampaignData = async (fileName: string, network: string, deployment: string): Promise<IncentivizationCampaignData> => {
    if (!fileName.endsWith('.json')) {
        fileName = `${fileName}.json`
    }
    const file = await fs.readFile(`./campaigns/${network}-${deployment}/${fileName}`)
    const data = JSON.parse(file.toString()) as IncentivizationCampaignData

    if (!data || !data.root) {
        throw new Error(`Campaign ${fileName} does not exist`)
    }

    return data
}

const logCommonCampaignData = (data: IncentivizationCampaignData): void => {
    const addressesInCampaign = Object.keys(data.data)
    const excludeZeroAndFAddresses = addressesInCampaign.filter((value) => ![ZERO_ADDRESS, F_ADDRESS].includes(value.toLocaleLowerCase()))
    const commonInfo = { root: data.root, network: data.network, market: data.market, type: data.type, endBlockNumber: data.blockNumber, startBlockNumber: data.startBlock, generatedTymestamp: data.generatedTimestamp, amountOfAddresses: addressesInCampaign.length, amountOfUsersWithoutZeroAndFAddresses: excludeZeroAndFAddresses.length }
    console.table(commonInfo)
}

const verify0AndFAddressesInTheCampaign = (data: IncentivizationCampaignData) => {
    const addressesInCampaign = Object.keys(data.data)
    // should add lower case?
    if (addressesInCampaign[0] !== ZERO_ADDRESS || addressesInCampaign[addressesInCampaign.length - 1] !== F_ADDRESS) {
        throw new Error(`${ZERO_ADDRESS} Should be the first address and ${F_ADDRESS} should be the last address`)
    }

    if (data.data[ZERO_ADDRESS].accrue !== '0') {
        throw new Error(`Accrue for ${ZERO_ADDRESS} is wrong. It should be 0`)
    }

    if (data.data[F_ADDRESS].accrue !== '0') {
        throw new Error(`Accrue for ${F_ADDRESS} is wrong. It should be 0`)
    }

    if (data.data[ZERO_ADDRESS].index !== 0) {
        throw new Error(`Index of ${ZERO_ADDRESS} should be 0`)
    }

    if (data.data[F_ADDRESS].index !== addressesInCampaign.length - 1) {
        throw new Error(`Index of ${F_ADDRESS} should be ${addressesInCampaign.length - 1}`)
    }
}

const verifyMerkleTreeIsSorted = (data: IncentivizationCampaignData) => {
    const addresses = Object.keys(data.data)
    const sortedArray = addresses.sort((a, b) => a[0].localeCompare(b[0]))
    addresses.forEach((address, index) => {
        if (sortedArray[index] !== address) {
            throw new Error("Merkle tree is not sorted")
        }
    })

    addresses.forEach((address, index) => {
        if (data.data[address].index !== index) {
            throw new Error(`Address ${address} has a wrong index`)
        }
    })
}

const verifyTwoProofsAreEqual = (proof1: { proof: string[], v: string[] }, proof2: { proof: string[], v: string[] }) => {
    const proof1proof = proof1.proof
    const proof2proof = proof2.proof
    const proof1v = proof1.v
    const proof2v = proof2.v

    proof1proof.forEach((value, index) => {
        if (proof2proof[index] !== value) {
            throw new Error(`Wrong proofs. Regenerate the Merkle`)
        }
    })

    proof1v.forEach((value, index) => {
        if (proof2v[index] !== value) {
            throw new Error(`Wrong proofs. Regenerate the Merkle`)
        }
    })
}

const verifyCorrectProofGenerationAndRootHashGeneration = (data: IncentivizationCampaignData) => {
    const addresses = Object.keys(data.data)
    const proofs = addresses.map(address => data.data[address].proof)
    const payloadForProofGeneration = addresses.map(address => [address, data.data[address].index.toString(), data.data[address].accrue])
    const newGeneratedMerkleTree = generateMerkleTree(payloadForProofGeneration)
    const newProofs = payloadForProofGeneration.map(d => getMerklTreeProof(d[0], newGeneratedMerkleTree));

    proofs.forEach((proofPayload, index) => {
        verifyTwoProofsAreEqual(proofPayload, newProofs[index])
    })

    if (data.root !== newGeneratedMerkleTree.root) {
        throw new Error('Wrong root hash. Regenerate Merkle tree')
    }
}

// TODO collect the data using another RPCs and verify that the result is the same
const verifyTheSameFileGenerationUsingDifferentRPCProviders = async (
    campaign: IncentivizationCampaignData,
    rpcs: string[]
) => {
    const { blockNumber, network, market, generatedTimestamp, type } = campaign;
  
    console.log(`Verifying data collection consistency across multiple RPCs...`);
  
    const baseRpc = rpcs[0];
    setCustomProvider(baseRpc);
  
    const dmBaseline = new DeploymentManager(network, market, hre);
    const collectDataPayload: CollectDataPayload = {
      blockNumber,
      network,
      deployment: market,
      generatedTimestamp,
      type,
      dm: dmBaseline,
      hre,
    };
    const baselineResult = await collectData(collectDataPayload);
  
    for (let i = 1; i < rpcs.length; i++) {
      const rpc = rpcs[i];
      console.log(`Switching to RPC: ${rpc}`);
      setCustomProvider(rpc);
  
      const dm = new DeploymentManager(network, market, hre);
      const payload = { ...collectDataPayload, dm };
  
      console.log(`Collecting data from RPC: ${rpc}`);
      const result = await collectData(payload);
  
      console.log(`Comparing results with baseline RPC...`);

      if (JSON.stringify(baselineResult.fileData) !== JSON.stringify(result.fileData)) {
        throw new Error(`Data inconsistency detected between RPCs: ${baseRpc} and ${rpc}`);
      }
  
      if (baselineResult.merklTree.root !== result.merklTree.root) {
        throw new Error(`Merkle root mismatch detected between RPCs: ${baseRpc} and ${rpc}`);
      }
    }
  
    console.log(`All RPCs produced consistent results.`);
  };

  const validateUserAccrue = async (
    userAddress: string,
    campaign: IncentivizationCampaignData,
  ): Promise<void> => {
    const { data, blockNumber, root } = campaign;
  
    if (!data[userAddress]) {
      throw new Error(`User ${userAddress} is not included in the campaign data.`);
    }
  
    const recordedAccrue = data[userAddress].accrue;
    console.log(`Recorded accrue for user ${userAddress}: ${recordedAccrue}`);
  
    const provider = hre.ethers.provider;
    const cometContractAddress = '<COMET_CONTRACT_ADDRESS>';
    const cometAbi = [
      'function userBasic(address) view returns (int104 baseTrackingAccrued, uint64 baseTrackingIndex, uint64 baseBorrowIndex, uint16 rewardOwed, uint8 flags)',
    ];
    const comet = new ethers.Contract(cometContractAddress, cometAbi, provider);
  
    const [baseTrackingAccrued] = await comet.userBasic(userAddress, {
      blockTag: blockNumber,
    });
    const actualAccrue = baseTrackingAccrued.toString();
  
    console.log(`Actual accrue for user ${userAddress} at block ${blockNumber}: ${actualAccrue}`);
  
    if (recordedAccrue !== actualAccrue) {
      throw new Error(
        `Data mismatch for user ${userAddress}. Recorded: ${recordedAccrue}, Actual: ${actualAccrue}`
      );
    }

    const treeData = Object.entries(data).map(([address, { index, accrue }]) => [
      address,
      index.toString(),
      accrue,
    ]);
    const tree = generateMerkleTree(treeData);
    const proof = getMerklTreeProof(userAddress, tree);
  
    if (!proof) {
      throw new Error(`Unable to generate Merkle proof for user ${userAddress}.`);
    }
  
    console.log(`Validation successful for user ${userAddress}`);
  };

const main = async () => {
    const campaignName = '1730244663865-21074594-start.json'
    const campaign = await getCampaignData(campaignName, 'mainnet', 'usdt')
    const rpcUrls = [] // TODO add rps
    const userAddress = '0x1234567890abcdef1234567890abcdef12345678'; // todo change it

    logCommonCampaignData(campaign)
    verify0AndFAddressesInTheCampaign(campaign)
    verifyMerkleTreeIsSorted(campaign)
    verifyCorrectProofGenerationAndRootHashGeneration(campaign)

    // verify data fetching using another RPC providers
    await verifyTheSameFileGenerationUsingDifferentRPCProviders(campaign, rpcUrls);
    // verify that the state of accrued values for all the users are less then 
    // the accrue values after the callStatic

    try {
        await validateUserAccrue(userAddress, campaign);
    } catch (error) {
        console.error(`Validation failed for user ${userAddress}:`, error.message);
    }
};

main().then().catch(console.error);

