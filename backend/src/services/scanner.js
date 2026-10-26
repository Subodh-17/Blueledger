// backend/src/services/scanner.js — malware scanning through a ClamAV daemon (clamd INSTREAM protocol).
// Policy (MALWARE_SCAN): off = never scan; optional = scan when the scanner is reachable (files stored as SCAN_UNAVAILABLE otherwise);
// required = refuse uploads while the scanner is unavailable. Infected files are always refused. A file is only ever described as
// scanned/clean when the scanner actually returned OK for its exact bytes.
const net = require("net");
const cfg = require("../config").scan;

function command(buf, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: cfg.host, port: cfg.port });
    const chunks = []; let done = false;
    const fin = (e, v) => { if (done) return; done = true; sock.destroy(); e ? reject(e) : resolve(v); };
    sock.setTimeout(cfg.timeoutMs, () => fin(Object.assign(new Error("scanner timed out"), { code: "ETIMEDOUT" })));
    sock.on("error", (e) => fin(e));
    sock.on("data", (d) => chunks.push(d));
    sock.on("end", () => fin(null, Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim()));
    sock.on("connect", () => {
      if (!chunked) return sock.write(buf);
      sock.write("zINSTREAM\0");
      for (let i = 0; i < buf.length; i += 65536) { const part = buf.subarray(i, Math.min(buf.length, i + 65536)); const len = Buffer.alloc(4); len.writeUInt32BE(part.length); sock.write(Buffer.concat([len, part])); }
      sock.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
    });
  });
}

/** @returns {{status:'CLEAN'|'INFECTED'|'SCAN_UNAVAILABLE'|'SCAN_ERROR'|'NOT_SCANNED', engine?, signature?, detail?}} */
async function scan(buffer) {
  if (cfg.policy === "off") return { status: "NOT_SCANNED" };
  try {
    const version = await command("zVERSION\0");
    const reply = await command(buffer, { chunked: true });
    if (/: OK$/.test(reply)) return { status: "CLEAN", engine: version };
    const m = reply.match(/^stream: (.+) FOUND$/);
    if (m) return { status: "INFECTED", engine: version, signature: m[1] };
    return { status: "SCAN_ERROR", engine: version, detail: reply.slice(0, 200) };
  } catch (e) { return { status: "SCAN_UNAVAILABLE", detail: e.code || e.message }; }
}
async function health() {
  if (cfg.policy === "off") return { policy: cfg.policy, configured: false, reachable: null };
  try { const pong = await command("zPING\0"); return { policy: cfg.policy, configured: true, reachable: pong === "PONG", engine: pong === "PONG" ? await command("zVERSION\0") : null }; }
  catch (e) { return { policy: cfg.policy, configured: true, reachable: false, error: e.code || e.message }; }
}
module.exports = { scan, health, policy: () => cfg.policy };
