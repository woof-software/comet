// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "../Configurator.sol";

/**
 * @title ICometFactoryV2LiveTest
 * @notice Minimal interface for the external live-test Comet factory. 
 */
interface ICometFactoryV2LiveTest {
    function clone(CometConfiguration.Configuration calldata config, bytes32 testingPurpose) external returns (address);
}

/**
 * @title ConfiguratorLiveTest
 * @author Woof
 * @notice Test-only Configurator variant. Extends {Configurator} with a per-Comet {testingPurpose}
 *         that is forwarded to the live-test factory's `clone(Configuration,bytes32)` when deploying a
 *         {CometLiveTest}. Real funds must never be deposited into markets deployed through this
 *         Configurator (see the banner in {CometLiveTest}).
 * @dev The base {Configurator.deploy} is left untouched; live-test deploys go through {deployLiveTest}.
 */
contract ConfiguratorLiveTest is Configurator {
    /// @notice Emitted when the testing purpose for a Comet proxy is updated.
    /// @param cometProxy The Comet proxy whose testing purpose was updated.
    /// @param oldTestingPurpose The previous testing purpose.
    /// @param newTestingPurpose The new testing purpose.
    event SetTestingPurpose(address indexed cometProxy, bytes32 oldTestingPurpose, bytes32 newTestingPurpose);

    /// @notice Mapping of Comet proxy addresses to the testing purpose forwarded to the factory on deploy.
    mapping(address => bytes32) public testingPurposePerComet;

    function setTestingPurpose(address cometProxy, bytes32 testingPurpose) external {
        if (msg.sender != governor) revert Unauthorized();

        bytes32 oldTestingPurpose = testingPurposePerComet[cometProxy];
        testingPurposePerComet[cometProxy] = testingPurpose;
        emit SetTestingPurpose(cometProxy, oldTestingPurpose, testingPurpose);
    }

    /**
     * @notice Deploy a new CometLiveTest implementation using the live-test factory, Configuration and
     *         testing purpose for that Comet proxy.
     * @dev Callable by anyone. Routes through {ICometFactoryV2LiveTest} so the Configuration is encoded
     *      against this branch's own struct definition.
     * @param cometProxy The Comet proxy whose configuration and testing purpose are used.
     * @return newComet The address of the newly deployed CometLiveTest implementation.
     */
    function deployLiveTest(address cometProxy) external returns (address newComet) {
        newComet = ICometFactoryV2LiveTest(factory[cometProxy]).clone(
            configuratorParams[cometProxy],
            testingPurposePerComet[cometProxy]
        );
        emit CometDeployed(cometProxy, newComet);
    }
}
