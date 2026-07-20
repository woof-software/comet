import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { ForkSpec } from '../../plugins/scenario/World';
import { mergeResults } from './mergeResults';
import { JsonSuiteResult } from '../../plugins/scenario/Report';

const RESULTS_DIR = path.join(__dirname, '..', '..', 'results');
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const MERGED_OUTPUT = path.join(__dirname, '..', '..', 'scenario-results.json');

function groupBases(bases: ForkSpec[], perBase: boolean): Map<string, ForkSpec[]> {
  const groups = new Map<string, ForkSpec[]>();
  for (const base of bases) {
    const key = perBase ? base.name : base.network;
    const group = groups.get(key) ?? [];
    group.push(base);
    groups.set(key, group);
  }
  return groups;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
  });
}

function runStream(group: string, bases: ForkSpec[]): Promise<{ group: string, code: number | null }> {
  return new Promise((resolve, reject) => {
    const resultsFile = path.join(RESULTS_DIR, `${group}.json`);
    const logFile = path.join(LOGS_DIR, `${group}.log`);
    const log = fs.createWriteStream(logFile);

    const child = spawn(
      'yarn',
      ['scenario', '--bases', bases.map((b) => b.name).join(','), '--output', resultsFile],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    // Locally, also echo to the terminal live. In CI, skip this: the orchestration messages
    // above (Preparing/Launching/etc.) still print via plain console.log either way, but each
    // stream's full verbose scenario-by-scenario output would otherwise duplicate what the
    // per-base display-scenario-logs jobs already show more legibly.
    if (!process.env.CI) {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    child.on('error', reject);
    child.on('exit', (code) => resolve({ group, code }));
  });
}

function printSummary(streamResults: { group: string, code: number | null }[]) {
  console.log('\n\nMultistream summary:');
  for (const { group, code } of streamResults) {
    const prefix = code === 0 ? '✅' : '❌';
    console.log(`${prefix} ${group} [logs/${group}.log] exited with code ${code}`);
  }
  console.log('\n');
}

export async function runMultistream(bases: ForkSpec[], perBase: boolean = false): Promise<void> {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const groups = groupBases(bases, perBase);
  const mainnetBases = bases.filter((b) => b.network === 'mainnet');
  const otherBases = bases.filter((b) => b.network !== 'mainnet');

  console.log(`Preparing: yarn build`);
  await run('yarn', ['build']);

  if (mainnetBases.length > 0) {
    console.log(`Preparing: warming spider cache for mainnet (${mainnetBases.length} base(s)) first`);
    await run('yarn', ['hardhat', 'scenario:spider', '--bases', mainnetBases.map((b) => b.name).join(',')]);
  }

  if (otherBases.length > 0) {
    console.log(`Preparing: warming spider cache for the remaining ${otherBases.length} base(s), in parallel`);
    await run('yarn', ['hardhat', 'scenario:spider', '--bases', otherBases.map((b) => b.name).join(',')]);
  }

  console.log(`Launching ${groups.size} stream(s) (${perBase ? 'per-base' : 'per-network'}): ${[...groups.keys()].join(', ')}`);
  if (perBase) {
    console.log(`⚠️  --per-base bypasses the bridged-deployment write-race protection.`);
  }
  const streamResults = await Promise.all(
    [...groups.entries()].map(([group, groupBases]) => runStream(group, groupBases))
  );

  const resultFiles = [...groups.keys()].map((group) => path.join(RESULTS_DIR, `${group}.json`));
  const existingResultFiles = resultFiles.filter((file) => fs.existsSync(file));
  const merged: JsonSuiteResult = await mergeResults(existingResultFiles, MERGED_OUTPUT);

  printSummary(streamResults);
  console.log(
    `Merged ${existingResultFiles.length}/${resultFiles.length} stream result file(s) into ${MERGED_OUTPUT}: ` +
    `${merged.stats.passes} passed, ${merged.stats.failures} failed, ${merged.stats.pending} skipped`
  );

  const anyFailed = streamResults.some(({ code }) => code !== 0) || merged.stats.failures > 0;
  process.exitCode = anyFailed ? 1 : 0;
}
