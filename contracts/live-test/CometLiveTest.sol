// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "../CometWithExtendedAssetList.sol";

/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                                                                         │
 * │   ⚠️  TEST INSTANCE ONLY — DO NOT DEPOSIT REAL FUNDS  ⚠️               │
 * │                                                                         │
 * │   This Comet is deployed exclusively for live, on-chain testing of      │
 * │   protocol features. It carries no guarantees whatsoever: it may be     │
 * │   upgraded, paused, drained, or abandoned at any moment without notice. │
 * │   Any assets supplied here should be considered permanently at risk and │
 * │   potentially unrecoverable. NEVER deposit funds you are not ready to   │
 * │   lose.                                                                 │
 * │                                                                         │
 * │   The DAO has NO control whatsoever over these Comets: no governance,   │
 * │   no pause, no recovery, no upgrades.                                   │
 * │                                                                         │
 * │   The same applies to EVERY Comet deployed from this instance: none of  │
 * │   them are for production use, and users should never deposit into them.│
 * │                                                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * @title CometLiveTest
 * @author Woof
 * @notice A test-only Comet instance. See the banner above: real funds must
 *         never be deposited into this market.
 * @dev Inherits the full behaviour of {CometWithExtendedAssetList} and only adds
 *      an immutable {testingPurpose} description that records why
 *      this test instance exists / which feature is currently being exercised.
 */
contract CometLiveTest is CometWithExtendedAssetList {
    /// @notice Description signalling that this Comet is a testing instance and
    ///         indicating which feature is currently under test.
    bytes32 internal immutable testingPurpose32;

    /**
     * @notice Construct a test-only Comet instance.
     * @param config The mapping of initial/constant parameters (see {CometWithExtendedAssetList}).
     * @param testingPurpose32_ Description of the feature under test, as a zero-padded
     **/
    constructor(Configuration memory config, bytes32 testingPurpose32_)
        CometWithExtendedAssetList(config)
    {
        testingPurpose32 = testingPurpose32_;
    }

    /**
     * @notice Get the description of this test instance's purpose
     * @return The testing purpose as a string
     */
    function testingPurpose() external view returns (string memory) {
        uint8 i;
        for (i = 0; i < 32; ) {
            if (testingPurpose32[i] == 0) {
                break;
            }
            unchecked { i++; }
        }
        bytes memory testingPurpose_ = new bytes(i);
        for (uint8 j = 0; j < i; ) {
            testingPurpose_[j] = testingPurpose32[j];
            unchecked { j++; }
        }
        return string(testingPurpose_);
    }
}