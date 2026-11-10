import { expect } from 'chai';
import { strict as assert } from 'assert';
import { BigNumber, Contract, providers, utils } from 'ethers';
import hre from 'hardhat';
import { diffState, getCometConfig } from '../DiffState';

describe('DiffState', () => {
  const address = (digit: string) => `0x${digit.repeat(40)}`;

  describe('diffState', () => {
    const contract = new Contract(address('1'), [], hre.ethers.provider);
    const originalLog = console.log;
    let logs: unknown[][];

    beforeEach(() => {
      logs = [];
      console.log = (...args: unknown[]) => { logs.push(args); };
    });
    afterEach(() => { console.log = originalLog; });

    it('returns new values, additions and deletions and normalizes nested BigNumbers without losing precision', async () => {
      const large = '900719925474099312345';
      const calls: Array<[Contract, number | undefined]> = [];
      const getState = async (received: Contract, block?: number) => {
        calls.push([received, block]);
        return block === 100 ? {
          balance: BigNumber.from(large),
          nested: { debt: BigNumber.from(-5), unchanged: 'same' },
          positions: [BigNumber.from(0), BigNumber.from(2)],
          removed: 'old value', enabled: true,
        } : {
          balance: BigNumber.from(large).add(1),
          nested: { debt: BigNumber.from(-4), unchanged: 'same' },
          positions: [BigNumber.from(0), BigNumber.from(3)],
          added: BigNumber.from(7), enabled: false,
        };
      };

      const result = await diffState(contract, getState, 100, 200);
      expect(calls).to.eql([[contract, 100], [contract, 200]]);
      expect(result).to.eql({
        balance: 900719925474099312346n,
        nested: { debt: -4n }, positions: { 1: 3n },
        removed: undefined, added: 7n, enabled: false,
      });
      expect(Object.prototype.hasOwnProperty.call(result, 'removed')).to.equal(true);
      expect(logs[0]).to.eql(['State changes after migration']);
      const output = String(logs[1]?.[0]);
      expect(output).to.include('+ New state').and.include('- Old state');
      expect(output).to.match(/^\+.*900719925474099312346n/m);
      expect(output).to.match(/^-.*900719925474099312345n/m);
    });

    it('returns an empty diff for equal values represented by distinct BigNumbers and native bigint', async () => {
      const getState = async (_contract: Contract, block?: number) => ({
        amount: block === 10 ? BigNumber.from('9007199254740993') : 9007199254740993n,
        nested: { amount: BigNumber.from(0), empty: {} }, list: [], enabled: false, label: '',
      });
      expect(await diffState(contract, getState, 10, 11)).to.eql({});
    });

    it('forwards an omitted new block as undefined to the state reader', async () => {
      const blocks: Array<number | undefined> = [];
      const getState = async (_contract: Contract, block?: number) => {
        blocks.push(block);
        return { amount: BigNumber.from(block === 0 ? 1 : 2) };
      };
      expect(await diffState(contract, getState, 0)).to.eql({ amount: 2n });
      expect(blocks).to.eql([0, undefined]);
    });

    for (const failingBlock of [10, 11]) {
      it(`preserves an error reading block ${failingBlock} without reporting a successful diff`, async () => {
        const failure = new Error(`Cannot read block ${failingBlock}`);
        const blocks: Array<number | undefined> = [];
        const getState = async (_contract: Contract, block?: number) => {
          blocks.push(block);
          if (block === failingBlock) throw failure;
          return { amount: BigNumber.from(1) };
        };
        await assert.rejects(diffState(contract, getState, 10, 11), error => error === failure);
        expect(blocks).to.eql(failingBlock === 10 ? [10] : [10, 11]);
        expect(logs).to.eql([]);
      });
    }

    it('compares states containing null fields alongside numeric values', async () => {
      const getState = async (_contract: Contract, block?: number) => ({
        optional: null, nested: { optional: null }, amount: BigNumber.from(block),
      });
      expect(await diffState(contract, getState, 1, 2)).to.eql({ amount: 2n });
    });

    it('compares actual token balances at historical blocks', async () => {
      const [signer] = await hre.ethers.getSigners();
      const token = await (await hre.ethers.getContractFactory('FaucetToken'))
        .deploy(0, 'Historical state', 6, 'HISTORY');
      const oldBlock = (await token.deployTransaction.wait()).blockNumber;
      const newBlock = (await (await token.allocateTo(signer.address, 7)).wait()).blockNumber;
      const getState = async (received: Contract, block?: number) => ({
        balance: await received.balanceOf(signer.address, { blockTag: block }),
      });
      expect(await diffState(token, getState, oldBlock, newBlock)).to.eql({ balance: 7n });
    });
  });

  describe('getCometConfig', () => {
    const scalarConfig = {
      governor: address('1'), pauseGuardian: address('2'), baseToken: address('3'),
      baseTokenPriceFeed: address('4'), extensionDelegate: address('5'),
      supplyKink: BigNumber.from(101), supplyPerSecondRateSlopeLow: BigNumber.from(102),
      supplyPerSecondInterestRateSlopeHigh: BigNumber.from(103), supplyPerSecondInterestRateBase: BigNumber.from(104),
      borrowKink: BigNumber.from(105), borrowPerSecondInterestRateSlopeLow: BigNumber.from(106),
      borrowPerSecondInterestRateSlopeHigh: BigNumber.from(107), borrowPerSecondInterestRateBase: BigNumber.from(108),
      storeFrontPriceFactor: BigNumber.from(109), baseTrackingSupplySpeed: BigNumber.from(110),
      baseTrackingBorrowSpeed: BigNumber.from(111), baseMinForRewards: BigNumber.from(112),
      baseBorrowMin: BigNumber.from(113), targetReserves: BigNumber.from('900719925474099312345'),
    };
    const assets = [
      {
        offset: 0, asset: address('6'), priceFeed: address('8'), scale: BigNumber.from(10).pow(18),
        borrowCollateralFactor: BigNumber.from(71), liquidateCollateralFactor: BigNumber.from(81),
        liquidationFactor: BigNumber.from(91), supplyCap: BigNumber.from(1001),
      },
      {
        offset: 1, asset: address('7'), priceFeed: address('9'), scale: BigNumber.from(10).pow(8),
        borrowCollateralFactor: BigNumber.from(72), liquidateCollateralFactor: BigNumber.from(82),
        liquidationFactor: BigNumber.from(92), supplyCap: BigNumber.from(1002),
      },
    ];
    const methodNames = Object.keys(scalarConfig).map(key =>
      key === 'supplyPerSecondRateSlopeLow' ? 'supplyPerSecondInterestRateSlopeLow' : key);
    let comet: Contract;
    let provider: providers.StaticJsonRpcProvider;
    let reads: Array<{ method: string, args: unknown[] }>;
    let symbolReads: Array<{ address: string, block: providers.BlockTag | undefined }>;

    beforeEach(() => {
      reads = [];
      symbolReads = [];
      provider = new providers.StaticJsonRpcProvider(undefined, { name: 'offline', chainId: 31337 });
      const tokenInterface = new utils.Interface(['function symbol() view returns (string)']);
      // Keep ethers Contract construction and ABI decoding real; replace only the RPC boundary.
      provider.call = async (transaction, blockTag) => {
        const to = await transaction.to;
        expect(await transaction.data).to.equal(tokenInterface.encodeFunctionData('symbol'));
        symbolReads.push({ address: to!, block: await blockTag });
        assert.ok(to === assets[0].asset || to === assets[1].asset, `Unexpected token address: ${to}`);
        return tokenInterface.encodeFunctionResult('symbol', [to === assets[0].asset ? 'WETH' : 'WBTC']);
      };
      const methods: Record<string, unknown> = { provider };
      for (const [key, value] of Object.entries(scalarConfig)) {
        const method = key === 'supplyPerSecondRateSlopeLow' ? 'supplyPerSecondInterestRateSlopeLow' : key;
        methods[method] = async (...args: unknown[]) => { reads.push({ method, args }); return value; };
      }
      methods.numAssets = async (...args: unknown[]) => { reads.push({ method: 'numAssets', args }); return assets.length; };
      methods.getAssetInfo = async (index: number, ...args: unknown[]) => {
        reads.push({ method: 'getAssetInfo', args: [index, ...args] });
        assert.ok(index >= 0 && index < assets.length);
        return assets[index];
      };
      // Only the Comet read interface is stubbed, with distinct values for every parameter.
      comet = methods as unknown as Contract;
    });

    for (const block of [undefined, 0, 123]) {
      it(`reads all parameters and distinct collateral configurations at ${block === undefined ? 'latest' : `block ${block}`}`, async () => {
        expect(await getCometConfig(comet, block)).to.eql({
          ...scalarConfig, numAssets: 2, WETH: assets[0], WBTC: assets[1],
        });
        const blockTag = { blockTag: block === undefined ? 'latest' : block };
        expect(reads.filter(read => read.method !== 'getAssetInfo').map(read => read.method))
          .to.have.members(['numAssets', ...methodNames]);
        expect(reads.filter(read => read.method !== 'getAssetInfo'))
          .to.have.length(methodNames.length + 1);
        for (const read of reads.filter(read => read.method !== 'getAssetInfo')) expect(read.args).to.eql([blockTag]);
        expect(reads.filter(read => read.method === 'getAssetInfo')).to.eql([
          { method: 'getAssetInfo', args: [0, blockTag] }, { method: 'getAssetInfo', args: [1, blockTag] },
        ]);
        expect(symbolReads).to.eql([
          { address: assets[0].asset, block: blockTag.blockTag },
          { address: assets[1].asset, block: blockTag.blockTag },
        ]);
      });
    }

    it('returns scalar configuration without asset or symbol lookups when there are no collaterals', async () => {
      Object.assign(comet, { numAssets: async () => 0 });
      expect(await getCometConfig(comet)).to.eql({ ...scalarConfig, numAssets: 0 });
      expect(reads.some(read => read.method === 'getAssetInfo')).to.equal(false);
      expect(symbolReads).to.eql([]);
    });

    for (const boundary of ['governor', 'getAssetInfo', 'symbol'] as const) {
      it(`preserves a ${boundary} read error rather than returning an incomplete configuration`, async () => {
        const failure = new Error(`Cannot read ${boundary}`);
        if (boundary === 'symbol') provider.call = async () => { throw failure; };
        else Object.assign(comet, { [boundary]: async () => { throw failure; } });
        await assert.rejects(getCometConfig(comet, 123), error => error === failure);
        if (boundary !== 'symbol') expect(symbolReads).to.eql([]);
      });
    }
  });
});
