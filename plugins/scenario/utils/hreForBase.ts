import hre from 'hardhat';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import type { NetworkConnection, NetworkManager } from 'hardhat/types/network';

import type { ForkSpec } from '../World.js';

function hreForConnection(connection: NetworkConnection): HardhatRuntimeEnvironment {
  const network = Object.create(hre.network) as NetworkManager;
  Object.defineProperty(network, 'getOrCreate', {
    value: async () => connection,
  });
  return Object.assign(Object.create(hre), { network }) as HardhatRuntimeEnvironment;
}

export async function nonForkedHreForBase(base: ForkSpec): Promise<HardhatRuntimeEnvironment> {
  return hreForConnection(await hre.network.create(base.network));
}

function getBlockRollback(base: ForkSpec): number | undefined {
  console.log(`Getting block rollback for network: ${base.network}`);
  if (base.network === 'linea') return 150;
  if (base.network === 'ronin' || base.network === 'unichain') return 1;
  if (base.network === 'arbitrum' || base.network === 'optimism') return undefined;
  if (base.network === 'base') return 100;
  if (base.network === 'mainnet') return 10;
  return 25;
}

export async function forkedHreForBase(base: ForkSpec): Promise<HardhatRuntimeEnvironment> {
  const remoteConnection = await hre.network.create(base.network);
  const remoteEthers = remoteConnection.ethers;
  const currentBlock = await remoteEthers.provider.getBlockNumber();
  const rollback = getBlockRollback(base);
  const blockNumber = base.blockNumber ?? (rollback === undefined ? undefined : currentBlock - rollback);
  const remoteConfig = remoteConnection.networkConfig;
  if (remoteConfig.type !== 'http') {
    throw new Error(`Cannot fork non-HTTP network ${base.network}`);
  }
  const url = await remoteConfig.url.get();

  console.log(`Forking from network: ${base.network}${blockNumber === undefined ? '' : ` at block number: ${blockNumber}`}`);
  const forkConnection = await hre.network.create({
    network: 'hardhat',
    override: {
      chainId: remoteConfig.chainId,
      forking: {
        enabled: true,
        url,
        blockNumber: blockNumber === undefined ? undefined : BigInt(blockNumber),
      },
    },
  });
  return hreForConnection(forkConnection);
}

export default async function hreForBase(base: ForkSpec, fork = true): Promise<HardhatRuntimeEnvironment> {
  return fork ? forkedHreForBase(base) : nonForkedHreForBase(base);
}
