// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IDistribution
 * @notice Interface for Sei's Distribution Precompile at address 0x0000000000000000000000000000000000001007
 * @dev This interface matches the Sei distribution precompile for managing staking rewards
 * @dev See: https://docs.sei.io/evm/precompiles/distribution
 */
interface IDistribution {
    // ============ Structs ============

    struct Rewards {
        RewardInfo[] rewards;
        DecCoin[] total;
    }

    struct RewardInfo {
        string validatorAddress;
        DecCoin[] rewards;
    }

    struct DecCoin {
        string denom;
        uint256 amount;
        uint256 precision; // decimal precision (typically 18)
    }

    // ============ Transaction Methods ============

    /**
     * @notice Set the withdrawal address for staking rewards
     * @dev Gas estimate: ~30,000
     * @param withdrawAddr The address to receive future reward withdrawals
     * @return success Whether the operation was successful
     */
    function setWithdrawAddress(address withdrawAddr) external returns (bool success);

    /**
     * @notice Withdraw delegation rewards from a specific validator
     * @dev Gas estimate: ~50,000-80,000
     * @param validator The validator's Sei address (e.g., "seivaloper1...")
     * @return success Whether the withdrawal was successful
     */
    function withdrawDelegationRewards(string memory validator) external returns (bool success);

    /**
     * @notice Withdraw delegation rewards from multiple validators in a single transaction
     * @dev Gas estimate: ~40,000 + ~30,000 per validator
     * @dev More gas efficient than calling withdrawDelegationRewards multiple times
     * @param validators Array of validator Sei addresses
     * @return success Whether all withdrawals were successful
     */
    function withdrawMultipleDelegationRewards(
        string[] memory validators
    ) external returns (bool success);

    /**
     * @notice Withdraw validator commission (only callable by validators)
     * @dev Gas estimate: ~60,000-90,000
     * @param validator The validator's Sei address
     * @return success Whether the withdrawal was successful
     */
    function withdrawValidatorCommission(string memory validator) external returns (bool success);

    // ============ Query Methods ============

    /**
     * @notice Get all rewards for a delegator across all validators
     * @param delegator The delegator's EVM address
     * @return rewardsInfo The rewards information including per-validator breakdown and totals
     */
    function rewards(address delegator) external view returns (Rewards memory rewardsInfo);
}

/**
 * @dev Distribution precompile address on Sei
 */
address constant DISTRIBUTION_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000001007;
