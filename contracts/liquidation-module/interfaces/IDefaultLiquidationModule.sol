// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

interface IDefaultLiquidationModule {
    function liquidate(address absorber, address account) external;
}