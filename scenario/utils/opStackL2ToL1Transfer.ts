import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { impersonateAddress } from '../../plugins/scenario/utils';

export const BRIDGE_ERC20_TO_SIGNATURE = 'bridgeERC20To(address,address,address,uint256,uint32,bytes)';

// Finalizes a bridgeERC20To on L1: overrides the Portal's l2Sender and the messenger's
// xDomainMessageSender slots, then calls finalizeBridgeERC20 as the impersonated messenger.
export async function simulateOpStackBridgeERC20To(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  calldata: string,
  opts: {
    networkLabel: string;
    l1Portal: string;
    l1CrossDomainMessenger: Contract;
    l1StandardBridge: Contract;
  }
): Promise<void> {
  const { networkLabel, l1Portal, l1CrossDomainMessenger, l1StandardBridge } = opts;
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const l2Bridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');
  const l2CrossDomainMessenger = await bridgeDeploymentManager.getContractOrThrow('l2CrossDomainMessenger');

  const [localToken, remoteToken, to, amount, , extraData] = utils.defaultAbiCoder.decode(
    ['address', 'address', 'address', 'uint256', 'uint32', 'bytes'],
    calldata
  );

  console.log(`Simulating L2→L1 bridgeERC20To: ${amount.toString()} of ${remoteToken} to ${to}`);
  console.log('Setting up L1 state to simulate finalizeBridgeERC20...');
  console.log(`${networkLabel} L1 Portal address:`, l1Portal);
  console.log('Overriding slot', utils.hexZeroPad('0x32', 32));
  console.log('l2CrossDomainMessenger:', utils.hexZeroPad(l2CrossDomainMessenger.address, 32));
  await governanceDeploymentManager.hre.network.provider.send('hardhat_setStorageAt', [
    l1Portal,
    utils.hexZeroPad('0x32', 32),
    utils.hexZeroPad(l2CrossDomainMessenger.address, 32)
  ]);

  await governanceDeploymentManager.hre.network.provider.send('hardhat_setStorageAt', [
    l1CrossDomainMessenger.address,
    '0xcc',
    utils.hexZeroPad(l2Bridge.address, 32)
  ]);

  const domainMessengerSigner = await impersonateAddress(
    governanceDeploymentManager,
    l1CrossDomainMessenger.address
  );
  await governanceDeploymentManager.hre.network.provider.send('hardhat_setBalance', [
    domainMessengerSigner.address,
    utils.hexStripZeros(utils.parseEther('1').toHexString()),
  ]);

  await (
    await l1StandardBridge.connect(domainMessengerSigner).finalizeBridgeERC20(
      remoteToken, localToken, bridgeReceiver.address, to, amount, extraData,
      { gasPrice: 0, gasLimit: 2_500_000 }
    )
  ).wait();

  await governanceDeploymentManager.hre.network.provider.send('hardhat_setStorageAt', [
    l1Portal,
    utils.hexZeroPad('0x32', 32),
    utils.hexZeroPad('0xdead', 32)
  ]);
}
