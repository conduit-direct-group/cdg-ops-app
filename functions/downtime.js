// Downtime & Scrap shift report (Chris, 10-22-2026; replaces New_Downtime_Report and feeds his DownTime and Scrap
// workbook). Line Leads and Supervisors enter each event as it happens; the report is signed with a PIN at the end.
// No database code here, so it can be tested on its own.
//
//   shiftReports/{lineId__date__shiftId}   lineId, lineName, lineNumber, date (the day the shift started), shiftId,
//                  shiftName, team ("A"… — the rotation's, or on a day with none the team picked on Who's here today;
//                  older reports may say "Sat A"/"Sat B"), size, sdr, productSize,
//                  changeover (only on the first practice reports — changeovers are now their own entries), comments,
//                  signed { by, byName, atMs, device } | null
//   changeoverEvents/{auto} reportId + date, lineId, lineNumber, team, productSize, minutes, type, by, byName, atMs
//                  (as many per shift as needed — Chris, 10-22-2026)
//   downtimeEvents/{auto}   reportId + date, lineId, lineNumber, team, productSize, minutes, reason, called, calledWho,
//                  maintenance ("none" | "team" | "called"), issueId, issueTitle, fix (what was done), by, byName, atMs
//   scrapEntries/{auto}     reportId + date, lineId, lineNumber, team, productSize, feet, reason, notes, tag, by, atMs
//   Test site: test_ in front of each. Flagged reels decided Scrap or Regrind are read into the scrap list live
//   (never copied), so a reel is counted once.
//
// Workbook columns (data columns only — This Week? / Last 2 Weeks? are formulas and are never written):
//   Changeover Log  Date | Line # | Team | Product Size | Changeover Time (min) | Changeover Type
//   Downtime Log    Date | Line # | Team | Product Size | Minutes | Reason | Notes | Maintenance Log Completed? | Someone Contacted?
//   Scrap Log       Date | Line # | Team | Product Size | Scrap Feet | Reason | Notes

const CHANGEOVER_TYPES = ["Full", "Pin/Mandrel", "Color", "SDR"];
// Downtime reasons in groups (Decision 141, Chris 10-29-2026), shown on the screen this way. Planned shows on the report
// but isn't a breakdown; Not downtime is kept but left out of totals; only Unplanned counts as downtime. Picking
// Changeover saves a Changeover Log entry instead. "No reason given" is hidden (a reason is required); old rows keep it.
const REASON_GROUPS = [
  { id: "planned", name: "Planned", note: "shows on the report, not a breakdown", sets: [["", ["Scheduled Maintenance", "Controlled Shutdown", "Changeover", "Startup"]]] },
  { id: "not-downtime", name: "Not downtime", note: "kept on record, left out of totals", sets: [["", ["Printer only – line running"]]] },
  { id: "unplanned", name: "Unplanned", note: "real downtime", sets: [
    ["Equipment", ["Extruder", "Puller", "Winder", "Loader/Receiver", "Loss of Vacuum", "Electrical", "Air Pressure", "Water (temp/level)", "Heat / temperature"]],
    ["Material", ["Ran Out of Material", "Problems with Material"]],
    ["People", ["Operator", "Staffing"]],
    ["Other", ["Other", "Unknown"]],
  ] },
];
const DOWNTIME_REASONS = REASON_GROUPS.flatMap((g) => g.sets.flatMap(([, list]) => list));
const CHANGEOVER_REASON = "Changeover";
const REVIEW_REASON = "Unknown"; // flagged for the Supervisor to review
// Renamed 10-29-2026: old entries keep the old name and stay in the same group; still accepted when an old entry is edited.
const OLD_REASONS = { Water: "Water (temp/level)", Heat: "Heat / temperature", "No reason given": "Unknown" };
const WRITEUP_WORDS = 5; // "at least one full sentence"
// From the workbook's Lists tab (10-22-2026).
const SCRAP_REASONS = [
  "Startup/Purge", "Color Change", "Sizing Out of Spec", "Material Defect", "Operator Error", "Contamination",
  "Equipment Malfunction", "Changeover Waste", "Water Temp/Level Issue", "Other",
];
const ENTER_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const SIGN_ROLES = ["lead", "supervisor", "plant-manager"];
const MAINTENANCE = ["none", "team", "called"];
// Flagged reel reason → Scrap Log reason (Chris approved 10-22-2026); anything else is Other with the reel reason in Notes.
const REEL_TO_SCRAP = {
  "OD/wall out of spec": "Sizing Out of Spec",
  "Ovality": "Sizing Out of Spec",
  "Contamination": "Contamination",
  "Wind or tension problem": "Equipment Malfunction",
};

const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const longText = (v, max) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
const whole = (v, min, max) => {
  const n = Number(v);
  return v !== "" && v !== null && v !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : null;
};

const reportId = (lineId, date, shiftId) => `${lineId}__${date}__${shiftId}`;
const productSize = (size, sdr) => [clean(size, 30), clean(sdr, 20)].filter(Boolean).join(" ");
// "Line 2" → "2" (the workbook's Line # column); a name without a number is used as is.
const lineNumber = (name) => (String(name || "").match(/\d+/) || [String(name || "")])[0];
const canEnter = (roles) => (roles || []).some((r) => ENTER_ROLES.includes(r));
const canSign = (roles) => (roles || []).some((r) => SIGN_ROLES.includes(r));

// Product run: size + SDR from the QC hold lists (specialty sizes typed), saved as "1.25\" SDR 13.5".
function cleanProduct(raw) {
  const size = clean(raw?.size, 30);
  const sdr = clean(raw?.sdr, 20);
  if (!size) return { error: "Pick the size." };
  if (!sdr) return { error: "Pick the wall (SDR)." };
  return { size, sdr, productSize: productSize(size, sdr) };
}

function cleanChangeover(raw) {
  const minutes = whole(raw?.minutes, 1, 1440);
  if (minutes === null) return { error: "Changeover minutes: a whole number, 1–1440." };
  if (!CHANGEOVER_TYPES.includes(raw?.type)) return { error: "Pick the changeover type." };
  return { changeover: { minutes, type: raw.type } };
}

// Planned / Not downtime / Unplanned for a reason, old names included (anything else counts as Unplanned, to be safe).
function groupOf(reason) {
  const name = OLD_REASONS[reason] || reason;
  return (REASON_GROUPS.find((g) => g.sets.some(([, list]) => list.includes(name))) || REASON_GROUPS[2]).id;
}
const countsAsDowntime = (reason) => groupOf(reason) === "unplanned";
const needsReview = (reason) => reason === REVIEW_REASON;

// The "What happened" write-up: what went wrong and what was done to fix it, at least one full sentence.
const words = (text) => String(text || "").trim().split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
const writeupDone = (text) => words(text) >= WRITEUP_WORDS;

// prev = the entry being edited: an old entry keeps its old reason name ("Water", "Heat", "No reason given").
function cleanDowntime(raw, prev = null) {
  const minutes = whole(raw?.minutes, 1, 1440);
  if (minutes === null) return { error: "Minutes down: a whole number, 1–1440." };
  if (raw?.reason === CHANGEOVER_REASON) return { error: "A changeover is saved in the Changeover Log — add it there, with its type." };
  const keepsOld = !!prev && raw?.reason === prev.reason && Object.prototype.hasOwnProperty.call(OLD_REASONS, raw.reason);
  if (!DOWNTIME_REASONS.includes(raw?.reason) && !keepsOld) return { error: "Pick the reason." };
  const called = raw?.called === true;
  const calledWho = called ? clean(raw?.calledWho, 60) : "";
  if (called && !calledWho) return { error: "Say who was called." };
  const maintenance = MAINTENANCE.includes(raw?.maintenance) ? raw.maintenance : null;
  if (!maintenance) return { error: "Was maintenance needed? Pick No, Fixed by our team, or Maintenance called." };
  const issueId = maintenance === "called" && typeof raw?.issueId === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(raw.issueId) ? raw.issueId : null;
  const fix = longText(raw?.fix, 1000); // the "What happened" write-up (the field kept its old name)
  if (!writeupDone(fix)) return { error: `Write what happened — what went wrong and what was done to fix it, in at least one full sentence (${WRITEUP_WORDS}+ words).` };
  // Which machine (Decision 120): optional M-number; the server checks it's on the report's line.
  const machineId = typeof raw?.machineId === "string" && /^M-\d{3,}$/.test(raw.machineId) ? raw.machineId : null;
  return { event: { minutes, over60: minutes > 60, reason: raw.reason, called, calledWho, maintenance, issueId, fix, machineId } };
}

function cleanScrap(raw) {
  const feet = whole(raw?.feet, 1, 100000);
  if (feet === null) return { error: "Feet: a whole number, 1–100,000." };
  if (!SCRAP_REASONS.includes(raw?.reason)) return { error: "Pick the reason." };
  const notes = longText(raw?.notes, 500);
  if (raw.reason === "Other" && notes.length < 3) return { error: "Add a note saying what happened (required for Other)." };
  const tag = clean(raw?.tag, 30);
  return { scrap: { feet, reason: raw.reason, notes, tag } };
}

// Rule 1 (Chris approved 10-22-2026): Someone Contacted? — Yes if someone was called; No if nobody was called but it
// was down over 60 minutes or needed maintenance; otherwise Not Needed.
function someoneContacted(ev) {
  if (ev.called) return "Yes";
  if (ev.minutes > 60 || ev.maintenance === "called") return "No";
  return "Not Needed";
}

// Maintenance Log Completed? — Yes when maintenance was called and a Maintenance Request is linked; No when called
// without one (it can be linked later); Not Needed when the team fixed it or no maintenance was needed.
function maintenanceLog(ev) {
  if (ev.maintenance !== "called") return "Not Needed";
  return ev.issueId ? "Yes" : "No";
}

// The workbook's Notes: what was done, who was called, and the Maintenance Request — one line.
function downtimeNotes(ev) {
  return [
    ev.fix,
    ev.called && ev.calledWho ? `Called: ${ev.calledWho}` : "",
    ev.maintenance === "team" ? "Fixed by team" : "",
    ev.maintenance === "called" ? (ev.issueTitle ? `Maintenance: ${ev.issueTitle}` : "Maintenance called") : "",
  ].filter(Boolean).join(". ").replace(/\.\./g, ".");
}

// Rule 2: a flagged reel decided Scrap or Regrind is a scrap entry (feet = footage reclaimed, else footage flagged).
function reelScrap(reel) {
  if (!["scrap", "regrind"].includes(reel?.decision?.kind)) return null;
  const mapped = REEL_TO_SCRAP[reel.reasonName];
  const feet = Number(reel.reclaim?.footage ?? reel.footage);
  return {
    source: "reel", reelId: reel.id, tag: reel.tag || "",
    feet: Number.isFinite(feet) && feet > 0 ? Math.round(feet) : null,
    reason: mapped || "Other",
    notes: [`Flagged reel${reel.tag ? ` tag ${reel.tag}` : " (no tag)"}`, reel.reasonName, reel.decision.label, reel.note].filter(Boolean).join(", "),
    productSize: productSize(reel.product?.size, reel.product?.sdr),
  };
}

// Changeovers for a report: its entries, plus the single changeover the first practice reports kept on the report.
function changeoverList(report, changeovers = []) {
  const legacy = report.changeover ? [{ id: "legacy", legacy: true, ...report.changeover }] : [];
  return [...legacy, ...changeovers].sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
}

// A typed scrap entry whose tag matches a flagged reel already counted.
const duplicateTag = (tag, reels) => !!clean(tag, 30) && (reels || []).some((r) => r.tag && r.tag.toLowerCase() === clean(tag, 30).toLowerCase());

// Workbook rows for one report (data columns only, in column order). Date as "YYYY-MM-DD".
function sheetRows(report, events = [], scraps = [], changeovers = []) {
  const head = (x) => [report.date, report.lineNumber, x.team || report.team || "", x.productSize || report.productSize || ""];
  return {
    changeover: changeoverList(report, changeovers).map((c) => [...head(c), c.minutes, c.type]),
    downtime: events.map((e) => [...head(e), e.minutes, e.reason, downtimeNotes(e), maintenanceLog(e), someoneContacted(e)]),
    scrap: scraps.filter((s) => s.feet).map((s) => [...head(s), s.feet, s.reason, s.notes || ""]),
  };
}

const SHEET_HEADERS = {
  changeover: ["Date", "Line #", "Team", "Product Size", "Changeover Time (min)", "Changeover Type"],
  downtime: ["Date", "Line #", "Team", "Product Size", "Minutes", "Reason", "Notes", "Maintenance Log Completed?", "Someone Contacted?"],
  scrap: ["Date", "Line #", "Team", "Product Size", "Scrap Feet", "Reason", "Notes"],
};

// Before signing, downtime and scrap each need entries or a "None this shift" tap (Chris, 10-23-2026), so an empty
// section means "nothing happened", not "forgot". counts = { downtime, scrap } (scrap includes flagged reels).
// report.none = { downtime?: {by, byName, atMs}, scrap?: {…} }. events = the downtime entries: every one needs its
// "What happened" write-up first (Decision 141). Returns the plain message, or null when ready.
function notReadyToSign(report, counts, events = []) {
  const left = [];
  if (!counts.downtime && !report.none?.downtime) left.push("downtime");
  if (!counts.scrap && !report.none?.scrap) left.push("scrap");
  if (left.length) return `Add the ${left.join(" and ")}, or tap “None this shift” for ${left.length === 1 ? "it" : "each"} — then sign.`;
  const noWriteup = events.filter((e) => !writeupDone(e.fix)).length;
  if (noWriteup) return `${noWriteup === 1 ? "1 downtime entry needs its" : `${noWriteup} downtime entries need their`} “What happened” write-up (at least one full sentence) — then sign.`;
  return null;
}

// Minutes per group for the report: { unplanned, planned, notDowntime } — totals count Unplanned only.
function minutesByGroup(events = []) {
  const out = { unplanned: 0, planned: 0, notDowntime: 0 };
  for (const e of events) {
    const g = groupOf(e.reason);
    out[g === "not-downtime" ? "notDowntime" : g] += e.minutes || 0;
  }
  return out;
}

module.exports = {
  notReadyToSign, minutesByGroup, groupOf, countsAsDowntime, needsReview, writeupDone,
  REASON_GROUPS, CHANGEOVER_REASON, REVIEW_REASON, OLD_REASONS, WRITEUP_WORDS,
  CHANGEOVER_TYPES, DOWNTIME_REASONS, SCRAP_REASONS, ENTER_ROLES, SIGN_ROLES, REEL_TO_SCRAP, SHEET_HEADERS,
  reportId, productSize, lineNumber, canEnter, canSign, cleanProduct, cleanChangeover, cleanDowntime, cleanScrap,
  someoneContacted, maintenanceLog, downtimeNotes, reelScrap, duplicateTag, changeoverList, sheetRows,
};
