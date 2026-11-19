# AgentBounty — Binance Agent ID Hackathon Submission Pack

> Status: READY TO SUBMIT once Binance publishes the project submission form.
> As of 19 Nov 2026 the official announcement lists what to submit but does NOT
> link a project submission form yet (only the X-promotion survey exists).
> Watch: the announcement page and the @BinanceWallet X post for the form link.
> Submission period ends 9 Dec 2026 08:00 UTC (15:00 WIB).

## Project

- **Project name:** AgentBounty
- **Tagline:** Bug bounty platform where AI agents holding a Binance Agent ID submit
  findings for BNB escrow rewards.
- **Website (live product):** https://gunrflxtion.github.io/agent-bounty/
- **GitHub (public, MIT):** https://github.com/gunrflxtion/agent-bounty
- **Team:** Solo — Gunawan (zkgvn), Indonesia. Agent ID: zkgvn.ai
- **Agent ID (token):** 62276202626127160220647962893400197927634347654180117621363126634871372855247
- **Agent ID wallet:** 0x1E6DEEE38f3678EA5F6B0B5C6e65eA8e27d9008d

## Contracts (BNB Smart Chain, mainnet)

| Contract | Address |
| --- | --- |
| AgentBountyHub | 0x8f808c733ec70dc2cf38d4a515a3bcce53356d10 |
| Agent ID registry (used by the contract) | 0x60B9262456de011f7d15a54CdD8c48bAaa8B022F |

- **Deploy tx:** 0x89d442832ba56e90ab45516acfe2fca1569ecdad51045df28542e781130ada46
  (block 134484919, 19 Nov 2026, from the Agent ID wallet via CREATE2 factory)
- **BscScan:** https://bscscan.com/address/0x8f808c733ec70dc2cf38d4a515a3bcce53356d10
- **Source verification:** Sourcify exact_match (also visible on BscScan).
  Compiler: Solidity 0.8.24, optimizer default (forge), constructor arg = Agent ID
  registry address.
- **Tests:** forge test 24/24 pass; Anvil smoke test pass (deploy → create
  program → submit → approve → claim).

## How Agent ID is used (description for the form)

1. **Identity gate (access control):** `submitFinding()` requires
   `agentId.balanceOf(msg.sender) > 0` — only wallets holding a Binance Agent ID
   (name.ai, soulbound ERC-721) can submit findings. The contract reads the
   official Agent ID registry on-chain; no off-chain allowlist.
2. **Reputation:** every submission is permanently tied to the agent's Agent ID
   wallet address on-chain (finding → agent address), forming a public,
   verifiable reputation history per agent.
3. **Identity check (view):** `isAgent(address)` exposes the holder check for
   the frontend and any integrator.
4. **Payments:** approved findings pay the fixed BNB reward only when the agent
   explicitly calls `claimReward()` — no automatic transfers, no scheduled
   collection, no unlimited approvals, no QR login anywhere in the product.

## Safety / red-line compliance

- No QR-code / pairing-code login on any website; no stored user sessions.
- No automatic or scheduled transfers; every value movement is an explicit
  user-signed action (createProgram / fundProgram / claimReward /
  withdrawEscrow).
- Contract is open-source (MIT); owner permissions are per-program
  (createProgram sets the program owner; only that owner can triage/fund/
  close/withdraw that program) and are documented in the README and code.
- No "Binance"/"BNB" branding impersonation in the project name, token, or
  domain. No promised returns. No collection of seeds, keys, or pairing codes.

## Reward receiving address (TO CONFIRM with the owner before submitting)

- Proposed: 0x1E6DEEE38f3678EA5F6B0B5C6e65eA8e27d9008d (the Agent ID wallet,
  BSC — receives USDC on BNB Chain).

## Checklist before submitting

- [x] Contract deployed on BSC mainnet
- [x] Source verified (Sourcify exact_match) + code public on GitHub
- [x] Product live at https://gunrflxtion.github.io/agent-bounty/
- [x] Agent ID integrated as identity gate (on-chain)
- [ ] ≥30 Agent ID addresses interacted with the contract (Innovation Award
      eligibility) — promotion in progress, 0 so far (19 Nov 2026)
- [ ] Demo video (optional but recommended for judges)
- [ ] Reward receiving address confirmed by the owner
- [ ] Submission form link found (not published yet as of 19 Nov 2026)
