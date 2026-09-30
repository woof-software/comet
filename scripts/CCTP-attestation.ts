/*
 A script to help check if CCTP's attestation server to acquire signature to mint native USDC on arbitrum
 Example: 
 DEPLOYMENT=usdc BURN_TXN_HASH=<burn_txn_hash> SOURCE_NETWORK=sepolia DEST_NETWORK=arbitrum-sepolia ETH_PK=<private_key> npx hardhat run scripts/CCTP-attestation.ts
*/
import { AbiCoder, id, keccak256 } from 'ethers';

import { DeploymentManager } from '../plugins/deployment_manager/DeploymentManager.js';
import { nonForkedHreForBase } from '../plugins/scenario/utils/hreForBase.js';

const abiCoder = AbiCoder.defaultAbiCoder();

interface AttestationResponse {
  status: string;
  attestation: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main() {
  const DEPLOYMENT = requireEnv('DEPLOYMENT');
  const BURN_TXN_HASH = requireEnv('BURN_TXN_HASH');
  const SOURCE_NETWORK = requireEnv('SOURCE_NETWORK');
  const DEST_NETWORK = requireEnv('DEST_NETWORK');
  const sourceHre = await nonForkedHreForBase({
    name: SOURCE_NETWORK,
    network: SOURCE_NETWORK,
    deployment: DEPLOYMENT,
  });
  const sourceEthers = (await sourceHre.network.getOrCreate()).ethers;

  const circleAttestationApiHost = SOURCE_NETWORK === 'mainnet' ? 'https://iris-api.circle.com' : 'https://iris-api-sandbox.circle.com';
  const transactionReceipt = await sourceEthers.provider.getTransactionReceipt(BURN_TXN_HASH);
  if (!transactionReceipt) {
    throw new Error(`Transaction receipt not found: ${BURN_TXN_HASH}`);
  }
  const eventTopic = id('MessageSent(bytes)');
  const log = transactionReceipt.logs.find((l) => l.topics[0] === eventTopic);
  if (!log) {
    throw new Error('MessageSent event not found');
  }
  const messageBytes = abiCoder.decode(['bytes'], log.data)[0];
  const messageHash = keccak256(messageBytes);
  console.log(`Message hash: ${messageHash}`);
  let attestationResponse = { status: 'pending', attestation: ''};
  while (attestationResponse.status != 'complete') {
    console.log(`Polling... ${circleAttestationApiHost}/attestations/${messageHash}`);
    const response = await fetch(`${circleAttestationApiHost}/attestations/${messageHash}`);
    attestationResponse = await response.json() as AttestationResponse;
    console.log(`Response: ${JSON.stringify(attestationResponse)}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`Attestation complete, proceeding to mint native usdc on ${DEST_NETWORK}:`);
  console.log(`------Parameters value------`);
  console.log(`receivingMessageBytes: ${messageBytes}`);
  console.log(`signature: ${attestationResponse.attestation}`);
  console.log(`----------------------------`);
  const destinationHre = await nonForkedHreForBase({
    name: DEST_NETWORK,
    network: DEST_NETWORK,
    deployment: DEPLOYMENT,
  });
  const dest_dm = new DeploymentManager(DEST_NETWORK, DEPLOYMENT, destinationHre, {
    writeCacheToDisk: true
  });
  const destinationEthers = (await destinationHre.network.getOrCreate()).ethers;

  const CCTPMessageTransmitter = await dest_dm.getContractOrThrow('CCTPMessageTransmitter');
  const signer = await dest_dm.getSigner();
  const signerAddress = await signer.getAddress();
  const feeData = await destinationEthers.provider.getFeeData();
  if (feeData.gasPrice === null) {
    throw new Error('Gas price is unavailable');
  }
  const transactionRequest = await signer.populateTransaction({
    to: await CCTPMessageTransmitter.getAddress(),
    from: signerAddress,
    data: CCTPMessageTransmitter.interface.encodeFunctionData('receiveMessage', [messageBytes, attestationResponse.attestation]),
    gasPrice: feeData.gasPrice * 13n / 10n,
  });

  const mintTxn = await signer.sendTransaction(transactionRequest);

  console.log(`Mint completed, transaction hash: ${mintTxn.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
