import '../../plugins/scenario/type-extensions';
import config from '../../hardhat.config';

// Already freshly spidered by run-scenarios.yaml's "Spider Contracts on Mainnet" prepare step,
// so it's excluded here to avoid the `spider` job redundantly spidering it a second time.
const ALREADY_SPIDERED = ['mainnet'];

function resolveBases(all: string[], inputBases: string, inputNetwork: string): string[] {
  if (inputBases) {
    return inputBases.split(',').map((name) => name.trim());
  }
  if (!inputNetwork || inputNetwork === 'all') {
    return all;
  }
  return all.filter((name) => name === inputNetwork || name.startsWith(`${inputNetwork}-`));
}

function groupBy(names: string[], keyOf: (name: string) => string): { name: string; bases: string }[] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const key = keyOf(name);
    const group = groups.get(key) ?? [];
    group.push(name);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([name, groupBases]) => ({ name, bases: groupBases.join(',') }));
}

function main() {
  const allBases = config.scenario.bases;
  const all = allBases.map((base) => base.name);
  const networkMap: Record<string, string> = {};
  for (const base of allBases) {
    networkMap[base.name] = base.network;
  }

  const bases = resolveBases(all, process.env.INPUT_BASES ?? '', process.env.INPUT_NETWORK ?? '');
  const spiderBases = bases.filter((name) => !ALREADY_SPIDERED.includes(name));

  // Used by the `spider` job: excludes bases the prepare step already spidered
  const spiderNetworkGroups = groupBy(spiderBases, (name) => networkMap[name]);
  const spiderBaseGroups = groupBy(spiderBases, (name) => name);

  // Used by the `run-scenarios` job: every chosen base still needs to actually run,
  // so nothing is excluded here (only `spider` cares about not re-spidering mainnet).
  const runNetworkGroups = groupBy(bases, (name) => networkMap[name]);
  const runBaseGroups = groupBy(bases, (name) => name);

  process.stdout.write(JSON.stringify({
    bases,
    spider_network_groups: spiderNetworkGroups,
    spider_base_groups: spiderBaseGroups,
    run_network_groups: runNetworkGroups,
    run_base_groups: runBaseGroups,
  }));
}

main();
