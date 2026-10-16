import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { CometHarnessInterfaceExtendedAssetList, CometProxyAdmin, Configurator, FaucetToken, SimplePriceFeed } from '../build/types';
import { ethers, expect, exp, makeConfigurator } from './helpers';
import { BigNumber } from 'ethers';

[6, 8, 18].forEach(runCollateral1WeiPriceTests);

function runCollateral1WeiPriceTests(collateralDecimals: number) {
  describe(`Collateral 1 Wei Price (${collateralDecimals} decimals)`, function () {
    const NEW_PRICE = 1n;
    const snapshot = (): Promise<string> => ethers.provider.send('evm_snapshot', []);
    const revert = (id: string): Promise<boolean> => ethers.provider.send('evm_revert', [id]);

    const collateralInfo = {
      name: 'Token',
      symbol: 'TOKEN',
      decimals: collateralDecimals,
      initialPrice: 85_000,
      borrowCF: exp(0.8, 18),
      liquidateCF: exp(0.85, 18),
      liquidationFactor: exp(0.9, 18),
      supplyCap: exp(200_000_000, collateralDecimals),
    };

    const collateralUnits = (wholeTokens: number): bigint => exp(wholeTokens, collateralDecimals);

    let comet: CometHarnessInterfaceExtendedAssetList;
    let collateral: FaucetToken;
    let backingCollateral: FaucetToken;
    let base: FaucetToken;
    let user: SignerWithAddress;
    let recipient: SignerWithAddress;
    let priceFeed: SimplePriceFeed;
    let initialSnapshot: string;
    let configurator: Configurator;
    let cometProxyAdmin: CometProxyAdmin;

  interface SupplyState {
    assetMask: number;
    collateralBalance: BigNumber;
    userCollateralReserved: BigNumber;
    totalSupplyAsset: BigNumber;
    totalsCollateralReserved: BigNumber;
    principal: BigNumber;
    baseTrackingIndex: BigNumber;
    assetsIn: number;
    userReserved: number;
    baseSupplyIndex: BigNumber;
    baseBorrowIndex: BigNumber;
    totalSupplyBase: BigNumber;
    totalBorrowBase: BigNumber;
    userCollateralBalance: BigNumber;
    cometCollateralBalance: BigNumber;
    tokenSupply: BigNumber;
    userBaseBalance: BigNumber;
    cometBaseBalance: BigNumber;
  }

  async function readSupplyState(account: SignerWithAddress = user, token: FaucetToken = collateral): Promise<SupplyState> {
    const asset = await comet.getAssetInfoByAddress(token.address);
    const userCollateral = await comet.userCollateral(account.address, token.address);
    const totalsCollateral = await comet.totalsCollateral(token.address);
    const userBasic = await comet.userBasic(account.address);
    const totalsBasic = await comet.totalsBasic();

    return {
      assetMask: 1 << asset.offset,
      collateralBalance: userCollateral.balance,
      userCollateralReserved: userCollateral._reserved,
      totalSupplyAsset: totalsCollateral.totalSupplyAsset,
      totalsCollateralReserved: totalsCollateral._reserved,
      principal: userBasic.principal,
      baseTrackingIndex: userBasic.baseTrackingIndex,
      assetsIn: userBasic.assetsIn,
      userReserved: userBasic._reserved,
      baseSupplyIndex: totalsBasic.baseSupplyIndex,
      baseBorrowIndex: totalsBasic.baseBorrowIndex,
      totalSupplyBase: totalsBasic.totalSupplyBase,
      totalBorrowBase: totalsBasic.totalBorrowBase,
      userCollateralBalance: await token.balanceOf(account.address),
      cometCollateralBalance: await token.balanceOf(comet.address),
      tokenSupply: await token.totalSupply(),
      userBaseBalance: await base.balanceOf(account.address),
      cometBaseBalance: await base.balanceOf(comet.address),
    };
  }

  before(async () => {
    const protocol = await makeConfigurator({
      baseBorrowMin: exp(1, 6),
      assets: {
        USDC: { decimals: 6, initialPrice: 1 },
        [collateralInfo.symbol]: { ...collateralInfo, initial: collateralUnits(100) },
        BACKING: {
          decimals: 18,
          initialPrice: 10,
          borrowCF: exp(0.8, 18),
          liquidateCF: exp(0.85, 18),
          liquidationFactor: exp(0.9, 18),
          supplyCap: exp(100, 18),
        },
      },
    });
    [user, recipient] = protocol.users;
    configurator = protocol.configurator.attach(protocol.configuratorProxy.address).connect(protocol.governor);
    cometProxyAdmin = protocol.proxyAdmin.connect(protocol.governor);
    collateral = protocol.tokens[collateralInfo.symbol] as FaucetToken;
    base = protocol.tokens.USDC as FaucetToken;
    backingCollateral = protocol.tokens.BACKING as FaucetToken;
    comet = protocol.cometWithExtendedAssetList.attach(protocol.cometProxyWithExtendedAssetList.address);
    priceFeed = protocol.priceFeeds[collateralInfo.symbol];
    initialSnapshot = await snapshot();
  });

  context('withdraw all collateral supplied at a 1 wei price without a borrow position', function () {
    const SUPPLY_AMOUNT = collateralUnits(10);
    let stateBefore: SupplyState;
    let collateralReservesBefore: BigNumber;

    before(async () => {
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);
      await collateral.allocateTo(user.address, SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
      stateBefore = await readSupplyState();
      collateralReservesBefore = await comet.getCollateralReserves(collateral.address);
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('withdraws the entire collateral position at a 1 wei price', async () => {
      await comet.connect(user).withdraw(collateral.address, SUPPLY_AMOUNT);
    });

    it('clears the user collateral position', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(0);
    });

    it('removes the withdrawn amount from total supplied collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(stateBefore.totalSupplyAsset.sub(SUPPLY_AMOUNT));
    });

    it('clears the collateral membership bit', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(stateBefore.assetsIn & ~stateBefore.assetMask);
    });

    it('returns all supplied tokens to the user ERC20 balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(stateBefore.userCollateralBalance.add(SUPPLY_AMOUNT));
    });

    it('debits the Comet ERC20 collateral balance by the full withdrawal', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(stateBefore.cometCollateralBalance.sub(SUPPLY_AMOUNT));
    });

    it('preserves protocol-owned collateral reserves', async () => {
      expect(await comet.getCollateralReserves(collateral.address)).to.equal(collateralReservesBefore);
    });

    it('leaves the user with no debt', async () => {
      expect(await comet.borrowBalanceOf(user.address)).to.equal(0);
    });

    it('preserves the user base principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(stateBefore.principal);
    });

    it('preserves total base supply principal', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(stateBefore.totalSupplyBase);
    });

    it('preserves total base borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(stateBefore.totalBorrowBase);
    });

    it('preserves the user base ERC20 balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(stateBefore.userBaseBalance);
    });

    it('preserves the Comet base ERC20 balance', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(stateBefore.cometBaseBalance);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(stateBefore.tokenSupply);
    });

    it('preserves the user collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(stateBefore.userCollateralReserved);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(stateBefore.totalsCollateralReserved);
    });

    it('preserves the user extended collateral membership', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(stateBefore.userReserved);
    });

    it('keeps the account non-liquidatable after the full withdrawal', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(false);
    });
  });

  context('supply collateral priced at 1 wei with no existing collateral position', function () {
    const SUPPLY_AMOUNT = collateralUnits(1);
    let stateBefore: SupplyState;

    before(async () => {
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);

      await collateral.allocateTo(user.address, 3n * SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, 2n * SUPPLY_AMOUNT);

      stateBefore = await readSupplyState();
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('supplies collateral priced at 1 wei', async () => {
      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
    });

    it('credits the full token amount to the user collateral balance', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(stateBefore.collateralBalance.add(SUPPLY_AMOUNT));
    });

    it('increases the market total supplied collateral by the full token amount', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(stateBefore.totalSupplyAsset.add(SUPPLY_AMOUNT));
    });

    it('sets the collateral membership bit for the user', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(stateBefore.assetsIn | stateBefore.assetMask);
    });

    it('debits the user ERC20 collateral balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(stateBefore.userCollateralBalance.sub(SUPPLY_AMOUNT));
    });

    it('credits the Comet ERC20 collateral balance', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(stateBefore.cometCollateralBalance.add(SUPPLY_AMOUNT));
    });

    it('preserves userBasic.principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(stateBefore.principal);
    });

    it('preserves userBasic.baseTrackingIndex', async () => {
      expect((await comet.userBasic(user.address)).baseTrackingIndex).to.equal(stateBefore.baseTrackingIndex);
    });

    it('preserves userBasic._reserved', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(stateBefore.userReserved);
    });

    it('preserves totalsBasic.baseSupplyIndex', async () => {
      expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(stateBefore.baseSupplyIndex);
    });

    it('preserves totalsBasic.baseBorrowIndex', async () => {
      expect((await comet.totalsBasic()).baseBorrowIndex).to.equal(stateBefore.baseBorrowIndex);
    });

    it('preserves totalsBasic.totalSupplyBase', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(stateBefore.totalSupplyBase);
    });

    it('preserves totalsBasic.totalBorrowBase', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(stateBefore.totalBorrowBase);
    });

    it('preserves the user collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(stateBefore.userCollateralReserved);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(stateBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(stateBefore.tokenSupply);
    });

    it('preserves the user base ERC20 balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(stateBefore.userBaseBalance);
    });

    it('preserves the Comet base ERC20 balance', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(stateBefore.cometBaseBalance);
    });

  });
  
  context('supply collateral priced at 1 wei with a collateral position opened at the initial price', function () {
    const SUPPLY_AMOUNT = collateralUnits(1);
    const INITIAL_SUPPLY_AMOUNT = 2n * SUPPLY_AMOUNT;
    let stateBefore: SupplyState;

    before(async () => {
      await collateral.allocateTo(user.address, 5n * SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, INITIAL_SUPPLY_AMOUNT + SUPPLY_AMOUNT);

      await comet.connect(user).supply(collateral.address, INITIAL_SUPPLY_AMOUNT);

      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);
      stateBefore = await readSupplyState();
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('supplies additional collateral priced at 1 wei', async () => {
      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
    });

    it('credits the full token amount to the user collateral balance', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(stateBefore.collateralBalance.add(SUPPLY_AMOUNT));
    });

    it('increases the market total supplied collateral by the full token amount', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(stateBefore.totalSupplyAsset.add(SUPPLY_AMOUNT));
    });

    it('preserves the collateral membership bit for the user', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(stateBefore.assetsIn);
    });

    it('debits the user ERC20 collateral balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(stateBefore.userCollateralBalance.sub(SUPPLY_AMOUNT));
    });

    it('credits the Comet ERC20 collateral balance', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(stateBefore.cometCollateralBalance.add(SUPPLY_AMOUNT));
    });

    it('preserves userBasic.principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(stateBefore.principal);
    });

    it('preserves userBasic.baseTrackingIndex', async () => {
      expect((await comet.userBasic(user.address)).baseTrackingIndex).to.equal(stateBefore.baseTrackingIndex);
    });

    it('preserves userBasic._reserved', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(stateBefore.userReserved);
    });

    it('preserves totalsBasic.baseSupplyIndex', async () => {
      expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(stateBefore.baseSupplyIndex);
    });

    it('preserves totalsBasic.baseBorrowIndex', async () => {
      expect((await comet.totalsBasic()).baseBorrowIndex).to.equal(stateBefore.baseBorrowIndex);
    });

    it('preserves totalsBasic.totalSupplyBase', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(stateBefore.totalSupplyBase);
    });

    it('preserves totalsBasic.totalBorrowBase', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(stateBefore.totalBorrowBase);
    });

    it('preserves the user collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(stateBefore.userCollateralReserved);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(stateBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(stateBefore.tokenSupply);
    });

    it('preserves the user base ERC20 balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(stateBefore.userBaseBalance);
    });

    it('preserves the Comet base ERC20 balance', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(stateBefore.cometBaseBalance);
    });

  });

  context('transfer collateral deposited at a 1 wei price to another user', function () {
    const SUPPLY_AMOUNT = collateralUnits(1);
    const DEPOSIT_AMOUNT = 2n * SUPPLY_AMOUNT;
    const TRANSFER_AMOUNT = SUPPLY_AMOUNT;
    let senderBefore: SupplyState;
    let recipientBefore: SupplyState;

    before(async () => {
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);
      await collateral.allocateTo(user.address, 3n * SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, DEPOSIT_AMOUNT);

      await comet.connect(user).supply(collateral.address, DEPOSIT_AMOUNT);
      senderBefore = await readSupplyState(user);
      recipientBefore = await readSupplyState(recipient);
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('transfers collateral priced at 1 wei to the recipient', async () => {
      await comet.connect(user).transferAsset(recipient.address, collateral.address, TRANSFER_AMOUNT);
    });

    it('debits the sender collateral position by the transferred amount', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(senderBefore.collateralBalance.sub(TRANSFER_AMOUNT));
    });

    it('credits the recipient collateral position by the transferred amount', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address)).balance).to.equal(recipientBefore.collateralBalance.add(TRANSFER_AMOUNT));
    });

    it('preserves sender collateral membership for the remaining position', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(senderBefore.assetsIn);
    });

    it('sets the recipient collateral membership bit', async () => {
      expect((await comet.userBasic(recipient.address)).assetsIn).to.equal(recipientBefore.assetsIn | recipientBefore.assetMask);
    });

    it('preserves the market total supplied collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(senderBefore.totalSupplyAsset);
    });

    it('preserves the sender collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(senderBefore.userCollateralBalance);
    });

    it('preserves the sender base ERC20 balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(senderBefore.userBaseBalance);
    });

    it('preserves the sender collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(senderBefore.userCollateralReserved);
    });

    it('preserves sender userBasic.principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(senderBefore.principal);
    });

    it('preserves sender userBasic.baseTrackingIndex', async () => {
      expect((await comet.userBasic(user.address)).baseTrackingIndex).to.equal(senderBefore.baseTrackingIndex);
    });

    it('preserves sender userBasic._reserved', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(senderBefore.userReserved);
    });

    it('preserves the recipient collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(recipient.address)).to.equal(recipientBefore.userCollateralBalance);
    });

    it('preserves the recipient base ERC20 balance', async () => {
      expect(await base.balanceOf(recipient.address)).to.equal(recipientBefore.userBaseBalance);
    });

    it('preserves the recipient collateral reserved field', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address))._reserved).to.equal(recipientBefore.userCollateralReserved);
    });

    it('preserves recipient userBasic.principal', async () => {
      expect((await comet.userBasic(recipient.address)).principal).to.equal(recipientBefore.principal);
    });

    it('preserves recipient userBasic.baseTrackingIndex', async () => {
      expect((await comet.userBasic(recipient.address)).baseTrackingIndex).to.equal(recipientBefore.baseTrackingIndex);
    });

    it('preserves recipient userBasic._reserved', async () => {
      expect((await comet.userBasic(recipient.address))._reserved).to.equal(recipientBefore.userReserved);
    });

    it('preserves totalsBasic.baseSupplyIndex', async () => {
      expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(senderBefore.baseSupplyIndex);
    });

    it('preserves totalsBasic.baseBorrowIndex', async () => {
      expect((await comet.totalsBasic()).baseBorrowIndex).to.equal(senderBefore.baseBorrowIndex);
    });

    it('preserves totalsBasic.totalSupplyBase', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(senderBefore.totalSupplyBase);
    });

    it('preserves totalsBasic.totalBorrowBase', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(senderBefore.totalBorrowBase);
    });

    it('preserves the Comet collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(senderBefore.cometCollateralBalance);
    });

    it('preserves the Comet base ERC20 balance', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(senderBefore.cometBaseBalance);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(senderBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(senderBefore.tokenSupply);
    });
  });

  context('transfer the full collateral position deposited at the initial price after the price becomes 1 wei', function () {
    const SUPPLY_AMOUNT = collateralUnits(1);
    const DEPOSIT_AMOUNT = 2n * SUPPLY_AMOUNT;
    const TRANSFER_AMOUNT = DEPOSIT_AMOUNT;
    let senderBefore: SupplyState;
    let recipientBefore: SupplyState;

    before(async () => {
      await collateral.allocateTo(user.address, 3n * SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, DEPOSIT_AMOUNT);

      await comet.connect(user).supply(collateral.address, DEPOSIT_AMOUNT);
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);
      senderBefore = await readSupplyState(user);
      recipientBefore = await readSupplyState(recipient);
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('transfers the full collateral position priced at 1 wei to the recipient', async () => {
      await comet.connect(user).transferAsset(recipient.address, collateral.address, TRANSFER_AMOUNT);
    });

    it('clears the sender collateral position after transferring the full amount', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(0);
    });

    it('credits the recipient collateral position by the transferred amount', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address)).balance).to.equal(recipientBefore.collateralBalance.add(TRANSFER_AMOUNT));
    });

    it('clears the sender collateral membership bit', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(senderBefore.assetsIn & ~senderBefore.assetMask);
    });

    it('sets the recipient collateral membership bit', async () => {
      expect((await comet.userBasic(recipient.address)).assetsIn).to.equal(recipientBefore.assetsIn | recipientBefore.assetMask);
    });

    it('preserves the market total supplied collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(senderBefore.totalSupplyAsset);
    });

    it('preserves the sender collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(senderBefore.userCollateralBalance);
    });

    it('preserves the sender base ERC20 balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(senderBefore.userBaseBalance);
    });

    it('preserves the sender collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(senderBefore.userCollateralReserved);
    });

    it('preserves sender userBasic.principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(senderBefore.principal);
    });

    it('preserves sender userBasic.baseTrackingIndex', async () => {
      expect((await comet.userBasic(user.address)).baseTrackingIndex).to.equal(senderBefore.baseTrackingIndex);
    });

    it('preserves sender userBasic._reserved', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(senderBefore.userReserved);
    });

    it('preserves the recipient collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(recipient.address)).to.equal(recipientBefore.userCollateralBalance);
    });

    it('preserves the recipient base ERC20 balance', async () => {
      expect(await base.balanceOf(recipient.address)).to.equal(recipientBefore.userBaseBalance);
    });

    it('preserves the recipient collateral reserved field', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address))._reserved).to.equal(recipientBefore.userCollateralReserved);
    });

    it('preserves recipient userBasic.principal', async () => {
      expect((await comet.userBasic(recipient.address)).principal).to.equal(recipientBefore.principal);
    });

    it('preserves recipient userBasic.baseTrackingIndex', async () => {
      expect((await comet.userBasic(recipient.address)).baseTrackingIndex).to.equal(recipientBefore.baseTrackingIndex);
    });

    it('preserves recipient userBasic._reserved', async () => {
      expect((await comet.userBasic(recipient.address))._reserved).to.equal(recipientBefore.userReserved);
    });

    it('preserves totalsBasic.baseSupplyIndex', async () => {
      expect((await comet.totalsBasic()).baseSupplyIndex).to.equal(senderBefore.baseSupplyIndex);
    });

    it('preserves totalsBasic.baseBorrowIndex', async () => {
      expect((await comet.totalsBasic()).baseBorrowIndex).to.equal(senderBefore.baseBorrowIndex);
    });

    it('preserves totalsBasic.totalSupplyBase', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(senderBefore.totalSupplyBase);
    });

    it('preserves totalsBasic.totalBorrowBase', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(senderBefore.totalBorrowBase);
    });

    it('preserves the Comet collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(senderBefore.cometCollateralBalance);
    });

    it('preserves the Comet base ERC20 balance', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(senderBefore.cometBaseBalance);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(senderBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(senderBefore.tokenSupply);
    });
  });

  /**
   * Borrow sizing for this USDC fixture:
   * - USDC is worth $1; the collateral USD feed has 8 decimals.
   * - A raw oracle answer of 1 means $0.00000001 per whole collateral token.
   * - borrowCF = 80%, so each token supports 0.000000008 USDC of borrowing.
   * - Required whole tokens = borrow in USDC / (0.00000001 * 0.8).
   *
   * | baseBorrowMin / intended borrow | Required collateral tokens |
   * |--------------------------------|----------------------------|
   * | 1 USDC                         |                125,000,000 |
   * | 100 USDC                       |             12,500,000,000 |
   * | 1,000 USDC                     |            125,000,000,000 |
   *
   * These are nominal collateral thresholds, before debt/index rounding or
   * subsequent interest. Use a buffer: this test supplies 200,000,000 tokens,
   * supporting 1.6 USDC, to borrow 1 USDC. Its supply cap is also 200,000,000;
   * the 100/1,000 USDC examples would require a higher cap as well as supply.
   * Amounts above are whole tokens; this 18-decimal fixture multiplies by 1e18.
   *
   * Why this cannot be reproduced with properly backed pumpBTC under these
   * USD-price assumptions: pumpBTC is designed to be backed 1:1 by BTC. Even
   * backing it with Bitcoin's entire 21,000,000 BTC supply would support only
   * 0.168 USDC here, below the 1 USDC minimum. Obtaining 125,000,000 backed
   * pumpBTC is therefore impossible under that backing model. FaucetToken
   * can mint arbitrary test balances, which is what makes this test feasible.
   * Sources:
   * https://pumpbtc.gitbook.io/pumpbtc/tech-specs/how-does-pumpbtc-work
   * https://bitcoin.org/en/faq#how-are-bitcoins-created
   *
   * This is a hypothetical pumpBTC/USD comparison, not the deployed pumpBTC
   * market's parameters. deployments/mainnet/wbtc/configuration.json specifies
   * 8 token decimals and a 75% borrowCF; its deploy.ts uses a pumpBTC/BTC feed.
   * A raw answer of 1 on that BTC-denominated feed has different USD value.
   * Token decimals change raw token units, not the whole-token amounts above.
   */
  context('transfer 1 USDC and become a borrower after the collateral price drops to 1 wei', function () {
    const SUPPLY_AMOUNT = collateralUnits(200_000_000);
    const TRANSFER_AMOUNT = exp(1, 6);
    const BASE_INDEX_SCALE = exp(1, 15);
    let senderBefore: SupplyState;
    let recipientBefore: SupplyState;
    let expectedBorrowPrincipal: BigNumber;
    let expectedSupplyPrincipal: BigNumber;

    before(async () => {
      await collateral.allocateTo(user.address, SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, SUPPLY_AMOUNT);
      await base.allocateTo(comet.address, exp(10, 6));

      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);

      senderBefore = await readSupplyState(user);
      recipientBefore = await readSupplyState(recipient);
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('transfers 1 USDC to the recipient by opening a borrow', async () => {
      await comet.connect(user).transferAsset(recipient.address, base.address, TRANSFER_AMOUNT);
      const totals = await comet.totalsBasic();
      // Debt principal rounds up; supply principal rounds down.
      const scaledAmount = BigNumber.from(TRANSFER_AMOUNT).mul(BASE_INDEX_SCALE);
      expectedBorrowPrincipal = scaledAmount.add(totals.baseBorrowIndex).sub(1).div(totals.baseBorrowIndex);
      expectedSupplyPrincipal = scaledAmount.div(totals.baseSupplyIndex);
    });

    it('records the sender negative base principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(expectedBorrowPrincipal.mul(-1));
    });

    it('records a 1 USDC borrow balance for the sender', async () => {
      expect(await comet.borrowBalanceOf(user.address)).to.equal(TRANSFER_AMOUNT);
    });

    it('records the recipient positive base principal', async () => {
      expect((await comet.userBasic(recipient.address)).principal).to.equal(expectedSupplyPrincipal);
    });

    it('credits the recipient with a 1 USDC Comet balance', async () => {
      expect(await comet.balanceOf(recipient.address)).to.equal(TRANSFER_AMOUNT);
    });

    it('keeps the sender borrow collateralized at the 1 wei price', async () => {
      expect(await comet.isBorrowCollateralized(user.address)).to.equal(true);
    });

    it('increases total base borrow principal by the new debt', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(senderBefore.totalBorrowBase.add(expectedBorrowPrincipal));
    });

    it('increases total base supply principal by the recipient credit', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(senderBefore.totalSupplyBase.add(expectedSupplyPrincipal));
    });

    it('preserves the sender collateral position', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(senderBefore.collateralBalance);
    });

    it('preserves the sender collateral membership', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(senderBefore.assetsIn);
    });

    it('preserves the sender collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(senderBefore.userCollateralBalance);
    });

    it('preserves the sender base ERC20 balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(senderBefore.userBaseBalance);
    });

    it('preserves the sender collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(senderBefore.userCollateralReserved);
    });

    it('preserves sender userBasic._reserved', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(senderBefore.userReserved);
    });

    it('preserves the recipient collateral position', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address)).balance).to.equal(recipientBefore.collateralBalance);
    });

    it('preserves the recipient collateral membership', async () => {
      expect((await comet.userBasic(recipient.address)).assetsIn).to.equal(recipientBefore.assetsIn);
    });

    it('preserves the recipient collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(recipient.address)).to.equal(recipientBefore.userCollateralBalance);
    });

    it('preserves the recipient base ERC20 balance', async () => {
      expect(await base.balanceOf(recipient.address)).to.equal(recipientBefore.userBaseBalance);
    });

    it('preserves the recipient collateral reserved field', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address))._reserved).to.equal(recipientBefore.userCollateralReserved);
    });

    it('preserves recipient userBasic._reserved', async () => {
      expect((await comet.userBasic(recipient.address))._reserved).to.equal(recipientBefore.userReserved);
    });

    it('preserves the market total supplied collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(senderBefore.totalSupplyAsset);
    });

    it('preserves the Comet collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(senderBefore.cometCollateralBalance);
    });

    it('preserves the Comet base ERC20 balance', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(senderBefore.cometBaseBalance);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(senderBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(senderBefore.tokenSupply);
    });
  });

  /**
   * Flow amounts (USDC = $1):
   * - Supply 10 backing tokens at $10 each (oracle answer 10e8): $100 supplied.
   * - At 80% borrowCF / 85% liquidateCF, that collateral alone supports $80
   *   of borrowing and a liquidation threshold of $85.
   * - Also supply 50,000 TOKEN, then change its raw USD price to 1 (1e-8 USD).
   *   Its total value after the drop is $0.0005.
   * - In before: withdraw/borrow $25 USDC into the sender's wallet.
   * - In the first action test: transfer $10 of Comet base balance to the
   *   recipient, increasing sender debt from $25 to $35 (before interest).
   * - In the second action test: transfer all 50,000 of the 1 wei TOKEN to
   *   the recipient. The sender retains the entire $100 backing position.
   * - Remaining $35 debt is below both $80 and $85, so the sender remains
   *   borrow-collateralized and non-liquidatable. Both internal transfers
   *   leave wallet ERC20 balances unchanged from their post-setup values.
   */
  context('borrow 25 USDC, transfer 10 more USDC, then transfer all 1 wei collateral', function () {
    const SUPPLY_AMOUNT = collateralUnits(50_000);
    const BACKING_SUPPLY_AMOUNT = exp(10, 18);
    const INITIAL_BORROW_AMOUNT = exp(25, 6);
    const BASE_TRANSFER_AMOUNT = exp(10, 6);
    const TOTAL_BORROW_AMOUNT = INITIAL_BORROW_AMOUNT + BASE_TRANSFER_AMOUNT;
    const BASE_INDEX_SCALE = exp(1, 15);
    let senderBefore: SupplyState;
    let recipientBefore: SupplyState;
    let senderBackingBefore: SupplyState;
    let recipientBackingBefore: SupplyState;
    let expectedBorrowPrincipal: BigNumber;
    let expectedSupplyPrincipal: BigNumber;

    before(async () => {
      await collateral.allocateTo(user.address, SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
      await backingCollateral.allocateTo(user.address, BACKING_SUPPLY_AMOUNT);
      await backingCollateral.connect(user).approve(comet.address, BACKING_SUPPLY_AMOUNT);
      await comet.connect(user).supply(backingCollateral.address, BACKING_SUPPLY_AMOUNT);
      await base.allocateTo(comet.address, exp(100, 6));
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);
      await comet.connect(user).withdraw(base.address, INITIAL_BORROW_AMOUNT);

      senderBefore = await readSupplyState(user);
      recipientBefore = await readSupplyState(recipient);
      senderBackingBefore = await readSupplyState(user, backingCollateral);
      recipientBackingBefore = await readSupplyState(recipient, backingCollateral);
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('transfers 10 USDC to the recipient by increasing the existing borrow', async () => {
      await comet.connect(user).transferAsset(recipient.address, base.address, BASE_TRANSFER_AMOUNT);
      const totals = await comet.totalsBasic();
      const scaledAmount = BigNumber.from(BASE_TRANSFER_AMOUNT).mul(BASE_INDEX_SCALE);
      const previousDebt = senderBefore.principal.mul(-1).mul(totals.baseBorrowIndex).div(BASE_INDEX_SCALE);
      const scaledDebt = previousDebt.add(BASE_TRANSFER_AMOUNT).mul(BASE_INDEX_SCALE);
      expectedBorrowPrincipal = scaledDebt.add(totals.baseBorrowIndex).sub(1).div(totals.baseBorrowIndex);
      expectedSupplyPrincipal = scaledAmount.div(totals.baseSupplyIndex);
    });

    it('records a 35 USDC borrow before the collateral transfer', async () => {
      expect(await comet.borrowBalanceOf(user.address)).to.equal(TOTAL_BORROW_AMOUNT);
    });

    it('credits the recipient with 10 USDC before the collateral transfer', async () => {
      expect(await comet.balanceOf(recipient.address)).to.equal(BASE_TRANSFER_AMOUNT);
    });

    it('keeps the borrower non-liquidatable before the collateral transfer', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(false);
    });

    it('transfers all 1 wei collateral while the sender has an outstanding borrow', async () => {
      await comet.connect(user).transferAsset(recipient.address, collateral.address, SUPPLY_AMOUNT);
    });

    it('clears the sender 1 wei collateral position', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(0);
    });

    it('credits the recipient with all transferred collateral', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address)).balance).to.equal(recipientBefore.collateralBalance.add(SUPPLY_AMOUNT));
    });

    it('clears only the sender 1 wei collateral membership bit', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(senderBefore.assetsIn & ~senderBefore.assetMask);
    });

    it('retains sender membership in the backing collateral', async () => {
      expect((await comet.userBasic(user.address)).assetsIn & senderBackingBefore.assetMask).to.equal(senderBackingBefore.assetMask);
    });

    it('sets the recipient 1 wei collateral membership bit', async () => {
      expect((await comet.userBasic(recipient.address)).assetsIn).to.equal(recipientBefore.assetsIn | recipientBefore.assetMask);
    });

    it('preserves the sender negative base principal after the collateral transfer', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(expectedBorrowPrincipal.mul(-1));
    });

    it('preserves the sender debt plus elapsed interest after the collateral transfer', async () => {
      const totals = await comet.totalsBasic();
      const { timestamp } = await ethers.provider.getBlock('latest');
      const rate = await comet.getBorrowRate(await comet.getUtilization());
      const index = totals.baseBorrowIndex.add(
        totals.baseBorrowIndex.mul(rate).mul(timestamp - totals.lastAccrualTime).div(exp(1, 18))
      );
      expect(await comet.borrowBalanceOf(user.address)).to.equal(expectedBorrowPrincipal.mul(index).div(BASE_INDEX_SCALE));
    });

    it('preserves the recipient positive base principal after the collateral transfer', async () => {
      expect((await comet.userBasic(recipient.address)).principal).to.equal(expectedSupplyPrincipal);
    });

    it('preserves the recipient base balance plus elapsed interest after the collateral transfer', async () => {
      const totals = await comet.totalsBasic();
      const { timestamp } = await ethers.provider.getBlock('latest');
      const rate = await comet.getSupplyRate(await comet.getUtilization());
      const index = totals.baseSupplyIndex.add(
        totals.baseSupplyIndex.mul(rate).mul(timestamp - totals.lastAccrualTime).div(exp(1, 18))
      );
      expect(await comet.balanceOf(recipient.address)).to.equal(expectedSupplyPrincipal.mul(index).div(BASE_INDEX_SCALE));
    });

    it('keeps the borrower collateralized with only the normal-price collateral', async () => {
      expect(await comet.isBorrowCollateralized(user.address)).to.equal(true);
    });

    it('keeps the borrower non-liquidatable after transferring all 1 wei collateral', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(false);
    });

    it('records only the base transfer increase in total borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(senderBefore.totalBorrowBase.add(expectedBorrowPrincipal).add(senderBefore.principal));
    });

    it('records only the base transfer increase in total supply principal', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(senderBefore.totalSupplyBase.add(expectedSupplyPrincipal));
    });

    it('preserves the sender normal-price collateral position', async () => {
      expect((await comet.userCollateral(user.address, backingCollateral.address)).balance).to.equal(senderBackingBefore.collateralBalance);
    });

    it('preserves the sender base ERC20 balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(senderBefore.userBaseBalance);
    });

    it('preserves sender userBasic._reserved', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(senderBefore.userReserved);
    });

    it('preserves the sender 1 wei collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(senderBefore.userCollateralBalance);
    });

    it('preserves the sender 1 wei collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(senderBefore.userCollateralReserved);
    });

    it('preserves the sender backing collateral ERC20 balance', async () => {
      expect(await backingCollateral.balanceOf(user.address)).to.equal(senderBackingBefore.userCollateralBalance);
    });

    it('preserves the sender backing collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, backingCollateral.address))._reserved).to.equal(senderBackingBefore.userCollateralReserved);
    });

    it('preserves the recipient normal-price collateral position', async () => {
      expect((await comet.userCollateral(recipient.address, backingCollateral.address)).balance).to.equal(recipientBackingBefore.collateralBalance);
    });

    it('preserves the recipient base ERC20 balance', async () => {
      expect(await base.balanceOf(recipient.address)).to.equal(recipientBefore.userBaseBalance);
    });

    it('preserves recipient userBasic._reserved', async () => {
      expect((await comet.userBasic(recipient.address))._reserved).to.equal(recipientBefore.userReserved);
    });

    it('preserves the recipient 1 wei collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(recipient.address)).to.equal(recipientBefore.userCollateralBalance);
    });

    it('preserves the recipient 1 wei collateral reserved field', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address))._reserved).to.equal(recipientBefore.userCollateralReserved);
    });

    it('preserves the recipient backing collateral ERC20 balance', async () => {
      expect(await backingCollateral.balanceOf(recipient.address)).to.equal(recipientBackingBefore.userCollateralBalance);
    });

    it('preserves the recipient backing collateral reserved field', async () => {
      expect((await comet.userCollateral(recipient.address, backingCollateral.address))._reserved).to.equal(recipientBackingBefore.userCollateralReserved);
    });

    it('preserves the market total supplied 1 wei collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(senderBefore.totalSupplyAsset);
    });

    it('preserves the Comet 1 wei collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(senderBefore.cometCollateralBalance);
    });

    it('preserves the market 1 wei collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(senderBefore.totalsCollateralReserved);
    });

    it('preserves the 1 wei collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(senderBefore.tokenSupply);
    });

    it('preserves the market total supplied backing collateral', async () => {
      expect((await comet.totalsCollateral(backingCollateral.address)).totalSupplyAsset).to.equal(senderBackingBefore.totalSupplyAsset);
    });

    it('preserves the Comet backing collateral ERC20 balance', async () => {
      expect(await backingCollateral.balanceOf(comet.address)).to.equal(senderBackingBefore.cometCollateralBalance);
    });

    it('preserves the market backing collateral reserved field', async () => {
      expect((await comet.totalsCollateral(backingCollateral.address))._reserved).to.equal(senderBackingBefore.totalsCollateralReserved);
    });

    it('preserves the backing collateral ERC20 total supply', async () => {
      expect(await backingCollateral.totalSupply()).to.equal(senderBackingBefore.tokenSupply);
    });

    it('preserves the Comet base ERC20 balance', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(senderBefore.cometBaseBalance);
    });

    it('preserves the backing collateral normal price after both transfers', async () => {
      expect(await comet.getPrice((await comet.getAssetInfoByAddress(backingCollateral.address)).priceFeed)).to.equal(exp(10, 8));
    });
  });

  /**
   * Supply 200,000,000 collateral tokens at the initial price, then set the
   * USD oracle answer to 1 ($0.00000001 per token). Their value becomes $2;
   * at 80% borrowCF they support $1.60 of debt. Borrow 1 USDC into the user's
   * wallet via withdraw(base, amount), Comet's entry point for direct borrowing.
   *
   * This synthetic faucet-token case cannot be reproduced with properly
   * BTC-backed pumpBTC under these USD-price assumptions: even the nominal
   * minimum of 125,000,000 tokens for a $1 borrow exceeds Bitcoin's entire
   * 21,000,000 BTC supply, while pumpBTC is designed to be backed 1:1 by BTC.
   * See the borrow-sizing table above. The repository's actual pumpBTC market
   * uses a BTC-denominated feed and different parameters; this is a hypothetical
   * pumpBTC/USD comparison, not a claim about that market's borrow threshold.
   * Sources:
   * https://pumpbtc.gitbook.io/pumpbtc/tech-specs/how-does-pumpbtc-work
   * https://bitcoin.org/en/faq#how-are-bitcoins-created
   */
  context('borrow 1 USDC directly after supplying collateral and dropping its price to 1 wei', function () {
    const SUPPLY_AMOUNT = collateralUnits(200_000_000);
    const BORROW_AMOUNT = exp(1, 6);
    const BASE_INDEX_SCALE = exp(1, 15);
    let stateBefore: SupplyState;
    let baseTokenSupplyBefore: BigNumber;
    let expectedBorrowPrincipal: BigNumber;

    before(async () => {
      await collateral.allocateTo(user.address, SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);
      await base.allocateTo(comet.address, exp(10, 6));
      stateBefore = await readSupplyState(user);
      baseTokenSupplyBefore = await base.totalSupply();
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('borrows 1 USDC into the user wallet through withdraw', async () => {
      await comet.connect(user).withdraw(base.address, BORROW_AMOUNT);
      const totals = await comet.totalsBasic();
      const scaledAmount = BigNumber.from(BORROW_AMOUNT).mul(BASE_INDEX_SCALE);
      expectedBorrowPrincipal = scaledAmount.add(totals.baseBorrowIndex).sub(1).div(totals.baseBorrowIndex);
    });

    it('records the user negative base principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(expectedBorrowPrincipal.mul(-1));
    });

    it('records a 1 USDC borrow balance for the user', async () => {
      expect(await comet.borrowBalanceOf(user.address)).to.equal(BORROW_AMOUNT);
    });

    it('leaves the user with no supplied Comet base balance', async () => {
      expect(await comet.balanceOf(user.address)).to.equal(0);
    });

    it('increases total base borrow principal by the new debt', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(stateBefore.totalBorrowBase.add(expectedBorrowPrincipal));
    });

    it('preserves total base supply principal', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(stateBefore.totalSupplyBase);
    });

    it('credits the user base ERC20 balance with the borrowed USDC', async () => {
      expect(await base.balanceOf(user.address)).to.equal(stateBefore.userBaseBalance.add(BORROW_AMOUNT));
    });

    it('debits the Comet base ERC20 balance by the borrowed USDC', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(stateBefore.cometBaseBalance.sub(BORROW_AMOUNT));
    });

    it('preserves the base ERC20 total supply', async () => {
      expect(await base.totalSupply()).to.equal(baseTokenSupplyBefore);
    });

    it('keeps the borrow collateralized at the 1 wei collateral price', async () => {
      expect(await comet.isBorrowCollateralized(user.address)).to.equal(true);
    });

    it('keeps the borrower non-liquidatable', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(false);
    });

    it('preserves the user collateral position', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(stateBefore.collateralBalance);
    });

    it('preserves the user collateral membership', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(stateBefore.assetsIn);
    });

    it('preserves the user collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(stateBefore.userCollateralBalance);
    });

    it('preserves the Comet collateral ERC20 balance', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(stateBefore.cometCollateralBalance);
    });

    it('preserves the market total supplied collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(stateBefore.totalSupplyAsset);
    });

    it('preserves the user collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(stateBefore.userCollateralReserved);
    });

    it('preserves userBasic._reserved', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(stateBefore.userReserved);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(stateBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(stateBefore.tokenSupply);
    });
  });


  /**
   * Start with 10 normal-price backing tokens at $10: $100 supplied, allowing
   * $80 of borrowing at 80% borrowCF. Borrow that $80 in before.
   * A further 100 raw USDC units (0.0001 USDC; USDC has 6 decimals) must fail
   * while only that normal collateral backs the debt.
   * Then supply 50,000 tokens at raw USD price 1: $0.0005 of collateral adds
   * $0.0004 = 400 raw USDC units of borrowing capacity at 80% borrowCF.
   * Retry the same 100-unit withdrawal: it should now succeed, with a small
   * buffer for interest and rounding. baseBorrowMin constrains the resulting
   * total debt, not each increase, so an existing $80 debt can grow by < $1.
   *
   * The theoretical minimum for 1 additional raw USDC unit (0.000001 USDC)
   * is 125 whole collateral tokens, or 125 * 1e18 raw collateral units:
   * 125 * 1e-8 USD * 80% = 0.000001 USD = 1 raw USDC unit.
   * This assumes existing debt is exactly at the normal collateral's borrow
   * limit. Accrued interest and principal rounding can require more tokens.
   */
  context('supply 1 wei collateral to increase borrowing capacity on an existing normal-collateral debt', function () {
    const SUPPLY_AMOUNT = collateralUnits(50_000);
    const BACKING_SUPPLY_AMOUNT = exp(10, 18);
    const INITIAL_BORROW_AMOUNT = exp(80, 6);
    const EXTRA_BORROW_AMOUNT = 100n;
    const BASE_INDEX_SCALE = exp(1, 15);
    let stateBefore: SupplyState;
    let backingBefore: SupplyState;
    let baseTokenSupplyBefore: BigNumber;
    let expectedBorrowPrincipal: BigNumber;
    let expectedDebt: BigNumber;

    before(async () => {
      await backingCollateral.allocateTo(user.address, BACKING_SUPPLY_AMOUNT);
      await backingCollateral.connect(user).approve(comet.address, BACKING_SUPPLY_AMOUNT);
      await comet.connect(user).supply(backingCollateral.address, BACKING_SUPPLY_AMOUNT);
      await base.allocateTo(comet.address, exp(100, 6));
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);
      await collateral.allocateTo(user.address, SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(user).withdraw(base.address, INITIAL_BORROW_AMOUNT);
      stateBefore = await readSupplyState(user);
      backingBefore = await readSupplyState(user, backingCollateral);
      baseTokenSupplyBefore = await base.totalSupply();
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('rejects the extra 100-unit borrow before supplying the 1 wei collateral', async () => {
      await expect(comet.connect(user).withdraw(base.address, EXTRA_BORROW_AMOUNT))
        .to.be.revertedWithCustomError(comet, 'NotCollateralized');
    });

    it('preserves debt principal after the rejected borrow', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(stateBefore.principal);
    });

    it('preserves the user base ERC20 balance after the rejected borrow', async () => {
      expect(await base.balanceOf(user.address)).to.equal(stateBefore.userBaseBalance);
    });

    it('preserves the Comet base ERC20 balance after the rejected borrow', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(stateBefore.cometBaseBalance);
    });

    it('supplies 50,000 tokens at a 1 wei price while already borrowing', async () => {
      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
    });

    it('credits the user with the supplied 1 wei collateral', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(stateBefore.collateralBalance.add(SUPPLY_AMOUNT));
    });

    it('increases total supplied 1 wei collateral by the deposit', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(stateBefore.totalSupplyAsset.add(SUPPLY_AMOUNT));
    });

    it('adds the 1 wei collateral membership without removing the backing collateral', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(stateBefore.assetsIn | stateBefore.assetMask);
    });

    it('debits the user collateral ERC20 balance by the deposit', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(stateBefore.userCollateralBalance.sub(SUPPLY_AMOUNT));
    });

    it('credits the Comet collateral ERC20 balance by the deposit', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(stateBefore.cometCollateralBalance.add(SUPPLY_AMOUNT));
    });

    it('preserves the existing debt principal during collateral supply', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(stateBefore.principal);
    });

    it('allows the same 100-unit borrow after supplying the 1 wei collateral', async () => {
      await comet.connect(user).withdraw(base.address, EXTRA_BORROW_AMOUNT);
      const totals = await comet.totalsBasic();
      const previousDebt = stateBefore.principal.mul(-1).mul(totals.baseBorrowIndex).div(BASE_INDEX_SCALE);
      const scaledDebt = previousDebt.add(EXTRA_BORROW_AMOUNT).mul(BASE_INDEX_SCALE);
      expectedBorrowPrincipal = scaledDebt.add(totals.baseBorrowIndex).sub(1).div(totals.baseBorrowIndex);
      expectedDebt = expectedBorrowPrincipal.mul(totals.baseBorrowIndex).div(BASE_INDEX_SCALE);
    });

    it('records the increased negative debt principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(expectedBorrowPrincipal.mul(-1));
    });

    it('records the additional debt with principal rounding', async () => {
      expect(await comet.borrowBalanceOf(user.address)).to.equal(expectedDebt);
    });

    it('increases total borrow principal only by the additional borrowing', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(stateBefore.totalBorrowBase.add(expectedBorrowPrincipal).add(stateBefore.principal));
    });

    it('credits exactly 100 additional USDC units to the user wallet', async () => {
      expect(await base.balanceOf(user.address)).to.equal(stateBefore.userBaseBalance.add(EXTRA_BORROW_AMOUNT));
    });

    it('debits exactly 100 additional USDC units from Comet', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(stateBefore.cometBaseBalance.sub(EXTRA_BORROW_AMOUNT));
    });

    it('keeps the increased debt collateralized', async () => {
      expect(await comet.isBorrowCollateralized(user.address)).to.equal(true);
    });

    it('keeps the borrower non-liquidatable', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(false);
    });

    it('preserves total base supply principal', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(stateBefore.totalSupplyBase);
    });

    it('preserves the base ERC20 total supply', async () => {
      expect(await base.totalSupply()).to.equal(baseTokenSupplyBefore);
    });

    it('preserves userBasic._reserved', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(stateBefore.userReserved);
    });

    it('preserves the backing collateral position', async () => {
      expect((await comet.userCollateral(user.address, backingCollateral.address)).balance).to.equal(backingBefore.collateralBalance);
    });

    it('preserves total supplied backing collateral', async () => {
      expect((await comet.totalsCollateral(backingCollateral.address)).totalSupplyAsset).to.equal(backingBefore.totalSupplyAsset);
    });

    it('preserves the user backing collateral ERC20 balance', async () => {
      expect(await backingCollateral.balanceOf(user.address)).to.equal(backingBefore.userCollateralBalance);
    });

    it('preserves the Comet backing collateral ERC20 balance', async () => {
      expect(await backingCollateral.balanceOf(comet.address)).to.equal(backingBefore.cometCollateralBalance);
    });

    it('preserves the user 1 wei collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(stateBefore.userCollateralReserved);
    });

    it('preserves the market 1 wei collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(stateBefore.totalsCollateralReserved);
    });

    it('preserves the 1 wei collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(stateBefore.tokenSupply);
    });

    it('preserves the user backing collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, backingCollateral.address))._reserved).to.equal(backingBefore.userCollateralReserved);
    });

    it('preserves the market backing collateral reserved field', async () => {
      expect((await comet.totalsCollateral(backingCollateral.address))._reserved).to.equal(backingBefore.totalsCollateralReserved);
    });

    it('preserves the backing collateral ERC20 total supply', async () => {
      expect(await backingCollateral.totalSupply()).to.equal(backingBefore.tokenSupply);
    });
  });

  /**
   * Supply 1 token at $85,000: 80% borrowCF gives $68,000 borrowing power.
   * Borrow 50% of that power ($34,000), then set the collateral price to 1
   * raw USD oracle unit ($0.00000001). The borrower becomes liquidatable.
   * Absorb must seize the entire position and cancel the debt against protocol
   * reserves. Collateral stays in Comet as protocol-owned collateral reserves;
   * the absorber receives accounting points, not the seized ERC20 tokens.
   */
  context('absorb a borrower at 50% of initial borrowing power after collateral drops to 1 wei', function () {
    const SUPPLY_AMOUNT = collateralUnits(1);
    let borrowAmount: BigNumber;
    let stateBefore: SupplyState;
    let absorberBefore: SupplyState;
    let collateralReservesBefore: BigNumber;
    let baseTokenSupplyBefore: BigNumber;
    let numAbsorbsBefore: number;
    let numAbsorbedBefore: BigNumber;
    let approxSpendBefore: BigNumber;
    let pointsReservedBefore: number;

    before(async () => {
      await collateral.allocateTo(user.address, SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
      await base.allocateTo(comet.address, exp(100_000, 6));

      const asset = await comet.getAssetInfoByAddress(collateral.address);
      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const borrowPower = BigNumber.from(SUPPLY_AMOUNT)
        .mul(await comet.getPrice(asset.priceFeed)).div(asset.scale)
        .mul(asset.borrowCollateralFactor).div(exp(1, 18))
        .mul(exp(1, 6)).div(basePrice);
      borrowAmount = borrowPower.div(2);
      await comet.connect(user).withdraw(base.address, borrowAmount);
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);

      stateBefore = await readSupplyState(user);
      absorberBefore = await readSupplyState(recipient);
      collateralReservesBefore = await comet.getCollateralReserves(collateral.address);
      baseTokenSupplyBefore = await base.totalSupply();
      const points = await comet.liquidatorPoints(recipient.address);
      numAbsorbsBefore = points.numAbsorbs;
      numAbsorbedBefore = points.numAbsorbed;
      approxSpendBefore = points.approxSpend;
      pointsReservedBefore = points._reserved;
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('makes the borrower liquidatable after the price drop', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(true);
    });

    it('makes the existing debt insufficiently collateralized after the price drop', async () => {
      expect(await comet.isBorrowCollateralized(user.address)).to.equal(false);
    });

    it('absorbs the underwater borrower at the 1 wei collateral price', async () => {
      await comet.connect(recipient).absorb(recipient.address, [user.address]);
    });

    it('takes the entire collateral position from the borrower', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(0);
    });

    it('removes the seized amount from total supplied collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(stateBefore.totalSupplyAsset.sub(SUPPLY_AMOUNT));
    });

    it('adds all seized collateral to protocol collateral reserves', async () => {
      expect(await comet.getCollateralReserves(collateral.address)).to.equal(collateralReservesBefore.add(SUPPLY_AMOUNT));
    });

    it('clears the borrower collateral membership', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(0);
    });

    it('clears the borrower extended collateral membership', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(0);
    });

    it('clears the borrower base principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(0);
    });

    it('clears the entire borrower debt', async () => {
      expect(await comet.borrowBalanceOf(user.address)).to.equal(0);
    });

    it('does not credit a positive base balance for collateral worth less than the debt', async () => {
      expect(await comet.balanceOf(user.address)).to.equal(0);
    });

    it('removes the absorbed debt principal from total borrows', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(stateBefore.totalBorrowBase.add(stateBefore.principal));
    });

    it('preserves total base supply principal when all collateral value is consumed by debt', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(stateBefore.totalSupplyBase);
    });

    it('leaves base reserves equal to remaining cash after writing off the only loan', async () => {
      expect(await comet.getReserves()).to.equal(stateBefore.cometBaseBalance);
    });

    it('makes the absorbed account non-liquidatable', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(false);
    });

    it('leaves the absorbed account with no collateral shortfall', async () => {
      expect(await comet.isBorrowCollateralized(user.address)).to.equal(true);
    });

    it('increments the absorber successful absorption count', async () => {
      expect((await comet.liquidatorPoints(recipient.address)).numAbsorbs).to.equal(numAbsorbsBefore + 1);
    });

    it('increments the absorber absorbed-account count', async () => {
      expect((await comet.liquidatorPoints(recipient.address)).numAbsorbed).to.equal(numAbsorbedBefore.add(1));
    });

    it('records the absorber approximate gas spend', async () => {
      expect((await comet.liquidatorPoints(recipient.address)).approxSpend).to.be.gt(approxSpendBefore);
    });

    it('preserves the absorber points reserved field', async () => {
      expect((await comet.liquidatorPoints(recipient.address))._reserved).to.equal(pointsReservedBefore);
    });

    it('preserves the borrower collateral ERC20 wallet balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(stateBefore.userCollateralBalance);
    });

    it('preserves the borrower base ERC20 wallet balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(stateBefore.userBaseBalance);
    });

    it('keeps the seized collateral ERC20 tokens in Comet', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(stateBefore.cometCollateralBalance);
    });

    it('preserves the Comet base ERC20 balance during debt absorption', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(stateBefore.cometBaseBalance);
    });

    it('does not transfer collateral ERC20 tokens to the absorber', async () => {
      expect(await collateral.balanceOf(recipient.address)).to.equal(absorberBefore.userCollateralBalance);
    });

    it('does not charge or pay base ERC20 tokens to the absorber', async () => {
      expect(await base.balanceOf(recipient.address)).to.equal(absorberBefore.userBaseBalance);
    });

    it('does not credit the absorber with a Comet collateral position', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address)).balance).to.equal(absorberBefore.collateralBalance);
    });

    it('preserves the absorber base principal', async () => {
      expect((await comet.userBasic(recipient.address)).principal).to.equal(absorberBefore.principal);
    });

    it('preserves the absorber collateral membership', async () => {
      expect((await comet.userBasic(recipient.address)).assetsIn).to.equal(absorberBefore.assetsIn);
    });

    it('preserves the absorber extended collateral membership', async () => {
      expect((await comet.userBasic(recipient.address))._reserved).to.equal(absorberBefore.userReserved);
    });

    it('preserves the borrower collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(stateBefore.userCollateralReserved);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(stateBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(stateBefore.tokenSupply);
    });

    it('preserves the base ERC20 total supply', async () => {
      expect(await base.totalSupply()).to.equal(baseTokenSupplyBefore);
    });
  });

  /**
   * Initial positions and debt (USDC = $1, borrowCF = 80% for both assets):
   * | Collateral | Supplied | Price   | Value   | Borrow power | Borrow 50% |
   * | TOKEN      | 1 token  | $85,000 | $85,000 | $68,000      | $34,000    |
   * | BACKING    | 10 tokens| $10     | $100    | $80          | $40        |
   * Total debt is $34,040 before interest. Only TOKEN drops to raw USD price
   * 1 ($0.00000001); BACKING remains worth $100. At 85% liquidateCF, the
   * remaining liquidation threshold is approximately $85, far below the debt.
   * Absorb liquidates the account as a whole: both positions are seized, even
   * though BACKING's price is unchanged. Both become protocol collateral
   * reserves; the borrower's entire debt is cleared and the loss is absorbed
   * by the protocol. Wallet ERC20 balances do not change during absorption.
   */
  context('absorb both collateral positions when only the first asset price drops to 1 wei', function () {
    const SUPPLY_AMOUNT = collateralUnits(1);
    const BACKING_SUPPLY_AMOUNT = exp(10, 18);
    let borrowAmount: BigNumber;
    let stateBefore: SupplyState;
    let absorberBefore: SupplyState;
    let backingBefore: SupplyState;
    let absorberBackingBefore: SupplyState;
    let backingReservesBefore: BigNumber;
    let collateralReservesBefore: BigNumber;
    let baseTokenSupplyBefore: BigNumber;
    let numAbsorbsBefore: number;
    let numAbsorbedBefore: BigNumber;
    let approxSpendBefore: BigNumber;
    let pointsReservedBefore: number;

    before(async () => {
      await collateral.allocateTo(user.address, SUPPLY_AMOUNT);
      await collateral.connect(user).approve(comet.address, SUPPLY_AMOUNT);
      await comet.connect(user).supply(collateral.address, SUPPLY_AMOUNT);
      await backingCollateral.allocateTo(user.address, BACKING_SUPPLY_AMOUNT);
      await backingCollateral.connect(user).approve(comet.address, BACKING_SUPPLY_AMOUNT);
      await comet.connect(user).supply(backingCollateral.address, BACKING_SUPPLY_AMOUNT);
      await base.allocateTo(comet.address, exp(100_000, 6));

      const asset = await comet.getAssetInfoByAddress(collateral.address);
      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const borrowPower = BigNumber.from(SUPPLY_AMOUNT)
        .mul(await comet.getPrice(asset.priceFeed)).div(asset.scale)
        .mul(asset.borrowCollateralFactor).div(exp(1, 18))
        .mul(exp(1, 6)).div(basePrice);
      const backingAsset = await comet.getAssetInfoByAddress(backingCollateral.address);
      const backingBorrowPower = BigNumber.from(BACKING_SUPPLY_AMOUNT)
        .mul(await comet.getPrice(backingAsset.priceFeed)).div(backingAsset.scale)
        .mul(backingAsset.borrowCollateralFactor).div(exp(1, 18))
        .mul(exp(1, 6)).div(basePrice);
      borrowAmount = borrowPower.div(2).add(backingBorrowPower.div(2));
      await comet.connect(user).withdraw(base.address, borrowAmount);
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);

      stateBefore = await readSupplyState(user);
      absorberBefore = await readSupplyState(recipient);
      backingBefore = await readSupplyState(user, backingCollateral);
      absorberBackingBefore = await readSupplyState(recipient, backingCollateral);
      backingReservesBefore = await comet.getCollateralReserves(backingCollateral.address);
      collateralReservesBefore = await comet.getCollateralReserves(collateral.address);
      baseTokenSupplyBefore = await base.totalSupply();
      const points = await comet.liquidatorPoints(recipient.address);
      numAbsorbsBefore = points.numAbsorbs;
      numAbsorbedBefore = points.numAbsorbed;
      approxSpendBefore = points.approxSpend;
      pointsReservedBefore = points._reserved;
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('makes the borrower liquidatable after the price drop', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(true);
    });

    it('makes the existing debt insufficiently collateralized after the price drop', async () => {
      expect(await comet.isBorrowCollateralized(user.address)).to.equal(false);
    });

    it('absorbs the underwater borrower and seizes both collateral assets', async () => {
      await comet.connect(recipient).absorb(recipient.address, [user.address]);
    });

    it('takes the entire collateral position from the borrower', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(0);
    });

    it('removes the seized amount from total supplied collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(stateBefore.totalSupplyAsset.sub(SUPPLY_AMOUNT));
    });

    it('adds all seized collateral to protocol collateral reserves', async () => {
      expect(await comet.getCollateralReserves(collateral.address)).to.equal(collateralReservesBefore.add(SUPPLY_AMOUNT));
    });

    it('clears the borrower collateral membership', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(0);
    });

    it('clears the borrower extended collateral membership', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(0);
    });

    it('clears the borrower base principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(0);
    });

    it('clears the entire borrower debt', async () => {
      expect(await comet.borrowBalanceOf(user.address)).to.equal(0);
    });

    it('does not credit a positive base balance for collateral worth less than the debt', async () => {
      expect(await comet.balanceOf(user.address)).to.equal(0);
    });

    it('removes the absorbed debt principal from total borrows', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(stateBefore.totalBorrowBase.add(stateBefore.principal));
    });

    it('preserves total base supply principal when all collateral value is consumed by debt', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(stateBefore.totalSupplyBase);
    });

    it('leaves base reserves equal to remaining cash after writing off the only loan', async () => {
      expect(await comet.getReserves()).to.equal(stateBefore.cometBaseBalance);
    });

    it('makes the absorbed account non-liquidatable', async () => {
      expect(await comet.isLiquidatable(user.address)).to.equal(false);
    });

    it('leaves the absorbed account with no collateral shortfall', async () => {
      expect(await comet.isBorrowCollateralized(user.address)).to.equal(true);
    });

    it('increments the absorber successful absorption count', async () => {
      expect((await comet.liquidatorPoints(recipient.address)).numAbsorbs).to.equal(numAbsorbsBefore + 1);
    });

    it('increments the absorber absorbed-account count', async () => {
      expect((await comet.liquidatorPoints(recipient.address)).numAbsorbed).to.equal(numAbsorbedBefore.add(1));
    });

    it('records the absorber approximate gas spend', async () => {
      expect((await comet.liquidatorPoints(recipient.address)).approxSpend).to.be.gt(approxSpendBefore);
    });

    it('preserves the absorber points reserved field', async () => {
      expect((await comet.liquidatorPoints(recipient.address))._reserved).to.equal(pointsReservedBefore);
    });

    it('preserves the borrower collateral ERC20 wallet balance', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(stateBefore.userCollateralBalance);
    });

    it('preserves the borrower base ERC20 wallet balance', async () => {
      expect(await base.balanceOf(user.address)).to.equal(stateBefore.userBaseBalance);
    });

    it('keeps the seized collateral ERC20 tokens in Comet', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(stateBefore.cometCollateralBalance);
    });

    it('preserves the Comet base ERC20 balance during debt absorption', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(stateBefore.cometBaseBalance);
    });

    it('does not transfer collateral ERC20 tokens to the absorber', async () => {
      expect(await collateral.balanceOf(recipient.address)).to.equal(absorberBefore.userCollateralBalance);
    });

    it('does not charge or pay base ERC20 tokens to the absorber', async () => {
      expect(await base.balanceOf(recipient.address)).to.equal(absorberBefore.userBaseBalance);
    });

    it('does not credit the absorber with a Comet collateral position', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address)).balance).to.equal(absorberBefore.collateralBalance);
    });

    it('preserves the absorber base principal', async () => {
      expect((await comet.userBasic(recipient.address)).principal).to.equal(absorberBefore.principal);
    });

    it('preserves the absorber collateral membership', async () => {
      expect((await comet.userBasic(recipient.address)).assetsIn).to.equal(absorberBefore.assetsIn);
    });

    it('preserves the absorber extended collateral membership', async () => {
      expect((await comet.userBasic(recipient.address))._reserved).to.equal(absorberBefore.userReserved);
    });

    it('preserves the borrower collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(stateBefore.userCollateralReserved);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(stateBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(stateBefore.tokenSupply);
    });

    it('preserves the base ERC20 total supply', async () => {
      expect(await base.totalSupply()).to.equal(baseTokenSupplyBefore);
    });

    it('takes the entire normal-price collateral position from the borrower', async () => {
      expect((await comet.userCollateral(user.address, backingCollateral.address)).balance).to.equal(0);
    });

    it('removes the seized backing amount from total supplied backing collateral', async () => {
      expect((await comet.totalsCollateral(backingCollateral.address)).totalSupplyAsset).to.equal(backingBefore.totalSupplyAsset.sub(BACKING_SUPPLY_AMOUNT));
    });

    it('adds all normal-price collateral to protocol collateral reserves', async () => {
      expect(await comet.getCollateralReserves(backingCollateral.address)).to.equal(backingReservesBefore.add(BACKING_SUPPLY_AMOUNT));
    });

    it('preserves the second collateral normal price despite seizing its position', async () => {
      expect(await comet.getPrice((await comet.getAssetInfoByAddress(backingCollateral.address)).priceFeed)).to.equal(exp(10, 8));
    });

    it('preserves the borrower backing collateral ERC20 wallet balance', async () => {
      expect(await backingCollateral.balanceOf(user.address)).to.equal(backingBefore.userCollateralBalance);
    });

    it('keeps the seized backing collateral ERC20 tokens in Comet', async () => {
      expect(await backingCollateral.balanceOf(comet.address)).to.equal(backingBefore.cometCollateralBalance);
    });

    it('does not transfer backing collateral ERC20 tokens to the absorber', async () => {
      expect(await backingCollateral.balanceOf(recipient.address)).to.equal(absorberBackingBefore.userCollateralBalance);
    });

    it('does not credit the absorber with a backing collateral position', async () => {
      expect((await comet.userCollateral(recipient.address, backingCollateral.address)).balance).to.equal(absorberBackingBefore.collateralBalance);
    });

    it('preserves the borrower backing collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, backingCollateral.address))._reserved).to.equal(backingBefore.userCollateralReserved);
    });

    it('preserves the market backing collateral reserved field', async () => {
      expect((await comet.totalsCollateral(backingCollateral.address))._reserved).to.equal(backingBefore.totalsCollateralReserved);
    });

    it('preserves the backing collateral ERC20 total supply', async () => {
      expect(await backingCollateral.totalSupply()).to.equal(backingBefore.tokenSupply);
    });
  });

  /**
   * Quote 1 USDC for collateral with an 8-decimal USD oracle answer of 1.
   * storeFrontPriceFactor = 100%, liquidationFactor = 90%: discount = 10%.
   * The exact discounted price is $0.000000009, so the quote should be
   * floor((1 / 0.000000009) * 1e18) = 111111111111111111111111111 raw tokens
   * (111,111,111.111111111111111111 whole tokens).
   *
   * Regression: quoteCollateral first computes floor(1 * 0.9) = 0 in oracle
   * price units, then divides by that value. It currently reverts with panic
   * 0x12 instead of returning a quote. The reference math retains the factor
   * scale until the final division. The test records the current panic while
   * the math checks document the valid quote lost through early rounding.
   */
  context('quote collateral with a 1 wei price and verify the discounted amount', function () {
    const BASE_AMOUNT = exp(1, 6);
    const FACTOR_SCALE = exp(1, 18);
    let quoteNumerator: BigNumber;
    let quoteDenominator: BigNumber;
    let expectedQuote: BigNumber;
    let discountedPriceNumerator: BigNumber;

    before(async () => {
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);
      const asset = await comet.getAssetInfoByAddress(collateral.address);
      const assetPrice = await comet.getPrice(asset.priceFeed);
      const basePrice = await comet.getPrice(await comet.baseTokenPriceFeed());
      const baseScale = await comet.baseScale();
      const discount = (await comet.storeFrontPriceFactor())
        .mul(BigNumber.from(FACTOR_SCALE).sub(asset.liquidationFactor)).div(FACTOR_SCALE);
      discountedPriceNumerator = assetPrice.mul(BigNumber.from(FACTOR_SCALE).sub(discount));
      // Retain the fractional oracle price and round down only the token output.
      quoteNumerator = basePrice.mul(BASE_AMOUNT).mul(asset.scale).mul(FACTOR_SCALE);
      quoteDenominator = baseScale.mul(discountedPriceNumerator);
      expectedQuote = quoteNumerator.div(quoteDenominator);
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('computes the reference quote as 111,111,111.111111111111111111 tokens', async () => {
      expect(expectedQuote).to.equal(BigNumber.from(1_000_000_000).mul(BigNumber.from(exp(1, collateralDecimals))).div(9));
    });

    it('shows that early integer rounding reduces the discounted oracle price to zero', async () => {
      expect(discountedPriceNumerator.div(FACTOR_SCALE)).to.equal(0);
    });

    it('keeps the reference quote value within the base payment', async () => {
      expect(expectedQuote.mul(quoteDenominator)).to.be.lte(quoteNumerator);
    });

    it('makes one additional raw collateral unit exceed the base payment', async () => {
      expect(expectedQuote.add(1).mul(quoteDenominator)).to.be.gt(quoteNumerator);
    });

    it('reverts with division-by-zero panic at a 1 wei price with a discount', async () => {
      await expect(comet.quoteCollateral(collateral.address, BASE_AMOUNT)).to.be.revertedWithPanic(0x12);
    });

    /**
     * Why the discount sweep produces different outcomes:
     * quoteCollateral computes the discounted price in integer oracle units
     * before dividing the payment value by that price.
     *
     * | Discount | Exact discounted raw price | Integer price | Result       |
     * | 0%       | 1 * 1.00 = 1               | 1             | Valid quote  |
     * | 1%       | 1 * 0.99 = 0.99            | 0             | Panic 0x12   |
     * | 10%      | 1 * 0.90 = 0.90            | 0             | Panic 0x12   |
     * | 99%      | 1 * 0.01 = 0.01            | 0             | Panic 0x12   |
     * | 100%     | 1 * 0.00 = 0               | 0             | Panic 0x12   |
     *
     * At 0%, the denominator remains 1: $1 / $0.00000001 gives 100 million
     * whole tokens. For 1%-99%, a positive fractional price is truncated to
     * zero by Solidity integer division. Dividing by that zero price causes
     * panic 0x12 (division by zero), rather than returning the larger quote
     * justified by the discount. Precision must be retained until the final
     * collateral-amount division. At 100%, the exact price really is zero;
     * that endpoint has no finite quote and is not a rounding-loss case.
     */
    it('quotes at 0% discount but divides by zero at each 1% step through 100%', async () => {
      // discount = storeFrontPriceFactor * (1 - liquidationFactor).
      // Keep storeFrontPriceFactor at 100% and vary liquidationFactor so each
      // iteration changes the actual discount by one percentage point.
      await configurator.setStoreFrontPriceFactor(comet.address, FACTOR_SCALE);

      for (let discountPercent = 0; discountPercent <= 100; discountPercent++) {
        const label = `discount ${discountPercent}%`;
        const liquidationFactor = BigNumber.from(FACTOR_SCALE).mul(100 - discountPercent).div(100);
        await configurator.updateAssetLiquidationFactor(comet.address, collateral.address, liquidationFactor);
        await cometProxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);

        const asset = await comet.getAssetInfoByAddress(collateral.address);
        const discount = (await comet.storeFrontPriceFactor())
          .mul(BigNumber.from(FACTOR_SCALE).sub(asset.liquidationFactor)).div(FACTOR_SCALE);
        expect(discount, label).to.equal(BigNumber.from(FACTOR_SCALE).mul(discountPercent).div(100));
        expect(await comet.getPrice(asset.priceFeed), label).to.equal(NEW_PRICE);

        if (discountPercent === 0) {
          // No price truncation: 1 USDC buys exactly 100,000,000 tokens.
          expect(await comet.quoteCollateral(collateral.address, BASE_AMOUNT), label).to.equal(collateralUnits(100_000_000));
        } else {
          // 1%-99% demonstrates precision loss. At 100% the exact discounted
          // price itself is zero, so that endpoint is a separate degeneracy.
          await expect(comet.quoteCollateral(collateral.address, BASE_AMOUNT), label).to.be.revertedWithPanic(0x12);
        }
      }
    });
  });


  /**
   * At raw collateral price 1 ($0.00000001), a 0% discount leaves the integer
   * price equal to 1, so paying 1 USDC buys 100,000,000 whole tokens.
   * Set storeFrontPriceFactor to zero through Configurator and redeploy the
   * implementation. Seed 200,000,000 protocol-owned collateral tokens and
   * 2 USDC base reserves, below the 10 USDC target so collateral is for sale.
   * The buyer pays 1 USDC; a separate recipient receives the collateral.
   * Afterwards, base reserves are 3 USDC and collateral reserves are halved.
   * For this raw price, any positive effective discount currently causes the
   * division-by-zero problem demonstrated by the preceding quote tests.
   * After validating the 0% purchase, sweep 1%-100% in a separate test.
   * Keep enough buyer funds and approval for another purchase so every failure
   * reaches the quote calculation rather than failing at the ERC20 transfer.
   */
  context('buy collateral at a 1 wei price across discounts from 0% to 100%', function () {
    const SUPPLY_AMOUNT = collateralUnits(200_000_000);
    const BASE_AMOUNT = exp(1, 6);
    const EXPECTED_COLLATERAL_AMOUNT = collateralUnits(100_000_000);
    let buyerBefore: SupplyState;
    let recipientBefore: SupplyState;
    let collateralReservesBefore: BigNumber;
    let baseReservesBefore: BigNumber;
    let baseTokenSupplyBefore: BigNumber;

    before(async () => {
      await configurator.setStoreFrontPriceFactor(comet.address, 0);
      await configurator.setTargetReserves(comet.address, exp(10, 6));
      await cometProxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);
      await priceFeed.setRoundData(0, NEW_PRICE, 0, 0, 0);

      // Directly fund protocol-owned reserves; these are not user deposits.
      await collateral.allocateTo(comet.address, SUPPLY_AMOUNT);
      await base.allocateTo(comet.address, exp(2, 6));
      await base.allocateTo(user.address, exp(3, 6));
      await base.connect(user).approve(comet.address, 2n * BASE_AMOUNT);
      buyerBefore = await readSupplyState(user);
      recipientBefore = await readSupplyState(recipient);
      collateralReservesBefore = await comet.getCollateralReserves(collateral.address);
      baseReservesBefore = await comet.getReserves();
      baseTokenSupplyBefore = await base.totalSupply();
    });

    after(async () => {
      if (initialSnapshot) {
        expect(await revert(initialSnapshot)).to.equal(true);
        initialSnapshot = await snapshot();
      }
    });

    it('quotes exactly 100 million collateral tokens for 1 USDC at zero discount', async () => {
      expect(await comet.quoteCollateral(collateral.address, BASE_AMOUNT)).to.equal(EXPECTED_COLLATERAL_AMOUNT);
    });

    it('buys collateral at the exact quoted minimum and sends it to the recipient', async () => {
      await comet.connect(user).buyCollateral(collateral.address, EXPECTED_COLLATERAL_AMOUNT, BASE_AMOUNT, recipient.address);
    });

    it('debits the buyer base ERC20 balance by 1 USDC', async () => {
      expect(await base.balanceOf(user.address)).to.equal(buyerBefore.userBaseBalance.sub(BASE_AMOUNT));
    });

    it('credits the Comet base ERC20 balance by 1 USDC', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(buyerBefore.cometBaseBalance.add(BASE_AMOUNT));
    });

    it('credits the recipient collateral ERC20 balance by 100 million tokens', async () => {
      expect(await collateral.balanceOf(recipient.address)).to.equal(recipientBefore.userCollateralBalance.add(EXPECTED_COLLATERAL_AMOUNT));
    });

    it('debits the Comet collateral ERC20 balance by 100 million tokens', async () => {
      expect(await collateral.balanceOf(comet.address)).to.equal(buyerBefore.cometCollateralBalance.sub(EXPECTED_COLLATERAL_AMOUNT));
    });

    it('increases base reserves by the purchase payment', async () => {
      expect(await comet.getReserves()).to.equal(baseReservesBefore.add(BASE_AMOUNT));
    });

    it('decreases collateral reserves by the purchased amount', async () => {
      expect(await comet.getCollateralReserves(collateral.address)).to.equal(collateralReservesBefore.sub(EXPECTED_COLLATERAL_AMOUNT));
    });

    it('preserves the buyer collateral ERC20 balance when buying for another recipient', async () => {
      expect(await collateral.balanceOf(user.address)).to.equal(buyerBefore.userCollateralBalance);
    });

    it('preserves the recipient base ERC20 balance', async () => {
      expect(await base.balanceOf(recipient.address)).to.equal(recipientBefore.userBaseBalance);
    });

    it('preserves total supplied user collateral', async () => {
      expect((await comet.totalsCollateral(collateral.address)).totalSupplyAsset).to.equal(buyerBefore.totalSupplyAsset);
    });

    it('preserves total base supply principal', async () => {
      expect((await comet.totalsBasic()).totalSupplyBase).to.equal(buyerBefore.totalSupplyBase);
    });

    it('preserves total base borrow principal', async () => {
      expect((await comet.totalsBasic()).totalBorrowBase).to.equal(buyerBefore.totalBorrowBase);
    });

    it('preserves the market collateral reserved field', async () => {
      expect((await comet.totalsCollateral(collateral.address))._reserved).to.equal(buyerBefore.totalsCollateralReserved);
    });

    it('preserves the collateral ERC20 total supply', async () => {
      expect(await collateral.totalSupply()).to.equal(buyerBefore.tokenSupply);
    });

    it('preserves the base ERC20 total supply', async () => {
      expect(await base.totalSupply()).to.equal(baseTokenSupplyBefore);
    });

    it('preserves the buyer Comet collateral position', async () => {
      expect((await comet.userCollateral(user.address, collateral.address)).balance).to.equal(buyerBefore.collateralBalance);
    });

    it('preserves the buyer collateral reserved field', async () => {
      expect((await comet.userCollateral(user.address, collateral.address))._reserved).to.equal(buyerBefore.userCollateralReserved);
    });

    it('preserves the buyer base principal', async () => {
      expect((await comet.userBasic(user.address)).principal).to.equal(buyerBefore.principal);
    });

    it('preserves the buyer collateral membership', async () => {
      expect((await comet.userBasic(user.address)).assetsIn).to.equal(buyerBefore.assetsIn);
    });

    it('preserves the buyer extended collateral membership', async () => {
      expect((await comet.userBasic(user.address))._reserved).to.equal(buyerBefore.userReserved);
    });

    it('preserves the recipient Comet collateral position', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address)).balance).to.equal(recipientBefore.collateralBalance);
    });

    it('preserves the recipient collateral reserved field', async () => {
      expect((await comet.userCollateral(recipient.address, collateral.address))._reserved).to.equal(recipientBefore.userCollateralReserved);
    });

    it('preserves the recipient base principal', async () => {
      expect((await comet.userBasic(recipient.address)).principal).to.equal(recipientBefore.principal);
    });

    it('preserves the recipient collateral membership', async () => {
      expect((await comet.userBasic(recipient.address)).assetsIn).to.equal(recipientBefore.assetsIn);
    });

    it('preserves the recipient extended collateral membership', async () => {
      expect((await comet.userBasic(recipient.address))._reserved).to.equal(recipientBefore.userReserved);
    });

    it('reverts purchases at every discount from 1% through 100%', async () => {
      const factorScale = exp(1, 18);
      await configurator.setStoreFrontPriceFactor(comet.address, factorScale);

      for (let discountPercent = 1; discountPercent <= 100; discountPercent++) {
        const label = `buyCollateral discount ${discountPercent}%`;
        const liquidationFactor = BigNumber.from(factorScale).mul(100 - discountPercent).div(100);
        await configurator.updateAssetLiquidationFactor(comet.address, collateral.address, liquidationFactor);
        await cometProxyAdmin.deployAndUpgradeTo(configurator.address, comet.address);

        const asset = await comet.getAssetInfoByAddress(collateral.address);
        const discount = (await comet.storeFrontPriceFactor())
          .mul(BigNumber.from(factorScale).sub(asset.liquidationFactor)).div(factorScale);
        expect(discount, label).to.equal(BigNumber.from(factorScale).mul(discountPercent).div(100));
        // 1%-99% loses fractional price precision; 100% has an exact zero price.
        // Each revert also rolls back the base transfer performed before quoting.
        await expect(
          comet.connect(user).buyCollateral(collateral.address, EXPECTED_COLLATERAL_AMOUNT, BASE_AMOUNT, recipient.address),
          label
        ).to.be.revertedWithPanic(0x12);
      }
    });

    it('does not debit additional buyer USDC for the reverted purchases', async () => {
      expect(await base.balanceOf(user.address)).to.equal(buyerBefore.userBaseBalance.sub(BASE_AMOUNT));
    });

    it('does not retain additional USDC in Comet from the reverted purchases', async () => {
      expect(await base.balanceOf(comet.address)).to.equal(buyerBefore.cometBaseBalance.add(BASE_AMOUNT));
    });

    it('does not send additional collateral to the recipient on reverted purchases', async () => {
      expect(await collateral.balanceOf(recipient.address)).to.equal(recipientBefore.userCollateralBalance.add(EXPECTED_COLLATERAL_AMOUNT));
    });

    it('preserves the unsold collateral reserves after the reverted purchases', async () => {
      expect(await comet.getCollateralReserves(collateral.address)).to.equal(collateralReservesBefore.sub(EXPECTED_COLLATERAL_AMOUNT));
    });
  });
  });
}
