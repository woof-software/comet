import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ContractTransaction, Signer } from 'ethers';
import { OneInchV6CoreAdapter, OneInchV6CoreAdapter__factory } from '../../build/types';
import {
  RouteConfig,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  TOKENS,
  MARKETS,
  setupDexAdapter,
  SnapshotRestorer,
} from '../helpers';

describe('CoreDexAdapter', function () {
  this.timeout(180_000);

  const market = MARKETS.usdc;

  let adapter: OneInchV6CoreAdapter;
  let adapterFactory: OneInchV6CoreAdapter__factory;
  let routes: RouteConfig[];
  let baseToken: string;
  let moduleSigner: Signer;
  let moduleAddress: string;
  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ adapter, adapterFactory, routes, baseToken, moduleSigner, moduleAddress, snapshot } = await setupDexAdapter(market));
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets comet to the provided market', async () => {
        expect(await adapter.comet()).to.equal(market.comet);
      });

      it('sets baseAsset to the comet base token', async () => {
        expect(await adapter.baseAsset()).to.equal(baseToken);
      });

      it('sets module to the provided liquidation module', async () => {
        expect(await adapter.module()).to.equal(moduleAddress);
      });

      it('sets coreRouter to the provided core router', async () => {
        expect(await adapter.coreRouter()).to.equal(CORE_ROUTER);
      });

      it('sets redundantRouter to the provided redundant router', async () => {
        expect(await adapter.redundantRouter()).to.equal(REDUNDANT_ROUTER);
      });

      it('sets slippageBps to the provided slippage', async () => {
        expect(await adapter.slippageBps()).to.equal(SLIPPAGE_BPS);
      });
    });

    context('reverts when', function () {
      it('a constructor address is zero', async () => {
        await expect(
          adapterFactory.deploy(
            ethers.constants.AddressZero,
            REDUNDANT_ROUTER,
            TOKENS.WETH.address,
            SLIPPAGE_BPS,
            routes
          )
        ).to.be.revertedWithCustomError(adapter, 'ZeroAddress');
      });

      it('slippage bps is out of bounds', async () => {
        const badSlippageBps = 10_001; // > BPS (100%)
        await expect(
          adapterFactory.deploy(
            CORE_ROUTER,
            REDUNDANT_ROUTER,
            TOKENS.WETH.address,
            badSlippageBps,
            routes
          )
        )
          .to.be.revertedWithCustomError(adapter, 'SlippageOutOfBounds')
          .withArgs(badSlippageBps);
      });
    });
  });

  context('setSlippageBps', function () {
    let setTx: ContractTransaction;
    const NEW_SLIPPAGE_BPS = 1000;

    context('happy path: module updates slippageBps', function () {
      after(async () => await snapshot.restore());

      it('module updates slippageBps to a new value', async () => {
        setTx = await adapter.connect(moduleSigner).setSlippageBps(NEW_SLIPPAGE_BPS);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits event SlippageSet', async () => {
        await expect(setTx).to.emit(adapter, 'SlippageSet').withArgs(SLIPPAGE_BPS, NEW_SLIPPAGE_BPS);
      });

      it('slippageBps is now a new value', async () => {
        expect(await adapter.slippageBps()).to.equal(NEW_SLIPPAGE_BPS);
      });
    });

    context('reverts when', function () {
      it('caller is not the module', async () => {
        const [outsider] = await ethers.getSigners();
        await expect(adapter.connect(outsider).setSlippageBps(NEW_SLIPPAGE_BPS)).to.be.revertedWithCustomError(adapter, 'Unathorized');
      });

      it('New slippageBps is out of bounds', async () => {
        const badSlippageBps = 0;
        await expect(adapter.connect(moduleSigner).setSlippageBps(badSlippageBps)).to.be.revertedWithCustomError(adapter, 'SlippageOutOfBounds');
      });

      it('New slippage bps is equal to previous value', async () => {
        await expect(adapter.connect(moduleSigner).setSlippageBps(SLIPPAGE_BPS)).to.be.revertedWithCustomError(adapter, 'AlreadySet');
      });
    });
  });

  it('rejects swap() from a non-module caller', async () => {
    const [outsider] = await ethers.getSigners();
    await expect(
      adapter.connect(outsider).swap(TOKENS.WBTC.address, '0x')
    ).to.be.revertedWithCustomError(adapter, 'Unathorized');
  });

  it('reverts swap() when the adapter holds no collateral (amountIn is zero)', async () => {
    // The freshly deployed adapter holds no WBTC, so balanceOf == 0.
    await expect(
      adapter.connect(moduleSigner).swap(TOKENS.WBTC.address, '0x')
    ).to.be.revertedWithCustomError(adapter, 'ZeroAmountIn');
  });
});
