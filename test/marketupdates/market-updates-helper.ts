import {
  SimpleTimelock__factory,
  MarketUpdateTimelock__factory,
  MarketUpdateProposer__factory, MarketAdminPermissionChecker__factory,
} from './../../build/types/index.js';
import { ethers, expect } from './../helpers.js';

export async function makeMarketAdmin() {
  const {
    governorTimelockSigner: governorTimelockSigner,
  } = await initializeAndFundGovernorTimelock();

  const signers = await ethers.getSigners();

  const marketUpdateMultiSig = signers[7];
  const marketUpdateProposalGuardianSigner = signers[8];
  const marketAdminPauseGuardianSigner = signers[9];

  const marketAdminTimelockFactory = new MarketUpdateTimelock__factory(signers[0]);

  const marketUpdateTimelockContract = await marketAdminTimelockFactory.deploy(
    governorTimelockSigner.address,
    2 * 24 * 60 * 60 // This is 2 days in seconds
  );
  await marketUpdateTimelockContract.waitForDeployment();
  const marketUpdateTimelockAddress = await marketUpdateTimelockContract.getAddress();

  // Impersonate the account
  await ethers.provider.send('hardhat_impersonateAccount', [marketUpdateTimelockAddress]);

  // Fund the impersonated account
  await signers[0].sendTransaction({
    to: marketUpdateTimelockAddress,
    value: ethers.parseEther('1.0'), // Sending 1 Ether to cover gas fees
  });

  // Get the signer from the impersonated account
  const marketUpdateTimelockSigner = await ethers.getSigner(
    marketUpdateTimelockAddress
  );

  const marketUpdaterProposerFactory = new MarketUpdateProposer__factory(signers[0]);

  // Fund the impersonated account
  await signers[0].sendTransaction({
    to: marketUpdateMultiSig.address,
    value: ethers.parseEther('1.0'), // Sending 1 Ether to cover gas fees
  });

  // This sets the owner of the MarketUpdateProposer to the marketUpdateMultiSig
  const marketUpdateProposerContract = await marketUpdaterProposerFactory.deploy(
    governorTimelockSigner.address,
    marketUpdateMultiSig.address,
    marketUpdateProposalGuardianSigner.address,
    marketUpdateTimelockAddress
  );
  await marketUpdateProposerContract.waitForDeployment();

  expect(await marketUpdateProposerContract.governor()).to.be.equal(
    governorTimelockSigner.address
  );

  await marketUpdateTimelockContract
    .connect(governorTimelockSigner)
    .setMarketUpdateProposer(await marketUpdateProposerContract.getAddress());

  const MarketAdminPermissionCheckerFactory = new MarketAdminPermissionChecker__factory(signers[0]);


  const marketAdminPermissionCheckerContract =  await MarketAdminPermissionCheckerFactory.deploy(
    governorTimelockSigner.address,
    marketUpdateTimelockAddress,
    marketAdminPauseGuardianSigner.address
  );
  await marketAdminPermissionCheckerContract.waitForDeployment();

  await marketUpdateTimelockContract
    .connect(governorTimelockSigner)
    .setMarketUpdateProposer(await marketUpdateProposerContract.getAddress());

  return {
    marketUpdateProposerContract,
    marketAdminPermissionCheckerContract,
    marketUpdateTimelockContract,

    governorTimelockSigner, // used to impersonate the main governor timelock

    marketUpdateMultiSig, // used to impersonate the market update multisig
    marketAdminPauseGuardianSigner, // used to impersonate the market admin pause guardian
    marketUpdateProposalGuardianSigner, // used to impersonate the market update proposal guardian
    marketUpdateTimelockSigner, // used to impersonate the market update timelock
  };
}

export async function initializeAndFundGovernorTimelock() {
  const signers = await ethers.getSigners();
  const gov = signers[0];
  const TimelockFactory = new SimpleTimelock__factory(gov);
  const governorTimelock = await TimelockFactory.deploy(gov.address);
  await governorTimelock.waitForDeployment();
  const governorTimelockAddress = await governorTimelock.getAddress();

  // Impersonate the account
  await ethers.provider.send('hardhat_impersonateAccount', [governorTimelockAddress]);

  // Fund the impersonated account
  await gov.sendTransaction({
    to: governorTimelockAddress,
    value: ethers.parseEther('100.0'), // Sending 1 Ether to cover gas fees
  });

  // Get the signer from the impersonated account
  const governorTimelockSigner = await ethers.getSigner(governorTimelockAddress);
  return { originalSigner: gov, governorTimelockSigner, governorTimelock };
}

export async function advanceTimeAndMineBlock(delay: number) {
  await ethers.provider.send('evm_increaseTime', [delay + 10]);
  await ethers.provider.send('evm_mine', []); // Mine a new block to apply the time increase
}


export async function createRandomWallet() {
  const signers = await ethers.getSigners();
  const gov = signers[0];
  const random = ethers.Wallet.createRandom();

  await gov.sendTransaction({
    to: random.address,
    value: ethers.parseEther('100.0'), // Sending 1 Ether to cover gas fees
  });
  return random.connect(ethers.provider);
}
