import 'dotenv/config';

import hardhatEthers from '@nomicfoundation/hardhat-ethers';
import hardhatEthersChaiMatchers from '@nomicfoundation/hardhat-ethers-chai-matchers';
import hardhatMocha from '@nomicfoundation/hardhat-mocha';
import hardhatNetworkHelpers from '@nomicfoundation/hardhat-network-helpers';
import hardhatTypechain from '@nomicfoundation/hardhat-typechain';
import { defineConfig } from 'hardhat/config';

import sourceFilterPlugin from './plugins/hardhat3/source-filter-plugin.js';

const {
  ETH_PK,
  MAINNET_QUICKNODE_LINK = '',
  RONIN_QUICKNODE_LINK = '',
  POLYGON_QUICKNODE_LINK = '',
  OPTIMISM_QUICKNODE_LINK = '',
  MANTLE_QUICKNODE_LINK = '',
  BASE_QUICKNODE_LINK = '',
  ARBITRUM_QUICKNODE_LINK = '',
  UNICHAIN_QUICKNODE_LINK = '',
  LINEA_QUICKNODE_LINK = '',
  MNEMONIC = 'myth like woof scare over problem client lizard pioneer submit female collect',
  NETWORK_PROVIDER = '',
  GOV_NETWORK_PROVIDER = '',
  GOV_NETWORK = '',
  REMOTE_ACCOUNTS = '',
} = process.env;

interface NetworkConfig {
  network: string;
  chainId: number;
  url: string;
  gas?: number | 'auto';
  gasPrice?: number | 'auto';
}

export const networkConfigs: NetworkConfig[] = [
  { network: 'mainnet', chainId: 1, url: MAINNET_QUICKNODE_LINK },
  { network: 'ronin', chainId: 2020, url: RONIN_QUICKNODE_LINK },
  { network: 'polygon', chainId: 137, url: POLYGON_QUICKNODE_LINK },
  { network: 'optimism', chainId: 10, url: OPTIMISM_QUICKNODE_LINK },
  { network: 'mantle', chainId: 5000, url: MANTLE_QUICKNODE_LINK },
  { network: 'unichain', chainId: 130, url: UNICHAIN_QUICKNODE_LINK },
  { network: 'linea', chainId: 59144, url: LINEA_QUICKNODE_LINK },
  { network: 'base', chainId: 8453, url: BASE_QUICKNODE_LINK },
  { network: 'arbitrum', chainId: 42161, url: ARBITRUM_QUICKNODE_LINK },
  { network: 'scroll', chainId: 534352, url: 'https://scroll-mainnet.gateway.tenderly.co' },
];

function deriveAccounts(privateKey: string, count = 20): string[] {
  const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

  return Array.from({ length: count }, (_, index) =>
    `0x${(BigInt(normalizedPrivateKey) + BigInt(index)).toString(16).padStart(64, '0')}`
  );
}

const remoteNetworks = Object.fromEntries(
  networkConfigs.map(({ network, chainId, url, gas = 'auto', gasPrice = 'auto' }) => [
    network,
    {
      type: 'http' as const,
      chainId,
      url:
        (network === GOV_NETWORK ? GOV_NETWORK_PROVIDER || undefined : undefined) ||
        NETWORK_PROVIDER ||
        url,
      gas,
      gasPrice,
      accounts: REMOTE_ACCOUNTS
        ? ('remote' as const)
        : ETH_PK
          ? deriveAccounts(ETH_PK)
          : { mnemonic: MNEMONIC },
    },
  ])
);

export default defineConfig({
  plugins: [
    sourceFilterPlugin,
    hardhatEthers,
    hardhatEthersChaiMatchers,
    hardhatMocha,
    hardhatNetworkHelpers,
    hardhatTypechain,
  ],

  solidity: {
    version: '0.8.15',
    settings: {
      optimizer: process.env.OPTIMIZER_DISABLED
        ? { enabled: false }
        : {
            enabled: true,
            runs: 1,
            details: {
              yulDetails: {
                optimizerSteps:
                  'dhfoDgvulfnTUtnIf [xa[r]scLM cCTUtTOntnfDIul Lcul Vcul [j] Tpeul xa[rul] xa[r]cL gvif CTUca[r]LsTOtfDnca[r]Iulc] jmul[jul] VcTOcul jmul',
              },
            },
          },
      outputSelection: {
        '*': {
          '*': ['evm.deployedBytecode.sourceMap'],
        },
      },
      viaIR: !process.env.OPTIMIZER_DISABLED,
    },
  },

  paths: {
    artifacts: 'build',
    cache: 'cache',
    sources: 'contracts',
    tests: {
      mocha: 'test',
    },
  },

  networks: {
    hardhat: {
      type: 'edr-simulated',
      chainId: 1337,
      loggingEnabled: Boolean(process.env.LOGGING),
      gas: 120_000_000,
      gasPrice: 'auto',
      blockGasLimit: 120_000_000,
      accounts: ETH_PK
        ? deriveAccounts(ETH_PK).map((privateKey) => ({
            privateKey,
            balance: 10n ** 36n,
          }))
        : {
            mnemonic: MNEMONIC,
            accountsBalance: 10n ** 36n,
          },
      allowUnlimitedContractSize: true,
    },
    ...remoteNetworks,
  },

  typechain: {
    outDir: 'build/types',
  },
});
