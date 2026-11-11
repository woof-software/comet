import { Contract } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { debug } from '../../plugins/deployment_manager/Utils';
import { impersonateAddress, getProxyAdmin } from './hreUtils';

const REDSTONE_FEEDS = {
  mantle: [
    '0x3DFA26B9A15D37190bB8e50aE093730DcA88973E', // USDe / USD
    '0x9b2C948dbA5952A1f5Ab6fA16101c1392b8da1ab', // mETH / ETH
    '0xFc34806fbD673c21c1AEC26d69AA247F1e69a2C6', // ETH / USD
  ],
  unichain: [
    '0xe8D9FbC10e00ecc9f0694617075fDAF657a76FB2', // ETH / USD
    '0xD15862FC3D5407A03B696548b6902D6464A69b8c', // USDC / ETH
    '0xc44be6D00307c3565FDf753e852Fc003036cBc13', // BTC / USD
    '0xf1454949C6dEdfb500ae63Aa6c784Aa1Dde08A6c', // UNI / USD
    '0x24c8964338Deb5204B096039147B8e8C3AEa42Cc', // wstETH / ETH
    '0xBf3bA2b090188B40eF83145Be0e9F30C6ca63689', // weETH / ETH
    '0xa0f2EF6ceC437a4e5F6127d6C51E1B0d3A746911', // ezETH / ETH
    '0x85C4F855Bc0609D2584405819EdAEa3aDAbfE97D', // rsETH / ETH
  ],
};

export async function redeployRenzoOracle(dm: DeploymentManager) {
  if (dm.network === 'mainnet') {
    // renzo admin 	0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A
    const renzoOracle = new Contract(
      '0x5a12796f7e7EBbbc8a402667d266d2e65A814042',
      [
        'function setOracleAddress(address _token, address _oracleAddress) external',
      ],
      dm.hre.ethers.provider
    );

    const admin = await impersonateAddress(
      dm,
      '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A'
    );
    // set balance
    await dm.hre.ethers.provider.send('hardhat_setBalance', [
      admin.address,
      dm.hre.ethers.utils.hexStripZeros(
        dm.hre.ethers.utils.parseUnits('100', 'ether').toHexString()
      ),
    ]);

    const newOracle = await dm.deploy(
      'renzo:Oracle',
      'test/MockRenzoOracle.sol',
      [
        '0x86392dC19c0b719886221c78AB11eb8Cf5c52812', // stETH / ETH oracle address
      ]
    );

    await renzoOracle
      .connect(admin)
      .setOracleAddress(
        '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
        newOracle.address
      );
  }
}

export async function mockAllRedstoneOracles(dm: DeploymentManager) {
  const feeds = REDSTONE_FEEDS[dm.network];
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
  const feedContract = new Contract(
    feed,
    [
      'function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
    ],
    await dm.getSigner()
  );
  const proxyAdminAddress = await getProxyAdmin(dm, feed);
  const proxyAdmin = new Contract(
    proxyAdminAddress,
    [
      'function upgrade(address proxy, address newImplementation) external',
      'function owner() external view returns (address)',
    ],
    await dm.getSigner()
  );
  const ownerAddress = await proxyAdmin.owner();
  const owner = await impersonateAddress(dm, ownerAddress);
  // set balance
  await dm.hre.ethers.provider.send('hardhat_setBalance', [
    owner.address,
    dm.hre.ethers.utils.hexStripZeros(
      dm.hre.ethers.utils.parseUnits('100', 'ether').toHexString()
    ),
  ]);
  const price = (await feedContract.latestRoundData()).answer;
  console.log(`Current price for ${feed} is ${price}`);
  const newImplementation = await dm.deploy(
    `MockRedstoneOracle:${feed}`,
    'test/MockRedstoneOracle.sol',
    [feed, price],
    true
  );
  await proxyAdmin.connect(owner).upgrade(feed, newImplementation.address);
}
