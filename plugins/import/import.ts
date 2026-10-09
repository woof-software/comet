import { get, getEtherscanApiKey, getEtherscanApiUrl, getEtherscanUrl } from './etherscan';
import { getBlockscoutApiKey, getBlockscoutApiUrl, getBlockscoutRPCUrl, getBlockscoutUrl } from './blockscout';
import { networkConfigs } from '../../hardhat.config';
import { providers } from 'ethers';

export function debug(...args: any[]) {
  if (process.env['DEBUG']) {
    if (typeof args[0] === 'function') {
      console.log(...args[0]());
    } else {
      console.log(...args);
    }
  }
}

// Prefixes a DEBUG log with the (network, address) it's about, so output interleaved
// across many contracts during a spider crawl stays attributable to one lookup.
export function trace(network: string, address: string, ...args: any[]) {
  debug(`[${network} ${address}]`, ...args);
}

/**
 * Copied from Saddle import with some small modifications.
 *
 * NOTE: This program also exists as a Hardhat plugin in a separate repo, but we
 * are temporarily moving it back into the protocol repo for easier development.
 *
 * See docs/contract-import.md for the fetch waterfall this file implements: Blockscout
 * V2 -> Blockscout V1 (legacy) -> Sourcify -> Etherscan, first success wins. The archive
 * and local-cache steps before all of this live in deployment_manager/Import.ts instead,
 * since they resolve straight to a finished BuildFile rather than raw source data.
 */

// Thrown by every step for "definitively not verified here" - distinguishes that from a
// transient error so the waterfall can skip straight to the next step without retrying.
const NOT_VERIFIED = 'Contract source code not verified';

function isNotVerified(e: any): boolean {
  return !!e?.message?.includes(NOT_VERIFIED);
}

function isNotFound(e: any): boolean {
  return e?.response?.status === 404;
}

function getChainId(network: string): number | undefined {
  return networkConfigs.find(c => c.network.toLowerCase() === network.toLowerCase())?.chainId;
}

interface EtherscanSource {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string;
  Runs: string;
  ConstructorArguments: string;
  Library: string;
  LicenseType: string;
  SwarmSource: string;
}

interface BlockscoutSource {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string;
  OptimizationRuns: string;
  ConstructorArguments: string;
  Library: string;
  LicenseType: string;
  SwarmSource: string;
  ImplementationAddress: string;
}

interface BlockscoutV2Source {
  source_code: string;
  file_path: string;
  additional_sources: { file_path: string, source_code: string }[];
  abi: object;
  name: string;
  compiler_version: string;
  compiler_settings: object;
  optimization_enabled: boolean;
  optimization_runs: number;
  constructor_args: string;
}

interface EtherscanData {
  source: string;
  abi: object;
  contract: string;
  compiler: string;
  optimized: boolean;
  optimizationRuns: number;
  constructorArgs: string;
}

function paramString(params: { [k: string]: string | number }) {
  return Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('&');
}

// Bytecode fetch is source-agnostic: RPC works regardless of which step below supplied
// the ABI/source, so it's tried first for both families in getContractCreationCode.

async function scrapeContractCreationCodeFromRPC(network: string, address: string) {
  const rpcUrl = await getBlockscoutRPCUrl(network);
  const provider = new providers.JsonRpcProvider(rpcUrl);
  const code = await provider.send('eth_getCode', [address, 'latest']);
  return code.slice(2);
}

async function pullFirstTransactionForContractFromBlockscout(network: string, address: string) {
  const params = {
    module: 'account',
    action: 'txlist',
    address: address,
    startblock: 0,
    endblock: 99999999,
    page: 1,
    offset: 10,
    sort: 'asc',
    apikey: getBlockscoutApiKey(network),
  };
  const url = `${getBlockscoutApiUrl(network)}?${paramString(params)}`;
  const debugUrl = `${getBlockscoutApiUrl(network)}?${paramString({ ...params, apikey: '[API_KEY]' })}`;

  trace(network, address, `Attempting to pull Contract Creation code from first tx at ${debugUrl}`);
  const result = await get(url, {});

  const contractCreationCode = result.result?.[0]?.input;
  if (!contractCreationCode) {
    throw new Error(`Unable to find Contract Creation tx at ${debugUrl}`);
  }
  trace(network, address, `Creation Code found in first tx at ${debugUrl}`);
  return contractCreationCode.slice(2);
}

async function scrapeContractCreationCodeFromEtherscanApi(network: string, address: string, i?: number) {
  const params = {
    module: 'proxy',
    action: 'eth_getCode',
    address,
    apikey: getEtherscanApiKey(network, i)
  };
  const url = `${getEtherscanApiUrl(network)}&${paramString(params)}`;
  const debugUrl = `${getEtherscanApiUrl(network)}&${paramString({ ...params, ...{ apikey: '[API_KEY]' } })}`;

  trace(network, address, `Attempting to pull Contract Creation code from API at ${debugUrl}`);
  const result = await get(url, {});
  const contractCreationCode = result.result;
  if (!contractCreationCode) {
    throw new Error(`Unable to find Contract Creation code from API at ${debugUrl}`);
  }
  trace(network, address, `Creation Code found in first tx at ${debugUrl}`);
  return contractCreationCode.slice(2);
}

/**
 * @description Does not work for 0x566511a1A09561e2896F8c0fD77E8544E59bFDB0 as etherscan starts using some firewall
 */
async function scrapeContractCreationCodeFromEtherscan(network: string, address: string) {
  const url = `${getEtherscanUrl(network)}/address/${address}#code`;
  trace(network, address, `Attempting to scrape Contract Creation code at ${url}`);
  const result = <string>await get(url, {});
  const regex = /<div id='verifiedbytecode2'>[\s\r\n]*([0-9a-fA-F]*)[\s\r\n]*<\/div>/g;
  const regexDoubleQuotes = /<div id="verifiedbytecode2">[\s\r\n]*([0-9a-fA-F]*)[\s\r\n]*<\/div>/g;
  const matches = [...result.matchAll(regex), ...result.matchAll(regexDoubleQuotes)];
  if (matches.length === 0) {
    if (result.match(/request throttled/i) || result.match(/try again later/i)) {
      throw new Error(`Request throttled: ${url}`);
    } else {
      throw new Error(`Failed to pull deployed contract code from Etherscan: ${url}`);
    }
  }
  trace(network, address, `Scraping successful for ${url}`);
  return matches[0][1];
}

async function pullFirstTransactionForContractFromEtherscan(network: string, address: string, i?: number) {
  const params = {
    module: 'account',
    action: 'txlist',
    address,
    startblock: 0,
    endblock: 99999999,
    page: 1,
    offset: 10,
    sort: 'asc',
    apikey: getEtherscanApiKey(network, i)
  };
  const url = `${getEtherscanApiUrl(network)}&${paramString(params)}`;
  const debugUrl = `${getEtherscanApiUrl(network)}&${paramString({ ...params, ...{ apikey: '[API_KEY]' } })}`;

  trace(network, address, `Attempting to pull Contract Creation code from first tx at ${debugUrl}`);
  const result = await get(url, {});
  const contractCreationCode = result.result[0].input;
  if (!contractCreationCode) {
    throw new Error(`Unable to find Contract Creation tx at ${debugUrl}`);
  }
  trace(network, address, `Creation Code found in first tx at ${debugUrl}`);
  return contractCreationCode.slice(2);
}

async function tryStrategies<T>(strategies: (() => Promise<T>)[]): Promise<T> {
  const errors: Error[] = [];
  for (const strategy of strategies) {
    try {
      return await strategy();
    } catch (e) {
      errors.push(e);
    }
  }
  throw new Error(errors.map(e => e.message).join('; '));
}

async function getContractCreationCode(network: string, address: string, family: 'blockscout' | 'etherscan') {
  if (family === 'blockscout') {
    return tryStrategies([
      () => scrapeContractCreationCodeFromRPC(network, address),
      () => pullFirstTransactionForContractFromBlockscout(network, address),
    ]);
  }

  // Etherscan family: RPC first, then scrape/proxy/txlist rotated across every key.
  const maxKeyRotations = 12;
  const strategies = [() => scrapeContractCreationCodeFromRPC(network, address)];
  for (let i = 0; i < maxKeyRotations; i++) {
    strategies.push(
      () => scrapeContractCreationCodeFromEtherscanApi(network, address, i),
      () => pullFirstTransactionForContractFromEtherscan(network, address, i),
    );
  }
  strategies.push(() => scrapeContractCreationCodeFromEtherscan(network, address));
  return tryStrategies(strategies);
}

async function getBlockscoutV2ApiData(network: string, address: string): Promise<EtherscanData> {
  const url = `${getBlockscoutUrl(network)}/api/v2/smart-contracts/${address}`;
  let result: BlockscoutV2Source;
  try {
    result = await get(url, { apikey: getBlockscoutApiKey(network) });
  } catch (e) {
    if (isNotFound(e)) throw new Error(NOT_VERIFIED);
    throw e;
  }

  if (!result?.source_code) {
    throw new Error(NOT_VERIFIED);
  }

  const sources = Object.fromEntries(
    [{ file_path: result.file_path, source_code: result.source_code }, ...(result.additional_sources ?? [])]
      .map(({ file_path, source_code }) => [file_path, { content: source_code }])
  );

  return {
    // Double-braced to match parseSources()'s Etherscan-style multi-file convention (see
    // getSourcifyApiData below for the same trick).
    source: `{${JSON.stringify({ language: 'Solidity', sources, settings: result.compiler_settings })}}`,
    abi: result.abi,
    contract: result.name,
    compiler: result.compiler_version,
    optimized: result.optimization_enabled,
    optimizationRuns: result.optimization_runs,
    constructorArgs: result.constructor_args ?? '',
  };
}

async function getBlockscoutV1ApiData(network: string, address: string): Promise<EtherscanData> {
  const apiUrl = await getBlockscoutApiUrl(network);
  const result = await get(apiUrl, {
    module: 'contract',
    action: 'getsourcecode',
    address,
    apikey: getBlockscoutApiKey(network),
  });

  if (result.status !== '1') {
    throw new Error(`Blockscout Error: ${result.message} - ${result.result}`);
  }

  const s = <BlockscoutSource>(<unknown>result.result[0]);

  if (!s.ABI || s.ABI === NOT_VERIFIED) {
    throw new Error(NOT_VERIFIED);
  }

  return {
    source: s.SourceCode,
    abi: JSON.parse(s.ABI),
    contract: s.ContractName,
    compiler: s.CompilerVersion,
    optimized: s.OptimizationUsed !== '0',
    optimizationRuns: Number(s.OptimizationRuns),
    constructorArgs: s.ConstructorArguments,
  };
}

async function getSourcifyApiData(network: string, address: string): Promise<EtherscanData> {
  const chainId = getChainId(network);
  if (!chainId) {
    throw new Error(NOT_VERIFIED);
  }

  let result;
  try {
    result = await get(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`, {
      fields: 'abi,compilation,metadata,sources',
    });
  } catch (e) {
    if (isNotFound(e)) throw new Error(NOT_VERIFIED);
    throw e;
  }

  if (!result?.metadata) {
    throw new Error(NOT_VERIFIED);
  }

  const { abi, compilation, metadata, sources } = result;

  return {
    // Etherscan's SourceCode field double-wraps standard-json-input sources in an extra pair
    // of braces (see parseSources() below); mimic that so multi-file Sourcify sources parse
    // the same way, using real file content instead of just the keccak256/urls that
    // metadata.sources normally carries.
    source: `{${JSON.stringify({ ...metadata, sources })}}`,
    abi,
    contract: compilation.name,
    compiler: compilation.compilerVersion,
    optimized: metadata.settings?.optimizer?.enabled ?? false,
    optimizationRuns: metadata.settings?.optimizer?.runs ?? 0,
    // Sourcify's creation-time constructor arguments aren't fetched here, so contractCreationCode
    // won't get its constructor-args suffix stripped for this fallback path — a minor
    // completeness gap, not a correctness one (bin just retains that trailing data).
    constructorArgs: '',
  };
}

async function getEtherscanApiData(network: string, address: string, apiKey: string): Promise<EtherscanData> {
  const apiUrl = await getEtherscanApiUrl(network);
  const result = await get(apiUrl, {
    module: 'contract',
    action: 'getsourcecode',
    address,
    apikey: apiKey,
  });

  if (result.status !== '1') {
    throw new Error(`Etherscan Error: ${result.message} - ${result.result}`);
  }

  const s = <EtherscanSource>(<unknown>result.result[0]);

  if (!s.SourceCode || !s.ABI || !s.ContractName || s.ABI === NOT_VERIFIED) {
    throw new Error(NOT_VERIFIED);
  }

  return {
    source: s.SourceCode,
    abi: JSON.parse(s.ABI),
    contract: s.ContractName,
    compiler: s.CompilerVersion,
    optimized: s.OptimizationUsed !== '0',
    optimizationRuns: Number(s.Runs),
    constructorArgs: s.ConstructorArguments,
  };
}

// Key rotation is Etherscan-specific plumbing, kept internal to this step rather than
// part of the generic one-retry-then-next-step policy the waterfall applies below.
async function getEtherscanApiDataWithKeyRotation(network: string, address: string): Promise<EtherscanData> {
  const maxKeyRotations = 12;
  let lastError: Error;
  for (let i = 0; i < maxKeyRotations; i++) {
    try {
      const apiKey = getEtherscanApiKey(network, i);
      return await getEtherscanApiData(network, address, apiKey);
    } catch (e) {
      if (isNotVerified(e)) throw e;
      lastError = e;
      trace(network, address, `Etherscan attempt ${i + 1} failed: ${e.message}`);
    }
  }
  throw lastError;
}

interface SourceStep {
  name: string;
  family: 'blockscout' | 'etherscan';
  configured: (network: string) => boolean;
  fetch: (network: string, address: string) => Promise<EtherscanData>;
}

function isBlockscoutConfigured(network: string): boolean {
  try {
    getBlockscoutUrl(network);
    return true;
  } catch {
    return false;
  }
}

function isEtherscanConfigured(network: string): boolean {
  try {
    getEtherscanApiUrl(network);
    return true;
  } catch {
    return false;
  }
}

const sourceSteps: SourceStep[] = [
  { name: 'Blockscout V2', family: 'blockscout', configured: isBlockscoutConfigured, fetch: getBlockscoutV2ApiData },
  { name: 'Blockscout V1', family: 'blockscout', configured: isBlockscoutConfigured, fetch: getBlockscoutV1ApiData },
  // No allowlist: every network is attempted, same as an unverified address would fail.
  { name: 'Sourcify', family: 'etherscan', configured: () => true, fetch: getSourcifyApiData },
  { name: 'Etherscan', family: 'etherscan', configured: isEtherscanConfigured, fetch: getEtherscanApiDataWithKeyRotation },
];

const TRANSIENT_RETRY_DELAY = 2000;

async function fetchFromStep(step: SourceStep, network: string, address: string): Promise<EtherscanData> {
  try {
    return await step.fetch(network, address);
  } catch (e) {
    if (isNotVerified(e)) throw e;
    trace(network, address, `${step.name} failed (${e.message}), retrying once`);
    await new Promise(ok => setTimeout(ok, TRANSIENT_RETRY_DELAY));
    return await step.fetch(network, address);
  }
}

async function fetchContractSource(network: string, address: string): Promise<{ data: EtherscanData, family: 'blockscout' | 'etherscan' }> {
  const errors: string[] = [];
  let allDefinitive = true;
  for (const step of sourceSteps) {
    if (!step.configured(network)) continue;
    try {
      const data = await fetchFromStep(step, network, address);
      trace(network, address, `resolved via ${step.name}`);
      return { data, family: step.family };
    } catch (e) {
      allDefinitive = allDefinitive && isNotVerified(e);
      errors.push(`${step.name}: ${e.message}`);
    }
  }
  const summary = errors.join('; ') || 'no source configured for this network';
  // Only a unanimous "not verified" across every tried step is definitive; if any step
  // failed transiently, surface a plain error so importContract's outer retry still fires.
  throw new Error(allDefinitive ? `${NOT_VERIFIED} (${summary})` : summary);
}

function parseSources({ source, contract, optimized, optimizationRuns }: EtherscanData) {
  if (source.startsWith('{') && source.endsWith('}')) {
    const sliced = source.slice(1, -1);
    if (sliced.startsWith('{') && sliced.endsWith('}')) {
      return JSON.parse(sliced);
    } else {
      return {
        language: 'Solidity',
        settings: {
          optimizer: {
            enabled: optimized,
            runs: optimizationRuns,
          }
        },
        sources: JSON.parse(source)
      };
    }
  } else {
    // Note: legacy for tests, but is this even right?
    return {
      language: 'Solidity',
      settings: {
        optimizer: {
          enabled: optimized,
          runs: optimizationRuns,
        }
      },
      sources: {
        [`contracts/${contract}.sol`]: {
          content: source,
          keccak256: '',
        }
      }
    };
  }
}

async function buildContractFromSourceData(
  network: string,
  address: string,
  data: EtherscanData,
  family: 'blockscout' | 'etherscan'
) {
  const { abi, contract, compiler, constructorArgs } = data;
  const { language, settings, sources } = parseSources(data);
  const contractPath = Object.keys(sources)[0];
  const contractFQN = `${contractPath}:${contract}`;

  let contractCreationCode = await getContractCreationCode(network, address, family);
  if (constructorArgs?.length > 0 && contractCreationCode?.endsWith(constructorArgs)) {
    contractCreationCode = contractCreationCode.slice(0, -constructorArgs.length);
  }

  const encodedABI = JSON.stringify(abi);
  return {
    contract,
    contracts: {
      [contractFQN]: {
        network,
        address,
        name: contract,
        abi: encodedABI,
        bin: contractCreationCode,
        constructorArgs,
        metadata: JSON.stringify({
          compiler: {
            version: compiler,
          },
          language,
          output: {
            abi: encodedABI,
          },
          devdoc: {},
          sources,
          settings,
          version: 1,
        }),
      },
    },
    version: compiler,
  };
}

export async function loadContract(network: string, address: string) {
  if (address === '0x0000000000000000000000000000000000000000') {
    throw new Error(`Cannot load contract for address ${address} on network ${network}. Address invalid.`);
  }
  const { data, family } = await fetchContractSource(network, address);
  return await buildContractFromSourceData(network, address, data, family);
}
