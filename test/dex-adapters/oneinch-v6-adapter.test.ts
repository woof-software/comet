import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ContractReceipt, ContractTransaction, Signer, BigNumber } from 'ethers';
import { OneInchV6CoreAdapter, ERC20 } from '../../build/types';
import {
  fundFromWhale,
  fetch1inchSwapData,
  ONEINCH_V6_SWAP_ABI,
  eq,
  findEvent,
  SnapshotRestorer,
  setupDexAdapter,
  CHAIN_ID,
  ONEINCH_SLIPPAGE_PCT,
  AMM_PROTOCOLS,
  CORE_ROUTER,
  ERC20_EVENTS_IFACE,
  WBTC,
  WBTC_WHALE,
  WBTC_AMOUNT,
} from '../helpers';

const suite =
  process.env.MAINNET_QUICKNODE_LINK && process.env.ONEINCH_API_KEY ? describe : describe.skip;

suite('OneInchV6CoreAdapter', function () {
  this.timeout(180_000);

  let adapter: OneInchV6CoreAdapter;
  let baseToken: string;
  let baseTokenErc20: ERC20;
  let wbtcErc20: ERC20;
  let moduleSigner: Signer;
  let moduleAddress: string;
  let snapshot: SnapshotRestorer;

  before(async () => {
    ({ adapter, baseToken, baseTokenErc20, wbtcErc20, moduleSigner, moduleAddress, snapshot } =
      await setupDexAdapter());
  });

  context('core swap router', function () {
    let tx: ContractTransaction;
    let receipt: ContractReceipt;
    let amountIn: BigNumber;
    let minOut: BigNumber;
    let received: BigNumber;
    let quote: string;

    before(async () => {
      await fundFromWhale(WBTC, WBTC_WHALE, adapter.address, WBTC_AMOUNT);
      amountIn = await wbtcErc20.balanceOf(adapter.address);

      quote = await fetch1inchSwapData({
        chainId: CHAIN_ID,
        src: WBTC,
        dst: baseToken,
        amount: amountIn.toString(),
        from: adapter.address,
        slippage: ONEINCH_SLIPPAGE_PCT,
        protocols: AMM_PROTOCOLS,
      });
    });

    after(async () => await snapshot.restore());

    it('swaps collateral into the base asset using 1Inch swap quote', async () => {
      minOut = await adapter.calculateMinAmountOut(WBTC, amountIn);
      tx = await adapter.connect(moduleSigner).swap(WBTC, quote);
      receipt = await tx.wait();
      received = await baseTokenErc20.balanceOf(moduleAddress);
    });

    it('emits the adapter Swap event', async () => {
      await expect(tx).to.emit(adapter, 'Swap').withArgs(WBTC, amountIn, received);
    });

    it('routes the swap through the 1inch core router', async () => {
      // The core path approves the 1inch router to pull the collateral.
      await expect(tx)
        .to.emit(wbtcErc20, 'Approval')
        .withArgs(adapter.address, CORE_ROUTER, amountIn);

      const fallbackAllowanceReset = findEvent(
        receipt.logs,
        ERC20_EVENTS_IFACE,
        'Approval',
        (token, args) =>
          eq(token, WBTC) &&
          eq(args.owner, adapter.address) &&
          eq(args.spender, CORE_ROUTER) &&
          args.value.eq(0)
      );
      expect(fallbackAllowanceReset, 'core swap must not fall back to the redundant router').to.be
        .undefined;
    });

    it('forwards the realized base output to the module', () => {
      expect(minOut).to.be.gt(0);
      expect(received).to.be.gte(minOut);
    });

    it('leaves no tokens on the adapter balance', async () => {
      expect(await wbtcErc20.balanceOf(adapter.address)).to.equal(0);
      expect(await baseTokenErc20.balanceOf(adapter.address)).to.equal(0);
    });

    context('reverts when', function () {
      let amountIn: BigNumber;
      let minOut: BigNumber;

      // Use locally crafted swap description instead of making excessive 1Inch API calls.
      const swapIface = new ethers.utils.Interface([ONEINCH_V6_SWAP_ABI]);
      const encodeSwap = (desc: Record<string, unknown>): string =>
        swapIface.encodeFunctionData('swap', [ethers.constants.AddressZero, desc, '0x']);
      const validDesc = () => ({
        srcToken: WBTC,
        dstToken: baseToken,
        srcReceiver: adapter.address,
        dstReceiver: adapter.address,
        amount: amountIn,
        minReturnAmount: minOut,
        flags: 0,
      });

      before(async () => {
        await fundFromWhale(WBTC, WBTC_WHALE, adapter.address, WBTC_AMOUNT);
        amountIn = await wbtcErc20.balanceOf(adapter.address);
        minOut = await adapter.calculateMinAmountOut(WBTC, amountIn);
      });

      it('swapData is too short to hold a selector', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, '0x')
        ).to.be.revertedWithCustomError(adapter, 'InvalidSwapData');
      });

      it('swapData selector is not IOneInchV6.swap', async () => {
        const wrongSelector = ethers.utils.hexConcat(['0xdeadbeef', ethers.utils.hexZeroPad('0x', 32)]);
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, wrongSelector)
        ).to.be.revertedWithCustomError(adapter, 'InvalidSelector');
      });

      it('srcToken does not match the collateral', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), srcToken: baseToken }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidTokens');
      });

      it('dstToken does not match the base asset', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), dstToken: WBTC }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidTokens');
      });

      it('dstReceiver is not the adapter', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), dstReceiver: moduleAddress }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidReceiver');
      });

      it('amount does not match the adapter collateral balance', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), amount: amountIn.add(1) }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidAmountIn');
      });

      it('minReturnAmount is below the adapter minimum', async () => {
        await expect(
          adapter.connect(moduleSigner).swap(WBTC, encodeSwap({ ...validDesc(), minReturnAmount: minOut.sub(1) }))
        ).to.be.revertedWithCustomError(adapter, 'InvalidMinAmountOut');
      });
    });
  });
});
