import {
  CometProxyAdmin,
  Configurator,
  IERC20,
  CometHarnessInterfaceExtendedAssetList as CometWithExtendedAssetList,
} from "build/types";
import {
  expect,
  exp,
  makeProtocol,
  makeConfigurator,
  ethers,
  updateAssetBorrowCollateralFactor,
  getLiquidity,
} from "./helpers";
import { BigNumber } from "ethers";

describe("isBorrowCollateralized", function () {
  it("defaults to true", async () => {
    const protocol = await makeProtocol({ base: "USDC" });
    const {
      comet,
      users: [alice],
    } = protocol;

    expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
  });

  it("is true when user is owed principal", async () => {
    const {
      comet,
      users: [alice],
    } = await makeProtocol({ base: "USDC" });
    await comet.setBasePrincipal(alice.address, 1_000_000);

    expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
  });

  it("is false when user owes principal", async () => {
    const {
      comet,
      users: [alice],
    } = await makeProtocol({ base: "USDC" });

    await comet.setBasePrincipal(alice.address, -1_000_000);

    expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
  });

  it("is true when value of collateral is greater than principal owed", async () => {
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
          borrowCF: exp(0.9, 18),
        },
      },
    });
    const { COMP } = tokens;

    // user owes 1 USDC, but has 1.2 COMP collateral
    await comet.setBasePrincipal(alice.address, -exp(1, 6));
    await comet.setCollateralBalance(alice.address, COMP.address, exp(1.2, 18));

    expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
  });

  it("takes borrow collateral factor into account when valuing collateral", async () => {
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
          borrowCF: exp(0.9, 18),
        },
      },
    });
    const { COMP } = tokens;

    // user owes 1 USDC
    await comet.setBasePrincipal(alice.address, -1_000_000);
    // user has 1 COMP collateral, but the borrow collateral factor puts it
    // below the required collateral amount
    await comet.setCollateralBalance(alice.address, COMP.address, exp(1, 18));

    expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
  });

  it("changes when the underlying asset price changes", async () => {
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
          initialPrice: 1,
          borrowCF: exp(0.2, 18),
        },
      },
    });
    const { COMP } = tokens;

    // user owes 1 USDC
    await comet.setBasePrincipal(alice.address, -exp(1, 6));
    // ...but has 5 COMP to cover their position
    await comet.setCollateralBalance(alice.address, COMP.address, exp(5, 18));

    expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;

    await priceFeeds.COMP.setRoundData(
      0, // roundId
      exp(0.5, 8), // answer
      0, // startedAt
      0, // updatedAt
      0 // answeredInRound
    );

    expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
  });

  describe("isBorrowCollateralized semantics across borrowCollateralFactor values", function () {
    // Configurator and protocol
    let configurator: Configurator;
    let configuratorProxyAddress: string;
    let proxyAdmin: CometProxyAdmin;
    let cometProxyAddress: string;

    // Contracts
    let cometAsProxy: any;

    // Tokens
    let baseSymbol: string;
    let baseToken: any;
    let compToken: any;

    // Users
    let alice: any;

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
            borrowCF: exp(0.9, 18),
            liquidateCF: exp(0.95, 18),
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
      compToken = cfg.tokens["COMP"];
      alice = cfg.users[0];

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

      // With positive borrowCF, position is collateralized
      expect(await cometAsProxy.isBorrowCollateralized(alice.address)).to.be
        .true;
    });

    it("liquidity calculation includes collateral with positive borrowCF", async () => {
      const liquidity = await getLiquidity(
        cometAsProxy,
        compToken,
        supplyAmount
      );
      expect(liquidity).to.be.greaterThan(0);
    });

    it("borrowCF can be updated to 0", async () => {
      const configuratorAsProxy = configurator.attach(configuratorProxyAddress);

      // Governance: set COMP borrowCF to 0 and upgrade
      await updateAssetBorrowCollateralFactor(
        configuratorAsProxy,
        proxyAdmin,
        cometProxyAddress,
        compToken.address,
        0n
      );

      // Verify borrowCF is 0
      expect(
        (await cometAsProxy.getAssetInfoByAddress(compToken.address))
          .borrowCollateralFactor
      ).to.equal(0);
    });

    it("liquidity calculation excludes collateral with zero borrowCF", async () => {
      const liquidity = await getLiquidity(
        cometAsProxy as any,
        compToken,
        supplyAmount
      );
      expect(liquidity).to.eq(0);
    });

    it("collateralization becomes false when borrowCF is set to 0", async () => {
      expect(await cometAsProxy.isBorrowCollateralized(alice.address)).to.be
        .false;
    });
  });

  it("isBorrowCollateralized with mixed borrow factors counts only positive CF assets", async () => {
    /**
     * This test verifies that when some assets have
     * borrowCollateralFactor set to 0, they contribute zero liquidity and
     * are ignored by isBorrowCollateralized, while assets with positive
     * borrowCF still count toward collateralization.
     */

    // Create 5 collaterals: ASSET0..ASSET4 with explicit borrowCF
    const collaterals = Object.fromEntries(
      Array.from({ length: 5 }, (_, j) => [
        `ASSET${j}`,
        {
          decimals: 18,
          initialPrice: 200,
          borrowCF: exp(0.9, 18), // Explicit borrowCF for predictability
        },
      ])
    );

    // Create protocol with configurator so we can update borrowCF later
    const {
      configurator,
      configuratorProxy,
      proxyAdmin,
      comet,
      cometProxy,
      tokens,
      users,
      base,
      priceFeeds,
    } = await makeConfigurator({
      assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals },
    });

    const cometAsProxy = comet.attach(
      cometProxy.address
    ) as unknown as CometWithExtendedAssetList;
    const configuratorAsProxy = configurator.attach(configuratorProxy.address);
    const baseToken = tokens[base];

    const underwater = users[0];

    // Supply equal collateral in all 5 assets
    const supplyAmount = exp(1, 18);
    const symbols = ["ASSET0", "ASSET1", "ASSET2", "ASSET3", "ASSET4"];
    for (const sym of symbols) {
      const token = tokens[sym];
      await token.allocateTo(underwater.address, supplyAmount);
      await token.connect(underwater).approve(cometProxy.address, supplyAmount);
      await cometAsProxy
        .connect(underwater)
        .supply(token.address, supplyAmount);
    }

    // Borrow base against the collateral
    // With 5 assets at price 200, borrowCF 0.9: each asset contributes ~180 USDC liquidity
    // Total liquidity: 5 * 180 = 900 USDC. Borrow 400 to stay well collateralized initially.
    // After zeroing 3 assets, only 2 contribute (360 total) < 400 borrowed, so undercollateralized.
    const borrowAmount = exp(400, 6);
    await baseToken.allocateTo(cometProxy.address, borrowAmount);
    await cometAsProxy
      .connect(underwater)
      .withdraw(baseToken.address, borrowAmount);

    // Verify collateralized initially
    expect(await cometAsProxy.isBorrowCollateralized(underwater.address)).to.be
      .true;

    // Zero borrowCF for three assets: ASSET1, ASSET3, ASSET4
    const zeroBcfSymbols = ["ASSET1", "ASSET3", "ASSET4"];
    for (const sym of zeroBcfSymbols) {
      await updateAssetBorrowCollateralFactor(
        configuratorAsProxy,
        proxyAdmin,
        cometProxy.address,
        tokens[sym].address,
        0n
      );
    }

    // Verify borrowCF=0 excludes those assets from liquidity
    const liquidityByAsset: Record<string, BigNumber> = {} as Record<
      string,
      BigNumber
    >;
    for (const sym of symbols) {
      liquidityByAsset[sym] = await getLiquidity(
        cometAsProxy,
        tokens[sym] as IERC20,
        supplyAmount
      );
    }

    for (const sym of zeroBcfSymbols) {
      expect(liquidityByAsset[sym].eq(0)).to.be.true;
    }
    for (const sym of ["ASSET0", "ASSET2"]) {
      expect(liquidityByAsset[sym].gt(0)).to.be.true;
    }

    // With only two assets contributing (price 200, borrowCF 0.9),
    // each contributes ~180 USDC liquidity, total ~360 USDC vs 400 borrowed
    // Position should be undercollateralized
    expect(await cometAsProxy.isBorrowCollateralized(underwater.address)).to.be
      .false;
  });

  for (let i = 1; i <= 24; i++) {
    it(`skips liquidity of asset ${
      i - 1
    } with borrowCF=0 with collaterals ${i}`, async () => {
      // Create collaterals: ASSET0, ASSET1, ..., ASSET{i-1}
      const collaterals = Object.fromEntries(
        Array.from({ length: i }, (_, j) => [
          `ASSET${j}`,
          {
            decimals: 18,
            initialPrice: 200,
            borrowCF: exp(0.9, 18),
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
      } = await makeConfigurator({
        assets: { USDC: { decimals: 6, initialPrice: 1 }, ...collaterals },
      });

      const cometAsProxy = comet.attach(
        cometProxy.address
      ) as unknown as CometWithExtendedAssetList;
      const configuratorAsProxy = configurator.attach(
        configuratorProxy.address
      );
      const underwater = users[0];

      // Upgrade proxy to extended asset list implementation to support many assets
      const CometExtAssetList = await (
        await ethers.getContractFactory("CometExtAssetList")
      ).deploy(
        {
          name32: ethers.utils.formatBytes32String("Compound Comet"),
          symbol32: ethers.utils.formatBytes32String("BASE"),
        },
        assetListFactory.address
      );
      await CometExtAssetList.deployed();
      await configuratorAsProxy.setExtensionDelegate(
        cometProxy.address,
        CometExtAssetList.address
      );
      const CometFactoryWithExtendedAssetList = await (
        await ethers.getContractFactory("CometFactoryWithExtendedAssetList")
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

      // Borrow an amount collateralized by the single supplied asset (~180 USDC liquidity)
      const borrowAmount = exp(150, 6);
      await tokens[base].allocateTo(cometProxy.address, borrowAmount);
      await cometAsProxy
        .connect(underwater)
        .withdraw(tokens[base].address, borrowAmount);

      // Initially collateralized with single asset active
      expect(await cometAsProxy.isBorrowCollateralized(underwater.address)).to
        .be.true;

      // Zero borrowCF for target asset (last one)
      await updateAssetBorrowCollateralFactor(
        configuratorAsProxy,
        proxyAdmin,
        cometProxy.address,
        targetToken.address,
        0n
      );

      // Verify target asset liquidity is zero
      const liq = await getLiquidity(
        cometAsProxy,
        targetToken as unknown as IERC20,
        supplyAmount
      );
      expect(liq).to.equal(0);

      // After zeroing the only supplied asset's borrowCF, position should be undercollateralized
      expect(
        await cometAsProxy.isBorrowCollateralized(underwater.address)
      ).to.equal(false);
    });
  }
});
