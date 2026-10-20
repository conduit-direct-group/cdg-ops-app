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
const odoo = require("./odoo");
const checklistsLib = require("./checklists");
const requestsLib = require("./requests");
const floorMapLib = require("./floormap");
const trainingApi = require("./training-api");
const annLib = require("./announcements");
const crypto = require("node:crypto");
const { getMessaging } = require("firebase-admin/messaging");
const { defineSecret } = require("firebase-functions/params");
const { onSchedule } = require("firebase-functions/v2/scheduler");

// Odoo API key (Google Secret Manager). Set with `firebase functions:secrets:set ODOO_API_KEY`.
const odooKey = defineSecret("ODOO_API_KEY");

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
const teams = db.collection("teams");
const shifts = db.collection("shifts");
const machineTypes = db.collection("machineTypes");
const counters = db.collection("meta").doc("counters");
const fixes = db.collection("fixes");
const fixCategories = db.collection("fixCategories");
const searchGaps = db.collection("searchGaps");
const issues = db.collection("issues");
const odooSyncStatus = db.collection("meta").doc("odooSync");
const checklistTemplates = db.collection("checklistTemplates");

// Our Storage bucket (photos, videos, documents). Public name, same as in the web config.
const BUCKET = "cdg-ops-app.firebasestorage.app";

// Test mode: the dev test site sends { test: true }. Its reports, fixes, checklist sign-offs, and trash go
// into test_ collections that the live app never reads, and nothing is sent to Odoo.
// Test mode can't be skipped: anything not sent from the live site's own address is test mode, whatever the
// request says. (Only the live site, https://cdg-ops.netlify.app, can create real Odoo requests and records.)
const LIVE_ORIGIN = "https://cdg-ops.netlify.app";
function isTest(req) {
  const origin = String(req.rawRequest?.headers?.origin || "");
  return req.data?.test === true || origin !== LIVE_ORIGIN;
}
function col(name, test) {
  return db.collection(test ? `test_${name}` : name);
}

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

// Team (Admin → Teams) and home line (Admin → Lines & machines): optional; when set, must exist and be on.
async function optionalRef(collection, value, label) {
  if (value == null || value === "") return null;
  const id = String(value);
  const snap = await collection.doc(id).get();
  if (!snap.exists || snap.get("active") === false) throw new HttpsError("invalid-argument", `Pick a ${label} from the list.`);
  return id;
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
      position: e.position || "",
      suggestedRoles: e.suggestedRoles || [],
      rolesConfirmed: e.rolesConfirmed !== false,
      loginEnabled: secrets.has(d.id),
      team: e.team || null,
      shift: e.shift || null,
      homeLineId: e.homeLineId || null,
      trainingName: e.trainingName || null,
      active: e.active !== false,
      mustChangePin: s.mustChangePin === true,
      locked: lock.locked,
      minutesLeft: lock.minutesLeft || 0,
    };
  });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { employees: list, nextNumber: records.nextEmployeeNumber(empSnaps.docs.map((d) => d.id)) };
});

// Adds a person. Returns a temporary PIN for the admin to give them.
exports.adminCreateEmployee = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const employeeNumber = requireEmployeeNumber(req.data?.employeeNumber);
  const employee = {
    name: requireName(req.data?.name), roles: await requireRoles(req.data?.roles), active: true,
    team: await optionalRef(teams, req.data?.team, "team"), shift: await optionalRef(shifts, req.data?.shift, "shift"),
    homeLineId: await optionalRef(lines, req.data?.homeLineId, "line"),
  };
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
  await refreshAnnouncementLists(); // kept-for-new-hires announcements reach them from day one
  return { employeeNumber, tempPin };
});

// New temporary PIN, lockout cleared, signed out on every device (e.g. forgotten PIN or lost phone).
exports.adminResetPin = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const employeeNumber = requireEmployeeNumber(req.data?.employeeNumber);
  const tempPin = pin.randomTempPin();
  const hashed = await pin.hashPin(tempPin);

  const employee = await db.runTransaction(async (tx) => {
    const [snap, secret] = await tx.getAll(employees.doc(employeeNumber), pinSecrets.doc(employeeNumber));
    if (!snap.exists) throw new HttpsError("not-found", `No employee ${employeeNumber}.`);
    if (!secret.exists) throw new HttpsError("failed-precondition", "This person doesn't have login yet. Use Enable login.");
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
  if (req.data?.roles !== undefined) {
    changes.roles = await requireRoles(req.data.roles);
    changes.rolesConfirmed = true;
  }
  if (req.data?.position !== undefined) {
    changes.position = records.cleanOptional(req.data.position, 80);
    if (changes.position === null) throw new HttpsError("invalid-argument", "Position is 80 characters max.");
  }
  if (req.data?.team !== undefined) changes.team = await optionalRef(teams, req.data.team, "team");
  if (req.data?.shift !== undefined) changes.shift = await optionalRef(shifts, req.data.shift, "shift");
  if (req.data?.homeLineId !== undefined) changes.homeLineId = await optionalRef(lines, req.data.homeLineId, "line");
  // Their entry on the training roster (by name), so their own training reminders show on Home.
  if (req.data?.trainingName !== undefined) {
    changes.trainingName = req.data.trainingName ? records.cleanOptional(req.data.trainingName, 60) : null;
    if (req.data.trainingName && !changes.trainingName) throw new HttpsError("invalid-argument", "Pick a name from the training roster.");
  }
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
  if (changes.roles || changes.team !== undefined || changes.homeLineId !== undefined || changes.active === true) await refreshAnnouncementLists();
  return { ok: true };
});

// Admins: people from a payroll list (e.g. Gusto), with NO login — no PIN, nobody can sign in until an
// admin taps Enable login. Only name and position are stored, plus a suggested role to confirm.
// { people: [{ employeeNumber, name, position, suggestedRoles }] } — all or nothing.
exports.adminImportEmployees = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const list = Array.isArray(req.data?.people) ? req.data.people : [];
  if (!list.length || list.length > 300) throw new HttpsError("invalid-argument", "Import between 1 and 300 people at a time.");
  const known = new Set((await roles.get()).docs.map((d) => d.id));
  const people = list.map((p, i) => {
    const employeeNumber = pin.normalizeEmployeeNumber(p?.employeeNumber);
    const name = pin.normalizeName(p?.name);
    const position = records.cleanOptional(p?.position, 80);
    if (!employeeNumber || !name || position === null) throw new HttpsError("invalid-argument", `Row ${i + 1}: number, name, or position isn't valid.`);
    const suggestedRoles = Array.isArray(p?.suggestedRoles) ? p.suggestedRoles.filter((r) => known.has(r)) : [];
    return { employeeNumber, name, position, suggestedRoles };
  });
  if (new Set(people.map((p) => p.employeeNumber)).size !== people.length) throw new HttpsError("invalid-argument", "An employee number is listed twice.");
  await db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(...people.map((p) => employees.doc(p.employeeNumber)));
    const taken = snaps.filter((x) => x.exists).map((x) => x.id);
    if (taken.length) throw new HttpsError("already-exists", `Already in the app: ${taken.join(", ")}. Nothing was imported.`);
    for (const p of people) {
      tx.create(employees.doc(p.employeeNumber), {
        name: p.name, position: p.position, roles: [], suggestedRoles: p.suggestedRoles, rolesConfirmed: false,
        team: null, shift: null, homeLineId: null, active: true, importedFrom: "gusto",
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.create(auditLog.doc(), { type: "imported", kind: "people", recordId: "gusto", by: adminNumber, at: FieldValue.serverTimestamp(), count: people.length });
  });
  await refreshAnnouncementLists();
  return { imported: people.length };
});

// Admins: { employeeNumber } — turn on login for someone imported without it. Their roles must be
// confirmed first. Returns a temporary PIN (shown once); they pick their own at first sign-in.
exports.adminEnableLogin = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const employeeNumber = requireEmployeeNumber(req.data?.employeeNumber);
  const tempPin = pin.randomTempPin();
  const hashed = await pin.hashPin(tempPin);
  const employee = await db.runTransaction(async (tx) => {
    const [snap, secret] = await tx.getAll(employees.doc(employeeNumber), pinSecrets.doc(employeeNumber));
    if (!snap.exists) throw new HttpsError("not-found", `No employee ${employeeNumber}.`);
    if (secret.exists) throw new HttpsError("failed-precondition", "Login is already on. Use Reset PIN instead.");
    if (snap.get("active") === false) throw new HttpsError("failed-precondition", "Turn the account back on first.");
    if (snap.get("rolesConfirmed") === false || !(snap.get("roles") || []).length) {
      throw new HttpsError("failed-precondition", "Confirm their role first (Edit → pick roles → Save).");
    }
    tx.set(pinSecrets.doc(employeeNumber), newPinRecord(hashed, true));
    audit(tx, "login-enabled", employeeNumber, adminNumber);
    return snap.data();
  });
  await syncAuthUser(employeeNumber, employee, true);
  return { employeeNumber, tempPin };
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
async function saveNamedRecord(collection, kind, req, extraCheck, extraFields = () => ({})) {
  const adminNumber = await requireAdmin(req);
  const name = requireText(req.data?.name, "Name");
  const extra = extraFields(req.data || {});
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
      tx.create(ref, { name, ...extra, active: active ?? true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      auditRecord(tx, "created", kind, id, adminNumber, { name, ...extra });
    } else {
      if (!snap.exists) throw new HttpsError("not-found", "That record no longer exists.");
      const changes = { name, ...extra, updatedAt: FieldValue.serverTimestamp() };
      if (active !== undefined) changes.active = active;
      tx.update(ref, changes);
      auditRecord(tx, "updated", kind, id, adminNumber, { name, ...extra, ...(active !== undefined ? { active } : {}) });
    }
  });
  return { id };
}

// Roles: create { create: true, name, id? } or update { id, name, active? }.
// The admin role can't be retired — someone has to be able to run the app.
// Optional { canPostAnnouncements: true|false } (Admin → Roles); left out = unchanged.
exports.adminSaveRole = onCall((req) =>
  saveNamedRecord(roles, "role", req, (id, active) => {
    if (id === "admin" && active === false) {
      throw new HttpsError("failed-precondition", "The Admin role can't be retired.");
    }
  }, (d) => {
    if (d.canPostAnnouncements === undefined) return {};
    if (typeof d.canPostAnnouncements !== "boolean") throw new HttpsError("invalid-argument", "canPostAnnouncements must be true or false.");
    return { canPostAnnouncements: d.canPostAnnouncements };
  })
);

// Lines: create { create: true, name } or update { id, name, active? }.
// The id comes from the first name ("Line 3" -> line-3) and never changes, even if the line is renamed.
// Lines: create { create: true, name, building? } or update { id, name, building?, active? }.
exports.adminSaveLine = onCall((req) =>
  saveNamedRecord(lines, "line", req, null, (d) => {
    if (d.building === undefined) return {};
    const building = records.cleanOptional(d.building);
    if (building === null) throw new HttpsError("invalid-argument", "Building is 60 characters max.");
    return { building };
  })
);

// Teams (A, B, C, D, …): create { create: true, name } or update { id, name, active? }.
exports.adminSaveTeam = onCall((req) => saveNamedRecord(teams, "team", req));

// Shifts (e.g. Days, Nights): create { create: true, name } or update { id, name, active? }.
exports.adminSaveShift = onCall((req) => saveNamedRecord(shifts, "shift", req));

// Machine types: create { create: true, name } or { id, active } to retire / bring back.
// A type's name never changes — machines, fix categories, and checklists match on it.
exports.adminSaveMachineType = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const active = optionalActive(req.data?.active);
  if (req.data?.create === true) {
    const name = requireText(req.data?.name, "Type name");
    const id = records.idFromName(name);
    if (!id) throw new HttpsError("invalid-argument", "Type name must start with a letter.");
    await db.runTransaction(async (tx) => {
      const all = await tx.get(machineTypes);
      if (all.docs.some((d) => d.id === id || String(d.get("name")).toLowerCase() === name.toLowerCase())) {
        throw new HttpsError("already-exists", `"${name}" is already on the list.`);
      }
      tx.create(machineTypes.doc(id), { name, active: true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      auditRecord(tx, "created", "machine type", id, adminNumber, { name });
    });
    return { id };
  }
  const ref = machineTypes.doc(String(req.data?.id || ""));
  if (active === undefined) throw new HttpsError("invalid-argument", "Nothing to change.");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That type no longer exists.");
    tx.update(ref, { active, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, active ? "restored" : "retired", "machine type", ref.id, adminNumber, { name: snap.get("name") });
  });
  return { id: ref.id };
});

// Machines: create { create: true, name, type?, lineId? } -> next plant-wide ID (M-001, M-002, ...),
// or update { id, name, type?, lineId?, active? }. lineId null = not on a line (spare, shared, in storage).
exports.adminSaveMachine = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const name = requireText(req.data?.name, "Machine name");
  const type = records.cleanOptional(req.data?.type);
  if (type === null) throw new HttpsError("invalid-argument", "Type is 60 characters max.");
  const details = {};
  for (const [key, label, max] of [["make", "Make", 60], ["model", "Model", 60], ["serial", "Serial number", 60]]) {
    if (req.data?.[key] === undefined) continue;
    details[key] = records.cleanOptional(req.data[key], max);
    if (details[key] === null) throw new HttpsError("invalid-argument", `${label} is ${max} characters max.`);
  }
  if (req.data?.notes !== undefined) {
    details.notes = records.cleanNotes(req.data.notes);
    if (details.notes === null) throw new HttpsError("invalid-argument", "Notes are 1,000 characters max.");
  }
  const typeList = (await machineTypes.get()).docs.map((d) => d.data());
  if (typeList.length && type && !typeList.some((t) => t.name === type)) {
    throw new HttpsError("invalid-argument", `"${type}" isn't on the Machine types list. Add it in Admin → Machine types first.`);
  }
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
        name, type, lineId, ...details, active: active ?? true,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      auditRecord(tx, "created", "machine", machineId, adminNumber, { name, lineId });
      return machineId;
    }
    const ref = machines.doc(req.data.id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That machine no longer exists.");
    const changes = { name, type, lineId, ...details, updatedAt: FieldValue.serverTimestamp() };
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
// Each fix is its own record in `fixes`. Status: approved | pending | rejected | retired | merged | trashed.
// Everyone signed in reads approved fixes (firestore.rules); pending ones only admins + the author.
// All changes come through these functions, which check the person's LIVE roles — no shared PIN.
//
// Safety net (nothing is lost by a bad edit or delete):
//   - Before every change, the fix as it was is saved in fixes/{id}/versions (admins can restore any of them).
//   - Delete moves a fix to the trash bin (status "trashed") for 30 days; admins can bring it back.
//   - Our own photos/videos/documents taken off a fix go to the `trash` list for 30 days, then purgeTrash
//     removes them for good (only if no fix or checklist still uses them).
//
// Test mode (the dev test site sends test: true): everything is saved in test_ collections the live app
// never reads, and real records can't be changed.
// ---------------------------------------------------------------------------

// Signed in with their own PIN, account on. Returns { employeeNumber, roles, approver }.
async function requireMember(req) {
  const employeeNumber = requireSignedIn(req);
  if (req.auth.token.pinTemp === true) throw new HttpsError("permission-denied", "Choose your own PIN first.");
  const snap = await employees.doc(employeeNumber).get();
  if (!snap.exists || snap.get("active") === false) throw new HttpsError("permission-denied", "Your account is turned off.");
  const roles = snap.get("roles") || [];
  return { employeeNumber, roles, approver: fixesLib.isApprover(roles), name: snap.get("name") || `Employee ${employeeNumber}` };
}

async function requireApprover(req, what) {
  const me = await requireMember(req);
  if (!me.approver) throw new HttpsError("permission-denied", `Only Admins can ${what}.`);
  return me;
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

// Reads a fix for a change. On the test site, real fixes are read-only.
async function getFixForChange(tx, test, id) {
  const snap = await tx.get(col("fixes", test).doc(id));
  if (snap.exists) return snap;
  if (test && (await tx.get(fixes.doc(id))).exists) {
    throw new HttpsError("failed-precondition", "This is the test site — real fixes can't be changed here. Add a test fix to try this.");
  }
  throw new HttpsError("not-found", "That fix no longer exists.");
}

// Saves the fix as it is now, before it changes.
function saveVersion(tx, ref, fixData, by, reason) {
  tx.create(ref.collection("versions").doc(), { ...fixesLib.versionOf(fixData), savedAt: FieldValue.serverTimestamp(), savedBy: by, reason });
}

function purgeDate() {
  return new Date(Date.now() + fixesLib.TRASH_DAYS * 86400000);
}

// Our own files that came off a fix go to the trash list (kept 30 days).
function trashDroppedFiles(tx, test, before, after, fixId, by) {
  for (const url of fixesLib.droppedFiles(before, after, BUCKET)) {
    tx.create(col("trash", test).doc(), {
      kind: "file", url, path: fixesLib.storagePath(url, BUCKET), fixId, title: before.title || "",
      trashedBy: by, trashedAt: FieldValue.serverTimestamp(), purgeAfter: purgeDate(),
    });
  }
}

// New fix:   { title, body, categoryId, tags, photos, videos, docLink, machineIds, test? }
// Edit:      same plus { id }.
// Approvers' changes go live. Others: new fixes and edits become pending suggestions
// (an edit to an approved fix is a separate pending record with editOf = the original's id).
exports.submitFix = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const fix = requireFix(req.data);
  const now = FieldValue.serverTimestamp();
  const editId = req.data?.id ? String(req.data.id) : null;
  const list = col("fixes", test);

  return db.runTransaction(async (tx) => {
    const original = editId ? await getFixForChange(tx, test, editId) : null;
    await checkFixRefs(tx, fix);

    if (!editId) {
      const ref = list.doc();
      const status = me.approver ? "approved" : "pending";
      tx.create(ref, {
        ...fix, status, editOf: null, helpfulYes: 0, helpfulNo: 0, votes: {},
        createdBy: me.employeeNumber, createdAt: now, updatedAt: now,
        ...(test ? { test: true } : {}),
        ...(status === "approved" ? { approvedBy: me.employeeNumber, approvedAt: now } : {}),
      });
      auditRecord(tx, "created", "fix", ref.id, me.employeeNumber, { status, title: fix.title, test });
      return { id: ref.id, status };
    }

    const o = original.data();
    if (o.status === "trashed") throw new HttpsError("failed-precondition", "That fix is in the trash. Bring it back first.");
    const ownPending = o.status === "pending" && o.createdBy === me.employeeNumber;
    if (me.approver || ownPending) {
      saveVersion(tx, original.ref, o, me.employeeNumber, "edited");
      trashDroppedFiles(tx, test, o, fix, editId, me.employeeNumber);
      tx.update(original.ref, { ...fix, updatedBy: me.employeeNumber, updatedAt: now });
      auditRecord(tx, "updated", "fix", editId, me.employeeNumber, { title: fix.title, test });
      return { id: editId, status: o.status };
    }
    if (o.status !== "approved") throw new HttpsError("permission-denied", "Only Admins can change this fix.");
    const ref = list.doc();
    tx.create(ref, {
      ...fix, status: "pending", editOf: editId, helpfulYes: 0, helpfulNo: 0, votes: {},
      createdBy: me.employeeNumber, createdAt: now, updatedAt: now,
      ...(test ? { test: true } : {}),
    });
    auditRecord(tx, "suggested-edit", "fix", ref.id, me.employeeNumber, { editOf: editId, title: fix.title, test });
    return { id: ref.id, status: "pending", editOf: editId };
  });
});

// Admins: { id, approve: true|false }. Approving an edit suggestion copies it onto the original.
exports.reviewFix = onCall(async (req) => {
  const me = await requireApprover(req, "approve fixes");
  const test = isTest(req);
  const id = String(req.data?.id || "");
  const approve = req.data?.approve === true;
  const now = FieldValue.serverTimestamp();

  return db.runTransaction(async (tx) => {
    const snap = await getFixForChange(tx, test, id);
    if (snap.get("status") !== "pending") throw new HttpsError("failed-precondition", "That suggestion was already handled.");
    const p = snap.data();
    const original = p.editOf ? await tx.get(col("fixes", test).doc(p.editOf)) : null;

    if (!approve) {
      tx.update(snap.ref, { status: "rejected", reviewedBy: me.employeeNumber, reviewedAt: now });
      auditRecord(tx, "rejected", "fix", id, me.employeeNumber, { title: p.title, test });
      return { id, status: "rejected" };
    }
    if (p.editOf) {
      if (!original.exists) throw new HttpsError("not-found", "The fix this edit was for no longer exists.");
      const fields = Object.fromEntries(FIX_FIELDS.map((k) => [k, p[k]]));
      saveVersion(tx, original.ref, original.data(), me.employeeNumber, "approved a suggested change");
      trashDroppedFiles(tx, test, original.data(), fields, p.editOf, me.employeeNumber);
      tx.update(original.ref, { ...fields, updatedBy: p.createdBy, updatedAt: now, approvedBy: me.employeeNumber, approvedAt: now });
      tx.update(snap.ref, { status: "merged", reviewedBy: me.employeeNumber, reviewedAt: now });
      auditRecord(tx, "approved-edit", "fix", p.editOf, me.employeeNumber, { suggestion: id, title: p.title, test });
      return { id: p.editOf, status: "approved" };
    }
    tx.update(snap.ref, { status: "approved", approvedBy: me.employeeNumber, approvedAt: now, updatedAt: now });
    auditRecord(tx, "approved", "fix", id, me.employeeNumber, { title: p.title, test });
    return { id, status: "approved" };
  });
});

// Admins: { id, retire: true|false }. Retired fixes are hidden, never deleted.
exports.retireFix = onCall(async (req) => {
  const me = await requireApprover(req, "retire fixes");
  const test = isTest(req);
  const id = String(req.data?.id || "");
  const retire = req.data?.retire !== false;
  await db.runTransaction(async (tx) => {
    const snap = await getFixForChange(tx, test, id);
    const status = snap.get("status");
    if (!(retire ? status === "approved" : status === "retired")) {
      throw new HttpsError("failed-precondition", "That fix can't be changed that way.");
    }
    saveVersion(tx, snap.ref, snap.data(), me.employeeNumber, retire ? "retired" : "brought back");
    tx.update(snap.ref, { status: retire ? "retired" : "approved", updatedBy: me.employeeNumber, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, retire ? "retired" : "restored", "fix", id, me.employeeNumber, { title: snap.get("title"), test });
  });
  return { id, status: retire ? "retired" : "approved" };
});

// Admins: { id } — to the trash bin for 30 days (then gone for good). Any status except already trashed.
exports.deleteFix = onCall(async (req) => {
  const me = await requireApprover(req, "delete fixes");
  const test = isTest(req);
  const id = String(req.data?.id || "");
  await db.runTransaction(async (tx) => {
    const snap = await getFixForChange(tx, test, id);
    const status = snap.get("status");
    if (status === "trashed") throw new HttpsError("failed-precondition", "That fix is already in the trash.");
    saveVersion(tx, snap.ref, snap.data(), me.employeeNumber, "deleted");
    tx.update(snap.ref, {
      status: "trashed", statusBeforeTrash: status, trashedBy: me.employeeNumber,
      trashedAt: FieldValue.serverTimestamp(), purgeAfter: purgeDate(),
    });
    auditRecord(tx, "deleted", "fix", id, me.employeeNumber, { title: snap.get("title"), test });
  });
  return { id, status: "trashed" };
});

// Admins: { id } — out of the trash, back to how it was.
exports.restoreFix = onCall(async (req) => {
  const me = await requireApprover(req, "restore fixes");
  const test = isTest(req);
  const id = String(req.data?.id || "");
  return db.runTransaction(async (tx) => {
    const snap = await getFixForChange(tx, test, id);
    if (snap.get("status") !== "trashed") throw new HttpsError("failed-precondition", "That fix isn't in the trash.");
    const status = snap.get("statusBeforeTrash") || "approved";
    tx.update(snap.ref, {
      status, statusBeforeTrash: FieldValue.delete(), trashedBy: FieldValue.delete(), trashedAt: FieldValue.delete(),
      purgeAfter: FieldValue.delete(), updatedBy: me.employeeNumber, updatedAt: FieldValue.serverTimestamp(),
    });
    auditRecord(tx, "restored-from-trash", "fix", id, me.employeeNumber, { title: snap.get("title"), test });
    return { id, status };
  });
});

// Admins: { id, versionId } — put a fix back the way it was in one of its saved versions.
// (What it looks like now is saved as a version first, so this can be undone too.)
exports.restoreFixVersion = onCall(async (req) => {
  const me = await requireApprover(req, "restore old versions");
  const test = isTest(req);
  const id = String(req.data?.id || "");
  const versionId = String(req.data?.versionId || "");
  return db.runTransaction(async (tx) => {
    const snap = await getFixForChange(tx, test, id);
    const v = await tx.get(snap.ref.collection("versions").doc(versionId));
    if (!v.exists) throw new HttpsError("not-found", "That version no longer exists.");
    const current = snap.data();
    if (current.status === "trashed") throw new HttpsError("failed-precondition", "Bring the fix back from the trash first.");
    const old = v.data();
    const fields = Object.fromEntries(FIX_FIELDS.map((k) => [k, old[k] ?? (k === "docLink" ? "" : [])]));
    // Status only goes back between live states (approved / retired); suggestions keep their own status.
    const status = ["approved", "retired"].includes(current.status) && ["approved", "retired"].includes(old.status) ? old.status : current.status;
    saveVersion(tx, snap.ref, current, me.employeeNumber, "before restoring an older version");
    trashDroppedFiles(tx, test, current, fields, id, me.employeeNumber);
    tx.update(snap.ref, { ...fields, status, updatedBy: me.employeeNumber, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "restored-version", "fix", id, me.employeeNumber, { versionId, title: old.title, test });
    return { id, status };
  });
});

// Admins: { trashId } — put a photo/video/document from the trash back on its fix.
exports.restoreTrashedFile = onCall(async (req) => {
  const me = await requireApprover(req, "restore files");
  const test = isTest(req);
  const trashRef = col("trash", test).doc(String(req.data?.trashId || ""));
  return db.runTransaction(async (tx) => {
    const t = await tx.get(trashRef);
    if (!t.exists || t.get("kind") !== "file") throw new HttpsError("not-found", "That file is no longer in the trash.");
    const url = t.get("url");
    const isVideo = /\.(mov|mp4|m4v|webm)$/i.test(t.get("path") || "");

    // A checklist item's training photo/video.
    if (t.get("templateId")) {
      const tRef = checklistTemplates.doc(t.get("templateId"));
      const tSnap = await tx.get(tRef);
      const items = tSnap.exists ? tSnap.get("items") || [] : [];
      const item = items.find((i) => i.id === t.get("itemId"));
      if (!item) throw new HttpsError("not-found", "The checklist item this file was on no longer exists.");
      const kind = isVideo ? "videos" : "photos";
      item[kind] = [...new Set([...(item[kind] || []), url])];
      tx.update(tRef, { items, updatedAt: FieldValue.serverTimestamp() });
      tx.delete(trashRef);
      auditRecord(tx, "restored-file", "checklist", tRef.id, me.employeeNumber, { path: t.get("path") });
      return { templateId: tRef.id };
    }

    const fixSnap = await tx.get(col("fixes", test).doc(t.get("fixId")));
    if (!fixSnap.exists) throw new HttpsError("not-found", "The fix this file was on no longer exists.");
    const f = fixSnap.data();
    const isPdf = /\.pdf$/i.test(t.get("path") || "");
    saveVersion(tx, fixSnap.ref, f, me.employeeNumber, "put a file back");
    const update = isPdf ? { docLink: url } : isVideo ? { videos: [...(f.videos || []), url] } : { photos: [...(f.photos || []), url] };
    tx.update(fixSnap.ref, { ...update, updatedBy: me.employeeNumber, updatedAt: FieldValue.serverTimestamp() });
    tx.delete(trashRef);
    auditRecord(tx, "restored-file", "fix", fixSnap.id, me.employeeNumber, { path: t.get("path"), test });
    return { id: fixSnap.id };
  });
});

// "Was this helpful?" — { id, helpful: true|false }. One vote per person; voting again changes it.
// Votes carried over from the old library (counts only, no names) are kept on top.
exports.voteFix = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const id = String(req.data?.id || "");
  return db.runTransaction(async (tx) => {
    const snap = await getFixForChange(tx, test, id);
    if (snap.get("status") !== "approved") throw new HttpsError("not-found", "That fix isn't available.");
    const votes = { ...(snap.get("votes") || {}), [me.employeeNumber]: req.data?.helpful === true };
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
  if (isTest(req)) return { ok: true }; // test-site searches aren't counted
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
  const adminNumber = await requireAdmin(req);
  const ref = searchGaps.doc(String(req.data?.id || ""));
  const done = req.data?.done !== false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That search is no longer on the list.");
    tx.update(ref, { done });
    auditRecord(tx, done ? "marked-done" : "marked-not-done", "search", ref.id, adminNumber, { term: snap.get("term") });
  });
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

// ---------------------------------------------------------------------------
// Open issues + last maintenance dates, with Odoo as the source of truth (Plan Phase 2)
//
// - reportProblem: a problem reported in the app becomes an Odoo maintenance request (real fields,
//   linked to the machine's Odoo equipment by its M-number), and shows on the open-issues board.
// - markIssueFixed (Maintenance, Admin): moves the Odoo request to its "done" stage (Repaired).
// - syncOdoo (every 5 minutes): board = all open corrective requests in Odoo; each machine's last PM /
//   last repair = latest closed request of each kind.
// ---------------------------------------------------------------------------

const FIXER_ROLES = ["maintenance", "admin"];

// Plant status bar (Home, everyone): which lines have an open line-down Maintenance Request, since when.
// A small summary everyone can read (the issues themselves stay Maintenance/Admin/Plant Manager only).
//   meta/plantStatus  { down: { [lineId]: { since: ms, machineIds: [] } }, updatedAt }   (test site: test_meta)
async function writePlantStatus(test) {
  try {
    const [open, machineSnaps] = await Promise.all([col("issues", test).where("open", "==", true).get(), machines.get()]);
    const lineOf = new Map(machineSnaps.docs.map((m) => [m.id, m.get("lineId") || null]));
    const lineIds = new Set((await lines.get()).docs.filter((l) => l.get("active") !== false).map((l) => l.id));
    const down = {};
    let unknown = 0;
    for (const d of open.docs) {
      if (d.get("lineDown") !== true) continue;
      // The machine's line; for requests with no machine (e.g. from the Microsoft Form, "CDG MACHINE ISSUE - 3-Extruder")
      // the line number written in the request's own title.
      let lineId = lineOf.get(d.get("machineId")) || null;
      if (!lineId) {
        const n = odoo.lineNumberFromTitle(d.get("title"));
        const guess = n ? `line-${n}` : null;
        if (guess && lineIds.has(guess)) lineId = guess;
      }
      if (!lineId) { unknown++; continue; }
      const at = d.get("reportedAt")?.toMillis?.() || null;
      const cur = (down[lineId] ||= { since: at, machineIds: [] });
      const machineId = d.get("machineId");
      if (machineId && !cur.machineIds.includes(machineId)) cur.machineIds.push(machineId);
      if (at && (!cur.since || at < cur.since)) cur.since = at;
    }
    await col("meta", test).doc("plantStatus").set({ down, unknown, updatedAt: FieldValue.serverTimestamp() });
  } catch (err) {
    console.error("plant status not updated", err);
  }
}

// "YYYY-MM-DD" in plant time (Cedar Rapids).
function plantToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}

// Odoo's "2026-10-15 19:32:11" (UTC) -> Date.
function odooDateTime(s) {
  return s ? new Date(`${String(s).replace(" ", "T")}Z`) : null;
}

const ISSUE_FIELDS = [
  "id", "name", "equipment_id", "priority", "description", "request_date", "create_date", "stage_id", "close_date",
  "x_studio_downtime_related", "x_studio_unsafe_to_run", "x_studio_failure_category", "x_studio_root_cause",
];

// One Odoo request -> the app's issue record (fields owned by Odoo; app-only fields are kept on merge).
function issueFromRequest(r) {
  const equipmentName = Array.isArray(r.equipment_id) ? r.equipment_id[1] : "";
  return {
    odooId: r.id,
    title: String(r.name || "").trim(),
    machineId: odoo.machineIdFromEquipmentName(equipmentName),
    equipmentName,
    lineDown: r.x_studio_downtime_related === true, // Odoo's "Downtime Related" box — the one signal for "line down"
    unsafe: r.x_studio_unsafe_to_run === true,
    priority: r.priority || "0",
    description: odoo.htmlToText(r.description).slice(0, 4000),
    failureCategory: r.x_studio_failure_category || "",
    rootCause: r.x_studio_root_cause || "",
    stage: Array.isArray(r.stage_id) ? r.stage_id[1] : "",
    reportedAt: odooDateTime(r.create_date) || (r.request_date ? new Date(`${r.request_date}T12:00:00Z`) : null),
    syncedAt: FieldValue.serverTimestamp(),
  };
}

// Cached per server instance: the team new requests go to, and the "Repaired" stage.
let odooRefs = null;
async function getOdooRefs(key) {
  if (odooRefs) return odooRefs;
  const teams = await odoo.odooCall(key, "maintenance.team", "search_read", { domain: [], fields: ["id", "name"] });
  const stages = await odoo.odooCall(key, "maintenance.stage", "search_read", { domain: [], fields: ["id", "name", "done", "sequence"], order: "sequence" });
  const team = teams.find((t) => t.name === "Internal Maintenance") || teams[0];
  const repaired = stages.find((s) => s.done && /repair/i.test(s.name)) || stages.find((s) => s.done);
  if (!team || !repaired) throw new Error("Odoo has no maintenance team or no 'done' stage.");
  odooRefs = { teamId: team.id, repairedStageId: repaired.id, repairedStageName: repaired.name };
  return odooRefs;
}

async function employeeName(employeeNumber) {
  const snap = await employees.doc(employeeNumber).get();
  return snap.get("name") || `Employee ${employeeNumber}`;
}

// Anyone signed in: { machineId, description, lineDown, unsafe, severity, actions, failureCategory, rootCause, photos }
// New Maintenance Request → push alert to everyone with the Maintenance role (Admins if nobody has it yet),
// not the person who reported it. Line down or unsafe is sent as urgent. Test site: only the person testing.
// Each alert has its own link (so a new one never quietly replaces the last one on the device).
async function alertMaintenance(me, machine, report, test, issueId) {
  const everyone = await activeEmployees();
  const crew = everyone.filter((e) => e.active !== false && e.roles.includes("maintenance")).map((e) => e.id);
  const { recipients, backup } = requestsLib.withBackup(crew, everyone);
  const urgent = report.lineDown || report.unsafe;
  const tags = [report.lineDown ? "⛔ LINE DOWN" : "🚨 Maintenance Request", report.unsafe ? "⚠ unsafe" : ""].filter(Boolean).join(" · ");
  return pushTo(test ? [me.employeeNumber] : recipients.filter((e) => e !== me.employeeNumber), {
    title: `${test ? "[TEST] " : ""}${tags} – ${machine.id} ${machine.name}${backup && !test ? " (no Maintenance role set — sent to Admins)" : ""}`,
    body: `${me.name}: ${report.description}`,
    url: `/?issues=1&i=${encodeURIComponent(issueId)}`,
    urgent,
  });
}

exports.reportProblem = onCall({ secrets: [odooKey] }, async (req) => {
  const me = await requireMember(req);
  const { report, error } = odoo.cleanReport(req.data);
  if (error) throw new HttpsError("invalid-argument", error);

  const machineSnap = await machines.doc(report.machineId).get();
  if (!machineSnap.exists || machineSnap.get("active") === false) throw new HttpsError("not-found", "That machine isn't in the app.");
  const machine = { id: machineSnap.id, ...machineSnap.data() };
  const lineSnap = machine.lineId ? await lines.doc(machine.lineId).get() : null;
  const lineName = lineSnap?.exists ? lineSnap.get("name") : "";
  const reporter = await employeeName(me.employeeNumber);

  // Test site: practice report only — never reaches Odoo, and only the test site's board shows it.
  if (isTest(req)) {
    const ref = col("issues", true).doc();
    await ref.set({
      odooId: null, open: true, source: "app", test: true,
      title: `[TEST] ${report.lineDown ? "⛔ LINE DOWN" : "🚨 Machine issue"} – ${machine.id} ${machine.name}`,
      machineId: machine.id, lineDown: report.lineDown, unsafe: report.unsafe, severity: report.severity,
      priority: odoo.SEVERITY[report.severity].priority, description: report.description, actions: report.actions,
      failureCategory: report.failureCategory, rootCause: report.rootCause, photos: report.photos,
      stage: "New Request", reportedBy: reporter, reportedByEmp: me.employeeNumber, reportedAt: FieldValue.serverTimestamp(),
    });
    await writePlantStatus(true);
    const pushed = await alertMaintenance(me, machine, report, true, ref.id);
    return { id: ref.id, odooId: null, test: true, pushed };
  }

  const key = odooKey.value();
  let odooId;
  try {
    const refs = await getOdooRefs(key);
    const [equipment] = await odoo.odooCall(key, "maintenance.equipment", "search_read", {
      domain: [["name", "=like", `${machine.id} %`]], fields: ["id", "name"], limit: 1,
    });
    if (!equipment) {
      throw new HttpsError("failed-precondition", `Odoo has no equipment named "${machine.id} …". Ask an admin to add it in Odoo.`);
    }
    const vals = odoo.requestValues({ ...report, lineName }, machine, equipment.id, equipment.name, refs.teamId, reporter, plantToday());
    [odooId] = await odoo.odooCall(key, "maintenance.request", "create", { vals_list: [vals] });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error("reportProblem: Odoo error", err);
    throw new HttpsError("unavailable", "Couldn't reach Odoo to create the request. Try again in a minute — if it keeps failing, use the paper/Microsoft Form and tell an admin.");
  }

  // On the board right away (the 5-minute sync keeps it in step with Odoo after that).
  const issueRef = issues.doc(`odoo-${odooId}`);
  await issueRef.set({
    odooId, open: true, source: "app",
    title: `${report.lineDown ? "⛔ LINE DOWN" : "🚨 Machine issue"} – ${machine.id} ${machine.name}`,
    machineId: machine.id, lineDown: report.lineDown, unsafe: report.unsafe, severity: report.severity,
    priority: odoo.SEVERITY[report.severity].priority, description: report.description, actions: report.actions,
    failureCategory: report.failureCategory, rootCause: report.rootCause, photos: report.photos,
    stage: "New Request", reportedBy: reporter, reportedByEmp: me.employeeNumber,
    reportedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await auditLog.add({ type: "reported", kind: "issue", recordId: issueRef.id, by: me.employeeNumber, at: FieldValue.serverTimestamp(), machineId: machine.id, lineDown: report.lineDown });
  await writePlantStatus(false);
  const pushed = await alertMaintenance(me, machine, report, false, issueRef.id);
  return { id: issueRef.id, odooId, pushed };
});

// Maintenance and Admins: { id, note? } — closes the Odoo request (stage Repaired, close date today).
exports.markIssueFixed = onCall({ secrets: [odooKey] }, async (req) => {
  const me = await requireMember(req);
  if (!me.roles.some((r) => FIXER_ROLES.includes(r))) throw new HttpsError("permission-denied", "Only Maintenance and Admins can mark issues fixed.");
  const test = isTest(req);
  const ref = col("issues", test).doc(String(req.data?.id || ""));
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError("failed-precondition", test ? "This is the test site — real Odoo requests can't be closed here. Report a test problem to try this." : "That issue no longer exists.");
  }
  if (snap.get("open") !== true) throw new HttpsError("failed-precondition", "That issue is already closed.");
  const note = typeof req.data?.note === "string" ? req.data.note.trim().slice(0, 1000) : "";
  const name = await employeeName(me.employeeNumber);
  if (test) {
    await ref.update({ open: false, stage: "Repaired", closedAt: FieldValue.serverTimestamp(), closedBy: name, closedByEmp: me.employeeNumber, fixNote: note });
    await writePlantStatus(true);
    return { ok: true, test: true };
  }
  const today = plantToday();
  const key = odooKey.value();
  try {
    const refs = await getOdooRefs(key);
    const id = snap.get("odooId");
    await odoo.odooCall(key, "maintenance.request", "write", { ids: [id], vals: { stage_id: refs.repairedStageId, close_date: today } });
    // Plain text: Odoo 19 shows HTML sent through the API as literal tags.
    const body = `Marked fixed in CDG Ops by ${name}.` + (note ? `\n${note}` : "");
    await odoo.odooCall(key, "maintenance.request", "message_post", { ids: [id], body, message_type: "comment", subtype_xmlid: "mail.mt_note" }).catch((e) => console.warn("note not posted", e.message));
  } catch (err) {
    console.error("markIssueFixed: Odoo error", err);
    throw new HttpsError("unavailable", "Couldn't reach Odoo to close the request. Try again in a minute, or close it in Odoo.");
  }
  await ref.update({ open: false, stage: "Repaired", closedAt: FieldValue.serverTimestamp(), closedBy: name, closedByEmp: me.employeeNumber, fixNote: note });
  const machineId = snap.get("machineId");
  if (machineId) await machines.doc(machineId).set({ lastRepairDate: today }, { merge: true }).catch(() => {});
  await auditLog.add({ type: "fixed", kind: "issue", recordId: ref.id, by: me.employeeNumber, at: FieldValue.serverTimestamp(), note });
  await writePlantStatus(false);
  return { ok: true };
});

// Maintenance and Admins: { id } — the line is running again, but the repair isn't finished. Unticks
// "Downtime Related" on the Odoo request (it stays open on the board) and notes who did it, so the Home
// status bar shows the line running right away (Decision 57).
exports.markLineBackUp = onCall({ secrets: [odooKey] }, async (req) => {
  const me = await requireMember(req);
  if (!me.roles.some((r) => FIXER_ROLES.includes(r))) throw new HttpsError("permission-denied", "Only Maintenance and Admins can mark a line back up.");
  const test = isTest(req);
  const ref = col("issues", test).doc(String(req.data?.id || ""));
  const snap = await ref.get();
  if (!snap.exists || snap.get("open") !== true) throw new HttpsError("failed-precondition", "That issue is no longer open.");
  if (snap.get("lineDown") !== true) throw new HttpsError("failed-precondition", "That issue isn't marked line down.");
  const name = await employeeName(me.employeeNumber);
  if (!test) {
    const key = odooKey.value();
    try {
      const id = snap.get("odooId");
      await odoo.odooCall(key, "maintenance.request", "write", { ids: [id], vals: { x_studio_downtime_related: false } });
      await odoo.odooCall(key, "maintenance.request", "message_post", { ids: [id], body: `Line back up (repair still open) — marked in CDG Ops by ${name}.`, message_type: "comment", subtype_xmlid: "mail.mt_note" }).catch((e) => console.warn("note not posted", e.message));
    } catch (err) {
      console.error("markLineBackUp: Odoo error", err);
      throw new HttpsError("unavailable", "Couldn't reach Odoo. Try again in a minute, or untick Downtime Related in Odoo.");
    }
  }
  await ref.update({ lineDown: false, lineBackUpAt: FieldValue.serverTimestamp(), lineBackUpBy: name });
  await auditLog.add({ type: "line-back-up", kind: "issue", recordId: ref.id, by: me.employeeNumber, at: FieldValue.serverTimestamp(), test });
  await writePlantStatus(test);
  return { ok: true, test };
});

// Pulls open breakdowns and last-maintenance dates from Odoo into the app.
async function syncFromOdoo(key) {
  // 1. Open corrective requests = the board.
  const open = await odoo.odooCall(key, "maintenance.request", "search_read", {
    domain: [["maintenance_type", "=", "corrective"], ["stage_id.done", "=", false], ["archive", "=", false]],
    fields: ISSUE_FIELDS, limit: 500,
  });
  const openIds = new Set(open.map((r) => `odoo-${r.id}`));
  const writes = open.map((r) => issues.doc(`odoo-${r.id}`).set({ ...issueFromRequest(r), open: true }, { merge: true }));

  // 2. Issues the app still shows as open but Odoo has closed (or deleted).
  const stillOpen = await issues.where("open", "==", true).get();
  const gone = stillOpen.docs.filter((d) => !openIds.has(d.id));
  if (gone.length) {
    const closed = await odoo.odooCall(key, "maintenance.request", "search_read", {
      domain: [["id", "in", gone.map((d) => d.get("odooId"))]], fields: ISSUE_FIELDS,
      context: { active_test: false },
    });
    const byId = new Map(closed.map((r) => [r.id, r]));
    for (const d of gone) {
      const r = byId.get(d.get("odooId"));
      writes.push(d.ref.set({ ...(r ? issueFromRequest(r) : {}), open: false, closedAt: r?.close_date ? new Date(`${r.close_date}T12:00:00Z`) : FieldValue.serverTimestamp() }, { merge: true }));
    }
  }

  // 3. Last PM / last repair for every machine.
  const done = await odoo.odooCall(key, "maintenance.request", "search_read", {
    domain: [["close_date", "!=", false], ["equipment_id", "!=", false]],
    fields: ["equipment_id", "maintenance_type", "close_date"], limit: 5000,
  });
  const dates = odoo.lastDatesByMachine(done);
  const machineSnaps = await machines.get();
  for (const m of machineSnaps.docs) {
    const d = dates[m.id];
    if (!d) continue;
    const update = {};
    if (d.pm && d.pm !== m.get("lastPmDate")) update.lastPmDate = d.pm;
    if (d.repair && d.repair !== m.get("lastRepairDate")) update.lastRepairDate = d.repair;
    if (Object.keys(update).length) writes.push(m.ref.update(update));
  }

  await Promise.all(writes);
  const result = { openIssues: open.length, closedSinceLastSync: gone.length, machinesWithDates: Object.keys(dates).length };
  await odooSyncStatus.set({ ok: true, lastAt: FieldValue.serverTimestamp(), error: null, ...result });
  await writePlantStatus(false);
  await writePlantStatus(true); // the test site's practice reports too
  return result;
}

async function syncAndRecord(key) {
  try {
    return await syncFromOdoo(key);
  } catch (err) {
    console.error("Odoo sync failed", err);
    await odooSyncStatus.set({ ok: false, lastAt: FieldValue.serverTimestamp(), error: String(err.message || err).slice(0, 500) }, { merge: true });
    throw err;
  }
}

// Every 5 minutes, all day.
exports.syncOdoo = onSchedule({ schedule: "every 5 minutes", timeZone: "America/Chicago", secrets: [odooKey], retryCount: 0 }, async () => {
  await syncAndRecord(odooKey.value());
});

// Admins: "Sync now" — also the quickest check that the Odoo connection works.
exports.adminSyncOdoo = onCall({ secrets: [odooKey] }, async (req) => {
  const adminNumber = await requireAdmin(req);
  await auditLog.add({ type: "synced", kind: "odoo", recordId: "sync", by: adminNumber, at: FieldValue.serverTimestamp() });
  try {
    return await syncAndRecord(odooKey.value());
  } catch (err) {
    throw new HttpsError("unavailable", `Odoo sync failed: ${String(err.message || err).slice(0, 300)}`);
  }
});

// ---------------------------------------------------------------------------
// Operator checklists (Plan Phase 3) — the old library's checklists, now signed by the signed-in person.
//
//   checklistTemplates/{id}      name, machineTypes, perLine, everyDays, items [{ id, text, photos, videos }]
//   checklistUnits/{unitId}      items { [itemId]: { at (ms), by (employee #), byName } } — latest per item
//   checklistSignoffs/{auto}     every sign-off ever (history): unitId, items, by, byName, at
// Test site: test_checklistUnits / test_checklistSignoffs, so practice sign-offs never change real due dates.
// ---------------------------------------------------------------------------

async function liveUnits() {
  const [t, l, m] = await Promise.all([checklistTemplates.get(), lines.get(), machines.get()]);
  const templates = t.docs.map((d) => ({ id: d.id, ...d.data() }));
  const units = checklistsLib.checklistUnits(templates, l.docs.map((d) => ({ id: d.id, ...d.data() })), m.docs.map((d) => d.data()));
  return { templates, units };
}

// Anyone signed in: { unitId, itemIds: [...], signer: { emp, pin }, device, test? } — "I did these items",
// signed with the shared PIN sign-off (Decision 7). The PIN is required (locked 10-20-2026).
exports.signChecklist = onCall(async (req) => {
  const signedIn = await requireMember(req);
  const test = isTest(req);
  if (!req.data?.signer) throw new HttpsError("failed-precondition", "Sign-offs need your PIN now. Close this screen and open the checklist again (or reload the app).");
  const me = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const unitIdIn = String(req.data?.unitId || "");
  const itemIds = Array.isArray(req.data?.itemIds) ? [...new Set(req.data.itemIds.map(String))] : [];
  if (!itemIds.length) throw new HttpsError("invalid-argument", "Check at least one item you did.");
  const { templates, units } = await liveUnits();
  const unit = units.find((u) => u.id === unitIdIn);
  if (!unit) throw new HttpsError("not-found", "That checklist isn't in use any more.");
  const template = templates.find((t) => t.id === unit.templateId);
  const known = new Set((template.items || []).map((i) => i.id));
  if (!itemIds.every((id) => known.has(id))) throw new HttpsError("invalid-argument", "That checklist changed. Close it and open it again.");

  const at = Date.now();
  const done = Object.fromEntries(itemIds.map((id) => [id, { at, by: me.employeeNumber, byName: me.name }]));
  const batch = db.batch();
  batch.set(
    col("checklistUnits", test).doc(unit.id),
    { templateId: unit.templateId, lineId: unit.lineId, items: done, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  batch.create(col("checklistSignoffs", test).doc(), {
    unitId: unit.id, templateId: unit.templateId, lineId: unit.lineId, items: itemIds,
    by: me.employeeNumber, byName: me.name, method: "pin", device, signedOn: signedIn.employeeNumber,
    at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
  });
  logSignoff(batch, test, { kind: "checklist", refId: unit.id, version: null, items: itemIds, emp: me.employeeNumber, name: me.name, method: "pin", device, signedOn: signedIn.employeeNumber });
  await batch.commit();
  return { ok: true, count: itemIds.length, name: me.name, test };
});

function requireTemplate(data, existing) {
  const { template, error } = checklistsLib.cleanTemplate(data, existing);
  if (error) throw new HttpsError("invalid-argument", error);
  return template;
}

// Our own training files that came off a checklist go to the trash list (kept 30 days).
function trashTemplateFiles(tx, before, after, templateId, by) {
  const keep = new Set((after?.items || []).flatMap((i) => [...(i.photos || []), ...(i.videos || [])]));
  for (const item of before?.items || []) {
    for (const url of [...(item.photos || []), ...(item.videos || [])]) {
      if (keep.has(url) || !fixesLib.storagePath(url, BUCKET)) continue;
      tx.create(db.collection("trash").doc(), {
        kind: "file", url, path: fixesLib.storagePath(url, BUCKET), templateId, itemId: item.id, title: `${before.name}: ${item.text}`,
        trashedBy: by, trashedAt: FieldValue.serverTimestamp(), purgeAfter: purgeDate(),
      });
    }
  }
}

// Admins: create { create: true, name, machineTypes, perLine, everyDays, items: [{ text }] }
// or update { id, ...same, active? }. Items keep their history and training media when reworded.
exports.adminSaveChecklist = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const isNew = req.data?.create === true;
  return db.runTransaction(async (tx) => {
    if (isNew) {
      const template = requireTemplate(req.data, null);
      const id = records.idFromName(template.name);
      if (!records.isRecordId(id)) throw new HttpsError("invalid-argument", "Name must start with a letter.");
      const ref = checklistTemplates.doc(id);
      if ((await tx.get(ref)).exists) throw new HttpsError("already-exists", `"${template.name}" already exists.`);
      tx.create(ref, { ...template, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      auditRecord(tx, "created", "checklist", id, adminNumber, { name: template.name });
      return { id };
    }
    const ref = checklistTemplates.doc(String(req.data?.id || ""));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That checklist no longer exists.");
    const template = requireTemplate(req.data, snap.data());
    trashTemplateFiles(tx, snap.data(), template, ref.id, adminNumber);
    tx.update(ref, { ...template, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "updated", "checklist", ref.id, adminNumber, { name: template.name, items: template.items.length, active: template.active });
    return { id: ref.id };
  });
});

// Admins: { templateId, itemId, photos, videos } — training photos/videos for one checklist item.
exports.adminSetChecklistMedia = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const photos = fixesLib.cleanLinks(req.data?.photos);
  const videos = fixesLib.cleanLinks(req.data?.videos);
  if (!photos || !videos) throw new HttpsError("invalid-argument", "Photo and video links must be full https:// links (20 max each).");
  const ref = checklistTemplates.doc(String(req.data?.templateId || ""));
  const itemIdIn = String(req.data?.itemId || "");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That checklist no longer exists.");
    const before = snap.data();
    if (!(before.items || []).some((i) => i.id === itemIdIn)) throw new HttpsError("not-found", "That item is no longer on the checklist.");
    const after = { ...before, items: before.items.map((i) => (i.id === itemIdIn ? { ...i, photos, videos } : i)) };
    trashTemplateFiles(tx, before, after, ref.id, adminNumber);
    tx.update(ref, { items: after.items, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "updated-media", "checklist", ref.id, adminNumber, { itemId: itemIdIn, photos: photos.length, videos: videos.length });
  });
  return { ok: true };
});

// Adds the old library's six checklists (only the ones not here yet).
async function addStartingChecklists(adminNumber) {
  const added = [];
  for (const t of checklistsLib.STARTING_CHECKLISTS) {
    const ref = checklistTemplates.doc(t.id);
    if ((await ref.get()).exists) continue;
    await ref.set({ ...checklistsLib.startingTemplate(t), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    added.push(t.id);
  }
  if (added.length) await auditLog.add({ type: "created", kind: "checklist", recordId: added.join(","), by: adminNumber, at: FieldValue.serverTimestamp() });
  return added;
}

// Admins: "Add the starting checklists".
exports.adminStartChecklists = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  return { added: await addStartingChecklists(adminNumber) };
});

// Admins, safe to run again: copy the old library's checklist dates and training media (read-only there),
// so due dates carry on at switch-over. Only newer dates replace what's here.
exports.adminImportOldChecklists = onCall({ timeoutSeconds: 540, memory: "1GiB" }, async (req) => {
  const adminNumber = await requireAdmin(req);
  await addStartingChecklists(adminNumber);
  const read = async (name) => {
    const res = await fetch(OLD_LIBRARY_DOC.replace(/library$/, name));
    if (res.status === 404) return {};
    if (!res.ok) throw new HttpsError("unavailable", `Couldn't read the old library (HTTP ${res.status}).`);
    const doc = await res.json();
    return fixesLib.plainValue({ mapValue: { fields: doc.fields || {} } });
  };
  const oldState = (await read("checklists")).state || {};
  const oldMedia = (await read("checklistMedia")).media || {};
  const lineIds = new Set((await lines.get()).docs.map((d) => d.id));
  const units = db.collection("checklistUnits");

  // 1. Dates: "L1-extruder" -> "line-1__extruder", "chiller" -> "plant__chiller".
  let datesCopied = 0;
  for (const [key, items] of Object.entries(oldState)) {
    const m = key.match(/^L(\d+)-(.+)$/);
    const lineId = m ? `line-${m[1]}` : null;
    const templateId = m ? m[2] : key;
    if (lineId && !lineIds.has(lineId)) continue;
    const ref = units.doc(checklistsLib.unitId(templateId, lineId));
    const current = (await ref.get()).get("items") || {};
    const newer = {};
    for (const [itemIdOld, rec] of Object.entries(items || {})) {
      const at = Number(rec?.at);
      if (!at || (current[itemIdOld]?.at || 0) >= at) continue;
      newer[itemIdOld] = { at, by: null, byName: String(rec.by || "").slice(0, 20) };
    }
    if (Object.keys(newer).length) {
      await ref.set({ templateId, lineId, items: newer, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      datesCopied += Object.keys(newer).length;
    }
  }

  // 2. Training media: "extruder__clean_die_head" -> that item's photos/videos (files copied into our Storage).
  const bucket = getStorage().bucket();
  let filesCopied = 0;
  const fileProblems = [];
  async function copyFile(url) {
    if (!fixesLib.isOldLibraryFile(url)) return url;
    const file = bucket.file(`checklists/legacy/${fixesLib.oldFileName(url)}`);
    try {
      const [exists] = await file.exists();
      if (!exists) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        await file.save(Buffer.from(await r.arrayBuffer()), { contentType: r.headers.get("content-type") || undefined, resumable: false });
        filesCopied++;
      }
      return await getDownloadURL(file);
    } catch (err) {
      fileProblems.push(`${fixesLib.oldFileName(url)}: ${err.message}`);
      return url;
    }
  }
  let itemsWithMedia = 0;
  for (const [key, m] of Object.entries(oldMedia)) {
    const [templateId, itemIdOld] = key.split("__");
    const ref = checklistTemplates.doc(templateId);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const items = snap.get("items") || [];
    const item = items.find((i) => i.id === itemIdOld);
    if (!item) continue;
    const photos = [];
    for (const u of (m?.photos || []).filter(Boolean)) photos.push(await copyFile(u));
    const videos = [];
    for (const u of (m?.videos || []).filter(Boolean)) videos.push(await copyFile(u));
    item.photos = [...new Set([...(item.photos || []), ...photos])];
    item.videos = [...new Set([...(item.videos || []), ...videos])];
    await ref.update({ items, updatedAt: FieldValue.serverTimestamp() });
    itemsWithMedia++;
  }
  await auditLog.add({
    type: "imported", kind: "checklist", recordId: "old-library", by: adminNumber, at: FieldValue.serverTimestamp(),
    datesCopied, itemsWithMedia, filesCopied,
  });
  return { datesCopied, itemsWithMedia, filesCopied, fileProblems };
});

// ---------------------------------------------------------------------------
// Trash bin cleanup: every night, things in the trash for more than 30 days are removed for good.
// A file is only deleted if no fix and no checklist still uses it.
// ---------------------------------------------------------------------------

async function purgeOnce(test) {
  const now = new Date();
  const bucket = getStorage().bucket();
  const [allFixes, templates, oldFiles, oldFixes] = await Promise.all([
    col("fixes", test).get(),
    checklistTemplates.get(),
    col("trash", test).where("purgeAfter", "<", now).get(),
    col("fixes", test).where("status", "==", "trashed").where("purgeAfter", "<", now).get(),
  ]);
  const goingIds = new Set(oldFixes.docs.map((d) => d.id));
  const inUse = new Set([
    ...allFixes.docs.filter((d) => !goingIds.has(d.id)).flatMap((d) => fixesLib.fileLinks(d.data())),
    ...templates.docs.flatMap((d) => (d.get("items") || []).flatMap((i) => [...(i.photos || []), ...(i.videos || [])])),
  ]);
  const removeFile = async (url) => {
    const path = fixesLib.storagePath(url, BUCKET);
    if (path && !inUse.has(url)) await bucket.file(path).delete({ ignoreNotFound: true });
  };
  let files = 0;
  for (const t of oldFiles.docs) {
    await removeFile(t.get("url"));
    await t.ref.delete();
    files++;
  }
  for (const f of oldFixes.docs) {
    for (const url of fixesLib.fileLinks(f.data())) await removeFile(url);
    await db.recursiveDelete(f.ref); // the fix and its version history
  }
  if (files || oldFixes.size) {
    await auditLog.add({
      type: "purged", kind: "trash", recordId: test ? "test" : "live", by: "system", at: FieldValue.serverTimestamp(),
      files, fixes: oldFixes.size,
    });
  }
  return { files, fixes: oldFixes.size };
}

// Every night at 3 a.m. plant time.
exports.purgeTrash = onSchedule({ schedule: "every day 03:00", timeZone: "America/Chicago", retryCount: 0 }, async () => {
  await purgeOnce(false);
  await purgeOnce(true);
});

// ---------------------------------------------------------------------------
// "Need something?" requests — app only, nothing goes to Odoo (Chris, 10-16-2026).
//
//   requestTypes/{id}     name, icon, routeRoles, routePeople, urgent, order, active (Admin → Request types)
//   requests/{auto}       typeId, typeName, icon, description, photos, lineId, place, urgent, status,
//                         recipients (employee #s it went to), createdBy, history, doneBy/doneAt
//   pushTokens/{hash}     emp, token — one per device that turned notifications on
// Test site: test_requests, and the push goes only to the person testing.
// ---------------------------------------------------------------------------

const requestTypes = db.collection("requestTypes");
const pushTokens = db.collection("pushTokens");

const tokenId = (token) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 40);

// Anyone signed in: { token } — this device wants push notifications.
exports.saveDeviceToken = onCall(async (req) => {
  const me = await requireMember(req);
  const token = typeof req.data?.token === "string" ? req.data.token.trim() : "";
  if (token.length < 20 || token.length > 4096) throw new HttpsError("invalid-argument", "That device couldn't be signed up for notifications.");
  await pushTokens.doc(tokenId(token)).set({ emp: me.employeeNumber, token, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// Anyone signed in: { token } — stop notifications on this device (e.g. a shared tablet).
exports.removeDeviceToken = onCall(async (req) => {
  await requireMember(req);
  const token = typeof req.data?.token === "string" ? req.data.token.trim() : "";
  if (token) await pushTokens.doc(tokenId(token)).delete();
  return { ok: true };
});

// Sends a notification to every device of these employees. Never fails the save that triggered it.
async function pushTo(employeeNumbers, { title, body, url, urgent = false }) {
  const emps = [...new Set(employeeNumbers)].filter(Boolean);
  if (!emps.length) return 0;
  try {
    const docs = [];
    for (let i = 0; i < emps.length; i += 30) {
      docs.push(...(await pushTokens.where("emp", "in", emps.slice(i, i + 30)).get()).docs);
    }
    if (!docs.length) return 0;
    const res = await getMessaging().sendEachForMulticast({
      tokens: docs.map((d) => d.get("token")),
      data: { title, body: body.slice(0, 180), url, tag: url },
      webpush: { headers: { Urgency: urgent ? "high" : "normal", TTL: "86400" } },
    });
    // Devices that are gone (app removed, permission turned off) are forgotten.
    const dead = res.responses
      .map((r, i) => (!r.success && /registration-token-not-registered|invalid-argument|invalid-registration-token/.test(r.error?.code || "") ? docs[i].ref : null))
      .filter(Boolean);
    await Promise.all(dead.map((ref) => ref.delete()));
    return res.successCount;
  } catch (err) {
    console.error("push failed", err);
    return 0;
  }
}

async function activeEmployees() {
  return (await employees.get()).docs.map((d) => ({ id: d.id, roles: d.get("roles") || [], active: d.get("active") }));
}

// Anyone signed in: { typeId, description, photos?, lineId?, place?, test? }
exports.submitRequest = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const { request, error } = requestsLib.cleanRequest(req.data);
  if (error) throw new HttpsError("invalid-argument", error);
  const typeSnap = await requestTypes.doc(request.typeId).get();
  if (!typeSnap.exists || typeSnap.get("active") === false) throw new HttpsError("invalid-argument", "That kind of request isn't available any more.");
  const type = typeSnap.data();
  let lineName = "";
  if (request.lineId) {
    const line = await lines.doc(request.lineId).get();
    if (!line.exists) throw new HttpsError("invalid-argument", "Pick a line from the list.");
    lineName = line.get("name");
  }
  const everyone = await activeEmployees();
  const { recipients, backup } = requestsLib.withBackup(requestsLib.recipientsFor(type, everyone), everyone);
  const now = FieldValue.serverTimestamp();
  const ref = col("requests", test).doc();
  await ref.set({
    ...request, typeName: type.name, icon: type.icon || "💬", urgent: type.urgent === true, lineName,
    status: "open", recipients, routedToBackup: backup, createdBy: me.employeeNumber, createdByName: me.name, createdAt: now, updatedAt: now,
    history: [{ status: "open", by: me.employeeNumber, byName: me.name, at: new Date() }],
    ...(test ? { test: true } : {}),
  });
  const where = [lineName, request.place].filter(Boolean).join(" · ");
  const sent = await pushTo(test ? [me.employeeNumber] : recipients.filter((e) => e !== me.employeeNumber), {
    title: `${test ? "[TEST] " : ""}${type.urgent ? "⚠ URGENT · " : ""}${type.icon || ""} ${type.name}${backup ? " (no one assigned — sent to Admins)" : ""}`.trim(),
    body: `${me.name}${where ? ` (${where})` : ""}: ${request.description}`,
    url: `/?req=${ref.id}`,
    urgent: type.urgent === true,
  });
  return { id: ref.id, recipients: recipients.length, backup, pushed: sent, test };
});

const STATUS_WORDS = { open: "Open", "in-progress": "In progress", done: "Done" };

// The people it was sent to, and admins: { id, status: "in-progress" | "done" | "open", note? }
exports.updateRequest = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const ref = col("requests", test).doc(String(req.data?.id || ""));
  const status = String(req.data?.status || "");
  const note = typeof req.data?.note === "string" ? req.data.note.trim().slice(0, 1000) : "";
  const r = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That request no longer exists.");
    const cur = snap.data();
    if (!requestsLib.canWork(cur, me.employeeNumber, me.roles)) throw new HttpsError("permission-denied", "Only the people it was sent to (or an admin) can change this.");
    if (!requestsLib.canMove(cur.status, status)) throw new HttpsError("failed-precondition", `It's already ${STATUS_WORDS[cur.status] || cur.status}.`);
    const update = {
      status, updatedAt: FieldValue.serverTimestamp(),
      history: FieldValue.arrayUnion({ status, by: me.employeeNumber, byName: me.name, at: new Date(), ...(note ? { note } : {}) }),
    };
    if (status === "done") Object.assign(update, { doneBy: me.employeeNumber, doneByName: me.name, doneAt: FieldValue.serverTimestamp(), doneNote: note });
    if (status === "open") Object.assign(update, { doneBy: FieldValue.delete(), doneByName: FieldValue.delete(), doneAt: FieldValue.delete(), doneNote: FieldValue.delete() });
    if (status === "in-progress") Object.assign(update, { takenBy: me.employeeNumber, takenByName: me.name });
    tx.update(ref, update);
    if (me.roles.includes("admin") && !(cur.recipients || []).includes(me.employeeNumber)) {
      auditRecord(tx, `request-${status}`, "request", ref.id, me.employeeNumber, { title: cur.typeName, test });
    }
    return cur;
  });
  // The person who asked hears about it.
  if (r.createdBy !== me.employeeNumber || test) {
    await pushTo([r.createdBy], {
      title: `${test ? "[TEST] " : ""}Your request: ${STATUS_WORDS[status]}`,
      body: `${r.icon || ""} ${r.typeName} — ${status === "done" ? `done by ${me.name}` : status === "in-progress" ? `${me.name} is on it` : "reopened"}${note ? `: ${note}` : ""}`,
      url: `/?req=${ref.id}`,
    });
  }
  return { ok: true };
});

async function knownRoleIds() {
  return (await roles.get()).docs.filter((d) => d.get("active") !== false).map((d) => d.id);
}

// Admins: create { create: true, name, icon, routeRoles, routePeople, urgent, order }
// or update { id, ...same, active? }.
exports.adminSaveRequestType = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const { type, error } = requestsLib.cleanType(req.data, await knownRoleIds());
  if (error) throw new HttpsError("invalid-argument", error);
  const isNew = req.data?.create === true;
  const id = isNew ? records.idFromName(type.name) : String(req.data?.id || "");
  if (!records.isRecordId(id)) throw new HttpsError("invalid-argument", "Name must start with a letter.");
  await db.runTransaction(async (tx) => {
    const ref = requestTypes.doc(id);
    const snap = await tx.get(ref);
    if (isNew && snap.exists) throw new HttpsError("already-exists", `"${type.name}" already exists.`);
    if (!isNew && !snap.exists) throw new HttpsError("not-found", "That request type no longer exists.");
    tx.set(ref, { ...type, updatedAt: FieldValue.serverTimestamp(), ...(isNew ? { createdAt: FieldValue.serverTimestamp() } : {}) }, { merge: true });
    auditRecord(tx, isNew ? "created" : "updated", "request type", id, adminNumber, { name: type.name, routeRoles: type.routeRoles, routePeople: type.routePeople, urgent: type.urgent, active: type.active });
  });
  return { id };
});

// Admins: the five starting request types (only the ones not here yet).
exports.adminStartRequestTypes = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const added = [];
  for (const t of requestsLib.STARTING_TYPES) {
    const ref = requestTypes.doc(t.id);
    if ((await ref.get()).exists) continue;
    await ref.set({ ...requestsLib.startingType(t), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    added.push(t.id);
  }
  if (added.length) await auditLog.add({ type: "created", kind: "request type", recordId: added.join(","), by: adminNumber, at: FieldValue.serverTimestamp() });
  return { added };
});

// ---------------------------------------------------------------------------
// Shared sign-off (Decision 7): every sign-off is the person's own employee # + PIN, checked here.
// Checklists, announcements, and anything later use this one piece. On a line tablet the person signing
// may be someone other than whoever is signed in — the PIN proves who signed.
//   signoffs/{auto}   kind, refId, version, emp, name, device { id, kind, label }, method ("pin" | "in-person"),
//                     signedOn (who was signed in on the device), recordedBy/note (in person), at
// Test site: test_signoffs.
// ---------------------------------------------------------------------------

// { signer: { emp, pin } } -> the signer. Wrong PINs count toward the same 5-try lockout as signing in.
async function requireSignature(data) {
  const emp = pin.normalizeEmployeeNumber(data?.signer?.emp);
  const enteredPin = data?.signer?.pin;
  if (!emp || !pin.isValidPinFormat(enteredPin)) throw new HttpsError("permission-denied", "Wrong PIN. Try again.");
  const result = await attemptPin(emp, enteredPin);
  if (!result.ok) {
    if (result.minutesLeft) throwPinFailure(result);
    throw new HttpsError("permission-denied", "Wrong PIN. Try again.");
  }
  if (result.mustChangePin) throw new HttpsError("failed-precondition", "Sign in once and pick your own PIN first, then sign.");
  return { employeeNumber: emp, name: result.employee.name || `Employee ${emp}`, roles: result.employee.roles || [], employee: result.employee };
}

function logSignoff(tx, test, entry) {
  tx.create(col("signoffs", test).doc(), { ...entry, at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}) });
}

// Everyone, with whether they have a login yet (PIN records are only checked for existence, never read).
async function peopleList() {
  const [e, s] = await Promise.all([employees.get(), pinSecrets.select().get()]);
  const login = new Set(s.docs.map((d) => d.id));
  return e.docs.map((d) => ({
    id: d.id, name: d.get("name") || `Employee ${d.id}`, roles: d.get("roles") || [], team: d.get("team") || null,
    homeLineId: d.get("homeLineId") || null, active: d.get("active") !== false, loginEnabled: login.has(d.id),
  }));
}

// ---------------------------------------------------------------------------
// Announcements with "Read & understood" (rules in announcements.js).
//   announcements/{auto}        title, body, priority, ackBy, endDate, file, audience, keepForNewHires, version,
//                               audienceEmps (who it's for), trackers (poster + supervisors with crew in it),
//                               createdBy/Name, ended
//   announcements/{id}/versions/{n}   the words of each earlier version (what people signed then)
//   announcementSigs/{id}__v{n}__{emp}   one signature per person per version: method, device, at, recordedBy, note
// Test site: test_announcements / test_announcementSigs. Practice posts never reach the live site; signing a
// real announcement on the test site is practice too (saved in test_announcementSigs).
// ---------------------------------------------------------------------------

const annCol = (test) => col("announcements", test);
const sigCol = (test) => col("announcementSigs", test);
const sigId = (id, version, emp) => `${id}__v${version}__${emp}`;
const hasRole = (roles, list) => (roles || []).some((r) => list.includes(r));
const ms = (t) => (t?.toMillis ? t.toMillis() : null);

// An announcement to read or sign. Test site: practice ones first, then real ones (which can't be changed there).
async function findAnnouncement(test, id) {
  if (!id || typeof id !== "string" || id.includes("/")) throw new HttpsError("not-found", "That announcement no longer exists.");
  const snap = await annCol(test).doc(id).get();
  if (snap.exists) return { snap, readOnly: false };
  if (test) {
    const real = await annCol(false).doc(id).get();
    if (real.exists) return { snap: real, readOnly: true };
  }
  throw new HttpsError("not-found", "That announcement no longer exists.");
}

const announcementPush = (a, test, kind) => ({
  title: `${test ? "[TEST] " : ""}${a.priority === "safety" ? "⚠ SAFETY · " : a.priority === "important" ? "❗ " : "📣 "}${kind}${a.title}`.slice(0, 120),
  body: `${a.createdByName || ""}: ${a.body}`.slice(0, 180),
  urgent: a.priority === "safety",
});

// Posters (roles allowed in Admin → Roles) and people who see everything: the people list for picking an audience.
exports.announcementPeople = onCall(async (req) => {
  const me = await requireMember(req);
  const roleDocs = (await roles.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!annLib.canPost(roleDocs, me.roles) && !hasRole(me.roles, annLib.SEE_ALL_ROLES)) {
    throw new HttpsError("permission-denied", "Your role can't post announcements. An admin can turn it on in Admin → Roles.");
  }
  const people = (await peopleList()).filter((p) => p.active);
  people.sort((x, y) => x.name.localeCompare(y.name));
  return { people: people.map(({ id, name, roles: r, team, homeLineId, loginEnabled }) => ({ id, name, roles: r, team, homeLineId, loginEnabled })) };
});

// Post { title, body, priority, ackBy, endDate?, file?, audience, keepForNewHires } or edit (same plus { id }).
// Editing the words, attachment, or priority makes a new version — everyone signs again (old signatures stay).
exports.postAnnouncement = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const [roleSnaps, teamSnaps, lineSnaps, people] = await Promise.all([roles.get(), teams.get(), lines.get(), peopleList()]);
  const live = (snaps) => snaps.docs.filter((d) => d.get("active") !== false).map((d) => d.id);
  const roleDocs = roleSnaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  const known = { roles: live(roleSnaps), teams: live(teamSnaps), lines: live(lineSnaps) };
  const { announcement, error } = annLib.cleanAnnouncement(req.data, known, (u) => (fixesLib.storagePath(u, BUCKET) || "").startsWith("uploads/"), plantToday());
  if (error) throw new HttpsError("invalid-argument", error);
  const audienceEmps = annLib.matchAudience(announcement.audience, people);
  if (!audienceEmps.length) throw new HttpsError("invalid-argument", "Nobody matches that audience right now. Pick others.");
  const trackers = annLib.trackersFor(me.employeeNumber, audienceEmps, people);
  const editId = req.data?.id ? String(req.data.id) : null;
  const now = FieldValue.serverTimestamp();

  if (!editId) {
    if (!annLib.canPost(roleDocs, me.roles)) throw new HttpsError("permission-denied", "Your role can't post announcements. An admin can turn it on in Admin → Roles.");
    const ref = annCol(test).doc();
    const doc = {
      ...announcement, version: 1, audienceEmps, trackers, ended: false,
      createdBy: me.employeeNumber, createdByName: me.name, createdAt: now, updatedAt: now, ...(test ? { test: true } : {}),
    };
    await db.runTransaction(async (tx) => {
      tx.create(ref, doc);
      auditRecord(tx, "posted", "announcement", ref.id, me.employeeNumber, { title: announcement.title, audience: audienceEmps.length, test });
    });
    const pushed = await pushTo(test ? [me.employeeNumber] : audienceEmps.filter((e) => e !== me.employeeNumber), {
      ...announcementPush(doc, test, "New: "), url: `/?ann=${ref.id}`,
    });
    return { id: ref.id, version: 1, audience: audienceEmps.length, pushed, test };
  }

  const ref = annCol(test).doc(editId);
  const r = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      if (test && (await tx.get(annCol(false).doc(editId))).exists) {
        throw new HttpsError("failed-precondition", "This is the test site — real announcements can't be changed here. Post a test one to try this.");
      }
      throw new HttpsError("not-found", "That announcement no longer exists.");
    }
    const cur = snap.data();
    if (cur.createdBy !== me.employeeNumber && !me.roles.includes("admin")) throw new HttpsError("permission-denied", "Only the person who posted it (or an admin) can change it.");
    if (cur.ended) throw new HttpsError("failed-precondition", "This announcement has ended. Post a new one instead.");
    const changed = annLib.contentChanged(cur, announcement);
    const version = (cur.version || 1) + (changed ? 1 : 0);
    if (changed) {
      tx.create(ref.collection("versions").doc(String(cur.version || 1)), {
        version: cur.version || 1, title: cur.title, body: cur.body, priority: cur.priority, file: cur.file || null,
        replacedAt: now, replacedBy: me.employeeNumber,
      });
    }
    tx.update(ref, { ...announcement, version, audienceEmps, trackers, updatedAt: now, editedBy: me.employeeNumber, editedByName: me.name, ...(changed ? { editedAt: now } : {}) });
    auditRecord(tx, "updated", "announcement", editId, me.employeeNumber, { title: announcement.title, version, signAgain: changed, test });
    return { changed, version, doc: { ...cur, ...announcement } };
  });
  let pushed = 0;
  if (r.changed) {
    pushed = await pushTo(test ? [me.employeeNumber] : audienceEmps.filter((e) => e !== me.employeeNumber), {
      ...announcementPush(r.doc, test, "Updated — please sign again: "), url: `/?ann=${editId}`,
    });
  }
  return { id: editId, version: r.version, signAgain: r.changed, audience: audienceEmps.length, pushed, test };
});

// The poster or an admin: { id } — end it now (it moves to the archive; signatures are kept).
exports.endAnnouncement = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const id = String(req.data?.id || "");
  await db.runTransaction(async (tx) => {
    const ref = annCol(test).doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      if (test && (await tx.get(annCol(false).doc(id))).exists) throw new HttpsError("failed-precondition", "This is the test site — real announcements can't be changed here.");
      throw new HttpsError("not-found", "That announcement no longer exists.");
    }
    if (snap.get("createdBy") !== me.employeeNumber && !me.roles.includes("admin")) throw new HttpsError("permission-denied", "Only the person who posted it (or an admin) can end it.");
    if (snap.get("ended")) return;
    tx.update(ref, { ended: true, endedAt: FieldValue.serverTimestamp(), endedBy: me.employeeNumber, endedByName: me.name });
    auditRecord(tx, "ended", "announcement", id, me.employeeNumber, { title: snap.get("title"), test });
  });
  return { ok: true };
});

// "Read & understood": { id, version, signer: { emp, pin }, device }. The version is the one the person read —
// if it was edited meanwhile, they're asked to read the new one.
exports.signAnnouncement = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const { snap } = await findAnnouncement(test, String(req.data?.id || ""));
  const a = snap.data();
  if (!(a.audienceEmps || []).includes(signer.employeeNumber)) throw new HttpsError("permission-denied", `This announcement isn't for ${signer.name}.`);
  if (annLib.isEnded(a, plantToday())) throw new HttpsError("failed-precondition", "This announcement has ended — nothing to sign.");
  if (Number(req.data?.version) !== (a.version || 1)) throw new HttpsError("failed-precondition", "It was just updated. Read the new version, then sign.");
  const version = a.version || 1;
  const ref = sigCol(test).doc(sigId(snap.id, version, signer.employeeNumber));
  const already = await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return true;
    tx.create(ref, {
      annId: snap.id, version, title: a.title, emp: signer.employeeNumber, name: signer.name, method: "pin", device,
      signedOn: me.employeeNumber, at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
    });
    logSignoff(tx, test, { kind: "announcement", refId: snap.id, version, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
    return false;
  });
  return { ok: true, already, name: signer.name, version, test };
});

// Supervisor, Plant Manager, Admin — for someone with no login yet: { id, emp, note, signer: { emp, pin }, device }.
// Signed with the recorder's own PIN; the note says how it was reviewed.
exports.recordReviewedInPerson = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  if (signer.employeeNumber !== me.employeeNumber) throw new HttpsError("permission-denied", "Use your own PIN.");
  if (!hasRole(signer.roles, annLib.IN_PERSON_ROLES)) throw new HttpsError("permission-denied", "Only Supervisors, the Plant Manager, and Admins can record this.");
  const note = typeof req.data?.note === "string" ? req.data.note.trim().slice(0, 500) : "";
  if (note.length < 3) throw new HttpsError("invalid-argument", "Add a short note (for example: “Read it together at the start of shift”).");
  const emp = pin.normalizeEmployeeNumber(req.data?.emp);
  const device = annLib.cleanDevice(req.data?.device);
  const { snap } = await findAnnouncement(test, String(req.data?.id || ""));
  const a = snap.data();
  if (!emp || !(a.audienceEmps || []).includes(emp)) throw new HttpsError("invalid-argument", "That person isn't in this announcement's audience.");
  const people = await peopleList();
  const person = people.find((p) => p.id === emp);
  if (!person) throw new HttpsError("not-found", "That person is no longer in the app.");
  if (person.loginEnabled) throw new HttpsError("failed-precondition", `${person.name} has a login — they sign with their own PIN.`);
  const meRecord = people.find((p) => p.id === me.employeeNumber);
  if (!hasRole(me.roles, ["plant-manager", "admin"]) && !annLib.crewOf(meRecord, people).includes(emp)) {
    throw new HttpsError("permission-denied", `${person.name} isn't on your crew.`);
  }
  const version = a.version || 1;
  const ref = sigCol(test).doc(sigId(snap.id, version, emp));
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) throw new HttpsError("already-exists", `${person.name} is already signed off on this version.`);
    tx.create(ref, {
      annId: snap.id, version, title: a.title, emp, name: person.name, method: "in-person", note, device,
      recordedBy: me.employeeNumber, recordedByName: me.name, signedOn: me.employeeNumber, at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
    });
    logSignoff(tx, test, { kind: "announcement", refId: snap.id, version, emp, name: person.name, method: "in-person", note, device, recordedBy: me.employeeNumber, signedOn: me.employeeNumber });
  });
  return { ok: true, name: person.name, test };
});

// Who has and hasn't signed one announcement (current version). Poster, Plant Manager, Office, Admin: everyone;
// Supervisors: their crew.
async function trackingFor(me, test, id) {
  const { snap, readOnly } = await findAnnouncement(test, id);
  const a = snap.data();
  const scope = annLib.trackScope({ id: me.employeeNumber, roles: me.roles }, a);
  if (!scope) throw new HttpsError("permission-denied", "Only the poster, Plant Manager, Office, Admins, and Supervisors (for their crew) can see this.");
  const people = await peopleList();
  const byId = new Map(people.map((p) => [p.id, p]));
  let ids = a.audienceEmps || [];
  if (scope === "crew") {
    const crew = new Set(annLib.crewOf(byId.get(me.employeeNumber), people));
    ids = ids.filter((e) => crew.has(e));
  }
  const sigs = (await sigCol(test).where("annId", "==", snap.id).get()).docs.map((d) => d.data());
  const version = a.version || 1;
  const list = ids.map((emp) => {
    const p = byId.get(emp) || { id: emp, name: `Employee ${emp}`, loginEnabled: false };
    const sig = sigs.find((s) => s.emp === emp && s.version === version);
    const older = sigs.filter((s) => s.emp === emp && s.version < version).reduce((n, s) => Math.max(n, s.version), 0);
    const status = annLib.personStatus(
      { id: emp, name: p.name, loginEnabled: p.loginEnabled, team: p.team || null, homeLineId: p.homeLineId || null, active: p.active !== false, olderVersion: older || null },
      sig ? { at: ms(sig.at), method: sig.method, device: sig.device?.label || "", recordedByName: sig.recordedByName || "", note: sig.note || "" } : null
    );
    return status;
  });
  list.sort((x, y) => x.name.localeCompare(y.name));
  return { a, snap, scope, list, readOnly, people };
}

exports.announcementTracking = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const { a, snap, scope, list, readOnly, people } = await trackingFor(me, test, String(req.data?.id || ""));
  const versions = (await snap.ref.collection("versions").get()).docs.map((d) => ({ version: d.get("version"), replacedAt: ms(d.get("replacedAt")) }));
  const meRecord = people.find((p) => p.id === me.employeeNumber);
  return {
    id: snap.id, title: a.title, version: a.version || 1, priority: a.priority, ackBy: a.ackBy, endDate: a.endDate || null,
    ended: annLib.isEnded(a, plantToday()), overdue: annLib.isOverdue(a, plantToday()), createdByName: a.createdByName || "",
    createdAt: ms(a.createdAt), scope, noCrew: scope === "crew" && !meRecord?.team && !meRecord?.homeLineId,
    people: list, counts: annLib.countUp(list), versions, readOnly, today: plantToday(),
    canInPerson: hasRole(me.roles, annLib.IN_PERSON_ROLES),
    canEdit: !readOnly && (a.createdBy === me.employeeNumber || me.roles.includes("admin")),
  };
});

// Push again to only the people (in your scope) who haven't signed and have a login: { id }.
exports.remindAnnouncement = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const { a, snap, list } = await trackingFor(me, test, String(req.data?.id || ""));
  if (annLib.isEnded(a, plantToday())) throw new HttpsError("failed-precondition", "This announcement has ended.");
  const waiting = list.filter((p) => p.state === "not-signed").map((p) => p.id);
  if (!waiting.length) return { reminded: 0, pushed: 0, test };
  const pushed = await pushTo(test ? [me.employeeNumber] : waiting, { ...announcementPush(a, test, "Reminder — please read and sign: "), url: `/?ann=${snap.id}` });
  await auditLog.add({ type: "reminded", kind: "announcement", recordId: snap.id, by: me.employeeNumber, at: FieldValue.serverTimestamp(), count: waiting.length, test });
  return { reminded: waiting.length, pushed, test };
});

// Dashboard cards: { scope: "all" | "crew" } — for each announcement still up, how many in scope have signed.
// "all": Plant Manager, Office, Admin. "crew": Supervisors.
exports.announcementSummary = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const scope = req.data?.scope === "crew" ? "crew" : "all";
  if (scope === "all" && !hasRole(me.roles, annLib.SEE_ALL_ROLES)) throw new HttpsError("permission-denied", "Plant Manager, Office, and Admins only.");
  if (scope === "crew" && !hasRole(me.roles, [...annLib.CREW_ROLES, "admin"])) throw new HttpsError("permission-denied", "Supervisors only.");
  const today = plantToday();
  const docs = [...(await annCol(false).where("ended", "==", false).get()).docs];
  if (test) docs.push(...(await annCol(true).where("ended", "==", false).get()).docs);
  const active = docs.filter((d) => !annLib.isEnded(d.data(), today));
  const people = await peopleList();
  const byId = new Map(people.map((p) => [p.id, p]));
  const meRecord = byId.get(me.employeeNumber);
  const crew = scope === "crew" ? new Set(annLib.crewOf(meRecord, people)) : null;
  const sigs = [];
  const annIds = active.map((d) => d.id);
  for (let i = 0; i < annIds.length; i += 30) sigs.push(...(await sigCol(test).where("annId", "in", annIds.slice(i, i + 30)).get()).docs.map((d) => d.data()));
  const behind = new Set();
  const behindOverdue = new Set();
  const items = active.map((d) => {
    const a = d.data();
    const ids = (a.audienceEmps || []).filter((e) => !crew || crew.has(e));
    const list = ids.map((emp) => annLib.personStatus({ id: emp, loginEnabled: byId.get(emp)?.loginEnabled === true }, sigs.find((s) => s.annId === d.id && s.emp === emp && s.version === (a.version || 1)) || null));
    const overdue = annLib.isOverdue(a, today);
    for (const p of list) if (p.state === "not-signed" || p.state === "no-login") { behind.add(p.id); if (overdue) behindOverdue.add(p.id); }
    return { id: d.id, title: a.title, priority: a.priority, ackBy: a.ackBy, overdue, test: d.ref.parent.id.startsWith("test_"), ...annLib.countUp(list) };
  }).filter((x) => x.total > 0);
  return { scope, items, behind: behind.size, behindOverdue: behindOverdue.size, noCrew: scope === "crew" && !meRecord?.team && !meRecord?.homeLineId };
});

// Who can sign on this device's sign-off sheet (line tablets: the crew signs one after another, no signing in):
// { kind: "announcement", id } -> audience who haven't signed yet; { kind: "checklist" } -> everyone with a login.
// Names and employee numbers only.
exports.signoffPeople = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled);
  let list = people;
  if (req.data?.kind === "announcement") {
    const { snap } = await findAnnouncement(test, String(req.data?.id || ""));
    const a = snap.data();
    const signed = new Set((await sigCol(test).where("annId", "==", snap.id).get()).docs.filter((d) => d.get("version") === (a.version || 1)).map((d) => d.get("emp")));
    const audience = new Set(a.audienceEmps || []);
    list = people.filter((p) => audience.has(p.id) && !signed.has(p.id));
  }
  list.sort((x, y) => x.name.localeCompare(y.name));
  return { people: list.filter((p) => p.id !== me.employeeNumber).map((p) => ({ emp: p.id, name: p.name })) };
});

// After people change (new hire, roles, team, home line): kept-for-new-hires announcements pick up anyone who
// now matches, and supervisors' tracking follows their crew. Never fails the change that called it.
async function refreshAnnouncementLists() {
  try {
    const people = await peopleList();
    for (const test of [false, true]) {
      const snaps = await annCol(test).where("ended", "==", false).get();
      for (const d of snaps.docs) {
        const a = d.data();
        const audienceEmps = annLib.refreshedAudience(a, people);
        const trackers = annLib.trackersFor(a.createdBy, audienceEmps, people);
        if (audienceEmps.join() !== (a.audienceEmps || []).join() || trackers.join() !== (a.trackers || []).join()) {
          await d.ref.update({ audienceEmps, trackers });
        }
      }
    }
  } catch (err) {
    console.error("announcement lists not refreshed", err);
  }
}

// ---------------------------------------------------------------------------
// Shop map (plant floor map). Company content — kept in the database only, read by signed-in people:
//   floorMap/layout          size, building outline, zones, icons
//   floorStations/{id}       position, shape, label, description, linked documents, machineId (M-number or null)
//   sops/{key}               full SOP / safety / troubleshooting text
// Admins load it from the original map file (Admin → Shop map) and link stations to machines.
// ---------------------------------------------------------------------------

const floorStations = db.collection("floorStations");
const sopsCol = db.collection("sops");

// Admins: { map } — the original's plant-data.json. Re-importing updates everything but keeps each
// station's machine link. Stations no longer in the file are retired (kept in history), never deleted.
exports.adminImportFloorMap = onCall({ memory: "512MiB" }, async (req) => {
  const adminNumber = await requireAdmin(req);
  const { layout, stations, sops, error } = floorMapLib.cleanMap(req.data?.map);
  if (error) throw new HttpsError("invalid-argument", error);
  const existing = await floorStations.get();
  const now = FieldValue.serverTimestamp();
  const writes = [
    (b) => b.set(db.collection("floorMap").doc("layout"), { ...layout, importedAt: now, importedBy: adminNumber }),
    ...stations.map((s) => (b) => b.set(floorStations.doc(s.id), { ...s, active: true, updatedAt: now }, { merge: true })),
    ...existing.docs.filter((d) => !stations.some((s) => s.id === d.id)).map((d) => (b) => b.update(d.ref, { active: false, updatedAt: now })),
    ...Object.entries(sops).map(([k, s]) => (b) => b.set(sopsCol.doc(k), { ...s, updatedAt: now })),
  ];
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach((w) => w(batch));
    await batch.commit();
  }
  await auditLog.add({ type: "imported", kind: "shop map", recordId: "layout", by: adminNumber, at: now, stations: stations.length, sops: Object.keys(sops).length });
  return { zones: layout.zones.length, stations: stations.length, sops: Object.keys(sops).length };
});

// Admins: { stationId, machineId } — link a map station to a machine (M-number), or null for an area.
exports.adminSetStationMachine = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const stationRef = floorStations.doc(String(req.data?.stationId || ""));
  const machineId = req.data?.machineId ? String(req.data.machineId) : null;
  if (machineId && !records.isMachineId(machineId)) throw new HttpsError("invalid-argument", "Unknown machine ID.");
  await db.runTransaction(async (tx) => {
    const [st, m] = await Promise.all([tx.get(stationRef), machineId ? tx.get(machines.doc(machineId)) : null]);
    if (!st.exists) throw new HttpsError("not-found", "That station isn't on the map.");
    if (machineId && !m.exists) throw new HttpsError("not-found", `There's no machine ${machineId}.`);
    tx.update(stationRef, { machineId, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "linked", "map station", stationRef.id, adminNumber, { label: st.get("label"), machineId });
  });
  return { ok: true };
});

// Admins: { machineIds } — make sure Odoo has an equipment record for each ("M-031 Outside Chiller"),
// so Maintenance Requests work for them. Existing ones are left alone.
exports.adminEnsureOdooEquipment = onCall({ secrets: [odooKey] }, async (req) => {
  const adminNumber = await requireAdmin(req);
  const ids = Array.isArray(req.data?.machineIds) ? [...new Set(req.data.machineIds.map(String))] : [];
  if (!ids.length || ids.length > 50 || !ids.every(records.isMachineId)) throw new HttpsError("invalid-argument", "List 1–50 machine IDs.");
  const key = odooKey.value();
  const refs = await getOdooRefs(key);
  const created = [];
  const already = [];
  for (const id of ids) {
    const snap = await machines.doc(id).get();
    if (!snap.exists) throw new HttpsError("not-found", `There's no machine ${id} in the app.`);
    const found = await odoo.odooCall(key, "maintenance.equipment", "search_read", { domain: [["name", "=like", `${id} %`]], fields: ["id", "name"], limit: 1 });
    if (found.length) { already.push(found[0].name); continue; }
    const lineSnap = snap.get("lineId") ? await lines.doc(snap.get("lineId")).get() : null;
    const name = floorMapLib.odooEquipmentName({ id, name: snap.get("name") }, lineSnap?.exists ? lineSnap.get("name") : "");
    await odoo.odooCall(key, "maintenance.equipment", "create", { vals_list: [{ name, maintenance_team_id: refs.teamId }] });
    created.push(name);
  }
  if (created.length) await auditLog.add({ type: "created", kind: "odoo equipment", recordId: ids.join(","), by: adminNumber, at: FieldValue.serverTimestamp(), created });
  return { created, already };
});

// ---------------------------------------------------------------------------
// Training (the training team's trainer app, in CDG Ops) — see training-api.js.
// ---------------------------------------------------------------------------

Object.assign(exports, trainingApi({ db, auditLog, requireMember, requireAdmin, isTest, col }));
