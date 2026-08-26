// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

import "forge-std/Test.sol";

import { AssetListFactory } from "@comet-contracts/AssetListFactory.sol";
import { CometConfiguration } from "@comet-contracts/CometConfiguration.sol";
import { CometExtAssetList } from "@comet-contracts/CometExtAssetList.sol";
import { CometFactoryWithExtendedAssetList } from "@comet-contracts/CometFactoryWithExtendedAssetList.sol";
import { CometInterface } from "@comet-contracts/CometInterface.sol";
import { CometProxyAdmin, Deployable } from "@comet-contracts/CometProxyAdmin.sol";
import { CometWithExtendedAssetList } from "@comet-contracts/CometWithExtendedAssetList.sol";
import { Configurator } from "@comet-contracts/Configurator.sol";
import { ConfiguratorProxy } from "@comet-contracts/ConfiguratorProxy.sol";
import { TransparentUpgradeableProxy } from "@comet-contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol";

import { MarketAdminPermissionChecker } from "@comet-contracts/marketupdates/MarketAdminPermissionChecker.sol";
import { MarketAdminPermissionCheckerInterface } from "@comet-contracts/marketupdates/MarketAdminPermissionCheckerInterface.sol";

import { OneInchV6Adapter } from "@comet-contracts/dex-adapters/core/OneInchV6Adapter.sol";
import { ICoreDexAdapter } from "@comet-contracts/interfaces/dex-adapters/ICoreDexAdapter.sol";
import { LiquidationModule } from "@comet-contracts/liquidation-module/LiquidationModule.sol";

import { LiquidationModuleDeployer } from "./LiquidationModuleDeployer.sol";

import { FaucetToken } from "@comet-contracts/test/FaucetToken.sol";
import { SimplePriceFeed } from "@comet-contracts/test/SimplePriceFeed.sol";

/**
 * @title Compound protocol fixture
 * @notice Deploys the whole protocol from scratch — mock tokens, price feeds, the Comet proxy and
 *         its admin, the Configurator, the market admin permission checker and the liquidation
 *         module — so fuzz tests get a live protocol with no fork and no deployment scripts.
 *         Inherit this contract and call `prepareFixture()` from `setUp()`.
 *
 *         The market mirrors `test/helpers/default-assets.ts`: USDC as the base token and the
 *         other 24 entries as collateral. Every step is its own function so a test can override
 *         one piece (a different asset table, different market parameters) and reuse the rest.
 */
abstract contract ProtocolFixture is Test {
    /// One row of the market's asset table. Mirrors an entry of default-assets.ts.
    /// `price` is in whole dollars; the collateral factors are 1e18-scaled.
    struct AssetSpec {
        string symbol;
        uint8 decimals;
        uint256 price;
        uint64 borrowCollateralFactor;
        uint64 liquidateCollateralFactor;
        uint64 liquidationFactor;
    }

    uint64 internal constant FACTOR_SCALE = 1e18;
    uint8 internal constant PRICE_FEED_DECIMALS = 8;
    uint256 internal constant TARGET_HF = 1.05e18;

    /// Incentive the executor earns on the DEX liquidation route.
    uint16 internal constant INCENTIVE_BPS = 500;
    /// The DEX adapter refuses a zero router and a zero slippage, but nothing here ever swaps:
    /// the routes are left unconfigured, so a liquidation falls back to sweeping collateral to Comet.
    uint16 internal constant DEX_SLIPPAGE_BPS = 500;
    address internal constant DEX_ROUTER = 0x111111125421cA6dc452d289314280a0f8842A65;

    /*//////////////////////////////////////////////////////////////
                                 ACTORS
    //////////////////////////////////////////////////////////////*/

    address internal dao;
    /// Governor of Comet, the Configurator and the ProxyAdmin.
    address internal timelock = makeAddr("timelock");
    address internal pauseGuardian = makeAddr("pauseGuardian");
    address internal marketAdmin = makeAddr("marketAdmin");
    /// Liquidation module roles. Kept apart from the DAO, which already holds the pauser role.
    address internal multisig = makeAddr("multisig");
    address internal executor = makeAddr("executor");
    address internal pauser = makeAddr("pauser");
    // Users
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");

    /*//////////////////////////////////////////////////////////////
                               CONTRACTS
    //////////////////////////////////////////////////////////////*/

    /// The market itself, reached through its proxy.
    CometInterface internal comet;
    TransparentUpgradeableProxy internal cometProxy;
    CometProxyAdmin internal proxyAdmin;
    CometFactoryWithExtendedAssetList internal cometFactory;
    /// The Configurator, reached through its proxy.
    Configurator internal configurator;
    ConfiguratorProxy internal configuratorProxy;
    CometExtAssetList internal extensionDelegate;
    AssetListFactory internal assetListFactory;
    MarketAdminPermissionChecker internal permissionChecker;
    /// The module the live market absorbs through, together with the adapter it swaps through.
    LiquidationModule internal liquidationModule;
    OneInchV6Adapter internal dexAdapter;

    /*//////////////////////////////////////////////////////////////
                                 MARKET
    //////////////////////////////////////////////////////////////*/

    /// The whole asset table, base token first.
    AssetSpec[] internal assetSpecs;
    FaucetToken internal baseToken;
    SimplePriceFeed internal basePriceFeed;
    /// Collateral in market order: `collaterals[i]` is the asset at Comet asset index `i`.
    FaucetToken[] internal collaterals;
    SimplePriceFeed[] internal collateralPriceFeeds;
    /// Set to the WETH mock, which the DEX adapter treats as native ETH.
    address internal weth;

    /**
     * @notice Deploys the whole market. Call this from `setUp()`.
     */
    function prepareFixture() internal {
        deployAssets();
        deployExtensionDelegate();

        // A Comet binds its liquidation module for good in the constructor, so the throwaway
        // implementation the proxy is born with needs a throwaway module of its own. The module the
        // market actually runs on is deployed below and reaches the proxy through the Configurator.
        deployMarketContracts(buildCometConfiguration(deployLiquidationModule()));

        liquidationModule = LiquidationModule(deployLiquidationModule());
        dao = liquidationModule.DAO();
        setupConfigurator(buildCometConfiguration(address(liquidationModule)));
        setupMarketAdminPermissionChecker();
        initializeMarket();
    }

    function deployAssets() internal {
        AssetSpec[] memory specs = defaultAssets();

        for (uint256 i; i < specs.length; ++i) {
            AssetSpec memory spec = specs[i];
            assetSpecs.push(spec);

            FaucetToken token = new FaucetToken(0, spec.symbol, spec.decimals, spec.symbol);
            SimplePriceFeed priceFeed =
                new SimplePriceFeed(int256(spec.price * 10 ** PRICE_FEED_DECIMALS), PRICE_FEED_DECIMALS);
            vm.label(address(token), spec.symbol);

            if (i == 0) {
                baseToken = token;
                basePriceFeed = priceFeed;
            } else {
                collaterals.push(token);
                collateralPriceFeeds.push(priceFeed);
            }

            if (keccak256(bytes(spec.symbol)) == keccak256("WETH")) weth = address(token);
        }
    }

    function deployExtensionDelegate() internal {
        assetListFactory = new AssetListFactory();
        extensionDelegate = new CometExtAssetList(
            CometConfiguration.ExtConfiguration({ name32: "Compound USDC", symbol32: "cUSDCv3" }),
            address(assetListFactory)
        );
    }

    function buildCometConfiguration(address liquidationModule_)
        internal
        view
        virtual
        returns (CometConfiguration.Configuration memory)
    {
        CometConfiguration.AssetConfig[] memory assetConfigs =
            new CometConfiguration.AssetConfig[](collaterals.length);

        for (uint256 i; i < collaterals.length; ++i) {
            AssetSpec memory spec = assetSpecs[i + 1]; // index 0 is the base token
            assetConfigs[i] = CometConfiguration.AssetConfig({
                asset: address(collaterals[i]),
                priceFeed: address(collateralPriceFeeds[i]),
                decimals: spec.decimals,
                borrowCollateralFactor: spec.borrowCollateralFactor,
                liquidateCollateralFactor: spec.liquidateCollateralFactor,
                liquidationFactor: spec.liquidationFactor,
                supplyCap: uint128(150_000 * 10 ** spec.decimals)
            });
        }

        uint64 baseUnit = uint64(10 ** assetSpecs[0].decimals);

        return CometConfiguration.Configuration({
            governor: timelock,
            pauseGuardian: pauseGuardian,
            baseToken: address(baseToken),
            baseTokenPriceFeed: address(basePriceFeed),
            extensionDelegate: address(extensionDelegate),
            supplyKink: 0.8e18,
            supplyPerYearInterestRateSlopeLow: 0.05e18,
            supplyPerYearInterestRateSlopeHigh: 2e18,
            supplyPerYearInterestRateBase: 0,
            borrowKink: 0.8e18,
            borrowPerYearInterestRateSlopeLow: 0.1e18,
            borrowPerYearInterestRateSlopeHigh: 3e18,
            borrowPerYearInterestRateBase: 0.005e18,
            storeFrontPriceFactor: FACTOR_SCALE,
            trackingIndexScale: 1e15,
            baseTrackingSupplySpeed: 1e15,
            baseTrackingBorrowSpeed: 1e15,
            baseMinForRewards: baseUnit,
            baseBorrowMin: baseUnit,
            targetReserves: 0,
            assetConfigs: assetConfigs,
            liquidationModule: liquidationModule_
        });
    }

    /**
     * @notice Deploys a liquidation module and the DEX adapter behind it.
     * @dev A module accepts one asset list and one Comet in its lifetime, which is why every
     *      implementation needs its own module and its own adapter.
     */
    function deployLiquidationModule() internal returns (address) {
        dexAdapter = LiquidationModuleDeployer.deployAdapter(
            DEX_ROUTER, weth, DEX_SLIPPAGE_BPS, collateralAddresses()
        );

        return address(LiquidationModuleDeployer.deployDefaultLiquidationModule(moduleOpts(dexAdapter)));
    }

    /// The roles a module is built with. The module refuses to start without an executor and a
    /// pauser, and refuses to grant the same role twice.
    function moduleOpts(ICoreDexAdapter adapter) internal view returns (LiquidationModuleDeployer.Opts memory) {
        address[] memory executors = new address[](1);
        executors[0] = executor;
        address[] memory pausers = new address[](1);
        pausers[0] = pauser;

        return LiquidationModuleDeployer.Opts({
            multisig: multisig,
            executors: executors,
            pausers: pausers,
            dexAdapter: adapter,
            incentiveBps: INCENTIVE_BPS
        });
    }

    /// The market's collateral in market order, as plain addresses.
    function collateralAddresses() internal view returns (address[] memory addresses) {
        addresses = new address[](collaterals.length);
        for (uint256 i; i < collaterals.length; ++i) {
            addresses[i] = address(collaterals[i]);
        }
    }

    function deployMarketContracts(CometConfiguration.Configuration memory config) internal {
        proxyAdmin = new CometProxyAdmin(timelock);

        CometWithExtendedAssetList cometImpl = new CometWithExtendedAssetList(config);
        cometProxy = new TransparentUpgradeableProxy(address(cometImpl), address(proxyAdmin), "");

        cometFactory = new CometFactoryWithExtendedAssetList();

        Configurator configuratorImpl = new Configurator();
        configuratorProxy = new ConfiguratorProxy(
            address(configuratorImpl),
            address(proxyAdmin),
            abi.encodeCall(Configurator.initialize, (timelock))
        );
        configurator = Configurator(address(configuratorProxy));

        vm.label(address(cometProxy), "comet");
        vm.label(address(configuratorProxy), "configurator");
    }

    function setupConfigurator(CometConfiguration.Configuration memory config) internal {
        vm.startPrank(timelock);
        configurator.setConfiguration(address(cometProxy), config);
        configurator.setFactory(address(cometProxy), address(cometFactory));
        vm.stopPrank();
    }

    /**
     * @notice Deploys the permission checker and registers it with both the Configurator and the
     *         proxy admin, which is what lets the market admin update the market alongside the DAO.
     */
    function setupMarketAdminPermissionChecker() internal {
        permissionChecker = new MarketAdminPermissionChecker(timelock, marketAdmin, address(0));

        vm.startPrank(timelock);
        configurator.setMarketAdminPermissionChecker(MarketAdminPermissionCheckerInterface(address(permissionChecker)));
        proxyAdmin.setMarketAdminPermissionChecker(MarketAdminPermissionCheckerInterface(address(permissionChecker)));
        vm.stopPrank();
    }

    function initializeMarket() internal {
        vm.prank(timelock);
        proxyAdmin.deployUpgradeToAndCall(
            Deployable(address(configuratorProxy)),
            cometProxy,
            abi.encodeWithSignature("initializeStorage()")
        );

        comet = CometInterface(address(cometProxy));
    }

    /// The market's asset table, base token first. Mirrors `default24Assets()` in test/helpers/default-assets.ts.
    function defaultAssets() internal pure virtual returns (AssetSpec[] memory specs) {
        specs = new AssetSpec[](25);

        //                     symbol   decimals   price   borrow  liquidate  liquidation
        specs[0]  = AssetSpec("USDC",      6,          1,       0,       0,       0);
        specs[1]  = AssetSpec("COMP",     18,        100, 0.80e18, 0.85e18, 0.90e18);
        specs[2]  = AssetSpec("WETH",     18,       2000, 0.75e18, 0.80e18, 0.90e18);
        specs[3]  = AssetSpec("USDT",      6,          1, 0.85e18, 0.90e18, 0.95e18);
        specs[4]  = AssetSpec("WBTC",      8,      65000, 0.70e18, 0.75e18, 0.90e18);
        specs[5]  = AssetSpec("DAI",      18,          1, 0.83e18, 0.88e18, 0.95e18);
        specs[6]  = AssetSpec("wstETH",   18,       3600, 0.75e18, 0.80e18, 0.93e18);
        specs[7]  = AssetSpec("rsETH",    18,       3400, 0.72e18, 0.78e18, 0.92e18);
        specs[8]  = AssetSpec("cbETH",    18,       3300, 0.72e18, 0.78e18, 0.92e18);
        specs[9]  = AssetSpec("rETH",     18,       3500, 0.72e18, 0.78e18, 0.92e18);
        specs[10] = AssetSpec("weETH",    18,       3400, 0.70e18, 0.76e18, 0.91e18);
        specs[11] = AssetSpec("ezETH",    18,       3350, 0.70e18, 0.76e18, 0.91e18);
        specs[12] = AssetSpec("cbBTC",     8,      65000, 0.70e18, 0.75e18, 0.90e18);
        specs[13] = AssetSpec("tBTC",     18,      65000, 0.68e18, 0.74e18, 0.90e18);
        specs[14] = AssetSpec("LINK",     18,         15, 0.65e18, 0.70e18, 0.88e18);
        specs[15] = AssetSpec("UNI",      18,          8, 0.60e18, 0.65e18, 0.85e18);
        specs[16] = AssetSpec("AAVE",     18,        100, 0.60e18, 0.65e18, 0.85e18);
        specs[17] = AssetSpec("LDO",      18,          2, 0.55e18, 0.62e18, 0.85e18);
        specs[18] = AssetSpec("CRV",      18,          1, 0.45e18, 0.55e18, 0.80e18);
        specs[19] = AssetSpec("MKR",      18,       2500, 0.60e18, 0.65e18, 0.85e18);
        specs[20] = AssetSpec("ARB",      18,          1, 0.55e18, 0.62e18, 0.85e18);
        specs[21] = AssetSpec("OP",       18,          2, 0.55e18, 0.62e18, 0.85e18);
        specs[22] = AssetSpec("GMX",      18,         40, 0.50e18, 0.58e18, 0.82e18);
        specs[23] = AssetSpec("USDe",     18,          1, 0.75e18, 0.82e18, 0.92e18);
        specs[24] = AssetSpec("sUSDe",    18,          1, 0.72e18, 0.80e18, 0.92e18);
    }
}
