import '../../plugins/scenario/type-extensions';
import config from '../../hardhat.config';

function resolveBases(all: string[], inputBases: string, inputNetwork: string): string[] {
  if (inputBases) {
    return inputBases.split(',').map((name) => name.trim());
  }
  if (!inputNetwork || inputNetwork === 'all') {
    return all;
  }
  return all.filter((name) => name === inputNetwork || name.startsWith(`${inputNetwork}-`));
}

function groupBy(names: string[], keyOf: (name: string) => string): { name: string, bases: string }[] {
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

  const runNetworkGroups = groupBy(bases, (name) => networkMap[name]);
  const runBaseGroups = groupBy(bases, (name) => name);

  process.stdout.write(JSON.stringify({
    bases,
    run_network_groups: runNetworkGroups,
    run_base_groups: runBaseGroups,
  }));
}

main();
