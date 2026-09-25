import { scenario } from './context/CometContext';
import { CometContext } from './context/CometContext';
import { AssetList, AssetListFactory } from '../build/types';
import { AssetConfigStruct } from '../build/types/AssetList';
import { expect } from 'chai';
import { expectRevertMatches, fundAccount, servicePatch2 } from './utils';

// The largest value the uint128 supply cap field can hold
const MAX_UINT128 = 2n ** 128n - 1n;

// The asset list keeps the lower 88 bits of the cap in one storage word and the upper 40 bits in the other
const UPPER_BITS_ONLY = (2n ** 40n - 1n) << 88n;

// The asset config as the contracts take it, but with the cap widened to uint256 so a value
// above uint128 max can be encoded. Both types take one 32-byte word, so the layout is the same.
const ASSET_CONFIG_WITH_WIDE_CAP =
  'tuple(address asset, address priceFeed, uint8 decimals, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint256 supplyCap)';

// Reads the asset configs the market runs on, so every check below is derived from the market itself
async function getAssetConfigs(context: CometContext): Promise<AssetConfigStruct[]> {
  const comet = await context.getComet();
  const configurator = await context.getConfigurator();
  const { assetConfigs } = await configurator.getConfiguration(comet.address);

  return assetConfigs.map(({ asset, priceFeed, decimals, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap }) => ({
    asset, priceFeed, decimals, borrowCollateralFactor, liquidateCollateralFactor, liquidationFactor, supplyCap,
  }));
}

// Checks every field of the asset info against the config it was created from.
// The cap shares its storage words with the other fields, so all of them must come back intact.
function validateGetAssetInfo(assetInfo, index: number, assetConfig: AssetConfigStruct) {
  expect(assetInfo.offset).to.equal(index);
  expect(assetInfo.asset).to.equal(assetConfig.asset);
  expect(assetInfo.priceFeed).to.equal(assetConfig.priceFeed);
  expect(assetInfo.scale).to.equal(oneToken(assetConfig.decimals));
  expect(assetInfo.borrowCollateralFactor).to.equal(assetConfig.borrowCollateralFactor);
  expect(assetInfo.liquidateCollateralFactor).to.equal(assetConfig.liquidateCollateralFactor);
  expect(assetInfo.liquidationFactor).to.equal(assetConfig.liquidationFactor);
  expect(assetInfo.supplyCap).to.equal(assetConfig.supplyCap);
}

// One whole unit of a collateral with the given decimals
const oneToken = (decimals): bigint => 10n ** BigInt(decimals.toString());

// The caps every scenario below runs with, as a function of the collateral's own decimals
const supplyCaps: [string, (assetConfig: AssetConfigStruct) => bigint][] = [
  // 1000.05 tokens of whatever the collateral is; the old packing rounded this down to 1000 tokens
  ['fractional', ({ decimals }) => 1000n * oneToken(decimals) + oneToken(decimals) / 20n],
  ['1 wei', () => 1n],
  ['one wei below a whole token', ({ decimals }) => oneToken(decimals) - 1n],
  ['0.5 token', ({ decimals }) => oneToken(decimals) / 2n],
  ['10.5 token', ({ decimals }) => oneToken(decimals) * 21n / 2n],
  // Only the bits the asset list keeps in its first storage word are set
  ['upper stored bits only', () => UPPER_BITS_ONLY],
  ['uint128 max', () => MAX_UINT128],
  ['zero', () => 0n],
];

/*
 * Gives every collateral the cap of this scenario and checks that the cap survives both ways it
 * reaches the market: a freshly deployed asset list, and the configurator followed by a comet upgrade.
 */
supplyCaps.forEach(([name, capFor]) => {
  scenario(
    `Comet#assetList > stores a ${name} supply cap`,
    { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
    async (_properties, context) => {
      const ethers = context.world.deploymentManager.hre.ethers;
      const comet = await context.getComet();
      const configurator = await context.getConfigurator();
      const cometExt = await ethers.getContractAt('CometExtAssetList', comet.address);
      const { admin } = context.actors;

      // The admin pays for the configurator calls and the comet upgrade
      await fundAccount(context.world, admin);

      const assetConfigs = (await getAssetConfigs(context)).map(assetConfig => ({ ...assetConfig, supplyCap: capFor(assetConfig) }));

      // A new asset list built from the updated configs must store every cap as configured
      const assetListFactory = await ethers.getContractAt('AssetListFactory', await cometExt.assetListFactory()) as AssetListFactory;
      const assetListAddress = await assetListFactory.callStatic.createAssetList(assetConfigs);
      await assetListFactory.createAssetList(assetConfigs);
      const assetList = await ethers.getContractAt('AssetList', assetListAddress) as AssetList;

      expect(await assetList.numAssets()).to.equal(assetConfigs.length);
      for (let i = 0; i < assetConfigs.length; i++) {
        validateGetAssetInfo(await assetList.getAssetInfo(i), i, assetConfigs[i]);
      }

      // The same caps set through the configurator must survive the comet upgrade
      for (const assetConfig of assetConfigs) {
        await configurator.connect(admin.signer).updateAssetSupplyCap(comet.address, assetConfig.asset, assetConfig.supplyCap);
      }
      await admin.deployAndUpgradeTo(configurator.address, comet.address);

      expect(await comet.numAssets()).to.equal(assetConfigs.length);
      for (let i = 0; i < assetConfigs.length; i++) {
        validateGetAssetInfo(await comet.getAssetInfo(i), i, assetConfigs[i]);
      }
    }
  );
});

scenario(
  'Comet#assetList > reverts on a supply cap above uint128 max for each asset index',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async (_properties, context) => {
    const ethers = context.world.deploymentManager.hre.ethers;
    const comet = await context.getComet();
    const configurator = await context.getConfigurator();
    const cometExt = await ethers.getContractAt('CometExtAssetList', comet.address);
    const { admin } = context.actors;

    // The admin pays for the calls that are expected to revert
    await fundAccount(context.world, admin);

    const assetConfigs = await getAssetConfigs(context);
    const assetListFactory = await ethers.getContractAt('AssetListFactory', await cometExt.assetListFactory()) as AssetListFactory;

    // ethers won't encode a cap above uint128 max, so both calls are sent as raw calldata with the cap as uint256.
    // The value is out of range for the uint128 field, so the ABI decoder rejects it with an empty revert.
    const revertPatterns = [/without a reason/i, /transaction failed/i, /reverted/i];

    // The oversized cap goes on one collateral at a time, while the rest keep the cap the market runs with
    for (let i = 0; i < assetConfigs.length; i++) {
      const oversizedConfigs = assetConfigs.map((assetConfig, j) => (
        j === i ? { ...assetConfig, supplyCap: MAX_UINT128 + 1n } : assetConfig
      ));

      const createAssetListData = assetListFactory.interface.getSighash('createAssetList') +
        ethers.utils.defaultAbiCoder.encode([`${ASSET_CONFIG_WITH_WIDE_CAP}[]`], [oversizedConfigs]).slice(2);

      await expectRevertMatches(
        admin.signer.sendTransaction({ to: assetListFactory.address, data: createAssetListData, gasLimit: 30_000_000 }).then(tx => tx.wait()),
        revertPatterns
      );

      const updateSupplyCapData = configurator.interface.getSighash('updateAssetSupplyCap') +
        ethers.utils.defaultAbiCoder.encode(
          ['address', 'address', 'uint256'],
          [comet.address, assetConfigs[i].asset, MAX_UINT128 + 1n]
        ).slice(2);

      await expectRevertMatches(
        admin.signer.sendTransaction({ to: configurator.address, data: updateSupplyCapData, gasLimit: 30_000_000 }).then(tx => tx.wait()),
        revertPatterns
      );

      // The rejected update left the collateral with the cap it had
      const storedConfigs = await getAssetConfigs(context);
      expect(storedConfigs[i].supplyCap).to.equal(assetConfigs[i].supplyCap);
    }
  }
);
