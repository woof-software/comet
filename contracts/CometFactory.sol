// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./Comet.sol";
import "./configurator/CometConfigurationIntermediate.sol";

contract CometFactory is CometConfigurationIntermediate {
    function clone(Configuration calldata config) external returns (address) {
        return address(new Comet(config));
    }
}