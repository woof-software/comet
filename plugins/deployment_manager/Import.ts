import { readFile } from 'node:fs/promises';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import type { Address, BuildFile } from './Types.js';
import { getBuildFile, storeBuildFile } from './ContractMap.js';
import { Cache } from './Cache.js';
import { loadContract } from '../import/import.js';

const DEFAULT_RETRIES = 7;
const DEFAULT_RETRY_DELAY = 10_000;

/**
 * Imports a contract from remote, e.g. Etherscan, generating local build file.
 */
export async function fetchAndCacheContract(
  cache: Cache,
  network: string,
  address: Address,
  importRetries = DEFAULT_RETRIES,
  importRetryDelay = DEFAULT_RETRY_DELAY,
  force = false
): Promise<BuildFile> {
  const buildFile = await fetchContract(cache, network, address, importRetries, importRetryDelay, force);
  await storeBuildFile(cache, network, address, buildFile);
  return buildFile;
}

const blockScoutNetworks = ['unichain', 'scroll'];

// Wrapper for pulling contract data from Etherscan
export async function importContract(
  network: string,
  address: Address,
  retries: number = DEFAULT_RETRIES,
  retryDelay: number = DEFAULT_RETRY_DELAY
): Promise<BuildFile> {
  if(blockScoutNetworks.includes(network)) {
    try {
      console.log(`Importing ${address} from ${network} blockscout`);
      return (await loadContract('blockscout', network, address)) as BuildFile;
    } catch (e) {
      if (retries === 0 || (e.message && e.message.includes('Contract source code not verified'))) {
        throw e;
      }
  
      console.warn(`Import failed for ${network}@${address} (${e.message}), retrying in ${retryDelay / 1000}s; ${retries} retries left`);
  
      await new Promise(ok => setTimeout(ok, retryDelay));
      return importContract(network, address, retries - 1, retryDelay * 2 > 10000 ? 10000 : retryDelay * 2);
    }
  }

  try {
    if(network === 'ronin') {
      return (await loadContract('ronin', network, address)) as BuildFile;
    }
    return (await loadContract('etherscan', network, address)) as BuildFile;
  } catch (e) {
    if (retries === 0 || (e.message && e.message.includes('Contract source code not verified'))) {
      throw e;
    }

    console.warn(`Import failed for ${network}@${address} (${e.message}), retrying in ${retryDelay / 1000}s; ${retries} retries left`);

    await new Promise(ok => setTimeout(ok, retryDelay));
    return importContract(network, address, retries - 1, retryDelay * 2 > 10000 ? 10000 : retryDelay * 2);
  }
}

// Reads a contract if exists in cache, otherwise attempts to import contract by address
export async function fetchContract(
  cache: Cache,
  network: string,
  address: Address,
  importRetries = DEFAULT_RETRIES,
  importRetryDelay = DEFAULT_RETRY_DELAY,
  force = false
): Promise<BuildFile> {
  const cachedBuildFile = !force && await getBuildFile(cache, network, address);
  if (cachedBuildFile) {
    return cachedBuildFile;
  } else {
    return importContract(network, address, importRetries, importRetryDelay);
  }
}

// Reads a contract if exists in cache, otherwise attempts to load contract by artifact
export async function readContract(
  cache: Cache,
  hre: HardhatRuntimeEnvironment,
  fullyQualifiedName: string,
  network: string,
  address: Address,
  force = false
): Promise<BuildFile> {
  const cachedBuildFile = !force && await getBuildFile(cache, network, address);
  if (cachedBuildFile) {
    return cachedBuildFile;
  } else {
    const artifact = await hre.artifacts.readArtifact(fullyQualifiedName);
    const buildInfoId = await hre.artifacts.getBuildInfoId(fullyQualifiedName);
    if (buildInfoId === undefined) {
      throw new Error(`Missing build info for ${fullyQualifiedName}`);
    }
    const buildInfoPath = await hre.artifacts.getBuildInfoPath(buildInfoId);
    if (buildInfoPath === undefined) {
      throw new Error(`Missing build info file for ${fullyQualifiedName}`);
    }
    const buildInfo = JSON.parse(await readFile(buildInfoPath, 'utf8'));
    const inputSourceName = artifact.inputSourceName ?? artifact.sourceName;
    const source = buildInfo.input.sources[inputSourceName]?.content;
    if (source === undefined) {
      throw new Error(`Missing source ${inputSourceName} in build info for ${fullyQualifiedName}`);
    }
    return {
      contract: artifact.contractName,
      contracts: {
        [`${artifact.sourceName}:${artifact.contractName}`]: {
          address,
          name: artifact.contractName,
          abi: artifact.abi,
          bin: artifact.bytecode,
          metadata: 'unknown',
          source,
          constructorArgs: 'unknown',
        },
      } as BuildFile['contracts'],
      version: buildInfo.solcLongVersion,
    };
  }
}
