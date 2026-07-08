import hre from 'hardhat';
import { readFileSync } from 'fs';
import path from 'path';
import { loadDemo } from '../lib/context';
import { withSnapshot } from '../lib/snapshot';
import { reportPosition, fmtToken } from '../lib/report';
import {
  OneInchV6Adapter__factory,
  LiquidationModuleForComet__factory,
  LiquidationModule__factory,
  Configurator__factory,
  CometProxyAdmin__factory,
} from '../../../build/types';
import { MARKETS, buildRoutesFromList, unsetRoute, CORE_ROUTER, REDUNDANT_ROUTER, TOKENS } from '../../../test/helpers';

/**
 * CASE 3 — Absorb because the DEX swap has no route.
 * Redeploys Dex Adapter and Liquidation Module with empty swap route
 * Run:  npx hardhat run scripts/demo/dex-liquidation/04c-absorb-dex-inoperable.ts --network localhost
 */

const SLIPPAGE_BPS = 1000; // 10%
const INCENTIVE_BPS = 500; // 5%

async function main() {
  const { comet, deployer, borrower, wethInfo } = await loadDemo();
  const provider = hre.ethers.provider;
  const roots = JSON.parse(
    readFileSync(path.join(__dirname, '../../../deployments/localhost/usdc-dex/roots.json'), 'utf8')
  ) as { configurator: string; cometAdmin: string };

  await withSnapshot(async () => {
    console.log('════════════════════════════════════════════════════════════');
    console.log(' CASE 3 — No DEX route for WETH → swap fails → ABSORB');
    console.log('════════════════════════════════════════════════════════════');

    await reportPosition(comet, borrower.address, 'Before liquidation');
    if (!(await comet.isLiquidatable(borrower.address))) {
      console.log('\nBorrower is not liquidatable yet — run 02-supply-and-borrow then 03-drop-price first.');
      return;
    }

    if (hre.network.name === 'localhost' || hre.network.name === 'hardhat') {
      await provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0']);
    }

    // 1) New DEX adapter — same routes as the live one, but WETH's Uniswap route is unset.
    const collateralAddresses: string[] = [];
    const numAssets = await comet.numAssets();
    for (let i = 0; i < numAssets; i++) collateralAddresses.push((await comet.getAssetInfo(i)).asset);
    const routes = buildRoutesFromList(collateralAddresses, MARKETS.usdc.routes).map((r) =>
      r.collateral.toLowerCase() === TOKENS.WETH.address.toLowerCase() ? { ...unsetRoute(), collateral: r.collateral } : r
    );
    console.log('\n1) Deploying a new DEX adapter with NO Uniswap route for WETH...');
    const adapter2 = await (
      await new OneInchV6Adapter__factory(deployer).deploy(CORE_ROUTER, REDUNDANT_ROUTER, TOKENS.WETH.address, SLIPPAGE_BPS, routes)
    ).deployed();

    // 2) New liquidation module bound to Comet, using the new adapter.
    console.log('2) Deploying a new liquidation module (bound to the Comet) with the new adapter...');
    const module2 = await (
      await new LiquidationModuleForComet__factory(deployer).deploy(
        adapter2.address,
        deployer.address,
        [deployer.address],
        [deployer.address],
        INCENTIVE_BPS,
        comet.address
      )
    ).deployed();

    // 3) Point the Comet at the new module.
    console.log('3) Governor sets the new module and upgrades the Comet...');
    await (await Configurator__factory.connect(roots.configurator, deployer).setLiquidationModule(comet.address, module2.address)).wait();
    await (await CometProxyAdmin__factory.connect(roots.cometAdmin, deployer).deployAndUpgradeTo(roots.configurator, comet.address)).wait();
    console.log(`   comet.liquidationModule = ${await comet.liquidationModule()} (new adapter has no WETH route)`);

    const reservesBefore = await comet.getCollateralReserves(wethInfo.asset);
    const collateralBefore = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtBefore = await comet.borrowBalanceOf(borrower.address);

    // 4) Keeper liquidates with empty 1inch data → 1inch unusable + no Uniswap route → swap fails → absorb.
    console.log('\n4) Keeper calls liquidate() with empty 1inch data simulating 1Inch Swap fail...');
    await (await LiquidationModule__factory.connect(module2.address, deployer).liquidate(deployer.address, borrower.address, ['0x'])).wait();

    const reservesAfter = await comet.getCollateralReserves(wethInfo.asset);
    const collateralAfter = await comet.collateralBalanceOf(borrower.address, wethInfo.asset);
    const debtAfter = await comet.borrowBalanceOf(borrower.address);
    console.log('\n  Swap FAILED — no usable 1inch data AND no Uniswap route for WETH → collateral absorbed, not sold.');
    console.log(`  Collateral seized into reserves: ${fmtToken(collateralBefore.sub(collateralAfter), 18, 'WETH')}`);
    console.log(`  Protocol WETH reserves:          ${fmtToken(reservesBefore, 18, 'WETH')} → ${fmtToken(reservesAfter, 18, 'WETH')}`);
    console.log(`  Debt written down:               ${fmtToken(debtBefore.sub(debtAfter), 6, 'USDC')}`);

    await reportPosition(comet, borrower.address, 'After absorb');
    console.log('\n✅ 1inch data was unusable and there is no Uniswap route for WETH, so the seized collateral was absorbed into reserves instead of swapped.');
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
