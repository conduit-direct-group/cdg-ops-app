// Tasks (Chris, 10-23-2026; Decision 106, 10-26-2026) — announcement tasks and message tasks, one list. No database code.
// Announcements marked "This is a task": a Line Lead or Supervisor assigns it to people on their shift. Messages marked
// as a task: the sender assigns it to people it reached. Due by a time (default: end of the shift). The person signs
// Done (PIN); then the ASSIGNER confirms — or, when the assigner is off shift, any Line Lead or Supervisor on the
// current shift. Never the person who did it. The confirmer can send it back with a note. Green only when confirmed.
// Not done when due: it stays with the person (red) and the assigner is alerted once.
//
//   annTasks/{auto}   source "announcement" | "message", annId (announcements) | rootId (messages), annTitle (the title
//                     shown), annVersion, priority, emp, name, team, dueMs (older ones: dueDate "YYYY-MM-DD"), note,
//                     assignedBy, assignedByName, status ("open" | "done" | "verified" | "removed"),
//                     done {emp,name,at,device} | null, verified {emp,name,at,device,role,roleName} | null (= confirmed),
//                     returns [{ by, byName, note, atMs }] (sent back), overdueAlertedAtMs, closedAtMs, createdAt
//   Kept 1 year after it's closed (record retention). Test site: test_annTasks.

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

// { emps, dueMs, note } → { task: { emps, dueMs, note } } or { error }. crewIds: who they may assign to (people on
// their shift). nowMs: now.
function cleanAssign(raw, { nowMs, crewIds }) {
  const emps = Array.isArray(raw?.emps) ? [...new Set(raw.emps.map(String))] : [];
  if (!emps.length) return { error: "Pick at least one person." };
  if (emps.length > MAX_PEOPLE) return { error: `Up to ${MAX_PEOPLE} people at a time.` };
  if (emps.some((e) => !crewIds.includes(e))) return { error: "Pick people on your shift from the list." };
  const dueMs = Number(raw?.dueMs);
  if (!Number.isFinite(dueMs) || dueMs < nowMs - 60000) return { error: "Pick a due time that hasn't passed." };
  if (dueMs > nowMs + 31 * 86400000) return { error: "Pick a due time within a month." };
  const note = typeof raw?.note === "string" ? raw.note.replace(/\r\n/g, "\n").trim().slice(0, 500) : "";
  return { task: { emps, dueMs: Math.round(dueMs), note } };
}

// When it's due (older tasks have a due date only: the end of that day, plant time ≈ 23:59 Chicago).
function dueMsOf(task) {
  if (Number.isFinite(task?.dueMs)) return task.dueMs;
  if (isDay(task?.dueDate)) return Date.parse(`${task.dueDate}T23:59:00-06:00`);
  return Infinity;
}

// Who confirms (Decision 106): the assigner; when the assigner is off shift, any Line Lead or Supervisor on the current
// shift. Never the person who did it. person: { id, roles }. → { role, roleName } or { error }.
function canConfirm(person, task, { assignerOnShift, personOnShift }) {
  if (person.id === task.emp) return { error: "The person who did it can't also confirm it." };
  const role = ["supervisor", "lead", "plant-manager", "admin"].find((r) => (person.roles || []).includes(r)) || "";
  if (person.id === task.assignedBy) return { role: role || "assigner", roleName: ROLE_NAMES[role] || "Assigned it" };
  if (assignerOnShift) return { error: `${task.assignedByName || "The person who assigned it"} confirms this — they're on shift.` };
  const floor = ["supervisor", "lead"].find((r) => (person.roles || []).includes(r));
  if (floor && personOnShift) return { role: floor, roleName: ROLE_NAMES[floor] };
  return { error: `${task.assignedByName || "The assigner"} is off shift, so a Line Lead or Supervisor on this shift confirms it.` };
}

// Sent back to the person: a short note is required.
function cleanReturn(v) {
  const note = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return note.length >= 3 ? { note } : { error: "Write a short note — what still needs doing." };
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

module.exports = { ASSIGN_ROLES, ROLE_NAMES, canAssign, coversTeam, crewFor, cleanAssign, dueMsOf, canConfirm, cleanReturn, secondSigner, canRemove };
