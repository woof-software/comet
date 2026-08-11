import { expect, makeProtocol, setTotalsBasic } from './helpers';

describe('getReserves', function () {
  it('calculates 0 reserves', async () => {
    const protocol = await makeProtocol({base: 'USDC'});
    const { comet, tokens } = protocol;
    const { USDC } = tokens;
    await USDC.allocateTo(comet.address, 100);

    await setTotalsBasic(comet, {
      baseSupplyIndex: 4e15,
      baseBorrowIndex: 3e15,
      totalSupplyBase: 25n,
      totalBorrowBase: 0n,
    });

    const reserves = await comet.getReserves();

    expect(reserves).to.be.equal(0n);
  });

  it('calculates positive reserves', async () => {
    const protocol = await makeProtocol({base: 'USDC'});
    const { comet, tokens } = protocol;
    const { USDC } = tokens;
    await USDC.allocateTo(comet.address, 100);

    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      baseBorrowIndex: 5e15,
      totalSupplyBase: 50n,
      totalBorrowBase: 10n,
    });

    const reserves = await comet.getReserves();

    expect(reserves).to.be.equal(50n);
  });

  it('calculates negative reserves', async () => {
    const protocol = await makeProtocol({base: 'USDC'});
    const { comet } = protocol;

    // Protocol holds no USDC.
    // totalBorrowBase must be non-zero so the supply-index cap does not fire
    // (cap condition: totalBorrowBase == 0 && totalSupplyBase > 0 would clamp
    // totalSupply_ to balance=0, making reserves=0 instead of -100).
    // With baseSupplyIndex=2e15 and baseBorrowIndex=3e15:
    //   reserves = 0 - 53*2 + 2*3 = -106 + 6 = -100
    await setTotalsBasic(comet, {
      baseSupplyIndex: 2e15,
      baseBorrowIndex: 3e15,
      totalSupplyBase: 53n,
      totalBorrowBase: 2n,
    });

    const reserves = await comet.getReserves();

    expect(reserves).to.be.equal(-100n);
  });
});
