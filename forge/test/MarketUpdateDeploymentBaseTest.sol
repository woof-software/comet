pragma solidity ^0.8.15;

import "@forge-std/src/Vm.sol";
import "@comet-contracts/CometWithExtendedAssetList.sol";
import "@comet-contracts/CometFactoryWithExtendedAssetList.sol";
import "@comet-contracts/bridges/arbitrum/ArbitrumBridgeReceiver.sol";
import "@comet-contracts/marketupdates/MarketAdminPermissionChecker.sol";
import "../script/marketupdates/helpers/GovernanceHelper.sol";
import "../script/marketupdates/helpers/MarketUpdateAddresses.sol";
import "../script/marketupdates/helpers/ChainAddresses.sol";
import "../script/marketupdates/helpers/MarketUpdateContractsDeployer.sol";
import { BridgeHelper } from "../script/marketupdates/helpers/BridgeHelper.sol";
import { LiquidationModuleHelper } from "../script/marketupdates/helpers/LiquidationModuleHelper.sol";
import { Test, console } from "forge-std/Test.sol";

abstract contract MarketUpdateDeploymentBaseTest is Test {

    IGovernorBravo public governorBravo = IGovernorBravo(MarketUpdateAddresses.GOVERNOR_BRAVO_PROXY_ADDRESS);

    function createMarketUpdateDeployment(Vm vm) public returns (MarketUpdateContractsDeployer.DeployedContracts memory) {
        bytes32 salt = keccak256(abi.encodePacked(vm.envString("SALT")));
        ChainAddresses.Chain chain = ChainAddresses.getChainBasedOnChainId(1);
        ChainAddresses.ChainAddressesStruct memory chainAddresses = ChainAddresses.getChainAddresses(chain);

        MarketUpdateContractsDeployer.DeployedContracts memory deployedContracts = MarketUpdateContractsDeployer.deployContracts(
            vm,
            salt,
            chainAddresses.marketAdmin,
            chainAddresses.marketUpdatePauseGuardian,
            chainAddresses.marketUpdateProposalGuardian,
            chainAddresses.governorTimelockAddress
        );


        console.log("MarketUpdateTimelock: ", deployedContracts.marketUpdateTimelock);
        console.log("MarketUpdateProposer: ", deployedContracts.marketUpdateProposer);
        console.log("NewConfiguratorImplementation: ", deployedContracts.newConfiguratorImplementation);
        console.log("NewCometProxyAdmin: ", deployedContracts.newCometProxyAdmin);
        console.log("MarketAdminPermissionChecker: ", deployedContracts.marketAdminPermissionChecker);


        address proposalCreator = GovernanceHelper.getTopDelegates()[0];

        MarketUpdateAddresses.MarketUpdateAddressesStruct memory addresses = MarketUpdateAddresses.getAddressesForChain(
            ChainAddresses.Chain.ETHEREUM,
            deployedContracts,
            MarketUpdateAddresses.MARKET_UPDATE_MULTISIG_ADDRESS
        );

        uint256 proposalId = GovernanceHelper.createDeploymentProposal(vm, addresses, proposalCreator);

        GovernanceHelper.moveProposalToActive(vm, proposalId);

        GovernanceHelper.voteOnProposal(vm, proposalId, proposalCreator);

        GovernanceHelper.moveProposalToSucceed(vm, proposalId);

        governorBravo.queue(proposalId);

        GovernanceHelper.moveProposalToExecution(vm, proposalId);

        console.log("proposal state after execution: ", uint(governorBravo.state(proposalId)));

        return deployedContracts;
    }

    function createMarketUpdateDeploymentForL2(Vm vm, ChainAddresses.Chain chain) public returns (MarketUpdateContractsDeployer.DeployedContracts memory) {
        bytes32 salt = keccak256(abi.encodePacked(vm.envString("SALT")));

        address localTimelock = ChainAddresses.getLocalTimelockAddress(chain);
        ChainAddresses.ChainAddressesStruct memory chainAddresses = ChainAddresses.getChainAddresses(chain);

        // Optimism already ran this deployment for real, so the proposal cannot be replayed — those
        // proxies have changed hands. Only the Configurator still has to move, to match the factory.
        if (chain == ChainAddresses.Chain.OPTIMISM) {
            console.log("Contracts are already deployed on Optimism, upgrading only the Configurator");

            MarketUpdateContractsDeployer.DeployedContracts memory optimismContracts = MarketUpdateContractsDeployer.DeployedContracts({
                marketUpdateTimelock: 0x81Bc6016Fa365bfE929a51Eec9217B441B598eC6,
                marketUpdateProposer: 0xB6Ef3AC71E9baCF1F4b9426C149d855Bfc4415F9,
                newConfiguratorImplementation: address(new Configurator()),
                newCometProxyAdmin: 0x24D86Da09C4Dd64e50dB7501b0f695d030f397aF,
                marketAdminPermissionChecker: 0x62DD0452411113404cf9a7fE88A5E6E86f9B71a6
            });

            address[] memory upgradeTargets = new address[](1);
            uint256[] memory upgradeValues = new uint256[](1);
            string[] memory upgradeSignatures = new string[](1);
            bytes[] memory upgradeCalldatas = new bytes[](1);

            upgradeTargets[0] = optimismContracts.newCometProxyAdmin;
            upgradeSignatures[0] = "upgrade(address,address)";
            upgradeCalldatas[0] = abi.encode(
                chainAddresses.configuratorProxyAddress,
                optimismContracts.newConfiguratorImplementation
            );

            BridgeHelper.simulateMessageAndExecuteProposal(
                vm,
                chain,
                MarketUpdateAddresses.GOVERNOR_BRAVO_TIMELOCK_ADDRESS,
                GovernanceHelper.ProposalRequest({
                    targets: upgradeTargets,
                    values: upgradeValues,
                    signatures: upgradeSignatures,
                    calldatas: upgradeCalldatas
                })
            );

            return optimismContracts;
        }

        MarketUpdateContractsDeployer.DeployedContracts memory deployedContracts = MarketUpdateContractsDeployer.deployContracts(
            vm,
            salt,
            chainAddresses.marketAdmin,
            chainAddresses.marketUpdatePauseGuardian,
            chainAddresses.marketUpdateProposalGuardian,
            localTimelock
        );


        console.log("MarketUpdateTimelock: ", deployedContracts.marketUpdateTimelock);
        console.log("MarketUpdateProposer: ", deployedContracts.marketUpdateProposer);
        console.log("NewConfiguratorImplementation: ", deployedContracts.newConfiguratorImplementation);
        console.log("NewCometProxyAdmin: ", deployedContracts.newCometProxyAdmin);
        console.log("MarketAdminPermissionChecker: ", deployedContracts.marketAdminPermissionChecker);


        MarketUpdateAddresses.MarketUpdateAddressesStruct memory addresses = MarketUpdateAddresses.getAddressesForChain(
            chain,
            deployedContracts,
            MarketUpdateAddresses.MARKET_UPDATE_MULTISIG_ADDRESS
        );

        GovernanceHelper.ProposalRequest memory proposalRequest = GovernanceHelper.createDeploymentProposalRequest(addresses);

        BridgeHelper.simulateMessageAndExecuteProposal(vm, chain, MarketUpdateAddresses.GOVERNOR_BRAVO_TIMELOCK_ADDRESS, proposalRequest);

        return deployedContracts;
    }

    /// Adding liquidationModule to the config moved the clone() selector, so the new Configurator
    /// cannot reach the factory live on-chain. Governance installs a matching one, once.
    function buildSetFactoryRequest(
        address configuratorProxy,
        address cometProxy
    ) internal returns (GovernanceHelper.ProposalRequest memory) {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        string[] memory signatures = new string[](1);
        bytes[] memory calldatas = new bytes[](1);

        targets[0] = configuratorProxy;
        signatures[0] = "setFactory(address,address)";
        calldatas[0] = abi.encode(cometProxy, address(new CometFactoryWithExtendedAssetList()));

        return GovernanceHelper.ProposalRequest({
            targets: targets,
            values: values,
            signatures: signatures,
            calldatas: calldatas
        });
    }

    /// A module serves one Comet deployment, so a fresh one goes in before every upgrade — the
    /// first included, where the stored module is still zero. Governor-only, hence its own proposal.
    function buildSetLiquidationModuleRequest(
        address configuratorProxy,
        address cometProxy
    ) internal returns (GovernanceHelper.ProposalRequest memory) {
        address[] memory targets = new address[](1);
        uint256[] memory values = new uint256[](1);
        string[] memory signatures = new string[](1);
        bytes[] memory calldatas = new bytes[](1);

        // Market update multisig stands in as multisig, executor and pauser.
        address liquidationModule = LiquidationModuleHelper.deployForMarket(
            configuratorProxy,
            cometProxy,
            MarketUpdateAddresses.MARKET_UPDATE_MULTISIG_ADDRESS
        );

        targets[0] = configuratorProxy;
        signatures[0] = "setLiquidationModule(address,address)";
        calldatas[0] = abi.encode(cometProxy, liquidationModule);

        return GovernanceHelper.ProposalRequest({
            targets: targets,
            values: values,
            signatures: signatures,
            calldatas: calldatas
        });
    }

    function updateAndVerifySupplyKink(
        Vm vm,
        string memory marketName,
        address cometProxy,
        ChainAddresses.ChainAddressesStruct memory chainAddresses,
        MarketUpdateContractsDeployer.DeployedContracts memory deployedContracts
    ) public {
        address configuratorProxy = chainAddresses.configuratorProxyAddress;
        address cometProxyAdminNew = deployedContracts.newCometProxyAdmin;
        address marketUpdateProposer = deployedContracts.marketUpdateProposer;
        uint256 oldSupplyKinkBeforeGovernorUpdate = CometWithExtendedAssetList(payable(cometProxy)).supplyKink();
        uint256 newSupplyKinkByGovernorTimelock = 300000000000000000;

        assertEq(MarketAdminPermissionChecker(deployedContracts.marketAdminPermissionChecker).marketAdmin(), deployedContracts.marketUpdateTimelock);

        GovernanceHelper.createProposalAndPass(
            vm,
            buildSetFactoryRequest(configuratorProxy, cometProxy),
            string(abi.encodePacked("Proposal to set a matching Comet factory for ", marketName, " Market"))
        );

        GovernanceHelper.createProposalAndPass(
            vm,
            buildSetLiquidationModuleRequest(configuratorProxy, cometProxy),
            string(abi.encodePacked("Proposal to set a liquidation module for ", marketName, " Market"))
        );

        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        string[] memory signatures = new string[](2);
        bytes[] memory calldatas = new bytes[](2);
        string memory description = string(abi.encodePacked("Proposal to update Supply Kink for ", marketName, " Market by Governor Timelock"));

        targets[0] = configuratorProxy;
        signatures[0] = "setSupplyKink(address,uint64)";
        calldatas[0] = abi.encode(cometProxy, newSupplyKinkByGovernorTimelock);

        targets[1] = cometProxyAdminNew;
        signatures[1] = "deployAndUpgradeTo(address,address)";
        calldatas[1] = abi.encode(configuratorProxy, cometProxy);

        GovernanceHelper.ProposalRequest memory proposalRequest = GovernanceHelper.ProposalRequest({
            targets: targets,
            values: values,
            signatures: signatures,
            calldatas: calldatas
        });

        GovernanceHelper.createProposalAndPass(vm, proposalRequest, description);

        // check the new kink value
        uint256 newSupplyKinkAfterGovernorUpdate = CometWithExtendedAssetList(payable(cometProxy)).supplyKink();
        assert(newSupplyKinkAfterGovernorUpdate == newSupplyKinkByGovernorTimelock);

        // Setting new Supply Kink using Market Admin
        uint256 oldSupplyKinkBeforeMarketAdminUpdate = CometWithExtendedAssetList(payable(cometProxy)).supplyKink();
        uint256 newSupplyKinkByMarketAdmin = 400000000000000000;

        assert(oldSupplyKinkBeforeMarketAdminUpdate != newSupplyKinkByMarketAdmin);

        GovernanceHelper.createProposalAndPass(
            vm,
            buildSetLiquidationModuleRequest(configuratorProxy, cometProxy),
            string(abi.encodePacked("Proposal to set a fresh liquidation module for ", marketName, " Market"))
        );

        calldatas[0] = abi.encode(cometProxy, newSupplyKinkByMarketAdmin);

        description = string(abi.encodePacked("Proposal to update Supply Kink for ", marketName, " Market by Market Admin"));
        GovernanceHelper.createAndPassMarketUpdateProposal(vm, chainAddresses.marketAdmin, proposalRequest, description, marketUpdateProposer);

        uint256 newSupplyKinkAfterMarketAdminUpdate = CometWithExtendedAssetList(payable(cometProxy)).supplyKink();
        assert(newSupplyKinkAfterMarketAdminUpdate == newSupplyKinkByMarketAdmin);
    }

    function updateAndVerifySupplyKinkInL2(
        Vm vm,
        string memory marketName,
        ChainAddresses.Chain chain,
        address cometProxy,
        MarketUpdateContractsDeployer.DeployedContracts memory deployedContracts
    ) public {

        ChainAddresses.ChainAddressesStruct memory chainAddresses = ChainAddresses.getChainAddresses(chain);

        address configuratorProxy = chainAddresses.configuratorProxyAddress;
        address cometProxyAdminNew = deployedContracts.newCometProxyAdmin;
        address marketUpdateProposer = deployedContracts.marketUpdateProposer;

        uint256 oldSupplyKinkBeforeGovernorUpdate = CometWithExtendedAssetList(payable(cometProxy)).supplyKink();
        uint256 newSupplyKinkByGovernorTimelock = 300000000000000000;

        assert(oldSupplyKinkBeforeGovernorUpdate != newSupplyKinkByGovernorTimelock);

        BridgeHelper.simulateMessageAndExecuteProposal(
            vm,
            chain,
            MarketUpdateAddresses.GOVERNOR_BRAVO_TIMELOCK_ADDRESS,
            buildSetFactoryRequest(configuratorProxy, cometProxy)
        );

        BridgeHelper.simulateMessageAndExecuteProposal(
            vm,
            chain,
            MarketUpdateAddresses.GOVERNOR_BRAVO_TIMELOCK_ADDRESS,
            buildSetLiquidationModuleRequest(configuratorProxy, cometProxy)
        );

        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        string[] memory signatures = new string[](2);
        bytes[] memory calldatas = new bytes[](2);
        string memory description = string(abi.encodePacked("Proposal to update Supply Kink for ", marketName, " Market by Governor Timelock"));

        targets[0] = configuratorProxy;
        signatures[0] = "setSupplyKink(address,uint64)";
        calldatas[0] = abi.encode(cometProxy, newSupplyKinkByGovernorTimelock);

        targets[1] = cometProxyAdminNew;
        signatures[1] = "deployAndUpgradeTo(address,address)";
        calldatas[1] = abi.encode(configuratorProxy, cometProxy);

        GovernanceHelper.ProposalRequest memory proposalRequest = GovernanceHelper.ProposalRequest({
            targets: targets,
            values: values,
            signatures: signatures,
            calldatas: calldatas
        });

        BridgeHelper.simulateMessageAndExecuteProposal(vm, chain, MarketUpdateAddresses.GOVERNOR_BRAVO_TIMELOCK_ADDRESS, proposalRequest);

        // check the new kink value
        uint256 newSupplyKinkAfterGovernorUpdate = CometWithExtendedAssetList(payable(cometProxy)).supplyKink();
        assert(newSupplyKinkAfterGovernorUpdate == newSupplyKinkByGovernorTimelock);

        // Setting new Supply Kink using Market Admin
        uint256 oldSupplyKinkBeforeMarketAdminUpdate = CometWithExtendedAssetList(payable(cometProxy)).supplyKink();
        uint256 newSupplyKinkByMarketAdmin = 400000000000000000;

        assert(oldSupplyKinkBeforeMarketAdminUpdate != newSupplyKinkByMarketAdmin);

        BridgeHelper.simulateMessageAndExecuteProposal(
            vm,
            chain,
            MarketUpdateAddresses.GOVERNOR_BRAVO_TIMELOCK_ADDRESS,
            buildSetLiquidationModuleRequest(configuratorProxy, cometProxy)
        );

        calldatas[0] = abi.encode(cometProxy, newSupplyKinkByMarketAdmin);

        description = string(abi.encodePacked("Proposal to update Supply Kink for ", marketName, " Market by Market Admin"));
        GovernanceHelper.createAndPassMarketUpdateProposalL2(vm, chainAddresses.marketAdmin, proposalRequest, description, marketUpdateProposer);

        uint256 newSupplyKinkAfterMarketAdminUpdate = CometWithExtendedAssetList(payable(cometProxy)).supplyKink();
        assert(newSupplyKinkAfterMarketAdminUpdate == newSupplyKinkByMarketAdmin);
    }
}
