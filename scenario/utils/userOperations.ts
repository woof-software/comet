import { factorScale } from '../../test/helpers';
import { CometContext } from '../context/CometContext';
import CometActor from '../context/CometActor';
import CometAsset from '../context/CometAsset';
import { addTokenBalance, hasWritableBalanceSlot, TOKENS_BY_NETWORK } from './erc20Balance';
import { getUsableCollateralIndices } from './index';

/**
 * @notice Sources the asset to the actor and supplies it to Comet
 * @dev Comet rejects borrows from a market without supply, so the base for a borrow has to come from a lender
 */
export async function sourceAndSupply(context: CometContext, asset: CometAsset, actor: CometActor, amount: bigint) {
  const comet = await context.getComet();
  await context.sourceTokens(amount, asset, actor.address);
  await asset.approve(actor, comet.address);
  await actor.supplyAsset({ asset: asset.address, amount });
}

/**
 * @notice Supplies the base token from a lender, an amount that is noticeable next to the total supply of the market
 * @dev A market without supply gets a fixed amount instead
 * @return The supplied amount
 */
export async function supplyBaseFromLender(context: CometContext, lender: CometActor): Promise<bigint> {
  const comet = await context.getComet();
  const baseToken = context.getAssetByAddress(await comet.baseToken());
  const baseScale = (await comet.baseScale()).toBigInt();
  const noticeableAmount = (await comet.totalSupply()).toBigInt() / 100n;
  const amount = noticeableAmount > 1000n * baseScale ? noticeableAmount : 1000n * baseScale;

  await addTokenBalance(context, baseToken.address, lender.address, amount);
  await baseToken.approve(lender, comet.address);
  await lender.supplyAsset({ asset: baseToken.address, amount });
  return amount;
}

/**
 * @notice The borrow that brings the current utilization of the market to the target one
 */
export async function borrowAmountToUtilization(context: CometContext, targetUtilization: bigint): Promise<bigint> {
  const comet = await context.getComet();
  const totalSupply = (await comet.totalSupply()).toBigInt();
  const totalBorrow = (await comet.totalBorrow()).toBigInt();
  const borrowAmount = targetUtilization * totalSupply / factorScale - totalBorrow;
  if (borrowAmount <= 0n) {
    throw new Error(`Utilization ${await comet.getUtilization()} is already at or above the target ${targetUtilization}`);
  }
  return borrowAmount;
}

/**
 * @notice Supplies the collateral that covers a borrow with a margin, within the free room under the supply caps
 * @dev A borrow that moves utilization of a live market takes more collateral than whales hold, so only assets whose
 *      balance can be set directly are used, the ones with the most borrowing power under their caps first. On a
 *      network without a token registry every asset is sourced by the context
 */
export async function supplyCollateralForBorrow(
  context: CometContext,
  borrower: CometActor,
  borrowAmount: bigint
): Promise<{ collateralAsset: CometAsset, amount: bigint }[]> {
  const comet = await context.getComet();
  const network = context.world.deploymentManager.network;
  const baseScale = (await comet.baseScale()).toBigInt();
  const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();

  const candidates: { asset: string, room: bigint, price: bigint, scale: bigint, borrowCollateralFactor: bigint, roomBorrowValue: bigint }[] = [];
  for (const i of await getUsableCollateralIndices(context)) {
    const info = await comet.getAssetInfo(i);
    if (TOKENS_BY_NETWORK[network] !== undefined && !hasWritableBalanceSlot(network, info.asset)) continue;
    const room = info.supplyCap.toBigInt() - (await comet.totalsCollateral(info.asset)).totalSupplyAsset.toBigInt();
    if (room <= 0n) continue;
    const price = (await comet.getPrice(info.priceFeed)).toBigInt();
    const scale = info.scale.toBigInt();
    const borrowCollateralFactor = info.borrowCollateralFactor.toBigInt();
    // Base borrowable against the whole room
    const roomBorrowValue = room * price * borrowCollateralFactor * baseScale / (scale * factorScale * basePrice);
    candidates.push({ asset: info.asset, room, price, scale, borrowCollateralFactor, roomBorrowValue });
  }
  candidates.sort((a, b) => (b.roomBorrowValue > a.roomBorrowValue ? 1 : -1));

  // The collateral covers the borrow with a margin, so the borrow stays collateralized while interest accrues
  let remainingBorrowValue = borrowAmount * 110n / 100n;
  const supplied: { collateralAsset: CometAsset, amount: bigint }[] = [];
  for (const { asset, room, price, scale, borrowCollateralFactor, roomBorrowValue } of candidates) {
    if (remainingBorrowValue <= 0n) break;
    const neededAmount = remainingBorrowValue * basePrice * scale * factorScale / (baseScale * price * borrowCollateralFactor) + 1n;
    const amount = neededAmount < room ? neededAmount : room;
    const collateralAsset = context.getAssetByAddress(asset);
    await addTokenBalance(context, asset, borrower.address, amount);
    await collateralAsset.approve(borrower, comet.address);
    await borrower.supplyAsset({ asset, amount });
    // The needed amount covers the rest of the borrow value even when it takes the whole room
    remainingBorrowValue = neededAmount <= room ? 0n : remainingBorrowValue - roomBorrowValue;
    supplied.push({ collateralAsset, amount });
  }

  if (remainingBorrowValue > 0n) {
    throw new Error(`Not enough room under the supply caps for the collateral, ${remainingBorrowValue} of base value is left uncovered`);
  }
  return supplied;
}

/**
 * @notice Supplies the collateral and borrows the base token, which Comet pays out of the liquidity added for it
 */
export async function borrowFromMarket(
  context: CometContext,
  borrower: CometActor,
  borrowAmount: bigint
): Promise<{ collateralAsset: CometAsset, amount: bigint }[]> {
  const comet = await context.getComet();
  const collateral = await supplyCollateralForBorrow(context, borrower, borrowAmount);
  // Comet pays the borrow out of the liquidity added for it
  await addTokenBalance(context, await comet.baseToken(), comet.address, borrowAmount);
  await borrower.withdrawAsset({ asset: await comet.baseToken(), amount: borrowAmount });
  return collateral;
}
