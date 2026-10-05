// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

/**
 * @title Config Hash
 * @notice Shared getter for contracts built from a config whose hash is computed with the Hash library
 * @dev Every such contract exposes its hash under this one name, so any caller can read it the same way,
 *      e.g. to check with Hash.verify whether a new config differs and a redeploy is needed
 * @author Woof
 * @custom:security-contact dmitriy@woof.software
 */
interface IConfigHash {
    /// @notice The hash of the config this contract was built from
    function configHash() external view returns (bytes32);
}
