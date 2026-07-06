import { ContractTransaction } from 'ethers';
import {
  CometHarnessInterfaceExtendedAssetList,
  CometProxyAdmin,
  Configurator,
  LiquidationModuleForComet,
  OneInchV6Adapter,
} from 'build/types';
import {
  deployDefaultLiquidationModuleWithComet,
  deployEmptyDexAdapter,
  ethers,
  exp,
  expect,
  makeConfigurator,
} from '../../helpers';

// Covers the governance deployment flow for attaching a new liquidation module to an
// already deployed Comet proxy. This matters because the module must bind to the
// existing proxy first, then receive the new asset list during the Comet upgrade.
describe('upgrade liquidation module', function () {
  const INCENTIVE_BPS = BigInt(500);

  let configuratorAsProxy: Configurator;
  let cometAsProxy: CometHarnessInterfaceExtendedAssetList;
  let proxyAdmin: CometProxyAdmin;
  let liquidationModule: LiquidationModuleForComet;
  let dexAdapter: OneInchV6Adapter;

  let cometProxyAddress: string;
  let oldLiquidationModule: string;
  let baseToken: string;
  let assetListBefore: string;
  let assetListAfter: string;
  let numAssets: number;
  let baseScale: bigint;
  let multisig: string;
  let executor: string;
  let pauser: string;
  let deployedImplementation: string;

  before(async () => {
    const protocol = await makeConfigurator({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        COMP: { decimals: 18, initialPrice: 100 },
        WETH: { decimals: 18, initialPrice: 2000 },
      },
      skipInitStorage: true,
    });

    configuratorAsProxy = protocol.configurator.attach(protocol.configuratorProxy.address);
    cometAsProxy = protocol.comet.attach(protocol.cometProxy.address);
    proxyAdmin = protocol.proxyAdmin;
    cometProxyAddress = protocol.cometProxy.address;
    oldLiquidationModule = protocol.defaultLiquidationModule.address;
    baseToken = protocol.tokens.USDC.address;
    assetListBefore = await cometAsProxy.assetList();
    numAssets = await cometAsProxy.numAssets();
    baseScale = (await cometAsProxy.baseScale()).toBigInt();
    multisig = protocol.multisig.address;
    executor = protocol.executors[0].address;
    pauser = protocol.pausers[0].address;

    dexAdapter = await deployEmptyDexAdapter([
      protocol.tokens.COMP.address,
      protocol.tokens.WETH.address,
    ]);
  });

  describe('deploy module for existing comet', function () {
    let deployTx: ContractTransaction;

    it('deploys the module', async () => {
      liquidationModule = await deployDefaultLiquidationModuleWithComet(
        {
          dexAdapter: dexAdapter.address,
          multisig,
          executors: [executor],
          pausers: [pauser],
          incentiveBps: INCENTIVE_BPS,
        },
        cometProxyAddress
      ) as unknown as LiquidationModuleForComet;
      deployTx = liquidationModule.deployTransaction;

      expect(liquidationModule.address).to.properAddress;
    });

    it('emits the initial incentive event', async () => {
      await expect(deployTx)
        .to.emit(liquidationModule, 'IncentiveBpsUpdated')
        .withArgs(0, INCENTIVE_BPS);
    });

    it('sets COMET to the existing comet proxy', async () => {
      expect(await liquidationModule.comet()).to.equal(cometProxyAddress);
    });

    it('sets BASE_SCALE from the existing comet proxy', async () => {
      expect(await liquidationModule.baseScale()).to.equal(await cometAsProxy.baseScale());
    });

    it('sets the DEX adapter', async () => {
      expect(await liquidationModule.dexAdapter()).to.equal(dexAdapter.address);
    });

    it('sets the multisig', async () => {
      expect(await liquidationModule.multisig()).to.equal(multisig);
    });

    it('sets the incentive bps', async () => {
      expect(await liquidationModule.incentiveBps()).to.equal(INCENTIVE_BPS);
    });

    it('enables partial liquidation', async () => {
      expect(await liquidationModule.partialLiquidationEnabled()).to.be.true;
    });

    it('exposes the target health factor', async () => {
      expect(await liquidationModule.TARGET_HEALTH_FACTOR()).to.equal(exp(1.05, 18));
    });

    it('grants the executor role', async () => {
      expect(await liquidationModule.hasRole(await liquidationModule.EXECUTOR_ROLE(), executor)).to.be.true;
    });

    it('grants the pauser role', async () => {
      expect(await liquidationModule.hasRole(await liquidationModule.PAUSER_ROLE(), pauser)).to.be.true;
    });

    it('grants the multisig role', async () => {
      expect(await liquidationModule.hasRole(await liquidationModule.MULTISIG_ROLE(), multisig)).to.be.true;
    });

    it('initiates the DEX adapter for the existing comet', async () => {
      expect(await dexAdapter.comet()).to.equal(cometProxyAddress);
    });

    it('authorizes the module on the DEX adapter', async () => {
      expect(await dexAdapter.module()).to.equal(liquidationModule.address);
    });

    it('does not set the module asset list before the comet upgrade', async () => {
      expect(await liquidationModule.assetList()).to.equal(ethers.constants.AddressZero);
    });
  });

  describe('update config in configurator', function () {
    let setLiquidationModuleTx: ContractTransaction;

    it('sanity check: configuration and Comet start with the old liquidation module', async () => {
      expect((await configuratorAsProxy.getConfiguration(cometProxyAddress)).liquidationModule).to.equal(oldLiquidationModule);
      expect(await cometAsProxy.liquidationModule()).to.equal(oldLiquidationModule);
    });

    it('governor sets the new liquidation module', async () => {
      setLiquidationModuleTx = await configuratorAsProxy.setLiquidationModule(cometProxyAddress, liquidationModule.address);
      await expect(setLiquidationModuleTx).to.not.be.reverted;
    });

    it('emits SetLiquidationModule', async () => {
      await expect(setLiquidationModuleTx)
        .to.emit(configuratorAsProxy, 'SetLiquidationModule')
        .withArgs(cometProxyAddress, oldLiquidationModule, liquidationModule.address);
    });

    it('stores the new liquidation module in the configuration', async () => {
      expect((await configuratorAsProxy.getConfiguration(cometProxyAddress)).liquidationModule).to.equal(liquidationModule.address);
    });

    it('keeps Comet on the old liquidation module before upgrade', async () => {
      expect(await cometAsProxy.liquidationModule()).to.equal(oldLiquidationModule);
    });
  });

  describe('upgrade a comet', function () {
    let upgradeEventNames: string[];

    it('deploys a new implementation and upgrades the proxy', async () => {
      const upgradeTx = await proxyAdmin.deployAndUpgradeTo(configuratorAsProxy.address, cometProxyAddress);
      const receipt = await upgradeTx.wait();
      const upgradeEvents = [];
      const iface = new ethers.utils.Interface([
        'event CometDeployed(address indexed cometProxy, address indexed newComet)',
        'event Upgraded(address indexed implementation)',
      ]);

      for (const event of receipt.events ?? []) {
        try {
          upgradeEvents.push(iface.parseLog(event));
        } catch {
          // Ignore unrelated logs in the receipt.
        }
      }

      upgradeEventNames = upgradeEvents.map((event) => event.name);
      deployedImplementation = upgradeEvents.find((event) => event.name === 'CometDeployed')?.args.newComet;

      expect(receipt.status).to.equal(1);
    });

    it('emits CometDeployed', async () => {
      expect(upgradeEventNames).to.include('CometDeployed');
    });

    it('emits Upgraded', async () => {
      expect(upgradeEventNames).to.include('Upgraded');
    });

    it('deploys a new implementation for the proxy', async () => {
      expect(deployedImplementation).to.properAddress;
    });

    it('Comet uses the new liquidation module', async () => {
      expect(await cometAsProxy.liquidationModule()).to.equal(liquidationModule.address);
    });

    it('Comet keeps the same base token', async () => {
      expect(await cometAsProxy.baseToken()).to.equal(baseToken);
    });

    it('Comet deploys a fresh asset list for the upgraded implementation', async () => {
      assetListAfter = await cometAsProxy.assetList();
      expect(assetListAfter).to.not.equal(assetListBefore);
    });

    it('sets the module asset list to the upgraded Comet asset list', async () => {
      expect(await liquidationModule.assetList()).to.equal(assetListAfter);
    });

    it('sets the module asset count from the upgraded Comet', async () => {
      expect(await liquidationModule.numAssets()).to.equal(numAssets);
    });

    it('sets the module base token from the upgraded Comet', async () => {
      expect(await liquidationModule.baseToken()).to.equal(baseToken);
    });

    it('keeps the module COMET bound to the proxy', async () => {
      expect(await liquidationModule.comet()).to.equal(cometProxyAddress);
    });

    it('keeps the module BASE_SCALE bound to the proxy setting', async () => {
      expect(await liquidationModule.baseScale()).to.equal(baseScale);
    });

    it('sets the DEX adapter base asset from the upgraded Comet', async () => {
      expect(await dexAdapter.baseAsset()).to.equal(baseToken);
    });

    it('keeps the DEX adapter bound to the proxy', async () => {
      expect(await dexAdapter.comet()).to.equal(cometProxyAddress);
    });
  });

  describe('revert when', function () {
    it('setAssetList is called after the upgrade initialized it', async () => {
      await expect(
        liquidationModule.setAssetList(assetListAfter, numAssets, baseToken)
      ).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
    });

    it('initiateModule is called after the constructor initialized it', async () => {
      await expect(
        liquidationModule.initiateModule(baseScale)
      ).to.be.revertedWithCustomError(liquidationModule, 'AlreadySet');
    });
  });
});
