import { Contract } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';
import { ADDRESSES } from '../../src/addresses';

// Tokens whose CCIP prices are refreshed on each network
const CCIP_TOKENS = {
  mainnet: [ADDRESSES.mainnet.assets.WETH, ADDRESSES.mainnet.assets.LINK, ADDRESSES.mainnet.assets.GHO],
  ronin: [ADDRESSES.ronin.assets.WETH, ADDRESSES.ronin.assets.WRON, ADDRESSES.ronin.assets.LINK],
};

const dest = new Map<string, string>([
  ['ronin', '6916147374840168594'],
  ['mainnet', '5009297550715157269'],
]);

export async function updateCCIPStats(
  dm: DeploymentManager,
  tenderlyLogs?: any[]
) {
  // The CommitStore is impersonated to push fresh prices into the PriceRegistry
  const { CCIP_COMMIT_STORE: commitStore, CCIP_PRICE_REGISTRY: priceRegistry } = ADDRESSES[dm.network] ?? {};
  if (!commitStore || !priceRegistry) {
    console.log(`No CCIP config for network ${dm.network}, skipping CCIP stats update.`);
    return;
  }
  const abi = [
    {
      inputs: [
        {
          components: [
            {
              components: [
                {
                  internalType: 'address',
                  name: 'sourceToken',
                  type: 'address',
                },
                {
                  internalType: 'uint224',
                  name: 'usdPerToken',
                  type: 'uint224',
                },
              ],
              internalType: 'struct TokenPriceUpdate[]',
              name: 'tokenPriceUpdates',
              type: 'tuple[]',
            },
            {
              components: [
                {
                  internalType: 'uint64',
                  name: 'destChainSelector',
                  type: 'uint64',
                },
                {
                  internalType: 'uint224',
                  name: 'usdPerUnitGas',
                  type: 'uint224',
                },
              ],
              internalType: 'struct GasPriceUpdate[]',
              name: 'gasPriceUpdates',
              type: 'tuple[]',
            },
          ],
          internalType: 'struct PriceUpdates',
          name: 'priceUpdates',
          type: 'tuple',
        },
      ],
      name: 'updatePrices',
      outputs: [],
      stateMutability: 'nonpayable',
      type: 'function',
    },
    {
      inputs: [
        {
          internalType: 'uint64',
          name: 'destChainSelector',
          type: 'uint64',
        },
      ],
      name: 'getDestinationChainGasPrice',
      outputs: [
        {
          components: [
            {
              internalType: 'uint224',
              name: 'value',
              type: 'uint224',
            },
            {
              internalType: 'uint32',
              name: 'timestamp',
              type: 'uint32',
            },
          ],
          internalType: 'struct TimestampedPackedUint224',
          name: '',
          type: 'tuple',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
    {
      inputs: [
        {
          internalType: 'address',
          name: 'token',
          type: 'address',
        },
      ],
      name: 'getTokenPrice',
      outputs: [
        {
          components: [
            {
              internalType: 'uint224',
              name: 'value',
              type: 'uint224',
            },
            {
              internalType: 'uint32',
              name: 'timestamp',
              type: 'uint32',
            },
          ],
          internalType: 'struct TimestampedPackedUint224',
          name: '',
          type: 'tuple',
        },
      ],
      stateMutability: 'view',
      type: 'function',
    },
  ];

  await dm.hre.network.provider.request({
    method: 'hardhat_impersonateAccount',
    params: [commitStore],
  });

  await dm.hre.network.provider.request({
    method: 'hardhat_setBalance',
    params: [commitStore, '0x56bc75e2d63100000'],
  });
  const commitStoreSigner = await dm.hre.ethers.getSigner(commitStore);

  const registryContract = new Contract(
    priceRegistry,
    abi,
    dm.hre.ethers.provider
  );

  const tokenPrices = [];
  const gasPrices = [];
  for (const address of CCIP_TOKENS[dm.network] ?? []) {
    const price = await registryContract.getTokenPrice(address);
    tokenPrices.push([address, price.value]);
  }

  for (const [, chainSelector] of dest) {
    try {
      const price = await registryContract.getDestinationChainGasPrice(chainSelector);
      gasPrices.push([chainSelector, price.value]);
    } catch (e) {
      continue;
    }
  }

  if (tenderlyLogs) {
    dm.stashRelayMessage(
      priceRegistry,
      registryContract.interface.encodeFunctionData('updatePrices', [
        {
          tokenPriceUpdates: tokenPrices,
          gasPriceUpdates: gasPrices,
        },
      ]),
      commitStore
    );
  }

  const tx0 = await commitStoreSigner.sendTransaction({
    to: priceRegistry,
    data: registryContract.interface.encodeFunctionData('updatePrices', [
      {
        tokenPriceUpdates: tokenPrices,
        gasPriceUpdates: gasPrices,
      },
    ]),
  });

  await tx0.wait();
}
