// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Compound's Comet Math Contract
 * @dev Pure math functions
 * @author Compound
 */
contract CometMath {
    /// @dev The scale for factors
    uint64 internal constant FACTOR_SCALE = 1e18;

    /** Custom errors **/

    error InvalidUInt64();
    error InvalidUInt104();
    error InvalidUInt128();
    error InvalidInt104();
    error InvalidInt256();
    error NegativeNumber();

    function safe64(uint n) internal pure returns (uint64) {
        if (n > type(uint64).max) revert InvalidUInt64();
        return uint64(n);
    }

    function safe104(uint n) internal pure returns (uint104) {
        if (n > type(uint104).max) revert InvalidUInt104();
        return uint104(n);
    }

    function safe128(uint n) internal pure returns (uint128) {
        if (n > type(uint128).max) revert InvalidUInt128();
        return uint128(n);
    }

    function signed104(uint104 n) internal pure returns (int104) {
        if (n > uint104(type(int104).max)) revert InvalidInt104();
        return int104(n);
    }

    function signed256(uint256 n) internal pure returns (int256) {
        if (n > uint256(type(int256).max)) revert InvalidInt256();
        return int256(n);
    }

    function unsigned104(int104 n) internal pure returns (uint104) {
        if (n < 0) revert NegativeNumber();
        return uint104(n);
    }

    function unsigned256(int256 n) internal pure returns (uint256) {
        if (n < 0) revert NegativeNumber();
        return uint256(n);
    }

    function toUInt8(bool x) internal pure returns (uint8) {
        return x ? 1 : 0;
    }

    function toBool(uint8 x) internal pure returns (bool) {
        return x != 0;
    }

    /**
     * @dev Multiply a `fromScale` quantity by a price, returning a common price quantity
     */
    function mulPrice(uint256 n, uint256 price, uint64 fromScale) internal pure returns (uint256) {
        return n * price / fromScale;
    }

    /**
     * @dev Multiply a number by a factor
     */
    function mulFactor(uint256 n, uint256 factor) internal pure returns (uint256) {
        return n * factor / FACTOR_SCALE;
    }

    /**
     * @dev Divide a common price quantity by a price, returning a `toScale` quantity
     */
    function divPrice(uint256 n, uint256 price, uint64 toScale) internal pure returns (uint256) {
        return n * toScale / price;
    }

    /**
     * @dev Multiply a signed `fromScale` quantity by a price, returning a common price quantity
     */
    function signedMulPrice(int256 n, uint256 price, uint64 fromScale) internal pure returns (int256) {
        return n * signed256(price) / int256(uint256(fromScale));
    }

    /**
     * @dev Whether user has a non-zero balance of an asset, given assetsIn flags
     * @dev _reserved is used to check bits 16-23 of assetsIn
     */
    function isInAsset(uint16 assetsIn, uint8 assetOffset, uint8 _reserved) internal pure returns (bool) {
        if (assetOffset < 16) {
            // check bit in assetsIn (for bits 0-15)
            return (assetsIn & (uint16(1) << assetOffset)) != 0;
        } else if (assetOffset < 24) {
            // check bit in reserved (for bits 16-23)
            return (_reserved & (uint8(1) << (assetOffset - 16))) != 0;
        }
        return false; // if assetOffset >= 24 (should not happen)
    }
}
