// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../../interfaces/IGov.sol";

/**
 * @title MockGov
 * @notice Mock implementation of the Sei Governance precompile for testing
 */
contract MockGov is IGov {
    // Track votes for testing
    mapping(uint64 => mapping(address => int32)) public proposalVotes;
    mapping(uint64 => bool) public proposalExists;
    
    // Track deposits
    mapping(uint64 => uint256) public proposalDeposits;

    // Events for testing
    event VoteCast(uint64 indexed proposalID, address indexed voter, int32 option);
    event WeightedVoteCast(uint64 indexed proposalID, address indexed voter);
    event DepositMade(uint64 indexed proposalID, address indexed depositor, uint256 amount);
    event ProposalSubmitted(uint64 indexed proposalID, address indexed proposer, string proposalJSON);

    // Counter for proposal IDs
    uint64 public nextProposalId = 1;

    // Allow setting proposal existence for testing
    function setProposalExists(uint64 proposalID, bool exists) external {
        proposalExists[proposalID] = exists;
    }

    function vote(uint64 proposalID, int32 option) external override returns (bool success) {
        // Validate vote option (1=Yes, 2=Abstain, 3=No, 4=NoWithVeto)
        require(option >= 1 && option <= 4, "Invalid vote option");
        
        proposalVotes[proposalID][msg.sender] = option;
        
        emit VoteCast(proposalID, msg.sender, option);
        return true;
    }

    function voteWeighted(
        uint64 proposalID,
        WeightedVoteOption[] calldata options
    ) external override returns (bool success) {
        require(options.length > 0, "No options provided");
        
        emit WeightedVoteCast(proposalID, msg.sender);
        return true;
    }

    function deposit(uint64 proposalID) external payable override returns (bool success) {
        require(msg.value > 0, "No deposit provided");
        
        proposalDeposits[proposalID] += msg.value;
        
        emit DepositMade(proposalID, msg.sender, msg.value);
        return true;
    }

    function submitProposal(string calldata proposalJSON) external payable override returns (uint64 proposalID) {
        proposalID = nextProposalId;
        nextProposalId++;
        
        proposalExists[proposalID] = true;
        if (msg.value > 0) {
            proposalDeposits[proposalID] = msg.value;
        }
        
        emit ProposalSubmitted(proposalID, msg.sender, proposalJSON);
        return proposalID;
    }

    // View functions for testing
    function getVote(uint64 proposalID, address voter) external view returns (int32) {
        return proposalVotes[proposalID][voter];
    }

    function getDeposit(uint64 proposalID) external view returns (uint256) {
        return proposalDeposits[proposalID];
    }
}
