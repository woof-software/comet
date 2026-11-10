import { expect } from 'chai';
import hre from 'hardhat';
import { DeploymentManager } from '../DeploymentManager';

describe('DeploymentManager state diff', () => {
  const oldAddress = '0x1111111111111111111111111111111111111111';
  const newAddress = '0x2222222222222222222222222222222222222222';
  const manager = new DeploymentManager('test-network', 'test-deployment', hre);
  type Delta = Parameters<DeploymentManager['diffDelta']>[0];
  const state = (address: string) => ({
    start: new Date('2026-01-01T00:00:00Z'), count: 1,
    spider: { roots: new Map<string, string>(), aliases: new Map([['pet', address]]), contracts: new Map() },
  });

  it('labels new and old alias addresses with the intended diff indicators', () => {
    const delta: Delta = { old: state(oldAddress), new: state(newAddress) };
    const output = manager.diffDelta(delta);
    expect(output).to.match(/^\+ New addresses$/m);
    expect(output).to.match(/^- Old addresses$/m);
    const oldLine = output.split('\n').find(line => line.includes(oldAddress));
    const newLine = output.split('\n').find(line => line.includes(newAddress));
    expect(oldLine).to.be.a('string').and.include('-');
    expect(newLine).to.be.a('string').and.include('+');
  });

  it('excludes contract objects from the diff while preserving address differences', () => {
    const baseline: Delta = { old: state(oldAddress), new: state(newAddress) };
    const changed: Delta = { old: state(oldAddress), new: state(newAddress) };
    changed.old.spider.contracts.set('oldOnly', new hre.ethers.Contract(oldAddress, [], hre.ethers.provider));
    changed.new.spider.contracts.set('newOnly', new hre.ethers.Contract(newAddress, [], hre.ethers.provider));
    expect(manager.diffDelta(changed)).to.equal(manager.diffDelta(baseline));

    const identical: Delta = { old: state(oldAddress), new: state(oldAddress) };
    const withoutContracts = manager.diffDelta(identical);
    identical.new.spider.contracts.set('extra', new hre.ethers.Contract(newAddress, [], hre.ethers.provider));
    expect(manager.diffDelta(identical)).to.equal(withoutContracts);
  });
});
