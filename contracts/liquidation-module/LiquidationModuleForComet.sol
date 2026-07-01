// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { LiquidationModule } from "./LiquidationModule.sol";
import { ICometInterface } from "../interfaces/ICometInterface.sol";
import { ICoreDexAdapter } from "../interfaces/dex-adapters/ICoreDexAdapter.sol";
import { IAssetList } from "../IAssetList.sol";

/**
 * @title Liquidation Module (for existing Comet)
 * @author Woof
 * @notice Extends DefaultLiquidationModule with a DEX-based liquidation path gated by
 *         configurable health factor boundaries. Is used for already deployed Comet
 * @custom:security-contact dmitriy@woof.software
 */
contract LiquidationModuleForComet is LiquidationModule {
    /**
     * @param dexAdapter_       The address of the DEX adapter for DEX-based liquidation.
     * @param multisig_         The Multisig address: controls parameter setters.
     * @param executors_        Initial set of Executor accounts (keeper liquidation callers).
     * @param pausers_          Initial set of Pauser accounts (DEX pause switch).
     * @param incentiveBps_     Initial executor incentive (in BPS) taken on the DEX route.
     * @param comet_            Existing Comet to be attached to
     * @param assetList_        Existing AssetList to be attached to
     */
    constructor(
        ICoreDexAdapter dexAdapter_,
        address multisig_,
        address[] memory executors_,
        address[] memory pausers_,
        uint16 incentiveBps_,
        address comet_,
        address assetList_
    ) LiquidationModule(dexAdapter_, multisig_, executors_, pausers_, incentiveBps_) {
        if (comet_ == address(0) || assetList_ == address(0)) revert ZeroAddress();
        comet = ICometInterface(comet_);

        initiateModule(assetList_, IAssetList(assetList_).numAssets(), uint64(comet.baseScale()), comet.baseToken());
    }
}
