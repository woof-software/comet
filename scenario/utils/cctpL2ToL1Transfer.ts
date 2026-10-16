import { Contract, utils } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { impersonateAddress } from '../../plugins/scenario/utils';

export const DEPOSIT_FOR_BURN_SIGNATURE = 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)';

// Mints a depositForBurn's amount on L1 via the TokenMinter, impersonating the L1 CCTPTokenMessenger.
export async function simulateCCTPL2ToL1Transfer(
  governanceDeploymentManager: DeploymentManager,
  bridgeDeploymentManager: DeploymentManager,
  calldata: string
): Promise<void> {
  const [amount, , mintRecipientBytes32, burnToken] = utils.defaultAbiCoder.decode(
    ['uint256', 'uint32', 'bytes32', 'address', 'bytes32', 'uint256', 'uint32'],
    calldata
  );
  const mintRecipient = utils.getAddress('0x' + utils.hexlify(mintRecipientBytes32).slice(-40));

  try {
    const l2CCTPTokenMessenger = await bridgeDeploymentManager.getContractOrThrow('CCTPMessageTransmitter');
    // Resolve L1 token via CCTP TokenMinter: burnToken (L2) → localToken (L1)
    const l1CCTPTokenMessenger = await governanceDeploymentManager.getContractOrThrow('CCTPTokenMessenger');
    const tokenMinterAddress = await l1CCTPTokenMessenger.localMinter();
    const L1TokenMinter = new Contract(
      tokenMinterAddress,
      ['function mint(uint32 sourceDomain, bytes32 burnToken, address recipientOne, address recipientTwo, uint256 amountOne, uint256 amountTwo) returns (address)'],
      await governanceDeploymentManager.getSigner()
    );
    const l1CCTPTokenMessengerSigner = await impersonateAddress(
      governanceDeploymentManager,
      l1CCTPTokenMessenger.address
    );
    await governanceDeploymentManager.hre.network.provider.send('hardhat_setBalance', [
      l1CCTPTokenMessengerSigner.address,
      '0x1000000000000000000',
    ]);
    const sourceDomain = await l2CCTPTokenMessenger.localDomain();
    const mintTx = await L1TokenMinter.connect(l1CCTPTokenMessengerSigner).mint(
      sourceDomain,
      utils.hexZeroPad(burnToken, 32),
      mintRecipient,
      L1TokenMinter.address, // mint to the token minter first, since some tokens (e.g. USDC) have a cap on max amount per mint, and the token minter can then transfer to the recipient
      amount,
      1
    );
    console.log('Simulated CCTP mint transaction:', mintTx.hash);
    await mintTx.wait();
  } catch (e) {
    console.log(`Warning: Could not simulate CCTP L2→L1 bridging for depositForBurn: ${e.message}`);
  }
}
