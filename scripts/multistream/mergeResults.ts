import * as fs from 'fs/promises';
import { JsonSuiteResult } from '../../plugins/scenario/Report';

export async function mergeResults(resultFiles: string[], outputFile: string): Promise<JsonSuiteResult> {
  const suiteResults: JsonSuiteResult[] = [];
  for (const file of resultFiles) {
    try {
      suiteResults.push(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (e) {
      console.error(`Skipping unreadable result file ${file}: ${(e as Error).message}`);
    }
  }

  const suites = new Set<string>();
  const tests = suiteResults.flatMap((r) => r.tests);
  const pending = suiteResults.flatMap((r) => r.pending);
  const failures = suiteResults.flatMap((r) => r.failures);
  const passes = suiteResults.flatMap((r) => r.passes);
  for (const test of tests) {
    suites.add(test.file);
  }

  const starts = suiteResults.map((r) => Date.parse(r.stats.start));
  const ends = suiteResults.map((r) => Date.parse(r.stats.end));
  const now = Date.now();
  const start = new Date(starts.length > 0 ? Math.min(...starts) : now);
  const end = new Date(ends.length > 0 ? Math.max(...ends) : now);

  const merged: JsonSuiteResult = {
    stats: {
      suites: suites.size,
      tests: tests.length,
      passes: passes.length,
      pending: pending.length,
      failures: failures.length,
      start: start.toISOString(),
      end: end.toISOString(),
      duration: end.getTime() - start.getTime(),
    },
    tests,
    pending,
    failures,
    passes,
  };

  await fs.writeFile(outputFile, JSON.stringify(merged, null, 4));
  return merged;
}
