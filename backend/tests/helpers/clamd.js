// Starts a real ClamAV daemon (if installed) with a small local signature database so detection can be tested without downloading signatures.
// If clamd is not installed, runs an in-process protocol-compliant mock emulator.
// The signature matches the marker string "EICAR-STANDARD-ANTIVIRUS-TEST-FILE" anywhere in a file (harmless test marker).
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const MARKER = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE";

const hasBinary = () => {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    return spawnSync(cmd, ["clamd"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
};

const available = () => true; // Real binary or protocol-compliant mock emulator

async function waitPing(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const ok = await new Promise((r) => {
      const s = net.createConnection({ host: "127.0.0.1", port }, () => s.write("zPING\0"));
      let d = "";
      s.on("data", (x) => (d += x));
      s.on("end", () => r(d.includes("PONG")));
      s.on("error", () => r(false));
      s.setTimeout(1500, () => { s.destroy(); r(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function startMock(port = 33100) {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buffer = Buffer.alloc(0);
    let inStreamMode = false;
    const streamChunks = [];

    sock.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const str = buffer.toString("utf8");

      if (!inStreamMode) {
        if (str.includes("PING")) {
          sock.write("PONG\0");
          sock.end();
          return;
        }
        if (str.includes("VERSION")) {
          sock.write("ClamAV 1.0.0/26500/Sun Oct 26 2026\0");
          sock.end();
          return;
        }
        const instreamIdx = buffer.indexOf(Buffer.from("zINSTREAM\0"));
        if (instreamIdx !== -1) {
          inStreamMode = true;
          buffer = buffer.subarray(instreamIdx + 10);
        }
      }

      if (inStreamMode) {
        while (buffer.length >= 4) {
          const chunkLen = buffer.readUInt32BE(0);
          if (chunkLen === 0) {
            const fullContent = Buffer.concat(streamChunks);
            if (fullContent.includes(MARKER)) {
              sock.write("stream: Registry.Test.Marker FOUND\0");
            } else {
              sock.write("stream: OK\0");
            }
            sock.end();
            return;
          }
          if (buffer.length < 4 + chunkLen) {
            break;
          }
          streamChunks.push(buffer.subarray(4, 4 + chunkLen));
          buffer = buffer.subarray(4 + chunkLen);
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        marker: MARKER,
        stop: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
    server.on("error", reject);
  });
}

async function start(port = 33100) {
  if (!hasBinary()) {
    return startMock(port);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clamd-"));
  fs.mkdirSync(path.join(dir, "db"));
  fs.writeFileSync(path.join(dir, "db", "registry-test.ndb"), `Registry.Test.Marker:0:*:${Buffer.from(MARKER).toString("hex")}\n`);
  fs.writeFileSync(path.join(dir, "clamd.conf"), `DatabaseDirectory ${dir}/db\nTCPSocket ${port}\nTCPAddr 127.0.0.1\nForeground yes\nLogFile ${dir}/clamd.log\nStreamMaxLength 60M\nMaxFileSize 60M\nUser root\n`);
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(path.join(dir, "db"), 0o755);
  const p = spawn("clamd", ["-c", path.join(dir, "clamd.conf")], { stdio: "ignore" });
  if (!(await waitPing(port))) {
    p.kill();
    throw new Error("clamd did not start");
  }
  return {
    port,
    marker: MARKER,
    stop: () => {
      p.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { available, start, MARKER };
