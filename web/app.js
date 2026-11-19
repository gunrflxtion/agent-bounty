// AgentBounty frontend — vanilla JS + ethers.js v6 (CDN, no build step).
//
// SECURITY NOTES (Binance Agent ID Hackathon red lines):
// - No QR login, no pairing codes. Wallet connects only via window.ethereum
//   (Binance Wallet / MetaMask) with an explicit user click.
// - No token approvals are ever requested. The contract only handles BNB sent
//   explicitly with createProgram()/fundProgram(), and pays out only when the
//   rightful party explicitly calls claimReward()/withdrawEscrow().
// - Report text is hashed locally in the browser; only the hash + URI go on-chain.
//
// HONESTY NOTES (what the contract does NOT store — kept local, labelled in UI):
// - Reviewer notes, revision links, assignments, deadlines, handles, notification
//   prefs and agent registrations live in this browser's localStorage only.
// - Rewards are paid in BNB (the contract escrows BNB), not USDC.
// - "Changes Requested" is the UI label for the on-chain Rejected verdict; the
//   agent revises by submitting a NEW finding linked to the old one.

const HUB_ADDRESS = "0x8f808c733ec70dc2cf38d4a515a3bcce53356d10"; // Deployed 19 Nov 2026 via CREATE2 factory (baw), tx 0x89d442832ba56e90ab45516acfe2fca1569ecdad51045df28542e781130ada46
const BSC_CHAIN_ID = 56; // 0x38
const DEPLOY_BLOCK = 134484919;

const HUB_ABI = [
  "function createProgram(string title, string metadataURI, uint256 rewardPerFinding) payable returns (uint256)",
  "function fundProgram(uint256 programId) payable",
  "function closeProgram(uint256 programId)",
  "function withdrawEscrow(uint256 programId)",
  "function submitFinding(uint256 programId, bytes32 reportHash, string reportURI, uint8 severity) returns (uint256)",
  "function triageFinding(uint256 findingId, bool approve)",
  "function claimReward(uint256 findingId)",
  "function programCount() view returns (uint256)",
  "function findingCount() view returns (uint256)",
  "function getProgram(uint256 programId) view returns (tuple(uint256 id, address owner, string title, string metadataURI, uint256 rewardPerFinding, uint256 escrow, bool closed))",
  "function getFinding(uint256 findingId) view returns (tuple(uint256 id, uint256 programId, address agent, bytes32 reportHash, string reportURI, uint8 severity, uint8 status, bool claimed))",
  "function isAgent(address account) view returns (bool)",
];

const SEVERITY = ["Low", "Medium", "High", "Critical"];
const STATUS_LABEL = ["In Review", "Approved", "Changes Requested"];
const STATUS_CLASS = ["submitted", "approved", "rejected"];

let provider = null;
let signer = null;
let account = null;
let hubRead = null;
let hubWrite = null;
let programs = []; // {id, owner, title, metadataURI, rewardPerFinding, escrow, closed}
let findings = []; // {id, programId, agent, reportHash, reportURI, severity, status, claimed, submittedAt}
let claims = [];   // {findingId, programId, agent, amount, txHash, blockNumber, timestamp, fee, status}
let isAgentFlag = false;
let currentFindingId = null;
let currentProgramId = null;
let currentClaimTx = null;
let currentAgentAddress = null;
let selectedAssignAgent = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const short = (addr) => (addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtBnb = (wei) => ethers.formatEther(wei) + " BNB";
const programById = (id) => programs.find((p) => p.id === Number(id));
const findingById = (id) => findings.find((f) => f.id === Number(id));

const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null || v === undefined ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

function setStatus(msg, kind) {
  const el = $("status");
  if (!el) return;
  el.textContent = msg;
  el.className = kind || "muted";
}

// Local-only data (labelled as such in the UI).
const revMap = () => store.get("ab_revisions_v1", {});       // newFindingId -> oldFindingId
const notesMap = () => store.get("ab_notes_v1", {});         // findingId -> reviewer note
const assignMap = () => store.get("ab_assignments_v1", {});  // programId -> agent address
const deadlineMap = () => store.get("ab_deadlines_v1", {});  // programId -> datetime-local string
const registeredAgents = () => store.get("ab_registered_agents_v1", []); // [{address, name, skills, endpoint}]

function versionOf(f) {
  let d = 0, cur = f.id;
  const map = revMap();
  while (map[cur] && d < 20) { d++; cur = map[cur]; }
  return "v1." + d;
}
function revisionOf(f) { return revMap()[f.id] || null; }
function statusBadge(f) {
  return `<span class="badge ${STATUS_CLASS[Number(f.status)]}">${STATUS_LABEL[Number(f.status)]}</span>`;
}
function agentDisplay(addr) {
  const reg = registeredAgents().find((a) => a.address.toLowerCase() === addr.toLowerCase());
  return reg ? esc(reg.name) : short(addr);
}
function allAgents() {
  const seen = new Map();
  for (const f of findings) {
    const k = f.agent.toLowerCase();
    if (!seen.has(k)) seen.set(k, { address: f.agent, submissions: 0, approved: 0, pending: 0 });
    const a = seen.get(k);
    a.submissions++;
    if (f.status === 1) a.approved++;
    if (f.status === 0) a.pending++;
  }
  for (const r of registeredAgents()) {
    const k = r.address.toLowerCase();
    if (!seen.has(k)) seen.set(k, { address: r.address, submissions: 0, approved: 0, pending: 0 });
  }
  return [...seen.values()].map((a) => {
    const reg = registeredAgents().find((r) => r.address.toLowerCase() === a.address.toLowerCase());
    return { ...a, name: reg ? reg.name : null, skills: reg ? reg.skills : null, endpoint: reg ? reg.endpoint : null };
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const TITLES = {
  overview: "Overview", board: "Bounty Board", "bounty-details": "Bounty Details",
  "assign-agent": "Assign Agent", "post-bounty": "Post a Bounty", agents: "My Agents",
  "agent-details": "Agent Details", submissions: "Submissions", details: "Submission Details",
  review: "Review Work", revision: "Submit Revision", rewards: "Rewards",
  "payment-details": "Payment Details", profile: "My Profile", wallet: "Wallet",
};
const NAV_FOR = {
  details: "submissions", review: "submissions", revision: "submissions",
  "bounty-details": "board", "assign-agent": "board", "post-bounty": "board",
  "agent-details": "agents", "payment-details": "rewards", wallet: "profile",
};

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  const el = $("view-" + name);
  if (el) el.classList.remove("hidden");
  const nav = NAV_FOR[name] || name;
  document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === nav));
  $("viewTitle").textContent = TITLES[name] || name;
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

async function connect() {
  if (!window.ethereum) {
    setStatus("No wallet found. Install Binance Wallet or MetaMask.", "error");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== BSC_CHAIN_ID) await switchToBsc();
    const accounts = await provider.send("eth_requestAccounts", []);
    account = accounts[0];
    signer = await provider.getSigner();
    $("accountLabel").textContent = short(account);
    $("connectBtn").textContent = short(account);
    setStatus("Connected on BNB Smart Chain.", "ok");
    if (!contracts()) return;
    await refreshAgentStatus();
    await loadChainData();
    renderAll();
  } catch (err) {
    console.error(err);
    setStatus("Connection failed: " + (err.message || err), "error");
  }
}

function disconnect() {
  account = null;
  signer = null;
  hubWrite = null;
  isAgentFlag = false;
  window.location.reload(); // back to read-only mode
}

async function switchToBsc() {
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] });
  } catch (err) {
    if (err.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x38", chainName: "BNB Smart Chain",
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: ["https://bsc-dataseed.binance.org/"],
          blockExplorerUrls: ["https://bscscan.com/"],
        }],
      });
    } else throw err;
  }
}

function contracts() {
  if (!provider) return false;
  hubRead = new ethers.Contract(HUB_ADDRESS, HUB_ABI, provider);
  hubWrite = signer ? new ethers.Contract(HUB_ADDRESS, HUB_ABI, signer) : null;
  return true;
}

async function refreshAgentStatus() {
  try {
    isAgentFlag = await hubRead.isAgent(account);
    $("submitHint").textContent = isAgentFlag
      ? "✓ This wallet holds a Binance Agent ID — it can submit findings."
      : "✗ This wallet does NOT hold a Binance Agent ID — it cannot submit findings (it can still sponsor programs).";
  } catch (err) {
    $("submitHint").textContent = "Could not check Agent ID status: " + (err.message || err);
  }
}

// ---------------------------------------------------------------------------
// Chain data (reads)
// ---------------------------------------------------------------------------

async function loadChainData() {
  const [pcRaw, fcRaw] = await Promise.all([hubRead.programCount(), hubRead.findingCount()]);
  const pc = Number(pcRaw);
  const fc = Number(fcRaw);
  programs = [];
  for (let i = 1; i <= pc; i++) {
    const p = await hubRead.getProgram(i);
    programs.push({ id: Number(p.id), owner: p.owner, title: p.title, metadataURI: p.metadataURI, rewardPerFinding: p.rewardPerFinding, escrow: p.escrow, closed: p.closed });
  }
  findings = [];
  for (let i = 1; i <= fc; i++) {
    const f = await hubRead.getFinding(i);
    findings.push({ id: Number(f.id), programId: Number(f.programId), agent: f.agent, reportHash: f.reportHash, reportURI: f.reportURI, severity: Number(f.severity), status: Number(f.status), claimed: f.claimed, submittedAt: null });
  }
  await Promise.all([loadTimestamps(), loadClaims()]);
}

async function loadTimestamps() {
  try {
    const iface = new ethers.Interface(["event FindingSubmitted(uint256 indexed findingId, uint256 indexed programId, address indexed agent, bytes32 reportHash, uint8 severity)"]);
    const topic = iface.getEvent("FindingSubmitted").topicHash;
    const to = await provider.getBlockNumber();
    const byFinding = {};
    for (let s = DEPLOY_BLOCK; s <= to; s += 10000) {
      const e = Math.min(s + 9999, to);
      const logs = await provider.getLogs({ address: HUB_ADDRESS, topics: [topic], fromBlock: s, toBlock: e });
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        byFinding[Number(parsed.args.findingId)] = log.blockNumber;
      }
    }
    const ts = {};
    for (const b of [...new Set(Object.values(byFinding))]) {
      const blk = await provider.getBlock(b);
      if (blk) ts[b] = Number(blk.timestamp);
    }
    for (const f of findings) f.submittedAt = byFinding[f.id] ? (ts[byFinding[f.id]] ?? null) : null;
  } catch (err) { console.warn("timestamps unavailable", err); }
}

async function loadClaims() {
  claims = [];
  try {
    const iface = new ethers.Interface(["event RewardClaimed(uint256 indexed findingId, uint256 indexed programId, address indexed agent, uint256 amount)"]);
    const topic = iface.getEvent("RewardClaimed").topicHash;
    const to = await provider.getBlockNumber();
    for (let s = DEPLOY_BLOCK; s <= to; s += 10000) {
      const e = Math.min(s + 9999, to);
      const logs = await provider.getLogs({ address: HUB_ADDRESS, topics: [topic], fromBlock: s, toBlock: e });
      for (const log of logs) {
        const parsed = iface.parseLog(log);
        let fee = null, timestamp = null, status = null;
        try {
          const rc = await provider.getTransactionReceipt(log.transactionHash);
          if (rc) { fee = rc.gasUsed * (rc.gasPrice ?? 0n); status = rc.status; }
        } catch (e) { /* ignore */ }
        try {
          const blk = await provider.getBlock(log.blockNumber);
          if (blk) timestamp = Number(blk.timestamp);
        } catch (e) { /* ignore */ }
        claims.push({ findingId: Number(parsed.args.findingId), programId: Number(parsed.args.programId), agent: parsed.args.agent, amount: parsed.args.amount, txHash: log.transactionHash, blockNumber: log.blockNumber, timestamp, fee, status });
      }
    }
  } catch (err) { console.warn("claims unavailable", err); }
}

async function fetchBrief(uri) {
  let url = uri;
  if (uri.startsWith("ipfs://")) url = "https://ipfs.io/ipfs/" + uri.slice(7);
  if (!url.startsWith("http")) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return (await res.text()).slice(0, 800);
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function renderAll() {
  renderStats();
  renderBoardPreview();
  renderActivity();
  renderBoard();
  renderAgentsView();
  renderActiveRuns();
  renderSubmissionsTable();
  populateProgramSelect();
  renderRewards();
  renderProfile();
  renderWallet();
  if (currentFindingId) { renderDetails(); renderReview(); renderRevision(); }
  if (currentProgramId) { renderBountyDetails(); renderAssign(); }
  if (currentAgentAddress) renderAgentDetails();
}

function renderStats() {
  $("statOpen").textContent = programs.filter((p) => !p.closed).length;
  $("statAgents").textContent = new Set(findings.map((f) => f.agent.toLowerCase())).size;
  $("statPending").textContent = findings.filter((f) => f.status === 0).length;
}

function bountyRowHtml(p) {
  const n = findings.filter((f) => f.programId === p.id).length;
  const assigned = assignMap()[p.id];
  return `<div class="bounty-row" onclick="showBountyDetails(${p.id})">
    <div class="bounty-icon">&lt;/&gt;</div>
    <div><div class="bounty-title">${esc(p.title)}</div>
    <div class="bounty-sub">Owner ${short(p.owner)} · ${n} submission${n === 1 ? "" : "s"}${assigned ? " · Assigned: " + esc(agentDisplay(assigned)) : ""}</div></div>
    <div class="bounty-reward">${fmtBnb(p.rewardPerFinding)}</div>
    <span class="badge ${p.closed ? "closed" : "open"}">${p.closed ? "Closed" : "Open"}</span>
    <span class="chev">&rsaquo;</span>
  </div>`;
}

function renderBoardPreview() {
  const open = programs.filter((p) => !p.closed).slice(-3).reverse();
  $("boardPreview").innerHTML = open.length === 0
    ? '<p class="muted">No open bounties yet. Be the first sponsor — post a bounty.</p>'
    : open.map(bountyRowHtml).join("");
}

function relTime(ts) {
  if (!ts) return "—";
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " hr ago";
  return fmtDate(ts);
}

function renderActivity() {
  const items = [];
  for (const f of findings) {
    if (f.submittedAt) items.push({ ts: f.submittedAt, icon: "➤", html: `<strong>${esc(agentDisplay(f.agent))}</strong> submitted a solution for <a href="#" onclick="showDetails(${f.id}); return false;">${esc((programById(f.programId) || {}).title || "Program #" + f.programId)}</a>.` });
  }
  for (const c of claims) {
    if (c.timestamp) items.push({ ts: c.timestamp, icon: "◉", html: `<strong>${esc(agentDisplay(c.agent))}</strong> claimed <strong>${fmtBnb(c.amount)}</strong> for <a href="#" onclick="showPaymentDetails('${c.txHash}'); return false;">${esc((programById(c.programId) || {}).title || "Program #" + c.programId)}</a>.` });
  }
  items.sort((a, b) => b.ts - a.ts);
  const top = items.slice(0, 5);
  $("activityFeed").innerHTML = top.length === 0
    ? '<p class="muted">No activity yet. Activity appears here when agents submit and claim.</p>'
    : top.map((it) => `<div class="activity-row"><div class="activity-icon">${it.icon}</div><div style="flex:1">${it.html}</div><span class="muted" style="white-space:nowrap">${relTime(it.ts)}</span></div>`).join("");
}

function renderBoard() {
  const q = ($("boardSearch").value || "").toLowerCase();
  const st = $("boardStatus").value;
  const bud = $("boardBudget").value;
  let list = [...programs].reverse();
  if (q) list = list.filter((p) => p.title.toLowerCase().includes(q) || p.owner.toLowerCase().includes(q));
  if (st === "open") list = list.filter((p) => !p.closed);
  if (st === "closed") list = list.filter((p) => p.closed);
  if (bud === "small") list = list.filter((p) => p.rewardPerFinding < ethers.parseEther("0.1"));
  if (bud === "mid") list = list.filter((p) => p.rewardPerFinding >= ethers.parseEther("0.1") && p.rewardPerFinding <= ethers.parseEther("1"));
  if (bud === "big") list = list.filter((p) => p.rewardPerFinding > ethers.parseEther("1"));
  $("programList").innerHTML = list.length === 0
    ? '<p class="muted">No bounties match. Try clearing the filters, or post the first bounty.</p>'
    : list.map(bountyRowHtml).join("");
}

function contextBarHtml(p, extra) {
  return `<div class="context-title"><div class="bounty-icon">&lt;/&gt;</div><div>${esc(p.title)}${extra ? `<div class="muted" style="font-size:13px; font-weight:400">${extra}</div>` : ""}</div></div>
    <div class="context-reward">${fmtBnb(p.rewardPerFinding)}</div>`;
}

async function renderBountyDetails() {
  const p = programById(currentProgramId);
  if (!p) return;
  const assigned = assignMap()[p.id];
  $("bountyDetailsContext").innerHTML = contextBarHtml(p, assigned ? "Agent: " + esc(agentDisplay(assigned)) : "Owner: " + short(p.owner));
  const dl = deadlineMap()[p.id];
  $("briefDeadline").textContent = dl ? fmtDate(Math.floor(new Date(dl).getTime() / 1000)) + " (shown to reviewers, not enforced on-chain)" : "No deadline set.";
  $("briefReward").textContent = fmtBnb(p.rewardPerFinding) + " per approved finding · Escrow " + fmtBnb(p.escrow);
  const brief = await fetchBrief(p.metadataURI);
  $("briefBody").innerHTML = (brief ? `<p style="white-space:pre-wrap">${esc(brief)}</p>` : `<p class="muted">Scope lives off-chain at:</p><p class="mono">${esc(p.metadataURI)}</p>`)
    + `<p><a href="${esc(p.metadataURI.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + p.metadataURI.slice(7) : p.metadataURI)}" target="_blank" rel="noopener">Open scope document &nearr;</a></p>`;
  const pf = findings.filter((f) => f.programId === p.id).slice().reverse();
  $("bountyFindings").innerHTML = pf.length === 0
    ? '<p class="muted">No submissions yet.</p>'
    : pf.map((f) => `<div class="finding"><p><strong>Finding #${f.id}</strong> · ${statusBadge(f)} · Severity: ${SEVERITY[f.severity]}${f.claimed ? " · Claimed" : ""}</p>
        <p class="muted">Agent: ${esc(agentDisplay(f.agent))} · ${fmtDate(f.submittedAt)}</p>
        <div class="row"><button class="secondary" onclick="showDetails(${f.id})">View submission</button></div></div>`).join("");
  $("assignAgentBtn").onclick = () => showAssignAgent(p.id);
  $("detailsSubmitBtn").onclick = () => { showView("submissions"); $("findProgId").value = String(p.id); };
}

function showBountyDetails(programId) {
  currentProgramId = Number(programId);
  showView("bounty-details");
  renderBountyDetails();
}

function renderAssign() {
  const p = programById(currentProgramId);
  if (!p) return;
  $("assignContext").innerHTML = contextBarHtml(p, "Select an agent to work on this bounty.");
  const agents = allAgents();
  $("assignList").innerHTML = agents.length === 0
    ? '<p class="muted">No agents known yet. An agent appears here once it registers or submits a finding.</p>'
    : agents.map((a) => `<div class="agent-row" onclick="selectAssignAgent('${a.address}')">
        <div class="agent-avatar">${esc((a.name || a.address).slice(0, 1).toUpperCase())}</div>
        <div><div class="agent-name">${a.name ? esc(a.name) : short(a.address)}</div>
        <div class="muted">${a.skills ? esc(a.skills) : "Security researcher"} · ${a.submissions} submission${a.submissions === 1 ? "" : "s"}</div></div>
        <span style="margin-left:auto; font-size:18px; color:${selectedAssignAgent && selectedAssignAgent.toLowerCase() === a.address.toLowerCase() ? "var(--accent)" : "var(--muted)"}">${selectedAssignAgent && selectedAssignAgent.toLowerCase() === a.address.toLowerCase() ? "●" : "○"}</span>
      </div>`).join("");
  const sel = selectedAssignAgent ? allAgents().find((a) => a.address.toLowerCase() === selectedAssignAgent.toLowerCase()) : null;
  if (sel) {
    const rate = sel.submissions ? Math.round((sel.approved / sel.submissions) * 100) : 0;
    $("assignSelected").innerHTML = `<div class="agent-row"><div class="agent-avatar">${esc((sel.name || sel.address).slice(0, 1).toUpperCase())}</div>
      <div><div class="agent-name">${sel.name ? esc(sel.name) : short(sel.address)}</div>
      <div class="muted"><span class="dot ${sel.pending ? "" : "gray"}"></span>${sel.pending ? "Working" : "Available"}</div></div></div>
      <div class="kv-rows">
        <div class="kr"><span class="k">Specialty</span><span>${sel.skills ? esc(sel.skills) : "Security research"}</span></div>
        <div class="kr"><span class="k">Success rate</span><span>${rate}% (${sel.approved}/${sel.submissions} approved)</span></div>
        <div class="kr"><span class="k">Submissions</span><span>${sel.submissions}</span></div>
        ${sel.endpoint ? `<div class="kr"><span class="k">Endpoint</span><span class="mono">${esc(sel.endpoint)}</span></div>` : ""}
      </div>`;
    $("confirmAssignBtn").disabled = false;
  } else {
    $("assignSelected").innerHTML = '<p class="muted">No agent selected yet.</p>';
    $("confirmAssignBtn").disabled = true;
  }
}

function selectAssignAgent(addr) {
  selectedAssignAgent = addr;
  renderAssign();
}

function showAssignAgent(programId) {
  currentProgramId = Number(programId);
  selectedAssignAgent = assignMap()[currentProgramId] || null;
  showView("assign-agent");
  renderAssign();
}

function renderAgentsView() {
  if (account) {
    const mine = findings.filter((f) => f.agent.toLowerCase() === account.toLowerCase());
    const approved = mine.filter((f) => f.status === 1).length;
    const handle = store.get("ab_handle_v1", "");
    $("agentCard").innerHTML = `<div class="agent-row" style="cursor:default">
      <div class="agent-avatar">${esc((handle || account).slice(0, 1).toUpperCase())}</div>
      <div><div class="agent-name">${handle ? esc(handle) : short(account)}</div>
      <div class="muted">${isAgentFlag ? "✓ Holds a Binance Agent ID" : "✗ No Binance Agent ID"} · ${mine.length} submissions · ${approved} approved</div>
      <div class="mono">${esc(account)}</div></div></div>`;
  } else {
    $("agentCard").innerHTML = '<p class="muted">Connect a wallet to see your agent.</p>';
  }
  const agents = allAgents();
  $("agentsList").innerHTML = agents.length === 0
    ? '<p class="muted">No agents yet.</p>'
    : agents.map((a) => `<div class="agent-row" onclick="showAgentDetails('${a.address}')">
        <div class="agent-avatar">${esc((a.name || a.address).slice(0, 1).toUpperCase())}</div>
        <div><div class="agent-name">${a.name ? esc(a.name) : short(a.address)}</div>
        <div class="muted">${a.skills ? esc(a.skills) + " · " : ""}${a.submissions} submissions · ${a.approved} approved</div></div>
        <span style="margin-left:auto"><span class="dot ${a.pending ? "" : "gray"}"></span>${a.pending ? "Working" : "Available"}</span>
        <span class="chev">&rsaquo;</span>
      </div>`).join("");
}

function renderActiveRuns() {
  const pending = findings.filter((f) => f.status === 0).slice().reverse();
  $("activeRuns").innerHTML = pending.length === 0
    ? '<p class="muted">No active runs — nothing is awaiting review right now.</p>'
    : pending.map((f) => {
        const p = programById(f.programId);
        return `<div class="agent-row" onclick="showDetails(${f.id})">
          <div class="agent-avatar">▶</div>
          <div><div class="agent-name">${p ? esc(p.title) : "Program #" + f.programId} — Finding #${f.id}</div>
          <div class="muted">Agent ${esc(agentDisplay(f.agent))} · ${versionOf(f)} · ${SEVERITY[f.severity]} · ${fmtDate(f.submittedAt)}</div></div>
          <span style="margin-left:auto">${statusBadge(f)}</span><span class="chev">&rsaquo;</span>
        </div>`;
      }).join("");
}

function showAgentDetails(addr) {
  currentAgentAddress = addr;
  showView("agent-details");
  renderAgentDetails();
}

async function renderAgentDetails() {
  const addr = currentAgentAddress;
  if (!addr) return;
  const reg = registeredAgents().find((a) => a.address.toLowerCase() === addr.toLowerCase());
  const mine = findings.filter((f) => f.agent.toLowerCase() === addr.toLowerCase());
  const name = reg ? reg.name : short(addr);
  $("agentDetailsContext").innerHTML = `<div class="context-title"><div class="agent-avatar">${esc(name.slice(0, 1).toUpperCase())}</div><div>${esc(name)}<div class="muted mono" style="font-size:13px; font-weight:400">${esc(addr)}</div></div></div>
    <div class="context-reward">${mine.length} submission${mine.length === 1 ? "" : "s"}</div>`;
  let isAgent = null;
  try { isAgent = await hubRead.isAgent(addr); } catch (e) { /* ignore */ }
  $("agentDetailsBody").innerHTML = `<div class="kv-rows">
    <div class="kr"><span class="k">Skills</span><span>${reg && reg.skills ? esc(reg.skills) : "—"}</span></div>
    <div class="kr"><span class="k">Endpoint</span><span>${reg && reg.endpoint ? `<a href="${esc(reg.endpoint)}" target="_blank" rel="noopener">${esc(reg.endpoint)}</a>` : "—"}</span></div>
    <div class="kr"><span class="k">Binance Agent ID</span><span>${isAgent === null ? "Unknown" : isAgent ? "✓ Holds one" : "✗ None"}</span></div>
    <div class="kr"><span class="k">BscScan</span><span><a href="https://bscscan.com/address/${esc(addr)}" target="_blank" rel="noopener">View address &nearr;</a></span></div>
  </div>`;
  const pending = mine.filter((f) => f.status === 0);
  $("agentActiveRuns").innerHTML = pending.length === 0
    ? '<p class="muted">No active runs.</p>'
    : pending.map((f) => {
        const p = programById(f.programId);
        return `<div class="finding" style="cursor:pointer" onclick="showDetails(${f.id})"><p><strong>Finding #${f.id}</strong> · ${p ? esc(p.title) : "Program #" + f.programId} · ${versionOf(f)}</p><p class="muted">${SEVERITY[f.severity]} · ${fmtDate(f.submittedAt)}</p></div>`;
      }).join("");
  $("agentHistory").innerHTML = mine.length === 0
    ? '<p class="muted">No submissions yet.</p>'
    : mine.slice().reverse().map((f) => {
        const p = programById(f.programId);
        return `<div class="finding"><p><strong>Finding #${f.id}</strong> · ${p ? esc(p.title) : "Program #" + f.programId} · ${versionOf(f)} · ${statusBadge(f)}${f.claimed ? " · Claimed" : ""}</p>
        <p class="muted">${SEVERITY[f.severity]} · ${fmtDate(f.submittedAt)}</p>
        <div class="row"><button class="secondary" onclick="showDetails(${f.id})">View</button></div></div>`;
      }).join("");
}

function populateProgramSelect() {
  const sel = $("findProgId");
  const prev = sel.value;
  const open = programs.filter((p) => !p.closed);
  sel.innerHTML = open.length === 0
    ? '<option value="">No open programs yet</option>'
    : open.map((p) => `<option value="${p.id}">#${p.id} — ${esc(p.title)} (${fmtBnb(p.rewardPerFinding)})</option>`).join("");
  if (prev && open.some((p) => String(p.id) === prev)) sel.value = prev;
}

function renderSubmissionsTable() {
  const filter = $("statusFilter").value;
  const q = ($("searchInput").value || "").toLowerCase();
  let list = findings.slice().reverse();
  if (filter !== "all") list = list.filter((f) => f.status === Number(filter));
  if (q) list = list.filter((f) => {
    const p = programById(f.programId);
    return String(f.id).includes(q) || f.agent.toLowerCase().includes(q) || (p && p.title.toLowerCase().includes(q));
  });
  $("submissionCount").textContent = list.length + " submission" + (list.length === 1 ? "" : "s");
  $("submissionTableBody").innerHTML = list.length === 0
    ? '<tr><td colspan="7" class="muted">No submissions match.</td></tr>'
    : list.map((f) => {
        const p = programById(f.programId);
        const rev = revisionOf(f);
        return `<tr class="clickable" onclick="showDetails(${f.id})">
          <td>#${f.id}</td>
          <td><strong>${p ? esc(p.title) : "Program #" + f.programId}</strong>${rev ? `<br><span class="muted">Revision of #${rev}</span>` : ""}</td>
          <td>${esc(agentDisplay(f.agent))}</td>
          <td>${versionOf(f)}</td>
          <td>${statusBadge(f)}</td>
          <td>${fmtDate(f.submittedAt)}</td>
          <td class="chev">&rsaquo;</td>
        </tr>`;
      }).join("");
}

function showDetails(findingId) {
  currentFindingId = Number(findingId);
  showView("details");
  renderDetails();
}

function renderDetails() {
  const f = findingById(currentFindingId);
  if (!f) return;
  const p = programById(f.programId);
  $("detailsContext").innerHTML = p
    ? contextBarHtml(p, "Agent: " + esc(agentDisplay(f.agent)))
    : `<div class="context-title">Finding #${f.id}</div><div class="context-reward">—</div>`;
  const badge = $("detailsBadge");
  badge.className = "badge " + STATUS_CLASS[f.status];
  badge.textContent = STATUS_LABEL[f.status];
  const rev = revisionOf(f);
  $("detailsBody").innerHTML = `
    <p style="font-size:16px"><strong>Finding #${f.id}${p ? " — " + esc(p.title) : ""} (${versionOf(f)})</strong>${rev ? ` <span class="muted">· Revision of #${rev}</span>` : ""}</p>
    <p class="muted">Report hash is stored on-chain; the full report lives at the URI below.</p>
    <div class="kv">
      <div><div class="kv-label">Agent</div><div class="kv-value">${esc(agentDisplay(f.agent))}</div></div>
      <div><div class="kv-label">Version</div><div class="kv-value">${versionOf(f)}</div></div>
      <div><div class="kv-label">Submitted</div><div class="kv-value">${fmtDate(f.submittedAt)}</div></div>
    </div>
    <div class="kv">
      <div><div class="kv-label">Severity</div><div class="kv-value">${SEVERITY[f.severity]}</div></div>
      <div><div class="kv-label">Status</div><div class="kv-value">${STATUS_LABEL[f.status]}${f.claimed ? " · Claimed" : ""}</div></div>
      <div><div class="kv-label">Reward</div><div class="kv-value">${p ? fmtBnb(p.rewardPerFinding) : "—"}</div></div>
    </div>
    <h3>Artifact</h3>
    <div class="artifact">
      <div style="flex:1; min-width:200px"><div class="mono">${esc(f.reportURI)}</div><div class="muted">Report artifact</div></div>
      <a href="${esc(f.reportURI.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + f.reportURI.slice(7) : f.reportURI)}" target="_blank" rel="noopener"><button class="outline">Open</button></a>
    </div>
    <p class="mono" style="margin-top:10px">hash: ${f.reportHash}</p>`;
  const note = notesMap()[f.id];
  $("detailsNotes").innerHTML = note
    ? `<p><strong>${p ? esc(short(p.owner)) : "Reviewer"}</strong> <span class="muted">· Reviewer</span></p><p style="white-space:pre-wrap">${esc(note)}</p><p class="muted">Stored in this browser only.</p>`
    : '<p class="muted">No reviewer notes yet.</p>';
  const actions = [];
  const isOwner = account && p && p.owner.toLowerCase() === account.toLowerCase();
  const isSubmitter = account && f.agent.toLowerCase() === account.toLowerCase();
  if (isOwner && f.status === 0) actions.push(`<button onclick="showReview(${f.id})">Review submission</button>`);
  if (isSubmitter && f.status === 2) actions.push(`<button onclick="showRevision(${f.id})">Submit revision</button>`);
  if (isSubmitter && f.status === 1 && !f.claimed) actions.push(`<button class="green" onclick="claimReward(${f.id})">Claim reward</button>`);
  if (p) actions.push(`<button class="secondary" onclick="showBountyDetails(${p.id})">View bounty</button>`);
  $("detailsActions").innerHTML = actions.join("");
}

function showReview(findingId) {
  currentFindingId = Number(findingId);
  showView("review");
  renderReview();
}

function renderReview() {
  const f = findingById(currentFindingId);
  if (!f) return;
  const p = programById(f.programId);
  $("reviewContext").innerHTML = p ? contextBarHtml(p, "Agent: " + esc(agentDisplay(f.agent))) : "";
  $("reviewSubmission").innerHTML = `<p><strong>Finding #${f.id} — ${p ? esc(p.title) : ""} (${versionOf(f)})</strong></p>
    <p class="muted">Severity: ${SEVERITY[f.severity]} · Submitted ${fmtDate(f.submittedAt)}</p>
    <div class="artifact"><div style="flex:1; min-width:160px"><div class="mono">${esc(f.reportURI)}</div></div>
    <a href="${esc(f.reportURI.startsWith("ipfs://") ? "https://ipfs.io/ipfs/" + f.reportURI.slice(7) : f.reportURI)}" target="_blank" rel="noopener"><button class="outline">Open</button></a></div>
    <p class="mono">hash: ${f.reportHash}</p>`;
  $("reviewNotes").value = notesMap()[f.id] || "";
  $("approveBtn").onclick = () => doTriage(f.id, true);
  $("requestChangesBtn").onclick = () => doTriage(f.id, false);
}

function showRevision(findingId) {
  currentFindingId = Number(findingId);
  showView("revision");
  renderRevision();
}

function renderRevision() {
  const f = findingById(currentFindingId);
  if (!f) return;
  const p = programById(f.programId);
  $("revisionContext").innerHTML = p ? contextBarHtml(p, "Agent: " + esc(agentDisplay(f.agent))) : "";
  const nextVersion = "v1." + (Number(versionOf(f).split(".")[1]) + 1);
  $("revVersion").value = nextVersion;
  $("revSeverity").value = String(f.severity);
  const note = notesMap()[f.id];
  $("revisionFeedback").innerHTML = note
    ? `<p><strong>${p ? esc(short(p.owner)) : "Reviewer"}</strong></p><p style="white-space:pre-wrap">${esc(note)}</p>`
    : '<p class="muted">No reviewer feedback yet.</p>';
  $("revisionPrevious").innerHTML = `<div class="finding"><p><strong>Finding #${f.id} (${versionOf(f)})</strong> · ${statusBadge(f)}</p>
    <p class="muted">${SEVERITY[f.severity]} · ${fmtDate(f.submittedAt)}</p>
    <p class="mono">${esc(f.reportURI)}</p></div>`;
}

function renderRewards() {
  if (!account) {
    $("earningsBalance").textContent = "—";
    $("claimableAmount").textContent = "—";
    $("paymentTableBody").innerHTML = '<tr><td colspan="6" class="muted">Connect your wallet to see your payment history.</td></tr>';
    return;
  }
  const mine = claims.filter((c) => c.agent.toLowerCase() === account.toLowerCase());
  const earned = mine.reduce((s, c) => s + c.amount, 0n);
  $("earningsBalance").textContent = fmtBnb(earned);
  const claimable = findings.filter((f) => f.agent.toLowerCase() === account.toLowerCase() && f.status === 1 && !f.claimed);
  const claimableValue = claimable.reduce((s, f) => { const p = programById(f.programId); return s + (p ? p.rewardPerFinding : 0n); }, 0n);
  $("claimableAmount").textContent = fmtBnb(claimableValue);
  $("claimAllBtn").disabled = claimable.length === 0;
  $("paymentTableBody").innerHTML = mine.length === 0
    ? '<tr><td colspan="6" class="muted">No payments yet. Approved findings pay out when you claim them.</td></tr>'
    : mine.slice().sort((a, b) => b.blockNumber - a.blockNumber).map((c) => {
        const p = programById(c.programId);
        return `<tr class="clickable" onclick="showPaymentDetails('${c.txHash}')">
          <td>${fmtDate(c.timestamp)}</td>
          <td>${p ? esc(p.title) : "Program #" + c.programId}</td>
          <td>${esc(agentDisplay(c.agent))}</td>
          <td>${fmtBnb(c.amount)}</td>
          <td><span class="badge paid">${c.status === 0 ? "Failed" : "Paid"}</span></td>
          <td class="chev">&rsaquo;</td>
        </tr>`;
      }).join("");
}

function showPaymentDetails(txHash) {
  currentClaimTx = txHash;
  showView("payment-details");
  renderPaymentDetails();
}

function renderPaymentDetails() {
  const c = claims.find((x) => x.txHash === currentClaimTx);
  if (!c) return;
  const p = programById(c.programId);
  $("paymentContext").innerHTML = p ? contextBarHtml(p, "Agent: " + esc(agentDisplay(c.agent))) : "";
  $("paymentReceipt").innerHTML = `
    <div style="font-size:34px; font-weight:700">${fmtBnb(c.amount)}</div>
    <div class="kv-rows" style="margin-top:12px">
      <div class="kr"><span class="k">Status</span><span>${c.status === 0 ? "Failed" : "● Confirmed"}</span></div>
      <div class="kr"><span class="k">Network</span><span>BNB Chain</span></div>
      <div class="kr"><span class="k">Transaction Hash</span><span class="mono">${short(c.txHash)}</span></div>
      <div class="kr"><span class="k">From</span><span class="mono">${short(HUB_ADDRESS)}</span></div>
      <div class="kr"><span class="k">To</span><span class="mono">${short(c.agent)}</span></div>
    </div>`;
  $("paymentTx").innerHTML = `<div class="kv-rows">
    <div class="kr"><span class="k">Amount</span><span>${fmtBnb(c.amount)}</span></div>
    <div class="kr"><span class="k">Fee</span><span>${c.fee !== null ? fmtBnb(c.fee) : "—"}</span></div>
    <div class="kr"><span class="k">Block</span><span>${c.blockNumber.toLocaleString("en-US")}</span></div>
    <div class="kr"><span class="k">Timestamp (UTC)</span><span>${fmtDate(c.timestamp)}</span></div>
  </div>`;
  $("paymentBscscan").href = "https://bscscan.com/tx/" + c.txHash;
}

function renderProfile() {
  const handle = store.get("ab_handle_v1", "");
  $("handleInput").value = handle;
  $("profileAvatar").textContent = (handle || (account || "?")).slice(0, 1).toUpperCase();
  const valid = /^[a-z0-9_]{3,32}$/.test(handle || "");
  $("handleBadge").textContent = !handle ? "Not set" : valid ? "Available" : "Invalid";
  $("handleBadge").className = "badge " + (!handle ? "submitted" : valid ? "approved" : "rejected");
  const notifs = store.get("ab_notifs_v1", { bounty: true, rewards: true, product: false });
  $("notifBounty").checked = !!notifs.bounty;
  $("notifRewards").checked = !!notifs.rewards;
  $("notifProduct").checked = !!notifs.product;
  if (!account) {
    $("profilePanel").innerHTML = '<p class="muted">Connect your wallet to see your profile.</p>';
    return;
  }
  const mine = findings.filter((f) => f.agent.toLowerCase() === account.toLowerCase());
  const approved = mine.filter((f) => f.status === 1).length;
  const claimed = mine.filter((f) => f.claimed).length;
  $("profilePanel").innerHTML = `<div class="kv-rows">
    <div class="kr"><span class="k">Wallet</span><span class="mono">${esc(account)}</span></div>
    <div class="kr"><span class="k">Binance Agent ID</span><span>${isAgentFlag ? "✓ Holds one" : "✗ None"}</span></div>
    <div class="kr"><span class="k">Submissions</span><span>${mine.length} (${approved} approved, ${claimed} claimed)</span></div>
    <div class="kr"><span class="k">Contract</span><span><a href="https://bscscan.com/address/${HUB_ADDRESS}" target="_blank" rel="noopener">${short(HUB_ADDRESS)} &nearr;</a></span></div>
  </div>`;
}

function renderWallet() {
  if (!account) {
    $("walletCard").innerHTML = '<p class="muted">Not connected.</p>';
    $("walletConnection").innerHTML = '<p class="muted">No wallet connected.</p>';
    return;
  }
  const claimable = findings.filter((f) => f.agent.toLowerCase() === account.toLowerCase() && f.status === 1 && !f.claimed);
  const claimableValue = claimable.reduce((s, f) => { const p = programById(f.programId); return s + (p ? p.rewardPerFinding : 0n); }, 0n);
  $("walletCard").innerHTML = `<div class="kv-rows">
    <div class="kr"><span class="k">BNB Chain</span><span>● Connected</span></div>
    <div class="kr"><span class="k">Wallet Address</span><span class="mono">${esc(account)}</span></div>
    <div class="kr"><span class="k">BscScan</span><span><a href="https://bscscan.com/address/${esc(account)}" target="_blank" rel="noopener">View address &nearr;</a></span></div>
  </div>`;
  $("walletConnection").innerHTML = `<div class="kv-rows">
    <div class="kr"><span class="k">Connect Wallet</span><span><span class="badge approved">Connected</span></span></div>
    <div class="kr"><span class="k">Network</span><span>BNB Chain</span></div>
    <div class="kr"><span class="k">Expected Rewards</span><span>${fmtBnb(claimableValue)}</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function publishBounty() {
  if (!contracts() || !hubWrite) { setStatus("Connect your wallet first.", "error"); return; }
  const title = $("postTitle").value.trim();
  const uri = $("postDeliverable").value.trim();
  const reward = $("postReward").value;
  const escrow = $("postEscrow").value;
  const deadline = $("postDeadline").value;
  if (!title || !uri || !reward || !escrow) { setStatus("Fill in title, deliverable, reward, and escrow.", "error"); return; }
  try {
    setStatus("Waiting for your signature…", "muted");
    const tx = await hubWrite.createProgram(title, uri, ethers.parseEther(reward), { value: ethers.parseEther(escrow) });
    setStatus("Transaction sent: " + tx.hash + " — waiting for confirmation…", "muted");
    await tx.wait();
    if (deadline) {
      const d = deadlineMap();
      d[await hubRead.programCount()] = deadline;
      store.set("ab_deadlines_v1", d);
    }
    setStatus("Bounty published.", "ok");
    await loadChainData();
    renderAll();
    const newId = Number(await hubRead.programCount());
    showBountyDetails(newId);
  } catch (err) {
    console.error(err);
    setStatus("Publish failed: " + (err.message || err), "error");
  }
}

async function submitFinding() {
  if (!contracts() || !hubWrite) { setStatus("Connect your wallet first.", "error"); return; }
  const programId = Number($("findProgId").value);
  const uri = $("findUri").value.trim();
  const severity = Number($("findSeverity").value);
  const report = $("findReport").value;
  if (!programId || !uri || !report) { setStatus("Fill in program, report URI, and the report text.", "error"); return; }
  const reportHash = ethers.keccak256(ethers.toUtf8Bytes(report));
  try {
    setStatus("Report hash (computed locally): " + reportHash, "muted");
    const tx = await hubWrite.submitFinding(programId, reportHash, uri, severity);
    setStatus("Transaction sent: " + tx.hash + " — waiting for confirmation…", "muted");
    await tx.wait();
    setStatus("Finding submitted.", "ok");
    await loadChainData();
    renderAll();
    showDetails(Number(await hubRead.findingCount()));
  } catch (err) {
    console.error(err);
    setStatus("Submit failed: " + (err.message || err), "error");
  }
}

async function submitRevision() {
  if (!contracts() || !hubWrite) { setStatus("Connect your wallet first.", "error"); return; }
  const old = findingById(currentFindingId);
  if (!old) return;
  const uri = $("revUri").value.trim();
  const severity = Number($("revSeverity").value);
  const report = $("revReport").value;
  if (!uri || !report) { setStatus("Fill in the updated report URI and report text.", "error"); return; }
  const reportHash = ethers.keccak256(ethers.toUtf8Bytes(report));
  try {
    setStatus("Report hash (computed locally): " + reportHash, "muted");
    const tx = await hubWrite.submitFinding(old.programId, reportHash, uri, severity);
    setStatus("Transaction sent: " + tx.hash + " — waiting for confirmation…", "muted");
    await tx.wait();
    const newId = Number(await hubRead.findingCount());
    const map = revMap();
    map[newId] = old.id;
    store.set("ab_revisions_v1", map);
    setStatus("Revision submitted as Finding #" + newId + ".", "ok");
    await loadChainData();
    renderAll();
    showDetails(newId);
  } catch (err) {
    console.error(err);
    setStatus("Revision failed: " + (err.message || err), "error");
  }
}

async function doTriage(findingId, approve) {
  if (!contracts() || !hubWrite) return;
  const note = $("reviewNotes").value.trim();
  if (note) {
    const m = notesMap();
    m[findingId] = note;
    store.set("ab_notes_v1", m);
  }
  try {
    const tx = await hubWrite.triageFinding(findingId, approve);
    await tx.wait();
    setStatus(approve ? "Finding approved." : "Changes requested — the agent can submit a revision.", "ok");
    await loadChainData();
    renderAll();
    showDetails(findingId);
  } catch (err) {
    console.error(err);
    setStatus("Review failed: " + (err.message || err), "error");
  }
}

async function claimReward(findingId) {
  if (!contracts() || !hubWrite) return;
  try {
    const tx = await hubWrite.claimReward(findingId);
    setStatus("Transaction sent: " + tx.hash + " — waiting for confirmation…", "muted");
    await tx.wait();
    setStatus("Reward claimed.", "ok");
    await loadChainData();
    renderAll();
  } catch (err) {
    console.error(err);
    setStatus("Claim failed: " + (err.message || err), "error");
  }
}

async function claimAllRewards() {
  if (!contracts() || !hubWrite || !account) return;
  const list = findings.filter((f) => f.agent.toLowerCase() === account.toLowerCase() && f.status === 1 && !f.claimed);
  if (list.length === 0) { setStatus("Nothing to claim.", "muted"); return; }
  for (const f of list) {
    try {
      setStatus("Claiming Finding #" + f.id + " (" + list.indexOf(f) + 1 + "/" + list.length + ")…", "muted");
      const tx = await hubWrite.claimReward(f.id);
      await tx.wait();
    } catch (err) {
      console.error(err);
      setStatus("Claim stopped at Finding #" + f.id + ": " + (err.message || err), "error");
      await loadChainData();
      renderAll();
      return;
    }
  }
  setStatus("All rewards claimed.", "ok");
  await loadChainData();
  renderAll();
}

async function fundProgram(programId) {
  if (!contracts() || !hubWrite) return;
  try {
    const tx = await hubWrite.fundProgram(programId, { value: ethers.parseEther("0.5") });
    await tx.wait();
    setStatus("Program funded with 0.5 BNB.", "ok");
    await loadChainData();
    renderAll();
  } catch (err) {
    console.error(err);
    setStatus("Fund failed: " + (err.message || err), "error");
  }
}

async function closeProgram(programId) {
  if (!contracts() || !hubWrite) return;
  try {
    const tx = await hubWrite.closeProgram(programId);
    await tx.wait();
    setStatus("Program closed.", "ok");
    await loadChainData();
    renderAll();
  } catch (err) {
    console.error(err);
    setStatus("Close failed: " + (err.message || err), "error");
  }
}

async function withdrawEscrow(programId) {
  if (!contracts() || !hubWrite) return;
  try {
    const tx = await hubWrite.withdrawEscrow(programId);
    await tx.wait();
    setStatus("Escrow withdrawn.", "ok");
    await loadChainData();
    renderAll();
  } catch (err) {
    console.error(err);
    setStatus("Withdraw failed: " + (err.message || err), "error");
  }
}

function registerAgent() {
  if (!account) { setStatus("Connect your wallet first.", "error"); return; }
  const name = $("agentName").value.trim();
  const skills = $("agentSkills").value.trim();
  const endpoint = $("agentEndpoint").value.trim();
  if (!name || !skills) { setStatus("Fill in the agent name and skills.", "error"); return; }
  const list = registeredAgents().filter((a) => a.address.toLowerCase() !== account.toLowerCase());
  list.push({ address: account, name, skills, endpoint });
  store.set("ab_registered_agents_v1", list);
  setStatus("Agent registered.", "ok");
  renderAgentsView();
  renderAgentsPanel();
  showAgentDetails(account);
}

function saveProfile() {
  const handle = $("handleInput").value.trim();
  if (handle && !/^[a-z0-9_]{3,32}$/.test(handle)) {
    setStatus("Handle must be 3–32 chars, a–z, 0–9, _.", "error");
    return;
  }
  store.set("ab_handle_v1", handle);
  store.set("ab_notifs_v1", { bounty: $("notifBounty").checked, rewards: $("notifRewards").checked, product: $("notifProduct").checked });
  setStatus("Profile saved.", "ok");
  renderProfile();
  renderAgentsView();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

document.querySelectorAll(".nav-item[data-view]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
// ---- Theme (dark / light) ----
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
  try { localStorage.setItem("ab_theme", t); } catch (e) {}
  const btn = $("themeToggle");
  if (btn) { btn.textContent = t === "dark" ? "☀" : "☾"; btn.title = t === "dark" ? "Switch to light mode" : "Switch to dark mode"; }
}
$("themeToggle").addEventListener("click", () => {
  applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
});
applyTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

$("connectBtn").addEventListener("click", connect);
$("walletConnectBtn").addEventListener("click", connect);
$("disconnectBtn").addEventListener("click", disconnect);
$("exploreBtn").addEventListener("click", () => showView("board"));
$("accountLabel").addEventListener("click", () => showView("wallet"));
$("publishBtn").addEventListener("click", publishBounty);
$("submitFindingBtn").addEventListener("click", submitFinding);
$("resubmitBtn").addEventListener("click", submitRevision);
$("claimAllBtn").addEventListener("click", claimAllRewards);
$("registerAgentBtn").addEventListener("click", registerAgent);
$("profileSaveBtn").addEventListener("click", saveProfile);
$("profileCancelBtn").addEventListener("click", renderProfile);
$("boardSearch").addEventListener("input", renderBoard);
$("boardStatus").addEventListener("change", renderBoard);
$("boardBudget").addEventListener("change", renderBoard);
$("statusFilter").addEventListener("change", renderSubmissionsTable);
$("searchInput").addEventListener("input", renderSubmissionsTable);
$("confirmAssignBtn").addEventListener("click", () => {
  if (!selectedAssignAgent || !currentProgramId) return;
  const m = assignMap();
  m[currentProgramId] = selectedAssignAgent;
  store.set("ab_assignments_v1", m);
  setStatus("Agent assigned.", "ok");
  renderAll();
  showBountyDetails(currentProgramId);
});

if (window.ethereum) {
  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

// Read-only mode: show on-chain data even before connecting.
(async () => {
  if (typeof ethers === "undefined") {
    $("boardPreview").innerHTML = '<p class="muted">Failed to load ethers.js from CDN — check your connection.</p>';
    return;
  }
  provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");
  if (!contracts()) return;
  try {
    await loadChainData();
    renderAll();
  } catch (err) {
    console.error(err);
    setStatus("Could not load on-chain data: " + (err.message || err), "error");
  }
})();
