import { NonceManager } from 'ethers';
import type { TransactionRequest, TransactionResponse } from 'ethers';

export class ExtendedNonceManager extends NonceManager {
  async resetPendingNonce(): Promise<void> {
    this.reset();
  }

  async sendTransaction(transaction: TransactionRequest): Promise<TransactionResponse> {
    try {
      return await super.sendTransaction(transaction);
    } catch (error) {
      this.reset();
      throw error;
    }
  }
}
