import type { FlashbotsTransactionResponse, RelayResponseError } from '@flashbots/ethers-provider-bundle';
import type { TransactionRequest } from 'ethers';

import googleCloudLog, { LogSeverity } from './googleCloudLog.js';
import type { SignerWithFlashbots } from './liquidateUnderwaterBorrowers.js';

function isFlashbotsTxnResponse(bundleReceipt: FlashbotsTransactionResponse | RelayResponseError): bundleReceipt is FlashbotsTransactionResponse {
  return (bundleReceipt as FlashbotsTransactionResponse).bundleTransactions !== undefined;
}

async function sendFlashbotsBundle(
  txn: TransactionRequest,
  signerWithFlashbots: SignerWithFlashbots
): Promise<boolean> {
  const { FlashbotsBundleResolution } = await import('@flashbots/ethers-provider-bundle');
  const wallet = signerWithFlashbots.signer;
  const flashbotsProvider = signerWithFlashbots.flashbotsProvider;
  if (!flashbotsProvider) {
    throw new Error('Flashbots provider is required');
  }
  if (!wallet.provider) {
    throw new Error('Signer provider is required');
  }
  const bundle = [
    {
      signer: wallet,
      transaction: txn,
    }
  ] as unknown as Parameters<typeof flashbotsProvider.signBundle>[0];
  const signedBundle = await flashbotsProvider.signBundle(
    bundle
  );
  const bundleReceipt = await flashbotsProvider.sendRawBundle(
    signedBundle, // bundle we signed above
    await wallet.provider.getBlockNumber() + 1, // block number at which this bundle is valid
  );
  let success: boolean = false;
  if (isFlashbotsTxnResponse(bundleReceipt)) {
    const resolution = await bundleReceipt.wait();
    if (resolution === FlashbotsBundleResolution.BundleIncluded) {
      success = true;
      googleCloudLog(LogSeverity.INFO, 'Bundle included!');
    } else if (resolution === FlashbotsBundleResolution.BlockPassedWithoutInclusion) {
      // XXX alert if too many attempts are not included in a block
      success = false;
      googleCloudLog(LogSeverity.INFO, 'Block passed without inclusion');
    } else if (resolution === FlashbotsBundleResolution.AccountNonceTooHigh) {
      success = false;
      googleCloudLog(LogSeverity.ALERT, 'Account nonce too high');
    }
  } else {
    success = false;
    googleCloudLog(LogSeverity.ALERT, `Error while sending Flashbots bundle: ${bundleReceipt.error}`);
  }

  return success;
}

// XXX Note: Blocking txn, so we probably want to run these methods in separate threads
export async function sendTxn(
  txn: TransactionRequest,
  signerWithFlashbots: SignerWithFlashbots
): Promise<boolean> {
  if (signerWithFlashbots.flashbotsProvider) {
    googleCloudLog(LogSeverity.INFO, 'Sending a private txn via Flashbots');
    return await sendFlashbotsBundle(txn, signerWithFlashbots);
  } else {
    googleCloudLog(LogSeverity.INFO, 'Sending a public txn');
    // XXX confirm that txn.wait() throws if the txn reverts
    await (await signerWithFlashbots.signer.sendTransaction(txn)).wait();
    return true;
  }
}
