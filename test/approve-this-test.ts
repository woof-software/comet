import { MaxUint256 } from 'ethers';

import { exp, expect, makeProtocol } from './helpers.js';

describe('approveThis', function () {
  describe('asset is Comet', function() {
    it('isAllowed defaults to false', async () => {
      const protocol = await makeProtocol();
      const { cometWithExtendedAssetList : comet, governor } = protocol;
      const cometAddress = await comet.getAddress();
      const governorAddress = await governor.getAddress();

      expect(await comet.isAllowed(cometAddress, governorAddress)).to.be.false;
    });

    it('allows governor to authorize a manager', async () => {
      const protocol = await makeProtocol();
      const { cometWithExtendedAssetList : comet, governor } = protocol;
      const cometAddress = await comet.getAddress();
      const governorAddress = await governor.getAddress();

      await comet.connect(governor).approveThis(governorAddress, cometAddress, MaxUint256);

      expect(await comet.isAllowed(cometAddress, governorAddress)).to.be.true;
    });

    it('allows governor to rescind authorization', async () => {
      const protocol = await makeProtocol();
      const { cometWithExtendedAssetList : comet, governor, users: [ user ] } = protocol;
      const cometAddress = await comet.getAddress();
      const userAddress = await user.getAddress();

      await comet.connect(governor).approveThis(userAddress, cometAddress, MaxUint256);

      expect(await comet.isAllowed(cometAddress, userAddress)).to.be.true;

      await comet.connect(governor).approveThis(userAddress, cometAddress, 0n);

      expect(await comet.isAllowed(cometAddress, userAddress)).to.be.false;
    });

    it('reverts if not called by governor', async () => {
      const protocol = await makeProtocol();
      const { cometWithExtendedAssetList : comet, users: [ user ] } = protocol;
      const cometAddress = await comet.getAddress();
      const userAddress = await user.getAddress();

      await expect(comet.connect(user).approveThis(userAddress, cometAddress, MaxUint256))
        .to.be.revertedWithCustomError(comet, 'Unauthorized');
    });
  });

  describe('asset is non-Comet ERC20', function() {
    it('isAllowed defaults to false', async () => {
      const protocol = await makeProtocol();
      const { cometWithExtendedAssetList : comet, tokens, governor } = protocol;
      const { COMP } = tokens;
      const cometAddress = await comet.getAddress();
      const governorAddress = await governor.getAddress();

      expect(await COMP.allowance(cometAddress, governorAddress)).to.be.equal(0n);
    });

    it('allows governor to authorize a manager', async () => {
      const protocol = await makeProtocol();
      const { cometWithExtendedAssetList : comet, tokens, governor } = protocol;
      const { COMP } = tokens;
      const cometAddress = await comet.getAddress();
      const governorAddress = await governor.getAddress();
      const compAddress = await COMP.getAddress();

      const newAllowance = exp(50, 18);
      await comet.connect(governor).approveThis(governorAddress, compAddress, newAllowance);

      expect(await COMP.allowance(cometAddress, governorAddress)).to.be.equal(newAllowance);
    });

    it('allows governor to rescind authorization', async () => {
      const protocol = await makeProtocol();
      const { cometWithExtendedAssetList : comet, tokens, governor, users: [ user ] } = protocol;
      const { COMP } = tokens;
      const cometAddress = await comet.getAddress();
      const userAddress = await user.getAddress();
      const compAddress = await COMP.getAddress();

      await comet.connect(governor).approveThis(userAddress, compAddress, MaxUint256);

      expect(await COMP.allowance(cometAddress, userAddress)).to.be.equal(MaxUint256);

      await comet.connect(governor).approveThis(userAddress, compAddress, 0n);

      expect(await COMP.allowance(cometAddress, userAddress)).to.be.equal(0n);
    });

    it('reverts if not called by governor', async () => {
      const protocol = await makeProtocol();
      const { cometWithExtendedAssetList : comet, tokens, users: [ user ] } = protocol;
      const { COMP } = tokens;
      const userAddress = await user.getAddress();
      const compAddress = await COMP.getAddress();

      await expect(comet.connect(user).approveThis(userAddress, compAddress, MaxUint256))
        .to.be.revertedWithCustomError(comet, 'Unauthorized');
    });
  });
});
