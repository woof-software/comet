import type { HookContext, SolidityHooks } from 'hardhat/types/hooks';

const EXTERNAL_CONTRACTS_COMPILE_LIST = [
  'contracts/capo/contracts/test/MockERC20.sol',
];

function shouldCompile(sourcePath: string): boolean {
  if (EXTERNAL_CONTRACTS_COMPILE_LIST.some((allowed) => sourcePath.includes(allowed))) {
    return true;
  }

  return !(
    sourcePath.includes('contracts/capo/contracts/test/') ||
    sourcePath.includes('contracts/capo/test/') ||
    sourcePath.includes('forge-std') ||
    sourcePath.endsWith('.t.sol')
  );
}

export default async (): Promise<Partial<SolidityHooks>> => ({
  async build(context, rootFilePaths, options, next) {
    return next(context, rootFilePaths.filter(shouldCompile), options);
  },
});
