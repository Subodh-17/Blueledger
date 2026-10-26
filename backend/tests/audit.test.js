// Audit log: append-only enforcement and tamper evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const { setup, projectBody } = require("./helpers");
const db = require("../src/db");
const audit = require("../src/services/audit");

let env;
test.before(async () => { env = await setup(); await env.as("admin").post("/api/projects", projectBody(env.orgs.a)); });
test.after(async () => { await env.close(); });

test("audit entries record actor, role, action, entity and timestamp", async () => {
  const e = (await db.query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 1")).rows[0];
  assert.equal(e.action, "PROJECT_CREATED");
  assert.equal(e.actor_role, "NCCR_ADMIN");
  assert.equal(e.actor_name, "admin");
  assert.ok(e.project_id && e.created_at && e.entry_hash);
});

test("database refuses UPDATE and DELETE on audit_logs", async () => {
  await assert.rejects(db.query("UPDATE audit_logs SET action='X'"), /append-only/);
  await assert.rejects(db.query("DELETE FROM audit_logs"), /append-only/);
});

test("hash chain detects out-of-band tampering", async () => {
  assert.equal((await audit.verifyChain()).ok, true);
  await env.as("admin").post("/api/organizations", { name: "Another Test Org", orgType: "NGO" });
  assert.equal((await audit.verifyChain()).ok, true);
  const first = (await db.query("SELECT id FROM audit_logs ORDER BY id LIMIT 1")).rows[0].id;
  // a superuser bypassing the trigger is the only way to alter history - and the chain exposes it
  await db.query("ALTER TABLE audit_logs DISABLE TRIGGER trg_audit_no_update");
  try {
    await db.query("UPDATE audit_logs SET details='{\"forged\":true}'::jsonb WHERE id=$1", [first]);
    const v = await audit.verifyChain();
    assert.equal(v.ok, false);
    assert.equal(v.firstBadId, Number(first));
    assert.equal((await env.as("admin").get("/api/audit/verify")).body.ok, false);
  } finally {
    await db.query("TRUNCATE audit_logs");
    await db.query("ALTER TABLE audit_logs ENABLE TRIGGER trg_audit_no_update");
  }
});
