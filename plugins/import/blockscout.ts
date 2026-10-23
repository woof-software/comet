import axios from 'axios';
import 'dotenv/config';

export interface Result {
  status: string;
  message: string;
  result: string;
}

// Blockscout PRO API keys only work on the api.blockscout.com gateway, not on per-chain instances
const blockscoutProChainIds: { [network: string]: number } = {
  'mainnet': 1,
  'optimism': 10,
  'base': 8453,
  'arbitrum': 42161,
  'unichain': 130,
};

function useBlockscoutProApi(network: string): boolean {
  return !!process.env.BLOCKSCOUT_KEY && network in blockscoutProChainIds;
}

export function getBlockscoutApiUrl(network: string): string {
  if (useBlockscoutProApi(network)) {
    return `https://api.blockscout.com/${blockscoutProChainIds[network]}/api`;
  }

  let host = {
    'mainnet': 'eth.blockscout.com',
    'optimism': 'optimism.blockscout.com',
    'base': 'base.blockscout.com',
    'arbitrum': 'arbitrum.blockscout.com',
    'unichain': 'unichain.blockscout.com',
    'scroll': 'scrollscan.com',
    'ronin': 'explorer.roninchain.com',
  }[network];

  if (!host) {
    throw new Error(`Unknown blockscout API host for network ${network}`);
  }

  return `https://${host}/api`;
}

// BLOCKSCOUT_KEY is only sent to the PRO API gateway
export function getBlockscoutApiKeyParams(network: string): { apikey?: string } {
  if (!useBlockscoutProApi(network)) {
    return {};
  }
  return { apikey: process.env.BLOCKSCOUT_KEY };
}

export function getBlockscoutUrl(network: string): string {
  let host = {
    'arbitrum': 'arbitrum.blockscout.com',
    'base': 'base.blockscout.com',
    'optimism': 'optimism.blockscout.com',
    'mainnet': 'eth.blockscout.com',
    'unichain': 'unichain.blockscout.com',
    'scroll': 'scrollscan.com',
    'ronin': 'explorer.roninchain.com',
  }[network];

  if (!host) {
    throw new Error(`Unknown blockscout host for network ${network}`);
  }

  return `https://${host}`;
}

export async function getBlockscoutRPCUrl(network: string): Promise<string> {
  let host = {
    'mainnet': `${process.env.MAINNET_QUICKNODE_LINK}`.replace('https://', ''),
    'optimism': `${process.env.OPTIMISM_QUICKNODE_LINK}`.replace('https://', ''),
    'base': `${process.env.BASE_QUICKNODE_LINK}`.replace('https://', ''),
    'arbitrum': `${process.env.ARBITRUM_QUICKNODE_LINK}`.replace('https://', ''),
    'unichain': `${process.env.UNICHAIN_QUICKNODE_LINK}`.replace('https://', ''),
    'scroll': `scroll-mainnet.gateway.tenderly.co`,
    'ronin': `${process.env.RONIN_QUICKNODE_LINK}`.replace('https://', ''),
  }[network];

  if (!host) {
    throw new Error(`Unknown blockscout RPC host for network ${network}`);
  }

  return `https://${host}`;
}

export async function get(url, data) {
  const res = (await axios.get(url, { params: data }))['data'];
  return res;
}
