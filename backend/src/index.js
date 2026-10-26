// backend/src/index.js — start the HTTP server, connect to the blockchain network and start the reconciler.
const cfg = require("./config");
const app = require("./app");
const chain = require("./services/chain");
const ops = require("./services/chainOps");
require("./services/chainHandlers");
const settings = require("./services/settings");
const ipfs = require("./services/ipfs");
const alerts = require("./services/alerts");
const metrics = require("./services/metrics");
const log = require("./utils/log");

(async () => {
  await settings.load().catch((e) => log.warn("settings not loaded", { error: e.message }));
  const st = await chain.init();
  const server = app.listen(cfg.port, () => {
    console.log(`\nBlue Carbon Registry listening on http://localhost:${cfg.port}`);
    console.log(`  Blockchain network: ${st.ready ? `connected (chain ${st.chainId}, contract ${st.contractAddress})` : `NOT CONNECTED (${st.error}). Chain-dependent actions are stored and retried automatically once it returns.`}`);
    if (!cfg.isProd) console.log("  Development configuration: records marked illustrative are not field-collected data.\n");
  });
  ops.startReconciler((s) => { metrics.noteReconcile(s); alerts.check().catch(() => {}); });
  if (cfg.reconcileIntervalMs > 0) setInterval(() => ipfs.processPending().catch(() => {}), cfg.reconcileIntervalMs).unref();
  if (st.ready) ops.reconcile({ minAgeMs: 0 }).then((s) => { if (s.examined) console.log("  Reconciled interrupted operations:", JSON.stringify(s)); }).catch(() => {});
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
})();
