import { ConfiguratorAndProtocol, ethers, exp, expect, SnapshotRestorer, takeSnapshot, setBalance, makeConfigurator, deployEmptyDexAdapter } from '../helpers';
import {
  CometHarnessInterfaceExtendedAssetList,
  CometInterface,
  CometWithExtendedAssetList__factory,
  CometExtAssetList__factory,
  Configurator,
  AssetListFactory__factory,
  SimplePriceFeed__factory,
  FaucetToken__factory,
  OneInchV6Adapter__factory,
  LiquidationModule,
  LiquidationModule__factory,
  LiquidationModuleForComet,
  LiquidationModuleForComet__factory,
} from 'build/types';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ContractTransaction } from 'ethers';

describe('liquidation module', function () {
  const INCENTIVE_BPS = BigInt(500);
  const ZERO = ethers.constants.AddressZero;

  // Parameter setters are gated by OZ AccessControl's MULTISIG_ROLE.
  const MULTISIG_ROLE = ethers.utils.id('MULTISIG_ROLE');
  const missingRole = (account: string, role: string) =>
    `AccessControl: account ${account.toLowerCase()} is missing role ${role}`;

  let comet: CometInterface;
  let liquidationModule: LiquidationModule;
  let LiquidationModuleFactory: LiquidationModule__factory;
  let LiquidationModuleForCometFactory: LiquidationModuleForComet__factory;
  let dexAdapter: string;
  let protocol: ConfiguratorAndProtocol;
  let configuratorAsProxy: Configurator;
  let cometAsProxy: CometHarnessInterfaceExtendedAssetList;
  let cometProxyAddress: string;
  let configuratorProxyAddress: string;
  let configuratorBaseToken: string;

  let governor: SignerWithAddress;
  let alice: SignerWithAddress;
  let moduleExecutor: SignerWithAddress;
  let modulePauser: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    const signers = await ethers.getSigners();
    const [deployer, pauseGuardian] = signers;
    alice = signers[2];
    moduleExecutor = signers[9];
    modulePauser = signers[10];
    const executors = [signers[3].address, signers[4].address, signers[5].address];
    const pausers = [signers[6].address, signers[7].address, signers[8].address];

    // The module's DAO (DEFAULT_ADMIN_ROLE) is a hardcoded constant; this suite also drives the onlyMultisig
    // setters through it, so it doubles as the Multisig.
    governor = await ethers.getImpersonatedSigner('0x6d903f6003cca6255D85CcA4D3B5E5146dC33925');
    await setBalance(governor.address, ethers.utils.parseEther('10'));

    // Mock market tokens: USDC base + a single WETH collateral
    const FaucetTokenFactory = (await ethers.getContractFactory('FaucetToken')) as FaucetToken__factory;
    const usdc = await FaucetTokenFactory.deploy(exp(1, 6), 'USD Coin', 6, 'USDC');
    await usdc.deployed();
    const weth = await FaucetTokenFactory.deploy(exp(1, 18), 'Wrapped Ether', 18, 'WETH');
    await weth.deployed();

    const PriceFeedFactory = (await ethers.getContractFactory('SimplePriceFeed')) as SimplePriceFeed__factory;
    const usdcFeed = await PriceFeedFactory.deploy(exp(1, 8), 8);
    await usdcFeed.deployed();
    const wethFeed = await PriceFeedFactory.deploy(exp(2000, 8), 8);
    await wethFeed.deployed();

    // Asset list factory + extension delegate
    const AssetListFactoryFactory = (await ethers.getContractFactory('AssetListFactory')) as AssetListFactory__factory;
    const assetListFactory = await AssetListFactoryFactory.deploy();
    await assetListFactory.deployed();
    const CometExtFactory = (await ethers.getContractFactory('CometExtAssetList')) as CometExtAssetList__factory;
    const extensionDelegate = await CometExtFactory.deploy(
      {
        name32: ethers.utils.formatBytes32String('Compound Comet'),
        symbol32: ethers.utils.formatBytes32String('📈BASE'),
      },
      assetListFactory.address
    );
    await extensionDelegate.deployed();

    // DEX adapter with unset route per collateral
    const AdapterFactory = (await ethers.getContractFactory('OneInchV6Adapter')) as OneInchV6Adapter__factory;
    const adapter = await AdapterFactory.deploy(deployer.address, deployer.address, weth.address, 500, [
      {
        collateral: weth.address,
        kind: 0, // Unset
        poolKey: { currency0: ZERO, currency1: ZERO, fee: 0, tickSpacing: 0, hooks: ZERO },
        zeroForOne: false,
        path: [],
      },
    ]);
    await adapter.deployed();
    dexAdapter = adapter.address;

    // Liquidation module (bound to the Comet below via initializeStorage)
    LiquidationModuleFactory = (await ethers.getContractFactory('LiquidationModule')) as LiquidationModule__factory;
    LiquidationModuleForCometFactory = (await ethers.getContractFactory('LiquidationModuleForComet')) as LiquidationModuleForComet__factory;
    liquidationModule = await LiquidationModuleFactory.deploy(
      dexAdapter,
      governor.address, // multisig == DAO for this suite
      executors,
      pausers,
      INCENTIVE_BPS
    );
    await liquidationModule.deployed();

    // Comet (the real implementation, not the test harness)
    const CometFactory = (await ethers.getContractFactory('CometWithExtendedAssetList')) as CometWithExtendedAssetList__factory;
    const cometContract = await CometFactory.deploy({
      governor: governor.address,
      pauseGuardian: pauseGuardian.address,
      extensionDelegate: extensionDelegate.address,
      liquidationModule: liquidationModule.address,
      baseToken: usdc.address,
      baseTokenPriceFeed: usdcFeed.address,
      supplyKink: exp(0.8, 18),
      supplyPerYearInterestRateBase: exp(0, 18),
      supplyPerYearInterestRateSlopeLow: exp(0.05, 18),
      supplyPerYearInterestRateSlopeHigh: exp(2, 18),
      borrowKink: exp(0.8, 18),
      borrowPerYearInterestRateBase: exp(0.005, 18),
      borrowPerYearInterestRateSlopeLow: exp(0.1, 18),
      borrowPerYearInterestRateSlopeHigh: exp(3, 18),
      storeFrontPriceFactor: exp(1, 18),
      trackingIndexScale: exp(1, 15),
      baseTrackingSupplySpeed: exp(1, 15),
      baseTrackingBorrowSpeed: exp(1, 15),
      baseMinForRewards: exp(1, 6),
      baseBorrowMin: exp(1, 6),
      targetReserves: 0,
      assetConfigs: [
        {
          asset: weth.address,
          priceFeed: wethFeed.address,
          decimals: 18,
          borrowCollateralFactor: exp(0.8, 18),
          liquidateCollateralFactor: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(150000, 18),
        },
      ],
    });
    await cometContract.deployed();
    await cometContract.initializeStorage();
    comet = (await ethers.getContractAt('CometInterface', cometContract.address)) as CometInterface;

    protocol = await makeConfigurator({
      base: 'USDC',
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        COMP: { decimals: 18, initialPrice: 100 },
      },
      skipInitStorage: true,
    });
    configuratorAsProxy = protocol.configurator.attach(protocol.configuratorProxy.address);
    cometAsProxy = protocol.comet.attach(protocol.cometProxy.address);
    cometProxyAddress = protocol.cometProxy.address;
    configuratorProxyAddress = configuratorAsProxy.address;
    configuratorBaseToken = protocol.tokens.USDC.address;

    snapshot = await takeSnapshot();
  });

  context('constructor', function () {
    context('happy path', function () {
      it('sets COMET to the provided comet address', async () => {
        expect(await liquidationModule.comet()).to.equal(comet.address);
      });

      it('sets DEX_ADAPTER to the provided adapter address', async () => {
        expect(await liquidationModule.dexAdapter()).to.equal(dexAdapter);
      });

      // The constructor reports the initial thresholds as transitions from 0.
      it('emits BorderHFUpdated with the initial border value', async () => {
        await expect(liquidationModule.deployTransaction)
          .to.emit(liquidationModule, 'IncentiveBpsUpdated').withArgs(0, INCENTIVE_BPS);
      });
    });

    it('IncentiveBps exceeds maximum bps', async () => {
      await expect(LiquidationModuleFactory.deploy(dexAdapter, governor.address, [moduleExecutor.address], [modulePauser.address], 1_001))
        .to.be.revertedWithCustomError(liquidationModule, 'InvalidIncentiveBps');
    });

    context('revert when', function () {
      it('comet address is zero for LiquidationModuleForComet', async () => {
        await expect(
          LiquidationModuleForCometFactory.deploy(
            dexAdapter,
            governor.address,
            [moduleExecutor.address],
            [modulePauser.address],
            INCENTIVE_BPS,
            ZERO
          )
        ).to.be.revertedWithCustomError(liquidationModule, 'ZeroAddress');
      });
    });
  });

  context('manual setAssetList before Comet upgrade', function () {
    context('base token is set and asset list is zero', function () {
      let module: LiquidationModuleForComet;

      before(async () => {
        const adapter = await deployEmptyDexAdapter([protocol.tokens.COMP.address]);

        module = await LiquidationModuleForCometFactory.deploy(
          adapter.address,
          protocol.multisig.address,
          [protocol.executors[0].address],
          [protocol.pausers[0].address],
          INCENTIVE_BPS,
          cometProxyAddress
        );
        await module.deployed();
      });

      after(async () => await snapshot.restore());

      it('reverts before storing module settings because the adapter cannot read a zero asset list', async () => {
        await expect(module.setAssetList(ZERO, 1, configuratorBaseToken)).to.be.revertedWithoutReason;
      });
    });

    context('asset list is set and base token is zero', function () {
      let module: LiquidationModuleForComet;
      let assetList: string;
      let manualSetAssetListTx: ContractTransaction;
      let setLiquidationModuleTx: ContractTransaction;

      before(async () => {
        const adapter = await deployEmptyDexAdapter([protocol.tokens.COMP.address]);

        module = await LiquidationModuleForCometFactory.deploy(
          adapter.address,
          protocol.multisig.address,
          [protocol.executors[0].address],
          [protocol.pausers[0].address],
          INCENTIVE_BPS,
          cometProxyAddress
        );
        await module.deployed();
        assetList = await cometAsProxy.assetList();
      });

      after(async () => await snapshot.restore());

      it('manually sets asset list with a zero base token', async () => {
        manualSetAssetListTx = await module.setAssetList(assetList, 1, ZERO);
        await expect(manualSetAssetListTx).to.not.be.reverted;
      });

      it('stores the asset list on the module', async () => {
        expect(await module.assetList()).to.equal(assetList);
      });

      it('keeps the base token unset on the module', async () => {
        expect(await module.baseToken()).to.equal(ZERO);
      });

      it('updates the configurator to the new module', async () => {
        setLiquidationModuleTx = await configuratorAsProxy.setLiquidationModule(cometProxyAddress, module.address);
        await expect(setLiquidationModuleTx).to.not.be.reverted;
      });

      it('reverts during Comet upgrade because the module is already set', async () => {
        await expect(
          protocol.proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, cometProxyAddress)
        ).to.be.revertedWithCustomError(module, 'AlreadySet');
      });
    });

    context('asset list and base token are zero', function () {
      let module: LiquidationModuleForComet;

      before(async () => {
        const adapter = await deployEmptyDexAdapter([protocol.tokens.COMP.address]);

        module = await LiquidationModuleForCometFactory.deploy(
          adapter.address,
          protocol.multisig.address,
          [protocol.executors[0].address],
          [protocol.pausers[0].address],
          INCENTIVE_BPS,
          cometProxyAddress
        );
        await module.deployed();
      });

      after(async () => await snapshot.restore());

      it('reverts before storing module settings because the adapter cannot read a zero asset list', async () => {
        await expect(module.setAssetList(ZERO, 1, ZERO)).to.be.revertedWithoutReason;
      });
    });
  });

  context('setIncentiveBps', function () {
    const NEW_INCENTIVE_BPS = 700;

    context('happy path: governor updates the incentive bps', function () {
      let setTx: ContractTransaction;

      after(async () => await snapshot.restore());

      it('governor updates incentiveBps to a value below MAX_INCENTIVE', async () => {
        setTx = await liquidationModule.connect(governor).setIncentiveBps(NEW_INCENTIVE_BPS);
        await expect(setTx).to.not.be.reverted;
      });

      it('emits IncentiveBpsUpdated with old and new values', async () => {
        await expect(setTx).to.emit(liquidationModule, 'IncentiveBpsUpdated').withArgs(INCENTIVE_BPS, NEW_INCENTIVE_BPS);
      });

      it('incentiveBps is now the new value', async () => {
        expect(await liquidationModule.incentiveBps()).to.equal(NEW_INCENTIVE_BPS);
      });
    });

    context('revert when', function () {
      after(async () => await snapshot.restore());

      it('caller is not the multisig', async () => {
        await expect(liquidationModule.connect(alice).setIncentiveBps(NEW_INCENTIVE_BPS))
          .to.be.revertedWith(missingRole(alice.address, MULTISIG_ROLE));
      });

      it('incentiveBps exceeds MAX_INCENTIVE', async () => {
        await expect(liquidationModule.connect(governor).setIncentiveBps(1_001))
          .to.be.revertedWithCustomError(liquidationModule, 'InvalidIncentiveBps');
      });
    });
  });
});
