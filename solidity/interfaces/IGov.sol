// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IGov
 * @notice Interface for Sei's Governance Precompile at address 0x0000000000000000000000000000000000001006
 * @dev This interface matches the Sei governance precompile
 * @dev See: https://github.com/sei-protocol/sei-chain/blob/main/precompiles/gov/Gov.sol
 */

struct WeightedVoteOption {
    int32 option;   // Vote option (1=Yes, 2=Abstain, 3=No, 4=NoWithVeto)
    string weight;  // Weight as decimal string (e.g., "0.7")
}

interface IGov {
    /**
     * @notice Cast a simple vote on a governance proposal
     * @param proposalID The ID of the proposal to vote on
     * @param option Vote option: 1=Yes, 2=Abstain, 3=No, 4=NoWithVeto
     * @return success Whether the vote was successfully cast
     */
    function vote(uint64 proposalID, int32 option) external returns (bool success);

    /**
     * @notice Cast a weighted vote on a governance proposal (vote splitting)
     * @param proposalID The ID of the proposal to vote on
     * @param options Array of weighted vote options, weights must sum to 1.0
     * @return success Whether the vote was successfully cast
     */
    function voteWeighted(
        uint64 proposalID,
        WeightedVoteOption[] calldata options
    ) external returns (bool success);

    /**
     * @notice Deposit tokens to a governance proposal
     * @param proposalID The ID of the proposal to deposit to
     * @return success Whether the deposit was successful
     * @dev Send usei tokens via msg.value
     */
    function deposit(uint64 proposalID) external payable returns (bool success);

    /**
     * @notice Submit a new governance proposal
     * @param proposalJSON JSON string containing proposal details
     * @return proposalID The ID of the created proposal
     * @dev Deposit should be provided via msg.value
     */
    function submitProposal(string calldata proposalJSON) external payable returns (uint64 proposalID);
}

/**
 * @dev Governance precompile address on Sei
 */
address constant GOV_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000001006;

/**
 * @dev Governance precompile contract instance
 */
IGov constant GOV_CONTRACT = IGov(GOV_PRECOMPILE_ADDRESS);
