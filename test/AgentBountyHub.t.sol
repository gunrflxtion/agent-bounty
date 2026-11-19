// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {AgentBountyHub} from "../src/AgentBountyHub.sol";
import {MockAgentID} from "./MockAgentID.sol";

/// @title AgentBountyHub tests — full lifecycle + access control + escrow safety
contract AgentBountyHubTest is Test {
    AgentBountyHub public hub;
    MockAgentID public agentId;

    address public sponsor = makeAddr("sponsor");
    address public agentA = makeAddr("agentA"); // Agent ID holder
    address public agentB = makeAddr("agentB"); // Agent ID holder
    address public stranger = makeAddr("stranger"); // no Agent ID

    uint256 public constant REWARD = 0.5 ether;
    bytes32 public constant REPORT_HASH = keccak256("finding: reentrancy in withdraw()");

    event ProgramCreated(
        uint256 indexed programId, address indexed owner, string title, uint256 rewardPerFinding, uint256 initialEscrow
    );
    event FindingSubmitted(
        uint256 indexed findingId,
        uint256 indexed programId,
        address indexed agent,
        bytes32 reportHash,
        AgentBountyHub.Severity severity
    );
    event FindingTriaged(uint256 indexed findingId, uint256 indexed programId, bool approved);
    event RewardClaimed(uint256 indexed findingId, uint256 indexed programId, address indexed agent, uint256 amount);

    function setUp() public {
        agentId = new MockAgentID();
        hub = new AgentBountyHub(address(agentId));

        // Give both agents an Agent ID (mock mint).
        agentId.mint(agentA);
        agentId.mint(agentB);

        // Sponsor funds.
        vm.deal(sponsor, 10 ether);
        vm.deal(agentA, 1 ether);
        vm.deal(agentB, 1 ether);
    }

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    function _createProgram() internal returns (uint256 programId) {
        vm.prank(sponsor);
        programId = hub.createProgram{value: 2 ether}("Acme DEX", "ipfs://scope-acme", REWARD);
    }

    function _submitFinding(uint256 programId, address agent) internal returns (uint256 findingId) {
        vm.prank(agent);
        findingId = hub.submitFinding(programId, REPORT_HASH, "ipfs://report-1", AgentBountyHub.Severity.High);
    }

    // ------------------------------------------------------------------------
    // Happy path
    // ------------------------------------------------------------------------

    function test_CreateProgram_RecordsEscrow() public {
        vm.expectEmit(true, true, false, true);
        emit ProgramCreated(1, sponsor, "Acme DEX", REWARD, 2 ether);

        vm.prank(sponsor);
        uint256 id = hub.createProgram{value: 2 ether}("Acme DEX", "ipfs://scope-acme", REWARD);
        assertEq(id, 1);

        AgentBountyHub.Program memory p = hub.getProgram(id);
        assertEq(p.owner, sponsor);
        assertEq(p.rewardPerFinding, REWARD);
        assertEq(p.escrow, 2 ether);
        assertEq(p.closed, false);
        assertEq(address(hub).balance, 2 ether);
    }

    function test_FullFlow_CreateSubmitApproveClaim() public {
        uint256 programId = _createProgram();
        uint256 findingId = _submitFinding(programId, agentA);

        AgentBountyHub.Finding memory f = hub.getFinding(findingId);
        assertEq(f.agent, agentA);
        assertEq(f.reportHash, REPORT_HASH);
        assertEq(uint8(f.status), uint8(AgentBountyHub.FindingStatus.Submitted));
        assertEq(f.claimed, false);

        // Owner approves.
        vm.prank(sponsor);
        hub.triageFinding(findingId, true);

        // Agent claims explicitly.
        uint256 before = agentA.balance;
        vm.prank(agentA);
        hub.claimReward(findingId);
        assertEq(agentA.balance, before + REWARD);
        assertEq(hub.getFinding(findingId).claimed, true);
        assertEq(hub.getProgram(programId).escrow, 2 ether - REWARD);
    }

    function test_FundProgram_TopsUpEscrow() public {
        uint256 programId = _createProgram();
        vm.prank(sponsor);
        hub.fundProgram{value: 1 ether}(programId);
        assertEq(hub.getProgram(programId).escrow, 3 ether);
    }

    function test_MultipleFindings_EachAgentClaimsOwn() public {
        uint256 programId = _createProgram();
        uint256 f1 = _submitFinding(programId, agentA);
        uint256 f2 = _submitFinding(programId, agentB);

        vm.prank(sponsor);
        hub.triageFinding(f1, true);
        vm.prank(sponsor);
        hub.triageFinding(f2, true);

        vm.prank(agentA);
        hub.claimReward(f1);
        vm.prank(agentB);
        hub.claimReward(f2);

        assertEq(hub.getProgram(programId).escrow, 2 ether - 2 * REWARD);
    }

    // ------------------------------------------------------------------------
    // Reject path
    // ------------------------------------------------------------------------

    function test_Reject_NoRewardAndEscrowIntact() public {
        uint256 programId = _createProgram();
        uint256 findingId = _submitFinding(programId, agentA);

        vm.prank(sponsor);
        hub.triageFinding(findingId, false);

        assertEq(uint8(hub.getFinding(findingId).status), uint8(AgentBountyHub.FindingStatus.Rejected));
        assertEq(hub.getProgram(programId).escrow, 2 ether);

        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.FindingNotApproved.selector);
        hub.claimReward(findingId);
    }

    // ------------------------------------------------------------------------
    // Access control — Agent ID gate
    // ------------------------------------------------------------------------

    function test_Revert_SubmitWithoutAgentId() public {
        uint256 programId = _createProgram();
        assertEq(hub.isAgent(stranger), false);
        assertEq(hub.isAgent(agentA), true);

        vm.prank(stranger);
        vm.expectRevert(AgentBountyHub.NotAgentIdHolder.selector);
        hub.submitFinding(programId, REPORT_HASH, "ipfs://report-1", AgentBountyHub.Severity.Low);
    }

    function test_Revert_TriageNotOwner() public {
        uint256 programId = _createProgram();
        uint256 findingId = _submitFinding(programId, agentA);

        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.NotProgramOwner.selector);
        hub.triageFinding(findingId, true);
    }

    function test_Revert_FundNotOwner() public {
        uint256 programId = _createProgram();
        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.NotProgramOwner.selector);
        hub.fundProgram{value: 0.1 ether}(programId);
    }

    function test_Revert_CloseNotOwner() public {
        uint256 programId = _createProgram();
        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.NotProgramOwner.selector);
        hub.closeProgram(programId);
    }

    function test_Revert_WithdrawNotOwner() public {
        uint256 programId = _createProgram();
        vm.prank(sponsor);
        hub.closeProgram(programId);
        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.NotProgramOwner.selector);
        hub.withdrawEscrow(programId);
    }

    // ------------------------------------------------------------------------
    // Claim safety
    // ------------------------------------------------------------------------

    function test_Revert_DoubleClaim() public {
        uint256 programId = _createProgram();
        uint256 findingId = _submitFinding(programId, agentA);
        vm.prank(sponsor);
        hub.triageFinding(findingId, true);

        vm.prank(agentA);
        hub.claimReward(findingId);

        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.AlreadyClaimed.selector);
        hub.claimReward(findingId);
    }

    function test_Revert_ClaimByNonSubmitter() public {
        uint256 programId = _createProgram();
        uint256 findingId = _submitFinding(programId, agentA);
        vm.prank(sponsor);
        hub.triageFinding(findingId, true);

        vm.prank(agentB);
        vm.expectRevert(AgentBountyHub.NotFindingSubmitter.selector);
        hub.claimReward(findingId);
    }

    function test_Revert_ClaimBeforeApprove() public {
        uint256 programId = _createProgram();
        uint256 findingId = _submitFinding(programId, agentA);

        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.FindingNotApproved.selector);
        hub.claimReward(findingId);
    }

    function test_Revert_TriageTwice() public {
        uint256 programId = _createProgram();
        uint256 findingId = _submitFinding(programId, agentA);
        vm.prank(sponsor);
        hub.triageFinding(findingId, true);

        vm.prank(sponsor);
        vm.expectRevert(AgentBountyHub.FindingAlreadyTriaged.selector);
        hub.triageFinding(findingId, false);
    }

    // ------------------------------------------------------------------------
    // Escrow safety
    // ------------------------------------------------------------------------

    function test_Revert_CreateWithEscrowBelowReward() public {
        vm.prank(sponsor);
        vm.expectRevert(AgentBountyHub.InsufficientEscrow.selector);
        hub.createProgram{value: 0.1 ether}("Tiny", "ipfs://x", REWARD);
    }

    function test_Revert_CreateWithZeroReward() public {
        vm.prank(sponsor);
        vm.expectRevert(AgentBountyHub.ZeroReward.selector);
        hub.createProgram{value: 1 ether}("Zero", "ipfs://x", 0);
    }

    function test_ClaimRevertsWhenEscrowDrained() public {
        // Sponsor funds exactly 1 reward, two findings get approved, but the
        // second claim must fail because escrow is empty after the first.
        vm.prank(sponsor);
        uint256 programId = hub.createProgram{value: REWARD}("One-shot", "ipfs://x", REWARD);

        uint256 f1 = _submitFinding(programId, agentA);
        uint256 f2 = _submitFinding(programId, agentB);
        vm.prank(sponsor);
        hub.triageFinding(f1, true);
        vm.prank(sponsor);
        hub.triageFinding(f2, true);

        vm.prank(agentA);
        hub.claimReward(f1);

        vm.prank(agentB);
        vm.expectRevert(AgentBountyHub.InsufficientEscrow.selector);
        hub.claimReward(f2);
    }

    function test_CloseAndWithdraw_ReturnsRemainingEscrow() public {
        uint256 programId = _createProgram();
        uint256 findingId = _submitFinding(programId, agentA);
        vm.prank(sponsor);
        hub.triageFinding(findingId, true);
        vm.prank(agentA);
        hub.claimReward(findingId);

        uint256 before = sponsor.balance;
        vm.prank(sponsor);
        hub.closeProgram(programId);
        vm.prank(sponsor);
        hub.withdrawEscrow(programId);

        assertEq(sponsor.balance, before + (2 ether - REWARD));
        assertEq(hub.getProgram(programId).escrow, 0);
        assertEq(address(hub).balance, 0);
    }

    function test_Revert_WithdrawBeforeClose() public {
        uint256 programId = _createProgram();
        vm.prank(sponsor);
        vm.expectRevert(AgentBountyHub.ProgramNotClosed.selector);
        hub.withdrawEscrow(programId);
    }

    function test_Revert_SubmitToClosedProgram() public {
        uint256 programId = _createProgram();
        vm.prank(sponsor);
        hub.closeProgram(programId);

        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.ProgramIsClosed.selector);
        hub.submitFinding(programId, REPORT_HASH, "ipfs://report-1", AgentBountyHub.Severity.Medium);
    }

    function test_Revert_FundClosedProgram() public {
        uint256 programId = _createProgram();
        vm.prank(sponsor);
        hub.closeProgram(programId);

        vm.prank(sponsor);
        vm.expectRevert(AgentBountyHub.ProgramIsClosed.selector);
        hub.fundProgram{value: 0.1 ether}(programId);
    }

    // ------------------------------------------------------------------------
    // Misc guards
    // ------------------------------------------------------------------------

    function test_Revert_UnknownProgramAndFinding() public {
        vm.prank(agentA);
        vm.expectRevert(AgentBountyHub.ProgramNotFound.selector);
        hub.submitFinding(999, REPORT_HASH, "ipfs://x", AgentBountyHub.Severity.Low);

        vm.prank(sponsor);
        vm.expectRevert(AgentBountyHub.FindingNotFound.selector);
        hub.triageFinding(999, true);
    }

    function test_Revert_DirectBnbTransfer() public {
        vm.prank(sponsor);
        (bool ok,) = address(hub).call{value: 0.1 ether}("");
        assertEq(ok, false, "plain BNB transfer must be rejected");
    }

    function test_ConstructorRevertsOnZeroAddress() public {
        vm.expectRevert(AgentBountyHub.ZeroAddress.selector);
        new AgentBountyHub(address(0));
    }
}
