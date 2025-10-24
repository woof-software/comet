// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "./CometCore.sol";

/**
 * @title Compound's Comet Ext Interface
 * @notice An efficient monolithic money market protocol
 * @author Compound
 */
abstract contract CometExtInterface is CometCore {
    error BadAmount();
    error BadNonce();
    error BadSignatory();
    error InvalidValueS();
    error InvalidValueV();
    error SignatureExpired();
    error OnlyPauseGuardianOrGovernor();
    error OffsetStatusAlreadySet(uint24 offset, bool status);
    error CollateralAssetOffsetStatusAlreadySet(uint24 offset, uint24 assetIndex, bool status);
    error InvalidAssetIndex();

    function allow(address manager, bool isAllowed) virtual external;
    function allowBySig(address owner, address manager, bool isAllowed, uint256 nonce, uint256 expiry, uint8 v, bytes32 r, bytes32 s) virtual external;

    // Pause control functions
    function pauseLendersWithdraw(bool paused) virtual external;
    function pauseBorrowersWithdraw(bool paused) virtual external;
    function pauseCollateralWithdraw(bool paused) virtual external;
    function pauseCollateralAssetWithdraw(uint24 assetIndex, bool paused) virtual external;

    function pauseCollateralSupply(bool paused) virtual external;
    function pauseBaseSupply(bool paused) virtual external;
    function pauseCollateralAssetSupply(uint24 assetIndex, bool paused) virtual external;

    function pauseLendersTransfer(bool paused) virtual external;
    function pauseBorrowersTransfer(bool paused) virtual external;
    function pauseCollateralTransfer(bool paused) virtual external;
    function pauseCollateralAssetTransfer(uint24 assetIndex, bool paused) virtual external;

    function collateralBalanceOf(address account, address asset) virtual external view returns (uint128);
    function baseTrackingAccrued(address account) virtual external view returns (uint64);

    function baseAccrualScale() virtual external view returns (uint64);
    function baseIndexScale() virtual external view returns (uint64);
    function factorScale() virtual external view returns (uint64);
    function priceScale() virtual external view returns (uint64);

    function maxAssets() virtual external view returns (uint8);

    function totalsBasic() virtual external view returns (TotalsBasic memory);

    function version() virtual external view returns (string memory);

    /**
      * ===== ERC20 interfaces =====
      * Does not include the following functions/events, which are defined in `CometMainInterface` instead:
      * - function decimals() virtual external view returns (uint8)
      * - function totalSupply() virtual external view returns (uint256)
      * - function transfer(address dst, uint amount) virtual external returns (bool)
      * - function transferFrom(address src, address dst, uint amount) virtual external returns (bool)
      * - function balanceOf(address owner) virtual external view returns (uint256)
      * - event Transfer(address indexed from, address indexed to, uint256 amount)
      */
    function name() virtual external view returns (string memory);
    function symbol() virtual external view returns (string memory);

    /**
      * @notice Approve `spender` to transfer up to `amount` from `src`
      * @dev This will overwrite the approval amount for `spender`
      *  and is subject to issues noted [here](https://eips.ethereum.org/EIPS/eip-20#approve)
      * @param spender The address of the account which may transfer tokens
      * @param amount The number of tokens that are approved (-1 means infinite)
      * @return Whether or not the approval succeeded
      */
    function approve(address spender, uint256 amount) virtual external returns (bool);

    /**
      * @notice Get the current allowance from `owner` for `spender`
      * @param owner The address of the account which owns the tokens to be spent
      * @param spender The address of the account which may transfer tokens
      * @return The number of tokens allowed to be spent (-1 means infinite)
      */
    function allowance(address owner, address spender) virtual external view returns (uint256);

    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event LendersWithdrawPauseAction(bool lendersWithdrawPaused);
    event BorrowersWithdrawPauseAction(bool borrowersWithdrawPaused);
    event CollateralWithdrawPauseAction(bool collateralWithdrawPaused);
    event CollateralAssetWithdrawPauseAction(uint24 assetIndex, bool collateralAssetWithdrawPaused);
    event CollateralSupplyPauseAction(bool collateralSupplyPaused);
    event CollateralAssetSupplyPauseAction(uint24 assetIndex, bool collateralAssetSupplyPaused);
    event LendersSupplyPauseAction(bool lendersSupplyPaused);
    event BorrowersSupplyPauseAction(bool borrowersSupplyPaused);
    event LendersTransferPauseAction(bool lendersTransferPaused);
    event BorrowersTransferPauseAction(bool borrowersTransferPaused);
    event CollateralTransferPauseAction(bool collateralTransferPaused);
    event CollateralAssetTransferPauseAction(uint24 assetIndex, bool collateralAssetTransferPaused);
}