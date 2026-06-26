import { ethers, exp, expect, makeProtocol, mulPrice, mulFactor } from '../helpers';
import { CometHarnessInterfaceExtendedAssetList, LiquidationModule, FaucetToken, SimplePriceFeed } from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

/**
 * PoC for finding C-1 — the keeper/DEX liquidation path is dead code.
 *
 * `LiquidationModule.liquidate` routes by health factor:
 *   - HF  > healthPositionHF (1.10) → revert NotLiquidatable   (healthy)
 *   - borderHF (1.02) < HF <= 1.10  → _dexLiquidate             (DEX / partial route)
 *   - HF <= borderHF                → _liquidate                (absorb route)
 *
 * Both routed paths call `_computeSeizurePlan`, which re-derives the *identical*
 * LCF-weighted `liquidity` and `debtRemainingValue` and enforces:
 *
 *     if (debtRemainingValue <= liquidity) revert NotLiquidatable();   // i.e. HF >= 1e18
 *
 * Since the DEX route is only ever entered for HF > borderHF > 1.0, every DEX
 * liquidation reverts at this guard before any swap. The partial/early-liquidation
 * feature can never run; only fully-insolvent accounts (HF < 1.0) are liquidatable,
 * and only via plain absorb.
 *
 * This PoC builds an account at HF = 1.05 (squarely inside the DEX band) and shows
 * the keeper call reverts NotLiquidatable, while Comet itself reports the account as
 * NOT liquidatable (isLiquidatable == false) — the contradiction at the heart of C-1.
 */
describe('PoC C-1: DEX/partial liquidation reverts for in-band accounts', function () {
  const FACTOR_SCALE = exp(1, 18);
  const BORDER_HF = exp(102, 16);          // 1.02e18 (deployAndUpdateLiquidationModule default)
  const HEALTH_POSITION_HF = exp(110, 16); // 1.10e18 (deployAndUpdateLiquidationModule default)

  let comet: CometHarnessInterfaceExtendedAssetList;
  let liquidationModule: LiquidationModule;
  let COMP: FaucetToken;

  let executor: SignerWithAddress;
  let absorber: SignerWithAddress;
  let alice: SignerWithAddress;

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
    // COMP priced at $1 keeps the HF arithmetic transparent; factors fall back to the
    // makeProtocol defaults (borrowCF 0.80, liquidateCF 0.85, liquidationFactor 0.90).
    const protocol = await makeProtocol({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        COMP: { decimals: 18, initialPrice: 1 },
      },
    });
    comet = protocol.comet;
    liquidationModule = protocol.defaultLiquidationModule;
    executor = protocol.executor;
    alice = protocol.users[0];
    absorber = protocol.users[1];
    COMP = protocol.tokens['COMP'] as FaucetToken;
  });

  it('sanity: module is configured with the documented in-band thresholds (both > 1.0)', async () => {
    expect(await liquidationModule.borderHF()).to.equal(BORDER_HF);
    expect(await liquidationModule.healthPositionHF()).to.equal(HEALTH_POSITION_HF);
    expect(BORDER_HF).to.be.greaterThan(FACTOR_SCALE); // 1.02 > 1.00
  });

  /*
   * Numerical example (all USD values in PRICE_SCALE = 1e8, factors in FACTOR_SCALE = 1e18):
   *
   *   Position:        debt   = 85 USDC  @ $1   → debtValue  = 85  * 1e8 = 8.500e9  ($85)
   *                    collat = 105 COMP @ $1   → fullValue  = 105 * 1e8 = 1.050e10 ($105)
   *   Factors (COMP):  borrowCF = 0.80,  liquidateCF (LCF) = 0.85,  liquidationFactor = 0.90
   *
   *   LCF-weighted liquidity = fullValue * LCF = 1.050e10 * 0.85 = 8.925e9   ($89.25)
   *   currentHF              = liquidity * 1e18 / debtValue
   *                         = 8.925e9 * 1e18 / 8.500e9 = 1.05e18            (HF = 1.05)
   *
   *   Step 1 — LiquidationModule.liquidate routing:
   *     borderHF (1.02e18) < currentHF (1.05e18) <= healthPositionHF (1.10e18)
   *     ⇒ routes to _dexLiquidate.                                          ✓ enters DEX path
   *
   *   Step 2 — _computeSeizurePlan guard (same liquidity & debtValue, re-derived):
   *     if (debtRemainingValue <= liquidity)  →  if (8.500e9 <= 8.925e9)  → TRUE
   *     ⇒ revert NotLiquidatable().                                        ✗ DEX path can never run
   *
   *   Meanwhile isLiquidatable = (debt + liquidity < 0) = (-8.500e9 + 8.925e9 < 0) = FALSE
   *   ⇒ Comet considers the account healthy. The guard (HF >= 1.0) and the routing band
   *     (HF up to 1.10) are mutually exclusive, so every in-band account reverts.
   */
  it('reverts NotLiquidatable for an account squarely inside the DEX band (HF = 1.05)', async () => {
    // $85 debt, 105 COMP @ $1 collateral.
    // HF_LCF = (105 * $1 * 0.85) / $85 = $89.25 / $85 = 1.05  → inside (1.02, 1.10].
    await comet.setBasePrincipal(alice.address, -85_000_000); // -85 USDC (baseScale 1e6)
    await comet.setCollateralBalance(alice.address, COMP.address, exp(105, 18));

    // The account sits in the band the DEX/partial route is meant to handle.
    const hf = await currentHF(alice.address);
    expect(hf).to.equal(exp(105, 16)); // exactly 1.05e18
    expect(hf).to.be.greaterThan(BORDER_HF);
    expect(hf).to.be.lessThanOrEqual(HEALTH_POSITION_HF);

    // Yet Comet's own liquidatability check (debt > LCF-liquidity, i.e. HF < 1.0) says "healthy".
    expect(await comet.isLiquidatable(alice.address)).to.equal(false);

    // The keeper liquidation (routes to _dexLiquidate → _computeSeizurePlan) reverts at the
    // `debtRemainingValue <= liquidity` guard, before any collateral is seized or swapped.
    await expect(
      liquidationModule
        .connect(executor)
        ['liquidate(address,address,bytes[])'](absorber.address, alice.address, [])
    ).to.be.revertedWithCustomError(liquidationModule, 'NotLiquidatable');
  });

  it('contrast: the same account is only liquidatable once HF drops below 1.0 (outside the DEX band)', async () => {
    // Drop collateral to 80 COMP → HF_LCF = (80 * 0.85) / 85 = $68 / $85 ≈ 0.80 < 1.0.
    await comet.setBasePrincipal(alice.address, -85_000_000);
    await comet.setCollateralBalance(alice.address, COMP.address, exp(80, 18));

    const hf = await currentHF(alice.address);
    expect(hf).to.be.lessThan(FACTOR_SCALE); // < 1.0

    // Below 1.0 the account IS liquidatable by Comet's definition — confirming the protocol only
    // permits liquidation for HF < 1.0, never for the 1.02–1.10 band the DEX feature was built for.
    expect(await comet.isLiquidatable(alice.address)).to.equal(true);
  });
});
