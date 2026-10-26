// backend/src/utils/password.js — password policy for accounts created through the API.
const COMMON = new Set(["password1234", "123456789012", "qwertyuiop12", "administrator", "letmein123456", "welcome12345", "iloveyou1234", "passw0rd1234", "changeme1234"]);
function check(pw, { email = "", name = "" } = {}) {
  if (typeof pw !== "string") return "must be a string";
  if (pw.length < 12) return "must be at least 12 characters";
  if (pw.length > 200) return "must be at most 200 characters";
  if (new Set(pw).size < 5) return "is too repetitive";
  if (COMMON.has(pw.toLowerCase())) return "is too common";
  const local = String(email).split("@")[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return "must not contain your email name";
  const first = String(name).split(/\s+/)[0].toLowerCase();
  if (first.length >= 4 && pw.toLowerCase().includes(first)) return "must not contain your name";
  return null;
}
module.exports = { check };
