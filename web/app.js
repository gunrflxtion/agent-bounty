// AgentBounty frontend — vanilla JS + ethers.js v6 (CDN, no build step).
//
// SECURITY NOTES (Binance Agent ID Hackathon red lines):
// - No QR login, no pairing codes. Wallet connects only via window.ethereum
//   (Binance Wallet / MetaMask) with an explicit user click.
// - No token approvals are ever requested. The contract only handles BNB sent
//   explicitly with createProgram()/fundProgram(), and pays out only when the
//   rightful party explicitly calls claimReward()/withdrawEscrow().
// - Report text is hashed locally in the browser; only the hash + URI go on-chain.

const HUB_ADDRESS = "0x8f808c733ec70dc2cf38d4a515a3bcce53356d10"; // Deployed 19 Nov 2026 via CREATE2 factory (baw), tx 0x89d442832ba56e90ab45516acfe2fca1569ecdad51045df28542e781130ada46
const BSC_CHAIN_ID = 56; // 0x38

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
const STATUS = ["Submitted", "Approved", "Rejected"];

let provider = null;
let signer = null;
let account = null;
let hubRead = null; // read-only contract (provider)
let hubWrite = null; // write contract (signer)

const $ = (id) => document.getElementById(id);
const short = (addr) => addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : "";

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = kind || "muted";
}

function hubDeployed() {
  return HUB_ADDRESS !== "0x0000000000000000000000000000000000000000";
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
    if (Number(network.chainId) !== BSC_CHAIN_ID) {
      await switchToBsc();
    }
    const accounts = await provider.send("eth_requestAccounts", []);
    account = accounts[0];
    signer = await provider.getSigner();
    $("accountLabel").textContent = short(account);
    $("submitCard").classList.remove("hidden");
    setStatus("Connected on BNB Smart Chain.", "ok");
    await refreshAll();
  } catch (err) {
    console.error(err);
    setStatus("Connection failed: " + (err.message || err), "error");
  }
}

async function switchToBsc() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x38" }],
    });
  } catch (err) {
    // 4902 = chain not added in this wallet; add BSC mainnet.
    if (err.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: "0x38",
          chainName: "BNB Smart Chain",
          nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
          rpcUrls: ["https://bsc-dataseed.binance.org/"],
          blockExplorerUrls: ["https://bscscan.com/"],
        }],
      });
    } else {
      throw err;
    }
  }
}

function contracts() {
  if (!provider) return false;
  if (!hubDeployed()) {
    setStatus("Contract not deployed yet — HUB_ADDRESS in app.js is still a placeholder.", "error");
    return false;
  }
  hubRead = new ethers.Contract(HUB_ADDRESS, HUB_ABI, provider);
  hubWrite = signer ? new ethers.Contract(HUB_ADDRESS, HUB_ABI, signer) : null;
  return true;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function refreshAll() {
  if (!contracts()) return;
  await refreshAgentStatus();
  await refreshPrograms();
}

async function refreshAgentStatus() {
  try {
    const ok = await hubRead.isAgent(account);
    $("agentStatus").textContent = ok
      ? "✓ This wallet holds a Binance Agent ID — it can submit findings."
      : "✗ This wallet does NOT hold a Binance Agent ID — it cannot submit findings (it can still sponsor programs).";
  } catch (err) {
    $("agentStatus").textContent = "Could not check Agent ID status: " + (err.message || err);
  }
}

async function refreshPrograms() {
  const list = $("programList");
  try {
    const count = Number(await hubRead.programCount());
    const fCount = Number(await hubRead.findingCount());
    if (count === 0) {
      list.innerHTML = '<p class="muted">No programs yet. Create the first one above.</p>';
      return;
    }
    // Simple scan: fine for a hackathon demo (production would index events).
    const findings = [];
    for (let i = 1; i <= fCount; i++) findings.push(await hubRead.getFinding(i));

    let html = "";
    for (let id = count; id >= 1; id--) {
      const p = await hubRead.getProgram(id);
      const mine = account && p.owner.toLowerCase() === account.toLowerCase();
      const progFindings = findings.filter((f) => Number(f.programId) === id);
      window.__currentProgramOwner = p.owner; // findings below belong to this program
      html += `<div class="finding">
        <div class="row" style="justify-content:space-between">
          <strong>#${p.id} — ${escapeHtml(p.title)}</strong>
          <span class="badge ${p.closed ? "closed" : "open"}">${p.closed ? "Closed" : "Open"}</span>
        </div>
        <p class="muted">Owner: ${short(p.owner)}${mine ? " (you)" : ""} · Scope: <span class="mono">${escapeHtml(p.metadataURI)}</span></p>
        <p>Reward per finding: <strong>${ethers.formatEther(p.rewardPerFinding)} BNB</strong> · Escrow: <strong>${ethers.formatEther(p.escrow)} BNB</strong></p>
        ${mine && !p.closed ? `<div class="row">
          <button class="secondary" onclick="fundProgram(${p.id})">Fund +0.5 BNB</button>
          <button class="danger" onclick="closeProgram(${p.id})">Close program</button>
        </div>` : ""}
        ${mine && p.closed && Number(p.escrow) > 0 ? `<div class="row">
          <button class="secondary" onclick="withdrawEscrow(${p.id})">Withdraw remaining escrow</button>
        </div>` : ""}
        <div style="margin-top:10px"><strong>Findings (${progFindings.length})</strong></div>
        ${progFindings.length === 0 ? '<p class="muted">No findings yet.</p>' : progFindings.map(findingHtml).join("")}
      </div>`;
    }
    list.innerHTML = html;
  } catch (err) {
    console.error(err);
    list.innerHTML = '<p class="muted">Could not load programs: ' + escapeHtml(err.message || err) + "</p>";
  }
}

function findingHtml(f) {
  const isSubmitter = account && f.agent.toLowerCase() === account.toLowerCase();
  const status = STATUS[Number(f.status)];
  let actions = "";
  if (Number(f.status) === 0 && window.__currentProgramOwner &&
      account && window.__currentProgramOwner.toLowerCase() === account.toLowerCase()) {
    actions = `<div class="row">
      <button class="green" onclick="triageFinding(${f.id}, true)">Approve</button>
      <button class="danger" onclick="triageFinding(${f.id}, false)">Reject</button>
    </div>`;
  }
  if (Number(f.status) === 1 && !f.claimed && isSubmitter) {
    actions = `<div class="row"><button class="green" onclick="claimReward(${f.id})">Claim reward</button></div>`;
  }
  return `<div class="finding">
    <p><strong>Finding #${f.id}</strong> · <span class="badge ${status.toLowerCase()}">${status}</span> · Severity: ${SEVERITY[Number(f.severity)]}${f.claimed ? " · Claimed" : ""}</p>
    <p class="muted">Agent: ${short(f.agent)} · Report: <span class="mono">${escapeHtml(f.reportURI)}</span></p>
    <p class="mono">hash: ${f.reportHash}</p>
    ${actions}
  </div>`;
}

// NOTE: triage buttons need the program owner; refreshPrograms sets
// window.__currentProgramOwner while rendering each program's findings.

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function createProgram() {
  if (!contracts() || !hubWrite) return;
  const title = $("progTitle").value.trim();
  const meta = $("progMeta").value.trim();
  const reward = $("progReward").value;
  const escrow = $("progEscrow").value;
  if (!title || !meta || !reward || !escrow) {
    setStatus("Fill in all program fields.", "error");
    return;
  }
  try {
    setStatus("Waiting for your signature…", "muted");
    const tx = await hubWrite.createProgram(title, meta, ethers.parseEther(reward), { value: ethers.parseEther(escrow) });
    setStatus("Transaction sent: " + tx.hash + " — waiting for confirmation…", "muted");
    await tx.wait();
    setStatus("Program created.", "ok");
    await refreshPrograms();
  } catch (err) {
    console.error(err);
    setStatus("Create failed: " + (err.message || err), "error");
  }
}

async function submitFinding() {
  if (!contracts() || !hubWrite) return;
  const programId = Number($("findProgId").value);
  const uri = $("findUri").value.trim();
  const severity = Number($("findSeverity").value);
  const report = $("findReport").value;
  if (!programId || !uri || !report) {
    setStatus("Fill in program ID, report URI, and the report text.", "error");
    return;
  }
  const reportHash = ethers.keccak256(ethers.toUtf8Bytes(report));
  try {
    setStatus("Report hash (computed locally): " + reportHash, "muted");
    const tx = await hubWrite.submitFinding(programId, reportHash, uri, severity);
    setStatus("Transaction sent: " + tx.hash + " — waiting for confirmation…", "muted");
    await tx.wait();
    setStatus("Finding submitted.", "ok");
    await refreshPrograms();
  } catch (err) {
    console.error(err);
    setStatus("Submit failed: " + (err.message || err), "error");
  }
}

async function triageFinding(findingId, approve) {
  if (!contracts() || !hubWrite) return;
  try {
    const tx = await hubWrite.triageFinding(findingId, approve);
    await tx.wait();
    setStatus(approve ? "Finding approved." : "Finding rejected.", "ok");
    await refreshPrograms();
  } catch (err) {
    console.error(err);
    setStatus("Triage failed: " + (err.message || err), "error");
  }
}

async function claimReward(findingId) {
  if (!contracts() || !hubWrite) return;
  try {
    const tx = await hubWrite.claimReward(findingId);
    await tx.wait();
    setStatus("Reward claimed.", "ok");
    await refreshPrograms();
  } catch (err) {
    console.error(err);
    setStatus("Claim failed: " + (err.message || err), "error");
  }
}

async function fundProgram(programId) {
  if (!contracts() || !hubWrite) return;
  try {
    const tx = await hubWrite.fundProgram(programId, { value: ethers.parseEther("0.5") });
    await tx.wait();
    setStatus("Program funded with 0.5 BNB.", "ok");
    await refreshPrograms();
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
    await refreshPrograms();
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
    await refreshPrograms();
  } catch (err) {
    console.error(err);
    setStatus("Withdraw failed: " + (err.message || err), "error");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$("connectBtn").addEventListener("click", connect);
$("refreshBtn").addEventListener("click", refreshAll);
$("createProgBtn").addEventListener("click", createProgram);
$("submitFindingBtn").addEventListener("click", submitFinding);

if (window.ethereum) {
  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

// Read-only mode: show programs even before connecting.
(async () => {
  if (typeof ethers === "undefined") {
    $("programList").innerHTML = '<p class="muted">Failed to load ethers.js from CDN — check your connection.</p>';
    return;
  }
  if (hubDeployed()) {
    provider = new ethers.JsonRpcProvider("https://bsc-dataseed.binance.org/");
    await refreshPrograms();
  } else {
    $("programList").innerHTML = '<p class="muted">Contract not deployed yet. Set HUB_ADDRESS in app.js after deployment.</p>';
  }
})();
