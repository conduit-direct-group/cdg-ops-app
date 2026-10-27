// Offline sign-offs (Decision 83, launch list 6). A sign-off made on a phone or line tablet with no connection is
// saved on the device and sent when the connection is back; the PIN is checked then. No database code here, so it
// can be tested on its own.
//
//   outboxReceipts/{clientId}   result, atMs, signedAtMs — one per sent sign-off, so a sign-off sent twice (a reply
//                               lost on bad Wi-Fi, a retry) only counts once. Test site: test_outboxReceipts.
//   signoffs/{auto}             gains signedAtMs + offline: true — when it was really signed on the floor.

const MAX_AGE_MS = 72 * 3600000; // a sign-off sent more than 3 days later keeps only the time it arrived
const CLOCK_SLACK_MS = 5 * 60000; // device clocks can be a little ahead

// The device's id for one sign-off: letters, digits, - and _, 12–64 long.
const cleanClientId = (v) => (typeof v === "string" && /^[A-Za-z0-9_-]{12,64}$/.test(v) ? v : null);

// When it was signed on the device, if believable (not in the future, not older than 3 days); else null.
function cleanSignedAt(v, nowMs) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return null;
  if (n > nowMs + CLOCK_SLACK_MS || n < nowMs - MAX_AGE_MS) return null;
  return Math.round(Math.min(n, nowMs));
}

// Decision 120 (Chris, 10-27-2026): the device time is kept beside the server time, and flagged instead of dropped
// when it looks wrong — "device-ahead" (the phone or tablet clock is ahead of the server by more than 2 minutes) or
// "far-apart" (it reached the server more than 10 minutes after the device says it was done: offline a while, or a
// clock that is behind). → { deviceAtMs (the device time as sent, or null), clockFlag (null when fine) }.
const AHEAD_MS = 2 * 60000;
const FAR_MS = 10 * 60000;
function clockCheck(v, nowMs) {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isFinite(n)) return { deviceAtMs: null, clockFlag: null };
  const deviceAtMs = Math.round(n);
  const clockFlag = deviceAtMs > nowMs + AHEAD_MS ? "device-ahead" : nowMs - deviceAtMs > FAR_MS ? "far-apart" : null;
  return { deviceAtMs, clockFlag };
}

module.exports = { MAX_AGE_MS, AHEAD_MS, FAR_MS, cleanClientId, cleanSignedAt, clockCheck };
