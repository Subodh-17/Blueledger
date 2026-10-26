// The real server entry point starts, connects to the chain and serves the API and the UI.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

test("backend process starts, reports health and chain status, and serves the frontend", async () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "index.js")], { env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  try {
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) { try { ok = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 250)); } }
    assert.ok(ok, "server did not become healthy");
    const st = await (await fetch(`http://127.0.0.1:${port}/api/chain/status`)).json();
    assert.equal(st.ready, true);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Blue Carbon Registry/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects`)).status, 401);
  } finally { child.kill(); }
});
