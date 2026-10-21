// HR access (Chris, 10-21-2026) — a per-person permission, separate from Admin. Covers write-ups and reviews (when
// built) and injury report details: the injury record, signatures, injury / first-aid photos, the yearly export.
// Admin, Training & Safety, and Production Manager without HR access still see that an injury report exists, its status,
// what happened, root cause, and actions — not the details. Stored on the person: employees/{emp}.hrAccess = true.
//
// Only someone who already has HR access can give or take it away (so a second Admin can't grant it to himself).
// The very first grant, when nobody has it yet, can only be an Admin giving it to himself (one-time setup).

const hasHr = (emp) => !!emp && emp.active !== false && emp.hrAccess === true;

// caller: { employeeNumber, roles, hr }; anyoneHasHr: does any active person have it now?
function canSetHr(caller, targetEmp, anyoneHasHr) {
  if (caller.hr) return { ok: true };
  if (!anyoneHasHr && caller.roles.includes("admin") && targetEmp === caller.employeeNumber) return { ok: true, firstSetup: true };
  return { ok: false, error: "Only someone with HR access can change who has it." };
}

// Taking it away from the last person would leave nobody able to see injury details or give it back.
function wouldLeaveNobody(holders, targetEmp, on) {
  return !on && holders.length === 1 && holders[0] === targetEmp;
}

const INJURY_TYPES = ["injury", "first-aid"];
// Photos of an injury or first-aid report are HR details; near miss / property / spill photos are for follow-up.
const photosNeedHr = (type) => INJURY_TYPES.includes(type);

module.exports = { hasHr, canSetHr, wouldLeaveNobody, photosNeedHr, INJURY_TYPES };
