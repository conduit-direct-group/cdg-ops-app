// Trucks board for Logistics & Distribution (Chris, 10-21-2026). No database code here, so it can be tested on its own.
//
//   trucks/{auto}   date (plant day), dir ("in" | "out"), carrier, time ("HH:MM", expected), forKind ("order" | "material"),
//                   ref (load / order / PO #), material (e.g. resin), notes, status ("expected" | "done" | "removed"),
//                   doneAt, doneBy, doneByName, createdBy/createdByName, search (lower-case words for history search)
//   Test site: test_trucks.
//
// Posting (add, edit, copy from yesterday, remove): roles with "Can post trucks" on the Roles screen (role.postTrucks);
// until set, Logistics & Distribution. Checking off ("Arrived" / "Out the door", one tap, no PIN): Logistics &
// Distribution and anyone who can post. Viewing: those, plus Plant Manager, Sales, Admin.

const POST_DEFAULT = ["shipping"];
const CHECK_ROLES = ["shipping"];
const VIEW_ROLES = ["shipping", "plant-manager", "sales", "admin"];
const UNDO_MS = 5 * 60000;
const MAX_PER_DAY = 200;

const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

const rolePostsTrucks = (role) => (typeof role.postTrucks === "boolean" ? role.postTrucks : POST_DEFAULT.includes(role.id));
const canPostTrucks = (roleDocs, myRoles) => (roleDocs || []).some((r) => r.active !== false && (myRoles || []).includes(r.id) && rolePostsTrucks(r));
const canCheckTrucks = (roleDocs, myRoles) => (myRoles || []).some((r) => CHECK_ROLES.includes(r)) || canPostTrucks(roleDocs, myRoles);
const canViewTrucks = (roleDocs, myRoles) => (myRoles || []).some((r) => VIEW_ROLES.includes(r)) || canPostTrucks(roleDocs, myRoles);

const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// { truck } or { error }.
function cleanTruck(raw) {
  const dir = raw?.dir === "out" ? "out" : raw?.dir === "in" ? "in" : null;
  if (!dir) return { error: "Pick Inbound or Outbound." };
  if (!isDay(raw?.date)) return { error: "Pick the day." };
  const carrier = clean(raw?.carrier, 60);
  if (!carrier) return { error: "Who is the carrier?" };
  const time = String(raw?.time || "");
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: "The expected time isn't a time." };
  const forKind = raw?.forKind === "material" ? "material" : "order";
  const ref = clean(raw?.ref, 60);
  const material = forKind === "material" ? clean(raw?.material, 80) : "";
  if (forKind === "order" && !ref) return { error: "Add the load, order, or PO #." };
  if (forKind === "material" && !material && !ref) return { error: "What material is it (e.g. resin)?" };
  const notes = typeof raw?.notes === "string" ? raw.notes.trim().slice(0, 500) : "";
  const truck = { date: raw.date, dir, carrier, time, forKind, ref, material, notes };
  return { truck: { ...truck, search: searchText(truck) } };
}

function searchText(t) {
  return [t.carrier, t.ref, t.material, t.notes].join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

// Undo a check-off: only within 5 minutes of the tap.
function canUndo(truck, nowMs) {
  return truck.status === "done" && typeof truck.doneAtMs === "number" && nowMs - truck.doneAtMs <= UNDO_MS;
}

// "Copy from yesterday": that day's trucks (not removed) as new expected trucks for `date`, skipping ones already
// on `date` (same direction, carrier, and order # / material).
function copyTrucks(fromTrucks, existing, date) {
  const key = (t) => [t.dir, t.carrier.toLowerCase(), (t.ref || "").toLowerCase(), (t.material || "").toLowerCase()].join("|");
  const have = new Set((existing || []).filter((t) => t.status !== "removed").map(key));
  const out = [];
  for (const t of fromTrucks || []) {
    if (t.status === "removed" || have.has(key(t))) continue;
    have.add(key(t));
    const { truck } = cleanTruck({ ...t, date });
    if (truck) out.push(truck);
  }
  return out;
}

const label = (t) => `${t.dir === "in" ? "📥 Inbound" : "🚚 Outbound"} · ${t.carrier}${t.ref ? ` · ${t.ref}` : ""}${t.material ? ` · ${t.material}` : ""}`;

module.exports = {
  POST_DEFAULT, CHECK_ROLES, VIEW_ROLES, UNDO_MS, MAX_PER_DAY,
  rolePostsTrucks, canPostTrucks, canCheckTrucks, canViewTrucks, cleanTruck, searchText, canUndo, copyTrucks, label,
};
