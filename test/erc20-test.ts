import { MaxUint256, ZeroAddress } from 'ethers';

import { baseBalanceOf, expect, makeProtocol, setTotalsBasic } from './helpers.js';

describe('erc20', function () {
  it('has correct name', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();

    expect(await comet.name()).to.be.equal('Compound Comet');
  });

  it('has correct symbol', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();

    expect(await comet.symbol()).to.be.equal('📈BASE');
  });

  it('has correct decimals', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();

    expect(await comet.decimals()).to.be.equal(6n);
  });

  it('has correct totalSupply', async () => {
    const { cometWithExtendedAssetList: comet } = await makeProtocol();

    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      totalSupplyBase: 50e6,
    });

    const totalSupply = await comet.totalSupply();

    expect(totalSupply).to.eq(100_000_000n);
  });

  describe('balanceOf', function () {
    it('returns presentValue of principal (when principal is positive)', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [user],
      } = await makeProtocol();

      await comet.setBasePrincipal(user.address, 100e6);

      let totalsBasic = await comet.totalsBasic();
      await setTotalsBasic(comet, {
        baseSupplyIndex: totalsBasic.baseSupplyIndex * 2n,
      });

      const balanceOf = await comet.balanceOf(user.address);
      expect(balanceOf).to.eq(200_000_000n);
    });

    it('returns 0 (when principal amount is negative)', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [user],
      } = await makeProtocol();

      await comet.setBasePrincipal(user.address, -100e6);

      const balanceOf = await comet.balanceOf(user.address);
      expect(balanceOf).to.eq(0n);
    });
  });

  it('performs ERC20 transfer of base', async () => {
    const {
      cometWithExtendedAssetList: comet,
      users: [alice, bob],
    } = await makeProtocol();

    expect(await baseBalanceOf(comet, bob.address)).to.eq(0n);

    await comet.setBasePrincipal(alice.address, 50e6);
    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
    });

    const tx = await comet.connect(alice).transfer(bob.address, 100e6);
    const receipt = await tx.wait();
    if (receipt === null) {
      throw new Error(`Transaction ${tx.hash} was not mined`);
    }

    const burn = comet.interface.parseLog(receipt.logs[0]);
    expect(burn?.name).to.equal('Transfer');
    expect(burn?.args.from).to.equal(alice.address);
    expect(burn?.args.to).to.equal(ZeroAddress);
    expect(burn?.args.amount).to.equal(100_000_000n);

    const mint = comet.interface.parseLog(receipt.logs[1]);
    expect(mint?.name).to.equal('Transfer');
    expect(mint?.args.from).to.equal(ZeroAddress);
    expect(mint?.args.to).to.equal(bob.address);
    expect(mint?.args.amount).to.equal(100_000_000n);

    expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
    expect(await baseBalanceOf(comet, bob.address)).to.eq(100_000_000n);
  });

  describe('transferFrom', function() {
    it('performs ERC20 transferFrom when user transfers their own funds', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [alice, bob],
      } = await makeProtocol();

      await comet.setBasePrincipal(alice.address, 50e6);
      await setTotalsBasic(comet, {
        baseSupplyIndex: 2e15,
      });

      await comet.connect(alice).transferFrom(alice.address, bob.address, 100e6);

      expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
      expect(await baseBalanceOf(comet, bob.address)).to.eq(100_000_000n);
    });

    it('reverts ERC20 transferFrom without approval', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [alice, bob],
      } = await makeProtocol();

      await comet.setBasePrincipal(alice.address, 100e6);

      await expect(
        comet.connect(bob).transferFrom(alice.address, bob.address, 100e6)
      ).to.be.revertedWithCustomError(comet, 'Unauthorized');
    });

    it('performs ERC20 transferFrom of base with approval', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [alice, bob],
      } = await makeProtocol();

      await comet.setBasePrincipal(alice.address, 100e6);

      // approving for uint256 = isAllowed[user][spender]=true
      await comet.connect(alice).approve(
        bob.address,
        MaxUint256
      );

      expect(await comet.allowance(alice.address, bob.address)).to.eq(MaxUint256);

      // bob can now transfer funds from alice
      await comet.connect(bob).transferFrom(alice.address, bob.address, 100e6);

      expect(await baseBalanceOf(comet, alice.address)).to.eq(0n);
      expect(await baseBalanceOf(comet, bob.address)).to.eq(100_000_000n);
    });

    it('reverts ERC20 transferFrom with revoked approval', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [alice, bob],
      } = await makeProtocol();

      await comet.setBasePrincipal(alice.address, 100e6);

      // bob is approved
      await comet.connect(alice).approve(
        bob.address,
        MaxUint256
      );

      expect(await comet.allowance(alice.address, bob.address)).to.eq(MaxUint256);

      // approval is revoked
      await comet.connect(alice).approve(bob.address, 0);

      expect(await comet.allowance(alice.address, bob.address)).to.eq(0n);

      // bob cannot transfer funds from alice
      await expect(
        comet.connect(bob).transferFrom(alice.address, bob.address, 100e6)
      ).to.be.revertedWithCustomError(comet, 'Unauthorized');
    });
  });

  describe('approve', function() {
    it('sets isAllowed=true when user approves address for uint256 max', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [user, spender]
      } = await makeProtocol();

      const tx = await comet.connect(user).approve(spender.address, MaxUint256);
      await expect(tx)
        .to.emit(comet, 'Approval')
        .withArgs(user.address, spender.address, MaxUint256);

      const isAllowed = await comet.isAllowed(user.address, spender.address);
      expect(isAllowed).to.be.true;
    });

    it('sets isAllowed=false when user passes 0', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [user, spender]
      } = await makeProtocol();

      const tx = await comet.connect(user).approve(spender.address, 0);
      await expect(tx)
        .to.emit(comet, 'Approval')
        .withArgs(user.address, spender.address, 0n);

      const isAllowed = await comet.isAllowed(user.address, spender.address);
      expect(isAllowed).to.be.false;
    });

    it('reverts when user approves for value that is not 0 or uint256.max', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [user, spender]
      } = await makeProtocol();

      await expect(
        comet.connect(user).approve(spender.address, 300)
      ).to.be.revertedWithCustomError(comet, 'BadAmount');
    });
  });

  describe('allowance', function() {
    it('returns unint256.max when spender has permission for user', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [user, spender]
      } = await makeProtocol();

      // authorize
      await comet.connect(user).allow(spender.address, true);

      const allowance = await comet.allowance(user.address, spender.address);
      expect(allowance).to.eq(MaxUint256);
    });

    it('returns 0 when spender does not have permission for user', async () => {
      const {
        cometWithExtendedAssetList: comet,
        users: [user, spender]
      } = await makeProtocol();

      // un-authorize
      await comet.connect(user).allow(spender.address, false);

      const allowance = await comet.allowance(user.address, spender.address);
      expect(allowance).to.eq(0n);
    });
  });
});
