import {
  CometHarnessInterfaceExtendedAssetList,
  CometProxyAdmin,
  Configurator,
  FaucetToken,
  NonStandardFaucetFeeToken,
  SimplePriceFeed,
} from 'build/types';
import { Contract } from 'ethers';
import {
  expect,
  exp,
  ethers,
  MAX_ASSETS,
  presentValue,
  mulPrice,
  mulFactor,
  BigNumber,
  makeConfigurator,
  SignerWithAddress,
  SnapshotRestorer,
  takeSnapshot
} from './helpers';

describe('isBorrowCollateralized', function () {
  // Constants
  const ONE_HOUR = 60 * 60;
  const baseTokenDecimals = 6;
  const collateralTokenDecimals = 18;
  // Configurator and protocol
  let comet: CometHarnessInterfaceExtendedAssetList;
  let configurator: Configurator;
  let configuratorProxyAddress: string;
  let proxyAdmin: CometProxyAdmin;
  // Tokens
  let baseSymbol: string;
  let baseToken: FaucetToken | NonStandardFaucetFeeToken;
  let collateralToken: FaucetToken | NonStandardFaucetFeeToken;
  // Price feeds
  let priceFeeds: Record<string, SimplePriceFeed>;
  // Users
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;
  let liquidityProvider: SignerWithAddress;

  let snapshot: SnapshotRestorer;

  before(async () => {
    const collaterals = Object.fromEntries(
      Array.from({ length: MAX_ASSETS }, (_, j) => [
        `ASSET${j}`,
        {
          decimals: collateralTokenDecimals,
          initialPrice: 200,
          borrowCF: exp(0.75, 18),
          liquidateCF: exp(0.8, 18),
        },
      ])
    );
    const protocol = await makeConfigurator({
      assets: {
        USDC: { decimals: baseTokenDecimals, initialPrice: 1 },
        ...collaterals,
      },
      baseTrackingBorrowSpeed: exp(1 / 86400, 15, 18), // 1 comp per day
      baseTrackingSupplySpeed: exp(1 / 86400, 15, 18), // 1 comp per day
    });
    const cometProxyAddress = protocol.cometProxy.address;
    comet = protocol.cometWithExtendedAssetList.attach(cometProxyAddress);
    configurator = protocol.configurator;
    configuratorProxyAddress = protocol.configuratorProxy.address;
    proxyAdmin = protocol.proxyAdmin;
    [alice, bob, charlie, liquidityProvider] = protocol.users;
    baseSymbol = protocol.base;
    baseToken = protocol.tokens[baseSymbol];
    collateralToken = protocol.tokens['ASSET0'];
    priceFeeds = protocol.priceFeeds;

    // Upgrade proxy to extended asset list implementation to support many assets
    const assetListFactory = protocol.assetListFactory;
    configurator = configurator.attach(configuratorProxyAddress);
    const CometExtAssetList = await (
      await ethers.getContractFactory('CometExtAssetList')
    ).deploy(
      {
        name32: ethers.utils.formatBytes32String('Test Comet'),
        symbol32: ethers.utils.formatBytes32String('Test Comet'),
      },
      assetListFactory.address
    );
    await CometExtAssetList.deployed();
    await configurator.setExtensionDelegate(
      cometProxyAddress,
      CometExtAssetList.address
    );
    const CometFactoryWithExtendedAssetList = await (
      await ethers.getContractFactory('CometFactoryWithExtendedAssetList')
    ).deploy();
    await CometFactoryWithExtendedAssetList.deployed();
    await configurator.setFactory(
      cometProxyAddress,
      CometFactoryWithExtendedAssetList.address
    );
    await proxyAdmin.deployAndUpgradeTo(configuratorProxyAddress, comet.address);
  });

  describe('empty market (no position)', function () {
    it('user principal should be >= 0', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.equal(0);
    });

    it('positive principal returns always true', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });

    it('wait and accrue state', async () => {
      // wait with empty comet for a while
      await ethers.provider.send('evm_increaseTime', [ONE_HOUR]); // 1 hr
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(alice.address);
    });

    it('time is not affecting on user with no position', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });
  });

  // Base token supply affects on user's principal , in case of supply
  // principal should be increased and should have positive impact on collateralized status (including accrue
  // and principal already >= 0 and time passed)
  describe('base token supply increases principal and affects positively on collateralized status, user remains collateralized', function () {
    const SUPPLY_AMOUNT: bigint = exp(1000, baseTokenDecimals);

    before(async () => {
      // Allocate tokens to alice
      await baseToken.allocateTo(alice.address, SUPPLY_AMOUNT);
    });

    it('sanity check: user principal should be zero', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.eq(0);
    });

    it('user perform supply operation', async () => {
      await baseToken.connect(alice).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(alice).supply(baseToken.address, SUPPLY_AMOUNT);
    });

    it('user principal increased by supply amount', async () => {
      expect((await comet.userBasic(alice.address)).principal).to.eq(
        SUPPLY_AMOUNT
      );
    });

    it('wait and accrue state', async () => {
      // wait with empty comet for a while
      await ethers.provider.send('evm_increaseTime', [ONE_HOUR]); // 1 hr
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(alice.address);
    });

    it('user remains collateralized', async () => {
      expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
    });
  });

  // Collateral token supply does not affect user's principal, it only increases
  // collateral balance and should have positive impact on collateralized status
  describe('collateral supply does not affect principal, user remains collateralized', function () {
    const SUPPLY_COLLATERAL_AMOUNT: bigint = exp(1, collateralTokenDecimals);
    let principalBefore: BigNumber;

    before(async () => {
      await collateralToken.allocateTo(bob.address, SUPPLY_COLLATERAL_AMOUNT);
      principalBefore = (await comet.userBasic(bob.address)).principal;
    });

    it('sanity check: user principal should be zero', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.eq(0);
    });

    it('collateral balance before should be zero', async () => {
      expect(
        (await comet.userCollateral(bob.address, collateralToken.address))
          .balance
      ).to.eq(0);
    });

    it('comet collateral token balance should be zero', async () => {
      expect(await collateralToken.balanceOf(comet.address)).to.eq(0);
    });

    it('user perform supply collateral operation', async () => {
      await collateralToken
        .connect(bob)
        .approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
      await comet
        .connect(bob)
        .supply(collateralToken.address, SUPPLY_COLLATERAL_AMOUNT);
    });

    it('wait and accrue state', async () => {
      // wait with empty comet for a while
      await ethers.provider.send('evm_increaseTime', [ONE_HOUR]); // 1 hr
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(bob.address);
    });

    it('user principal should not change after collateral supply', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.eq(
        principalBefore
      );
    });

    it('collateral balance after equals supply amount', async () => {
      expect(
        (await comet.userCollateral(bob.address, collateralToken.address))
          .balance
      ).to.eq(SUPPLY_COLLATERAL_AMOUNT);
    });

    it('comet collateral token balance equals supply amount', async () => {
      expect(await collateralToken.balanceOf(comet.address)).to.eq(
        SUPPLY_COLLATERAL_AMOUNT
      );
    });

    it('users borrow balance should be zero', async () => {
      expect(await comet.borrowBalanceOf(bob.address)).to.eq(0);
    });

    it('user remains collateralized', async () => {
      expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
    });
  });

  describe('transfers: isBorrowCollateralized impact on transfer functions', function () {
    before(async () => {
      snapshot = await takeSnapshot();
    });
    describe('transferBase', function () {
      describe('revert when', function () {
        // Alice has 1000 USDC supply but no collateral
        // Transferring 1100 USDC creates a 100 USDC borrow with nothing to back it
        describe('sender has no collateral to back the borrow', function () {
          const TRANSFER_AMOUNT = exp(1100, baseTokenDecimals);

          let aliceBalance: BigNumber;
          let aliceCollateralBalance: BigNumber;
          let basePrice: BigNumber;
          let baseScale: BigNumber;

          before(async () => {
            aliceBalance = await comet.balanceOf(alice.address);
            aliceCollateralBalance = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            baseScale = await comet.baseScale();
          });

          it('alice has base token balance from previous supply', async () => {
            expect(aliceBalance).to.eq(exp(1000, baseTokenDecimals));
          });

          it('alice has no collateral', async () => {
            expect(aliceCollateralBalance).to.eq(0);
          });

          it('transfer creates a borrow with value exceeding zero collateral capacity', async () => {
            // After transfer: balance = 1000e6 - 1100e6 = -100e6 (borrow of 100 USDC)
            const borrowAmount = TRANSFER_AMOUNT - aliceBalance.toBigInt();
            // borrowValue = borrowAmount * basePrice / baseScale = 100e6 * 1e8 / 1e6 = 100e8
            const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
            // Alice has 0 collateral → weighted collateral = 0
            // borrowValue (100e8) > 0 → liquidity negative → NotCollateralized
            expect(borrowValue).to.be.gt(0);
          });

          it('transferBase reverts with NotCollateralized', async () => {
            await expect(
              comet.connect(alice).transfer(bob.address, TRANSFER_AMOUNT)
            ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
          });
        });

        // Alice has 1000 USDC supply + 1 ASSET0 collateral (weighted capacity = $150)
        // Transfer 1200 USDC → borrow = $200 > $150 weighted collateral
        describe('collaterals is insufficient to cover the borrow', function () {
          const SUPPLY_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
          const TRANSFER_AMOUNT = exp(1200, baseTokenDecimals);

          let aliceCollateralBalance: BigNumber;

          before(async () => {
            await collateralToken.allocateTo(
              alice.address,
              SUPPLY_COLLATERAL_AMOUNT
            );
            await collateralToken
              .connect(alice)
              .approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
            await comet
              .connect(alice)
              .supply(collateralToken.address, SUPPLY_COLLATERAL_AMOUNT);

            aliceCollateralBalance = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
          });

          it('alice has USDC balance from previous supply', async () => {
            expect(await comet.balanceOf(alice.address)).to.eq(
              exp(1000, baseTokenDecimals)
            );
          });

          it('alice has 1 ASSET0 as collateral', async () => {
            expect(aliceCollateralBalance).to.eq(SUPPLY_COLLATERAL_AMOUNT);
          });

          it('simulated post-transfer liquidity is negative, proving NotCollateralized', async () => {
            const principal = (
              await comet.userBasic(alice.address)
            ).principal.sub(TRANSFER_AMOUNT);
            const totalsBasic = await comet.totalsBasic();
            const balanceAfterTransfer = presentValue(
              principal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(
              await comet.baseTokenPriceFeed()
            );
            const baseScale = await comet.baseScale();

            // debtUSD = balanceAfterTransfer * basePrice / baseScale (negative)
            // = -200e6 * 1e8 / 1e6 = -200e8
            const debtUSD = mulPrice(
              balanceAfterTransfer,
              basePrice,
              baseScale
            );

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);

            // collateralUSD = 1e18 * 200e8 / 1e18 = 200e8
            const collateralUSD = mulPrice(
              aliceCollateralBalance.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 200e8 * 0.75e18 / 1e18 = 150e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = debtUSD (negative) + weightedCollateral (positive)
            // = -200e8 + 150e8 = -50e8 < 0 → NotCollateralized
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.lessThan(0n);
          });

          it('transferBase reverts with NotCollateralized', async () => {
            await expect(
              comet.connect(alice).transfer(bob.address, TRANSFER_AMOUNT)
            ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
          });
        });
      });

      describe('success when', function () {
        // Current state:
        // - Alice has 1000 USDC supply + 1 ASSET0 collateral (weighted capacity = $150)
        // - Bob has 1 ASSET0 collateral
        // New state:
        // - Alice transfers 1100 USDC → borrow = $100 < $150 weighted collateral
        // - Alice remains collateralized and has borrow position
        describe('sender has collateral to back the borrow', function () {
          const TRANSFER_AMOUNT = exp(1100, baseTokenDecimals);
          const EXPECTED_BORROW_AMOUNT = exp(100, baseTokenDecimals);

          let alicePrincipalBefore: BigNumber;
          let aliceCollateralBalance: BigNumber;
          let bobBaseBalanceBefore: BigNumber;
          let basePrice: BigNumber;
          let baseScale: BigNumber;

          before(async () => {
            alicePrincipalBefore = (await comet.userBasic(alice.address))
              .principal;
            aliceCollateralBalance = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            bobBaseBalanceBefore = await comet.balanceOf(bob.address);
            basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            baseScale = await comet.baseScale();
          });

          it('alice transfers 1100 USDC and opens a borrow-backed transfer', async () => {
            await expect(
              comet.connect(alice).transfer(bob.address, TRANSFER_AMOUNT)
            ).to.not.be.reverted;
          });

          it('alice principal before transfer was 1000 USDC supply', async () => {
            expect(alicePrincipalBefore).to.eq(exp(1000, baseTokenDecimals));
          });

          it('alice principal after transfer is negative (borrower state)', async () => {
            expect(
              (await comet.userBasic(alice.address)).principal
            ).to.be.approximately(-EXPECTED_BORROW_AMOUNT, exp(1, 3)); // possible small difference due to rounding errors
          });

          it('alice borrow balance after transfer equals 100 USDC', async () => {
            expect(await comet.borrowBalanceOf(alice.address)).to.eq(EXPECTED_BORROW_AMOUNT);
          });

          it('bob base balance increases by 1100 USDC', async () => {
            const bobBaseBalanceAfter = await comet.balanceOf(bob.address);
            expect(bobBaseBalanceAfter.sub(bobBaseBalanceBefore)).to.eq(TRANSFER_AMOUNT);
          });

          it('alice remains borrow-collateralized after transfer', async () => {
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
          });

          it('manual liquidity proof after transfer is positive', async () => {
            const alicePrincipalAfter = (await comet.userBasic(alice.address))
              .principal;
            const totalsBasic = await comet.totalsBasic();
            const balanceAfterTransfer = presentValue(
              alicePrincipalAfter.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            // debtUSD = -100e6 * 1e8 / 1e6 = -100e8
            const debtUSD = mulPrice(
              balanceAfterTransfer,
              basePrice,
              baseScale
            );

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);

            // collateralUSD = 1e18 * 200e8 / 1e18 = 200e8
            const collateralUSD = mulPrice(
              aliceCollateralBalance.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 200e8 * 0.75e18 / 1e18 = 150e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = -100e8 + 150e8 = +50e8 > 0 → collateralized
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
          });
        });
      });
    });

    describe('transferCollateral', function () {
      describe('revert when', function () {
        // Current state:
        // - Alice has active borrow position (~100 USDC) and 1 ASSET0 collateral
        // - Bob already has 1 ASSET0 collateral from previous flow
        // Simulated new state if transfer were allowed:
        // - Alice transfers 1 ASSET0 to Bob -> Alice collateral: 1 -> 0, Bob collateral: 1 -> 2
        // - Alice weighted collateral becomes 0 while debt remains > 0, so liquidity is negative
        // - transferCollateral must revert with NotCollateralized and balances stay unchanged
        describe('sender transfers away collateral required for current borrow', function () {
          const TRANSFER_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);

          let alicePrincipalBefore: BigNumber;
          let aliceBorrowBalanceBefore: BigNumber;
          let aliceCollateralBalanceBefore: BigNumber;
          let bobCollateralBalanceBefore: BigNumber;
          let basePrice: BigNumber;
          let baseScale: BigNumber;

          before(async () => {
            alicePrincipalBefore = (await comet.userBasic(alice.address))
              .principal;

            aliceBorrowBalanceBefore = await comet.borrowBalanceOf(
              alice.address
            );

            aliceCollateralBalanceBefore = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;

            bobCollateralBalanceBefore = (
              await comet.userCollateral(bob.address, collateralToken.address)
            ).balance;

            basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            baseScale = await comet.baseScale();
          });

          it('alice is currently in borrower state', async () => {
            expect(alicePrincipalBefore).to.be.lessThan(0);
          });

          it('alice has outstanding borrow before collateral transfer', async () => {
            expect(aliceBorrowBalanceBefore).to.be.greaterThan(0);
          });

          it('alice has 1 ASSET0 collateral before transfer', async () => {
            expect(aliceCollateralBalanceBefore).to.eq(
              TRANSFER_COLLATERAL_AMOUNT
            );
          });

          it('alice transferCollateral to bob reverts with NotCollateralized', async () => {
            await expect(
              comet
                .connect(alice)
                .transferAsset(
                  bob.address,
                  collateralToken.address,
                  TRANSFER_COLLATERAL_AMOUNT
                )
            ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
          });

          it('alice collateral remains unchanged after revert', async () => {
            expect(
              (
                await comet.userCollateral(alice.address, collateralToken.address)
              ).balance
            ).to.eq(aliceCollateralBalanceBefore);
          });

          it('bob collateral remains unchanged after revert', async () => {
            expect(
              (
                await comet.userCollateral(bob.address, collateralToken.address)
              ).balance
            ).to.eq(bobCollateralBalanceBefore);
          });

          it('manual post-transfer simulation shows negative liquidity', async () => {
            const totalsBasic = await comet.totalsBasic();
            const baseBalance = presentValue(
              alicePrincipalBefore.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            // debtUSD remains negative from existing borrow position
            const debtUSD = mulPrice(baseBalance, basePrice, baseScale);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateralAfterTransfer =
                aliceCollateralBalanceBefore.toBigInt() -
                TRANSFER_COLLATERAL_AMOUNT;

            // after transfer all collateral is removed -> weighted collateral = 0
            const collateralUSD = mulPrice(
              collateralAfterTransfer,
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.lessThan(0n);
          });
        }
        );
      });

      describe('success when', function () {
        // Current state:
        // - Alice has active borrow position (~100 USDC) and 1 ASSET0 collateral
        // - Bob has 1 ASSET0 collateral
        // New state:
        // - Alice supplies +1 ASSET0 -> collateral becomes 2 ASSET0
        // - Alice transfers 0.25 ASSET0 ($50 at $200/ASSET0) to Bob
        // - Alice collateral becomes 1.75 ASSET0 and remains borrow-collateralized
        describe('sender keeps enough collateral after transfer', function () {
          const ADDITIONAL_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
          const TRANSFER_COLLATERAL_AMOUNT = exp(25, 16); // 0.25 ASSET0

          let alicePrincipalBefore: BigNumber;
          let aliceCollateralBeforeSupply: BigNumber;
          let bobCollateralBeforeTransfer: BigNumber;
          let basePrice: BigNumber;
          let baseScale: BigNumber;

          before(async () => {
            alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
            aliceCollateralBeforeSupply = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            bobCollateralBeforeTransfer = (
              await comet.userCollateral(bob.address, collateralToken.address)
            ).balance;
            basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            baseScale = await comet.baseScale();
          });

          it('alice has borrow position before adding collateral', async () => {
            expect(alicePrincipalBefore).to.be.lessThan(0);
          });

          it('alice has 1 ASSET0 before additional supply', async () => {
            expect(aliceCollateralBeforeSupply).to.eq(exp(1, collateralTokenDecimals));
          });

          it('alice supplies 1 additional ASSET0 collateral', async () => {
            await collateralToken.allocateTo(alice.address, ADDITIONAL_COLLATERAL_AMOUNT);
            await collateralToken.connect(alice).approve(comet.address, ADDITIONAL_COLLATERAL_AMOUNT);
            await comet.connect(alice).supply(collateralToken.address, ADDITIONAL_COLLATERAL_AMOUNT);
          });

          it('alice collateral becomes 2 ASSET0 after supply', async () => {
            expect(
              (await comet.userCollateral(alice.address, collateralToken.address)).balance
            ).to.eq(aliceCollateralBeforeSupply.add(ADDITIONAL_COLLATERAL_AMOUNT));
          });

          it('alice transfers 0.25 ASSET0 collateral to bob', async () => {
            await expect(
              comet
                .connect(alice)
                .transferAsset(
                  bob.address,
                  collateralToken.address,
                  TRANSFER_COLLATERAL_AMOUNT
                )
            ).to.not.be.reverted;
          });

          it('alice collateral after transfer is 1.75 ASSET0', async () => {
            const aliceCollateralAfter = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            expect(aliceCollateralAfter).to.eq(
              aliceCollateralBeforeSupply
                .add(ADDITIONAL_COLLATERAL_AMOUNT)
                .sub(TRANSFER_COLLATERAL_AMOUNT)
            );
          });

          it('bob collateral increases by 0.25 ASSET0', async () => {
            const bobCollateralAfter = (
              await comet.userCollateral(bob.address, collateralToken.address)
            ).balance;
            expect(bobCollateralAfter.sub(bobCollateralBeforeTransfer)).to.eq(
              TRANSFER_COLLATERAL_AMOUNT
            );
          });

          it('alice remains borrow-collateralized after collateral transfer', async () => {
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
          });

          it('manual liquidity proof after transfer is positive', async () => {
            const alicePrincipalAfter = (await comet.userBasic(alice.address)).principal;
            const aliceCollateralAfter = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            const totalsBasic = await comet.totalsBasic();
            const baseBalance = presentValue(
              alicePrincipalAfter.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const debtUSD = mulPrice(baseBalance, basePrice, baseScale);
            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateralUSD = mulPrice(
              aliceCollateralAfter.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // 1.75 ASSET0 * $200 = $350; weighted at 0.75 => $262.5
            // debt is ~ $100, so liquidity stays positive
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
          });
        });
      });
    });
  });

  describe('price feed impact', function () {
    let priceFeedSnapshot: SnapshotRestorer;
    let collateralOnly: SignerWithAddress;

    before(async () => {
      priceFeedSnapshot = await takeSnapshot();

      const signers = await ethers.getSigners();

      // Set up collateral-only user (signers[5]): 1 ASSET0, no base supply/borrow
      collateralOnly = signers[5];
      const collateralAmount = exp(1, collateralTokenDecimals);
      await collateralToken.allocateTo(collateralOnly.address, collateralAmount);
      await collateralToken.connect(collateralOnly).approve(comet.address, collateralAmount);
      await comet.connect(collateralOnly).supply(collateralToken.address, collateralAmount);

      // Tighten Alice's position so realistic price changes (~10-20%) flip collateralization.
      // Current state: ~100 USDC borrow, 1.75 ASSET0 collateral (weighted capacity = $262.50).
      // After additional borrow of 140 USDC: ~240 USDC borrow → utilization ~91%.
      const additionalBorrow = exp(140, baseTokenDecimals);
      const liquidityProvider = signers[4];
      const liquidity = exp(10000, baseTokenDecimals);
      await baseToken.allocateTo(liquidityProvider.address, liquidity);
      await baseToken.connect(liquidityProvider).approve(comet.address, liquidity);
      await comet.connect(liquidityProvider).supply(baseToken.address, liquidity);
      await comet.connect(alice).withdraw(baseToken.address, additionalBorrow);
    });

    after(async () => {
      await priceFeedSnapshot.restore();
    });

    describe('revert when', function () {
      describe('base price feed returns zero price', function () {
        let basePriceFeed: SimplePriceFeed;
        let basePriceBefore: BigNumber;

        before(async () => {
          basePriceFeed = priceFeeds[baseSymbol];
          basePriceBefore = await comet.getPrice(await comet.baseTokenPriceFeed());
          await basePriceFeed.setRoundData(1, 0, 1, 1, 1);
        });

        after(async () => {
          await basePriceFeed.setRoundData(1, basePriceBefore, 1, 1, 1);
        });

        it('isBorrowCollateralized reverts with BadPrice', async () => {
          await expect(
            comet.isBorrowCollateralized(alice.address)
          ).to.be.revertedWithCustomError(comet, 'BadPrice');
        });
      });

      describe('collateral price feed returns zero price', function () {
        let collateralPriceFeed: SimplePriceFeed;
        let collateralPriceBefore: BigNumber;

        before(async () => {
          collateralPriceFeed = priceFeeds['ASSET0'];
          collateralPriceBefore = await comet.getPrice(collateralPriceFeed.address);
          await collateralPriceFeed.setRoundData(1, 0, 1, 1, 1);
        });

        after(async () => {
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore, 1, 1, 1);
        });

        it('isBorrowCollateralized reverts with BadPrice', async () => {
          await expect(
            comet.isBorrowCollateralized(alice.address)
          ).to.be.revertedWithCustomError(comet, 'BadPrice');
        });
      });

      describe('base price feed is replaced with broken feed via configurator upgrade', function () {
        let brokenBasePriceFeed: Contract;
        let oldBasePriceFeed: string;
        let configuratorAsProxy: Configurator;

        before(async () => {
          configuratorAsProxy = configurator.attach(configuratorProxyAddress);
          oldBasePriceFeed = await comet.baseTokenPriceFeed();
          brokenBasePriceFeed = await (
            await ethers.getContractFactory('PriceFeedWithRevert')
          ).deploy(exp(1, 8), 8);
          await brokenBasePriceFeed.deployed();

          await configuratorAsProxy.setBaseTokenPriceFeed(
            comet.address,
            brokenBasePriceFeed.address
          );
          await proxyAdmin.deployAndUpgradeTo(
            configuratorProxyAddress,
            comet.address
          );
          expect(await comet.baseTokenPriceFeed()).to.eq(brokenBasePriceFeed.address);
        });

        after(async () => {
          await configuratorAsProxy.setBaseTokenPriceFeed(
            comet.address,
            oldBasePriceFeed
          );
          await proxyAdmin.deployAndUpgradeTo(
            configuratorProxyAddress,
            comet.address
          );
        });

        it('isBorrowCollateralized reverts with Reverted from price feed', async () => {
          await expect(
            comet.isBorrowCollateralized(alice.address)
          ).to.be.revertedWithCustomError(brokenBasePriceFeed, 'Reverted');
        });
      });

      describe('collateral price feed is replaced with broken feed via configurator upgrade', function () {
        let brokenCollateralPriceFeed: Contract;
        let oldCollateralPriceFeed: string;
        let configuratorAsProxy: Configurator;

        before(async () => {
          configuratorAsProxy = configurator.attach(configuratorProxyAddress);
          oldCollateralPriceFeed = (await comet.getAssetInfo(0)).priceFeed;
          brokenCollateralPriceFeed = await (
            await ethers.getContractFactory('PriceFeedWithRevert')
          ).deploy(exp(1, 8), 8);
          await brokenCollateralPriceFeed.deployed();

          await configuratorAsProxy.updateAssetPriceFeed(
            comet.address,
            collateralToken.address,
            brokenCollateralPriceFeed.address
          );
          await proxyAdmin.deployAndUpgradeTo(
            configuratorProxyAddress,
            comet.address
          );
          expect((await comet.getAssetInfo(0)).priceFeed).to.eq(brokenCollateralPriceFeed.address);
        });

        after(async () => {
          await configuratorAsProxy.updateAssetPriceFeed(
            comet.address,
            collateralToken.address,
            oldCollateralPriceFeed
          );
          await proxyAdmin.deployAndUpgradeTo(
            configuratorProxyAddress,
            comet.address
          );
        });

        it('isBorrowCollateralized reverts with Reverted from price feed', async () => {
          await expect(
            comet.isBorrowCollateralized(alice.address)
          ).to.be.revertedWithCustomError(brokenCollateralPriceFeed, 'Reverted');
        });
      });
    });

    describe('base price change', function () {
      // Current state (after tightening in parent before):
      // - Alice (borrower): ~240 USDC borrow, 1.75 ASSET0 collateral (weighted = $262.50)
      // - Bob (lender): ~1100 USDC supply, 1.25 ASSET0 collateral, no borrow
      // - collateralOnly: 0 base position, 1 ASSET0 collateral
      it('confirm initial state is collateralized for all users', async () => {
        expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
        expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
        expect(await comet.isBorrowCollateralized(collateralOnly.address)).to.be.true;
      });

      describe('base price increases by 15%', function () {
        let basePriceFeed: SimplePriceFeed;
        let basePriceBefore: BigNumber;

        before(async () => {
          basePriceFeed = priceFeeds[baseSymbol];
          basePriceBefore = await comet.getPrice(await comet.baseTokenPriceFeed());
          await basePriceFeed.setRoundData(1, basePriceBefore.mul(115).div(100), 1, 1, 1);
        });

        after(async () => {
          await basePriceFeed.setRoundData(1, basePriceBefore, 1, 1, 1);
        });

        describe('borrower (Alice): ~240 USDC borrow + 1.75 ASSET0', function () {
          it('becomes undercollateralized', async () => {
            const alicePrincipal = (await comet.userBasic(alice.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const aliceBalance = presentValue(
              alicePrincipal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // debtUSD = ~-240e6 * 1.15e8 / 1e6 = ~-276e8 (negative, borrower)
            const debtUSD = mulPrice(aliceBalance, basePrice, baseScale);
            expect(debtUSD).to.be.lessThan(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const aliceCollateral = (await comet.userCollateral(alice.address, collateralToken.address)).balance;

            // collateralUSD = 1.75e18 * 200e8 / 1e18 = 350e8
            const collateralUSD = mulPrice(
              aliceCollateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 350e8 * 0.75e18 / 1e18 = 262.5e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = ~-276e8 + 262.5e8 = ~-13.5e8 < 0 → undercollateralized
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.lessThan(0n);
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
          });
        });

        describe('lender without borrowing (Bob): ~1100 USDC supply + 1.25 ASSET0', function () {
          it('stays collateralized', async () => {
            const bobPrincipal = (await comet.userBasic(bob.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const bobBalance = presentValue(
              bobPrincipal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // supplyUSD = ~1100e6 * 1.15e8 / 1e6 = ~1265e8 (positive, lender)
            const supplyUSD = mulPrice(bobBalance, basePrice, baseScale);
            expect(supplyUSD).to.be.greaterThan(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const bobCollateral = (await comet.userCollateral(bob.address, collateralToken.address)).balance;

            // collateralUSD = 1.25e18 * 200e8 / 1e18 = 250e8 (collateral price unchanged)
            const collateralUSD = mulPrice(
              bobCollateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 250e8 * 0.75e18 / 1e18 = 187.5e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = ~1265e8 + 187.5e8 > 0 → collateralized (positive principal, no borrow)
            const liquidity = supplyUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
          });
        });

        describe('collateral-only user: 1 ASSET0, no base position', function () {
          it('stays collateralized', async () => {
            const principal = (await comet.userBasic(collateralOnly.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const balance = presentValue(
              principal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // baseUSD = 0 * 1.15e8 / 1e6 = 0 (no base position at all)
            const baseUSD = mulPrice(balance, basePrice, baseScale);
            expect(baseUSD).to.eq(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateral = (await comet.userCollateral(collateralOnly.address, collateralToken.address)).balance;

            // collateralUSD = 1e18 * 200e8 / 1e18 = 200e8 (collateral price unchanged)
            const collateralUSD = mulPrice(
              collateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 200e8 * 0.75e18 / 1e18 = 150e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = 0 + 150e8 = 150e8 > 0 → collateralized (no base exposure)
            const liquidity = baseUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(collateralOnly.address)).to.be.true;
          });
        });
      });

      describe('base price decreases by 10%', function () {
        let basePriceFeed: SimplePriceFeed;
        let basePriceBefore: BigNumber;

        before(async () => {
          basePriceFeed = priceFeeds[baseSymbol];
          basePriceBefore = await comet.getPrice(await comet.baseTokenPriceFeed());
          await basePriceFeed.setRoundData(1, basePriceBefore.mul(90).div(100), 1, 1, 1);
        });

        after(async () => {
          await basePriceFeed.setRoundData(1, basePriceBefore, 1, 1, 1);
        });

        describe('borrower (Alice): ~240 USDC borrow + 1.75 ASSET0', function () {
          it('stays collateralized', async () => {
            const alicePrincipal = (await comet.userBasic(alice.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const aliceBalance = presentValue(
              alicePrincipal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // debtUSD = ~-240e6 * 0.9e8 / 1e6 = ~-216e8 (negative, borrower)
            const debtUSD = mulPrice(aliceBalance, basePrice, baseScale);
            expect(debtUSD).to.be.lessThan(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const aliceCollateral = (await comet.userCollateral(alice.address, collateralToken.address)).balance;

            // collateralUSD = 1.75e18 * 200e8 / 1e18 = 350e8
            const collateralUSD = mulPrice(
              aliceCollateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 350e8 * 0.75e18 / 1e18 = 262.5e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = ~-216e8 + 262.5e8 = ~46.5e8 > 0 → stays collateralized
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
          });
        });

        describe('lender without borrowing (Bob): ~1100 USDC supply + 1.25 ASSET0', function () {
          it('stays collateralized', async () => {
            const bobPrincipal = (await comet.userBasic(bob.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const bobBalance = presentValue(
              bobPrincipal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // supplyUSD = ~1100e6 * 0.9e8 / 1e6 = ~990e8 (positive, lender)
            const supplyUSD = mulPrice(bobBalance, basePrice, baseScale);
            expect(supplyUSD).to.be.greaterThan(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const bobCollateral = (await comet.userCollateral(bob.address, collateralToken.address)).balance;

            // collateralUSD = 1.25e18 * 200e8 / 1e18 = 250e8 (collateral price unchanged)
            const collateralUSD = mulPrice(
              bobCollateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 250e8 * 0.75e18 / 1e18 = 187.5e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = ~990e8 + 187.5e8 > 0 → collateralized (positive principal, no borrow)
            const liquidity = supplyUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
          });
        });

        describe('collateral-only user: 1 ASSET0, no base position', function () {
          it('stays collateralized', async () => {
            const principal = (await comet.userBasic(collateralOnly.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const balance = presentValue(
              principal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // baseUSD = 0 * 0.9e8 / 1e6 = 0 (no base position at all)
            const baseUSD = mulPrice(balance, basePrice, baseScale);
            expect(baseUSD).to.eq(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateral = (await comet.userCollateral(collateralOnly.address, collateralToken.address)).balance;

            // collateralUSD = 1e18 * 200e8 / 1e18 = 200e8 (collateral price unchanged)
            const collateralUSD = mulPrice(
              collateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 200e8 * 0.75e18 / 1e18 = 150e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = 0 + 150e8 = 150e8 > 0 → collateralized (no base exposure)
            const liquidity = baseUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(collateralOnly.address)).to.be.true;
          });
        });
      });
    });

    describe('collateral price change', function () {
      describe('collateral price increases by 15%', function () {
        let collateralPriceFeed: SimplePriceFeed;
        let collateralPriceBefore: BigNumber;

        before(async () => {
          collateralPriceFeed = priceFeeds['ASSET0'];
          collateralPriceBefore = await comet.getPrice(collateralPriceFeed.address);
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore.mul(115).div(100), 1, 1, 1);
        });

        after(async () => {
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore, 1, 1, 1);
        });

        describe('borrower (Alice): ~240 USDC borrow + 1.75 ASSET0', function () {
          it('stays collateralized', async () => {
            const alicePrincipal = (await comet.userBasic(alice.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const aliceBalance = presentValue(
              alicePrincipal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // debtUSD = ~-240e6 * 1e8 / 1e6 = ~-240e8 (negative, borrower, base price unchanged)
            const debtUSD = mulPrice(aliceBalance, basePrice, baseScale);
            expect(debtUSD).to.be.lessThan(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const aliceCollateral = (await comet.userCollateral(alice.address, collateralToken.address)).balance;

            // collateralUSD = 1.75e18 * 230e8 / 1e18 = 402.5e8 (+15% from $200)
            const collateralUSD = mulPrice(
              aliceCollateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 402.5e8 * 0.75e18 / 1e18 = 301.875e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = ~-240e8 + 301.875e8 = ~61.875e8 > 0 → stays collateralized
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
          });
        });

        describe('lender without borrowing (Bob): ~1100 USDC supply + 1.25 ASSET0', function () {
          it('stays collateralized', async () => {
            const bobPrincipal = (await comet.userBasic(bob.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const bobBalance = presentValue(
              bobPrincipal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // supplyUSD = ~1100e6 * 1e8 / 1e6 = ~1100e8 (positive, base price unchanged)
            const supplyUSD = mulPrice(bobBalance, basePrice, baseScale);
            expect(supplyUSD).to.be.greaterThan(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const bobCollateral = (await comet.userCollateral(bob.address, collateralToken.address)).balance;

            // collateralUSD = 1.25e18 * 230e8 / 1e18 = 287.5e8 (+15% from $200)
            const collateralUSD = mulPrice(
              bobCollateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 287.5e8 * 0.75e18 / 1e18 = 215.625e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = ~1100e8 + 215.625e8 > 0 → collateralized (positive principal, no borrow)
            const liquidity = supplyUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
          });
        });

        describe('collateral-only user: 1 ASSET0, no base position', function () {
          it('stays collateralized', async () => {
            const principal = (await comet.userBasic(collateralOnly.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const balance = presentValue(
              principal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // baseUSD = 0 * 1e8 / 1e6 = 0 (no base position)
            const baseUSD = mulPrice(balance, basePrice, baseScale);
            expect(baseUSD).to.eq(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateral = (await comet.userCollateral(collateralOnly.address, collateralToken.address)).balance;

            // collateralUSD = 1e18 * 230e8 / 1e18 = 230e8 (+15% from $200)
            const collateralUSD = mulPrice(
              collateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 230e8 * 0.75e18 / 1e18 = 172.5e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = 0 + 172.5e8 = 172.5e8 > 0 → collateralized (no borrow)
            const liquidity = baseUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(collateralOnly.address)).to.be.true;
          });
        });
      });

      describe('collateral price decreases by 20%', function () {
        let collateralPriceFeed: SimplePriceFeed;
        let collateralPriceBefore: BigNumber;

        before(async () => {
          collateralPriceFeed = priceFeeds['ASSET0'];
          collateralPriceBefore = await comet.getPrice(collateralPriceFeed.address);
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore.mul(80).div(100), 1, 1, 1);
        });

        after(async () => {
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore, 1, 1, 1);
        });

        describe('borrower (Alice): ~240 USDC borrow + 1.75 ASSET0', function () {
          it('becomes undercollateralized', async () => {
            const alicePrincipal = (await comet.userBasic(alice.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const aliceBalance = presentValue(
              alicePrincipal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // debtUSD = ~-240e6 * 1e8 / 1e6 = ~-240e8 (negative, borrower, base price unchanged)
            const debtUSD = mulPrice(aliceBalance, basePrice, baseScale);
            expect(debtUSD).to.be.lessThan(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const aliceCollateral = (await comet.userCollateral(alice.address, collateralToken.address)).balance;

            // collateralUSD = 1.75e18 * 160e8 / 1e18 = 280e8 (-20% from $200)
            const collateralUSD = mulPrice(
              aliceCollateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 280e8 * 0.75e18 / 1e18 = 210e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = ~-240e8 + 210e8 = ~-30e8 < 0 → undercollateralized
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.lessThan(0n);
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
          });
        });

        describe('lender without borrowing (Bob): ~1100 USDC supply + 1.25 ASSET0', function () {
          it('stays collateralized', async () => {
            const bobPrincipal = (await comet.userBasic(bob.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const bobBalance = presentValue(
              bobPrincipal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // supplyUSD = ~1100e6 * 1e8 / 1e6 = ~1100e8 (positive, base price unchanged)
            const supplyUSD = mulPrice(bobBalance, basePrice, baseScale);
            expect(supplyUSD).to.be.greaterThan(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const bobCollateral = (await comet.userCollateral(bob.address, collateralToken.address)).balance;

            // collateralUSD = 1.25e18 * 160e8 / 1e18 = 200e8 (-20% from $200)
            const collateralUSD = mulPrice(
              bobCollateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 200e8 * 0.75e18 / 1e18 = 150e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = ~1100e8 + 150e8 > 0 → collateralized (positive principal, no borrow)
            const liquidity = supplyUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
          });
        });

        describe('collateral-only user: 1 ASSET0, no base position', function () {
          it('stays collateralized', async () => {
            const principal = (await comet.userBasic(collateralOnly.address)).principal;
            const totalsBasic = await comet.totalsBasic();
            const balance = presentValue(
              principal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            const baseScale = await comet.baseScale();

            // baseUSD = 0 * 1e8 / 1e6 = 0 (no base position)
            const baseUSD = mulPrice(balance, basePrice, baseScale);
            expect(baseUSD).to.eq(0n);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateral = (await comet.userCollateral(collateralOnly.address, collateralToken.address)).balance;

            // collateralUSD = 1e18 * 160e8 / 1e18 = 160e8 (-20% from $200)
            const collateralUSD = mulPrice(
              collateral.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 160e8 * 0.75e18 / 1e18 = 120e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = 0 + 120e8 = 120e8 > 0 → collateralized (no borrow)
            const liquidity = baseUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
            expect(await comet.isBorrowCollateralized(collateralOnly.address)).to.be.true;
          });
        });
      });
    });
  });

  describe('withdraw: isBorrowCollateralized impact on withdraw function', function () {
    // Reset to pre-transfer state
    before(async () => {
      await snapshot.restore();
    });

    describe('withdraw base', function () {
      describe('revert when', function () {
        // Alice has 1000 USDC supply but no collateral
        // Withdrawing 1100 USDC creates a 100 USDC borrow with nothing to back it
        describe('sender has no collateral to back the borrow', function () {
          const WITHDRAW_AMOUNT = exp(1100, baseTokenDecimals);

          let aliceBalance: BigNumber;
          let aliceCollateralBalance: BigNumber;
          let basePrice: BigNumber;
          let baseScale: BigNumber;

          before(async () => {
            aliceBalance = await comet.balanceOf(alice.address);
            aliceCollateralBalance = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            baseScale = await comet.baseScale();
          });

          it('alice has base token balance from previous supply', async () => {
            expect(aliceBalance).to.eq(exp(1000, baseTokenDecimals));
          });

          it('alice has no collateral', async () => {
            expect(aliceCollateralBalance).to.eq(0);
          });

          it('withdraw creates a borrow with value exceeding zero collateral capacity', async () => {
            // After withdraw: balance = 1000e6 - 1100e6 = -100e6 (borrow of 100 USDC)
            const borrowAmount = WITHDRAW_AMOUNT - aliceBalance.toBigInt();
            // borrowValue = borrowAmount * basePrice / baseScale = 100e6 * 1e8 / 1e6 = 100e8
            const borrowValue = mulPrice(borrowAmount, basePrice, baseScale);
            // Alice has 0 collateral → weighted collateral = 0
            // borrowValue (100e8) > 0 → liquidity negative → NotCollateralized
            expect(borrowValue).to.be.gt(0);
          });

          it('withdrawing base asset reverts with NotCollateralized', async () => {
            await expect(
              comet.connect(alice).withdraw(baseToken.address, WITHDRAW_AMOUNT)
            ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
          });
        });

        // Alice has 1000 USDC supply + 1 ASSET0 collateral (weighted capacity = $150)
        // Withdrawing 1200 USDC → borrow = $200 > $150 weighted collateral
        describe('collaterals is insufficient to cover the borrow', function () {
          const SUPPLY_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
          const WITHDRAW_AMOUNT = exp(1200, baseTokenDecimals);

          let aliceCollateralBalance: BigNumber;

          before(async () => {
            await collateralToken.allocateTo(
              alice.address,
              SUPPLY_COLLATERAL_AMOUNT
            );
            await collateralToken
              .connect(alice)
              .approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
            await comet
              .connect(alice)
              .supply(collateralToken.address, SUPPLY_COLLATERAL_AMOUNT);

            aliceCollateralBalance = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
          });

          it('alice has USDC balance from previous supply', async () => {
            expect(await comet.balanceOf(alice.address)).to.eq(
              exp(1000, baseTokenDecimals)
            );
          });

          it('alice has 1 ASSET0 as collateral', async () => {
            expect(aliceCollateralBalance).to.eq(SUPPLY_COLLATERAL_AMOUNT);
          });

          it('simulated post-withdraw liquidity is negative, proving NotCollateralized', async () => {
            const principal = (
              await comet.userBasic(alice.address)
            ).principal.sub(WITHDRAW_AMOUNT);
            const totalsBasic = await comet.totalsBasic();
            const balanceAfterWithdraw = presentValue(
              principal.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const basePrice = await comet.getPrice(
              await comet.baseTokenPriceFeed()
            );
            const baseScale = await comet.baseScale();

            // debtUSD = balanceAfterWithdraw * basePrice / baseScale (negative)
            // = -200e6 * 1e8 / 1e6 = -200e8
            const debtUSD = mulPrice(
              balanceAfterWithdraw,
              basePrice,
              baseScale
            );

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);

            // collateralUSD = 1e18 * 200e8 / 1e18 = 200e8
            const collateralUSD = mulPrice(
              aliceCollateralBalance.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
              // weightedCollateral = 200e8 * 0.75e18 / 1e18 = 150e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = debtUSD (negative) + weightedCollateral (positive)
            // = -200e8 + 150e8 = -50e8 < 0 → NotCollateralized
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.lessThan(0n);
          });

          it('withdrawing base asset reverts with NotCollateralized', async () => {
            await expect(
              comet.connect(alice).withdraw(baseToken.address, WITHDRAW_AMOUNT)
            ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
          });
        });
      });

      describe('success when', function () {
        // Current state:
        // - Alice has 1000 USDC supply + 1 ASSET0 collateral (weighted capacity = $150)
        // New state:
        // - Alice withdraws 1100 USDC → borrow = $100 < $150 weighted collateral
        // - Alice remains collateralized and has borrow position
        describe('sender has collateral to back the borrow', function () {
          const WITHDRAW_AMOUNT = exp(1100, baseTokenDecimals);
          const EXPECTED_BORROW_AMOUNT = exp(100, baseTokenDecimals);

          let alicePrincipalBefore: BigNumber;
          let aliceCollateralBalance: BigNumber;
          let aliceBaseBalanceBefore: BigNumber;
          let basePrice: BigNumber;
          let baseScale: BigNumber;

          before(async () => {
            alicePrincipalBefore = (await comet.userBasic(alice.address))
              .principal;
            aliceCollateralBalance = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            aliceBaseBalanceBefore = await baseToken.balanceOf(alice.address);
            basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            baseScale = await comet.baseScale();
            await baseToken.allocateTo(comet.address, WITHDRAW_AMOUNT); // fund comet with base token to allow withdraw
          });

          it('alice withdraws 1100 USDC and opens a borrow-backed withdrawal', async () => {
            await expect(
              comet.connect(alice).withdraw(baseToken.address, WITHDRAW_AMOUNT)
            ).to.not.be.reverted;
          });

          it('alice principal before withdrawal was 1000 USDC supply', async () => {
            expect(alicePrincipalBefore).to.eq(exp(1000, baseTokenDecimals));
          });

          it('alice principal after withdrawal is negative (borrower state)', async () => {
            expect(
              (await comet.userBasic(alice.address)).principal
            ).to.be.approximately(-EXPECTED_BORROW_AMOUNT, exp(1, 3)); // possible small difference due to rounding errors
          });

          it('alice borrow balance after withdrawal equals 100 USDC', async () => {
            expect(await comet.borrowBalanceOf(alice.address)).to.eq(
              EXPECTED_BORROW_AMOUNT
            );
          });

          it('alice base balance increases by 1100 USDC', async () => {
            const aliceBaseBalanceAfter = await baseToken.balanceOf(alice.address);
            expect(aliceBaseBalanceAfter.sub(aliceBaseBalanceBefore)).to.eq(
              WITHDRAW_AMOUNT
            );
          });

          it('alice remains borrow-collateralized after withdrawal', async () => {
            expect(await comet.isBorrowCollateralized(alice.address)).to.be
              .true;
          });

          it('manual liquidity proof after withdrawal is positive', async () => {
            const alicePrincipalAfter = (await comet.userBasic(alice.address))
              .principal;
            const totalsBasic = await comet.totalsBasic();
            const balanceAfterWithdrawal = presentValue(
              alicePrincipalAfter.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            // debtUSD = -100e6 * 1e8 / 1e6 = -100e8
            const debtUSD = mulPrice(
              balanceAfterWithdrawal,
              basePrice,
              baseScale
            );

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);

            // collateralUSD = 1e18 * 200e8 / 1e18 = 200e8
            const collateralUSD = mulPrice(
              aliceCollateralBalance.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            // weightedCollateral = 200e8 * 0.75e18 / 1e18 = 150e8
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // liquidity = -100e8 + 150e8 = +50e8 > 0 → collateralized
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
          });
        });
      });
    });
    
    describe('withdrawCollateral', function () {
      describe('revert when', function () {
        // Current state:
        // - Alice has active borrow position (~100 USDC) and 1 ASSET0 collateral
        // Simulated new state if withdraw of a collateral were allowed:
        // - Alice withdraws 1 ASSET0 -> Alice collateral: 1 -> 0
        // - Alice weighted collateral becomes 0 while debt remains > 0, so liquidity is negative
        // - withdraw of a collateral must revert with NotCollateralized and balances stay unchanged
        describe('sender withdraws collateral required for current borrow', function () {
          const WITHDRAW_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);

          let alicePrincipalBefore: BigNumber;
          let aliceBorrowBalanceBefore: BigNumber;
          let aliceCollateralBalanceBefore: BigNumber;
          let basePrice: BigNumber;
          let baseScale: BigNumber;

          before(async () => {
            alicePrincipalBefore = (await comet.userBasic(alice.address))
              .principal;
            aliceBorrowBalanceBefore = await comet.borrowBalanceOf(
              alice.address
            );
            aliceCollateralBalanceBefore = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            baseScale = await comet.baseScale();
          });

          it('alice is currently in borrower state', async () => {
            expect(alicePrincipalBefore).to.be.lessThan(0);
          });

          it('alice has outstanding borrow before collateral withdrawal', async () => {
            expect(aliceBorrowBalanceBefore).to.be.greaterThan(0);
          });

          it('alice has 1 ASSET0 collateral before withdrawal', async () => {
            expect(aliceCollateralBalanceBefore).to.eq(
              WITHDRAW_COLLATERAL_AMOUNT
            );
          });

          it('alice withdraws collateral reverts with NotCollateralized', async () => {
            await expect(
              comet
                .connect(alice)
                .withdraw(
                  collateralToken.address,
                  WITHDRAW_COLLATERAL_AMOUNT
                )
            ).to.be.revertedWithCustomError(comet, 'NotCollateralized');
          });

          it('manual post-withdrawal simulation shows negative liquidity', async () => {
            const totalsBasic = await comet.totalsBasic();
            const baseBalance = presentValue(
              alicePrincipalBefore.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            // debtUSD remains negative from existing borrow position
            const debtUSD = mulPrice(baseBalance, basePrice, baseScale);

            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateralAfterWithdrawal =
                aliceCollateralBalanceBefore.toBigInt() -
                WITHDRAW_COLLATERAL_AMOUNT;

            // after withdrawal all collateral is removed -> weighted collateral = 0
            const collateralUSD = mulPrice(
              collateralAfterWithdrawal,
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.lessThan(0n);
          });
        }
        );
      });

      describe('success when', function () {
        // Current state:
        // - Alice has active borrow position (~100 USDC) and 1 ASSET0 collateral
        // New state:
        // - Alice supplies +1 ASSET0 -> collateral becomes 2 ASSET0
        // - Alice withdraws 0.25 ASSET0 ($50 at $200/ASSET0)
        // - Alice collateral becomes 1.75 ASSET0 and remains borrow-collateralized
        describe('sender keeps enough collateral after withdrawal', function () {
          const ADDITIONAL_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
          const WITHDRAW_COLLATERAL_AMOUNT = exp(25, 16); // 0.25 ASSET0

          let alicePrincipalBefore: BigNumber;
          let aliceCollateralBeforeSupplyOnComet: BigNumber;
          let aliceCollateralBeforeWithdrawal: BigNumber;
          let basePrice: BigNumber;
          let baseScale: BigNumber;

          before(async () => {
            alicePrincipalBefore = (await comet.userBasic(alice.address)).principal;
            aliceCollateralBeforeSupplyOnComet = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            aliceCollateralBeforeWithdrawal = await collateralToken.balanceOf(alice.address);
            basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
            baseScale = await comet.baseScale();
          });

          it('alice has borrow position before adding collateral', async () => {
            expect(alicePrincipalBefore).to.be.lessThan(0);
          });

          it('alice has 1 ASSET0 before additional supply', async () => {
            expect(aliceCollateralBeforeSupplyOnComet).to.eq(exp(1, collateralTokenDecimals));
          });

          it('alice supplies 1 additional ASSET0 collateral', async () => {
            await collateralToken.allocateTo(alice.address, ADDITIONAL_COLLATERAL_AMOUNT);
            await collateralToken.connect(alice).approve(comet.address, ADDITIONAL_COLLATERAL_AMOUNT);
            await comet.connect(alice).supply(collateralToken.address, ADDITIONAL_COLLATERAL_AMOUNT);
          });

          it('alice collateral becomes 2 ASSET0 after supply', async () => {
            expect(
              (await comet.userCollateral(alice.address, collateralToken.address)).balance
            ).to.eq(aliceCollateralBeforeSupplyOnComet.add(ADDITIONAL_COLLATERAL_AMOUNT));
          });

          it('alice withdraws 0.25 ASSET0 collateral', async () => {
            await expect(
              comet
                .connect(alice)
                .withdraw(
                  collateralToken.address,
                  WITHDRAW_COLLATERAL_AMOUNT
                )
            ).to.not.be.reverted;
          });

          it('alice collateral after withdrawal is 1.75 ASSET0', async () => {
            const aliceCollateralAfter = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            expect(aliceCollateralAfter).to.eq(
              aliceCollateralBeforeSupplyOnComet
                .add(ADDITIONAL_COLLATERAL_AMOUNT)
                .sub(WITHDRAW_COLLATERAL_AMOUNT)
            );
          });

          it('alice collateral balance increases by 0.25 ASSET0', async () => {
            const aliceCollateralAfter = await collateralToken.balanceOf(alice.address);
            expect(aliceCollateralAfter.sub(aliceCollateralBeforeWithdrawal)).to.eq(
              WITHDRAW_COLLATERAL_AMOUNT
            );
          });

          it('alice remains borrow-collateralized after collateral withdrawal', async () => {
            expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
          });

          it('manual liquidity proof after withdrawal is positive', async () => {
            const alicePrincipalAfter = (await comet.userBasic(alice.address)).principal;
            const aliceCollateralAfter = (
              await comet.userCollateral(alice.address, collateralToken.address)
            ).balance;
            const totalsBasic = await comet.totalsBasic();
            const baseBalance = presentValue(
              alicePrincipalAfter.toBigInt(),
              totalsBasic.baseSupplyIndex.toBigInt(),
              totalsBasic.baseBorrowIndex.toBigInt()
            );

            const debtUSD = mulPrice(baseBalance, basePrice, baseScale);
            const assetInfo = await comet.getAssetInfo(0);
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateralUSD = mulPrice(
              aliceCollateralAfter.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            const weightedCollateral = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );

            // 1.75 ASSET0 * $200 = $350; weighted at 0.75 => $262.5
            // debt is ~ $100, so liquidity stays positive
            const liquidity = debtUSD + weightedCollateral;
            expect(liquidity).to.be.greaterThan(0n);
          });
        });
      });
    });
  });

  describe('multiple collaterals: liquidity calculation across collateral types', function () {
    // Each collateral: $200 price, 0.75 borrowCF → weighted $150 per token
    // Base token: $1 price, 6 decimals
    const BASE_SUPPLY = exp(100_000, baseTokenDecimals);

    before(async () => {
      // Supply base liquidity once for all multiple-collateral scenarios
      await baseToken.allocateTo(liquidityProvider.address, BASE_SUPPLY);
      await baseToken.connect(liquidityProvider).approve(comet.address, BASE_SUPPLY);
      await comet.connect(liquidityProvider).supply(baseToken.address, BASE_SUPPLY);
      snapshot = await takeSnapshot();
    });

    describe('4 collaterals, liquidity becomes sufficient at 3rd collateral', function () {
      // Charlie supplies 1 token each of ASSET0-ASSET3
      // Weighted capacity per collateral = $200 * 0.75 = $150
      // Borrow: 400 USDC ($400)
      // Cumulative weighted after each collateral:
      //   ASSET0: $150           → liquidity = $150 - $400 = -$250 (insufficient)
      //   ASSET1: $150 + $150    → liquidity = $300 - $400 = -$100 (insufficient)
      //   ASSET2: $300 + $150    → liquidity = $450 - $400 = +$50  (sufficient)
      //   ASSET3: $450 + $150    → liquidity = $600 - $400 = +$200 (extra)

      const NUM_COLLATERALS = 4;
      const COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
      const BORROW_AMOUNT = exp(400, baseTokenDecimals);

      before(async () => {
        await snapshot.restore();
        // Charlie supplies 4 different collateral types
        for (let i = 0; i < NUM_COLLATERALS; i++) {
          const assetInfo = await comet.getAssetInfo(i);
          const token = await ethers.getContractAt(
            'FaucetToken',
            assetInfo.asset
          );
          await token.allocateTo(charlie.address, COLLATERAL_AMOUNT);
          await token.connect(charlie).approve(comet.address, COLLATERAL_AMOUNT);
          await comet.connect(charlie).supply(token.address, COLLATERAL_AMOUNT);
        }

        // Charlie borrows 400 USDC
        await comet.connect(charlie).withdraw(baseToken.address, BORROW_AMOUNT);
      });

      it('charlie has negative principal (borrower state)', async () => {
        expect((await comet.userBasic(charlie.address)).principal).to.be.lessThan(0);
      });

      it('charlie borrow balance equals 400 USDC', async () => {
        expect(await comet.borrowBalanceOf(charlie.address)).to.eq(BORROW_AMOUNT);
      });

      it('charlie has 1 token of each of 4 collaterals', async () => {
        for (let i = 0; i < NUM_COLLATERALS; i++) {
          const assetInfo = await comet.getAssetInfo(i);
          const userCollateral = await comet.userCollateral(charlie.address, assetInfo.asset);

          expect(userCollateral.balance).to.eq(COLLATERAL_AMOUNT);
        }
      });

      it('charlie is borrow-collateralized', async () => {
        expect(await comet.isBorrowCollateralized(charlie.address)).to.be.true;
      });

      it('manual proof: first 2 collaterals insufficient, 3rd makes it sufficient', async () => {
        const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
        const baseScale = await comet.baseScale();
        const totalsBasic = await comet.totalsBasic();
        const principal = (await comet.userBasic(charlie.address)).principal;
        const baseBalance = presentValue(
          principal.toBigInt(),
          totalsBasic.baseSupplyIndex.toBigInt(),
          totalsBasic.baseBorrowIndex.toBigInt()
        );
        const debtUSD = mulPrice(baseBalance, basePrice, baseScale);

        let cumulativeWeighted = 0n;
        for (let i = 0; i < NUM_COLLATERALS; i++) {
          const assetInfo = await comet.getAssetInfo(i);
          const balance = (await comet.userCollateral(charlie.address, assetInfo.asset)).balance;
          const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
          const collateralUSD = mulPrice(
            balance.toBigInt(),
            collateralPrice.toBigInt(),
            assetInfo.scale.toBigInt()
          );
          const weighted = mulFactor(
            collateralUSD,
            assetInfo.borrowCollateralFactor
          );
          cumulativeWeighted += weighted;

          const liquidity = debtUSD + cumulativeWeighted;
          if (i < 2) {
            // After 1st and 2nd collateral: cumulative weighted < debt
            expect(liquidity).to.be.lessThan(0n);
          } else {
            // After 3rd and 4th collateral: cumulative weighted > debt
            expect(liquidity).to.be.greaterThan(0n);
          }
        }
      });
    });

    describe('3 collaterals, only the last one covers the debt', function () {
      // Charlie supplies:
      //   ASSET0: 0.01 tokens → weighted = $200 * 0.01 * 0.75 = $1.50
      //   ASSET1: 0.01 tokens → weighted = $1.50
      //   ASSET2: 3 tokens    → weighted = $200 * 3 * 0.75 = $450
      // Borrow: 300 USDC ($300)
      // Cumulative weighted after each collateral:
      //   ASSET0: $1.50              → liquidity = $1.50 - $300 = -$298.50 (insufficient)
      //   ASSET1: $1.50 + $1.50      → liquidity = $3.00 - $300 = -$297    (insufficient)
      //   ASSET2: $3.00 + $450       → liquidity = $453  - $300 = +$153    (sufficient)

      const NUM_COLLATERALS = 3;
      const SMALL_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals - 2); // 0.01 tokens
      const LARGE_COLLATERAL_AMOUNT = exp(3, collateralTokenDecimals); // 3 tokens
      const BORROW_AMOUNT = exp(300, baseTokenDecimals);

      before(async () => {
        await snapshot.restore();

        // Charlie supplies 3 collateral types with different amounts
        for (let i = 0; i < NUM_COLLATERALS; i++) {
          const assetInfo = await comet.getAssetInfo(i);
          const token = await ethers.getContractAt(
            'FaucetToken',
            assetInfo.asset
          );
          const amount =
            i < 2 ? SMALL_COLLATERAL_AMOUNT : LARGE_COLLATERAL_AMOUNT;
          await token.allocateTo(charlie.address, amount);
          await token.connect(charlie).approve(comet.address, amount);
          await comet.connect(charlie).supply(token.address, amount);
        }

        // Charlie borrows 300 USDC
        await comet.connect(charlie).withdraw(baseToken.address, BORROW_AMOUNT);
      });

      it('charlie has negative principal (borrower state)', async () => {
        expect((await comet.userBasic(charlie.address)).principal).to.be.lessThan(0);
      });

      it('charlie borrow balance equals 300 USDC', async () => {
        expect(await comet.borrowBalanceOf(charlie.address)).to.eq(BORROW_AMOUNT);
      });

      it('charlie has 0.01 tokens of ASSET0 and ASSET1, 3 tokens of ASSET2', async () => {
        for (let i = 0; i < NUM_COLLATERALS; i++) {
          const assetInfo = await comet.getAssetInfo(i);
          const expectedAmount =
            i < 2 ? SMALL_COLLATERAL_AMOUNT : LARGE_COLLATERAL_AMOUNT;
          const userCollateral = await comet.userCollateral(charlie.address, assetInfo.asset);
          expect(userCollateral.balance).to.eq(expectedAmount);
        }
      });

      it('charlie is borrow-collateralized', async () => {
        expect(await comet.isBorrowCollateralized(charlie.address)).to.be.true;
      });

      it('manual proof: first 2 collaterals insufficient, only the 3rd covers the debt', async () => {
        const basePrice = await comet.getPrice(
          await comet.baseTokenPriceFeed()
        );
        const baseScale = await comet.baseScale();
        const totalsBasic = await comet.totalsBasic();
        const principal = (await comet.userBasic(charlie.address)).principal;
        const baseBalance = presentValue(
          principal.toBigInt(),
          totalsBasic.baseSupplyIndex.toBigInt(),
          totalsBasic.baseBorrowIndex.toBigInt()
        );
        const debtUSD = mulPrice(baseBalance, basePrice, baseScale);

        let cumulativeWeighted = 0n;
        for (let i = 0; i < NUM_COLLATERALS; i++) {
          const assetInfo = await comet.getAssetInfo(i);
          const balance = (await comet.userCollateral(charlie.address, assetInfo.asset)).balance;
          const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
          const collateralUSD = mulPrice(
            balance.toBigInt(),
            collateralPrice.toBigInt(),
            assetInfo.scale.toBigInt()
          );
          const weighted = mulFactor(
            collateralUSD,
            assetInfo.borrowCollateralFactor
          );
          cumulativeWeighted += weighted;

          const liquidity = debtUSD + cumulativeWeighted;
          if (i < 2) {
            // First 2 collaterals (0.01 tokens each) contribute only $1.50 each
            expect(liquidity).to.be.lessThan(0n);
          } else {
            // 3rd collateral (3 tokens) contributes $450, making total sufficient
            expect(liquidity).to.be.greaterThan(0n);
          }
        }
      });
    });

    describe('24 collaterals', function () {
      // Charlie supplies 1 token of each of all 24 collateral types
      // Total weighted capacity = 24 * $200 * 0.75 = $3600
      // Borrow: 3500 USDC ($3500)
      // 23 collaterals: 23 * $150 = $3450 < $3500 → insufficient
      // 24 collaterals: 24 * $150 = $3600 > $3500 → sufficient

      const NUM_COLLATERALS = MAX_ASSETS; // 24
      const COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
      const BORROW_AMOUNT = exp(3500, baseTokenDecimals);

      before(async () => {
        await snapshot.restore();

        // Charlie supplies all 24 collateral types
        for (let i = 0; i < NUM_COLLATERALS; i++) {
          const assetInfo = await comet.getAssetInfo(i);
          const token = await ethers.getContractAt(
            'FaucetToken',
            assetInfo.asset
          );
          await token.allocateTo(charlie.address, COLLATERAL_AMOUNT);
          await token.connect(charlie).approve(comet.address, COLLATERAL_AMOUNT);
          await comet.connect(charlie).supply(token.address, COLLATERAL_AMOUNT);
        }

        // Charlie borrows 3500 USDC
        await comet.connect(charlie).withdraw(baseToken.address, BORROW_AMOUNT);
      });

      describe('huge loan covered by all 24 collaterals', function () {
        it('charlie has negative principal (borrower state)', async () => {
          expect((await comet.userBasic(charlie.address)).principal).to.be.lessThan(0);
        });

        it('charlie borrow balance equals 3500 USDC', async () => {
          expect(await comet.borrowBalanceOf(charlie.address)).to.eq(BORROW_AMOUNT);
        });

        it('charlie has 1 token of each of all 24 collaterals', async () => {
          for (let i = 0; i < NUM_COLLATERALS; i++) {
            const assetInfo = await comet.getAssetInfo(i);
            const userCollateral = await comet.userCollateral(charlie.address, assetInfo.asset);
            expect(userCollateral.balance).to.eq(COLLATERAL_AMOUNT);
          }
        });

        it('charlie is borrow-collateralized with all 24 collaterals', async () => {
          expect(await comet.isBorrowCollateralized(charlie.address)).to.be.true;
        });

        it('manual proof: first 23 collaterals insufficient, all 24 sufficient', async () => {
          const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
          const baseScale = await comet.baseScale();
          const totalsBasic = await comet.totalsBasic();
          const principal = (await comet.userBasic(charlie.address)).principal;
          const baseBalance = presentValue(
            principal.toBigInt(),
            totalsBasic.baseSupplyIndex.toBigInt(),
            totalsBasic.baseBorrowIndex.toBigInt()
          );
          const debtUSD = mulPrice(baseBalance, basePrice, baseScale);

          let cumulativeWeighted = 0n;
          for (let i = 0; i < NUM_COLLATERALS; i++) {
            const assetInfo = await comet.getAssetInfo(i);
            const balance = (await comet.userCollateral(charlie.address, assetInfo.asset)).balance;
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateralUSD = mulPrice(
              balance.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            const weighted = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );
            cumulativeWeighted += weighted;

            const liquidity = debtUSD + cumulativeWeighted;
            if (i < NUM_COLLATERALS - 1) {
              // First 23 collaterals: cumulative $3450 < $3500 debt
              expect(liquidity).to.be.lessThan(0n);
            } else {
              // All 24 collaterals: cumulative $3600 > $3500 debt
              expect(liquidity).to.be.greaterThan(0n);
            }
          }
        });
      });

      describe('all 24 collaterals insufficient to cover the debt', function () {
        // Base price is increased by 10%: debt = 3500 * 1.1 = $3850
        // Total weighted collateral remains $3600
        // $3600 < $3850 → undercollateralized
        let basePriceBefore: BigNumber;

        before(async () => {
          basePriceBefore = await comet.getPrice(
            await comet.baseTokenPriceFeed()
          );
          // Increase base price by 10%: debt in USD increases from $3500 to $3850
          await priceFeeds[baseSymbol].setRoundData(1, basePriceBefore.mul(110).div(100), 1, 1, 1);
        });

        after(async () => {
          await priceFeeds[baseSymbol].setRoundData(1, basePriceBefore, 1, 1, 1);
        });

        it('charlie is NOT borrow-collateralized despite having all 24 collaterals', async () => {
          expect(await comet.isBorrowCollateralized(charlie.address)).to.be.false;
        });

        it('manual proof: total weighted collateral across all 24 assets is less than debt', async () => {
          const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
          const baseScale = await comet.baseScale();
          const totalsBasic = await comet.totalsBasic();
          const principal = (await comet.userBasic(charlie.address)).principal;
          const baseBalance = presentValue(
            principal.toBigInt(),
            totalsBasic.baseSupplyIndex.toBigInt(),
            totalsBasic.baseBorrowIndex.toBigInt()
          );
          const debtUSD = mulPrice(baseBalance, basePrice, baseScale);

          let cumulativeWeighted = 0n;
          for (let i = 0; i < NUM_COLLATERALS; i++) {
            const assetInfo = await comet.getAssetInfo(i);
            const balance = (await comet.userCollateral(charlie.address, assetInfo.asset)).balance;
            const collateralPrice = await comet.getPrice(assetInfo.priceFeed);
            const collateralUSD = mulPrice(
              balance.toBigInt(),
              collateralPrice.toBigInt(),
              assetInfo.scale.toBigInt()
            );
            const weighted = mulFactor(
              collateralUSD,
              assetInfo.borrowCollateralFactor
            );
            cumulativeWeighted += weighted;
          }

          // Even after all 24 collaterals, liquidity is still negative
          const liquidity = debtUSD + cumulativeWeighted;
          expect(liquidity).to.be.lessThan(0n);
        });
      });
    });
  });
});