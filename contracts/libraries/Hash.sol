// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Hash
 * @notice Typed hashing of configs, so a stored hash can tell whether a config changed
 * @dev Works for any config type: the caller passes its own type hash and the config ABI-encoded with `abi.encode`.
 *      The type hash keeps configs of different types apart even when their bytes are equal.
 *      Never pass `abi.encodePacked` output: packed encoding is ambiguous and two configs could share a hash.
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
library Hash {
    /**
     * @dev Hashes an encoded config under a type hash
     * @param typeHash The hash identifying the config type
     * @param encoded The config, ABI-encoded with `abi.encode`
     * @return The config hash
     */
    function hash(bytes32 typeHash, bytes memory encoded) internal pure returns (bytes32) {
        // The type hash has a fixed length, so joining it with the encoded config cannot be read two ways
        return keccak256(bytes.concat(typeHash, encoded));
    }

    /**
     * @dev Checks whether an encoded config hashes to the expected hash, meaning the config is unchanged
     * @param expected The hash to compare with, which must come from a trusted source such as a deployed contract
     * @param typeHash The hash identifying the config type
     * @param encoded The config, ABI-encoded with `abi.encode`
     * @return True if the config hashes to `expected`
     */
    function verify(bytes32 expected, bytes32 typeHash, bytes memory encoded) internal pure returns (bool) {
        return hash(typeHash, encoded) == expected;
    }
}
