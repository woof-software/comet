import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import { MaxUint256, Signature, ZeroAddress } from 'ethers';

import { ethers, expect, makeProtocol } from './helpers.js';
import type { Comet } from './helpers.js';

let comet: Comet;
let _admin: SignerWithAddress;
let pauseGuardian: SignerWithAddress;
let signer: SignerWithAddress;
let manager: SignerWithAddress;
let domain;
let signature: Signature;
let signatureArgs: {
  owner: string;
  manager: string;
  isAllowed: boolean;
  nonce: bigint;
  expiry: number;
};

const types = {
  Authorization: [
    { name: 'owner', type: 'address' },
    { name: 'manager', type: 'address' },
    { name: 'isAllowed', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
  ],
};

describe('allowBySig', function () {
  beforeEach(async () => {
    comet = (await makeProtocol()).cometWithExtendedAssetList;
    [_admin, pauseGuardian, signer, manager] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();

    domain = {
      name: await comet.name(),
      version: await comet.version(),
      chainId,
      verifyingContract: await comet.getAddress(),
    };
    const blockNumber = await ethers.provider.getBlockNumber();
    const timestamp = (await ethers.provider.getBlock(blockNumber)).timestamp;

    signatureArgs = {
      owner: signer.address,
      manager: manager.address,
      isAllowed: true,
      nonce: await comet.userNonce(signer.address),
      expiry: timestamp + 10,
    };

    const rawSignature = await signer.signTypedData(domain, types, signatureArgs);
    signature = Signature.from(rawSignature);
  });

  it('authorizes with a valid signature', async () => {
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    const tx = await comet
      .connect(manager)
      .allowBySig(
        signatureArgs.owner,
        signatureArgs.manager,
        signatureArgs.isAllowed,
        signatureArgs.nonce,
        signatureArgs.expiry,
        signature.v,
        signature.r,
        signature.s
      );

    await expect(tx)
      .to.emit(comet, 'Approval')
      .withArgs(signer.address, manager.address, MaxUint256);

    // authorizes manager
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.true;

    // increments nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce + 1n);
  });

  it('fails if owner argument is altered', async () => {
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    const invalidOwnerAddress = pauseGuardian.address;

    await expect(
      comet.connect(manager).allowBySig(
        invalidOwnerAddress, // altered owner
        signatureArgs.manager,
        signatureArgs.isAllowed,
        signatureArgs.nonce,
        signatureArgs.expiry,
        signature.v,
        signature.r,
        signature.s
      )
    ).to.be.revertedWithCustomError(comet, 'BadSignatory');

    // does not authorize
    expect(await comet.isAllowed(invalidOwnerAddress, manager.address)).to.be.false;

    // does not alter signer nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('fails if manager argument is altered', async () => {
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    const invalidManagerAddress = pauseGuardian.address;

    await expect(
      comet.connect(manager).allowBySig(
        signatureArgs.owner,
        invalidManagerAddress, // altered manager
        signatureArgs.isAllowed,
        signatureArgs.nonce,
        signatureArgs.expiry,
        signature.v,
        signature.r,
        signature.s
      )
    ).to.be.revertedWithCustomError(comet, 'BadSignatory');

    // does not authorize
    expect(await comet.isAllowed(signer.address, invalidManagerAddress)).to.be.false;

    // does not alter signer nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('fails if isAllowed argument is altered', async () => {
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    await expect(
      comet.connect(manager).allowBySig(
        signatureArgs.owner,
        signatureArgs.manager,
        !signatureArgs.isAllowed, // altered isAllowed
        signatureArgs.nonce,
        signatureArgs.expiry,
        signature.v,
        signature.r,
        signature.s
      )
    ).to.be.revertedWithCustomError(comet, 'BadSignatory');

    // does not authorize
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    // does not alter signer nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('fails if nonce argument is altered', async () => {
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    await expect(
      comet.connect(manager).allowBySig(
        signatureArgs.owner,
        signatureArgs.manager,
        signatureArgs.isAllowed,
        signatureArgs.nonce + 1n, // altered nonce
        signatureArgs.expiry,
        signature.v,
        signature.r,
        signature.s
      )
    ).to.be.revertedWithCustomError(comet, 'BadSignatory');

    // does not authorize
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    // does not alter signer nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('fails if expiry argument is altered', async () => {
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    await expect(
      comet.connect(manager).allowBySig(
        signatureArgs.owner,
        signatureArgs.manager,
        signatureArgs.isAllowed,
        signatureArgs.nonce,
        signatureArgs.expiry + 100, // altered expiry
        signature.v,
        signature.r,
        signature.s
      )
    ).to.be.revertedWithCustomError(comet, 'BadSignatory');

    // does not authorize
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    // does not alter signer nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('fails if signature contains invalid nonce', async () => {
    const invalidNonce = signatureArgs.nonce + 1n;
    const rawSignature = await signer.signTypedData(domain, types, {
      ...signatureArgs,
      nonce: invalidNonce,
    });
    const signatureWithInvalidNonce = Signature.from(rawSignature);

    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    await expect(
      comet
        .connect(manager)
        .allowBySig(
          signatureArgs.owner,
          signatureArgs.manager,
          signatureArgs.isAllowed,
          invalidNonce,
          signatureArgs.expiry,
          signatureWithInvalidNonce.v,
          signatureWithInvalidNonce.r,
          signatureWithInvalidNonce.s
        )
    ).to.be.revertedWithCustomError(comet, 'BadNonce');

    // does not authorize
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;
    // does not update nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('rejects a repeated message', async () => {
    // valid call
    await comet
      .connect(manager)
      .allowBySig(
        signatureArgs.owner,
        signatureArgs.manager,
        signatureArgs.isAllowed,
        signatureArgs.nonce,
        signatureArgs.expiry,
        signature.v,
        signature.r,
        signature.s
      );

    // repeated call
    await expect(
      comet
        .connect(manager)
        .allowBySig(
          signatureArgs.owner,
          signatureArgs.manager,
          signatureArgs.isAllowed,
          signatureArgs.nonce,
          signatureArgs.expiry,
          signature.v,
          signature.r,
          signature.s
        )
    ).to.be.revertedWithCustomError(comet, 'BadNonce');
  });

  it('fails if signature expiry has passed', async () => {
    const blockNumber = await ethers.provider.getBlockNumber();
    const timestamp = (await ethers.provider.getBlock(blockNumber)).timestamp;
    const invalidExpiry = timestamp - 1;

    const expiredSignatureArgs = {
      ...signatureArgs,
      expiry: invalidExpiry,
    };
    const rawSignature = await signer.signTypedData(domain, types, expiredSignatureArgs);
    const expiredSignature = Signature.from(rawSignature);

    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    await expect(
      comet
        .connect(manager)
        .allowBySig(
          expiredSignatureArgs.owner,
          expiredSignatureArgs.manager,
          expiredSignatureArgs.isAllowed,
          expiredSignatureArgs.nonce,
          expiredSignatureArgs.expiry,
          expiredSignature.v,
          expiredSignature.r,
          expiredSignature.s
        )
    ).to.be.revertedWithCustomError(comet, 'SignatureExpired');

    // does not authorize
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    // does not update nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('fails if v not in {27,28}', async () => {
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    await expect(
      comet
        .connect(manager)
        .allowBySig(
          signatureArgs.owner,
          signatureArgs.manager,
          signatureArgs.isAllowed,
          signatureArgs.nonce,
          signatureArgs.expiry,
          26,
          signature.r,
          signature.s
        )
    ).to.be.revertedWithCustomError(comet, 'InvalidValueV');

    // does not authorize
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    // does not update nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('fails if s is too high', async () => {
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    // 1 greater than the max value of s
    const invalidS = '0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A1';

    await expect(
      comet
        .connect(manager)
        .allowBySig(
          signatureArgs.owner,
          signatureArgs.manager,
          signatureArgs.isAllowed,
          signatureArgs.nonce,
          signatureArgs.expiry,
          signature.v,
          signature.r,
          invalidS
        )
    ).to.be.revertedWithCustomError(comet, 'InvalidValueS');

    // does not authorize
    expect(await comet.isAllowed(signer.address, manager.address)).to.be.false;

    // does not update nonce
    expect(await comet.userNonce(signer.address)).to.equal(signatureArgs.nonce);
  });

  it('fails if owner is zero address', async () => {
    expect(await comet.isAllowed(ZeroAddress, manager.address)).to.be.false;

    const blockNumber = await ethers.provider.getBlockNumber();
    const timestamp = (await ethers.provider.getBlock(blockNumber)).timestamp;

    const invalidSignature = {
      v: 27, // valid v
      r: '0x0000000000000000000000000000000000000000000000000000000000000000', // invalid r
      s: '0x36b99b3646118e24ca7c0c698792ebaf25a4bfa08c1cd6778c335a537b0eb43c', // valid s
    };

    // manager uses invalid signature to force ecrecover to return address(0)
    await expect(
      comet
        .connect(manager)
        .allowBySig(
          ZeroAddress,
          manager.address,
          true,
          await comet.userNonce(ZeroAddress),
          timestamp + 100,
          invalidSignature.v,
          invalidSignature.r,
          invalidSignature.s,
        )
    ).to.be.revertedWithCustomError(comet, 'BadSignatory');

    // does not authorize manager for address(0)
    expect(await comet.isAllowed(ZeroAddress, manager.address)).to.be.false;
  });
});
