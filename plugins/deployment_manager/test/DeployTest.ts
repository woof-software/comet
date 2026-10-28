import { expect } from 'chai';
import * as fs from 'fs/promises';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { deploy } from '../Deploy';
import { Cache } from '../Cache';
import { recordTimers, tempDir } from './TestHelpers';
import { buildToken, deployBuild, faucetTokenBuildFile, tokenArgs, hre } from './DeployHelpers';

// TODO: Test verify
// TODO: Test caching

describe('Deploy', () => {
  it('deploy', async () => {
    let token = await buildToken();
    expect(await token.symbol()).to.equal('TEST');
  });

  it('deployBuild', async () => {
    let token = await deployBuild(faucetTokenBuildFile, tokenArgs, hre, { network: 'test-network' });
    expect(await token.symbol()).to.equal('TEST');
  });

  it('retries a verification failure in standalone Deploy.ts without losing the receiver', async () => {
    // Isolate cache files and shorten deployment retry waits.
    const dir = await fs.mkdtemp(tempDir());
    const timers = recordTimers(true);
    let verificationAttempts = 0;
    const failure = new Error('Temporary verification failure');
    // Fail the first verification attempt, allow the next one to succeed.
    const runtime: HardhatRuntimeEnvironment = {
      ...hre,
      run: (async () => {
        verificationAttempts++;
        if (verificationAttempts === 1) throw failure;
      }) as HardhatRuntimeEnvironment['run'],
    };
    try {
      let caught: unknown;
      let address: string | undefined;
      try {
        // Deploy a real local contract and verify it immediately.
        const contract = await deploy('test/Dog.sol', [
          'standalone', hre.ethers.constants.AddressZero, [],
        ], runtime, {
          network: 'test-network',
          cache: new Cache('test-network', 'test-deployment', true, dir),
          verificationStrategy: 'eager',
          raiseOnVerificationFailure: true,
        });
        address = contract.address;
      } catch (error) {
        caught = error;
      }
      // Expect recovery after one retry, with no error escaping from deploy().
      expect(caught, 'verification retry must not throw an unbound-this error').to.equal(undefined);
      expect(verificationAttempts).to.equal(2);
      expect(address).to.be.a('string');
    } finally {
      // Clean up even when the regression assertion fails.
      timers.restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
