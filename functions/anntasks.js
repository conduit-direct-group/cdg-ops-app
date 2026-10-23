// Announcement tasks (Chris, 10-23-2026). A Line Lead or Supervisor who gets an announcement that is real work can
// assign it to one or more people on their team, with a due date (starts at the announcement's acknowledge-by date).
// Each person signs Done with their PIN; then a Line Lead or Supervisor on that team — or the Production Manager —
// signs off. Never the person who did it. Green only when both have signed. No database code here.
//
//   annTasks/{auto}   annId, annVersion, annTitle, priority, emp, name, team, dueDate ("YYYY-MM-DD"), note,
//                     assignedBy, assignedByName, status ("open" | "done" | "verified" | "removed"),
//                     done {emp,name,at,device} | null, verified {emp,name,at,device,role,roleName} | null, createdAt
//   Test site: test_annTasks.

const ASSIGN_ROLES = ["lead", "supervisor"];
const ROLE_NAMES = { supervisor: "Supervisor", lead: "Line Lead", "plant-manager": "Production Manager" };
const MAX_PEOPLE = 30;

const has = (roles, list) => (roles || []).some((r) => list.includes(r));
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
const canAssign = (roles) => has(roles, ASSIGN_ROLES);

// Does this lead / supervisor cover that team (their own team, or one a Supervisor supervises)?
const coversTeam = (p, team) => !!team && (p.team === team || (has(p.roles, ["supervisor"]) && (p.supervisesTeams || []).includes(team)));

// The people a lead / supervisor can assign to: active, on a team they cover, not themselves. people = peopleList().
function crewFor(me, people) {
  return people.filter((p) => p.active !== false && p.id !== me.id && (coversTeam(me, p.team) || (!!me.team && p.team === me.team)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// { emps, dueDate, note } → { task: { emps, dueDate, note } } or { error }. crewIds: who they may assign to.
function cleanAssign(raw, { today, crewIds }) {
  const emps = Array.isArray(raw?.emps) ? [...new Set(raw.emps.map(String))] : [];
  if (!emps.length) return { error: "Pick at least one person." };
  if (emps.length > MAX_PEOPLE) return { error: `Up to ${MAX_PEOPLE} people at a time.` };
  if (emps.some((e) => !crewIds.includes(e))) return { error: "Pick people on your team from the list." };
  if (!isDay(raw?.dueDate)) return { error: "Pick the due date." };
  if (raw.dueDate < today) return { error: "The due date can't be in the past." };
  const note = typeof raw?.note === "string" ? raw.note.replace(/\r\n/g, "\n").trim().slice(0, 500) : "";
  return { task: { emps, dueDate: raw.dueDate, note } };
}

// The second sign-off: a Line Lead or Supervisor on the task's team (or the one who assigned it), or the Production
// Manager. Never the person who did it. → { role, roleName } or { error }.
function secondSigner(person, task) {
  if (person.id === task.emp) return { error: "The person who did it can't also sign it off." };
  if (has(person.roles, ["plant-manager"])) return { role: "plant-manager", roleName: ROLE_NAMES["plant-manager"] };
  const role = ["supervisor", "lead"].find((r) => (person.roles || []).includes(r));
  if (role && (coversTeam(person, task.team) || person.id === task.assignedBy)) return { role, roleName: ROLE_NAMES[role] };
  return { error: "A Line Lead or Supervisor on that team (or the Production Manager) signs this off." };
}

// Who may remove an open task: the one who assigned it, a lead / supervisor on that team, Production Manager, Admin.
const canRemove = (person, task) => person.id === task.assignedBy || has(person.roles, ["plant-manager", "admin"]) || (has(person.roles, ASSIGN_ROLES) && coversTeam(person, task.team));

module.exports = { ASSIGN_ROLES, ROLE_NAMES, canAssign, coversTeam, crewFor, cleanAssign, secondSigner, canRemove };
