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
    uint16 internal constant BPS = 10_000;
    uint16 internal constant MAX_INCENTIVE = 1_000; /// 10% as max allowed incentive
    uint256 internal constant BASE_ROUNDING_DUST = 1;

    /// @notice used for DEX-path liquidations. Zero address means module doesn't support DEX liquidation route.
    ICoreDexAdapter public immutable dexAdapter;

    /// @notice Executor incentive on the DEX route, taken as a cut of the surplus base left after the debt is
    ///         covered — not of the whole liquidated amount.
    uint16 public incentiveBps;

    /**
     * @param dexAdapter_       The address of the DEX adapter for DEX-based liquidation.
     * @param multisig_         The Multisig address: controls parameter setters.
     * @param executors_        Initial set of Executor accounts (keeper liquidation callers).
     * @param pausers_          Initial set of Pauser accounts (DEX pause switch).
     * @param incentiveBps_     Initial executor incentive (in BPS) taken on the DEX route out of the surplus base.
     */
    constructor(
        ICoreDexAdapter dexAdapter_,
        address multisig_,
        address[] memory executors_,
        address[] memory pausers_,
        uint16 incentiveBps_
    ) CoreLiquidationModule(multisig_, executors_, pausers_) {
        if (address(dexAdapter_) == address(0)) revert ZeroAddress();
        if (incentiveBps_ > MAX_INCENTIVE) revert InvalidIncentiveBps();

        dexAdapter = dexAdapter_;
        incentiveBps = incentiveBps_;

        emit IncentiveBpsUpdated(0, incentiveBps_);
    }

    /**
     * @notice initialization method which will be called just once from the Comet during its costruction
     *         It is safe to assume that only comet will initiate the method, as otherwise Comet update proposal will revert
     *         in case if this method is called before proposal.
     */
    function setAssetList(address _assetList, uint8 _numAssets, address _baseToken) override public {
        super.setAssetList(_assetList, _numAssets, _baseToken);

        dexAdapter.setAssetList(_assetList, _numAssets, _baseToken);
    }


    /**
     * @notice initialization method which will be called just once from the Comet during its costruction
     *         It is safe to assume that only comet will initiate the method, as otherwise Comet update proposal will revert
     *         in case if this method is called before proposal.
     */
    function initiateModule(uint64 _baseScale) override public {
        /// @dev is supposed to be called from Comet only
        super.initiateModule(_baseScale);
        dexAdapter.initiateAdapter(msg.sender);
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
    function liquidate(address absorber, address account, bytes[] calldata swapData) external nonReentrant onlyRole(EXECUTOR_ROLE) {
        if (comet.isAbsorbPaused()) revert Paused();
        
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
     * @notice Seizes and swaps collaterals into the base asset through the DEX adapter, sends the base needed to
     *         clear the debt to Comet, and pays the executor an `incentiveBps` cut of the surplus that is left
     *         on top of it.
     *
     *      If an individual swap fails, the adapter sweeps that collateral back to Comet and it is absorbed
     *      instead of sold, so its value is excluded from `baseRequired`. A shortfall beyond the rounding dust is
     *      bad debt: no incentive is paid and the whole realized base goes to Comet.
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
        uint256 unswappedSeizedValue;
        uint256 basePrice = getPrice(comet.baseTokenPriceFeed());

        for (uint8 i; i < plan.length; ++i) {
            if (plan[i].seizedAmount == 0) continue;

            // Comet emits AbsorbCollateral from the hook.
            ICometLiquidationInterface(address(comet)).updateAndSeizeCollateral(
                absorber,
                account,
                plan[i].index,
                uint128(plan[i].seizedAmount),
                plan[i].wantedCollateralValue
            );
            // Hook transfers collateral to the module, so module re-transfers it further to the adapter
            IERC20(plan[i].asset).safeTransfer(address(dexAdapter), plan[i].seizedAmount);
            // A failed swap means the adapter swept that collateral back to Comet (it is absorbed instead of
            // sold), so its debt-offset value must not be expected back in base.
            if (!dexAdapter.swap(plan[i].asset, plan[i].seizedAmount, swapData[i]))
                unswappedSeizedValue += plan[i].seizedValue;
        }

        /// @dev Even if received amount is less than debt due to slippage, the DEX adapter verifies the slippage
        ///      tolerance, so we can close the whole debt.
        // Comet emits AbsorbDebt from the hook.
        ICometLiquidationInterface(address(comet)).updateDebtAndPrincipal(absorber, account, newBalance, basePaidOut, basePaidOutValue);

        uint256 baseReceived = baseToken.balanceOf(address(this)) - baseBefore;
        // Convert the swept collateral's value to base.
        uint256 unswappedBaseAmount = divPrice(unswappedSeizedValue, basePrice, baseScale);
        uint256 baseRequired = basePaidOut > unswappedBaseAmount ? basePaidOut - unswappedBaseAmount : 0;

        /// baseReceived: actually received amount of base asset after all swaps and after slippage checks
        /// baseRequired: amount to be put into reserves to cover debt (as it is basically a difference in balances)
        /// In general, we can assume baseReceived > baseRequired, as even due to slippage tolerance and swap fees
        /// the protocol swaps collaterals for debt value + penalty, which covers those expenses.
        ///
        /// However, in case if baseReceived < baseRequired (in case we received less value even counting collateral's penalty)
        /// the protocol has closed the bad debt (collateral's penalized value is less than balances difference)

        // Incentive is taken only in case of regular debts closed.
        uint256 incentive;
        uint256 baseForComet;

        // basePaidOut rounds up while unswappedBaseAmount rounds down, so baseRequired can be overstated
        // by at most BASE_ROUNDING_DUST. Only a shortfall beyond that dust is real bad debt, so a debt
        // covered fully in-kind (or down to the wei) is not misreported.
        if (baseReceived + BASE_ROUNDING_DUST < baseRequired) {
            baseForComet = baseReceived;
            emit BadDebtLiquidate(absorber, account, msg.sender, baseReceived);
        }
        else {
            uint256 surplus = baseReceived > baseRequired ? baseReceived - baseRequired : 0;
            incentive = surplus * incentiveBps / BPS;
            baseForComet = baseReceived - incentive;
        }

        if (baseForComet > 0) baseToken.safeTransfer(address(comet), baseForComet);
        if (incentive > 0) baseToken.safeTransfer(msg.sender, incentive);

        emit DexLiquidate(absorber, account, msg.sender, baseReceived, baseForComet, incentive);
    }

    /**
     * @notice Updates the executor incentive (in BPS) taken on the DEX route.
     * @dev Reverts if the new value exceeds MAX_INCENTIVE (10%).
     * @param newIncentiveBps New incentive in BPS (1e4 scale).
     */
    function setIncentiveBps(uint16 newIncentiveBps) external onlyRole(MULTISIG_ROLE) {
        if (newIncentiveBps > MAX_INCENTIVE || newIncentiveBps == incentiveBps) revert InvalidIncentiveBps();

        emit IncentiveBpsUpdated(incentiveBps, newIncentiveBps);
        incentiveBps = newIncentiveBps;
    }

    /**
     * @notice Updates the global slippage (`collateral` == address(0)) or a per-collateral override on the DEX adapter.
     * @dev Reverts if the new value exceeds 100% (1e4). A per-collateral override may be 0 to clear it.
     * @param newSlippageBps New slippage in BPS (1e4 scale).
     * @param collateral Collateral to override, or the zero address to set the global slippage.
     */
    function setSlippageBps(uint16 newSlippageBps, address collateral) external onlyRole(MULTISIG_ROLE) {
        ///@dev event is emitted in DEX adapter
        dexAdapter.setSlippageBps(newSlippageBps, collateral);
    }
}
