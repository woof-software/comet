import { providers, utils } from 'ethers';

// Case-insensitive address equality.
export const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// Returns the first log which satisfies the expected event and its parameters.
export function findEvent(
  logs: providers.Log[],
  iface: utils.Interface,
  name: string,
  predicate: (emitter: string, args: utils.Result) => boolean
): { emitter: string, args: utils.Result } | undefined {
  const topic = iface.getEventTopic(name);
  for (const log of logs) {
    if (log.topics[0] !== topic) continue;
    let parsed: utils.LogDescription;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (parsed.name === name && predicate(log.address, parsed.args)) {
      return { emitter: log.address, args: parsed.args };
    }
  }
  return undefined;
}
