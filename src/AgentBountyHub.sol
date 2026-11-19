// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentBountyHub — a bug bounty platform where AI agents submit findings
/// @author zkgvn (AgentBounty, built for the Binance Agent ID Hackathon)
/// @notice Bug bounty programs for AI agents. A human/project sponsor creates a
///         program and locks a BNB escrow. AI agents that hold a Binance Agent ID
///         (name.ai, soulbound ERC-721) submit findings as a report hash + report
///         pointer. The program owner triages each finding (approve / reject).
///         Approved findings pay the fixed per-finding reward to the agent, but
///         ONLY when the agent explicitly calls claimReward() — the contract never
///         moves funds automatically, never pulls user tokens, and never asks for
///         unlimited approvals. All value movement is an explicit user action.
///
///         Binance Agent ID (BSC mainnet, ERC-721):
///         0x60b9262456de011f7d15a54cdd8c48baaa8b022f
///         On local test chains that contract does not exist, so tests deploy
///         MockAgentID (see test/MockAgentID.sol) and pass its address here.

interface IAgentID {
    function balanceOf(address account) external view returns (uint256);
}

contract AgentBountyHub {
    // ------------------------------------------------------------------------
    // Constants & immutables
    // ------------------------------------------------------------------------

    /// @notice Binance Agent ID contract on BNB Smart Chain mainnet.
    address public constant MAINNET_AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    /// @notice Agent ID registry used for the holder gate (mainnet address, or
    ///         a mock on local chains).
    IAgentID public immutable agentId;

    // ------------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------------

    enum Severity {
        Low,
        Medium,
        High,
        Critical
    }

    enum FindingStatus {
        Submitted, // awaiting triage
        Approved, // reward payable via claimReward()
        Rejected // no reward, escrow untouched
    }

    struct Program {
        uint256 id;
        address owner;
        string title;
        string metadataURI; // off-chain scope / rules (e.g. IPFS)
        uint256 rewardPerFinding; // fixed BNB reward per approved finding
        uint256 escrow; // BNB currently locked for this program
        bool closed;
    }

    struct Finding {
        uint256 id;
        uint256 programId;
        address agent; // submitter (must hold an Agent ID)
        bytes32 reportHash; // keccak256 of the full report, computed off-chain
        string reportURI; // where the full report lives (e.g. IPFS)
        Severity severity; // claimed severity, owner verifies during triage
        FindingStatus status;
        bool claimed;
    }

    // ------------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------------

    uint256 public programCount;
    uint256 public findingCount;

    mapping(uint256 => Program) public programs;
    mapping(uint256 => Finding) public findings;

    /// @dev Simple reentrancy guard (no external deps).
    uint256 private _locked = 1;

    // ------------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------------

    event ProgramCreated(
        uint256 indexed programId,
        address indexed owner,
        string title,
        uint256 rewardPerFinding,
        uint256 initialEscrow
    );
    event ProgramFunded(uint256 indexed programId, address indexed funder, uint256 amount);
    event FindingSubmitted(
        uint256 indexed findingId,
        uint256 indexed programId,
        address indexed agent,
        bytes32 reportHash,
        Severity severity
    );
    event FindingTriaged(uint256 indexed findingId, uint256 indexed programId, bool approved);
    event RewardClaimed(uint256 indexed findingId, uint256 indexed programId, address indexed agent, uint256 amount);
    event ProgramClosed(uint256 indexed programId);
    event EscrowWithdrawn(uint256 indexed programId, address indexed owner, uint256 amount);

    // ------------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------------

    error NotAgentIdHolder();
    error NotProgramOwner();
    error ProgramIsClosed();
    error ProgramNotClosed();
    error FindingNotFound();
    error ProgramNotFound();
    error FindingAlreadyTriaged();
    error FindingNotApproved();
    error AlreadyClaimed();
    error NotFindingSubmitter();
    error InsufficientEscrow();
    error ZeroReward();
    error ZeroAddress();
    error Reentrancy();

    // ------------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------------

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    /// @param agentIdContract Address of the Agent ID registry. Pass
    ///        MAINNET_AGENT_ID on BSC mainnet; a mock address on test chains.
    constructor(address agentIdContract) {
        if (agentIdContract == address(0)) revert ZeroAddress();
        agentId = IAgentID(agentIdContract);
    }

    // ------------------------------------------------------------------------
    // Program lifecycle
    // ------------------------------------------------------------------------

    /// @notice Create a bounty program and lock the initial BNB escrow.
    /// @param title Short program name (e.g. "Acme DEX — smart contracts").
    /// @param metadataURI Scope, rules and asset list (e.g. ipfs://...).
    /// @param rewardPerFinding Fixed BNB reward paid per approved finding.
    /// @return programId The new program id.
    function createProgram(string calldata title, string calldata metadataURI, uint256 rewardPerFinding)
        external
        payable
        returns (uint256 programId)
    {
        if (rewardPerFinding == 0) revert ZeroReward();
        // Escrow must cover at least one reward, or no finding could ever pay out.
        if (msg.value < rewardPerFinding) revert InsufficientEscrow();

        programId = ++programCount;
        programs[programId] = Program({
            id: programId,
            owner: msg.sender,
            title: title,
            metadataURI: metadataURI,
            rewardPerFinding: rewardPerFinding,
            escrow: msg.value,
            closed: false
        });

        emit ProgramCreated(programId, msg.sender, title, rewardPerFinding, msg.value);
    }

    /// @notice Top up a program's escrow. Only the program owner can fund.
    function fundProgram(uint256 programId) external payable {
        Program storage program = _getProgram(programId);
        if (program.owner != msg.sender) revert NotProgramOwner();
        if (program.closed) revert ProgramIsClosed();
        program.escrow += msg.value;
        emit ProgramFunded(programId, msg.sender, msg.value);
    }

    /// @notice Close a program. No new findings afterwards. The remaining
    ///         escrow stays locked until the owner calls withdrawEscrow().
    function closeProgram(uint256 programId) external {
        Program storage program = _getProgram(programId);
        if (program.owner != msg.sender) revert NotProgramOwner();
        if (program.closed) revert ProgramIsClosed();
        program.closed = true;
        emit ProgramClosed(programId);
    }

    /// @notice Withdraw the remaining escrow of a closed program.
    ///         Explicit owner action — no automatic transfer on close.
    function withdrawEscrow(uint256 programId) external nonReentrant {
        Program storage program = _getProgram(programId);
        if (program.owner != msg.sender) revert NotProgramOwner();
        if (!program.closed) revert ProgramNotClosed();
        uint256 amount = program.escrow;
        if (amount == 0) revert InsufficientEscrow();
        program.escrow = 0;
        emit EscrowWithdrawn(programId, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "BNB transfer failed");
    }

    // ------------------------------------------------------------------------
    // Findings
    // ------------------------------------------------------------------------

    /// @notice Submit a finding. Only Agent ID holders can submit — the Agent
    ///         ID is the identity layer, and the on-chain history of an agent's
    ///         submissions is its public reputation.
    /// @param programId Target program (must be open).
    /// @param reportHash keccak256 of the full report, computed off-chain.
    /// @param reportURI Where the full report can be read (e.g. ipfs://...).
    /// @param severity Claimed severity (owner verifies during triage).
    /// @return findingId The new finding id.
    function submitFinding(uint256 programId, bytes32 reportHash, string calldata reportURI, Severity severity)
        external
        returns (uint256 findingId)
    {
        Program storage program = _getProgram(programId);
        if (program.closed) revert ProgramIsClosed();
        // Identity gate: caller must hold at least one Binance Agent ID.
        if (agentId.balanceOf(msg.sender) == 0) revert NotAgentIdHolder();

        findingId = ++findingCount;
        findings[findingId] = Finding({
            id: findingId,
            programId: programId,
            agent: msg.sender,
            reportHash: reportHash,
            reportURI: reportURI,
            severity: severity,
            status: FindingStatus.Submitted,
            claimed: false
        });

        emit FindingSubmitted(findingId, programId, msg.sender, reportHash, severity);
    }

    /// @notice Triage a finding. Only the program owner. Approve releases the
    ///         reward for claiming; reject pays nothing and leaves escrow intact.
    function triageFinding(uint256 findingId, bool approve) external {
        Finding storage finding = _getFinding(findingId);
        Program storage program = _getProgram(finding.programId);
        if (program.owner != msg.sender) revert NotProgramOwner();
        if (finding.status != FindingStatus.Submitted) revert FindingAlreadyTriaged();

        finding.status = approve ? FindingStatus.Approved : FindingStatus.Rejected;
        emit FindingTriaged(findingId, finding.programId, approve);
    }

    /// @notice Claim the reward for an approved finding. Only the agent that
    ///         submitted it, only once. Explicit call — no automatic payout.
    function claimReward(uint256 findingId) external nonReentrant {
        Finding storage finding = _getFinding(findingId);
        if (finding.agent != msg.sender) revert NotFindingSubmitter();
        if (finding.status != FindingStatus.Approved) revert FindingNotApproved();
        if (finding.claimed) revert AlreadyClaimed();

        Program storage program = _getProgram(finding.programId);
        uint256 reward = program.rewardPerFinding;
        if (program.escrow < reward) revert InsufficientEscrow();

        finding.claimed = true; // effects before interaction
        program.escrow -= reward;
        emit RewardClaimed(findingId, finding.programId, msg.sender, reward);
        (bool ok,) = msg.sender.call{value: reward}("");
        require(ok, "BNB transfer failed");
    }

    // ------------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------------

    /// @notice True if an address holds at least one Binance Agent ID.
    function isAgent(address account) external view returns (bool) {
        return agentId.balanceOf(account) > 0;
    }

    function getProgram(uint256 programId) external view returns (Program memory) {
        return _getProgram(programId);
    }

    function getFinding(uint256 findingId) external view returns (Finding memory) {
        return _getFinding(findingId);
    }

    // ------------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------------

    function _getProgram(uint256 programId) internal view returns (Program storage program) {
        program = programs[programId];
        if (program.id == 0) revert ProgramNotFound();
    }

    function _getFinding(uint256 findingId) internal view returns (Finding storage finding) {
        finding = findings[findingId];
        if (finding.id == 0) revert FindingNotFound();
    }

    // Reject accidental plain BNB transfers — funds only enter via
    // createProgram() / fundProgram(), where they are accounted as escrow.
    receive() external payable {
        revert("Use createProgram/fundProgram");
    }
}
