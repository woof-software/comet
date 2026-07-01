// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @dev ERC-20 whose transfer/transferFrom return 16 bytes — neither 0 nor 32.
 * Triggers the `default { revert(0, 0) }` branch in the Bulker's doTransferOut / doTransferIn
 * assembly switch on returndatasize().
 */
contract WrongLengthReturnToken {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function transfer(address, uint256) external pure {
        assembly {
            mstore(0, 1)
            return(0, 16)
        }
    }

    function transferFrom(address, address, uint256) external pure {
        assembly {
            mstore(0, 1)
            return(0, 16)
        }
    }
}
