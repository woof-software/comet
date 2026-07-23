// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./CometWithExtendedAssetList.sol";

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
    /// @notice Human-readable description signalling that this Comet is a testing
    ///         instance and indicating which feature is currently under test.
    string public testingPurpose;

    constructor(Configuration memory config, string memory testingPurpose_)
        CometWithExtendedAssetList(config)
    {
        testingPurpose = testingPurpose_;
    }
}