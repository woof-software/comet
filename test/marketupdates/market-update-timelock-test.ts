import { AbiCoder, keccak256 } from 'ethers';

import { makeMarketAdmin, advanceTimeAndMineBlock } from './market-updates-helper.js';
import { expect, getBlock, makeConfigurator } from '../helpers.js';
import { Configurator__factory } from '../../build/types/index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

describe('MarketUpdateTimelock', function() {
  it('is created properly with main-governor-timelock as governor', async () => {
    const { marketUpdateTimelockContract, governorTimelockSigner } = await makeMarketAdmin();

    expect(await marketUpdateTimelockContract.governor()).to.equal(
      governorTimelockSigner.address
    );
  });

  it('only allows main-governor-timelock to set MarketUpdateProposer', async () => {
    const {
      marketUpdateTimelockContract,
      governorTimelockSigner,
    } = await makeMarketAdmin();

    const {
      users: [alice, bob],
    } = await makeConfigurator();

    await marketUpdateTimelockContract
      .connect(governorTimelockSigner)
      .setMarketUpdateProposer(alice.address);

    expect(await marketUpdateTimelockContract.marketUpdateProposer()).to.equal(
      alice.address
    );

    await expect(
      marketUpdateTimelockContract.connect(bob).setMarketUpdateProposer(bob.address)
    ).to.be.revertedWith(
      'MarketUpdateTimelock::setMarketUpdateProposer: Call must come from governor.'
    );
  });

  it('only MarketUpdateProposer can queue transactions', async () => {
    // include checks for marketAdmin, governor, and anonymous address
    const {
      marketUpdateTimelockContract,
      governorTimelockSigner,
      marketUpdateProposerContract,
      marketUpdateMultiSig,
    } = await makeMarketAdmin();

    const {
      configuratorProxy,
      cometProxyWithExtendedAssetList: cometProxy,
      users: [bob],
    } = await makeConfigurator();

    // Get the delay from the contract
    const delay = Number(await marketUpdateTimelockContract.delay()); // Example: 172800 for 2 days

    const latestBlock = await getBlock();
    const currentTimestamp = latestBlock.timestamp;

    // Ensure eta is sufficiently in the future
    const eta = currentTimestamp + delay + 5; // eta is current timestamp + delay + a few seconds

    // Success case: market update proposer can queue transactions
    await marketUpdateProposerContract
      .connect(marketUpdateMultiSig)
      .propose(
        [await configuratorProxy.getAddress()],
        [0],
        ['setSupplyKink(address, uint64)'],
        [
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
        ],
        'Setting supply kink to 100'
      );

    // Failure case: Main Governor Timelock cannot queue transactions
    await expect(
      marketUpdateTimelockContract
        .connect(governorTimelockSigner)
        .queueTransaction(
          await configuratorProxy.getAddress(),
          0,
          'setSupplyKink(address, uint64)',
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
          eta
        )
    ).to.be.revertedWith(
      'MarketUpdateTimelock::queueTransaction: Call must come from marketUpdateProposer.'
    );

    // Failure case: none other than MarketUpdateProposer can queue transactions
    await expect(
      marketUpdateTimelockContract
        .connect(bob)
        .queueTransaction(
          await configuratorProxy.getAddress(),
          0,
          'setSupplyKink(address, uint64)',
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
          eta
        )
    ).to.be.revertedWith(
      'MarketUpdateTimelock::queueTransaction: Call must come from marketUpdateProposer.'
    );
  });

  it('only MarketUpdateProposer can execute transactions', async () => {
    const {
      marketUpdateTimelockContract,
      governorTimelockSigner,
      marketUpdateProposerContract,
      marketUpdateMultiSig,
    } = await makeMarketAdmin();

    const {
      configuratorProxy,
      configurator,
      cometProxyWithExtendedAssetList: cometProxy,
      users: [bob],
    } = await makeConfigurator();

    const configuratorAsProxy = Configurator__factory.connect(
      await configuratorProxy.getAddress(),
      configurator.runner
    );
    configuratorAsProxy.transferGovernor(await marketUpdateTimelockContract.getAddress());
    const proposalId = 1n;

    // Get the delay from the contract
    const delay = Number(await marketUpdateTimelockContract.delay()); // Example: 172800 for 2 days

    let latestBlock = await getBlock();
    let currentTimestamp = latestBlock.timestamp;

    let eta = currentTimestamp + delay + 5; // Ensure eta is in the future

    // Success case: market update proposer can execute transactions
    await marketUpdateProposerContract
      .connect(marketUpdateMultiSig)
      .propose(
        [await configuratorProxy.getAddress()],
        [0],
        ['setSupplyKink(address,uint64)'],
        [
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
        ],
        'Setting supply kink to 100'
      );

    // Fast-forward time by delay + seconds to surpass the eta
    await advanceTimeAndMineBlock(delay);

    await marketUpdateProposerContract
      .connect(marketUpdateMultiSig)
      .execute(proposalId);

    // Failure case: Main Governor Timelock cannot execute transactions

    latestBlock = await getBlock();
    currentTimestamp = latestBlock.timestamp;

    eta = currentTimestamp + delay + 5; // Ensure eta is in the future

    await marketUpdateProposerContract
      .connect(marketUpdateMultiSig)
      .propose(
        [await configuratorProxy.getAddress()],
        [0],
        ['setSupplyKink(address,uint64)'],
        [
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
        ],
        'Setting supply kink to 100'
      );

    // Fast-forward time by delay + few seconds to surpass the eta
    await advanceTimeAndMineBlock(delay);

    await expect(marketUpdateTimelockContract
      .connect(governorTimelockSigner)
      .executeTransaction(
        await configuratorProxy.getAddress(),
        0,
        'setSupplyKink(address,uint64)',
        abiCoder.encode(
          ['address', 'uint64'],
          [await cometProxy.getAddress(), 100000]
        ),
        eta
      )).to.be.revertedWith('MarketUpdateTimelock::executeTransaction: Call must come from marketUpdateProposer.');

    // Failure case: none other than MarketUpdateProposer can execute transactions

    // first queuing a transaction
    latestBlock = await getBlock();
    currentTimestamp = latestBlock.timestamp;

    eta = currentTimestamp + delay + 5; // Ensure eta is in the future

    await marketUpdateProposerContract
      .connect(marketUpdateMultiSig)
      .propose(
        [await configuratorProxy.getAddress()],
        [0],
        ['setSupplyKink(address,uint64)'],
        [
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
        ],
        'Setting supply kink to 100'
      );

    // Fast-forward time by delay + few seconds to surpass the eta
    await advanceTimeAndMineBlock(delay);

    await expect(
      marketUpdateTimelockContract
        .connect(bob)
        .executeTransaction(
          await configuratorProxy.getAddress(),
          0,
          'setSupplyKink(address,uint64)',
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100000]
          ),
          eta
        )
    ).to.be.revertedWith(
      'MarketUpdateTimelock::executeTransaction: Call must come from marketUpdateProposer.'
    );
  });

  it('only MarketUpdateProposer can cancel transactions', async () => {
    const {
      marketUpdateTimelockContract,
      governorTimelockSigner,
      marketUpdateProposerContract,
      marketUpdateMultiSig,
    } = await makeMarketAdmin();

    const {
      configuratorProxy,
      configurator,
      cometProxyWithExtendedAssetList: cometProxy,
      users: [bob],
    } = await makeConfigurator();

    const configuratorAsProxy = Configurator__factory.connect(
      await configuratorProxy.getAddress(),
      configurator.runner
    );
    await configuratorAsProxy.transferGovernor(await marketUpdateTimelockContract.getAddress());

    const proposalId = 1n;

    // Get the delay from the contract
    const delay = Number(await marketUpdateTimelockContract.delay()); // Example: 172800 for 2 days

    let latestBlock = await getBlock();
    let currentTimestamp = latestBlock.timestamp;

    let eta = currentTimestamp + delay + 5; // Ensure eta is in the future

    // Success case: MarketUpdateProposer can cancel transactions
    await marketUpdateProposerContract
      .connect(marketUpdateMultiSig)
      .propose(
        [await configuratorProxy.getAddress()],
        [0],
        ['setSupplyKink(address,uint64)'],
        [
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
        ],
        'Setting supply kink to 100'
      );

    await marketUpdateProposerContract.connect(marketUpdateMultiSig).cancel(proposalId);

    // Checking the state of the transaction using the txHash
    const txHash = keccak256(
      abiCoder.encode(
        ['address', 'uint', 'string', 'bytes', 'uint'],
        [
          await configuratorProxy.getAddress(),
          0,
          'setSupplyKink(address,uint64)',
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100000]
          ),
          eta,
        ]
      )
    );

    expect(await marketUpdateTimelockContract.queuedTransactions(txHash)).to.equal(
      false
    );

    // Failure case: Main Governor Timelock cannot cancel transactions
    await marketUpdateProposerContract
      .connect(marketUpdateMultiSig)
      .propose(
        [await configuratorProxy.getAddress()],
        [0],
        ['setSupplyKink(address,uint64)'],
        [
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
        ],
        'Setting supply kink to 100'
      );

    await expect(marketUpdateTimelockContract
      .connect(governorTimelockSigner)
      .cancelTransaction(
        await configuratorProxy.getAddress(),
        0,
        'setSupplyKink(address,uint64)',
        abiCoder.encode(
          ['address', 'uint64'],
          [await cometProxy.getAddress(), 100000]
        ),
        eta
      )).to.be.revertedWith('MarketUpdateTimelock::cancelTransaction: Call must come from marketUpdateProposer.');

    // Failure case: none other than MarketUpdateProposer can execute transactions

    // first queuing a transaction
    latestBlock = await getBlock();
    currentTimestamp = latestBlock.timestamp;

    eta = currentTimestamp + delay + 5; // Ensure eta is in the future

    await marketUpdateProposerContract
      .connect(marketUpdateMultiSig)
      .propose(
        [await configuratorProxy.getAddress()],
        [0],
        ['setSupplyKink(address,uint64)'],
        [
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100]
          ),
        ],
        'Setting supply kink to 100'
      );

    await expect(
      marketUpdateTimelockContract
        .connect(bob)
        .cancelTransaction(
          await configuratorProxy.getAddress(),
          0,
          'setSupplyKink(address,uint64)',
          abiCoder.encode(
            ['address', 'uint64'],
            [await cometProxy.getAddress(), 100000]
          ),
          eta
        )
    ).to.be.revertedWith(
      'MarketUpdateTimelock::cancelTransaction: Call must come from marketUpdateProposer.'
    );
  });

  it('only main-governor-timelock can set new governor', async () => {
    const {
      marketUpdateTimelockContract,
      governorTimelockSigner,
    } = await makeMarketAdmin();

    const {
      users: [alice, bob],
    } = await makeConfigurator();

    await marketUpdateTimelockContract
      .connect(governorTimelockSigner)
      .setGovernor(alice.address);

    expect(await marketUpdateTimelockContract.governor()).to.equal(alice.address);

    await expect(
      marketUpdateTimelockContract.connect(bob).setGovernor(bob.address)
    ).to.be.revertedWith(
      'MarketUpdateTimelock::setGovernor: Call must come from governor.'
    );
  });

  it('MarketUpdateProposer cannot set or update MarketUpdateProposer', async () => {
    const {
      marketUpdateTimelockContract,
      marketUpdateMultiSig,
    } = await makeMarketAdmin();

    const {
      users: [bob],
    } = await makeConfigurator();

    await expect(
      marketUpdateTimelockContract
        .connect(marketUpdateMultiSig)
        .setMarketUpdateProposer(bob.address)
    ).to.be.revertedWith(
      'MarketUpdateTimelock::setMarketUpdateProposer: Call must come from governor.'
    );
  });

  it('MarketUpdateProposer cannot set or update main-governor-timelock', async () => {
    const {
      marketUpdateTimelockContract,
      marketUpdateMultiSig,
    } = await makeMarketAdmin();

    const {
      users: [bob],
    } = await makeConfigurator();

    await expect(
      marketUpdateTimelockContract.connect(marketUpdateMultiSig).setGovernor(bob.address)
    ).to.be.revertedWith(
      'MarketUpdateTimelock::setGovernor: Call must come from governor.'
    );
  });
});
