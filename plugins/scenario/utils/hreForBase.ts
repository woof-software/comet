import { ethers } from 'ethers';
import type { HardhatEthersHelpers } from '@nomiclabs/hardhat-ethers/types';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { HardhatContext } from 'hardhat/internal/context';
import { loadConfigAndTasks } from 'hardhat/internal/core/config/config-loading';
import { getEnvHardhatArguments } from 'hardhat/internal/core/params/env-variables';
import { HARDHAT_PARAM_DEFINITIONS } from 'hardhat/internal/core/params/hardhat-params';
import { Environment } from 'hardhat/internal/core/runtime-environment';
import { ForkSpec } from '../World';
import { HttpNetworkConfig, HttpNetworkUserConfig } from 'hardhat/types';
import { EthereumProvider } from 'hardhat/types/provider';

/*
mimics https://github.com/nomiclabs/hardhat/blob/master/packages/hardhat-core/src/internal/lib/hardhat-lib.ts

Hardhat's Environment class implements the HardhatRuntimeEnvironment interface.
However, the ethers and waffle plugins later extend the
HardhatRuntimeEnvironment interface. So if we want to interact with the
Environment class after the plugins have been loaded, we need to replicate the
alterations made to HardhatRuntimeEnvironment on the Environment interface.

These alterations will almost certainly go out-of-date as the ethers and waffle
packages are updated, and we'll need to do a similar alteration for any
additional packages that alter the HardhatRuntimeEnvironment interface.

ethers type extension: https://github.com/nomiclabs/hardhat/blob/master/packages/hardhat-ethers/src/internal/type-extensions.ts
waffle type extension: https://github.com/nomiclabs/hardhat/blob/master/packages/hardhat-waffle/src/type-extensions.ts
change network extension: https://github.com/dmihal/hardhat-change-network/blob/master/src/type-extensions.ts
*/
declare module 'hardhat/internal/core/runtime-environment' {
  interface Environment {
    waffle: any;
    ethers: typeof ethers & HardhatEthersHelpers;
    changeNetwork(newNetwork: string): void;
    getProvider(newNetwork: string): EthereumProvider;
  }
}

export async function nonForkedHreForBase(base: ForkSpec): Promise<HardhatRuntimeEnvironment> {
  const ctx: HardhatContext = HardhatContext.getHardhatContext();

  const hardhatArguments = getEnvHardhatArguments(
    HARDHAT_PARAM_DEFINITIONS,
    process.env
  );

  const { resolvedConfig, userConfig } = loadConfigAndTasks(hardhatArguments);

  return new Environment(
    resolvedConfig,
    {
      ...hardhatArguments,
      ...{
        network: base.network
      }
    },
    ctx.tasksDSL.getTaskDefinitions(),
    ctx.environment.scopes,
    ctx.environmentExtenders,
    userConfig
  );
}

function getBlockRollback(base: ForkSpec) {
  console.log(`Getting block rollback for network: ${base.network}`);
  if (base.blockNumber)
    return base.blockNumber;
  else if(base.network === 'linea')
    return 150;
  else if (base.network === 'ronin'){
    return 0;
  }
  else if (base.network === 'arbitrum') {
    return undefined;
  }
  else if (base.network === 'unichain') {
    return 0;
  }
  else if (base.network === 'base') {
    return 100;
  }
  else if (base.network === 'optimism') {
    return undefined;
  }
  else if (base.network === 'mainnet') {
    return 10;
  }
  else
    return 25;
}

export async function forkedHreForBase(base: ForkSpec): Promise<HardhatRuntimeEnvironment> {
  const ctx: HardhatContext = HardhatContext.getHardhatContext();

  const hardhatArguments = getEnvHardhatArguments(HARDHAT_PARAM_DEFINITIONS, process.env);

  const { resolvedConfig: config, userConfig } = loadConfigAndTasks(hardhatArguments);

  const networks = config.networks;
  const { hardhat: defaultNetwork, localhost } = networks;

  const baseNetwork = networks[base.network] as HttpNetworkUserConfig;

  const provider = new ethers.providers.JsonRpcProvider(baseNetwork.url);
  if(baseNetwork.url)
    console.log(`Forking from network: ${base.network} at block number: ${await provider.getBlockNumber() - (getBlockRollback(base) || 0)}`);

  // noNetwork otherwise
  if (!base.blockNumber && baseNetwork.url && getBlockRollback(base) !== undefined)
    base.blockNumber = await provider.getBlockNumber() - getBlockRollback(base); // arbitrary number of blocks to go back

  if (getBlockRollback(base) === 0) {
    const provider = new ethers.providers.JsonRpcProvider(baseNetwork.url);
    const block = await provider.getBlockNumber();
    base.blockNumber = block - 1;
  }

  if (!baseNetwork) {
    throw new Error(`cannot find network config for network: ${base.network}`);
  }

  const forkedNetwork = {
    ...defaultNetwork,
    ...{
      forking: {
        enabled: true,
        url: baseNetwork.url,
        httpHeaders: {},
        ...(base.blockNumber && { blockNumber: base.blockNumber }),
      },
    },
    ...(baseNetwork.chainId ? { chainId: baseNetwork.chainId } : {}),
  };

  const forkedConfig = {
    ...config,
    ...{
      defaultNetwork: 'hardhat',
      networks: {
        hardhat: forkedNetwork,
        localhost: localhost
      },
    },
  };
  return new Environment(
    forkedConfig,
    hardhatArguments,
    ctx.tasksDSL.getTaskDefinitions(),
    ctx.environment.scopes,
    ctx.environmentExtenders,
    userConfig
  );
}

export default async function hreForBase(base: ForkSpec, fork = true): Promise<HardhatRuntimeEnvironment> {
  if (fork) {
    return forkedHreForBase(base);
  } else {
    return nonForkedHreForBase(base);
  }
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
  const ctx: HardhatContext = HardhatContext.getHardhatContext();

  const hardhatArguments = getEnvHardhatArguments(HARDHAT_PARAM_DEFINITIONS, process.env);

  const { resolvedConfig: config, userConfig } = loadConfigAndTasks(hardhatArguments);

  const networks = config.networks;
  const baseNetwork = networks[network] as HttpNetworkConfig;
  if (!baseNetwork) {
    throw new Error(`cannot find network config for network: ${network}`);
  }

  const vnetConfig = {
    ...config,
    defaultNetwork: network,
    networks: {
      ...networks,
      // `accounts: 'remote'` disables Hardhat's local-accounts provider wrapper, which would
      // otherwise reject `eth_sendTransaction` from any address besides the configured private
      // key (e.g. an impersonated whale) with HH103. Virtual TestNets accept unsigned
      // eth_sendTransaction from any address directly, so signing can be fully delegated to the node.
      [network]: { ...baseNetwork, url: rpcUrl, accounts: 'remote' as const },
    },
  };

  const env = new Environment(
    vnetConfig,
    { ...hardhatArguments, network },
    ctx.tasksDSL.getTaskDefinitions(),
    ctx.environment.scopes,
    ctx.environmentExtenders,
    userConfig
  );

  patchProviderForVnet(env.network.provider);

  return env;
}