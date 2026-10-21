// Who to Call (Chris, 10-21-2026) — the posted call sheet, in the app. The numbers live only in the database
// (meta/callSheet), never in this repo. No database code here, so it can be tested on its own.
//
//   meta/callSheet   mainNumber, entries [{ id, ext, title, kind ("safety" | "maintenance" | "production" | "other"),
//                    lines [text] }], onCall [{ id, name, role, shift, number, agreed: true }]
//   callTaps/{auto}  ext, kind, lineId, at, atMs, by, byName — a tap on a call button (the phone can't tell us the
//                    call went through). Test site: test_callTaps.
//
// Line-down reminder: a line down for an hour with no tap on the Maintenance call button since it went down.

const KINDS = ["safety", "maintenance", "production", "other"];
const REMIND_MS = 60 * 60000;

const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const digits = (v) => String(v || "").replace(/\D/g, "");
const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);

// A US phone number: 10 digits (or 11 starting with 1).
function phoneOk(v) {
  const d = digits(v);
  return d.length === 10 || (d.length === 11 && d[0] === "1");
}

// tel: link that dials the number, waits, then the extension: tel:+13195550100,4 (555 = made-up example)
function telLink(number, ext = "") {
  let d = digits(number);
  if (d.length === 10) d = `1${d}`;
  return `tel:+${d}${digits(ext) ? `,${digits(ext)}` : ""}`;
}

function cleanSheet(raw) {
  const mainNumber = clean(raw?.mainNumber, 20);
  if (!phoneOk(mainNumber)) return { error: "The main number must be a 10-digit phone number." };
  if (!Array.isArray(raw?.entries) || raw.entries.length > 20) return { error: "Up to 20 extensions." };
  const entries = [];
  for (const e of raw.entries) {
    const title = clean(e?.title, 40);
    const ext = digits(e?.ext).slice(0, 6);
    if (!title) return { error: "Every extension needs a name (e.g. Safety)." };
    if (!ext) return { error: `${title}: add the extension number.` };
    const lines = (Array.isArray(e?.lines) ? e.lines : []).map((l) => clean(l, 300)).filter(Boolean).slice(0, 10);
    entries.push({ id: isId(e?.id) ? e.id : newId(), ext, title, kind: KINDS.includes(e?.kind) ? e.kind : "other", lines });
  }
  if (!Array.isArray(raw?.onCall ?? []) || (raw?.onCall || []).length > 50) return { error: "Up to 50 on-call contacts." };
  const onCall = [];
  for (const c of raw?.onCall || []) {
    const name = clean(c?.name, 60);
    if (!name) return { error: "Every on-call contact needs a name." };
    if (!phoneOk(c?.number)) return { error: `${name}: the number must be a 10-digit phone number.` };
    if (c?.agreed !== true) return { error: `${name}: only add people who agreed to have their number shown.` };
    onCall.push({ id: isId(c?.id) ? c.id : newId(), name, role: clean(c?.role, 40), shift: clean(c?.shift, 30), number: clean(c?.number, 20), agreed: true });
  }
  return { sheet: { mainNumber, entries, onCall } };
}

// Lines that need the "call Maintenance" reminder: down for an hour or more, and no Maintenance call tap for that
// line (or with no line) since it went down. down: { [lineId]: { since } }; taps: [{ kind, lineId, atMs }].
function linesToRemind(down, taps, nowMs) {
  return Object.entries(down || {})
    .filter(([, d]) => d?.since && nowMs - d.since >= REMIND_MS)
    .filter(([lineId, d]) => !(taps || []).some((t) => t.kind === "maintenance" && t.atMs >= d.since && (!t.lineId || t.lineId === lineId)))
    .map(([lineId, d]) => ({ lineId, since: d.since }));
}

module.exports = { KINDS, REMIND_MS, phoneOk, telLink, cleanSheet, linesToRemind };
