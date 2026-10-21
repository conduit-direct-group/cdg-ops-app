// Near-Miss & Incident Reports (Chris, 10-21-2026). No database code here, so it can be tested on its own.
// The app stores the fields OSHA Forms 300 / 301 ask for so they can be exported later — it does not by itself make
// the company OSHA-compliant, and it gives no legal advice.
//
//   incidents/{auto}            type, occurredAt ("YYYY-MM-DDTHH:MM", plant time), place { lineId, stationId, label },
//                               what, immediate, photos, witnesses, anonymous, createdBy (none when anonymous),
//                               status, whys [5], rootCause, actionCount/openActions, closed {…}, sharedAnnId
//   incidents/{id}/private/osha the injured person and OSHA 300/301 details (Training & Safety, Plant Manager, Admin)
//   incidentActions/{auto}      incidentId, text, ownerEmp, ownerName, due ("YYYY-MM-DD"), done {…} — the owner sees
//                               their own (no names or medical details in the text)
//   Test site: test_ copies.
//
// Who sees reports: Training & Safety, Plant Manager, Admin (database rules); the reporter sees their own status.

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

// A new report. lineIds / stationIds: what exists. isOurFile(url) for photos. nowIso: plant "YYYY-MM-DDTHH:MM".
function cleanReport(raw, { lineIds = [], stationIds = [], isOurFile = () => false, nowIso = "9999" } = {}) {
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
  if (photos.some((u) => !isOurFile(u))) return { error: "A photo didn't upload. Add it again." };
  const witnesses = line(raw?.witnesses, 300);
  const anonymous = type === "near-miss" && raw?.anonymous === true; // only near misses can be anonymous
  // Injury / first aid: who was hurt and where on the body (the rest is filled in at follow-up).
  const hurt = ["injury", "first-aid"].includes(type) ? { name: line(raw?.hurt?.name, 80), bodyPart: line(raw?.hurt?.bodyPart, 80) } : null;
  if (hurt && !hurt.name) return { error: "Who was hurt?" };
  return { report: { type, occurredAt: raw.occurredAt, place: { lineId, stationId, label }, what, immediate, photos, witnesses, anonymous }, hurt };
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

// OSHA 300 / 301 details (follow-up, injury and first aid). Stored apart from the report, readable only by
// Training & Safety, Plant Manager, Admin.
function cleanOsha(raw) {
  const n = (v) => (v === "" || v == null ? null : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 999 ? Number(v) : NaN);
  const out = {
    injuredName: line(raw?.injuredName, 80), injuredEmp: line(raw?.injuredEmp, 10), jobTitle: line(raw?.jobTitle, 60),
    dateOfHire: isDay(raw?.dateOfHire) ? raw.dateOfHire : "", timeBeganWork: /^([01]\d|2[0-3]):[0-5]\d$/.test(raw?.timeBeganWork || "") ? raw.timeBeganWork : "",
    bodyPart: line(raw?.bodyPart, 80), nature: line(raw?.nature, 120), activity: clean(raw?.activity, 500),
    objectOrSubstance: line(raw?.objectOrSubstance, 200), treatment: TREATMENTS.includes(raw?.treatment) ? raw.treatment : "",
    physician: line(raw?.physician, 120), facility: line(raw?.facility, 160),
    outcome: OUTCOMES.includes(raw?.outcome) ? raw.outcome : "", daysAway: n(raw?.daysAway), daysRestricted: n(raw?.daysRestricted),
    dateOfDeath: isDay(raw?.dateOfDeath) ? raw.dateOfDeath : "", privacyCase: raw?.privacyCase === true,
  };
  if (Number.isNaN(out.daysAway) || Number.isNaN(out.daysRestricted)) return { error: "Days must be whole numbers." };
  return { osha: out };
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

module.exports = { TYPES, STATUSES, FOLLOW_ROLES, NOTIFY_ROLES, TREATMENTS, OUTCOMES, canFollow, cleanReport, cleanWhys, cleanAction, cleanOsha, nextStatus, plantNowIso };
