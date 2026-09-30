import type { HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/types';
import { AbiCoder, parseEther, ZeroAddress } from 'ethers';

import { ethers, expect, makeProtocol, getConfigurationForConfigurator } from './../helpers.js';
import {
  initializeAndFundGovernorTimelock,
  advanceTimeAndMineBlock,
} from './market-updates-helper.js';
import {
  CometHarnessInterfaceExtendedAssetList__factory,
  CometFactoryWithExtendedAssetList__factory,
  CometProxyAdmin__factory,
  CometProxyAdminOld__factory,
  Configurator__factory,
  ConfiguratorOld__factory,
  ConfiguratorProxy__factory,
  MarketAdminPermissionChecker__factory,
  MarketUpdateProposer__factory,
  MarketUpdateTimelock__factory,
  SimpleTimelock,
  TransparentUpgradeableProxy__factory,
} from './../../build/types/index.js';

const abiCoder = AbiCoder.defaultAbiCoder();

describe('MarketUpdateDeployment', function() {
  /*

    Mainner Timelock - https://etherscan.io/address/0x6d903f6003cca6255D85CcA4D3B5E5146dC33925

    Existing Setup Steps:
    1) Deploy CometProxyAdmin with Governor Timelock. The owner of the CometProxyAdmin should be the Governor Timelock
       See the owner here on mainnet -https://etherscan.io/address/0x1ec63b5883c3481134fd50d5daebc83ecd2e8779#readContract
       The owner should be the Governor Timelock
    2) Deploy the Configurator with Admin as CometProxyAdmin
       See the admin of the Proxy contact https://etherscan.io/address/0x316f9708bb98af7da9c68c1c3b5e79039cd336e3
       The admin should be the CometProxyAdmin
    3) Deploy the Comet's Proxy with Admin as CometProxyAdmin
       See the admin of the Proxy contact https://etherscan.io/address/0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840
       The admin should be the CometProxyAdmin

    New Setup Steps:
    -------   Deploy New Contracts -----------
    1) Deploy the address of MarketAdminMultiSig

    2) Deploy MarketUpdateTimelock with Governor Timelock as the owner

    3) Deploy MarketUpdateProposer with MarketAdminMultiSig as the owner

    4) Deploy the new CometProxyAdmin

    5) Set MainGovernorTimelock as the owner of new CometProxyAdmin by calling transferOwnership

    6) Deploy the new Configurator's Implementation

    7) Deploy the MarketAdminPermissionChecker contract

    8) Transfer the ownership of MarketAdminPermissionChecker to Governor Timelock

    -------   Update Existing Contracts -----------

    All actions to be done by timelock proposals
    -- Update Admins ---
    1) Call Old CometProxyAdmin  via timelock and call `changeProxyAdmin` function to set Comet Proxy's admin as the new CometProxyAdmin // This will allow the new CometProxyAdmin to upgrade the Comet's implementation

    2) Call Old CometProxyAdmin and call `changeProxyAdmin` function to set Configurator's Proxy's admin as the new CometProxyAdmin // This will allow the new CometProxyAdmin to upgrade the Configurator's implementation if needed in future

    -- Set new configurator's implementation ---

    3) Set marketUpdateAdmin on MarketAdminPermissionChecker

    4) Set MarketAdminPermissionChecker on Configurator

    5) Set MarketAdminPermissionChecker on CometProxyAdmin

    6) Set Market Update proposer in MarketUpdateTimelock

    7) Deploy market update   // This will make sure existing functionality is working fine
          - setSupplyKink
          - deployAndUpgrade
   */

  /*
    Market Updates

    1) propose a new market update on MarketUpdateProposer using MarketAdminMultiSig

    2) Call the execute function on MarketUpdateProposer to execute the proposal
   */

  it('should be able to deploy MarketUpdates in the proper sequence', async () => {
    const {
      governorTimelockSigner: governorTimelockSigner,
      governorTimelock: governorTimelock,
      originalSigner,
    } = await initializeAndFundGovernorTimelock();

    const {
      configuratorProxyContract,
      configuratorBehindProxy,
      cometBehindProxy,
      oldCometProxyAdmin,
      proxyOfComet,
      comet,
    } = await deployExistingContracts({
      governorTimelock,
      governorTimelockSigner,
      originalSigner,
    });

    const cometAsProxy = CometHarnessInterfaceExtendedAssetList__factory.connect(
      await cometBehindProxy.getAddress(),
      comet.runner
    );

    expect(await configuratorBehindProxy.governor()).to.be.equal(
      await governorTimelock.getAddress()
    );
    // -------   Deploy New Contracts -----------

    const signers = await ethers.getSigners();

    // 1) Deploy the address of MarketAdminMultiSig
    const marketUpdateMultiSig = signers[3];

    const marketUpdaterProposerFactory = new MarketUpdateProposer__factory(
      marketUpdateMultiSig
    );

    // Fund the impersonated account
    await signers[0].sendTransaction({
      to: marketUpdateMultiSig.address,
      value: parseEther('1.0'), // Sending 1 Ether to cover gas fees
    });

    const marketAdminTimelockFactory = new MarketUpdateTimelock__factory(
      marketUpdateMultiSig
    );

    // 2) Deploy MarketUpdateTimelock with Governor Timelock as the owner
    const marketUpdateTimelock = await marketAdminTimelockFactory.deploy(
      await governorTimelock.getAddress(),
      2 * 24 * 60 * 60 // This is 2 days in seconds
    );

    // Fund the impersonated account
    await signers[0].sendTransaction({
      to: await marketUpdateTimelock.getAddress(),
      value: parseEther('1.0'), // Sending 1 Ether to cover gas fees
    });

    // 3) Deploy MarketUpdateProposer with MarketAdminMultiSig as the owner
    const proposalGuardian = signers[5];
    const marketUpdateProposer = await marketUpdaterProposerFactory
      .connect(marketUpdateMultiSig)
      .deploy(
        await governorTimelock.getAddress(),
        marketUpdateMultiSig.address,
        proposalGuardian.address,
        await marketUpdateTimelock.getAddress()
      );

    // 4) Deploy the new CometProxyAdmin
    const ProxyAdmin = new CometProxyAdmin__factory(marketUpdateMultiSig);
    const proxyAdminNew = await ProxyAdmin.deploy(marketUpdateMultiSig.address);

    // 5) Set MainGovernorTimelock as the owner of new CometProxyAdmin by calling transferOwnership
    await proxyAdminNew
      .connect(marketUpdateMultiSig)
      .transferOwnership(await governorTimelock.getAddress());

    // 6) Deploy the new Configurator's Implementation
    const ConfiguratorFactory = new Configurator__factory(marketUpdateMultiSig);
    const configuratorNew = await ConfiguratorFactory.deploy();
    await configuratorNew.waitForDeployment();

    // 7) Deploy the MarketAdminPermissionChecker contract
    const MarketAdminPermissionCheckerFactory =
      new MarketAdminPermissionChecker__factory(marketUpdateMultiSig);

    const marketAdminPermissionCheckerContract =
      await MarketAdminPermissionCheckerFactory.deploy(
        await governorTimelock.getAddress(),
        ZeroAddress,
        ZeroAddress
      );

    const oldCometProxyAdminAddress = await oldCometProxyAdmin.getAddress();
    const proxyOfCometAddress = await proxyOfComet.getAddress();
    const newProxyAdminAddress = await proxyAdminNew.getAddress();
    const configuratorProxyAddress = await configuratorProxyContract.getAddress();
    const newConfiguratorAddress = await configuratorNew.getAddress();
    const permissionCheckerAddress = await marketAdminPermissionCheckerContract.getAddress();
    const marketUpdateTimelockAddress = await marketUpdateTimelock.getAddress();
    const marketUpdateProposerAddress = await marketUpdateProposer.getAddress();
    const cometBehindProxyAddress = await cometBehindProxy.getAddress();

    // -------   Update Existing Contracts -----------
    console.log('Updating the existing contracts');

    // Call Old CometProxyAdmin  via timelock and call `changeProxyAdmin` function to set Comet Proxy's admin as the new CometProxyAdmin // This will allow the new CometProxyAdmin to upgrade the Comet's implementation
    await governorTimelock.executeTransactions(
      [oldCometProxyAdminAddress],
      [0],
      ['changeProxyAdmin(address,address)'],
      [
        abiCoder.encode(
          ['address', 'address'],
          [proxyOfCometAddress, newProxyAdminAddress]
        ),
      ]
    );

    // Call Old CometProxyAdmin and call `changeProxyAdmin` function to set Configurator's Proxy's admin as the new CometProxyAdmin // This will allow the new CometProxyAdmin to upgrade the Configurator's implementation if needed in future
    await governorTimelock.executeTransactions(
      [oldCometProxyAdminAddress],
      [0],
      ['changeProxyAdmin(address,address)'],
      [
        abiCoder.encode(
          ['address', 'address'],
          [configuratorProxyAddress, newProxyAdminAddress]
        ),
      ]
    );

    await governorTimelock.executeTransactions(
      [newProxyAdminAddress],
      [0],
      ['upgrade(address,address)'],
      [
        abiCoder.encode(
          ['address', 'address'],
          [configuratorProxyAddress, newConfiguratorAddress]
        ),
      ]
    );

    // Setting Market Update Admin in MarketAdminPermissionChecker
    await governorTimelock.executeTransactions(
      [permissionCheckerAddress],
      [0],
      ['setMarketAdmin(address)'],
      [
        abiCoder.encode(
          ['address'],
          [marketUpdateTimelockAddress]
        ),
      ]
    );

    // Setting MarketAdminPermissionChecker on Configurator
    await governorTimelock.executeTransactions(
      [configuratorProxyAddress],
      [0],
      ['setMarketAdminPermissionChecker(address)'],
      [
        abiCoder.encode(
          ['address'],
          [permissionCheckerAddress]
        ),
      ]
    );

    // Setting MarketAdminPermissionChecker on CometProxyAdmin
    await governorTimelock.executeTransactions(
      [newProxyAdminAddress],
      [0],
      ['setMarketAdminPermissionChecker(address)'],
      [
        abiCoder.encode(
          ['address'],
          [permissionCheckerAddress]
        ),
      ]
    );

    // Setting Market Update proposer in MarketUpdateTimelock
    await governorTimelock.executeTransactions(
      [marketUpdateTimelockAddress],
      [0],
      ['setMarketUpdateProposer(address)'],
      [
        abiCoder.encode(
          ['address'],
          [marketUpdateProposerAddress]
        ),
      ]
    );

    // Governor Timelock: Setting new supplyKink in Configurator and deploying Comet
    const newSupplyKinkByGovernorTimelock = 300n;
    const oldSupplyKink = await cometAsProxy.supplyKink();
    expect(oldSupplyKink).to.be.equal(800000000000000000n);
    await governorTimelock.executeTransactions(
      [configuratorProxyAddress, newProxyAdminAddress],
      [0, 0],
      ['setSupplyKink(address,uint64)', 'deployAndUpgradeTo(address,address)'],
      [
        abiCoder.encode(
          ['address', 'uint64'],
          [cometBehindProxyAddress, newSupplyKinkByGovernorTimelock]
        ),
        abiCoder.encode(
          ['address', 'address'],
          [configuratorProxyAddress, cometBehindProxyAddress]
        ),
      ]
    );

    const newSupplyKink = await cometAsProxy.supplyKink();
    expect(newSupplyKink).to.be.equal(newSupplyKinkByGovernorTimelock);

    // MarketAdmin: Setting new supplyKink in Configurator and deploying Comet
    const newConfiguratorViaProxy = Configurator__factory.connect(
      configuratorProxyAddress,
      configuratorNew.runner
    );
    const supplyKinkOld = (
      await newConfiguratorViaProxy.getConfiguration(cometBehindProxyAddress)
    ).supplyKink;
    expect(supplyKinkOld).to.be.equal(300n);

    const newSupplyKinkByMarketAdmin = 100n;
    await marketUpdateProposer
      .connect(marketUpdateMultiSig)
      .propose(
        [configuratorProxyAddress, newProxyAdminAddress],
        [0, 0],
        [
          'setSupplyKink(address,uint64)',
          'deployAndUpgradeTo(address,address)',
        ],
        [
          abiCoder.encode(
            ['address', 'uint64'],
            [cometBehindProxyAddress, newSupplyKinkByMarketAdmin]
          ),
          abiCoder.encode(
            ['address', 'address'],
            [configuratorProxyAddress, cometBehindProxyAddress]
          ),
        ],
        'Test market update'
      );

    await advanceTimeAndMineBlock(2 * 24 * 60 * 60 + 10); // Fast forward by 2 days + a few seconds to surpass the eta

    await marketUpdateProposer.connect(marketUpdateMultiSig).execute(1);

    expect(
      (await newConfiguratorViaProxy.getConfiguration(cometBehindProxyAddress))
        .supplyKink
    ).to.be.equal(newSupplyKinkByMarketAdmin);
  });

  async function deployExistingContracts(input: {
    governorTimelock: SimpleTimelock;
    governorTimelockSigner: SignerWithAddress;
    originalSigner: SignerWithAddress;
  }) {
    const { governorTimelockSigner } = input;
    const opts: any = {};

    const {
      governor,
      pauseGuardian,
      extensionDelegateAssetList: extensionDelegate,
      base,
      cometWithExtendedAssetList: comet,
      tokens,
      priceFeeds,
    } = await makeProtocol({
      governor: governorTimelockSigner,
    });

    const configuration = await getConfigurationForConfigurator(
      opts,
      comet,
      governor,
      pauseGuardian,
      extensionDelegate,
      tokens,
      base,
      priceFeeds
    );

    // Deploy ProxyAdmin
    const ProxyAdmin = new CometProxyAdminOld__factory(governorTimelockSigner);
    const proxyAdmin = await ProxyAdmin.deploy(governorTimelockSigner.address);
    await proxyAdmin.waitForDeployment();

    // Deploy Comet proxy
    const CometProxy = new TransparentUpgradeableProxy__factory(governorTimelockSigner);
    const cometBehindProxy = await CometProxy.deploy(
      await comet.getAddress(),
      await proxyAdmin.getAddress(),
      (await comet.initializeStorage.populateTransaction()).data
    );
    await cometBehindProxy.waitForDeployment();

    // Derive the rest of the Configurator configuration values

    // Deploy CometFactory
    const CometFactoryFactory = new CometFactoryWithExtendedAssetList__factory(
      governorTimelockSigner
    );
    const cometFactory = await CometFactoryFactory.deploy();
    await cometFactory.waitForDeployment();

    // Deploy Configurator
    const ConfiguratorFactory = new ConfiguratorOld__factory(governorTimelockSigner);
    const configurator = await ConfiguratorFactory.deploy();
    await configurator.waitForDeployment();

    // Deploy Configurator proxy
    const initializeCalldata = (await configurator.initialize.populateTransaction(governor.address)).data;
    const ConfiguratorProxyContract = new ConfiguratorProxy__factory(governorTimelockSigner);
    const configuratorProxyContract = await ConfiguratorProxyContract.deploy(
      await configurator.getAddress(),
      await proxyAdmin.getAddress(),
      initializeCalldata
    );
    await configuratorProxyContract.waitForDeployment();

    // Set the initial factory and configuration for Comet in Configurator
    const configuratorBehindProxy = ConfiguratorOld__factory.connect(
      await configuratorProxyContract.getAddress(),
      governorTimelockSigner
    );
    await configuratorBehindProxy.setConfiguration(
      await cometBehindProxy.getAddress(),
      configuration
    );
    await configuratorBehindProxy.setFactory(
      await cometBehindProxy.getAddress(),
      await cometFactory.getAddress()
    );

    return {
      configuratorProxyContract,
      configuratorBehindProxy,
      cometBehindProxy,
      proxyOfComet: cometBehindProxy,
      oldCometProxyAdmin: proxyAdmin,
      comet,
    };
  }
});
