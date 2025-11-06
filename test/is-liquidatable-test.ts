import {
  CometHarnessInterfaceExtendedAssetList,
  IERC20,
} from 'build/types';
import {
  expect,
  exp,
  makeProtocol,
  makeConfigurator,
  ethers,
  updateAssetLiquidateCollateralFactor,
  getLiquidityWithLiquidateCF,
} from './helpers';
import { BigNumber } from 'ethers';

/*
Prices are set in terms of the base token (USDC with 6 decimals, by default):

  await comet.setBasePrincipal(alice.address, 1_000_000);

But the prices returned are denominated in terms of price scale (USD with 8
decimals, by default)

*/

describe('isLiquidatable', function () {
  it('defaults to false', async () => {
    const protocol = await makeProtocol();
    const {
      comet,
      users: [alice],
    } = protocol;

    expect(await comet.isLiquidatable(alice.address)).to.be.false;
  });

  it('is false when user is owed principal', async () => {
    const {
      comet,
      users: [alice],
    } = await makeProtocol();
    await comet.setBasePrincipal(alice.address, 1_000_000);

    expect(await comet.isLiquidatable(alice.address)).to.be.false;
  });

  it('is true when user owes principal', async () => {
    const {
      comet,
      users: [alice],
    } = await makeProtocol();
    await comet.setBasePrincipal(alice.address, -1_000_000);

    expect(await comet.isLiquidatable(alice.address)).to.be.true;
  });

  it('is false when collateral can cover the borrowed principal', async () => {
    const {
      comet,
      tokens,
      users: [alice],
    } = await makeProtocol({
      assets: {
        USDC: { decimals: 6 },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 1, // 1 COMP = 1 USDC
        },
      },
    });
    const { COMP } = tokens;

    // user owes $100,000
    await comet.setBasePrincipal(alice.address, -100_000_000_000);
    // but has $100,000 in COMP to cover
    await comet.setCollateralBalance(
      alice.address,
      COMP.address,
      exp(100_000, 18)
    );

    expect(await comet.isLiquidatable(alice.address)).to.be.false;
  });

  it('is true when the collateral cannot cover the borrowed principal', async () => {
    const {
      comet,
      tokens,
      users: [alice],
    } = await makeProtocol({
      assets: {
        USDC: { decimals: 6 },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 1, // 1 COMP = 1 USDC
        },
      },
    });
    const { COMP } = tokens;

    // user owes $100,000 is
    await comet.setBasePrincipal(alice.address, -100_000_000_000);
    // and only has $95,000 in COMP
    await comet.setCollateralBalance(
      alice.address,
      COMP.address,
      exp(95_000, 18)
    );

    expect(await comet.isLiquidatable(alice.address)).to.be.true;
  });

  it('takes liquidateCollateralFactor into account when comparing principal to collateral', async () => {
    const {
      comet,
      tokens,
      users: [alice],
    } = await makeProtocol({
      assets: {
        USDC: { decimals: 6 },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 1, // 1 COMP = 1 USDC
          borrowCF: exp(0.75, 18),
          liquidateCF: exp(0.8, 18),
        },
      },
    });
    const { COMP } = tokens;

    // user owes $100,000
    await comet.setBasePrincipal(alice.address, -100_000_000_000);
    // has $100,000 in COMP to cover, but at a .8 liquidateCollateralFactor
    await comet.setCollateralBalance(
      alice.address,
      COMP.address,
      exp(100_000, 18)
    );

    expect(await comet.isLiquidatable(alice.address)).to.be.true;
  });

  it('changes when the underlying asset price changes', async () => {
    const {
      comet,
      tokens,
      users: [alice],
      priceFeeds,
    } = await makeProtocol({
      assets: {
        USDC: { decimals: 6 },
        COMP: {
          initial: 1e7,
          decimals: 18,
          initialPrice: 1, // 1 COMP = 1 USDC
        },
      },
    });
    const { COMP } = tokens;

    // user owes $100,000
    await comet.setBasePrincipal(alice.address, -100_000_000_000);
    // has $100,000 in COMP to cover
    await comet.setCollateralBalance(
      alice.address,
      COMP.address,
      exp(100_000, 18)
    );

    expect(await comet.isLiquidatable(alice.address)).to.be.false;

    // price drops
    await priceFeeds.COMP.setRoundData(
      0, // roundId
      exp(0.5, 8), // answer
      0, // startedAt
      0, // updatedAt
      0 // answeredInRound
    );

    expect(await comet.isLiquidatable(alice.address)).to.be.true;
  });

  describe('isLiquidatable semantics across liquidateCollateralFactor values', function () {
    // Configurator and protocol
    let configurator: any;
    let configuratorProxyAddress: string;
    let proxyAdmin: any;
    let cometProxyAddress: string;

    // Contracts
    let cometAsProxy: any;

    // Tokens
    let baseSymbol: string;
    let baseToken: any;
    let compToken: any;

    // Users
    let alice: any;
    let governor: any;

    // Values
    let supplyAmount: bigint;
    let borrowAmount: bigint;

    before(async () => {
      const cfg = await makeConfigurator({
        assets: {
          USDC: { decimals: 6, initialPrice: 1 },
          COMP: {
            initial: 1e7,
            decimals: 18,
            initialPrice: 1,
          },
        },
      });

      configurator = cfg.configurator;
      configuratorProxyAddress = cfg.configuratorProxy.address;
      proxyAdmin = cfg.proxyAdmin;
      cometProxyAddress = cfg.cometProxy.address;

      const comet = cfg.comet;
      cometAsProxy = comet.attach(cometProxyAddress);

      baseSymbol = cfg.base;
      baseToken = cfg.tokens[baseSymbol];
      compToken = cfg.tokens['COMP'];
      alice = cfg.users[0];
      governor = cfg.governor;

      // Upgrade proxy to extended asset list implementation to support many assets
      const assetListFactory = cfg.assetListFactory;
      const configuratorAsProxy = configurator.attach(configuratorProxyAddress);
      const CometExtAssetList = await (
        await ethers.getContractFactory('CometExtAssetList')
      ).deploy(
        {
          name32: ethers.utils.formatBytes32String('Compound Comet'),
          symbol32: ethers.utils.formatBytes32String('BASE'),
        },
        assetListFactory.address
      );
      await CometExtAssetList.deployed();
      await configuratorAsProxy.setExtensionDelegate(
        cometProxyAddress,
        CometExtAssetList.address
      );
      const CometFactoryWithExtendedAssetList = await (
        await ethers.getContractFactory('CometFactoryWithExtendedAssetList')
      ).deploy();
      await CometFactoryWithExtendedAssetList.deployed();
      await configuratorAsProxy.setFactory(
        cometProxyAddress,
        CometFactoryWithExtendedAssetList.address
      );
      await proxyAdmin.deployAndUpgradeTo(
        configuratorProxyAddress,
        cometProxyAddress
      );

      // Supply collateral and borrow base
      supplyAmount = exp(10, 18);
      borrowAmount = exp(5, 6);

      await compToken.allocateTo(alice.address, supplyAmount);
      await compToken.connect(alice).approve(cometProxyAddress, supplyAmount);
      await cometAsProxy.connect(alice).supply(compToken.address, supplyAmount);

      await baseToken.allocateTo(cometProxyAddress, borrowAmount);
      await cometAsProxy
        .connect(alice)
        .withdraw(baseToken.address, borrowAmount);

      // With positive liquidateCF and ample collateral, not liquidatable
      expect(await cometAsProxy.isLiquidatable(alice.address)).to.be.false;
    });

    it('liquidity calculation includes collateral with positive liquidateCF', async () => {
      const liquidity = await getLiquidityWithLiquidateCF(
        cometAsProxy,
        compToken,
        supplyAmount
      );
      expect(liquidity).to.be.greaterThan(0);
    });

    it('liquidateCF can be updated to 0', async () => {
      const configuratorAsProxy = configurator.attach(configuratorProxyAddress);

      // Governance: set COMP liquidateCF to 0 and upgrade
      await updateAssetLiquidateCollateralFactor(
        configuratorAsProxy,
        proxyAdmin,
        cometProxyAddress,
        compToken.address,
        0n,
        governor
      );

      // Verify liquidateCF is 0
      expect(
        (await cometAsProxy.getAssetInfoByAddress(compToken.address))
          .liquidateCollateralFactor
      ).to.equal(0);
    });

    it('liquidity calculation excludes collateral with zero liquidateCF', async () => {
      const liquidity = await getLiquidityWithLiquidateCF(
        cometAsProxy,
        compToken,
        supplyAmount
      );
      expect(liquidity).to.equal(0);
    });

    it('position becomes liquidatable when liquidateCF is set to 0', async () => {
      expect(await cometAsProxy.isLiquidatable(alice.address)).to.be.true;
    });
  });

  it('isLiquidatable with mixed liquidate factors counts only positive CF assets', async () => {
    // Create 5 collaterals: ASSET0..ASSET4 with explicit liquidateCF
    const collaterals = Object.fromEntries(
      Array.from({ length: 5 }, (_, j) => [
        `ASSET${j}`,
        {
          decimals: 18,
          initialPrice: 200,
          borrowCF: exp(0.75, 18),
          liquidateCF: exp(0.8, 18),
        },
      ])
    );

    // Create protocol with configurator so we can update liquidateCF later
    const {
      configurator,
      configuratorProxy,
      proxyAdmin,
      comet,
      cometProxy,
      tokens,
      users,
      base,
      assetListFactory,
      governor,
    } = await makeConfigurator({
      assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals },
    });

    const cometAsProxy = comet.attach(
      cometProxy.address
    ) as unknown as CometHarnessInterfaceExtendedAssetList;
    const configuratorAsProxy = configurator.attach(configuratorProxy.address);
    const baseToken = tokens[base];

    const underwater = users[0];

    // Upgrade proxy to extended asset list implementation to support many assets before updating CF
    const CometExtAssetList = await (
      await ethers.getContractFactory('CometExtAssetList')
    ).deploy(
      {
        name32: ethers.utils.formatBytes32String('Compound Comet'),
        symbol32: ethers.utils.formatBytes32String('BASE'),
      },
      assetListFactory.address
    );
    await CometExtAssetList.deployed();
    await configuratorAsProxy.setExtensionDelegate(
      cometProxy.address,
      CometExtAssetList.address
    );
    const CometFactoryWithExtendedAssetList = await (
      await ethers.getContractFactory('CometFactoryWithExtendedAssetList')
    ).deploy();
    await CometFactoryWithExtendedAssetList.deployed();
    await configuratorAsProxy.setFactory(
      cometProxy.address,
      CometFactoryWithExtendedAssetList.address
    );
    await proxyAdmin.deployAndUpgradeTo(
      configuratorProxy.address,
      cometProxy.address
    );

    // Supply equal collateral in all 5 assets
    const supplyAmount = exp(1, 18);
    const symbols = ['ASSET0', 'ASSET1', 'ASSET2', 'ASSET3', 'ASSET4'];
    for (const sym of symbols) {
      const token = tokens[sym];
      await token.allocateTo(underwater.address, supplyAmount);
      await token.connect(underwater).approve(cometProxy.address, supplyAmount);
      await cometAsProxy
        .connect(underwater)
        .supply(token.address, supplyAmount);
    }

    // Borrow base against the collateral
    // With 5 assets at price 200, liquidateCF 0.8: each asset contributes ~160 USDC liquidation value
    // Total liquidation value: 5 * 160 = 800 USDC. Borrow 400 so not liquidatable initially.
    // After zeroing 3 assets, only 2 contribute (320 total) < 400 borrowed, so liquidatable.
    const borrowAmount = exp(400, 6);
    await baseToken.allocateTo(cometProxy.address, borrowAmount);
    await cometAsProxy
      .connect(underwater)
      .withdraw(baseToken.address, borrowAmount);

    // Verify NOT liquidatable initially
    expect(await cometAsProxy.isLiquidatable(underwater.address)).to.be.false;

    // Zero liquidateCF for three assets: ASSET1, ASSET3, ASSET4
    const zeroLcfSymbols = ['ASSET1', 'ASSET3', 'ASSET4'];
    for (const sym of zeroLcfSymbols) {
      await updateAssetLiquidateCollateralFactor(
        configuratorAsProxy,
        proxyAdmin,
        cometProxy.address,
        tokens[sym].address,
        0n,
        governor
      );
    }

    // Verify liquidateCF=0 excludes those assets from liquidity
    const liquidityByAsset: Record<string, BigNumber> = {} as Record<
      string,
      BigNumber
    >;
    for (const sym of symbols) {
      liquidityByAsset[sym] = await getLiquidityWithLiquidateCF(
        cometAsProxy,
        tokens[sym] as IERC20,
        supplyAmount
      );
    }

    for (const sym of zeroLcfSymbols) {
      expect(liquidityByAsset[sym].eq(0)).to.be.true;
    }
    for (const sym of ['ASSET0', 'ASSET2']) {
      expect(liquidityByAsset[sym].gt(0)).to.be.true;
    }

    // With only two assets contributing (price 200, liquidateCF 0.8),
    // each contributes ~160 USDC, total ~320 USDC vs 400 borrowed
    // Position should become liquidatable
    expect(await cometAsProxy.isLiquidatable(underwater.address)).to.be.true;
  });

  for (let i = 1; i <= 24; i++) {
    it(`skips liquidation value of asset ${
      i - 1
    } with liquidateCF=0 with collaterals ${i}`, async () => {
      // Create collaterals: ASSET0, ASSET1, ..., ASSET{i-1}
      const collaterals = Object.fromEntries(
        Array.from({ length: i }, (_, j) => [
          `ASSET${j}`,
          {
            decimals: 18,
            initialPrice: 200,
            borrowCF: exp(0.75, 18),
            liquidateCF: exp(0.85, 18),
          },
        ])
      );

      const {
        configurator,
        configuratorProxy,
        proxyAdmin,
        comet,
        cometProxy,
        tokens,
        users,
        base,
        assetListFactory,
        governor,
      } = await makeConfigurator({
        assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals },
      });

      const cometAsProxy = comet.attach(cometProxy.address);
      const configuratorAsProxy = configurator.attach(
        configuratorProxy.address
      );
      const underwater = users[0];

      // Upgrade proxy to extended asset list implementation to support many assets
      const CometExtAssetList = await (
        await ethers.getContractFactory('CometExtAssetList')
      ).deploy(
        {
          name32: ethers.utils.formatBytes32String('Compound Comet'),
          symbol32: ethers.utils.formatBytes32String('BASE'),
        },
        assetListFactory.address
      );
      await CometExtAssetList.deployed();
      await configuratorAsProxy.setExtensionDelegate(
        cometProxy.address,
        CometExtAssetList.address
      );
      const CometFactoryWithExtendedAssetList = await (
        await ethers.getContractFactory('CometFactoryWithExtendedAssetList')
      ).deploy();
      await CometFactoryWithExtendedAssetList.deployed();
      await configuratorAsProxy.setFactory(
        cometProxy.address,
        CometFactoryWithExtendedAssetList.address
      );
      await proxyAdmin.deployAndUpgradeTo(
        configuratorProxy.address,
        cometProxy.address
      );

      const supplyAmount = exp(1, 18);
      const targetSymbol = `ASSET${i - 1}`;
      const targetToken = tokens[targetSymbol];
      await targetToken.allocateTo(underwater.address, supplyAmount);
      await targetToken
        .connect(underwater)
        .approve(cometProxy.address, supplyAmount);
      await cometAsProxy
        .connect(underwater)
        .supply(targetToken.address, supplyAmount);

      // Borrow amount collateralized by the single supplied asset under liquidation values (~170 USDC)
      const baseToken = tokens[base];
      const borrowAmount = exp(150, 6);
      await baseToken.allocateTo(cometProxy.address, borrowAmount);
      await cometAsProxy
        .connect(underwater)
        .withdraw(baseToken.address, borrowAmount);

      // Initially not liquidatable with positive liquidateCF
      expect(await cometAsProxy.isLiquidatable(underwater.address)).to.be.false;

      // Zero liquidateCF for target asset (last one)
      await updateAssetLiquidateCollateralFactor(
        configuratorAsProxy,
        proxyAdmin,
        cometProxy.address,
        targetToken.address,
        0n,
        governor
      );

      // After zeroing the only supplied asset's liquidateCF, position should be liquidatable
      expect(await cometAsProxy.isLiquidatable(underwater.address)).to.equal(
        true
      );
    });
  }
});
