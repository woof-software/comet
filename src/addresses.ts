import { utils } from 'ethers';

// NOTE: self-check of this file. It only confirms that every address below is itself a valid address
// (right length, hex, correct checksum); it does not check that a contract lives there or on which network.
// It runs when the file is loaded, so a typo stops any scenario, spider or deploy before it reaches the network.
// ADDRESSES is wrapped in this call, so the object is checked as it is defined and returned unchanged.
function assertAddressesAreValid<T>(addresses: T): T {
  for (const address of collectAddresses(addresses)) {
    utils.getAddress(address);
  }
  return addresses;
}

// Walks nested groups (such as assets) and lists (such as REDSTONE_FEEDS) and returns every address in them
function collectAddresses(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Object.values(value as object).flatMap(collectAddresses);
}

// Every external contract address used by src/, scenario/ and plugins/, grouped by the network it lives on.
// Network keys match DeploymentManager's network names, so code can look up ADDRESSES[dm.network].
// Whale lists stay in src/deploy/index.ts; market contracts stay in deployments/.
export const ADDRESSES = assertAddressesAreValid({
  mainnet: {
    assets: {
      WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
      GHO: '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f',
      STETH: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
      WSTETH: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    },

    // GovernorBravo that cloneGov copies onto local and testnet deployments
    GOVERNOR_BRAVO_IMPL: '0xef3b6e9e13706a8f01fe98fdcf66335dc5cfdeed',
    GOVERNOR_BRAVO: '0xc0da02939e1441f497fd74f78ce7decb17b66529',

    // Renzo's oracle registry and its admin, used to repoint the stETH oracle on forks
    RENZO_ORACLE: '0x5a12796f7e7EBbbc8a402667d266d2e65A814042',
    RENZO_ADMIN: '0xD1e6626310fD54Eceb5b9a51dA2eC329D6D4B68A',
    STETH_ETH_FEED: '0x86392dC19c0b719886221c78AB11eb8Cf5c52812',

    // L1 side of the Arbitrum bridge, used to simulate L2→L1 token bridging
    ARBITRUM_BRIDGE: '0x8315177ab297ba92a06054ce80a67ed4dbd7ed3a',
    ARBITRUM_OUTBOX: '0x667e23ABd27E623c11d4CC00ca3EC4d0bD63337a',

    // OptimismPortals on L1, used to simulate L2→L1 token bridging
    BASE_L1_PORTAL: '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e',
    OPTIMISM_L1_PORTAL: '0xbEb5Fc579115071764c7423A4f12eDde41f106Ed',

    // CCIP: router and Ronin off-ramp for Ronin relays; the CommitStore is impersonated to push prices into the PriceRegistry
    CCIP_ROUTER: '0x80226fc0Ee2b096224EeAc085Bb9a8cba1146f7D',
    CCIP_RONIN_OFF_RAMP: '0x9a3Ed7007809CfD666999e439076B4Ce4120528D',
    CCIP_COMMIT_STORE: '0x2aa101bf99caef7fc1355d4c493a1fe187a007ce',
    CCIP_PRICE_REGISTRY: '0x8c9b2Efb7c64C394119270bfecE7f54763b958Ad',

    // DEXes and flash-loan source for the liquidation bot
    BALANCER_VAULT: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    UNISWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    UNISWAP_V3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    SUSHISWAP_ROUTER: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  },

  arbitrum: {
    assets: {
      WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      // Proxy whose symbol() reverts on a Hardhat fork, so RelationConfig answers 'tETH' for it
      TETH: '0xd09acb80c1e8f2291862c4978a008791c9167003',
    },

    // ArbSys precompile, mocked because Hardhat's EVM has no Arbitrum precompiles
    ARB_SYS: '0x0000000000000000000000000000000000000064',
    // L2 gateway router: L2→L1 token withdrawals go through it
    GATEWAY_ROUTER: '0x5288c571Fd7aD117beA99bF60FE0846C4E84F933',

    // CCTP: the TokenMessenger is impersonated to call mint on the TokenMinter
    CCTP_TOKEN_MINTER: '0xE7Ed1fa7f45D05C508232aa32649D89b73b8bA48',
    CCTP_TOKEN_MESSENGER: '0x19330d10d9cc8751218eaf51e8885d058642e08a',

    // DEXes and flash-loan source for the liquidation bot
    BALANCER_VAULT: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    UNISWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    UNISWAP_V3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    SUSHISWAP_ROUTER: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  },

  polygon: {
    assets: {
      WETH: '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619',
      STMATIC: '0x3a58a54c066fdc0f2d55fc9c89f0415c92ebf3c4',
    },

    // System account that delivers L1 state-sync messages on L2
    STATE_RECEIVER: '0x0000000000000000000000000000000000001001',
    // ChildChainManager proxy that mints bridged ERC20s on L2
    CHILD_CHAIN_MANAGER: '0xA6FA4fB5f76172d178d61B04b0ecd319C5d1C0aa',

    // DEXes and flash-loan source for the liquidation bot
    BALANCER_VAULT: '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
    UNISWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    UNISWAP_V3_FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    SUSHISWAP_ROUTER: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  },

  linea: {
    // Account that holds the setter role on Linea's message service
    SETTER_ROLE_ACCOUNT: '0x2b0F9C76970975aec03784EFd763623757EF7652',
  },

  ronin: {
    assets: {
      WETH: '0xc99a6a985ed2cac1ef41640596c5a5f9f4e19ef5',
      WRON: '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4',
      LINK: '0x3902228d6a3d2dc44731fd9d45fee6a61c722d0b',
    },

    CCIP_TOKEN_ADMIN_REGISTRY: '0x90e83d532A4aD13940139c8ACE0B93b0DdbD323a',
    CCIP_COMMIT_STORE: '0x28c66d9693b2634b2f3b170f6d9584eec2f72ff0',
    CCIP_PRICE_REGISTRY: '0xefCEa3CFA330adcDdeCe99219C57fd45cd166ac1',
  },

  mantle: {
    // Redstone feeds that scenarios replace with mocks, so prices stay fresh on a fork
    REDSTONE_FEEDS: [
      '0x3DFA26B9A15D37190bB8e50aE093730DcA88973E', // USDe / USD
      '0x9b2C948dbA5952A1f5Ab6fA16101c1392b8da1ab', // mETH / ETH
      '0xFc34806fbD673c21c1AEC26d69AA247F1e69a2C6', // ETH / USD
    ],
  },

  unichain: {
    // OP-stack L2StandardBridge predeploy: it is the only account allowed to mint bridged tokens
    L2_STANDARD_BRIDGE: '0x4200000000000000000000000000000000000010',
    // Bridged tokens that TokenSourcer mints through the L2StandardBridge instead of searching for holders
    BRIDGE_MINTABLE_TOKENS: [
      '0x927b51f251480a681271180da4de28d44ec4afb8', // WBTC
      '0x8f187aa05619a017077f5308904739877ce9ea21', // UNI
      '0x949d3A70722731d3bA8E0ca4061E12387c659E75',
      '0xdf78e4F0A8279942ca68046476919A90f2288656', // COMP
    ],
    // Redstone feeds that scenarios replace with mocks, so prices stay fresh on a fork
    REDSTONE_FEEDS: [
      '0xe8D9FbC10e00ecc9f0694617075fDAF657a76FB2', // ETH / USD
      '0xD15862FC3D5407A03B696548b6902D6464A69b8c', // USDC / ETH
      '0xc44be6D00307c3565FDf753e852Fc003036cBc13', // BTC / USD
      '0xf1454949C6dEdfb500ae63Aa6c784Aa1Dde08A6c', // UNI / USD
      '0x24c8964338Deb5204B096039147B8e8C3AEa42Cc', // wstETH / ETH
      '0xBf3bA2b090188B40eF83145Be0e9F30C6ca63689', // weETH / ETH
      '0xa0f2EF6ceC437a4e5F6127d6C51E1B0d3A746911', // ezETH / ETH
      '0x85C4F855Bc0609D2584405819EdAEa3aDAbfE97D', // rsETH / ETH
    ],
  },
} as const);
