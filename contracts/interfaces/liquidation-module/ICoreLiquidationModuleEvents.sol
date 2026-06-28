// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

/**
 * @title Core Liquidation Module Events
 * @author Woof
 * @notice Interface of events emitted by the DefaultLiquidationModule.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICoreLiquidationModuleEvents {
    /**
     * @notice Emitted when a borrower's base debt is absorbed during liquidation.
     * @param absorber The recipient of the liquidation incentive. Defined by the caller, not msg.sender.
     * @param borrower The liquidated account whose debt is absorbed.
     * @param basePaidOut The amount of base debt cleared from the borrower.
     * @param usdValue The USD value of the cleared base debt.
     */
    event AbsorbDebt(
        address indexed absorber,
        address indexed borrower,
        uint256 basePaidOut, 
        uint256 usdValue
    );

    /**
     * @notice Emitted when a borrower's collateral is absorbed during liquidation.
     * @param absorber The recipient of the liquidation incentive. Defined by the caller, not msg.sender.
     * @param borrower The liquidated account whose collateral is absorbed.
     * @param asset The collateral asset absorbed from the borrower.
     * @param collateralAbsorbed The amount of collateral absorbed.
     * @param usdValue The USD value of the absorbed collateral.
     */
    event AbsorbCollateral(
        address indexed absorber,
        address indexed borrower,
        address indexed asset,
        uint256 collateralAbsorbed,
        uint256 usdValue
    );
}
