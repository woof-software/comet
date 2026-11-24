import { BigNumber, Contract, ContractInterface, ContractTransaction, utils } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { debug } from '../../plugins/deployment_manager/Utils';
import { impersonateAddress, getProxyAdmin } from './hreUtils';
import { exp } from './math';
import { ADDRESSES } from '../../src/addresses';

// Renzo's oracle registry: maps each token to the price oracle Renzo reads it from
interface RenzoOracle extends Contract {
  setOracleAddress(token: string, oracle: string): Promise<ContractTransaction>;
}

// Redstone price feed (proxy); only the latest answer is needed to seed the mock
interface RedstoneFeed extends Contract {
  latestRoundData(): Promise<{ answer: BigNumber }>;
}

// Proxy admin of a Redstone feed: its owner can upgrade the feed to the mock
interface ProxyAdmin extends Contract {
  owner(): Promise<string>;
  upgrade(proxy: string, newImplementation: string): Promise<ContractTransaction>;
}

const RENZO_ORACLE_ABI: ContractInterface = new utils.Interface([
  'function setOracleAddress(address _token, address _oracleAddress) external',
]);

const REDSTONE_FEED_ABI: ContractInterface = new utils.Interface([
  'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

const PROXY_ADMIN_ABI: ContractInterface = new utils.Interface([
  'function upgrade(address proxy, address newImplementation) external',
  'function owner() external view returns (address)',
]);

export async function redeployRenzoOracle(dm: DeploymentManager) {
  if (dm.network !== 'mainnet') return;

  const admin = await impersonateAddress(dm, ADDRESSES.mainnet.RENZO_ADMIN, exp(100, 18));
  const renzoOracle = new Contract(ADDRESSES.mainnet.RENZO_ORACLE, RENZO_ORACLE_ABI, admin) as RenzoOracle;

  const newOracle = await dm.deploy('renzo:Oracle', 'test/MockRenzoOracle.sol', [ADDRESSES.mainnet.STETH_ETH_FEED]);
  await renzoOracle.setOracleAddress(ADDRESSES.mainnet.assets.STETH, newOracle.address);
}

export async function mockAllRedstoneOracles(dm: DeploymentManager) {
  const feeds = ADDRESSES[dm.network]?.REDSTONE_FEEDS;
  if (!Array.isArray(feeds)) {
    debug(`No redstone feeds found for network: ${dm.network}`);
    return;
  }
  for (const feed of feeds) {
    console.log(`Mocking Redstone oracle for feed: ${feed}`);
    try {
      await dm.getContractOrThrow(`MockRedstoneOracle:${feed}`);
    } catch (_) {
      await mockRedstoneOracle(dm, feed);
    }
  }
}

async function mockRedstoneOracle(dm: DeploymentManager, feed: string) {
  const signer = await dm.getSigner();
  const feedContract = new Contract(feed, REDSTONE_FEED_ABI, signer) as RedstoneFeed;
  const proxyAdmin = new Contract(await getProxyAdmin(dm, feed), PROXY_ADMIN_ABI, signer) as ProxyAdmin;

  const owner = await impersonateAddress(dm, await proxyAdmin.owner(), exp(100, 18));
  const { answer: price } = await feedContract.latestRoundData();
  console.log(`Current price for ${feed} is ${price}`);

  const newImplementation = await dm.deploy(
    `MockRedstoneOracle:${feed}`,
    'test/MockRedstoneOracle.sol',
    [feed, price],
    true
  );
  await (proxyAdmin.connect(owner) as ProxyAdmin).upgrade(feed, newImplementation.address);
}
