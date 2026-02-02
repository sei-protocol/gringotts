// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IStaking
 * @notice Interface for Sei's Staking Precompile at address 0x0000000000000000000000000000000000001005
 * @dev This interface matches the Sei staking precompile for native staking operations
 * @dev See: https://docs.sei.io/evm/precompiles/staking
 */
interface IStaking {
    // ============ Structs ============

    struct Validator {
        string operatorAddress;
        string consensusPubkey;
        bool jailed;
        string status;
        uint256 tokens;
        uint256 delegatorShares;
        string description;
        int64 unbondingHeight;
        int64 unbondingTime;
        uint256 commission;
        uint256 minSelfDelegation;
    }

    struct Delegation {
        string delegatorAddress;
        string validatorAddress;
        Shares shares;
        Balance balance;
    }

    struct Shares {
        uint256 amount;
    }

    struct Balance {
        uint256 amount;
    }

    struct UnbondingDelegation {
        string delegatorAddress;
        string validatorAddress;
        UnbondingEntry[] entries;
    }

    struct UnbondingEntry {
        int64 creationHeight;
        int64 completionTime;
        uint256 initialBalance;
        uint256 balance;
    }

    struct Redelegation {
        string delegatorAddress;
        string srcValidatorAddress;
        string dstValidatorAddress;
        RedelegationEntry[] entries;
    }

    struct RedelegationEntry {
        int64 creationHeight;
        int64 completionTime;
        uint256 initialBalance;
        uint256 sharesDst;
    }

    // ============ Transaction Methods ============

    /**
     * @notice Delegate tokens to a validator
     * @dev Tokens are sent via msg.value
     * @param validator The validator's Sei address (e.g., "seivaloper1...")
     * @return success Whether the delegation was successful
     */
    function delegate(string memory validator) external payable returns (bool success);

    /**
     * @notice Redelegate tokens from one validator to another
     * @param srcValidator The source validator's Sei address
     * @param dstValidator The destination validator's Sei address
     * @param amount The amount to redelegate (in wei, 18 decimals)
     * @return success Whether the redelegation was successful
     */
    function redelegate(
        string memory srcValidator,
        string memory dstValidator,
        uint256 amount
    ) external returns (bool success);

    /**
     * @notice Undelegate tokens from a validator
     * @param validator The validator's Sei address
     * @param amount The amount to undelegate (in wei, 18 decimals)
     * @return success Whether the undelegation was successful
     */
    function undelegate(string memory validator, uint256 amount) external returns (bool success);

    // ============ Query Methods ============

    /**
     * @notice Get delegation information for a specific delegator-validator pair
     * @param delegator The delegator's EVM address
     * @param validator The validator's Sei address
     * @return delegation The delegation information
     */
    function delegation(
        address delegator,
        string memory validator
    ) external view returns (Delegation memory delegation);

    /**
     * @notice Get all validators
     * @return validators Array of all validators
     */
    function validators() external view returns (Validator[] memory validators);

    /**
     * @notice Get a specific validator's information
     * @param validator The validator's Sei address
     * @return validatorInfo The validator information
     */
    function validator(string memory validator) external view returns (Validator memory validatorInfo);

    /**
     * @notice Get all delegations for a delegator
     * @param delegator The delegator's EVM address
     * @return delegations Array of delegations
     */
    function delegations(address delegator) external view returns (Delegation[] memory delegations);

    /**
     * @notice Get unbonding delegation for a specific delegator-validator pair
     * @param delegator The delegator's EVM address
     * @param validator The validator's Sei address
     * @return unbonding The unbonding delegation information
     */
    function unbondingDelegation(
        address delegator,
        string memory validator
    ) external view returns (UnbondingDelegation memory unbonding);

    /**
     * @notice Get all unbonding delegations for a delegator
     * @param delegator The delegator's EVM address
     * @return unbondings Array of unbonding delegations
     */
    function unbondingDelegations(
        address delegator
    ) external view returns (UnbondingDelegation[] memory unbondings);

    /**
     * @notice Get redelegations for a delegator
     * @param delegator The delegator's EVM address
     * @param srcValidator The source validator (optional, empty string for all)
     * @param dstValidator The destination validator (optional, empty string for all)
     * @return redelegations Array of redelegations
     */
    function redelegations(
        address delegator,
        string memory srcValidator,
        string memory dstValidator
    ) external view returns (Redelegation[] memory redelegations);
}

/**
 * @dev Staking precompile address on Sei
 */
address constant STAKING_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000001005;
