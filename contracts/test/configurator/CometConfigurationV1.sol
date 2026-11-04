// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "../../migration/CometConfigurationIntermediate.sol";

/**
 * @title Compound's Comet Configuration Interface, V1 copy
 * @dev The configuration of ConfiguratorV1, for testing the upgrade path (ConfiguratorV1 -> ConfiguratorIntermediate -> Configurator).
 *      V1 and Intermediate have the same structs, so this inherits them instead of copying: a copy would be a
 *      different type, and ConfiguratorV1 could no longer pass its Configuration to the CometFactory both use
 * @author Compound
 */
contract CometConfigurationV1 is CometConfigurationIntermediate {}
