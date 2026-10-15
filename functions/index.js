// Server code for the CDG Operations App.
// Runs on Google's servers (Cloud Functions), never on the phone or tablet.
//
// Login (Decisions 4-7, 16): employee # + 6-digit PIN, checked here on the server.
//   - PINs are stored only as scrypt hashes in `pinSecrets`, which phones can never read.
//   - 5 wrong tries locks the account for 15 minutes; an admin can unlock sooner.
//   - New hires and resets get a temporary PIN and must pick their own on first login.
//
// Data:
//   employees/{employeeNumber}   name, roles, active
//   pinSecrets/{employeeNumber}  hash, salt, wrongCount, lockedUntilMs, mustChangePin
//   auditLog/{auto-id}           who did what to which account, and when
//
// Rule: no secrets, PINs, or employee data in this file — ever. The repo is public.

const { initializeApp } = require("firebase-admin/app");
const { getStorage, getDownloadURL } = require("firebase-admin/storage");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const pin = require("./pin");
const records = require("./records");
const fixesLib = require("./fixes");

initializeApp();
const db = getFirestore();
const auth = getAuth();

// maxInstances caps how many copies can run at once — a guard against runaway cost.
setGlobalOptions({ region: "us-central1", maxInstances: 5 });

const employees = db.collection("employees");
const pinSecrets = db.collection("pinSecrets");
const auditLog = db.collection("auditLog");
const roles = db.collection("roles");
const lines = db.collection("lines");
const machines = db.collection("machines");
const counters = db.collection("meta").doc("counters");
const fixes = db.collection("fixes");
const fixCategories = db.collection("fixCategories");
const searchGaps = db.collection("searchGaps");

const WRONG_LOGIN = "Wrong employee number or PIN.";

function uidFor(employeeNumber) {
  return `emp_${employeeNumber}`;
}

function audit(tx, type, employeeNumber, by, extra = {}) {
  tx.create(auditLog.doc(), { type, employeeNumber, by, at: FieldValue.serverTimestamp(), ...extra });
}

function newPinRecord(hashed, mustChangePin) {
  return { ...hashed, wrongCount: 0, lockedUntilMs: null, mustChangePin, updatedAt: FieldValue.serverTimestamp() };
}

// Checks a PIN and records the result (wrong-try count, lockout). Used by login, change-PIN,
// and later by every sign-off so a signature proves who signed (Decision 7).
async function attemptPin(employeeNumber, enteredPin) {
  const empRef = employees.doc(employeeNumber);
  const secretRef = pinSecrets.doc(employeeNumber);
  return db.runTransaction(async (tx) => {
    const [empSnap, secretSnap] = await tx.getAll(empRef, secretRef);
    if (!empSnap.exists || !secretSnap.exists || empSnap.get("active") === false) {
      await pin.hashPin(enteredPin); // same work as a real check, so timing doesn't reveal which numbers exist
      return { ok: false };
    }
    const record = secretSnap.data();
    const now = Date.now();
    const lock = pin.lockStatus(record, now);
    if (lock.locked) return { ok: false, minutesLeft: lock.minutesLeft };

    if (!(await pin.pinMatches(enteredPin, record))) {
      const next = pin.afterWrongPin(record, now);
      tx.update(secretRef, { wrongCount: next.wrongCount, lockedUntilMs: next.lockedUntilMs });
      if (next.justLocked) audit(tx, "locked", employeeNumber, "system");
      return { ok: false, minutesLeft: next.justLocked ? pin.LOCK_MINUTES : undefined };
    }
    if (record.wrongCount || record.lockedUntilMs) {
      tx.update(secretRef, { wrongCount: 0, lockedUntilMs: null });
    }
    return { ok: true, employee: empSnap.data(), mustChangePin: record.mustChangePin === true };
  });
}

function throwPinFailure(result) {
  if (result.minutesLeft) {
    throw new HttpsError(
      "resource-exhausted",
      `Too many wrong tries. Try again in ${result.minutesLeft} minutes, or ask an admin to unlock you.`
    );
  }
  throw new HttpsError("permission-denied", WRONG_LOGIN);
}

// Keeps the Firebase sign-in account in step with the employee record.
// Roles ride along in the sign-in pass ("claims") so security rules can check them.
// pinTemp: true means "still on a temporary PIN" — rules will block everything until it's changed.
async function syncAuthUser(employeeNumber, employee, pinTemp) {
  const uid = uidFor(employeeNumber);
  try {
    await auth.updateUser(uid, { displayName: employee.name, disabled: employee.active === false });
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    await auth.createUser({ uid, displayName: employee.name, disabled: employee.active === false });
  }
  await auth.setCustomUserClaims(uid, { emp: employeeNumber, roles: employee.roles, pinTemp });
  return uid;
}

function requireSignedIn(req) {
  const employeeNumber = req.auth?.token?.emp;
  if (!employeeNumber) throw new HttpsError("unauthenticated", "Please sign in again.");
  return employeeNumber;
}

// Checks the live employee record, not just the sign-in pass, so removing someone's
// admin role takes effect immediately.
async function requireAdmin(req) {
  const employeeNumber = requireSignedIn(req);
  if (req.auth.token.pinTemp === true) {
    throw new HttpsError("permission-denied", "Choose your own PIN first.");
  }
  const snap = await employees.doc(employeeNumber).get();
  if (!snap.exists || snap.get("active") === false || !(snap.get("roles") || []).includes("admin")) {
    throw new HttpsError("permission-denied", "Only admins can do this.");
  }
  return employeeNumber;
}

function requireEmployeeNumber(value) {
  const employeeNumber = pin.normalizeEmployeeNumber(value);
  if (!employeeNumber) throw new HttpsError("invalid-argument", "Employee number must be 1-12 letters or digits.");
  return employeeNumber;
}

function requireName(value) {
  const name = pin.normalizeName(value);
  if (!name) throw new HttpsError("invalid-argument", "Name is required (60 characters max).");
  return name;
}

// Roles must be on the Roles list (Admin → Roles) and not retired.
async function requireRoles(value) {
  const ids = pin.normalizeRoles(value);
  if (!ids) throw new HttpsError("invalid-argument", "Pick at least one role.");
  const snaps = await db.getAll(...ids.map((id) => roles.doc(id)));
  const bad = snaps.filter((s) => !s.exists || s.get("active") === false).map((s) => s.id);
  if (bad.length) {
    throw new HttpsError(
      "invalid-argument",
      `Not on the Roles list: ${bad.join(", ")}. Add it in Admin → Roles (or tap "Add the starting roles" there).`
    );
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Everyone
// ---------------------------------------------------------------------------

// Employee # + PIN in, sign-in pass (custom token) out.
exports.pinLogin = onCall(async (req) => {
  const employeeNumber = pin.normalizeEmployeeNumber(req.data?.employeeNumber);
  const enteredPin = req.data?.pin;
  if (!employeeNumber || !pin.isValidPinFormat(enteredPin)) {
    throw new HttpsError("permission-denied", WRONG_LOGIN);
  }
  const result = await attemptPin(employeeNumber, enteredPin);
  if (!result.ok) throwPinFailure(result);

  const uid = await syncAuthUser(employeeNumber, result.employee, result.mustChangePin);
  const token = await auth.createCustomToken(uid);
  return { token, name: result.employee.name, mustChangePin: result.mustChangePin };
});

// Swap a temporary PIN (or any current PIN) for a new one the person picks.
// After this the app must refresh its sign-in pass to pick up pinTemp: false.
exports.changePin = onCall(async (req) => {
  const employeeNumber = requireSignedIn(req);
  const { currentPin, newPin } = req.data || {};
  if (!pin.isValidPinFormat(newPin)) throw new HttpsError("invalid-argument", "New PIN must be 6 digits.");
  if (pin.isWeakPin(newPin)) throw new HttpsError("invalid-argument", "That PIN is too easy to guess. Pick another.");
  if (newPin === currentPin) throw new HttpsError("invalid-argument", "New PIN must be different from the old one.");
  if (!pin.isValidPinFormat(currentPin)) throw new HttpsError("permission-denied", "Current PIN is wrong.");

  const result = await attemptPin(employeeNumber, currentPin);
  if (!result.ok) {
    if (result.minutesLeft) throwPinFailure(result);
    throw new HttpsError("permission-denied", "Current PIN is wrong.");
  }
  const hashed = await pin.hashPin(newPin);
  await db.runTransaction(async (tx) => {
    tx.set(pinSecrets.doc(employeeNumber), newPinRecord(hashed, false));
    audit(tx, "pin-changed", employeeNumber, employeeNumber);
  });
  await syncAuthUser(employeeNumber, result.employee, false);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Admins
// ---------------------------------------------------------------------------

// Everyone, with status for the admin People screen. Never includes PIN hashes.
exports.adminListEmployees = onCall(async (req) => {
  await requireAdmin(req);
  const [empSnaps, secretSnaps] = await Promise.all([employees.get(), pinSecrets.get()]);
  const secrets = new Map(secretSnaps.docs.map((d) => [d.id, d.data()]));
  const now = Date.now();
  const list = empSnaps.docs.map((d) => {
    const e = d.data();
    const s = secrets.get(d.id) || {};
    const lock = pin.lockStatus(s, now);
    return {
      employeeNumber: d.id,
      name: e.name,
      roles: e.roles || [],
      active: e.active !== false,
      mustChangePin: s.mustChangePin === true,
      locked: lock.locked,
      minutesLeft: lock.minutesLeft || 0,
    };
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { employees: list };
});

// Adds a person. Returns a temporary PIN for the admin to give them.
exports.adminCreateEmployee = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const employeeNumber = requireEmployeeNumber(req.data?.employeeNumber);
  const employee = { name: requireName(req.data?.name), roles: await requireRoles(req.data?.roles), active: true };
  const tempPin = pin.randomTempPin();
  const hashed = await pin.hashPin(tempPin);

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(employees.doc(employeeNumber));
    if (existing.exists) throw new HttpsError("already-exists", `Employee ${employeeNumber} already exists.`);
    tx.create(employees.doc(employeeNumber), {
      ...employee,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(pinSecrets.doc(employeeNumber), newPinRecord(hashed, true));
    audit(tx, "created", employeeNumber, adminNumber, { roles: employee.roles });
  });
  await syncAuthUser(employeeNumber, employee, true);
  return { employeeNumber, tempPin };
});

// New temporary PIN, lockout cleared, signed out on every device (e.g. forgotten PIN or lost phone).
exports.adminResetPin = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const employeeNumber = requireEmployeeNumber(req.data?.employeeNumber);
  const tempPin = pin.randomTempPin();
  const hashed = await pin.hashPin(tempPin);

  const employee = await db.runTransaction(async (tx) => {
    const snap = await tx.get(employees.doc(employeeNumber));
    if (!snap.exists) throw new HttpsError("not-found", `No employee ${employeeNumber}.`);
    tx.set(pinSecrets.doc(employeeNumber), newPinRecord(hashed, true));
    audit(tx, "pin-reset", employeeNumber, adminNumber);
    return snap.data();
  });
  await syncAuthUser(employeeNumber, employee, true);
  await auth.revokeRefreshTokens(uidFor(employeeNumber));
  return { employeeNumber, tempPin };
});

// Ends a lockout early. PIN stays the same.
exports.adminUnlock = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const employeeNumber = requireEmployeeNumber(req.data?.employeeNumber);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(pinSecrets.doc(employeeNumber));
    if (!snap.exists) throw new HttpsError("not-found", `No employee ${employeeNumber}.`);
    tx.update(snap.ref, { wrongCount: 0, lockedUntilMs: null });
    audit(tx, "unlocked", employeeNumber, adminNumber);
  });
  return { ok: true };
});

// Change name or roles, or turn an account off (someone leaves) / back on.
exports.adminUpdateEmployee = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const employeeNumber = requireEmployeeNumber(req.data?.employeeNumber);
  const changes = {};
  if (req.data?.name !== undefined) changes.name = requireName(req.data.name);
  if (req.data?.roles !== undefined) changes.roles = await requireRoles(req.data.roles);
  if (req.data?.active !== undefined) {
    if (typeof req.data.active !== "boolean") throw new HttpsError("invalid-argument", "active must be true or false.");
    changes.active = req.data.active;
  }
  if (Object.keys(changes).length === 0) throw new HttpsError("invalid-argument", "Nothing to change.");
  if (employeeNumber === adminNumber && (changes.active === false || (changes.roles && !changes.roles.includes("admin")))) {
    throw new HttpsError("failed-precondition", "You can't remove your own admin access. Ask another admin.");
  }

  const { employee, pinTemp } = await db.runTransaction(async (tx) => {
    const [empSnap, secretSnap] = await tx.getAll(employees.doc(employeeNumber), pinSecrets.doc(employeeNumber));
    if (!empSnap.exists) throw new HttpsError("not-found", `No employee ${employeeNumber}.`);
    tx.update(empSnap.ref, { ...changes, updatedAt: FieldValue.serverTimestamp() });
    audit(tx, "updated", employeeNumber, adminNumber, { changes });
    return { employee: { ...empSnap.data(), ...changes }, pinTemp: secretSnap.get("mustChangePin") === true };
  });
  await syncAuthUser(employeeNumber, employee, pinTemp);
  if (changes.active === false) await auth.revokeRefreshTokens(uidFor(employeeNumber));
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Lines, machines, roles ("lines are data, not code" — Plan §5)
//
// Everyone signed in can READ these lists directly (see firestore.rules) — the shop map,
// checklists, and Fix Library all need them. Only admins can CHANGE them, and only through
// these functions, which check the data and write the audit log.
// Nothing is deleted: records are retired (active: false) so history never points at nothing.
// ---------------------------------------------------------------------------

function auditRecord(tx, type, kind, recordId, by, extra = {}) {
  tx.create(auditLog.doc(), { type, kind, recordId, by, at: FieldValue.serverTimestamp(), ...extra });
}

function requireText(value, label, max = 60) {
  const text = records.cleanName(value, max);
  if (!text) throw new HttpsError("invalid-argument", `${label} is required (${max} characters max).`);
  return text;
}

function optionalActive(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpsError("invalid-argument", "active must be true or false.");
  return value;
}

// Shared by roles and lines: create (no id, or a new explicit id) or update (existing id).
async function saveNamedRecord(collection, kind, req, extraCheck) {
  const adminNumber = await requireAdmin(req);
  const name = requireText(req.data?.name, "Name");
  const active = optionalActive(req.data?.active);
  const isNew = req.data?.create === true;
  const id = req.data?.id ? String(req.data.id) : records.idFromName(name);
  if (!records.isRecordId(id)) {
    throw new HttpsError("invalid-argument", "Name must start with a letter (e.g. \"Line 3\", not \"3\").");
  }
  if (extraCheck) extraCheck(id, active);

  await db.runTransaction(async (tx) => {
    const ref = collection.doc(id);
    const snap = await tx.get(ref);
    if (isNew) {
      if (snap.exists) throw new HttpsError("already-exists", `"${name}" already exists.`);
      tx.create(ref, { name, active: active ?? true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      auditRecord(tx, "created", kind, id, adminNumber, { name });
    } else {
      if (!snap.exists) throw new HttpsError("not-found", "That record no longer exists.");
      const changes = { name, updatedAt: FieldValue.serverTimestamp() };
      if (active !== undefined) changes.active = active;
      tx.update(ref, changes);
      auditRecord(tx, "updated", kind, id, adminNumber, { name, ...(active !== undefined ? { active } : {}) });
    }
  });
  return { id };
}

// Roles: create { create: true, name, id? } or update { id, name, active? }.
// The admin role can't be retired — someone has to be able to run the app.
exports.adminSaveRole = onCall((req) =>
  saveNamedRecord(roles, "role", req, (id, active) => {
    if (id === "admin" && active === false) {
      throw new HttpsError("failed-precondition", "The Admin role can't be retired.");
    }
  })
);

// Lines: create { create: true, name } or update { id, name, active? }.
// The id comes from the first name ("Line 3" -> line-3) and never changes, even if the line is renamed.
exports.adminSaveLine = onCall((req) => saveNamedRecord(lines, "line", req));

// Machines: create { create: true, name, type?, lineId? } -> next plant-wide ID (M-001, M-002, ...),
// or update { id, name, type?, lineId?, active? }. lineId null = not on a line (spare, shared, in storage).
exports.adminSaveMachine = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const name = requireText(req.data?.name, "Machine name");
  const type = records.cleanOptional(req.data?.type);
  if (type === null) throw new HttpsError("invalid-argument", "Type is 60 characters max.");
  const lineId = req.data?.lineId ? String(req.data.lineId) : null;
  const active = optionalActive(req.data?.active);
  const isNew = req.data?.create === true;
  if (!isNew && !records.isMachineId(req.data?.id)) throw new HttpsError("invalid-argument", "Unknown machine ID.");

  const id = await db.runTransaction(async (tx) => {
    if (lineId) {
      const line = await tx.get(lines.doc(lineId));
      if (!line.exists) throw new HttpsError("not-found", "That line no longer exists.");
    }
    if (isNew) {
      const counterSnap = await tx.get(counters);
      const next = counterSnap.get("nextMachine") || 1;
      const machineId = records.machineIdFor(next);
      tx.set(counters, { nextMachine: next + 1 }, { merge: true });
      tx.create(machines.doc(machineId), {
        name, type, lineId, active: active ?? true,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      auditRecord(tx, "created", "machine", machineId, adminNumber, { name, lineId });
      return machineId;
    }
    const ref = machines.doc(req.data.id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That machine no longer exists.");
    const changes = { name, type, lineId, updatedAt: FieldValue.serverTimestamp() };
    if (active !== undefined) changes.active = active;
    tx.update(ref, changes);
    auditRecord(tx, "updated", "machine", req.data.id, adminNumber, { name, lineId, ...(active !== undefined ? { active } : {}) });
    return req.data.id;
  });
  return { id };
});

// ---------------------------------------------------------------------------
// Fix Library (Plan Decisions 25–28)
//
// Each fix is its own record in `fixes`. Status: approved | pending | rejected | retired | merged.
// Everyone signed in reads approved fixes (firestore.rules); pending ones only approvers + the author.
// All changes come through these functions, which check the person's LIVE roles — no shared PIN.
// ---------------------------------------------------------------------------

// Signed in with their own PIN, account on. Returns { employeeNumber, roles, approver }.
async function requireMember(req) {
  const employeeNumber = requireSignedIn(req);
  if (req.auth.token.pinTemp === true) throw new HttpsError("permission-denied", "Choose your own PIN first.");
  const snap = await employees.doc(employeeNumber).get();
  if (!snap.exists || snap.get("active") === false) throw new HttpsError("permission-denied", "Your account is turned off.");
  const roles = snap.get("roles") || [];
  return { employeeNumber, roles, approver: fixesLib.isApprover(roles) };
}

function requireFix(data) {
  const { fix, error } = fixesLib.cleanFix(data);
  if (error) throw new HttpsError("invalid-argument", error);
  return fix;
}

// Category must exist and not be retired; pinned machines must exist.
async function checkFixRefs(tx, fix) {
  const cat = await tx.get(fixCategories.doc(fix.categoryId));
  if (!cat.exists || cat.get("active") === false) throw new HttpsError("invalid-argument", "Pick a category from the list.");
  if (fix.machineIds.length) {
    const snaps = await tx.getAll(...fix.machineIds.map((id) => machines.doc(id)));
    const missing = snaps.filter((s) => !s.exists).map((s) => s.id);
    if (missing.length) throw new HttpsError("invalid-argument", `Unknown machine: ${missing.join(", ")}`);
  }
}

const FIX_FIELDS = ["title", "body", "categoryId", "tags", "photos", "videos", "docLink", "machineIds"];

// New fix:   { title, body, categoryId, tags, photos, videos, docLink, machineIds }
// Edit:      same plus { id }.
// Approvers' changes go live. Others: new fixes and edits become pending suggestions
// (an edit to an approved fix is a separate pending record with editOf = the original's id).
exports.submitFix = onCall(async (req) => {
  const me = await requireMember(req);
  const fix = requireFix(req.data);
  const now = FieldValue.serverTimestamp();
  const editId = req.data?.id ? String(req.data.id) : null;

  return db.runTransaction(async (tx) => {
    const original = editId ? await tx.get(fixes.doc(editId)) : null;
    await checkFixRefs(tx, fix);

    if (!editId) {
      const ref = fixes.doc();
      const status = me.approver ? "approved" : "pending";
      tx.create(ref, {
        ...fix, status, editOf: null, helpfulYes: 0, helpfulNo: 0, votes: {},
        createdBy: me.employeeNumber, createdAt: now, updatedAt: now,
        ...(status === "approved" ? { approvedBy: me.employeeNumber, approvedAt: now } : {}),
      });
      auditRecord(tx, "created", "fix", ref.id, me.employeeNumber, { status, title: fix.title });
      return { id: ref.id, status };
    }

    if (!original.exists) throw new HttpsError("not-found", "That fix no longer exists.");
    const o = original.data();
    const ownPending = o.status === "pending" && o.createdBy === me.employeeNumber;
    if (me.approver || ownPending) {
      tx.update(original.ref, { ...fix, updatedBy: me.employeeNumber, updatedAt: now });
      auditRecord(tx, "updated", "fix", editId, me.employeeNumber, { title: fix.title });
      return { id: editId, status: o.status };
    }
    if (o.status !== "approved") throw new HttpsError("permission-denied", "Only approvers can change this fix.");
    const ref = fixes.doc();
    tx.create(ref, {
      ...fix, status: "pending", editOf: editId, helpfulYes: 0, helpfulNo: 0, votes: {},
      createdBy: me.employeeNumber, createdAt: now, updatedAt: now,
    });
    auditRecord(tx, "suggested-edit", "fix", ref.id, me.employeeNumber, { editOf: editId, title: fix.title });
    return { id: ref.id, status: "pending", editOf: editId };
  });
});

// Approvers: { id, approve: true|false }. Approving an edit suggestion copies it onto the original.
exports.reviewFix = onCall(async (req) => {
  const me = await requireMember(req);
  if (!me.approver) throw new HttpsError("permission-denied", "Only Admins can approve fixes.");
  const id = String(req.data?.id || "");
  const approve = req.data?.approve === true;
  const now = FieldValue.serverTimestamp();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(fixes.doc(id));
    if (!snap.exists || snap.get("status") !== "pending") throw new HttpsError("failed-precondition", "That suggestion was already handled.");
    const p = snap.data();
    const original = p.editOf ? await tx.get(fixes.doc(p.editOf)) : null;

    if (!approve) {
      tx.update(snap.ref, { status: "rejected", reviewedBy: me.employeeNumber, reviewedAt: now });
      auditRecord(tx, "rejected", "fix", id, me.employeeNumber, { title: p.title });
      return { id, status: "rejected" };
    }
    if (p.editOf) {
      if (!original.exists) throw new HttpsError("not-found", "The fix this edit was for no longer exists.");
      const fields = Object.fromEntries(FIX_FIELDS.map((k) => [k, p[k]]));
      tx.update(original.ref, { ...fields, updatedBy: p.createdBy, updatedAt: now, approvedBy: me.employeeNumber, approvedAt: now });
      tx.update(snap.ref, { status: "merged", reviewedBy: me.employeeNumber, reviewedAt: now });
      auditRecord(tx, "approved-edit", "fix", p.editOf, me.employeeNumber, { suggestion: id, title: p.title });
      return { id: p.editOf, status: "approved" };
    }
    tx.update(snap.ref, { status: "approved", approvedBy: me.employeeNumber, approvedAt: now, updatedAt: now });
    auditRecord(tx, "approved", "fix", id, me.employeeNumber, { title: p.title });
    return { id, status: "approved" };
  });
});

// Approvers: { id, retire: true|false }. Retired fixes are hidden, never deleted.
exports.retireFix = onCall(async (req) => {
  const me = await requireMember(req);
  if (!me.approver) throw new HttpsError("permission-denied", "Only Admins can retire fixes.");
  const id = String(req.data?.id || "");
  const retire = req.data?.retire !== false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(fixes.doc(id));
    const status = snap.get("status");
    if (!snap.exists || !(retire ? status === "approved" : status === "retired")) {
      throw new HttpsError("failed-precondition", "That fix can't be changed that way.");
    }
    tx.update(snap.ref, { status: retire ? "retired" : "approved", updatedBy: me.employeeNumber, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, retire ? "retired" : "restored", "fix", id, me.employeeNumber, { title: snap.get("title") });
  });
  return { id, status: retire ? "retired" : "approved" };
});

// "Was this helpful?" — { id, helpful: true|false }. One vote per person; voting again changes it.
// Votes carried over from the old library (counts only, no names) are kept on top.
exports.voteFix = onCall(async (req) => {
  const me = await requireMember(req);
  const id = String(req.data?.id || "");
  const helpful = req.data?.helpful === true;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(fixes.doc(id));
    if (!snap.exists || snap.get("status") !== "approved") throw new HttpsError("not-found", "That fix isn't available.");
    const votes = { ...(snap.get("votes") || {}), [me.employeeNumber]: helpful };
    const yes = Object.values(votes).filter(Boolean).length + (snap.get("legacyHelpfulYes") || 0);
    const no = Object.values(votes).filter((v) => !v).length + (snap.get("legacyHelpfulNo") || 0);
    tx.update(snap.ref, { votes, helpfulYes: yes, helpfulNo: no });
    return { helpfulYes: yes, helpfulNo: no };
  });
});

// Admins, one-time (safe to run again): copy the old Line Fix Library into the new app (Decisions 25, 28).
// Reads the old library (read-only — it is never changed), creates fix categories, copies photos/videos
// stored in the old library's Storage into ours, and saves each fix as its own record ("old-<old id>").
// Re-running updates the same records and skips files already copied.
const OLD_LIBRARY_DOC =
  "https://firestore.googleapis.com/v1/projects/line-library/databases/(default)/documents/problems/library";

exports.adminImportOldLibrary = onCall({ timeoutSeconds: 540, memory: "2GiB" }, async (req) => {
  const adminNumber = await requireAdmin(req);

  const res = await fetch(OLD_LIBRARY_DOC);
  if (!res.ok) throw new HttpsError("unavailable", `Couldn't read the old library (HTTP ${res.status}).`);
  const doc = await res.json();
  const items = (fixesLib.plainValue({ mapValue: { fields: doc.fields || {} } }).items || []).filter((i) => i && i.id && i.title);

  // 1. Categories, with the machine types they cover.
  const categoryIds = new Map();
  for (const name of [...new Set(items.map((i) => String(i.category || "General").trim()))]) {
    const id = records.idFromName(name) || `cat-${categoryIds.size + 1}`;
    categoryIds.set(name, id);
    await fixCategories.doc(id).set(
      { name, machineTypes: fixesLib.machineTypesForOldCategory(name), active: true, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  // 2. Files stored in the old library -> our Storage (once per file).
  const bucket = getStorage().bucket();
  const copied = new Map();
  let filesCopied = 0;
  let filesSkipped = 0;
  const fileProblems = [];
  async function copyFile(url) {
    if (!fixesLib.isOldLibraryFile(url)) return url; // SharePoint, YouTube, … stay as links
    if (copied.has(url)) return copied.get(url);
    const file = bucket.file(`fixes/legacy/${fixesLib.oldFileName(url)}`);
    try {
      const [exists] = await file.exists();
      if (exists) {
        filesSkipped++;
      } else {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await file.save(Buffer.from(await r.arrayBuffer()), {
          contentType: r.headers.get("content-type") || undefined,
          resumable: false,
        });
        filesCopied++;
      }
      const newUrl = await getDownloadURL(file);
      copied.set(url, newUrl);
      return newUrl;
    } catch (err) {
      fileProblems.push(`${fixesLib.oldFileName(url)}: ${err.message}`);
      return url; // keep the old link so nothing is lost; re-run to try again
    }
  }

  // 3. Each fix as its own record. Only the old library's approved fixes come over.
  let fixesSaved = 0;
  for (const it of items.filter((i) => (i.status || "approved") === "approved")) {
    const photos = [];
    for (const u of (it.photoLinks || []).filter(Boolean)) photos.push(await copyFile(u));
    const videos = [];
    for (const u of (it.videoLinks || []).filter(Boolean)) videos.push(await copyFile(u));
    const docLink = it.docLink ? await copyFile(it.docLink) : "";
    const added = Number(it.addedAt) || Date.now();
    const updated = Number(it.updatedAt) || added;
    const ref = fixes.doc(`old-${String(it.id).replace(/[^A-Za-z0-9_-]/g, "_")}`);
    // Votes start from the old library's counts only the first time; a re-run never resets new votes.
    const firstTime = !(await ref.get()).exists;
    const votesStart = firstTime
      ? { helpfulYes: Number(it.helpfulYes) || 0, helpfulNo: Number(it.helpfulNo) || 0, votes: {} }
      : {};
    await ref.set(
      {
        title: String(it.title).slice(0, 120),
        body: String(it.body || "").slice(0, 10000),
        categoryId: categoryIds.get(String(it.category || "General").trim()),
        tags: (it.tags || []).map(String).slice(0, 20),
        photos, videos, docLink,
        machineIds: [],
        status: "approved",
        editOf: null,
        legacyId: it.id,
        legacyHelpfulYes: Number(it.helpfulYes) || 0,
        legacyHelpfulNo: Number(it.helpfulNo) || 0,
        ...votesStart,
        createdBy: "old-library",
        createdAt: new Date(added),
        updatedAt: new Date(updated),
        importedBy: adminNumber,
        importedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    fixesSaved++;
  }

  // 4. The old library's "searches with no results" log.
  let searchGapsCopied = 0;
  const gapsRes = await fetch(OLD_LIBRARY_DOC.replace(/library$/, "searchGaps"));
  if (gapsRes.ok) {
    const gapsDoc = await gapsRes.json();
    const entries = fixesLib.plainValue({ mapValue: { fields: gapsDoc.fields || {} } }).entries || [];
    for (const g of entries) {
      const term = fixesLib.cleanSearchTerm(g?.term);
      if (!term) continue;
      const gapRef = searchGaps.doc(fixesLib.searchGapId(term));
      if ((await gapRef.get()).exists) continue; // already copied (or already logged here) — keep ours
      await gapRef.set({
        term,
        count: Number(g.count) || 1,
        firstAt: new Date(Number(g.firstSearchedAt) || Date.now()),
        lastAt: new Date(Number(g.lastSearchedAt) || Date.now()),
        done: false,
      });
      searchGapsCopied++;
    }
  }

  await auditLog.add({
    type: "imported", kind: "fix", recordId: "old-library", by: adminNumber, at: FieldValue.serverTimestamp(),
    fixesSaved, categories: categoryIds.size, filesCopied, filesSkipped, fileProblems: fileProblems.length, searchGapsCopied,
  });
  return { fixesSaved, categories: categoryIds.size, filesCopied, filesSkipped, fileProblems, searchGapsCopied };
});

// Searches that found no fixes (like the old library): { term }. Anyone signed in; the app sends it
// once per search, 1.5 s after typing stops. Admins read the list (firestore.rules) to see what's missing.
exports.logSearchGap = onCall(async (req) => {
  await requireMember(req);
  const term = fixesLib.cleanSearchTerm(req.data?.term);
  if (!term) return { ok: false };
  const ref = searchGaps.doc(fixesLib.searchGapId(term));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      // Searched again: count it, and bring it back if it had been marked done (the fix still isn't found).
      tx.update(ref, { count: FieldValue.increment(1), lastAt: FieldValue.serverTimestamp(), done: false });
    } else {
      tx.create(ref, { term, count: 1, firstAt: FieldValue.serverTimestamp(), lastAt: FieldValue.serverTimestamp(), done: false });
    }
  });
  return { ok: true };
});

// Admins: { id, done: true|false } — tick off a no-results search once the missing fix is written.
exports.adminMarkSearchGap = onCall(async (req) => {
  await requireAdmin(req);
  const ref = searchGaps.doc(String(req.data?.id || ""));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "That search is no longer on the list.");
  await ref.update({ done: req.data?.done !== false });
  return { ok: true };
});

// Admins: add many fixes at once, like the old library's bulk add ("### Title" blocks).
// { items: [{ title, category, tags, body, photos, videos, docLink }] } — category by NAME; a new
// category name creates the category. Everything added this way is approved. 200 per call.
exports.adminBulkAddFixes = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const items = Array.isArray(req.data?.items) ? req.data.items : [];
  if (!items.length || items.length > 200) throw new HttpsError("invalid-argument", "Add between 1 and 200 fixes at a time.");

  // Check every fix first, so nothing is half-added because of one bad block.
  const catDocs = (await fixCategories.get()).docs;
  const catIdByName = new Map(catDocs.map((d) => [String(d.get("name")).toLowerCase(), d.id]));
  const existingIds = new Set(catDocs.map((d) => d.id));
  const prepared = items.map((it, i) => {
    let categoryName = records.cleanName(it?.category || "General") || "General";
    let categoryId = catIdByName.get(categoryName.toLowerCase()) || records.idFromName(categoryName);
    // "Die!" or "die" → the existing "Die" category, never a rename of it.
    if (existingIds.has(categoryId)) categoryName = catDocs.find((d) => d.id === categoryId).get("name");
    if (!categoryId) throw new HttpsError("invalid-argument", `Fix ${i + 1}: category "${categoryName}" must start with a letter.`);
    const { fix, error } = fixesLib.cleanFix({ ...it, categoryId, machineIds: [] });
    if (error) throw new HttpsError("invalid-argument", `Fix ${i + 1} ("${String(it?.title || "").slice(0, 40)}"): ${error}`);
    return { fix, categoryName };
  });

  const batch = db.batch();
  const now = FieldValue.serverTimestamp();
  const newCategories = new Set();
  for (const { fix, categoryName } of prepared) {
    if (!existingIds.has(fix.categoryId) && !newCategories.has(fix.categoryId)) {
      newCategories.add(fix.categoryId);
      batch.set(fixCategories.doc(fix.categoryId), {
        name: categoryName, machineTypes: fixesLib.machineTypesForOldCategory(categoryName), active: true, updatedAt: now,
      }, { merge: true });
    }
    batch.create(fixes.doc(), {
      ...fix, status: "approved", editOf: null, helpfulYes: 0, helpfulNo: 0, votes: {},
      createdBy: adminNumber, createdAt: now, updatedAt: now, approvedBy: adminNumber, approvedAt: now,
    });
  }
  batch.create(auditLog.doc(), { type: "bulk-added", kind: "fix", recordId: "bulk", by: adminNumber, at: now, count: prepared.length });
  await batch.commit();
  return { added: prepared.length, newCategories: [...newCategories] };
});
