import hre from 'hardhat';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { verifyContract } from '../Verify.js';
import { deployBuild } from '../Deploy.js';
import { buildToken, faucetTokenBuildFile, tokenArgs } from './DeployHelpers.js';

let verifyMockConfigured = false;

export async function mockVerifySuccess(hre: HardhatRuntimeEnvironment) {
  if (verifyMockConfigured) return;

  const server = createServer((request, response) => {
    request.resume();
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
    const action = url.searchParams.get('action');
    let result: unknown;

    if (action === 'getsourcecode') {
      result = [{ SourceCode: '' }];
    } else if (action === 'verifysourcecode') {
      result = 'MYGUID';
    } else if (action === 'checkverifystatus') {
      result = 'Pass - Verified';
    } else {
      response.writeHead(400);
      response.end();
      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: '1', message: 'OK', result }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();

  const { port } = server.address() as AddressInfo;
  const explorerUrl = `http://127.0.0.1:${port}`;
  process.env.ETHERSCAN_KEY = 'GOERLI_KEY';
  hre.config.chainDescriptors.set(5n, {
    name: 'Goerli',
    chainType: 'l1',
    blockExplorers: {
      etherscan: {
        url: explorerUrl,
        apiUrl: `${explorerUrl}/api`,
      },
    },
  });

  const connection = await hre.network.getOrCreate();
  const request = connection.provider.request.bind(connection.provider);
  connection.provider.request = async (requestArguments) =>
    requestArguments.method === 'eth_chainId'
      ? '0x5'
      : request(requestArguments);

  Object.defineProperty(hre.network, 'create', {
    configurable: true,
    value: async () => connection,
  });

  verifyMockConfigured = true;
}

describe('Verify', () => {
  describe('via artifacts', () => {
    it('verify from artifacts [success]', async () => {
      const token = await buildToken();
      await mockVerifySuccess(hre);
      await verifyContract(
        { via: 'artifacts', address: await token.getAddress(), constructorArguments: tokenArgs },
        hre,
        true
      );
    });
  });

  describe('via buildfile', () => {
    it('verify from build file', async () => {
      const contract = await deployBuild(faucetTokenBuildFile, tokenArgs, hre, { network: 'test-network' });
      await mockVerifySuccess(hre);
      await verifyContract(
        { via: 'buildfile', contract, buildFile: faucetTokenBuildFile, deployArgs: tokenArgs },
        hre,
        true
      );
    });
  });
});
