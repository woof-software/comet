// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { ILiquidationModule } from "../interfaces/liquidation-module/ILiquidationModule.sol";
import { ICoreDexAdapter } from "../interfaces/dex-adapters/ICoreDexAdapter.sol";

import { CoreLiquidationModule, ICometData, ICometLiquidationInterface } from "./CoreLiquidationModule.sol";

/**
 * @title Liquidation Module
 * @author Woof
 * @notice Extends DefaultLiquidationModule with a DEX-based liquidation path gated by
 *         configurable health factor boundaries.
 * @custom:security-contact dmitriy@woof.software
 */
contract LiquidationModule is ILiquidationModule, CoreLiquidationModule {
    using SafeERC20 for IERC20;

    /// @notice Basis-point denominator (100% = 10_000 bps).
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_PENALTY = 1_000; /// 10% as max allowed penalty

    /// @notice used for DEX-path liquidations. Zero address means module doesn't support DEX liquidation route.
    ICoreDexAdapter public immutable dexAdapter;

    /// @notice Executor penalty on the DEX route.
    uint256 public penaltyBps;

    /**
     * @param dexAdapter_       The address of the DEX adapter for DEX-based liquidation.
     * @param multisig_         The Multisig address: controls parameter setters.
     * @param executors_        Initial set of Executor accounts (keeper liquidation callers).
     * @param pausers_          Initial set of Pauser accounts (DEX pause switch).
     * @param penaltyBps_       Initial executor penalty (in BPS) taken on the DEX route.
     */
    constructor(
        ICoreDexAdapter dexAdapter_,
        address multisig_,
        address[] memory executors_,
        address[] memory pausers_,
        uint256 borderHF_,
        uint256 penaltyBps_
    ) CoreLiquidationModule(multisig_, executors_, pausers_) {
        if (address(dexAdapter_) == address(0)) revert ZeroAddress();
        if (penaltyBps_ > MAX_PENALTY) revert InvalidPenaltyBps();

        dexAdapter = dexAdapter_;
        penaltyBps = penaltyBps_;

        emit PenaltyBpsUpdated(0, penaltyBps_);
    }

    /**
     * @notice initialization method which will be called just once from the Comet during its costructio
     *         It is safe to assume that only comet will initiate the method, as otherwise Comet update proposal will revert
     *         in case if this method is called before proposal.
     */
    function initiateModule(address _assetList, uint8 _numAssets, uint64 _baseScale, address _baseToken) override public {
        super.initiateModule(_assetList, _numAssets, _baseScale, _baseToken);

        /// @dev msg.sender is expected to be a comet address
        dexAdapter.initiateAdapter(msg.sender, _assetList, _baseToken);
    }

    /**
     * @notice Routes a keeper liquidation to the appropriate path based on the account's current HF.
     * @dev Caller must be an Executor. While the DEX path is paused every call falls back to absorb.
     *
     *      HF = liquidityValue * FACTOR_SCALE / debtValue  (1e18 scale)
     *
     *      - HF > healthPositionHF              → reverts NotLiquidatable
     *      - borderHF < HF <= healthPositionHF  → DEX route (`_dexLiquidate`)
     *      - HF <= borderHF                     → default absorb route (`_liquidate`)
     *
     * @param absorber The recipient of the liquidation incentive.
     * @param account  The underwater account to liquidate.
     * @param swapData Per-collateral router calldata for the DEX route, aligned to the seizure plan order.
     */
    function liquidate(address absorber, address account, bytes[] calldata swapData) external onlyRole(EXECUTOR_ROLE) {
        comet.accrueAccount(account);

        // When the DEX path is paused, every keeper liquidation falls back to the default
        // absorb flow regardless of the account's HF.
        if (dexRoutePaused) {
            _liquidate(absorber, account);
            return;
        }
        _dexLiquidate(absorber, account, swapData);
    }

    /**
     * @notice Seizes and swaps collaterals into the base asset through the DEX adapter, pays the executor a
     *         `penaltyBps` cut of the realized base, and sends the remainder to Comet to clear the debt.
     * @dev If an individual swap fails, the adapter sweeps that collateral back to Comet and it is absorbed
     *      instead of sold; Reverts if bad debt occurs, or if the base left for Comet after the penalty cannot cover
     *      the debt.
     * @param absorber The recipient of the incentive.
     * @param account  The account being liquidated.
     * @param swapData Per-collateral router calldata, aligned to the seizure plan order.
     */
    function _dexLiquidate(address absorber, address account, bytes[] calldata swapData) internal {
        (
            Seizure[] memory plan,
            int256 newBalance,
            uint256 basePaidOut,
            uint256 basePaidOutValue
        ) = _computeSeizurePlan(account);

        if (swapData.length != plan.length) revert InvalidSwapDataLength();

        uint256 baseBefore = baseToken.balanceOf(address(this));
        uint256 unswappedBaseAmount;
        uint256 basePrice = getPrice(comet.baseTokenPriceFeed());

        for (uint8 i; i < plan.length; ++i) {
            if (plan[i].seizedAmount == 0) continue;

            emit AbsorbCollateral(absorber, account, plan[i].asset, plan[i].seizedAmount, plan[i].wantedCollateralValue);
            ICometLiquidationInterface(address(comet)).updateAndSeizeCollateral(account, plan[i].index, uint128(plan[i].seizedAmount));
            // Hook transfers collateral to the module, so module re-transfers it further to the adapter
            IERC20(plan[i].asset).safeTransfer(address(dexAdapter), plan[i].seizedAmount);
            // A failed swap means the adapter swept that collateral back to Comet (it is absorbed instead of
            // sold), so its debt-offset value must not be expected back in base.
            if (!dexAdapter.swap(plan[i].asset, swapData[i]))
                unswappedBaseAmount += divPrice(plan[i].seizedValue, basePrice, baseScale);
        }

        uint256 baseReceived = baseToken.balanceOf(address(this)) - baseBefore;

        ICometLiquidationInterface(address(comet)).updateDebtAndPrincipal(account, newBalance);
        emit AbsorbDebt(absorber, account, basePaidOut, basePaidOutValue);

        uint256 requiredBase = basePaidOut > unswappedBaseAmount ? basePaidOut - unswappedBaseAmount : 0;

        // Penalty is taken only from the realized swap amount.
        uint256 penalty = baseReceived * penaltyBps / BPS;
        uint256 baseForComet = baseReceived - penalty;
        if (baseForComet < requiredBase) revert SwapProceedsTooLow(baseReceived, requiredBase + penalty);

        if (baseForComet > 0) baseToken.safeTransfer(address(comet), baseForComet);
        if (penalty > 0) baseToken.safeTransfer(msg.sender, penalty);

        emit DexLiquidate(absorber, account, msg.sender, baseReceived, baseForComet, penalty);
    }

    /**
     * @notice Updates the executor penalty (in BPS) taken on the DEX route.
     * @dev Reverts if the new value exceeds MAX_PENALTY (10%).
     * @param newPenaltyBps New penalty in BPS (1e4 scale).
     */
    function setPenaltyBps(uint256 newPenaltyBps) external onlyRole(MULTISIG_ROLE) {
        if (newPenaltyBps > MAX_PENALTY || newPenaltyBps == penaltyBps) revert InvalidPenaltyBps();

        emit PenaltyBpsUpdated(penaltyBps, newPenaltyBps);
        penaltyBps = newPenaltyBps;
    }
}
