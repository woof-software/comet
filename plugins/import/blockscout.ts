import axios from 'axios';
import 'dotenv/config';

export interface Result {
  status: string;
  message: string;
  result: string;
}

export function getBlockscoutApiUrl(network: string): string {
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

export async function get(url, data) {
  const res = (await axios.get(url, { params: data }))['data'];
  return res;
}
