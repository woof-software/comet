import { Signature } from 'ethers';
import type {
  BigNumberish,
  ContractTransactionReceipt,
  ContractTransactionResponse,
  Overrides,
  Signer,
} from 'ethers';
import type { CometContext } from './CometContext.js';
import { resolveAddress } from './Address.js';
import type { AddressLike } from './Address.js';
import { ERC20__factory } from '../../build/types/index.js';
import { baseBalanceOf } from '../../test/helpers.js';

export const types = {
  Authorization: [
    { name: 'owner', type: 'address' },
    { name: 'manager', type: 'address' },
    { name: 'isAllowed', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
};

function floor(n: number): bigint {
  return BigInt(Math.floor(n));
}

// In ethers v6, wait() may return null, so ensure callers always receive a mined receipt.
async function waitForReceipt(
  transaction: Promise<ContractTransactionResponse>
): Promise<ContractTransactionReceipt> {
  const response = await transaction;
  const receipt = await response.wait();
  if (receipt === null) {
    throw new Error(`Transaction ${response.hash} was not mined`);
  }
  return receipt;
}

export default class CometActor {
  name: string;
  signer: Signer;
  address: string;
  context: CometContext;

  constructor(
    name: string,
    signer: Signer,
    address: string,
    context: CometContext,
  ) {
    this.name = name;
    this.signer = signer;
    this.address = address;
    this.context = context;
  }

  static fork(actor: CometActor, context: CometContext): CometActor {
    return new CometActor(actor.name, actor.signer, actor.address, context);
  }

  async getEthBalance() {
    const provider = this.signer.provider;
    if (!provider) {
      throw new Error('Signer provider is required');
    }
    return provider.getBalance(this.address);
  }

  async getErc20Balance(tokenAddress: string): Promise<bigint> {
    const erc20 = ERC20__factory.connect(tokenAddress, this.signer);
    return erc20.balanceOf(this.address);
  }

  async getCometBaseBalance(): Promise<bigint> {
    const comet = await this.context.getComet();
    return baseBalanceOf(comet, this.address);
  }

  async getCometCollateralBalance(tokenAddress: string): Promise<bigint> {
    const comet = await this.context.getComet();
    return comet.collateralBalanceOf(this.address, tokenAddress);
  }

  async sendEth(recipient: AddressLike, amount: number) {
    const tx = await this.signer.sendTransaction({
      to: resolveAddress(recipient),
      value: floor(amount * 1e18),
    });
    await tx.wait();
  }

  async transferErc20(tokenAddress: string, dst: string, amount: bigint): Promise<ContractTransactionReceipt> {
    const erc20 = ERC20__factory.connect(tokenAddress, this.signer);
    return waitForReceipt(erc20.transfer(dst, amount));
  }

  async allow(manager: CometActor | string, isAllowed: boolean): Promise<ContractTransactionReceipt> {
    if (typeof manager !== 'string') manager = manager.address;
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).allow(manager, isAllowed));
  }

  async safeSupplyAsset({ asset, amount }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    await this.context.bumpSupplyCaps({ [asset]: amount });
    return waitForReceipt(comet.connect(this.signer).supply(asset, amount));
  }

  async supplyAsset({ asset, amount }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).supply(asset, amount));
  }

  async supplyAssetFrom({ src, dst, asset, amount }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).supplyFrom(src, dst, asset, amount));
  }

  async transferAsset({ dst, asset, amount }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).transferAsset(dst, asset, amount));
  }

  async transferAssetFrom({ src, dst, asset, amount }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).transferAssetFrom(src, dst, asset, amount));
  }

  async withdrawAsset({ asset, amount }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).withdraw(asset, amount));
  }

  async withdrawAssetFrom({ src, dst, asset, amount }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).withdrawFrom(src, dst, asset, amount));
  }

  async absorb({ absorber, accounts }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).absorb(absorber, accounts));
  }

  async signAuthorization({
    manager,
    isAllowed,
    nonce,
    expiry,
    chainId,
  }: {
    manager: string;
    isAllowed: boolean;
    nonce: BigNumberish;
    expiry: number;
    chainId: BigNumberish;
  }): Promise<Signature> {
    const comet = await this.context.getComet();
    const domain = {
      name: await comet.name(),
      version: await comet.version(),
      chainId: chainId,
      verifyingContract: await comet.getAddress(),
    };
    const value = {
      owner: this.address,
      manager,
      isAllowed,
      nonce,
      expiry,
    };
    const rawSignature = await this.signer.signTypedData(domain, types, value);
    return Signature.from(rawSignature);
  }

  async allowBySig({
    owner,
    manager,
    isAllowed,
    nonce,
    expiry,
    signature,
  }: {
    owner: string;
    manager: string;
    isAllowed: boolean;
    nonce: BigNumberish;
    expiry: number;
    signature: { v: number; r: string; s: string };
  }): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(
      comet
        .connect(this.signer)
        .allowBySig(owner, manager, isAllowed, nonce, expiry, signature.v, signature.r, signature.s)
    );
  }

  async invoke({ actions, calldata }, overrides?: Overrides): Promise<ContractTransactionReceipt> {
    const bulker = await this.context.getBulker();
    return waitForReceipt(bulker.connect(this.signer).invoke(actions, calldata, { ...overrides }));
  }

  /* ===== Admin-only functions ===== */

  async withdrawReserves(to: string, amount: BigNumberish, overrides?: Overrides): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).withdrawReserves(to, amount, { ...overrides }));
  }

  async pause({
    supplyPaused = false,
    transferPaused = false,
    withdrawPaused = false,
    absorbPaused = false,
    buyPaused = false,
  }, overrides?: Overrides
  ): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(
      comet
        .connect(this.signer)
        .pause(supplyPaused, transferPaused, withdrawPaused, absorbPaused, buyPaused, { ...overrides })
    );
  }

  async approveThis(manager: string, asset: string, amount: BigNumberish, overrides?: Overrides): Promise<ContractTransactionReceipt> {
    const comet = await this.context.getComet();
    return waitForReceipt(comet.connect(this.signer).approveThis(manager, asset, amount, { ...overrides }));
  }

  async deployAndUpgradeTo(configuratorProxy: string, cometProxy: string, overrides?: Overrides): Promise<ContractTransactionReceipt> {
    const proxyAdmin = await this.context.getCometAdmin();
    return waitForReceipt(
      proxyAdmin.connect(this.signer).deployAndUpgradeTo(configuratorProxy, cometProxy, { ...overrides })
    );
  }
}
