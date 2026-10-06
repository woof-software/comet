import type { BigNumberish, ContractRunner, Signer } from 'ethers';
import { Loader, World, debug } from '../../plugins/scenario/index.js';
import type { Migration } from '../../plugins/deployment_manager/index.js';
import {
  NativeTokenConstraint,
  TokenBalanceConstraint,
  ModernConstraint,
  PauseConstraint,
  UtilizationConstraint,
  SupplyCapConstraint,
  CometBalanceConstraint,
  MigrationConstraint,
  ProposalConstraint,
  FilterConstraint,
  PriceConstraint,
  ReservesConstraint
} from '../constraints/index.js';
import CometActor from './CometActor.js';
import CometAsset from './CometAsset.js';
import type {
  CometInterface,
  Configurator,
  SimpleTimelock,
  CometProxyAdmin,
  IGovernorBravo,
  CometRewards,
  Fauceteer,
  BaseBulker,
  BaseBridgeReceiver,
  ERC20,
} from '../../build/types/index.js';
import {
  BaseBridgeReceiver__factory,
  BaseBulker__factory,
  CometInterface__factory,
  CometProxyAdmin__factory,
  CometRewards__factory,
  Configurator__factory,
  ERC20__factory,
  Fauceteer__factory,
  IGovernorBravo__factory,
  SimpleTimelock__factory,
} from '../../build/types/index.js';
import { sourceTokens } from '../../plugins/scenario/utils/TokenSourcer.js';
import { deployComet, COMP_WHALES, WHALES } from '../../src/deploy/index.js';
import type { ProtocolConfiguration } from '../../src/deploy/index.js';
import { getAddressFromNumber, resolveAddress } from './Address.js';
import type { AddressLike } from './Address.js';
import { fastGovernanceExecute, max, mineBlocks, setEtherBalance, setNextBaseFeeToZero, setNextBlockTimestamp } from '../utils/index.js';
import type { DynamicConstraint, StaticConstraint } from '../../plugins/scenario/Scenario.js';
import type { Requirements } from '../constraints/Requirements.js';

export type ActorMap = { [name: string]: CometActor };
export type AssetMap = { [name: string]: CometAsset };
export type MigrationData = {
  migration: Migration<any>;
  lastProposal?: number;
  preMigrationBlockNumber?: number;
  skipVerify?: boolean;
  verified?: boolean;
}

export interface CometProperties {
  actors: ActorMap;
  assets: AssetMap;
  comet: CometInterface;
  configurator: Configurator;
  proxyAdmin: CometProxyAdmin;
  timelock: SimpleTimelock;
  governor: IGovernorBravo;
  rewards: CometRewards;
  bulker: BaseBulker;
  bridgeReceiver: BaseBridgeReceiver;
}

export class CometContext {
  world: World;
  actors: ActorMap;
  assets: AssetMap;
  migrations?: MigrationData[];

  constructor(world: World) {
    this.world = world;
    this.actors = {};
    this.assets = {};
  }

  private async getContract<T>(
    alias: string,
    connect: (address: string, runner?: ContractRunner | null) => T
  ): Promise<T> {
    const contract = await this.world.deploymentManager.contract(alias);
    return (contract && connect(await contract.getAddress(), contract.runner)) as T;
  }

  async getCompWhales(): Promise<string[]> {
    const useMainnetComp = ['mainnet', 'polygon', 'arbitrum', 'base', 'optimism', 'scroll', 'mantle', 'linea', 'ronin', 'unichain'].includes(this.world.base.network);
    return COMP_WHALES[useMainnetComp ? 'mainnet' : 'testnet'];
  }

  async getWhales(): Promise<string[]> {
    const whales: string[] = [];
    const fauceteer = await this.getFauceteer();
    if (fauceteer)
      whales.push(await fauceteer.getAddress());
    return whales.concat(WHALES[this.world.base.network] || []);
  }

  async getProposer(): Promise<Signer> {
    return this.world.impersonateAddress((await this.getCompWhales())[0], { value: 10n ** 18n, onGovNetwork: true });
  }

  async getComp(): Promise<ERC20> {
    return this.getContract('COMP', ERC20__factory.connect);
  }

  async getComet(): Promise<CometInterface> {
    return this.getContract('comet', CometInterface__factory.connect);
  }

  async getCometAdmin(): Promise<CometProxyAdmin> {
    return this.getContract('cometAdmin', CometProxyAdmin__factory.connect);
  }

  async getConfigurator(): Promise<Configurator> {
    return this.getContract('configurator', Configurator__factory.connect);
  }

  async getTimelock(): Promise<SimpleTimelock> {
    return this.getContract('timelock', SimpleTimelock__factory.connect);
  }

  async getGovernor(): Promise<IGovernorBravo> {
    return this.getContract('governor', IGovernorBravo__factory.connect);
  }

  async getRewards(): Promise<CometRewards> {
    return this.getContract('rewards', CometRewards__factory.connect);
  }

  async getRewardToken(): Promise<ERC20> {
    const signer = await this.world.deploymentManager.getSigner();
    const { token } = await this.getRewardConfig();
    return ERC20__factory.connect(token, signer);
  }

  async getBulker(): Promise<BaseBulker> {
    return this.getContract('bulker', BaseBulker__factory.connect);
  }

  async getFauceteer(): Promise<Fauceteer> {
    return this.getContract('fauceteer', Fauceteer__factory.connect);
  }

  async getBridgeReceiver(): Promise<BaseBridgeReceiver> {
    return this.getContract('bridgeReceiver', BaseBridgeReceiver__factory.connect);
  }

  async getConfiguration(): Promise<ProtocolConfiguration> {
    const comet = await this.getComet();
    const configurator = await this.getConfigurator();
    return configurator.getConfiguration(await comet.getAddress());
  }

  async getRewardConfig(): Promise<{ token: string, rescaleFactor: bigint, shouldUpscale: boolean }> {
    const comet = await this.getComet();
    const rewards = await this.getRewards();
    return rewards.rewardConfig(await comet.getAddress());
  }

  async upgrade(configOverrides: ProtocolConfiguration): Promise<CometContext> {
    const { world } = this;

    const currentComet = await this.getComet();
    const admin = await world.impersonateAddress(await currentComet.governor(), { value: 20n ** 18n });

    const deploySpec = { cometMain: true, cometExt: true };
    const deployed = await deployComet(this.world.deploymentManager, deploySpec, configOverrides, admin);

    await this.world.deploymentManager.spider(deployed);
    await this.setAssets();

    debug('Upgraded comet...');

    return this;
  }

  async changePriceFeeds(newPrices: Record<string, number>) {
    const comet = await this.getComet();
    const baseToken = await comet.baseToken();

    const newPriceFeeds: Record<string, string> = {};
    for (const assetAddress in newPrices) {
      const assetName = this.getAssetByAddress(assetAddress)[0];
      const priceFeed = await this.world.deploymentManager.deploy(
        `${assetName}:priceFeed`,
        'test/SimplePriceFeed.sol',
        [newPrices[assetAddress] * 1e8, 8],
        true
      );
      newPriceFeeds[assetAddress] = await priceFeed.getAddress();
    }

    const gov = await this.world.impersonateAddress(await comet.governor(), { value: 10n ** 18n });
    const cometAdmin = (await this.getCometAdmin()).connect(gov);
    const configurator = (await this.getConfigurator()).connect(gov);
    const cometAddress = await comet.getAddress();
    const configuratorAddress = await configurator.getAddress();
    for (const [assetAddress, priceFeedAddress] of Object.entries(newPriceFeeds)) {
      if (assetAddress === baseToken) {
        debug(`Setting base token price feed to ${priceFeedAddress}`);
        await configurator.setBaseTokenPriceFeed(cometAddress, priceFeedAddress);
      } else {
        debug(`Setting ${assetAddress} price feed to ${priceFeedAddress}`);
        await configurator.updateAssetPriceFeed(cometAddress, assetAddress, priceFeedAddress);
      }
    }
    await cometAdmin.deployAndUpgradeTo(configuratorAddress, cometAddress);
  }

  async bumpSupplyCaps(supplyAmountPerAsset: Record<string, bigint>) {
    const comet = await this.getComet();
    const baseToken = await comet.baseToken();

    // Update supply cap in asset configs if new collateral supply will exceed the supply cap
    let shouldUpgrade = false;
    const newSupplyCaps: Record<string, bigint> = {};
    for (const asset in supplyAmountPerAsset) {
      if (asset !== baseToken) {
        const assetInfo = await comet.getAssetInfoByAddress(asset);
        const currentTotalSupply = (await comet.totalsCollateral(asset)).totalSupplyAsset;
        const newTotalSupply = currentTotalSupply + supplyAmountPerAsset[asset];
        if (newTotalSupply > assetInfo.supplyCap) {
          shouldUpgrade = true;
          newSupplyCaps[asset] = max(newTotalSupply * 2n, assetInfo.scale);
        }
      }
    }

    // Set new supply caps in Configurator and do a deployAndUpgradeTo
    if (shouldUpgrade) {
      const cometAddress = await comet.getAddress();
      debug(`Bumping supply caps...`, cometAddress, newSupplyCaps);
      const gov = await this.world.impersonateAddress(await comet.governor(), { value: 10n ** 18n });
      const cometAdmin = (await this.getCometAdmin()).connect(gov);
      const configurator = (await this.getConfigurator()).connect(gov);
      for (const [asset, cap] of Object.entries(newSupplyCaps)) {
        await configurator.updateAssetSupplyCap(cometAddress, asset, cap);
      }
      await cometAdmin.deployAndUpgradeTo(await configurator.getAddress(), cometAddress);
    }
  }

  async allocateActor(name: string): Promise<CometActor> {
    const { world } = this;
    const { signer } = this.actors;

    const actorAddress = getAddressFromNumber(Object.keys(this.actors).length + 1);
    const actorSigner = await world.impersonateAddress(actorAddress);
    const actor: CometActor = new CometActor(name, actorSigner, actorAddress, this);
    this.actors[name] = actor;

    // When we allocate a new actor, how much eth should we warm the account with?
    // This seems to really vary by which network we're looking at, esp. since EIP-1559,
    // which makes the base fee for transactions variable by the network itself.
    await signer.sendEth(actor, world.base.allocation ?? 1.0);

    return actor;
  }

  getAssetByAddress(address: string): CometAsset {
    for (let [_name, asset] of Object.entries(this.assets)) {
      if (asset.address.toLowerCase() === address.toLowerCase()) {
        return asset;
      }
    }
    throw new Error(`Unable to find asset by address ${address}`);
  }

  async sourceTokens(amount: number | bigint, asset: CometAsset | string, recipient: AddressLike) {
    const { world } = this;
    const recipientAddress = resolveAddress(recipient);
    const cometAsset = typeof asset === 'string' ? this.getAssetByAddress(asset) : asset;
    const comet = await this.getComet();

    let amountRemaining = BigInt(amount);

    // Try to steal from a known whale
    for (const whale of await this.getWhales()) {
      const signer = await world.impersonateAddress(whale);
      const balance = await cometAsset.balanceOf(whale);
      const amountToTake = balance > amountRemaining ? amountRemaining : balance;
      if (amountToTake > 0n) {
        debug(`Source Tokens: stealing from whale ${whale}`, amountToTake, cometAsset.address);
        // make gas fee 0 so we can source from contract addresses as well as EOAs
        await this.setNextBaseFeeToZero();
        await cometAsset.transfer(signer, amountToTake, recipientAddress, { gasPrice: 0 });
        amountRemaining -= amountToTake;
      }
      if (amountRemaining <= 0n)
        break;
    }

    if (amountRemaining != 0n) {
      // Source from logs (expensive, in terms of node API limits)
      debug('Source Tokens: sourcing from logs...', amountRemaining, cometAsset.address);
      await sourceTokens({
        dm: this.world.deploymentManager,
        amount: amountRemaining,
        asset: cometAsset.address,
        address: recipientAddress,
        blacklist: [await comet.getAddress()],
      });
    }
  }

  async setActors(actors?: { [name: string]: CometActor }) {
    this.actors = actors ?? await getActors(this);
  }

  async setAssets(assets?: { [symbol: string]: CometAsset }) {
    this.assets = assets ?? await getAssets(this);
  }

  async setNextBaseFeeToZero() {
    await setNextBaseFeeToZero(this.world.deploymentManager);
  }

  async setNextBlockTimestamp(timestamp: number) {
    await setNextBlockTimestamp(this.world.deploymentManager, timestamp);
  }

  async mineBlocks(blocks: number) {
    await mineBlocks(this.world.deploymentManager, blocks);
  }

  // Instantly executes some actions through the governance proposal process
  async fastGovernanceExecute(targets: string[], values: BigNumberish[], signatures: string[], calldatas: string[]) {
    const proposer = await this.getProposer();
    await fastGovernanceExecute(
      this.world.deploymentManager,
      proposer,
      targets,
      values,
      signatures,
      calldatas
    );
  }
}

async function buildActor(name: string, signer: Signer, context: CometContext): Promise<CometActor> {
  return new CometActor(name, signer, await signer.getAddress(), context);
}

async function getActors(context: CometContext): Promise<{ [name: string]: CometActor }> {
  const { world } = context;

  const comet = await context.getComet();
  const [
    localAdminSigner,
    localPauseGuardianSigner,
    albertSigner,
    bettySigner,
    charlesSigner
  ] = await world.deploymentManager.getSigners();

  const adminAddress = await comet.governor();
  const pauseGuardianAddress = await comet.pauseGuardian();
  const useLocalAdminSigner = adminAddress === await localAdminSigner.getAddress();
  const useLocalPauseGuardianSigner = pauseGuardianAddress === await localPauseGuardianSigner.getAddress();
  let adminSigner: Signer;
  if (useLocalAdminSigner) {
    adminSigner = localAdminSigner;
  } else {
    adminSigner = await world.impersonateAddress(adminAddress);
    // Fund the impersonated governor for gas (single setBalance RPC, no block mined),
    // so scenarios don't need to zero the base fee on every admin tx.
    await setEtherBalance(world.deploymentManager, adminAddress, 10n ** 18n);
  }
  const pauseGuardianSigner = useLocalPauseGuardianSigner ? localPauseGuardianSigner : await world.impersonateAddress(pauseGuardianAddress);

  return {
    admin: await buildActor('admin', adminSigner, context),
    pauseGuardian: await buildActor('pauseGuardian', pauseGuardianSigner, context),
    albert: await buildActor('albert', albertSigner, context),
    betty: await buildActor('betty', bettySigner, context),
    charles: await buildActor('charles', charlesSigner, context),
    signer: await buildActor('signer', localAdminSigner, context),
  };
}

async function getAssets(context: CometContext): Promise<{ [symbol: string]: CometAsset }> {
  const { deploymentManager } = context.world;

  const COMP = await context.getComp();
  const comet = await context.getComet();
  const signer = await deploymentManager.getSigner();
  const numAssets = await comet.numAssets();
  const assetAddresses = [
    await comet.baseToken(),
    ...await Promise.all(Array(Number(numAssets)).fill(0).map(async (_, i) => {
      return (await comet.getAssetInfo(i)).asset;
    })),
    ...(COMP ? [await COMP.getAddress()] : []),
  ];

  return Object.fromEntries(await Promise.all(assetAddresses.map(async (address) => {
    const erc20 = ERC20__factory.connect(address, signer);
    return [await erc20.symbol(), new CometAsset(erc20)];
  })));
}

async function getInitialContext(world: World): Promise<CometContext> {
  const context = new CometContext(world);
  await context.setActors();
  await context.setAssets();
  return context;
}

async function getContextProperties(context: CometContext): Promise<CometProperties> {
  return {
    actors: context.actors,
    assets: context.assets,
    comet: await context.getComet(),
    configurator: await context.getConfigurator(),
    proxyAdmin: await context.getCometAdmin(),
    timelock: await context.getTimelock(),
    governor: await context.getGovernor(),
    rewards: await context.getRewards(),
    bulker: await context.getBulker(),
    bridgeReceiver: await context.getBridgeReceiver()
  };
}

export const staticConstraints: StaticConstraint<CometContext>[] = [
  new NativeTokenConstraint(),
  new MigrationConstraint(),
  new ProposalConstraint(),
];

export const dynamicConstraints: DynamicConstraint<CometContext, Requirements>[] = [
  new FilterConstraint(),
  new ModernConstraint(),
  new PauseConstraint(),
  new SupplyCapConstraint(),
  new CometBalanceConstraint(),
  new TokenBalanceConstraint(),
  new UtilizationConstraint(),
  new PriceConstraint(),
  new ReservesConstraint()
];

export const scenarioLoader = Loader.get<CometContext, CometProperties, Requirements>().configure(
  staticConstraints,
  getInitialContext,
  getContextProperties,
);
export const scenario = scenarioLoader.scenarioFun(dynamicConstraints);
