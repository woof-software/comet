import { expect } from 'chai';
import { CometContext } from '../context/CometContext';
import { ERC20 } from '../../build/types';
import { AssetConfigStructOutput } from '../../build/types/Configurator';
import { AssetInfoStructOutput } from '../../build/types/AssetList';

// Checks every field of the asset info against the config it should match, and the scale against the token decimals.
// The cap shares its storage words with the other fields, so all of them must come back intact.
export function validateGetAssetInfo(
  assetInfo: AssetInfoStructOutput,
  index: number,
  assetConfig: AssetConfigStructOutput | { [key: string]: any },
  decimals: number
) {
  expect(assetInfo.offset).to.equal(index);
  expect(assetInfo.asset).to.equal(assetConfig.asset);
  expect(assetInfo.priceFeed).to.equal(assetConfig.priceFeed);
  expect(assetInfo.scale).to.equal(oneToken(decimals));
  expect(assetInfo.borrowCollateralFactor).to.equal(assetConfig.borrowCollateralFactor);
  expect(assetInfo.liquidateCollateralFactor).to.equal(assetConfig.liquidateCollateralFactor);
  expect(assetInfo.liquidationFactor).to.equal(assetConfig.liquidationFactor);
  expect(assetInfo.supplyCap).to.equal(assetConfig.supplyCap);
}

// One whole unit of a collateral with the given decimals
export const oneToken = (decimals): bigint => 10n ** BigInt(decimals.toString());

// The token of a collateral, which the asset list reads the decimals from
export const getToken = async (context: CometContext, asset: string): Promise<ERC20> =>
  await context.world.deploymentManager.hre.ethers.getContractAt('ERC20', asset) as ERC20;

// Every collateral of the comet must read back exactly as configured
export async function validateAssetInfos(context: CometContext, assetConfigs: (AssetConfigStructOutput | { [key: string]: any })[]) {
  const comet = await context.getComet();
  expect(await comet.numAssets()).to.equal(assetConfigs.length);
  for (let i = 0; i < assetConfigs.length; i++) {
    const decimals = await (await getToken(context, assetConfigs[i].asset)).decimals();
    validateGetAssetInfo(await comet.getAssetInfo(i), i, assetConfigs[i], decimals);
  }
}

// The highest liquidation factor the asset list accepts: a factor of one
export const MAX_COLLATERAL_FACTOR = 10n ** 18n;

// The largest value the uint128 supply cap field can hold
export const MAX_UINT128 = 2n ** 128n - 1n;

// The supply caps the scenarios run with, as a function of one whole unit of the collateral and its token
const capsPerToken: [string, (one: bigint, token: ERC20) => Promise<bigint> | bigint][] = [
  // 1000.05 tokens of whatever the collateral is; the old packing rounded this down to 1000 tokens
  ['fractional', (one) => 1000n * one + one / 20n],
  ['1 wei', () => 1n],
  ['one wei below a whole token', (one) => one - 1n],
  ['0.5 token', (one) => one / 2n],
  ['10.5 token', (one) => one * 21n / 2n],
  ['75,000 token', (one) => 75_000n * one],
  ['150,000 token', (one) => 150_000n * one],
  ['1,000,000 token', (one) => 1_000_000n * one],
  // The cap is not bound to what the token can ever have in circulation
  ['token total supply + 1 wei', async (_, token) => (await token.totalSupply()).toBigInt() + 1n],
  ['uint128 max', () => MAX_UINT128],
  ['zero', () => 0n],
];

// The same caps for a collateral of the comet: one whole unit comes from the token's own decimals
export const supplyCaps: [string, (assetConfig: AssetConfigStructOutput, context: CometContext) => Promise<bigint>][] =
  capsPerToken.map(([name, capFor]) => [name, async ({ asset }, context) => {
    const token = await getToken(context, asset);
    return await capFor(oneToken(await token.decimals()), token);
  }]);
