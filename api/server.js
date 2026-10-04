// CRYPTO CLAIM SCANNER - Vercel Serverless Function (native Node.js, tanpa dependency)
// Read-only: hanya membaca data blockchain publik. Tidak ada transaksi, tidak ada private key.

const CONFIG = {
  // Tidak ada API key yang dibutuhkan. Verifikasi source code kontrak memakai
  // Sourcify (gratis, publik, tanpa key): https://sourcify.dev
  SOURCIFY: "https://sourcify.dev/server/v2/contract"
};

const CHAINS = {
  bsc: {
    id: 56, name: "BSC", native: "BNB", explorer: "https://bscscan.com/address/",
    rpc: ["https://bsc-dataseed.binance.org", "https://bsc-rpc.publicnode.com"]
  },
  base: {
    id: 8453, name: "Base", native: "ETH", explorer: "https://basescan.org/address/",
    rpc: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]
  }
};

// KNOWN CLAIM REGISTRY - hanya isi dengan claim yang sudah Anda verifikasi sendiri
// (cek di situs resmi proyek + explorer). Selama kosong, scanner berjalan di DEMO MODE.
// Format entri:
// { id:"proyek-1", name:"NAMA AIRDROP", chain:"bsc", contract:"0x...", token:"SIMBOL",
//   decimals:18, eligibilitySelector:"0x........", // view(address) -> uint256 jumlah claim
//   claimedSelector:"0x........",                   // view(address) -> bool/uint, opsional
//   requiresProof:false, deadline:"2026-12-15", gasLimit:150000, priceUsd:null }
const REGISTRY = [];

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 10000) break; }
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

async function rpcOne(url, method, params) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ac.signal
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "RPC error");
    return j.result;
  } finally { clearTimeout(timer); }
}

async function rpc(net, method, params) {
  let lastErr;
  for (const url of net.rpc) {
    try { return await rpcOne(url, method, params); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("RPC unavailable");
}

function formatUnits(v, decimals) {
  const d = Number(decimals || 18);
  const s = v.toString().padStart(d + 1, "0");
  const whole = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d).replace(/0+$/, "").slice(0, 6);
  return Number(whole).toLocaleString("en-US") + (frac ? "." + frac : "");
}

// true = source terverifikasi di Sourcify, false = belum ada, null = tidak dapat dicek.
// Terverifikasi hanya berarti source code cocok dengan bytecode, BUKAN bahwa kontrak aman.
async function sourceVerified(net, address) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(CONFIG.SOURCIFY + "/" + net.id + "/" + address, { signal: ac.signal });
    if (r.status === 404) return false;
    if (!r.ok) return null;
    const j = await r.json();
    return !!(j && j.match);
  } catch { return null; } finally { clearTimeout(timer); }
}

async function scanEntry(net, e, wallet, gasPrice) {
  const r = {
    id: e.id, name: e.name, token: e.token, contract: e.contract,
    explorer: net.explorer + e.contract, status: "UNKNOWN", claimable: null,
    valueUsd: null, gasNative: null, gasSymbol: net.native, gasUsd: null,
    deadline: e.deadline || null, risk: "UNKNOWN", sourceVerified: null,
    notes: [], demo: false, show: true
  };
  const pad = wallet.slice(2).toLowerCase().padStart(64, "0");
  try {
    const code = await rpc(net, "eth_getCode", [e.contract, "latest"]);
    if (!code || code === "0x") { r.notes.push("No contract code at this address"); return r; }
    r.sourceVerified = await sourceVerified(net, e.contract);
    r.notes.push(r.sourceVerified === true ? "Source code verified on Sourcify (not a safety guarantee)"
      : r.sourceVerified === false ? "Source code NOT verified on Sourcify"
      : "Source verification unavailable");

    if (e.claimedSelector) {
      const v = await rpc(net, "eth_call", [{ to: e.contract, data: e.claimedSelector + pad }, "latest"]);
      if (v && BigInt(v) !== 0n) { r.status = "CLAIMED"; return r; }
    }
    if (e.deadline && Date.parse(e.deadline + "T23:59:59Z") < Date.now()) { r.status = "EXPIRED"; return r; }

    if (e.eligibilitySelector) {
      const v = await rpc(net, "eth_call", [{ to: e.contract, data: e.eligibilitySelector + pad }, "latest"]);
      const amount = v ? BigInt(v) : 0n;
      if (amount > 0n) {
        r.status = "CLAIMABLE";
        r.claimable = formatUnits(amount, e.decimals) + " " + (e.token || "");
        if (e.priceUsd) r.valueUsd = Number(formatUnits(amount, e.decimals).replace(/,/g, "")) * e.priceUsd;
      } else { r.show = false; r.notes.push("Wallet not eligible per contract"); return r; }
    } else if (e.requiresProof) {
      r.status = "POSSIBLE";
      r.notes.push("Merkle proof required - eligibility cannot be verified on-chain here");
    } else {
      r.notes.push("No eligibility check available");
    }
    if (gasPrice) r.gasNative = Number(gasPrice * BigInt(e.gasLimit || 150000)) / 1e18;
  } catch (err) {
    r.notes.push("Check failed: " + (err.message || "unknown"));
  }
  return r;
}

function demoResults() {
  return [
    {
      id: "demo-1", name: "XYZ AIRDROP", token: "XYZ", contract: null, explorer: null,
      status: "CLAIMABLE", claimable: "12,450 XYZ", valueUsd: 84.2, gasUsd: 0.12,
      gasNative: null, gasSymbol: null, deadline: "2026-12-15", risk: "UNKNOWN",
      notes: [], demo: true, show: true
    },
    {
      id: "demo-2", name: "SAMPLE REDEEM", token: "SMP", contract: null, explorer: null,
      status: "UNKNOWN", claimable: null, valueUsd: null, gasUsd: null,
      gasNative: null, gasSymbol: null, deadline: null, risk: "UNKNOWN",
      notes: ["Eligibility could not be verified"], demo: true, show: true
    }
  ];
}

module.exports = async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return send(res, 405, { success: false, error: "Use POST" });

  const body = await readBody(req);
  const wallet = String(body.wallet || "").trim();
  const chain = String(body.chain || "").toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) return send(res, 400, { success: false, error: "Invalid EVM address" });
  if (!CHAINS[chain]) return send(res, 400, { success: false, error: "Chain not supported" });

  const net = CHAINS[chain];
  const entries = REGISTRY.filter(e => e.chain === chain);

  let block = null;
  try { block = parseInt(await rpc(net, "eth_blockNumber", []), 16); } catch { block = null; }

  if (!block || !entries.length) {
    return send(res, 200, {
      success: true, mode: "demo",
      reason: !block ? "rpc_unavailable" : "registry_empty",
      wallet, chain, contractsScanned: 0, claimContracts: 0, eligible: 0,
      results: demoResults()
    });
  }

  let gasPrice = null;
  try { gasPrice = BigInt(await rpc(net, "eth_gasPrice", [])); } catch { gasPrice = null; }

  const scanned = await Promise.all(entries.map(e => scanEntry(net, e, wallet, gasPrice)));
  const results = scanned.filter(r => r.show);
  const eligible = results.filter(r => r.status === "CLAIMABLE" || r.status === "POSSIBLE").length;

  return send(res, 200, {
    success: true, mode: "live", wallet, chain, block,
    contractsScanned: entries.length, claimContracts: results.length, eligible, results
  });
};
