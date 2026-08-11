// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICoreLiquidationModuleErrors } from "./ICoreLiquidationModuleErrors.sol";

/**
 * @title Core Liquidation Module Interface
 * @author Woof
 * @notice Interface for the core liquidation module used by Comet.
 * @dev Function documentation is maintained in the module implementation contract.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICoreLiquidationModule is ICoreLiquidationModuleErrors {
    struct Seizure {
        address asset;
        uint8 index;
        uint256 seizedAmount;
        uint256 seizedValue;
        uint256 wantedCollateralValue;
    }

    function absorb(address absorber, address account) external;

    function isLiquidatable(address account) external view returns (bool);

    function seizurePlan(address account) external view returns (Seizure[] memory plan);

    function initiateModule(uint64 _baseScale) external;
    function setAssetList(address _assetList, uint8 _numAssets, address _baseToken) external;
}
