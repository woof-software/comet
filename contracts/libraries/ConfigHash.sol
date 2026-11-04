// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import { IConfigHash } from "../interfaces/IConfigHash.sol";

/**
 * @title ConfigHash
 * @notice Typed hashing of configs, so a stored hash can tell whether a config changed
 * @dev Works for any config type: the caller passes its own type hash and the config ABI-encoded with `abi.encode`.
 *      The type hash keeps configs of different types apart even when their bytes are equal.
 *      Never pass `abi.encodePacked` output: packed encoding is ambiguous and two configs could share a hash.
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
library ConfigHash {
    /**
     * @dev Hashes an encoded config under a type hash
     * @param typeHash The hash identifying the config type
     * @param encoded The config, ABI-encoded with `abi.encode`
     * @return The config hash
     */
    function hashConfig(bytes32 typeHash, bytes memory encoded) internal pure returns (bytes32) {
        // The type hash has a fixed length, so joining it with the encoded config cannot be read two ways
        return keccak256(bytes.concat(typeHash, encoded));
    }

    /**
     * @dev Checks whether a new config is the one a deployed contract was built from, meaning no redeploy is needed
     * @param target The deployed contract to compare with, which must implement IConfigHash and come from a trusted source
     * @param newConfig The new config, ABI-encoded with `abi.encode`
     * @return True if the new config hashes to the target's configHash
     */
    function areHashesEqual(address target, bytes memory newConfig) internal view returns (bool) {
        return hashConfig(IConfigHash(target).TYPEHASH(), newConfig) == IConfigHash(target).configHash();
    }
}
