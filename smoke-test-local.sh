#!/usr/bin/env bash
# Local Anvil smoke test for AgentBounty (NOT a deployment — local only).
set -u
export PATH="$HOME/.foundry/bin:$PATH"
cd ~/workspace/agent-bounty || exit 1

KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
RPC=http://127.0.0.1:8545

anvil --port 8545 --gas-price 0 --base-fee 0 > /tmp/anvil-agentbounty.log 2>&1 &
ANVIL_PID=$!
sleep 3

echo "== deployer balance: $(cast balance $DEPLOYER --rpc-url $RPC)"
MOCK=$(forge create test/MockAgentID.sol:MockAgentID --rpc-url $RPC --private-key $KEY --broadcast 2>&1 | grep -oE "Deployed to: 0x[0-9a-fA-F]+" | awk '{print $3}')
echo "MockAgentID: $MOCK"
HUB=$(AGENT_ID_ADDRESS=$MOCK forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $KEY 2>&1 | grep -oE "AgentBountyHub deployed at: 0x[0-9a-fA-F]+" | awk '{print $4}')
echo "Hub: $HUB"

if [ -n "$HUB" ]; then
  echo "== isAgent(deployer) before mint: $(cast call $HUB "isAgent(address)(bool)" $DEPLOYER --rpc-url $RPC)"
  cast send $MOCK "mint(address)" $DEPLOYER --rpc-url $RPC --private-key $KEY --quiet
  echo "== isAgent(deployer) after mint: $(cast call $HUB "isAgent(address)(bool)" $DEPLOYER --rpc-url $RPC)"
  echo "== createProgram (1 BNB escrow, 0.5 reward):"
  cast send $HUB "createProgram(string,string,uint256)" "Smoke Test Program" "ipfs://smoke" 500000000000000000 --value 1ether --rpc-url $RPC --private-key $KEY --quiet
  echo "== programCount: $(cast call $HUB "programCount()(uint256)" --rpc-url $RPC)"
  HASH=$(cast keccak "finding: reentrancy in withdraw()")
  echo "== submitFinding:"
  cast send $HUB "submitFinding(uint256,bytes32,string,uint8)" 1 "$HASH" "ipfs://report-1" 2 --rpc-url $RPC --private-key $KEY --quiet
  echo "== triage approve:"
  cast send $HUB "triageFinding(uint256,bool)" 1 true --rpc-url $RPC --private-key $KEY --quiet
  echo "== claimReward:"
  cast send $HUB "claimReward(uint256)" 1 --rpc-url $RPC --private-key $KEY --quiet
  echo "== finding 1 claimed + program escrow:"
  cast call $HUB "getFinding(uint256)" 1 --rpc-url $RPC
  cast call $HUB "getProgram(uint256)" 1 --rpc-url $RPC
fi

kill $ANVIL_PID 2>/dev/null
echo "anvil stopped"
