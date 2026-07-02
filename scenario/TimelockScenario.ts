import { scenario, CometContext } from './context/CometContext';
import { expect } from 'chai';
import { BigNumberish, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { advanceToTimestamp, getLatestBlockTimestamp, isBridgedDeployment, mineBlocks, setNextBlockTimestamp } from './utils';
import { Timelock, Timelock__factory } from '../build/types';
import { DeploymentManager } from '../plugins/deployment_manager/DeploymentManager';

const ONE_DAY = 24 * 60 * 60;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ─────────────────────────────────────────────────────────────────────────────
// Happy Path
// ─────────────────────────────────────────────────────────────────────────────

// HP-00
scenario(
  'Timelock#queueTransaction > queues a transaction with valid eta',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const target = actors.betty.address;
    const value = 0;
    const signature = '';
    const data = '0x';
    const eta = await buildEta(dm, timelock);
    const txHash = computeTxHash(target, value, signature, data, eta);

    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'tx must not be queued before');

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);

    expect(
      await timelock.connect(admin).callStatic.queueTransaction(target, value, signature, data, eta)
    ).to.equal(txHash, 'queueTransaction must return the txHash');

    const txn = await timelock
      .connect(admin)
      .queueTransaction(target, value, signature, data, eta)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash)).to.equal(true, 'tx must be queued after');

    return txn;
  }
);

// HP-01
scenario(
  'Timelock#cancelTransaction > cancels a queued transaction',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const target = actors.betty.address;
    const value = 0;
    const signature = '';
    const data = '0x';
    const eta = await buildEta(dm, timelock);
    const txHash = computeTxHash(target, value, signature, data, eta);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, value, signature, data, eta);

    expect(await timelock.queuedTransactions(txHash)).to.equal(true, 'tx must be queued before cancel');

    const txn = await timelock
      .connect(admin)
      .cancelTransaction(target, value, signature, data, eta)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'tx must not be queued after cancel');

    return txn;
  }
);

// HP-02
scenario(
  'Timelock#executeTransaction > executes a queued transaction after delay expires',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const target = actors.betty.address;
    const value = 0;
    const signature = '';
    const data = '0x';
    const eta = await buildEta(dm, timelock);
    const txHash = computeTxHash(target, value, signature, data, eta);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, value, signature, data, eta);

    await advanceToTimestamp(dm, eta);

    expect(await timelock.queuedTransactions(txHash)).to.equal(true, 'tx must be queued before execute');

    const txn = await timelock
      .connect(admin)
      .executeTransaction(target, value, signature, data, eta)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'tx must be removed from queue after execution');

    return txn;
  }
);

// HP-03
scenario(
  'Timelock#executeTransaction > executes transaction with empty signature (full calldata)',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async (_properties, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    // signature="" -> callData = data (data must be the full calldata including selector)
    const target = timelock.address;
    const value = 0;
    const signature = '';
    const data = utils.id('delay()').slice(0, 10); // 4-byte selector for delay()
    const eta = await buildEta(dm, timelock);
    const txHash = computeTxHash(target, value, signature, data, eta);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, value, signature, data, eta);

    await advanceToTimestamp(dm, eta);

    const txn = await timelock
      .connect(admin)
      .executeTransaction(target, value, signature, data, eta)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'tx must be removed from queue');

    return txn;
  }
);

// HP-04
scenario(
  'Timelock#executeTransaction > executes transaction with signature (selector + data)',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async (_properties, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    // signature != "" -> callData = bytes4(keccak256(signature)) ++ data
    const target = timelock.address;
    const value = 0;
    const signature = 'delay()';
    const data = '0x'; // no args for delay()
    const eta = await buildEta(dm, timelock);
    const txHash = computeTxHash(target, value, signature, data, eta);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, value, signature, data, eta);

    await advanceToTimestamp(dm, eta);

    const txn = await timelock
      .connect(admin)
      .executeTransaction(target, value, signature, data, eta)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'tx must be removed from queue');

    return txn;
  }
);

// HP-05
scenario(
  'Timelock#setDelay > changes delay via self-executed transaction',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async (_properties, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const { delay: delayBefore, minimumDelay } = await getTimelockParams(timelock);
    // pick a valid delay that differs from the current on-chain delay
    let newDelay = minimumDelay + ONE_DAY;
    if (newDelay === delayBefore) newDelay += ONE_DAY;

    const target = timelock.address;
    const value = 0;
    const signature = 'setDelay(uint256)';
    const data = utils.defaultAbiCoder.encode(['uint256'], [newDelay]);
    const eta = await buildEta(dm, timelock);
    const txHash = computeTxHash(target, value, signature, data, eta);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, value, signature, data, eta);

    await advanceToTimestamp(dm, eta);

    const txn = await timelock
      .connect(admin)
      .executeTransaction(target, value, signature, data, eta)
      .then((tx) => tx.wait());

    const delayAfter = (await timelock.delay()).toNumber();
    expect(delayAfter).to.equal(newDelay, 'delay must be updated to newDelay');
    expect(delayAfter).to.not.equal(delayBefore, 'delay must have changed');
    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'tx must be removed from queue');

    return txn;
  }
);

// HP-06
scenario(
  'Timelock#setPendingAdmin > sets pendingAdmin via self-executed transaction',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const newPendingAdmin = actors.betty.address;

    const target = timelock.address;
    const value = 0;
    const signature = 'setPendingAdmin(address)';
    const data = utils.defaultAbiCoder.encode(['address'], [newPendingAdmin]);
    const eta = await buildEta(dm, timelock);
    const txHash = computeTxHash(target, value, signature, data, eta);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, value, signature, data, eta);

    await advanceToTimestamp(dm, eta);

    const txn = await timelock
      .connect(admin)
      .executeTransaction(target, value, signature, data, eta)
      .then((tx) => tx.wait());

    expect(await timelock.pendingAdmin()).to.equal(newPendingAdmin, 'pendingAdmin must be updated');
    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'tx must be removed from queue');

    return txn;
  }
);

// HP-07
scenario(
  'Timelock#acceptAdmin > accepts admin role when called by pendingAdmin',
  { filter: async (ctx) => !isBridgedDeployment(ctx), timelockPendingAdmin: 'betty' },
  async ({ actors }, context) => {
    const timelock = await getForkedTimelock(context);
    const newAdmin = actors.betty.signer;

    expect(await timelock.pendingAdmin()).to.equal(
      newAdmin.address,
      'pendingAdmin must be set to betty before acceptAdmin'
    );

    // ── Action: betty calls acceptAdmin directly ──
    const txn = await timelock
      .connect(newAdmin)
      .acceptAdmin()
      .then((tx) => tx.wait());

    expect(await timelock.admin()).to.equal(newAdmin.address, 'admin must be updated to newAdmin');
    expect(await timelock.pendingAdmin()).to.equal(ZERO_ADDRESS, 'pendingAdmin must be reset to address(0)');

    return txn;
  }
);

// HP-08
scenario(
  'Timelock#admin transfer > completes two-step admin transfer with old admin losing rights',
  { filter: async (ctx) => !isBridgedDeployment(ctx), timelockPendingAdmin: 'betty' },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    // Step 1 (pendingAdmin = betty) is established by the timelockPendingAdmin constraint
    const oldAdmin = await impersonateTimelockAdmin(context, timelock);
    const newAdmin = actors.betty.signer;

    // ── Step 2: newAdmin calls acceptAdmin ──
    const txn = await timelock
      .connect(newAdmin)
      .acceptAdmin()
      .then((tx) => tx.wait());

    expect(await timelock.admin()).to.equal(newAdmin.address, 'admin must be updated to newAdmin');
    expect(await timelock.pendingAdmin()).to.equal(ZERO_ADDRESS, 'pendingAdmin must be address(0)');

    // ── Step 3: verify old admin lost rights ──
    const newEta = await buildEta(dm, timelock);
    await expect(
      timelock.connect(oldAdmin).queueTransaction(actors.charles.address, 0, '', '0x', newEta)
    ).to.be.revertedWith('Timelock::queueTransaction: Call must come from admin.');

    return txn;
  }
);

// HP-09
scenario(
  'Timelock#executeTransaction > executes transaction with ETH value transfer',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    // admin sends 1 ETH to the timelock plus pays gas, so fund it with 2 ETH
    const admin = await impersonateTimelockAdmin(context, timelock, 2n * 10n ** 18n);
    const recipient = actors.charles.address;

    const transferAmount = utils.parseEther('1');

    // ── Fund the Timelock with ETH (triggers fallback() payable) ──
    await admin.sendTransaction({ to: timelock.address, value: transferAmount });

    const target = recipient;
    const value = transferAmount;
    const signature = '';
    const data = '0x';
    const eta = await buildEta(dm, timelock);
    const txHash = computeTxHash(target, value, signature, data, eta);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, value, signature, data, eta);

    await advanceToTimestamp(dm, eta);

    const balanceBefore = await dm.hre.ethers.provider.getBalance(recipient);

    const txn = await timelock
      .connect(admin)
      .executeTransaction(target, value, signature, data, eta)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'tx must be removed from queue');
    expect(await dm.hre.ethers.provider.getBalance(recipient)).to.equal(
      balanceBefore.add(transferAmount),
      'recipient ETH balance must increase by transferred value'
    );

    return txn;
  }
);

// HP-10
scenario(
  'Timelock#executeTransaction > executes at boundary: block.timestamp == eta and block.timestamp == eta + GRACE_PERIOD',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const { delay, gracePeriod } = await getTimelockParams(timelock);

    const block = await dm.hre.ethers.provider.getBlock('latest');
    const eta1 = block.timestamp + delay + 2;
    const eta2 = eta1 + delay; // after advancing to eta1, this remains a valid future eta

    const target = actors.betty.address;
    // Different data -> different txHash
    const txHash1 = computeTxHash(target, 0, '', '0x', eta1);
    const txHash2 = computeTxHash(target, 0, '', '0x01', eta2);

    // ── Queue both transactions upfront ──
    await setNextBlockTimestamp(dm, block.timestamp + 1);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x', eta1);
    await setNextBlockTimestamp(dm, block.timestamp + 2);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x01', eta2);

    // ── Run 1: execute at exactly eta1 (lower boundary, >= is inclusive) ──
    await setNextBlockTimestamp(dm, eta1);

    await timelock.connect(admin).executeTransaction(target, 0, '', '0x', eta1);

    expect(await timelock.queuedTransactions(txHash1)).to.equal(false, 'tx1 must be removed at eta boundary');

    // ── Run 2: execute at exactly eta2 + GRACE_PERIOD (upper boundary, <= is inclusive) ──
    await setNextBlockTimestamp(dm, eta2 + gracePeriod);

    const txn = await timelock
      .connect(admin)
      .executeTransaction(target, 0, '', '0x01', eta2)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash2)).to.equal(false, 'tx2 must be removed at GRACE_PERIOD boundary');

    return txn;
  }
);

// HP-11
scenario(
  'Timelock#fallback > accepts ETH without calldata',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const sender = actors.albert.signer; // fallback has no access control

    const sendAmount = utils.parseEther('1');
    const balanceBefore = await dm.hre.ethers.provider.getBalance(timelock.address);

    const txn = await sender
      .sendTransaction({
        to: timelock.address,
        value: sendAmount
      })
      .then((tx) => tx.wait());

    expect(await dm.hre.ethers.provider.getBalance(timelock.address)).to.equal(
      balanceBefore.add(sendAmount),
      'Timelock ETH balance must increase by amount sent'
    );

    return txn;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Unhappy Path
// ─────────────────────────────────────────────────────────────────────────────

//UH-00
scenario(
  'Timelock#queueTransaction > reverts when caller is not admin',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const nonAdmin = actors.charles.signer;

    const eta = await buildEta(dm, timelock);

    await expect(
      timelock.connect(nonAdmin).queueTransaction(actors.betty.address, 0, '', '0x', eta)
    ).to.be.revertedWith('Timelock::queueTransaction: Call must come from admin.');
  }
);

//UH-01
scenario(
  'Timelock#queueTransaction > reverts when eta < block.timestamp + delay',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const { delay } = await getTimelockParams(timelock);

    const block = await dm.hre.ethers.provider.getBlock('latest');
    const badEta = block.timestamp + delay - 1; // one second short of required delay

    await expect(
      timelock.connect(admin).queueTransaction(actors.betty.address, 0, '', '0x', badEta)
    ).to.be.revertedWith('Timelock::queueTransaction: Estimated execution block must satisfy delay.');
  }
);

//UH-02
scenario(
  'Timelock#cancelTransaction > reverts when caller is not admin',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const nonAdmin = actors.charles.signer;

    const target = actors.betty.address;
    const eta = await buildEta(dm, timelock);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x', eta);

    await expect(timelock.connect(nonAdmin).cancelTransaction(target, 0, '', '0x', eta)).to.be.revertedWith(
      'Timelock::cancelTransaction: Call must come from admin.'
    );
  }
);

//UH-03
scenario(
  'Timelock#executeTransaction > reverts when caller is not admin',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const nonAdmin = actors.charles.signer;

    const target = actors.betty.address;
    const eta = await buildEta(dm, timelock);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x', eta);
    await advanceToTimestamp(dm, eta);

    await expect(timelock.connect(nonAdmin).executeTransaction(target, 0, '', '0x', eta)).to.be.revertedWith(
      'Timelock::executeTransaction: Call must come from admin.'
    );
  }
);

//UH-04
scenario(
  'Timelock#executeTransaction > reverts when transaction was never queued',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const target = actors.betty.address;
    const eta = await buildEta(dm, timelock);
    await advanceToTimestamp(dm, eta);

    // do NOT call queueTransaction before executing
    await expect(timelock.connect(admin).executeTransaction(target, 0, '', '0x', eta)).to.be.revertedWith(
      "Timelock::executeTransaction: Transaction hasn't been queued."
    );
  }
);

//UH-05
scenario(
  'Timelock#executeTransaction > reverts when block.timestamp < eta',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const target = actors.betty.address;
    const eta = await buildEta(dm, timelock);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x', eta);

    // do NOT advance time — block.timestamp < eta
    await expect(timelock.connect(admin).executeTransaction(target, 0, '', '0x', eta)).to.be.revertedWith(
      "Timelock::executeTransaction: Transaction hasn't surpassed time lock."
    );
  }
);

//UH-06
scenario(
  'Timelock#executeTransaction > reverts when transaction is stale (after grace period)',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const { gracePeriod } = await getTimelockParams(timelock);

    const target = actors.betty.address;
    const eta = await buildEta(dm, timelock);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x', eta);

    // advance past eta + GRACE_PERIOD
    await setNextBlockTimestamp(dm, eta + gracePeriod + 1);
    await mineBlocks(dm, 1);

    await expect(timelock.connect(admin).executeTransaction(target, 0, '', '0x', eta)).to.be.revertedWith(
      'Timelock::executeTransaction: Transaction is stale.'
    );
  }
);

//UH-07
scenario(
  'Timelock#executeTransaction > reverts when target call reverts',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async (_properties, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    // Queue a self-call to acceptAdmin(); pendingAdmin is never the timelock itself so
    // msg.sender (timelock) != pendingAdmin — the inner call reverts.
    const target = timelock.address;
    const signature = '';
    const data = utils.id('acceptAdmin()').slice(0, 10); // full calldata = acceptAdmin() selector
    const eta = await buildEta(dm, timelock);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, signature, data, eta);
    await advanceToTimestamp(dm, eta);

    // inner acceptAdmin reverts -> outer wraps as "Transaction execution reverted."
    await expect(timelock.connect(admin).executeTransaction(target, 0, signature, data, eta)).to.be.revertedWith(
      'Timelock::executeTransaction: Transaction execution reverted.'
    );
  }
);

//UH-08
scenario(
  'Timelock#executeTransaction > reverts on re-execution of already-executed transaction',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const target = actors.betty.address;
    const eta = await buildEta(dm, timelock);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x', eta);
    await advanceToTimestamp(dm, eta);

    // first execution succeeds
    await timelock.connect(admin).executeTransaction(target, 0, '', '0x', eta);

    // second execution must revert: queuedTransactions[txHash] == false
    await expect(timelock.connect(admin).executeTransaction(target, 0, '', '0x', eta)).to.be.revertedWith(
      "Timelock::executeTransaction: Transaction hasn't been queued."
    );
  }
);

//UH-09
scenario(
  'Timelock#setDelay > reverts when called directly (not via self-call)',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async (_properties, context) => {
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const { minimumDelay } = await getTimelockParams(timelock);

    const delayBefore = await timelock.delay();

    await expect(timelock.connect(admin).setDelay(minimumDelay + 1)).to.be.revertedWith(
      'Timelock::setDelay: Call must come from Timelock.'
    );

    expect(await timelock.delay()).to.equal(delayBefore, 'delay must not change on failed direct call');
  }
);

//UH-10
scenario(
  'Timelock#setDelay > reverts when delay < MINIMUM_DELAY (via self-call)',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async (_properties, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const { minimumDelay } = await getTimelockParams(timelock);

    const tooSmallDelay = minimumDelay - 1;
    const delayBefore = await timelock.delay();

    const target = timelock.address;
    const signature = 'setDelay(uint256)';
    const data = utils.defaultAbiCoder.encode(['uint256'], [tooSmallDelay]);
    const eta = await buildEta(dm, timelock);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, signature, data, eta);
    await advanceToTimestamp(dm, eta);

    // inner setDelay guard fails; outer executeTransaction wraps as "Transaction execution reverted."
    await expect(timelock.connect(admin).executeTransaction(target, 0, signature, data, eta)).to.be.revertedWith(
      'Timelock::executeTransaction: Transaction execution reverted.'
    );

    expect(await timelock.delay()).to.equal(delayBefore, 'delay must remain unchanged');
  }
);

//UH-11
scenario(
  'Timelock#setDelay > reverts when delay > MAXIMUM_DELAY (via self-call)',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async (_properties, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const { maximumDelay } = await getTimelockParams(timelock);

    const tooLargeDelay = maximumDelay + 1;
    const delayBefore = await timelock.delay();

    const target = timelock.address;
    const signature = 'setDelay(uint256)';
    const data = utils.defaultAbiCoder.encode(['uint256'], [tooLargeDelay]);
    const eta = await buildEta(dm, timelock);

    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, signature, data, eta);
    await advanceToTimestamp(dm, eta);

    await expect(timelock.connect(admin).executeTransaction(target, 0, signature, data, eta)).to.be.revertedWith(
      'Timelock::executeTransaction: Transaction execution reverted.'
    );

    expect(await timelock.delay()).to.equal(delayBefore, 'delay must remain unchanged');
  }
);

//UH-12
scenario(
  'Timelock#setPendingAdmin > reverts when called directly (not via self-call)',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const pendingAdminBefore = await timelock.pendingAdmin();

    await expect(timelock.connect(admin).setPendingAdmin(actors.betty.address)).to.be.revertedWith(
      'Timelock::setPendingAdmin: Call must come from Timelock.'
    );

    expect(await timelock.pendingAdmin()).to.equal(pendingAdminBefore, 'pendingAdmin must not change');
  }
);

//UH-13
scenario(
  'Timelock#acceptAdmin > reverts when caller is not pendingAdmin',
  { filter: async (ctx) => !isBridgedDeployment(ctx), timelockPendingAdmin: 'betty' },
  async ({ actors }, context) => {
    const timelock = await getForkedTimelock(context);
    const newAdmin = actors.betty.signer;
    const notPendingAdmin = actors.charles.signer;

    expect(await timelock.pendingAdmin()).to.equal(newAdmin.address, 'pendingAdmin must be betty');

    // charles (not pendingAdmin) calls acceptAdmin
    await expect(timelock.connect(notPendingAdmin).acceptAdmin()).to.be.revertedWith(
      'Timelock::acceptAdmin: Call must come from pendingAdmin.'
    );
  }
);

//UH-16
scenario(
  'Timelock#acceptAdmin > reverts when pendingAdmin is address(0)',
  { filter: async (ctx) => !isBridgedDeployment(ctx), timelockPendingAdmin: ZERO_ADDRESS },
  async ({ actors }, context) => {
    const timelock = await getForkedTimelock(context);

    expect(await timelock.pendingAdmin()).to.equal(ZERO_ADDRESS, 'pendingAdmin must be address(0)');

    await expect(timelock.connect(actors.charles.signer).acceptAdmin()).to.be.revertedWith(
      'Timelock::acceptAdmin: Call must come from pendingAdmin.'
    );
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

// EC-00
scenario(
  'Timelock#queueTransaction > re-queueing identical transaction overwrites same slot (idempotent)',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);

    const target = actors.betty.address;
    // extra slack so the identical eta still satisfies the delay check on the second queue
    const eta = (await buildEta(dm, timelock)) + 5;
    const txHash = computeTxHash(target, 0, '', '0x', eta);

    // ── First queue ──
    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x', eta);

    expect(await timelock.queuedTransactions(txHash)).to.equal(true, 'tx must be queued after first call');

    // ── Second queue with identical params -> same txHash, idempotent ──
    await setNextBlockTimestamp(dm, (await getLatestBlockTimestamp(dm)) + 1);
    const txn = await timelock
      .connect(admin)
      .queueTransaction(target, 0, '', '0x', eta)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash)).to.equal(true, 'tx must still be queued after duplicate queue');

    // ── Cancelling once removes the entry for both ──
    await timelock.connect(admin).cancelTransaction(target, 0, '', '0x', eta);

    expect(await timelock.queuedTransactions(txHash)).to.equal(false, 'single cancel removes the entry');

    return txn;
  }
);

// EC-01
scenario(
  'Timelock#executeTransaction > boundary: succeeds at eta + GRACE_PERIOD, reverts at eta + GRACE_PERIOD + 1',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async ({ actors }, context) => {
    const dm = context.world.deploymentManager;
    const timelock = await getForkedTimelock(context);
    const admin = await impersonateTimelockAdmin(context, timelock);
    const { delay, gracePeriod } = await getTimelockParams(timelock);

    const block = await dm.hre.ethers.provider.getBlock('latest');
    const eta_a = block.timestamp + delay + 2;
    const eta_b = eta_a + 2; // different eta -> different txHash

    const target = actors.betty.address;
    const txHash_a = computeTxHash(target, 0, '', '0x', eta_a);
    const txHash_b = computeTxHash(target, 0, '', '0x01', eta_b);

    // ── Queue both transactions upfront ──
    await setNextBlockTimestamp(dm, block.timestamp + 1);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x', eta_a);
    await setNextBlockTimestamp(dm, block.timestamp + 2);
    await timelock.connect(admin).queueTransaction(target, 0, '', '0x01', eta_b);

    // ── Run 1: execute tx_a exactly at eta_a + GRACE_PERIOD (inclusive upper bound -> succeeds) ──
    await setNextBlockTimestamp(dm, eta_a + gracePeriod);

    const txn = await timelock
      .connect(admin)
      .executeTransaction(target, 0, '', '0x', eta_a)
      .then((tx) => tx.wait());

    expect(await timelock.queuedTransactions(txHash_a)).to.equal(
      false,
      'tx_a must be removed from queue at eta + GRACE_PERIOD boundary'
    );

    // ── Run 2: attempt tx_b at eta_b + GRACE_PERIOD + 1 (past upper bound -> reverts) ──
    // eta_b = eta_a + 2, so eta_b + GRACE_PERIOD + 1 = eta_a + GRACE_PERIOD + 3
    await setNextBlockTimestamp(dm, eta_b + gracePeriod + 1);

    await expect(
      timelock.connect(admin).executeTransaction(target, 0, '', '0x01', eta_b, { gasLimit: 500000 })
    ).to.be.revertedWith('Timelock::executeTransaction: Transaction is stale.');

    expect(await timelock.queuedTransactions(txHash_b)).to.equal(
      true,
      'tx_b must remain queued (rejected execution leaves queue unchanged)'
    );

    return txn;
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getForkedTimelock(context: CometContext): Promise<Timelock> {
  const dm = context.world.deploymentManager;
  const timelockAddress = (await context.getTimelock()).address;
  return Timelock__factory.connect(timelockAddress, dm.hre.ethers.provider);
}

async function impersonateTimelockAdmin(
  context: CometContext,
  timelock: Timelock,
  value: bigint = 10n ** 18n
): Promise<SignerWithAddress> {
  return context.world.impersonateAddress(await timelock.admin(), { value, onGovNetwork: true });
}

async function getTimelockParams(
  timelock: Timelock
): Promise<{ delay: number, gracePeriod: number, minimumDelay: number, maximumDelay: number }> {
  return {
    delay: (await timelock.delay()).toNumber(),
    gracePeriod: (await timelock.GRACE_PERIOD()).toNumber(),
    minimumDelay: (await timelock.MINIMUM_DELAY()).toNumber(),
    maximumDelay: (await timelock.MAXIMUM_DELAY()).toNumber()
  };
}

async function buildEta(dm: DeploymentManager, timelock: Timelock): Promise<number> {
  const timestamp = await getLatestBlockTimestamp(dm);
  const delay = await timelock.delay();
  return timestamp + delay.toNumber() + 1;
}

function computeTxHash(
  target: string,
  value: BigNumberish,
  signature: string,
  data: string,
  eta: BigNumberish
): string {
  return utils.keccak256(
    utils.defaultAbiCoder.encode(
      ['address', 'uint256', 'string', 'bytes', 'uint256'],
      [target, value, signature, data, eta]
    )
  );
}
