// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "./Gringotts.sol";

/**
 * @title GringottsFactory
 * @notice Factory contract for deploying upgradeable Gringotts vesting contracts on Sei
 * @dev Deploys ERC1967 proxies pointing to a Gringotts implementation
 */
contract GringottsFactory {
    // ============ Events ============

    event GringottsCreated(
        address indexed proxy,
        address indexed implementation,
        address indexed deployer,
        uint256 totalAmount
    );

    // ============ State Variables ============

    address public implementation;
    address[] public deployedContracts;
    mapping(address => address[]) public contractsByDeployer;

    // ============ Constructor ============

    /**
     * @notice Deploy the factory with a Gringotts implementation
     * @param _implementation Address of the Gringotts implementation contract
     */
    constructor(address _implementation) {
        require(_implementation != address(0), "Invalid implementation");
        require(_implementation.code.length > 0, "Implementation not a contract");
        implementation = _implementation;
    }

    // ============ Functions ============

    /**
     * @notice Deploy a new upgradeable Gringotts contract
     * @dev Deploys an ERC1967 proxy and initializes it
     * @param _admins Array of initial admin addresses
     * @param _operators Array of initial operator addresses
     * @param _vestingTimestamps Array of vesting timestamps
     * @param _vestingAmounts Array of vesting amounts (in wei)
     * @param _unlockDistributionAddress Address to receive unlocked tokens
     * @param _stakingRewardAddress Address to receive staking rewards
     * @param _maxVotingPeriod Maximum voting period in seconds
     * @param _adminVotingThresholdPercentage Percentage threshold for passing proposals
     * @return proxy The address of the deployed proxy contract
     */
    function createGringotts(
        address[] memory _admins,
        address[] memory _operators,
        uint256[] memory _vestingTimestamps,
        uint256[] memory _vestingAmounts,
        address _unlockDistributionAddress,
        address _stakingRewardAddress,
        uint256 _maxVotingPeriod,
        uint8 _adminVotingThresholdPercentage
    ) external payable returns (address proxy) {
        // Encode initialization data
        bytes memory initData = abi.encodeWithSelector(
            Gringotts.initialize.selector,
            _admins,
            _operators,
            _vestingTimestamps,
            _vestingAmounts,
            _unlockDistributionAddress,
            _stakingRewardAddress,
            _maxVotingPeriod,
            _adminVotingThresholdPercentage
        );

        // Deploy proxy with initialization
        proxy = address(new ERC1967Proxy{value: msg.value}(implementation, initData));

        deployedContracts.push(proxy);
        contractsByDeployer[msg.sender].push(proxy);

        emit GringottsCreated(proxy, implementation, msg.sender, msg.value);

        return proxy;
    }

    /**
     * @notice Get all deployed Gringotts proxy addresses
     * @return Array of proxy addresses
     */
    function getDeployedContracts() external view returns (address[] memory) {
        return deployedContracts;
    }

    /**
     * @notice Get contracts deployed by a specific address
     * @param deployer The deployer address
     * @return Array of proxy addresses
     */
    function getContractsByDeployer(address deployer) external view returns (address[] memory) {
        return contractsByDeployer[deployer];
    }

    /**
     * @notice Get the total number of deployed contracts
     * @return The count of deployed contracts
     */
    function getDeployedContractsCount() external view returns (uint256) {
        return deployedContracts.length;
    }
}
