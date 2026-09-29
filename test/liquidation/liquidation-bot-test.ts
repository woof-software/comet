import { encodeBytes32String, MaxUint256, ZeroAddress } from 'ethers';

import { event, expect, exp, wait } from '../helpers.js';
import { Exchange, forkMainnet, makeLiquidatableProtocol, resetHardhatNetwork } from './makeLiquidatableProtocol.js';
import { DAI, SUSHISWAP_ROUTER, UNISWAP_ROUTER } from './addresses.js';

describe.skip('Liquidator', function () {
  before(forkMainnet);
  after(resetHardhatNetwork);

  it('Should init liquidator', async function () {
    const { liquidator } = await makeLiquidatableProtocol();
    expect(await liquidator.uniswapRouter()).to.equal(UNISWAP_ROUTER);
    expect(await liquidator.sushiSwapRouter()).to.equal(SUSHISWAP_ROUTER);
  });

  it('Should execute WETH flash swap with profit', async () => {
    const { comet, liquidator, users: [owner, underwater], assets: { usdc, weth } } = await makeLiquidatableProtocol();
    await weth.connect(underwater).approve(await comet.getAddress(), exp(120, 18));
    await comet.connect(underwater).supply(await weth.getAddress(), exp(120, 18));
    await comet.setBasePrincipal(underwater.address, -(exp(4000, 6)));

    const beforeUSDCBalance = await usdc.balanceOf(owner.address);

    const tx = await wait(liquidator.connect(owner).absorbAndArbitrage(
      await comet.getAddress(),
      [underwater.address],
      [await weth.getAddress()],
      [
        {
          exchange: Exchange.Uniswap,
          uniswapPoolFee: 500,
          swapViaWeth: false,
          balancerPoolId: encodeBytes32String(''),
          curvePool: ZeroAddress
        }
      ],
      [MaxUint256],
      DAI,
      100,
      10e6
    ));

    const afterUSDCBalance = await usdc.balanceOf(owner.address);
    const profit = afterUSDCBalance - beforeUSDCBalance;

    expect(tx.hash).to.be.not.null;
    expect(profit).to.be.greaterThan(0);
    expect(event(tx, 2)).to.deep.equal({
      Absorb: {
        initiator: owner.address,
        accounts: [ underwater.address ]
      }
    });
  });

  it('Should execute WBTC flash swap with profit', async () => {
    const { comet, liquidator, users: [owner, underwater], assets: { usdc, wbtc } } = await makeLiquidatableProtocol();
    await wbtc.connect(underwater).approve(await comet.getAddress(), exp(2, 8));
    await comet.connect(underwater).supply(await wbtc.getAddress(), exp(2, 8));
    await comet.setBasePrincipal(underwater.address, -(exp(40000, 6)));

    const beforeUSDCBalance = await usdc.balanceOf(owner.address);
    const tx = await wait(liquidator.connect(owner).absorbAndArbitrage(
      await comet.getAddress(),
      [underwater.address],
      [await wbtc.getAddress()],
      [
        {
          exchange: Exchange.Uniswap,
          uniswapPoolFee: 3000,
          swapViaWeth: true,
          balancerPoolId: encodeBytes32String(''),
          curvePool: ZeroAddress
        }
      ],
      [MaxUint256],
      DAI,
      100,
      10e6
    ));

    const afterUSDCBalance = await usdc.balanceOf(owner.address);
    const profit = afterUSDCBalance - beforeUSDCBalance;
    expect(tx.hash).to.be.not.null;
    expect(profit).to.be.greaterThan(0);
    expect(event(tx, 2)).to.deep.equal({
      Absorb: {
        initiator: owner.address,
        accounts: [ underwater.address ]
      }
    });
  });

  it('Should execute UNI flash swap with profit', async () => {
    const { comet, liquidator, users: [owner, underwater], assets: { usdc, uni } } = await makeLiquidatableProtocol();
    await uni.connect(underwater).approve(await comet.getAddress(), exp(120, 18));
    await comet.connect(underwater).supply(await uni.getAddress(), exp(120, 18));
    await comet.setBasePrincipal(underwater.address, -(exp(40000, 6)));

    const beforeUSDCBalance = await usdc.balanceOf(owner.address);
    const tx = await wait(liquidator.connect(owner).absorbAndArbitrage(
      await comet.getAddress(),
      [underwater.address],
      [await uni.getAddress()],
      [
        {
          exchange: Exchange.Uniswap,
          uniswapPoolFee: 3000,
          swapViaWeth: true,
          balancerPoolId: encodeBytes32String(''),
          curvePool: ZeroAddress
        }
      ],
      [MaxUint256],
      DAI,
      100,
      10e6
    ));

    const afterUSDCBalance = await usdc.balanceOf(owner.address);
    const profit = afterUSDCBalance - beforeUSDCBalance;
    expect(tx.hash).to.be.not.null;
    expect(profit).to.be.greaterThan(0);
    expect(event(tx, 2)).to.deep.equal({
      Absorb: {
        initiator: owner.address,
        accounts: [ underwater.address ]
      }
    });
  });

  it('Should execute COMP flash swap with profit', async () => {
    const { comet, liquidator, users: [owner, underwater], assets: { usdc, comp } } = await makeLiquidatableProtocol();
    await comp.connect(underwater).approve(await comet.getAddress(), exp(12, 18));
    await comet.connect(underwater).supply(await comp.getAddress(), exp(12, 18));
    await comet.setBasePrincipal(underwater.address, -(exp(40000, 6)));

    const beforeUSDCBalance = await usdc.balanceOf(owner.address);
    const tx = await wait(liquidator.connect(owner).absorbAndArbitrage(
      await comet.getAddress(),
      [underwater.address],
      [await comp.getAddress()],
      [
        {
          exchange: Exchange.Uniswap,
          uniswapPoolFee: 3000,
          swapViaWeth: true,
          balancerPoolId: encodeBytes32String(''),
          curvePool: ZeroAddress
        }
      ],
      [MaxUint256],
      DAI,
      100,
      10e6
    ));

    const afterUSDCBalance = await usdc.balanceOf(owner.address);
    const profit = afterUSDCBalance - beforeUSDCBalance;
    expect(tx.hash).to.be.not.null;
    expect(profit).to.be.greaterThan(0);
    expect(event(tx, 2)).to.deep.equal({
      Absorb: {
        initiator: owner.address,
        accounts: [ underwater.address ]
      }
    });
  });

  it('Should execute LINK flash swap with profit', async () => {
    const { comet, liquidator, users: [owner, underwater], assets: { usdc, link } } = await makeLiquidatableProtocol();
    await link.connect(underwater).approve(await comet.getAddress(), exp(12, 18));
    await comet.connect(underwater).supply(await link.getAddress(), exp(12, 18));
    await comet.setBasePrincipal(underwater.address, -(exp(4000, 6)));

    const beforeUSDCBalance = await usdc.balanceOf(owner.address);
    const tx = await wait(liquidator.connect(owner).absorbAndArbitrage(
      await comet.getAddress(),
      [underwater.address],
      [await link.getAddress()],
      [
        {
          exchange: Exchange.Uniswap,
          uniswapPoolFee: 3000,
          swapViaWeth: true,
          balancerPoolId: encodeBytes32String(''),
          curvePool: ZeroAddress
        }
      ],
      [MaxUint256],
      DAI,
      100,
      10e6
    ));

    const afterUSDCBalance = await usdc.balanceOf(owner.address);
    const profit = afterUSDCBalance - beforeUSDCBalance;
    expect(tx.hash).to.be.not.null;
    expect(profit).to.be.greaterThan(0);
    expect(event(tx, 2)).to.deep.equal({
      Absorb: {
        initiator: owner.address,
        accounts: [ underwater.address ]
      }
    });
  });
});
