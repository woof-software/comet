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
     * @dev Checks whether a new config is the one a deployed contract was built from, meaning no redeploy is needed.
     *      A target without the IConfigHash getters (no contract yet, or one built before config hashing) has nothing
     *      to compare with, so it counts as changed. A contract has both getters or neither, so once configHash
     *      is found TYPEHASH is called directly
     * @param target The deployed contract to compare with, which must come from a trusted source
     * @param newConfig The new config, ABI-encoded with `abi.encode`
     * @return True if the target supports IConfigHash and the new config hashes to its configHash
     */
    function compareConfigHashes(address target, bytes memory newConfig) internal view returns (bool) {
        (bool found, bytes32 currentHash) = _trySupportsConfigHash(target);
        if (!found) return false;
        return hashConfig(IConfigHash(target).TYPEHASH(), newConfig) == currentHash;
    }

    /**
     * @dev Attempts to read `configHash` from a contract without reverting, the same way OpenZeppelin's
     *      ERC165Checker probes `supportsInterface`: a low-level static call with a gas cap, using only scratch space.
     *
     * It returns:
     *
     * * `found`: true if the call didn't revert and returned exactly one word; false for a contract without
     *   the getter, an address without code, or any other return data
     * * `value`: the returned config hash, or zero if not found
     */
    function _trySupportsConfigHash(address target) private view returns (bool found, bytes32 value) {
        bytes4 selector = IConfigHash.configHash.selector;

        assembly ("memory-safe") {
            mstore(0x00, selector)
            // The call must be its own statement: Yul evaluates arguments right to left, so inside one and(...)
            // returndatasize() would be read before the call has run
            let success := staticcall(30000, target, 0x00, 0x04, 0x00, 0x20)
            found := and(success, eq(returndatasize(), 0x20)) // exactly one word, so the copied value is the whole answer
            value := mul(mload(0x00), found) // zero unless found, even if the call wrote partial data
        }
    }
}
