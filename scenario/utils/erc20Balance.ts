import { BigNumber, BigNumberish, ethers } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { CometContext } from '../context/CometContext';

/**
 * Token registries and balance helpers for every supported network. The helpers take the runtime of the scenario
 * world instead of the global one, since every world forks its own network.
 */

// Base slot of the balances mapping in OpenZeppelin ERC20 with ERC-7201 namespaced storage:
// keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~bytes32(uint256(0xff))
export const ERC7201_OZ_ERC20_BALANCES = '0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00';

export interface TokenInfo {
  address: string;
  amount: BigNumber;
  // How `setErc20Balance` funds this token: a number (plain balances slot), a 32-byte hex base slot
  // (ERC-7201), or a whale address to transfer from (for tokens whose slot can't be poked).
  slot: number | string;
}

const PLACEHOLDER_AMOUNT = ethers.utils.parseUnits('1', 18);

function t(address: string, amount: BigNumber = PLACEHOLDER_AMOUNT, slot: number | string = 0): TokenInfo {
  return { address, amount, slot };
}

// ── Ethereum ───────────────────────────────────────────────────────────────
const MAINNET = {
  USDC: t('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ethers.utils.parseUnits('1000', 6), 9),
  USDT: t('0xdAC17F958D2ee523a2206206994597C13D831ec7', ethers.utils.parseUnits('1000', 6), 2),
  WBTC: t('0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', ethers.utils.parseUnits('0.017', 8), 0),
  WETH: t('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ethers.utils.parseUnits('0.64', 18), 3),
  WSTETH: t('0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', ethers.utils.parseUnits('0.64', 18), 0),
  USDS: t('0xdC035D45d973E3EC169d2276DDab16f1e407384F', ethers.utils.parseUnits('1000', 18), 2),
  LINK: t('0x514910771AF9Ca656af840dff83E8264EcF986CA', ethers.utils.parseUnits('140', 18), 1),
  cbBTC: t('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', ethers.utils.parseUnits('0.017', 8), 9),
  UNI: t('0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', ethers.utils.parseUnits('365', 18), 4),
  XAUt: t('0x68749665FF8D2d112Fa859AA293F07A622782F38', ethers.utils.parseUnits('0.25', 6), 51),
  USDe: t('0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', ethers.utils.parseUnits('1000', 18), 2),
  COMP: t('0xc00e94Cb662C3520282E6f5717214004A7f26888', ethers.utils.parseUnits('65', 18), 1),
  rsETH: t('0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7', ethers.utils.parseUnits('0.64', 18), 51),
  weETH: t('0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', ethers.utils.parseUnits('0.64', 18), 101),
  tBTC: t('0x18084fbA666a33d37592fA2633fD49a74DD93a88', ethers.utils.parseUnits('0.017', 18), 1),
  cbETH: t('0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', ethers.utils.parseUnits('0.64', 18), 9),
  ETHx: t('0xA35b1B31Ce002FBF2058D22F30f95D405200A15b', ethers.utils.parseUnits('0.64', 18), 51),
  ezETH: t('0xbf5495Efe5DB9ce00f80364C8B423567e58d2110', ethers.utils.parseUnits('0.64', 18), 51),
  rswETH: t('0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0', ethers.utils.parseUnits('0.64', 18), 98),
  rETH: t('0xae78736Cd615f374D3085123A210448E74Fc6393', ethers.utils.parseUnits('0.64', 18), 1),
  osETH: t('0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38', ethers.utils.parseUnits('0.64', 18), 2),
  tETH: t('0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8', ethers.utils.parseUnits('0.64', 18), '0xce8c60fd8390eFCc3Fc66A3f0bd64BEb969e750E'),
  // Whales hold almost nothing, the balances live in ERC-7201 storage
  pufETH: t('0xD9A442856C234a39a81a089C06451EBAa4306a72', ethers.utils.parseUnits('0.64', 18), ERC7201_OZ_ERC20_BALANCES),
  mETH: t('0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa', ethers.utils.parseUnits('0.64', 18), 201),
  SKY: t('0x56072C95FAA701256059aa122697B133aDEd9279', ethers.utils.parseUnits('19000', 18), 2),
  sUSDS: t('0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', ethers.utils.parseUnits('1000', 18), 2),
  deUSD: t('0x15700B564Ca08D9439C58cA5053166E8317aa138', ethers.utils.parseUnits('1000', 18), '0xd629EdC5F1ff4cB7D9dD0A5bE72C1d9fc5D02709'),
  sdeUSD: t('0x5C5b196aBE0d54485975D1Ec29617D42D9198326', ethers.utils.parseUnits('1000', 18), '0x7667095Caa12b79fCa489ff6E2198Ca01fDAe057'),
  wUSDM: t('0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812', ethers.utils.parseUnits('1000', 18), 51),
  sFRAX: t('0xA663B02CF0a4b149d2aD41910CB81e23e1c41c32', ethers.utils.parseUnits('1000', 18), 3),
  LBTC: t('0x8236a87084f8B84306f72007F36F2618A5634494', ethers.utils.parseUnits('0.017', 8), '0xa9d4EcEBd48C282a70CfD3c469d6C8F178a5738E'),
  pumpBTC: t('0xF469fBD2abcd6B9de8E169d128226C0Fc90a012e', ethers.utils.parseUnits('0.017', 8), 0),
  wOETH: t('0xDcEe70654261AF21C44c093C300eD3Bb97b78192', ethers.utils.parseUnits('0.64', 18), 0)
};

// ── Base ─────────────────────────────────────────────────────────────────--
const BASE = {
  USDC: t('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ethers.utils.parseUnits('1000', 6), 9),
  WETH: t('0x4200000000000000000000000000000000000006', ethers.utils.parseUnits('0.64', 18), 3),
  cbBTC: t('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', ethers.utils.parseUnits('0.017', 8), 9),
  tBTC: t('0x236aa50979D5f3De3Bd1Eeb40E81137F22ab794b', ethers.utils.parseUnits('0.017', 18), 51),
  cbETH: t('0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', ethers.utils.parseUnits('0.64', 18), 51),
  ezETH: t('0x2416092f143378750bb29b79ed961ab195cceea5', ethers.utils.parseUnits('0.64', 18), 51),
  wstETH: t('0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', ethers.utils.parseUnits('0.64', 18), 1),
  wsuperOETHb: t('0x7FcD174E80f264448ebeE8c88a7C4476AAF58Ea6', ethers.utils.parseUnits('0.64', 18), 0),
  weETH: t('0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A', ethers.utils.parseUnits('0.017', 18), '0x52Aa899454998Be5b000Ad077a46Bbe360F4e497'),
  wrsETH: t('0xEDfa23602D0EC14714057867A78d01e94176BEA0', ethers.utils.parseUnits('0.64', 18), 151),
  sUSDS: t('0x5875eEE11Cf8398102FdAd704C9E96607675467a', ethers.utils.parseUnits('1000', 18), 2),
};

// ── Arbitrum ─────────────────────────────────────────────────────────────--
const ARBITRUM = {
  USDC: t('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', ethers.utils.parseUnits('1000', 6), 9),
  USDCe: t('0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', ethers.utils.parseUnits('1000', 6), 51),
  USDT0: t('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', ethers.utils.parseUnits('1000', 6), 51),
  WETH: t('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', ethers.utils.parseUnits('0.64', 18), 51),
  WBTC: t('0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', ethers.utils.parseUnits('0.017', 8), 51),
  ARB: t('0x912CE59144191C1204E64559FE8253a0e49E6548', ethers.utils.parseUnits('13000', 18), 51),
  wstETH: t('0x5979D7b546E38E414F7E9822514be443A4800529', ethers.utils.parseUnits('0.64', 18), 1),
  rETH: t('0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8', ethers.utils.parseUnits('0.64', 18), 51),
  tBTC: t('0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40', ethers.utils.parseUnits('0.017', 18), 51),
  GMX: t('0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', ethers.utils.parseUnits('185', 18), 5),
  ezETH: t('0x2416092f143378750bb29b79eD961ab195CcEea5', ethers.utils.parseUnits('0.64', 18), 51),
  tETH: t('0xd09ACb80C1E8f2291862c4978A008791c9167003', ethers.utils.parseUnits('0.64', 18), '0xDBD974Eb5360d053ea0c56B4DaCF4A9D3E894Ee2'),
  rsETH: t('0x4186BFC76E2E237523CBC30FD220FE055156b41F', ethers.utils.parseUnits('0.64', 18), 5),
  wUSDM: t('0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812', ethers.utils.parseUnits('1000', 18), 51),
  weETH: t('0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe', ethers.utils.parseUnits('0.64', 18), 51)
};

// ── Optimism ─────────────────────────────────────────────────────────────--
const OPTIMISM = {
  USDC: t('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', ethers.utils.parseUnits('1000', 6), 9),
  USDT: t('0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', ethers.utils.parseUnits('1000', 6), 0),
  WETH: t('0x4200000000000000000000000000000000000006', ethers.utils.parseUnits('0.64', 18), 3),
  WBTC: t('0x68f180fcCe6836688e9084f035309E29Bf0A2095', ethers.utils.parseUnits('0.017', 8), 0),
  OP: t('0x4200000000000000000000000000000000000042', ethers.utils.parseUnits('10600', 18), 0),
  weETH: t('0x5A7fACB970D094B6C7FF1df0eA68D99E6e73CBFF', ethers.utils.parseUnits('0.64', 18), '0x8B9441c69E8396848A471596D59FD797A626E1Bc'),
  wstETH: t('0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', ethers.utils.parseUnits('0.64', 18), 1),
  wrsETH: t('0x87eEE96D50Fb761AD85B1c982d28A042169d61b1', ethers.utils.parseUnits('0.64', 18), '0x181bA797ccF779D8aB339721ED6ee827E758668e'),
  ezETH: t('0x2416092f143378750bb29b79eD961ab195CcEea5', ethers.utils.parseUnits('0.64', 18), 51),
  rETH: t('0x9Bcef72be871e61ED4fBbc7630889beE758eb81D', ethers.utils.parseUnits('0.64', 18), 0),
  wUSDM: t('0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812', ethers.utils.parseUnits('1000', 18), 51)
};

// ── Polygon (native coin POL keyed by its wrapped ERC-20 WPOL) ─────────────--
const POLYGON = {
  USDCe: t('0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', ethers.utils.parseUnits('1000', 6), 0),
  // The balances mapping sits in this slot
  USDC: t('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', ethers.utils.parseUnits('1000', 6), 9),
  USDT0: t('0xc2132D05D31c914a87C6611C10748AEb04B58e8F', ethers.utils.parseUnits('1000', 6), 0),
  WPOL: t('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', ethers.utils.parseUnits('14300', 18), 3),
  WBTC: t('0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', ethers.utils.parseUnits('0.017', 8), 0),
  WETH: t('0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', ethers.utils.parseUnits('0.64', 18), 0),
  MaticX: t('0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6', ethers.utils.parseUnits('12200', 18), 0),
  stMATIC: t('0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4', ethers.utils.parseUnits('12400', 18), 0),
};

// ── Unichain ─────────────────────────────────────────────────────────────--
const UNICHAIN = {
  USDC: t('0x078D782b760474a361dDA0AF3839290b0EF57AD6', ethers.utils.parseUnits('1000', 6), 9),
  WETH: t('0x4200000000000000000000000000000000000006', ethers.utils.parseUnits('0.64', 18), 0),
  UNI: t('0x8f187aA05619a017077f5308904739877ce9eA21', ethers.utils.parseUnits('365', 18), 0),
  rsETH: t('0xc3eACf0612346366Db554C991D7858716db09f58', ethers.utils.parseUnits('0.64', 18), 5),
  ezETH: t('0x2416092f143378750bb29b79eD961ab195CcEea5', ethers.utils.parseUnits('0.64', 18), 51),
  WBTC: t('0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', ethers.utils.parseUnits('0.017', 8), '0x326D0B0357b394EC5bbeFE87554243E5dc76e56E'),
  wstETH: t('0xc02fE7317D4eb8753a02c35fe019786854A92001', ethers.utils.parseUnits('0.64', 18), 1),
  weETH: t('0x7DCC39B4d1C53CB31e1aBc0e358b43987FEF80f7', ethers.utils.parseUnits('0.64', 18), '0xe36DA4Ea4D07E54B1029eF26A896A656A3729f86')
};

// ── Linea ────────────────────────────────────────────────────────────────--
const LINEA = {
  WETH: t('0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', ethers.utils.parseUnits('0.64', 18), 3),
  WBTC: t('0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4', ethers.utils.parseUnits('0.017', 8), 51),
  wstETH: t('0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F', ethers.utils.parseUnits('0.64', 18), 51),
  ezETH: t('0x2416092f143378750bb29b79eD961ab195CcEea5', ethers.utils.parseUnits('0.64', 18), 51),
  weETH: t('0x1Bf74C010E6320bab11e2e5A532b5AC15e0b8aA6', ethers.utils.parseUnits('0.64', 18), '0x0323500C3F2e29F7B7f42f83d7646A5B3D0591b1'),
  wrsETH: t('0xD2671165570f41BBB3B0097893300b6EB6101E6C', ethers.utils.parseUnits('0.64', 18), 151),
};

// ── Mantle (native coin keyed by its wrapped ERC-20) ───────────────────────--
const MANTLE = {
  WETH: t('0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111', ethers.utils.parseUnits('0.64', 18), 0),
  FBTC: t('0xC96dE26018A54D51c097160568752c4E3BD6C364', ethers.utils.parseUnits('0.017', 8), ERC7201_OZ_ERC20_BALANCES),
  // The balances mapping sits in this slot
  mETH: t('0xcDA86A272531e8640cD7F1a92c01839911B90bb0', ethers.utils.parseUnits('0.64', 18), 51),
};

// ── Scroll ───────────────────────────────────────────────────────────────--
const SCROLL = {
  WETH: t('0x5300000000000000000000000000000000000004'),
  // The balances mapping sits in this slot, not in the default one
  wstETH: t('0xf610A9dfB7C89644979b4a0f27063E9e7d7Cda32', ethers.utils.parseUnits('0.64', 18), 51),
};

// Token registries per network.
export const TOKENS_BY_NETWORK: Record<string, Record<string, TokenInfo>> = {
  mainnet: MAINNET,
  base: BASE,
  arbitrum: ARBITRUM,
  optimism: OPTIMISM,
  polygon: POLYGON,
  unichain: UNICHAIN,
  linea: LINEA,
  mantle: MANTLE,
  scroll: SCROLL,
};

// Funds `to` with `amount` of `token` from `whale`'s balance.
export async function fundFromWhale(
  hre: HardhatRuntimeEnvironment,
  token: string,
  whale: string,
  to: string,
  amount: BigNumberish
): Promise<void> {
  await hre.network.provider.request({ method: 'hardhat_impersonateAccount', params: [whale] });
  await hre.network.provider.request({
    method: 'hardhat_setBalance',
    params: [whale, ethers.utils.hexStripZeros(ethers.utils.parseEther('10').toHexString())],
  });
  const signer = await hre.ethers.getSigner(whale);
  const erc20 = new ethers.Contract(
    token,
    ['function transfer(address,uint256) returns (bool)'],
    signer
  );
  await (await erc20.transfer(to, amount)).wait();
}

// Sets an ERC-20 balance directly via storage (no whale needed) using `hardhat_setStorageAt`.
export async function setErc20Balance(
  hre: HardhatRuntimeEnvironment,
  token: string,
  account: string,
  balance: BigNumberish,
  slot: BigNumberish = 0
): Promise<void> {
  if (!ethers.utils.isAddress(token)) {
    throw new Error(`${token} is not a valid address`);
  }
  if (!ethers.utils.isAddress(account)) {
    throw new Error(`${account} is not a valid address`);
  }

  const index = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [account, slot])
  );
  const value = ethers.utils.hexZeroPad(BigNumber.from(balance).toHexString(), 32);

  await hre.network.provider.request({
    method: 'hardhat_setStorageAt',
    params: [token, index, value],
  });
  await hre.network.provider.request({ method: 'evm_mine', params: [] });
}

/**
 * @notice The registry entry of the token on the network, if there is one
 */
function findTokenInfo(network: string, token: string): TokenInfo | undefined {
  return Object.values(TOKENS_BY_NETWORK[network] ?? {}).find(({ address }) => address.toLowerCase() === token.toLowerCase());
}

/**
 * @notice Whether the balance of the token can be set to any amount, which a whale with a limited balance does not allow
 */
export function hasWritableBalanceSlot(network: string, token: string): boolean {
  const info = findTokenInfo(network, token);
  return info !== undefined && !(typeof info.slot === 'string' && ethers.utils.isAddress(info.slot));
}

/**
 * @notice Adds `amount` to the token balance of `account`: writes the balances slot, or transfers from the whale
 *         for tokens whose slot cannot be written. Tokens missing from the registry are sourced by the context
 */
export async function addTokenBalance(context: CometContext, token: string, account: string, amount: bigint) {
  const dm = context.world.deploymentManager;
  const info = findTokenInfo(dm.network, token);

  if (info === undefined) {
    await context.sourceTokens(amount, token, account);
    return;
  }

  const erc20 = new ethers.Contract(token, ['function balanceOf(address) view returns (uint256)'], dm.hre.ethers.provider);
  const balanceBefore = (await erc20.balanceOf(account)).toBigInt();

  if (typeof info.slot === 'string' && ethers.utils.isAddress(info.slot)) {
    await fundFromWhale(dm.hre, token, info.slot, account, amount);
  } else {
    await setErc20Balance(dm.hre, token, account, balanceBefore + amount, info.slot);
  }

  const balanceAfter = (await erc20.balanceOf(account)).toBigInt();
  if (balanceAfter !== balanceBefore + amount) {
    throw new Error(`addTokenBalance: balance of ${token} for ${account} is ${balanceAfter}, expected ${balanceBefore + amount}`);
  }
}
