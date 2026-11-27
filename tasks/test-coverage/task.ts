import { task } from 'hardhat/config';

// solidity-coverage uses shelljs.ls with a *.sol glob, which expands directories
// named *.sol (e.g. contracts/capo/abi/json/IERC20.sol/) and returns their contents
// as relative paths (e.g. "IERC20.json"). Those relative paths can't be loaded.
// This override filters shelljs.ls results to only .sol and .vy files.
task('coverage', async (taskArgs, hre, runSuper) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const shell = require('shelljs');
  const originalLs = shell.ls;
  shell.ls = function (...args: unknown[]) {
    const result = originalLs.apply(this, args);
    const filtered = Array.from(result as string[]).filter(
      (f: string) => f.endsWith('.sol') || f.endsWith('.vy')
    );
    return Object.assign(filtered, { stdout: result.stdout, stderr: result.stderr, code: result.code });
  };
  try {
    return await runSuper(taskArgs);
  } finally {
    shell.ls = originalLs;
  }
});