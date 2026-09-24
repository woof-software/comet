import { expect, makeProtocol, setTotalsBasic } from './helpers.js';

describe('withdrawReserves', function () {
  it('withdraws reserves from the protocol', async () => {
    const tokenBalance = 1000n;
    const {
      cometWithExtendedAssetList: comet,
      tokens: { USDC },
      users: [alice],
      governor,
    } = await makeProtocol({
      baseTokenBalance: tokenBalance,
    });
    const cometAddress = await comet.getAddress();

    expect(await USDC.balanceOf(alice.address)).to.be.equal(0n);

    const tx = await comet.connect(governor).withdrawReserves(alice.address, tokenBalance);

    await expect(tx)
      .to.emit(USDC, 'Transfer')
      .withArgs(cometAddress, alice.address, tokenBalance);
    await expect(tx)
      .to.emit(comet, 'WithdrawReserves')
      .withArgs(alice.address, tokenBalance);

    expect(await USDC.balanceOf(alice.address)).to.equal(tokenBalance);
    expect(await USDC.balanceOf(cometAddress)).to.equal(0n);
  });

  it('reverts if called not by governor', async () => {
    const {
      cometWithExtendedAssetList: comet,
      users: [alice],
    } = await makeProtocol();
    await expect(comet.connect(alice).withdrawReserves(alice.address, 10))
      .to.be.revertedWithCustomError(comet, 'Unauthorized');
  });

  it('reverts if not enough reserves are owned by protocol', async () => {
    const tokenBalance = 1000;
    const {
      cometWithExtendedAssetList: comet,
      governor,
      users: [alice],
    } = await makeProtocol({
      baseTokenBalance: tokenBalance,
    });
    await expect(
      comet.connect(governor).withdrawReserves(alice.address, tokenBalance + 1)
    ).to.be.revertedWithCustomError(comet, 'InsufficientReserves');
  });

  it('accounts for total supply base when calculating reserves', async () => {
    const {
      cometWithExtendedAssetList: comet,
      governor,
      users: [alice],
    } = await makeProtocol({
      baseTokenBalance: 200,
    });

    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      totalSupplyBase: 50n,
    });

    expect(await comet.getReserves()).to.be.equal(100n);

    await expect(comet.connect(governor).withdrawReserves(alice.address, 101))
      .to.be.revertedWithCustomError(comet, 'InsufficientReserves');
  });

  it('reverts if negative reserves', async () => {
    const {
      cometWithExtendedAssetList: comet,
      governor,
      users: [alice],
    } = await makeProtocol({
      baseTokenBalance: 0,
    });

    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      totalSupplyBase: 50n,
    });

    expect(await comet.getReserves()).to.be.equal(-100n);

    await expect(comet.connect(governor).withdrawReserves(alice.address, 100))
      .to.be.revertedWithCustomError(comet, 'InsufficientReserves');
  });
});
