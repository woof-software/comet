// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./CometWithExtendedAssetList.sol";

/**
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * |   Market-specific terms apply. Review the                                                │
 * │   Institutional Market Supplemental Terms:                                               │
 * │   https://www.compound.xyz/terms-of-service#usdc-institutional-market-terms-of-service   │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * @title InstitutionalComet
 * @author Woof
 * @dev Inherits the full behaviour of {CometWithExtendedAssetList}
 */
contract InstitutionalComet is CometWithExtendedAssetList {
    /**
     * @notice Construct a new Institutional Comet instance
     **/
    constructor(Configuration memory config) CometWithExtendedAssetList(config) {}
}
