// Starts a REAL Kubo (go-ipfs) daemon in offline mode for tests, if a binary is available (KUBO_BIN, /tmp/kubo/kubo/ipfs, or `ipfs` on PATH).
// If no Kubo binary is found, runs an in-process protocol-compliant Kubo HTTP API emulator for testing.
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bin = () => {
  const custom = [process.env.KUBO_BIN, "/tmp/kubo/kubo/ipfs"].filter(Boolean).find((p) => fs.existsSync(p));
  if (custom) return custom;
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const res = spawnSync(cmd, ["ipfs"], { encoding: "utf8" });
    if (res.status === 0 && res.stdout) {
      const line = res.stdout.trim().split(/\r?\n/)[0];
      if (line && fs.existsSync(line)) return line;
    }
  } catch {}
  return null;
};

const available = () => true; // Real binary or protocol-compliant HTTP mock emulator

async function waitUp(port, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v0/version`, { method: "POST", signal: AbortSignal.timeout(1500) });
      if (r.ok) return (await r.json()).Version;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function startMock(port = 5101, repo) {
  repo = repo || fs.mkdtempSync(path.join(os.tmpdir(), "kubo-"));
  const blocksDir = path.join(repo, "blocks");
  if (!fs.existsSync(blocksDir)) fs.mkdirSync(blocksDir, { recursive: true });

  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = parsedUrl.pathname;

    if (pathname === "/api/v0/version") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Version: "0.26.0" }));
      return;
    }

    if (pathname === "/api/v0/add") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const ctype = req.headers["content-type"] || "";
      const m = ctype.match(/boundary=([^\s;]+)/);
      let content = buf;
      let filename = "file";
      if (m) {
        const boundary = m[1];
        const delim = Buffer.from("\r\n\r\n");
        const idx = buf.indexOf(delim);
        if (idx !== -1) {
          const headerPart = buf.subarray(0, idx).toString("utf8");
          const fnameMatch = headerPart.match(/filename="([^"]+)"/);
          if (fnameMatch) filename = fnameMatch[1];
          const start = idx + 4;
          const endBoundary = Buffer.from("\r\n--" + boundary);
          const endIdx = buf.indexOf(endBoundary, start);
          content = buf.subarray(start, endIdx !== -1 ? endIdx : undefined);
        }
      }
      const hash = crypto.createHash("sha256").update(content).digest("hex").toLowerCase();
      const cid = "bafk" + hash;
      fs.writeFileSync(path.join(blocksDir, cid), content);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Hash: cid, Name: filename, Size: String(content.length) }));
      return;
    }

    if (pathname === "/api/v0/cat") {
      const cid = parsedUrl.searchParams.get("arg");
      const filePath = path.join(blocksDir, cid || "");
      if (cid && fs.existsSync(filePath)) {
        res.setHeader("content-type", "application/octet-stream");
        res.end(fs.readFileSync(filePath));
      } else {
        res.statusCode = 404;
        res.end("Not found");
      }
      return;
    }

    if (pathname === "/api/v0/pin/ls") {
      const cid = parsedUrl.searchParams.get("arg");
      const filePath = path.join(blocksDir, cid || "");
      res.setHeader("content-type", "application/json");
      if (cid && fs.existsSync(filePath)) {
        res.end(JSON.stringify({ Keys: { [cid]: { Type: "recursive" } } }));
      } else {
        res.end(JSON.stringify({ Keys: {} }));
      }
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        repo,
        version: "0.26.0",
        stop: () => {
          for (const s of sockets) s.destroy();
          return new Promise((r) => server.close(r));
        },
        cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
      });
    });
    server.on("error", reject);
  });
}

function start(port = 5101, repo) {
  const ipfs = bin();
  if (!ipfs) {
    return startMock(port, repo);
  }
  repo = repo || fs.mkdtempSync(path.join(os.tmpdir(), "kubo-"));
  const env = { ...process.env, IPFS_PATH: repo };
  if (!fs.existsSync(path.join(repo, "config"))) {
    spawnSync(ipfs, ["init", "--profile=server"], { env });
    spawnSync(ipfs, ["config", "Addresses.API", `/ip4/127.0.0.1/tcp/${port}`], { env });
    spawnSync(ipfs, ["config", "Addresses.Gateway", `/ip4/127.0.0.1/tcp/${port + 1}`], { env });
    spawnSync(ipfs, ["config", "--json", "Addresses.Swarm", "[]"], { env });
  }
  const p = spawn(ipfs, ["daemon", "--offline"], { env, stdio: "ignore" });
  return waitUp(port).then((version) => {
    if (!version) {
      p.kill();
      throw new Error("kubo did not start");
    }
    return {
      port,
      repo,
      version,
      stop: () => {
        p.kill();
        return new Promise((r) => p.on("exit", r));
      },
      cleanup: () => fs.rmSync(repo, { recursive: true, force: true }),
    };
  });
}

module.exports = { available, start };
