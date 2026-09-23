import { ZeroAddress } from 'ethers';

import { GovernorSimple__factory } from '../build/types/index.js';
import { ethers, expect } from './helpers.js';

async function buildGovernorSimple() {
  const [deployer] = await ethers.getSigners();
  const GovernorSimpleFactory = new GovernorSimple__factory(deployer);
  const governorSimple = await GovernorSimpleFactory.deploy();
  await governorSimple.waitForDeployment();
  return governorSimple;
}

describe('GovernorSimple', function () {
  it('adds a new admin', async () => {
    const [alice, bob] = await ethers.getSigners();
    const governorSimple = await buildGovernorSimple();
    await governorSimple.initialize(
      ZeroAddress,
      [alice.address]
    );

    expect(await governorSimple.isAdmin(bob.address)).to.be.false;

    await governorSimple.connect(alice).addAdmin(bob.address);

    expect(await governorSimple.isAdmin(bob.address)).to.be.true;
  });

  it('removes an existing admin', async () => {
    const [alice, bob] = await ethers.getSigners();
    const governorSimple = await buildGovernorSimple();
    await governorSimple.initialize(
      ZeroAddress,
      [alice.address, bob.address]
    );

    expect(await governorSimple.isAdmin(bob.address)).to.be.true;

    await governorSimple.connect(alice).removeAdmin(bob.address);

    expect(await governorSimple.isAdmin(bob.address)).to.be.false;
  });
});
