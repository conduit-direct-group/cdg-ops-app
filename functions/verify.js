// Two-step sign-off on assigned duties (Chris, 10-23-2026): the person who did it signs Done, then someone else signs
// Verified. Green only when both have signed. Used by Keep the Shop Clean and the station checklists (not line checks).
// No database code here, so it can be tested on its own.
//
// Who verifies: a Supervisor. When no Supervisor is on shift, the Production Manager or a Line Lead can (backup).
// Nobody verifies their own work. The verifier's role is saved on the record.
//
// "Do again": a Line Lead, Supervisor, Production Manager, or Admin reopens finished work with a short reason. The
// old sign-offs move to the record's history (never deleted).

const VERIFY_ROLES = ["supervisor"];
const BACKUP_ROLES = ["plant-manager", "lead"]; // in this order: the role saved when someone has both
const REDO_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const ROLE_NAMES = { supervisor: "Supervisor", "plant-manager": "Production Manager", lead: "Line Lead" };

const has = (roles, list) => (roles || []).some((r) => list.includes(r));

// The role someone verifies as: { role, roleName, backup } — or { error }.
// roles: the verifier's roles; supervisorOnShift: is any Supervisor on this shift; doers: who did the work.
function verifierRole(emp, roles, { supervisorOnShift, doers = [] }) {
  if (doers.includes(emp)) return { error: "You did some of this work — someone else verifies it." };
  if (has(roles, VERIFY_ROLES)) return { role: "supervisor", roleName: ROLE_NAMES.supervisor, backup: false };
  const backup = BACKUP_ROLES.find((r) => (roles || []).includes(r));
  if (backup && !supervisorOnShift) return { role: backup, roleName: ROLE_NAMES[backup], backup: true };
  if (backup) return { error: "A Supervisor is on shift — they verify this." };
  return { error: "Supervisors verify this. With no Supervisor on shift, the Production Manager or a Line Lead can." };
}

// Who may verify, for the sign-off sheet: people = [{ id, roles }].
function verifiers(people, { supervisorOnShift, doers = [] }) {
  return people.filter((p) => !verifierRole(p.id, p.roles, { supervisorOnShift, doers }).error);
}

// A "Do again" reason: 3–300 characters.
function cleanReason(v) {
  const reason = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return reason.length >= 3 ? { reason } : { error: "Add a short reason (for example: “Floor still wet by the winders”)." };
}

const canRedo = (roles) => has(roles, REDO_ROLES);

module.exports = { VERIFY_ROLES, BACKUP_ROLES, REDO_ROLES, ROLE_NAMES, verifierRole, verifiers, cleanReason, canRedo };
