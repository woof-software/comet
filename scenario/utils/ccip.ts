import { Contract } from 'ethers';
import { DeploymentManager } from '../../plugins/deployment_manager';

const tokens = [
  ['mainnet', 'WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
  ['mainnet', 'LINK', '0x514910771AF9Ca656af840dff83E8264EcF986CA'],
  ['mainnet', 'GHO', '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f'],
  ['ronin', 'WETH', '0xc99a6a985ed2cac1ef41640596c5a5f9f4e19ef5'],
  ['ronin', 'WRON', '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4'],
  ['ronin', 'LINK', '0x3902228d6a3d2dc44731fd9d45fee6a61c722d0b'],
];

const dest = new Map<string, string>([
  ['ronin', '6916147374840168594'],
  ['mainnet', '5009297550715157269'],
]);

// CCIP contracts per network: the CommitStore is impersonated to push fresh prices into the PriceRegistry
const CCIP_CONTRACTS = [
  {
    network: 'mainnet',
    commitStore: '0x2aa101bf99caef7fc1355d4c493a1fe187a007ce',
    priceRegistry: '0x8c9b2Efb7c64C394119270bfecE7f54763b958Ad',
  },
  {
    network: 'ronin',
    commitStore: '0x28c66d9693b2634b2f3b170f6d9584eec2f72ff0',
    priceRegistry: '0xefCEa3CFA330adcDdeCe99219C57fd45cd166ac1',
  },
];

export async function updateCCIPStats(
  dm: DeploymentManager,
  tenderlyLogs?: any[]
) {
  const { commitStore, priceRegistry } = CCIP_CONTRACTS.find(c => c.network === dm.network) || {};
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
  for (const [network, , address] of tokens) {
    if (network !== dm.network) continue;
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
