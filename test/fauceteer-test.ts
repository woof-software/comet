import {
  Fauceteer__factory,
  FaucetToken__factory
} from '../build/types/index.js';
import { ethers, exp, expect, fastForward } from './helpers.js';

async function makeFauceteer() {
  const [deployer] = await ethers.getSigners();
  const FauceteerFactory = new Fauceteer__factory(deployer);
  const fauceteer = await FauceteerFactory.deploy();

  const FaucetTokenFactory = new FaucetToken__factory(deployer);
  const COMP = await FaucetTokenFactory.deploy(1e6, 'COMP', 18, 'COMP');
  const USDC = await FaucetTokenFactory.deploy(1e6, 'USDC', 6, 'USDC');
  await Promise.all([
    fauceteer.waitForDeployment(),
    COMP.waitForDeployment(),
    USDC.waitForDeployment(),
  ]);

  return {
    fauceteer,
    tokens: { COMP, USDC }
  };
}

describe('Fauceteer', function () {
  it('issues .01% of balance of requested asset to requester', async () => {
    const [_minter, requester] = await ethers.getSigners();
    const { fauceteer, tokens: { USDC, COMP } } = await makeFauceteer();
    const fauceteerAddress = await fauceteer.getAddress();
    const usdcAddress = await USDC.getAddress();
    const compAddress = await COMP.getAddress();
    await USDC.allocateTo(fauceteerAddress, exp(100, 6));
    await COMP.allocateTo(fauceteerAddress, exp(100, 18));

    expect(await USDC.balanceOf(requester.address)).to.eq(0n);
    expect(await COMP.balanceOf(requester.address)).to.eq(0n);

    await fauceteer.connect(requester).drip(usdcAddress);
    await fauceteer.connect(requester).drip(compAddress);

    // fauceter maintains 99.99 units of USDC
    expect(await USDC.balanceOf(fauceteerAddress)).to.eq(99990000n);
    // requester gets .01 units (10000 / 1e6 == .01)
    expect(await USDC.balanceOf(requester.address)).to.eq(10000n);

    // fauceter maintains 99.99% of initial COMP balance
    expect(await COMP.balanceOf(fauceteerAddress)).to.eq(99990000000000000000n);
    // requester gets .01 units (10000000000000000 / 1e18 == .01)
    expect(await COMP.balanceOf(requester.address)).to.eq(10000000000000000n);
  });

  it('throws an error if balance of asset is 0', async () => {
    const [_minter, requester] = await ethers.getSigners();
    const { fauceteer, tokens: { USDC } } = await makeFauceteer();
    const usdcAddress = await USDC.getAddress();

    expect(await USDC.balanceOf(requester.address)).to.eq(0n);

    await expect(
      fauceteer.connect(requester).drip(usdcAddress)
    ).to.be.revertedWithCustomError(fauceteer, 'BalanceTooLow');
  });

  it('limits each address to one request per asset per day', async () => {
    const [_minter, r1, r2] = await ethers.getSigners();
    const { fauceteer, tokens: { USDC, COMP } } = await makeFauceteer();
    const fauceteerAddress = await fauceteer.getAddress();
    const usdcAddress = await USDC.getAddress();
    const compAddress = await COMP.getAddress();

    await USDC.allocateTo(fauceteerAddress, exp(500, 6));
    await COMP.allocateTo(fauceteerAddress, exp(500, 18));

    expect(await USDC.balanceOf(r1.address)).to.eq(0n);
    expect(await COMP.balanceOf(r1.address)).to.eq(0n);
    expect(await USDC.balanceOf(r2.address)).to.eq(0n);
    expect(await COMP.balanceOf(r2.address)).to.eq(0n);

    // first requester receives tokens
    await fauceteer.connect(r1).drip(usdcAddress);
    expect(await USDC.balanceOf(r1.address)).to.eq(50000n);
    await fauceteer.connect(r1).drip(compAddress);
    expect(await COMP.balanceOf(r1.address)).to.eq(50000000000000000n);

    // repeated request fails
    await expect(
      fauceteer.connect(r1).drip(usdcAddress)
    ).to.be.revertedWithCustomError(fauceteer, 'RequestedTooFrequently');
    await expect(
      fauceteer.connect(r1).drip(compAddress)
    ).to.be.revertedWithCustomError(fauceteer, 'RequestedTooFrequently');

    // does not prevent other requesters from receiving tokens
    await fauceteer.connect(r2).drip(usdcAddress);
    await fauceteer.connect(r2).drip(compAddress);

    // wait a day and you can request more
    await fastForward(60 * 60 * 24);
    await fauceteer.connect(r1).drip(usdcAddress);
    await fauceteer.connect(r1).drip(compAddress);
  });
});
