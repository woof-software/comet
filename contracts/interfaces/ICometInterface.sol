// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { ICometData } from "./ICometData.sol";

/**
 * @title Comet integration interface
 * @author Woof
 * @notice Comet interface for external integration purposes.
 * @custom:security-contact dmitriy@woof.software
 */
interface ICometInterface {
    function governor() external view returns (address);

    function baseToken() external view returns (address);
    function baseTokenPriceFeed() external view returns (address);
    // @dev uint64
    function baseScale() external view returns (uint256);

    function assetList() external view returns (address);
    function numAssets() external view returns (uint8);

    function baseBorrowMin() external view returns (uint256);

    function userBasic(address account) external view returns (ICometData.UserBasic memory);
    function userCollateral(address account, address asset) external view returns (ICometData.UserCollateral memory);

    function accrueAccount(address account) external;
    function presentValue(int104 principalValue_) external view returns (int256);

    function isAbsorbPaused() external view returns (bool);
}
