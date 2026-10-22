// Low silo alert (Chris, 10-21-2026). No database code here, so it can be tested on its own.
//
//   siloLevels/{siloId}      level (0–100), at, by, byName, source ("handoff" | "update"), alerted (true while below the
//                            low line after an alert went out). Test site: test_siloLevels.
//   siloReadings/{auto}      every reading (history). Test site: test_siloReadings.
//   meta/siloSettings        { silos: { [siloId]: { low: number|null, alert: bool } }, alertPeople: [employee #] }
//                            — Admin → Silo alerts. alertPeople get the alert too (Chris, 10-22-2026: Chris himself).
//
// Levels come from the Shift Handoff's silo fields (same ids) and from "Update silo levels" mid-shift.
// No alerts until a low level is set. One alert per drop: again only after a refill above the line and a new drop.

const SILOS = [
  { id: "regrind-silo", name: "Regrind silo", alertByDefault: false },
  { id: "silo-1", name: "Silo 1", alertByDefault: true },
  { id: "silo-2", name: "Silo 2", alertByDefault: true },
  { id: "silo-3", name: "Silo 3", alertByDefault: true },
  { id: "silo-4", name: "Silo 4", alertByDefault: true },
];
const ALERT_ROLES = ["shipping", "supervisor", "plant-manager"];
const UPDATE_ROLES = ["operator", "lead", "supervisor", "plant-manager", "admin"];

// The levels a set of handoff values (or an update) contains: { siloId: number } — only known silos, 0–100.
function levelsFrom(values) {
  const out = {};
  for (const s of SILOS) {
    const v = values?.[s.id];
    if (v === "" || v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[s.id] = Math.round(n * 10) / 10;
  }
  return out;
}

// Settings as saved: low is a number 1–99 or null (not set); alert defaults to Silos 1–4 on, Regrind off.
function cleanSettings(raw) {
  const silos = {};
  for (const s of SILOS) {
    const r = raw?.[s.id] || {};
    let low = r.low === "" || r.low === null || r.low === undefined ? null : Number(r.low);
    if (low !== null && (!Number.isFinite(low) || low < 1 || low > 99)) return { error: `${s.name}: the low level must be 1–99%.` };
    silos[s.id] = { low, alert: typeof r.alert === "boolean" ? r.alert : s.alertByDefault };
  }
  return { silos };
}

// One reading: should it alert, and what is the silo's alerted state afterwards?
function judge(setting, wasAlerted, level) {
  const low = setting?.low;
  const on = setting ? setting.alert !== false : false;
  if (!on || typeof low !== "number") return { alert: false, alerted: false };
  if (level >= low) return { alert: false, alerted: false }; // refilled above the line: ready to alert on the next drop
  if (wasAlerted) return { alert: false, alerted: true }; // still low, already told
  return { alert: true, alerted: true };
}

// Extra people who get low silo alerts (on top of the roles): employee numbers, no repeats, 20 at most.
function cleanPeople(raw) {
  if (raw === undefined || raw === null) return { people: [] };
  if (!Array.isArray(raw) || raw.length > 20) return { error: "Pick up to 20 people." };
  const people = [...new Set(raw.map(String))];
  if (people.some((p) => !/^[A-Za-z0-9]{1,12}$/.test(p))) return { error: "Pick people from the list." };
  return { people };
}

// Who gets an alert: everyone on (active) with an alert role, plus the extra people (if on). employees: [{ id, roles, active }]
function alertRecipients(employees, alertPeople = []) {
  return employees.filter((e) => e.active !== false && ((e.roles || []).some((r) => ALERT_ROLES.includes(r)) || alertPeople.includes(e.id))).map((e) => e.id);
}

const siloName = (id) => SILOS.find((s) => s.id === id)?.name || id;

module.exports = { SILOS, ALERT_ROLES, UPDATE_ROLES, levelsFrom, cleanSettings, cleanPeople, alertRecipients, judge, siloName };
