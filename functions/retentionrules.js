// Record retention — the nightly cleanup's rules (Chris, 10-23-2026, Decision 99). No database code here, so it can be
// tested alone. The periods are saved in meta/retention { periods: { key: days | null } } (null = never delete) and
// changed on Admin → Record retention; write-ups and injury reports need HR access to change, and injury reports can't
// go below 5 years. Cleanup never removes anything still open. Live records only (the test site has its own cleanup).

const DAY = 86400000;
const YEAR = 365;

// Each group of records, its default period, and what it covers (shown on the screen).
const CATEGORIES = [
  { key: "checklists", label: "Shop Clean, station checklists, machine checklists", covers: "Keep the Shop Clean lists and their daily tasks, station checklists, machine checklist sign-offs", days: 90 },
  { key: "lineChecks", label: "Line Check Log readings", covers: "Line Check Log readings (page 1 and page 2) — data for comparing old and new machines at the new shop", days: 2 * YEAR },
  { key: "reels", label: "Flagged reels / QC hold", covers: "Flagged reels and their decisions — quality traceability", days: 2 * YEAR },
  { key: "downtime", label: "Downtime & Scrap reports", covers: "Shift reports with their changeovers, downtime, and scrap (they also go to the spreadsheet)", days: 2 * YEAR },
  { key: "handoffs", label: "Shift handoffs", covers: "Shift handoff notes, sent and received", days: YEAR },
  { key: "annSigs", label: "Announcement sign-offs", covers: "Who signed Read & understood — proof people were told", days: null },
  { key: "injury", label: "Injury and first-aid reports", covers: "Injury and first-aid reports with their private details, signatures, photos, and actions — counted from closing", days: null, hr: true, minDays: 5 * YEAR },
  { key: "incidents", label: "Near misses, property damage, spills", covers: "Near miss, property damage, and spill reports with their photos and actions — counted from closing", days: null },
  { key: "writeups", label: "Write-ups", covers: "Employee write-ups", days: null, hr: true },
];
const CHOICES = [30, 60, 90, 182, YEAR, 2 * YEAR, 3 * YEAR, 5 * YEAR, 7 * YEAR, 10 * YEAR, null];
const INJURY_TYPES = ["injury", "first-aid"];

const byKey = (key) => CATEGORIES.find((c) => c.key === key) || null;

function periodLabel(days) {
  if (days == null) return "Never delete";
  if (days % YEAR === 0) return `${days / YEAR} year${days === YEAR ? "" : "s"}`;
  if (days === 182) return "6 months";
  return `${days} days`;
}

// Saved periods + the defaults for anything not saved.
function periods(saved = {}) {
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, Object.prototype.hasOwnProperty.call(saved, c.key) ? saved[c.key] : c.days]));
}

// me: { roles, hr }. Admins change periods; write-ups and injury reports also need HR access.
function canChange(cat, me) {
  return !!cat && (me?.roles || []).includes("admin") && (!cat.hr || me.hr === true);
}

// A new period for one group → { days } or { error }.
function cleanPeriod(key, value) {
  const cat = byKey(key);
  if (!cat) return { error: "Pick a group of records." };
  const days = value === null || value === "never" ? null : Number(value);
  if (days !== null && !CHOICES.includes(days)) return { error: "Pick one of the listed periods." };
  if (cat.minDays && days !== null && days < cat.minDays) return { error: `${cat.label} are kept at least ${periodLabel(cat.minDays)}.` };
  return { days };
}

// The plant-time day (YYYY-MM-DD) before which records go: records dated earlier than this are older than `days`.
function cutoffDay(nowMs, days) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(nowMs - days * DAY));
}
const cutoffMs = (nowMs, days) => nowMs - days * DAY;

// Still open — never removed, whatever its age.
const OPEN = {
  shopTasks: (d) => !d.check, // Shop Clean: until the Supervisor's Verified
  stationLists: (d) => !d.verified,
  checklistSignoffs: (d, ctx) => ctx.pendingSignoffs.has(d.id), // waiting for Verified on its machine
  lineLogs: (d) => !d.operatorSign,
  plantLogs: () => false,
  reels: (d) => d.status !== "done",
  shiftReports: (d) => !d.verified,
  handoffs: (d) => d.status === "draft" || d.status === "sent" || (d.status === "received" && d.needsVerify === true),
  announcementSigs: () => false,
  incidents: (d, ctx) => d.status !== "closed" || (d.openActions || 0) > 0 || ctx.openActionIncidents.has(d.id),
  writeups: (d) => d.status === "waiting",
};

const isInjury = (inc) => INJURY_TYPES.includes(inc?.type);

// A safety report may go only when its own group's period has passed since closing — and an injury report never
// before 5 years after closing, whatever the setting says.
function incidentMayGo(inc, p, nowMs) {
  const days = isInjury(inc) ? p.injury : p.incidents;
  if (days == null || !inc?.closedAtMs) return false;
  const floor = isInjury(inc) ? Math.max(days, byKey("injury").minDays) : days;
  return inc.closedAtMs < cutoffMs(nowMs, floor);
}

module.exports = { CATEGORIES, CHOICES, INJURY_TYPES, byKey, periodLabel, periods, canChange, cleanPeriod, cutoffDay, cutoffMs, OPEN, isInjury, incidentMayGo };
