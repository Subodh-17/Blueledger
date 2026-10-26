// backend/src/services/mailer.js — outgoing mail. Transports: "outbox" (development/test: stored in mail_outbox, never sent),
// "smtp" (nodemailer using SMTP_URL). Message bodies containing reset links are never logged.
const db = require("../db");
const cfg = require("../config");

async function send({ to, subject, body }) {
  if (cfg.mail.transport === "smtp") {
    if (!cfg.mail.smtpUrl) throw new Error("SMTP_URL is not configured");
    const t = require("nodemailer").createTransport(cfg.mail.smtpUrl);
    await t.sendMail({ from: cfg.mail.from, to, subject, text: body });
    return { transport: "smtp" };
  }
  if (cfg.isProd) throw new Error("The outbox mail transport is not allowed in production");
  await db.query("INSERT INTO mail_outbox (to_email, subject, body, transport) VALUES ($1,$2,$3,'outbox')", [to, subject, body]);
  return { transport: "outbox" };
}
module.exports = { send };
