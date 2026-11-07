// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.34;

interface IUSDC {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title Polygon Reserves Transfer
 * @notice Moves the Polygon cUSDCv3 reserves, bridged to Mainnet by the Safe, from the Safe to the Mainnet Timelock once
 * @dev The Safe approves this contract for AMOUNT USDC through a governance proposal
 */
contract PolygonReservesTransfer {
    error AlreadyTransferred();
    error TransferFailed();


    address public constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address public constant SAFE = 0xD28d21422f5fA74E3d4414626c774bDA274b7Ca9;
    address public constant TIMELOCK = 0x6d903f6003cca6255D85CcA4D3B5E5146dC33925;
    uint256 public constant AMOUNT = 470_000e6;

    bool public transferred;

    /// @notice Transfers AMOUNT USDC from the Safe to the Timelock; callable by anyone, once
    function transfer() external {
        if (transferred) revert AlreadyTransferred();
        transferred = true;

        if (!IUSDC(USDC).transferFrom(SAFE, TIMELOCK, AMOUNT)) revert TransferFailed();
    }
}
