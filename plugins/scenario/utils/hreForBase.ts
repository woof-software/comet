import hre from 'hardhat';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import type { NetworkConnection, NetworkManager } from 'hardhat/types/network';
import type { EthereumProvider } from 'hardhat/types/providers';
import { networkConfigs } from '../../../hardhat.config.js';

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

function getBlockRollback(base: ForkSpec): number {
  if (base.network === 'linea') return 150;
  if (base.network === 'ronin' || base.network === 'unichain') return 1;
  if (base.network === 'arbitrum' || base.network === 'optimism') return 10;
  if (base.network === 'base') return 100;
  if (base.network === 'mainnet') return 10;
  return 25;
}

let activeMigration = false;

export function migrationStarted() {
  activeMigration = true;
}

async function getBlockNumberWithRetry(provider: { getBlockNumber(): Promise<number> }): Promise<number> {
  const maxAttempts = 5;
  const retryDelayMs = 5000;
  const requestTimeoutMs = 10000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        provider.getBlockNumber(),
        new Promise<number>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`Timed out fetching block number after ${requestTimeoutMs / 1000}s`)), requestTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      console.warn(`Failed to fetch block number (attempt ${attempt}/${maxAttempts}). Retrying in ${retryDelayMs / 1000}s...`);
      clearTimeout(timeout);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('Failed to fetch block number after retries.');
}

export async function forkedHreForBase(base: ForkSpec): Promise<HardhatRuntimeEnvironment> {
  const migrationUrl = activeMigration
    ? networkConfigs.find(config => config.network === base.network)?.url
    : undefined;

  if (activeMigration && !migrationUrl) {
    throw new Error(`Missing migration RPC URL for network: ${base.network}`);
  }

  const remoteConnection = await hre.network.create({
    network: base.network,
    ...(migrationUrl ? { override: { url: migrationUrl } } : {}),
  });

  try {
    const remoteConfig = remoteConnection.networkConfig;
    if (remoteConfig.type !== 'http') {
      throw new Error(`Cannot fork non-HTTP network ${base.network}`);
    }
    const url = await remoteConfig.url.get();
    const blockNumber = base.blockNumber ?? (
      await getBlockNumberWithRetry(remoteConnection.ethers.provider) - getBlockRollback(base)
    );

    console.log(`Forking from network: ${base.network} at block number: ${blockNumber}`);
    const forkConnection = await hre.network.create({
      network: 'hardhat',
      override: {
        chainId: remoteConfig.chainId,
        forking: {
          enabled: true,
          url,
          blockNumber: BigInt(blockNumber),
        },
      },
    });
    return hreForConnection(forkConnection);
  } finally {
    await remoteConnection.close();
  }
}

export default async function hreForBase(base: ForkSpec, fork = true): Promise<HardhatRuntimeEnvironment> {
  return fork && base.network !== 'hardhat'
    ? forkedHreForBase(base)
    : nonForkedHreForBase(base);
}

/*
Tenderly Virtual TestNets don't implement Hardhat's `hardhat_*` cheatcodes, only their own
(tenderly_setBalance, tenderly_setStorageAt, ...) plus standard evm_* methods. This translates
the handful of hardhat_* calls made by existing scenario helpers (impersonateAddress, mineBlocks,
setEtherBalance, setNextBaseFeeToZero) to their Tenderly/standard equivalents, so that code can run
unmodified against a Virtual TestNet's Admin RPC instead of a local Hardhat fork.
*/
function translateVnetRpcCall(
  method: string,
  params: any[] = []
): { method: string, params: any[] } | null {
  switch (method) {
    // Virtual TestNets accept eth_sendTransaction from any `from` address without unlocking it first.
    case 'hardhat_impersonateAccount':
    case 'hardhat_stopImpersonatingAccount':
      return null;
    // Virtual TestNets accept 0 gasPrice/fee txs directly; there's no base-fee override cheatcode.
    case 'hardhat_setNextBlockBaseFeePerGas':
      return null;
    case 'hardhat_setBalance':
      return { method: 'tenderly_setBalance', params: [[params[0]], params[1]] };
    case 'hardhat_mine':
      return { method: 'evm_increaseBlocks', params: [params[0]] };
    default:
      return { method, params };
  }
}

function patchProviderForVnet(provider: EthereumProvider): void {
  const originalRequest = provider.request.bind(provider);
  provider.request = (async (args: { method: string, params?: any[] }) => {
    const translated = translateVnetRpcCall(args.method, args.params as any[]);
    if (!translated) return null;
    return originalRequest(translated);
  }) as typeof provider.request;

  const sendable = provider as unknown as { send?: (method: string, params?: any[]) => Promise<any> };
  if (typeof sendable.send === 'function') {
    const originalSend = sendable.send.bind(provider);
    sendable.send = async (method: string, params?: any[]) => {
      const translated = translateVnetRpcCall(method, params);
      if (!translated) return null;
      return originalSend(translated.method, translated.params);
    };
  }
}

// Connects to a Tenderly Virtual TestNet's Admin RPC as a live network, rather than forking it
// again locally, so migrations/proposals execute as real, persistent transactions on the vnet.
export async function vnetHreForBase(network: string, rpcUrl: string): Promise<HardhatRuntimeEnvironment> {
  const baseNetwork = hre.config.networks[network];
  if (!baseNetwork || baseNetwork.type !== 'http') {
    throw new Error(`Cannot connect Virtual TestNet for network: ${network}`);
  }

  const connection = await hre.network.create({
    network,
    override: {
      url: rpcUrl,
      // Let the Virtual TestNet handle unsigned transactions from impersonated addresses.
      accounts: 'remote',
    },
  });
  patchProviderForVnet(connection.provider);

  return hreForConnection(connection);
}
