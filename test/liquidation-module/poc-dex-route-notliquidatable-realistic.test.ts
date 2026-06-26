import { ethers, exp, expect, makeProtocol, mulPrice, mulFactor } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, FaucetToken, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * PoC for finding C-1 — realistic variant (NO setBasePrincipal / setCollateralBalance).
 *
 * The position is built entirely through ordinary user actions:
 *   - Bob supplies USDC base liquidity.
 *   - Alice supplies 10 COMP ($1,000 @ $100) and borrows $700 (within the 0.80 borrowCF cap of $800).
 * A market price move then drops COMP just enough to push Alice's health factor into the
 * (borderHF 1.02, healthPositionHF 1.10] band that `LiquidationModule.liquidate` routes to the
 * DEX / partial-liquidation path.
 *
 * Result: the keeper liquidation reverts with `NotLiquidatable` (fired by the shared
 * `_computeSeizurePlan` guard `debtRemainingValue <= liquidity`, i.e. HF >= 1.0), even though
 * Comet's own `isLiquidatable` reports the account as healthy. The DEX route is unreachable.
 *
 * Worked numbers (USD in PRICE_SCALE 1e8, factors in FACTOR_SCALE 1e18), COMP dropped $100 → ~$86.47:
 *   debt                   = $700                                  → debtValue = 7.000e10
 *   collateral             = 10 COMP @ ~$86.47                     → fullValue ≈ 8.647e10 ($864.7)
 *   LCF-weighted liquidity = fullValue * 0.85           ≈ 7.350e10 ($735.0)
 *   currentHF              = 7.350e10 * 1e18 / 7.000e10 ≈ 1.05e18  (inside the DEX band)
 *
 *   routing : 1.02e18 < 1.05e18 <= 1.10e18           ⇒ _dexLiquidate           (enters DEX path)
 *   guard   : 7.000e10 <= 7.350e10                   ⇒ revert NotLiquidatable   (path can never run)
 *   isLiquidatable = (-7.000e10 + 7.350e10 < 0)      = FALSE                    (Comet: healthy)
 */
describe('PoC C-1 (realistic): DEX/partial liquidation reverts via real supply/borrow', function () {
  const FACTOR_SCALE = exp(1, 18);
  const BORDER_HF = exp(102, 16);          // 1.02e18
  const HEALTH_POSITION_HF = exp(110, 16); // 1.10e18
  const TARGET_BAND_HF = exp(105, 16);     // aim for mid-band 1.05e18

  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: LiquidationModule;
  let baseToken: FaucetToken;
  let COMP: FaucetToken;
  let compPriceFeed: SimplePriceFeed;

  let executor: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let absorber: SignerWithAddress;

  async function currentHF(account: string): Promise<bigint> {
    const accountUser = await comet.userBasic(account);
    const pv = (await comet.presentValue(accountUser.principal)).toBigInt(); // negative for a borrower
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseScale = (await comet.baseScale()).toBigInt();
    const debtValue = mulPrice(-pv, basePrice, baseScale);

    const info = await comet.getAssetInfoByAddress(COMP.address);
    const compPrice = (await comet.getPrice(info.priceFeed)).toBigInt();
    const balance = (await comet.userCollateral(account, COMP.address)).balance.toBigInt();
    const liquidity = mulFactor(mulPrice(balance, compPrice, info.scale), info.liquidateCollateralFactor);

    return (liquidity * FACTOR_SCALE) / debtValue;
  }

  before(async () => {
    const protocol = await makeProtocol({
      base: 'USDC',
      baseBorrowMin: 0,
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        COMP: { decimals: 18, initialPrice: 100 },
      },
    });
    comet = protocol.comet;
    liquidationModule = protocol.defaultLiquidationModule;
    executor = protocol.executor;
    [alice, bob, absorber] = protocol.users;
    baseToken = protocol.tokens['USDC'] as FaucetToken;
    COMP = protocol.tokens['COMP'] as FaucetToken;
    compPriceFeed = protocol.priceFeeds['COMP'];

    // Bob seeds base liquidity so Alice's borrow can be drawn from the market.
    const baseLiquidity = exp(5_000, 6);
    await baseToken.allocateTo(bob.address, baseLiquidity);
    await baseToken.connect(bob).approve(comet.address, baseLiquidity);
    await comet.connect(bob).supply(baseToken.address, baseLiquidity);

    // Alice opens a real position: supply 10 COMP ($1,000 @ $100), borrow $700 (cap is $800 @ borrowCF 0.80).
    const collateralAmount = exp(10, 18);
    await COMP.allocateTo(alice.address, collateralAmount);
    await COMP.connect(alice).approve(comet.address, collateralAmount);
    await comet.connect(alice).supply(COMP.address, collateralAmount);
    await comet.connect(alice).withdraw(baseToken.address, exp(700, 6));
  });

  it('sanity: Alice starts well-collateralized and not liquidatable', async () => {
    expect(await comet.isLiquidatable(alice.address)).to.equal(false);
    expect(await currentHF(alice.address)).to.be.greaterThan(HEALTH_POSITION_HF); // HF ≈ 1.21 > 1.10
  });

  it('a market price drop into the (borderHF, healthPositionHF] band makes the keeper liquidation revert NotLiquidatable', async () => {
    // Solve for the COMP price that lands Alice at ~1.05 HF given her actual on-chain debt.
    const accountUser = await comet.userBasic(alice.address);
    const pv = (await comet.presentValue(accountUser.principal)).toBigInt();
    const basePrice = (await comet.getPrice(await comet.baseTokenPriceFeed())).toBigInt();
    const baseScale = (await comet.baseScale()).toBigInt();
    const debtValue = mulPrice(-pv, basePrice, baseScale);

    const info = await comet.getAssetInfoByAddress(COMP.address);
    const balance = (await comet.userCollateral(alice.address, COMP.address)).balance.toBigInt();
    const LCF = info.liquidateCollateralFactor.toBigInt();
    const scale = info.scale.toBigInt();

    // currentHF = mulFactor(mulPrice(balance, P, scale), LCF) * 1e18 / debtValue == TARGET_BAND_HF
    //   ⇒ P = (TARGET_BAND_HF * debtValue / 1e18) * scale * 1e18 / (balance * LCF)
    const targetLiquidity = (TARGET_BAND_HF * debtValue) / FACTOR_SCALE;
    const newPrice = (targetLiquidity * scale * FACTOR_SCALE) / (balance * LCF);

    await compPriceFeed.connect(alice).setRoundData(0, newPrice, 0, 0, 0);
    await comet.accrueAccount(alice.address);

    // Alice is now squarely inside the DEX/partial band.
    const hf = await currentHF(alice.address);
    expect(hf).to.be.greaterThan(BORDER_HF);
    expect(hf).to.be.lessThanOrEqual(HEALTH_POSITION_HF);

    // Comet still reports her as healthy (HF >= 1.0)...
    expect(await comet.isLiquidatable(alice.address)).to.equal(false);

    // ...but the keeper DEX liquidation reverts at the shared `_computeSeizurePlan` guard,
    // before any collateral is seized or swapped.
    await expect(
      liquidationModule
        .connect(executor)
        ['liquidate(address,address,bytes[])'](absorber.address, alice.address, [])
    ).to.be.revertedWithCustomError(liquidationModule, 'NotLiquidatable');
  });
});
