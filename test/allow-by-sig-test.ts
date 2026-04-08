import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { ethers, expect, exp, makeProtocol, wait, event, defaultAssets, SnapshotRestorer, takeSnapshot } from './helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BigNumber, Signature } from 'ethers';

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
  const seedAmount = BigNumber.from(exp(10_000, baseTokenDecimals));
  const supplyAmount = BigNumber.from(exp(100, baseTokenDecimals));

  let comet: CometHarnessInterfaceExtendedAssetList;
  let baseToken: FaucetToken;
  let collaterals: { [symbol: string]: FaucetToken } = {};
  let priceFeeds: { [symbol: string]: SimplePriceFeed } = {};

  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  let snapshot: SnapshotRestorer;
  let snapshotWithoutAllow: SnapshotRestorer;

  let pauseGuardian: SignerWithAddress;
  let domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  let signature: Signature;
  let signatureArgs: {
    owner: string;
    manager: string;
    isAllowed: boolean;
    nonce: BigNumber;
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
    [alice, bob] = protocol.users;
    pauseGuardian = protocol.pauseGuardian;

    // Seed reserves so borrowing is possible
    await baseToken.allocateTo(comet.address, seedAmount);

    // Alice supplies some USDC in the initial snapshot
    await baseToken.allocateTo(alice.address, supplyAmount);
    await baseToken.connect(alice).approve(comet.address, supplyAmount);
    await comet.connect(alice).supply(baseToken.address, supplyAmount);

    domain = {
      name: await comet.name(),
      version: await comet.version(),
      chainId: 1337,
      verifyingContract: comet.address,
    };
    const blockNumber = await ethers.provider.getBlockNumber();
    const timestamp = (await ethers.provider.getBlock(blockNumber)).timestamp;

    signatureArgs = {
      owner: alice.address,
      manager: bob.address,
      isAllowed: true,
      nonce: await comet.userNonce(alice.address),
      expiry: timestamp + 10,
    };

    const rawSignature = await alice._signTypedData(domain, types, signatureArgs);
    signature = ethers.utils.splitSignature(rawSignature);
    
    snapshotWithoutAllow = await takeSnapshot();
  });

  describe('positive cases', function () {
    describe('allow interactions', function () {

      after(async function () {
        snapshot = await takeSnapshot();
      });

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
        expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce.add(1));

        expect(event(tx, 0)).to.be.deep.equal({
          Approval: {
            owner: alice.address,
            spender: bob.address,
            amount: ethers.constants.MaxUint256.toBigInt(),
          }
        });
      });
    });

    describe('interactions with comet', function () {
      this.afterEach(async function () {
        await snapshot.restore();
      });

      it('can supply base token after being authorized', async () => {
        await baseToken.allocateTo(alice.address, supplyAmount);
        await baseToken.connect(alice).approve(comet.address, supplyAmount);        

        expect(await comet.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).supplyFrom(
          alice.address,
          bob.address,
          baseToken.address,
          supplyAmount
        ));
        expect(await comet.balanceOf(bob.address)).to.be.closeTo(supplyAmount, 1);
      });

      it('can supply collateral after being authorized', async () => {
        const collateralAmount = exp(1, 18);
        await collaterals.WETH.allocateTo(alice.address, collateralAmount);
        await collaterals.WETH.connect(alice).approve(comet.address, collateralAmount);

        expect(await comet.collateralBalanceOf(bob.address, collaterals.WETH.address)).to.equal(0);
        await wait(comet.connect(bob).supplyFrom(
          alice.address,
          bob.address,
          collaterals.WETH.address,
          collateralAmount
        ));
        expect(await comet.collateralBalanceOf(bob.address, collaterals.WETH.address)).to.equal(collateralAmount);
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
        expect(await comet.balanceOf(bob.address)).to.be.closeTo(balance, 1);
      });

      it('can transfer collateral after being authorized', async () => {
        const collateralAmount = exp(1, 18);
        await collaterals.WETH.allocateTo(alice.address, collateralAmount);
        await collaterals.WETH.connect(alice).approve(comet.address, collateralAmount);
        await comet.connect(alice).supply(collaterals.WETH.address, collateralAmount);

        expect(await comet.collateralBalanceOf(bob.address, collaterals.WETH.address)).to.equal(0);
        await wait(comet.connect(bob).transferAssetFrom(
          alice.address,
          bob.address,
          collaterals.WETH.address,
          collateralAmount
        ));
        expect(await comet.collateralBalanceOf(bob.address, collaterals.WETH.address)).to.equal(collateralAmount);
      });

      it('can withdraw base token after being authorized', async () => {
        const balance = await comet.balanceOf(alice.address);
        expect(balance).to.be.gt(0);

        expect(await baseToken.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).withdrawFrom(
          alice.address,
          bob.address,
          baseToken.address,
          balance
        ));
        expect(await baseToken.balanceOf(bob.address)).to.equal(balance);
      });

      it('can withdraw collateral after being authorized', async () => {
        const collateralAmount = exp(1, 18);
        await collaterals.WETH.allocateTo(alice.address, collateralAmount);
        await collaterals.WETH.connect(alice).approve(comet.address, collateralAmount);
        await comet.connect(alice).supply(collaterals.WETH.address, collateralAmount);

        expect(await collaterals.WETH.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).withdrawFrom(
          alice.address,
          bob.address,
          collaterals.WETH.address,
          collateralAmount
        ));
        expect(await collaterals.WETH.balanceOf(bob.address)).to.equal(collateralAmount);
      });

      it('can borrow after being authorized', async () => {
        await comet.connect(alice).withdraw(baseToken.address, supplyAmount);
        expect(await comet.balanceOf(alice.address)).to.equal(0);

        const borrowAmount = exp(1000, baseTokenDecimals);
        const collateralAmount = exp(1, 18);
        await collaterals.WETH.allocateTo(alice.address, collateralAmount);
        await collaterals.WETH.connect(alice).approve(comet.address, collateralAmount);
        await comet.connect(alice).supply(collaterals.WETH.address, collateralAmount);
        
        expect(await baseToken.balanceOf(bob.address)).to.equal(0);
        await wait(comet.connect(bob).withdrawFrom(
          alice.address,
          bob.address,
          baseToken.address,
          borrowAmount
        ));
        expect(await baseToken.balanceOf(bob.address)).to.equal(borrowAmount);
      });
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
      ).to.be.revertedWith("custom error 'BadSignatory()'");

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
      ).to.be.revertedWith("custom error 'BadSignatory()'");

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
      ).to.be.revertedWith("custom error 'BadSignatory()'");

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
          signatureArgs.nonce.add(1), // altered nonce
          signatureArgs.expiry,
          signature.v,
          signature.r,
          signature.s
        )
      ).to.be.revertedWith("custom error 'BadSignatory()'");

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
      ).to.be.revertedWith("custom error 'BadSignatory()'");

      // does not authorize
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // does not alter signer nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if signature contains invalid nonce', async () => {
      const invalidNonce = signatureArgs.nonce.add(1);
      const rawSignature = await alice._signTypedData(domain, types, {
        ...signatureArgs,
        nonce: invalidNonce,
      });
      const signatureWithInvalidNonce = ethers.utils.splitSignature(rawSignature);

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
      ).to.be.revertedWith("custom error 'BadNonce()'");

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
      ).to.be.revertedWith("custom error 'BadNonce()'");
    });

    it('fails if signature expiry has passed', async () => {
      const blockNumber = await ethers.provider.getBlockNumber();
      const timestamp = (await ethers.provider.getBlock(blockNumber)).timestamp;
      const invalidExpiry = timestamp - 1;

      const expiredSignatureArgs = {
        ...signatureArgs,
        expiry: invalidExpiry,
      };
      const rawSignature = await alice._signTypedData(domain, types, expiredSignatureArgs);
      const expiredSignature = ethers.utils.splitSignature(rawSignature);

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
      ).to.be.revertedWith("custom error 'SignatureExpired()'");

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
      ).to.be.revertedWith("custom error 'InvalidValueV()'");

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
      ).to.be.revertedWith("custom error 'InvalidValueS()'");

      // does not authorize
      expect(await comet.isAllowed(alice.address, bob.address)).to.be.false;

      // does not update nonce
      expect(await comet.userNonce(alice.address)).to.equal(signatureArgs.nonce);
    });

    it('fails if owner is zero address', async () => {
      expect(await comet.isAllowed(ethers.constants.AddressZero, bob.address)).to.be.false;

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
          .connect(bob)
          .allowBySig(
            ethers.constants.AddressZero,
            bob.address,
            true,
            await comet.userNonce(ethers.constants.AddressZero),
            timestamp + 100,
            invalidSignature.v,
            invalidSignature.r,
            invalidSignature.s,
          )
      ).to.be.revertedWith("custom error 'BadSignatory()'");

      // does not authorize manager for address(0)
      expect(await comet.isAllowed(ethers.constants.AddressZero, bob.address)).to.be.false;
    });
  });
});
