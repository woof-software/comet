import { BigNumber, Contract, utils } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { impersonateAddress } from '../../plugins/scenario/utils';

export const BRIDGE_ERC20_TO_SIGNATURE = 'bridgeERC20To(address,address,address,uint256,uint32,bytes)';
export const BRIDGE_ETH_TO_SIGNATURE = 'bridgeETHTo(address,uint32,bytes)';

const PORTAL_L2_SENDER_SLOT = utils.hexZeroPad('0x32', 32);
const MESSENGER_X_DOMAIN_SENDER_SLOT = '0xcc';
const DEFAULT_L2_SENDER = utils.hexZeroPad('0xdead', 32);

type OpStackL1Contracts = {
  networkLabel: string;
  l1Portal: string;
  l1CrossDomainMessenger: Contract;
  l1StandardBridge: Contract;
};

// Runs `finalize` as the impersonated L1 messenger, with the Portal's l2Sender and the messenger's
// xDomainMessageSender spoofed to the L2 messenger/bridge (a real relay needs an L2 output proof),
// then restores both slots.
async function asL1Messenger(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  { l1Portal, l1CrossDomainMessenger }: OpStackL1Contracts,
  ethValue: BigNumber,
  finalize: (messenger: Contract['signer']) => Promise<void>
): Promise<void> {
  const provider = governanceDeploymentManager.hre.network.provider;
  const l2Bridge = await bridgeDeploymentManager.getContractOrThrow('l2StandardBridge');
  const l2CrossDomainMessenger = await bridgeDeploymentManager.getContractOrThrow('l2CrossDomainMessenger');

  await provider.send('hardhat_setStorageAt', [l1Portal, PORTAL_L2_SENDER_SLOT, utils.hexZeroPad(l2CrossDomainMessenger.address, 32)]);
  await provider.send('hardhat_setStorageAt', [l1CrossDomainMessenger.address, MESSENGER_X_DOMAIN_SENDER_SLOT, utils.hexZeroPad(l2Bridge.address, 32)]);

  const messenger = await impersonateAddress(governanceDeploymentManager, l1CrossDomainMessenger.address);
  await provider.send('hardhat_setBalance', [
    messenger.address,
    utils.hexStripZeros(ethValue.add(utils.parseEther('1')).toHexString()),
  ]);

  await finalize(messenger);

  await provider.send('hardhat_setStorageAt', [l1Portal, PORTAL_L2_SENDER_SLOT, DEFAULT_L2_SENDER]);
  await provider.send('hardhat_setStorageAt', [l1CrossDomainMessenger.address, MESSENGER_X_DOMAIN_SENDER_SLOT, DEFAULT_L2_SENDER]);
}

// Finalizes a bridgeERC20To on L1 via finalizeBridgeERC20.
export async function simulateOpStackBridgeERC20To(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  calldata: string,
  opts: OpStackL1Contracts
): Promise<void> {
  const bridgeReceiver = await bridgeDeploymentManager.getContractOrThrow('bridgeReceiver');
  const [localToken, remoteToken, to, amount, , extraData] = utils.defaultAbiCoder.decode(
    ['address', 'address', 'address', 'uint256', 'uint32', 'bytes'],
    calldata
  );

  console.log(`Simulating ${opts.networkLabel} L2→L1 bridgeERC20To: ${amount.toString()} of ${remoteToken} to ${to}`);
  await asL1Messenger(governanceDeploymentManager, bridgeDeploymentManager, opts, BigNumber.from(0), async (messenger) => {
    await (
      await opts.l1StandardBridge.connect(messenger).finalizeBridgeERC20(
        remoteToken, localToken, bridgeReceiver.address, to, amount, extraData,
        { gasPrice: 0, gasLimit: 2_500_000 }
      )
    ).wait();
  });
}

// Finalizes a bridgeETHTo on L1 via finalizeBridgeETH, forwarding the bridged ETH.
export async function simulateOpStackBridgeETHTo(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  calldata: string,
  amount: BigNumber,
  opts: OpStackL1Contracts
): Promise<void> {
  const l2Timelock = await bridgeDeploymentManager.getContractOrThrow('timelock');
  const [to, , extraData] = utils.defaultAbiCoder.decode(['address', 'uint32', 'bytes'], calldata);

  console.log(`Simulating ${opts.networkLabel} L2→L1 bridgeETHTo: ${amount.toString()} wei to ${to}`);
  await asL1Messenger(governanceDeploymentManager, bridgeDeploymentManager, opts, amount, async (messenger) => {
    await (
      await opts.l1StandardBridge.connect(messenger).finalizeBridgeETH(
        l2Timelock.address, to, amount, extraData,
        { value: amount, gasPrice: 0, gasLimit: 2_500_000 }
      )
    ).wait();
  });
}
