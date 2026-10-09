import { MaxUint256, Signature, ZeroAddress } from 'ethers';
import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import type { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from '../build/types/index.js';
import { ethers, expect, exp, makeProtocol, wait, event, defaultAssets } from './helpers.js';
import { takeSnapshot } from './helpers/snapshot.js';
import type { SnapshotRestorer } from './helpers/snapshot.js';

function expectApproximately(actual: bigint, expected: bigint, tolerance: bigint): void {
  const difference = actual >= expected ? actual - expected : expected - actual;
  expect(difference <= tolerance).to.equal(true, `difference ${difference} exceeds tolerance ${tolerance}`);
}

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
  const baseTokenDecimals = 6;
  const seedAmount = exp(10_000, baseTokenDecimals);
  const supplyAmount = exp(100, baseTokenDecimals);

  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charles: SignerWithAddress;

  let snapshot: SnapshotRestorer;
  let snapshotWithoutAllow: SnapshotRestorer;

  let pauseGuardian: SignerWithAddress;
  let domain: {
    name: string;
    version: string;
    chainId: bigint;
    verifyingContract: string;
  };
  let signature: Signature;
  let signatureArgs: {
    owner: string;
    manager: string;
    isAllowed: boolean;
    nonce: bigint;
    expiry: number;
  };
  before(async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      assets: defaultAssets({}, {
        WETH: {
          decimals: 18,
          borrowCF: exp(0.8, 18),
          liquidateCF: exp(0.95, 18),
          liquidationFactor: exp(0.95, 18),
        },
      }),
    });
    comet = protocol.cometWithExtendedAssetList;
    baseToken = protocol.tokens.USDC as FaucetToken;
    for (const asset in protocol.tokens) {
      if (asset === 'USDC') continue;
      collaterals[asset] = protocol.tokens[asset] as FaucetToken;
    }
    for (const asset in protocol.priceFeeds) {
      priceFeeds[asset] = protocol.priceFeeds[asset];
    }
    [alice, bob, charles] = protocol.users;
    pauseGuardian = protocol.pauseGuardian;

    // Seed reserves so borrowing is possible
    await baseToken.allocateTo((await comet.getAddress()), seedAmount);

    // Alice supplies some USDC in the initial snapshot
    await baseToken.allocateTo(alice.address, supplyAmount);
    await baseToken.connect(alice).approve((await comet.getAddress()), supplyAmount);
    await comet.connect(alice).supply((await baseToken.getAddress()), supplyAmount);

    domain = {
      name: await comet.name(),
      version: await comet.version(),
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: (await comet.getAddress()),
    };
    const blockNumber = await ethers.provider.getBlockNumber();
    const block = await ethers.provider.getBlock(blockNumber);
    if (!block) throw new Error('Block not found');
    const timestamp = block.timestamp;

    signatureArgs = {
      owner: alice.address,
      manager: bob.address,
      isAllowed: true,
      nonce: await comet.userNonce(alice.address),
      expiry: timestamp + 10,
    };

    const rawSignature = await alice.signTypedData(domain, types, signatureArgs);
    signature = Signature.from(rawSignature);

    snapshotWithoutAllow = await takeSnapshot();
  });

  async function signAuthorization(
    args: typeof signatureArgs,
    domainOverride: Partial<typeof domain> = {}
  ): Promise<Signature> {
    const rawSignature = await alice.signTypedData(
      { ...domain, ...domainOverride },
      types,
      args
    );
    return Signature.from(rawSignature);
  }

  async function submitAuthorization(
    args: typeof signatureArgs,
    authorizationSignature: Signature,
    submitter: SignerWithAddress = bob
  ) {
    return comet.connect(submitter).allowBySig(
      args.owner,
      args.manager,
      args.isAllowed,
      args.nonce,
      args.expiry,
      authorizationSignature.v,
      authorizationSignature.r,
      authorizationSignature.s
    );
  }

  describe('positive cases', function () {
    describe('allow interactions', function () {
      it('authorizes with a valid signature', async () => {
        expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

        const tx = await wait(comet
          .connect(bob)
          .allowBySig(
            signatureArgs.owner,
            signatureArgs.manager,
            signatureArgs.isAllowed,
            signatureArgs.nonce,
            signatureArgs.expiry,
            signature.v,
            signature.r,
            signature.s
          ));

        // authorizes manager
        expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;

        // increments nonce
        expect(await comet.userNonce(alice.address)).to.equal((signatureArgs.nonce + 1n));

        expect(event(tx, 0)).to.be.deep.equal({
          Approval: {
            owner: alice.address,
            spender: bob.address,
            amount: MaxUint256,
          }
        });
      });
    });

    describe('interactions with comet', function () {
      before(async function () {
        await snapshotWithoutAllow.restore();
        await wait(submitAuthorization(signatureArgs, signature));
        snapshot = await takeSnapshot();
      });

      this.afterEach(async function () {
        await snapshot.restore();
      });

      it('can supply base token after being authorized', async () => {
        await baseToken.allocateTo(alice.address, supplyAmount);
        await baseToken.connect(alice).approve((await comet.getAddress()), supplyAmount);

        expect(await comet.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).supplyFrom(
          alice.address,
          bob.address,
          (await baseToken.getAddress()),
          supplyAmount
        ));
        expectApproximately(await comet.balanceOf(bob.address), supplyAmount, 1n);
      });

      it('can supply collateral after being authorized', async () => {
        const collateralAmount = exp(1, 18);
        await collaterals.WETH.allocateTo(alice.address, collateralAmount);
        await collaterals.WETH.connect(alice).approve((await comet.getAddress()), collateralAmount);

        expect(await comet.collateralBalanceOf(bob.address, (await collaterals.WETH.getAddress()))).to.equal(0);
        await wait(comet.connect(bob).supplyFrom(
          alice.address,
          bob.address,
          (await collaterals.WETH.getAddress()),
          collateralAmount
        ));
        expect(await comet.collateralBalanceOf(bob.address, (await collaterals.WETH.getAddress()))).to.equal(collateralAmount);
      });

      it('can transfer base token after being authorized', async () => {
        const balance = await comet.balanceOf(alice.address);
        expect(balance).to.be.gt(0);

        expect(await comet.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).transferFrom(
          alice.address,
          bob.address,
          balance
        ));
        expectApproximately(await comet.balanceOf(bob.address), balance, 1n);
      });

      it('can transfer collateral after being authorized', async () => {
        const collateralAmount = exp(1, 18);
        await collaterals.WETH.allocateTo(alice.address, collateralAmount);
        await collaterals.WETH.connect(alice).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(alice).supply((await collaterals.WETH.getAddress()), collateralAmount);

        expect(await comet.collateralBalanceOf(bob.address, (await collaterals.WETH.getAddress()))).to.equal(0);
        await wait(comet.connect(bob).transferAssetFrom(
          alice.address,
          bob.address,
          (await collaterals.WETH.getAddress()),
          collateralAmount
        ));
        expect(await comet.collateralBalanceOf(bob.address, (await collaterals.WETH.getAddress()))).to.equal(collateralAmount);
      });

      it('can withdraw base token after being authorized', async () => {
        const balance = await comet.balanceOf(alice.address);
        expect(balance).to.be.gt(0);

        expect(await baseToken.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).withdrawFrom(
          alice.address,
          bob.address,
          (await baseToken.getAddress()),
          balance
        ));
        expect(await baseToken.balanceOf(bob.address)).to.equal(balance);
      });

      it('can withdraw collateral after being authorized', async () => {
        const collateralAmount = exp(1, 18);
        await collaterals.WETH.allocateTo(alice.address, collateralAmount);
        await collaterals.WETH.connect(alice).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(alice).supply((await collaterals.WETH.getAddress()), collateralAmount);

        expect(await collaterals.WETH.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).withdrawFrom(
          alice.address,
          bob.address,
          (await collaterals.WETH.getAddress()),
          collateralAmount
        ));
        expect(await collaterals.WETH.balanceOf(bob.address)).to.equal(collateralAmount);
      });

      it('can borrow after being authorized', async () => {
        await comet.connect(alice).withdraw((await baseToken.getAddress()), supplyAmount);
        expect(await comet.balanceOf(alice.address)).to.equal(0);

        const borrowAmount = exp(1000, baseTokenDecimals);
        const collateralAmount = exp(1, 18);
        await collaterals.WETH.allocateTo(alice.address, collateralAmount);
        await collaterals.WETH.connect(alice).approve((await comet.getAddress()), collateralAmount);
        await comet.connect(alice).supply((await collaterals.WETH.getAddress()), collateralAmount);

        expect(await baseToken.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).withdrawFrom(
          alice.address,
          bob.address,
          (await baseToken.getAddress()),
          borrowAmount
        ));
        expect(await baseToken.balanceOf(bob.address)).to.equal(borrowAmount);
      });
    });
  });

  describe('authorization lifecycle', function () {
    this.beforeEach(async function () {
      await snapshotWithoutAllow.restore();
    });

    it('allows authorization to be rescinded and blocks further manager actions', async () => {
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      if (!block) throw new Error('Block not found');
      const timestamp = block.timestamp;
      const initialNonce = await comet.userNonce(alice.address);

      const allowArgs = {
        ...signatureArgs,
        nonce: initialNonce,
        expiry: timestamp + 1_000,
      };
      const allowSignature = await signAuthorization(allowArgs);
      await submitAuthorization(allowArgs, allowSignature);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;
      expect(await comet.allowance(alice.address, bob.address)).to.equal(MaxUint256);

      const revokeArgs = {
        ...allowArgs,
        isAllowed: false,
        nonce: (initialNonce + 1n),
      };
      const revokeSignature = await signAuthorization(revokeArgs);
      await submitAuthorization(revokeArgs, revokeSignature);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      expect(await comet.allowance(alice.address, bob.address)).to.equal(0);
      expect(await comet.userNonce(alice.address)).to.equal((initialNonce + 2n));

      await expect(
        comet.connect(bob).withdrawFrom(
          alice.address,
          bob.address,
          (await baseToken.getAddress()),
          1
        )
      ).to.be.revertedWithCustomError(comet, 'Unauthorized');
    });
  });

  describe('domain validation', function () {
    this.beforeEach(async function () {
      await snapshotWithoutAllow.restore();
    });

    async function expectInvalidDomain(domainOverride: Partial<typeof domain>) {
      const nonce = await comet.userNonce(alice.address);
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      if (!block) throw new Error('Block not found');
      const timestamp = block.timestamp;
      const args = {
        ...signatureArgs,
        nonce,
        expiry: timestamp + 1_000,
      };
      const invalidDomainSignature = await signAuthorization(args, domainOverride);

      await expect(
        submitAuthorization(args, invalidDomainSignature)
      ).to.be.revertedWithCustomError(comet, 'BadSignatory');

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      expect(await comet.userNonce(alice.address)).to.equal(nonce);
    }

    it('fails if signature was signed for a different chain id', async () => {
      await expectInvalidDomain({ chainId: domain.chainId + 1n });
    });

    it('fails if signature was signed with the wrong domain name', async () => {
      await expectInvalidDomain({ name: 'Not The Real Market Name' });
    });

    it('fails if signature was signed with the wrong domain version', async () => {
      await expectInvalidDomain({ version: '9999' });
    });

    it('fails if signature was signed for a different verifying contract', async () => {
      await expectInvalidDomain({ verifyingContract: bob.address });
    });
  });

  describe('signature timing and nonce ordering', function () {
    this.beforeEach(async function () {
      await snapshotWithoutAllow.restore();
    });

    it('fails when block timestamp equals expiry', async () => {
      const nonce = await comet.userNonce(alice.address);
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      if (!block) throw new Error('Block not found');
      const timestamp = block.timestamp;
      const args = {
        ...signatureArgs,
        nonce,
        expiry: timestamp + 100,
      };
      const boundarySignature = await signAuthorization(args);

      await ethers.provider.send('evm_setNextBlockTimestamp', [args.expiry]);

      await expect(
        submitAuthorization(args, boundarySignature)
      ).to.be.revertedWithCustomError(comet, 'SignatureExpired');

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      expect(await comet.userNonce(alice.address)).to.equal(nonce);
    });

    it('applies two pre-signed authorizations submitted in nonce order', async () => {
      const nonce = await comet.userNonce(alice.address);
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      if (!block) throw new Error('Block not found');
      const timestamp = block.timestamp;
      const firstArgs = {
        ...signatureArgs,
        nonce,
        expiry: timestamp + 1_000,
      };
      const secondArgs = {
        ...firstArgs,
        manager: charles.address,
        nonce: (nonce + 1n),
      };
      const firstSignature = await signAuthorization(firstArgs);
      const secondSignature = await signAuthorization(secondArgs);

      await submitAuthorization(firstArgs, firstSignature);
      await submitAuthorization(secondArgs, secondSignature, charles);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;
      expect(await comet.isAllowed(alice.address, charles.address)).to.be.true;
      expect(await comet.userNonce(alice.address)).to.equal((nonce + 2n));
    });

    it('rejects a pre-signed authorization submitted out of nonce order', async () => {
      const nonce = await comet.userNonce(alice.address);
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      if (!block) throw new Error('Block not found');
      const timestamp = block.timestamp;
      const firstArgs = {
        ...signatureArgs,
        nonce,
        expiry: timestamp + 1_000,
      };
      const secondArgs = {
        ...firstArgs,
        manager: charles.address,
        nonce: (nonce + 1n),
      };
      const firstSignature = await signAuthorization(firstArgs);
      const secondSignature = await signAuthorization(secondArgs);

      await expect(
        submitAuthorization(secondArgs, secondSignature, charles)
      ).to.be.revertedWithCustomError(comet, 'BadNonce');

      expect(await comet.isAllowed(alice.address, charles.address)).to.be.false;
      expect(await comet.userNonce(alice.address)).to.equal(nonce);

      await submitAuthorization(firstArgs, firstSignature);
      await submitAuthorization(secondArgs, secondSignature, charles);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.true;
      expect(await comet.isAllowed(alice.address, charles.address)).to.be.true;
      expect(await comet.userNonce(alice.address)).to.equal((nonce + 2n));
    });
  });

  describe('edge cases', function () {
    this.beforeEach(async function () {
      await snapshotWithoutAllow.restore();
    });

    it('fails if owner argument is altered', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      const invalidOwnerAddress = pauseGuardian.address;

      await expect(
        comet.connect(bob).allowBySig(
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
      expect(await comet.isAllowed(invalidOwnerAddress, bob.address)).to.be.false;

      // does not alter signer nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if manager argument is altered', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      const invalidManagerAddress = pauseGuardian.address;

      await expect(
        comet.connect(bob).allowBySig(
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
      expect(await comet.isAllowed(alice.address, invalidManagerAddress)).to.be.false;

      // does not alter signer nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if isAllowed argument is altered', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      await expect(
        comet.connect(bob).allowBySig(
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
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // does not alter signer nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if nonce argument is altered', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      await expect(
        comet.connect(bob).allowBySig(
          signatureArgs.owner,
          signatureArgs.manager,
          signatureArgs.isAllowed,
          (signatureArgs.nonce + 1n), // altered nonce
          signatureArgs.expiry,
          signature.v,
          signature.r,
          signature.s
        )
      ).to.be.revertedWithCustomError(comet, 'BadSignatory');

      // does not authorize
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // does not alter signer nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if expiry argument is altered', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      await expect(
        comet.connect(bob).allowBySig(
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
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // does not alter signer nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if signature contains invalid nonce', async () => {
      const invalidNonce = (signatureArgs.nonce + 1n);
      const rawSignature = await alice.signTypedData(domain, types, {
        ...signatureArgs,
        nonce: invalidNonce,
      });
      const signatureWithInvalidNonce = Signature.from(rawSignature);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      await expect(
        comet
          .connect(bob)
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
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;
      // does not update nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('rejects a repeated message', async () => {
    // valid call
      await comet
        .connect(bob)
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
          .connect(bob)
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
      const block = await ethers.provider.getBlock(blockNumber);
      if (!block) throw new Error('Block not found');
      const timestamp = block.timestamp;
      const invalidExpiry = timestamp - 1;

      const expiredSignatureArgs = {
        ...signatureArgs,
        expiry: invalidExpiry,
      };
      const rawSignature = await alice.signTypedData(domain, types, expiredSignatureArgs);
      const expiredSignature = Signature.from(rawSignature);

      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      await expect(
        comet
          .connect(bob)
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
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // does not update nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if v not in {27,28}', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      await expect(
        comet
          .connect(bob)
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
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // does not update nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if s is too high', async () => {
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // 1 greater than the max value of s
      const invalidS = '0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A1';

      await expect(
        comet
          .connect(bob)
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
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // does not update nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if owner is zero address', async () => {
      expect(await comet.isAllowed(ZeroAddress, bob.address)).to.be.false;

      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);
      if (!block) throw new Error('Block not found');
      const timestamp = block.timestamp;

      const invalidSignature = {
        v: 27, // valid v
        r: '0x0000000000000000000000000000000000000000000000000000000000000000', // invalid r
        s: '0x36b99b3646118e24ca7c0c698792ebaf25a4bfa08c1cd6778c335a537b0eb43c', // valid s
      };

      // manager uses invalid signature to force ecrecover to return address(0)
      await expect(
        comet
          .connect(bob)
          .allowBySig(
            ZeroAddress,
            bob.address,
            true,
            await comet.userNonce(ZeroAddress),
            timestamp + 100,
            invalidSignature.v,
            invalidSignature.r,
            invalidSignature.s,
          )
      ).to.be.revertedWithCustomError(comet, 'BadSignatory');

      // does not authorize manager for address(0)
      expect(await comet.isAllowed(ZeroAddress, bob.address)).to.be.false;
    });

  });
});
