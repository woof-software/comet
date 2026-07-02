import { scenario, CometContext } from './context/CometContext';
import { expect } from 'chai';
import { BigNumberish, constants, utils } from 'ethers';
import { exp } from '../test/helpers';
import {
  advanceToTimestamp,
  getLatestBlockTimestamp,
  isBridgedDeployment,
  mineBlocks,
  setNextBlockTimestamp,
  setEtherBalance
} from './utils';
import {
  buildSupplyCapProposalActions,
  createProposal,
  reachQuorum,
  advancePastDeadline,
  succeedProposal,
  queueProposalById,
  executeProposalById
} from './utils/governanceHelpers';
import { CompoundGovernor__factory, CompoundGovernor, Comp__factory } from '../build/types';

// ─────────────────────────────────────────────────────────────────────────────
// Happy Path
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Proposal creation
// ─────────────────────────────────────────────────────────────────────────────

// HP-00
scenario(
  'CompoundGovernor#propose > creation succeeds for proposer with sufficient votes',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ comet, configurator }, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // A signer that holds (or is delegated) enough COMP to clear proposalThreshold.
    // getProposer() is the framework helper that resolves such an account.
    const proposer = await context.getProposer();
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const blockNumber = await dm.hre.ethers.provider.getBlock('latest').then((b) => b.number - 1);
    expect(await comp.getPriorVotes(proposer.address, blockNumber)).to.be.gte(
      await governor.proposalThreshold(),
      'proposer does not have enough votes to propose'
    );

    expect(await governor.isWhitelisted(proposer.address)).to.equal(
      false,
      `proposer ${proposer.address} is whitelisted to propose`
    );

    // getNextProposalId() = the id the NEXT proposal will get (Seq: raw _nextProposalId).
    const nextIdBefore = (await governor.getNextProposalId()).toBigInt();

    // ── Build a representative proposal: update supply cap of an existing asset ──
    const { asset: assetAddress } = await comet.getAssetInfo(0);
    const currentCap = (await comet.getAssetInfo(0)).supplyCap.toBigInt();
    const newSupplyCap = currentCap + 1n; // minimal, harmless change to an existing asset

    const updateCapCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint128'],
      [comet.address, assetAddress, newSupplyCap]
    );

    const targets = [configurator.address];
    const values = [0];
    const calldatas = [
      // function selector + encoded args for updateAssetSupplyCap(address,address,uint128)
      utils.id('updateAssetSupplyCap(address,address,uint128)').slice(0, 10) + updateCapCalldata.slice(2)
    ];
    const description = 'HP-00: update supply cap of asset 0 (creation-only test)';
    const descriptionHash = utils.keccak256(utils.toUtf8Bytes(description));

    const proposalCountBefore = await governor.proposalCount();

    // ── Snapshot storage before creation ───────────────────────────────────────
    // NOTE: latestProposalIds is a public mapping on CompoundGovernor. If the
    // typechain wrapper exposes it, read via governor.latestProposalIds(addr).
    const latestBefore = (await governor.latestProposalIds(proposer.address)).toBigInt();

    // ── Create the proposal ─────────────────────────────────────────────────────
    // CompoundGovernor (OZ-based) signature: propose(targets, values, calldatas, description)
    // — NOTE: this differs from GovernorBravo's propose(...signatures...). If the
    // framework's governor type is still IGovernorBravo, cast to the CompoundGovernor
    // typechain type here.
    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    const txn = await governor
      .connect(proposer)
      .propose(targets, values, calldatas, description)
      .then((tx) => tx.wait());

    // ── Extract the new proposalId ──────────────────────────────────────────────
    // Prefer reading it from storage (deterministic) over parsing events.
    const latestAfter = (await governor.latestProposalIds(proposer.address)).toBigInt();
    const proposalId = latestAfter;
    const proposalCountAfter = await governor.proposalCount();

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. A new proposal id was produced and recorded for this proposer.
    expect(latestAfter).to.not.equal(latestBefore, 'latestProposalIds[proposer] was not updated after propose()');
    // 2. proposalCount increments by 1
    expect(proposalCountAfter).to.equal(proposalCountBefore.add(1), 'proposalCount did not increment after propose()');

    // 3. The proposal is registered and resolvable. Reading state() of a
    //    non-existent proposal reverts GovernorNonexistentProposal; the fact
    //    that this call returns at all proves the proposal was created.
    //    Immediately after creation (before votingDelay elapses) it must be Pending (=0).
    const state = await governor.state(proposalId);
    expect(state).to.equal(0, 'freshly created proposal should be in Pending state');

    // 4. The proposer is recorded as the proposal's proposer.
    expect((await governor.proposalProposer(proposalId)).toLowerCase()).to.equal(
      proposer.address.toLowerCase(),
      'proposalProposer does not match the creating account'
    );

    // 5. Sanity: nothing was executed — the asset config is unchanged at this stage.
    expect((await comet.getAssetInfo(0)).supplyCap.toBigInt()).to.equal(
      currentCap,
      'supply cap must NOT change on creation (only on execute)'
    );

    // 6. The proposal details are recorded correctly.
    expect(await governor.proposalDetails(proposalId)).to.deep.equal([targets, values, calldatas, descriptionHash]);

    // 7. The proposal snapshot and deadline are recorded correctly.
    expect(await governor.proposalSnapshot(proposalId)).to.equal(
      BigInt(txn.blockNumber) + (await governor.votingDelay()).toBigInt(),
      'proposalSnapshot does not match expected block number'
    );

    // 8. The proposal deadline is snapshot + votingPeriod.
    expect(await governor.proposalDeadline(proposalId)).to.equal(
      (await governor.proposalSnapshot(proposalId)).toBigInt() + (await governor.votingPeriod()).toBigInt(),
      'proposalDeadline does not match expected block number'
    );

    // 9. The proposal hash is recorded correctly.
    expect(await governor.callStatic.hashProposal(targets, values, calldatas, descriptionHash)).to.equal(
      proposalId,
      'hashProposal does not match the proposalId returned by propose()'
    );

    // getNextProposalId() grew by exactly 1 (differs from proposalCount() by one).
    const nextIdAfter = (await governor.getNextProposalId()).toBigInt();
    expect(nextIdAfter).to.equal(
      nextIdBefore + 1n,
      'getNextProposalId() did not increment by exactly 1 after propose()'
    );

    // A freshly created (unqueued) proposal has no queue eta.
    expect(await governor.proposalEta(proposalId)).to.equal(
      0,
      'proposalEta should be 0 for a freshly created (unqueued) proposal'
    );

    return txn; // return txn to measure gas
  }
);

// HP-01
scenario(
  'CompoundGovernor#propose > creation succeeds for whitelisted proposer without sufficient votes',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ comet, configurator }, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // A signer that holds (or is delegated) enough COMP to clear proposalThreshold.
    // getProposer() is the framework helper that resolves such an account.
    const activeWhitelistedAccount = await findActiveWhitelistedAccountReverse(governor, context);
    const proposer = await context.world.impersonateAddress(activeWhitelistedAccount!, {
      value: 10n ** 18n,
      onGovNetwork: true
    });

    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const blockNumber = await dm.hre.ethers.provider.getBlock('latest').then((b) => b.number - 1);
    expect(await comp.getPriorVotes(proposer.address, blockNumber)).to.be.lt(
      await governor.proposalThreshold(),
      'proposer has enough votes to propose'
    );

    expect(await governor.isWhitelisted(proposer.address)).to.equal(
      true,
      `proposer ${proposer.address} is not whitelisted to propose`
    );

    // Whitelist expiration is a future timestamp (isWhitelisted == expiration > block.timestamp).
    expect((await governor.whitelistAccountExpirations(proposer.address)).toBigInt()).to.be.gt(
      BigInt(await getLatestBlockTimestamp(dm)),
      'whitelistAccountExpirations(proposer) should be a future timestamp'
    );

    const nextIdBefore = (await governor.getNextProposalId()).toBigInt();

    // ── Build a representative proposal: update supply cap of an existing asset ──
    const { asset: assetAddress } = await comet.getAssetInfo(0);
    const currentCap = (await comet.getAssetInfo(0)).supplyCap.toBigInt();
    const newSupplyCap = currentCap + 1n; // minimal, harmless change to an existing asset

    const updateCapCalldata = utils.defaultAbiCoder.encode(
      ['address', 'address', 'uint128'],
      [comet.address, assetAddress, newSupplyCap]
    );

    const targets = [configurator.address];
    const values = [0];
    const calldatas = [
      // function selector + encoded args for updateAssetSupplyCap(address,address,uint128)
      utils.id('updateAssetSupplyCap(address,address,uint128)').slice(0, 10) + updateCapCalldata.slice(2)
    ];
    const description = 'HP-00: update supply cap of asset 0 (creation-only test)';
    const descriptionHash = utils.keccak256(utils.toUtf8Bytes(description));

    const proposalCountBefore = await governor.proposalCount();

    // ── Snapshot storage before creation ───────────────────────────────────────
    // NOTE: latestProposalIds is a public mapping on CompoundGovernor. If the
    // typechain wrapper exposes it, read via governor.latestProposalIds(addr).
    const latestBefore = (await governor.latestProposalIds(proposer.address)).toBigInt();

    // ── Create the proposal ─────────────────────────────────────────────────────
    // CompoundGovernor (OZ-based) signature: propose(targets, values, calldatas, description)
    // — NOTE: this differs from GovernorBravo's propose(...signatures...). If the
    // framework's governor type is still IGovernorBravo, cast to the CompoundGovernor
    // typechain type here.
    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    const txn = await governor
      .connect(proposer)
      .propose(targets, values, calldatas, description)
      .then((tx) => tx.wait());

    // ── Extract the new proposalId ──────────────────────────────────────────────
    // Prefer reading it from storage (deterministic) over parsing events.
    const latestAfter = (await governor.latestProposalIds(proposer.address)).toBigInt();
    const proposalId = latestAfter;
    const proposalCountAfter = await governor.proposalCount();

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. A new proposal id was produced and recorded for this proposer.
    expect(latestAfter).to.not.equal(latestBefore, 'latestProposalIds[proposer] was not updated after propose()');
    // 2. proposalCount increments by 1
    expect(proposalCountAfter).to.equal(proposalCountBefore.add(1), 'proposalCount did not increment after propose()');

    // 3. The proposal is registered and resolvable. Reading state() of a
    //    non-existent proposal reverts GovernorNonexistentProposal; the fact
    //    that this call returns at all proves the proposal was created.
    //    Immediately after creation (before votingDelay elapses) it must be Pending (=0).
    const state = await governor.state(proposalId);
    expect(state).to.equal(0, 'freshly created proposal should be in Pending state');

    // 4. The proposer is recorded as the proposal's proposer.
    expect((await governor.proposalProposer(proposalId)).toLowerCase()).to.equal(
      proposer.address.toLowerCase(),
      'proposalProposer does not match the creating account'
    );

    // 5. Sanity: nothing was executed — the asset config is unchanged at this stage.
    expect((await comet.getAssetInfo(0)).supplyCap.toBigInt()).to.equal(
      currentCap,
      'supply cap must NOT change on creation (only on execute)'
    );

    // 6. The proposal details are recorded correctly.
    expect(await governor.proposalDetails(proposalId)).to.deep.equal([targets, values, calldatas, descriptionHash]);

    // 7. The proposal snapshot and deadline are recorded correctly.
    expect(await governor.proposalSnapshot(proposalId)).to.equal(
      BigInt(txn.blockNumber) + (await governor.votingDelay()).toBigInt(),
      'proposalSnapshot does not match expected block number'
    );

    // 8. The proposal deadline is snapshot + votingPeriod.
    expect(await governor.proposalDeadline(proposalId)).to.equal(
      (await governor.proposalSnapshot(proposalId)).toBigInt() + (await governor.votingPeriod()).toBigInt(),
      'proposalDeadline does not match expected block number'
    );

    // 9. The proposal hash is recorded correctly.
    expect(await governor.callStatic.hashProposal(targets, values, calldatas, descriptionHash)).to.equal(
      proposalId,
      'hashProposal does not match the proposalId returned by propose()'
    );

    // getNextProposalId() grew by exactly 1 after creation.
    const nextIdAfter = (await governor.getNextProposalId()).toBigInt();
    expect(nextIdAfter).to.equal(nextIdBefore + 1n, 'getNextProposalId() should be before + 1 after propose()');

    return txn; // return txn to measure gas
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Proposal cancellation
// ─────────────────────────────────────────────────────────────────────────────

// HP-02
scenario(
  'CompoundGovernor#cancel > proposal cancellation succeeds by the proposer',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // A signer that holds (or is delegated) enough COMP to clear proposalThreshold.
    // getProposer() is the framework helper that resolves such an account.
    const proposer = await context.getProposer();

    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const blockNumber = await dm.hre.ethers.provider.getBlock('latest').then((b) => b.number - 1);
    expect(await comp.getPriorVotes(proposer.address, blockNumber)).to.be.gte(
      await governor.proposalThreshold(),
      'proposer does not have enough votes to propose'
    );

    expect(await governor.isWhitelisted(proposer.address)).to.equal(
      false,
      `proposer ${proposer.address} is whitelisted to propose`
    );

    // ── Build a representative proposal: update supply cap of an existing asset ──
    const proposal = await createProposal(context, {
      proposer
    });

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. The proposal is registered and resolvable. Reading state() of a
    //    non-existent proposal reverts GovernorNonexistentProposal; the fact
    //    that this call returns at all proves the proposal was created.
    //    Immediately after creation (before votingDelay elapses) it must be Pending (=0).
    expect(await governor.state(proposal.proposalId)).to.equal(
      0,
      'freshly created proposal should be in Pending state'
    );

    // 2. The proposer is recorded as the proposal's proposer.
    expect((await governor.proposalProposer(proposal.proposalId)).toLowerCase()).to.equal(
      proposer.address.toLowerCase(),
      'proposalProposer does not match the creating account'
    );

    // ── Cancel the proposal ─────────────────────────────────────────────────────
    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    const txn = await governor
      .connect(proposer)
      ['cancel(uint256)'](proposal.proposalId)
      .then((tx) => tx.wait());

    // 3. The proposal is now in the Canceled state.
    expect(await governor.state(proposal.proposalId)).to.equal(
      2,
      'proposal should be in Canceled state after cancel()'
    );

    // 4. The proposal's eta is cleared (0) after cancellation.
    expect(await governor.proposalEta(proposal.proposalId)).to.equal(0, 'proposalEta should be 0 after cancel()');

    return txn; // return txn to measure gas
  }
);

// HP-03
scenario(
  'CompoundGovernor#cancel > proposal cancellation succeeds by the proposal guardian',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // A signer that holds (or is delegated) enough COMP to clear proposalThreshold.
    // getProposer() is the framework helper that resolves such an account.
    const proposer = await context.getProposer();

    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const blockNumber = await dm.hre.ethers.provider.getBlock('latest').then((b) => b.number - 1);
    expect(await comp.getPriorVotes(proposer.address, blockNumber)).to.be.gte(
      await governor.proposalThreshold(),
      'proposer does not have enough votes to propose'
    );

    expect(await governor.isWhitelisted(proposer.address)).to.equal(
      false,
      `proposer ${proposer.address} is whitelisted to propose`
    );

    // ── Build a representative proposal: update supply cap of an existing asset ──
    const proposal = await createProposal(context, {
      proposer
    });

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. The proposal is registered and resolvable. Reading state() of a
    //    non-existent proposal reverts GovernorNonexistentProposal; the fact
    //    that this call returns at all proves the proposal was created.
    //    Immediately after creation (before votingDelay elapses) it must be Pending (=0).
    expect(await governor.state(proposal.proposalId)).to.equal(
      0,
      'freshly created proposal should be in Pending state'
    );

    // 2. The proposer is recorded as the proposal's proposer.
    expect((await governor.proposalProposer(proposal.proposalId)).toLowerCase()).to.equal(
      proposer.address.toLowerCase(),
      'proposalProposer does not match the creating account'
    );

    const proposalGuardian = await context.world.impersonateAddress((await governor.proposalGuardian()).account, {
      value: 10n ** 18n,
      onGovNetwork: true
    });

    // ── Cancel the proposal ─────────────────────────────────────────────────────
    const txn = await governor
      .connect(proposalGuardian)
      ['cancel(uint256)'](proposal.proposalId)
      .then((tx) => tx.wait());

    // 3. The proposal is now in the Canceled state.
    expect(await governor.state(proposal.proposalId)).to.equal(
      2,
      'proposal should be in Canceled state after cancel()'
    );

    // 4. The proposal's eta is cleared (0) after cancellation.
    expect(await governor.proposalEta(proposal.proposalId)).to.equal(0, 'proposalEta should be 0 after cancel()');

    return txn; // return txn to measure gas
  }
);

// HP-04
scenario(
  'CompoundGovernor#cancel > proposal cancellation succeeds by the third-party when proposer was lost of voting power',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // A signer that holds (or is delegated) enough COMP to clear proposalThreshold.
    // getProposer() is the framework helper that resolves such an account.
    const proposer = await context.getProposer(5);

    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    let blockNumber = await dm.hre.ethers.provider.getBlock('latest').then((b) => b.number - 1);
    expect(await comp.getPriorVotes(proposer.address, blockNumber)).to.be.gte(
      await governor.proposalThreshold(),
      'proposer does not have enough votes to propose'
    );

    expect(await governor.isWhitelisted(proposer.address)).to.equal(
      false,
      `proposer ${proposer.address} is whitelisted to propose`
    );

    // ── Build a representative proposal: update supply cap of an existing asset ──
    const proposal = await createProposal(context, {
      proposer
    });

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. The proposal is registered and resolvable. Reading state() of a
    //    non-existent proposal reverts GovernorNonexistentProposal; the fact
    //    that this call returns at all proves the proposal was created.
    //    Immediately after creation (before votingDelay elapses) it must be Pending (=0).
    expect(await governor.state(proposal.proposalId)).to.equal(
      0,
      'freshly created proposal should be in Pending state'
    );

    // 2. The proposer is recorded as the proposal's proposer.
    expect((await governor.proposalProposer(proposal.proposalId)).toLowerCase()).to.equal(
      proposer.address.toLowerCase(),
      'proposalProposer does not match the creating account'
    );

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await comp
      .connect(proposer)
      .delegate(betty.address)
      .then((tx) => tx.wait())
      .then((receipt) => receipt.blockNumber);

    await mineBlocks(dm, 2); // wait for the delegation to be mined
    blockNumber = await dm.hre.ethers.provider.getBlock('latest').then((b) => b.number - 1);
    expect(await comp.getPriorVotes(proposer.address, blockNumber)).to.be.lt(
      await governor.proposalThreshold(),
      'proposer have enough voting power'
    );

    expect(await comp.getPriorVotes(albert.address, blockNumber)).to.be.lt(
      await governor.proposalThreshold(),
      'third-party have enough voting power to cancel the proposal'
    );

    // ── Cancel the proposal ─────────────────────────────────────────────────────
    const txn = await governor
      .connect(albert.signer)
      ['cancel(uint256)'](proposal.proposalId)
      .then((tx) => tx.wait());

    // 3. The proposal is now in the Canceled state.
    expect(await governor.state(proposal.proposalId)).to.equal(
      2,
      'proposal should be in Canceled state after cancel()'
    );

    // 4. The proposal's eta is cleared (0) after cancellation.
    expect(await governor.proposalEta(proposal.proposalId)).to.equal(0, 'proposalEta should be 0 after cancel()');

    return txn; // return txn to measure gas
  }
);

// HP-05
scenario(
  'CompoundGovernor#cancel > proposal cancellation succeeds by the whitelist guardian when whitelisted proposer is proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // A signer that holds (or is delegated) enough COMP to clear proposalThreshold.
    const activeWhitelistedAccount = await findActiveWhitelistedAccountReverse(governor, context);
    const proposer = await context.world.impersonateAddress(activeWhitelistedAccount!, {
      value: 10n ** 18n,
      onGovNetwork: true
    });

    expect(await governor.isWhitelisted(proposer.address)).to.equal(
      true,
      `proposer ${proposer.address} is not whitelisted to propose`
    );

    // ── Build a representative proposal: update supply cap of an existing asset ──
    const proposal = await createProposal(context, {
      proposer
    });

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. The proposal is registered and resolvable. Reading state() of a
    //    non-existent proposal reverts GovernorNonexistentProposal; the fact
    //    that this call returns at all proves the proposal was created.
    //    Immediately after creation (before votingDelay elapses) it must be Pending (=0).
    expect(await governor.state(proposal.proposalId)).to.equal(
      0,
      'freshly created proposal should be in Pending state'
    );

    // 2. The proposer is recorded as the proposal's proposer.
    expect((await governor.proposalProposer(proposal.proposalId)).toLowerCase()).to.equal(
      proposer.address.toLowerCase(),
      'proposalProposer does not match the creating account'
    );

    const whitelistGuardian = await context.world.impersonateAddress(await governor.whitelistGuardian(), {
      value: 10n ** 18n,
      onGovNetwork: true
    });

    // ── Cancel the proposal ─────────────────────────────────────────────────────
    const txn = await governor
      .connect(whitelistGuardian)
      ['cancel(uint256)'](proposal.proposalId)
      .then((tx) => tx.wait());

    // 3. The proposal is now in the Canceled state.
    expect(await governor.state(proposal.proposalId)).to.equal(
      2,
      'proposal should be in Canceled state after cancel()'
    );

    // 4. The proposal's eta is cleared (0) after cancellation.
    expect(await governor.proposalEta(proposal.proposalId)).to.equal(0, 'proposalEta should be 0 after cancel()');

    // 5. The proposer remains whitelisted after cancellation (cancel does not clear whitelist).
    expect(await governor.isWhitelisted(proposer.address)).to.equal(
      true,
      'proposer should remain whitelisted after cancel()'
    );

    return txn; // return txn to measure gas
  }
);

// HP-06
scenario(
  'CompoundGovernor#cancel > proposal cancellation succeeds via the full list of parameters',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // A signer that holds (or is delegated) enough COMP to clear proposalThreshold.
    // getProposer() is the framework helper that resolves such an account.
    const proposer = await context.getProposer();

    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const blockNumber = await dm.hre.ethers.provider.getBlock('latest').then((b) => b.number - 1);
    expect(await comp.getPriorVotes(proposer.address, blockNumber)).to.be.gte(
      await governor.proposalThreshold(),
      'proposer does not have enough votes to propose'
    );

    expect(await governor.isWhitelisted(proposer.address)).to.equal(
      false,
      `proposer ${proposer.address} is whitelisted to propose`
    );

    // ── Build a representative proposal: update supply cap of an existing asset ──
    const proposal = await createProposal(context, {
      proposer
    });

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. The proposal is registered and resolvable. Reading state() of a
    //    non-existent proposal reverts GovernorNonexistentProposal; the fact
    //    that this call returns at all proves the proposal was created.
    //    Immediately after creation (before votingDelay elapses) it must be Pending (=0).
    expect(await governor.state(proposal.proposalId)).to.equal(
      0,
      'freshly created proposal should be in Pending state'
    );

    // 2. The proposer is recorded as the proposal's proposer.
    expect((await governor.proposalProposer(proposal.proposalId)).toLowerCase()).to.equal(
      proposer.address.toLowerCase(),
      'proposalProposer does not match the creating account'
    );

    // ── Cancel the proposal ─────────────────────────────────────────────────────
    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    const txn = await governor
      .connect(proposer)
      ['cancel(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        utils.keccak256(utils.toUtf8Bytes(proposal.description))
      )
      .then((tx) => tx.wait());

    // 3. The proposal is now in the Canceled state.
    expect(await governor.state(proposal.proposalId)).to.equal(
      2,
      'proposal should be in Canceled state after cancel()'
    );

    // 4. The proposal's eta is cleared (0) after cancellation.
    expect(await governor.proposalEta(proposal.proposalId)).to.equal(0, 'proposalEta should be 0 after cancel()');

    return txn; // return txn to measure gas
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Voting (HP-07..HP-09)
// ─────────────────────────────────────────────────────────────────────────────

//HP-07
scenario(
  'CompoundGovernor#castVote > full voting for succeeds',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber)).toBigInt();

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. The proposal is registered and resolvable. Reading state() of a
    const forVotesBefore = (await governor.proposalVotes(proposal.proposalId)).forVotes.toBigInt();
    expect(forVotesBefore).to.equal(0n, 'forVotes should be 0 before any votes are cast');

    // ── Vote on the proposal ─────────────────────────────────────────────────────
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVote(proposal.proposalId, 1) // 1 = For
      .then((tx) => tx.wait());

    // 3.
    const forVotesAfter = (await governor.proposalVotes(proposal.proposalId)).forVotes.toBigInt();
    expect(forVotesAfter).to.equal(votingWeight, 'forVotes should be equal to voting weight after casting a vote');

    // usedVotes consumes the voter's full weight at the snapshot; hasVoted flips true.
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(
      true,
      'hasVoted should be true after casting'
    );

    return txn; // return txn to measure gas
  }
);

//HP-08
scenario(
  'CompoundGovernor#castVote > full voting against succeeds',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber)).toBigInt();

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. The proposal is registered and resolvable. Reading state() of a
    const againstVotesBefore = (await governor.proposalVotes(proposal.proposalId)).againstVotes.toBigInt();
    expect(againstVotesBefore).to.equal(0n, 'againstVotes should be 0 before any votes are cast');

    // ── Vote on the proposal ─────────────────────────────────────────────────────
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVote(proposal.proposalId, 0) // 0 = against
      .then((tx) => tx.wait());

    // 3.
    const againstVotesAfter = (await governor.proposalVotes(proposal.proposalId)).againstVotes.toBigInt();
    expect(againstVotesAfter).to.equal(
      votingWeight,
      'againstVotes should be equal to voting weight after casting a vote'
    );

    // usedVotes consumes the voter's full weight at the snapshot; hasVoted flips true.
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(
      true,
      'hasVoted should be true after casting'
    );

    return txn; // return txn to measure gas
  }
);

//HP-09
scenario(
  'CompoundGovernor#castVote > full voting abstain succeeds',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber)).toBigInt();

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. The proposal is registered and resolvable. Reading state() of a
    const abstainVotesBefore = (await governor.proposalVotes(proposal.proposalId)).abstainVotes.toBigInt();
    expect(abstainVotesBefore).to.equal(0n, 'abstainVotes should be 0 before any votes are cast');

    // ── Vote on the proposal ─────────────────────────────────────────────────────
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVote(proposal.proposalId, 2) // 2 = abstain
      .then((tx) => tx.wait());

    // 3.
    const abstainVotesAfter = (await governor.proposalVotes(proposal.proposalId)).abstainVotes.toBigInt();
    expect(abstainVotesAfter).to.equal(
      votingWeight,
      'abstainVotes should be equal to voting weight after casting a vote'
    );

    // usedVotes consumes the voter's full weight at the snapshot; hasVoted flips true.
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(
      true,
      'hasVoted should be true after casting'
    );

    return txn; // return txn to measure gas
  }
);

//HP-10
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > fractional vote split succeeds',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber)).toBigInt();
    const forVotes = votingWeight / 4n; // split voting weight between for and against
    const againstVotes = votingWeight / 4n; // split voting weight between for and against
    const abstainVotes = votingWeight / 2n; // split voting weight between abstain and for

    // ── Assertions ──────────────────────────────────────────────────────────────

    // 1. All three vote buckets start empty before any vote is cast.
    const votesBefore = await governor.proposalVotes(proposal.proposalId);
    const forVotesBefore = votesBefore.forVotes.toBigInt();
    const againstVotesBefore = votesBefore.againstVotes.toBigInt();
    const abstainVotesBefore = votesBefore.abstainVotes.toBigInt();
    expect(forVotesBefore).to.equal(0n, 'forVotes should be 0 before any votes are cast');
    expect(againstVotesBefore).to.equal(0n, 'againstVotes should be 0 before any votes are cast');
    expect(abstainVotesBefore).to.equal(0n, 'abstainVotes should be 0 before any votes are cast');

    // ── Vote on the proposal ─────────────────────────────────────────────────────
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVoteWithReasonAndParams(
        proposal.proposalId,
        255,
        '',
        utils.solidityPack(['uint128', 'uint128', 'uint128'], [againstVotes, forVotes, abstainVotes])
      )
      .then((tx) => tx.wait());

    // 3. Each bucket reflects its packed share of the split.
    const votesAfter = await governor.proposalVotes(proposal.proposalId);
    const forVotesAfter = votesAfter.forVotes.toBigInt();
    const againstVotesAfter = votesAfter.againstVotes.toBigInt();
    const abstainVotesAfter = votesAfter.abstainVotes.toBigInt();
    expect(forVotesAfter).to.equal(forVotes, 'forVotes should equal the packed For share after casting');
    expect(againstVotesAfter).to.equal(
      againstVotes,
      'againstVotes should equal the packed Against share after casting'
    );
    expect(abstainVotesAfter).to.equal(
      abstainVotes,
      'abstainVotes should be equal to voting weight after casting a vote'
    );

    // 4. usedVotes equals the total weight consumed by the split (against + for + abstain),
    //    which accounts for the voter's full votingWeight up to integer-division dust
    //    (w/4 + w/4 + w/2 loses the low bits of an odd weight), and hasVoted flips true.
    const usedVotes = (await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt();
    expect(usedVotes).to.equal(
      againstVotes + forVotes + abstainVotes,
      'usedVotes should equal against + for + abstain (total weight consumed by the split)'
    );
    expect(votingWeight - usedVotes).to.be.lt(
      4n,
      'usedVotes should consume the voter votingWeight up to integer-division dust'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(
      true,
      'hasVoted should be true after casting'
    );

    return txn; // return txn to measure gas
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Voting — remaining variants (HP-11..HP-19)
//──────────────────────────────────────────────────────────────────────────────

//HP-11
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > vote for with reason and params',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    const forVotesBefore = (await governor.proposalVotes(proposal.proposalId)).forVotes.toBigInt();
    expect(forVotesBefore).to.equal(0n);

    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVoteWithReasonAndParams(proposal.proposalId, 1, 'reason', '0x')
      .then((tx) => tx.wait());

    const forVotesAfter = (await governor.proposalVotes(proposal.proposalId)).forVotes.toBigInt();
    expect(forVotesAfter).to.equal(votingWeight, 'forVotes should equal voting weight');
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.be.true;
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );

    return txn; // return txn to measure gas
  }
);

//HP-12
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > vote against with reason and params',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVoteWithReasonAndParams(proposal.proposalId, 0, 'against', '0x')
      .then((tx) => tx.wait());

    const againstVotes = (await governor.proposalVotes(proposal.proposalId)).againstVotes.toBigInt();
    expect(againstVotes).to.equal(votingWeight, 'againstVotes should equal voting weight');
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(true, 'hasVoted should be true');
    return txn;
  }
);

//HP-13
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > vote abstain with reason and params',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVoteWithReasonAndParams(proposal.proposalId, 2, 'abstain', '0x')
      .then((tx) => tx.wait());

    const abstainVotes = (await governor.proposalVotes(proposal.proposalId)).abstainVotes.toBigInt();
    expect(abstainVotes).to.equal(votingWeight, 'abstainVotes should equal voting weight');
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(true, 'hasVoted should be true');
    return txn;
  }
);

//HP-14
scenario(
  'CompoundGovernor#castVoteBySig > off-chain signature vote succeeds',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    // Give albert enough COMP to have voting weight
    const whale = await context.getProposer();
    const amount = utils.parseUnits('100', 18);
    await setEtherBalance(dm, whale.address, 10n ** 18n);
    await comp.connect(whale).transfer(albert.address, amount);

    // Albert self-delegates so voting power is checkpointed
    const albertSigner = albert.signer;
    await comp.connect(albertSigner).delegate(albert.address);
    await mineBlocks(dm, 1);

    // Create proposal AFTER delegation checkpoint
    const proposer = await context.getProposer(1);
    const proposal = await createProposal(context, { proposer });

    // Advance to Active state
    const votingDelay = (await governor.votingDelay()).toNumber();
    await mineBlocks(dm, votingDelay + 1);

    const nonceBefore = (await governor.nonces(albert.address)).toBigInt();
    const voteStart = (await governor.proposalSnapshot(proposal.proposalId)).toNumber();
    const weight = (await comp.getPriorVotes(albert.address, voteStart)).toBigInt();
    expect(weight).to.be.gt(0n, 'albert should have voting weight at snapshot');

    // Build EIP-712 domain and message
    const { chainId } = await dm.hre.ethers.provider.getNetwork();
    const domain = {
      name: 'Compound Governor',
      version: '1',
      chainId,
      verifyingContract: governor.address
    };
    const ballotTypes = {
      Ballot: [
        { name: 'proposalId', type: 'uint256' },
        { name: 'support', type: 'uint8' },
        { name: 'voter', type: 'address' },
        { name: 'nonce', type: 'uint256' }
      ]
    };
    const ballotValue = {
      proposalId: proposal.proposalId,
      support: 1,
      voter: albert.address,
      nonce: nonceBefore
    };

    const rawSig = await albertSigner._signTypedData(domain, ballotTypes, ballotValue);

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    const txn = await governor
      .connect(proposer)
      .castVoteBySig(proposal.proposalId, 1, albert.address, rawSig)
      .then((tx) => tx.wait());

    const forVotes = (await governor.proposalVotes(proposal.proposalId)).forVotes.toBigInt();
    expect(forVotes).to.be.gte(weight, "forVotes should include albert's weight");

    const nonceAfter = (await governor.nonces(albert.address)).toBigInt();
    expect(nonceAfter).to.equal(nonceBefore + 1n, 'nonce should increment after sig vote');

    // Single-support sig vote consumes albert's full weight at the snapshot; hasVoted flips true.
    expect((await governor.usedVotes(proposal.proposalId, albert.address)).toBigInt()).to.equal(
      weight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, albert.address)).to.equal(
      true,
      'hasVoted should be true after sig vote'
    );
    return txn;
  }
);

//HP-15
scenario(
  'CompoundGovernor#castVoteWithReasonAndParamsBySig > fractional off-chain signature vote succeeds',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    // Give albert COMP and self-delegate
    const whale = await context.getProposer();
    const amount = utils.parseUnits('100', 18);
    await setEtherBalance(dm, whale.address, 10n ** 18n);
    await comp.connect(whale).transfer(albert.address, amount);
    await comp.connect(albert.signer).delegate(albert.address);
    await mineBlocks(dm, 1);

    const proposer = await context.getProposer(1);
    const proposal = await createProposal(context, { proposer });

    const votingDelay = (await governor.votingDelay()).toNumber();
    await mineBlocks(dm, votingDelay + 1);

    const nonceBefore = (await governor.nonces(albert.address)).toBigInt();
    const voteStart = (await governor.proposalSnapshot(proposal.proposalId)).toNumber();
    const weight = (await comp.getPriorVotes(albert.address, voteStart)).toBigInt();
    expect(weight).to.be.gt(0n);

    // Fractional params: split weight evenly (against=1/4, for=1/2, abstain=1/4)
    const forAmt = weight / 2n;
    const againstAmt = weight / 4n;
    const abstainAmt = weight - forAmt - againstAmt;
    const params = utils.solidityPack(['uint128', 'uint128', 'uint128'], [againstAmt, forAmt, abstainAmt]);
    const reason = 'fractional split';

    const { chainId } = await dm.hre.ethers.provider.getNetwork();
    const domain = {
      name: 'Compound Governor',
      version: '1',
      chainId,
      verifyingContract: governor.address
    };
    const extendedBallotTypes = {
      ExtendedBallot: [
        { name: 'proposalId', type: 'uint256' },
        { name: 'support', type: 'uint8' },
        { name: 'voter', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'reason', type: 'string' },
        { name: 'params', type: 'bytes' }
      ]
    };
    const ballotValue = {
      proposalId: proposal.proposalId,
      support: 255,
      voter: albert.address,
      nonce: nonceBefore,
      reason,
      params
    };

    const rawSig = await albert.signer._signTypedData(domain, extendedBallotTypes, ballotValue);

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    const txn = await governor
      .connect(proposer)
      .castVoteWithReasonAndParamsBySig(proposal.proposalId, 255, albert.address, reason, params, rawSig)
      .then((tx) => tx.wait());

    const pv = await governor.proposalVotes(proposal.proposalId);
    expect(pv.forVotes.toBigInt()).to.equal(forAmt, 'forVotes should match');
    expect(pv.againstVotes.toBigInt()).to.equal(againstAmt, 'againstVotes should match');
    expect(pv.abstainVotes.toBigInt()).to.equal(abstainAmt, 'abstainVotes should match');

    const nonceAfter = (await governor.nonces(albert.address)).toBigInt();
    expect(nonceAfter).to.equal(nonceBefore + 1n, 'nonce should increment');

    // Fractional vote: usedVotes == against + for + abstain (fresh-proposal deltas).
    expect((await governor.usedVotes(proposal.proposalId, albert.address)).toBigInt()).to.equal(
      pv.againstVotes.toBigInt() + pv.forVotes.toBigInt() + pv.abstainVotes.toBigInt(),
      'usedVotes should equal against + for + abstain'
    );
    expect(await governor.hasVoted(proposal.proposalId, albert.address)).to.equal(
      true,
      'hasVoted should be true after sig vote'
    );
    return txn;
  }
);

//HP-16
scenario(
  'CompoundGovernor#castVoteWithReason > vote for with reason',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVoteWithReason(proposal.proposalId, 1, 'I support this')
      .then((tx) => tx.wait());

    const forVotes = (await governor.proposalVotes(proposal.proposalId)).forVotes.toBigInt();
    expect(forVotes).to.equal(votingWeight);
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(true, 'hasVoted should be true');
    return txn;
  }
);

//HP-17
scenario(
  'CompoundGovernor#castVoteWithReason > vote against with reason',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVoteWithReason(proposal.proposalId, 0, 'I oppose this')
      .then((tx) => tx.wait());

    const againstVotes = (await governor.proposalVotes(proposal.proposalId)).againstVotes.toBigInt();
    expect(againstVotes).to.equal(votingWeight);
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(true, 'hasVoted should be true');
    return txn;
  }
);

//HP-18
scenario(
  'CompoundGovernor#castVoteWithReason > vote abstain with reason',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const votingWeight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const txn = await governor
      .connect(voter)
      .castVoteWithReason(proposal.proposalId, 2, 'I abstain')
      .then((tx) => tx.wait());

    const abstainVotes = (await governor.proposalVotes(proposal.proposalId)).abstainVotes.toBigInt();
    expect(abstainVotes).to.equal(votingWeight);
    expect((await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt()).to.equal(
      votingWeight,
      'usedVotes should equal getPriorVotes(voter, snapshot)'
    );
    expect(await governor.hasVoted(proposal.proposalId, voter.address)).to.equal(true, 'hasVoted should be true');
    return txn;
  }
);

//HP-19
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > fractional vote with non-empty reason',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const weight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    const forAmt = weight / 3n;
    const againstAmt = weight / 3n;
    const abstainAmt = weight - forAmt - againstAmt;
    const params = utils.solidityPack(['uint128', 'uint128', 'uint128'], [againstAmt, forAmt, abstainAmt]);

    await setEtherBalance(dm, voter.address, 10n ** 18n);
    const tx = await governor
      .connect(voter)
      .castVoteWithReasonAndParams(proposal.proposalId, 255, 'split vote reason', params);
    const txn = await tx.wait();

    const pv = await governor.proposalVotes(proposal.proposalId);
    expect(pv.forVotes.toBigInt()).to.equal(forAmt);
    expect(pv.againstVotes.toBigInt()).to.equal(againstAmt);
    expect(pv.abstainVotes.toBigInt()).to.equal(abstainAmt);

    // Fractional vote: usedVotes == against + for + abstain (fresh-proposal deltas).
    const usedVotes = (await governor.usedVotes(proposal.proposalId, voter.address)).toBigInt();
    expect(usedVotes).to.equal(
      pv.againstVotes.toBigInt() + pv.forVotes.toBigInt() + pv.abstainVotes.toBigInt(),
      'usedVotes should equal against + for + abstain'
    );

    // VoteCastWithParams(voter indexed, proposalId, support, weight, reason, params).
    // The emitted weight is the total consumed (votedWeight == usedVotes).
    await expect(tx)
      .to.emit(governor, 'VoteCastWithParams')
      .withArgs(voter.address, proposal.proposalId, 255, usedVotes, 'split vote reason', params);

    return txn;
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Quorum (HP-20..HP-23)
//──────────────────────────────────────────────────────────────────────────────

//HP-20
scenario(
  'CompoundGovernor#castVote > late quorum vote extends deadline',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const extension = await governor.lateQuorumVoteExtension();
    if (extension === 0) return; // skip if late quorum not configured

    const proposal = context.proposal!;

    // Advance to within `extension` blocks of the deadline
    const deadline = (await governor.proposalDeadline(proposal.proposalId)).toNumber();
    const now = await dm.hre.ethers.provider.getBlockNumber();
    const blocksUntilLateWindow = deadline - now - extension + 1;
    if (blocksUntilLateWindow > 0) {
      await mineBlocks(dm, blocksUntilLateWindow);
    }

    const deadlineBefore = (await governor.proposalDeadline(proposal.proposalId)).toNumber();

    // Cast a quorum-reaching vote in the late window
    const txn = await reachQuorum(context, governor, proposal);

    const deadlineAfter = (await governor.proposalDeadline(proposal.proposalId)).toNumber();
    expect(deadlineAfter).to.be.gt(deadlineBefore, 'deadline should be extended after late quorum vote');
    return txn;
  }
);

//HP-21
scenario(
  'CompoundGovernor#state > proposal succeeds with quorum and majority',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const txn = await succeedProposal(context, governor, proposal);

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(4, 'proposal should be in Succeeded state');

    // Succeeded implies For-only quorum was reached: quorum(snapshot) <= forVotes.
    const snapshot = (await governor.proposalSnapshot(proposal.proposalId)).toBigInt();
    const forVotes = (await governor.proposalVotes(proposal.proposalId)).forVotes.toBigInt();
    expect(forVotes).to.be.gte((await governor.quorum(snapshot)).toBigInt(), 'forVotes should be >= quorum(snapshot)');

    // Not yet queued, so the eta is unset.
    expect(await governor.proposalEta(proposal.proposalId)).to.equal(0, 'proposalEta should be 0 (not yet queued)');
    return txn;
  }
);

//HP-22
scenario(
  'CompoundGovernor#state > proposal defeated without quorum',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    // Quorum counts For-votes ONLY (CompoundGovernor._quorumReached: quorum(snapshot) <= forVotes).
    // Cast REAL Against + Abstain votes whose COMBINED weight exceeds quorum while leaving
    // For-votes at 0: total participation is above quorum, yet the For-only quorum is NOT
    // reached, so the proposal ends Defeated.
    const snapshot = (await governor.proposalSnapshot(proposal.proposalId)).toBigInt();
    const quorumTarget = (await governor.quorum(snapshot)).toBigInt();
    const whales = await context.getCompWhales();
    // whales[0] is the proposer; use the others so the proposer does not vote against itself.
    const voters = whales.slice(1);

    let lastTxn = null;
    for (let i = 0; i < voters.length; i++) {
      const pv = await governor.proposalVotes(proposal.proposalId);
      const combined = pv.againstVotes.toBigInt() + pv.abstainVotes.toBigInt();
      // Ensure at least one Against (i=0) and one Abstain (i=1) are recorded before stopping.
      if (i >= 2 && combined > quorumTarget) break;
      try {
        const whale = await context.world.impersonateAddress(voters[i], { value: 10n ** 18n, onGovNetwork: true });
        const support = i % 2 === 0 ? 0 : 2; // even -> Against (0), odd -> Abstain (2)
        lastTxn = await governor
          .connect(whale)
          .castVote(proposal.proposalId, support)
          .then((tx) => tx.wait());
      } catch (_) {
        /* already voted */
      }
    }

    // Real weight landed: Against + Abstain together exceed quorum, but For stays below it.
    const pv = await governor.proposalVotes(proposal.proposalId);
    expect(pv.againstVotes.toBigInt() + pv.abstainVotes.toBigInt()).to.be.gt(
      quorumTarget,
      'against + abstain should exceed quorum (real votes were cast)'
    );
    expect(pv.forVotes.toBigInt()).to.be.lt(
      quorumTarget,
      'forVotes should stay below quorum (For-only quorum not reached)'
    );

    await advancePastDeadline(dm, governor, proposal.proposalId);

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(3, 'proposal should be Defeated (For-only quorum not reached despite total > quorum)');
    return lastTxn;
  }
);

//HP-23
scenario(
  'CompoundGovernor#state > proposal defeated with quorum but no majority',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    // Quorum counts For-votes ONLY (CompoundGovernor._quorumReached: quorum(snapshot) <= forVotes).
    // Here For-votes DO reach quorum, but Against >= For, so the proposal has quorum yet
    // fails the majority check (_voteSucceeded: forVotes > againstVotes) and ends Defeated.
    const snapshot = (await governor.proposalSnapshot(proposal.proposalId)).toBigInt();
    const quorumTarget = (await governor.quorum(snapshot)).toBigInt();
    const whales = await context.getCompWhales();

    // Rank whales by their voting power at the snapshot (largest first).
    const ranked = (
      await Promise.all(
        whales.map(async (addr) => ({
          addr,
          power: (await comp.getPriorVotes(addr, snapshot)).toBigInt()
        }))
      )
    ).sort((a, b) => (a.power < b.power ? 1 : a.power > b.power ? -1 : 0));

    let lastTxn = null;
    const voted = new Set<string>();

    // Leg 1 — reach quorum with the MINIMUM For weight: accumulate exactly `quorumTarget`
    // For-votes across whales (largest first). The whale that tips For to quorum donates its
    // remaining weight to Against in the same fractional vote, so no voting power is wasted.
    let forRemaining = quorumTarget;
    for (const entry of ranked) {
      if (forRemaining === 0n || entry.power === 0n) continue;
      const forPart = entry.power < forRemaining ? entry.power : forRemaining;
      const againstPart = entry.power - forPart;
      const whale = await context.world.impersonateAddress(entry.addr, { value: 10n ** 18n, onGovNetwork: true });
      lastTxn = await governor
        .connect(whale)
        .castVoteWithReasonAndParams(
          proposal.proposalId,
          255,
          '',
          utils.solidityPack(['uint128', 'uint128', 'uint128'], [againstPart, forPart, 0n])
        )
        .then((tx) => tx.wait());
      voted.add(entry.addr.toLowerCase());
      forRemaining -= forPart;
    }

    // Leg 2 — remaining whales add Against (full weight) until Against >= For.
    for (const entry of ranked) {
      if (voted.has(entry.addr.toLowerCase()) || entry.power === 0n) continue;
      const pv = await governor.proposalVotes(proposal.proposalId);
      if (pv.againstVotes.toBigInt() >= pv.forVotes.toBigInt()) break;
      try {
        const whale = await context.world.impersonateAddress(entry.addr, { value: 10n ** 18n, onGovNetwork: true });
        lastTxn = await governor
          .connect(whale)
          .castVote(proposal.proposalId, 0)
          .then((tx) => tx.wait());
      } catch (_) {
        /* already voted */
      }
    }

    // Quorum reached via For-votes, yet no majority: Against >= For.
    const pv = await governor.proposalVotes(proposal.proposalId);
    expect(pv.forVotes.toBigInt()).to.be.gte(quorumTarget, 'forVotes should reach quorum');
    expect(pv.againstVotes.toBigInt()).to.be.gte(
      pv.forVotes.toBigInt(),
      'againstVotes should be >= forVotes (no majority)'
    );

    await advancePastDeadline(dm, governor, proposal.proposalId);

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(3, 'proposal should be Defeated (quorum reached but against >= for)');
    return lastTxn;
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Queue (HP-24..HP-25)
//──────────────────────────────────────────────────────────────────────────────

//HP-24
scenario(
  'CompoundGovernor#queue > queueing succeeded by proposalId',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'succeeded' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const etaBefore = (await governor.proposalEta(proposal.proposalId)).toBigInt();
    expect(etaBefore).to.equal(0n, 'eta should be 0 before queue');

    const txn = await queueProposalById(context, governor, proposal.proposalId);

    const etaAfter = (await governor.proposalEta(proposal.proposalId)).toBigInt();
    expect(etaAfter).to.be.gt(0n, 'eta should be set after queue');

    // eta == (timestamp of the block that ran queue) + timelock.delay()  (TLC:95).
    const queueBlock = await dm.hre.ethers.provider.getBlock(txn.blockNumber);
    const timelock = await context.getTimelock();
    const delay = (await timelock.delay()).toBigInt();
    expect(etaAfter).to.equal(
      BigInt(queueBlock.timestamp) + delay,
      'eta should equal queue-block timestamp + timelock delay'
    );

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(5, 'proposal should be in Queued state');
    return txn;
  }
);

//HP-25
scenario(
  'CompoundGovernor#queue > queueing succeeded by full parameter list',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'succeeded' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;
    const proposer = proposal.proposer;

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    const txn = await governor
      .connect(proposer)
      ['queue(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        proposal.descriptionHash
      )
      .then((tx) => tx.wait());

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(5, 'proposal should be in Queued state');
    const eta = (await governor.proposalEta(proposal.proposalId)).toBigInt();
    expect(eta).to.be.gt(0n, 'eta should be set after queue');

    // eta == (timestamp of the block that ran queue) + timelock.delay()  (TLC:95).
    const queueBlock = await dm.hre.ethers.provider.getBlock(txn.blockNumber);
    const timelock = await context.getTimelock();
    const delay = (await timelock.delay()).toBigInt();
    expect(eta).to.equal(
      BigInt(queueBlock.timestamp) + delay,
      'eta should equal queue-block timestamp + timelock delay'
    );
    return txn;
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Execute (HP-26..HP-29)
//──────────────────────────────────────────────────────────────────────────────

//HP-26
scenario(
  'CompoundGovernor#execute > execution succeeded by proposalId',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'queued' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const txn = await executeProposalById(context, governor, proposal.proposalId);

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(7, 'proposal should be in Executed state');
    return txn;
  }
);

//HP-27
scenario(
  'CompoundGovernor#execute > sets executed flag on proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'queued' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const txn = await executeProposalById(context, governor, proposal.proposalId);

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(7, 'proposal should be Executed');

    // Verify eta is still set (not cleared)
    const eta = (await governor.proposalEta(proposal.proposalId)).toBigInt();
    expect(eta).to.be.gt(0n, 'eta should remain after execution');
    return txn;
  }
);

//HP-28
scenario(
  'CompoundGovernor#execute > execution succeeded by full parameter list',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'queued' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;
    const proposer = proposal.proposer;

    const eta = (await governor.proposalEta(proposal.proposalId)).toNumber();
    const timestamp = await getLatestBlockTimestamp(dm);
    if (timestamp <= eta) {
      await setNextBlockTimestamp(dm, eta + 1);
    }

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    const txn = await governor
      .connect(proposer)
      ['execute(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        proposal.descriptionHash
      )
      .then((tx) => tx.wait());

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(7, 'proposal should be Executed');
    return txn;
  }
);

//HP-29
scenario(
  'CompoundGovernor#execute > execution succeeds with no native-currency transfer',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'queued' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // buildSupplyCapProposalActions always uses values = [0], so this verifies zero-value execution
    const proposal = context.proposal!;
    expect(proposal.values.every((v) => v === 0)).to.be.true;

    const txn = await executeProposalById(context, governor, proposal.proposalId);

    const state = await governor.state(proposal.proposalId);
    expect(state).to.equal(7, 'proposal with zero ETH values should execute successfully');
    return txn;
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Whitelist (HP-30..HP-32)
//──────────────────────────────────────────────────────────────────────────────

//HP-30
scenario(
  'CompoundGovernor#setWhitelistAccountExpiration > address whitelisted via governance',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const timestamp = await getLatestBlockTimestamp(dm);
    // Use a far-future expiration so it survives the governance delay
    const expiration = timestamp + 3600 * 24 * 60; // 60 days

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistAccountExpiration(address,uint256)'],
      [utils.defaultAbiCoder.encode(['address', 'uint256'], [albert.address, expiration])]
    );

    const stored = (await governor.whitelistAccountExpirations(albert.address)).toNumber();
    expect(stored).to.equal(expiration, 'whitelist expiration should be stored');

    const isWhitelisted = await governor.isWhitelisted(albert.address);
    expect(isWhitelisted).to.be.true;
    return txn;
  }
);

//HP-31
scenario(
  'CompoundGovernor#setWhitelistAccountExpiration > address whitelisted by whitelist guardian',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { betty, albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // First set whitelistGuardian via governance
    await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistGuardian(address)'],
      [utils.defaultAbiCoder.encode(['address'], [betty.address])]
    );

    const guardian = await governor.whitelistGuardian();
    expect(guardian).to.equal(betty.address, 'betty should be whitelistGuardian');

    // Betty (now guardian) sets whitelist expiration for albert
    const timestamp = await getLatestBlockTimestamp(dm);
    const expiration = timestamp + 3600 * 24 * 7; // 7 days

    const txn = await governor
      .connect(betty.signer)
      .setWhitelistAccountExpiration(albert.address, expiration)
      .then((tx) => tx.wait());

    const stored = (await governor.whitelistAccountExpirations(albert.address)).toNumber();
    expect(stored).to.equal(expiration);
    expect(await governor.isWhitelisted(albert.address)).to.be.true;
    return txn;
  }
);

//HP-32
scenario(
  'CompoundGovernor#setWhitelistAccountExpiration > overwrites existing whitelist expiration',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const timestamp1 = await getLatestBlockTimestamp(dm);
    const expiration1 = timestamp1 + 3600 * 24 * 30;

    // Set initial whitelist expiration
    await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistAccountExpiration(address,uint256)'],
      [utils.defaultAbiCoder.encode(['address', 'uint256'], [albert.address, expiration1])]
    );

    const expirationBefore = (await governor.whitelistAccountExpirations(albert.address)).toBigInt();

    const timestamp2 = await getLatestBlockTimestamp(dm);
    const expiration2 = timestamp2 + 3600 * 24 * 90; // 90 days

    // Overwrite with a new expiration — this is the primary action under test
    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistAccountExpiration(address,uint256)'],
      [utils.defaultAbiCoder.encode(['address', 'uint256'], [albert.address, expiration2])]
    );

    const stored = (await governor.whitelistAccountExpirations(albert.address)).toNumber();
    expect(stored).to.equal(expiration2, 'expiration should be updated to new value');

    // The overwrite actually changed the stored value, and the account is whitelisted.
    expect(BigInt(stored)).to.not.equal(expirationBefore, 'expiration should differ before vs after overwrite');
    expect(await governor.isWhitelisted(albert.address)).to.equal(true, 'account should be whitelisted after set');
    return txn;
  }
);

//──────────────────────────────────────────────────────────────────────────────
// State machine walkthrough (HP-33)
//──────────────────────────────────────────────────────────────────────────────

//HP-33
scenario(
  'CompoundGovernor#state > proposal traverses all expected states',
  { filter: async (ctx) => !isBridgedDeployment(ctx) },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // ── Proposal A: Pending -> Active -> Canceled ───────────────────────────────
    const proposer = await context.getProposer();
    const proposalA = await createProposal(context, { proposer });
    expect(await governor.state(proposalA.proposalId)).to.equal(0, 'A: should be Pending');

    const votingDelay = (await governor.votingDelay()).toNumber();
    await mineBlocks(dm, votingDelay + 1);
    expect(await governor.state(proposalA.proposalId)).to.equal(1, 'A: should be Active');

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await governor.connect(proposer)['cancel(uint256)'](proposalA.proposalId);
    expect(await governor.state(proposalA.proposalId)).to.equal(2, 'A: should be Canceled');

    // ── Proposal B: Defeated (no quorum, mine past deadline) ─────────────────
    const proposalB = await createProposal(context, { proposer });
    await mineBlocks(dm, votingDelay + 1);
    await advancePastDeadline(dm, governor, proposalB.proposalId);
    expect(await governor.state(proposalB.proposalId)).to.equal(3, 'B: should be Defeated');

    // ── Proposal C: Succeeded -> Queued -> Expired ─────────────────────────────
    const proposalC = await createProposal(context, { proposer });
    await succeedProposal(context, governor, proposalC);
    expect(await governor.state(proposalC.proposalId)).to.equal(4, 'C: should be Succeeded');

    await queueProposalById(context, governor, proposalC.proposalId);
    expect(await governor.state(proposalC.proposalId)).to.equal(5, 'C: should be Queued');

    // Advance past eta + GRACE_PERIOD
    const eta = (await governor.proposalEta(proposalC.proposalId)).toNumber();
    const timelock = await context.getTimelock();
    const gracePeriod = (await timelock.GRACE_PERIOD()).toNumber();
    await advanceToTimestamp(dm, eta + gracePeriod + 1);
    expect(await governor.state(proposalC.proposalId)).to.equal(6, 'C: should be Expired');

    // ── Proposal D: Succeeded -> Queued -> Executed ─────────────────────────────
    const proposalD = await createProposal(context, { proposer });
    await succeedProposal(context, governor, proposalD);
    await queueProposalById(context, governor, proposalD.proposalId);
    const txn = await executeProposalById(context, governor, proposalD.proposalId);
    expect(await governor.state(proposalD.proposalId)).to.equal(7, 'D: should be Executed');
    return txn;
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Governance configuration (HP-34..HP-43)
//──────────────────────────────────────────────────────────────────────────────

//HP-34
scenario(
  'CompoundGovernor#setVotingDelay > voting delay updated via governance',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const delayBefore = (await governor.votingDelay()).toNumber();
    const newDelay = delayBefore + 100;

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setVotingDelay(uint48)'],
      [utils.defaultAbiCoder.encode(['uint48'], [newDelay])]
    );

    const delayAfter = (await governor.votingDelay()).toNumber();
    expect(delayAfter).to.equal(newDelay);
    expect(delayAfter).to.not.equal(delayBefore);
    return txn;
  }
);

//HP-35
scenario(
  'CompoundGovernor#setVotingPeriod > voting period updated via governance',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const periodBefore = (await governor.votingPeriod()).toNumber();
    const newPeriod = periodBefore + 500;

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setVotingPeriod(uint32)'],
      [utils.defaultAbiCoder.encode(['uint32'], [newPeriod])]
    );

    const periodAfter = (await governor.votingPeriod()).toNumber();
    expect(periodAfter).to.equal(newPeriod);
    return txn;
  }
);

//HP-36
scenario(
  'CompoundGovernor#setProposalThreshold > proposal threshold updated via governance',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const thresholdBefore = (await governor.proposalThreshold()).toBigInt();
    const newThreshold = thresholdBefore / 2n;

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setProposalThreshold(uint256)'],
      [utils.defaultAbiCoder.encode(['uint256'], [newThreshold])]
    );

    const thresholdAfter = (await governor.proposalThreshold()).toBigInt();
    expect(thresholdAfter).to.equal(newThreshold);
    return txn;
  }
);

//HP-37
scenario(
  'CompoundGovernor#setQuorum > quorum updated via governance and checkpointed',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const blockBefore = await dm.hre.ethers.provider.getBlockNumber();
    const quorumBefore = (await governor.quorum(blockBefore)).toBigInt();
    const newQuorum = quorumBefore / 2n;

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setQuorum(uint256)'],
      [utils.defaultAbiCoder.encode(['uint256'], [newQuorum])]
    );

    const blockAfter = await dm.hre.ethers.provider.getBlockNumber();
    const quorumAfter = (await governor.quorum(blockAfter)).toBigInt();
    expect(quorumAfter).to.equal(newQuorum);

    // Old block should still return old quorum (checkpoint historisation)
    const historicQuorum = (await governor.quorum(blockBefore)).toBigInt();
    expect(historicQuorum).to.equal(quorumBefore);
    return txn;
  }
);

//HP-38
scenario(
  'CompoundGovernor#setLateQuorumVoteExtension > late quorum extension updated via governance',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const extBefore = await governor.lateQuorumVoteExtension();
    const newExt = extBefore === 0 ? 100 : extBefore + 50;

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setLateQuorumVoteExtension(uint48)'],
      [utils.defaultAbiCoder.encode(['uint48'], [newExt])]
    );

    const extAfter = await governor.lateQuorumVoteExtension();
    expect(extAfter).to.equal(newExt);
    return txn;
  }
);

//HP-39
scenario(
  'CompoundGovernor#updateTimelock > timelock updated via governance',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const timelockBefore = await governor.timelock();

    // Deploy a fresh SimpleTimelock with governor as admin
    const newTimelock = await dm.deploy('testTimelockHP39', 'test/SimpleTimelock.sol', [governor.address], true);

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['updateTimelock(address)'],
      [utils.defaultAbiCoder.encode(['address'], [newTimelock.address])]
    );

    const timelockAfter = await governor.timelock();
    expect(timelockAfter).to.equal(newTimelock.address);
    expect(timelockAfter).to.not.equal(timelockBefore);
    return txn;
  }
);

//HP-40
scenario(
  'CompoundGovernor#setWhitelistGuardian > whitelist guardian updated via governance',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistGuardian(address)'],
      [utils.defaultAbiCoder.encode(['address'], [albert.address])]
    );

    const guardian = await governor.whitelistGuardian();
    expect(guardian).to.equal(albert.address);
    return txn;
  }
);

//HP-41
scenario(
  'CompoundGovernor#setProposalGuardian > proposal guardian updated via governance',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const timestamp = await getLatestBlockTimestamp(dm);
    const expiration = timestamp + 3600 * 24 * 60 * 2; // 120 days (survives governance delay)

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setProposalGuardian((address,uint96))'],
      [utils.defaultAbiCoder.encode(['tuple(address,uint96)'], [[betty.address, expiration]])]
    );

    const pg = await governor.proposalGuardian();
    expect(pg.account).to.equal(betty.address);
    expect(pg.expiration.toNumber()).to.equal(expiration);
    return txn;
  }
);

//HP-42
scenario(
  'CompoundGovernor#relay > governor calls external contract via relay',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Deploy a test token and mint some to the governor
    const token = await dm.deploy<import('../build/types').FaucetToken, [string, string, BigNumberish, string]>(
      'relayTestTokenHP42',
      'test/FaucetToken.sol',
      [exp(1_000_000, 18).toString(), 'RelayTest', 18, 'RTT'],
      true
    );
    await token.allocateTo(governor.address, exp(1000, 18));

    const albertBalBefore = (await token.balanceOf(albert.address)).toBigInt();

    // Relay a transfer from governor to albert
    const transferCalldata = token.interface.encodeFunctionData('transfer', [albert.address, exp(100, 18)]);
    const relayArgs = utils.defaultAbiCoder.encode(
      ['address', 'uint256', 'bytes'],
      [token.address, 0, transferCalldata]
    );

    const txn = await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['relay(address,uint256,bytes)'],
      [relayArgs]
    );

    const albertBalAfter = (await token.balanceOf(albert.address)).toBigInt();
    expect(albertBalAfter).to.equal(albertBalBefore + exp(100, 18));
    return txn;
  }
);

//HP-43
scenario(
  'CompoundGovernor#execute > full lifecycle applies governance action on-chain',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comet = await context.getComet();
    const configurator = await context.getConfigurator();

    // Capture expected outcome before proposal is submitted
    // buildSupplyCapProposalActions targets asset 0 and sets newSupplyCap = currentCap + 1n
    const assetInfoBefore = await comet.getAssetInfo(0);
    const targetAssetAddress = assetInfoBefore.asset;
    const expectedSupplyCap = assetInfoBefore.supplyCap.toBigInt() + 1n;

    const proposer = await context.getProposer();
    const proposal = await createProposal(context, { proposer });

    // Verify Pending state
    expect(await governor.state(proposal.proposalId)).to.equal(0, 'should start Pending');

    // Advance to Active
    const votingDelay = (await governor.votingDelay()).toNumber();
    await mineBlocks(dm, votingDelay + 1);
    expect(await governor.state(proposal.proposalId)).to.equal(1, 'should be Active');

    // Reach quorum and vote for
    await reachQuorum(context, governor, proposal);

    // Advance past deadline
    await advancePastDeadline(dm, governor, proposal.proposalId);
    expect(await governor.state(proposal.proposalId)).to.equal(4, 'should be Succeeded');

    // Queue
    await queueProposalById(context, governor, proposal.proposalId);
    expect(await governor.state(proposal.proposalId)).to.equal(5, 'should be Queued');

    // Execute
    const txn = await executeProposalById(context, governor, proposal.proposalId);
    expect(await governor.state(proposal.proposalId)).to.equal(7, 'should be Executed');

    // Verify the governance action was applied in the Configurator
    // (updateAssetSupplyCap updates Configurator; a subsequent deployAndUpgradeTo would push to Comet)
    const config = await configurator.getConfiguration(comet.address);
    const assetConfig = config.assetConfigs.find((a) => a.asset.toLowerCase() === targetAssetAddress.toLowerCase());
    expect(assetConfig?.supplyCap.toBigInt()).to.equal(expectedSupplyCap);

    return txn;
  }
);

//──────────────────────────────────────────────────────────────────────────────
// Unhappy paths (UH-00..UH-46)
//──────────────────────────────────────────────────────────────────────────────

//UH-00
scenario(
  'CompoundGovernor#propose > reverts for restricted description',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const proposer = await context.getProposer();

    const { targets, values, calldatas } = await buildSupplyCapProposalActions(context);
    // Description with #proposer=<otherAddress> restricts who can propose
    const restrictedDescription = `Supply cap bump #proposer=${albert.address}`;

    const nextIdBefore = (await governor.getNextProposalId()).toBigInt();

    // proposer != albert, so this should revert with GovernorRestrictedProposer
    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(
      governor.connect(proposer).propose(targets, values, calldatas, restrictedDescription)
    ).to.be.revertedWithCustomError(governor, 'GovernorRestrictedProposer');

    // A reverted propose() must not consume a proposal id.
    expect((await governor.getNextProposalId()).toBigInt()).to.equal(
      nextIdBefore,
      'getNextProposalId() should be unchanged after a reverted propose()'
    );
  }
);

//UH-01
scenario(
  'CompoundGovernor#propose > reverts for non-whitelisted proposer without sufficient votes',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const { targets, values, calldatas, description } = await buildSupplyCapProposalActions(context);

    // albert has 0 COMP and is not whitelisted
    await expect(
      governor.connect(albert.signer).propose(targets, values, calldatas, description)
    ).to.be.revertedWithCustomError(governor, 'GovernorInsufficientProposerVotes');
  }
);

//UH-02
scenario(
  'CompoundGovernor#propose > reverts when proposer already has active proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposer = context.proposal!.proposer;

    // Second proposal from same proposer while first is active
    const { targets, values, calldatas, description } = await buildSupplyCapProposalActions(context, 'second');
    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(
      governor.connect(proposer).propose(targets, values, calldatas, description)
    ).to.be.revertedWithCustomError(governor, 'ProposerActiveProposal');
  }
);

//UH-03
scenario(
  'CompoundGovernor#cancel > reverts when called by unauthorized address',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    // albert tries to cancel; proposer above threshold -> Unauthorized("Proposer above proposalThreshold", albert)
    await expect(governor.connect(albert.signer)['cancel(uint256)'](proposal.proposalId))
      .to.be.revertedWithCustomError(governor, 'Unauthorized')
      .withArgs(toBytes32Reason('Proposer above proposalThreshold'), albert.address);
  }
);

//UH-04
scenario(
  'CompoundGovernor#cancel > reverts when unauthorized address cancels whitelisted proposer',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Whitelist albert via governance (albert has 0 COMP, so below threshold)
    const timestamp = await getLatestBlockTimestamp(dm);
    const expiration = timestamp + 3600 * 24 * 60;
    await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistAccountExpiration(address,uint256)'],
      [utils.defaultAbiCoder.encode(['address', 'uint256'], [albert.address, expiration])]
    );

    // Albert proposes (whitelisted, no threshold)
    const { targets, values, calldatas, description } = await buildSupplyCapProposalActions(context);
    await governor.connect(albert.signer).propose(targets, values, calldatas, description);

    const proposalId = (await governor.latestProposalIds(albert.address)).toBigInt();

    // Betty (not whitelistGuardian, not proposalGuardian) -> Unauthorized("Not whitelistGuardian", betty)
    await expect(governor.connect(betty.signer)['cancel(uint256)'](proposalId))
      .to.be.revertedWithCustomError(governor, 'Unauthorized')
      .withArgs(toBytes32Reason('Not whitelistGuardian'), betty.address);
  }
);

//UH-05
scenario(
  'CompoundGovernor#cancel > reverts for nonexistent proposal (by id)',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer)['cancel(uint256)'](999999))
      .to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal')
      .withArgs(999999);
  }
);

//UH-06
scenario(
  'CompoundGovernor#cancel > reverts for nonexistent proposal (by params)',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    // Use wrong targets (different address)
    const wrongTargets = [albert.address];
    await expect(
      governor
        .connect(albert.signer)
        ['cancel(address[],uint256[],bytes[],bytes32)'](
          wrongTargets,
          proposal.values,
          proposal.calldatas,
          proposal.descriptionHash
        )
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-07
scenario(
  'CompoundGovernor#cancel > reverts when values do not match proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    await expect(
      governor.connect(albert.signer)['cancel(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        [1], // wrong values
        proposal.calldatas,
        proposal.descriptionHash
      )
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-08
scenario(
  'CompoundGovernor#cancel > reverts when calldatas do not match proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    await expect(
      governor.connect(albert.signer)['cancel(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        proposal.values,
        ['0xdeadbeef'], // wrong calldatas
        proposal.descriptionHash
      )
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-09
scenario(
  'CompoundGovernor#cancel > reverts when descriptionHash does not match proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    await expect(
      governor.connect(albert.signer)['cancel(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        utils.keccak256(utils.toUtf8Bytes('wrong description')) // wrong hash
      )
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-10
scenario(
  'CompoundGovernor#castVote > reverts for invalid vote type',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    await expect(
      governor.connect(voter).castVote(proposal.proposalId, 3) // 3 is invalid
    ).to.be.revertedWithCustomError(governor, 'GovernorInvalidVoteType');
  }
);

//UH-11
scenario(
  'CompoundGovernor#castVote > reverts for nonexistent proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).castVote(888888, 1)).to.be.revertedWithCustomError(
      governor,
      'GovernorNonexistentProposal'
    );
  }
);

//UH-12
scenario(
  'CompoundGovernor#castVote > reverts when proposal is in Pending state',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Create proposal but do NOT mine past votingDelay — still Pending
    const proposal = context.proposal!;
    expect(await governor.state(proposal.proposalId)).to.equal(0, 'should be Pending');

    const voter = await context.getProposer(1);
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    await expect(governor.connect(voter).castVote(proposal.proposalId, 1)).to.be.revertedWithCustomError(
      governor,
      'GovernorUnexpectedProposalState'
    );
  }
);

//UH-13
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > reverts for nonexistent proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(
      governor.connect(albert.signer).castVoteWithReasonAndParams(777777, 1, 'reason', '0x')
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-14
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > reverts when proposal is in Pending state',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;
    expect(await governor.state(proposal.proposalId)).to.equal(0, 'should be Pending');

    const voter = await context.getProposer(1);
    await expect(
      governor.connect(voter).castVoteWithReasonAndParams(proposal.proposalId, 1, 'reason', '0x')
    ).to.be.revertedWithCustomError(governor, 'GovernorUnexpectedProposalState');
  }
);

//UH-15
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > reverts for invalid fractional params length',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    // Fractional support = 255 but params is only 4 bytes (not 48)
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    await expect(
      governor.connect(voter).castVoteWithReasonAndParams(proposal.proposalId, 255, '', '0x12345678')
    ).to.be.revertedWithCustomError(governor, 'GovernorInvalidVoteParams');
  }
);

//UH-16
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > reverts for invalid vote type',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    // support=3 is invalid (valid: 0,1,2,255)
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    await expect(
      governor.connect(voter).castVoteWithReasonAndParams(proposal.proposalId, 3, '', '0x')
    ).to.be.revertedWithCustomError(governor, 'GovernorInvalidVoteType');
  }
);

//UH-17
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > reverts for full vote with non-empty params',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const nonEmptyParams = utils.solidityPack(['uint128', 'uint128', 'uint128'], [0, 100, 0]);
    // support=1 (For) with non-empty params should revert
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    await expect(
      governor.connect(voter).castVoteWithReasonAndParams(proposal.proposalId, 1, '', nonEmptyParams)
    ).to.be.revertedWithCustomError(governor, 'GovernorInvalidVoteParams');
  }
);

//UH-18
scenario(
  'CompoundGovernor#castVote > reverts for repeated full vote',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    await governor.connect(voter).castVote(proposal.proposalId, 1);

    // Second vote from same voter
    await expect(governor.connect(voter).castVote(proposal.proposalId, 1))
      .to.be.revertedWithCustomError(governor, 'GovernorAlreadyCastVote')
      .withArgs(voter.address);
  }
);

//UH-19
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > reverts when all fractional weight already spent',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const weight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    // Use all weight in one fractional vote
    const params = utils.solidityPack(['uint128', 'uint128', 'uint128'], [0, weight, 0]);
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    await governor.connect(voter).castVoteWithReasonAndParams(proposal.proposalId, 255, '', params);

    // Try to cast again — all weight spent, contract raises AlreadyCastVote before ExceedRemainingWeight
    const params2 = utils.solidityPack(['uint128', 'uint128', 'uint128'], [0, 1, 0]);
    await expect(
      governor.connect(voter).castVoteWithReasonAndParams(proposal.proposalId, 255, '', params2)
    ).to.be.revertedWithCustomError(governor, 'GovernorAlreadyCastVote');
  }
);

//UH-20
scenario(
  'CompoundGovernor#castVoteWithReasonAndParams > reverts when vote exceeds remaining fractional weight',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);
    const comp = Comp__factory.connect((await context.getComp()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    const voter = await context.getProposer(1);
    const weight = (await comp.getPriorVotes(voter.address, proposal.blockNumber!)).toBigInt();

    // Use half weight in first vote
    const halfWeight = weight / 2n;
    const params1 = utils.solidityPack(['uint128', 'uint128', 'uint128'], [0, halfWeight, 0]);
    await setEtherBalance(dm, voter.address, 10n ** 18n);
    await governor.connect(voter).castVoteWithReasonAndParams(proposal.proposalId, 255, '', params1);

    // Try to use more than the remaining half (e.g., 3/4 of total)
    const tooMuch = (weight * 3n) / 4n;
    const params2 = utils.solidityPack(['uint128', 'uint128', 'uint128'], [0, tooMuch, 0]);
    await expect(
      governor.connect(voter).castVoteWithReasonAndParams(proposal.proposalId, 255, '', params2)
    ).to.be.revertedWithCustomError(governor, 'GovernorExceedRemainingWeight');
  }
);

//UH-21
scenario(
  'CompoundGovernor#queue > reverts when proposal not in Succeeded state (by proposalId)',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Create proposal and leave in Pending state
    const proposal = context.proposal!;
    const proposer = proposal.proposer;
    expect(await governor.state(proposal.proposalId)).to.equal(0);

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(governor.connect(proposer)['queue(uint256)'](proposal.proposalId)).to.be.revertedWithCustomError(
      governor,
      'GovernorUnexpectedProposalState'
    );
  }
);

//UH-22
scenario(
  'CompoundGovernor#queue > reverts when proposal not in Succeeded state (by full params)',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Create and leave in Pending
    const proposal = context.proposal!;
    const proposer = proposal.proposer;

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(
      governor
        .connect(proposer)
        ['queue(address[],uint256[],bytes[],bytes32)'](
          proposal.targets,
          proposal.values,
          proposal.calldatas,
          proposal.descriptionHash
        )
    ).to.be.revertedWithCustomError(governor, 'GovernorUnexpectedProposalState');
  }
);

//UH-23
scenario(
  'CompoundGovernor#queue > reverts for nonexistent proposal (by id)',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer)['queue(uint256)'](666666))
      .to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal')
      .withArgs(666666);
  }
);

//UH-24
scenario(
  'CompoundGovernor#queue > reverts when targets do not match proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'succeeded' }
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    await expect(
      governor.connect(albert.signer)['queue(address[],uint256[],bytes[],bytes32)'](
        [albert.address], // wrong targets
        proposal.values,
        proposal.calldatas,
        proposal.descriptionHash
      )
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-25
scenario(
  'CompoundGovernor#queue > reverts when values do not match proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'succeeded' }
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    await expect(
      governor.connect(albert.signer)['queue(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        [99], // wrong values
        proposal.calldatas,
        proposal.descriptionHash
      )
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-26
scenario(
  'CompoundGovernor#queue > reverts when calldatas do not match proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'succeeded' }
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    await expect(
      governor.connect(albert.signer)['queue(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        proposal.values,
        ['0xdeadbeef'], // wrong calldatas
        proposal.descriptionHash
      )
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-27
scenario(
  'CompoundGovernor#queue > reverts when descriptionHash does not match proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'succeeded' }
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;

    await expect(
      governor.connect(albert.signer)['queue(address[],uint256[],bytes[],bytes32)'](
        proposal.targets,
        proposal.values,
        proposal.calldatas,
        utils.keccak256(utils.toUtf8Bytes('wrong')) // wrong hash
      )
    ).to.be.revertedWithCustomError(governor, 'GovernorNonexistentProposal');
  }
);

//UH-28
scenario(
  'CompoundGovernor#queue > reverts for Defeated proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'active' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;
    const proposer = proposal.proposer;

    // Bring to Defeated (no quorum, mine past deadline)
    await advancePastDeadline(dm, governor, proposal.proposalId);
    expect(await governor.state(proposal.proposalId)).to.equal(3, 'should be Defeated');

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(governor.connect(proposer)['queue(uint256)'](proposal.proposalId)).to.be.revertedWithCustomError(
      governor,
      'GovernorUnexpectedProposalState'
    );
  }
);

//UH-29
scenario(
  'CompoundGovernor#queue > reverts for already-Queued proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'queued' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;
    const proposer = proposal.proposer;
    expect(await governor.state(proposal.proposalId)).to.equal(5, 'should be Queued');

    // Queue again
    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(governor.connect(proposer)['queue(uint256)'](proposal.proposalId)).to.be.revertedWithCustomError(
      governor,
      'GovernorUnexpectedProposalState'
    );
  }
);

//UH-30
scenario(
  'CompoundGovernor#execute > reverts when Succeeded proposal is not queued',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'succeeded' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;
    const proposer = proposal.proposer;
    expect(await governor.state(proposal.proposalId)).to.equal(4, 'should be Succeeded');

    // Execute without queueing first -> GovernorNotQueuedProposal
    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(governor.connect(proposer)['execute(uint256)'](proposal.proposalId)).to.be.revertedWithCustomError(
      governor,
      'GovernorNotQueuedProposal'
    );
  }
);

//UH-31
scenario(
  'CompoundGovernor#execute > reverts when proposal is in Pending state',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: true
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Proposal in Pending state
    const proposal = context.proposal!;
    const proposer = proposal.proposer;
    expect(await governor.state(proposal.proposalId)).to.equal(0, 'should be Pending');

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(governor.connect(proposer)['execute(uint256)'](proposal.proposalId)).to.be.revertedWithCustomError(
      governor,
      'GovernorUnexpectedProposalState'
    );
  }
);

//UH-32
scenario(
  'CompoundGovernor#execute > reverts for already-Executed proposal',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'queued' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;
    const proposer = proposal.proposer;
    await executeProposalById(context, governor, proposal.proposalId);
    expect(await governor.state(proposal.proposalId)).to.equal(7, 'should be Executed');

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(governor.connect(proposer)['execute(uint256)'](proposal.proposalId)).to.be.revertedWithCustomError(
      governor,
      'GovernorUnexpectedProposalState'
    );
  }
);

//UH-33
scenario(
  'CompoundGovernor#execute > reverts for Expired proposal (past grace period)',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx),
    proposal: { state: 'queued' }
  },
  async (_, context) => {
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const proposal = context.proposal!;
    const proposer = proposal.proposer;

    const eta = (await governor.proposalEta(proposal.proposalId)).toNumber();
    const timelock = await context.getTimelock();
    const gracePeriod = (await timelock.GRACE_PERIOD()).toNumber();

    // Jump past eta + GRACE_PERIOD -> Expired
    await advanceToTimestamp(dm, eta + gracePeriod + 1);
    expect(await governor.state(proposal.proposalId)).to.equal(6, 'should be Expired');

    await setEtherBalance(dm, proposer.address, 10n ** 18n);
    await expect(governor.connect(proposer)['execute(uint256)'](proposal.proposalId)).to.be.revertedWithCustomError(
      governor,
      'GovernorUnexpectedProposalState'
    );
  }
);

//UH-34
scenario(
  'CompoundGovernor#setWhitelistAccountExpiration > reverts when called by non-guardian',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const timestamp = await getLatestBlockTimestamp(dm);
    await expect(governor.connect(albert.signer).setWhitelistAccountExpiration(betty.address, timestamp + 3600))
      .to.be.revertedWithCustomError(governor, 'Unauthorized')
      .withArgs(toBytes32Reason('Not timelock or guardian'), albert.address);
  }
);

//UH-35
scenario(
  'CompoundGovernor#setVotingDelay > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).setVotingDelay(100))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-36
scenario(
  'CompoundGovernor#setVotingPeriod > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).setVotingPeriod(100))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-37
scenario(
  'CompoundGovernor#setProposalThreshold > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).setProposalThreshold(1000))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-38
scenario(
  'CompoundGovernor#setQuorum > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).setQuorum(1000))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-39
scenario(
  'CompoundGovernor#setLateQuorumVoteExtension > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).setLateQuorumVoteExtension(100))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-40
scenario(
  'CompoundGovernor#updateTimelock > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).updateTimelock(betty.address))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-41
scenario(
  'CompoundGovernor#setWhitelistGuardian > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).setWhitelistGuardian(betty.address))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-42
scenario(
  'CompoundGovernor#setProposalGuardian > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    const timestamp = await getLatestBlockTimestamp(dm);
    await expect(
      governor.connect(albert.signer).setProposalGuardian({ account: betty.address, expiration: timestamp + 3600 })
    )
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-43
scenario(
  'CompoundGovernor#relay > reverts when called by non-executor',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    await expect(governor.connect(albert.signer).relay(betty.address, 0, '0x'))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(albert.address);
  }
);

//UH-44
scenario(
  'CompoundGovernor#setWhitelistGuardian > reverts when called by current whitelist guardian (not executor)',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Set betty as whitelistGuardian via governance
    await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistGuardian(address)'],
      [utils.defaultAbiCoder.encode(['address'], [betty.address])]
    );
    expect(await governor.whitelistGuardian()).to.equal(betty.address);

    // Betty (whitelistGuardian) tries to call setWhitelistGuardian — only executor can
    await expect(governor.connect(betty.signer).setWhitelistGuardian(albert.address))
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(betty.address);
  }
);

//UH-45
scenario(
  'CompoundGovernor#setProposalGuardian > reverts when called by current proposal guardian (not executor)',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Set betty as proposalGuardian via governance
    const timestamp = await getLatestBlockTimestamp(dm);
    const expiration = timestamp + 3600 * 24 * 120;

    await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setProposalGuardian((address,uint96))'],
      [utils.defaultAbiCoder.encode(['tuple(address,uint96)'], [[betty.address, expiration]])]
    );
    expect((await governor.proposalGuardian()).account).to.equal(betty.address);

    // Betty (proposalGuardian) tries to call setProposalGuardian — only executor can
    await expect(
      governor.connect(betty.signer).setProposalGuardian({ account: albert.address, expiration: timestamp + 3600 })
    )
      .to.be.revertedWithCustomError(governor, 'GovernorOnlyExecutor')
      .withArgs(betty.address);
  }
);

//UH-46
scenario(
  'CompoundGovernor#setWhitelistAccountExpiration > reverts when called by former whitelist guardian',
  {
    filter: async (ctx) => !isBridgedDeployment(ctx)
  },
  async ({ actors }, context) => {
    const { albert, betty } = actors;
    const dm = context.world.deploymentManager;
    const governor = CompoundGovernor__factory.connect((await context.getGovernor()).address, dm.hre.ethers.provider);

    // Set betty as whitelistGuardian
    await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistGuardian(address)'],
      [utils.defaultAbiCoder.encode(['address'], [betty.address])]
    );
    expect(await governor.whitelistGuardian()).to.equal(betty.address);

    // Remove betty (replace with zero address)
    await context.fastGovernanceExecute(
      [governor.address],
      [0],
      ['setWhitelistGuardian(address)'],
      [utils.defaultAbiCoder.encode(['address'], [constants.AddressZero])]
    );
    expect(await governor.whitelistGuardian()).to.equal(constants.AddressZero);

    // Betty (former guardian) -> Unauthorized("Not timelock or guardian", betty)
    const timestamp = await getLatestBlockTimestamp(dm);
    await expect(governor.connect(betty.signer).setWhitelistAccountExpiration(albert.address, timestamp + 3600))
      .to.be.revertedWithCustomError(governor, 'Unauthorized')
      .withArgs(toBytes32Reason('Not timelock or guardian'), betty.address);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function findActiveWhitelistedAccountReverse(
  governor: CompoundGovernor,
  context: CometContext,
  opts: { chunk?: number; minBlock?: number } = {}
): Promise<string | null> {
  const chunk = opts.chunk ?? 5000; // scan window size
  const minBlock = opts.minBlock ?? 0; // don't go deeper (e.g. Governor deployment block)
  const filter = governor.filters.WhitelistAccountExpirationSet();

  let toBlock = (await context.world.deploymentManager.hre.ethers.provider.getBlock('latest')).number;
  const checked = new Set<string>(); // addresses already checked via isWhitelisted

  while (toBlock >= minBlock) {
    const fromBlock = Math.max(minBlock, toBlock - chunk + 1);

    const events = await governor.queryFilter(filter, fromBlock, toBlock);

    // within the window we also go from the end: newest events first
    for (let i = events.length - 1; i >= 0; i--) {
      const account = events[i].args!.account as string;
      const key = account.toLowerCase();
      if (checked.has(key)) continue; // already discarded this address
      checked.add(key);

      // the decision is made by the CURRENT state, not the value from the event
      if (await governor.isWhitelisted(account)) {
        return account;
      }
    }

    toBlock = fromBlock - 1; // next window deeper into the past
  }
  return null;
}

function toBytes32Reason(reason: string): string {
  const bytes = utils.toUtf8Bytes(reason);
  if (bytes.length > 32) {
    throw new Error(`reason "${reason}" is ${bytes.length} bytes; cannot fit in bytes32`);
  }
  return utils.hexlify(utils.concat([bytes, new Uint8Array(32 - bytes.length)]));
}
