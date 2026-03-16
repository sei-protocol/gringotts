// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IDistribution
 * @notice Interface for Sei's Distribution Precompile at address 0x0000000000000000000000000000000000001007
 * @dev This interface matches the Sei distribution precompile for managing staking rewards
 * @dev See: https://github.com/sei-protocol/sei-chain/blob/main/precompiles/distribution/Distribution.sol
 */
interface IDistribution {
    // ============ Events ============

    event WithdrawAddressSet(address indexed delegator, address withdrawAddr);
    event DelegationRewardsWithdrawn(address indexed delegator, string validator, uint256 amount);
    event MultipleDelegationRewardsWithdrawn(address indexed delegator, string[] validators, uint256[] amounts);
    event ValidatorCommissionWithdrawn(string indexed validator, uint256 amount);

    // ============ Structs ============

    /**
     * @notice Represents a coin/token with amount, decimals, and denomination
     * @dev Used to represent various tokens in the Cosmos ecosystem
     */
    struct Coin {
        uint256 amount;
        uint256 decimals;
        string denom;
    }

    /**
     * @notice Represents rewards from a specific validator
     * @dev Contains all reward coins from a single validator
     */
    struct Reward {
        Coin[] coins;
        string validator_address;
    }

    /**
     * @notice Aggregated rewards information for a delegator
     * @dev Contains both per-validator breakdown and total rewards
     */
    struct Rewards {
        Reward[] rewards;
        Coin[] total;
    }

    // ============ Transaction Methods ============

    /**
     * @notice Sets the withdrawal address for the caller's staking rewards
     * @dev The caller must have a valid associated Sei address
     * @param withdrawAddr The EVM address where rewards should be sent
     * @return success True if the withdrawal address was set successfully
     */
    function setWithdrawAddress(address withdrawAddr) external returns (bool success);

    /**
     * @notice Withdraws delegation rewards from a specific validator
     * @dev The caller must be a delegator to the specified validator
     * @param validator The validator's Sei address (e.g., "seivaloper1...")
     * @return success True if rewards were withdrawn successfully
     */
    function withdrawDelegationRewards(string memory validator) external returns (bool success);

    /**
     * @notice Withdraws delegation rewards from multiple validators in a single transaction
     * @dev More gas efficient than calling withdrawDelegationRewards multiple times
     * @param validators Array of validator Sei addresses
     * @return success True if all rewards were withdrawn successfully
     */
    function withdrawMultipleDelegationRewards(string[] memory validators) external returns (bool success);

    /**
     * @notice Withdraws validator commission (only callable by the validator operator)
     * @dev Only the validator operator can withdraw their commission
     * @return success True if commission was withdrawn successfully
     */
    function withdrawValidatorCommission() external returns (bool success);

    // ============ Query Methods ============

    /**
     * @notice Gets all pending rewards for a delegator
     * @dev Returns rewards from all validators the address has delegated to
     * @param delegatorAddress The EVM address of the delegator
     * @return rewards Structured data containing all pending rewards
     */
    function rewards(address delegatorAddress) external view returns (Rewards memory rewards);
}

/**
 * @dev Distribution precompile address on Sei
 */
address constant DISTRIBUTION_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000001007;

/**
 * @dev Distribution precompile contract instance
 */
IDistribution constant DISTRIBUTION_CONTRACT = IDistribution(DISTRIBUTION_PRECOMPILE_ADDRESS);
