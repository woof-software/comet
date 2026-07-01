// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @dev Minimal mock of Lido wstETH.
 * stETH() returns a configurable address — set to a FalseReturnToken in UH-17 to
 * drive TransferInFailed through the Bulker's doTransferIn assembly handler.
 * wrap() is a stub; it is never reached because doTransferIn reverts first.
 */
contract MockWstETH {
    address private _steth;

    constructor(address steth_) {
        _steth = steth_;
    }

    function stETH() external view returns (address) {
        return _steth;
    }

    function wrap(uint256) external pure returns (uint256) {
        return 0;
    }
}
