// Training (the training team's trainer app, moved into CDG Ops) — rules and checks. No database code here,
// so it can be tested on its own.
//
// Company content (roster, levels, safety records, SOP and trainer-guide text) lives only in the database,
// never in this repo. Trainer PINs are stored only as hashes (same scrambling as login PINs, see pin.js).

const crypto = require("node:crypto");

const TZ = "America/Chicago";
const SCALE = ["Not Trained", "Trained / Aware", "Assisted", "Independent", "Qualified to Train"];
// Yearly refreshers (Refresher Log). ld08 is for leads only.
const REFRESHERS = ["loto", "eap", "ppe", "c10", "qc", "ld08"];
const LD01_MIN_LEVEL = 3; // a trainer needs LD-01 at this level before they may sign anyone off
const SESSION_IDLE_MS = 15 * 60000; // the tablet locks after 2 idle minutes; the server gives a little slack
const SESSION_MAX_MS = 12 * 3600000;
const MAX_SIG_BYTES = 300000;

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => typeof v === "string" && v.length <= max;
const isCode = (v) => typeof v === "string" && /^[A-Z]{1,3}-\d{1,3}[a-z]?$/.test(v); // e.g. C-01, LD-08, L-03a
const isIso = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTrainerId = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(v);
const isPin = (v) => typeof v === "string" && /^\d{4}$/.test(v);
const isSigId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/.test(v);

function todayIso(now = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(now));
}
// "Oct 19, 2026" — how the old app wrote sign-off dates.
function fmtDate(now = Date.now()) {
  return new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: TZ });
}
function addYear(iso) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

// Database id for a trainee (the roster is keyed by name, like the workbook).
function personId(name) {
  const n = String(name).trim();
  const slug = n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";
  return `p-${slug}-${crypto.createHash("sha1").update(n.toLowerCase()).digest("hex").slice(0, 6)}`;
}
function cleanName(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length < 60 ? s : null;
}

// Signature pictures are stored once each, named by their content.
function sigId(dataUrl) {
  return crypto.createHash("sha256").update(dataUrl).digest("hex").slice(0, 24);
}
function isSigImage(v) {
  return typeof v === "string" && v.length <= MAX_SIG_BYTES && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(v);
}

// --- Reference data (the original app's cdg-data.js) -----------------------------------------------------

// Checks CDG_DATA / CDG_LIB from the original app. Returns { data, lib } with the workbook Trainers tab's
// PIN column removed (PINs never go in the database in plain text), or { error } in plain English.
function cleanReference(data, lib) {
  if (!isObj(data) || !Array.isArray(data.modules) || !isObj(data.reqMin) || !Array.isArray(data.roster)) {
    return { error: "That isn't the training app's data (CDG_DATA was not found)." };
  }
  if (!data.modules.length || data.modules.length > 300 || !data.modules.every((m) => isCode(m?.code) && str(m.title, 300) && str(m.series, 80))) {
    return { error: "The module list in the file doesn't look right." };
  }
  if (data.roster.length > 1000 || !data.roster.every((r) => isObj(r) && str(r.name, 200))) return { error: "The roster in the file doesn't look right." };
  if (!isObj(lib) || !isObj(lib.guides) || !isObj(lib.sops) || !isObj(lib.moduleSops)) {
    return { error: "That isn't the training app's data (CDG_LIB was not found)." };
  }
  const cleanData = { ...data, trainerInfo: (data.trainerInfo || []).map(stripPin) };
  delete cleanData.cnum;
  return { data: cleanData, lib };
}
function stripPin(t) {
  if (!isObj(t)) return t;
  const { pin, ...rest } = t; // eslint-disable-line no-unused-vars
  return { ...rest, fields: (rest.fields || []).filter((f) => !/pin/i.test(String(f?.k || ""))) };
}

// Splits CDG_LIB into pieces that each fit in one database document (1 MB). Stored as text because the
// database can't hold a list inside a list (SOP tables are lists of rows).
function libPieces(lib) {
  const { guides, sops, kc, ...rest } = lib;
  return { "lib-guides": guides || {}, "lib-sops": sops || {}, "lib-kc": kc || {}, "lib-rest": rest };
}

// --- Levels, refreshers, and who may sign -----------------------------------------------------------------

// Records for a trainee who has no records in the app yet: one 'imported' entry per workbook level.
function seedRecords(levels) {
  return Object.fromEntries(Object.entries(levels || {}).filter(([c]) => isCode(c)).map(([c, l]) => [c,
    Array.from({ length: Math.max(0, Math.min(4, Number(l) || 0)) }, (_, i) => ({ level: i + 1, trainer: 'Workbook', date: 'Imported from CDGTRN0009', imported: true }))]));
}
// Level a trainee has on a module = how many levels are signed (or imported from the workbook).
function levelOf(records, code) {
  return ((records || {})[code] || []).length;
}

// Any yearly refresher overdue? (Same rule as the old app: due a year after it was last done.)
function refreshersOverdue(position, base, overrides, today) {
  const lead = /Lead/.test(position || "");
  return REFRESHERS.filter((k) => k !== "ld08" || lead).filter((k) => {
    const last = (overrides || {})[k] || (base || {})[k];
    return last && addYear(last) < today;
  });
}

// Can this trainer sign levels for this trainee? { ok } or { ok: false, msg } — same wording as the tablet.
function gate({ trainer, traineeName, overdue, trainerLd01 }) {
  if (overdue.length) return { ok: false, msg: "Refresher overdue: no level advances until it’s current" };
  if (trainer.coordinator) return { ok: true };
  if (trainer.employee && trainer.employee === traineeName) return { ok: false, msg: "No one may sign off their own competency" };
  if (!trainer.employee) return { ok: false, msg: "Link your roster record: LD-01 required to sign" };
  if (trainerLd01 < LD01_MIN_LEVEL) return { ok: false, msg: `Your LD-01 is Level ${trainerLd01}; Level ${LD01_MIN_LEVEL} required to sign` };
  return { ok: true };
}

// New records list after signing `level` (lower unsigned levels are filled in with the same signature).
function signedRecords(list, level, entry) {
  const a = list || [];
  const fill = Array.from({ length: Math.max(0, level - 1 - a.length) }, (_, i) => ({ ...entry, level: a.length + i + 1, filled: level }));
  return [...a.slice(0, level - 1), ...fill, { ...entry, level }];
}

// Workbook (CDGTRN0009) data pulled on a tablet. Keeps only the fields the app uses; PINs are dropped.
function cleanWorkbook(wb) {
  if (!isObj(wb) || !Array.isArray(wb.roster) || !isObj(wb.levels)) return null;
  if (JSON.stringify(wb).length > 900000) return null;
  const roster = wb.roster.filter((r) => isObj(r) && cleanName(r.name)).map((r) => Object.fromEntries(
    ["name", "id", "team", "shift", "hire", "track", "position", "inPosition", "needs", "basis", "baseline", "card", "target", "trainer", "status", "notes"]
      .map((k) => [k, r[k] == null ? null : String(r[k]).slice(0, 500)])));
  const numMap = (o) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([c, v]) => isCode(c) && Number.isFinite(+v)).map(([c, v]) => [c, Math.max(0, Math.min(4, Math.round(+v)))]));
  const byName = (o, fn) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([n]) => cleanName(n)).map(([n, v]) => [n, fn(v)]));
  return {
    roster,
    levels: byName(wb.levels, numMap),
    extra: byName(wb.extra, numMap),
    safety: byName(wb.safety, (v) => (isObj(v) ? Object.fromEntries(["date", "by", "topics", "acks", "verified"].map((k) => [k, v[k] == null ? "" : String(v[k]).slice(0, 100)])) : null)),
    refreshers: byName(wb.refreshers, (v) => Object.fromEntries(Object.entries(isObj(v) ? v : {}).filter(([k, d]) => REFRESHERS.includes(k) && isIso(d)))),
    trainerInfo: Array.isArray(wb.trainers) ? wb.trainers.slice(0, 200).map(stripPin) : null,
    oldNums: typeof wb.oldNums === "boolean" ? wb.oldNums : null,
  };
}

// --- The old tablet's backup file (cdg-training-backup.json) ---------------------------------------------

const PERSON_FIELDS = ["records", "checks", "kcAns", "kcAtt", "extra", "refresh", "orient", "posOv"];

// Splits the old tablet's saved state (localStorage "cdg-tablet-v1") into the app's records:
// { trainers, people: { name: {records, …} }, sigs: { id: png }, todos, queue, wbConfig } or { error }.
// Signature pictures are moved out of the records into `sigs` (records keep sigId / csigId).
function splitBackup(backup) {
  const saved = backup?.tablet;
  if (!isObj(saved) || !isObj(saved.records) || !Array.isArray(saved.trainers)) {
    return { error: "That isn't a backup from the old training app (cdg-training-backup.json)." };
  }
  const sigs = {};
  const keepSig = (png) => {
    if (!isSigImage(png)) return null;
    const id = sigId(png);
    sigs[id] = png;
    return id;
  };
  const people = {};
  const put = (name, field, value) => {
    const n = cleanName(name);
    if (!n || value == null) return;
    (people[n] ||= {})[field] = value;
  };
  for (const [name, mods] of Object.entries(saved.records)) {
    if (!isObj(mods)) continue;
    const out = {};
    for (const [code, list] of Object.entries(mods)) {
      if (!isCode(code) || !Array.isArray(list)) continue;
      out[code] = list.filter(isObj).slice(0, 4).map((r) => {
        const { sig, csig, initials, ...rest } = r; // eslint-disable-line no-unused-vars
        const s = keepSig(sig), c = keepSig(csig);
        return { ...rest, ...(s ? { sigId: s } : {}), ...(c ? { csigId: c } : {}) };
      });
    }
    put(name, "records", out);
  }
  for (const f of ["checks", "kcAns", "kcAtt", "extra", "refresh", "orient", "posOv"]) {
    for (const [name, v] of Object.entries(isObj(saved[f]) ? saved[f] : {})) put(name, f, v);
  }
  const trainers = saved.trainers.filter((t) => isObj(t) && isTrainerId(t.id) && cleanName(t.name)).map((t) => ({
    id: t.id,
    name: cleanName(t.name),
    role: cleanName(t.role) || "Trainer",
    // The old app made its first profile (id "jul") the Training & Safety Coordinator.
    coordinator: t.coordinator === true || t.id === "jul",
    employee: cleanName(t.employee) || null,
    info: Array.isArray(t.info) ? stripPin({ fields: t.info }).fields : null,
    pin: isPin(t.pin) ? t.pin : null,
  }));
  const queue = (Array.isArray(backup.queue) ? backup.queue : []).filter((j) => isObj(j) && str(j.t, 20) && j.t !== "trainer" && j.t !== "trainerAdd").slice(0, 2000)
    .map((j) => { const { pin, ...rest } = j; return rest; }); // eslint-disable-line no-unused-vars
  const cfg = isObj(backup.wbConfig) ? backup.wbConfig : {};
  return {
    trainers,
    people,
    sigs,
    todos: (Array.isArray(saved.todos) ? saved.todos : []).filter(isObj).slice(0, 500),
    queue,
    wbData: isObj(saved.wbData) ? saved.wbData : null,
    shared: { fileDirty: Number(saved.fileDirty) || 0, lastSaved: saved.lastSaved || null, lastLoaded: saved.lastLoaded || null, wbOld: typeof saved.wbOld === "boolean" ? saved.wbOld : null },
    wbConfig: { clientId: str(cfg.clientId, 100) ? cfg.clientId : "", tenantId: str(cfg.tenantId, 100) ? cfg.tenantId : "", link: str(cfg.link, 2000) ? cfg.link : "" },
  };
}

// One trainee's records from the backup, checked before saving.
function cleanPerson(p) {
  if (!isObj(p)) return null;
  const out = {};
  for (const f of PERSON_FIELDS) if (isObj(p[f])) out[f] = p[f];
  if (JSON.stringify(out).length > 700000) return null;
  for (const list of Object.values(out.records || {})) {
    if (!Array.isArray(list) || list.some((r) => !isObj(r) || r.sig || r.csig)) return null;
  }
  return out;
}

// Counts shown before an import is saved, so they can be checked against the old tablet.
function backupCounts(split) {
  const people = Object.values(split.people);
  const signOffs = people.reduce((a, p) => a + Object.values(p.records || {}).reduce((b, l) => b + l.filter((r) => !r.imported).length, 0), 0);
  return {
    trainers: split.trainers.length,
    trainersWithPin: split.trainers.filter((t) => t.pin).length,
    people: people.length,
    signOffs,
    signatures: Object.keys(split.sigs).length,
    knowledgeChecks: people.reduce((a, p) => a + Object.values(p.kcAtt || {}).reduce((b, l) => b + (Array.isArray(l) ? l.length : 0), 0), 0),
    todos: split.todos.length,
    unsentWorkbookChanges: split.queue.length,
  };
}

// Workbook queue entries the app writes (same shapes the old tablet sent to Microsoft).
function workbookJob(op) {
  switch (op.op) {
    case "sign": return { t: "level", name: op.name, code: op.code, level: op.level };
    case "revoke": return { t: "level", name: op.name, code: op.code, level: op.level - 1 };
    case "extra": return { t: "extra", name: op.name, code: op.code, level: op.level || "" };
    case "position": return { t: "position", name: op.name, position: op.to, date: op.date };
    case "refresher": return { t: "refresher", name: op.name, key: op.key, date: op.date };
    case "orient": return { t: "orient", name: op.name, date: op.date, by: op.by, verified: op.verified };
    case "orientVerify": return { t: "orientVerify", name: op.name };
    default: return null;
  }
}

module.exports = {
  SCALE, REFRESHERS, LD01_MIN_LEVEL, SESSION_IDLE_MS, SESSION_MAX_MS,
  isObj, isCode, isIso, isTrainerId, isPin, isSigId, isSigImage,
  todayIso, fmtDate, addYear, personId, cleanName, sigId,
  cleanReference, stripPin, libPieces,
  seedRecords, levelOf, refreshersOverdue, gate, signedRecords, cleanWorkbook,
  splitBackup, cleanPerson, backupCounts, workbookJob,
};
