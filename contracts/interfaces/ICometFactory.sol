// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { CometConfiguration } from "../CometConfiguration.sol";

/**
 * @title Compound's Comet Factory Interface
 * @notice Deploys new Comet implementations
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface ICometFactory {
    /**
     * @notice Deploys a new Comet implementation from a configuration
     * @param config The configuration of the new Comet implementation
     * @return The address of the new Comet implementation
     */
    function clone(CometConfiguration.Configuration calldata config) external returns (address);
}
