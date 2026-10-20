// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import {AggregatorV3Interface} from "../vendor/@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/**
 * @title ToggleRevertPriceFeed
 * @notice A TEST-ONLY price feed that either passes prices straight through
 *         from an underlying feed, or reverts — toggled by anyone.
 * @dev NOT for production use. The toggle is permissionless, so anyone can
 *      brick price reads of any market wired to this feed.
 */
contract ToggleRevertPriceFeed is AggregatorV3Interface {
    uint256 public constant override version = 1;
    uint8 public immutable override decimals;
    AggregatorV3Interface public immutable sourcePriceFeed;

    /// @notice When true, price reads revert; when false, they are proxied to {sourcePriceFeed}
    bool public shouldRevert;
    /// @notice Underlying feed's description suffixed with this feed's purpose
    string public override description;

    /// @notice Thrown on price reads while {shouldRevert} is on
    error Reverted();
    /// @notice Thrown when passed values is equal to already stored one
    error SameValue();
    /// @notice Emitted when the revert mode is toggled
    event ShouldRevertSet(bool shouldRevert);

    constructor(address sourcePriceFeed_) {
        sourcePriceFeed = AggregatorV3Interface(sourcePriceFeed_);
        decimals = AggregatorV3Interface(sourcePriceFeed_).decimals();
        shouldRevert = true;
        description = string.concat(AggregatorV3Interface(sourcePriceFeed_).description(), " Toggle revert price feed");
    }

    /**
     * @notice Toggle between reverting and passing through the source feed
     * @param shouldRevert_ True to revert on price reads, false to pass through {sourcePriceFeed}
     **/
    function setShouldRevert(bool shouldRevert_) external {
        if (shouldRevert_ == shouldRevert) revert SameValue();
        shouldRevert = shouldRevert_;
        emit ShouldRevertSet(shouldRevert_);
    }

    /**
     * @notice Price data for a specific round
     * @dev Reverts while {shouldRevert} is on, otherwise proxied to the underlying feed
     **/
    function getRoundData(uint80 roundId_) external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        if (shouldRevert) revert Reverted();
        return sourcePriceFeed.getRoundData(roundId_);
    }

    /**
     * @notice Price data for the latest round
     * @dev Reverts while {shouldRevert} is on, otherwise proxied to the underlying feed
     **/
    function latestRoundData() external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        if (shouldRevert) revert Reverted();
        return sourcePriceFeed.latestRoundData();
    }
}
