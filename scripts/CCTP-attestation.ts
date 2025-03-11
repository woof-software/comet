/*
 A script to help check if CCTP's attestation server to acquire signature to mint native USDC on arbitrum
 Example: 
 DEPLOYMENT=usdc BURN_TXN_HASH=<burn_txn_hash> SOURCE_NETWORK=sepolia DEST_NETWORK=arbitrum-sepolia ETH_PK=<private_key> npx hardhat run scripts/CCTP-attestation.ts
*/
import { nonForkedHreForBase } from '../plugins/scenario/utils/hreForBase';

import { DeploymentManager } from '../plugins/deployment_manager/DeploymentManager';
import { requireEnv } from '../hardhat.config';

async function main() {
  const DEPLOYMENT = requireEnv('DEPLOYMENT');
  const BURN_TXN_HASH = requireEnv('BURN_TXN_HASH');
  const SOURCE_NETWORK = requireEnv('SOURCE_NETWORK');
  const DEST_NETWORK = requireEnv('DEST_NETWORK');
  
  const hreSRC = await nonForkedHreForBase({ name: SOURCE_NETWORK, network: SOURCE_NETWORK, deployment: '' });
  const src_dm = new DeploymentManager(SOURCE_NETWORK, DEPLOYMENT, hreSRC, {
    writeCacheToDisk: true
  });

  const circleAttestationApiHost = SOURCE_NETWORK === 'mainnet' ? 'https://iris-api.circle.com' : 'https://iris-api-sandbox.circle.com';
  const transactionReceipt = await src_dm.hre.ethers.provider.getTransactionReceipt(BURN_TXN_HASH);
  const eventTopic = src_dm.hre.ethers.utils.id('MessageSent(bytes)');
  const log = transactionReceipt.logs.find((l) => l.topics[0] === eventTopic);
  const messageBytes = src_dm.hre.ethers.utils.defaultAbiCoder.decode(['bytes'], log.data)[0];
  const messageHash = src_dm.hre.ethers.utils.keccak256(messageBytes);
  console.log(`Message hash: ${messageHash}`);
  let attestationResponse = { status: 'pending', attestation: ''};
  while (attestationResponse.status != 'complete') {
    console.log(`Polling... ${circleAttestationApiHost}/attestations/${messageHash}`);
    const response = await fetch(`${circleAttestationApiHost}/attestations/${messageHash}`);
    attestationResponse = await response.json();
    // attestationResponse = { status: 'complete', attestation: '0xe98af27614d419950026763b66eb4e21fc37afb9c95e42b058c42ceb6579537739a391864676aa1c5316f9c8dedafcc7c54b26d2c6be0e63bb0a333dcbc17c0c1b21c71e36c98119cf0898671e895d7aa72ef8f12c046aa07f7be35814595658512420a98a1a2b154e3a757e58d4fbf98cd6d5d98f5338a62aee51752008b7effd1b'};

    console.log(`Response: ${JSON.stringify(attestationResponse)}`);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`Attestation complete, proceeding to mint native usdc on ${DEST_NETWORK}:`);
  console.log(`------Parameters value------`);
  console.log(`receivingMessageBytes: ${messageBytes}`);
  console.log(`signature: ${attestationResponse.attestation}`);
  console.log(`----------------------------`);
  /*
    const transactionRequest = await signer.populateTransaction({
      to: CCTPMessageTransmitter.address,
      from: signer.address,
      data: CCTPMessageTransmitter.interface.encodeFunctionData('receiveMessage', [messageBytes, attestationResponse.attestation]),
      gasPrice: Math.ceil(1.3 * (await hre.ethers.provider.getGasPrice()).toNumber())
    });
  */
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
