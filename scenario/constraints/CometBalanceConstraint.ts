import type { Constraint, Solution } from '../../plugins/scenario/index.js';
import type { CometContext } from '../context/CometContext.js';
import type CometActor from '../context/CometActor.js';
import { expect } from 'chai';
import type { Requirements } from './Requirements.js';
import { baseBalanceOf, exp, factorScale } from '../../test/helpers.js';
import { ComparativeAmount, ComparisonOp, getAssetFromName, parseAmount, getExpectedBaseBalance, getToTransferAmount } from '../utils/index.js';

async function borrowBase(borrowActor: CometActor, toBorrowBase: bigint, context: CometContext) {
  const comet = await context.getComet();
  // XXX only use collaterals that are not specified in the requirement or have `gte`
  const { asset: collateralAsset, borrowCollateralFactor, priceFeed, scale } = await comet.getAssetInfo(0);

  const collateralToken = context.getAssetByAddress(collateralAsset);
  const baseTokenAddress = await comet.baseToken();

  const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
  const collateralPrice = await comet.getPrice(priceFeed);

  const baseScale = await comet.baseScale();
  const collateralScale = scale;

  const collateralWeiPerUnitBase = (collateralScale * basePrice) / collateralPrice;
  let collateralNeeded = (collateralWeiPerUnitBase * toBorrowBase) / baseScale;
  collateralNeeded = (collateralNeeded * factorScale) / borrowCollateralFactor; // adjust for borrowCollateralFactor
  collateralNeeded = (collateralNeeded * 11n) / 10n; // add fudge factor

  await context.sourceTokens(collateralNeeded, collateralToken, borrowActor);
  await collateralToken.approve(borrowActor, await comet.getAddress());
  await borrowActor.safeSupplyAsset({ asset: collateralToken.address, amount: collateralNeeded });
  await borrowActor.withdrawAsset({ asset: baseTokenAddress, amount: toBorrowBase });
}

export class CometBalanceConstraint<T extends CometContext, R extends Requirements> implements Constraint<T, R> {
  async solve(requirements: R, initialContext: T) {
    let assetsByActor = requirements.cometBalances;
    if (typeof assetsByActor === 'function') {
      assetsByActor = await assetsByActor(initialContext);
    }

    if (assetsByActor) {
      const actorsByAsset = Object.entries(assetsByActor).reduce((a, [actor, assets]) => {
        return Object.entries(assets).reduce((a, [asset, rawAmount]) => {
          const v = a[asset] || {};
          a[asset] = { [actor]: parseAmount(rawAmount), ...v };
          return a;
        }, a);
      }, {});

      // XXX ideally we do for each actor:
      //  if lt or lte: lt solution
      //  if gt or gte: gt solution
      //  if gte or lte or eq: eq solution
      //  but its combinatorial

      // XXX ideally when properties fail
      //  we can report the names of the solution which were applied
      const solutions: Solution<T>[] = [];
      solutions.push(async function barelyMeet(context: T) {
        const comet = await context.getComet();
        const cometAddress = await comet.getAddress();
        for (const assetName in actorsByAsset) {
          const asset = await getAssetFromName(assetName, context);
          for (const actorName in actorsByAsset[assetName]) {
            const actor = context.actors[actorName];
            const amount: ComparativeAmount = actorsByAsset[assetName][actorName];
            const cometBalance = await comet.collateralBalanceOf(actor.address, asset.address);
            const decimals = await asset.decimals();
            const toTransfer = getToTransferAmount(amount, cometBalance, decimals);
            if (toTransfer > 0) {
              // Case: Supply asset
              // 1. Source tokens to user
              await context.sourceTokens(toTransfer, asset.address, actor.address);
              // 2. Supply tokens to Comet
              // Note: but will interest rates cause supply/borrow to not exactly match the desired amount?
              await asset.approve(actor, cometAddress);
              await actor.safeSupplyAsset({ asset: asset.address, amount: toTransfer });
            } else if (toTransfer < 0) {
              const toWithdraw = -toTransfer;
              const baseToken = await context.getAssetByAddress(await comet.baseToken());
              if (asset === baseToken) {
                // Case: Withdraw base asset
                // 1. Calculate Comet's base balance shortfall
                const cometBaseBalance = await baseToken.balanceOf(cometAddress);
                const cometBaseBalanceShortfall = toWithdraw - cometBaseBalance;
                // 2. If there is a shortfall, make up for it by sourcing base tokens to Comet
                if (cometBaseBalanceShortfall > 0) {
                  await context.sourceTokens(cometBaseBalanceShortfall, baseToken.address, cometAddress);
                }
                // 3. Borrow base (will supply collateral if needed to borrow)
                await borrowBase(actor, -toTransfer, context);
              } else {
                // Case: Withdraw collateral asset
                // 1. Withdraw collateral
                await actor.withdrawAsset({ asset: asset.address, amount: toWithdraw });
              }
            }
          }
        }
        return context;
      });
      return solutions;
    } else {
      return null;
    }
  }

  async check(requirements: R, context: T) {
    const assetsByActor = requirements.cometBalances;
    if (assetsByActor) {
      const comet = await context.getComet();
      for (const [actorName, assets] of Object.entries(assetsByActor)) {
        for (const [assetName, rawAmount] of Object.entries(assets)) {
          const actor = context.actors[actorName];
          const asset = await getAssetFromName(assetName, context);
          const amount = parseAmount(rawAmount);
          const decimals = await asset.decimals();
          const baseToken = await comet.baseToken();
          let actualBalance: bigint;
          let expectedBalance: bigint;
          if (asset.address === baseToken) {
            actualBalance = await baseBalanceOf(comet, actor.address);
            const baseIndexScale = await comet.baseIndexScale();
            let baseIndex;
            if (amount.val >= 0) {
              baseIndex = (await comet.totalsBasic()).baseSupplyIndex;
            } else {
              baseIndex = (await comet.totalsBasic()).baseBorrowIndex;
            }
            expectedBalance = getExpectedBaseBalance(exp(amount.val, decimals), baseIndexScale, baseIndex);
          } else {
            actualBalance = await comet.collateralBalanceOf(actor.address, asset.address);
            expectedBalance = exp(amount.val, decimals);
          }
          switch (amount.op) {
            case ComparisonOp.EQ:
              expect(actualBalance).to.equal(expectedBalance);
              break;
            case ComparisonOp.GTE:
              expect(actualBalance).to.be.at.least(expectedBalance);
              break;
            case ComparisonOp.LTE:
              expect(actualBalance).to.be.at.most(expectedBalance);
              break;
            case ComparisonOp.GT:
              expect(actualBalance).to.be.above(expectedBalance);
              break;
            case ComparisonOp.LT:
              expect(actualBalance).to.be.below(expectedBalance);
              break;
          }
        }
      }
    }
  }
}
