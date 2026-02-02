// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../interfaces/IStaking.sol";

/**
 * @title MockStaking
 * @notice A mock staking contract for testing purposes
 * @dev Mimics Sei's staking precompile interface
 */
contract MockStaking is IStaking {
    // delegator => validator string => delegation info
    mapping(address => mapping(string => DelegationInfo)) internal _delegations;
    // delegator => validators list
    mapping(address => string[]) internal _delegatorValidators;
    // delegator => validator => exists in list
    mapping(address => mapping(string => bool)) internal _validatorExists;
    // delegator => validator => unbonding info
    mapping(address => mapping(string => UnbondingInfo)) internal _unbondings;
    // delegator => unbonding validators list
    mapping(address => string[]) internal _unbondingValidators;

    struct DelegationInfo {
        uint256 amount;
        uint256 shares;
    }

    struct UnbondingInfo {
        uint256 balance;
        int64 completionTime;
    }

    // ============ Transaction Methods ============

    function delegate(string memory valAddr) external payable override returns (bool) {
        require(msg.value > 0, "No value sent");

        if (!_validatorExists[msg.sender][valAddr]) {
            _delegatorValidators[msg.sender].push(valAddr);
            _validatorExists[msg.sender][valAddr] = true;
        }

        _delegations[msg.sender][valAddr].amount += msg.value;
        _delegations[msg.sender][valAddr].shares += msg.value;

        return true;
    }

    function redelegate(
        string memory srcValidator,
        string memory dstValidator,
        uint256 amount
    ) external override returns (bool) {
        require(_delegations[msg.sender][srcValidator].amount >= amount, "Insufficient delegation");

        _delegations[msg.sender][srcValidator].amount -= amount;
        _delegations[msg.sender][srcValidator].shares -= amount;

        if (!_validatorExists[msg.sender][dstValidator]) {
            _delegatorValidators[msg.sender].push(dstValidator);
            _validatorExists[msg.sender][dstValidator] = true;
        }

        _delegations[msg.sender][dstValidator].amount += amount;
        _delegations[msg.sender][dstValidator].shares += amount;

        return true;
    }

    function undelegate(string memory valAddr, uint256 amount) external override returns (bool) {
        require(_delegations[msg.sender][valAddr].amount >= amount, "Insufficient delegation");

        _delegations[msg.sender][valAddr].amount -= amount;
        _delegations[msg.sender][valAddr].shares -= amount;

        // Add to unbonding
        _unbondings[msg.sender][valAddr].balance += amount;
        _unbondings[msg.sender][valAddr].completionTime = int64(int256(block.timestamp + 21 days));

        // For testing, immediately return the funds
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        return true;
    }

    // ============ Query Methods ============

    function delegation(
        address delegator,
        string memory valAddr
    ) external view override returns (Delegation memory) {
        DelegationInfo storage info = _delegations[delegator][valAddr];
        return Delegation({
            delegatorAddress: _addressToSeiAddress(delegator),
            validatorAddress: valAddr,
            shares: Shares({amount: info.shares}),
            balance: Balance({amount: info.amount})
        });
    }

    function validators() external pure override returns (Validator[] memory) {
        // Return empty array for mock
        return new Validator[](0);
    }

    function validator(string memory) external pure override returns (Validator memory) {
        return Validator({
            operatorAddress: "",
            consensusPubkey: "",
            jailed: false,
            status: "BOND_STATUS_BONDED",
            tokens: 0,
            delegatorShares: 0,
            description: "",
            unbondingHeight: 0,
            unbondingTime: 0,
            commission: 0,
            minSelfDelegation: 0
        });
    }

    function delegations(address delegator) external view override returns (Delegation[] memory) {
        string[] storage vals = _delegatorValidators[delegator];
        uint256 count = 0;

        // Count non-zero delegations
        for (uint256 i = 0; i < vals.length; i++) {
            if (_delegations[delegator][vals[i]].amount > 0) {
                count++;
            }
        }

        Delegation[] memory result = new Delegation[](count);
        uint256 idx = 0;

        for (uint256 i = 0; i < vals.length; i++) {
            DelegationInfo storage info = _delegations[delegator][vals[i]];
            if (info.amount > 0) {
                result[idx] = Delegation({
                    delegatorAddress: _addressToSeiAddress(delegator),
                    validatorAddress: vals[i],
                    shares: Shares({amount: info.shares}),
                    balance: Balance({amount: info.amount})
                });
                idx++;
            }
        }

        return result;
    }

    function unbondingDelegation(
        address delegator,
        string memory valAddr
    ) external view override returns (UnbondingDelegation memory) {
        UnbondingInfo storage info = _unbondings[delegator][valAddr];

        UnbondingEntry[] memory entries = new UnbondingEntry[](info.balance > 0 ? 1 : 0);
        if (info.balance > 0) {
            entries[0] = UnbondingEntry({
                creationHeight: 1,
                completionTime: info.completionTime,
                initialBalance: info.balance,
                balance: info.balance
            });
        }

        return UnbondingDelegation({
            delegatorAddress: _addressToSeiAddress(delegator),
            validatorAddress: valAddr,
            entries: entries
        });
    }

    function unbondingDelegations(
        address delegator
    ) external view override returns (UnbondingDelegation[] memory) {
        string[] storage vals = _delegatorValidators[delegator];
        uint256 count = 0;

        // Count validators with unbonding
        for (uint256 i = 0; i < vals.length; i++) {
            if (_unbondings[delegator][vals[i]].balance > 0) {
                count++;
            }
        }

        UnbondingDelegation[] memory result = new UnbondingDelegation[](count);
        uint256 idx = 0;

        for (uint256 i = 0; i < vals.length; i++) {
            UnbondingInfo storage info = _unbondings[delegator][vals[i]];
            if (info.balance > 0) {
                UnbondingEntry[] memory entries = new UnbondingEntry[](1);
                entries[0] = UnbondingEntry({
                    creationHeight: 1,
                    completionTime: info.completionTime,
                    initialBalance: info.balance,
                    balance: info.balance
                });

                result[idx] = UnbondingDelegation({
                    delegatorAddress: _addressToSeiAddress(delegator),
                    validatorAddress: vals[i],
                    entries: entries
                });
                idx++;
            }
        }

        return result;
    }

    function redelegations(
        address,
        string memory,
        string memory
    ) external pure override returns (Redelegation[] memory) {
        return new Redelegation[](0);
    }

    // ============ Helper Functions ============

    function _addressToSeiAddress(address addr) internal pure returns (string memory) {
        // In production, this would convert to sei1... format
        // For testing, just return a placeholder
        bytes memory alphabet = "0123456789abcdef";
        bytes memory data = abi.encodePacked(addr);
        bytes memory str = new bytes(4 + data.length * 2);
        str[0] = "s";
        str[1] = "e";
        str[2] = "i";
        str[3] = "1";
        for (uint256 i = 0; i < data.length; i++) {
            str[4 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[5 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }

    // ============ Test Helpers ============

    function setDelegation(address delegator, string memory valAddr, uint256 amount) external {
        if (!_validatorExists[delegator][valAddr]) {
            _delegatorValidators[delegator].push(valAddr);
            _validatorExists[delegator][valAddr] = true;
        }
        _delegations[delegator][valAddr].amount = amount;
        _delegations[delegator][valAddr].shares = amount;
    }

    function setUnbonding(address delegator, string memory valAddr, uint256 amount) external {
        _unbondings[delegator][valAddr].balance = amount;
        _unbondings[delegator][valAddr].completionTime = int64(int256(block.timestamp + 21 days));
    }

    receive() external payable {}
}
