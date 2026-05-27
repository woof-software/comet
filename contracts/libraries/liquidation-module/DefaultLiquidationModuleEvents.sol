// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

library DefaultLiquidationModuleEvents {
    event AbsorbDebt(address indexed absorber, address indexed borrower, uint basePaidOut, uint usdValue);
    
    event AbsorbCollateral(address indexed absorber, address indexed borrower, address indexed asset, uint collateralAbsorbed, uint usdValue);
}