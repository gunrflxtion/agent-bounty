// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAgentID — minimal stand-in for the Binance Agent ID registry
/// @notice Only implements what AgentBountyHub needs: balanceOf(). On BSC
///         mainnet the real registry is 0x60b9262456de011f7d15a54cdd8c48baaa8b022f
///         (ERC-721, soulbound, one per user). This mock exists ONLY for local
///         tests on Anvil, where the real contract does not exist.
contract MockAgentID {
    mapping(address => uint256) private _balances;

    function mint(address to) external {
        _balances[to] += 1;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }
}
