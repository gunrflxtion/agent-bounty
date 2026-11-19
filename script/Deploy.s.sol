// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentBountyHub} from "../src/AgentBountyHub.sol";

/// @title Deploy AgentBountyHub
/// @notice DO NOT RUN YET — deployment is a separate, user-confirmed step.
///         When the user approves deployment, run (from the project root):
///           forge script script/Deploy.s.sol --rpc-url <BSC_RPC> --broadcast
///         The deployer wallet must hold BNB for gas. The Agent ID registry
///         address defaults to the Binance Agent ID contract on BSC mainnet;
///         override with env var AGENT_ID_ADDRESS for other networks.
///         After deploy: verify on BscScan, then paste the deployed address
///         into web/app.js (HUB_ADDRESS) and into the hackathon submission.
contract Deploy is Script {
    /// @notice Binance Agent ID registry on BSC mainnet (same value as
    ///         AgentBountyHub.MAINNET_AGENT_ID; duplicated here because
    ///         constants are not reachable via the contract type in scripts).
    address internal constant BSC_MAINNET_AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    function run() external {
        address agentId = vm.envOr("AGENT_ID_ADDRESS", BSC_MAINNET_AGENT_ID);
        console.log("Deploying AgentBountyHub with Agent ID registry:", agentId);

        vm.startBroadcast();
        AgentBountyHub hub = new AgentBountyHub(agentId);
        vm.stopBroadcast();

        console.log("AgentBountyHub deployed at:", address(hub));
    }
}
