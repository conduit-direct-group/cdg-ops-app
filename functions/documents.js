// Documents & forms (Chris, 10-26-2026, Decision 116). No database code here, so it can be tested on its own.
//
// Every master copy (forms, machine checklists, reference documents, the map file, the Crew Board stations file, the
// training data) belongs to a department. Admins edit everything; a department's head edits that department's items
// (Decision 116 a, f: no helpers; a department with no head is covered by Admins). The server checks it on every save.
//
//   meta/docDepartments    departments: { "<key>": departmentId } — set by Admins; a missing key uses the default below
//   docRevisions/{key}     rev, at, by, byName, summary — the latest load of a file that used to just replace itself
//     /revs/{n}            each load (who, when, what was in it); the file itself is in Storage at doc-revisions/{key}/{n}.json
//
// Item keys: "form:<id>", "checklist:<id>", "refdoc:<id>", "map", "stations", "training".

const KINDS = {
  form: { label: "Form", dept: /^production$/i },
  checklist: { label: "Machine checklist", dept: /maintenance/i }, // Decision 116 d
  refdoc: { label: "Reference document", dept: /^production$/i },
  map: { label: "Shop map file", dept: /operations/i },
  stations: { label: "Crew Board stations file", dept: /^production$/i },
  training: { label: "Training data", dept: /training/i },
};
const SINGLE = ["map", "stations", "training"]; // one item each

// "form:handoff" → { kind: "form", id: "handoff" }; "map" → { kind: "map", id: null }. Unknown → null.
function parseKey(key) {
  const s = String(key || "");
  if (SINGLE.includes(s)) return { kind: s, id: null };
  const m = /^(form|checklist|refdoc):([A-Za-z0-9_-]{1,80})$/.exec(s);
  return m ? { kind: m[1], id: m[2] } : null;
}

// The department an item belongs to: the Admin's setting (if that department still exists), else the default for its
// kind found by name among the departments that are on, else null (no department — Admins cover it).
function departmentOf(key, set, departments) {
  const known = new Set((departments || []).map((d) => d.id));
  if (set?.[key] && known.has(set[key])) return set[key];
  const kind = parseKey(key)?.kind;
  if (!kind) return null;
  return (departments || []).find((d) => d.active !== false && KINDS[kind].dept.test(d.name))?.id || null;
}

// May this person change items of this department? me = { employeeNumber, roles }; heads = Map department → head's emp.
function canEdit(me, deptId, heads) {
  if ((me?.roles || []).includes("admin")) return true;
  return !!deptId && !!me?.employeeNumber && heads?.get(deptId) === me.employeeNumber;
}

// The departments this person heads (Admins: all of them).
function myDepartments(me, departments, heads) {
  return (departments || []).filter((d) => canEdit(me, d.id, heads)).map((d) => d.id);
}

// Where people see it ("Used on"), from what's in the app today.
const FORM_USED_ON = {
  handoff: "Home → Shift handoff (Line Leads, Supervisors); More → Shift handoff (Production Manager, Admins)",
  tasklist: "Home → Needs you (Line Leads, Supervisors) — the shift task list",
  linecheck: "Checklists & documents → Line Check Log (each line + plant-wide)",
  station: "Checklists & documents → Station checklists; Crew Board station",
};
function usedOn(kind, extra = {}) {
  if (kind === "form") return FORM_USED_ON[extra.formKind] || "Checklists & documents";
  if (kind === "checklist") return `Checklists & documents → machine checklists${extra.units ? ` (${extra.units} in use)` : ""}; the machine's page; Home when overdue`;
  if (kind === "refdoc") return "Checklists & documents → Reference documents";
  if (kind === "map") return "Shop Map (everyone), station SOP buttons, Your station today";
  if (kind === "stations") return "Who's here today → Stations; Your station today";
  if (kind === "training") return "🎓 Training (modules, roster, SOP text)";
  return "";
}

module.exports = { KINDS, SINGLE, parseKey, departmentOf, canEdit, myDepartments, usedOn };
