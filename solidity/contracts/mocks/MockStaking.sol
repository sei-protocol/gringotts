// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../interfaces/IStaking.sol";

/**
 * @title MockStaking
 * @notice A mock staking contract for testing purposes
 * @dev Mimics Sei's staking precompile interface
 */
contract MockStaking is IStaking {
    uint256 private constant WEI_PER_USEI = 1e12;

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
        require(msg.value % WEI_PER_USEI == 0, "Not whole uSEI");
        uint256 amountUsei = msg.value / WEI_PER_USEI;

        if (!_validatorExists[msg.sender][valAddr]) {
            _delegatorValidators[msg.sender].push(valAddr);
            _validatorExists[msg.sender][valAddr] = true;
        }

        _delegations[msg.sender][valAddr].amount += amountUsei;
        _delegations[msg.sender][valAddr].shares += amountUsei;

        emit Delegate(msg.sender, valAddr, amountUsei);
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

        emit Redelegate(msg.sender, srcValidator, dstValidator, amount);
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
        (bool success, ) = msg.sender.call{value: amount * WEI_PER_USEI}("");
        require(success, "Transfer failed");

        emit Undelegate(msg.sender, valAddr, amount);
        return true;
    }

    function createValidator(
        string memory,
        string memory moniker,
        string memory,
        string memory,
        string memory,
        uint256
    ) external payable override returns (bool) {
        emit ValidatorCreated(msg.sender, "", moniker);
        return true;
    }

    function editValidator(
        string memory moniker,
        string memory,
        uint256
    ) external override returns (bool) {
        emit ValidatorEdited(msg.sender, "", moniker);
        return true;
    }

    // ============ Query Methods ============

    function delegation(
        address delegator,
        string memory valAddr
    ) external view override returns (Delegation memory) {
        DelegationInfo storage info = _delegations[delegator][valAddr];
        return Delegation({
            balance: Balance({amount: info.amount, denom: "usei"}),
            delegation: DelegationDetails({
                delegator_address: _addressToSeiAddress(delegator),
                shares: info.shares,
                decimals: 18,
                validator_address: valAddr
            })
        });
    }

    function validators(
        string memory,
        bytes memory
    ) external pure override returns (ValidatorsResponse memory) {
        return ValidatorsResponse({
            validators: new Validator[](0),
            nextKey: ""
        });
    }

    function validator(string memory) external pure override returns (Validator memory) {
        return Validator({
            operatorAddress: "",
            consensusPubkey: "",
            jailed: false,
            status: 3, // BOND_STATUS_BONDED
            tokens: "0",
            delegatorShares: "0",
            description: "",
            unbondingHeight: 0,
            unbondingTime: 0,
            commissionRate: "0.1",
            commissionMaxRate: "0.2",
            commissionMaxChangeRate: "0.01",
            commissionUpdateTime: 0,
            minSelfDelegation: "1"
        });
    }

    function validatorDelegations(
        string memory,
        bytes memory
    ) external pure override returns (DelegationsResponse memory) {
        return DelegationsResponse({
            delegations: new Delegation[](0),
            nextKey: ""
        });
    }

    function validatorUnbondingDelegations(
        string memory,
        bytes memory
    ) external pure override returns (UnbondingDelegationsResponse memory) {
        return UnbondingDelegationsResponse({
            unbondingDelegations: new UnbondingDelegation[](0),
            nextKey: ""
        });
    }

    function delegatorDelegations(
        address delegator,
        bytes memory
    ) external view override returns (DelegationsResponse memory) {
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
                    balance: Balance({amount: info.amount, denom: "usei"}),
                    delegation: DelegationDetails({
                        delegator_address: _addressToSeiAddress(delegator),
                        shares: info.shares,
                        decimals: 18,
                        validator_address: vals[i]
                    })
                });
                idx++;
            }
        }

        return DelegationsResponse({
            delegations: result,
            nextKey: ""
        });
    }

    function delegatorValidator(
        address,
        string memory
    ) external pure override returns (Validator memory) {
        return Validator({
            operatorAddress: "",
            consensusPubkey: "",
            jailed: false,
            status: 3,
            tokens: "0",
            delegatorShares: "0",
            description: "",
            unbondingHeight: 0,
            unbondingTime: 0,
            commissionRate: "0.1",
            commissionMaxRate: "0.2",
            commissionMaxChangeRate: "0.01",
            commissionUpdateTime: 0,
            minSelfDelegation: "1"
        });
    }

    function unbondingDelegation(
        address delegator,
        string memory valAddr
    ) external view override returns (UnbondingDelegation memory) {
        UnbondingInfo storage info = _unbondings[delegator][valAddr];

        UnbondingDelegationEntry[] memory entries = new UnbondingDelegationEntry[](info.balance > 0 ? 1 : 0);
        if (info.balance > 0) {
            entries[0] = UnbondingDelegationEntry({
                creationHeight: 1,
                completionTime: info.completionTime,
                initialBalance: _uintToString(info.balance),
                balance: _uintToString(info.balance)
            });
        }

        return UnbondingDelegation({
            delegatorAddress: _addressToSeiAddress(delegator),
            validatorAddress: valAddr,
            entries: entries
        });
    }

    function delegatorUnbondingDelegations(
        address delegator,
        bytes memory
    ) external view override returns (UnbondingDelegationsResponse memory) {
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
                UnbondingDelegationEntry[] memory entries = new UnbondingDelegationEntry[](1);
                entries[0] = UnbondingDelegationEntry({
                    creationHeight: 1,
                    completionTime: info.completionTime,
                    initialBalance: _uintToString(info.balance),
                    balance: _uintToString(info.balance)
                });

                result[idx] = UnbondingDelegation({
                    delegatorAddress: _addressToSeiAddress(delegator),
                    validatorAddress: vals[i],
                    entries: entries
                });
                idx++;
            }
        }

        return UnbondingDelegationsResponse({
            unbondingDelegations: result,
            nextKey: ""
        });
    }

    function redelegations(
        string memory,
        string memory,
        string memory,
        bytes memory
    ) external pure override returns (RedelegationsResponse memory) {
        return RedelegationsResponse({
            redelegations: new Redelegation[](0),
            nextKey: ""
        });
    }

    function delegatorValidators(
        address,
        bytes memory
    ) external pure override returns (ValidatorsResponse memory) {
        return ValidatorsResponse({
            validators: new Validator[](0),
            nextKey: ""
        });
    }

    function historicalInfo(int64) external pure override returns (HistoricalInfo memory) {
        return HistoricalInfo({
            height: 0,
            validators: new Validator[](0)
        });
    }

    function pool() external pure override returns (Pool memory) {
        return Pool({
            notBondedTokens: "0",
            bondedTokens: "0"
        });
    }

    function params() external pure override returns (Params memory) {
        return Params({
            unbondingTime: 1814400, // 21 days in seconds
            maxValidators: 100,
            maxEntries: 7,
            historicalEntries: 10000,
            bondDenom: "usei",
            minCommissionRate: "0",
            maxVotingPowerRatio: "0.1",
            maxVotingPowerEnforcementThreshold: "100"
        });
    }

    // ============ Helper Functions ============

    function _addressToSeiAddress(address addr) internal pure returns (string memory) {
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

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
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
