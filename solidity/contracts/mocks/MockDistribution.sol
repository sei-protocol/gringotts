// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../interfaces/IDistribution.sol";

/**
 * @title MockDistribution
 * @notice A mock distribution contract for testing purposes
 * @dev Mimics Sei's distribution precompile interface
 */
contract MockDistribution is IDistribution {
    // delegator => withdraw address
    mapping(address => address) public withdrawAddresses;
    // delegator => validator => rewards
    mapping(address => mapping(string => uint256)) public pendingRewards;
    // Track validators with rewards for each delegator
    mapping(address => string[]) internal _rewardValidators;
    mapping(address => mapping(string => bool)) internal _hasReward;

    // ============ Transaction Methods ============

    function setWithdrawAddress(address withdrawAddr) external override returns (bool) {
        withdrawAddresses[msg.sender] = withdrawAddr;
        return true;
    }

    function withdrawDelegationRewards(string memory validator) external override returns (bool) {
        uint256 amount = pendingRewards[msg.sender][validator];
        if (amount > 0) {
            pendingRewards[msg.sender][validator] = 0;

            address recipient = withdrawAddresses[msg.sender];
            if (recipient == address(0)) {
                recipient = msg.sender;
            }

            (bool success, ) = recipient.call{value: amount}("");
            require(success, "Transfer failed");
        }
        return true;
    }

    function withdrawMultipleDelegationRewards(
        string[] memory validators
    ) external override returns (bool) {
        address recipient = withdrawAddresses[msg.sender];
        if (recipient == address(0)) {
            recipient = msg.sender;
        }

        uint256 totalAmount = 0;
        for (uint256 i = 0; i < validators.length; i++) {
            uint256 amount = pendingRewards[msg.sender][validators[i]];
            if (amount > 0) {
                pendingRewards[msg.sender][validators[i]] = 0;
                totalAmount += amount;
            }
        }

        if (totalAmount > 0) {
            (bool success, ) = recipient.call{value: totalAmount}("");
            require(success, "Transfer failed");
        }

        return true;
    }

    function withdrawValidatorCommission(string memory) external pure override returns (bool) {
        // Not implemented for testing
        return true;
    }

    // ============ Query Methods ============

    function rewards(address delegator) external view override returns (Rewards memory) {
        string[] storage vals = _rewardValidators[delegator];
        uint256 count = 0;

        // Count validators with rewards
        for (uint256 i = 0; i < vals.length; i++) {
            if (pendingRewards[delegator][vals[i]] > 0) {
                count++;
            }
        }

        RewardInfo[] memory rewardInfos = new RewardInfo[](count);
        uint256 totalRewards = 0;
        uint256 idx = 0;

        for (uint256 i = 0; i < vals.length; i++) {
            uint256 amount = pendingRewards[delegator][vals[i]];
            if (amount > 0) {
                DecCoin[] memory coins = new DecCoin[](1);
                coins[0] = DecCoin({denom: "usei", amount: amount, precision: 18});

                rewardInfos[idx] = RewardInfo({validatorAddress: vals[i], rewards: coins});
                totalRewards += amount;
                idx++;
            }
        }

        DecCoin[] memory total = new DecCoin[](1);
        total[0] = DecCoin({denom: "usei", amount: totalRewards, precision: 18});

        return Rewards({rewards: rewardInfos, total: total});
    }

    // ============ Test Helpers ============

    function setRewards(address delegator, string memory validator, uint256 amount) external {
        if (!_hasReward[delegator][validator]) {
            _rewardValidators[delegator].push(validator);
            _hasReward[delegator][validator] = true;
        }
        pendingRewards[delegator][validator] = amount;
    }

    function fundRewards() external payable {}

    receive() external payable {}
}
