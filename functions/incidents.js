// Near-Miss & Incident Reports (Chris, 10-21-2026). No database code here, so it can be tested on its own.
// The app stores the fields OSHA Forms 300 / 301 ask for so they can be exported later — it does not by itself make
// the company OSHA-compliant, and it gives no legal advice.
//
//   incidents/{auto}            type, occurredAt ("YYYY-MM-DDTHH:MM", plant time), place { lineId, stationId, label },
//                               what, immediate, photoPaths, witnesses, anonymous, createdBy (none when anonymous),
//                               status, whys [5], rootCause, actionCount/openActions, closed {…}, sharedAnnId
//   incidents/{id}/private/osha the injured person and OSHA 300/301 details (Training & Safety, Production Manager, Admin)
//   incidents/{id}/private/signatures  names + times; the drawn signatures themselves are files (below)
//
// Files (photos and signatures) live in the PRIVATE storage folder safety/{incidentId}/… — readable only by Training &
// Safety, Production Manager, Admin (storage rules), served through the server, never as shareable links. The phone uploads
// a photo to safety/incoming/{random id} (no employee number anywhere — anonymous stays anonymous); the server moves it.
//   incidentActions/{auto}      incidentId, text, ownerEmp, ownerName, due ("YYYY-MM-DD"), done {…} — the owner sees
//                               their own (no names or medical details in the text)
//   Test site: test_ copies.
//
// Who sees reports: Training & Safety, Production Manager, Admin (database rules); the reporter sees their own status.

const TYPES = {
  "near-miss": { label: "Near miss", icon: "⚠" },
  "first-aid": { label: "First aid", icon: "🩹" },
  injury: { label: "Injury", icon: "🚑" },
  property: { label: "Property damage", icon: "🏚" },
  spill: { label: "Spill / environmental", icon: "🛢" },
};
const STATUSES = {
  reported: "🆕 Reported", investigating: "🔍 Investigating", actions: "🛠 Actions open", closed: "✓ Closed",
};
const FOLLOW_ROLES = ["training-safety", "plant-manager", "admin"];
const NOTIFY_ROLES = ["training-safety", "plant-manager", "supervisor"];
const TREATMENTS = ["first-aid-only", "medical-treatment", "emergency-room", "hospitalized-overnight"];
const OUTCOMES = ["death", "days-away", "restricted", "other-recordable", "not-recordable"];

const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
const line = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const canFollow = (roles) => (roles || []).some((r) => FOLLOW_ROLES.includes(r));
const isDateTime = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(v);
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// A photo the phone uploaded to safety/incoming/: a random id (20–40 letters/digits) + .jpg — nothing else.
const isUploadId = (v) => typeof v === "string" && /^[A-Za-z0-9]{20,40}\.jpg$/.test(v);

// A new report. lineIds / stationIds: what exists. photos: upload ids. nowIso: plant "YYYY-MM-DDTHH:MM".
function cleanReport(raw, { lineIds = [], stationIds = [], nowIso = "9999" } = {}) {
  const type = Object.prototype.hasOwnProperty.call(TYPES, raw?.type) ? raw.type : null;
  if (!type) return { error: "Pick what kind of report it is." };
  if (!isDateTime(raw?.occurredAt)) return { error: "When did it happen?" };
  if (raw.occurredAt > nowIso) return { error: "That time is in the future." };
  const lineId = lineIds.includes(raw?.place?.lineId) ? raw.place.lineId : null;
  const stationId = stationIds.includes(raw?.place?.stationId) ? raw.place.stationId : null;
  const label = line(raw?.place?.label, 80);
  if (!lineId && !stationId && !label) return { error: "Where did it happen? Pick a line or station, or type the spot." };
  const what = clean(raw?.what, 2000);
  if (what.length < 5) return { error: "Say what happened (a few words is fine)." };
  const immediate = clean(raw?.immediate, 1000);
  const photos = Array.isArray(raw?.photos) ? raw.photos.slice(0, 6).map(String) : [];
  if (photos.some((u) => !isUploadId(u))) return { error: "A photo didn't upload. Add it again." };
  const witnesses = line(raw?.witnesses, 300);
  const anonymous = type === "near-miss" && raw?.anonymous === true; // only near misses can be anonymous
  // Injury / first aid: who was hurt and where on the body (the rest is filled in at follow-up).
  const hurt = ["injury", "first-aid"].includes(type) ? { name: line(raw?.hurt?.name, 80), bodyPart: line(raw?.hurt?.bodyPart, 80) } : null;
  if (hurt && !hurt.name) return { error: "Who was hurt?" };
  return { report: { type, occurredAt: raw.occurredAt, place: { lineId, stationId, label }, what, immediate, photos, witnesses, anonymous }, hurt };
}

// Signatures (injury and first aid, Chris 10-21-2026): the Supervisor and every witness sign with a finger.
// { name, png } — png is the drawn signature as a PNG data URL (kept small). Returns { sig } or { error }.
const SIG_TYPES = ["injury", "first-aid"];
const MAX_WITNESSES = 6;
function cleanSignature(raw, who = "The signer") {
  const name = line(raw?.name, 80);
  if (!name) return { error: `${who}: print the name.` };
  const png = typeof raw?.png === "string" ? raw.png : "";
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(png) || png.length < 200) return { error: `${who}: sign in the box.` };
  if (png.length > 300000) return { error: `${who}: the signature is too large — clear it and sign again.` };
  return { sig: { name, png } };
}

// Signatures sent with a report: { supervisor?, witnesses[] } — any can be added later too.
function cleanSignatures(raw) {
  const out = { supervisor: null, witnesses: [] };
  if (raw?.supervisor) {
    const s = cleanSignature(raw.supervisor, "Supervisor");
    if (s.error) return { error: s.error };
    out.supervisor = s.sig;
  }
  const w = Array.isArray(raw?.witnesses) ? raw.witnesses : [];
  if (w.length > MAX_WITNESSES) return { error: `Up to ${MAX_WITNESSES} witnesses.` };
  for (const [n, x] of w.entries()) {
    const s = cleanSignature(x, `Witness ${n + 1}`);
    if (s.error) return { error: s.error };
    out.witnesses.push(s.sig);
  }
  return { signatures: out };
}

// 5 Whys + root cause (follow-up).
function cleanWhys(raw) {
  const whys = Array.from({ length: 5 }, (_, i) => clean(raw?.whys?.[i], 500));
  const rootCause = clean(raw?.rootCause, 1000);
  return { whys, rootCause };
}

// One corrective action. owners: [{ id, name, active }].
function cleanAction(raw, owners) {
  const text = line(raw?.text, 300);
  if (!text) return { error: "Say what will be done." };
  const owner = owners.find((o) => o.id === raw?.ownerEmp && o.active !== false);
  if (!owner) return { error: "Pick who owns this action." };
  if (!isDay(raw?.due)) return { error: "Pick a due date." };
  return { action: { text, ownerEmp: owner.id, ownerName: owner.name, due: raw.due } };
}

// The injury record (follow-up, injury and first aid) — ONLY these, in plain words (Chris, 10-21-2026). No medical
// documents in the app: doctor's notes, diagnoses, and claim forms go to HR. Any other field sent is dropped.
// Stored apart from the report, readable only by Training & Safety, Production Manager, Admin.
const INJURY_FIELDS = ["injuredName", "injuryType", "bodyPart", "firstAidGiven", "wentToDoctor"];
function cleanOsha(raw) {
  const doc = raw?.wentToDoctor;
  const out = {
    injuredName: line(raw?.injuredName, 80), injuryType: line(raw?.injuryType, 80), bodyPart: line(raw?.bodyPart, 80),
    firstAidGiven: line(raw?.firstAidGiven, 200), wentToDoctor: doc === "yes" || doc === "no" ? doc : "",
  };
  return { osha: out };
}

// Records rule (Chris, 10-21-2026): injury and first-aid reports are kept 5 years — nothing in the app deletes them
// (no trash, no purge). The year runs from when the report was closed (or made, if still open).
const RETAIN_YEARS = 5;
function keepUntilMs(inc) {
  const from = inc?.closedAtMs || inc?.createdAtMs || Date.now();
  const d = new Date(from);
  d.setFullYear(d.getFullYear() + RETAIN_YEARS);
  return d.getTime();
}

// Status after a change: closed stays closed; otherwise open actions → "actions", investigating once whys or
// actions exist, else reported.
function nextStatus(cur, { openActions, started }) {
  if (cur === "closed") return "closed";
  if (openActions > 0) return "actions";
  return started || cur === "investigating" || cur === "actions" ? "investigating" : "reported";
}

// Plant time "YYYY-MM-DDTHH:MM" now.
function plantNowIso(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

module.exports = { INJURY_FIELDS, RETAIN_YEARS, keepUntilMs, isUploadId, SIG_TYPES, MAX_WITNESSES, cleanSignature, cleanSignatures, TYPES, STATUSES, FOLLOW_ROLES, NOTIFY_ROLES, TREATMENTS, OUTCOMES, canFollow, cleanReport, cleanWhys, cleanAction, cleanOsha, nextStatus, plantNowIso };
