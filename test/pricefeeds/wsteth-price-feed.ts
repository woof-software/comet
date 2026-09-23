import { ethers, exp, expect } from '../helpers.js';

export async function makeWstETH({ stEthPrice, tokensPerStEth }) {
  const SimplePriceFeedFactory = await ethers.getContractFactory('SimplePriceFeed');
  const stETHPriceFeed = await SimplePriceFeedFactory.deploy(stEthPrice, 18);
  await stETHPriceFeed.waitForDeployment();

  const SimpleWstETHFactory = await ethers.getContractFactory('SimpleWstETH');
  const simpleWstETH = await SimpleWstETHFactory.deploy(tokensPerStEth);
  await simpleWstETH.waitForDeployment();

  const wstETHPriceFeedFactory = await ethers.getContractFactory('WstETHPriceFeed');
  const wstETHPriceFeed = await wstETHPriceFeedFactory.deploy(
    await stETHPriceFeed.getAddress(),
    await simpleWstETH.getAddress(),
    8
  );
  await wstETHPriceFeed.waitForDeployment();

  return {
    simpleWstETH,
    stETHPriceFeed,
    wstETHPriceFeed
  };
}

const testCases = [
  {
    stEthPrice: exp(1300, 18),
    tokensPerStEth: exp(.9, 18),
    result: 144444444444n
  },
  {
    stEthPrice: exp(1000, 18),
    tokensPerStEth: exp(.9, 18),
    result: 111111111111n
  },
  {
    stEthPrice: exp(1000, 18),
    tokensPerStEth: exp(.2, 18),
    result: exp(5000, 8)
  },
  {
    stEthPrice: exp(1000, 18),
    tokensPerStEth: exp(.5, 18),
    result: exp(2000, 8)
  },
  {
    stEthPrice: exp(1000, 18),
    tokensPerStEth: exp(.8, 18),
    result: exp(1250, 8)
  },
  {
    stEthPrice: exp(-1000, 18),
    tokensPerStEth: exp(.8, 18),
    result: exp(-1250, 8)
  },
];

describe('wstETH price feed', function () {
  it('reverts if constructed with bad decimals', async () => {
    const SimplePriceFeedFactory = await ethers.getContractFactory('SimplePriceFeed');
    const stETHPriceFeed = await SimplePriceFeedFactory.deploy(exp(1, 18), 18);
    await stETHPriceFeed.waitForDeployment();

    const SimpleWstETHFactory = await ethers.getContractFactory('SimpleWstETH');
    const simpleWstETH = await SimpleWstETHFactory.deploy(exp(0.9, 18));
    await simpleWstETH.waitForDeployment();

    const wstETHPriceFeedFactory = await ethers.getContractFactory('WstETHPriceFeed');
    await expect(wstETHPriceFeedFactory.deploy(
      await stETHPriceFeed.getAddress(),
      await simpleWstETH.getAddress(),
      20 // decimals_ is too high
    )).to.be.revertedWithCustomError(wstETHPriceFeedFactory, 'BadDecimals');
  });

  describe('latestRoundData', function () {
    for (const { stEthPrice, tokensPerStEth, result } of testCases) {
      it(`stEthPrice (${stEthPrice}), tokensPerStEth (${tokensPerStEth}) -> ${result}`, async () => {
        const { wstETHPriceFeed } = await makeWstETH({ stEthPrice, tokensPerStEth });
        const latestRoundData = await wstETHPriceFeed.latestRoundData();
        const price = latestRoundData.answer;

        expect(price).to.eq(result);
      });
    }

    it('passes along roundId, startedAt, updatedAt and answeredInRound values from stETH price feed', async () => {
      const { stETHPriceFeed, wstETHPriceFeed } = await makeWstETH({
        stEthPrice: exp(1000, 18),
        tokensPerStEth: exp(.8, 18),
      });

      await stETHPriceFeed.setRoundData(
        exp(15, 18), // roundId_,
        1,           // answer_,
        exp(16, 8),  // startedAt_,
        exp(17, 8),  // updatedAt_,
        exp(18, 18)  // answeredInRound_
      );

      const {
        roundId,
        startedAt,
        updatedAt,
        answeredInRound
      } = await wstETHPriceFeed.latestRoundData();

      expect(roundId).to.eq(exp(15, 18));
      expect(startedAt).to.eq(exp(16, 8));
      expect(updatedAt).to.eq(exp(17, 8));
      expect(answeredInRound).to.eq(exp(18, 18));
    });
  });
});
