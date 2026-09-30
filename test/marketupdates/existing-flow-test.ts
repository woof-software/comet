import { AbiCoder, Interface, LogDescription, parseEther } from 'ethers';
import {
  CometHarnessInterfaceExtendedAssetList__factory,
  CometProxyAdmin__factory,
  Configurator__factory,
  GovernorSimple__factory,
  SimpleTimelock__factory,
  TransparentUpgradeableProxy__factory
} from '../../build/types/index.js';
import { ethers, event, expect, makeConfigurator, wait } from './../helpers.js';

const abiCoder = AbiCoder.defaultAbiCoder();

describe('configurator', function() {
  it("Ensure - timelock's admin is set as Governor - Add two(access and not access) test for it.", async () => {
    const { signer, timelock } = await initializeAndFundTimelock();

    const {
      configurator,
      configuratorProxy,
      cometProxyWithExtendedAssetList: cometProxy,
      users: [alice]
    } = await makeConfigurator({
      governor: signer
    });

    const configuratorAsProxy = Configurator__factory.connect(
      await configuratorProxy.getAddress(),
      configurator.runner
    );

    const setPauseGuardianCalldata = abiCoder.encode(
      ['address', 'address'],
      [await cometProxy.getAddress(), alice.address]
    );

    // This works fine as governor is set as timelock's admin
    await timelock.executeTransactions(
      [await configuratorProxy.getAddress()],
      [0],
      ['setPauseGuardian(address,address)'],
      [setPauseGuardianCalldata]
    );
    expect(
      (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress()))
        .pauseGuardian
    ).to.be.equal(alice.address);

    // This will revert as alice is calling the timelock
    await expect(
      timelock.connect(alice).executeTransactions(
        [await configuratorProxy.getAddress()],
        [0], // no Ether to be sent
        ['setPauseGuardian(address,address)'],
        [setPauseGuardianCalldata]
      )
    ).to.be.revertedWithCustomError(timelock, 'Unauthorized');
  });

  it("Ensure - Configurator's governor is set as timelock - Test for access", async () => {
    const { signer, timelock } = await initializeAndFundTimelock();
    const {
      configurator,
      configuratorProxy,
      cometProxyWithExtendedAssetList: cometProxy,
      users: [alice]
    } = await makeConfigurator({ governor: signer });

    const configuratorAsProxy = Configurator__factory.connect(
      await configuratorProxy.getAddress(),
      configurator.runner
    );

    const setPauseGuardianCalldata = abiCoder.encode(
      ['address', 'address'],
      [await cometProxy.getAddress(), alice.address]
    );

    // This works fine as configurator's governor is set as timelock
    await timelock.executeTransactions(
      [await configuratorProxy.getAddress()],
      [0],
      ['setPauseGuardian(address,address)'],
      [setPauseGuardianCalldata]
    );

    expect(
      (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress()))
        .pauseGuardian
    ).to.be.equal(alice.address);
  });

  it("Ensure - Configurator's governor is set as timelock - Test for not access", async () => {
    const { signer, timelock } = await initializeAndFundTimelock();
    const {
      governor,
      configurator,
      configuratorProxy,
      cometProxyWithExtendedAssetList: cometProxy,
      users: [alice]
    } = await makeConfigurator({ governor: signer });

    const configuratorAsProxy = Configurator__factory.connect(
      await configuratorProxy.getAddress(),
      configurator.runner
    );
    await configuratorAsProxy.connect(governor).transferGovernor(alice.address); // set alice as governor of Configurator

    const setPauseGuardianCalldata = abiCoder.encode(
      ['address', 'address'],
      [await cometProxy.getAddress(), alice.address]
    );

    // This will revert as configurator's governor is set as Alice
    await expect(
      timelock.executeTransactions(
        [await configuratorProxy.getAddress()],
        [0], // no Ether to be sent
        ['setPauseGuardian(address,address)'],
        [setPauseGuardianCalldata]
      )
    ).to.be.revertedWith('failed to call');
  });

  it("Ensure - CometProxyAdmin's owner is timelock - Test for access", async () => {
    const { signer, timelock } = await initializeAndFundTimelock();
    const {
      configuratorProxy,
      proxyAdmin,
      cometProxyWithExtendedAssetList: cometProxy
    } = await makeConfigurator({ governor: signer });

    const deployAndUpgradeToCalldata = abiCoder.encode(
      ['address', 'address'],
      [await configuratorProxy.getAddress(), await cometProxy.getAddress()]
    );

    const txn = (await wait(
      timelock.executeTransactions(
        [await proxyAdmin.getAddress()],
        [0],
        ['deployAndUpgradeTo(address,address)'],
        [deployAndUpgradeToCalldata]
      )
    )) as any;

    const abi = [
      'event CometDeployed(address indexed cometProxy, address indexed newComet)',
      'event Upgraded(address indexed implementation)'
    ];

    // Initialize the contract interface
    const iface = new Interface(abi);
    const events: LogDescription[] = [];

    txn.receipt.logs.forEach((log) => {
      try {
        const decodedEvent = iface.parseLog(log);
        if (decodedEvent) events.push(decodedEvent);
      } catch (error) {
        console.log('Failed to decode event:', error);
      }
    });

    // verify the event names
    expect(events[0].name).to.be.equal('CometDeployed');
    expect(events[1].name).to.be.equal('Upgraded');

    const oldCometProxyAddress = await cometProxy.getAddress();
    const oldCometProxyAddressFromEvent = events[0].args.cometProxy;
    const newCometProxyAddress = events[0].args.newComet;

    expect(oldCometProxyAddress).to.be.equal(oldCometProxyAddressFromEvent);
    expect(oldCometProxyAddress).to.be.not.equal(newCometProxyAddress);
  });

  it("Ensure - CometProxyAdmin's owner is timelock - Test for non-access", async () => {
    const { signer, timelock } = await initializeAndFundTimelock();
    const {
      configuratorProxy,
      proxyAdmin,
      cometProxyWithExtendedAssetList: cometProxy,
      users: [alice]
    } = await makeConfigurator({ governor: signer });

    await proxyAdmin.transferOwnership(alice.address); // Transferred ownership to alice instead of timelock

    const deployAndUpgradeToCalldata = abiCoder.encode(
      ['address', 'address'],
      [await configuratorProxy.getAddress(), await cometProxy.getAddress()]
    );

    expect(
      timelock.executeTransactions(
        [await proxyAdmin.getAddress()],
        [0],
        ['deployAndUpgradeTo(address,address)'],
        [deployAndUpgradeToCalldata]
      )
    ).to.be.revertedWith('failed to call');
  });

  it("Ensure - Comet's Proxy's admin is set as CometProxyAdmin - Test for access.", async () => {
    const {
      configurator,
      configuratorProxy,
      proxyAdmin,
      cometWithExtendedAssetList: comet,
      cometProxyWithExtendedAssetList: cometProxy,
      users: [alice]
    } = await makeConfigurator();

    const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(
      await cometProxy.getAddress(),
      comet.runner
    );
    const configuratorAsProxy = Configurator__factory.connect(
      await configuratorProxy.getAddress(),
      configurator.runner
    );
    expect(
      (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).governor
    ).to.be.equal(await comet.governor());

    const oldGovernor = await comet.governor();
    const newGovernor = alice.address;
    const txn = await wait(
      configuratorAsProxy.setGovernor(await cometProxy.getAddress(), newGovernor)
    );
    await wait(
      proxyAdmin.deployAndUpgradeTo(
        await configuratorProxy.getAddress(),
        await cometProxy.getAddress()
      )
    );

    expect(event(txn, 0)).to.be.deep.equal({
      SetGovernor: {
        cometProxy: await cometProxy.getAddress(),
        oldGovernor,
        newGovernor
      }
    });
    expect(oldGovernor).to.be.not.equal(newGovernor);
    expect(
      (await configuratorAsProxy.getConfiguration(await cometProxy.getAddress())).governor
    ).to.be.equal(newGovernor);
    expect(await cometAsProxy.governor()).to.be.equal(newGovernor);
  });

  it("Ensure - Comet's Proxy's admin is set as CometProxyAdmin - Test for non-access.", async () => {
    const {
      configuratorProxy,
      proxyAdmin,
      cometWithExtendedAssetList: comet,
      users: [_alice, bob]
    } = await makeConfigurator();

    // Deploy ProxyAdmin
    const ProxyAdmin = new CometProxyAdmin__factory(bob);
    const proxyAdminTemp = await ProxyAdmin.deploy(bob.address);
    await proxyAdminTemp.waitForDeployment();

    // Deploy Comet proxy
    const CometProxy = new TransparentUpgradeableProxy__factory(bob);
    const cometProxy = await CometProxy.deploy(
      await comet.getAddress(),
      await proxyAdminTemp.getAddress(),
      (await comet.initializeStorage.populateTransaction()).data
    );
    await cometProxy.waitForDeployment();

    await expect(
      proxyAdmin.deployAndUpgradeTo(
        await configuratorProxy.getAddress(),
        await cometProxy.getAddress()
      )
    ).to.revert(ethers);
  });

  it("Add a test to create a proposal and execute it(This proposal changes the governor of configurator and the deploys the comet through ProxyAdmin). This proposal should update something simple on Comet's asset", async () => {
    const { signer, timelock } = await initializeAndFundTimelock();
    const {
      governor,
      configuratorProxy,
      proxyAdmin,
      cometProxyWithExtendedAssetList: cometProxy,
      cometWithExtendedAssetList: comet,
      users: [_alice]
    } = await makeConfigurator({ governor: signer });
    const GovernorFactory = new GovernorSimple__factory(governor);
    const governorBravo = await GovernorFactory.deploy();
    await governorBravo.waitForDeployment();
    await governorBravo.initialize(await timelock.getAddress(), [governor.address]);

    // Setting GovernorBravo as the admin of timelock
    await timelock.setAdmin(await governorBravo.getAddress());

    const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(
      await cometProxy.getAddress(),
      comet.runner
    );
    const ASSET_ADDRESS = (await cometAsProxy.getAssetInfo(1)).asset;
    const NEW_ASSET_SUPPLY_CAP = 500000000000000000000n;

    expect((await cometAsProxy.getAssetInfo(1)).supplyCap).to.be.not.equal(
      NEW_ASSET_SUPPLY_CAP
    );

    const updateAssetSupplyCapCalldata = abiCoder.encode(
      ['address', 'address', 'uint128'],
      [await cometProxy.getAddress(), ASSET_ADDRESS, NEW_ASSET_SUPPLY_CAP]
    );
    const deployAndUpgradeToCalldata = abiCoder.encode(
      ['address', 'address'],
      [await configuratorProxy.getAddress(), await cometProxy.getAddress()]
    );

    const proposeTx = (await wait(
      governorBravo
        .connect(governor)
        .propose(
          [await configuratorProxy.getAddress(), await proxyAdmin.getAddress()],
          [0, 0],
          [
            'updateAssetSupplyCap(address,address,uint128)',
            'deployAndUpgradeTo(address,address)'
          ],
          [updateAssetSupplyCapCalldata, deployAndUpgradeToCalldata],
          "Proposal to update Comet's governor"
        )
    )) as any;

    const proposalCreatedEvent = proposeTx.receipt.logs
      .map((log) => governorBravo.interface.parseLog(log))
      .find((log) => log?.name === 'ProposalCreated');
    if (!proposalCreatedEvent) {
      throw new Error('ProposalCreated event not found');
    }
    const proposalId = proposalCreatedEvent.args.id;

    await wait(governorBravo.connect(governor).queue(proposalId));

    await wait(governorBravo.connect(governor).execute(proposalId));

    expect(
      (await cometAsProxy.getAssetInfoByAddress(ASSET_ADDRESS)).supplyCap
    ).to.be.equal(NEW_ASSET_SUPPLY_CAP);
  });
});
async function initializeAndFundTimelock() {
  const signers = await ethers.getSigners();
  const gov = signers[0];
  const TimelockFactory = new SimpleTimelock__factory(gov);
  const timelock = await TimelockFactory.deploy(gov.address);
  await timelock.waitForDeployment();
  const timelockAddress = await timelock.getAddress();

  // Impersonate the account
  await ethers.provider.send('hardhat_impersonateAccount', [timelockAddress]);

  // Fund the impersonated account
  await gov.sendTransaction({
    to: timelockAddress,
    value: parseEther('1.0') // Sending 1 Ether to cover gas fees
  });

  // Get the signer from the impersonated account
  const signer = await ethers.getSigner(timelockAddress);
  return { signer, timelock };
}
