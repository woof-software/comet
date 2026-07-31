// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "../vendor/@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";

/**
 * @title PriceFeedLiveTest
 * @notice A TEST-ONLY price feed for live, on-chain testing. It either passes
 *         prices straight through from a real source feed, or serves a
 *         hand-set constant price — toggled at runtime by an authorized admin.
 * @dev NOT for production use. Because the constant price is arbitrary and set
 *      by a role holder, any market wired to this feed can be manipulated at
 *      will; never point a production Comet at it.
 *
 *      Implements the full Chainlink {AggregatorV3Interface} (both
 *      `getRoundData` and `latestRoundData`). In constant mode `startedAt` /
 *      `updatedAt` are always reported as `block.timestamp`, so the feed never
 *      appears stale to any staleness check.
 * @author Woof
 */
contract PriceFeedLiveTest is AggregatorV3Interface, AccessControl {
    uint256 public constant override version = 1;
    uint8 public immutable override decimals;
    AggregatorV3Interface public immutable sourcePriceFeed;

    /// @notice When true, prices are fetched from {sourcePriceFeed}; when false,
    ///         the hand-set {constantPrice} is served instead
    bool public useSourceFeed;
    /// @notice The constant price served while source mode is off
    int256 public constantPrice;
    /// @notice Monotonic round id for the constant-price mode, bumped on every {setPrice}
    uint80 internal constantRoundId;
    /// @notice Description and testing purpose of price feed
    string public description;

    /// @notice Thrown when passed values is equal to already stored one
    error SameValue();
    /// @notice Emitted when the constant price is updated
    event PriceSet(int256 price);
    /// @notice Emitted when the price source mode is toggled
    event SourceFeedModeSet(bool useSourceFeed);

    constructor(address sourcePriceFeed_, uint8 decimals_, address admin_, string memory description_) {
        sourcePriceFeed = AggregatorV3Interface(sourcePriceFeed_);
        decimals = decimals_;
        useSourceFeed = true;
        description = description_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    /**
     * @notice Set the constant price served while source mode is off
     * @param price_ The new constant price, in this feed's {decimals}
     **/
    function setPrice(int256 price_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (price_ == constantPrice) revert SameValue();
        constantPrice = price_;
        unchecked { constantRoundId++; }
        emit PriceSet(price_);
    }

    /**
     * @notice Toggle between the source feed and the constant price
     * @param useSourceFeed_ True to pass through {sourcePriceFeed}, false to serve {constantPrice}
     **/
    function setUseSourceFeed(bool useSourceFeed_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (useSourceFeed_ == useSourceFeed) revert SameValue();
        useSourceFeed = useSourceFeed_;
        emit SourceFeedModeSet(useSourceFeed_);
    }

    /**
     * @notice Price data for a specific round
     * @dev In source mode this is proxied to the underlying feed. In constant
     *      mode the requested round is echoed back with the current constant
     *      price and a fresh (non-stale) timestamp.
     **/
    function getRoundData(uint80 roundId_) external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        if (useSourceFeed) {
            return sourcePriceFeed.getRoundData(roundId_);
        }
        return (roundId_, constantPrice, block.timestamp, block.timestamp, roundId_);
    }

    /**
     * @notice Price data for the latest round
     * @dev In source mode this is proxied to the underlying feed. In constant
     *      mode the current constant price is returned with a fresh (non-stale)
     *      timestamp, so it satisfies any staleness check.
     **/
    function latestRoundData() external view override returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        if (useSourceFeed) {
            return sourcePriceFeed.latestRoundData();
        }
        return (constantRoundId, constantPrice, block.timestamp, block.timestamp, constantRoundId);
    }
}
