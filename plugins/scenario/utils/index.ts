import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { DeploymentManager } from '../../../plugins/deployment_manager';

export async function impersonateAddress(dm: DeploymentManager, address: string, value?: bigint): Promise<SignerWithAddress> {
  if (value) {
    const current = await dm.hre.ethers.provider.getBalance(address);
    const newBalance = current.toBigInt() + value;
    await dm.hre.network.provider.request({
      method: 'hardhat_setBalance',
      params: [address, dm.hre.ethers.utils.hexValue(newBalance)],
    });
  }
  await dm.hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [address],
  });
  return await dm.getSigner(address);
}
