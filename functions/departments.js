// Departments + reports to (Chris, 10-22-2026; launch list 1). No database code here, so it can be tested on its own.
//
//   meta/departments     departments [{ id, name, active }] (Admin → Departments), headsReportTo: employee # or null
//                        (null = the Production head)
//   employees/{emp}      department (id), deptHead (true on the one head of a department), reportsTo (an admin's
//                        override: employee #; missing = worked out automatically)
//
// Reports to, worked out automatically:
//   Production, by shift: Operator → their team's Line Lead → their team's Supervisor → Production Manager.
//   Other departments: everyone → their department head; heads → headsReportTo (default: the Production head).
//   The Production head (the Production Manager) reports to no one unless an admin sets someone.

const STARTING_DEPARTMENTS = [
  ["production", "Production"], ["maintenance", "Maintenance"], ["quality", "Quality"],
  ["logistics", "Logistics & Distribution"], ["sales", "Sales"], ["office", "Office"], ["training-safety", "Training & Safety"],
];
const PRODUCTION = "production";
// Role → department, in the order a person with several roles is placed (Admin is not a department).
const ROLE_DEPARTMENT = [
  ["plant-manager", "production"], ["supervisor", "production"], ["lead", "production"], ["operator", "production"],
  ["maintenance", "maintenance"], ["quality", "quality"], ["shipping", "logistics"], ["sales", "sales"],
  ["office", "office"], ["training-safety", "training-safety"],
];

const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const slug = (s) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const has = (p, role) => (p.roles || []).includes(role);

const startingDepartments = () => STARTING_DEPARTMENTS.map(([id, name]) => ({ id, name, active: true }));

// The department a person's roles point to (only departments that are on), or null.
function suggestDepartment(roles, departments) {
  const on = new Set((departments || []).filter((d) => d.active !== false).map((d) => d.id));
  for (const [role, dept] of ROLE_DEPARTMENT) if ((roles || []).includes(role) && on.has(dept)) return dept;
  return null;
}

// Admin → Departments: 1–30 names, no repeats; new ones get an id from the name; ids never change.
function cleanDepartments(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 30) return { error: "Keep 1 to 30 departments." };
  const out = [];
  for (const r of raw) {
    const name = clean(r?.name, 60);
    if (!name) return { error: "Every department needs a name." };
    if (out.some((d) => d.name.toLowerCase() === name.toLowerCase())) return { error: `“${name}” is listed twice.` };
    const id = typeof r?.id === "string" && /^[a-z0-9-]{1,40}$/.test(r.id) ? r.id : slug(name);
    if (!id || out.some((d) => d.id === id)) return { error: `“${name}” is too close to another department's name.` };
    out.push({ id, name, active: r?.active !== false });
  }
  if (!out.some((d) => d.active)) return { error: "Keep at least one department on." };
  return { departments: out };
}

// One person's department fields from Admin → People. reportsTo: an employee # (override) or null (automatic).
function cleanOrg(raw, { departments = [], people = [], emp } = {}) {
  const department = raw?.department ? String(raw.department) : null;
  if (department && !departments.some((d) => d.id === department)) return { error: "Pick a department from the list." };
  const head = raw?.head === true;
  if (head && !department) return { error: "Pick the department first, then tick Department head." };
  const reportsTo = raw?.reportsTo ? String(raw.reportsTo) : null;
  if (reportsTo && reportsTo === emp) return { error: "Someone can't report to themselves." };
  if (reportsTo && !people.some((p) => p.id === reportsTo && p.active !== false)) return { error: "Pick who they report to from the list." };
  return { org: { department, head, reportsTo } };
}

// The head of a department: the person ticked as head (active), or for Production with none ticked, the
// Production Manager in Production (or any Production Manager).
function headOf(dept, people) {
  const on = people.filter((p) => p.active !== false);
  const ticked = on.find((p) => p.department === dept && p.deptHead === true);
  if (ticked || dept !== PRODUCTION) return ticked || null;
  return on.find((p) => p.department === PRODUCTION && has(p, "plant-manager")) || on.find((p) => has(p, "plant-manager")) || null;
}

// Someone on the same team with a role, in Production, not this person; same home line first.
function teamMate(p, role, people) {
  const list = people.filter((x) => x.active !== false && x.id !== p.id && x.department === PRODUCTION && has(x, role) && p.team && x.team === p.team);
  return list.find((x) => p.homeLineId && x.homeLineId === p.homeLineId) || list.sort((a, b) => a.name.localeCompare(b.name))[0] || null;
}

// Who each person reports to: Map emp → { reportsTo: emp | null, source: "override" | "auto" | "top" | "missing" }.
function reportsToAll(people, { headsReportTo = null } = {}) {
  const prodHead = headOf(PRODUCTION, people);
  const headsTo = people.some((x) => x.id === headsReportTo && x.active !== false) ? headsReportTo : prodHead?.id || null;
  const heads = new Map();
  const headFor = (d) => (heads.has(d) ? heads.get(d) : heads.set(d, headOf(d, people)).get(d));
  const out = new Map();
  for (const p of people) {
    const pick = (to) => (to && to !== p.id ? to : null);
    let to = null;
    if (p.reportsTo && people.some((x) => x.id === p.reportsTo && x.active !== false) && p.reportsTo !== p.id) {
      out.set(p.id, { reportsTo: p.reportsTo, source: "override" });
      continue;
    }
    if (!p.department) { out.set(p.id, { reportsTo: null, source: "missing" }); continue; }
    if (p.department === PRODUCTION) {
      if (prodHead && prodHead.id === p.id) { out.set(p.id, { reportsTo: null, source: "top" }); continue; }
      if (has(p, "supervisor")) to = prodHead?.id;
      else if (has(p, "lead")) to = teamMate(p, "supervisor", people)?.id || prodHead?.id;
      else to = teamMate(p, "lead", people)?.id || teamMate(p, "supervisor", people)?.id || prodHead?.id;
    } else {
      const head = headFor(p.department);
      to = head && head.id === p.id ? headsTo : head?.id;
    }
    to = pick(to);
    out.set(p.id, { reportsTo: to, source: to ? "auto" : "missing" });
  }
  return out;
}

// Departments (on) with people in them but no head.
function departmentsWithoutHead(people, departments) {
  return (departments || []).filter((d) => d.active !== false && people.some((p) => p.active !== false && p.department === d.id) && !headOf(d.id, people)).map((d) => d.id);
}

module.exports = {
  STARTING_DEPARTMENTS, PRODUCTION, startingDepartments, suggestDepartment, cleanDepartments, cleanOrg, headOf, reportsToAll,
  departmentsWithoutHead,
};
