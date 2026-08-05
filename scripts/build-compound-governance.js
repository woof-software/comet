'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SUBMODULE = path.join(ROOT, 'contracts/compound-governance');
const FORGE_OUT = path.join(SUBMODULE, 'out');
const ARTIFACTS_OUT = path.join(ROOT, 'artifacts');

// Source files that belong to the compound-governance project itself
// (not OZ deps, not forge-std, not test helpers).
// The compilationTarget in rawMetadata tells us the Foundry src-relative path.
const SUBMODULE_SRC_PREFIX = 'contracts/';

function walkDir(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

function buildWithForge() {
  console.log('[compound-governance] running forge build...');
  execSync('forge build', {
    cwd: SUBMODULE,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}` },
  });
  console.log('[compound-governance] forge build done');
}

function convertArtifacts() {
  const allJsons = walkDir(FORGE_OUT).filter(
    p => !path.basename(p, '.json').endsWith('.dbg')
  );

  let converted = 0;
  for (const jsonPath of allJsons) {
    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      continue;
    }

    // Skip files that don't look like compiled contract artifacts
    if (!artifact.abi || !artifact.bytecode || !artifact.rawMetadata) continue;

    let rawMeta;
    try {
      rawMeta = JSON.parse(artifact.rawMetadata);
    } catch {
      continue;
    }

    const compilationTarget = rawMeta?.settings?.compilationTarget ?? {};
    const entries = Object.entries(compilationTarget);
    if (entries.length === 0) continue;

    const [foundrySourcePath, contractName] = entries[0];

    // Only convert production contracts from the compound-governance source tree.
    // Exclude OZ/forge deps (not under contracts/), test files, and Foundry scripts.
    if (!foundrySourcePath.startsWith(SUBMODULE_SRC_PREFIX)) continue;
    if (
      foundrySourcePath.includes('/test/') ||
      foundrySourcePath.endsWith('.t.sol') ||
      foundrySourcePath.endsWith('.s.sol')
    ) continue;

    // Map Foundry source path -> root-project source path
    // e.g. "contracts/CompoundGovernor.sol" -> "contracts/compound-governance/contracts/CompoundGovernor.sol"
    const sourceName = `contracts/compound-governance/${foundrySourcePath}`;

    const hardhatArtifact = {
      _format: 'hh-sol-artifact-1',
      contractName,
      sourceName,
      abi: artifact.abi,
      bytecode: artifact.bytecode?.object ?? '0x',
      deployedBytecode: artifact.deployedBytecode?.object ?? '0x',
      linkReferences: artifact.bytecode?.linkReferences ?? {},
      deployedLinkReferences: artifact.deployedBytecode?.linkReferences ?? {},
    };

    // Output path mirrors Hardhat convention: artifacts/<sourceName>/<contractName>.json
    const outDir = path.join(ARTIFACTS_OUT, sourceName);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `${contractName}.json`),
      JSON.stringify(hardhatArtifact, null, 2)
    );
    converted++;
  }

  console.log(`[compound-governance] converted ${converted} artifacts to Hardhat format`);
}

async function generateTypes() {
  console.log('[compound-governance] regenerating TypeChain types for all contracts...');
  const { runTypeChain, glob } = require('typechain');
  const allFiles = glob(ROOT, [`${ARTIFACTS_OUT}/contracts/**/*.json`])
    .filter(f => !f.endsWith('.dbg.json'));
  const result = await runTypeChain({
    cwd: ROOT,
    filesToProcess: allFiles,
    allFiles,
    outDir: 'build/types',
    target: 'ethers-v5',
  });
  console.log(`[compound-governance] TypeChain types done (${result.filesGenerated} files generated)`);
}

buildWithForge();
convertArtifacts();
generateTypes().catch(e => { console.error(e); process.exit(1); });
