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
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const pin = require("./pin");
const records = require("./records");

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
