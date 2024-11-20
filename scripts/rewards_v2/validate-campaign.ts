// Get some campaign
// Get some RPCs to verify
// Create reward with the same conditions, but with different RPCs
// Verify, that all the current users' accrue value is less then real current accrue

import hre from 'hardhat';
import fs from 'fs/promises'
import { CollectDataPayload, IncentivizationCampaignData } from './types';
import { generateMerkleTree, getMerklTreeProof, collectData } from './utils';
import { DeploymentManager } from '../../plugins/deployment_manager';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const F_ADDRESS = '0xffffffffffffffffffffffffffffffffffffffff'

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
const verifyTheSameFileGenerationUsingDifferentRPCProviders = async (campaign: IncentivizationCampaignData, rpcs: string[]) => {
    const { blockNumber, network, market, generatedTimestamp, type } = campaign
    const dm = new DeploymentManager(
        network,
        market,
        hre,
        {
            writeCacheToDisk: true,
            verificationStrategy: 'eager',
        }
    );
    const collectDataPayload: CollectDataPayload = {
        blockNumber,
        network,
        deployment: market,
        generatedTimestamp,
        type,
        dm,
        hre,
    }

    const { fileData, merklTree } = await collectData(collectDataPayload)
}

const main = async () => {
    const campaignName = '1730244663865-21074594-start.json'
    const campaign = await getCampaignData(campaignName, 'mainnet', 'usdt')
    logCommonCampaignData(campaign)
    verify0AndFAddressesInTheCampaign(campaign)
    verifyMerkleTreeIsSorted(campaign)
    verifyCorrectProofGenerationAndRootHashGeneration(campaign)

    // verify data fetching using another RPC providers
    // verify that the state of accrued values for all the users are less then 
    // the accrue values after the callStatic
};

main().then().catch(console.error);

