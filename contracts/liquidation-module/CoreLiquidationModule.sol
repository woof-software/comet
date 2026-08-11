// SPDX-License-Identifier: BUSL-1.1
pragma solidity =0.8.15;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { ICometInterface, ICometData } from "../interfaces/ICometInterface.sol";
import { ICometLiquidationInterface } from "../interfaces/ICometLiquidationInterface.sol";
import { IAssetList } from "../IAssetList.sol";

import { LiquidationAccessControl } from "./LiquidationAccessControl.sol";
import { SeizureCalculations } from "./SeizureCalculations.sol";
import { ICoreLiquidationModule } from "../interfaces/liquidation-module/ICoreLiquidationModule.sol";

/**
 * @title Core Liquidation Module
 * @author Woof
 * @notice Implements Comet's default account absorption and liquidation checks.
 * @dev The module is called only by its bound Comet instance and writes state back through
 *      Comet's liquidation hooks. It handles the following liquidation cases:
 *      - partial liquidation when collateral can restore the account to the target health factor;
 *      - full liquidation when the account must be totally liquidated;
 *      - bad debt write-off when collateral cannot cover the account debt;
 *      - minimum debt handling when the remaining borrow falls below the configured borrow minimum.
 * @custom:security-contact dmitriy@woof.software
 */
abstract contract CoreLiquidationModule is ICoreLiquidationModule, LiquidationAccessControl, SeizureCalculations, ReentrancyGuard {
    /// @notice The Comet base asset; collateral is swapped into it on the DEX route.
    IERC20 public baseToken;

    modifier onlyComet() {
        if (msg.sender != address(comet)) revert OnlyComet();
        _;
    }

    /**
     * @param _multisig  The Multisig address: controls parameter setters.
     * @param _executors Initial set of Executor accounts (keeper liquidation callers).
     * @param _pausers   Initial set of Pauser accounts (DEX pause switch).
     */
    constructor(
        address _multisig,
        address[] memory _executors,
        address[] memory _pausers
    ) LiquidationAccessControl(_multisig, _executors, _pausers) {

    }

    /**
     * @notice initialization method which will be called just once during Comet initialization or module construction
     *         It is safe to assume that only comet will initiate the method, as otherwise Comet update proposal will revert
     *         in case if this method is called before proposal.
     */
    function setAssetList(address _assetList, uint8 _numAssets, address _baseToken) virtual public {
        /// @dev values are set during the Comet implementation deployment
        ///      or via update by the same Comet (thus address of the comet is already set via constructor)
        if (address(assetList) != address(0) || address(baseToken) != address(0)) revert AlreadySet();

        if (_assetList == address(0) || _baseToken == address(0)) revert ZeroAddress();
        if (_numAssets == 0) revert InvalidNumAssets();

        assetList = IAssetList(_assetList);
        numAssets = _numAssets;
        baseToken = IERC20(_baseToken);
    }

    /**
     * @notice initialization method which will be called just once during Comet initialization or module construction
     *         It is safe to assume that only comet will initiate the method, as otherwise Comet update proposal will revert
     *         in case if this method is called before proposal.
     */
    function initiateModule(uint64 _baseScale) virtual public {
        /// @dev values are either set during Comet first deployment (comet is not set)
        ///      or via update by the same Comet (thus address of the comet is already set via constructor)
        if (address(comet) != address(0)) revert AlreadySet();

        comet = ICometInterface(msg.sender);
        baseScale = _baseScale;
    }

    /**
     * @notice Entry point for the protocol-driven liquidation path: it absorbs an underwater account.
     * @dev Restricted to Comet — it can only be executed by `Comet.absorb()`
     * @param absorber The recipient of the incentive paid to the caller of `Comet.absorb()`.
     * @param account  The underwater account whose collateral and debt are being absorbed.
     */
    function absorb(address absorber, address account) external nonReentrant onlyComet {
        _liquidate(absorber, account);
    }

    /**
    * @notice Seizes collateral assets one by one until the account reaches target health factor
    *         or all debt is fully repaid. Any unrecoverable shortfall is written off
    *         as bad debt absorbed by the protocol
    * @dev Iterates over account collateral assets in index order.
    * @param absorber The recipient of the incentive paid to the caller of absorb()
    * @param account  The underwater account whose collateral and debt are being absorbed
    */
    function _liquidate(address absorber, address account) internal {
        (
            Seizure[] memory plan,
            int256 newBalance,
            uint256 basePaidOut,
            uint256 basePaidOutValue
        ) = _computeSeizurePlan(account);

        for (uint8 i; i < plan.length; ++i) {
            if (plan[i].seizedAmount == 0 ) continue;
            // Collaterals storage update. Comet emits AbsorbCollateral from the hook.
            ICometLiquidationInterface(address(comet)).updateCollateral(
                absorber,
                account,
                plan[i].index,
                safe128(plan[i].seizedAmount),
                plan[i].wantedCollateralValue
            );
        }

        // Comet emits AbsorbDebt from the hook.
        ICometLiquidationInterface(address(comet)).updateDebtAndPrincipal(absorber, account, newBalance, basePaidOut, basePaidOutValue);
    }

    /**
     * @notice Returns the per-collateral seizure plan a liquidation would produce for `account`.
     * @param account The underwater account to plan a seizure for.
     * @return plan The ordered list of collateral seizures.
     */
    function seizurePlan(address account) external view returns (Seizure[] memory plan) {
        (plan, , , ) = _computeSeizurePlan(account);
    }

    /**
     * @notice Check whether an account has enough collateral to not be liquidated
     * @param account The address to check
     * @return bool: whether the account is minimally collateralized enough to not be liquidated
     *
     * @dev Intentionally does NOT check isCollateralDeactivated. Unlike isBorrowCollateralized,
     *      which reverts on deactivated collateral to block borrower actions, this function
     *      must always return a result so that liquidation remains possible. A stuck borrower
     *      who cannot withdraw deactivated collateral (see withdrawCollateral) relies on
     *      liquidation as their only exit path. If isLiquidatable reverted on deactivated
     *      collateral, the borrower would be permanently frozen with no way out.
     *
     *      When liquidateCollateralFactor is 0 for the deactivated asset, it contributes
     *      nothing to the liquidity calculation, making the account easier to liquidate.
     */
    function isLiquidatable(address account) public view returns (bool) {
        ICometData.UserBasic memory accountUser = comet.userBasic(account);

        if (accountUser.principal >= 0) return false;

        int256 debt = signedMulPrice(
            comet.presentValue(accountUser.principal),
            getPrice(comet.baseTokenPriceFeed()),
            baseScale
        );

        (uint256 liquidity, ) = _getLiquidity(accountUser, account, true, new uint256[](0));
        return debt + int256(liquidity) < 0;
    }

    /**
     * @notice Computes the per-collateral seizure plan for an underwater account at its current debt.
     * @param account The underwater account to plan a seizure for.
     * @return values: the ordered seizure plan, the account's new balance, debt payout, its value
     */
    function _computeSeizurePlan(address account)
        internal
        view
        returns (ICoreLiquidationModule.Seizure[] memory, int256, uint256, uint256)
    {
        ICometData.UserBasic memory accountUser = comet.userBasic(account);
        return _computeSeizurePlan(accountUser, account, comet.presentValue(accountUser.principal), partialLiquidationEnabled);
    }
}
