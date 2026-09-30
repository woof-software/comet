import SafeProtocolKit from '@safe-global/protocol-kit';
import type { SafeConfig } from '@safe-global/protocol-kit';
import { Contract, Wallet } from 'ethers';

import { DeploymentManager } from '../plugins/deployment_manager/DeploymentManager.js';
import { nonForkedHreForBase, forkedHreForBase } from '../plugins/scenario/utils/hreForBase.js';

const SRC_NETWORK = process.env['SRC_NETWORK'] ?? 'mainnet';
const DST_NETWORK = process.env['DST_NETWORK'] ?? 'hardhat';

interface SafeDeploymentTransaction {
  to: string;
  value: string;
  data: string;
}

interface SafeInstance {
  createSafeDeploymentTransaction(): Promise<SafeDeploymentTransaction>;
  getAddress(): Promise<string>;
}

const Safe = SafeProtocolKit as unknown as {
  init(config: SafeConfig): Promise<SafeInstance>;
};

async function main() {
  const hreSRC = await forkedHreForBase({ name: SRC_NETWORK, network: SRC_NETWORK, deployment: '' });
  const sourceConnection = await hreSRC.network.getOrCreate();

  const dm = new DeploymentManager(SRC_NETWORK, 'usdc', hreSRC);

  const comet = await dm.contract('comet');
  const guardian = await comet.pauseGuardian();

  // Get owners and threshold from existing multisig
  const GnosisABI = [
    {'constant':true,'inputs':[],'name':'getOwners','outputs':[{'internalType':'address[]','name':'','type':'address[]'}],'payable':false,'stateMutability':'view','type':'function'},
    {'constant':true,'inputs':[],'name':'getThreshold','outputs':[{'internalType':'uint256','name':'','type':'uint256'}],'payable':false,'stateMutability':'view','type':'function'},
  ];
  const GnosisSafeContract = new Contract(guardian, GnosisABI, sourceConnection.ethers.provider);
  const owners = [...await GnosisSafeContract.getOwners()] as string[];
  const threshold = Number(await GnosisSafeContract.getThreshold());
  const safeAccountConfig = { owners, threshold };
  console.log(safeAccountConfig);
  console.log(guardian);

  const hreDST = await nonForkedHreForBase({ name: '', network: DST_NETWORK, deployment: '' });
  const destinationConnection = await hreDST.network.getOrCreate();
  const privateKey = process.env.ETH_PK;
  if (!privateKey) {
    throw new Error('Missing required environment variable: ETH_PK');
  }
  const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new Wallet(normalizedPrivateKey, destinationConnection.ethers.provider);

  const protocolKit = await Safe.init({
    provider: destinationConnection.provider,
    signer: normalizedPrivateKey,
    predictedSafe: { safeAccountConfig },
  });
  const deploymentTransaction = await protocolKit.createSafeDeploymentTransaction();
  const transaction = await wallet.sendTransaction({
    to: deploymentTransaction.to,
    value: BigInt(deploymentTransaction.value),
    data: deploymentTransaction.data,
  });
  await transaction.wait();

  console.log(`Safe deployed at ${await protocolKit.getAddress()}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
