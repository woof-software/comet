import { MaxUint256 } from 'ethers';
import type { Overrides, Signer } from 'ethers';
import type { ERC20 } from '../../build/types/index.js';
import CometActor from './CometActor.js';
import { resolveAddress } from './Address.js';
import type { AddressLike } from './Address.js';
import { wait } from '../../test/helpers.js';

export default class CometAsset {
  token: ERC20;
  address: string;

  constructor(token: ERC20) {
    this.token = token;
    if (typeof token.target !== 'string') {
      throw new Error('Token address is required');
    }
    this.address = token.target;
  }

  static fork(asset: CometAsset): CometAsset {
    return new CometAsset(asset.token);
  }

  async balanceOf(account: Signer | string): Promise<bigint> {
    const address = typeof account === 'string' ? account : await account.getAddress();
    return this.token.balanceOf(address);
  }

  async transfer(from: CometActor | Signer, amount: number | bigint, recipient: CometAsset | string, overrides: Overrides = {}) {
    const recipientAddress = typeof(recipient) === 'string' ? recipient : recipient.address;
    const signer = from instanceof CometActor ? from.signer : from;
    await wait(this.token.connect(signer).transfer(recipientAddress, amount, overrides));
  }

  async approve(from: CometActor | Signer, spender: AddressLike, amount?: number | bigint) {
    const spenderAddress = resolveAddress(spender);
    const finalAmount = amount ?? MaxUint256;
    const signer = from instanceof CometActor ? from.signer : from;
    await wait(this.token.connect(signer).approve(spenderAddress, finalAmount));
  }

  async allowance(owner: AddressLike, spender: AddressLike): Promise<bigint> {
    const ownerAddress = resolveAddress(owner);
    const spenderAddress = resolveAddress(spender);
    return this.token.allowance(ownerAddress, spenderAddress);
  }

  async decimals(): Promise<number> {
    return Number(await this.token.decimals());
  }
}
