// "Need something?" requests (app only — nothing goes to Odoo). No database code here, so it can be tested.
//
// Request types are data (Admin → Request types & routing). Each type routes to roles and/or people.
// When a request is sent, the server turns that routing into a fixed list of employee numbers
// (`recipients`) — they get a push notification and see it on their home screen.
// Status: open -> in-progress -> done. Done keeps who closed it and when.

const STATUSES = ["open", "in-progress", "done"];

// Chris's starting types and routing (10-16-2026). "lead" = Production Lead / Supervisor.
// Supplies has no restock role yet — it goes to Admin until someone is picked on the admin screen.
const STARTING_TYPES = [
  { id: "tool", name: "Tool broken or missing", icon: "🧰", routeRoles: ["maintenance"], urgent: false, order: 1 },
  { id: "supplies", name: "Running low / out of supplies", icon: "📦", routeRoles: ["admin"], urgent: false, order: 2, needsRouting: true },
  { id: "safety", name: "Safety concern", icon: "⚠️", routeRoles: ["lead", "admin"], urgent: true, order: 3 },
  { id: "building", name: "Building (lights, bathroom, heat)", icon: "🏢", routeRoles: ["maintenance"], urgent: false, order: 4 },
  { id: "other", name: "Other", icon: "💬", routeRoles: ["lead"], urgent: false, order: 5 },
];

function startingType(t) {
  return {
    name: t.name, icon: t.icon, routeRoles: t.routeRoles, routePeople: [], urgent: t.urgent, order: t.order, active: true,
    needsRouting: t.needsRouting === true,
  };
}

const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");

// What a person sends. Returns { request } or { error }.
function cleanRequest(data) {
  const description = clean(data?.description, 2000);
  if (description.length < 3) return { error: "Say what you need (a few words is fine)." };
  const place = clean(data?.place, 80);
  const lineId = typeof data?.lineId === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(data.lineId) ? data.lineId : null;
  const photos = Array.isArray(data?.photos) ? data.photos.filter((u) => typeof u === "string" && /^https:\/\//.test(u) && u.length < 2000) : [];
  if (photos.length > 5) return { error: "5 photos at most." };
  if (typeof data?.typeId !== "string" || !data.typeId) return { error: "Pick what kind of request it is." };
  return { request: { typeId: data.typeId, description, place, lineId, photos } };
}

// Admin edits to a type. Returns { type } or { error }.
function cleanType(data, knownRoles) {
  const name = clean(data?.name, 60).replace(/\s+/g, " ");
  if (!name) return { error: "Name is required (60 characters max)." };
  const icon = clean(data?.icon, 8) || "💬";
  const routeRoles = Array.isArray(data?.routeRoles) ? [...new Set(data.routeRoles.map(String))] : [];
  const routePeople = Array.isArray(data?.routePeople) ? [...new Set(data.routePeople.map(String))] : [];
  if (routeRoles.some((r) => !knownRoles.includes(r))) return { error: "Pick roles from the list." };
  if (routePeople.some((p) => !/^[A-Za-z0-9]{1,12}$/.test(p))) return { error: "Pick people from the list." };
  if (!routeRoles.length && !routePeople.length) return { error: "Send it to at least one role or person." };
  const order = Number.isFinite(Number(data?.order)) ? Number(data.order) : 99;
  return { type: { name, icon, routeRoles, routePeople, urgent: data?.urgent === true, active: data?.active !== false, order, needsRouting: false } };
}

// Routing -> employee numbers: everyone on (active) with one of the roles, plus the named people (if on).
// employees: [{ id, roles, active }]
function recipientsFor(type, employees) {
  const on = employees.filter((e) => e.active !== false);
  const byRole = on.filter((e) => (e.roles || []).some((r) => (type.routeRoles || []).includes(r))).map((e) => e.id);
  const named = on.filter((e) => (type.routePeople || []).includes(e.id)).map((e) => e.id);
  return [...new Set([...byRole, ...named])].sort();
}

// Who may move a request along: the people it was sent to, and admins.
function canWork(request, employeeNumber, roles) {
  return (request.recipients || []).includes(employeeNumber) || (roles || []).includes("admin");
}

// Allowed moves: open -> in-progress -> done; done can be reopened (back to open) if it was closed by mistake.
function canMove(from, to) {
  if (!STATUSES.includes(to) || from === to) return false;
  if (from === "open") return to === "in-progress" || to === "done";
  if (from === "in-progress") return to === "done" || to === "open";
  return from === "done" && to === "open";
}

module.exports = { STATUSES, STARTING_TYPES, startingType, cleanRequest, cleanType, recipientsFor, canWork, canMove };
