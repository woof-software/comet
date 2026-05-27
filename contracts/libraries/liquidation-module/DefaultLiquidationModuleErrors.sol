// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

library DefaultLiquidationModuleErrors {
    error Unauthorized();
    error NotLiquidatable();
    error BadPrice();
    error TokenIsDeactivated(address asset);
}