// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";
import "../interfaces/IStaking.sol";
import "../interfaces/IDistribution.sol";
import "../interfaces/IGov.sol";

/**
 * @title Gringotts
 * @notice A vesting contract with multi-sig admin governance and staking management for Sei
 * @dev Uses Sei's native staking and distribution precompiles
 * @dev Works with native SEI tokens
 * @dev Upgradeable via UUPS pattern - upgrades require admin multi-sig approval
 */
contract Gringotts is Initializable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    // ============ Enums ============

    enum ProposalStatus {
        Open,
        Passed,
        Executed,
        Expired
    }

    enum ProposalType {
        UpdateAdmin,
        UpdateUnlockedDistributionAddress,
        UpdateStakingRewardDistributionAddress,
        EmergencyWithdraw,
        UpgradeContract,
        GovVote
    }

    // ============ Structs ============

    struct Proposal {
        uint256 id;
        ProposalType proposalType;
        string title;
        address targetAddress;
        bool removeAdmin;
        uint256 startTime;
        uint256 expiresAt;
        ProposalStatus status;
        uint256 yesVotes;
        uint256 totalWeight;
        address proposer;
    }

    struct GovVoteData {
        uint64 govProposalId;
        int32 voteOption;  // 1=Yes, 2=Abstain, 3=No, 4=NoWithVeto
    }

    // ============ Constants ============

    uint256 private constant HUNDRED_YEARS_IN_SECONDS = 100 * 365 * 24 * 60 * 60;
    uint256 private constant PERCENTAGE_DENOMINATOR = 100;
    uint256 private constant WEI_PER_USEI = 1e12;
    uint256 private constant DECIMAL_USEI_PER_WEI = 1e6;

    // Sei Precompile addresses
    IStaking public constant STAKING = IStaking(STAKING_PRECOMPILE_ADDRESS);
    IDistribution public constant DISTRIBUTION = IDistribution(DISTRIBUTION_PRECOMPILE_ADDRESS);
    IGov public constant GOV = IGov(GOV_PRECOMPILE_ADDRESS);

    // ============ State Variables ============

    // Distribution addresses
    address public unlockDistributionAddress;
    address public stakingRewardAddress;
    bool public stakingRewardWithdrawAddressConfigured;

    // Vesting state
    uint256[] public vestingTimestamps;
    uint256[] public vestingAmounts;
    uint256 public totalAmount;

    // Withdrawal tracking
    uint256 public withdrawnStakingRewards;
    uint256 public withdrawnUnlocked;
    uint256 public withdrawnLocked;

    // Admin governance
    mapping(address => bool) public admins;
    uint256 public adminCount;
    mapping(address => bool) public operators;
    uint256 public operatorCount;
    address[] private adminList;
    address[] private operatorList;
    mapping(address => uint256) private adminListIndexPlusOne;
    mapping(address => uint256) private operatorListIndexPlusOne;
    string[] private trackedValidatorList;
    mapping(bytes32 => uint256) private trackedValidatorIndexPlusOne;
    mapping(bytes32 => uint256) private trackedStakedUsei;
    mapping(bytes32 => uint256) private trackedUnbondingUsei;

    // Voting configuration
    uint256 public maxVotingPeriod;
    uint256 public adminVotingThresholdPercentage;

    // Proposals
    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // Gov vote tracking (proposal ID => GovVoteData)
    mapping(uint256 => GovVoteData) public govVoteData;

    // ============ Events ============

    event AdminAdded(address indexed admin);
    event AdminRemoved(address indexed admin);
    event OperatorAdded(address indexed operator);
    event OperatorRemoved(address indexed operator);
    event ProposalCreated(
        uint256 indexed proposalId,
        ProposalType proposalType,
        string title,
        address proposer
    );
    event Voted(uint256 indexed proposalId, address indexed voter);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalStatusChanged(uint256 indexed proposalId, ProposalStatus newStatus);
    event Delegated(string indexed validator, uint256 amount);
    event Redelegated(string indexed srcValidator, string indexed dstValidator, uint256 amount);
    event Undelegated(string indexed validator, uint256 amount);
    event UnlockedWithdrawn(address indexed to, uint256 amount);
    event StakingRewardsWithdrawn(address indexed to, uint256 amount);
    event EmergencyWithdraw(address indexed to, uint256 amount);
    event UnlockDistributionAddressUpdated(address indexed newAddress);
    event StakingRewardAddressUpdated(address indexed newAddress);
    event UpgradeProposed(address indexed newImplementation, uint256 indexed proposalId);
    event UpgradeExecuted(address indexed newImplementation);
    event GovVoteProposed(uint64 indexed govProposalId, int32 voteOption, uint256 indexed proposalId);
    event GovVoteExecuted(uint64 indexed govProposalId, int32 voteOption);

    // ============ Errors ============

    error NoAdmins();
    error NoOperators();
    error Unauthorized();
    error InvalidThreshold();
    error InvalidTranche(string reason);
    error ProposalNotOpen();
    error ProposalExpired();
    error ProposalNotFound();
    error AlreadyVoted();
    error WrongExecuteStatus();
    error NoSufficientUnlockedTokens();
    error ZeroAddress();
    error InsufficientDeposit();
    error TransferFailed();
    error StakingFailed();
    error InvalidImplementation();
    error UpgradeNotApproved();
    error CannotRemoveLastAdmin();
    error DuplicateAddress();
    error InvalidVoteOption();
    error GovVoteFailed();
    error SetWithdrawAddressFailed();
    error DistributionFailed();
    error InvalidStakingAmount();

    // ============ Modifiers ============

    modifier onlyAdmin() {
        if (!admins[msg.sender]) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert Unauthorized();
        _;
    }

    // ============ Constructor ============

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============ Initializer ============

    /**
     * @notice Initialize the Gringotts contract
     * @dev Replaces constructor for upgradeable pattern
     * @param _admins Array of initial admin addresses
     * @param _operators Array of initial operator addresses
     * @param _vestingTimestamps Array of vesting timestamps
     * @param _vestingAmounts Array of vesting amounts (in wei)
     * @param _unlockDistributionAddress Address to receive unlocked tokens
     * @param _stakingRewardAddress Address to receive staking rewards
     * @param _maxVotingPeriod Maximum voting period in seconds
     * @param _adminVotingThresholdPercentage Percentage threshold for passing proposals (0-100)
     */
    function initialize(
        address[] memory _admins,
        address[] memory _operators,
        uint256[] memory _vestingTimestamps,
        uint256[] memory _vestingAmounts,
        address _unlockDistributionAddress,
        address _stakingRewardAddress,
        uint256 _maxVotingPeriod,
        uint8 _adminVotingThresholdPercentage
    ) public payable initializer {
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        if (_admins.length == 0) revert NoAdmins();
        if (_operators.length == 0) revert NoOperators();
        if (_adminVotingThresholdPercentage > 100) revert InvalidThreshold();
        if (_unlockDistributionAddress == address(0)) revert ZeroAddress();
        if (_stakingRewardAddress == address(0)) revert ZeroAddress();

        // Validate and set vesting schedule
        uint256 total = _validateAndSetVestingSchedule(_vestingTimestamps, _vestingAmounts);

        // Verify sufficient deposit
        if (msg.value < total) revert InsufficientDeposit();

        unlockDistributionAddress = _unlockDistributionAddress;
        stakingRewardAddress = _stakingRewardAddress;
        maxVotingPeriod = _maxVotingPeriod;
        adminVotingThresholdPercentage = _adminVotingThresholdPercentage;

        // Set admins (check for duplicates)
        for (uint256 i = 0; i < _admins.length; i++) {
            if (_admins[i] == address(0)) revert ZeroAddress();
            if (admins[_admins[i]]) revert DuplicateAddress();
            _addAdmin(_admins[i]);
        }

        // Set operators (check for duplicates)
        for (uint256 i = 0; i < _operators.length; i++) {
            if (_operators[i] == address(0)) revert ZeroAddress();
            if (operators[_operators[i]]) revert DuplicateAddress();
            _addOperator(_operators[i]);
        }

        // The distribution withdraw address is set by the
        // UpdateStakingRewardDistributionAddress proposal after deployment.
        // Calling the precompile from ERC1967Proxy construction fails on Sei
        // because the proxy address is not associated until its code exists.
    }

    // ============ Operator Functions ============

    /**
     * @notice Delegate SEI to a validator using Sei's staking precompile
     * @param validator The validator's Sei address (e.g., "seivaloper1...")
     * @param amount The amount to delegate (in wei, must be a whole uSEI)
     */
    function delegate(string calldata validator, uint256 amount) external onlyOperator nonReentrant {
        _requireWholeUsei(amount);
        uint256 pendingRewards = _getValidatorPendingRewards(validator);
        uint256 amountUsei = amount / WEI_PER_USEI;

        bool success = STAKING.delegate{value: amount}(validator);
        if (!success) revert StakingFailed();

        bytes32 validatorKey = _trackValidator(validator);
        trackedStakedUsei[validatorKey] += amountUsei;
        _recordConfiguredStakingRewards(pendingRewards);
        emit Delegated(validator, amount);
    }

    /**
     * @notice Redelegate SEI from one validator to another
     * @param srcValidator Source validator's Sei address
     * @param dstValidator Destination validator's Sei address
     * @param amount Amount to redelegate (in wei, converted to uSEI for the precompile)
     */
    function redelegate(
        string calldata srcValidator,
        string calldata dstValidator,
        uint256 amount
    ) external onlyOperator nonReentrant {
        uint256 amountUsei = _weiToUsei(amount);
        uint256 pendingRewards = _getValidatorPendingRewards(srcValidator);
        if (!_stringsEqual(srcValidator, dstValidator)) {
            pendingRewards += _getValidatorPendingRewards(dstValidator);
        }

        bool success = STAKING.redelegate(srcValidator, dstValidator, amountUsei);
        if (!success) revert StakingFailed();

        bytes32 srcKey = _trackValidator(srcValidator);
        bytes32 dstKey = _trackValidator(dstValidator);
        if (!_stringsEqual(srcValidator, dstValidator)) {
            _subtractTrackedStaked(srcKey, amountUsei);
            trackedStakedUsei[dstKey] += amountUsei;
        }
        _recordConfiguredStakingRewards(pendingRewards);
        emit Redelegated(srcValidator, dstValidator, amount);
    }

    /**
     * @notice Undelegate SEI from a validator
     * @param validator The validator's Sei address
     * @param amount Amount to undelegate (in wei, converted to uSEI for the precompile)
     */
    function undelegate(string calldata validator, uint256 amount) external onlyOperator nonReentrant {
        uint256 amountUsei = _weiToUsei(amount);
        uint256 pendingRewards = _getValidatorPendingRewards(validator);

        bool success = STAKING.undelegate(validator, amountUsei);
        if (!success) revert StakingFailed();

        bytes32 validatorKey = _trackValidator(validator);
        _subtractTrackedStaked(validatorKey, amountUsei);
        trackedUnbondingUsei[validatorKey] += amountUsei;
        _recordConfiguredStakingRewards(pendingRewards);
        emit Undelegated(validator, amount);
    }

    /**
     * @notice Withdraw unlocked (vested) SEI
     * @param amount The amount to withdraw
     */
    function initiateWithdrawUnlocked(uint256 amount) external onlyOperator nonReentrant {
        uint256 vestedAmount = _collectVested(amount);
        withdrawnUnlocked += vestedAmount;

        (bool success, ) = unlockDistributionAddress.call{value: vestedAmount}("");
        if (!success) revert TransferFailed();

        emit UnlockedWithdrawn(unlockDistributionAddress, vestedAmount);
    }

    /**
     * @notice Withdraw staking rewards using Sei's distribution precompile
     * @param validators Array of validator addresses to withdraw rewards from
     */
    function initiateWithdrawReward(string[] calldata validators) external onlyOperator nonReentrant {
        // First, send any rewards already in contract balance (from auto-withdrawals)
        uint256 totalWithdrawn = _calculateWithdrawnRewards();
        _sendStakingRewards(totalWithdrawn);

        if (validators.length > 0) {
            IDistribution.Rewards memory rewardsInfo = DISTRIBUTION.rewards(address(this));
            string[] memory eligibleValidators = new string[](validators.length);
            uint256 eligibleCount = 0;
            uint256 withdrawableRewards = 0;

            for (uint256 i = 0; i < validators.length; i++) {
                if (_containsValidator(eligibleValidators, eligibleCount, validators[i])) {
                    continue;
                }

                uint256 validatorRewards = _getValidatorWithdrawableRewards(rewardsInfo, validators[i]);
                if (validatorRewards > 0) {
                    eligibleValidators[eligibleCount] = validators[i];
                    eligibleCount++;
                    withdrawableRewards += validatorRewards;
                }
            }

            if (eligibleCount > 0) {
                string[] memory validatorsToWithdraw = new string[](eligibleCount);
                for (uint256 i = 0; i < eligibleCount; i++) {
                    validatorsToWithdraw[i] = eligibleValidators[i];
                }

                uint256 balanceBefore = address(this).balance;
                bool success = DISTRIBUTION.withdrawMultipleDelegationRewards(validatorsToWithdraw);
                if (!success) revert DistributionFailed();
                if (stakingRewardWithdrawAddressConfigured) {
                    totalWithdrawn += withdrawableRewards;
                } else if (address(this).balance > balanceBefore) {
                    uint256 receivedRewards = address(this).balance - balanceBefore;
                    _sendStakingRewards(receivedRewards);
                    totalWithdrawn += receivedRewards;
                }
            }
        }

        if (totalWithdrawn > 0) {
            _recordWithdrawnStakingRewards(totalWithdrawn);
        }
    }

    /**
     * @notice Withdraw staking rewards from a single validator
     * @param validator The validator's Sei address
     */
    function withdrawSingleValidatorReward(string calldata validator) external onlyOperator nonReentrant {
        // Query pending rewards for this validator before withdrawal
        uint256 pendingRewards = _getValidatorPendingRewards(validator);
        if (pendingRewards == 0) {
            return;
        }

        // Rewards go directly to the withdraw address set in the distribution precompile.
        uint256 balanceBefore = address(this).balance;
        bool success = DISTRIBUTION.withdrawDelegationRewards(validator);
        if (!success) revert DistributionFailed();

        if (stakingRewardWithdrawAddressConfigured) {
            _recordWithdrawnStakingRewards(pendingRewards);
        } else if (address(this).balance > balanceBefore) {
            uint256 receivedRewards = address(this).balance - balanceBefore;
            _sendStakingRewards(receivedRewards);
            _recordWithdrawnStakingRewards(receivedRewards);
        }
    }

    // ============ Admin Functions ============

    /**
     * @notice Update an operator (add or remove)
     * @param op Operator address
     * @param remove Whether to remove the operator
     */
    function updateOp(address op, bool remove) external onlyAdmin {
        if (op == address(0)) revert ZeroAddress();

        if (remove) {
            _removeOperator(op);
        } else {
            _addOperator(op);
        }
    }

    /**
     * @notice Propose to add or remove an admin
     * @param admin The admin address
     * @param remove Whether to remove the admin
     */
    function proposeUpdateAdmin(address admin, bool remove) external onlyAdmin {
        if (admin == address(0)) revert ZeroAddress();

        _createProposal(ProposalType.UpdateAdmin, remove ? "Remove admin" : "Add admin", admin, remove);
    }

    /**
     * @notice Propose to update the unlocked distribution address
     * @param newAddress The new address
     */
    function proposeUpdateUnlockedDistributionAddress(address newAddress) external onlyAdmin {
        if (newAddress == address(0)) revert ZeroAddress();

        _createProposal(ProposalType.UpdateUnlockedDistributionAddress, "Update unlock distribution address", newAddress, false);
    }

    /**
     * @notice Propose to update the staking reward distribution address
     * @param newAddress The new address
     */
    function proposeUpdateStakingRewardDistributionAddress(address newAddress) external onlyAdmin {
        if (newAddress == address(0)) revert ZeroAddress();

        _createProposal(ProposalType.UpdateStakingRewardDistributionAddress, "Update staking reward address", newAddress, false);
    }

    /**
     * @notice Propose an emergency withdrawal of all locked tokens
     * @param dst Destination address for the withdrawal
     */
    function proposeEmergencyWithdraw(address dst) external onlyAdmin {
        if (dst == address(0)) revert ZeroAddress();

        _createProposal(ProposalType.EmergencyWithdraw, "Emergency withdraw", dst, false);
    }

    /**
     * @notice Propose a contract upgrade to a new implementation
     * @param newImplementation Address of the new implementation contract
     */
    function proposeUpgrade(address newImplementation) external onlyAdmin {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (newImplementation.code.length == 0) revert InvalidImplementation();

        _createProposal(ProposalType.UpgradeContract, "Upgrade contract", newImplementation, false);
        
        emit UpgradeProposed(newImplementation, proposalCount);
    }

    /**
     * @notice Propose a vote on a Sei governance proposal
     * @param govProposalId The governance proposal ID on Sei
     * @param voteOption Vote option: 1=Yes, 2=Abstain, 3=No, 4=NoWithVeto
     */
    function proposeGovVote(uint64 govProposalId, int32 voteOption) external onlyAdmin {
        // Validate vote option (1=Yes, 2=Abstain, 3=No, 4=NoWithVeto)
        if (voteOption < 1 || voteOption > 4) revert InvalidVoteOption();

        _createProposal(ProposalType.GovVote, "Gov vote", address(0), false);
        
        // Store the gov vote data for this proposal
        govVoteData[proposalCount] = GovVoteData({
            govProposalId: govProposalId,
            voteOption: voteOption
        });

        emit GovVoteProposed(govProposalId, voteOption, proposalCount);
    }

    /**
     * @notice Vote on a proposal (only Yes votes supported, like the original)
     * @param proposalId The proposal ID
     */
    function voteProposal(uint256 proposalId) external onlyAdmin {
        _requireProposalExists(proposalId);
        Proposal storage prop = proposals[proposalId];

        _updateProposalStatus(proposalId);

        if (prop.status == ProposalStatus.Expired) return;
        if (prop.status != ProposalStatus.Open) revert ProposalNotOpen();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        hasVoted[proposalId][msg.sender] = true;
        prop.yesVotes++;

        emit Voted(proposalId, msg.sender);

        _updateProposalStatus(proposalId);
    }

    /**
     * @notice Process (execute) a passed proposal
     * @param proposalId The proposal ID
     */
    function processProposal(uint256 proposalId) external onlyAdmin nonReentrant {
        _requireProposalExists(proposalId);
        Proposal storage prop = proposals[proposalId];

        _updateProposalStatus(proposalId);

        if (prop.status == ProposalStatus.Expired) return;
        if (prop.status != ProposalStatus.Passed) revert WrongExecuteStatus();

        prop.status = ProposalStatus.Executed;
        emit ProposalStatusChanged(proposalId, ProposalStatus.Executed);

        // Execute based on proposal type
        if (prop.proposalType == ProposalType.UpdateAdmin) {
            _executeUpdateAdmin(prop.targetAddress, prop.removeAdmin);
        } else if (prop.proposalType == ProposalType.UpdateUnlockedDistributionAddress) {
            _executeUpdateUnlockDistributionAddress(prop.targetAddress);
        } else if (prop.proposalType == ProposalType.UpdateStakingRewardDistributionAddress) {
            _executeUpdateStakingRewardAddress(prop.targetAddress);
        } else if (prop.proposalType == ProposalType.EmergencyWithdraw) {
            _executeEmergencyWithdraw(prop.targetAddress);
        } else if (prop.proposalType == ProposalType.UpgradeContract) {
            _executeUpgrade(prop.targetAddress);
        } else if (prop.proposalType == ProposalType.GovVote) {
            _executeGovVote(proposalId);
        }

        emit ProposalExecuted(proposalId);
    }

    // ============ View Functions ============

    /**
     * @notice Get the total vested amount at current time
     * @return The total vested amount
     */
    function getTotalVested() external view returns (uint256) {
        return _totalVestedAmount(block.timestamp);
    }

    /**
     * @notice Get vesting schedule info
     * @return timestamps Array of vesting timestamps
     * @return amounts Array of vesting amounts
     */
    function getVestingSchedule() external view returns (uint256[] memory timestamps, uint256[] memory amounts) {
        return (vestingTimestamps, vestingAmounts);
    }

    /**
     * @notice Get contract info
     */
    function getInfo()
        external
        view
        returns (
            address _unlockDistributionAddress,
            address _stakingRewardAddress,
            uint256 _withdrawnStakingRewards,
            uint256 _withdrawnUnlocked,
            uint256 _withdrawnLocked,
            uint256 _balance
        )
    {
        return (
            unlockDistributionAddress,
            stakingRewardAddress,
            withdrawnStakingRewards,
            withdrawnUnlocked,
            withdrawnLocked,
            address(this).balance
        );
    }

    /**
     * @notice Get configuration info
     */
    function getConfig()
        external
        view
        returns (
            uint256 _maxVotingPeriod,
            uint256 _adminVotingThresholdPercentage,
            uint256 _adminCount,
            uint256 _operatorCount
        )
    {
        return (maxVotingPeriod, adminVotingThresholdPercentage, adminCount, operatorCount);
    }

    /**
     * @notice Get proposal details
     * @param proposalId The proposal ID
     */
    function getProposal(uint256 proposalId) external view returns (Proposal memory) {
        return proposals[proposalId];
    }

    /**
     * @notice Get delegation info for a validator using Sei precompile
     * @param validator The validator's Sei address
     */
    function getDelegation(string calldata validator) external view returns (IStaking.Delegation memory) {
        return STAKING.delegation(address(this), validator);
    }

    /**
     * @notice Get delegations for this contract (first page only)
     * @dev Sei's staking precompile does not expose the delegation list query on every chain
     *      version, so this returns point-lookups for validators Gringotts has used.
     */
    function getAllDelegations() external view returns (IStaking.Delegation[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < trackedValidatorList.length; i++) {
            if (trackedStakedUsei[_validatorKey(trackedValidatorList[i])] > 0) {
                count++;
            }
        }

        IStaking.Delegation[] memory delegations = new IStaking.Delegation[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < trackedValidatorList.length; i++) {
            if (trackedStakedUsei[_validatorKey(trackedValidatorList[i])] > 0) {
                delegations[idx] = STAKING.delegation(address(this), trackedValidatorList[i]);
                idx++;
            }
        }
        return delegations;
    }

    /**
     * @notice Get unbonding delegations (first page only)
     * @dev Returns Gringotts' locally tracked undelegations because the live precompile
     *      does not expose unbonding list queries on every chain version.
     */
    function getUnbondingDelegations() external view returns (IStaking.UnbondingDelegation[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < trackedValidatorList.length; i++) {
            if (trackedUnbondingUsei[_validatorKey(trackedValidatorList[i])] > 0) {
                count++;
            }
        }

        IStaking.UnbondingDelegation[] memory unbondingDelegations = new IStaking.UnbondingDelegation[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < trackedValidatorList.length; i++) {
            uint256 balanceUsei = trackedUnbondingUsei[_validatorKey(trackedValidatorList[i])];
            if (balanceUsei > 0) {
                string memory balance = _uintToString(balanceUsei);
                IStaking.UnbondingDelegationEntry[] memory entries = new IStaking.UnbondingDelegationEntry[](1);
                entries[0] = IStaking.UnbondingDelegationEntry({
                    creationHeight: 0,
                    completionTime: 0,
                    initialBalance: balance,
                    balance: balance
                });
                unbondingDelegations[idx] = IStaking.UnbondingDelegation({
                    delegatorAddress: "",
                    validatorAddress: trackedValidatorList[i],
                    entries: entries
                });
                idx++;
            }
        }
        return unbondingDelegations;
    }

    /**
     * @notice Get pending rewards
     */
    function getPendingRewards() external view returns (IDistribution.Rewards memory) {
        return DISTRIBUTION.rewards(address(this));
    }

    /**
     * @notice Check if an address is an admin
     */
    function isAdmin(address account) external view returns (bool) {
        return admins[account];
    }

    /**
     * @notice Check if an address is an operator
     */
    function isOperator(address account) external view returns (bool) {
        return operators[account];
    }

    /**
     * @notice List current admins
     */
    function listAdmins() external view returns (address[] memory) {
        return adminList;
    }

    /**
     * @notice List current operators
     */
    function listOperators() external view returns (address[] memory) {
        return operatorList;
    }

    /**
     * @notice Get the current implementation address
     */
    function getImplementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }

    // ============ Internal Functions ============

    /**
     * @notice Authorization check for UUPS upgrades
     * @dev Only allows upgrades through the multi-sig proposal process
     */
    /**
     * @notice Block direct calls to upgradeToAndCall - upgrades must go through proposal system
     * @dev This override ensures no one can bypass the multi-sig governance
     */
    function upgradeToAndCall(address, bytes memory) public payable override {
        revert UpgradeNotApproved();
    }

    /**
     * @notice Authorization hook required by UUPSUpgradeable - always reverts
     * @dev All upgrades go through _executeUpgrade which bypasses this check
     */
    function _authorizeUpgrade(address) internal pure override {
        revert UpgradeNotApproved();
    }

    /**
     * @notice Execute an approved upgrade
     * @dev Calls ERC1967Utils directly, bypassing upgradeToAndCall
     * @param newImplementation The new implementation address
     */
    function _executeUpgrade(address newImplementation) internal {
        // Verify the new implementation is UUPS-compatible
        try IERC1822Proxiable(newImplementation).proxiableUUID() returns (bytes32 slot) {
            if (slot != ERC1967Utils.IMPLEMENTATION_SLOT) {
                revert InvalidImplementation();
            }
        } catch {
            revert InvalidImplementation();
        }

        // Perform the upgrade directly via ERC1967Utils
        // This avoids the external self-call pattern and pendingImplementation state
        ERC1967Utils.upgradeToAndCall(newImplementation, "");
        emit UpgradeExecuted(newImplementation);
    }

    function _validateAndSetVestingSchedule(
        uint256[] memory _timestamps,
        uint256[] memory _amounts
    ) internal returns (uint256 total) {
        if (_timestamps.length != _amounts.length) {
            revert InvalidTranche("mismatched vesting amounts and schedule");
        }
        if (_amounts.length == 0) {
            revert InvalidTranche("nothing to vest");
        }

        uint256 lastTimestamp = 0;

        for (uint256 i = 0; i < _timestamps.length; i++) {
            if (_amounts[i] == 0) {
                revert InvalidTranche("zero vesting amount is not allowed");
            }
            if (_timestamps[i] <= lastTimestamp) {
                revert InvalidTranche("vesting schedule must be monotonic increasing");
            }
            // Migration exports can include already-vested tranches that have not been withdrawn yet.
            if (_timestamps[i] > block.timestamp + HUNDRED_YEARS_IN_SECONDS) {
                revert InvalidTranche("timestamp is too far in the future");
            }

            total += _amounts[i];
            lastTimestamp = _timestamps[i];
        }

        vestingTimestamps = _timestamps;
        vestingAmounts = _amounts;
        totalAmount = total;
    }

    function _createProposal(
        ProposalType proposalType,
        string memory title,
        address targetAddress,
        bool removeAdmin
    ) internal {
        proposalCount++;
        uint256 proposalId = proposalCount;

        proposals[proposalId] = Proposal({
            id: proposalId,
            proposalType: proposalType,
            title: title,
            targetAddress: targetAddress,
            removeAdmin: removeAdmin,
            startTime: block.timestamp,
            expiresAt: block.timestamp + maxVotingPeriod,
            status: ProposalStatus.Open,
            yesVotes: 1,
            totalWeight: adminCount,
            proposer: msg.sender
        });

        hasVoted[proposalId][msg.sender] = true;

        emit ProposalCreated(proposalId, proposalType, title, msg.sender);
        emit Voted(proposalId, msg.sender);

        _updateProposalStatus(proposalId);
    }

    function _updateProposalStatus(uint256 proposalId) internal {
        Proposal storage prop = proposals[proposalId];

        if (prop.status != ProposalStatus.Open) return;

        if (block.timestamp > prop.expiresAt) {
            prop.status = ProposalStatus.Expired;
            emit ProposalStatusChanged(proposalId, ProposalStatus.Expired);
            return;
        }

        if (prop.yesVotes * PERCENTAGE_DENOMINATOR >= prop.totalWeight * adminVotingThresholdPercentage) {
            prop.status = ProposalStatus.Passed;
            emit ProposalStatusChanged(proposalId, ProposalStatus.Passed);
        }
    }

    function _requireProposalExists(uint256 proposalId) internal view {
        if (proposalId == 0 || proposalId > proposalCount) revert ProposalNotFound();
    }

    function _executeUpdateAdmin(address admin, bool remove) internal {
        if (remove) {
            _removeAdmin(admin);
        } else {
            _addAdmin(admin);
        }
    }

    function _executeUpdateUnlockDistributionAddress(address newAddress) internal {
        unlockDistributionAddress = newAddress;
        emit UnlockDistributionAddressUpdated(newAddress);
    }

    function _executeUpdateStakingRewardAddress(address newAddress) internal {
        stakingRewardAddress = newAddress;
        // Update the distribution precompile's withdraw address
        bool success = DISTRIBUTION.setWithdrawAddress(newAddress);
        if (!success) revert SetWithdrawAddressFailed();
        stakingRewardWithdrawAddressConfigured = true;
        emit StakingRewardAddressUpdated(newAddress);
    }

    function _executeEmergencyWithdraw(address dst) internal {
        uint256 amount = 0;
        for (uint256 i = 0; i < vestingAmounts.length; i++) {
            amount += vestingAmounts[i];
        }

        delete vestingTimestamps;
        delete vestingAmounts;

        withdrawnLocked += amount;

        if (amount > 0) {
            (bool success, ) = dst.call{value: amount}("");
            if (!success) revert TransferFailed();
        }

        emit EmergencyWithdraw(dst, amount);
    }

    function _executeGovVote(uint256 proposalId) internal {
        GovVoteData memory voteData = govVoteData[proposalId];
        bool success = GOV.vote(voteData.govProposalId, voteData.voteOption);
        if (!success) revert GovVoteFailed();
        emit GovVoteExecuted(voteData.govProposalId, voteData.voteOption);
    }

    function _recordWithdrawnStakingRewards(uint256 amount) internal {
        if (amount == 0) {
            return;
        }

        withdrawnStakingRewards += amount;
        emit StakingRewardsWithdrawn(stakingRewardAddress, amount);
    }

    function _recordConfiguredStakingRewards(uint256 amount) internal {
        if (!stakingRewardWithdrawAddressConfigured) {
            return;
        }

        _recordWithdrawnStakingRewards(amount);
    }

    function _sendStakingRewards(uint256 amount) internal {
        if (amount == 0) {
            return;
        }

        (bool success, ) = stakingRewardAddress.call{value: amount}("");
        if (!success) revert TransferFailed();
    }

    function _collectVested(uint256 requestedAmount) internal returns (uint256) {
        uint256 vestedAmount = 0;
        uint256 amountToSubtract = 0;
        uint256 remainingFirstIdx = 0;

        for (uint256 i = 0; i < vestingTimestamps.length; i++) {
            if (vestingTimestamps[i] > block.timestamp) {
                break;
            }

            vestedAmount += vestingAmounts[i];

            if (vestedAmount >= requestedAmount) {
                amountToSubtract = vestingAmounts[i] + requestedAmount - vestedAmount;
                if (vestedAmount == requestedAmount) {
                    remainingFirstIdx = i + 1;
                    amountToSubtract = 0;
                }
                vestedAmount = requestedAmount;
                break;
            }
            remainingFirstIdx = i + 1;
        }

        if (vestedAmount < requestedAmount) {
            revert NoSufficientUnlockedTokens();
        }

        if (remainingFirstIdx >= vestingAmounts.length) {
            delete vestingTimestamps;
            delete vestingAmounts;
        } else {
            uint256 newLength = vestingAmounts.length - remainingFirstIdx;
            uint256[] memory newTimestamps = new uint256[](newLength);
            uint256[] memory newAmounts = new uint256[](newLength);

            for (uint256 i = 0; i < newLength; i++) {
                newTimestamps[i] = vestingTimestamps[remainingFirstIdx + i];
                newAmounts[i] = vestingAmounts[remainingFirstIdx + i];
            }

            if (amountToSubtract > 0) {
                newAmounts[0] -= amountToSubtract;
            }

            vestingTimestamps = newTimestamps;
            vestingAmounts = newAmounts;
        }

        return vestedAmount;
    }

    function _totalVestedAmount(uint256 timestamp) internal view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < vestingTimestamps.length; i++) {
            if (vestingTimestamps[i] <= timestamp) {
                total += vestingAmounts[i];
            } else {
                break;
            }
        }
        return total;
    }

    function _calculateWithdrawnRewards() internal view returns (uint256) {
        uint256 bankBalance = address(this).balance;
        uint256 withdrawnPrincipal = withdrawnLocked + withdrawnUnlocked;

        // Calculate staked amount from all delegations (with pagination)
        uint256 staked = _getTotalStaked();

        // Calculate unbonding amount from all unbonding delegations (with pagination)
        uint256 unbonding = _getTotalUnbonding();

        uint256 principalInBank = 0;
        if (withdrawnPrincipal + staked + unbonding < totalAmount) {
            principalInBank = totalAmount - withdrawnPrincipal - staked - unbonding;
        }

        if (principalInBank < bankBalance) {
            return bankBalance - principalInBank;
        }
        return 0;
    }

    /**
     * @notice Get total staked amount across all validators Gringotts has used
     * @return total Total staked amount in wei
     */
    function _getTotalStaked() internal view returns (uint256 total) {
        for (uint256 i = 0; i < trackedValidatorList.length; i++) {
            total += _useiToWei(trackedStakedUsei[_validatorKey(trackedValidatorList[i])]);
        }
        return total;
    }

    /**
     * @notice Get total unbonding amount across all validators Gringotts has used
     * @return total Total unbonding amount in wei
     */
    function _getTotalUnbonding() internal view returns (uint256 total) {
        for (uint256 i = 0; i < trackedValidatorList.length; i++) {
            total += _useiToWei(trackedUnbondingUsei[_validatorKey(trackedValidatorList[i])]);
        }
        return total;
    }

    function _getValidatorPendingRewards(string calldata validator) internal view returns (uint256) {
        IDistribution.Rewards memory rewardsInfo = DISTRIBUTION.rewards(address(this));
        return _getValidatorWithdrawableRewards(rewardsInfo, validator);
    }

    function _getValidatorWithdrawableRewards(
        IDistribution.Rewards memory rewardsInfo,
        string memory validator
    ) internal pure returns (uint256) {
        for (uint256 i = 0; i < rewardsInfo.rewards.length; i++) {
            if (_stringsEqual(rewardsInfo.rewards[i].validator_address, validator)) {
                uint256 total = 0;
                for (uint256 j = 0; j < rewardsInfo.rewards[i].coins.length; j++) {
                    total += _coinAmountToWei(rewardsInfo.rewards[i].coins[j]);
                }
                return _truncateToUseiWei(total);
            }
        }
        return 0;
    }

    function _coinAmountToWei(IDistribution.Coin memory coin) internal pure returns (uint256) {
        return coin.amount / DECIMAL_USEI_PER_WEI;
    }

    function _truncateToUseiWei(uint256 amountWei) internal pure returns (uint256) {
        return (amountWei / WEI_PER_USEI) * WEI_PER_USEI;
    }

    function _requireWholeUsei(uint256 amountWei) internal pure {
        if (amountWei == 0 || amountWei % WEI_PER_USEI != 0) revert InvalidStakingAmount();
    }

    function _weiToUsei(uint256 amountWei) internal pure returns (uint256) {
        _requireWholeUsei(amountWei);
        return amountWei / WEI_PER_USEI;
    }

    function _useiToWei(uint256 amountUsei) internal pure returns (uint256) {
        return amountUsei * WEI_PER_USEI;
    }

    function _containsValidator(
        string[] memory validators,
        uint256 length,
        string calldata validator
    ) internal pure returns (bool) {
        for (uint256 i = 0; i < length; i++) {
            if (_stringsEqual(validators[i], validator)) {
                return true;
            }
        }
        return false;
    }

    function _addAdmin(address admin) internal {
        if (admins[admin]) {
            return;
        }
        admins[admin] = true;
        adminCount++;
        adminList.push(admin);
        adminListIndexPlusOne[admin] = adminList.length;
        emit AdminAdded(admin);
    }

    function _removeAdmin(address admin) internal {
        if (!admins[admin]) {
            return;
        }
        if (adminCount <= 1) revert CannotRemoveLastAdmin();

        admins[admin] = false;
        adminCount--;
        _removeAddressFromList(adminList, adminListIndexPlusOne, admin);
        emit AdminRemoved(admin);
    }

    function _addOperator(address operator) internal {
        if (operators[operator]) {
            return;
        }
        operators[operator] = true;
        operatorCount++;
        operatorList.push(operator);
        operatorListIndexPlusOne[operator] = operatorList.length;
        emit OperatorAdded(operator);
    }

    function _removeOperator(address operator) internal {
        if (!operators[operator]) {
            return;
        }
        operators[operator] = false;
        operatorCount--;
        _removeAddressFromList(operatorList, operatorListIndexPlusOne, operator);
        emit OperatorRemoved(operator);
    }

    function _removeAddressFromList(
        address[] storage list,
        mapping(address => uint256) storage indexPlusOne,
        address account
    ) internal {
        uint256 index = indexPlusOne[account] - 1;
        uint256 lastIndex = list.length - 1;

        if (index != lastIndex) {
            address last = list[lastIndex];
            list[index] = last;
            indexPlusOne[last] = index + 1;
        }

        list.pop();
        delete indexPlusOne[account];
    }

    function _stringsEqual(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _trackValidator(string memory validator) internal returns (bytes32 key) {
        key = _validatorKey(validator);
        if (trackedValidatorIndexPlusOne[key] == 0) {
            trackedValidatorList.push(validator);
            trackedValidatorIndexPlusOne[key] = trackedValidatorList.length;
        }
        return key;
    }

    function _subtractTrackedStaked(bytes32 validatorKey, uint256 amountUsei) internal {
        uint256 stakedUsei = trackedStakedUsei[validatorKey];
        trackedStakedUsei[validatorKey] = amountUsei < stakedUsei ? stakedUsei - amountUsei : 0;
    }

    function _validatorKey(string memory validator) internal pure returns (bytes32) {
        return keccak256(bytes(validator));
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

    // ============ Receive Function ============

    /**
     * @notice Allow contract to receive SEI
     */
    receive() external payable {}

    // ============ Storage Gap ============

    /**
     * @dev Reserved storage space for future upgrades
     * This allows adding new state variables in upgrades without shifting existing storage
     */
    uint256[45] private __gap;
}
