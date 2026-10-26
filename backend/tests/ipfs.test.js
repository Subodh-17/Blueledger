// IPFS: pin + verify against a REAL Kubo node (when available), bounded retries, truthful status during outages, content-mismatch detection.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const crypto = require("node:crypto");
const kubo = require("./helpers/kubo");
const { setup, projectBody, recordBody, uniquePng } = require("./helpers");
const cfg = require("../src/config");
const db = require("../src/db");
const ipfs = require("../src/services/ipfs");
const storage = require("../src/services/storage");
const cryptoSvc = require("../src/services/crypto");

const KUBO = kubo.available();
let env, P, R, node;
const PORT = 5101;
const png = (extra = "") => Buffer.concat([uniquePng(), Buffer.from(extra)]);
const up = async (buf = png()) => (await env.as("fieldA").upload({ projectId: P.id, recordId: R.id, kind: "FIELD_PHOTO", captureDate: "2026-06-01" }, buf, "photo.png")).body.evidence;
const row = async (id) => (await db.query("SELECT * FROM evidence WHERE id=$1", [id])).rows[0];
const configure = (over = {}) => Object.assign(cfg.ipfs, { provider: "kubo", apiUrl: `http://127.0.0.1:${PORT}`, timeoutMs: 4000, retryMax: 3, backoffBaseMs: 60000, backoffMaxMs: 600000, ...over });

test.before(async () => {
  env = await setup();
  P = (await env.as("admin").post("/api/projects", projectBody(env.orgs.a))).body.project;
  R = (await env.as("fieldA").post("/api/records", recordBody(P.id))).body.record;
  cfg.scan.policy = "off";
  if (KUBO) node = await kubo.start(PORT);
});
test.after(async () => { if (node) { await node.stop(); node.cleanup(); } await env.close(); });

test("storage: files are content-addressed and rejected unless the content matches the extension", () => {
  const buf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("test content " + Math.random())]);
  const s = storage.save(buf, "photo.PNG");
  assert.equal(s.sha256, crypto.createHash("sha256").update(buf).digest("hex"));
  assert.ok(fs.existsSync(storage.pathFor(s.file)));
  assert.equal(storage.save(buf, "script.js"), null);
  assert.ok(storage.save(Buffer.from("MZ executable pretending to be an image"), "x.png").error, "content must match the extension");
  assert.equal(storage.save(buf, "x.svg"), null, "svg only allowed for the reference-data loader");
});

test("backoff is exponential, jittered and capped", () => {
  configure({ backoffBaseMs: 1000, backoffMaxMs: 8000 });
  const lo = (n) => ipfs.backoffMs(n);
  for (let i = 0; i < 20; i++) { assert.ok(lo(1) >= 750 && lo(1) <= 1250); assert.ok(lo(3) >= 3000 && lo(3) <= 5000); assert.ok(lo(9) <= 10000 && lo(9) >= 6000, "capped near the maximum"); }
});

test("with no provider configured nothing is ever reported as pinned", async () => {
  Object.assign(cfg.ipfs, { provider: "none" });
  const e = await up();
  assert.equal(e.ipfs_status, "NOT_CONFIGURED"); assert.equal(e.ipfs_cid, null);
  assert.deepEqual(await ipfs.processPending({ force: true }), { processed: 0 });
});

test("REAL Kubo node: the file is pinned, read back by CID, hash-verified and only then reported as pinned", { skip: !KUBO && "kubo binary not available" }, async () => {
  configure();
  const buf = png("ipfs-round-trip");
  const e = await up(buf);
  assert.equal(e.ipfs_status, "PENDING", "not reported as pinned at upload time");
  await new Promise((r) => setTimeout(r, 1500)); // the background attempt started by the upload
  let r = await row(e.id);
  if (r.ipfs_status !== "PINNED") { await ipfs.processPending({ force: true }); r = await row(e.id); }
  assert.equal(r.ipfs_status, "PINNED", JSON.stringify(r)); assert.match(r.ipfs_cid, /^baf[a-z0-9]+$/); assert.ok(r.ipfs_verified_at); assert.equal(r.ipfs_attempts >= 1, true);
  const cat = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/api/v0/cat?arg=${r.ipfs_cid}`, { method: "POST" })).arrayBuffer());
  assert.ok(cat.equals(buf), "the node returns exactly the uploaded bytes");
  const ls = await (await fetch(`http://127.0.0.1:${PORT}/api/v0/pin/ls?arg=${r.ipfs_cid}&type=all`, { method: "POST" })).json();
  assert.ok(ls.Keys[r.ipfs_cid], "the CID is pinned on the node");
  assert.equal(await ipfs.fetchHash(r.ipfs_cid), r.stored_sha256);
});

test("REAL Kubo node with encryption at rest: the ciphertext is what gets pinned and verified", { skip: !KUBO && "kubo binary not available" }, async () => {
  configure(); cfg.encryption.mode = "required"; cfg.encryption.current = cryptoSvc.generateKey("ipfs-k1");
  try {
    const e = await up(png("pinned-ciphertext-check"));
    await ipfs.processPending({ force: true }); await new Promise((r) => setTimeout(r, 800));
    const r = await row(e.id);
    assert.equal(r.encrypted, true); assert.equal(r.ipfs_status, "PINNED");
    const cat = Buffer.from(await (await fetch(`http://127.0.0.1:${PORT}/api/v0/cat?arg=${r.ipfs_cid}`, { method: "POST" })).arrayBuffer());
    assert.ok(!cat.includes("pinned-ciphertext-check"), "plaintext never leaves the server");
    assert.equal(crypto.createHash("sha256").update(cat).digest("hex"), r.stored_sha256);
  } finally { cfg.encryption.mode = "off"; cfg.encryption.current = undefined; }
});

test("REAL Kubo outage: status is UNAVAILABLE with a future retry time (never pinned), and the item recovers when the node returns", { skip: !KUBO && "kubo binary not available" }, async () => {
  configure();
  await node.stop();
  const e = await up(png("outage"));
  await new Promise((r) => setTimeout(r, 1200));
  const a = await ipfs.attempt(e.id);
  assert.equal(a.status, "UNAVAILABLE");
  let r = await row(e.id);
  assert.equal(r.ipfs_status, "UNAVAILABLE"); assert.equal(r.ipfs_cid, null); assert.ok(r.ipfs_attempts >= 1); assert.ok(new Date(r.ipfs_next_retry_at) > new Date(), "the next attempt is scheduled in the future");
  assert.equal((await ipfs.processPending()).processed, 0, "not retried before it is due (bounded backoff)");
  assert.equal(((await env.as("admin").get("/api/system/status")).body.evidenceStorage.ipfs).reachable, false, "health reports the outage");
  node = await kubo.start(PORT, node.repo);
  const out = await ipfs.processPending({ force: true });
  assert.ok(out.pinned >= 1, JSON.stringify(out));
  r = await row(e.id);
  assert.equal(r.ipfs_status, "PINNED"); assert.ok(r.ipfs_cid); assert.equal(r.ipfs_last_error, null);
  assert.equal(((await env.as("admin").get("/api/system/status")).body.evidenceStorage.ipfs).reachable, true);
});

test("retries are bounded: after IPFS_RETRY_MAX failures the item stops retrying until an administrator requeues it", { skip: !KUBO && "kubo binary not available" }, async () => {
  configure({ retryMax: 2 });
  await node.stop();
  const e = await up(png("bounded"));
  await new Promise((r) => setTimeout(r, 1200));
  await db.query("UPDATE evidence SET ipfs_attempts=0, ipfs_status='PENDING', ipfs_next_retry_at=NULL WHERE id=$1", [e.id]);
  await ipfs.attempt(e.id); const r1 = await ipfs.attempt(e.id);
  assert.equal(r1.exhausted, true);
  let r = await row(e.id); assert.equal(r.ipfs_next_retry_at, null); assert.equal(r.ipfs_attempts, 2);
  assert.equal((await ipfs.processPending({ force: true })).processed, 0, "exhausted items are not retried automatically");
  node = await kubo.start(PORT, node.repo);
  assert.equal((await env.as("verifier").post("/api/system/ipfs/retry", {})).status, 403);
  const rq = await env.as("admin").post("/api/system/ipfs/retry", { resetAttempts: true });
  assert.equal(rq.status, 200); assert.ok(rq.body.pinned >= 1);
  assert.equal((await row(e.id)).ipfs_status, "PINNED");
});

test("a node that returns different bytes for the CID is VERIFY_FAILED, never PINNED", async () => {
  const srv = http.createServer((req, res) => {
    req.resume();
    if (req.url.startsWith("/api/v0/add")) { res.setHeader("content-type", "application/json"); req.on("end", () => res.end(JSON.stringify({ Hash: "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy", Name: "x", Size: "1" }))); }
    else if (req.url.startsWith("/api/v0/cat")) req.on("end", () => res.end("completely different bytes"));
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    configure({ apiUrl: `http://127.0.0.1:${srv.address().port}` });
    const e = await up(png("mismatch")); await new Promise((r) => setTimeout(r, 600));
    const a = await ipfs.attempt(e.id);
    assert.equal(a.status, "VERIFY_FAILED");
    const r = await row(e.id); assert.equal(r.ipfs_status, "VERIFY_FAILED"); assert.equal(r.ipfs_cid, null); assert.match(r.ipfs_last_error, /hashes to/);
    assert.equal((await db.query("SELECT COUNT(*)::int n FROM audit_logs WHERE action='EVIDENCE_IPFS_VERIFY_FAILED'")).rows[0].n >= 1, true);
  } finally { srv.close(); }
});

test("a hanging IPFS service cannot block the application: the attempt times out within the configured bound", async () => {
  const srv = http.createServer(() => { /* never responds */ });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    configure({ apiUrl: `http://127.0.0.1:${srv.address().port}`, timeoutMs: 400 });
    const e = await up(png("hang")); await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now(); const a = await ipfs.attempt(e.id);
    assert.equal(a.status, "UNAVAILABLE"); assert.ok(Date.now() - t0 < 3000, `returned in ${Date.now() - t0} ms`);
  } finally { srv.closeAllConnections?.(); srv.close(); Object.assign(cfg.ipfs, { provider: "none", timeoutMs: 15000 }); }
});
