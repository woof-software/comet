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
} from './helpers';

describe.only('isBorrowCollateralized', function () {
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

  let snapshotId: string;

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
    [alice, bob] = protocol.users;
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
      snapshotId = await ethers.provider.send('evm_snapshot', []);
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
            expect(await comet.borrowBalanceOf(alice.address)).to.eq(
              EXPECTED_BORROW_AMOUNT
            );
          });

          it('bob base balance increases by 1100 USDC', async () => {
            const bobBaseBalanceAfter = await comet.balanceOf(bob.address);
            expect(bobBaseBalanceAfter.sub(bobBaseBalanceBefore)).to.eq(
              TRANSFER_AMOUNT
            );
          });

          it('alice remains borrow-collateralized after transfer', async () => {
            expect(await comet.isBorrowCollateralized(alice.address)).to.be
              .true;
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
        describe(
          'sender transfers away collateral required for current borrow',
          function () {
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
      // Current state:
      // - Alice has active borrow position (~100 USDC) and 1 ASSET0 collateral (weighted capacity = $150)
      // - Bob has 1 ASSET0 collateral and no borrow position
      it('confirm initial state is collateralized for both users', async () => {
        expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
        expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
      });

      describe('base price increases', function () {
        let basePriceFeed: SimplePriceFeed;
        let basePriceBefore: BigNumber;

        before(async () => {
          basePriceFeed = priceFeeds[baseSymbol];
          basePriceBefore = await comet.getPrice(await comet.baseTokenPriceFeed());
          await basePriceFeed.setRoundData(1, basePriceBefore.mul(10), 1, 1, 1);
        });

        after(async () => {
          await basePriceFeed.setRoundData(1, basePriceBefore, 1, 1, 1);
        });

        it('opened borrow position becomes undercollateralized', async () => {
          expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
        });

        it('non-opened position is not affected by base price increase', async () => {
          expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
        });
      });

      describe('base price decreases', function () {
        let basePriceFeed: SimplePriceFeed;
        let basePriceBefore: BigNumber;

        before(async () => {
          basePriceFeed = priceFeeds[baseSymbol];
          basePriceBefore = await comet.getPrice(await comet.baseTokenPriceFeed());
          await basePriceFeed.setRoundData(1, basePriceBefore.div(10), 1, 1, 1);
        });

        after(async () => {
          await basePriceFeed.setRoundData(1, basePriceBefore, 1, 1, 1);
        });

        it('opened borrow position stays collateralized', async () => {
          expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
        });

        it('non-opened position is not affected by base price decrease', async () => {
          expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
        });
      });
    });

    describe('collateral price change', function () {
      describe('collateral price increases', function () {
        let collateralPriceFeed: SimplePriceFeed;
        let collateralPriceBefore: BigNumber;

        before(async () => {
          collateralPriceFeed = priceFeeds['ASSET0'];
          collateralPriceBefore = await comet.getPrice(collateralPriceFeed.address);
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore.mul(10), 1, 1, 1);
        });

        after(async () => {
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore, 1, 1, 1);
        });

        it('opened borrow position stays collateralized', async () => {
          expect(await comet.isBorrowCollateralized(alice.address)).to.be.true;
        });

        it('non-opened position is not affected by collateral price increase', async () => {
          expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
        });
      });

      describe('collateral price decreases', function () {
        let collateralPriceFeed: SimplePriceFeed;
        let collateralPriceBefore: BigNumber;

        before(async () => {
          collateralPriceFeed = priceFeeds['ASSET0'];
          collateralPriceBefore = await comet.getPrice(collateralPriceFeed.address);
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore.div(10), 1, 1, 1);
        });

        after(async () => {
          await collateralPriceFeed.setRoundData(1, collateralPriceBefore, 1, 1, 1);
        });

        it('opened borrow position becomes undercollateralized', async () => {
          expect(await comet.isBorrowCollateralized(alice.address)).to.be.false;
        });

        it('non-opened position is not affected by collateral price decrease', async () => {
          expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
        });
      });
    });
  });

  describe('withdraw: isBorrowCollateralized impact on withdraw function', function () {
    // Reset to pre-transfer state
    before(async () => {
      await ethers.provider.send('evm_revert', [snapshotId]);
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
            console.log(await baseToken.balanceOf(alice.address));
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
            console.log(aliceBaseBalanceAfter, aliceBaseBalanceBefore);
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
        describe(
          'sender withdraws collateral required for current borrow',
          function () {
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

            it('alice collateral remains unchanged after revert', async () => {
              expect(
                (
                  await comet.userCollateral(alice.address, collateralToken.address)
                ).balance
              ).to.eq(aliceCollateralBalanceBefore);
            });

            it('alice collateral remains unchanged after revert', async () => {
              expect(
                (
                  await comet.userCollateral(alice.address, collateralToken.address)
                ).balance
              ).to.eq(aliceCollateralBalanceBefore);
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
});