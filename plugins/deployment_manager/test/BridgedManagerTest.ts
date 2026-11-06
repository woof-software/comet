import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import * as path from 'path';
import { DeploymentManager } from '../DeploymentManager';
import { tempDir } from './TestHelpers';

describe('DeploymentManager bridged managers', () => {
  const originalLoad = DeploymentManager.prototype.loadContractsFromExistingCache;
  const originalSpider = DeploymentManager.prototype.spider;
  let parent: DeploymentManager;
  let calls: Array<{ manager: DeploymentManager, action: string }>;

  beforeEach(() => {
    calls = [];
    parent = new DeploymentManager('test-network', 'parent', hre, {
      baseDir: tempDir(), writeCacheToDisk: false, verificationStrategy: 'none', importRetries: 2,
    });
    // Observe child initialization without touching the default deployments/ directory.
    DeploymentManager.prototype.loadContractsFromExistingCache = async function () {
      calls.push({ manager: this, action: 'load' });
      this.contractsCache = new Map();
    };
    DeploymentManager.prototype.spider = async function () {
      calls.push({ manager: this, action: 'spider' });
      return { roots: new Map(), aliases: new Map(), contracts: new Map() };
    };
  });
  afterEach(() => {
    DeploymentManager.prototype.loadContractsFromExistingCache = originalLoad;
    DeploymentManager.prototype.spider = originalSpider;
  });

  it('reuses the same pair and initializes each different pair exactly once', async () => {
    const first = await parent.addBridgedDeploymentManager(parent.network, 'market-a');
    expect(await parent.addBridgedDeploymentManager(parent.network, 'market-a')).to.equal(first);
    const otherMarket = await parent.addBridgedDeploymentManager(parent.network, 'market-b');
    const otherNetwork = await parent.addBridgedDeploymentManager('other-network', 'market-a', hre);
    expect(otherMarket).not.to.equal(first);
    expect(otherNetwork).not.to.equal(first);
    expect(otherNetwork).not.to.equal(otherMarket);
    expect(parent.bridgedDeploymentManagers.size).to.equal(3);
    expect(calls.map(call => call.action)).to.eql(['load', 'spider', 'load', 'spider', 'load', 'spider']);
    expect(calls.map(call => call.manager)).to.eql([first, first, otherMarket, otherMarket, otherNetwork, otherNetwork]);
  });

  it('uses the parent HRE for the same network when no HRE is supplied', async () => {
    const child = await parent.addBridgedDeploymentManager(parent.network, 'child');
    expect(child.hre).to.equal(parent.hre);
    expect(child.network).to.equal(parent.network);
    expect(child.deployment).to.equal('child');
  });

  it('rejects another network without an explicit HRE before initializing a child', async () => {
    await assert.rejects(parent.addBridgedDeploymentManager('other-network', 'child'),
      /Must provide hre to bridge to a different network deployment manager/);
    expect(calls).to.eql([]);
    expect(parent.bridgedDeploymentManagers.size).to.equal(0);
  });

  it('uses the supplied HRE for another network', async () => {
    const supplied = { ...hre, network: { ...hre.network, name: 'other-network' } };
    const child = await parent.addBridgedDeploymentManager('other-network', 'child', supplied);
    expect(child.hre).to.equal(supplied);
    expect(child.hre).not.to.equal(parent.hre);
    expect(calls.map(call => call.action)).to.eql(['load', 'spider']);
  });

  it('characterizes child settings without assuming inheritance from the parent', async () => {
    const child = await parent.addBridgedDeploymentManager(parent.network, 'child');
    expect(child.config).to.eql({ writeCacheToDisk: true });
    expect(child.cache.writeCacheToDisk).to.equal(true);
    expect(child.cache.deploymentDir).to.equal(path.join(process.cwd(), 'deployments'));
    expect(child.cache.deploymentDir).not.to.equal(parent.cache.deploymentDir);
    expect(child.config.verificationStrategy).to.equal(undefined);
    expect(child.config.importRetries).to.equal(undefined);
    expect(parent.cache.writeCacheToDisk).to.equal(false);
    expect(parent.config.verificationStrategy).to.equal('none');
  });

  for (const boundary of ['load', 'spider'] as const) {
    it(`propagates a ${boundary} failure without caching a partially initialized child`, async () => {
      const failure = new Error(`Injected child ${boundary} failure`);
      if (boundary === 'load') {
        DeploymentManager.prototype.loadContractsFromExistingCache = async function () {
          calls.push({ manager: this, action: 'load' });
          throw failure;
        };
      } else {
        DeploymentManager.prototype.spider = async function () {
          calls.push({ manager: this, action: 'spider' });
          throw failure;
        };
      }
      await assert.rejects(parent.addBridgedDeploymentManager(parent.network, 'child'), error => error === failure);
      expect(parent.bridgedDeploymentManagers.size).to.equal(0);
      expect(calls.map(call => call.action)).to.eql(boundary === 'load' ? ['load'] : ['load', 'spider']);
    });
  }
});
