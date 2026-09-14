import { scenario } from './context/CometContext';
import { CometContext } from './context/CometContext';
import { expect } from 'chai';
import {
  ERC20__factory,
  DexLiquidationModule__factory,
  OneInchV6Adapter__factory,
  SimplePriceFeed__factory,
} from '../build/types';
import { fetch1inchSwapData, ONEINCH_SLIPPAGE_PCT, NETWORKS } from '../test/helpers';
import { getLiquidationModuleAddress, hasDexLiquidation } from './utils';
import { getConfigForScenario } from './utils/scenarioHelper';
import { impersonateAddress } from '../plugins/scenario/utils';

// Compound governance timelock — it holds DEFAULT_ADMIN_ROLE on every liquidation module, so it can grant the
// EXECUTOR_ROLE a keeper needs to call the DEX liquidation entry point.
const DAO = '0x6d903f6003cca6255D85CcA4D3B5E5146dC33925';

// Fraction of the initial oracle price each collateral is dropped to.
const PRICE_DROP_NUMERATOR = 1;
const PRICE_DROP_DENOMINATOR = 2;

/**
 * DEX-route liquidation testing. Route-less collaterals are absorbed, while collaterals with routes are swapped.
 */
scenario.only(
  'Comet#liquidation > dex route liquidation swaps collaterals with route and absorbs the rest',
  {
    filter: async (ctx: CometContext) => await hasDexLiquidation(ctx),
    // Fund Comet with base liquidity so the borrower can draw it.
    tokenBalances: async (ctx: CometContext) => ({
      $comet: { $base: getConfigForScenario(ctx).liquidationBase },
    }),
  },
  async ({ comet, actors }, context, world) => {
    const { albert, betty } = actors;
    const ethers = world.deploymentManager.hre.ethers;

    // The module + adapter are guaranteed present by the filter.
    const moduleAddress = (await getLiquidationModuleAddress(context))!;
    const module = DexLiquidationModule__factory.connect(moduleAddress, ethers.provider);
    const adapter = OneInchV6Adapter__factory.connect(await module.dexAdapter(), ethers.provider);

    const baseToken = await comet.baseToken();
    const baseScale = (await comet.baseScale()).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const factorScale = (await comet.factorScale()).toBigInt();
    const numAssets = await comet.numAssets();
    const net = NETWORKS[world.base.network];

    // 1. Build a position by supplying each collateral.
    const perAssetBaseWei =
      (BigInt(getConfigForScenario(context).liquidationBase) * baseScale) / BigInt(numAssets);

    const supplied: { asset: string, amount: bigint, priceFeed: string, price: bigint }[] = [];
    let borrowCapacityWei = 0n;
    for (let i = 0; i < numAssets; i++) {
      const info = await comet.getAssetInfo(i);
      // Skip delisted collaterals.
      if (info.borrowCollateralFactor.toBigInt() === 0n) continue;

      const price = (await comet.getPrice(info.priceFeed)).toBigInt();
      // Collateral amount worth ~perAssetBaseWei of base: amount = baseValue * basePrice/baseScale * scale/price.
      const amount = (perAssetBaseWei * basePrice * info.scale.toBigInt()) / (baseScale * price);
      if (amount === 0n) continue;

      const asset = context.getAssetByAddress(info.asset);
      try {
        await context.sourceTokens(amount, asset, albert);
      } catch {
        continue; // not sourceable on this fork 
      }
      await asset.approve(albert, comet.address);
      await albert.safeSupplyAsset({ asset: info.asset, amount });

      supplied.push({ asset: info.asset, amount, priceFeed: info.priceFeed, price });
      borrowCapacityWei += (perAssetBaseWei * info.borrowCollateralFactor.toBigInt()) / factorScale;
    }
    expect(supplied.length > 0, 'no sourceable collateral to build a position').to.be.true;

    // 2. Borrow just under the BCF capacity.
    await albert.withdrawAsset({ asset: baseToken, amount: (borrowCapacityWei * 95n) / 100n });
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    // 3. Drop every collateral price so the position can be liquidated.
    // TODO rewrite to ctx.changePriceFeeds once it is compatible with Comet with liquidation module
    const oracleSigner = await world.deploymentManager.getSigner();
    for (const s of supplied) {
      const dropped = (s.price * BigInt(PRICE_DROP_NUMERATOR)) / BigInt(PRICE_DROP_DENOMINATOR);
      await SimplePriceFeed__factory.connect(s.priceFeed, oracleSigner).setRoundData(0, dropped, 0, 0, 0);
    }
    expect(await comet.isLiquidatable(albert.address)).to.be.true;

    // 4. Grant the keeper (betty) the executor role.
    const dao = await impersonateAddress(world.deploymentManager, DAO);
    await context.setNextBaseFeeToZero();
    await module.connect(dao).grantRole(await module.EXECUTOR_ROLE(), betty.address, { gasPrice: 0 });

    // 5. Build swap data for each seized collateral. Collaterals without swap route should be absorbed.
    const plan = await module.seizurePlan(albert.address);
    const ROUTE_UNSET = 0;
    const swapData = await Promise.all(
      plan.map(async (s) => {
        const routeless = Number(await adapter.routeKind(s.asset)) === ROUTE_UNSET;
        if (routeless || !net) return '0x'; // no route -> absorbed (swept back to Comet)
        try {
          return await fetch1inchSwapData({
            chainId: net.chainId,
            src: s.asset,
            dst: baseToken,
            amount: s.seizedAmount.toString(),
            from: adapter.address,
            slippage: ONEINCH_SLIPPAGE_PCT,
            ...(net.protocols ? { protocols: net.protocols } : {}),
          });
        } catch {
          return '0x';
        }
      })
    );

    // Snapshot each seized collateral's Comet ERC-20 balance and reserves before liquidating.
    const before = new Map<string, { comet: bigint, reserves: bigint }>();
    for (const s of plan) {
      const erc20 = ERC20__factory.connect(s.asset, ethers.provider);
      before.set(s.asset.toLowerCase(), {
        comet: (await erc20.balanceOf(comet.address)).toBigInt(),
        reserves: (await comet.getCollateralReserves(s.asset)).toBigInt(),
      });
    }
    const borrowBefore = (await comet.borrowBalanceOf(albert.address)).toBigInt();

    // 6. Keeper runs the DEX-route liquidation.
    await context.setNextBaseFeeToZero();
    const receipt = await (
      await module.connect(betty.signer).liquidate(betty.address, albert.address, swapData, { gasPrice: 0 })
    ).wait();

    // Collaterals whose swap failed were swept back to Comet (the adapter emits RedundantSwapFailed for each).
    const swept = new Set<string>();
    for (const log of receipt.logs) {
      try {
        const parsed = adapter.interface.parseLog(log);
        if (parsed.name === 'RedundantSwapFailed') swept.add((parsed.args.collateral as string).toLowerCase());
      } catch {
        // not an adapter event
      }
    }

    // 7. Every seized collateral was either swapped out of Comet or absorbed back into its reserves. Log which.
    const swapped: string[] = [];
    const absorbed: string[] = [];
    for (const s of plan) {
      const key = s.asset.toLowerCase();
      const b = before.get(key)!;
      const seized = s.seizedAmount.toBigInt();
      const erc20 = ERC20__factory.connect(s.asset, ethers.provider);
      const symbol = await erc20.symbol();
      const cometAfter = (await erc20.balanceOf(comet.address)).toBigInt();
      const reservesAfter = (await comet.getCollateralReserves(s.asset)).toBigInt();

      if (swept.has(key)) {
        // Route-less: absorbed. Comet's token balance is unchanged (out then back) and reserves grew by it.
        expect(cometAfter, `${symbol} absorbed: comet balance`).to.equal(b.comet);
        expect(reservesAfter - b.reserves, `${symbol} absorbed: reserves`).to.equal(seized);
        absorbed.push(symbol);
      } else {
        // Swapped: the tokens left Comet and reserves are unchanged.
        expect(b.comet - cometAfter, `${symbol} swapped: comet balance`).to.equal(seized);
        expect(reservesAfter, `${symbol} swapped: reserves`).to.equal(b.reserves);
        swapped.push(symbol);
      }
    }
    console.log(`[${context.world.base.name}] swapped on DEX: ${swapped.join(', ') || '(none)'}`);
    console.log(`[${context.world.base.name}] absorbed: ${absorbed.join(', ') || '(none)'}`);

    // 8. The debt was reduced and the position is no longer liquidatable.
    expect((await comet.borrowBalanceOf(albert.address)).toBigInt()).to.be.lessThan(borrowBefore);
    expect(await comet.isLiquidatable(albert.address)).to.be.false;

    return receipt;
  }
);
