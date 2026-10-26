// The sign-off rule, app-wide (Chris, 10-26-2026, Decision 108 item 10). Every sign-off or acknowledgment saves the
// name, employee #, date and time, and the exact version of what was signed. Where the thing signed has its own revision
// (a form's rev, an announcement's version, a checklist template's rev) that number is the version; where it doesn't,
// the version is a fingerprint of exactly what was signed ("c-" + 16 hex), so a later edit can't pass for what was
// signed. No database code here, so it can be tested alone.
//
//   signoffs/{auto}   kind, refId, version, emp, name, at (server time), method ("pin" | "drawn" | "in-person" | "app"),
//                     device?, signedOn?, signedAtMs? (offline), …kind-specific fields. Test site: test_signoffs.

const crypto = require("node:crypto");

// Same value, same order of keys → same text (so the fingerprint doesn't depend on key order).
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, stable(v[k])]));
  }
  return v instanceof Date ? v.toISOString() : v;
}

// A fingerprint of exactly what was signed.
const contentVersion = (obj) => `c-${crypto.createHash("sha256").update(JSON.stringify(stable(obj ?? null))).digest("hex").slice(0, 16)}`;

// What every entry in the sign-off log must have. → "" or what's missing.
function missing(entry) {
  const gaps = ["kind", "refId", "emp", "name", "version"].filter((k) => entry?.[k] === undefined || entry?.[k] === null || entry?.[k] === "");
  return gaps.length ? `Sign-off log entry (${entry?.kind || "?"}) is missing ${gaps.join(", ")}.` : "";
}

module.exports = { stable, contentVersion, missing };
