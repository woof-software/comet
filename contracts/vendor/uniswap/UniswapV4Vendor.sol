// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

// Minimal, ABI-compatible vendored declarations of the Uniswap V4 types/interfaces used by the
// DEX adapters.

/// @notice An ERC-20 (or native) currency, represented by its address. Matches Uniswap's
///         `type Currency is address` so `Currency.wrap`/`unwrap` and ABI encoding are identical.
type Currency is address;

/// @notice Placeholder for the hooks contract stored in a pool key. Only the type (an address slot)
///         is needed by the adapters; none of its methods are called.
interface IHooks {}

/// @notice Returns the key for identifying a pool
struct PoolKey {
    /// @notice The lower currency of the pool, sorted numerically
    Currency currency0;
    /// @notice The higher currency of the pool, sorted numerically
    Currency currency1;
    /// @notice The pool LP fee, capped at 1_000_000. If the highest bit is 1, the pool has a dynamic fee and must be exactly equal to 0x800000
    uint24 fee;
    /// @notice Ticks that involve positions must be a multiple of tick spacing
    int24 tickSpacing;
    /// @notice The hooks of the pool
    IHooks hooks;
}

/// @notice Parameters for a single-pool exact-input swap.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

/// @notice A single hop in a multi-hop path: the currency to swap into next and the parameters
///         (fee, tick spacing, hooks) of the pool used to reach it.
struct PathKey {
    Currency intermediateCurrency;
    uint24 fee;
    int24 tickSpacing;
    IHooks hooks;
    bytes hookData;
}

/// @notice Parameters for a multi-hop exact-input swap.
struct ExactInputParams {
    Currency currencyIn;
    PathKey[] path;
    uint128 amountIn;
    uint128 amountOutMinimum;
}

/// @notice Minimal interface for the Uniswap V4 router used by the redundant DEX adapter.
interface IUniversalRouter {
    /// @notice Executes encoded commands against the router (UniversalRouter-style entrypoint).
    /// @param commands The encoded command bytes
    /// @param inputs The encoded inputs for each command
    /// @param deadline The deadline by which the transaction must execute
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}
