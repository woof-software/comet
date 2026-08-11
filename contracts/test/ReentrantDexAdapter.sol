// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

interface IReentrantAttacker {
    function attack() external;
}

/**
 * @title ReentrantDexAdapter
 * @notice TEST-ONLY malicious DEX adapter used to reproduce audit finding M-02 (liquidation reentrancy).
 *         `swap` is the window where the real adapter hands control to an externally-controlled 1inch
 *         executor; here it simply calls back into an attacker contract that reenters Comet, then reports
 *         the swap as successful. It matches the ICoreDexAdapter surface the LiquidationModule calls
 *         (by selector) without importing the interface. NOT FOR PRODUCTION.
 */
contract ReentrantDexAdapter {
    address public comet;
    IReentrantAttacker public attacker;

    function setAttacker(IReentrantAttacker attacker_) external {
        attacker = attacker_;
    }

    // ── ICoreDexAdapter surface (no-ops except swap) ──
    function initiateAdapter(address comet_) external {
        comet = comet_;
    }

    function setAssetList(address, uint8, address) external {}

    function setSlippageBps(uint16, address) external {}

    /// @dev Reenters Comet through the attacker mid-swap, then reports the swap as successful.
    function swap(address, uint256, bytes calldata) external returns (bool swapped) {
        if (address(attacker) != address(0)) attacker.attack();
        return true;
    }
}
