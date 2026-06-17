import { expect } from 'chai';
import { ethers } from 'hardhat';
import { OneInchV6CoreAdapter, OneInchV6CoreAdapter__factory } from '../../build/types';
import {
  RouteConfig,
  CORE_ROUTER,
  REDUNDANT_ROUTER,
  SLIPPAGE_BPS,
  TOKENS,
  MARKETS,
  setupDexAdapter,
} from '../helpers';

const suite =
  process.env.MAINNET_QUICKNODE_LINK && process.env.ONEINCH_API_KEY ? describe : describe.skip;

suite('CoreDexAdapter', function () {
  this.timeout(180_000);

  const market = MARKETS.usdc;

  let adapter: OneInchV6CoreAdapter;
  let adapterFactory: OneInchV6CoreAdapter__factory;
  let routes: RouteConfig[];
  let baseToken: string;
  let moduleAddress: string;

  before(async () => {
    ({ adapter, adapterFactory, routes, baseToken, moduleAddress } = await setupDexAdapter(market));
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
            market.comet,
            ethers.constants.AddressZero,
            CORE_ROUTER,
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
            market.comet,
            moduleAddress,
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

  it('rejects swap() from a non-module caller', async () => {
    const [outsider] = await ethers.getSigners();
    await expect(
      adapter.connect(outsider).swap(TOKENS.WBTC.address, '0x')
    ).to.be.revertedWithCustomError(adapter, 'Unathorized');
  });
});
