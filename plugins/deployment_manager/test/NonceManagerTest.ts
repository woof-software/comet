import { expect } from 'chai';
import { strict as assert } from 'assert';
import { Wallet, providers } from 'ethers';
import { ExtendedNonceManager } from '../NonceManager';
import { deferred, flushPromises } from './TestHelpers';

describe('ExtendedNonceManager', () => {
  let signer: Wallet;
  let manager: ExtendedNonceManager;
  let nonces: number[];
  const submissionFailure = new Error('Transaction rejected');

  beforeEach(() => {
    // The signer is offline; these tests never submit blockchain transactions.
    signer = new Wallet('0x' + '11'.repeat(32));
    signer.getTransactionCount = async () => 7;
    nonces = [];
    manager = new ExtendedNonceManager(signer);
  });

  it('increments pending nonces for successful submissions', async () => {
    signer.sendTransaction = async transaction => {
      const nonce = Number(await transaction.nonce);
      nonces.push(nonce);
      return { nonce } as providers.TransactionResponse;
    };

    await manager.sendTransaction({ to: signer.address });
    await manager.sendTransaction({ to: signer.address });
    expect(nonces).to.eql([7, 8]);
  });

  it('reloads the chain nonce after a failed submission and reuses it on the next attempt', async () => {
    const reads: Array<providers.BlockTag | undefined> = [];
    signer.getTransactionCount = async tag => { reads.push(tag); return 7; };
    signer.sendTransaction = async transaction => {
      const nonce = Number(await transaction.nonce);
      nonces.push(nonce);
      if (nonces.length === 1) throw submissionFailure;
      return { nonce } as providers.TransactionResponse;
    };

    await assert.rejects(manager.sendTransaction({ to: signer.address }), error => error === submissionFailure);
    await flushPromises();
    await manager.sendTransaction({ to: signer.address });
    expect(reads).to.eql(['pending', undefined]);
    expect(nonces).to.eql([7, 7]);
  });

  it('waits for nonce reset completion before reporting a failed submission', async () => {
    const resetNonce = deferred<number>();
    let resetStarted = false;
    signer.getTransactionCount = async tag => {
      if (tag === 'pending') return 7;
      resetStarted = true;
      return resetNonce.promise;
    };
    signer.sendTransaction = async () => { throw submissionFailure; };
    let settled = false;
    const observed = manager.sendTransaction({ to: signer.address }).then(
      () => { settled = true; return undefined; },
      error => { settled = true; return error; }
    );

    try {
      await flushPromises();
      expect(resetStarted).to.equal(true);
      // Returning the failure early lets callers retry with stale nonce state.
      expect(settled).to.equal(false);
    } finally {
      resetNonce.resolve(9);
      await observed;
      await flushPromises();
    }
    expect(await manager.getTransactionCount('pending')).to.equal(9);
    expect(await observed).to.equal(submissionFailure);
  });

  it('makes a nonce-reset failure visible to the caller', async () => {
    const resetFailure = new Error('Cannot refresh nonce');
    signer.getTransactionCount = async tag => {
      if (tag === 'pending') return 7;
      throw resetFailure;
    };
    signer.sendTransaction = async () => { throw submissionFailure; };
    const reset = manager._reset.bind(manager);
    const resets: Promise<void>[] = [];
    manager._reset = () => {
      const result = reset();
      // Observe this promise so the reproduction cannot crash the test runner
      // with an unhandled rejection if production fails to await it.
      result.catch(() => undefined);
      resets.push(result);
      return result;
    };

    let caught: unknown;
    try {
      await manager.sendTransaction({ to: signer.address });
    } catch (error) {
      caught = error;
    }
    await Promise.allSettled(resets);
    expect(resets).to.have.length(1);
    const detail = caught as { cause?: unknown, errors?: unknown[] } | undefined;
    // Accept a direct reset error or a combined error that preserves it.
    expect([caught, detail?.cause, ...(detail?.errors ?? [])]).to.include(resetFailure);
  });

  describe('typed data', () => {
    const verifyingContract = '0x2222222222222222222222222222222222222222';
    const owner = '0x3333333333333333333333333333333333333333';
    const types = { Permit: [{ name: 'owner', type: 'address' }, { name: 'value', type: 'uint256' }] };
    const signature = '0x' + 'ab'.repeat(65);

    for (const useNames of [false, true]) {
      it(`sends the EIP-712 payload with ${useNames ? 'resolved ENS names' : 'literal addresses'}`, async () => {
        const provider = new providers.JsonRpcProvider(undefined, { name: 'test-network', chainId: 31337 });
        const resolutions: string[] = [];
        provider.resolveName = async input => {
          const name = await input;
          resolutions.push(name);
          if (name === 'market.eth') return verifyingContract;
          if (name === 'alice.eth') return owner;
          throw new Error(`Unexpected ENS lookup: ${name}`);
        };
        const requests: Array<{ method: string, params: any[] }> = [];
        provider.send = async (method, params) => { requests.push({ method, params }); return signature; };
        const wallet = signer.connect(provider);
        const managed = new ExtendedNonceManager(wallet);

        const result = await managed._signTypedData({
          name: 'Apple', version: '1', chainId: 1,
          verifyingContract: useNames ? 'market.eth' : verifyingContract,
        }, types, { owner: useNames ? 'alice.eth' : owner, value: 7 });

        expect(result).to.equal(signature);
        expect(resolutions).to.have.members(useNames ? ['market.eth', 'alice.eth'] : []);
        expect(requests).to.have.length(1);
        expect(requests[0].method).to.equal('eth_signTypedData_v4');
        expect(requests[0].params[0]).to.equal(wallet.address.toLowerCase());
        expect(JSON.parse(requests[0].params[1])).to.eql({
          domain: { name: 'Apple', version: '1', chainId: '1', verifyingContract },
          types: {
            ...types,
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
          },
          primaryType: 'Permit',
          message: { owner, value: '7' },
        });
      });
    }

    it('does not send a signing request when ENS resolution fails', async () => {
      const provider = new providers.JsonRpcProvider(undefined, { name: 'test-network', chainId: 31337 });
      const failure = new Error('ENS lookup failed');
      provider.resolveName = async () => { throw failure; };
      let signingRequests = 0;
      provider.send = async () => { signingRequests++; return signature; };
      const managed = new ExtendedNonceManager(signer.connect(provider));
      await assert.rejects(managed._signTypedData({
        name: 'Apple', version: '1', chainId: 1, verifyingContract,
      }, types, { owner: 'alice.eth', value: 7 }), error => error === failure);
      expect(signingRequests).to.equal(0);
    });
  });
});
