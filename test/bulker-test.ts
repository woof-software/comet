import { AbiCoder, MaxUint256, ZeroAddress } from 'ethers';

import { baseBalanceOf, ethers, expect, exp, makeProtocol, wait, makeBulker, defaultAssets, getGasUsed, makeRewards, fastForward, event, setTotalsBasic } from './helpers.js';
import { FaucetWETH__factory, NonStandardFaucetToken__factory } from '../build/types/index.js';
import type { CometHarnessInterfaceExtendedAssetList } from '../build/types/index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

async function makeFaucetWETHFactory() {
  const [deployer] = await ethers.getSigners();
  return new FaucetWETH__factory(deployer);
}

async function setTotalSupplyAsset(
  comet: CometHarnessInterfaceExtendedAssetList,
  asset: string,
  totalSupplyAsset: bigint
) {
  const totals = await comet.totalsCollateral(asset);
  await wait(comet.setTotalsCollateral(asset, {
    totalSupplyAsset,
    _reserved: totals._reserved,
  }));
}

// XXX Improve the "no permission" tests that should expect a custom error when
// when https://github.com/nomiclabs/hardhat/issues/1618 gets fixed.
describe('bulker', function () {
  it('supply base asset', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { USDC, WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Alice approves 10 USDC to Comet
    const supplyAmount = exp(10, 6);
    await USDC.allocateTo(alice.address, supplyAmount);
    await USDC.connect(alice).approve(await comet.getAddress(), MaxUint256);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice supplies 10 USDC through the bulker
    const supplyAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await USDC.getAddress(), supplyAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_ASSET()], [supplyAssetCalldata]);

    expect(await baseBalanceOf(comet, alice.address)).to.be.equal(supplyAmount);
  });

  it('supply collateral asset', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { COMP, WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Alice approves 10 COMP to Comet
    const supplyAmount = exp(10, 18);
    await COMP.allocateTo(alice.address, supplyAmount);
    await COMP.connect(alice).approve(await comet.getAddress(), MaxUint256);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice supplies 10 COMP through the bulker
    const supplyAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await COMP.getAddress(), supplyAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_ASSET()], [supplyAssetCalldata]);

    expect(await comet.collateralBalanceOf(alice.address, await COMP.getAddress())).to.be.equal(supplyAmount);
  });

  it('supply 24 collateral assets', async () => {
    const protocol = await makeProtocol({
      assets: {
        // 24 assets
        USDC: {},
        COMP: {},
        WETH: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
        ASSET10: {},
        ASSET11: {},
        ASSET12: {},
        ASSET13: {},
        ASSET14: {},
        ASSET15: {},
        ASSET16: {},
        ASSET17: {},
        ASSET18: {},
        ASSET19: {},
        ASSET20: {},
        ASSET21: {},
        ASSET22: {},
        ASSET23: {},
      },
      reward: 'COMP',
    });
    const { cometWithExtendedAssetList : comet, tokens: {
      COMP,
      WETH,
      USDC,
    }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Alice approves 10 COMP to Comet
    const supplyAmount = exp(10, 18);
    await COMP.allocateTo(alice.address, supplyAmount);
    await COMP.connect(alice).approve(await comet.getAddress(), MaxUint256);

    await USDC.connect(alice).approve(await comet.getAddress(), MaxUint256);

    for (let i = 3; i < 24; i++) {
      const asset = `ASSET${i}`;
      await protocol.tokens[asset].allocateTo(alice.address, supplyAmount);
      await protocol.tokens[asset].connect(alice).approve(await comet.getAddress(), MaxUint256);
    }

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);


    // Alice supplies 10 COMP through the bulker
    const supplyCOMPCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await COMP.getAddress(), supplyAmount]);
    const actions = [await bulker.ACTION_SUPPLY_ASSET()];
    const calldatas = [supplyCOMPCalldata];
    for(let i = 3; i < 24; i++) {
      actions.push(await bulker.ACTION_SUPPLY_ASSET());
      const asset = `ASSET${i}`;
      const supplyAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await protocol.tokens[asset].getAddress(), supplyAmount]);
      calldatas.push(supplyAssetCalldata);
    }

    await bulker.connect(alice).invoke(actions, calldatas);

    expect(await comet.collateralBalanceOf(alice.address, await COMP.getAddress())).to.be.equal(supplyAmount);
    for (let i = 3; i < 24; i++) {
      const asset = `ASSET${i}`;
      expect(await comet.collateralBalanceOf(alice.address, await protocol.tokens[asset].getAddress())).to.be.equal(supplyAmount);
    }
  });

  it('supply collateral asset to a different account', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { COMP, WETH }, users: [alice, bob] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Alice approves 10 COMP to Comet
    const supplyAmount = exp(10, 18);
    await COMP.allocateTo(alice.address, supplyAmount);
    await COMP.connect(alice).approve(await comet.getAddress(), MaxUint256);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice supplies 10 COMP to Bob through the bulker
    const supplyAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), bob.address, await COMP.getAddress(), supplyAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_ASSET()], [supplyAssetCalldata]);

    expect(await comet.collateralBalanceOf(alice.address, await COMP.getAddress())).to.be.equal(0);
    expect(await comet.collateralBalanceOf(bob.address, await COMP.getAddress())).to.be.equal(supplyAmount);
  });

  it('supply native token', async () => {
    const protocol = await makeProtocol({
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // No approval is actually needed on the supplyEth action!

    // Alice supplies 10 ETH through the bulker
    const supplyAmount = exp(10, 18);
    const supplyNativeTokenCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, supplyAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], [supplyNativeTokenCalldata], { value: supplyAmount });

    expect(await comet.collateralBalanceOf(alice.address, await WETH.getAddress())).to.be.equal(supplyAmount);
  });

  it('supply native token refunds unused native token', async () => {
    const protocol = await makeProtocol({
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // No approval is actually needed on the supplyEth action!

    // Alice supplies 10 ETH through the bulker but actually sends 20 ETH
    const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);
    const supplyAmount = exp(10, 18);
    const supplyNativeTokenCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, supplyAmount]);
    const txn = await wait(bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], [supplyNativeTokenCalldata], { value: supplyAmount * 2n }));
    const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);

    expect(await comet.collateralBalanceOf(alice.address, await WETH.getAddress())).to.be.equal(supplyAmount);
    expect(aliceBalanceBefore - aliceBalanceAfter).to.be.equal(supplyAmount + getGasUsed(txn));
  });

  it('supply native token with insufficient native token', async () => {
    const protocol = await makeProtocol({
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // No approval is actually needed on the supplyEth action!

    // Alice supplies 10 ETH through the bulker but only sends 5 ETH
    const supplyAmount = exp(10, 18);
    const supplyNativeTokenCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, supplyAmount]);
    await expect(bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], [supplyNativeTokenCalldata], { value: supplyAmount / 2n }))
      .to.revert(ethers); // Wrapping ETH to WETH in the Bulker reverts because there is not enough ETH in the txn
  });

  it('supplyNativeToken with max base', async () => {
    const protocol = await makeProtocol({
      base: 'WETH',
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() },
        USDC: {
          supplyCap: exp(100_000, 6)
        }
      }),
      // set rates at 0 to ignore effects of interest rate accrual, which are not relevant to this test
      borrowInterestRateBase: 0,
      borrowInterestRateSlopeLow: 0,
    });
    const { cometWithExtendedAssetList : comet, tokens: { USDC, WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    const borrowAmount = exp(10, 18);
    const supplyAmount = exp(50_000, 6);
    await WETH.allocateTo(await comet.getAddress(), borrowAmount);
    await USDC.allocateTo(alice.address, supplyAmount);

    // Alice supplies collateral to borrow the base asset
    await USDC.connect(alice).approve(await comet.getAddress(), supplyAmount);
    await comet.connect(alice).supply(await USDC.getAddress(), supplyAmount);
    await comet.connect(alice).withdraw(await WETH.getAddress(), borrowAmount);

    expect(await comet.borrowBalanceOf(alice.address)).to.not.be.equal(0);

    // Alice repays max ETH through the bulker
    const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);
    const borrowBalanceOf = await comet.borrowBalanceOf(alice.address);
    const supplyNativeTokenCalldata = abiCoder.encode(
      ['address', 'address', 'uint'],
      [await comet.getAddress(), alice.address, MaxUint256]
    );
    const txn = await wait(bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], [supplyNativeTokenCalldata], { value: borrowAmount * 2n }));
    const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);

    expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(0);
    expect(await ethers.provider.getBalance(await bulker.getAddress())).to.be.equal(0); // check extra ETH has been refunded to user
    expect(aliceBalanceAfter - aliceBalanceBefore).to.be.equal(-borrowBalanceOf - getGasUsed(txn));
  });

  it('supplyNativeToken with max collateral should revert', async () => {
    const protocol = await makeProtocol({
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // No approval is actually needed on the supplyEth action!

    // Alice supplies max collateral (doesn't make sense) through the bulker
    const supplyNativeTokenCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, MaxUint256]);
    await expect(
      bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_NATIVE_TOKEN()], [supplyNativeTokenCalldata], { value: exp(1, 18) })
    ).to.revert(ethers);
  });

  it('transfer base asset', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { USDC, WETH }, users: [alice, bob] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    const transferAmount = exp(10, 6);
    await comet.setBasePrincipal(alice.address, transferAmount);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice transfer 10 USDC to Bob through the bulker
    const transferAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), bob.address, await USDC.getAddress(), transferAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_TRANSFER_ASSET()], [transferAssetCalldata]);

    expect(await baseBalanceOf(comet, alice.address)).to.be.equal(0n);
    expect(await baseBalanceOf(comet, bob.address)).to.be.equal(transferAmount);
  });

  it('transfer collateral asset', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { COMP, WETH }, users: [alice, bob] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    const transferAmount = exp(10, 18);
    await comet.setCollateralBalance(alice.address, await COMP.getAddress(), transferAmount);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice transfer 10 COMP to Bob through the bulker
    const transferAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), bob.address, await COMP.getAddress(), transferAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_TRANSFER_ASSET()], [transferAssetCalldata]);

    expect(await comet.collateralBalanceOf(alice.address, await COMP.getAddress())).to.be.equal(0);
    expect(await comet.collateralBalanceOf(bob.address, await COMP.getAddress())).to.be.equal(transferAmount);
  });

  it('withdraw base asset', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { USDC, WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate base asset to Comet and Alice's Comet balance
    const withdrawAmount = exp(10, 6);
    await USDC.allocateTo(await comet.getAddress(), withdrawAmount);
    await setTotalsBasic(comet, { totalSupplyBase: withdrawAmount });
    await comet.setBasePrincipal(alice.address, withdrawAmount);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice withdraws 10 USDC through the bulker
    const withdrawAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await USDC.getAddress(), withdrawAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_WITHDRAW_ASSET()], [withdrawAssetCalldata]);

    expect(await baseBalanceOf(comet, alice.address)).to.be.equal(0n);
    expect(await USDC.balanceOf(alice.address)).to.be.equal(withdrawAmount);
  });

  it('withdraw collateral asset', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { COMP, WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate collateral asset to Comet and Alice's Comet balance
    const withdrawAmount = exp(10, 18);
    await COMP.allocateTo(await comet.getAddress(), withdrawAmount);
    await setTotalSupplyAsset(comet, await COMP.getAddress(), withdrawAmount);
    await comet.setCollateralBalance(alice.address, await COMP.getAddress(), withdrawAmount);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice withdraws 10 COMP through the bulker
    const withdrawAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await COMP.getAddress(), withdrawAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_WITHDRAW_ASSET()], [withdrawAssetCalldata]);

    expect(await comet.collateralBalanceOf(alice.address, await COMP.getAddress())).to.be.equal(0);
    expect(await COMP.balanceOf(alice.address)).to.be.equal(withdrawAmount);
  });

  it('withdraw 24 collateral assets', async () => {
    const protocol = await makeProtocol({
      assets: {
        // 24 assets
        USDC: {},
        COMP: {},
        WETH: {},
        ASSET3: {},
        ASSET4: {},
        ASSET5: {},
        ASSET6: {},
        ASSET7: {},
        ASSET8: {},
        ASSET9: {},
        ASSET10: {},
        ASSET11: {},
        ASSET12: {},
        ASSET13: {},
        ASSET14: {},
        ASSET15: {},
        ASSET16: {},
        ASSET17: {},
        ASSET18: {},
        ASSET19: {},
        ASSET20: {},
        ASSET21: {},
        ASSET22: {},
        ASSET23: {},
      },
      reward: 'COMP',
    });
    const { cometWithExtendedAssetList : comet, tokens: {
      COMP,
      WETH,
    }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate collateral asset to Comet and Alice's Comet balance
    const withdrawAmount = exp(10, 18);
    await COMP.allocateTo(await comet.getAddress(), withdrawAmount);
    await setTotalSupplyAsset(comet, await COMP.getAddress(), withdrawAmount);
    await comet.setCollateralBalance(alice.address, await COMP.getAddress(), withdrawAmount);

    for(let i = 3; i < 24; i++) {
      const asset = `ASSET${i}`;
      await protocol.tokens[asset].allocateTo(await comet.getAddress(), withdrawAmount);
      await setTotalSupplyAsset(comet, await protocol.tokens[asset].getAddress(), withdrawAmount);
      await comet.setCollateralBalance(alice.address, await protocol.tokens[asset].getAddress(), withdrawAmount);
    }

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice withdraws 10 COMP through the bulker
    const withdrawAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await COMP.getAddress(), withdrawAmount]);
    const actions = [await bulker.ACTION_WITHDRAW_ASSET()];
    const calldatas = [withdrawAssetCalldata];
    for(let i = 3; i < 24; i++) {
      actions.push(await bulker.ACTION_WITHDRAW_ASSET());
      const asset = `ASSET${i}`;
      const withdrawAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await protocol.tokens[asset].getAddress(), withdrawAmount]);
      calldatas.push(withdrawAssetCalldata);
    }
    await bulker.connect(alice).invoke(actions, calldatas);

    expect(await comet.collateralBalanceOf(alice.address, await COMP.getAddress())).to.be.equal(0);
    expect(await COMP.balanceOf(alice.address)).to.be.equal(withdrawAmount);
    for (let i = 3; i < 24; i++) {
      const asset = `ASSET${i}`;
      expect(await comet.collateralBalanceOf(alice.address, await protocol.tokens[asset].getAddress())).to.be.equal(0);
      expect(await protocol.tokens[asset].balanceOf(alice.address)).to.be.equal(withdrawAmount);
    }
  });

  it('withdraw collateral asset to a different account', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { COMP, WETH }, users: [alice, bob] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate collateral asset to Comet and Alice's Comet balance
    const withdrawAmount = exp(10, 18);
    await COMP.allocateTo(await comet.getAddress(), withdrawAmount);
    await setTotalSupplyAsset(comet, await COMP.getAddress(), withdrawAmount);
    await comet.setCollateralBalance(alice.address, await COMP.getAddress(), withdrawAmount);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice withdraws 10 COMP through the bulker
    const withdrawAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), bob.address, await COMP.getAddress(), withdrawAmount]);
    await bulker.connect(alice).invoke([await bulker.ACTION_WITHDRAW_ASSET()], [withdrawAssetCalldata]);

    expect(await comet.collateralBalanceOf(alice.address, await COMP.getAddress())).to.be.equal(0);
    expect(await COMP.balanceOf(alice.address)).to.be.equal(0);
    expect(await COMP.balanceOf(bob.address)).to.be.equal(withdrawAmount);
  });

  it('withdraw native token', async () => {
    const protocol = await makeProtocol({
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice], governor } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate WETH to Comet and Alice's Comet balance
    const withdrawAmount = exp(10, 18);
    await WETH.allocateTo(await comet.getAddress(), withdrawAmount);
    await governor.sendTransaction({ to: await WETH.getAddress(), value: withdrawAmount }); // seed WETH contract with ether
    await setTotalSupplyAsset(comet, await WETH.getAddress(), withdrawAmount);
    await comet.setCollateralBalance(alice.address, await WETH.getAddress(), withdrawAmount);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice withdraws 10 ETH through the bulker
    const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);
    const withdrawNativeTokenCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, withdrawAmount]);
    const txn = await wait(bulker.connect(alice).invoke([await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], [withdrawNativeTokenCalldata]));
    const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);

    expect(await comet.collateralBalanceOf(alice.address, await WETH.getAddress())).to.be.equal(0);
    expect(aliceBalanceAfter - aliceBalanceBefore).to.be.equal(withdrawAmount - getGasUsed(txn));
  });

  it('withdrawNativeToken max base', async () => {
    const protocol = await makeProtocol({
      base: 'WETH',
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice], governor } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate WETH to Comet and Alice's Comet balance
    const withdrawAmount = exp(10, 18);
    await WETH.allocateTo(alice.address, withdrawAmount);
    await governor.sendTransaction({ to: await WETH.getAddress(), value: withdrawAmount }); // seed WETH contract with ether
    await WETH.connect(alice).approve(await comet.getAddress(), withdrawAmount);
    await comet.connect(alice).supply(await WETH.getAddress(), withdrawAmount);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice withdraws uin256.max ETH through the bulker
    const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);
    const withdrawNativeTokenCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, MaxUint256]);
    const txn = await wait(bulker.connect(alice).invoke([await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], [withdrawNativeTokenCalldata]));
    const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);

    expect(await comet.collateralBalanceOf(alice.address, await WETH.getAddress())).to.be.equal(0);
    expect(aliceBalanceAfter - aliceBalanceBefore).to.be.equal(withdrawAmount - getGasUsed(txn));
  });

  it('withdrawNativeToken max collateral reverts', async () => {
    const protocol = await makeProtocol({
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice], governor } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate WETH to Comet and Alice's Comet balance
    const withdrawAmount = exp(10, 18);
    await WETH.allocateTo(alice.address, withdrawAmount);
    await governor.sendTransaction({ to: await WETH.getAddress(), value: withdrawAmount }); // seed WETH contract with ether
    await WETH.connect(alice).approve(await comet.getAddress(), withdrawAmount);
    await comet.connect(alice).supply(await WETH.getAddress(), withdrawAmount);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice withdraws uin256.max ETH through the bulker
    const withdrawNativeTokenCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, MaxUint256]);

    // ...but it reverts
    await expect(
      bulker.connect(alice).invoke([await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], [withdrawNativeTokenCalldata])
    ).to.be.revertedWithCustomError(comet, 'InvalidUInt128');
  });

  it('claim rewards', async () => {
    const protocol = await makeProtocol({
      baseMinForRewards: 10e6,
    });
    const {
      cometWithExtendedAssetList : comet,
      governor,
      tokens: { USDC, COMP, WETH },
      users: [alice],
    } = protocol;
    const { rewards } = await makeRewards({ governor, configs: [[comet, COMP]] });
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate and approve transfers
    await COMP.allocateTo(await rewards.getAddress(), exp(86400, 18));
    await USDC.allocateTo(alice.address, 10e6);
    await USDC.connect(alice).approve(await comet.getAddress(), 10e6);

    // Supply once
    await comet.connect(alice).supply(await USDC.getAddress(), 10e6);

    await fastForward(86400);

    expect(await COMP.balanceOf(alice.address)).to.be.equal(0);

    // Alice claims rewards through the bulker
    const claimRewardCalldata = abiCoder.encode(['address', 'address', 'address', 'bool'], [await comet.getAddress(), await rewards.getAddress(), alice.address, true]);
    await bulker.connect(alice).invoke([await bulker.ACTION_CLAIM_REWARD()], [claimRewardCalldata]);

    expect(await COMP.balanceOf(alice.address)).to.be.equal(exp(86400, 18));
  });

  it('reverts on supply asset if no permission granted to bulker', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { USDC, WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    const supplyAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await USDC.getAddress(), 1]);
    await expect(bulker.connect(alice).invoke([await bulker.ACTION_SUPPLY_ASSET()], [supplyAssetCalldata]))
      .to.revert(ethers); // Should revert with "custom error 'Unauthorized()'"
  });

  it('reverts on transfer asset if no permission granted to bulker', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { COMP, WETH }, users: [alice, bob] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    const transferAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), bob.address, await COMP.getAddress(), 1]);
    await expect(bulker.connect(alice).invoke([await bulker.ACTION_TRANSFER_ASSET()], [transferAssetCalldata]))
      .to.revert(ethers); // Should revert with "custom error 'Unauthorized()'"
  });

  it('reverts on withdraw asset if no permission granted to bulker', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { COMP, WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    const withdrawAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await COMP.getAddress(), 1]);
    await expect(bulker.connect(alice).invoke([await bulker.ACTION_WITHDRAW_ASSET()], [withdrawAssetCalldata]))
      .to.revert(ethers); // Should revert with "custom error 'Unauthorized()'"
  });

  it('reverts on withdraw native token if no permission granted to bulker', async () => {
    const protocol = await makeProtocol({
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    const withdrawNativeTokenCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, 1]);
    await expect(bulker.connect(alice).invoke([await bulker.ACTION_WITHDRAW_NATIVE_TOKEN()], [withdrawNativeTokenCalldata]))
      .to.revert(ethers); // Should revert with "custom error 'Unauthorized()'"
  });

  describe('admin functions', function () {
    it('transferAdmin', async () => {
      const protocol = await makeProtocol({});
      const { governor, tokens: { WETH }, users: [alice] } = protocol;
      const bulkerInfo = await makeBulker({ admin: governor, weth: await WETH.getAddress() });
      const { bulker } = bulkerInfo;

      expect(await bulker.admin()).to.be.equal(governor.address);

      // Admin transferred
      const txn = await wait(bulker.connect(governor).transferAdmin(alice.address));

      expect(event(txn, 0)).to.be.deep.equal({
        AdminTransferred: {
          oldAdmin: governor.address,
          newAdmin: alice.address
        }
      });
      expect(await bulker.admin()).to.be.equal(alice.address);
    });

    it('revert if transferAdmin called by non-admin', async () => {
      const protocol = await makeProtocol({});
      const { governor, tokens: { WETH }, users: [alice] } = protocol;
      const bulkerInfo = await makeBulker({ admin: governor, weth: await WETH.getAddress() });
      const { bulker } = bulkerInfo;

      await expect(
        bulker.connect(alice).transferAdmin(alice.address)
      ).to.be.revertedWithCustomError(bulker, 'Unauthorized');
    });

    it('revert if transferAdmin to zero address', async () => {
      const protocol = await makeProtocol({});
      const { governor, tokens: { WETH } } = protocol;
      const bulkerInfo = await makeBulker({ admin: governor, weth: await WETH.getAddress() });
      const { bulker } = bulkerInfo;

      await expect(
        bulker.connect(governor).transferAdmin(ZeroAddress)
      ).to.be.revertedWithCustomError(bulker, 'InvalidAddress');
    });

    it('sweep standard ERC20 token', async () => {
      const protocol = await makeProtocol({});
      const { governor, tokens: { USDC, WETH }, users: [alice] } = protocol;
      const bulkerInfo = await makeBulker({ admin: governor, weth: await WETH.getAddress() });
      const { bulker } = bulkerInfo;

      // Alice "accidentally" sends 10 USDC to the Bulker
      const transferAmount = exp(10, 6);
      await USDC.allocateTo(alice.address, transferAmount);
      await USDC.connect(alice).transfer(await bulker.getAddress(), transferAmount);

      const oldBulkerBalance = await USDC.balanceOf(await bulker.getAddress());
      const oldGovBalance = await USDC.balanceOf(governor.address);

      // Governor sweeps tokens
      await bulker.connect(governor).sweepToken(governor.address, await USDC.getAddress());

      const newBulkerBalance = await USDC.balanceOf(await bulker.getAddress());
      const newGovBalance = await USDC.balanceOf(governor.address);

      expect(newBulkerBalance - oldBulkerBalance).to.be.equal(-transferAmount);
      expect(newGovBalance - oldGovBalance).to.be.equal(transferAmount);
    });

    it('sweep non-standard ERC20 token', async () => {
      const protocol = await makeProtocol({});
      const { governor, tokens: { WETH }, users: [alice] } = protocol;
      const bulkerInfo = await makeBulker({ admin: governor, weth: await WETH.getAddress() });
      const { bulker } = bulkerInfo;

      // Deploy non-standard token
      const factory = new NonStandardFaucetToken__factory(governor);
      const nonStandardToken = await factory.deploy(1000e6, 'Tether', 6, 'USDT');
      await nonStandardToken.waitForDeployment();

      // Alice "accidentally" sends 10 non-standard tokens to the Bulker
      const transferAmount = exp(10, 6);
      await nonStandardToken.allocateTo(alice.address, transferAmount);
      await nonStandardToken.connect(alice).transfer(await bulker.getAddress(), transferAmount);

      const oldBulkerBalance = await nonStandardToken.balanceOf(await bulker.getAddress());
      const oldGovBalance = await nonStandardToken.balanceOf(governor.address);

      // Governor sweeps tokens
      await bulker.connect(governor).sweepToken(governor.address, await nonStandardToken.getAddress());

      const newBulkerBalance = await nonStandardToken.balanceOf(await bulker.getAddress());
      const newGovBalance = await nonStandardToken.balanceOf(governor.address);

      expect(newBulkerBalance - oldBulkerBalance).to.be.equal(-transferAmount);
      expect(newGovBalance - oldGovBalance).to.be.equal(transferAmount);
    });

    it('sweep native token', async () => {
      const protocol = await makeProtocol({});
      const { governor, tokens: { WETH }, users: [alice] } = protocol;
      const bulkerInfo = await makeBulker({ admin: governor, weth: await WETH.getAddress() });
      const { bulker } = bulkerInfo;

      // Alice "accidentally" sends 1 ETH to the Bulker
      const transferAmount = exp(1, 18);
      await alice.sendTransaction({ to: await bulker.getAddress(), value: transferAmount });

      const oldBulkerBalance = await ethers.provider.getBalance(await bulker.getAddress());
      const oldGovBalance = await ethers.provider.getBalance(governor.address);

      // Governor sweeps ETH
      const txn = await wait(bulker.connect(governor).sweepNativeToken(governor.address));

      const newBulkerBalance = await ethers.provider.getBalance(await bulker.getAddress());
      const newGovBalance = await ethers.provider.getBalance(governor.address);

      expect(newBulkerBalance - oldBulkerBalance).to.be.equal(-transferAmount);
      expect(newGovBalance - oldGovBalance).to.be.equal(transferAmount - getGasUsed(txn));
    });

    it('reverts if sweepToken is called by non-admin', async () => {
      const protocol = await makeProtocol({});
      const { governor, tokens: { USDC, WETH }, users: [alice] } = protocol;
      const bulkerInfo = await makeBulker({ admin: governor, weth: await WETH.getAddress() });
      const { bulker } = bulkerInfo;

      // Alice sweeps tokens
      await expect(bulker.connect(alice).sweepToken(governor.address, await USDC.getAddress()))
        .to.be.revertedWithCustomError(bulker, 'Unauthorized');
    });

    it('reverts if sweepNativeToken is called by non-admin', async () => {
      const protocol = await makeProtocol({});
      const { governor, tokens: { WETH }, users: [alice] } = protocol;
      const bulkerInfo = await makeBulker({ admin: governor, weth: await WETH.getAddress() });
      const { bulker } = bulkerInfo;

      // Alice sweeps ETH
      await expect(bulker.connect(alice).sweepNativeToken(governor.address))
        .to.be.revertedWithCustomError(bulker, 'Unauthorized');
    });
  });
});

describe('bulker multiple actions', function () {
  it('supply collateral + borrow base asset', async () => {
    const protocol = await makeProtocol({});
    const { cometWithExtendedAssetList : comet, tokens: { USDC, COMP, WETH }, users: [alice] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // Allocate base asset to Comet
    const borrowAmount = exp(10, 6);
    await USDC.allocateTo(await comet.getAddress(), borrowAmount);
    await setTotalsBasic(comet, { totalSupplyBase: borrowAmount });

    // Alice approves 100 COMP to Comet
    const supplyAmount = exp(100, 18);
    await COMP.allocateTo(alice.address, supplyAmount);
    await COMP.connect(alice).approve(await comet.getAddress(), MaxUint256);

    // Alice gives the Bulker permission over her account
    await comet.connect(alice).allow(await bulker.getAddress(), true);

    // Alice supplies 10 COMP through the bulker
    const supplyAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await COMP.getAddress(), supplyAmount]);
    // Alice withdraws 10 USDC through the bulker
    const withdrawAssetCalldata = abiCoder.encode(['address', 'address', 'address', 'uint'], [await comet.getAddress(), alice.address, await USDC.getAddress(), borrowAmount]);
    await bulker.connect(alice).invoke(
      [await bulker.ACTION_SUPPLY_ASSET(), await bulker.ACTION_WITHDRAW_ASSET()],
      [supplyAssetCalldata, withdrawAssetCalldata]
    );

    expect(await comet.collateralBalanceOf(alice.address, await COMP.getAddress())).to.be.equal(supplyAmount);
    expect(await comet.borrowBalanceOf(alice.address)).to.be.equal(borrowAmount);
    expect(await USDC.balanceOf(alice.address)).to.be.equal(borrowAmount);
  });

  it('supply native token to multiple accounts', async () => {
    const protocol = await makeProtocol({
      assets: defaultAssets({}, {
        WETH: { factory: await makeFaucetWETHFactory() }
      })
    });
    const { cometWithExtendedAssetList : comet, tokens: { WETH }, users: [alice, bob] } = protocol;
    const bulkerInfo = await makeBulker({ weth: await WETH.getAddress() });
    const { bulker } = bulkerInfo;

    // No approval is actually needed on the supplyEth action!

    // Alice supplies 10 ETH through the bulker
    const supplyAmount = exp(10, 18);
    const supplyAliceEthCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), alice.address, supplyAmount / 2n]);
    const supplyBobEthCalldata = abiCoder.encode(['address', 'address', 'uint'], [await comet.getAddress(), bob.address, supplyAmount / 2n]);
    await bulker.connect(alice).invoke(
      [await bulker.ACTION_SUPPLY_NATIVE_TOKEN(), await bulker.ACTION_SUPPLY_NATIVE_TOKEN()],
      [supplyAliceEthCalldata, supplyBobEthCalldata],
      { value: supplyAmount }
    );

    expect(await comet.collateralBalanceOf(alice.address, await WETH.getAddress())).to.be.equal(supplyAmount / 2n);
    expect(await comet.collateralBalanceOf(bob.address, await WETH.getAddress())).to.be.equal(supplyAmount / 2n);
  });
});
