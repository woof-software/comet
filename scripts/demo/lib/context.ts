import hre from 'hardhat';
import { readFileSync } from 'fs';
import path from 'path';
import {
  CometInterface__factory,
  LiquidationModule__factory,
  OneInchV6Adapter__factory,
  SimplePriceFeed__factory,
  ERC20__factory,
} from '../../../build/types';

/**
 * Loads the deployed demo market and the demo actors from a running (forked) hardhat node.
 */
export async function loadDemo() {
  const rootsPath = path.join(__dirname, '../../../deployments/localhost/usdc-dex/roots.json');
  const cometAddress =
    process.env.COMET_ADDRESS ?? (JSON.parse(readFileSync(rootsPath, 'utf8')) as { comet: string }).comet;

  const [deployer, lender, borrower] = await hre.ethers.getSigners();
  const provider = hre.ethers.provider;

  const comet = CometInterface__factory.connect(cometAddress, provider);
  const module = LiquidationModule__factory.connect(await comet.liquidationModule(), provider);
  const adapter = OneInchV6Adapter__factory.connect(await module.dexAdapter(), provider);

  const wethInfo = await comet.getAssetInfo(0); // single WETH collateral
  const wethFeed = SimplePriceFeed__factory.connect(wethInfo.priceFeed, provider);
  const usdc = ERC20__factory.connect(await comet.baseToken(), provider);
  const weth = ERC20__factory.connect(wethInfo.asset, provider);

  return { hre, comet, module, adapter, wethInfo, wethFeed, usdc, weth, deployer, lender, borrower };
}
