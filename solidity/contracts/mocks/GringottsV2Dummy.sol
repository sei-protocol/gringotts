// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../Gringotts.sol";

contract GringottsV2Dummy is Gringotts {
    function dummyVersion() external pure returns (string memory) {
        return "gringotts-v2-dummy";
    }

    function dummyNumber() external pure returns (uint256) {
        return 2;
    }
}
