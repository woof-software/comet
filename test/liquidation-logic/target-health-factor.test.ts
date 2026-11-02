import { ethers, expect, exp, makeProtocol, mulPrice, mulFactor, ceilDiv, toBigInt, factorScale, ONE, wantedCollateralValue } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, FaucetToken, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

// The liquidation suites run at the default target. This one checks that absorb solves against the
// target the market is configured with, including the lowest one the constructor accepts.
describe('absorb with a configured target health factor', function () {
  const baseTokenPrice = exp(1, 8);
  const baseScale = exp(1, 6);
  const collateralAmount = exp(1, 18); // 1 COMP, $100
  const borrowAmount = exp(80, 6); // $80
  const droppedPrice = exp(93, 8); // LCF-weighted value is $79.05, below the $80 debt

  for (const targetHealthFactor of [ONE, exp(1.2, 18)]) {
    describe(`targetHealthFactor = ${targetHealthFactor}`, function () {
      let comet: CometHarnessInterfaceExtendedAssetList;
      let comp: FaucetToken;
      let compPriceFeed: SimplePriceFeed;
      let alice: SignerWithAddress;
      let absorber: SignerWithAddress;
      let absorbTx: ContractTransaction;

      before(async function () {
        const protocol = await makeProtocol({
          base: 'USDC',
          assets: {
            USDC: { decimals: 6, initialPrice: 1 },
            COMP: { decimals: 18, initialPrice: 100 },
          },
          baseBorrowMin: 0,
          baseTrackingSupplySpeed: 0,
          baseTrackingBorrowSpeed: 0,
          targetHealthFactor,
        });
        comet = protocol.comet;
        comp = protocol.tokens['COMP'] as FaucetToken;
        compPriceFeed = protocol.priceFeeds['COMP'];
        let lender: SignerWithAddress;
        [alice, absorber, lender] = protocol.users;

        const usdc = protocol.tokens['USDC'] as FaucetToken;
        await usdc.allocateTo(lender.address, exp(1000, 6));
        await usdc.connect(lender).approve(comet.address, ethers.constants.MaxUint256);
        await comet.connect(lender).supply(usdc.address, exp(1000, 6));

        await comp.allocateTo(alice.address, collateralAmount);
        await comp.connect(alice).approve(comet.address, ethers.constants.MaxUint256);
        await comet.connect(alice).supply(comp.address, collateralAmount);
        await comet.connect(alice).withdraw(usdc.address, borrowAmount);

        await compPriceFeed.setRoundData(0, droppedPrice, 0, 0, 0);
      });

      it('absorb is successful', async function () {
        absorbTx = await comet.connect(absorber).absorb(absorber.address, [alice.address]);
        await expect(absorbTx).to.not.be.reverted;
      });

      it('alice is no longer liquidatable', async function () {
        expect(await comet.isLiquidatable(alice.address)).to.be.false;
      });

      it('new health factor reaches the configured target', async function () {
        const assetInfo = await comet.getAssetInfoByAddress(comp.address);
        const balance = await comet.collateralBalanceOf(alice.address, comp.address);
        const liquidityValue = mulFactor(mulPrice(balance, droppedPrice, assetInfo.scale), assetInfo.liquidateCollateralFactor);
        const debtValue = mulPrice(await comet.borrowBalanceOf(alice.address), baseTokenPrice, baseScale);

        expect(liquidityValue * factorScale / debtValue).to.be.greaterThanOrEqual(targetHealthFactor);
      });

      it('seizes the amount solved for the configured target', async function () {
        const assetInfo = await comet.getAssetInfoByAddress(comp.address);
        const debtValue = mulPrice(borrowAmount, baseTokenPrice, baseScale);
        const collateralizedValue = mulFactor(mulPrice(collateralAmount, droppedPrice, assetInfo.scale), assetInfo.liquidateCollateralFactor);
        const wantedValue = wantedCollateralValue(debtValue, collateralizedValue, assetInfo, targetHealthFactor);
        const seizedAmount = ceilDiv(wantedValue * toBigInt(assetInfo.scale), droppedPrice);

        expect(await comet.collateralBalanceOf(alice.address, comp.address)).to.be.equal(collateralAmount - seizedAmount);
      });
    });
  }
});
