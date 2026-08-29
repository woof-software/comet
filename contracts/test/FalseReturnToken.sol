// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @dev ERC-20 whose transfer/transferFrom always return false.
 * Used to trigger TransferOutFailed / TransferInFailed in the Bulker's
 * doTransferOut / doTransferIn assembly handlers.
 */
contract FalseReturnToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
