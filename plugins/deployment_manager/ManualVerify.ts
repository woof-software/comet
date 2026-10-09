import { writeFile } from 'node:fs/promises';
import { Interface } from 'ethers';
import type { Contract } from 'ethers';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';

import type { BuildFile } from './Types.js';
import { getPrimaryContract } from './Utils.js';

/** Verifies imported/spidered bytecode using the compiler metadata kept in its build file. */
export async function manualVerifyContract(
  contract: Contract,
  buildFile: BuildFile,
  deployArgs: any[],
  hre: HardhatRuntimeEnvironment
): Promise<void> {
  const [contractName, contractMetadata] = getPrimaryContract(buildFile);
  const contractAddress = (await contract.getAddress()).toLowerCase();
  const sourceName = contractMetadata.source;
  if (sourceName === undefined) {
    throw new Error(`Build file for ${contractName} does not include its source name`);
  }

  const metadata = JSON.parse(contractMetadata.metadata);
  const compilerVersion = metadata.compiler.version.replace(
    /\+commit\.([0-9a-fA-F]+)\..*/gi,
    '+commit.$1'
  );
  const settings = { ...metadata.settings };
  delete settings.compilationTarget;
  if (settings.optimizer?.runs > 1_000_000) {
    settings.optimizer = { ...settings.optimizer, runs: 1_000_000 };
  }

  const compilerInput = {
    language: metadata.language,
    settings,
    sources: metadata.sources,
  };
  const constructorArguments = new Interface(contractMetadata.abi).encodeDeploy(deployArgs).slice(2);
  const fullyQualifiedName = `${sourceName}:${contractName}`;

  if (process.env.DEBUG_VERIFY) {
    await writeFile(`sources-${contractAddress}.json`, JSON.stringify(compilerInput));
  }

  const { verification } = await hre.network.getOrCreate();
  const etherscan = verification.etherscan;
  const guid = await etherscan.verify({
    contractAddress,
    compilerInput,
    contractName: fullyQualifiedName,
    compilerVersion,
    constructorArguments,
  });
  const result = await etherscan.pollVerificationStatus(guid, contractAddress, contractName);
  if (!result.success) {
    throw new Error(`Verification failed for ${fullyQualifiedName}: ${result.message}`);
  }
}
