import { ethers } from "hardhat";
import { BigNumber } from "ethers";
import { RouteConfig, MarketConfig, poolRoute, multiRoute, unsetRoute } from "./dex-router";
import { ERC7201_OZ_ERC20_BALANCES } from "./network-helpers";

/**
 * Tokens, swap routes and markets per network.
 */

const ETH = ethers.constants.AddressZero;

export interface TokenInfo {
  address: string;
  amount: BigNumber;
  // ERC-20 balances storage slot: a number (plain layout) or a 32-byte hex base slot (ERC-7201).
  slot: number | string;
}

const PLACEHOLDER_AMOUNT = ethers.utils.parseUnits("1", 18);
function t(address: string, amount: BigNumber = PLACEHOLDER_AMOUNT, slot: number | string = 0): TokenInfo {
  return { address, amount, slot };
}

// Builds a single-pool route selling `collateral` into `base` (each may be a TokenInfo or raw address).
function route(
  base: string | TokenInfo,
  collateral: string | TokenInfo,
  fee: number,
  tickSpacing: number
): RouteConfig {
  const b = typeof base === "string" ? base : base.address;
  const c = typeof collateral === "string" ? collateral : collateral.address;
  return poolRoute(b, c, fee, tickSpacing);
}

// Marks collaterals that have no configured swap route (resolved to an unset route).
function unset(...tokens: TokenInfo[]): Record<string, RouteConfig> {
  return Object.fromEntries(tokens.map((tk) => [tk.address, unsetRoute()]));
}

// ── Ethereum ───────────────────────────────────────────────────────────────
const MAINNET = {
  USDC: t("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", ethers.utils.parseUnits("10000", 6), 9),
  USDT: t("0xdAC17F958D2ee523a2206206994597C13D831ec7", ethers.utils.parseUnits("10000", 6), 2),
  WBTC: t("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", ethers.utils.parseUnits("1", 8), 0),
  WETH: t("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", ethers.utils.parseUnits("3", 18), 3),
  WSTETH: t("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", ethers.utils.parseUnits("3", 18), 0),
  USDS: t("0xdC035D45d973E3EC169d2276DDab16f1e407384F", ethers.utils.parseUnits("10000", 18), 2),
  LINK: t("0x514910771AF9Ca656af840dff83E8264EcF986CA", ethers.utils.parseUnits("1500", 18), 1),
  cbBTC: t("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", ethers.utils.parseUnits("1", 8), 9),
  UNI: t("0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", ethers.utils.parseUnits("3000", 18), 4),
  XAUt: t("0x68749665FF8D2d112Fa859AA293F07A622782F38", ethers.utils.parseUnits("2.5", 6), 51),
  USDe: t("0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", ethers.utils.parseUnits("10000", 18), 2),
  COMP: t("0xc00e94Cb662C3520282E6f5717214004A7f26888", ethers.utils.parseUnits("600", 18), 1),
  rsETH: t("0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7", ethers.utils.parseUnits("3", 18), 51),
  weETH: t("0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", ethers.utils.parseUnits("3", 18), 101),
  tBTC: t("0x18084fbA666a33d37592fA2633fD49a74DD93a88", ethers.utils.parseUnits("1", 18), 1),
  cbETH: t("0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", ethers.utils.parseUnits("3", 18), 9),
  ETHx: t("0xA35b1B31Ce002FBF2058D22F30f95D405200A15b", ethers.utils.parseUnits("3", 18), 51),
  ezETH: t("0xbf5495Efe5DB9ce00f80364C8B423567e58d2110", ethers.utils.parseUnits("3", 18), 51),
  rswETH: t("0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0", ethers.utils.parseUnits("3", 18), 98),
  rETH: t("0xae78736Cd615f374D3085123A210448E74Fc6393", ethers.utils.parseUnits("3", 18), 1),
  osETH: t("0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38", ethers.utils.parseUnits("3", 18), 2),
  tETH: t("0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8", ethers.utils.parseUnits("3", 18), ERC7201_OZ_ERC20_BALANCES),
  pufETH: t("0xD9A442856C234a39a81a089C06451EBAa4306a72", ethers.utils.parseUnits("3", 18), ERC7201_OZ_ERC20_BALANCES),
  mETH: t("0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa", ethers.utils.parseUnits("3", 18), 201),
  SKY: t("0x56072C95FAA701256059aa122697B133aDEd9279", ethers.utils.parseUnits("180000", 18), 2),
  sUSDS: t("0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", ethers.utils.parseUnits("10000", 18), 2),
  deUSD: t("0x15700B564Ca08D9439C58cA5053166E8317aa138", ethers.utils.parseUnits("10000", 18), ERC7201_OZ_ERC20_BALANCES),
  sdeUSD: t("0x5C5b196aBE0d54485975D1Ec29617D42D9198326", ethers.utils.parseUnits("10000", 18), ERC7201_OZ_ERC20_BALANCES),
  wUSDM: t("0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812", ethers.utils.parseUnits("10000", 18), 51),
  sFRAX: t("0xA663B02CF0a4b149d2aD41910CB81e23e1c41c32", ethers.utils.parseUnits("10000", 18), 3),
  LBTC: t("0x8236a87084f8B84306f72007F36F2618A5634494", ethers.utils.parseUnits("1", 8), ERC7201_OZ_ERC20_BALANCES),
  pumpBTC: t("0xF469fBD2abcd6B9de8E169d128226C0Fc90a012e", ethers.utils.parseUnits("1", 8), 0),
  wOETH: t("0xDcEe70654261AF21C44c093C300eD3Bb97b78192", ethers.utils.parseUnits("3", 18), 0)
};

// Standalone routes reused by the dex-adapter unit tests.
export const WBTC_USDC_ROUTE: RouteConfig = route(MAINNET.USDC, MAINNET.WBTC, 3000, 60);
export const WETH_USDC_ROUTE: RouteConfig = route(MAINNET.USDC, ETH, 3000, 60);
export const USDC_WETH_ROUTE: RouteConfig = route(ETH, MAINNET.USDC, 3000, 60);
export const WSTETH_USDC_ROUTE: RouteConfig = multiRoute([
  { intermediateCurrency: MAINNET.WBTC.address, fee: 2500, tickSpacing: 50, hooks: ethers.constants.AddressZero, hookData: "0x" },
  { intermediateCurrency: MAINNET.USDC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
]);

const ethereum: Record<string, MarketConfig> = {
  usdc: {
    comet: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
    routes: {
      ...unset(MAINNET.COMP),
      [MAINNET.WBTC.address]: WBTC_USDC_ROUTE,
      [MAINNET.WETH.address]: WETH_USDC_ROUTE,
      [MAINNET.UNI.address]: route(MAINNET.USDC, MAINNET.UNI, 3000, 60),
      [MAINNET.LINK.address]: route(MAINNET.USDC, MAINNET.LINK, 3000, 60),
      [MAINNET.WSTETH.address]: WSTETH_USDC_ROUTE,
      [MAINNET.cbBTC.address]: route(MAINNET.USDC, MAINNET.cbBTC, 3000, 60),
      ...unset(MAINNET.tBTC, MAINNET.weETH, MAINNET.deUSD, MAINNET.sdeUSD, MAINNET.rsETH),
      [MAINNET.USDe.address]: multiRoute([
        { intermediateCurrency: MAINNET.USDT.address, fee: 45, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.USDC.address, fee: 7, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ])
    },
  },
  weth: {
    comet: "0xA17581A9E3356d9A858b789D68B4d866e593aE94",
    routes: {
      ...unset(MAINNET.cbETH),
      [MAINNET.WSTETH.address]: multiRoute([
        { intermediateCurrency: MAINNET.WBTC.address, fee: 2500, tickSpacing: 50, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ETH, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset(MAINNET.rETH, MAINNET.rsETH, MAINNET.weETH, MAINNET.osETH),
      [MAINNET.WBTC.address]: route(ETH, MAINNET.WBTC, 3000, 60),
      ...unset(MAINNET.ezETH),
      [MAINNET.cbBTC.address]: multiRoute([
        { intermediateCurrency: MAINNET.USDC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency:ETH, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset(MAINNET.rswETH, MAINNET.tBTC, MAINNET.ETHx, MAINNET.tETH, MAINNET.pufETH, MAINNET.wOETH),
      [MAINNET.USDC.address]: USDC_WETH_ROUTE,
      [MAINNET.USDT.address]: route(ETH, MAINNET.USDT, 500, 10),
    },
  },
  usdt: {
    comet: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840",
    routes: {
      ...unset(MAINNET.COMP),
      [MAINNET.WETH.address]: route(MAINNET.USDT, ETH, 500, 10),
      [MAINNET.WBTC.address]: route(MAINNET.USDT, MAINNET.WBTC, 300, 60),
      [MAINNET.UNI.address]: multiRoute([
        { intermediateCurrency: MAINNET.USDC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.USDT.address, fee: 7, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      [MAINNET.LINK.address]: multiRoute([
        { intermediateCurrency: MAINNET.USDC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.USDT.address, fee: 7, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      [MAINNET.WSTETH.address]: multiRoute([
        { intermediateCurrency: MAINNET.WBTC.address, fee: 2500, tickSpacing: 50, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.USDT.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      [MAINNET.cbBTC.address]: multiRoute([
        { intermediateCurrency: MAINNET.USDC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.USDT.address, fee: 7, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset(MAINNET.tBTC),
      [MAINNET.wUSDM.address]: multiRoute([
        { intermediateCurrency: MAINNET.USDC.address, fee: 100, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.USDT.address, fee: 7, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset( 
        MAINNET.sFRAX,
        MAINNET.mETH,
        MAINNET.weETH,
        MAINNET.sdeUSD,
        MAINNET.deUSD
      ),
      [MAINNET.XAUt.address]: route(MAINNET.USDT, MAINNET.XAUt, 440, 9),
      [MAINNET.USDe.address]: route(MAINNET.USDT, MAINNET.USDe, 45, 1),
    },
  },
  wbtc: {
    comet: "0xe85Dc543813B8c2CFEaAc371517b925a166a9293",
    routes: {
      ...unset(MAINNET.LBTC, MAINNET.pumpBTC),
      [MAINNET.USDC.address]: route(MAINNET.WBTC, MAINNET.USDC, 3000, 60),
      [MAINNET.USDT.address]: route(MAINNET.WBTC, MAINNET.USDT, 3000, 60),
    },
  },
  wsteth: {
    comet: "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3",
    routes: {
      ...unset(MAINNET.rsETH, MAINNET.ezETH, MAINNET.tETH),
      [MAINNET.USDC.address]: multiRoute([
        {intermediateCurrency: MAINNET.WBTC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.WSTETH.address, fee: 2500, tickSpacing: 50, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      [MAINNET.USDT.address]: multiRoute([
        {intermediateCurrency: MAINNET.WBTC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.WSTETH.address, fee: 2500, tickSpacing: 50, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      [MAINNET.WETH.address]: multiRoute([
        {intermediateCurrency: MAINNET.WBTC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: MAINNET.WSTETH.address, fee: 2500, tickSpacing: 50, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset(MAINNET.weETH),
    },
  },
  usds: {
    comet: "0x5D409e56D886231aDAf00c8775665AD0f9897b56",
    routes: {
    [MAINNET.WETH.address]: multiRoute([
      { intermediateCurrency: MAINNET.USDT.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" },
      { intermediateCurrency: MAINNET.USDS.address, fee: 5, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x"}
    ]),
    [MAINNET.USDe.address]: multiRoute([
      { intermediateCurrency: MAINNET.USDT.address, fee: 45, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" },
      { intermediateCurrency: MAINNET.USDS.address, fee: 5, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x"}
    ]),
    [MAINNET.cbBTC.address]: multiRoute([
      { intermediateCurrency: MAINNET.USDC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
      { intermediateCurrency: MAINNET.USDT.address, fee: 7, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" },
      { intermediateCurrency: MAINNET.USDS.address, fee: 5, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x"}
    ]),
    ...unset(MAINNET.tBTC),
    [MAINNET.WSTETH.address]: multiRoute([
      { intermediateCurrency: MAINNET.WBTC.address, fee: 2500, tickSpacing: 50, hooks: ethers.constants.AddressZero, hookData: "0x" },
      { intermediateCurrency: MAINNET.USDT.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
      { intermediateCurrency: MAINNET.USDS.address, fee: 5, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x"}
    ]),
    ...unset(MAINNET.sUSDS, MAINNET.weETH),
    [MAINNET.SKY.address]: multiRoute([
      { intermediateCurrency: MAINNET.WBTC.address, fee: 10000, tickSpacing: 200, hooks: ethers.constants.AddressZero, hookData: "0x" },
      { intermediateCurrency: MAINNET.USDT.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
      { intermediateCurrency: MAINNET.USDS.address, fee: 5, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x"}
    ]),
    ...unset(MAINNET.deUSD, MAINNET.sdeUSD)
    },
  },
};

// ── Base ─────────────────────────────────────────────────────────────────--
const BASE = {
  USDC: t("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", ethers.utils.parseUnits("10000", 6), 9),
  WETH: t("0x4200000000000000000000000000000000000006", ethers.utils.parseUnits("3", 18), 3),
  cbBTC: t("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", ethers.utils.parseUnits("1", 8), 9),
  tBTC: t("0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b", ethers.utils.parseUnits("1", 18), 51),
  cbETH: t("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", ethers.utils.parseUnits("3", 18), 51),
  ezETH: t("0x2416092f143378750bb29b79ed961ab195cceea5", ethers.utils.parseUnits("3", 18), 51),
  wstETH: t("0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", ethers.utils.parseUnits("3", 18), 1),
  wsuperOETHb: t("0x7FcD174E80f264448ebeE8c88a7C4476AAF58Ea6", ethers.utils.parseUnits("3", 18), 0),
  weETH: t("0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", ethers.utils.parseUnits("1", 18), ERC7201_OZ_ERC20_BALANCES),
  wrsETH: t("0xEDfa23602D0EC14714057867A78d01e94176BEA0", ethers.utils.parseUnits("3", 18), 151),
  sUSDS: t("0x5875eEE11Cf8398102FdAd704C9E96607675467a", ethers.utils.parseUnits("10000", 18), 2),
};

const base: Record<string, MarketConfig> = {
  usdc: {
    comet: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
    routes: {
      ...unset(BASE.cbETH),
      [BASE.WETH.address]: route(BASE.USDC, ETH, 3000, 60),
      ...unset(BASE.wstETH),
      [BASE.cbBTC.address]: route(BASE.USDC, BASE.cbBTC, 500, 10),
      ...unset(BASE.tBTC),
    },
  },
  weth: {
    comet: "0x46e6b214b524310239732D51387075E0e70970bf",
    routes: {
      ...unset(BASE.cbETH, BASE.ezETH, BASE.wstETH),
      [BASE.USDC.address]: route(ETH, BASE.USDC, 3000, 60),
      ...unset(BASE.weETH, BASE.wrsETH),
      [BASE.cbBTC.address]: route(ETH, BASE.cbBTC, 500, 10),
      ...unset(BASE.wsuperOETHb),
    },
  },
  usdbc: {
    comet: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
    routes: { ...unset(BASE.cbETH, BASE.WETH) },
  },
  usds: {
    comet: "0x2c776041CCFe903071AF44aa147368a9c8EEA518",
    routes: { ...unset(BASE.sUSDS, BASE.cbBTC) },
  },
  aero: {
    comet: "0x784efeB622244d2348d4F2522f8860B96fbEcE89",
    routes: { ...unset(BASE.WETH, BASE.USDC, BASE.wstETH, BASE.cbBTC) },
  },
};

// ── Arbitrum ─────────────────────────────────────────────────────────────--
const ARBITRUM = {
  USDC: t("0xaf88d065e77c8cC2239327C5EDb3A432268e5831", ethers.utils.parseUnits("10000", 6), 9),
  USDCe: t("0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", ethers.utils.parseUnits("10000", 6), 51),
  USDT0: t("0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", ethers.utils.parseUnits("10000", 6), 51),
  WETH: t("0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", ethers.utils.parseUnits("3", 18), 51),
  WBTC: t("0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", ethers.utils.parseUnits("1", 8), 51),
  ARB: t("0x912CE59144191C1204E64559FE8253a0e49E6548", ethers.utils.parseUnits("115000", 18), 51),
  wstETH: t("0x5979D7b546E38E414F7E9822514be443A4800529", ethers.utils.parseUnits("3", 18), 1),
  rETH: t("0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8", ethers.utils.parseUnits("3", 18), 51),
  tBTC: t("0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40", ethers.utils.parseUnits("1", 18), 51),
  GMX: t("0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", ethers.utils.parseUnits("1800", 18), 5),
  ezETH: t("0x2416092f143378750bb29b79eD961ab195CcEea5", ethers.utils.parseUnits("3", 18), 51),
  tETH: t("0xd09ACb80C1E8f2291862c4978A008791c9167003", ethers.utils.parseUnits("3", 18), ERC7201_OZ_ERC20_BALANCES),
  rsETH: t("0x4186BFC76E2E237523CBC30FD220FE055156b41F", ethers.utils.parseUnits("3", 18), 5),
  wUSDM: t("0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812", ethers.utils.parseUnits("10000", 18), 51),
  weETH: t("0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe", ethers.utils.parseUnits("3", 18), 51)
};

const arbitrum: Record<string, MarketConfig> = {
  usdc: {
    comet: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
    routes: {
      [ARBITRUM.ARB.address]: route(ARBITRUM.USDC, ARBITRUM.ARB, 3000, 60),
      [ARBITRUM.GMX.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ARBITRUM.USDC.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      [ARBITRUM.WETH.address]: route(ARBITRUM.USDC, ETH, 500, 10),
      [ARBITRUM.WBTC.address]: route(ARBITRUM.USDC, ARBITRUM.WBTC, 500, 10),
      [ARBITRUM.wstETH.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ARBITRUM.USDC.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset(ARBITRUM.ezETH, ARBITRUM.wUSDM, ARBITRUM.tETH),
      [ARBITRUM.tBTC.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ARBITRUM.USDC.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ])
    },
  },
  "usdc.e": {
    comet: "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA",
    routes: {
      [ARBITRUM.ARB.address]: route(ARBITRUM.USDCe, ARBITRUM.ARB, 500, 10),
      [ARBITRUM.GMX.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ARBITRUM.USDCe.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" },
      ]),
      [ARBITRUM.WETH.address]: route(ARBITRUM.USDCe, ETH, 500, 10),
      [ARBITRUM.WBTC.address]: multiRoute([
        { intermediateCurrency: ARBITRUM.USDC.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ARBITRUM.USDCe.address, fee: 47, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" },
      ])
    },
  },
  usdt: {
    comet: "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07",
    routes: {
      [ARBITRUM.ARB.address]: route(ARBITRUM.USDT0, ARBITRUM.ARB, 3000, 60),
      [ARBITRUM.WETH.address]: route(ARBITRUM.USDT0, ETH, 500, 10),
      [ARBITRUM.wstETH.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ARBITRUM.USDT0.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      [ARBITRUM.WBTC.address]: route(ARBITRUM.USDT0, ARBITRUM.WBTC, 500, 10),
      [ARBITRUM.GMX.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ARBITRUM.USDT0.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      [ARBITRUM.tBTC.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: ARBITRUM.USDT0.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset(ARBITRUM.tETH),
    },
  },
  weth: {
    comet: "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486",
    routes: {
      ...unset(ARBITRUM.weETH),
      [ARBITRUM.rETH.address]: route(ETH, ARBITRUM.rETH, 3000, 60),
      [ARBITRUM.wstETH.address]: route(ETH, ARBITRUM.wstETH, 500, 10),
      [ARBITRUM.WBTC.address]: route(ETH, ARBITRUM.WBTC, 500, 10),
      ...unset(ARBITRUM.rsETH),
      [ARBITRUM.USDT0.address]: route(ETH, ARBITRUM.USDT0, 500, 10),
      [ARBITRUM.USDC.address]: route(ETH, ARBITRUM.USDC, 500, 10),
      ...unset(ARBITRUM.ezETH, ARBITRUM.tETH),
    },
  },
};

// ── Optimism ─────────────────────────────────────────────────────────────--
const OPTIMISM = {
  USDC: t("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", ethers.utils.parseUnits("10000", 6), 9),
  USDT: t("0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", ethers.utils.parseUnits("10000", 6), 0),
  WETH: t("0x4200000000000000000000000000000000000006", ethers.utils.parseUnits("10000", 18), 3),
  WBTC: t("0x68f180fcCe6836688e9084f035309E29Bf0A2095", ethers.utils.parseUnits("1", 8), 0),
  OP: t("0x4200000000000000000000000000000000000042", ethers.utils.parseUnits("95000", 18), 0),
  weETH: t("0x5A7fACB970D094B6C7FF1df0eA68D99E6e73CBFF", ethers.utils.parseUnits("3", 18), ERC7201_OZ_ERC20_BALANCES),
  wstETH: t("0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", ethers.utils.parseUnits("3", 18), 1),
  wrsETH: t("0x87eEE96D50Fb761AD85B1c982d28A042169d61b1", ethers.utils.parseUnits("3", 18), 0),
  ezETH: t("0x2416092f143378750bb29b79eD961ab195CcEea5", ethers.utils.parseUnits("3", 18), 51),
  rETH: t("0x9Bcef72be871e61ED4fBbc7630889beE758eb81D", ethers.utils.parseUnits("3", 18), 0),
  wUSDM: t("0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812", ethers.utils.parseUnits("10000", 18), 51)
};

const optimism: Record<string, MarketConfig> = {
  usdc: {
    comet: "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB",
    routes: {
      [OPTIMISM.OP.address]: route(OPTIMISM.USDC, OPTIMISM.OP, 3000, 60),
      [OPTIMISM.WETH.address]: route(OPTIMISM.USDC, ETH, 20000, 400),
      [OPTIMISM.WBTC.address]: route(OPTIMISM.USDC, OPTIMISM.WBTC, 3000, 60),
      [OPTIMISM.wstETH.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 100, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: OPTIMISM.USDC.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset(OPTIMISM.wUSDM),
    },
  },
  usdt: {
    comet: "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214",
    routes: {
      [OPTIMISM.OP.address]: route(OPTIMISM.USDT, OPTIMISM.OP, 3000, 60),
      [OPTIMISM.WETH.address]: route(OPTIMISM.USDT, ETH, 500, 10),
      [OPTIMISM.WBTC.address]: route(OPTIMISM.USDT, OPTIMISM.WBTC, 3000, 600),
      [OPTIMISM.wstETH.address]: multiRoute([
        { intermediateCurrency: ETH, fee: 100, tickSpacing: 1, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: OPTIMISM.USDT.address, fee: 500, tickSpacing: 10, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ]),
      ...unset(OPTIMISM.wUSDM),
    },
  },
  weth: {
    comet: "0xE36A30D249f7761327fd973001A32010b521b6Fd",
    routes: {
      [OPTIMISM.wstETH.address]: route(ETH, OPTIMISM.wstETH, 100, 1),
      ...unset(OPTIMISM.rETH),
      [OPTIMISM.WBTC.address]: route(ETH, OPTIMISM.WBTC, 3000, 60),
      [OPTIMISM.USDT.address]: route(ETH, OPTIMISM.USDT, 500, 10),
      [OPTIMISM.USDC.address]: route(ETH, OPTIMISM.USDC, 20000, 400),
      ...unset(OPTIMISM.ezETH),
      [OPTIMISM.weETH.address]: route(ETH, OPTIMISM.weETH, 100, 1),
      [OPTIMISM.wrsETH.address]: route(ETH, OPTIMISM.wrsETH, 3000, 60),
    },
  },
};

// ── Polygon (native coin POL keyed by its wrapped ERC-20 WPOL) ─────────────--
const POLYGON = {
  USDCe: t("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", ethers.utils.parseUnits("10000", 6), 0),
  USDT0: t("0xc2132D05D31c914a87C6611C10748AEb04B58e8F", ethers.utils.parseUnits("10000", 6), 0),
  WPOL: t("0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", ethers.utils.parseUnits("130000", 18), 3),
  WBTC: t("0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", ethers.utils.parseUnits("1", 8), 0),
  WETH: t("0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", ethers.utils.parseUnits("3", 18), 0),
  MaticX: t("0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6", ethers.utils.parseUnits("110000", 18), 0),
  stMATIC: t("0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4", ethers.utils.parseUnits("110000", 18), 0),
};

const polygon: Record<string, MarketConfig> = {
  usdc: {
    comet: "0xF25212E676D1F7F89Cd72fFEe66158f541246445",
    routes: {
      [POLYGON.WETH.address]: route(POLYGON.USDCe, POLYGON.WETH, 500, 10),
      [POLYGON.WBTC.address]: route(POLYGON.USDCe, POLYGON.WBTC, 3000, 60),
      [POLYGON.WPOL.address]: route(POLYGON.USDCe, ETH, 3000, 60),
      ...unset(POLYGON.MaticX, POLYGON.stMATIC),
    },
  },
  usdt: {
    comet: "0xaeB318360f27748Acb200CE616E389A6C9409a07",
    routes: {
      [POLYGON.WPOL.address]: route(POLYGON.USDT0, ETH, 3000, 60),
      [POLYGON.WETH.address]: route(POLYGON.USDT0, POLYGON.WETH, 3000, 60),
      ...unset(POLYGON.MaticX, POLYGON.stMATIC),
      [POLYGON.WBTC.address]: multiRoute([
        { intermediateCurrency: POLYGON.WETH.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" },
        { intermediateCurrency: POLYGON.USDT0.address, fee: 3000, tickSpacing: 60, hooks: ethers.constants.AddressZero, hookData: "0x" }
      ])
    },
  },
};

// ── Unichain ─────────────────────────────────────────────────────────────--
const UNICHAIN = {
  USDC: t("0x078D782b760474a361dDA0AF3839290b0EF57AD6", ethers.utils.parseUnits("10000", 6), 9),
  WETH: t("0x4200000000000000000000000000000000000006", ethers.utils.parseUnits("3", 18), 0),
  UNI: t("0x8f187aA05619a017077f5308904739877ce9eA21", ethers.utils.parseUnits("3000", 18), 0),
  rsETH: t("0xc3eACf0612346366Db554C991D7858716db09f58", ethers.utils.parseUnits("3", 18), 5),
  ezETH: t("0x2416092f143378750bb29b79eD961ab195CcEea5", ethers.utils.parseUnits("3", 18), 51),
  WBTC: t("0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", ethers.utils.parseUnits("1", 8), 5),
  wstETH: t("0xc02fE7317D4eb8753a02c35fe019786854A92001", ethers.utils.parseUnits("3", 18), 1),
  weETH: t("0x7DCC39B4d1C53CB31e1aBc0e358b43987FEF80f7", ethers.utils.parseUnits("3", 18), ERC7201_OZ_ERC20_BALANCES)
};

const unichain: Record<string, MarketConfig> = {
  usdc: {
    comet: "0x2c7118c4C88B9841FCF839074c26Ae8f035f2921",
    routes: {
      [UNICHAIN.UNI.address]: route(UNICHAIN.USDC, UNICHAIN.UNI, 9500, 190),
      [UNICHAIN.WETH.address]: route(UNICHAIN.USDC, ETH, 500, 10),
    },
  },
  weth: {
    comet: "0x6C987dDE50dB1dcDd32Cd4175778C2a291978E2a",
    routes: {
      [UNICHAIN.wstETH.address]: route(ETH, UNICHAIN.wstETH, 100, 1),
      ...unset(UNICHAIN.weETH),
      [UNICHAIN.ezETH.address]: route(ETH, UNICHAIN.ezETH, 100, 1),
      [UNICHAIN.UNI.address]: route(ETH, UNICHAIN.UNI, 3000, 60),
      [UNICHAIN.WBTC.address]: route(ETH, UNICHAIN.WBTC, 500, 10),
      [UNICHAIN.rsETH.address]: route(ETH, UNICHAIN.rsETH, 100, 1),
    },
  },
};

// ── Linea ────────────────────────────────────────────────────────────────--
const LINEA = {
  WETH: t("0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", ethers.utils.parseUnits("3", 18), 3),
  WBTC: t("0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4", ethers.utils.parseUnits("1", 8), 51),
  wstETH: t("0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F", ethers.utils.parseUnits("3", 18), 51),
  ezETH: t("0x2416092f143378750bb29b79eD961ab195CcEea5", ethers.utils.parseUnits("3", 18), 51),
  weETH: t("0x1Bf74C010E6320bab11e2e5A532b5AC15e0b8aA6", ethers.utils.parseUnits("3", 18), ERC7201_OZ_ERC20_BALANCES),
  wrsETH: t("0xD2671165570f41BBB3B0097893300b6EB6101E6C", ethers.utils.parseUnits("3", 18), 151),
};

const linea: Record<string, MarketConfig> = {
  usdc: {
    comet: "0x8D38A3d6B3c3B7d96D6536DA7Eef94A9d7dbC991",
    routes: { ...unset(LINEA.WETH, LINEA.wstETH, LINEA.WBTC) },
  },
  weth: {
    comet: "0x60F2058379716A64a7A5d29219397e79bC552194",
    routes: { ...unset(LINEA.ezETH, LINEA.wstETH, LINEA.WBTC, LINEA.weETH, LINEA.wrsETH) },
  },
};

// ── Mantle (native coin keyed by its wrapped ERC-20) ───────────────────────--
const MANTLE = {
  WETH: t("0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111", ethers.utils.parseUnits("3", 18), 0),
  FBTC: t("0xC96dE26018A54D51c097160568752c4E3BD6C364", ethers.utils.parseUnits("1", 8), ERC7201_OZ_ERC20_BALANCES),
  mETH: t("0xcDA86A272531e8640cD7F1a92c01839911B90bb0", ethers.utils.parseUnits("3", 18), ERC7201_OZ_ERC20_BALANCES),
};

const mantle: Record<string, MarketConfig> = {
  usde: {
    comet: "0x606174f62cd968d8e684c645080fa694c1D7786E",
    routes: { ...unset(MANTLE.mETH, MANTLE.WETH, MANTLE.FBTC) },
  },
};

// ── Scroll ───────────────────────────────────────────────────────────────--
const SCROLL = {
  WETH: t("0x5300000000000000000000000000000000000004"),
  wstETH: t("0xf610A9dfB7C89644979b4a0f27063E9e7d7Cda32"),
};

const scroll: Record<string, MarketConfig> = {
  usdc: {
    comet: "0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44",
    routes: { ...unset(SCROLL.WETH, SCROLL.wstETH) },
  },
};

// Token registries per network.
export const TOKENS_BY_NETWORK = {
  mainnet: MAINNET,
  base: BASE,
  arbitrum: ARBITRUM,
  optimism: OPTIMISM,
  polygon: POLYGON,
  unichain: UNICHAIN,
  linea: LINEA,
  mantle: MANTLE,
  scroll: SCROLL,
};

// Swap routes per Comet market, grouped by network.
export const SWAP_ROUTES = {
  mainnet: ethereum,
  base,
  arbitrum,
  optimism,
  polygon,
  unichain,
  linea,
  mantle,
  scroll,
};

// Mainnet token registry and markets, used by the dex-adapter unit tests.
export const TOKENS = MAINNET;
export const MARKETS = SWAP_ROUTES.mainnet;
