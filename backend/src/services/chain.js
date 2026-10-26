// backend/src/services/chain.js — client for the BlueCarbonRegistry smart contract (ethers v6).
//
// Signing model: the backend signs as configured signing accounts.
//   CHAIN_MODE=local  Local development node only. Uses the node's unlocked accounts: [0] registry administrator,
//                     [1] verifier, [2] registrar. A user whose wallet_address is one of the unlocked accounts signs their own actions.
//   CHAIN_MODE=keys   Uses CHAIN_*_PRIVATE_KEY from the environment (never stored in the repository). Holder-signed
//                     transfers/retirements are not available because the backend does not hold holder keys.
//
// Reliability: the deployment artifact is validated (shape, chain ID, contract code, required ABI), RPC calls have a timeout,
// submissions are split into "submit" (returns a transaction hash) and "wait" (receipt), and failures are classified as
// permanent (contract rejection) or transient (network). See chainOps.js for durable operations and reconciliation.
const fs = require("fs");
const { ethers } = require("ethers");
const appCfg = require("../config");
const cfg = appCfg.chain;
const { HttpError } = require("../utils/http");

const DECISION = { VERIFIED: 0, REJECTED: 1, NEEDS_REVISION: 2 };
const REC_STATUS = ["NONE", "ANCHORED", "VERIFIED", "REJECTED", "NEEDS_REVISION", "CREDITED"];
const REQUIRED_FUNCTIONS = ["admin", "registerProject", "anchorRecord", "reanchorRecord", "recordVerification", "issueCredits", "transfer", "retire", "getRecord", "getProject", "batchBalanceOf", "setVerifier", "setRegistrar", "isVerifier", "isRegistrar", "usedRef", "proposeAdmin", "acceptAdmin", "isBatchFrozen", "setBatchFrozen", "cancelCredits", "batchCancelled", "totalCancelled"];

/** Permanent = the contract/signer rejected the call (retrying the same call will not help). Transient = network/RPC problem. */
class ChainError extends Error {
  constructor(message, { permanent = false, timeout = false } = {}) { super(message); this.permanent = permanent; this.timeout = timeout; }
}
function classify(e) {
  const reason = e.reason || e.revert?.args?.[0] || e.shortMessage || e.message || "unknown error";
  if (e instanceof ChainError) return e;
  if (e.code === "CALL_EXCEPTION" || e.code === "ACTION_REJECTED" || e.code === "INSUFFICIENT_FUNDS" || e.reason) return new ChainError(reason, { permanent: true });
  if (e.code === "TIMEOUT") return new ChainError("Timed out waiting for the blockchain network", { timeout: true });
  return new ChainError(`Blockchain network error: ${reason}`);
}

class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  run(fn) { const r = this.tail.then(fn, fn); this.tail = r.catch(() => {}); return r; }
}

class ChainService {
  constructor() { this.ready = false; this.error = "not initialised"; this.lastTry = 0; this.mutex = new Mutex(); this.deployment = null; }

  async init() {
    this.lastTry = Date.now();
    try {
      if (!fs.existsSync(cfg.deploymentFile)) throw new Error(`Deployment file not found (${cfg.deploymentFile}). Deploy the contract first.`);
      let dep;
      try { dep = JSON.parse(fs.readFileSync(cfg.deploymentFile, "utf8")); } catch { throw new Error("Deployment file is not valid JSON"); }
      const address = cfg.contractAddress || dep.address;
      if (!ethers.isAddress(address || "")) throw new Error("Deployment file has no valid contract address");
      if (!Array.isArray(dep.abi)) throw new Error("Deployment file has no ABI");
      const names = new Set(dep.abi.filter((f) => f.type === "function").map((f) => f.name));
      const missing = REQUIRED_FUNCTIONS.filter((n) => !names.has(n));
      if (missing.length) throw new Error(`Deployment ABI is missing functions: ${missing.join(", ")}`);

      // Probe the chain ID with a bounded raw call first: ethers' own network detection retries forever when the node is unreachable.
      let probe;
      try {
        probe = await fetch(cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(appCfg.rpcTimeoutMs) });
        if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
      } catch (e) { throw new Error(`RPC endpoint unreachable (${e.cause?.code || e.message})`); }
      const hex = (await probe.json()).result;
      if (!hex) throw new Error("RPC endpoint did not return a chain ID");
      this.chainId = Number(BigInt(hex));
      const network = ethers.Network.from(this.chainId);
      const req = new ethers.FetchRequest(cfg.rpcUrl); req.timeout = appCfg.rpcTimeoutMs;
      if (this.provider?.destroy) this.provider.destroy();
      this.provider = new ethers.JsonRpcProvider(req, network, { staticNetwork: network });
      if (appCfg.isProd) {
        if (cfg.mode !== "keys") throw new Error("Production requires CHAIN_MODE=keys (service signing keys from the environment)");
        if (!cfg.expectedChainId) throw new Error("Production requires EXPECTED_CHAIN_ID so the application never falls back to an unintended network");
        if (this.chainId !== cfg.expectedChainId) throw new Error(`Production chain ID mismatch: expected ${cfg.expectedChainId}, the RPC endpoint reports ${this.chainId}`);
        if ([31337, 1337].includes(this.chainId) && !cfg.allowLocalChain) throw new Error("Refusing to run production against a local development chain (set ALLOW_LOCAL_CHAIN=1 to override deliberately)");
        if (!dep.codeHash) throw new Error("Production requires a deployment file with a codeHash");
      }
      if (cfg.expectedChainId && this.chainId !== cfg.expectedChainId) throw new Error(`Chain ID ${this.chainId} does not match EXPECTED_CHAIN_ID ${cfg.expectedChainId}`);
      if (dep.chainId != null && Number(dep.chainId) !== this.chainId)
        throw new Error(`Chain ID mismatch: deployment was made on chain ${dep.chainId} but the RPC endpoint reports chain ${this.chainId}`);
      if ((await this.provider.getCode(address)) === "0x") throw new Error(`No contract code at ${address} on chain ${this.chainId}`);
      if (dep.codeHash && ethers.keccak256(await this.provider.getCode(address)) !== dep.codeHash) throw new Error(`The bytecode at ${address} does not match the deployment file (code hash mismatch)`);
      this.address = address; this.abi = dep.abi; this.deployBlock = dep.deployBlock || 0; this.deployment = { network: dep.network, deployedAt: dep.deployedAt, admin: dep.admin, codeHashVerified: !!dep.codeHash };
      this.readContract = new ethers.Contract(address, dep.abi, this.provider);

      this.accounts = [];
      if (cfg.mode === "local") {
        this.accounts = await this.provider.listAccounts();
        if (this.accounts.length < 3) throw new Error("Local mode needs at least 3 unlocked accounts (start a local development node)");
        this.roles = { admin: this.accounts[0], verifier: this.accounts[1], registrar: this.accounts[2] };
      } else {
        const mk = (k, n) => { if (!k) throw new Error(`${n} is required when CHAIN_MODE=keys`); return new ethers.NonceManager(new ethers.Wallet(k, this.provider)); };
        this.roles = { admin: mk(cfg.adminKey, "CHAIN_ADMIN_PRIVATE_KEY"), verifier: mk(cfg.verifierKey, "CHAIN_VERIFIER_PRIVATE_KEY"), registrar: mk(cfg.registrarKey, "CHAIN_REGISTRAR_PRIVATE_KEY") };
      }
      this.adminAddress = await this.readContract.admin();
      const signerAdmin = await this.roles.admin.getAddress();
      if (signerAdmin.toLowerCase() !== this.adminAddress.toLowerCase()) throw new Error("The configured administrator signing account is not the contract administrator");
      this.ready = true; this.error = null;
    } catch (e) { this.ready = false; this.error = e.message; }
    return this.status();
  }

  async ensure() {
    if (this.ready) return;
    if (Date.now() - this.lastTry > 3000) await this.init();
    if (!this.ready) throw new HttpError(503, `Blockchain network not connected: ${this.error}`);
  }

  async status() {
    const base = { ready: this.ready, connection: this.ready ? "CONNECTED" : "NOT_CONNECTED", error: this.error, mode: cfg.mode, rpcEndpoint: redact(cfg.rpcUrl) };
    if (!this.ready) return base;
    try {
      return { ...base, chainId: this.chainId, contractAddress: this.address, blockNumber: await this.provider.getBlockNumber(), admin: this.adminAddress,
        tokenName: await this.readContract.name(), tokenSymbol: await this.readContract.symbol(), totalIssued: Number(await this.readContract.totalIssued()),
        totalRetired: Number(await this.readContract.totalRetired()), deployment: this.deployment };
    } catch (e) { this.ready = false; this.error = e.message; return { ...base, ready: false, connection: "NOT_CONNECTED", error: e.message }; }
  }

  signerFor(role, wallet) {
    if (cfg.mode === "local" && wallet) { const hit = this.accounts.find((a) => a.address.toLowerCase() === wallet.toLowerCase()); if (hit) return hit; }
    return this.roles[role];
  }
  canSignFor(wallet) { return cfg.mode === "local" && !!wallet && this.accounts?.some((a) => a.address.toLowerCase() === wallet.toLowerCase()); }

  /** Send a transaction. Resolves as soon as the network accepted it (transaction hash known); call wait() for the receipt. */
  async submit(role, wallet, method, args) {
    await this.ensure();
    return this.mutex.run(async () => {
      try {
        const signer = this.signerFor(role, wallet);
        const tx = await this.readContract.connect(signer)[method](...args);
        const from = await signer.getAddress();
        const info = { hash: tx.hash, from, chainId: this.chainId, contract: this.address };
        return { ...info, wait: async (timeoutMs = appCfg.txConfirmTimeoutMs) => {
          try {
            const rc = await tx.wait(cfg.confirmations, timeoutMs);
            if (!rc || rc.status !== 1) throw new ChainError("Transaction reverted", { permanent: true });
            const blk = await this.provider.getBlock(rc.blockNumber);
            if (!blk || blk.hash !== rc.blockHash) throw new ChainError("The block containing the transaction is no longer part of the canonical chain");
            return { txHash: rc.hash, blockNumber: rc.blockNumber, blockHash: rc.blockHash, gasUsed: rc.gasUsed.toString(), from, chainId: this.chainId, contract: this.address };
          } catch (e) { throw classify(e); }
        } };
      } catch (e) { throw classify(e); }
    });
  }

  /** Status of a transaction as reported by the network: CONFIRMED (success, required depth, canonical block) | FAILED | PENDING (not mined or not deep enough) | UNKNOWN (not found, dropped or reorganised away). */
  async receiptFor(hash) {
    await this.ensure();
    try {
      // Raw JSON-RPC calls: the high-level provider caches lookups for a short time, which would hide a dropped or reorganised transaction.
      const rc = await this.provider.send("eth_getTransactionReceipt", [hash]);
      if (rc) {
        const head = Number(await this.provider.send("eth_blockNumber", [])), num = Number(rc.blockNumber);
        const blk = await this.provider.send("eth_getBlockByNumber", [rc.blockNumber, false]);
        if (!blk || blk.hash !== rc.blockHash) return { status: "UNKNOWN", txHash: hash, reason: "reorganised" };
        if (rc.status !== "0x1") return { status: "FAILED", txHash: hash, blockNumber: num };
        if (head - num + 1 < cfg.confirmations) return { status: "PENDING", txHash: hash, confirmations: head - num + 1 };
        return { status: "CONFIRMED", txHash: hash, blockNumber: num, blockHash: rc.blockHash, gasUsed: BigInt(rc.gasUsed).toString(), from: rc.from, chainId: this.chainId, contract: this.address };
      }
      return { status: (await this.provider.send("eth_getTransactionByHash", [hash])) ? "PENDING" : "UNKNOWN", txHash: hash };
    } catch (e) { throw classify(e); }
  }

  registerProject(projectId32, metadataHash) { return this.submit("registrar", null, "registerProject", [projectId32, metadataHash]); }
  anchorRecord(projectId32, recordId32, contentHash, evidenceRoot) { return this.submit("registrar", null, "anchorRecord", [projectId32, recordId32, contentHash, evidenceRoot]); }
  reanchorRecord(recordId32, contentHash, evidenceRoot) { return this.submit("registrar", null, "reanchorRecord", [recordId32, contentHash, evidenceRoot]); }
  recordVerification(recordId32, decision, verificationHash, wallet) { return this.submit("verifier", wallet, "recordVerification", [recordId32, DECISION[decision], verificationHash]); }
  issueCredits(recordId32, quantity, estimateHash, holder, wallet) { return this.submit("admin", wallet, "issueCredits", [recordId32, quantity, estimateHash, holder]); }
  async transfer(recordId32, fromWallet, to, amount, ref) {
    await this.ensure();
    if (!this.canSignFor(fromWallet)) throw new ChainError("Transfers must be signed by the holder's own wallet; the backend can only sign for holders on a local development node", { permanent: true });
    return this.submit("holder", fromWallet, "transfer", [recordId32, to, amount, ref]);
  }
  async retire(recordId32, holderWallet, amount, reason, ref) {
    await this.ensure();
    if (!this.canSignFor(holderWallet)) throw new ChainError("Retirement must be signed by the holder's own wallet; the backend can only sign for holders on a local development node", { permanent: true });
    return this.submit("holder", holderWallet, "retire", [recordId32, amount, reason, ref]);
  }
  /** On-chain idempotency: has a transfer/retirement with this reference already executed? */
  async refUsed(ref) { await this.ensure(); try { return await this.readContract.usedRef(ref); } catch (e) { throw classify(e); } }
  /** The event proving a reference was used (to recover its transaction hash). */
  async findRefEvent(kind, ref) {
    await this.ensure();
    try {
      const f = kind === "transfer" ? this.readContract.filters.CreditsTransferred(null, null, null, null, ref) : this.readContract.filters.CreditsRetired(null, null, null, null, ref);
      return (await this.readContract.queryFilter(f, this.deployBlock || 0))[0] || null;
    } catch (e) { throw classify(e); }
  }
  /** Contract events by name and indexed arguments (null = any), oldest first. Used by recovery to find the transaction behind a state that already holds on-chain. */
  async findEvents(name, ...args) {
    await this.ensure();
    try { return await this.readContract.queryFilter(this.readContract.filters[name](...args), this.deployBlock || 0); } catch (e) { throw classify(e); }
  }
  async allRefEvents() {
    await this.ensure();
    try {
      const t = await this.readContract.queryFilter(this.readContract.filters.CreditsTransferred(), this.deployBlock || 0), r = await this.readContract.queryFilter(this.readContract.filters.CreditsRetired(), this.deployBlock || 0), c = await this.readContract.queryFilter(this.readContract.filters.CreditsCancelled(), this.deployBlock || 0);
      return [
        ...t.map((e) => ({ kind: "transfer", ref: e.args.ref, tx: e.transactionHash, amount: Number(e.args.amount), recordId: e.args.recordId })),
        ...r.map((e) => ({ kind: "retire", ref: e.args.ref, tx: e.transactionHash, amount: Number(e.args.amount), recordId: e.args.recordId })),
        ...c.map((e) => ({ kind: "cancel", ref: e.args.ref, tx: e.transactionHash, amount: Number(e.args.amount), recordId: e.args.recordId }))
      ];
    } catch (e) { throw classify(e); }
  }
  setBatchFrozen(recordId32, frozen, caseHash32, adminWallet) {
    return this.submit("admin", adminWallet, "setBatchFrozen", [recordId32, frozen, caseHash32]);
  }
  cancelCredits(recordId32, holderWallet, amount, caseHash32, ref, adminWallet) {
    return this.submit("admin", adminWallet, "cancelCredits", [recordId32, holderWallet, amount, caseHash32, ref]);
  }
  proposeAdmin(account) { return this.submit("admin", null, "proposeAdmin", [account]); }
  /** Current on-chain role holders, reconstructed from RoleChanged events and confirmed against the contract. */
  async roleHolders() {
    await this.ensure();
    try {
      const evs = await this.readContract.queryFilter(this.readContract.filters.RoleChanged(), this.deployBlock || 0);
      const seen = new Map(); for (const e of evs) seen.set(`${e.args.role}:${e.args.account.toLowerCase()}`, { role: e.args.role, account: e.args.account });
      const holders = [];
      for (const h of seen.values()) { const on = h.role === "verifier" ? await this.readContract.isVerifier(h.account) : await this.readContract.isRegistrar(h.account); if (on) holders.push(h); }
      return { admin: await this.readContract.admin(), pendingAdmin: await this.readContract.pendingAdmin(), serviceRegistrar: await this.roles.registrar.getAddress(), holders };
    } catch (e) { throw classify(e); }
  }
  setVerifier(account, granted) { return this.submit("admin", null, "setVerifier", [account, granted]); }
  setRegistrar(account, granted) { return this.submit("admin", null, "setRegistrar", [account, granted]); }

  // ── reads ──
  async getRecord(recordId32) {
    await this.ensure();
    try {
      const r = await this.readContract.getRecord(recordId32);
      return { projectId: r.projectId, contentHash: r.contentHash, evidenceRoot: r.evidenceRoot, status: REC_STATUS[Number(r.status)], revision: Number(r.revision), anchoredAt: Number(r.anchoredAt),
        verifier: r.verifier, verifiedAt: Number(r.verifiedAt), verificationHash: r.verificationHash, estimateHash: r.estimateHash, creditQuantity: Number(r.creditQuantity), creditHolder: r.creditHolder, issuedAt: Number(r.issuedAt) };
    } catch (e) { throw classify(e); }
  }
  async getProject(projectId32) {
    await this.ensure();
    try { const p = await this.readContract.getProject(projectId32); return { exists: p.exists, active: p.active, metadataHash: p.metadataHash, totalIssued: Number(p.totalIssued) }; } catch (e) { throw classify(e); }
  }
  async batchRetired(recordId32) { await this.ensure(); try { return Number(await this.readContract.batchRetired(recordId32)); } catch (e) { throw classify(e); } }
  async batchCancelled(recordId32) { await this.ensure(); try { return Number(await this.readContract.batchCancelled(recordId32)); } catch (e) { throw classify(e); } }
  async totalCancelled() { await this.ensure(); try { return Number(await this.readContract.totalCancelled()); } catch (e) { throw classify(e); } }
  async isBatchFrozen(recordId32) { await this.ensure(); try { return await this.readContract.isBatchFrozen(recordId32); } catch (e) { throw classify(e); } }
  async batchBalance(recordId32, holder) { await this.ensure(); try { return Number(await this.readContract.batchBalanceOf(recordId32, holder)); } catch (e) { throw classify(e); } }
  async rolesOf(address) { await this.ensure(); return { verifier: await this.readContract.isVerifier(address), registrar: await this.readContract.isRegistrar(address), admin: (await this.readContract.admin()).toLowerCase() === address.toLowerCase() }; }
}

const redact = (u) => u.replace(/\/\/[^@/]*@/, "//***@").replace(/([?&](?:key|apikey|token)=)[^&]+/gi, "$1***");

module.exports = new ChainService();
module.exports.ChainService = ChainService;
module.exports.ChainError = ChainError;
