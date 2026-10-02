import { expect } from 'chai';
import type { Contract } from 'ethers';
import hre from 'hardhat';
import type { HardhatRuntimeEnvironment } from 'hardhat/types/hre';
import nock from 'nock';

import { Cache } from '../Cache.js';
import { spider } from '../Spider.js';
import type { RelationConfigMap } from '../RelationConfig.js';
import { objectFromMap } from '../Utils.js';
import { deploy } from '../Deploy.js';
import { getHardhatEthers } from '../hardhat3/runtime.js';

interface TestContracts {
  finn: Contract;
  molly: Contract;
  spot: Contract;
  proxy: Contract;
  finnImpl: Contract;
  proxyAdmin: Contract;
}

async function setupContracts(
  cache: Cache,
  hre: HardhatRuntimeEnvironment
): Promise<TestContracts> {
  const signers = await (await getHardhatEthers(hre)).getSigners();
  const proxyAdmin: Contract = await deploy(
    'vendor/proxy/transparent/ProxyAdmin.sol',
    [await signers[0].getAddress()],
    hre,
    { cache, network: 'test-network' }
  );

  const finnImpl: Contract = await deploy(
    'test/Dog.sol',
    ['finn:implementation', '0x0000000000000000000000000000000000000000', []],
    hre,
    { cache, network: 'test-network' }
  );

  const finnImplAddress = await finnImpl.getAddress();
  const proxyAdminAddress = await proxyAdmin.getAddress();
  const initializeDogTransaction = await finnImpl.initializeDog.populateTransaction(
    'finn',
    finnImplAddress,
    []
  );

  const proxy: Contract = await deploy(
    'vendor/proxy/transparent/TransparentUpgradeableProxy.sol',
    [
      finnImplAddress,
      proxyAdminAddress,
      initializeDogTransaction.data,
    ],
    hre,
    { cache, network: 'test-network' }
  );

  const proxyAddress = await proxy.getAddress();

  const molly: Contract = await deploy(
    'test/Dog.sol',
    ['molly', proxyAddress, []],
    hre,
    { cache, network: 'test-network' }
  );

  const spot: Contract = await deploy(
    'test/Dog.sol',
    ['spot', proxyAddress, []],
    hre,
    { cache, network: 'test-network' }
  );

  const finn = finnImpl.attach(proxyAddress) as Contract;

  await finn.addPup(await molly.getAddress());
  await finn.addPup(await spot.getAddress());

  return {
    finn,
    molly,
    spot,
    proxy,
    finnImpl,
    proxyAdmin,
  };
}

describe('Spider', () => {
  beforeEach(async () => {
    nock.disableNetConnect();
  });

  it('runs valid spider', async () => {
    let cache = new Cache('test-network', 'test-deployment');
    let { finn, molly, spot, finnImpl } = await setupContracts(cache, hre);

    const finnAddress = await finn.getAddress();
    const finnImplAddress = await finnImpl.getAddress();
    const mollyAddress = await molly.getAddress();
    const spotAddress = await spot.getAddress();
    let roots = new Map([['finn', finnAddress]]);

    let relationConfig: RelationConfigMap = {
      finn: {
        delegates: {
          field: {
            slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
          },
        },
        relations: {
          father: {
            alias: '.name',
          },
          pups: {
            field: async (dog) => (await dog.puppers.staticCall()).map(({ pup }) => pup),
            alias: ['.name'],
          },
        },
      },
    };

    let { aliases, contracts } = await spider(cache, 'test-network', hre, relationConfig, roots);

    expect(objectFromMap(aliases)).to.eql({
      finn: finnAddress,
      'finn:implementation': finnImplAddress,
      molly: mollyAddress,
      spot: spotAddress,
      // TODO: Dictionary?
      // pups: [
      //   '0x0000000000000000000000000000000000000003',
      //   '0x0000000000000000000000000000000000000004',
      // ],
    });

    let check = {};
    for (let [alias, contract] of contracts) {
      // Just make sure these contracts are working, too.
      const name = typeof contract.name === 'function' ? await contract.name() : null;
      check[alias] = name ? name : await contract.getAddress();
    }
    expect(check).to.eql({
      finn: 'finn',
      'finn:implementation': 'finn:implementation',
      molly: 'molly',
      spot: 'spot',
    });
  });
});
