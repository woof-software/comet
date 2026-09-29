import { ethers, expect } from '../../helpers';
import { CometWithExtendedAssetList, ListAccessGate } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { ContractFactory } from 'ethers';
import { OPERATOR_ADMIN_ROLE, OPERATOR_ROLE, deployListAccessGateFixture } from '../../helpers/access-gate';

// ListAccessGate is abstract, so it is tested through AllowlistGate. Only what the ListAccessGate constructor adds
// on top of DefaultAccessGate is covered here: the OPERATOR_ROLE (maintains the lists), administered by
// OPERATOR_ADMIN_ROLE, and no account listed initially.
describe('list access gate: constructor', function () {
  const ZERO = ethers.constants.AddressZero;

  let AccessGateFactory: ContractFactory;
  let gate: ListAccessGate;
  let comet: CometWithExtendedAssetList;
  let governor: SignerWithAddress;
  let operatorAdmin: SignerWithAddress;
  let pausers: string[];
  let operators: string[];
  let accounts: SignerWithAddress[];

  before(async () => {
    ({ AccessGateFactory, gate, comet, governor, operatorAdmin, pausers, operators, accounts } =
      await deployListAccessGateFixture('AllowlistGate'));
  });

  describe('happy path', function () {
    [0, 1].forEach((i) => {
      it(`grants the initial Operator #${i + 1}`, async () => {
        expect(await gate.hasRole(OPERATOR_ROLE, operators[i])).to.be.true;
      });
    });

    it('makes the operator admin role the admin of the operator role', async () => {
      expect(await gate.getRoleAdmin(OPERATOR_ROLE)).to.equal(OPERATOR_ADMIN_ROLE);
    });

    it('starts with no account listed', async () => {
      for (const account of accounts) {
        expect(await gate.listedActions(account.address)).to.equal(0);
      }
    });
  });

  describe('revert when', function () {
    it('an Operator address is the zero address', async () => {
      await expect(
        AccessGateFactory.deploy(comet.address, governor.address, operatorAdmin.address, pausers, [operators[0], ZERO])
      ).to.be.revertedWithCustomError(gate, 'ZeroAddress');
    });
  });
});
