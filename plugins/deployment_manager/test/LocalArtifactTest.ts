import { expect } from 'chai';
import { strict as assert } from 'assert';
import hre from 'hardhat';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { Cache } from '../Cache';
import { readContract } from '../Import';
import { tempDir } from './TestHelpers';

describe('Import reading local artifacts', () => {
  const artifactName = 'contracts/test/Dog.sol:Dog';
  const address = '0x1111111111111111111111111111111111111111';

  it('returns complete local artifact data on a cache miss', async () => {
    const cache = new Cache('test-network', 'test-deployment', false, tempDir());
    const artifact = await hre.artifacts.readArtifact(artifactName);
    const build = await hre.artifacts.getBuildInfo(artifactName);
    assert.ok(build);
    expect(await readContract(cache, hre, artifactName, cache.network, address)).to.eql({
      contract: 'Dog',
      contracts: {
        [artifactName]: {
          address, name: 'Dog', abi: artifact.abi, bin: artifact.bytecode,
          metadata: 'unknown', source: build.input.sources[artifact.sourceName].content,
          constructorArgs: 'unknown',
        },
      },
      version: build.solcLongVersion,
    });
  });

  it('reports a missing local artifact', async () => {
    const cache = new Cache('test-network', 'test-deployment', false, tempDir());
    await assert.rejects(readContract(cache, hre, 'MissingDeploymentTestArtifact', cache.network, address),
      /Artifact.*MissingDeploymentTestArtifact.*not found/);
  });

  it('reports missing build info instead of returning incomplete contract data', async () => {
    const cache = new Cache('test-network', 'test-deployment', false, tempDir());
    const runtime: HardhatRuntimeEnvironment = {
      ...hre,
      artifacts: Object.assign(Object.create(hre.artifacts), {
        getBuildInfo: async () => undefined,
      }),
    };
    // The artifact exists, but its compiler build info is deliberately unavailable.
    // Current code reports a TypeError; a clearer diagnostic can be agreed separately.
    await assert.rejects(readContract(cache, runtime, artifactName, cache.network, address), TypeError);
  });
});
