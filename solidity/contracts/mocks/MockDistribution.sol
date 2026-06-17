// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../interfaces/IDistribution.sol";

/**
 * @title MockDistribution
 * @notice A mock distribution contract for testing purposes
 * @dev Mimics Sei's distribution precompile interface
 */
contract MockDistribution is IDistribution {
    uint256 private constant WEI_PER_USEI = 1e12;
    uint256 private constant DECIMAL_USEI_PER_WEI = 1e6;

    // delegator => withdraw address
    mapping(address => address) public withdrawAddresses;
    // delegator => validator => rewards
    mapping(address => mapping(string => uint256)) public pendingRewards;
    // Track validators with rewards for each delegator
    mapping(address => string[]) internal _rewardValidators;
    mapping(address => mapping(string => bool)) internal _hasReward;
    bool public setWithdrawAddressShouldFail;
    bool public withdrawShouldFail;
    uint256 public singleWithdrawCallCount;
    uint256 public multipleWithdrawCallCount;

    // ============ Transaction Methods ============

    function setWithdrawAddress(address withdrawAddr) external override returns (bool) {
        if (setWithdrawAddressShouldFail) {
            return false;
        }
        withdrawAddresses[msg.sender] = withdrawAddr;
        emit WithdrawAddressSet(msg.sender, withdrawAddr);
        return true;
    }

    function withdrawDelegationRewards(string memory validator) external override returns (bool) {
        singleWithdrawCallCount++;
        if (withdrawShouldFail) {
            return false;
        }

        return _withdrawDelegationRewards(msg.sender, validator);
    }

    function autoWithdrawDelegationRewards(address delegator, string memory validator) external returns (bool) {
        if (withdrawShouldFail) {
            return false;
        }

        return _withdrawDelegationRewards(delegator, validator);
    }

    function _withdrawDelegationRewards(address delegator, string memory validator) internal returns (bool) {
        uint256 amount = pendingRewards[delegator][validator];
        uint256 settledAmount = _toSettledWei(amount);
        if (settledAmount > 0) {
            pendingRewards[delegator][validator] = amount - settledAmount;

            address recipient = withdrawAddresses[delegator];
            if (recipient == address(0)) {
                recipient = delegator;
            }

            (bool success, ) = recipient.call{value: settledAmount}("");
            require(success, "Transfer failed");

            emit DelegationRewardsWithdrawn(delegator, validator, settledAmount);
        }
        return true;
    }

    function withdrawMultipleDelegationRewards(
        string[] memory validators
    ) external override returns (bool) {
        multipleWithdrawCallCount++;
        if (withdrawShouldFail) {
            return false;
        }

        address recipient = withdrawAddresses[msg.sender];
        if (recipient == address(0)) {
            recipient = msg.sender;
        }

        uint256[] memory amounts = new uint256[](validators.length);
        uint256 totalAmount = 0;

        for (uint256 i = 0; i < validators.length; i++) {
            uint256 amount = pendingRewards[msg.sender][validators[i]];
            uint256 settledAmount = _toSettledWei(amount);
            if (settledAmount > 0) {
                pendingRewards[msg.sender][validators[i]] = amount - settledAmount;
                amounts[i] = settledAmount;
                totalAmount += settledAmount;
            }
        }

        if (totalAmount > 0) {
            (bool success, ) = recipient.call{value: totalAmount}("");
            require(success, "Transfer failed");
        }

        emit MultipleDelegationRewardsWithdrawn(msg.sender, validators, amounts);
        return true;
    }

    function withdrawValidatorCommission() external pure override returns (bool) {
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

        Reward[] memory rewardInfos = new Reward[](count);
        uint256 totalRewards = 0;
        uint256 idx = 0;

        for (uint256 i = 0; i < vals.length; i++) {
            uint256 amount = pendingRewards[delegator][vals[i]];
            if (amount > 0) {
                Coin[] memory coins = new Coin[](1);
                coins[0] = Coin({amount: _toDecimalUsei(amount), decimals: 18, denom: "usei"});

                rewardInfos[idx] = Reward({coins: coins, validator_address: vals[i]});
                totalRewards += amount;
                idx++;
            }
        }

        Coin[] memory total = new Coin[](1);
        total[0] = Coin({amount: _toDecimalUsei(totalRewards), decimals: 18, denom: "usei"});

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

    function setSetWithdrawAddressSuccess(bool success) external {
        setWithdrawAddressShouldFail = !success;
    }

    function setWithdrawSuccess(bool success) external {
        withdrawShouldFail = !success;
    }

    function fundRewards() external payable {}

    function _toSettledWei(uint256 amount) internal pure returns (uint256) {
        return (amount / WEI_PER_USEI) * WEI_PER_USEI;
    }

    function _toDecimalUsei(uint256 amountWei) internal pure returns (uint256) {
        return amountWei * DECIMAL_USEI_PER_WEI;
    }

    receive() external payable {}
}
