import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';

import type { CometHarnessInterfaceExtendedAssetList, FaucetToken, NonStandardFaucetFeeToken } from '../build/types/index.js';
import { expect, exp, makeProtocol } from './helpers.js';

describe('CometExt', function () {
  let cometWithExtendedAssetList: CometHarnessInterfaceExtendedAssetList;
  let user: SignerWithAddress;
  let tokens: { [symbol: string]: FaucetToken | NonStandardFaucetFeeToken };

  beforeEach(async () => {
    ({
      cometWithExtendedAssetList,
      users: [user],
      tokens,
    } = await makeProtocol());

    // Set different indices
    const totals = await cometWithExtendedAssetList.totalsBasic();
    await (await cometWithExtendedAssetList.setTotalsBasic({
      trackingSupplyIndex: totals.trackingSupplyIndex,
      trackingBorrowIndex: totals.trackingBorrowIndex,
      baseSupplyIndex: 2e15,
      baseBorrowIndex: 3e15,
      totalSupplyBase: totals.totalSupplyBase,
      totalBorrowBase: totals.totalBorrowBase,
      lastAccrualTime: totals.lastAccrualTime,
      pauseFlags: totals.pauseFlags,
    })).wait();
  });

  it('returns factor scale', async () => {
    const factorScale = await cometWithExtendedAssetList.factorScale();
    expect(factorScale).to.eq(exp(1, 18));
  });

  it('returns price scale', async () => {
    const priceScale = await cometWithExtendedAssetList.priceScale();
    expect(priceScale).to.eq(exp(1, 8));
  });

  it('returns collateralBalance (in units of the collateral asset)', async () => {
    const { WETH } = tokens;
    const wethAddress = await WETH.getAddress();

    await cometWithExtendedAssetList.setCollateralBalance(
      user.address,
      wethAddress,
      exp(5, 18)
    );

    const collateralBalanceOf = await cometWithExtendedAssetList.collateralBalanceOf(
      user.address,
      wethAddress
    );
    expect(collateralBalanceOf).to.eq(exp(5,18));
  });
});
