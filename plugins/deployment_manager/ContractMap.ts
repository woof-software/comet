import * as fs from 'fs/promises';
import * as nodepath from 'path';
import { Contract } from 'ethers';
import { Cache, FileSpec } from './Cache';
import { Address, Alias, BuildFile } from './Types';

export type ContractMap = Map<Alias, Contract>;

function getFileSpec(network: string, address: Address): FileSpec {
  return { top: [network, '.contracts', address + '.json'] };
}

export async function getBuildFile(cache: Cache, network: string, address: Address): Promise<BuildFile> {
  return cache.readCache<BuildFile>(getFileSpec(network, address));
}

export async function storeBuildFile(cache: Cache, network: string, address: Address, buildFile: BuildFile) {
  await cache.storeCache(getFileSpec(network, address), buildFile);
}

const ARCHIVE_DIR = nodepath.join(process.cwd(), 'plugins', 'import', 'contracts-archive');

// Merges every archived build file for `network` into `cache`
export async function seedArchiveCache(cache: Cache, network: string): Promise<void> {
  const archiveDir = nodepath.join(ARCHIVE_DIR, network.toLowerCase(), '.contracts');
  let files: string[];
  try {
    files = await fs.readdir(archiveDir);
  } catch {
    return; // submodule not initialized, or no archive entries for this network
  }

  await Promise.all(files.map(async (file) => {
    if (!file.endsWith('.json')) return;
    const address = file.slice(0, -'.json'.length);
    if (await getBuildFile(cache, network, address)) return;

    try {
      const buildFile = JSON.parse(await fs.readFile(nodepath.join(archiveDir, file), 'utf8'));
      await storeBuildFile(cache, network, address, buildFile);
    } catch (e) {
      console.warn(`Skipping malformed archive entry ${network}/${file}: ${e.message}`);
    }
  }));
}

// Reads one archived build file directly off disk, for networks seedArchiveCache() hasn't covered
export async function getArchivedBuildFile(network: string, address: Address): Promise<BuildFile | undefined> {
  const file = nodepath.join(ARCHIVE_DIR, network.toLowerCase(), '.contracts', `${address.toLowerCase()}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`Skipping malformed archive entry ${network}/${address}: ${e.message}`);
    }
    return undefined;
  }
}
