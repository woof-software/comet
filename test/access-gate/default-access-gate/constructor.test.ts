import { ethers, expect } from '../../helpers';
import { CometWithExtendedAssetList, DefaultAccessGate, DefaultAccessGate__factory } from '../../../build/types';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import {
  ACTIONS,
  ADMIN_ROLE,
  COLLATERAL_ACTIONS,
  NO_ASSET,
  OPERATOR_ADMIN_ROLE,
  PAUSER_ROLE,
  WBTC_INDEX,
  WETH_INDEX,
  deployDefaultAccessGateFixture,
} from '../../helpers/access-gate';

// DefaultAccessGate is bound to its Comet and wires the roles on deployment:
//   - DEFAULT_ADMIN_ROLE (governor):                  admin of OPERATOR_ADMIN_ROLE.
//   - OPERATOR_ADMIN_ROLE (governor, operator admin): admin of PAUSER_ROLE.
//   - PAUSER_ROLE (initial Pausers):                  pauses and unpauses actions.
// Nothing is paused initially.
describe('default access gate: constructor', function () {
  const ZERO = ethers.constants.AddressZero;

  let AccessGateFactory: DefaultAccessGate__factory;
  let gate: DefaultAccessGate;
  let comet: CometWithExtendedAssetList;
  let governor: SignerWithAddress;
  let operatorAdmin: SignerWithAddress;
  let pausers: string[];

  before(async () => {
    ({ AccessGateFactory, gate, comet, governor, operatorAdmin, pausers } = await deployDefaultAccessGateFixture());
  });

  describe('happy path', function () {
    it('binds the gate to the Comet', async () => {
      expect(await gate.comet()).to.equal(comet.address);
    });

    it('exposes the governor', async () => {
      expect(await gate.governor()).to.equal(governor.address);
    });

    it('grants the governor the admin role', async () => {
      expect(await gate.hasRole(ADMIN_ROLE, governor.address)).to.be.true;
    });

    it('grants the governor the operator admin role', async () => {
      expect(await gate.hasRole(OPERATOR_ADMIN_ROLE, governor.address)).to.be.true;
    });

    it('grants the operator admin the operator admin role', async () => {
      expect(await gate.hasRole(OPERATOR_ADMIN_ROLE, operatorAdmin.address)).to.be.true;
    });

    [0, 1].forEach((i) => {
      it(`grants the initial Pauser #${i + 1}`, async () => {
        expect(await gate.hasRole(PAUSER_ROLE, pausers[i])).to.be.true;
      });
    });

    it('makes the operator admin role the admin of the pauser role', async () => {
      expect(await gate.getRoleAdmin(PAUSER_ROLE)).to.equal(OPERATOR_ADMIN_ROLE);
    });

    ACTIONS.forEach(([name, action]) => {
      it(`starts with ${name} unpaused`, async () => {
        expect(await gate.isPaused(action, NO_ASSET)).to.be.false;
      });
    });

    COLLATERAL_ACTIONS.forEach(([name, action]) => {
      [WETH_INDEX, WBTC_INDEX].forEach((assetIndex) => {
        it(`starts with ${name} unpaused for asset #${assetIndex}`, async () => {
          expect(await gate.isPaused(action, assetIndex)).to.be.false;
        });
      });
    });
  });

  describe('revert when', function () {
    it('the Comet is the zero address', async () => {
      await expect(AccessGateFactory.deploy(ZERO, governor.address, operatorAdmin.address, pausers))
        .to.be.revertedWithCustomError(gate, 'ZeroAddress');
    });

    it('the governor is the zero address', async () => {
      await expect(AccessGateFactory.deploy(comet.address, ZERO, operatorAdmin.address, pausers))
        .to.be.revertedWithCustomError(gate, 'ZeroAddress');
    });

    it('a Pauser address is the zero address', async () => {
      await expect(AccessGateFactory.deploy(comet.address, governor.address, operatorAdmin.address, [pausers[0], ZERO]))
        .to.be.revertedWithCustomError(gate, 'ZeroAddress');
    });
  });
});
