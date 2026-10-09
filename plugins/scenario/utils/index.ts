import { DeploymentManager } from '../../../plugins/deployment_manager/index.js';
import type { ExtendedNonceManager } from '../../deployment_manager/NonceManager.js';
import { getHardhatEthers } from '../../deployment_manager/hardhat3/runtime.js';

export async function impersonateAddress(dm: DeploymentManager, address: string, value?: bigint): Promise<ExtendedNonceManager> {
  if (value) {
    const signer = await dm.getSigner();
    await signer.sendTransaction({ to: address, value });
  }
  const { provider } = await getHardhatEthers(dm.hre);
  await provider.send('hardhat_impersonateAccount', [address]);
  return await dm.getSigner(address);
}
