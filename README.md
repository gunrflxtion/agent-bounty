# AgentBounty — Bug Bounties for AI Agents

> Built for the **Binance Agent ID Hackathon** (Binance Wallet × BNB Chain).
> Submission period: 18 Nov – 9 Dec 2026 08:00 UTC. Total prizes: 60,000 USDC.

**The idea:** a bug bounty platform where the researchers are **AI agents** — a
use case that does not exist yet on Binance. A human/project sponsor creates a
bounty program and locks a BNB escrow. AI agents that hold a **Binance Agent ID**
(`name.ai`, soulbound ERC-721) submit findings as an on-chain report hash plus a
report link. The program owner triages each finding (approve / reject). Approved
findings pay a fixed reward to the agent — but only when the agent **explicitly**
calls `claimReward()`. Agent ID is the identity layer: only holders can submit,
and an agent's on-chain submission history is its public reputation.

## How it meets the hackathon rules

- **Deployed on BNB Chain, actively uses Agent ID** — `submitFinding()` requires
  `balanceOf(msg.sender) > 0` on the Binance Agent ID registry
  (`0x60B9262456de011f7d15a54CdD8c48bAaa8B022F` on BSC mainnet), used for access
  control (who can submit) and identity (reputation per agent address).
- **Verified + open-source on BscScan** — deployment step (not done yet; see below).
- **Safety red lines, respected by design:**
  - No QR login, no pairing codes, no session storage. The frontend connects only
    via `window.ethereum` (Binance Wallet / MetaMask) after an explicit user click.
  - No unauthorized asset transfers. The contract never pulls tokens and never
    asks for approvals (there are no ERC-20 approvals at all — escrow is BNB sent
    explicitly with `createProgram()` / `fundProgram()`). Rewards move only when
    the rightful agent explicitly calls `claimReward()`, and leftover escrow moves
    only when the program owner explicitly calls `withdrawEscrow()` after closing.
  - No scheduled/automatic transfers, no bundled extra transfers, no unlimited approvals.

## Project layout

```
agent-bounty/
├── src/
│   └── AgentBountyHub.sol     # the bounty platform contract
├── test/
│   ├── AgentBountyHub.t.sol   # 24 Foundry tests (full lifecycle + guards)
│   └── MockAgentID.sol        # minimal Agent ID stand-in (local tests only)
├── script/
│   └── Deploy.s.sol           # deployment script (NOT run yet)
├── web/
│   ├── index.html             # static frontend (no build step)
│   └── app.js                 # ethers.js v6 via CDN
├── smoke-test-local.sh        # Anvil end-to-end smoke test (local only)
├── foundry.toml
└── README.md
```

## Contract: `AgentBountyHub`

Constructor takes the Agent ID registry address (mainnet constant
`MAINNET_AGENT_ID`; pass a mock on local chains).

| Function | Who | What |
|---|---|---|
| `createProgram(title, metadataURI, rewardPerFinding)` payable | anyone (sponsor) | Creates a program, locks initial BNB escrow (must cover ≥ 1 reward) |
| `fundProgram(programId)` payable | program owner | Tops up escrow |
| `submitFinding(programId, reportHash, reportURI, severity)` | Agent ID holder | Submits a finding (report hash = keccak256 of the report, computed off-chain) |
| `triageFinding(findingId, approve)` | program owner | Approve (reward becomes claimable) or reject (escrow untouched) |
| `claimReward(findingId)` | the submitting agent | Explicitly claims the fixed reward, once only |
| `closeProgram(programId)` | program owner | Closes the program (no new findings) |
| `withdrawEscrow(programId)` | program owner | Withdraws remaining escrow after close |
| `isAgent(account)` / `getProgram(id)` / `getFinding(id)` | anyone | Views |

Events for every important action: `ProgramCreated`, `ProgramFunded`,
`FindingSubmitted`, `FindingTriaged`, `RewardClaimed`, `ProgramClosed`,
`EscrowWithdrawn`.

Security notes:

- Checks-effects-interactions + a `nonReentrant` guard on both BNB-paying
  functions (`claimReward`, `withdrawEscrow`).
- Plain BNB transfers to the contract are rejected — funds only enter via
  `createProgram()` / `fundProgram()`, where they are accounted as escrow.
- `forge build` still shows 3 lint warnings that are false positives for this
  design: two `reentrancy-eth` notes (state is updated before the external
  call *and* the reentrancy guard is active) and one `incorrect-strict-equality`
  note (`balanceOf(...) == 0` is the intended holder check).

## Tests

```bash
forge test
```

**24 passed, 0 failed.** Coverage: happy path (create → submit → approve →
claim), reject path, Agent ID gate, triage/fund/close/withdraw restricted to the
program owner, double-claim, claim by non-submitter, claim before approval,
double triage, escrow-below-reward, zero reward, escrow drained before a second
claim, close + withdraw returns the remainder, submit/fund to a closed program,
unknown program/finding, direct BNB transfer rejected, zero-address constructor.

## Local end-to-end smoke test (Anvil)

```bash
./smoke-test-local.sh
```

Deploys `MockAgentID` + `AgentBountyHub` on a local Anvil chain, mints an Agent
ID to the deployer, then runs create → submit → approve → claim and prints the
resulting state. Verified: escrow drops from 1 BNB to 0.5 BNB after a 0.5 BNB
claim, finding marked claimed. **Local only — no real chain, no real funds.**

## Frontend (`web/`)

Static site, no build step. Open `web/index.html` in a browser (serve it, e.g.
`python3 -m http.server` from `web/`, then visit `http://localhost:8000`).

- **Connect Wallet** (Binance Wallet / MetaMask), auto-switches to BSC mainnet.
- Shows whether the connected wallet holds a Binance Agent ID.
- Create programs, list programs with their findings, submit findings (report
  hashed locally in the browser), triage buttons for program owners, claim
  buttons for agents.
- Before deployment, `HUB_ADDRESS` in `web/app.js` is a placeholder — set it to
  the deployed contract address after deploying.

## Deployment (NOT done — separate user-confirmed step)

### Option A — Remix + Binance Wallet (deploy from the Agentic wallet)

The Binance Agentic Wallet CLI (`baw`) cannot deploy a new contract
(`contract-call` requires a target contract address), so deployment from the
Agent ID holder wallet happens in Remix, where the wallet signs directly:

1. Open https://remix.ethereum.org in a browser with the Binance Wallet
   extension, and create a new file `AgentBountyHub.sol`.
2. Paste the contract source from [`src/AgentBountyHub.sol`](src/AgentBountyHub.sol)
   (single file, no imports).
3. Compile: Solidity **0.8.24**, EVM version default, **optimizer OFF**.
   (Use the same settings later for BscScan verification.)
4. Deploy & Run: Environment = **Injected Provider – Binance Wallet**.
   Connect the Agentic wallet and make sure the network is **BNB Smart Chain**
   (chain ID 56).
5. Deploy `AgentBountyHub` with the constructor argument = the Binance Agent
   ID registry address: `0x60B9262456de011f7d15a54CdD8c48bAaa8B022F`.
   Confirm in the wallet. Estimated gas cost: ~0.00016 BNB.
6. Verify source on BscScan (Contract → Verify and Publish): compiler 0.8.24,
   optimization No, license MIT, same single-file source; constructor
   arguments are the ABI-encoded registry address above.
7. Set `HUB_ADDRESS` in `web/app.js` to the deployed address, then host the
   frontend (any static host).

### Option B — Foundry (deployer key available locally)

1. Fund a deployer wallet with BNB for gas (user funds it; amount confirmed
   before any transaction).
2. `forge script script/Deploy.s.sol --rpc-url <BSC_RPC> --broadcast`
   (uses `AGENT_ID_ADDRESS` env var, defaults to the mainnet Agent ID contract).
3. Verify source on BscScan, then set `HUB_ADDRESS` in `web/app.js`.
4. Submit project info (name, website, contract address, Agent ID usage
   description) during the submission period.

## Design decisions (recorded, simplest option chosen)

- **Escrow in BNB only (v1).** USDC escrow is a natural v2 — it would add an
  ERC-20 `transferFrom` step and a per-token approval UX; BNB keeps v1 simple
  and keeps the "no approvals" story clean.
- **Fixed reward per finding** (not per-severity pricing). Simpler escrow math
  and simpler triage; severity is recorded for reputation and can drive pricing
  in v2.
- **Report stored off-chain** (hash + URI on-chain). Full reports on-chain would
  be expensive; the hash commits the agent to the exact report text.
- **Naive on-chain scan in the frontend** (iterate `programCount` /
  `findingCount`). Fine for a hackathon demo; production would index events.

## What is NOT done yet

- [ ] Deploy to BSC mainnet (needs user-confirmed BNB funding + explicit approval)
- [ ] Verify contract source on BscScan
- [x] GitHub repo (public, open-source — required for submission): https://github.com/gunrflxtion/agent-bounty
- [ ] Host the frontend (static hosting) + submit project info to the hackathon
- [ ] The hard part for the Innovation Award: a live product + **≥ 30 Agent ID
      addresses interacting** with the contract during the submission period —
      needs outreach to Agent ID holders (e.g. via the Ptah / Binance agent
      community) once deployed
