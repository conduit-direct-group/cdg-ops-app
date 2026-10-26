// What each role sees in More (Chris, 10-26-2026, Decision 108 item 6 with the Decision 112 layout). Admins set it per
// role in Admin → Roles (roles/{id}.nav = { key: true | false }); a role with no setting uses the approved table. An item
// shows when the person's roles allow it (what they can do) AND one of their roles has it turned on. Always kept for
// everyone, not set here: Home and its quick buttons, All safety reports, All announcements, My profile, Who to Call,
// Reference documents. Permissions (Write-ups, Admin, Machines, Trucks) aren't set here either.

import { data } from "./data.js";
import { usesCrewBoard } from "./crew.js";
import { usesHandoffs } from "./handoff.js";
import { runsShopList } from "./shoptasks.js";
import { usesMachines } from "./dashboard.js";
import { usesDowntime } from "./downtime.js";
import { canViewTrucks, canCheckTrucks } from "./trucks.js";

const has = (roles, list) => (roles || []).some((r) => list.includes(r));
export const ISSUE_VIEW_ROLES = ["maintenance", "admin", "plant-manager", "supervisor"]; // the Open issues board

// key, label, who may have it (permission), and who has it unless an Admin changes it (the approved table).
export const NAV_ITEMS = [
  { key: "crew", label: "👥 Who's here today", allowed: usesCrewBoard, on: ["admin", "plant-manager", "supervisor", "lead"] },
  { key: "handoff", label: "📝 Shift handoff", allowed: usesHandoffs, on: ["admin", "plant-manager", "supervisor", "lead"] },
  { key: "shop", label: "🧹 Keep the Shop Clean", allowed: runsShopList, on: ["admin", "plant-manager", "supervisor", "lead"] },
  { key: "fixes", label: "🔧 Fix Library", allowed: usesMachines, on: ["admin", "plant-manager", "supervisor", "lead", "operator", "maintenance", "training-safety"] },
  { key: "issues", label: "🚨 Open issues", allowed: (r) => has(r, ISSUE_VIEW_ROLES), on: ["admin", "plant-manager", "supervisor", "maintenance"] },
  { key: "training", label: "🎓 Training", allowed: (r) => has(r, ["training-safety", "admin"]), on: ["admin", "training-safety"] },
  { key: "trucksView", label: "🚚 Trucks (look only)", allowed: (r) => canViewTrucks(r) && !canCheckTrucks(r), on: ["admin", "plant-manager", "sales"] },
  { key: "qcList", label: "🏷 QC hold — flagged reels", allowed: (r) => (r || []).includes("quality") || usesMachines(r), on: ["admin", "plant-manager", "supervisor", "lead", "training-safety"] },
  { key: "downtime", label: "⏱ Downtime & scrap shift report", allowed: usesDowntime, on: ["admin", "plant-manager", "supervisor", "lead"] },
];
const byKey = new Map(NAV_ITEMS.map((i) => [i.key, i]));

// Does this one role have the item turned on? (its own setting, else the approved table)
export function roleShows(roleId, key) {
  const doc = (data.roles || []).find((r) => r.id === roleId);
  const set = doc?.nav?.[key];
  return typeof set === "boolean" ? set : !!byKey.get(key)?.on.includes(roleId);
}

// Does a person with these roles see the item in More?
export function navShows(key, roles) {
  const item = byKey.get(key);
  if (!item || !item.allowed(roles)) return false;
  return (roles || []).some((r) => roleShows(r, key));
}
