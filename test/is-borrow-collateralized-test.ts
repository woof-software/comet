import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, FaucetToken, NonStandardFaucetFeeToken, PriceFeedWithRevert, SimplePriceFeed } from 'build/types';
import { expect, exp, ethers, MAX_ASSETS, presentValue, mulPrice, mulFactor, factorScale, BigNumber, takeSnapshot, SnapshotRestorer, makeConfigurator, SignerWithAddress } from './helpers';

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
  let tokens: Record<string, FaucetToken | NonStandardFaucetFeeToken>;
  // Price feeds
  let priceFeeds: Record<string, SimplePriceFeed>;
  // Users
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

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
        ...collaterals 
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
    tokens = protocol.tokens;
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
    await configurator.setExtensionDelegate(cometProxyAddress, CometExtAssetList.address);
    const CometFactoryWithExtendedAssetList = await (await ethers.getContractFactory('CometFactoryWithExtendedAssetList')).deploy();
    await CometFactoryWithExtendedAssetList.deployed();
    await configurator.setFactory(cometProxyAddress, CometFactoryWithExtendedAssetList.address);
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
    const SUPPLY_AMOUNT:bigint = exp(1000, baseTokenDecimals);

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
      expect((await comet.userBasic(alice.address)).principal).to.eq(SUPPLY_AMOUNT);
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
    const SUPPLY_COLLATERAL_AMOUNT:bigint = exp(1, collateralTokenDecimals);
    let principalBefore: BigNumber;

    before(async () => {
      await collateralToken.allocateTo(bob.address, SUPPLY_COLLATERAL_AMOUNT);
      principalBefore = (await comet.userBasic(bob.address)).principal;
    });

    it('sanity check: user principal should be zero', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.eq(0);
    });

    it('collateral balance before should be zero', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(0);
    });

    it('comet collateral token balance should be zero', async () => {
      expect(await collateralToken.balanceOf(comet.address)).to.eq(0);
    });

    it('user perform supply collateral operation', async () => {
      await collateralToken.connect(bob).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
      await comet.connect(bob).supply(collateralToken.address, SUPPLY_COLLATERAL_AMOUNT);
    });

    it('wait and accrue state', async () => {
      // wait with empty comet for a while
      await ethers.provider.send('evm_increaseTime', [ONE_HOUR]); // 1 hr
      await ethers.provider.send('evm_mine', []);

      await comet.accrueAccount(bob.address);
    });

    it('user principal should not change after collateral supply', async () => {
      expect((await comet.userBasic(bob.address)).principal).to.eq(principalBefore);
    });

    it('collateral balance after equals supply amount', async () => {
      expect((await comet.userCollateral(bob.address, collateralToken.address)).balance).to.eq(SUPPLY_COLLATERAL_AMOUNT);
    });

    it('comet collateral token balance equals supply amount', async () => {
      expect(await collateralToken.balanceOf(comet.address)).to.eq(SUPPLY_COLLATERAL_AMOUNT);
    });

    it('users borrow balance should be zero', async () => {
      expect(await comet.borrowBalanceOf(bob.address)).to.eq(0);
    });

    it('user remains collateralized', async () => {
      expect(await comet.isBorrowCollateralized(bob.address)).to.be.true;
    });
  });

  describe('transfers: isBorrowCollateralized impact on transfer functions', function () {
    describe('transferBase', function () {
      // Alice has 1000 USDC supply but no collateral
      // Transferring 1100 USDC creates a 100 USDC borrow with nothing to back it
      describe('revert case: NotCollateralized when sender has no collateral to back the borrow', function () {
        const TRANSFER_AMOUNT = exp(1100, baseTokenDecimals);

        let aliceBalance: BigNumber;
        let aliceCollateralBalance: BigNumber;
        let basePrice: BigNumber;
        let baseScale: BigNumber;

        before(async () => {
          aliceBalance = await comet.balanceOf(alice.address);
          aliceCollateralBalance = (await comet.userCollateral(alice.address, collateralToken.address)).balance;
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

      describe('revert case: NotCollateralized when collateral is insufficient to cover the borrow', function () {
        const SUPPLY_COLLATERAL_AMOUNT = exp(1, collateralTokenDecimals);
        // Alice has 1000 USDC supply + 1 ASSET0 collateral (weighted capacity = $150)
        // Transfer 1200 USDC → borrow = $200 > $150 weighted collateral
        const TRANSFER_AMOUNT = exp(1200, baseTokenDecimals);

        let aliceCollateralBalance: BigNumber;

        before(async () => {
          await collateralToken.allocateTo(alice.address, SUPPLY_COLLATERAL_AMOUNT);
          await collateralToken.connect(alice).approve(comet.address, SUPPLY_COLLATERAL_AMOUNT);
          await comet.connect(alice).supply(collateralToken.address, SUPPLY_COLLATERAL_AMOUNT);

          aliceCollateralBalance = (await comet.userCollateral(alice.address, collateralToken.address)).balance;
        });

        it('alice has USDC balance from previous supply', async () => {
          expect(await comet.balanceOf(alice.address)).to.eq(exp(1000, baseTokenDecimals));
        });

        it('alice has 1 ASSET0 as collateral', async () => {
          expect(aliceCollateralBalance).to.eq(SUPPLY_COLLATERAL_AMOUNT);
        });

        it('simulated post-transfer liquidity is negative, proving NotCollateralized', async () => {
          const principal = (await comet.userBasic(alice.address)).principal.sub(TRANSFER_AMOUNT);
          const totalsBasic = await comet.totalsBasic();
          const balanceAfterTransfer = presentValue(
            principal.toBigInt(),
            totalsBasic.baseSupplyIndex.toBigInt(),
            totalsBasic.baseBorrowIndex.toBigInt()
          );

          const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
          const baseScale = await comet.baseScale();

          // debtUSD = balanceAfterTransfer * basePrice / baseScale (negative)
          // = -200e6 * 1e8 / 1e6 = -200e8
          const debtUSD = mulPrice(balanceAfterTransfer, basePrice, baseScale);

          const assetInfo = await comet.getAssetInfo(0);
          const collateralPrice = await comet.getPrice(assetInfo.priceFeed);

          // collateralUSD = 1e18 * 200e8 / 1e18 = 200e8
          const collateralUSD = mulPrice(aliceCollateralBalance.toBigInt(), collateralPrice.toBigInt(), assetInfo.scale.toBigInt());
          // weightedCollateral = 200e8 * 0.75e18 / 1e18 = 150e8
          const weightedCollateral = mulFactor(collateralUSD, assetInfo.borrowCollateralFactor);

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
  });
});
