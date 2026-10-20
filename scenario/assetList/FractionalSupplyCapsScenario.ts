import { expect } from 'chai';
import { CometContext, scenario } from '../context/CometContext';
import { expectRevertMatches, fundAccount, getUsableCollateralIndices, servicePatch2 } from '../utils';
import { MAX_UINT128, supplyCaps, validateAssetInfos } from './shared';

/*//////////////////////////////////////////////////////////////
                          HAPPY CASES
//////////////////////////////////////////////////////////////*/

// Gives every collateral the cap of this scenario through the configurator and checks the comet reads it back exactly
supplyCaps.forEach(([name, capFor]) => {
  scenario(
    `Comet#assetList > stores a ${name} supply cap`,
    { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
    async ({ comet, configurator, actors }, context) => {
      const { admin } = actors;

      // The admin pays for the configurator calls
      await fundAccount(context.world, admin);

      const assetConfigs = [];
      for (const assetConfig of await configurator.getAssetConfigs(comet.address)) {
        assetConfigs.push({ ...assetConfig, supplyCap: await capFor(assetConfig, context) });
      }

      for (const assetConfig of assetConfigs) {
        await configurator.connect(admin.signer).updateAssetSupplyCap(comet.address, assetConfig.asset, assetConfig.supplyCap);
      }

      await validateAssetInfos(context, assetConfigs);
    }
  );
});

/*//////////////////////////////////////////////////////////////
                          REVERT CASES
//////////////////////////////////////////////////////////////*/

scenario(
  'Comet#assetList > reverts on a supply cap above uint128 max for each asset index',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ comet, configurator, actors }, context) => {
    const ethers = context.world.deploymentManager.hre.ethers;
    const { admin } = actors;

    // The admin pays for the calls that are expected to revert
    await fundAccount(context.world, admin);

    const assetConfigs = await configurator.getAssetConfigs(comet.address);

    // ethers won't encode a cap above uint128 max, so the call is sent as raw calldata with the cap as uint256.
    // The value is out of range for the uint128 parameter, so the ABI decoder rejects it with an empty revert.
    const revertPatterns = [/without a reason/i, /transaction failed/i, /reverted/i];

    for (let i = 0; i < assetConfigs.length; i++) {
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
      expect((await configurator.getAssetConfigs(comet.address))[i].supplyCap).to.equal(assetConfigs[i].supplyCap);
      expect((await comet.getAssetInfo(i)).supplyCap).to.equal(assetConfigs[i].supplyCap);
    }
  }
);

// The Configurator rejects an unknown asset with its own error before reaching the list,
// so the list is called as the configurator to reach its own check
scenario(
  'Comet#assetList > reverts on a supply cap for an asset that is not in the list',
  { filter: async (ctx: CometContext) => await servicePatch2(ctx) },
  async ({ configurator, assetList, actors }, context) => {
    const { albert } = actors;
    const configuratorSigner = await context.world.impersonateAddress(configurator.address);
    await fundAccount(context.world, configuratorSigner);

    // Any address that is not a collateral of the market
    await expect(assetList.connect(configuratorSigner).setSupplyCap(albert.address, 1n))
      .to.be.revertedWithCustomError(assetList, 'BadAsset');
  }
);

/*//////////////////////////////////////////////////////////////
                             ACCESS
//////////////////////////////////////////////////////////////*/

// The supply cap setter of the asset list is for the Configurator only. Every call writes back the current cap
// of a usable collateral, so a call can only fail on who makes it

scenario(
  'AssetList#setSupplyCap > succeeds when called by the configurator',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const assetInfo = await comet.getAssetInfo(assetIndex);

    // The Configurator setter calls the asset list setter, with the Configurator as the caller
    await configurator.connect(admin.signer).updateAssetSupplyCap(comet.address, assetInfo.asset, assetInfo.supplyCap);

    expect(await comet.getAssetInfo(assetIndex)).to.deep.equal(assetInfo);
  }
);

scenario(
  'AssetList#setSupplyCap > reverts when called directly by the governor',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, assetList, actors }, context) => {
    const { admin } = actors;
    await fundAccount(context.world, admin);
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, supplyCap } = await comet.getAssetInfo(assetIndex);

    await expect(assetList.connect(admin.signer).setSupplyCap(asset, supplyCap))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
  }
);

scenario(
  'AssetList#setSupplyCap > reverts when called directly by a random account',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, assetList, actors }, context) => {
    const { albert } = actors;
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, supplyCap } = await comet.getAssetInfo(assetIndex);

    await expect(assetList.connect(albert.signer).setSupplyCap(asset, supplyCap))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
  }
);

scenario(
  'AssetList#setSupplyCap > reverts when called directly by the proxy admin, which never reaches the implementation',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, assetList, proxyAdmin }, context) => {
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, supplyCap } = await comet.getAssetInfo(assetIndex);
    const proxyAdminSigner = await context.world.impersonateAddress(proxyAdmin.address);
    await fundAccount(context.world, proxyAdminSigner);

    await expect(assetList.connect(proxyAdminSigner).setSupplyCap(asset, supplyCap))
      .to.be.revertedWith('TransparentUpgradeableProxy: admin cannot fallback to proxy target');
  }
);

// The configurator is set in the storage of the proxy by initialize, so the implementation has none of its own
scenario(
  'AssetList#setSupplyCap > reverts when the configurator calls the implementation instead of the proxy',
  {
    filter: async (ctx: CometContext) => await servicePatch2(ctx) && (await getUsableCollateralIndices(ctx)).length > 0
  },
  async ({ comet, configurator, assetList, proxyAdmin }, context) => {
    const [assetIndex] = await getUsableCollateralIndices(context, 1);
    const { asset, supplyCap } = await comet.getAssetInfo(assetIndex);
    const implementation = assetList.attach(await proxyAdmin.getProxyImplementation(assetList.address));
    const configuratorSigner = await context.world.impersonateAddress(configurator.address);
    await fundAccount(context.world, configuratorSigner);

    await expect(implementation.connect(configuratorSigner).setSupplyCap(asset, supplyCap))
      .to.be.revertedWithCustomError(assetList, 'OnlyConfigurator');
  }
);
