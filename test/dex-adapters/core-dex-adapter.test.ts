import { expect } from 'chai';
import { ethers } from 'hardhat';
import { BigNumber, ContractTransaction, Signer } from 'ethers';
import { CometInterface, OneInchV6Adapter, OneInchV6Adapter__factory } from '../../build/types';
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

  let adapter: OneInchV6Adapter;
  let adapterFactory: OneInchV6Adapter__factory;
  let comet: CometInterface;
  let routes: RouteConfig[];
  let baseToken: string;
  let moduleSigner: Signer;
  let moduleAddress: string;
  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ adapter, adapterFactory, comet, routes, baseToken, moduleSigner, moduleAddress, snapshot } = await setupDexAdapter(market));
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

      context('with per-collateral slippage overrides', function () {
        const WBTC_OVERRIDE_BPS = 300;
        const WETH_OVERRIDE_BPS = 800;
        let customAdapter: OneInchV6Adapter;

        before(async () => {
          customAdapter = await adapterFactory.deploy(
            CORE_ROUTER,
            REDUNDANT_ROUTER,
            TOKENS.WETH.address,
            SLIPPAGE_BPS,
            routes,
            [
              { collateral: TOKENS.WBTC.address, slippageBps: WBTC_OVERRIDE_BPS },
              { collateral: TOKENS.WETH.address, slippageBps: WETH_OVERRIDE_BPS },
            ]
          );
          await customAdapter.deployed();
        });

        it('stores each per-collateral override', async () => {
          expect(await customAdapter.collateralSlippageBps(TOKENS.WBTC.address)).to.equal(WBTC_OVERRIDE_BPS);
          expect(await customAdapter.collateralSlippageBps(TOKENS.WETH.address)).to.equal(WETH_OVERRIDE_BPS);
        });

        it('leaves collaterals without an override at zero', async () => {
          expect(await customAdapter.collateralSlippageBps(TOKENS.WSTETH.address)).to.equal(0);
        });

        it('still sets the global slippageBps', async () => {
          expect(await customAdapter.slippageBps()).to.equal(SLIPPAGE_BPS);
        });

        it('reverts when an override slippage is out of bounds', async () => {
          await expect(
            adapterFactory.deploy(CORE_ROUTER, REDUNDANT_ROUTER, TOKENS.WETH.address, SLIPPAGE_BPS, routes, [
              { collateral: TOKENS.WBTC.address, slippageBps: 10_001 },
            ])
          )
            .to.be.revertedWithCustomError(adapter, 'SlippageOutOfBounds')
            .withArgs(10_001);
        });

        it('reverts when an override collateral is the zero address', async () => {
          await expect(
            adapterFactory.deploy(CORE_ROUTER, REDUNDANT_ROUTER, TOKENS.WETH.address, SLIPPAGE_BPS, routes, [
              { collateral: ethers.constants.AddressZero, slippageBps: 300 },
            ])
          ).to.be.revertedWithCustomError(adapter, 'ZeroAddress');
        });
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
            routes,
            []
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
            routes,
            []
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
        setTx = await adapter.connect(moduleSigner).setSlippageBps(NEW_SLIPPAGE_BPS, ethers.constants.AddressZero);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits event SlippageSet', async () => {
        await expect(setTx).to.emit(adapter, 'SlippageSet').withArgs(ethers.constants.AddressZero, SLIPPAGE_BPS, NEW_SLIPPAGE_BPS);
      });

      it('slippageBps is now a new value', async () => {
        expect(await adapter.slippageBps()).to.equal(NEW_SLIPPAGE_BPS);
      });
    });

    context('per-collateral slippage', function () {
      const collateral = TOKENS.WBTC.address;
      const PER_COLLATERAL_BPS = 250;
      let setTx: ContractTransaction;
      let clearTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('module sets a per-collateral override', async () => {
        setTx = await adapter.connect(moduleSigner).setSlippageBps(PER_COLLATERAL_BPS, collateral);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits SlippageSet keyed by the collateral', async () => {
        await expect(setTx).to.emit(adapter, 'SlippageSet').withArgs(collateral, 0, PER_COLLATERAL_BPS);
      });

      it('stores the per-collateral override', async () => {
        expect(await adapter.collateralSlippageBps(collateral)).to.equal(PER_COLLATERAL_BPS);
      });

      it('leaves the global slippageBps unchanged', async () => {
        expect(await adapter.slippageBps()).to.equal(SLIPPAGE_BPS);
      });

      it('reverts when the per-collateral value is unchanged', async () => {
        await expect(
          adapter.connect(moduleSigner).setSlippageBps(PER_COLLATERAL_BPS, collateral)
        ).to.be.revertedWithCustomError(adapter, 'AlreadySet');
      });

      it('reverts when the per-collateral slippage exceeds BPS', async () => {
        const badSlippageBps = 10_001;
        await expect(adapter.connect(moduleSigner).setSlippageBps(badSlippageBps, collateral))
          .to.be.revertedWithCustomError(adapter, 'SlippageOutOfBounds')
          .withArgs(badSlippageBps);
      });

      it('allows clearing the override with a zero value', async () => {
        clearTx = await adapter.connect(moduleSigner).setSlippageBps(0, collateral);
        await expect(clearTx).to.emit(adapter, 'SlippageSet').withArgs(collateral, PER_COLLATERAL_BPS, 0);
        expect(await adapter.collateralSlippageBps(collateral)).to.equal(0);
      });
    });

    context('reverts when', function () {
      it('caller is not the module', async () => {
        const [outsider] = await ethers.getSigners();
        await expect(adapter.connect(outsider).setSlippageBps(NEW_SLIPPAGE_BPS, ethers.constants.AddressZero)).to.be.revertedWithCustomError(adapter, 'Unathorized');
      });

      it('New slippageBps is out of bounds', async () => {
        const badSlippageBps = 0;
        await expect(adapter.connect(moduleSigner).setSlippageBps(badSlippageBps, ethers.constants.AddressZero)).to.be.revertedWithCustomError(adapter, 'SlippageOutOfBounds');
      });

      it('New slippage bps is equal to previous value', async () => {
        await expect(adapter.connect(moduleSigner).setSlippageBps(SLIPPAGE_BPS, ethers.constants.AddressZero)).to.be.revertedWithCustomError(adapter, 'AlreadySet');
      });
    });
  });

  context('calculateMinAmountOut', function () {
    const BPS = 10_000;
    const collateral = TOKENS.WBTC.address;
    const amountIn = BigNumber.from(10).pow(8); // 1 WBTC (8 decimals)
    let baseAssetValue: BigNumber; // oracle-derived value in base units, before slippage

    before(async () => {
      // Recompute the base-asset value with the same math the adapter uses, so the only variable
      // under test is which slippage (global vs per-collateral) gets applied.
      const assetInfo = await comet.getAssetInfoByAddress(collateral);
      const assetPrice = await comet.getPrice(assetInfo.priceFeed);
      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();
      baseAssetValue = amountIn.mul(assetPrice).mul(baseScale).div(assetInfo.scale).div(basePrice);
    });

    after(async () => await snapshot.restore());

    it('applies the global slippageBps when the collateral has no override', async () => {
      expect(await adapter.collateralSlippageBps(collateral)).to.equal(0);
      const expected = baseAssetValue.mul(BPS - SLIPPAGE_BPS).div(BPS);
      expect(await adapter.calculateMinAmountOut(collateral, amountIn)).to.equal(expected);
    });

    it('applies the per-collateral override when the collateral has one', async () => {
      const perCollateralBps = SLIPPAGE_BPS * 2; // distinct from the global value to prove it is used
      await (await adapter.connect(moduleSigner).setSlippageBps(perCollateralBps, collateral)).wait();
      const expected = baseAssetValue.mul(BPS - perCollateralBps).div(BPS);
      expect(await adapter.calculateMinAmountOut(collateral, amountIn)).to.equal(expected);
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
