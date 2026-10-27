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
const formsLib = require("./forms");
const specsLib = require("./machinespecs");
const testData = require("./testdata");
const trucksLib = require("./trucks");
const silosLib = require("./silos");
const reelsLib = require("./reels");
const downtimeLib = require("./downtime");
const callLib = require("./callsheet");
const incidentsLib = require("./incidents");
const rotationLib = require("./rotation");
const hrLib = require("./hraccess");
const offlineLib = require("./offline");
const { AsyncLocalStorage } = require("node:async_hooks");
const deptLib = require("./departments");
const docsLib = require("./documents");
const historyLib = require("./history");
const crewLib = require("./crew");
const verifyLib = require("./verify");
const annTasksLib = require("./anntasks");
const crewSeatsLib = require("./crewseats");
const writeupsLib = require("./writeups");
const retentionLib = require("./retentionrules");
const messagingLib = require("./messaging");
const signoffsLib = require("./signoffs");
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

// Team (Admin → Teams): optional; when set, must exist and be on. (No home lines — Decision 104.)
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
    keepHistory(tx, empSnap.ref, empSnap.data(), changes, adminNumber);
    tx.update(empSnap.ref, { ...changes, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber });
    audit(tx, "updated", employeeNumber, adminNumber, { changes });
    return { employee: { ...empSnap.data(), ...changes }, pinTemp: secretSnap.get("mustChangePin") === true };
  });
  await syncAuthUser(employeeNumber, employee, pinTemp);
  if (changes.active === false) await auth.revokeRefreshTokens(uidFor(employeeNumber));
  if (changes.roles || changes.team !== undefined || changes.active === true) await refreshAnnouncementLists();
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
        team: null, shift: null, active: true, importedFrom: "gusto",
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

// Decision 120 (Chris, 10-27-2026): nothing is overwritten without a record. Saves the old and new value of each field
// that changes, who, and when (server time) in changeHistory (test site: test_changeHistory) — see history.js.
// before = the record as it was; after = the fields being written (action "delete": the whole record goes).
function keepHistory(tx, ref, before, after, by, { byName = null, test = false, action = "update" } = {}) {
  const d = historyLib.diff(before, action === "delete" ? null : after);
  if (d) tx.create(col("changeHistory", test).doc(), { collection: ref.parent.id, docId: ref.id, action, old: d.old, new: d.new, by: by || null, byName, at: FieldValue.serverTimestamp() });
}
// The same, outside a transaction (settings pages): reads the record just before it's written.
async function keepHistoryNow(ref, after, by, { byName = null, test = false } = {}) {
  const snap = await ref.get();
  const d = historyLib.diff(snap.exists ? snap.data() : null, after);
  if (d) await col("changeHistory", test).add({ collection: ref.parent.id, docId: ref.id, action: "update", old: d.old, new: d.new, by: by || null, byName, at: FieldValue.serverTimestamp() });
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
      const changes = { name, ...extra, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber };
      if (active !== undefined) changes.active = active;
      keepHistory(tx, ref, snap.data(), changes, adminNumber);
      tx.update(ref, changes);
      auditRecord(tx, "updated", kind, id, adminNumber, { name, ...extra, ...(active !== undefined ? { active } : {}) });
    }
  });
  return { id };
}

// Roles: create { create: true, name, id? } or update { id, name, active? }.
// The admin role can't be retired — someone has to be able to run the app.
// Optional { canPostAnnouncements: true|false } (Admin → Roles); left out = unchanged.
exports.adminSaveRole = onCall(async (req) => {
  const out = await saveNamedRecord(roles, "role", req, (id, active) => {
    if (id === "admin" && active === false) {
      throw new HttpsError("failed-precondition", "The Admin role can't be retired.");
    }
  }, (d) => {
    const extra = {};
    if (d.canPostAnnouncements !== undefined) {
      if (typeof d.canPostAnnouncements !== "boolean") throw new HttpsError("invalid-argument", "canPostAnnouncements must be true or false.");
      extra.canPostAnnouncements = d.canPostAnnouncements;
    }
    // { postTrucks: true|false } — may post the day's trucks (Trucks board). Unset = Logistics & Distribution.
    if (d.postTrucks !== undefined) {
      if (typeof d.postTrucks !== "boolean") throw new HttpsError("invalid-argument", "postTrucks must be true or false.");
      extra.postTrucks = d.postTrucks;
    }
    // { nav: { key: true|false } } — what people with this role see in More (Decision 108 item 6; web/nav.js). Unset = the
    // approved table.
    if (d.nav !== undefined) {
      const keys = ["crew", "handoff", "shop", "fixes", "issues", "training", "trucksView", "qcList", "downtime"];
      if (!d.nav || typeof d.nav !== "object" || Array.isArray(d.nav) || Object.entries(d.nav).some(([k, v]) => !keys.includes(k) || typeof v !== "boolean")) {
        throw new HttpsError("invalid-argument", "Pick More menu items from the list.");
      }
      extra.nav = d.nav;
    }
    // { editMachines: true|false } — may add and edit machine parts & specs (Machines). Unset = Maintenance and Admin.
    if (d.editMachines !== undefined) {
      if (typeof d.editMachines !== "boolean") throw new HttpsError("invalid-argument", "editMachines must be true or false.");
      extra.editMachines = d.editMachines;
    }
    return extra;
  });
  await Promise.all([writeMachineAccess(), writeTruckAccess()]);
  return out;
});

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
    const changes = { name, type, lineId, ...details, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber };
    if (active !== undefined) changes.active = active;
    keepHistory(tx, ref, snap.data(), changes, adminNumber);
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
  return { employeeNumber, roles, approver: fixesLib.isApprover(roles), name: snap.get("name") || `Employee ${employeeNumber}`, hr: hrLib.hasHr(snap.data()) };
}

// HR access (hraccess.js): injury report details, write-ups and reviews. A per-person switch, not a role.
async function requireHr(req) {
  const me = await requireMember(req);
  if (!me.hr) throw new HttpsError("permission-denied", "This needs HR access. Ask the person who has HR access.");
  return me;
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
      tx.update(original.ref, { ...fields, updatedBy: p.createdBy, updatedAt: now, approvedBy: me.employeeNumber, approvedByName: me.name, approvedAt: now });
      tx.update(snap.ref, { status: "merged", reviewedBy: me.employeeNumber, reviewedByName: me.name, reviewedAt: now });
      logSignoff(tx, test, { kind: "fix-approved", refId: p.editOf, version: signoffsLib.contentVersion(fields), suggestion: id, emp: me.employeeNumber, name: me.name, method: "app" });
      auditRecord(tx, "approved-edit", "fix", p.editOf, me.employeeNumber, { suggestion: id, title: p.title, test });
      return { id: p.editOf, status: "approved" };
    }
    tx.update(snap.ref, { status: "approved", approvedBy: me.employeeNumber, approvedByName: me.name, approvedAt: now, updatedAt: now });
    logSignoff(tx, test, { kind: "fix-approved", refId: id, version: signoffsLib.contentVersion(Object.fromEntries(FIX_FIELDS.map((k) => [k, p[k]]))), emp: me.employeeNumber, name: me.name, method: "app" });
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
    tx.update(snap.ref, { votes, helpfulYes: yes, helpfulNo: no, lastVoteAt: FieldValue.serverTimestamp(), lastVoteBy: me.employeeNumber });
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
      { name, machineTypes: fixesLib.machineTypesForOldCategory(name), active: true, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber },
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
  const me = await requireMember(req);
  if (isTest(req)) return { ok: true }; // test-site searches aren't counted
  const term = fixesLib.cleanSearchTerm(req.data?.term);
  if (!term) return { ok: false };
  const ref = searchGaps.doc(fixesLib.searchGapId(term));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      // Searched again: count it, and bring it back if it had been marked done (the fix still isn't found).
      tx.update(ref, { count: FieldValue.increment(1), lastAt: FieldValue.serverTimestamp(), lastBy: me.employeeNumber, done: false });
    } else {
      tx.create(ref, { term, count: 1, firstAt: FieldValue.serverTimestamp(), firstBy: me.employeeNumber, lastAt: FieldValue.serverTimestamp(), lastBy: me.employeeNumber, done: false });
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
    tx.update(ref, { done, markedAt: FieldValue.serverTimestamp(), markedBy: adminNumber });
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
        name: categoryName, machineTypes: fixesLib.machineTypesForOldCategory(categoryName), active: true, updatedAt: now, updatedBy: adminNumber,
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
// A small summary everyone can read (the issues themselves stay Maintenance/Admin/Production Manager only).
//   meta/plantStatus  { down: { [lineId]: { since: ms, machineIds: [] } }, updatedAt }   (test site: test_meta)
async function writePlantStatus(test) {
  try {
    const [open, machineSnaps] = await Promise.all([col("issues", test).where("open", "==", true).get(), machines.get()]);
    const lineOf = new Map(machineSnaps.docs.map((m) => [m.id, m.get("lineId") || null]));
    const lineIds = new Set((await lines.get()).docs.filter((l) => l.get("active") !== false).map((l) => l.id));
    const down = {};
    let unknown = 0;
    const testCutoff = Date.now() - 24 * 3600000; // test site: practice line-downs stop counting after 24 hours
    for (const d of open.docs) {
      if (d.get("lineDown") !== true) continue;
      if (test && (d.get("reportedAt")?.toMillis?.() || 0) < testCutoff) continue;
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
      machineId: machine.id, lineId: machine.lineId || null, lineDown: report.lineDown, unsafe: report.unsafe, severity: report.severity,
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
    machineId: machine.id, lineId: machine.lineId || null, lineDown: report.lineDown, unsafe: report.unsafe, severity: report.severity,
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
    await logSignoffNow(true, { kind: "issue-fixed", refId: ref.id, version: signoffsLib.contentVersion({ title: snap.get("title"), note }), emp: me.employeeNumber, name, method: "app" });
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
  await logSignoffNow(false, { kind: "issue-fixed", refId: ref.id, version: signoffsLib.contentVersion({ odooId: snap.get("odooId"), title: snap.get("title"), note }), emp: me.employeeNumber, name, method: "app" });
  const machineId = snap.get("machineId");
  if (machineId) await machines.doc(machineId).set({ lastRepairDate: today, lastRepairAt: FieldValue.serverTimestamp(), lastRepairBy: me.employeeNumber, lastRepairIssue: ref.id }, { merge: true }).catch(() => {});
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
  await ref.update({ lineDown: false, lineBackUpAt: FieldValue.serverTimestamp(), lineBackUpBy: name, lineBackUpByEmp: me.employeeNumber });
  await logSignoffNow(test, { kind: "line-back-up", refId: ref.id, version: signoffsLib.contentVersion({ odooId: snap.get("odooId") || null, title: snap.get("title") }), emp: me.employeeNumber, name, method: "app" });
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
  const [stillOpen, machineSnaps] = await Promise.all([issues.where("open", "==", true).get(), machines.get()]);
  const lineOf = new Map(machineSnaps.docs.map((m) => [m.id, m.get("lineId") || null]));
  const was = new Map(stillOpen.docs.map((d) => [d.id, d.data()]));
  // Decision 120: what a sync changes on an issue the app already has is kept, like a person's edit.
  const SYNC = "system:odoo-sync";
  const history = (ref, before, next) => {
    const d = before && historyLib.diff(before, next);
    if (d) writes.push(col("changeHistory", false).add({ collection: "issues", docId: ref.id, action: "update", old: d.old, new: d.new, by: SYNC, byName: "Odoo sync", at: FieldValue.serverTimestamp() }));
  };
  const writes = [];
  for (const r of open) {
    const ref = issues.doc(`odoo-${r.id}`);
    const next = { ...issueFromRequest(r), open: true };
    next.lineId = lineOf.get(next.machineId) ?? null;
    history(ref, was.get(ref.id), next);
    writes.push(ref.set(next, { merge: true }));
  }

  // 2. Issues the app still shows as open but Odoo has closed (or deleted).
  const gone = stillOpen.docs.filter((d) => !openIds.has(d.id));
  if (gone.length) {
    const closed = await odoo.odooCall(key, "maintenance.request", "search_read", {
      domain: [["id", "in", gone.map((d) => d.get("odooId"))]], fields: ISSUE_FIELDS,
      context: { active_test: false },
    });
    const byId = new Map(closed.map((r) => [r.id, r]));
    for (const d of gone) {
      const r = byId.get(d.get("odooId"));
      const next = { ...(r ? issueFromRequest(r) : {}), open: false, closedAt: r?.close_date ? new Date(`${r.close_date}T12:00:00Z`) : FieldValue.serverTimestamp() };
      history(d.ref, d.data(), next);
      writes.push(d.ref.set(next, { merge: true }));
    }
  }

  // 3. Last PM / last repair for every machine.
  const done = await odoo.odooCall(key, "maintenance.request", "search_read", {
    domain: [["close_date", "!=", false], ["equipment_id", "!=", false]],
    fields: ["equipment_id", "maintenance_type", "close_date"], limit: 5000,
  });
  const dates = odoo.lastDatesByMachine(done);
  for (const m of machineSnaps.docs) {
    const d = dates[m.id];
    if (!d) continue;
    const update = {};
    if (d.pm && d.pm !== m.get("lastPmDate")) update.lastPmDate = d.pm;
    if (d.repair && d.repair !== m.get("lastRepairDate")) update.lastRepairDate = d.repair;
    if (Object.keys(update).length) {
      const d = historyLib.diff(m.data(), update);
      if (d) writes.push(col("changeHistory", false).add({ collection: "machines", docId: m.id, action: "update", old: d.old, new: d.new, by: SYNC, byName: "Odoo sync", at: FieldValue.serverTimestamp() }));
      writes.push(m.ref.update({ ...update, datesSyncedAt: FieldValue.serverTimestamp() }));
    }
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
exports.signChecklist = onCall(signable(async (req) => {
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
  // The exact version signed (Decision 108): the template's revision and the words of each item as signed.
  const rev = template.rev || 1;
  const itemTexts = Object.fromEntries((template.items || []).filter((i) => itemIds.includes(i.id)).map((i) => [i.id, i.text || ""]));

  const at = Date.now();
  const done = Object.fromEntries(itemIds.map((id) => [id, { at, by: me.employeeNumber, byName: me.name }]));
  const batch = db.batch();
  const signoffRef = col("checklistSignoffs", test).doc();
  // pending: sign-offs waiting for Verified (two-step sign-off, verify.js); due dates count from Done.
  batch.set(
    col("checklistUnits", test).doc(unit.id),
    { templateId: unit.templateId, lineId: unit.lineId, items: done, pending: { [signoffRef.id]: { items: itemIds, by: me.employeeNumber, byName: me.name, at, rev } }, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
  batch.create(signoffRef, {
    unitId: unit.id, templateId: unit.templateId, lineId: unit.lineId, items: itemIds, rev, itemTexts,
    by: me.employeeNumber, byName: me.name, method: "pin", device, signedOn: signedIn.employeeNumber,
    at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
  });
  logSignoff(batch, test, { kind: "checklist", refId: unit.id, version: rev, itemTexts, items: itemIds, emp: me.employeeNumber, name: me.name, method: "pin", device, signedOn: signedIn.employeeNumber });
  await batch.commit();
  return { ok: true, count: itemIds.length, name: me.name, test };
}));

// Verified, for one sign-off waiting on a checklist: { unitId, signoffId, signer: { emp, pin }, device }. A Supervisor —
// or, with no Supervisor on shift, the Production Manager or a Line Lead. Not the person who signed it.
exports.verifyChecklist = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const unitRef = col("checklistUnits", test).doc(String(req.data?.unitId || "x"));
  const signoffId = String(req.data?.signoffId || "");
  const supervisorOnShift = await supervisorOnShiftNow(test);
  const w = await db.runTransaction(async (tx) => {
    const snap = await tx.get(unitRef);
    const p = snap.exists ? snap.get("pending")?.[signoffId] : null;
    if (!p) throw new HttpsError("failed-precondition", "That sign-off is already verified (or no longer waiting).");
    const who = requireVerifier(signer, supervisorOnShift, [p.by]);
    const stamp = verifyStamp(signer, who, device);
    tx.update(unitRef, { [`pending.${signoffId}`]: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    tx.update(col("checklistSignoffs", test).doc(signoffId), { verified: stamp });
    logSignoff(tx, test, { kind: "checklist-verify", refId: unitRef.id, version: p.rev || 1, signoffId, items: p.items, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber, role: who.role, backup: who.backup });
    return who;
  });
  return { ok: true, name: signer.name, role: w.roleName, backup: w.backup, test };
}));

// Who can verify on this device's sheet (line tablets): { unitId, signoffId } -> who may verify right now, with a login.
exports.checklistVerifiers = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const snap = await col("checklistUnits", test).doc(String(req.data?.unitId || "x")).get();
  const p = snap.exists ? snap.get("pending")?.[String(req.data?.signoffId || "")] : null;
  const people = (await peopleList()).filter((x) => x.active && x.loginEnabled && x.id !== me.employeeNumber);
  const list = verifyLib.verifiers(people, { supervisorOnShift: await supervisorOnShiftNow(test), doers: [p?.by].filter(Boolean) });
  return { people: list.map((x) => ({ emp: x.id, name: x.name })) };
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

// Admins and the checklist department's head (Decision 116): create { create: true, department?, name, machineTypes,
// perLine, everyDays, items: [{ text }] } or update { id, ...same, active? }. Items keep their history and training
// media when reworded.
exports.adminSaveChecklist = onCall(async (req) => {
  const isNew = req.data?.create === true;
  const key = isNew ? `checklist:${records.idFromName(String(req.data?.name || "")) || "new"}` : `checklist:${String(req.data?.id || "")}`;
  const { me, dept } = await requireDocEditor(req, key, isNew ? { newDept: req.data?.department } : {});
  const adminNumber = me.employeeNumber;
  return db.runTransaction(async (tx) => {
    if (isNew) {
      const template = requireTemplate(req.data, null);
      const id = records.idFromName(template.name);
      if (!records.isRecordId(id)) throw new HttpsError("invalid-argument", "Name must start with a letter.");
      const ref = checklistTemplates.doc(id);
      if ((await tx.get(ref)).exists) throw new HttpsError("already-exists", `"${template.name}" already exists.`);
      // Revisions (Decision 108): rev 1 now; every change saves the new words as the next revision.
      const doc = { ...template, rev: 1, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
      tx.create(ref, doc);
      tx.create(ref.collection("revisions").doc("1"), { ...template, rev: 1, savedAt: FieldValue.serverTimestamp(), savedBy: adminNumber, savedByName: me.name });
      if (dept) tx.set(docDeptsDoc, { departments: { [`checklist:${id}`]: dept } }, { merge: true });
      auditRecord(tx, "created", "checklist", id, adminNumber, { name: template.name });
      return { id };
    }
    const ref = checklistTemplates.doc(String(req.data?.id || ""));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That checklist no longer exists.");
    const template = requireTemplate(req.data, snap.data());
    trashTemplateFiles(tx, snap.data(), template, ref.id, adminNumber);
    // Old sign-offs keep the rev and words they signed; this saves the new words as the next revision.
    const rev = (snap.get("rev") || 1) + 1;
    tx.update(ref, { ...template, rev, updatedAt: FieldValue.serverTimestamp() });
    tx.create(ref.collection("revisions").doc(String(rev)), { ...template, rev, savedAt: FieldValue.serverTimestamp(), savedBy: adminNumber, savedByName: me.name });
    auditRecord(tx, "updated", "checklist", ref.id, adminNumber, { name: template.name, items: template.items.length, active: template.active, rev });
    return { id: ref.id, rev };
  });
});

// Admins and the checklist department's head: { templateId, itemId, photos, videos } — training photos/videos for one item.
exports.adminSetChecklistMedia = onCall(async (req) => {
  const adminNumber = (await requireDocEditor(req, `checklist:${String(req.data?.templateId || "")}`)).me.employeeNumber;
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
    const was = before.items.find((i) => i.id === itemIdIn);
    keepHistory(tx, ref, { [`media.${itemIdIn}`]: { photos: was.photos || [], videos: was.videos || [] } }, { [`media.${itemIdIn}`]: { photos, videos } }, adminNumber);
    tx.update(ref, { items: after.items, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber });
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
  const [allFixes, templates, oldFiles, oldFixes, specs] = await Promise.all([
    col("fixes", test).get(),
    checklistTemplates.get(),
    col("trash", test).where("purgeAfter", "<", now).get(),
    col("fixes", test).where("status", "==", "trashed").where("purgeAfter", "<", now).get(),
    machineSpecs.get(),
  ]);
  const goingIds = new Set(oldFixes.docs.map((d) => d.id));
  const inUse = new Set([
    ...allFixes.docs.filter((d) => !goingIds.has(d.id)).flatMap((d) => fixesLib.fileLinks(d.data())),
    ...templates.docs.flatMap((d) => (d.get("items") || []).flatMap((i) => [...(i.photos || []), ...(i.videos || [])])),
    ...specs.docs.flatMap((d) => (d.get("files") || []).map((f) => f.url)),
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
  // Machines: rows and files removed more than 30 days ago (live list only — the test site edits the same list).
  if (!test) {
    for (const m of specs.docs) {
      const old = await m.ref.collection("removed").where("purgeAfter", "<", now).get();
      for (const r of old.docs) {
        if (r.get("section") === "files" && r.get("row")?.url) await removeFile(r.get("row").url);
        await r.ref.delete();
        files++;
      }
    }
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
    if (status === "done") logSignoff(tx, test, { kind: "request-done", refId: ref.id, version: signoffsLib.contentVersion({ typeId: cur.typeId, description: cur.description, note }), emp: me.employeeNumber, name: me.name, method: "app" });
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
    if (!isNew) keepHistory(tx, ref, snap.data(), type, adminNumber);
    tx.set(ref, { ...type, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber, ...(isNew ? { createdAt: FieldValue.serverTimestamp() } : {}) }, { merge: true });
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

// The sign-off log (Decision 108 item 10): every entry has name, employee #, the time (server), and the exact version
// signed — an entry without them is a bug, so it stops the sign-off instead of saving a weak record (signoffs.js).
function logSignoff(tx, test, entry) {
  const gap = signoffsLib.missing(entry);
  if (gap) throw new HttpsError("internal", gap);
  const sent = offlineSend.getStore() || {};
  const signedAtMs = sent.signedAtMs;
  tx.create(col("signoffs", test).doc(), {
    ...entry, at: FieldValue.serverTimestamp(), ...(signedAtMs ? { signedAtMs, offline: true } : {}),
    // Decision 120: the device's own time, always kept; flagged when its clock is ahead or it arrived much later.
    ...(sent.deviceAtMs ? { deviceAtMs: sent.deviceAtMs } : {}), ...(sent.clockFlag ? { clockFlag: sent.clockFlag } : {}),
    ...(test ? { test: true } : {}),
  });
  if (sent.clockFlag) {
    tx.create(auditLog.doc(), { type: "clock flag", kind: "sign-off", recordId: entry.refId || null, by: entry.emp, at: FieldValue.serverTimestamp(),
      flag: sent.clockFlag, deviceAtMs: sent.deviceAtMs, signoffKind: entry.kind, device: entry.device?.label || null, ...(test ? { test: true } : {}) });
  }
}
// The same, outside a transaction (actions that aren't a PIN sign-off: request done, issue fixed, fix approved …).
async function logSignoffNow(test, entry) {
  const batch = db.batch();
  logSignoff(batch, test, entry);
  await batch.commit();
}

// Offline sign-offs (offline.js): a sign-off saved on a device with no connection arrives later with { clientId,
// signedAtMs }. The PIN is checked now, as usual. The same clientId is applied only once — a second send (a reply
// lost on bad Wi-Fi) gets the first result back — and the sign-off record keeps when it was signed on the floor.
// Without a clientId (older screens) nothing changes.
const offlineSend = new AsyncLocalStorage();
function signable(handler) {
  return async (req) => {
    const clientId = offlineLib.cleanClientId(req.data?.clientId);
    if (!clientId) return handler(req);
    requireSignedIn(req); // never look up a receipt for someone not signed in
    const ref = col("outboxReceipts", isTest(req)).doc(clientId);
    const prior = await ref.get();
    if (prior.exists) return { ...(prior.get("result") || {}), already: true };
    const now = Date.now();
    const signedAtMs = offlineLib.cleanSignedAt(req.data?.signedAtMs, now);
    const { deviceAtMs, clockFlag } = offlineLib.clockCheck(req.data?.signedAtMs, now);
    const result = await offlineSend.run({ signedAtMs, deviceAtMs, clockFlag }, () => handler(req));
    await ref.set({ result: result ?? null, atMs: Date.now(), signedAtMs, deviceAtMs, clockFlag, by: req.auth?.uid || null, ...(isTest(req) ? { test: true } : {}) });
    return result;
  };
}

// Everyone, with whether they have a login yet (PIN records are only checked for existence, never read).
async function peopleList() {
  const [e, s] = await Promise.all([employees.get(), pinSecrets.select().get()]);
  const login = new Set(s.docs.map((d) => d.id));
  return e.docs.map((d) => ({
    id: d.id, name: d.get("name") || `Employee ${d.id}`, roles: d.get("roles") || [], team: d.get("team") || null,
    active: d.get("active") !== false, loginEnabled: login.has(d.id),
    supervisesTeams: d.get("supervisesTeams") || [], position: d.get("position") || "", trainingName: d.get("trainingName") || null,
    department: d.get("department") || null,
  }));
}

// Active departments [{ id, name }] (Admin → Departments), for audiences.
async function departmentList() {
  const snap = await db.collection("meta").doc("departments").get();
  return (snap.get("departments") || deptLib.startingDepartments()).filter((x) => x.active !== false).map((x) => ({ id: x.id, name: x.name }));
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

// Posters (department heads, Admins, and people ticked "Can post" — Decision 106) and people who see everything: the people list for an audience.
async function posterOf(me) {
  const snap = await employees.doc(me.employeeNumber).get();
  return { roles: me.roles, deptHead: snap.get("deptHead") === true, department: snap.get("department") || null, canPost: snap.get("canPost") === true };
}
async function canPostAnnouncements(me) {
  return annLib.canPostNow(await posterOf(me));
}
exports.announcementPeople = onCall(async (req) => {
  const me = await requireMember(req);
  if (!(await canPostAnnouncements(me)) && !hasRole(me.roles, annLib.SEE_ALL_ROLES)) {
    throw new HttpsError("permission-denied", "Only department heads, Admins, and people an Admin allows post announcements.");
  }
  const [list, onLines, departments, poster] = await Promise.all([peopleList(), shiftLineAssignments(isTest(req)), departmentList(), posterOf(me)]);
  const people = withShiftLines(list.filter((p) => p.active), onLines);
  people.sort((x, y) => x.name.localeCompare(y.name));
  // Decision 108: what this poster may pick, and the audience a new announcement starts with.
  return {
    people: people.map(({ id, name, roles: r, team, department, supervisesTeams, lineIds, loginEnabled }) => ({ id, name, roles: r, team, department, supervisesTeams, lineIds, loginEnabled })),
    departments, options: annLib.postOptions(poster),
  };
});

// Post { title, body, priority, ackBy, endDate?, file?, audience, keepForNewHires } or edit (same plus { id }).
// Editing the words, attachment, or priority makes a new version — everyone signs again (old signatures stay).
exports.postAnnouncement = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const [roleSnaps, teamSnaps, lineSnaps, everyone, onLines, departments, poster] = await Promise.all([roles.get(), teams.get(), lines.get(), peopleList(), shiftLineAssignments(test), departmentList(), posterOf(me)]);
  const people = withShiftLines(everyone, onLines); // a line audience = who is on that line this shift (Decision 104)
  const live = (snaps) => snaps.docs.filter((d) => d.get("active") !== false).map((d) => d.id);
  const roleDocs = roleSnaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  const known = { roles: live(roleSnaps), teams: live(teamSnaps), lines: live(lineSnaps), departments: departments.map((x) => x.id) };
  const { announcement, error } = annLib.cleanAnnouncement(req.data, known, (u) => (fixesLib.storagePath(u, BUCKET) || "").startsWith("uploads/"), plantToday());
  if (error) throw new HttpsError("invalid-argument", error);
  const notAllowed = annLib.checkAudience(announcement.audience, annLib.postOptions(poster)); // Decision 108
  if (notAllowed) throw new HttpsError("permission-denied", notAllowed);
  const audienceEmps = annLib.matchAudience(announcement.audience, people);
  if (!audienceEmps.length) throw new HttpsError("invalid-argument", "Nobody matches that audience right now. Pick others.");
  if (!annLib.signersOf({ ...announcement, audienceEmps }, people).length) {
    throw new HttpsError("invalid-argument", "Important announcements are signed by the Line Leads and Supervisors in the audience, and there are none. Add them, or pick Normal.");
  }
  const trackers = annLib.trackersFor(me.employeeNumber, audienceEmps, people);
  const editId = req.data?.id ? String(req.data.id) : null;
  const now = FieldValue.serverTimestamp();

  if (!editId) {
    if (!(await canPostAnnouncements(me))) throw new HttpsError("permission-denied", "Only department heads, Admins, and people an Admin allows post announcements.");
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
    keepHistory(tx, ref, cur, announcement, me.employeeNumber, { byName: me.name, test });
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
exports.signAnnouncement = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const { snap } = await findAnnouncement(test, String(req.data?.id || ""));
  const a = snap.data();
  if (!(a.audienceEmps || []).includes(signer.employeeNumber)) throw new HttpsError("permission-denied", `This announcement isn't for ${signer.name}.`);
  if (!annLib.signsIt(a, signer.roles)) throw new HttpsError("permission-denied", `Line Leads and Supervisors sign Important announcements — ${signer.name} doesn't need to.`);
  if (annLib.isEnded(a, plantToday())) throw new HttpsError("failed-precondition", "This announcement has ended — nothing to sign.");
  if (Number(req.data?.version) !== (a.version || 1)) throw new HttpsError("failed-precondition", "It was just updated. Read the new version, then sign.");
  const version = a.version || 1;
  const ref = sigCol(test).doc(sigId(snap.id, version, signer.employeeNumber));
  const already = await db.runTransaction(async (tx) => {
    const [sig, now] = await Promise.all([tx.get(ref), tx.get(snap.ref)]);
    if ((now.get("version") || 1) !== version) throw new HttpsError("failed-precondition", "It was just updated. Read the new version, then sign.");
    if (sig.exists) return true;
    tx.create(ref, {
      annId: snap.id, version, title: a.title, emp: signer.employeeNumber, name: signer.name, method: "pin", device,
      signedOn: me.employeeNumber, at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
    });
    logSignoff(tx, test, { kind: "announcement", refId: snap.id, version, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
    return false;
  });
  return { ok: true, already, name: signer.name, version, test };
}));

// "Opened" (Chris, 10-23-2026): someone who reads an Important announcement they don't sign (the crew) — saved per
// person, so it leaves the top of their Home on every device. { id, version }. announcementOpens/{id}__v{n}__{emp}.
exports.markAnnouncementOpened = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const { snap } = await findAnnouncement(test, String(req.data?.id || ""));
  const a = snap.data();
  if (!(a.audienceEmps || []).includes(me.employeeNumber)) throw new HttpsError("permission-denied", "This announcement isn't for you.");
  const version = a.version || 1;
  await col("announcementOpens", test).doc(`${snap.id}__v${version}__${me.employeeNumber}`).set({
    annId: snap.id, version, emp: me.employeeNumber, at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
  }, { merge: true });
  return { ok: true };
});

// Supervisor, Production Manager, Admin — for someone with no login yet: { id, emp, note, signer: { emp, pin }, device }.
// Signed with the recorder's own PIN; the note says how it was reviewed.
exports.recordReviewedInPerson = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  if (signer.employeeNumber !== me.employeeNumber) throw new HttpsError("permission-denied", "Use your own PIN.");
  if (!hasRole(signer.roles, annLib.IN_PERSON_ROLES)) throw new HttpsError("permission-denied", "Only Supervisors, the Production Manager, and Admins can record this.");
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
  if (!annLib.signsIt(a, person.roles)) throw new HttpsError("failed-precondition", `Line Leads and Supervisors sign Important announcements — ${person.name} doesn't need to.`);
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
}));

// Who has and hasn't signed one announcement (current version). Poster, Production Manager, Office, Admin: everyone;
// Supervisors: their crew.
async function trackingFor(me, test, id) {
  const { snap, readOnly } = await findAnnouncement(test, id);
  const a = snap.data();
  const scope = annLib.trackScope({ id: me.employeeNumber, roles: me.roles }, a);
  if (!scope) throw new HttpsError("permission-denied", "Only the poster, Production Manager, Office, Admins, and Supervisors (for their crew) can see this.");
  const people = await peopleList();
  const byId = new Map(people.map((p) => [p.id, p]));
  let ids = annLib.signersOf(a, people); // Important: only the Line Leads and Supervisors
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
      { id: emp, name: p.name, loginEnabled: p.loginEnabled, team: p.team || null, active: p.active !== false, olderVersion: older || null },
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
    createdAt: ms(a.createdAt), scope, noCrew: scope === "crew" && !meRecord?.team,
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
// "all": Production Manager, Office, Admin. "crew": Supervisors.
exports.announcementSummary = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const scope = req.data?.scope === "crew" ? "crew" : "all";
  if (scope === "all" && !hasRole(me.roles, annLib.SEE_ALL_ROLES)) throw new HttpsError("permission-denied", "Production Manager, Office, and Admins only.");
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
    const ids = annLib.signersOf(a, people).filter((e) => !crew || crew.has(e));
    const list = ids.map((emp) => annLib.personStatus({ id: emp, loginEnabled: byId.get(emp)?.loginEnabled === true }, sigs.find((s) => s.annId === d.id && s.emp === emp && s.version === (a.version || 1)) || null));
    const overdue = annLib.isOverdue(a, today);
    for (const p of list) if (p.state === "not-signed" || p.state === "no-login") { behind.add(p.id); if (overdue) behindOverdue.add(p.id); }
    return { id: d.id, title: a.title, priority: a.priority, ackBy: a.ackBy, overdue, test: d.ref.parent.id.startsWith("test_"), ...annLib.countUp(list) };
  }).filter((x) => x.total > 0);
  return { scope, items, behind: behind.size, behindOverdue: behindOverdue.size, noCrew: scope === "crew" && !meRecord?.team };
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
    list = people.filter((p) => audience.has(p.id) && annLib.signsIt(a, p.roles) && !signed.has(p.id));
  }
  list.sort((x, y) => x.name.localeCompare(y.name));
  return { people: list.filter((p) => p.id !== me.employeeNumber).map((p) => ({ emp: p.id, name: p.name })) };
});

// After people change (new hire, roles, team): kept-for-new-hires announcements pick up anyone who
// now matches, and supervisors' tracking follows their crew. Never fails the change that called it.
async function refreshAnnouncementLists() {
  try {
    const everyone = await peopleList();
    for (const test of [false, true]) {
      const people = withShiftLines(everyone, await shiftLineAssignments(test));
      const snaps = await annCol(test).where("ended", "==", false).get();
      for (const d of snaps.docs) {
        const a = d.data();
        const audienceEmps = annLib.refreshedAudience(a, people);
        const trackers = annLib.trackersFor(a.createdBy, audienceEmps, people);
        if (audienceEmps.join() !== (a.audienceEmps || []).join() || trackers.join() !== (a.trackers || []).join()) {
          await d.ref.update({ audienceEmps, trackers, listsRefreshedAt: FieldValue.serverTimestamp() });
        }
      }
    }
  } catch (err) {
    console.error("announcement lists not refreshed", err);
  }
}

// ---------------------------------------------------------------------------
// Forms admins edit without code changes (rules in forms.js). The wording lives only here in the database.
//   formTemplates/{formId}                 name, kind, intro, sections, rev, revAt, revBy, revByName, revNote
//   formTemplates/{formId}/revisions/{n}   every revision as it was (records keep the revision they started on)
// Who may edit: Admins, and the head of the form's department (Decision 116, replacing the per-role switch of Decision 60).
// ---------------------------------------------------------------------------

const formTemplates = db.collection("formTemplates");

// Until the release (Chris, 10-26-2026): roles that the live Admin → Roles screen lets edit a form (role.editForms,
// Decision 60) keep editing that existing form, so department heads can work on the test site now without changing
// the live site. Remove at release, with the adminSaveRole change.
async function legacyFormEditor(req, formId, isNew, err) {
  if (isNew || err?.code !== "permission-denied") throw err;
  const me = await requireMember(req);
  const roleDocs = (await roles.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!roleDocs.some((r) => r.active !== false && me.roles.includes(r.id) && (r.editForms || []).includes(formId))) throw err;
  return { me, dept: null };
}

// { formId, create?, department? (new forms), name, kind, intro, sections, note } — saves a new revision (or the first one).
// Records already started keep the revision they started on; the next one started uses this.
exports.saveFormTemplate = onCall(async (req) => {
  const formId = String(req.data?.formId || "");
  if (!records.isRecordId(formId)) throw new HttpsError("invalid-argument", "Form id must start with a letter (e.g. handoff).");
  const isNew = req.data?.create === true;
  const { me, dept } = await requireDocEditor(req, `form:${formId}`, isNew ? { newDept: req.data?.department } : {}).catch((err) => legacyFormEditor(req, formId, isNew, err));
  const { template, error } = formsLib.cleanTemplate(req.data);
  if (error) throw new HttpsError("invalid-argument", error);
  const note = typeof req.data?.note === "string" ? req.data.note.trim().slice(0, 300) : "";
  const ref = formTemplates.doc(formId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (req.data?.create === true && snap.exists) throw new HttpsError("already-exists", "That form already exists — open it to edit it.");
    if (req.data?.create !== true && !snap.exists) throw new HttpsError("not-found", "That form no longer exists.");
    const before = snap.exists ? snap.data() : null;
    const changes = formsLib.describeChange(before, template);
    if (before && changes === "No changes") throw new HttpsError("failed-precondition", "Nothing changed, so no new revision was made.");
    const rev = (before?.rev || 0) + 1;
    const doc = { ...template, rev, revAt: FieldValue.serverTimestamp(), revBy: me.employeeNumber, revByName: me.name, revNote: note || changes, revChanges: changes, active: true };
    tx.set(ref, doc);
    tx.create(ref.collection("revisions").doc(String(rev)), doc);
    if (!before && dept) tx.set(docDeptsDoc, { departments: { [`form:${formId}`]: dept } }, { merge: true });
    auditRecord(tx, before ? "revised" : "created", "form", formId, me.employeeNumber, { rev, note: note || changes });
    return { formId, rev, changes };
  });
});

// ---------------------------------------------------------------------------
// Shift Handoff Notes (Decision 60) — the Line Lead Pass Down, in the app.
//   handoffs/{auto}   formRev, sections (copy of that revision), lines (copy), team, toTeam, date, values,
//                     auto (lines down, open maintenance issues, overdue checklists — captured when sent),
//                     status draft | sent | received | discarded, createdBy/Name, sentBy {emp,name,device,at},
//                     receivedBy {emp,name,device,at}
// The outgoing lead signs with PIN; the incoming team's Line Lead signs received (it's on their Home until then).
// Test site: test_handoffs; the notification goes only to the person testing.
// ---------------------------------------------------------------------------

const handoffCol = (test) => col("handoffs", test);

async function requireHandoffRole(req) {
  const me = await requireMember(req);
  if (!me.roles.some((r) => formsLib.HANDOFF_ROLES.includes(r))) throw new HttpsError("permission-denied", "Handoffs are for Line Leads, Supervisors, the Production Manager, and Admins.");
  return me;
}

// What the app already knows, shown read-only on the handoff: lines down, open maintenance issues, overdue checklists.
async function handoffAutoFill(test) {
  const read = async (path) => { const s = await db.doc(path).get(); return s.exists ? s.data() : {}; };
  const [plantReal, plantTest, lineSnaps, issueSnaps, testIssueSnaps, unitsLive, unitDocs, testUnitDocs] = await Promise.all([
    read("meta/plantStatus"), test ? read("test_meta/plantStatus") : {}, lines.get(),
    issues.where("open", "==", true).get(), test ? col("issues", true).where("open", "==", true).get() : { docs: [] },
    liveUnits(), col("checklistUnits", false).get(), test ? col("checklistUnits", true).get() : { docs: [] },
  ]);
  const lineName = new Map(lineSnaps.docs.map((d) => [d.id, d.get("name")]));
  const down = { ...(plantReal.down || {}), ...(plantTest.down || {}) };
  const linesDown = Object.entries(down).map(([lineId, v]) => ({ lineId, line: lineName.get(lineId) || lineId, since: v.since || null, machineIds: v.machineIds || [] }));
  const openIssues = [...issueSnaps.docs, ...testIssueSnaps.docs].map((d) => d.data())
    .sort((a, b) => (b.lineDown === true) - (a.lineDown === true) || (b.unsafe === true) - (a.unsafe === true))
    .slice(0, 40)
    .map((i) => ({ title: String(i.title || "").slice(0, 160), machineId: i.machineId || null, lineDown: i.lineDown === true, unsafe: i.unsafe === true, odooId: i.odooId || null }));
  const done = {};
  for (const d of [...unitDocs.docs, ...testUnitDocs.docs]) {
    const items = d.get("items") || {};
    done[d.id] = { ...(done[d.id] || {}) };
    for (const [k, v] of Object.entries(items)) if (!done[d.id][k] || (v.at || 0) > (done[d.id][k].at || 0)) done[d.id][k] = v;
  }
  const now = Date.now();
  // Test site: checklists start fresh each shift (14-day items can't fall overdue within one shift), so none are overdue.
  const overdueChecklists = test ? [] : unitsLive.units
    .map((u) => ({ u, t: unitsLive.templates.find((t) => t.id === u.templateId) }))
    .filter(({ u, t }) => t && checklistsLib.unitStatus(t, done[u.id], now).overdue)
    .map(({ u, t }) => (u.lineId ? `${lineName.get(u.lineId) || u.lineId} · ${t.name}` : t.name));
  return { linesDown, openIssues, overdueChecklists, at: now };
}

exports.handoffAutoFill = onCall(async (req) => {
  await requireHandoffRole(req);
  return handoffAutoFill(isTest(req));
});

async function activeTeamIds() {
  return (await teams.get()).docs.filter((d) => d.get("active") !== false).map((d) => d.id);
}

// Start a handoff (or carry on with your own unsent one): { team, toTeam, date }. It copies the current form
// revision and the lines on now, so it finishes on the version it started with.
exports.startHandoff = onCall(async (req) => {
  const me = await requireHandoffRole(req);
  const test = isTest(req);
  const mine = await handoffCol(test).where("createdBy", "==", me.employeeNumber).where("status", "==", "draft").limit(1).get();
  if (!mine.empty) return { id: mine.docs[0].id, resumed: true };
  const { header, error } = formsLib.cleanHandoffHeader(req.data, await activeTeamIds());
  if (error) throw new HttpsError("invalid-argument", error);
  const form = await formTemplates.doc("handoff").get();
  if (!form.exists || form.get("active") === false) throw new HttpsError("failed-precondition", "The handoff form isn't set up yet. An admin loads it in Admin → Forms.");
  const lineList = (await lines.get()).docs.filter((d) => d.get("active") !== false).map((d) => ({ id: d.id, name: d.get("name") }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const ref = handoffCol(test).doc();
  await ref.set({
    formId: "handoff", formRev: form.get("rev"), formName: form.get("name"), intro: form.get("intro") || "", sections: form.get("sections"),
    lines: lineList, ...header, values: {}, status: "draft",
    createdBy: me.employeeNumber, createdByName: me.name, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
  });
  return { id: ref.id, resumed: false };
});

async function ownDraft(tx, test, id, me) {
  const ref = handoffCol(test).doc(String(id || ""));
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError("not-found", "That handoff no longer exists.");
  if (snap.get("createdBy") !== me.employeeNumber) throw new HttpsError("permission-denied", "Only the person who started this handoff can change it.");
  if (snap.get("status") !== "draft") throw new HttpsError("failed-precondition", "This handoff was already sent.");
  return snap;
}

// Save as you go: { id, team, toTeam, date, values }.
exports.saveHandoffDraft = onCall(async (req) => {
  const me = await requireHandoffRole(req);
  const test = isTest(req);
  const teamIds = await activeTeamIds();
  await db.runTransaction(async (tx) => {
    const snap = await ownDraft(tx, test, req.data?.id, me);
    const h = snap.data();
    const { header, error } = formsLib.cleanHandoffHeader({ team: h.team, toTeam: h.toTeam, date: h.date, ...pickHeader(req.data) }, teamIds);
    if (error) throw new HttpsError("invalid-argument", error);
    const v = formsLib.cleanValues(h.sections, h.lines, req.data?.values);
    if (v.error) throw new HttpsError("invalid-argument", v.error);
    keepHistory(tx, snap.ref, h, { ...header, ...historyLib.spread("values", h.values, v.values) }, me.employeeNumber, { byName: me.name, test });
    tx.update(snap.ref, { ...header, values: v.values, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.employeeNumber });
  });
  return { ok: true };
});
const pickHeader = (d) => Object.fromEntries(["team", "toTeam", "date"].filter((k) => d?.[k]).map((k) => [k, d[k]]));

// The outgoing lead signs and sends it: { id, team, toTeam, date, values, signer: { emp, pin }, device }.
// The signer must be the person who started it. The incoming team's Line Leads get a notification.
exports.sendHandoff = onCall(signable(async (req) => {
  const me = await requireHandoffRole(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  if (signer.employeeNumber !== me.employeeNumber) throw new HttpsError("permission-denied", "Sign with your own PIN — you started this handoff.");
  const device = annLib.cleanDevice(req.data?.device);
  const teamIds = await activeTeamIds();
  const auto = await handoffAutoFill(test);
  const sent = await db.runTransaction(async (tx) => {
    const snap = await ownDraft(tx, test, req.data?.id, me);
    const h = snap.data();
    const { header, error } = formsLib.cleanHandoffHeader({ team: h.team, toTeam: h.toTeam, date: h.date, ...pickHeader(req.data) }, teamIds);
    if (error) throw new HttpsError("invalid-argument", error);
    const v = formsLib.cleanValues(h.sections, h.lines, req.data?.values);
    if (v.error) throw new HttpsError("invalid-argument", v.error);
    const sentBy = { emp: me.employeeNumber, name: me.name, device, at: new Date() };
    tx.update(snap.ref, { ...header, values: v.values, auto, status: "sent", sentBy, sentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "handoff-sent", refId: snap.id, version: h.formRev, emp: me.employeeNumber, name: me.name, method: "pin", device, signedOn: me.employeeNumber });
    return { ...h, ...header, values: v.values };
  });
  // Silo levels on the handoff feed the silo levels card and the low silo alert (never fails the handoff).
  await recordSiloLevels(test, silosLib.levelsFrom(sent.values), me, "handoff").catch((err) => console.error("silo levels not saved", err));
  const people = await peopleList();
  const leads = formsLib.incomingLeads(sent, people);
  const teamName = async (id) => (await teams.doc(id).get()).get("name") || id;
  const [fromName, toName] = await Promise.all([teamName(sent.team), teamName(sent.toTeam)]);
  const pushed = await pushTo(test ? [me.employeeNumber] : leads, {
    title: `${test ? "[TEST] " : ""}📝 Shift handoff from Team ${fromName}`,
    body: `${me.name} handed off to Team ${toName}. Read it and sign received.`,
    url: `/?handoff=${req.data.id}`,
  });
  return { ok: true, leads: leads.length, pushed, test };
}));

// Throw away your unsent handoff: { id } (kept, marked discarded — nothing is deleted).
exports.discardHandoff = onCall(async (req) => {
  const me = await requireHandoffRole(req);
  const test = isTest(req);
  await db.runTransaction(async (tx) => {
    const snap = await ownDraft(tx, test, req.data?.id, me);
    tx.update(snap.ref, { status: "discarded", discardedBy: me.employeeNumber, discardedByName: me.name, discardedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "discarded", "handoff", snap.id, me.employeeNumber, { test });
  });
  return { ok: true };
});

// The incoming lead signs received: { id, signer: { emp, pin }, device }. On a line tablet any incoming Line Lead
// can sign without signing in.
exports.receiveHandoff = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const person = { roles: signer.roles, team: signer.employee.team || null };
  const ref = handoffCol(test).doc(String(req.data?.id || ""));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That handoff no longer exists.");
    const h = snap.data();
    if (h.status === "received") throw new HttpsError("failed-precondition", `Already received by ${h.receivedBy?.name || "someone"}.`);
    if (h.status !== "sent") throw new HttpsError("failed-precondition", "This handoff hasn't been sent yet.");
    if (!formsLib.canReceive(person, h)) throw new HttpsError("permission-denied", `${signer.name} isn't a Line Lead on the incoming team.`);
    if (signer.employeeNumber === h.createdBy) throw new HttpsError("permission-denied", "The person who wrote it can't also sign it received.");
    // needsVerify: waits for Verified (two-step sign-off, verify.js) — listed on Home for whoever may verify.
    tx.update(ref, { status: "received", needsVerify: true, receivedBy: { emp: signer.employeeNumber, name: signer.name, device, at: new Date() }, receivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "handoff-received", refId: ref.id, version: h.formRev, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
  });
  return { ok: true, name: signer.name, test };
}));

// Verified, once received: { id, signer: { emp, pin }, device }. A Supervisor — or, with no Supervisor on shift, the
// Production Manager or a Line Lead. Not the person who wrote it or the one who received it.
exports.verifyHandoff = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const ref = handoffCol(test).doc(String(req.data?.id || ""));
  const supervisorOnShift = await supervisorOnShiftNow(test);
  const w = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That handoff no longer exists.");
    const h = snap.data();
    if (h.status !== "received") throw new HttpsError("failed-precondition", "It isn't signed received yet.");
    if (h.verified) throw new HttpsError("failed-precondition", `Already verified by ${h.verified.name}.`);
    const who = requireVerifier(signer, supervisorOnShift, [h.createdBy, h.receivedBy?.emp].filter(Boolean));
    tx.update(ref, { verified: verifyStamp(signer, who, device), needsVerify: false, updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "handoff-verify", refId: ref.id, version: h.formRev, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber, role: who.role, backup: who.backup });
    return who;
  });
  return { ok: true, name: signer.name, role: w.roleName, backup: w.backup, test };
}));

// Who can verify on this device's sheet (line tablets): { id } -> who may verify right now, with a login.
exports.handoffVerifiers = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const snap = await handoffCol(test).doc(String(req.data?.id || "")).get();
  if (!snap.exists) throw new HttpsError("not-found", "That handoff no longer exists.");
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled && p.id !== me.employeeNumber);
  const list = verifyLib.verifiers(people, { supervisorOnShift: await supervisorOnShiftNow(test), doers: [snap.get("createdBy"), snap.get("receivedBy")?.emp].filter(Boolean) });
  return { people: list.map((p) => ({ emp: p.id, name: p.name })) };
});

// Names that can sign received on this device (line tablets): the incoming team's Line Leads. { id }
exports.handoffReceivers = onCall(async (req) => {
  const me = await requireMember(req);
  const snap = await handoffCol(isTest(req)).doc(String(req.data?.id || "")).get();
  if (!snap.exists) throw new HttpsError("not-found", "That handoff no longer exists.");
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled);
  const ids = new Set(formsLib.incomingLeads(snap.data(), people));
  return { people: people.filter((p) => ids.has(p.id) && p.id !== me.employeeNumber && p.id !== snap.get("createdBy")).map((p) => ({ emp: p.id, name: p.name })) };
});

// ---------------------------------------------------------------------------
// Keep the Shop Clean — shift task lists (Decision 62). The tasks, shifts, and "turns red" time come from the
// task-list form (Admin → Forms, formId "clean-shop"). One list per shift (date + shift).
//   shopTasks/{date__shift}   formRev, sections (copy), shift {id,name,start,end}, date, startMs, endMs, redMinutes,
//                             assign { taskId: emp }, names { emp: name }, assignees [emp], done { taskId: {emp,name,at,device} },
//                             check {emp,name,at,device,role,roleName,backup} | null (Verified), history [reassigned /
//                             Do again — old sign-offs kept], createdBy/Name
// A Line Lead or Supervisor assigns each task to a person; each person marks their own task done with PIN; the
// Supervisor check is a PIN sign-off once every task is done. Test site: test_shopTasks.
// ---------------------------------------------------------------------------

const shopCol = (test) => col("shopTasks", test);
const SHOP_FORM = "clean-shop";

async function requireTaskListRole(req) {
  const me = await requireMember(req);
  if (!me.roles.some((r) => formsLib.TASKLIST_ROLES.includes(r))) throw new HttpsError("permission-denied", "Line Leads, Supervisors, the Production Manager, and Admins run the shop task list.");
  return me;
}

// Start (or open) this shift's list: {}. Uses the current form revision; a list already started keeps its own.
exports.startShopTasks = onCall(async (req) => {
  const me = await requireTaskListRole(req);
  const test = isTest(req);
  const form = await formTemplates.doc(SHOP_FORM).get();
  if (!form.exists || form.get("active") === false) throw new HttpsError("failed-precondition", "The shop task list isn't set up yet. An admin loads it in Admin → Forms.");
  const now = formsLib.currentShift(form.get("shifts"), Date.now());
  if (!now) throw new HttpsError("failed-precondition", "No shift is running right now (check the shift times in Admin → Forms).");
  const ref = shopCol(test).doc(`${now.date}__${now.shift.id}`);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    tx.create(ref, {
      formId: SHOP_FORM, formRev: form.get("rev"), formName: form.get("name"), intro: form.get("intro") || "", sections: form.get("sections"),
      shift: now.shift, date: now.date, startMs: now.startMs, endMs: now.endMs, redMinutes: form.get("redMinutes") ?? 60,
      assign: {}, names: {}, assignees: [], done: {}, check: null,
      createdBy: me.employeeNumber, createdByName: me.name, createdAt: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
    });
  });
  return { id: ref.id, shift: now.shift.name, date: now.date };
});

// The crew to pick from: everyone on, with team and whether they have a login (they need one to mark done).
exports.shopTaskPeople = onCall(async (req) => {
  await requireTaskListRole(req);
  const people = (await peopleList()).filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name));
  return { people: people.map(({ id, name, team, roles: r, loginEnabled }) => ({ id, name, team, roles: r, loginEnabled })) };
});

// Assign a task: { id, taskId, emp } (emp null = unassign). Not once it's done. The person gets a notification.
exports.assignShopTask = onCall(async (req) => {
  const me = await requireTaskListRole(req);
  const test = isTest(req);
  const emp = req.data?.emp ? pin.normalizeEmployeeNumber(req.data.emp) : null;
  const person = emp ? await employees.doc(emp).get() : null;
  if (emp && (!person.exists || person.get("active") === false)) throw new HttpsError("invalid-argument", "Pick a person from the list.");
  const ref = shopCol(test).doc(String(req.data?.id || ""));
  const r = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That task list no longer exists.");
    const l = snap.data();
    const task = (l.sections || []).flatMap((s) => s.fields).find((t) => t.id === req.data?.taskId);
    if (!task) throw new HttpsError("invalid-argument", "That task isn't on this list.");
    if (l.done?.[task.id]) throw new HttpsError("failed-precondition", `“${task.label}” is already done.`);
    if (l.check) throw new HttpsError("failed-precondition", "This list was already checked by a supervisor.");
    const assign = { ...(l.assign || {}) };
    const names = { ...(l.names || {}) };
    const from = assign[task.id] || null;
    if (emp) { assign[task.id] = emp; names[emp] = person.get("name") || `Employee ${emp}`; } else delete assign[task.id];
    // Reassigned (e.g. someone left mid-shift): kept in the list's history.
    const history = from && from !== emp
      ? [...(l.history || []), { kind: "reassigned", taskId: task.id, label: task.label, from, fromName: names[from] || from, to: emp, toName: emp ? names[emp] : null, by: me.employeeNumber, byName: me.name, at: new Date() }]
      : l.history || [];
    tx.update(ref, { assign, names, assignees: [...new Set(Object.values(assign))].sort(), history, updatedAt: FieldValue.serverTimestamp() });
    return { task, list: l };
  });
  if (emp && emp !== me.employeeNumber) {
    await pushTo(test ? [me.employeeNumber] : [emp], {
      title: `${test ? "[TEST] " : ""}🧹 Your shop task this shift`, body: `${r.task.label} — mark it done in the app before you leave.`, url: `/?shop=${ref.id}`,
    });
  }
  return { ok: true, test };
});

// Mark your own task done: { id, taskId, signer: { emp, pin }, device }. The signer must be the person it's assigned to.
exports.markShopTaskDone = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const ref = shopCol(test).doc(String(req.data?.id || ""));
  const label = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That task list no longer exists.");
    const l = snap.data();
    const task = (l.sections || []).flatMap((s) => s.fields).find((t) => t.id === req.data?.taskId);
    if (!task) throw new HttpsError("invalid-argument", "That task isn't on this list.");
    if (l.assign?.[task.id] !== signer.employeeNumber) throw new HttpsError("permission-denied", `“${task.label}” isn't assigned to ${signer.name}.`);
    if (l.done?.[task.id]) return task.label;
    tx.update(ref, { done: { ...(l.done || {}), [task.id]: { emp: signer.employeeNumber, name: signer.name, at: new Date(), device } }, updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "shop-task", refId: ref.id, version: l.formRev, item: task.id, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
    return task.label;
  });
  return { ok: true, name: signer.name, task: label, test };
}));

// Two-step sign-off (verify.js): is a Supervisor on this shift? Supervisors who cover the team on shift (their own team
// or one they supervise), minus anyone marked Out on Who's here today. No team on shift yet → no Supervisor on shift.
async function supervisorOnShiftNow(test) {
  const [s, people] = await Promise.all([crewShift(test), peopleList()]);
  if (!s?.teamId) return false;
  const marks = s.saved?.marks || {};
  return people.some((p) => p.active && p.roles.includes("supervisor") && deptLib.covers(p, s.teamId, "supervisor") && marks[p.id]?.status !== "out");
}

// The verifier's role for the record, or a plain refusal.
function requireVerifier(signer, supervisorOnShift, doers) {
  const who = verifyLib.verifierRole(signer.employeeNumber, signer.roles, { supervisorOnShift, doers });
  if (who.error) throw new HttpsError("permission-denied", who.error.replace(/^You did/, `${signer.name} did`));
  return who;
}
const verifyStamp = (signer, who, device) => ({ emp: signer.employeeNumber, name: signer.name, at: new Date(), device, role: who.role, roleName: who.roleName, backup: who.backup });
const shopDoers = (l) => Object.values(l.done || {}).map((d) => d.emp);

// Verified (the second step), once every task is done: { id, signer: { emp, pin }, device }. A Supervisor — or, with no
// Supervisor on shift, the Production Manager or a Line Lead. Not someone who did a task on the list.
exports.checkShopTasks = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const ref = shopCol(test).doc(String(req.data?.id || ""));
  const supervisorOnShift = await supervisorOnShiftNow(test);
  const who = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That task list no longer exists.");
    const l = snap.data();
    if (l.check) throw new HttpsError("failed-precondition", `Already verified by ${l.check.name}.`);
    const left = (l.sections || []).flatMap((s) => s.fields).filter((t) => !l.done?.[t.id]);
    if (left.length) throw new HttpsError("failed-precondition", `${left.length} task${left.length === 1 ? " isn't" : "s aren't"} done yet.`);
    const w = requireVerifier(signer, supervisorOnShift, shopDoers(l));
    tx.update(ref, { check: verifyStamp(signer, w, device), updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "shop-check", refId: ref.id, version: l.formRev, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber, role: w.role, backup: w.backup });
    return w;
  });
  return { ok: true, name: signer.name, role: who.roleName, backup: who.backup, test };
}));

// Do again: { id, taskId, reason } — reopens a finished task. Its Done (and the list's Verified, if any) move to the
// history; the person it's assigned to is notified. Line Leads, Supervisors, Production Manager, Admins.
exports.redoShopTask = onCall(async (req) => {
  const me = await requireMember(req);
  if (!verifyLib.canRedo(me.roles)) throw new HttpsError("permission-denied", "Line Leads, Supervisors, the Production Manager, and Admins can ask for a task to be done again.");
  const test = isTest(req);
  const { reason, error } = verifyLib.cleanReason(req.data?.reason);
  if (error) throw new HttpsError("invalid-argument", error);
  const ref = shopCol(test).doc(String(req.data?.id || ""));
  const r = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That task list no longer exists.");
    const l = snap.data();
    const task = (l.sections || []).flatMap((s) => s.fields).find((t) => t.id === req.data?.taskId);
    if (!task) throw new HttpsError("invalid-argument", "That task isn't on this list.");
    if (!l.done?.[task.id]) throw new HttpsError("failed-precondition", `“${task.label}” isn't done yet.`);
    const at = new Date();
    const history = [...(l.history || []), { kind: "redo", taskId: task.id, label: task.label, reason, prevDone: l.done[task.id], prevCheck: l.check || null, by: me.employeeNumber, byName: me.name, at }];
    const done = { ...l.done };
    delete done[task.id];
    tx.update(ref, { done, check: null, history, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "redo", "shop task", ref.id, me.employeeNumber, { taskId: task.id, reason, test });
    return { task, emp: l.assign?.[task.id] || null };
  });
  if (r.emp && r.emp !== me.employeeNumber) {
    await pushTo(test ? [me.employeeNumber] : [r.emp], {
      title: `${test ? "[TEST] " : ""}🧹 Do again: ${r.task.label}`, body: `${me.name}: ${reason}`, url: `/?shop=${ref.id}`,
    });
  }
  return { ok: true, task: r.task.label, test };
});

// Who can sign on this device's sheet (line tablets): { id, taskId } -> the person it's assigned to; { id } (Verified)
// -> who may verify right now (verify.js), with a login.
exports.shopTaskSigners = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const snap = await shopCol(test).doc(String(req.data?.id || "")).get();
  if (!snap.exists) throw new HttpsError("not-found", "That task list no longer exists.");
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled && p.id !== me.employeeNumber);
  const list = req.data?.taskId
    ? people.filter((p) => snap.get("assign")?.[req.data.taskId] === p.id)
    : verifyLib.verifiers(people, { supervisorOnShift: await supervisorOnShiftNow(test), doers: shopDoers(snap.data()) });
  return { people: list.map((p) => ({ emp: p.id, name: p.name })) };
});

// ---------------------------------------------------------------------------
// Station checklists (Decision 63) — from the Daily Check List: Reel Building and Reclamation, one per station per
// shift. The items come from each station's form (Admin → Forms, kind "station"); the shift times come from the
// Keep the Shop Clean form, so they're kept in one place.
//   stationLists/{date__shift__formId}   formId, formRev, formName, intro, sections (copy), shift, date, startMs, endMs,
//                                        redMinutes, values, signed {emp,name,at,device} | null (Done),
//                                        verified {emp,name,at,device,role,roleName,backup} | null, history [Do again], createdBy
// Anyone signed in fills it in (saved as they go); one person signs it off with PIN once every task is ticked and
// every count is filled in. Test site: test_stationLists.
// ---------------------------------------------------------------------------

const stationCol = (test) => col("stationLists", test);

// Open this shift's checklist for a station (made the first time someone opens it): { formId }.
exports.startStationList = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const formId = String(req.data?.formId || "");
  if (!records.isRecordId(formId)) throw new HttpsError("invalid-argument", "Pick a station.");
  const [form, shiftForm] = await Promise.all([formTemplates.doc(formId).get(), formTemplates.doc(formsLib.SHIFT_FORM).get()]);
  if (!form.exists || form.get("kind") !== "station" || form.get("active") === false) throw new HttpsError("not-found", "That station checklist isn't set up.");
  if (!shiftForm.exists) throw new HttpsError("failed-precondition", "Shift times aren't set up yet (they're on the Keep the Shop Clean form in Admin → Forms).");
  const now = formsLib.currentShift(shiftForm.get("shifts"), Date.now());
  if (!now) throw new HttpsError("failed-precondition", "No shift is running right now (check the shift times in Admin → Forms).");
  const ref = stationCol(test).doc(`${now.date}__${now.shift.id}__${formId}`);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    tx.create(ref, {
      formId, formRev: form.get("rev"), formName: form.get("name"), intro: form.get("intro") || "", sections: form.get("sections"),
      shift: now.shift, date: now.date, startMs: now.startMs, endMs: now.endMs, redMinutes: shiftForm.get("redMinutes") ?? 60,
      values: {}, signed: null, createdBy: me.employeeNumber, createdAt: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
    });
  });
  return { id: ref.id };
});

async function openStationList(tx, test, id) {
  const ref = stationCol(test).doc(String(id || ""));
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError("not-found", "That checklist no longer exists.");
  if (snap.get("signed")) throw new HttpsError("failed-precondition", `Already signed off by ${snap.get("signed").name}.`);
  return snap;
}

// Save as you go: { id, values }.
exports.saveStationList = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  await db.runTransaction(async (tx) => {
    const snap = await openStationList(tx, test, req.data?.id);
    const v = formsLib.cleanValues(snap.get("sections"), [], req.data?.values);
    if (v.error) throw new HttpsError("invalid-argument", v.error);
    keepHistory(tx, snap.ref, snap.data(), historyLib.spread("values", snap.get("values"), v.values), me.employeeNumber, { byName: me.name, test });
    tx.update(snap.ref, { values: v.values, updatedBy: me.employeeNumber, updatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

// Sign it off: { id, values, signer: { emp, pin }, device } — every task ticked and every count filled in.
exports.signStationList = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const name = await db.runTransaction(async (tx) => {
    const snap = await openStationList(tx, test, req.data?.id);
    const l = snap.data();
    const v = formsLib.cleanValues(l.sections, [], req.data?.values);
    if (v.error) throw new HttpsError("invalid-argument", v.error);
    const missing = formsLib.stationMissing(l.sections, v.values);
    if (missing.length) throw new HttpsError("failed-precondition", `Not done yet: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` +${missing.length - 4} more` : ""}.`);
    tx.update(snap.ref, { values: v.values, signed: { emp: signer.employeeNumber, name: signer.name, at: new Date(), device }, updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "station-checklist", refId: snap.id, version: l.formRev, content: signoffsLib.contentVersion(v.values), emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
    return l.formName;
  });
  return { ok: true, name: signer.name, form: name, test };
}));

// Verified (the second step, verify.js) once it's signed Done: { id, signer: { emp, pin }, device }. A Supervisor — or,
// with no Supervisor on shift, the Production Manager or a Line Lead. Not the person who signed it Done.
exports.verifyStationList = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const ref = stationCol(test).doc(String(req.data?.id || ""));
  const supervisorOnShift = await supervisorOnShiftNow(test);
  const r = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That checklist no longer exists.");
    const l = snap.data();
    if (!l.signed) throw new HttpsError("failed-precondition", "It isn't signed Done yet.");
    if (l.verified) throw new HttpsError("failed-precondition", `Already verified by ${l.verified.name}.`);
    const w = requireVerifier(signer, supervisorOnShift, [l.signed.emp]);
    tx.update(ref, { verified: verifyStamp(signer, w, device), updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "station-verify", refId: ref.id, version: l.formRev, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber, role: w.role, backup: w.backup });
    return { w, form: l.formName };
  });
  return { ok: true, name: signer.name, role: r.w.roleName, backup: r.w.backup, form: r.form, test };
}));

// Do again: { id, reason } — reopens a signed checklist. Its Done and Verified move to the history (the ticks and counts
// stay, to fix what's needed). Line Leads, Supervisors, Production Manager, Admins.
exports.redoStationList = onCall(async (req) => {
  const me = await requireMember(req);
  if (!verifyLib.canRedo(me.roles)) throw new HttpsError("permission-denied", "Line Leads, Supervisors, the Production Manager, and Admins can ask for a checklist to be done again.");
  const test = isTest(req);
  const { reason, error } = verifyLib.cleanReason(req.data?.reason);
  if (error) throw new HttpsError("invalid-argument", error);
  const ref = stationCol(test).doc(String(req.data?.id || ""));
  const form = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That checklist no longer exists.");
    const l = snap.data();
    if (!l.signed) throw new HttpsError("failed-precondition", "It isn't signed Done yet — nothing to reopen.");
    const history = [...(l.history || []), { kind: "redo", reason, prevDone: l.signed, prevCheck: l.verified || null, prevValues: l.values || {}, by: me.employeeNumber, byName: me.name, at: new Date() }];
    tx.update(ref, { signed: null, verified: null, history, updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "redo", "station checklist", ref.id, me.employeeNumber, { reason, test });
    return l.formName;
  });
  return { ok: true, form, test };
});

// Who can verify on this device's sheet (line tablets): { id } -> who may verify right now, with a login.
exports.stationVerifiers = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const snap = await stationCol(test).doc(String(req.data?.id || "")).get();
  if (!snap.exists) throw new HttpsError("not-found", "That checklist no longer exists.");
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled && p.id !== me.employeeNumber);
  const list = verifyLib.verifiers(people, { supervisorOnShift: await supervisorOnShiftNow(test), doers: [snap.get("signed")?.emp].filter(Boolean) });
  return { people: list.map((p) => ({ emp: p.id, name: p.name })) };
});

// ---------------------------------------------------------------------------
// Line Check Log (Decision 64) — from the Line Daily Checklist. The readings, checks, limits, how often, and the
// page-2 plant-wide items come from the "line-check" form (Admin → Forms); shift times from Keep the Shop Clean.
//   lineLogs/{date__shift__lineId}   formRev, formName, sections (page-1 copy), lineId, lineName, shift, date, startMs,
//                                    endMs, everyMinutes, rounds [{at, emp, name, device, values, flags, notes}],
//                                    notes, operatorSign {emp,name,at,device}, review {emp,name,at,device}
//   plantLogs/{date__shift}          formRev, sections (page-2 copy), shift, date, taps { fieldId: [{at, emp, name}] }
// A round is recorded as the person signed in (the paper's initials). Out-of-range readings and "Not OK" checks need a
// note and alert the Line Lead. The operator signs at end of shift (PIN); a Supervisor reviews (PIN).
// Test site: test_lineLogs / test_plantLogs; alerts go only to the person testing.
// ---------------------------------------------------------------------------

const lineLogCol = (test) => col("lineLogs", test);
const plantLogCol = (test) => col("plantLogs", test);
const LINE_FORM = "line-check";

async function lineCheckSetup() {
  const [form, shiftForm] = await Promise.all([formTemplates.doc(LINE_FORM).get(), formTemplates.doc(formsLib.SHIFT_FORM).get()]);
  if (!form.exists || form.get("active") === false) throw new HttpsError("failed-precondition", "The Line Check Log isn't set up yet. An admin loads it in Admin → Forms.");
  if (!shiftForm.exists) throw new HttpsError("failed-precondition", "Shift times aren't set up yet (they're on the Keep the Shop Clean form in Admin → Forms).");
  const now = formsLib.currentShift(shiftForm.get("shifts"), Date.now());
  if (!now) throw new HttpsError("failed-precondition", "No shift is running right now (check the shift times in Admin → Forms).");
  return { form, now };
}

// Open this shift's log for a line (made the first time), and the plant-wide page 2: { lineId }.
exports.startLineLog = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const lineId = String(req.data?.lineId || "");
  const line = await lines.doc(lineId).get();
  if (!line.exists || line.get("active") === false) throw new HttpsError("invalid-argument", "Pick a line.");
  const { form, now } = await lineCheckSetup();
  const sections = form.get("sections") || [];
  const lineSections = sections.filter((s) => s.scope !== "plant")
    .map((s) => ({ ...s, fields: s.fields.filter((f) => formsLib.appliesTo(f, lineId)) })).filter((s) => s.fields.length);
  const ref = lineLogCol(test).doc(`${now.date}__${now.shift.id}__${lineId}`);
  const plantRef = plantLogCol(test).doc(`${now.date}__${now.shift.id}`);
  await db.runTransaction(async (tx) => {
    const [a, b] = await tx.getAll(ref, plantRef);
    const base = { formRev: form.get("rev"), formName: form.get("name"), shift: now.shift, date: now.date, startMs: now.startMs, endMs: now.endMs, createdAt: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}) };
    if (!a.exists) {
      tx.create(ref, { ...base, intro: form.get("intro") || "", sections: lineSections, lineId, lineName: line.get("name"), everyMinutes: form.get("everyMinutes") || 30, rounds: [], notes: "", operatorSign: null, review: null, createdBy: me.employeeNumber });
    }
    if (!b.exists) tx.create(plantRef, { ...base, sections: sections.filter((s) => s.scope === "plant"), taps: {}, createdBy: me.employeeNumber });
  });
  return { id: ref.id, plantId: plantRef.id };
});

// Record one round: { id, values, notes, device }. Flags (out of range / Not OK) need notes and alert the Line Lead.
exports.addLineRound = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const device = annLib.cleanDevice(req.data?.device);
  const ref = lineLogCol(test).doc(String(req.data?.id || ""));
  const r = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That line log no longer exists.");
    const l = snap.data();
    if (l.operatorSign) throw new HttpsError("failed-precondition", "This log was already signed at end of shift.");
    const fields = (l.sections || []).flatMap((s) => s.fields);
    const { round, error } = formsLib.cleanRound(fields, l.lineId, req.data?.values, req.data?.notes);
    if (error) throw new HttpsError("invalid-argument", error);
    const entry = { ...round, at: new Date(), emp: me.employeeNumber, name: me.name, device };
    tx.update(ref, { rounds: [...(l.rounds || []), entry], updatedAt: FieldValue.serverTimestamp() });
    return { l, round, fields };
  });
  let alerted = 0;
  if (r.round.flags.length) {
    const people = await peopleList();
    const leads = people.filter((p) => p.active && p.roles.includes("lead"));
    const onNow = (await shiftLineAssignments(test)).now; // who the Crew Board put on that line (Decision 104)
    const onLine = leads.filter((p) => (onNow[p.id] || []).includes(r.l.lineId)).map((p) => p.id);
    const to = test ? [me.employeeNumber] : onLine.length ? onLine : leads.map((p) => p.id);
    const what = r.round.flags.map((id) => r.fields.find((f) => f.id === id)?.label).filter(Boolean).join(", ");
    alerted = await pushTo(to, { title: `${test ? "[TEST] " : ""}⚠ ${r.l.lineName}: check out of spec`, body: `${me.name}: ${what}`, url: `/?linelog=${ref.id}`, urgent: true });
  }
  return { ok: true, flags: r.round.flags.length, alerted, test };
});

// Notes / issues for the line this shift: { id, notes }.
exports.saveLineNotes = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const notes = typeof req.data?.notes === "string" ? req.data.notes.trim().slice(0, 4000) : "";
  const ref = lineLogCol(test).doc(String(req.data?.id || ""));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That line log no longer exists.");
    if (snap.get("operatorSign")) throw new HttpsError("failed-precondition", "This log was already signed at end of shift.");
    keepHistory(tx, ref, snap.data(), { notes }, me.employeeNumber, { byName: me.name, test });
    tx.update(ref, { notes, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.employeeNumber, updatedByName: me.name });
  });
  return { ok: true };
});

// Page 2: one tap stamps the time and name: { id (plant log), fieldId }.
exports.tapPlantItem = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const ref = plantLogCol(test).doc(String(req.data?.id || ""));
  const count = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That plant log no longer exists.");
    const p = snap.data();
    const field = (p.sections || []).flatMap((s) => s.fields).find((f) => f.id === req.data?.fieldId);
    if (!field) throw new HttpsError("invalid-argument", "That item isn't on this log.");
    const list = [...(p.taps?.[field.id] || []), { at: new Date(), emp: me.employeeNumber, name: me.name }];
    if (list.length > 100) throw new HttpsError("failed-precondition", "That's more than 100 times this shift.");
    tx.update(ref, { taps: { ...(p.taps || {}), [field.id]: list }, updatedAt: FieldValue.serverTimestamp() });
    return list.length;
  });
  return { ok: true, count, test };
});

// End of shift — operator signs: { id, signer: { emp, pin }, device }. At least one round recorded.
exports.signLineLog = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const ref = lineLogCol(test).doc(String(req.data?.id || ""));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That line log no longer exists.");
    const l = snap.data();
    if (l.operatorSign) throw new HttpsError("failed-precondition", `Already signed by ${l.operatorSign.name}.`);
    if (!(l.rounds || []).length) throw new HttpsError("failed-precondition", "Record at least one check before signing.");
    tx.update(ref, { operatorSign: { emp: signer.employeeNumber, name: signer.name, at: new Date(), device }, updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "line-log", refId: ref.id, version: l.formRev, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
  });
  return { ok: true, name: signer.name, test };
}));

// Supervisor review (after the operator signed): { id, signer: { emp, pin }, device }. Supervisor, Production Manager, Admin.
exports.reviewLineLog = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  if (!signer.roles.some((r) => formsLib.CHECK_ROLES.includes(r))) throw new HttpsError("permission-denied", "The review is for Supervisors, the Production Manager, and Admins.");
  const device = annLib.cleanDevice(req.data?.device);
  const ref = lineLogCol(test).doc(String(req.data?.id || ""));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That line log no longer exists.");
    const l = snap.data();
    if (!l.operatorSign) throw new HttpsError("failed-precondition", "The operator signs first, at end of shift.");
    if (l.review) throw new HttpsError("failed-precondition", `Already reviewed by ${l.review.name}.`);
    tx.update(ref, { review: { emp: signer.employeeNumber, name: signer.name, at: new Date(), device }, updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "line-log-review", refId: ref.id, version: l.formRev, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
  });
  return { ok: true, name: signer.name, test };
}));

// Supervisors who can review on this device (line tablets).
exports.lineLogReviewers = onCall(async (req) => {
  const me = await requireMember(req);
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled && p.id !== me.employeeNumber && p.roles.some((r) => formsLib.CHECK_ROLES.includes(r)));
  return { people: people.map((p) => ({ emp: p.id, name: p.name })) };
});

// ---------------------------------------------------------------------------
// Reference documents (Decision 65) — e.g. the Shift Station Assignment Sheet, viewable from the Shop Map and the
// Training page. The file is in our storage (uploads/…); the list is here (signed-in people read it). Admins and the
// document's department head change it (Documents & forms, Decision 116).
//   refDocs/{auto}   name, url, kind ("pdf" | "image"), fileName, rev, history [{rev, url, fileName, at, by}], active
// ---------------------------------------------------------------------------

const refDocs = db.collection("refDocs");

// Add { department?, name, url, kind, fileName, note } or change { id, name, url?, kind?, fileName?, active? }.
// A new file is a new revision; earlier files stay in the history.
exports.saveRefDoc = onCall(async (req) => {
  const { me, dept } = await requireDocEditor(req, req.data?.id ? `refdoc:${String(req.data.id)}` : "refdoc:new", req.data?.id ? {} : { newDept: req.data?.department });
  const adminNumber = me.employeeNumber;
  const name = records.cleanName(req.data?.name, 120);
  if (!name) throw new HttpsError("invalid-argument", "Give the document a title (120 characters max).");
  const url = req.data?.url ? String(req.data.url) : null;
  if (url && !(fixesLib.storagePath(url, BUCKET) || "").startsWith("uploads/")) throw new HttpsError("invalid-argument", "That file didn't upload. Add it again.");
  const kind = req.data?.kind === "image" ? "image" : "pdf";
  const fileName = typeof req.data?.fileName === "string" ? req.data.fileName.slice(0, 120) : "";
  const active = req.data?.active === false ? false : true;
  const id = req.data?.id ? String(req.data.id) : null;
  return db.runTransaction(async (tx) => {
    const ref = id ? refDocs.doc(id) : refDocs.doc();
    const snap = id ? await tx.get(ref) : null;
    if (id && !snap.exists) throw new HttpsError("not-found", "That document is no longer on the list.");
    if (!id && !url) throw new HttpsError("invalid-argument", "Add the file first.");
    const cur = snap?.data() || { rev: 0, history: [] };
    const rev = url ? (cur.rev || 0) + 1 : cur.rev || 1;
    const doc = {
      name, active, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber, updatedByName: me.name,
      ...(url ? { url, kind, fileName, rev, history: [...(cur.history || []), { rev, url, fileName, at: new Date(), by: me.name, byEmp: me.employeeNumber }] } : {}),
    };
    tx.set(ref, doc, { merge: true });
    if (!id && dept) tx.set(docDeptsDoc, { departments: { [`refdoc:${ref.id}`]: dept } }, { merge: true });
    auditRecord(tx, id ? (active ? "updated" : "retired") : "created", "reference document", ref.id, adminNumber, { name, rev });
    return { id: ref.id, rev };
  });
});

// ---------------------------------------------------------------------------
// Machines — parts & specs per machine (Decision 51, updated 10-21-2026). Kept in the app only for now; nothing goes
// to Odoo yet (the fields match the Decision 51 mapping, see machinespecs.js). Company content, so the dev test site
// edits the same list as the live site (like forms and reference documents) — what Maintenance enters is never lost.
//   machineSpecs/{M-001}              info, parts, fasteners, belts, fluids, files, notes, partNumbers, rev
//   machineSpecs/{id}/versions/{auto} the record before each change (restore)
//   machineSpecs/{id}/removed/{auto}  rows and files taken off (put back within 30 days, then cleared at night)
//   meta/machineAccess                { roles } — who may read these (the database rules use it)
// Maintenance and Admin add and edit (Admin → Roles: "Can edit machines"); the Production Manager views.
// ---------------------------------------------------------------------------

const machineSpecs = db.collection("machineSpecs");
const SPEC_SECTIONS = Object.keys(specsLib.SECTIONS);
const SECTION_NAMES = { info: "Info", parts: "Parts", fasteners: "Fasteners", belts: "Belts & bearings", fluids: "Fluids & lubrication", files: "Photos & documents", notes: "Important notes" };

async function roleList() {
  return (await roles.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function writeMachineAccess() {
  const list = await roleList();
  const ids = [...new Set([...specsLib.VIEW_ROLES, ...list.filter((r) => r.active !== false && specsLib.roleEditsMachines(r)).map((r) => r.id)])];
  await db.collection("meta").doc("machineAccess").set({ roles: ids, updatedAt: FieldValue.serverTimestamp() });
}

async function requireMachineEditor(req) {
  const me = await requireMember(req);
  if (!specsLib.canEditMachines(await roleList(), me.roles)) throw new HttpsError("permission-denied", "Your role can't edit machines. An admin can allow it in Admin → Roles.");
  return me;
}

function requireMachineId(value) {
  const id = String(value || "");
  if (!records.isMachineId(id)) throw new HttpsError("invalid-argument", "Unknown machine.");
  return id;
}

const isOurUpload = (url) => (fixesLib.storagePath(url, BUCKET) || "").startsWith("uploads/");
const specFields = (d) => Object.fromEntries(["info", ...SPEC_SECTIONS].map((k) => [k, d?.[k] ?? (k === "info" ? {} : [])]));

// Same transaction steps for every change: check the machine and the revision, save a version, write, log.
async function changeSpecs(tx, me, machineId, expectRev, reason, makeChanges) {
  const [mSnap, sSnap] = await Promise.all([tx.get(machines.doc(machineId)), tx.get(machineSpecs.doc(machineId))]);
  if (!mSnap.exists) throw new HttpsError("not-found", "That machine is no longer on the list.");
  const cur = sSnap.exists ? sSnap.data() : { rev: 0 };
  if (expectRev !== undefined && expectRev !== null && Number(expectRev) !== (cur.rev || 0)) {
    throw new HttpsError("aborted", "Someone else just changed this machine. Your screen has their changes now — make your change again.");
  }
  const { changes, removed, summary } = makeChanges(cur);
  const ref = machineSpecs.doc(machineId);
  if (sSnap.exists) tx.create(ref.collection("versions").doc(), { ...specFields(cur), rev: cur.rev || 0, savedAt: FieldValue.serverTimestamp(), savedBy: me.employeeNumber, savedByName: me.name, reason });
  for (const r of removed) {
    tx.create(ref.collection("removed").doc(), { ...r, removedBy: me.employeeNumber, removedByName: me.name, removedAt: FieldValue.serverTimestamp(), purgeAfter: purgeDate() });
  }
  const next = { ...specFields(cur), ...changes };
  const rev = (cur.rev || 0) + 1;
  tx.set(ref, { ...next, machineId, partNumbers: specsLib.partNumbersOf(next), rev, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.employeeNumber, updatedByName: me.name });
  auditRecord(tx, "updated", "machine specs", machineId, me.employeeNumber, { summary, rev });
  return { machineId, rev };
}

// { machineId, section: "info", info } or { machineId, section, items } (the whole section's rows), rev (what the
// screen had — if someone else saved in between, nothing is overwritten).
exports.saveMachineSpecs = onCall(async (req) => {
  const me = await requireMachineEditor(req);
  const machineId = requireMachineId(req.data?.machineId);
  const section = String(req.data?.section || "");
  let value;
  if (section === "info") {
    const { info, error } = specsLib.cleanInfo(req.data?.info);
    if (error) throw new HttpsError("invalid-argument", error);
    value = info;
  } else {
    const { items, error } = specsLib.cleanSection(section, req.data?.items, isOurUpload);
    if (error) throw new HttpsError("invalid-argument", error);
    value = items;
  }
  return db.runTransaction((tx) => changeSpecs(tx, me, machineId, req.data?.rev, `edited ${SECTION_NAMES[section]}`, (cur) => {
    if (section === "info") return { changes: { info: value }, removed: [], summary: "Info changed" };
    const d = specsLib.diffSection(cur[section], value);
    return { changes: { [section]: value }, removed: d.removed.map((row) => ({ section, row })), summary: `${SECTION_NAMES[section]}: ${specsLib.describeDiff(section, d)}` };
  }));
});

// { fromId, toId, sections: ["parts", …], replace } — copy rows from another machine, then edit them.
// replace: true takes the target's old rows off (to Removed, 30 days); otherwise the copies are added after them.
// Photos and documents are not copied (each machine's own).
exports.copyMachineSpecs = onCall(async (req) => {
  const me = await requireMachineEditor(req);
  const fromId = requireMachineId(req.data?.fromId);
  const toId = requireMachineId(req.data?.toId);
  if (fromId === toId) throw new HttpsError("invalid-argument", "Pick a different machine to copy from.");
  const sections = [...new Set(Array.isArray(req.data?.sections) ? req.data.sections : [])].filter((k) => ["info", "parts", "fasteners", "belts", "fluids", "notes"].includes(k));
  if (!sections.length) throw new HttpsError("invalid-argument", "Pick what to copy.");
  const replace = req.data?.replace === true;
  return db.runTransaction(async (tx) => {
    const src = await tx.get(machineSpecs.doc(fromId));
    if (!src.exists) throw new HttpsError("not-found", "That machine has nothing to copy yet.");
    const from = src.data();
    return changeSpecs(tx, me, toId, req.data?.rev, `copied from ${fromId}`, (cur) => {
      const changes = {};
      const removed = [];
      for (const k of sections) {
        if (k === "info") { // make, model, vendor, notes only — serial number and install date belong to one machine
          const i = from.info || {};
          changes.info = { ...(cur.info || {}), make: i.make || "", model: i.model || "", vendor: i.vendor || "", notes: i.notes || (cur.info?.notes || "") };
          continue;
        }
        const copies = specsLib.copyRows(from[k]);
        if (replace) removed.push(...(cur[k] || []).map((row) => ({ section: k, row })));
        changes[k] = [...(replace ? [] : cur[k] || []), ...copies].slice(0, 300);
      }
      return { changes, removed, summary: `Copied ${sections.map((k) => SECTION_NAMES[k]).join(", ")} from ${fromId}${replace ? " (replaced)" : ""}` };
    });
  });
});

// { machineId, versionId } — put the machine's specs back the way they were (what's there now is saved first).
exports.restoreMachineSpecsVersion = onCall(async (req) => {
  const me = await requireMachineEditor(req);
  const machineId = requireMachineId(req.data?.machineId);
  const versionId = String(req.data?.versionId || "");
  return db.runTransaction(async (tx) => {
    const v = await tx.get(machineSpecs.doc(machineId).collection("versions").doc(versionId));
    if (!v.exists) throw new HttpsError("not-found", "That version no longer exists.");
    const old = specFields(v.data());
    return changeSpecs(tx, me, machineId, null, "before restoring an older version", (cur) => {
      const removed = SPEC_SECTIONS.flatMap((k) => specsLib.diffSection(cur[k], old[k]).removed.map((row) => ({ section: k, row })));
      return { changes: old, removed, summary: `Restored the version from revision ${v.get("rev")}` };
    });
  });
});

// { machineId, removedId } — put a removed row or file back (within 30 days).
exports.restoreMachineSpecItem = onCall(async (req) => {
  const me = await requireMachineEditor(req);
  const machineId = requireMachineId(req.data?.machineId);
  const rRef = machineSpecs.doc(machineId).collection("removed").doc(String(req.data?.removedId || ""));
  return db.runTransaction(async (tx) => {
    const r = await tx.get(rRef);
    if (!r.exists) throw new HttpsError("not-found", "That item is no longer in Removed.");
    const { section, row } = r.data();
    const out = await changeSpecs(tx, me, machineId, null, `put back a row in ${SECTION_NAMES[section]}`, (cur) => {
      const rows = cur[section] || [];
      return { changes: { [section]: rows.some((x) => x.id === row.id) ? rows : [...rows, row] }, removed: [], summary: `${SECTION_NAMES[section]}: 1 put back` };
    });
    tx.delete(rRef);
    return out;
  });
});

// ---------------------------------------------------------------------------
// Shift rotation (which team works which days / shift) — meta/rotation, Admin → Shift rotation. Rules in rotation.js.
// ---------------------------------------------------------------------------

const rotationDoc = db.collection("meta").doc("rotation");

// Admins: { teams: [{ teamId, days, shiftId }] }.
exports.adminSaveRotation = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const [teamSnaps, shiftForm] = await Promise.all([teams.get(), formTemplates.doc(formsLib.SHIFT_FORM).get()]);
  const { teams: rows, error } = rotationLib.cleanRotation(req.data?.teams, teamSnaps.docs.filter((t) => t.get("active") !== false).map((t) => t.id), (shiftForm.get("shifts") || []).map((s) => s.id));
  if (error) throw new HttpsError("invalid-argument", error);
  await keepHistoryNow(rotationDoc, { teams: rows }, adminNumber);
  await rotationDoc.set({ teams: rows, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber });
  await auditLog.add({ type: "updated", kind: "shift rotation", recordId: "rotation", by: adminNumber, at: FieldValue.serverTimestamp(), teams: rows });
  return { ok: true };
});

// Supervisors of the team on shift right now (all Supervisors when the rotation doesn't say, e.g. Saturday).
async function supervisorsOnShift() {
  const [rot, shiftForm, people] = await Promise.all([rotationDoc.get(), formTemplates.doc(formsLib.SHIFT_FORM).get(), peopleList()]);
  const sups = people.filter((p) => p.active && p.roles.includes("supervisor"));
  const teamId = rotationLib.teamOnShift(rot.get("teams") || [], formsLib.currentShift(shiftForm.get("shifts") || [], Date.now()));
  const onTeam = teamId ? sups.filter((p) => deptLib.covers(p, teamId, "supervisor")) : []; // their own team or one they supervise
  return (onTeam.length ? onTeam : sups).map((p) => p.id);
}

// ---------------------------------------------------------------------------
// Near-Miss & Incident Reports (Chris, 10-21-2026). Rules in incidents.js. Reports are readable only by Training &
// Safety, Production Manager, Admin (database rules); the injured person's details are kept apart (private/osha).
// The reporter follows their own report through myIncidents. Test site: test_incidents / test_incidentActions.
// ---------------------------------------------------------------------------

async function requireIncidentFollower(req) {
  const me = await requireMember(req);
  if (!incidentsLib.canFollow(me.roles)) throw new HttpsError("permission-denied", "Only Training & Safety, the Production Manager, and Admins follow up on reports.");
  return me;
}

async function refreshIncident(tx, test, incRef, curStatus, started) {
  const open = (await tx.get(col("incidentActions", test).where("incidentId", "==", incRef.id))).docs.filter((d) => !d.get("done")).length;
  return { openActions: open, status: incidentsLib.nextStatus(curStatus, { openActions: open, started }) };
}

// Safety-report files (photos, drawn signatures): the PRIVATE storage folder — safety/{incidentId}/… (test site:
// safety/test/{incidentId}/…). Storage rules let only Training & Safety, Production Manager, Admin read it; the app shows the
// files through incidentFiles (never a shareable link). Phones upload photos to safety/incoming/{random id}.jpg.
const safetyFolder = (test, incidentId) => `safety/${test ? "test/" : ""}${incidentId}`;
const bucketRef = () => getStorage().bucket();

// Saves bytes as a private file (no download link is ever made for it).
async function savePrivate(path, buffer, contentType) {
  await bucketRef().file(path).save(buffer, { contentType, resumable: false, metadata: { cacheControl: "private, max-age=0" } });
  return path;
}

// Moves the phone's uploads from safety/incoming into the report's folder. Returns the new paths.
async function moveIncoming(uploadIds, folder) {
  const out = [];
  for (const [n, id] of uploadIds.entries()) {
    const src = bucketRef().file(`safety/incoming/${id}`);
    const [exists] = await src.exists();
    if (!exists) throw new HttpsError("failed-precondition", "A photo didn't upload. Add it again.");
    const [buf] = await src.download();
    out.push(await savePrivate(`${folder}/photo-${n + 1}.jpg`, buf, "image/jpeg"));
    await src.delete({ ignoreNotFound: true });
  }
  return out;
}

// A drawn signature (PNG data URL) → a private file; returns its path.
async function saveSignature(folder, name, png) {
  return savePrivate(`${folder}/${name}.png`, Buffer.from(png.split(",")[1], "base64"), "image/png");
}

async function fileDataUrl(path, type) {
  try {
    const [buf] = await bucketRef().file(path).download();
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// Anyone: { type, occurredAt, place, what, immediate, photos (upload ids), witnesses, anonymous, hurt, signatures }.
exports.reportIncident = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const [lineSnaps, stationSnaps] = await Promise.all([lines.get(), floorStations.get()]);
  const { report, hurt, error } = incidentsLib.cleanReport(req.data, {
    lineIds: lineSnaps.docs.filter((l) => l.get("active") !== false).map((l) => l.id),
    stationIds: stationSnaps.docs.filter((s) => s.get("active") !== false).map((s) => s.id),
    nowIso: incidentsLib.plantNowIso(),
  });
  if (error) throw new HttpsError("invalid-argument", error);
  const needsSigs = incidentsLib.SIG_TYPES.includes(report.type);
  let sigs = { supervisor: null, witnesses: [] };
  if (needsSigs) {
    const s = incidentsLib.cleanSignatures(req.data?.signatures);
    if (s.error) throw new HttpsError("invalid-argument", s.error);
    sigs = s.signatures;
  }
  const device = annLib.cleanDevice(req.data?.device);
  const placeLabel = report.place.label || stationSnaps.docs.find((s) => s.id === report.place.stationId)?.get("label") || lineSnaps.docs.find((l) => l.id === report.place.lineId)?.get("name") || "";
  const ref = col("incidents", test).doc();
  // Files first, into the report's private folder: photos moved from incoming, signatures saved as PNG files.
  const folder = safetyFolder(test, ref.id);
  const photoPaths = await moveIncoming(report.photos, folder);
  // Signers picked from the list carry their employee # (Decision 108); the version is the report as signed.
  const version = incidentSignedVersion({ ...report, place: report.place }, hurt ? { injuredName: hurt.name, bodyPart: hurt.bodyPart } : null);
  const named = new Map();
  for (const x of [sigs.supervisor, ...sigs.witnesses].filter((s) => s?.emp)) {
    const e = await employees.doc(x.emp).get();
    if (!e.exists || e.get("active") === false) throw new HttpsError("invalid-argument", "Pick the person from the list (or type a name for someone who isn't an employee).");
    named.set(x.emp, e.get("name") || x.name);
  }
  const stamp = async (x, file) => ({ name: x.emp ? named.get(x.emp) : x.name, emp: x.emp || null, path: await saveSignature(folder, file, x.png), atMs: Date.now(), device, collectedBy: me.employeeNumber, collectedByName: me.name, version });
  const sigDoc = needsSigs ? {
    supervisor: sigs.supervisor ? await stamp(sigs.supervisor, "sig-supervisor") : null,
    witnesses: await Promise.all(sigs.witnesses.map((w, n) => stamp(w, `sig-witness-${n + 1}`))),
  } : null;
  const { photos: _drop, ...reportFields } = report;
  await db.runTransaction(async (tx) => {
    tx.create(ref, {
      ...reportFields, photoPaths, placeName: placeLabel, status: "reported", openActions: 0, whys: [], rootCause: "",
      ...(needsSigs ? { supervisorSigned: !!sigs.supervisor, supervisorSignedName: sigs.supervisor?.name || "", witnessSignatures: sigs.witnesses.length } : {}),
      ...(report.anonymous ? {} : { createdBy: me.employeeNumber, createdByName: me.name }),
      createdAt: FieldValue.serverTimestamp(), createdAtMs: Date.now(), month: report.occurredAt.slice(0, 7), ...(test ? { test: true } : {}),
    });
    if (hurt) tx.create(ref.collection("private").doc("osha"), { injuredName: hurt.name, bodyPart: hurt.bodyPart });
    if (sigDoc) {
      tx.create(ref.collection("private").doc("signatures"), sigDoc);
      for (const [role, s] of [["supervisor", sigDoc.supervisor], ...sigDoc.witnesses.map((w) => ["witness", w])]) {
        if (s) logSignoff(tx, test, { kind: `incident-signature (${role})`, refId: ref.id, version, emp: s.emp || `not-employee:${s.name}`, name: s.name, method: "drawn", device, collectedBy: me.employeeNumber, collectedByName: me.name });
      }
    }
    auditRecord(tx, "reported", "incident", ref.id, report.anonymous ? "anonymous" : me.employeeNumber, { type: report.type, test });
  });
  const t = incidentsLib.TYPES[report.type];
  const to = test ? [me.employeeNumber] : [...new Set([
    ...(await activeEmployees()).filter((e) => e.active !== false && e.roles.some((r) => ["training-safety", "plant-manager"].includes(r))).map((e) => e.id),
    ...(await supervisorsOnShift()),
  ])];
  await pushTo(to, { title: `${test ? "[TEST] " : ""}${t.icon} ${t.label} reported${placeLabel ? ` · ${placeLabel}` : ""}`, body: report.what.slice(0, 120), url: `/?incident=${ref.id}`, urgent: report.type === "injury" });
  return { id: ref.id, anonymous: report.anonymous, test };
});

// Anyone: { ids? } — the status of my own reports (signed) and of anonymous ones this device sent (their ids).
exports.myIncidents = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const list = col("incidents", test);
  const mine = (await list.where("createdBy", "==", me.employeeNumber).get()).docs;
  const ids = (Array.isArray(req.data?.ids) ? req.data.ids : []).slice(0, 30).map(String).filter((x) => /^[A-Za-z0-9]{10,40}$/.test(x));
  const anon = ids.length ? (await db.getAll(...ids.map((id) => list.doc(id)))).filter((s) => s.exists && s.get("anonymous") === true) : [];
  const show = (d) => ({
    id: d.id, type: d.get("type"), occurredAt: d.get("occurredAt"), placeName: d.get("placeName") || "", status: d.get("status"), anonymous: d.get("anonymous") === true, createdAtMs: d.get("createdAtMs") || 0,
    needsSupervisorSig: incidentsLib.SIG_TYPES.includes(d.get("type")) && d.get("supervisorSigned") !== true, witnessSignatures: d.get("witnessSignatures") || 0,
  });
  return { reports: [...mine, ...anon].map(show).sort((a, b) => b.createdAtMs - a.createdAtMs) };
});

// Follow-up: { id, whys, rootCause, osha?, start? } — 5 Whys, root cause, and (injury / first aid) OSHA details.
exports.saveIncidentFollowUp = onCall(async (req) => {
  const me = await requireIncidentFollower(req);
  const test = isTest(req);
  const { whys, rootCause } = incidentsLib.cleanWhys(req.data);
  let osha = null;
  if (req.data?.osha) {
    const o = incidentsLib.cleanOsha(req.data.osha);
    if (o.error) throw new HttpsError("invalid-argument", o.error);
    osha = o.osha;
  }
  return db.runTransaction(async (tx) => {
    const ref = col("incidents", test).doc(String(req.data?.id || ""));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That report no longer exists.");
    if (snap.get("status") === "closed") throw new HttpsError("failed-precondition", "That report is closed.");
    const started = req.data?.start === true || whys.some(Boolean) || !!rootCause;
    const { status } = await refreshIncident(tx, test, ref, snap.get("status"), started);
    if (osha && !me.hr) throw new HttpsError("permission-denied", "The injury record needs HR access.");
    const oshaRef = ref.collection("private").doc("osha");
    const was = osha ? (await tx.get(oshaRef)).data() || {} : null;
    // Signed reports (Decision 108): who was hurt and the body part are what the Supervisor and witnesses signed.
    if (osha && (snap.get("supervisorSigned") || snap.get("witnessSignatures"))) {
      if ((osha.injuredName || "") !== (was.injuredName || "") || (osha.bodyPart || "") !== (was.bodyPart || "")) {
        throw new HttpsError("failed-precondition", "Who was hurt and the body part were signed — they can't be changed now. Add a note in the root cause instead.");
      }
    }
    keepHistory(tx, ref, snap.data(), { whys, rootCause, status }, me.employeeNumber, { byName: me.name, test });
    tx.update(ref, { whys, rootCause, status, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.employeeNumber, updatedByName: me.name });
    if (osha && ["injury", "first-aid"].includes(snap.get("type"))) {
      keepHistory(tx, oshaRef, was, osha, me.employeeNumber, { byName: me.name, test });
      tx.set(oshaRef, { ...osha, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.employeeNumber });
    }
    auditRecord(tx, "followed-up", "incident", ref.id, me.employeeNumber, { status, test });
    return { status };
  });
});

// Follow-up: { id, text, ownerEmp, due } — a corrective action; it shows in the owner's Needs you.
exports.addIncidentAction = onCall(async (req) => {
  const me = await requireIncidentFollower(req);
  const test = isTest(req);
  const owners = (await peopleList()).map((p) => ({ id: p.id, name: p.name, active: p.active }));
  const { action, error } = incidentsLib.cleanAction(req.data, owners);
  if (error) throw new HttpsError("invalid-argument", error);
  const out = await db.runTransaction(async (tx) => {
    const ref = col("incidents", test).doc(String(req.data?.id || ""));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That report no longer exists.");
    if (snap.get("status") === "closed") throw new HttpsError("failed-precondition", "That report is closed.");
    const { openActions } = await refreshIncident(tx, test, ref, snap.get("status"), true);
    const aRef = col("incidentActions", test).doc();
    tx.create(aRef, { ...action, incidentId: ref.id, incidentType: snap.get("type"), createdAt: FieldValue.serverTimestamp(), createdBy: me.employeeNumber, done: null, ...(test ? { test: true } : {}) });
    tx.update(ref, { openActions: openActions + 1, status: "actions", updatedAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "action-added", "incident", ref.id, me.employeeNumber, { owner: action.ownerEmp, due: action.due, test });
    return { actionId: aRef.id };
  });
  await pushTo(test ? [me.employeeNumber] : [action.ownerEmp], { title: `${test ? "[TEST] " : ""}🛠 Safety action for you`, body: `${action.text} — due ${action.due}`, url: "/?actions=1" });
  return out;
});

// The owner (or follow-up): { actionId, note } — action done.
exports.completeIncidentAction = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const note = typeof req.data?.note === "string" ? req.data.note.trim().slice(0, 500) : "";
  return db.runTransaction(async (tx) => {
    const aRef = col("incidentActions", test).doc(String(req.data?.actionId || ""));
    const a = await tx.get(aRef);
    if (!a.exists) throw new HttpsError("not-found", "That action no longer exists.");
    if (a.get("ownerEmp") !== me.employeeNumber && !incidentsLib.canFollow(me.roles)) throw new HttpsError("permission-denied", "Only the owner or Training & Safety can mark this done.");
    if (a.get("done")) throw new HttpsError("failed-precondition", "That action is already done.");
    const ref = col("incidents", test).doc(a.get("incidentId"));
    const snap = await tx.get(ref);
    const { openActions } = await refreshIncident(tx, test, ref, snap.get("status"), true);
    const left = Math.max(0, openActions - 1);
    tx.update(aRef, { done: { at: FieldValue.serverTimestamp(), atMs: Date.now(), by: me.employeeNumber, byName: me.name, note } });
    if (snap.exists && snap.get("status") !== "closed") tx.update(ref, { openActions: left, status: incidentsLib.nextStatus(snap.get("status"), { openActions: left, started: true }) });
    auditRecord(tx, "action-done", "incident", ref.id, me.employeeNumber, { action: aRef.id, test });
    return { ok: true, left };
  });
});

// Training & Safety or Production Manager, with PIN: { id, signer, device } — close (every action done first).
exports.closeIncident = onCall(signable(async (req) => {
  await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  if (!incidentsLib.canFollow(signer.roles)) throw new HttpsError("permission-denied", `${signer.name} can't close reports — Training & Safety or the Production Manager signs.`);
  const device = annLib.cleanDevice(req.data?.device);
  return db.runTransaction(async (tx) => {
    const ref = col("incidents", test).doc(String(req.data?.id || ""));
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That report no longer exists.");
    if (snap.get("status") === "closed") throw new HttpsError("failed-precondition", "Already closed.");
    const { openActions } = await refreshIncident(tx, test, ref, snap.get("status"), true);
    if (openActions) throw new HttpsError("failed-precondition", `Finish the ${openActions} open action${openActions === 1 ? "" : "s"} first.`);
    if (incidentsLib.SIG_TYPES.includes(snap.get("type")) && snap.get("supervisorSigned") !== true) throw new HttpsError("failed-precondition", "The Supervisor hasn't signed this report yet.");
    const closedAtMs = Date.now();
    const i = snap.data();
    const version = signoffsLib.contentVersion({ type: i.type, occurredAt: i.occurredAt, place: i.place, what: i.what, immediate: i.immediate, whys: i.whys, rootCause: i.rootCause });
    tx.update(ref, { status: "closed", openActions: 0, closedAtMs, keepUntilMs: incidentsLib.keepUntilMs({ closedAtMs }), closed: { by: signer.employeeNumber, byName: signer.name, at: FieldValue.serverTimestamp(), device, version } });
    logSignoff(tx, test, { kind: "incident-closed", refId: ref.id, version, emp: signer.employeeNumber, name: signer.name, method: "pin", device });
    auditRecord(tx, "closed", "incident", ref.id, signer.employeeNumber, { test });
    return { ok: true, name: signer.name, test };
  });
}));

// Follow-up: active people (for action owners), and who can close with a PIN on this device.
exports.incidentPeople = onCall(async (req) => {
  const me = await requireIncidentFollower(req);
  const people = (await peopleList()).filter((p) => p.active);
  return {
    owners: people.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
    closers: people.filter((p) => p.loginEnabled && p.id !== me.employeeNumber && incidentsLib.canFollow(p.roles)).map((p) => ({ emp: p.id, name: p.name })),
  };
});

// Injury / first aid, signed later on the reporter's device (or by follow-up): { id, role: "supervisor" | "witness",
// name, png, device }. The Supervisor signs once; witnesses are added (up to 6).
exports.signIncident = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const role = req.data?.role === "supervisor" ? "supervisor" : "witness";
  const { sig, error } = incidentsLib.cleanSignature(req.data, role === "supervisor" ? "Supervisor" : "Witness");
  if (error) throw new HttpsError("invalid-argument", error);
  const device = annLib.cleanDevice(req.data?.device);
  const incId = String(req.data?.id || "");
  if (!/^[A-Za-z0-9]{10,40}$/.test(incId)) throw new HttpsError("not-found", "That report no longer exists.");
  const sigPath = await saveSignature(safetyFolder(test, incId), `sig-${role}-${Date.now()}`, sig.png);
  return db.runTransaction(async (tx) => {
    const ref = col("incidents", test).doc(incId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That report no longer exists.");
    if (snap.get("createdBy") !== me.employeeNumber && !incidentsLib.canFollow(me.roles)) throw new HttpsError("permission-denied", "Signatures are collected on the reporter's device or by Training & Safety.");
    if (!incidentsLib.SIG_TYPES.includes(snap.get("type"))) throw new HttpsError("failed-precondition", "Only injury and first-aid reports are signed.");
    if (snap.get("status") === "closed") throw new HttpsError("failed-precondition", "That report is closed.");
    const sigRef = ref.collection("private").doc("signatures");
    const cur = (await tx.get(sigRef)).data() || { supervisor: null, witnesses: [] };
    const i = snap.data();
    const named = sig.emp ? await tx.get(employees.doc(sig.emp)) : null;
    if (sig.emp && (!named.exists || named.get("active") === false)) throw new HttpsError("invalid-argument", "Pick the person from the list (or type a name for someone who isn't an employee).");
    const version = incidentSignedVersion(i, (await tx.get(ref.collection("private").doc("osha"))).data());
    const stamped = { name: named ? named.get("name") || sig.name : sig.name, emp: sig.emp || null, path: sigPath, atMs: Date.now(), device, collectedBy: me.employeeNumber, collectedByName: me.name, version };
    if (role === "supervisor") {
      if (cur.supervisor) throw new HttpsError("failed-precondition", `Already signed by ${cur.supervisor.name}.`);
      cur.supervisor = stamped;
    } else {
      if ((cur.witnesses || []).length >= incidentsLib.MAX_WITNESSES) throw new HttpsError("failed-precondition", `Up to ${incidentsLib.MAX_WITNESSES} witnesses.`);
      cur.witnesses = [...(cur.witnesses || []), stamped];
    }
    tx.set(sigRef, cur);
    tx.update(ref, { supervisorSigned: !!cur.supervisor, supervisorSignedName: cur.supervisor?.name || "", witnessSignatures: (cur.witnesses || []).length });
    logSignoff(tx, test, { kind: `incident-signature (${role})`, refId: ref.id, version, emp: stamped.emp || `not-employee:${stamped.name}`, name: stamped.name, method: "drawn", device, collectedBy: me.employeeNumber, collectedByName: me.name });
    auditRecord(tx, `signed (${role})`, "incident", ref.id, me.employeeNumber, { name: sig.name, test });
    return { ok: true, role, name: sig.name };
  });
});

// What an injury / first-aid signature signs (Decision 108): the report and who was hurt, where on the body.
function incidentSignedVersion(i, osha) {
  return signoffsLib.contentVersion({ type: i.type, occurredAt: i.occurredAt, place: i.place, what: i.what, immediate: i.immediate, injuredName: osha?.injuredName || "", bodyPart: osha?.bodyPart || "" });
}

// Follow-up: { id } — the report's photos and signatures as pictures (read here on the server from the private folder).
exports.incidentFiles = onCall(async (req) => {
  const me = await requireIncidentFollower(req);
  const test = isTest(req);
  const snap = await col("incidents", test).doc(String(req.data?.id || "")).get();
  if (!snap.exists) throw new HttpsError("not-found", "That report no longer exists.");
  // Without HR access: near-miss / property / spill photos only — no injury photos, no signatures.
  if (!me.hr) {
    if (hrLib.photosNeedHr(snap.get("type"))) return { photos: [], signatures: null, hrOnly: true };
    return { photos: await Promise.all((snap.get("photoPaths") || []).map((p) => fileDataUrl(p, "image/jpeg"))), signatures: null };
  }
  const sigs = (await snap.ref.collection("private").doc("signatures").get()).data() || null;
  const sigOut = async (s) => (s ? { name: s.name, atMs: s.atMs || null, image: s.path ? await fileDataUrl(s.path, "image/png") : null } : null);
  return {
    photos: await Promise.all((snap.get("photoPaths") || []).map((p) => fileDataUrl(p, "image/jpeg"))),
    signatures: sigs ? { supervisor: await sigOut(sigs.supervisor), witnesses: await Promise.all((sigs.witnesses || []).map(sigOut)) } : null,
  };
});

// Admins: { year } — that year's injury and first-aid reports with the injury record and signatures, for the locked HR
// folder (the screen turns it into a PDF). Every export is in the activity log.
exports.exportInjuryReports = onCall({ timeoutSeconds: 120, memory: "512MiB" }, async (req) => {
  const { employeeNumber: adminNumber } = await requireHr(req);
  const test = isTest(req);
  const year = String(req.data?.year || "");
  if (!/^20\d\d$/.test(year)) throw new HttpsError("invalid-argument", "Pick a year.");
  const snaps = await col("incidents", test).where("month", ">=", `${year}-01`).where("month", "<=", `${year}-12`).get();
  const rows = [];
  for (const d of snaps.docs.filter((x) => incidentsLib.SIG_TYPES.includes(x.get("type"))).sort((a, b) => String(a.get("occurredAt")).localeCompare(String(b.get("occurredAt"))))) {
    const [osha, sigs, acts] = await Promise.all([
      d.ref.collection("private").doc("osha").get(), d.ref.collection("private").doc("signatures").get(),
      col("incidentActions", test).where("incidentId", "==", d.id).get(),
    ]);
    const s = sigs.data() || {};
    const sigOut = async (x) => (x ? { name: x.name, atMs: x.atMs || null, image: x.path ? await fileDataUrl(x.path, "image/png") : null } : null);
    const injury = Object.fromEntries(incidentsLib.INJURY_FIELDS.map((k) => [k, osha.get(k) || ""]));
    rows.push({
      id: d.id, type: d.get("type"), occurredAt: d.get("occurredAt"), placeName: d.get("placeName") || "", what: d.get("what") || "", immediate: d.get("immediate") || "",
      witnesses: d.get("witnesses") || "", reportedBy: d.get("anonymous") ? "anonymous" : d.get("createdByName") || "", status: d.get("status"),
      whys: d.get("whys") || [], rootCause: d.get("rootCause") || "", closedBy: d.get("closed")?.byName || "", closedAtMs: d.get("closedAtMs") || null,
      injury, photoCount: (d.get("photoPaths") || []).length,
      actions: acts.docs.map((a) => ({ text: a.get("text"), owner: a.get("ownerName"), due: a.get("due"), done: !!a.get("done") })),
      signatures: { supervisor: await sigOut(s.supervisor), witnesses: await Promise.all((s.witnesses || []).map(sigOut)) },
    });
  }
  await auditLog.add({ type: "exported", kind: "injury reports", recordId: year, by: adminNumber, at: FieldValue.serverTimestamp(), count: rows.length, test });
  return { year, rows, test };
});

// Admins, one-time (safe to run again): moves safety-report photos and signatures made before the private folder
// existed (photos in uploads/…, signatures stored as pictures in the database) into safety/{incidentId}/….
exports.adminMoveSafetyFiles = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async (req) => {
  const adminNumber = await requireAdmin(req);
  let photos = 0, signatures = 0, reports = 0;
  for (const test of [false, true]) {
    for (const d of (await col("incidents", test).get()).docs) {
      const folder = safetyFolder(test, d.id);
      const update = {};
      const old = d.get("photos");
      if (Array.isArray(old) && old.length) {
        const paths = [...(d.get("photoPaths") || [])];
        for (const url of old) {
          const p = fixesLib.storagePath(url, BUCKET);
          if (!p) continue;
          try {
            const [buf] = await bucketRef().file(p).download();
            paths.push(await savePrivate(`${folder}/photo-${paths.length + 1}.jpg`, buf, "image/jpeg"));
            await bucketRef().file(p).delete({ ignoreNotFound: true });
            photos++;
          } catch (err) { console.warn("photo not moved", p, err.message); }
        }
        Object.assign(update, { photoPaths: paths, photos: FieldValue.delete() });
      }
      const sigRef = d.ref.collection("private").doc("signatures");
      const s = (await sigRef.get()).data();
      if (s) {
        let changed = false;
        const fix = async (x, file) => {
          if (!x?.png) return x;
          changed = true; signatures++;
          const { png, ...rest } = x;
          return { ...rest, path: await saveSignature(folder, file, png) };
        };
        const next = { supervisor: await fix(s.supervisor, "sig-supervisor"), witnesses: await Promise.all((s.witnesses || []).map((w, n) => fix(w, `sig-witness-${n + 1}`))) };
        if (changed) await sigRef.set(next);
      }
      if (Object.keys(update).length) { await d.ref.update(update); reports++; }
    }
  }
  await auditLog.add({ type: "moved", kind: "safety files", recordId: "safety", by: adminNumber, at: FieldValue.serverTimestamp(), photos, signatures, reports });
  return { photos, signatures, reports };
});

// HR access: { employeeNumber, on } — only someone with HR access can change it (first setup: an Admin, for himself,
// when nobody has it yet). Every change is in the activity log.
exports.setHrAccess = onCall(async (req) => {
  const me = await requireMember(req);
  const target = pin.normalizeEmployeeNumber(req.data?.employeeNumber);
  if (!target) throw new HttpsError("invalid-argument", "Pick a person.");
  const on = req.data?.on === true;
  const holders = (await employees.where("hrAccess", "==", true).get()).docs.filter((d) => d.get("active") !== false).map((d) => d.id);
  const check = hrLib.canSetHr(me, target, holders.length > 0);
  if (!check.ok) throw new HttpsError("permission-denied", check.error);
  if (hrLib.wouldLeaveNobody(holders, target, on)) throw new HttpsError("failed-precondition", "Someone has to keep HR access — give it to another person first.");
  await db.runTransaction(async (tx) => {
    const ref = employees.doc(target);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That person isn't in People.");
    tx.update(ref, { hrAccess: on, updatedAt: FieldValue.serverTimestamp() });
    tx.create(auditLog.doc(), { type: on ? "hr-access-on" : "hr-access-off", kind: "employee", recordId: target, by: me.employeeNumber, at: FieldValue.serverTimestamp(), firstSetup: !!check.firstSetup });
  });
  return { ok: true, employeeNumber: target, on };
});

// HR access holders: who has it (names only).
exports.hrAccessList = onCall(async (req) => {
  await requireHr(req);
  const snaps = await employees.where("hrAccess", "==", true).get();
  return { people: snaps.docs.filter((d) => d.get("active") !== false).map((d) => ({ id: d.id, name: d.get("name") || d.id })) };
});

// After posting a lessons-learned announcement from a near miss: { id, annId }.
exports.markIncidentShared = onCall(async (req) => {
  const me = await requireIncidentFollower(req);
  const test = isTest(req);
  const ref = col("incidents", test).doc(String(req.data?.id || ""));
  const ann = await col("announcements", test).doc(String(req.data?.annId || "")).get();
  if (!ann.exists) throw new HttpsError("not-found", "That announcement wasn't found.");
  await ref.update({ sharedAnnId: ann.id, sharedAt: FieldValue.serverTimestamp(), sharedBy: me.employeeNumber });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Who to Call (Chris, 10-21-2026). Rules in callsheet.js. The numbers are kept only here in the database.
// ---------------------------------------------------------------------------

// Admins: { mainNumber, entries, onCall } — the call sheet.
exports.adminSaveCallSheet = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const { sheet, error } = callLib.cleanSheet(req.data);
  if (error) throw new HttpsError("invalid-argument", error);
  await keepHistoryNow(db.collection("meta").doc("callSheet"), sheet, adminNumber);
  await db.collection("meta").doc("callSheet").set({ ...sheet, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber });
  await auditLog.add({ type: "updated", kind: "call sheet", recordId: "callSheet", by: adminNumber, at: FieldValue.serverTimestamp(), entries: sheet.entries.length, onCall: sheet.onCall.length });
  return { ok: true };
});

// Anyone: { ext, kind, lineId? } — a tap on a call button (stops the line-down reminder once Maintenance is called).
exports.logCallTap = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const kind = callLib.KINDS.includes(req.data?.kind) ? req.data.kind : "other";
  const lineId = req.data?.lineId && records.isRecordId(String(req.data.lineId)) ? String(req.data.lineId) : null;
  await col("callTaps", test).add({ ext: String(req.data?.ext || "").replace(/\D/g, "").slice(0, 6), kind, lineId, at: FieldValue.serverTimestamp(), atMs: Date.now(), by: me.employeeNumber, byName: me.name, ...(test ? { test: true } : {}) });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Flagged Reels / QC Hold (Chris, 10-21-2026; SOP0012). Rules in reels.js. Test site: test_reels.
// 🏷 Flagged → (Floater: in QC Staging) → ⚖️ decision (Line Lead / Quality / Supervisor, PIN) → ♻️ Reclamation closes
// regrind and scrap → ✓ Done. Reasons, sizes, and SDRs: meta/reelSettings (Admin → QC hold); starting lists in reels.js.
// ---------------------------------------------------------------------------

const reelSettingsDoc = db.collection("meta").doc("reelSettings");

async function reelSettings() {
  const d = (await reelSettingsDoc.get()).data() || {};
  return {
    reasons: d.reasons || reelsLib.STARTING_REASONS.map((name) => ({ id: reelsLib.slug(name), name, active: true })),
    sizes: d.sizes || reelsLib.STARTING_SIZES,
    sdrs: d.sdrs || reelsLib.STARTING_SDRS,
    colors: d.colors || [], // every color used so far (Orange is always offered)
    testColors: d.testColors || [], // practice flags on the test site
  };
}

const reelSearch = (r) => [r.tag, r.reasonName, r.product?.size, r.product?.sdr, r.product?.color, r.note].join(" ").toLowerCase();

async function getReel(tx, test, id) {
  const snap = await tx.get(col("reels", test).doc(String(id || "")));
  if (!snap.exists) throw new HttpsError("not-found", "That reel is no longer on the QC list.");
  return snap;
}

// Anyone on the floor: { lineId, winder, tag | noTag, footage, reasonId, product { size, sdr, color }, photo, note }.
exports.flagReel = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const [settings, lineSnaps, shiftForm, machineSnaps] = await Promise.all([reelSettings(), lines.get(), formTemplates.doc(formsLib.SHIFT_FORM).get(), machines.get()]);
  const activeLines = lineSnaps.docs.filter((l) => l.get("active") !== false);
  const known = test ? [...settings.colors, ...settings.testColors] : settings.colors;
  const { reel, error } = reelsLib.cleanFlag(req.data, { reasons: settings.reasons, colors: known, lineIds: activeLines.map((l) => l.id), isOurFile: isOurUpload });
  if (error) throw new HttpsError("invalid-argument", error);
  const newColor = reel.product.color !== reelsLib.DEFAULT_COLOR && reelsLib.withColor(known, reel.product.color) ? reel.product.color : null;
  const now = Date.now();
  const shift = formsLib.currentShift(shiftForm.get("shifts") || [], now);
  const ref = col("reels", test).doc();
  await db.runTransaction(async (tx) => {
    tx.create(ref, {
      ...reel, lineName: activeLines.find((l) => l.id === reel.lineId).get("name"), status: "flagged",
      machineId: reelsLib.winderMachine(machineSnaps.docs.map((m) => ({ id: m.id, ...m.data() })), reel.lineId, reel.winder), // Decision 120
      flagged: { at: FieldValue.serverTimestamp(), atMs: now, by: me.employeeNumber, byName: me.name, shiftId: shift?.shift.id || null, shiftName: shift?.shift.name || null },
      flaggedDate: plantToday(), flaggedAtMs: now, dueMs: reelsLib.dueAfterNextShift(shift, now),
      search: reelSearch(reel),
      ...(test ? { test: true } : {}),
    });
    if (newColor) tx.set(reelSettingsDoc, { [test ? "testColors" : "colors"]: FieldValue.arrayUnion(newColor) }, { merge: true });
    auditRecord(tx, "flagged", "reel", ref.id, me.employeeNumber, { tag: reel.tag || "no tag", reason: reel.reasonName, test });
  });
  return { id: ref.id, test };
});

// Floater: { id } — moved to QC Staging.
exports.stageReel = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  return db.runTransaction(async (tx) => {
    const snap = await getReel(tx, test, req.data?.id);
    if (snap.get("status") !== "flagged") throw new HttpsError("failed-precondition", "That reel was already moved or decided.");
    tx.update(snap.ref, { status: "staged", staged: { at: FieldValue.serverTimestamp(), by: me.employeeNumber, byName: me.name } });
    auditRecord(tx, "staged", "reel", snap.id, me.employeeNumber, { test });
    return { ok: true };
  });
});

// Line Lead / Quality / Supervisor, with their PIN: { id, kind, note, signer, device }.
exports.decideReel = onCall(signable(async (req) => {
  await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  if (!reelsLib.canDecide(signer.roles)) throw new HttpsError("permission-denied", `${signer.name} can't decide on reels — a Line Lead, Quality, or Supervisor signs.`);
  const { kind, note, error } = reelsLib.cleanDecision(req.data);
  if (error) throw new HttpsError("invalid-argument", error);
  const device = annLib.cleanDevice(req.data?.device);
  const d = reelsLib.DECISIONS[kind];
  return db.runTransaction(async (tx) => {
    const snap = await getReel(tx, test, req.data?.id);
    if (!["flagged", "staged"].includes(snap.get("status"))) throw new HttpsError("failed-precondition", "That reel already has a decision.");
    const done = d.next === "done";
    const { status: _s, decision: _d, updatedAt: _u, ...flagged } = snap.data();
    const version = signoffsLib.contentVersion(flagged);
    tx.update(snap.ref, {
      status: d.next, decision: { kind, label: d.label, note, by: signer.employeeNumber, byName: signer.name, at: FieldValue.serverTimestamp(), atMs: Date.now(), device, version },
      ...(done ? { doneAtMs: Date.now() } : {}),
    });
    logSignoff(tx, test, { kind: "reel-decision", refId: snap.id, version, emp: signer.employeeNumber, name: signer.name, method: "pin", device, decision: kind });
    auditRecord(tx, "decided", "reel", snap.id, signer.employeeNumber, { decision: kind, test });
    return { ok: true, name: signer.name, next: d.next, test };
  });
}));

// Reclamation: { id, footage, segregation } — closes a regrind / scrap reel.
exports.reclaimReel = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const { footage, segregation, error } = reelsLib.cleanReclaim(req.data);
  if (error) throw new HttpsError("invalid-argument", error);
  return db.runTransaction(async (tx) => {
    const snap = await getReel(tx, test, req.data?.id);
    if (snap.get("status") !== "reclaim") throw new HttpsError("failed-precondition", "That reel isn't waiting on Reclamation.");
    tx.update(snap.ref, { status: "done", doneAtMs: Date.now(), reclaim: { footage, segregation, by: me.employeeNumber, byName: me.name, at: FieldValue.serverTimestamp() } });
    auditRecord(tx, "reclaimed", "reel", snap.id, me.employeeNumber, { footage, test });
    return { ok: true };
  });
});

// Who can decide on this device (line tablets): Line Leads, Quality, Supervisors with a login.
exports.reelDeciders = onCall(async (req) => {
  const me = await requireMember(req);
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled && p.id !== me.employeeNumber && reelsLib.canDecide(p.roles));
  return { people: people.map((p) => ({ emp: p.id, name: p.name })) };
});

// Admins: { reasons?, sizes?, sdrs?, colors? } — the lists on the flag screen (colors may be empty for now).
exports.adminSaveReelSettings = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const cur = await reelSettings();
  const next = { ...cur };
  if (req.data?.reasons !== undefined) {
    const { reasons, error } = reelsLib.cleanReasons(req.data.reasons);
    if (error) throw new HttpsError("invalid-argument", error);
    next.reasons = reasons;
  }
  for (const [k, what, optional] of [["sizes", "sizes"], ["sdrs", "walls (SDR)"], ["colors", "colors", true]]) {
    if (req.data?.[k] === undefined) continue;
    const { list, error } = reelsLib.cleanChoices(req.data[k], what, { optional: !!optional });
    if (error) throw new HttpsError("invalid-argument", error);
    next[k] = list;
  }
  await keepHistoryNow(reelSettingsDoc, next, adminNumber);
  await reelSettingsDoc.set({ ...next, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber });
  await auditLog.add({ type: "updated", kind: "qc hold lists", recordId: "reelSettings", by: adminNumber, at: FieldValue.serverTimestamp() });
  return { ok: true };
});

// Admins: { from, to } — merge a duplicate color ("blk" → "Black"): every reel (live and practice) with "from" is
// changed to "to", and "from" leaves the used-colors lists. Logged.
exports.adminMergeReelColor = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const cur = await reelSettings();
  const { from, to, error } = reelsLib.cleanMerge(req.data, [...new Set([...cur.colors, ...cur.testColors])]);
  if (error) throw new HttpsError("invalid-argument", error);
  let changed = 0;
  for (const test of [false, true]) {
    const snaps = await col("reels", test).where("product.color", "==", from).get();
    for (let i = 0; i < snaps.docs.length; i += 400) {
      const batch = db.batch();
      for (const d of snaps.docs.slice(i, i + 400)) {
        const product = { ...d.get("product"), color: to };
        batch.update(d.ref, { product, search: reelSearch({ ...d.data(), product }) });
      }
      await batch.commit();
    }
    changed += snaps.size;
  }
  await reelSettingsDoc.set({
    colors: reelsLib.mergedColors(cur.colors, from, to), testColors: reelsLib.mergedColors(cur.testColors, from, to),
    updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber,
  }, { merge: true });
  await auditLog.add({ type: "merged", kind: "reel color", recordId: "reelSettings", by: adminNumber, at: FieldValue.serverTimestamp(), from, to, reels: changed });
  return { from, to, reels: changed };
});

// ---------------------------------------------------------------------------
// Low silo alert (Chris, 10-21-2026). Rules in silos.js. Levels from the Shift Handoff and "Update silo levels";
// low lines per silo in Admin → Silo alerts (meta/siloSettings). Test site: test_siloLevels / test_siloReadings
// (the low lines are shared), and the alert goes only to the person testing.
// ---------------------------------------------------------------------------

const siloSettingsDoc = db.collection("meta").doc("siloSettings");

// Saves each reading, decides alerts (one per drop), and tells Logistics, Supervisors, the Production Manager, and the
// extra people picked in Admin → Silo alerts.
async function recordSiloLevels(test, levels, me, source) {
  const ids = Object.keys(levels);
  if (!ids.length) return { saved: 0, alerts: [] };
  const settingsSnap = await siloSettingsDoc.get();
  const settings = settingsSnap.get("silos") || {};
  const alerts = await db.runTransaction(async (tx) => {
    const refs = ids.map((id) => col("siloLevels", test).doc(id));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    const out = [];
    ids.forEach((id, i) => {
      const level = levels[id];
      const { alert, alerted } = silosLib.judge(settings[id], snaps[i].get("alerted") === true, level);
      tx.set(refs[i], { level, at: FieldValue.serverTimestamp(), by: me.employeeNumber, byName: me.name, source, alerted, ...(alert ? { alertedAt: FieldValue.serverTimestamp() } : {}) });
      tx.create(col("siloReadings", test).doc(), { siloId: id, level, at: FieldValue.serverTimestamp(), by: me.employeeNumber, byName: me.name, source, alert });
      if (alert) out.push({ id, level, low: settings[id].low });
    });
    return out;
  });
  if (alerts.length) {
    const list = alerts.map((a) => `${silosLib.siloName(a.id)} at ${a.level}% (low line ${a.low}%)`).join(", ");
    const to = test ? [me.employeeNumber] : silosLib.alertRecipients(await activeEmployees(), settingsSnap.get("alertPeople") || []);
    await pushTo(to, { title: `${test ? "[TEST] " : ""}🛢 Low silo: ${alerts.map((a) => silosLib.siloName(a.id)).join(", ")}`, body: `${list} — entered by ${me.name}`, url: "/?silos=1", urgent: true });
    await auditLog.add({ type: "low-silo", kind: "silo", recordId: alerts.map((a) => a.id).join(","), by: me.employeeNumber, at: FieldValue.serverTimestamp(), alerts, test });
  }
  return { saved: ids.length, alerts: alerts.map((a) => a.id) };
}

// Line Operator (material system) and up, mid-shift: { levels: { "silo-1": 40, … } }.
exports.updateSiloLevels = onCall(async (req) => {
  const me = await requireMember(req);
  if (!me.roles.some((r) => silosLib.UPDATE_ROLES.includes(r))) throw new HttpsError("permission-denied", "Only operators, leads, supervisors, and managers update silo levels.");
  const levels = silosLib.levelsFrom(req.data?.levels);
  if (!Object.keys(levels).length) throw new HttpsError("invalid-argument", "Enter at least one silo level (0–100%).");
  const out = await recordSiloLevels(isTest(req), levels, me, "update");
  return { ...out, test: isTest(req) };
});

// Admins: { silos: { [siloId]: { low, alert } }, alertPeople? } — the low line for each silo (blank = no alerts for
// it) and the extra people who get alerts (left as is when not sent, so older screens don't clear it).
exports.adminSaveSiloSettings = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const { silos, error } = silosLib.cleanSettings(req.data?.silos);
  if (error) throw new HttpsError("invalid-argument", error);
  const extra = {};
  if (req.data?.alertPeople !== undefined) {
    const { people, error: peopleError } = silosLib.cleanPeople(req.data.alertPeople);
    if (peopleError) throw new HttpsError("invalid-argument", peopleError);
    extra.alertPeople = people;
  }
  await keepHistoryNow(siloSettingsDoc, { silos, ...extra }, adminNumber);
  await siloSettingsDoc.set({ silos, ...extra, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber }, { merge: true });
  await auditLog.add({ type: "updated", kind: "silo alerts", recordId: "siloSettings", by: adminNumber, at: FieldValue.serverTimestamp(), silos, ...extra });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Trucks board — Logistics & Distribution (Chris, 10-21-2026). Rules in trucks.js. Test site: test_trucks.
// Posting rights per role on the Roles screen ("Can post trucks"); the database rules read meta/truckAccess.
// ---------------------------------------------------------------------------

async function writeTruckAccess() {
  const list = await roleList();
  const ids = [...new Set([...trucksLib.VIEW_ROLES, ...list.filter((r) => r.active !== false && trucksLib.rolePostsTrucks(r)).map((r) => r.id)])];
  await db.collection("meta").doc("truckAccess").set({ roles: ids, updatedAt: FieldValue.serverTimestamp() });
}

async function requireTruckRole(req, kind) {
  const me = await requireMember(req);
  const list = await roleList();
  const ok = kind === "post" ? trucksLib.canPostTrucks(list, me.roles) : trucksLib.canCheckTrucks(list, me.roles);
  if (!ok) throw new HttpsError("permission-denied", kind === "post" ? "Your role can't post trucks. An admin can allow it in Admin → Roles." : "Only Logistics & Distribution checks trucks off.");
  return me;
}

// The people who post trucks (the managers) — they get the arrived / out the door notifications.
async function truckManagers() {
  const list = await roleList();
  const posting = new Set(list.filter((r) => r.active !== false && trucksLib.rolePostsTrucks(r)).map((r) => r.id));
  return (await activeEmployees()).filter((e) => e.active !== false && e.roles.some((r) => posting.has(r))).map((e) => e.id);
}

// Poster: new { date, dir, carrier, time, forKind, ref, material, notes } or edit (same + id).
exports.saveTruck = onCall(async (req) => {
  const me = await requireTruckRole(req, "post");
  const test = isTest(req);
  const { truck, error } = trucksLib.cleanTruck(req.data);
  if (error) throw new HttpsError("invalid-argument", error);
  const list = col("trucks", test);
  const id = req.data?.id ? String(req.data.id) : null;
  return db.runTransaction(async (tx) => {
    if (id) {
      const snap = await tx.get(list.doc(id));
      if (!snap.exists || snap.get("status") === "removed") throw new HttpsError("not-found", "That truck is no longer on the board.");
      keepHistory(tx, snap.ref, snap.data(), truck, me.employeeNumber, { byName: me.name, test });
      tx.update(snap.ref, { ...truck, updatedAt: FieldValue.serverTimestamp(), updatedBy: me.employeeNumber, updatedByName: me.name });
      auditRecord(tx, "updated", "truck", id, me.employeeNumber, { label: trucksLib.label(truck), test });
      return { id };
    }
    const ref = list.doc();
    tx.create(ref, { ...truck, status: "expected", createdAt: FieldValue.serverTimestamp(), createdBy: me.employeeNumber, createdByName: me.name, ...(test ? { test: true } : {}) });
    auditRecord(tx, "created", "truck", ref.id, me.employeeNumber, { label: trucksLib.label(truck), date: truck.date, test });
    return { id: ref.id };
  });
});

// Poster: { id } — take a truck off the board (kept in history as removed).
exports.removeTruck = onCall(async (req) => {
  const me = await requireTruckRole(req, "post");
  const test = isTest(req);
  const ref = col("trucks", test).doc(String(req.data?.id || ""));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("status") === "removed") throw new HttpsError("not-found", "That truck is no longer on the board.");
    tx.update(ref, { status: "removed", removedAt: FieldValue.serverTimestamp(), removedBy: me.employeeNumber, removedByName: me.name });
    auditRecord(tx, "removed", "truck", ref.id, me.employeeNumber, { label: trucksLib.label(snap.data()), test });
    return { id: ref.id };
  });
});

// Poster: { date } — copy the last day with trucks (looking back up to 7 days) onto `date` as expected trucks.
exports.copyTrucksFromDay = onCall(async (req) => {
  const me = await requireTruckRole(req, "post");
  const test = isTest(req);
  const date = String(req.data?.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpsError("invalid-argument", "Pick the day.");
  const list = col("trucks", test);
  const back = (n) => new Date(Date.parse(`${date}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  const recent = await list.where("date", ">=", back(7)).where("date", "<", date).get();
  const days = [...new Set(recent.docs.filter((d) => d.get("status") !== "removed").map((d) => d.get("date")))].sort();
  const fromDate = days.pop();
  if (!fromDate) throw new HttpsError("not-found", "No trucks in the last 7 days to copy.");
  const from = recent.docs.filter((d) => d.get("date") === fromDate).map((d) => d.data());
  const existing = (await list.where("date", "==", date).get()).docs.map((d) => d.data());
  const copies = trucksLib.copyTrucks(from, existing, date).slice(0, trucksLib.MAX_PER_DAY - existing.length);
  const batch = db.batch();
  for (const t of copies) batch.create(list.doc(), { ...t, status: "expected", copiedFrom: fromDate, createdAt: FieldValue.serverTimestamp(), createdBy: me.employeeNumber, createdByName: me.name, ...(test ? { test: true } : {}) });
  batch.create(auditLog.doc(), { type: "copied", kind: "trucks", recordId: date, by: me.employeeNumber, at: FieldValue.serverTimestamp(), fromDate, count: copies.length, test });
  await batch.commit();
  return { count: copies.length, fromDate };
});

// Yard: { id } — one tap: "Arrived" (inbound) or "Out the door" (outbound). Stamps the time and who; tells the managers.
exports.checkTruck = onCall(async (req) => {
  const me = await requireTruckRole(req, "check");
  const test = isTest(req);
  const ref = col("trucks", test).doc(String(req.data?.id || ""));
  const t = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("status") === "removed") throw new HttpsError("not-found", "That truck is no longer on the board.");
    if (snap.get("status") === "done") throw new HttpsError("failed-precondition", `Already checked off by ${snap.get("doneByName")}.`);
    tx.update(ref, { status: "done", doneAt: FieldValue.serverTimestamp(), doneAtMs: Date.now(), doneBy: me.employeeNumber, doneByName: me.name });
    auditRecord(tx, snap.get("dir") === "in" ? "arrived" : "out the door", "truck", ref.id, me.employeeNumber, { label: trucksLib.label(snap.data()), test });
    return snap.data();
  });
  const what = t.dir === "in" ? "📥 Arrived" : "🚚 Out the door";
  const to = test ? [me.employeeNumber] : (await truckManagers()).filter((e) => e !== me.employeeNumber);
  await pushTo(to, { title: `${test ? "[TEST] " : ""}${what}: ${t.carrier}`, body: `${[t.ref, t.material].filter(Boolean).join(" · ") || (t.dir === "in" ? "Inbound" : "Outbound")} — ${me.name}`, url: "/?trucks=1" });
  return { ok: true, test };
});

// Yard: { id } — undo a check-off within 5 minutes (a mis-tap).
exports.undoTruck = onCall(async (req) => {
  const me = await requireTruckRole(req, "check");
  const test = isTest(req);
  const ref = col("trucks", test).doc(String(req.data?.id || ""));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That truck is no longer on the board.");
    if (!trucksLib.canUndo(snap.data(), Date.now())) throw new HttpsError("failed-precondition", "Undo is only for 5 minutes after the tap.");
    const undo = { status: "expected", doneAt: FieldValue.delete(), doneAtMs: FieldValue.delete(), doneBy: FieldValue.delete(), doneByName: FieldValue.delete() };
    keepHistory(tx, ref, snap.data(), undo, me.employeeNumber, { byName: me.name, test });
    tx.update(ref, { ...undo, undoneBy: me.employeeNumber, undoneByName: me.name, undoneAt: FieldValue.serverTimestamp() });
    auditRecord(tx, "undo", "truck", ref.id, me.employeeNumber, { label: trucksLib.label(snap.data()), was: snap.get("doneByName"), test });
    return { ok: true };
  });
});

// ---------------------------------------------------------------------------
// Test site cleanup (Chris, 10-21-2026) — practice (test_) records only; rules and the live-safety test in testdata.js.
// Never touches live records, Odoo, or the training workbook.
// ---------------------------------------------------------------------------

async function cleanTestData(opts) {
  const out = await testData.clearTestData(db, { ...opts, deleteDoc: async (ref) => {
    if (ref.parent.id === "test_incidents") await bucketRef().deleteFiles({ prefix: `safety/test/${ref.id}/` }).catch(() => {});
    await db.recursiveDelete(ref);
  } });
  if (!opts.dryRun && out.total) {
    await writePlantStatus(true); // practice line-downs gone → the test site's line status follows
    await auditLog.add({ type: "cleared", kind: "test data", recordId: "test", by: opts.by || "system", at: FieldValue.serverTimestamp(), total: out.total, olderThanMs: opts.olderThanMs ?? null });
  }
  return out;
}

// Admins, test site only: { reset: false } → counts of practice records, plus the real open requests (to close in
// Odoo or mark "Line is back up" — listed, never changed). { reset: true } → removes every practice record.
exports.adminTestData = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const origin = String(req.rawRequest?.headers?.origin || "");
  if (origin === LIVE_ORIGIN) throw new HttpsError("failed-precondition", "This only works on the test site.");
  const reset = req.data?.reset === true;
  const out = await cleanTestData({ dryRun: !reset, by: adminNumber });
  if (reset) return out;
  const [open, machineSnaps] = await Promise.all([issues.where("open", "==", true).get(), machines.get()]);
  const machineName = new Map(machineSnaps.docs.map((m) => [m.id, m.get("name")]));
  const real = open.docs.map((d) => ({
    odooId: d.get("odooId") || null, title: String(d.get("title") || "").slice(0, 160), machineId: d.get("machineId") || null,
    machine: machineName.get(d.get("machineId")) || null, lineDown: d.get("lineDown") === true, unsafe: d.get("unsafe") === true,
    reportedAt: d.get("reportedAt")?.toMillis?.() || null,
  })).sort((a, b) => (b.lineDown + b.unsafe) - (a.lineDown + a.unsafe) || (a.reportedAt || 0) - (b.reportedAt || 0));
  return { ...out, real };
});

// Every day at 3:30 a.m. plant time: practice records not changed for 24 hours are removed.
exports.purgeTestData = onSchedule({ schedule: "every day 03:30", timeZone: "America/Chicago", retryCount: 0 }, async () => {
  await cleanTestData({ olderThanMs: Date.now() - testData.DAY_MS });
});

// ---------------------------------------------------------------------------
// Shop map (plant floor map). Company content — kept in the database only, read by signed-in people:
//   floorMap/layout          size, building outline, zones, icons
//   floorStations/{id}       position, shape, label, description, linked documents, machineId (M-number or null)
//   sops/{key}               full SOP / safety / troubleshooting text
// Admins and the map's department head load the map file (Documents & forms; every load is kept as a revision);
// Admins link stations to machines (Admin → Shop map).
// ---------------------------------------------------------------------------

const floorStations = db.collection("floorStations");
const sopsCol = db.collection("sops");

// Admins: { map } — the original's plant-data.json. Re-importing updates everything but keeps each
// station's machine link. Stations no longer in the file are retired (kept in history), never deleted.
exports.adminImportFloorMap = onCall({ memory: "512MiB" }, async (req) => {
  const { me } = await requireDocEditor(req, "map");
  const adminNumber = me.employeeNumber;
  const { layout, stations, sops, error } = floorMapLib.cleanMap(req.data?.map);
  if (error) throw new HttpsError("invalid-argument", error);
  const rev = await saveLoadRevision("map", { layout, stations, sops }, me, `${layout.zones.length} areas · ${stations.length} stations · ${Object.keys(sops).length} SOPs`);
  const existing = await floorStations.get();
  const now = FieldValue.serverTimestamp();
  const writes = [
    (b) => b.set(db.collection("floorMap").doc("layout"), { ...layout, importedAt: now, importedBy: adminNumber }),
    ...stations.map((s) => (b) => b.set(floorStations.doc(s.id), { ...s, active: true, updatedAt: now, updatedBy: adminNumber, mapRev: rev }, { merge: true })),
    ...existing.docs.filter((d) => !stations.some((s) => s.id === d.id)).map((d) => (b) => b.update(d.ref, { active: false, updatedAt: now })),
    ...Object.entries(sops).map(([k, s]) => (b) => b.set(sopsCol.doc(k), { ...s, updatedAt: now, updatedBy: adminNumber, mapRev: rev })),
  ];
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach((w) => w(batch));
    await batch.commit();
  }
  await auditLog.add({ type: "imported", kind: "shop map", recordId: "layout", by: adminNumber, at: now, stations: stations.length, sops: Object.keys(sops).length, rev });
  return { zones: layout.zones.length, stations: stations.length, sops: Object.keys(sops).length, rev };
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
    keepHistory(tx, stationRef, st.data(), { machineId }, adminNumber);
    tx.update(stationRef, { machineId, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber });
    auditRecord(tx, "linked", "map station", stationRef.id, adminNumber, { label: st.get("label"), machineId, was: st.get("machineId") || null });
  });
  return { ok: true };
});

// Admins: { machineIds } — make sure Odoo has an equipment record for each ("M-031 Outside Chiller"),
// so Maintenance Requests work for them. Existing ones are left alone, and retired machines are never added
// (10-22-2026: a retired station still linked to retired M-039 put it in Odoo).
exports.adminEnsureOdooEquipment = onCall({ secrets: [odooKey] }, async (req) => {
  const adminNumber = await requireAdmin(req);
  const ids = Array.isArray(req.data?.machineIds) ? [...new Set(req.data.machineIds.map(String))] : [];
  if (!ids.length || ids.length > 50 || !ids.every(records.isMachineId)) throw new HttpsError("invalid-argument", "List 1–50 machine IDs.");
  const key = odooKey.value();
  const refs = await getOdooRefs(key);
  const created = [];
  const already = [];
  const skipped = [];
  for (const id of ids) {
    const snap = await machines.doc(id).get();
    if (!snap.exists) throw new HttpsError("not-found", `There's no machine ${id} in the app.`);
    if (snap.get("active") === false) { skipped.push(id); continue; }
    const found = await odoo.odooCall(key, "maintenance.equipment", "search_read", { domain: [["name", "=like", `${id} %`]], fields: ["id", "name"], limit: 1 });
    if (found.length) { already.push(found[0].name); continue; }
    const lineSnap = snap.get("lineId") ? await lines.doc(snap.get("lineId")).get() : null;
    const name = floorMapLib.odooEquipmentName({ id, name: snap.get("name") }, lineSnap?.exists ? lineSnap.get("name") : "");
    await odoo.odooCall(key, "maintenance.equipment", "create", { vals_list: [{ name, maintenance_team_id: refs.teamId }] });
    created.push(name);
  }
  if (created.length) await auditLog.add({ type: "created", kind: "odoo equipment", recordId: ids.join(","), by: adminNumber, at: FieldValue.serverTimestamp(), created });
  return { created, already, skipped };
});

// ---------------------------------------------------------------------------
// Training (the training team's trainer app, in CDG Ops) — see training-api.js.
// ---------------------------------------------------------------------------

Object.assign(exports, trainingApi({ db, auditLog, requireMember, requireAdmin, isTest, col, requireDocEditor, saveLoadRevision, keepHistory, keepHistoryNow, historyLib }));

// ---------------------------------------------------------------------------
// Downtime & Scrap shift report (Chris, 10-22-2026). Rules in downtime.js. Line Leads and Supervisors enter each
// changeover, downtime event, and partial reel / scrap as it happens; the report is signed with a PIN. Read and
// written only through these functions (no database rules needed). Test site: test_shiftReports /
// test_downtimeEvents / test_scrapEntries. Flagged reels decided Scrap or Regrind are read in live (counted once).
// The workbook on SharePoint is not connected yet — entries wait in the app and Export to Excel gives the rows.
// ---------------------------------------------------------------------------

const SHIFT_REPORT_DAYS = 7; // recent reports a lead can reopen (an unsigned one from last shift, say)

function requireEnter(me) {
  if (!downtimeLib.canEnter(me.roles)) throw new HttpsError("permission-denied", "Only Line Leads, Supervisors, the Production Manager, and Admins use the shift report.");
}

// The shift a moment belongs to: { shift, date, startMs, endMs } (night shifts belong to the day they start).
async function shiftAt(ms) {
  const form = await formTemplates.doc(formsLib.SHIFT_FORM).get();
  return formsLib.currentShift(form.get("shifts") || [], ms);
}

// The rotation's team name for a shift ("A"…), or null on a day with no team (Saturday).
async function rotationTeamName(shiftNow) {
  const rot = await rotationDoc.get();
  const teamId = rotationLib.teamOnShift(rot.get("teams") || [], shiftNow);
  if (!teamId) return null;
  const t = await teams.doc(teamId).get();
  return t.exists ? t.get("name") || null : null;
}

// Flagged reels from one report's line and shift that were decided Scrap or Regrind, as scrap entries.
async function reelScrapsFor(test, report) {
  const next = new Date(Date.parse(`${report.date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const snaps = await col("reels", test).where("flaggedDate", "in", [report.date, next]).get();
  return snaps.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.lineId === report.lineId && r.flaggedAtMs >= report.startMs && r.flaggedAtMs < report.endMs)
    .map(downtimeLib.reelScrap).filter(Boolean)
    .map((s) => ({ ...s, id: `reel-${s.reelId}`, team: report.team }));
}

// The team picked on Who's here today for this shift (name), or null.
async function crewTeamName(test) {
  const s = await crewShift(test);
  if (!s?.teamId) return null;
  const t = await teams.doc(s.teamId).get();
  return t.exists ? t.get("name") || null : null;
}

// A report as saved, or a fresh one for the current shift on that line (not saved until something is entered).
async function loadShiftReport(test, { lineId, reportId }) {
  if (reportId) {
    const snap = await col("shiftReports", test).doc(String(reportId)).get();
    if (!snap.exists) throw new HttpsError("not-found", "That shift report isn't here.");
    return { id: snap.id, saved: true, ...snap.data() };
  }
  const line = lineId ? await lines.doc(String(lineId)).get() : null;
  if (!line?.exists || line.get("active") === false) throw new HttpsError("invalid-argument", "Pick the line.");
  const now = await shiftAt(Date.now());
  if (!now) throw new HttpsError("failed-precondition", "No shift is running right now (Admin → Forms sets the shift times).");
  const id = downtimeLib.reportId(line.id, now.date, now.shift.id);
  const snap = await col("shiftReports", test).doc(id).get();
  if (snap.exists) return { id, saved: true, ...snap.data() };
  // The rotation's team; on a day with none (Saturday), the team picked on Who's here today (Chris, 10-23-2026 —
  // Sat A / Sat B dropped). needTeamPick: neither yet, so the lead picks it on Who's here today first.
  const team = (await rotationTeamName(now)) || (await crewTeamName(test));
  return {
    id, saved: false, lineId: line.id, lineName: line.get("name"), lineNumber: downtimeLib.lineNumber(line.get("name")),
    date: now.date, shiftId: now.shift.id, shiftName: now.shift.name || now.shift.id, startMs: now.startMs, endMs: now.endMs,
    team: team || "", needTeamPick: !team, size: "", sdr: "", productSize: "", changeover: null, comments: "", signed: null,
  };
}

async function shiftReportView(test, report) {
  const [changeovers, events, scraps, reelScraps, openOnLine] = await Promise.all([
    col("changeoverEvents", test).where("reportId", "==", report.id).get(),
    col("downtimeEvents", test).where("reportId", "==", report.id).get(),
    col("scrapEntries", test).where("reportId", "==", report.id).get(),
    report.signed?.reelScraps ? report.signed.reelScraps : reelScrapsFor(test, report), // frozen once signed (Decision 108)
    col("issues", test).where("open", "==", true).get(),
  ]);
  const lineMachines = new Set((await machines.where("lineId", "==", report.lineId).get()).docs.map((d) => d.id));
  const byTime = (a, b) => (a.atMs || 0) - (b.atMs || 0);
  return {
    report,
    changeovers: downtimeLib.changeoverList(report, changeovers.docs.map((d) => ({ id: d.id, ...d.data() }))),
    events: events.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byTime)
      .map((e) => ({ ...e, contacted: downtimeLib.someoneContacted(e), maintLog: downtimeLib.maintenanceLog(e) })),
    scraps: [...scraps.docs.map((d) => ({ id: d.id, source: "entry", ...d.data() })).sort(byTime), ...reelScraps],
    issues: openOnLine.docs.filter((d) => lineMachines.has(d.get("machineId")))
      .map((d) => ({ id: d.id, odooId: d.get("odooId") || null, title: String(d.get("title") || "").slice(0, 160), machineId: d.get("machineId") })),
  };
}

// Line Leads, Supervisors, Production Manager, Admins: { lineId } (this shift) or { reportId } → the report, its
// entries (with the workbook's Yes / No / Not Needed answers), open Maintenance Requests on the line, the lists, and
// the line's reports from the last week.
exports.shiftReport = onCall(async (req) => {
  const me = await requireMember(req);
  requireEnter(me);
  const test = isTest(req);
  const report = await loadShiftReport(test, req.data || {});
  const [view, settings, recentSnaps] = await Promise.all([
    shiftReportView(test, report), reelSettings(),
    col("shiftReports", test).where("date", ">=", new Date(Date.now() - SHIFT_REPORT_DAYS * 86400000).toISOString().slice(0, 10)).get(),
  ]);
  return {
    ...view, test,
    canSign: downtimeLib.canSign(me.roles),
    lists: { changeoverTypes: downtimeLib.CHANGEOVER_TYPES, downtimeReasons: downtimeLib.DOWNTIME_REASONS, scrapReasons: downtimeLib.SCRAP_REASONS, sizes: settings.sizes, sdrs: settings.sdrs },
    recent: recentSnaps.docs.filter((d) => d.get("lineId") === report.lineId && d.id !== report.id)
      .map((d) => ({ id: d.id, date: d.get("date"), shiftName: d.get("shiftName"), team: d.get("team"), signed: !!d.get("signed"), verified: !!d.get("verified") }))
      .sort((a, b) => (a.id < b.id ? 1 : -1)),
  };
});

// The report's header: { lineId | reportId, size, sdr, changeover? ({ minutes, type } or null),
// comments? }. Creates the report the first time. Not after it's signed.
exports.saveShiftReport = onCall(async (req) => {
  const me = await requireMember(req);
  requireEnter(me);
  const test = isTest(req);
  const report = await loadShiftReport(test, req.data || {});
  if (report.signed) throw new HttpsError("failed-precondition", "This shift report is signed — it can't be changed.");
  const product = downtimeLib.cleanProduct(req.data);
  if (product.error) throw new HttpsError("invalid-argument", product.error);
  if (report.needTeamPick) throw new HttpsError("failed-precondition", "No team in the rotation today — pick the team that's working on Who's here today first.");
  const team = report.team;
  let changeover = report.changeover || null;
  if (req.data?.changeover === null) changeover = null;
  else if (req.data?.changeover !== undefined) {
    const c = downtimeLib.cleanChangeover(req.data.changeover);
    if (c.error) throw new HttpsError("invalid-argument", c.error);
    changeover = { ...c.changeover, productSize: product.productSize, by: me.employeeNumber, byName: me.name, atMs: Date.now() };
  }
  const comments = req.data?.comments === undefined ? report.comments || "" : String(req.data.comments || "").replace(/\r\n/g, "\n").trim().slice(0, 2000);
  const { id, saved, needTeamPick, ...fields } = report;
  const ref = col("shiftReports", test).doc(id);
  await db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    if (cur.exists && cur.get("signed")) throw new HttpsError("failed-precondition", "This shift report was just signed.");
    if (cur.exists) keepHistory(tx, ref, cur.data(), { team, size: product.size, sdr: product.sdr, productSize: product.productSize, changeover, comments }, me.employeeNumber, { byName: me.name, test });
    tx.set(ref, {
      ...fields, team, size: product.size, sdr: product.sdr, productSize: product.productSize, changeover, comments,
      updatedAtMs: Date.now(), updatedBy: me.employeeNumber, ...(cur.exists ? {} : { createdAtMs: Date.now(), createdBy: me.employeeNumber }),
      ...(test ? { test: true } : {}),
    }, { merge: true });
    auditRecord(tx, cur.exists ? "updated" : "started", "shift report", id, me.employeeNumber, { test });
  });
  return { id };
});

// One entry: { reportId, kind: "changeover" | "downtime" | "scrap", id? (edit), remove?: true, ...fields }. Copies the report's date,
// line, team, and current product size. Not after the report is signed.
exports.saveShiftEntry = onCall(async (req) => {
  const me = await requireMember(req);
  requireEnter(me);
  const test = isTest(req);
  const ENTRY = { changeover: ["changeoverEvents", downtimeLib.cleanChangeover], downtime: ["downtimeEvents", downtimeLib.cleanDowntime], scrap: ["scrapEntries", downtimeLib.cleanScrap] };
  const kind = Object.prototype.hasOwnProperty.call(ENTRY, req.data?.kind) ? req.data.kind : null;
  if (!kind) throw new HttpsError("invalid-argument", "Changeover, downtime, or scrap?");
  const reportRef = col("shiftReports", test).doc(String(req.data?.reportId || "x"));
  const entries = col(ENTRY[kind][0], test);
  let fields = null;
  if (req.data?.remove !== true) {
    const out = ENTRY[kind][1](req.data);
    if (out.error) throw new HttpsError("invalid-argument", out.error);
    fields = out.changeover || out.event || out.scrap;
    if (fields.issueId) {
      const issue = await col("issues", test).doc(fields.issueId).get();
      if (!issue.exists) throw new HttpsError("not-found", "That Maintenance Request isn't here any more — pick it again.");
      fields.issueTitle = `${issue.get("odooId") ? `#${issue.get("odooId")} ` : ""}${String(issue.get("title") || "").slice(0, 120)}`;
      if (kind === "downtime" && !fields.machineId && issue.get("machineId")) fields.machineId = issue.get("machineId"); // the request's machine
    }
  }
  return db.runTransaction(async (tx) => {
    const report = await tx.get(reportRef);
    if (!report.exists) throw new HttpsError("failed-precondition", "Save the product size first.");
    if (report.get("signed")) throw new HttpsError("failed-precondition", "This shift report is signed — it can't be changed.");
    if (fields?.machineId) {
      const m = await tx.get(machines.doc(fields.machineId));
      if (!m.exists || m.get("lineId") !== report.get("lineId")) throw new HttpsError("invalid-argument", "Pick a machine on this line.");
      fields.machineName = m.get("name") || "";
    }
    const ref = req.data?.id ? entries.doc(String(req.data.id)) : entries.doc();
    let cur = null;
    if (req.data?.id) {
      cur = await tx.get(ref);
      if (!cur.exists || cur.get("reportId") !== reportRef.id) throw new HttpsError("not-found", "That entry isn't on this report any more.");
    }
    if (!fields) {
      keepHistory(tx, ref, cur.data(), null, me.employeeNumber, { byName: me.name, test, action: "delete" });
      tx.delete(ref);
      auditRecord(tx, "removed", `shift ${kind}`, ref.id, me.employeeNumber, { reportId: reportRef.id, test });
      return { id: ref.id, removed: true };
    }
    const r = report.data();
    if (cur) keepHistory(tx, ref, cur.data(), fields, me.employeeNumber, { byName: me.name, test });
    tx.set(ref, {
      ...fields, reportId: reportRef.id, date: r.date, lineId: r.lineId, lineNumber: r.lineNumber, shiftId: r.shiftId, team: r.team,
      // The person who added it stays the author; an edit records who changed it (Decision 120).
      ...(cur ? { updatedBy: me.employeeNumber, updatedByName: me.name } : { productSize: r.productSize, atMs: Date.now(), by: me.employeeNumber, byName: me.name }), updatedAtMs: Date.now(),
      ...(test ? { test: true } : {}),
    }, { merge: true });
    // An entry added after "None this shift" was tapped: it isn't none any more.
    if (r.none?.[kind]) tx.update(reportRef, { [`none.${kind}`]: FieldValue.delete() });
    auditRecord(tx, req.data?.id ? "updated" : "added", `shift ${kind}`, ref.id, me.employeeNumber, { reportId: reportRef.id, test });
    return { id: ref.id };
  });
});

// Line Lead / Supervisor / Production Manager, with their PIN: { reportId, comments?, signer, device }.
exports.signShiftReport = onCall(signable(async (req) => {
  const me = await requireMember(req);
  requireEnter(me);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  if (!downtimeLib.canSign(signer.roles)) throw new HttpsError("permission-denied", `${signer.name} can't sign shift reports — a Line Lead or Supervisor signs.`);
  const device = annLib.cleanDevice(req.data?.device);
  const ref = col("shiftReports", test).doc(String(req.data?.reportId || "x"));
  const first = await ref.get();
  const reelList = first.exists ? await reelScrapsFor(test, { id: first.id, ...first.data() }) : [];
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("failed-precondition", "Save the product size first.");
    if (snap.get("signed")) throw new HttpsError("failed-precondition", `Already signed by ${snap.get("signed").byName}.`);
    const [events, scraps, changeovers] = await Promise.all([
      tx.get(col("downtimeEvents", test).where("reportId", "==", ref.id)),
      tx.get(col("scrapEntries", test).where("reportId", "==", ref.id)),
      tx.get(col("changeoverEvents", test).where("reportId", "==", ref.id)),
    ]);
    const notReady = downtimeLib.notReadyToSign(snap.data(), { downtime: events.size, scrap: scraps.size + reelList.length });
    if (notReady) throw new HttpsError("failed-precondition", notReady);
    const comments = req.data?.comments === undefined ? snap.get("comments") || "" : String(req.data.comments || "").replace(/\r\n/g, "\n").trim().slice(0, 2000);
    // Decision 108: the flagged-reel scrap is frozen into the report as signed (a reel decided later doesn't change it),
    // and the version is a fingerprint of everything on it.
    const r = snap.data();
    const rows = (q) => q.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.id < b.id ? -1 : 1));
    const version = signoffsLib.contentVersion({ productSize: r.productSize, changeover: r.changeover, none: r.none || {}, comments, events: rows(events), scraps: rows(scraps), changeovers: rows(changeovers), reelScraps: reelList });
    tx.update(ref, { comments, signed: { by: signer.employeeNumber, byName: signer.name, atMs: Date.now(), device, version, reelScraps: reelList } });
    logSignoff(tx, test, { kind: "shift-report", refId: ref.id, version, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
    auditRecord(tx, "signed", "shift report", ref.id, signer.employeeNumber, { test });
    return { ok: true, name: signer.name };
  });
}));

// "None this shift" for downtime or scrap: { reportId, kind: "downtime" | "scrap", none: true | false }. Only while the
// section has no entries (flagged reels count as scrap). Not after the report is signed.
exports.markShiftNone = onCall(async (req) => {
  const me = await requireMember(req);
  requireEnter(me);
  const test = isTest(req);
  const kind = req.data?.kind === "downtime" || req.data?.kind === "scrap" ? req.data.kind : null;
  if (!kind) throw new HttpsError("invalid-argument", "Downtime or scrap?");
  const ref = col("shiftReports", test).doc(String(req.data?.reportId || "x"));
  const first = await ref.get();
  if (!first.exists) throw new HttpsError("failed-precondition", "Save the product size first.");
  const reelScraps = kind === "scrap" ? (await reelScrapsFor(test, { id: first.id, ...first.data() })).length : 0;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get("signed")) throw new HttpsError("failed-precondition", "This shift report is signed — it can't be changed.");
    if (req.data?.none === true) {
      const entries = await tx.get(col(kind === "downtime" ? "downtimeEvents" : "scrapEntries", test).where("reportId", "==", ref.id));
      if (entries.size + reelScraps) throw new HttpsError("failed-precondition", `There's ${kind} on this report already — remove it first, or leave it.`);
      tx.update(ref, { [`none.${kind}`]: { by: me.employeeNumber, byName: me.name, atMs: Date.now() }, updatedAtMs: Date.now() });
    } else {
      tx.update(ref, { [`none.${kind}`]: FieldValue.delete(), updatedAtMs: Date.now() });
    }
    auditRecord(tx, req.data?.none === true ? "none" : "undo none", `shift ${kind}`, ref.id, me.employeeNumber, { test });
  });
  return { ok: true };
});

// Verified (the second step, verify.js) once the report is signed: { reportId, signer: { emp, pin }, device }. A
// Supervisor — or, with no Supervisor on shift, the Production Manager or a Line Lead. Not the person who signed it.
exports.verifyShiftReport = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const ref = col("shiftReports", test).doc(String(req.data?.reportId || "x"));
  const supervisorOnShift = await supervisorOnShiftNow(test);
  const w = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That shift report isn't here.");
    const r = snap.data();
    if (!r.signed) throw new HttpsError("failed-precondition", "It isn't signed yet.");
    if (r.verified) throw new HttpsError("failed-precondition", `Already verified by ${r.verified.name}.`);
    const who = requireVerifier(signer, supervisorOnShift, [r.signed.by]);
    tx.update(ref, { verified: verifyStamp(signer, who, device) });
    logSignoff(tx, test, { kind: "shift-report-verify", refId: ref.id, version: r.signed.version || signoffsLib.contentVersion(r), emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber, role: who.role, backup: who.backup });
    return who;
  });
  return { ok: true, name: signer.name, role: w.roleName, backup: w.backup, test };
}));

// Who can verify on this device's sheet (line tablets): { reportId } -> who may verify right now, with a login.
exports.shiftReportVerifiers = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const snap = await col("shiftReports", test).doc(String(req.data?.reportId || "x")).get();
  if (!snap.exists) throw new HttpsError("not-found", "That shift report isn't here.");
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled && p.id !== me.employeeNumber);
  const list = verifyLib.verifiers(people, { supervisorOnShift: await supervisorOnShiftNow(test), doers: [snap.get("signed")?.by].filter(Boolean) });
  return { people: list.map((p) => ({ emp: p.id, name: p.name })) };
});

// Supervisors, Production Manager, Admins: { from, to } ("YYYY-MM-DD", up to 92 days) → the workbook rows for
// each tab (Changeover Log, Downtime Log, Scrap Log), data columns only — for Export to Excel until SharePoint is
// connected. Includes flagged reels decided Scrap or Regrind.
exports.exportShiftReports = onCall(async (req) => {
  const me = await requireMember(req);
  if (!me.roles.some((r) => ["supervisor", "plant-manager", "admin"].includes(r))) throw new HttpsError("permission-denied", "Supervisors, the Production Manager, and Admins export.");
  const test = isTest(req);
  const day = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = day(req.data?.from), to = day(req.data?.to);
  if (!from || !to || from > to || Date.parse(to) - Date.parse(from) > 92 * 86400000) throw new HttpsError("invalid-argument", "Pick a date range of up to 92 days.");
  const inRange = (c) => col(c, test).where("date", ">=", from).where("date", "<=", to).get();
  const [reports, changeovers, events, scraps, reels, lineSnaps, form] = await Promise.all([
    inRange("shiftReports"), inRange("changeoverEvents"), inRange("downtimeEvents"), inRange("scrapEntries"),
    col("reels", test).where("flaggedAtMs", ">=", Date.parse(`${from}T00:00:00Z`) - 86400000).get(),
    lines.get(), formTemplates.doc(formsLib.SHIFT_FORM).get(),
  ]);
  const byReport = new Map(reports.docs.map((d) => [d.id, { id: d.id, ...d.data(), changeovers: [], events: [], scraps: [] }]));
  const lineName = new Map(lineSnaps.docs.map((d) => [d.id, d.get("name")]));
  const reportFor = (id, x) => {
    if (!byReport.has(id)) byReport.set(id, { id, date: x.date, lineId: x.lineId, lineNumber: x.lineNumber || downtimeLib.lineNumber(lineName.get(x.lineId)), team: x.team || "", productSize: "", changeover: null, changeovers: [], events: [], scraps: [] });
    return byReport.get(id);
  };
  for (const d of changeovers.docs) reportFor(d.get("reportId"), d.data()).changeovers.push(d.data());
  for (const d of events.docs) reportFor(d.get("reportId"), d.data()).events.push(d.data());
  for (const d of scraps.docs) reportFor(d.get("reportId"), d.data()).scraps.push(d.data());
  const shifts = form.get("shifts") || [];
  for (const d of reels.docs) {
    const reel = { id: d.id, ...d.data() };
    const s = downtimeLib.reelScrap(reel);
    const at = formsLib.currentShift(shifts, reel.flaggedAtMs);
    if (!s || !at || at.date < from || at.date > to) continue;
    const rid = downtimeLib.reportId(reel.lineId, at.date, at.shift.id);
    if (byReport.get(rid)?.signed?.reelScraps) continue; // signed: the frozen list below, not today's reels
    reportFor(rid, { date: at.date, lineId: reel.lineId }).scraps.push(s);
  }
  for (const r of byReport.values()) if (r.signed?.reelScraps) r.scraps.push(...r.signed.reelScraps);
  const out = { changeover: [], downtime: [], scrap: [] };
  for (const r of [...byReport.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const rows = downtimeLib.sheetRows(r, r.events.sort((a, b) => a.atMs - b.atMs), r.scraps, r.changeovers);
    for (const k of Object.keys(out)) out[k].push(...rows[k]);
  }
  await auditLog.add({ type: "exported", kind: "shift reports", recordId: `${from}..${to}`, by: me.employeeNumber, at: FieldValue.serverTimestamp(), test });
  return { headers: downtimeLib.SHEET_HEADERS, rows: out, from, to, test };
});

// Departments + reports to (Chris, 10-22-2026; launch list 1). Rules in departments.js. Set on Admin → People;
// departments are a list in Admin → Departments (meta/departments). Read only through these functions: everyone sees
// the org chart (names and titles only) and who they report to; admins see and change the rest.
// ---------------------------------------------------------------------------

const departmentsDoc = db.collection("meta").doc("departments");

async function orgData() {
  const [deptSnap, empSnaps, roleSnaps] = await Promise.all([departmentsDoc.get(), employees.get(), roles.get()]);
  const departments = deptSnap.get("departments") || deptLib.startingDepartments();
  const headsReportTo = deptSnap.get("headsReportTo") || null;
  const roleName = new Map(roleSnaps.docs.map((d) => [d.id, d.get("name")]));
  const people = empSnaps.docs.map((d) => ({
    id: d.id, name: d.get("name") || `Employee ${d.id}`, roles: d.get("roles") || [], team: d.get("team") || null,
    active: d.get("active") !== false, position: d.get("position") || "",
    department: d.get("department") || null, deptHead: d.get("deptHead") === true, reportsTo: d.get("reportsTo") || null,
    supervisesTeams: d.get("supervisesTeams") || [], canPost: d.get("canPost") === true,
  }));
  const reports = deptLib.reportsToAll(people, { headsReportTo });
  // A title: the position, else the role names (Admin only when it's the only role).
  const title = (x) => x.position || x.roles.filter((r) => r !== "admin").map((r) => roleName.get(r) || r).join(", ") || (x.roles.includes("admin") ? "Admin" : "");
  const headIds = new Map(departments.map((dep) => [dep.id, deptLib.headOf(dep.id, people)?.id || null]));
  return { departments, headsReportTo, people, reports, title, headIds };
}

// Anyone signed in: the org chart — names and titles only — and who I report to.
exports.orgChart = onCall(async (req) => {
  const me = await requireMember(req);
  const o = await orgData();
  const name = new Map(o.people.map((x) => [x.id, x.name]));
  const on = o.people.filter((x) => x.active && !deptLib.isPracticeAccount(x.name)); // practice accounts stay off the chart
  return {
    departments: o.departments.filter((dep) => dep.active !== false).map((dep) => ({ id: dep.id, name: dep.name, head: o.headIds.get(dep.id) })),
    people: on.map((x) => ({ emp: x.id, name: x.name, title: o.title(x), department: x.department, head: !!x.department && o.headIds.get(x.department) === x.id, reportsTo: o.reports.get(x.id)?.reportsTo || null }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    me: { emp: me.employeeNumber, reportsTo: o.reports.get(me.employeeNumber)?.reportsTo || null, reportsToName: name.get(o.reports.get(me.employeeNumber)?.reportsTo) || null, top: o.reports.get(me.employeeNumber)?.source === "top" },
  };
});

// Admins: everyone's department, head, override, suggested department, and who they report to (and why).
exports.adminOrg = onCall(async (req) => {
  await requireAdmin(req);
  const o = await orgData();
  return {
    departments: o.departments, headsReportTo: o.headsReportTo,
    noHead: deptLib.departmentsWithoutHead(o.people, o.departments),
    people: o.people.map((x) => ({
      emp: x.id, department: x.department, suggested: deptLib.suggestDepartment(x.roles, o.departments), deptHead: x.deptHead,
      isHead: !!x.department && o.headIds.get(x.department) === x.id, override: x.reportsTo, supervisesTeams: x.supervisesTeams, canPost: x.canPost,
      reportsTo: o.reports.get(x.id)?.reportsTo || null, source: o.reports.get(x.id)?.source || "missing",
    })),
  };
});

// Admins: { emp, department, head, reportsTo (employee #, "none" = top, or null = automatic), supervisesTeams, replace? }. One head per department:
// ticking a second one is refused with the current head unless replace is true (then the old head is unticked).
exports.adminSaveOrg = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const emp = String(req.data?.emp || "");
  const out = await db.runTransaction(async (tx) => {
    const [deptSnap, all, teamSnaps] = await Promise.all([tx.get(departmentsDoc), tx.get(employees), tx.get(teams)]);
    const departments = deptSnap.get("departments") || deptLib.startingDepartments();
    const people = all.docs.map((d) => ({ id: d.id, name: d.get("name"), active: d.get("active") !== false, department: d.get("department") || null, deptHead: d.get("deptHead") === true }));
    if (!people.some((x) => x.id === emp)) throw new HttpsError("not-found", "That person isn't in the app.");
    const { org, error } = deptLib.cleanOrg(req.data, { departments, people, emp, teamIds: teamSnaps.docs.map((t) => t.id) });
    if (error) throw new HttpsError("invalid-argument", error);
    const current = org.head ? people.find((x) => x.id !== emp && x.active && x.department === org.department && x.deptHead) : null;
    if (current && req.data?.replace !== true) {
      const deptName = departments.find((dep) => dep.id === org.department)?.name || org.department;
      throw new HttpsError("already-exists", `${current.name} is the ${deptName} head. Replace ${current.name}?`, { currentHead: { emp: current.id, name: current.name } });
    }
    const stamp = { updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber };
    if (current) {
      keepHistory(tx, employees.doc(current.id), { deptHead: true }, { deptHead: false }, adminNumber);
      tx.update(employees.doc(current.id), { deptHead: false, ...stamp });
    }
    const orgChange = { department: org.department, deptHead: org.head, reportsTo: org.reportsTo || FieldValue.delete(), supervisesTeams: org.supervisesTeams, canPost: org.canPost };
    keepHistory(tx, employees.doc(emp), all.docs.find((d) => d.id === emp).data(), orgChange, adminNumber);
    tx.update(employees.doc(emp), { ...orgChange, ...stamp });
    auditRecord(tx, "updated", "department", emp, adminNumber, { department: org.department, head: org.head, reportsTo: org.reportsTo, supervisesTeams: org.supervisesTeams, canPost: org.canPost, replaced: current?.id || null });
    return { ok: true, replaced: current ? current.name : null };
  });
  // Teams a Supervisor covers can change who a "those roles on Team B" announcement reaches (keep for new hires).
  await refreshAnnouncementLists();
  return out;
});

// Admins: { departments: [{ id?, name, active }], headsReportTo: employee # or null } — Admin → Departments.
exports.adminSaveDepartments = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const { departments, error } = deptLib.cleanDepartments(req.data?.departments);
  if (error) throw new HttpsError("invalid-argument", error);
  const to = req.data?.headsReportTo ? String(req.data.headsReportTo) : null;
  if (to) {
    const snap = await employees.doc(to).get();
    if (!snap.exists || snap.get("active") === false) throw new HttpsError("invalid-argument", "Pick who department heads report to from the list.");
  }
  await keepHistoryNow(departmentsDoc, { departments, headsReportTo: to }, adminNumber);
  await departmentsDoc.set({ departments, headsReportTo: to, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber });
  await auditLog.add({ type: "updated", kind: "departments", recordId: "departments", by: adminNumber, at: FieldValue.serverTimestamp(), departments: departments.map((dep) => dep.name), headsReportTo: to });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Crew Board, step 1 — Who's here today (Chris, 10-21-2026, Decision 69; launch list 2). Rules in crew.js. Read and
// written only through these functions (no database rules), so Out reasons stay with Supervisors, the Production
// Manager, and Admins. Test site: test_attendance.
// ---------------------------------------------------------------------------

// This shift's attendance: { now, ref, saved, teamId, rotationTeam } — or null when no shift is running. The team is
// the one saved on the record, else the rotation's; on a day with no team (Saturday) the lead picks it.
async function crewShift(test) {
  const now = await shiftAt(Date.now());
  if (!now) return null;
  const ref = col("attendance", test).doc(crewLib.docId(now.date, now.shift.id));
  const [snap, rot] = await Promise.all([ref.get(), rotationDoc.get()]);
  const rotTeam = rotationLib.teamOnShift(rot.get("teams") || [], now);
  const saved = snap.exists ? snap.data() : null;
  return { now, ref, saved, teamId: saved?.teamId || rotTeam || null, rotationTeam: !!rotTeam };
}

// The whole record, ready to write (set, not merge, so cleared marks really go).
function crewRecord(s, saved, { teamId, teamName, added, marks, by, test }) {
  return {
    ...(saved || { createdAtMs: Date.now() }),
    date: s.now.date, shiftId: s.now.shift.id, shiftName: s.now.shift.name || s.now.shift.id, startMs: s.now.startMs, endMs: s.now.endMs,
    teamId, teamName, added, marks, updatedAtMs: Date.now(), updatedBy: by, ...(test ? { test: true } : {}),
  };
}

const crewListFor = (people, teamId, added, test) => crewLib.crewList(people, { teamId, added, test, isPractice: deptLib.isPracticeAccount });

function requireCrewMarker(me) {
  if (!crewLib.canMark(me.roles)) throw new HttpsError("permission-denied", "Line Leads, Supervisors, the Production Manager, and Admins mark who's here.");
}

// Anyone signed in: this shift's crew, Here / Out / not marked yet. Out reasons only for Supervisors, the Production
// Manager, and Admins. forMe: a Line Lead or Supervisor whose team is on (any of them on a day with no team yet).
exports.crewToday = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const s = await crewShift(test);
  if (!s) return { noShift: true, test };
  const [people, teamSnaps] = await Promise.all([peopleList(), teams.get()]);
  const teamList = teamSnaps.docs.filter((d) => d.get("active") !== false).map((d) => ({ id: d.id, name: d.get("name") || d.id }));
  const teamName = (id) => teamSnaps.docs.find((d) => d.id === id)?.get("name") || id;
  const marks = s.saved?.marks || {};
  const list = crewListFor(people, s.teamId, s.saved?.added || [], test);
  const mark = crewLib.canMark(me.roles);
  const myself = people.find((p) => p.id === me.employeeNumber) || {};
  const leadRoles = me.roles.filter((r) => r === "lead" || r === "supervisor");
  const onCrew = new Set(list.map((p) => p.id));
  return {
    test,
    shift: { date: s.now.date, shiftId: s.now.shift.id, shiftName: s.now.shift.name || s.now.shift.id, startMs: s.now.startMs, endMs: s.now.endMs, dueMs: crewLib.dueMs(s.now.startMs) },
    team: s.teamId ? { id: s.teamId, name: teamName(s.teamId) } : null,
    canMark: mark, canPickTeam: mark && !s.rotationTeam, canSeeReasons: crewLib.canSeeReasons(me.roles),
    forMe: leadRoles.length > 0 && (!s.teamId || leadRoles.some((r) => deptLib.covers(myself, s.teamId, r))),
    reasons: crewLib.OUT_REASONS,
    teams: mark ? teamList : [],
    people: crewLib.crewView(list, marks, { reasons: crewLib.canSeeReasons(me.roles) }),
    counts: crewLib.counts(list, marks),
    others: mark ? people.filter((p) => p.active && !onCrew.has(p.id) && (test || !deptLib.isPracticeAccount(p.name)))
      .map((p) => ({ emp: p.id, name: p.name, team: p.team ? teamName(p.team) : "" })).sort((a, b) => a.name.localeCompare(b.name)) : [],
    ...(s.teamId ? crewBoardFor(await crewBoardView(test, s, people, list), mark, me.employeeNumber) : { stations: null }),
  };
});

// Training levels and level notes are for the people who seat the crew; everyone else sees only their own.
function crewBoardFor(view, mark, emp) {
  if (mark || !view.stations) return view;
  const st = view.stations;
  return { stations: { ...st, levels: st.levels[emp] ? { [emp]: st.levels[emp] } : {}, fits: st.fits[emp] ? { [emp]: st.fits[emp] } : {} } };
}

// Line Leads, Supervisors, Production Manager, Admins: { emp, status: "here" | "out" | null, reason (Out) } or
// { all: true } (everyone not marked yet → Here).
exports.crewMark = onCall(async (req) => {
  const me = await requireMember(req);
  requireCrewMarker(me);
  const test = isTest(req);
  const all = req.data?.all === true;
  const { mark, error } = all ? { mark: { status: "here" } } : crewLib.cleanMark(req.data);
  if (error) throw new HttpsError("invalid-argument", error);
  const s = await crewShift(test);
  if (!s) throw new HttpsError("failed-precondition", "No shift is running right now (Admin → Forms sets the shift times).");
  if (!s.teamId) throw new HttpsError("failed-precondition", "Pick the team that's working first.");
  const [people, team] = await Promise.all([peopleList(), teams.doc(s.teamId).get()]);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(s.ref);
    const saved = snap.exists ? snap.data() : null;
    const added = saved?.added || [];
    const list = crewListFor(people, s.teamId, added, test);
    const marks = { ...(saved?.marks || {}) };
    const stamp = { by: me.employeeNumber, byName: me.name, atMs: Date.now() };
    let changed;
    if (all) {
      changed = list.filter((p) => !marks[p.id]).map((p) => p.id);
      for (const id of changed) marks[id] = { status: "here", ...stamp };
    } else {
      const emp = String(req.data?.emp || "");
      if (!list.some((p) => p.id === emp)) throw new HttpsError("not-found", "That person isn't on this shift's crew.");
      if (mark) marks[emp] = { ...mark, ...stamp };
      else delete marks[emp];
      changed = [emp];
    }
    // Marked Out: off any station seat (Crew Board step 2).
    const seats = { ...(saved?.seats || {}) };
    for (const [k, v] of Object.entries(seats)) if (marks[v]?.status !== "here") delete seats[k];
    if (saved) keepHistory(tx, s.ref, saved, { ...historyLib.spread("marks", saved.marks, marks), ...historyLib.spread("seats", saved.seats, seats) }, me.employeeNumber, { byName: me.name, test });
    tx.set(s.ref, { ...crewRecord(s, saved, { teamId: s.teamId, teamName: team.get("name") || s.teamId, added, marks, by: me.employeeNumber, test }), seats });
    auditRecord(tx, "marked", "attendance", s.ref.id, me.employeeNumber, { emps: changed, status: mark?.status || null, test });
    return { ok: true, count: changed.length, counts: crewLib.counts(list, marks) };
  });
});

// Line Leads, Supervisors, Production Manager, Admins: { teamId } (only on a day the rotation has no team),
// { add: emp } (covering from another team), or { remove: emp } (someone added by mistake; their mark goes too).
exports.crewSetup = onCall(async (req) => {
  const me = await requireMember(req);
  requireCrewMarker(me);
  const test = isTest(req);
  const s = await crewShift(test);
  if (!s) throw new HttpsError("failed-precondition", "No shift is running right now (Admin → Forms sets the shift times).");
  let teamId = s.teamId;
  if (req.data?.teamId !== undefined) {
    if (s.rotationTeam) throw new HttpsError("failed-precondition", "The shift rotation sets today's team (Admin → Shift rotation).");
    teamId = String(req.data.teamId || "");
  }
  if (!teamId) throw new HttpsError("failed-precondition", "Pick the team that's working first.");
  const [people, team] = await Promise.all([peopleList(), teams.doc(teamId).get()]);
  if (!team.exists || team.get("active") === false) throw new HttpsError("invalid-argument", "Pick a team from the list.");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(s.ref);
    const saved = snap.exists ? snap.data() : null;
    let added = [...(saved?.added || [])];
    const marks = { ...(saved?.marks || {}) };
    const add = req.data?.add ? String(req.data.add) : null;
    const remove = req.data?.remove ? String(req.data.remove) : null;
    if (add) {
      const p = people.find((x) => x.id === add && x.active);
      if (!p) throw new HttpsError("not-found", "That person isn't in the app.");
      if (crewListFor(people, teamId, added, test).some((x) => x.id === add)) throw new HttpsError("already-exists", `${p.name} is already on the crew.`);
      added.push(add);
    }
    if (remove) {
      if (!added.includes(remove)) throw new HttpsError("failed-precondition", "Only people added to this shift can be taken off. Admin → People sets each person's team.");
      added = added.filter((x) => x !== remove);
      delete marks[remove];
      if (saved?.seats) for (const [k, v] of Object.entries(saved.seats)) if (v === remove) delete saved.seats[k]; // off their station too
    }
    if (saved) keepHistory(tx, s.ref, saved, { teamId, added, ...historyLib.spread("marks", saved.marks, marks) }, me.employeeNumber, { byName: me.name, test });
    tx.set(s.ref, crewRecord(s, saved, { teamId, teamName: team.get("name") || teamId, added, marks, by: me.employeeNumber, test }));
    auditRecord(tx, "updated", "attendance", s.ref.id, me.employeeNumber, { teamId, add, remove, test });
    return { ok: true };
  });
});

// ---------------------------------------------------------------------------
// Announcement tasks (Chris, 10-23-2026). Rules in anntasks.js. A Line Lead or Supervisor in an announcement's
// audience assigns it as a task to people on their team; each signs Done, then a Line Lead / Supervisor on that team
// (or the Production Manager) signs it off. Read live by the assignee and by leads, supervisors, Production Manager,
// Admins (database rules); written only here. Test site: test_annTasks.
// ---------------------------------------------------------------------------

const annTaskCol = (test) => col("annTasks", test);

async function openAnnTask(tx, test, id) {
  const ref = annTaskCol(test).doc(String(id || "x"));
  const snap = await tx.get(ref);
  if (!snap.exists || snap.get("status") === "removed") throw new HttpsError("not-found", "That task no longer exists.");
  return { ref, task: snap.data() };
}

// People on the shift running now (on their team's shift, or covering, and not absent) — who tasks go to (Decision 106).
async function shiftCrew(test) {
  const [people, ctx, s] = await Promise.all([messagePeople(test), messageShiftContext(test), crewShift(test)]);
  const onShift = (p) => ["on", "covering"].includes(messagingLib.standing(p, ctx));
  return { people, ctx, onShift, crew: people.filter(onShift), shiftEndMs: s?.now?.endMs || null };
}

// The people I can assign this announcement to: { annId } → { people: [{ emp, name, team }], shiftEndMs }.
exports.annTaskPeople = onCall(async (req) => {
  const me = await requireMember(req);
  if (!annTasksLib.canAssign(me.roles)) throw new HttpsError("permission-denied", "Line Leads and Supervisors assign announcement tasks.");
  const { crew, shiftEndMs } = await shiftCrew(isTest(req));
  const teamName = new Map((await teams.get()).docs.map((d) => [d.id, d.get("name") || d.id]));
  return {
    shiftEndMs,
    people: crew.filter((p) => p.id !== me.employeeNumber).sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ emp: p.id, name: p.name, team: p.team ? teamName.get(p.team) || p.team : "", loginEnabled: p.loginEnabled })),
  };
});

// Assign: { annId, emps: [employee #], dueMs, note? } — people on my shift. Someone with an open task on it is skipped.
exports.assignAnnouncementTask = onCall(async (req) => {
  const me = await requireMember(req);
  if (!annTasksLib.canAssign(me.roles)) throw new HttpsError("permission-denied", "Line Leads and Supervisors assign announcement tasks.");
  const test = isTest(req);
  const { snap } = await findAnnouncement(test, String(req.data?.annId || ""));
  const a = snap.data();
  if (!a.isTask) throw new HttpsError("failed-precondition", "This announcement isn't marked as a task.");
  if (!(a.audienceEmps || []).includes(me.employeeNumber)) throw new HttpsError("permission-denied", "This announcement wasn't sent to you.");
  if (annLib.isEnded(a, plantToday())) throw new HttpsError("failed-precondition", "This announcement has ended.");
  const { people, crew } = await shiftCrew(test);
  const { task, error } = annTasksLib.cleanAssign(req.data, { nowMs: Date.now(), crewIds: crew.filter((p) => p.id !== me.employeeNumber).map((p) => p.id) });
  if (error) throw new HttpsError("invalid-argument", error);
  const existing = await annTaskCol(test).where("annId", "==", snap.id).get();
  const busy = new Set(existing.docs.filter((d) => ["open", "done"].includes(d.get("status"))).map((d) => d.get("emp")));
  const byId = new Map(people.map((p) => [p.id, p]));
  const fresh = task.emps.filter((e) => !busy.has(e));
  const batch = db.batch();
  for (const emp of fresh) {
    const p = byId.get(emp);
    batch.create(annTaskCol(test).doc(), {
      source: "announcement", annId: snap.id, annVersion: a.version || 1, annTitle: a.title, priority: a.priority, emp, name: p.name, team: p.team || null,
      dueMs: task.dueMs, dueDate: plantDayOf(task.dueMs), note: task.note, assignedBy: me.employeeNumber, assignedByName: me.name, status: "open", done: null, verified: null,
      returns: [], createdAt: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
    });
  }
  if (fresh.length) {
    batch.create(auditLog.doc(), { type: "assigned", kind: "announcement task", recordId: snap.id, by: me.employeeNumber, at: FieldValue.serverTimestamp(), emps: fresh, dueMs: task.dueMs, test });
    await batch.commit();
    await pushTo(test ? [me.employeeNumber] : fresh, {
      title: `${test ? "[TEST] " : ""}📋 Task from ${me.name}`, body: `${a.title} — due ${fmtClock(task.dueMs)}. Tap Done in the app when it's finished.`, url: `/?ann=${snap.id}`,
    });
  }
  return { assigned: fresh.length, skipped: task.emps.length - fresh.length, test };
});

// The announcement's version right now (Decision 108: a task sign-off is tied to the version current when it's signed).
async function annVersionNow(tx, test, task) {
  const a = task.annId ? await tx.get(annCol(test).doc(task.annId)) : null;
  return a?.exists ? a.get("version") || 1 : task.annVersion || 1;
}

// Done, by the person it's assigned to: { id, signer: { emp, pin }, device }.
exports.markAnnTaskDone = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const out = await db.runTransaction(async (tx) => {
    const { ref, task } = await openAnnTask(tx, test, req.data?.id);
    if (task.emp !== signer.employeeNumber) throw new HttpsError("permission-denied", `This task is ${task.name}'s — ${signer.name} can't sign it done.`);
    if (task.status !== "open") return task.annTitle;
    const version = await annVersionNow(tx, test, task);
    tx.update(ref, { status: "done", done: { emp: signer.employeeNumber, name: signer.name, at: new Date(), device, annVersion: version } });
    logSignoff(tx, test, { kind: "announcement-task", refId: ref.id, version, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber });
    return task.annTitle;
  });
  return { ok: true, name: signer.name, title: out, test };
}));

// Who may confirm right now (Decision 106): the assigner; when the assigner is off shift, a Line Lead or Supervisor on
// the current shift. → (person, task) => { role, roleName } | { error }
async function confirmCheck(test) {
  const { people, onShift } = await shiftCrew(test);
  const byId = new Map(people.map((p) => [p.id, p]));
  const on = (emp) => { const p = byId.get(emp); return !!p && (onShift(p) || !p.team); };
  return (person, task) => annTasksLib.canConfirm(person, task, { assignerOnShift: on(task.assignedBy), personOnShift: on(person.id) });
}

// Confirm, once it's done: { id, signer: { emp, pin }, device }. The assigner — or, when they're off shift, a Line Lead or
// Supervisor on this shift. Never the person who did it.
exports.signAnnTask = onCall(signable(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const signer = await requireSignature(req.data);
  const device = annLib.cleanDevice(req.data?.device);
  const check = await confirmCheck(test);
  const w = await db.runTransaction(async (tx) => {
    const { ref, task } = await openAnnTask(tx, test, req.data?.id);
    if (task.status === "open") throw new HttpsError("failed-precondition", `${task.name} hasn't tapped Done yet.`);
    if (task.status === "verified") throw new HttpsError("failed-precondition", `Already confirmed by ${task.verified?.name}.`);
    const who = check({ id: signer.employeeNumber, roles: signer.roles }, task);
    if (who.error) throw new HttpsError("permission-denied", who.error);
    const version = await annVersionNow(tx, test, task);
    tx.update(ref, { status: "verified", closedAtMs: Date.now(), verified: { emp: signer.employeeNumber, name: signer.name, at: new Date(), device, role: who.role, roleName: who.roleName, annVersion: version } });
    logSignoff(tx, test, { kind: "announcement-task-verify", refId: ref.id, version, emp: signer.employeeNumber, name: signer.name, method: "pin", device, signedOn: me.employeeNumber, role: who.role });
    return who;
  });
  return { ok: true, name: signer.name, role: w.roleName, test };
}));

// Take an open task back (assigned by mistake, or to give it to someone else): { id }.
exports.removeAnnTask = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const people = await peopleList();
  const myself = people.find((p) => p.id === me.employeeNumber) || { id: me.employeeNumber, roles: me.roles };
  await db.runTransaction(async (tx) => {
    const { ref, task } = await openAnnTask(tx, test, req.data?.id);
    if (!annTasksLib.canRemove(myself, task)) throw new HttpsError("permission-denied", "The person who assigned it, a lead or supervisor on that team, or the Production Manager can take it back.");
    if (task.status !== "open") throw new HttpsError("failed-precondition", "It's already signed done — it can't be taken back.");
    tx.update(ref, { status: "removed", closedAtMs: Date.now(), removedBy: me.employeeNumber, removedByName: me.name, removedAt: new Date() });
    auditRecord(tx, "removed", "announcement task", ref.id, me.employeeNumber, { test });
  });
  return { ok: true };
});

// Who can sign on this device's sheet (line tablets): { id, step: "done" | "verify" } → names and employee numbers.
exports.annTaskSigners = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const snap = await annTaskCol(test).doc(String(req.data?.id || "x")).get();
  if (!snap.exists) throw new HttpsError("not-found", "That task no longer exists.");
  const task = snap.data();
  const people = (await peopleList()).filter((p) => p.active && p.loginEnabled && p.id !== me.employeeNumber);
  const check = req.data?.step === "verify" ? await confirmCheck(test) : null;
  const list = check ? people.filter((p) => !check(p, task).error) : people.filter((p) => p.id === task.emp);
  return { people: list.map((p) => ({ emp: p.id, name: p.name })) };
});

// Send it back (Decision 106): { id, note } — whoever may confirm it; it goes back to the person as not done.
exports.returnAnnTask = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const { note, error } = annTasksLib.cleanReturn(req.data?.note);
  if (error) throw new HttpsError("invalid-argument", error);
  const check = await confirmCheck(test);
  const task = await db.runTransaction(async (tx) => {
    const { ref, task: t } = await openAnnTask(tx, test, req.data?.id);
    if (t.status !== "done") throw new HttpsError("failed-precondition", t.status === "open" ? "It isn't marked done yet." : "It's already confirmed.");
    const who = check({ id: me.employeeNumber, roles: me.roles }, t);
    if (who.error) throw new HttpsError("permission-denied", who.error);
    // The Done that was sent back stays with the return (Decision 108: a sign-off is never wiped).
    tx.update(ref, { status: "open", done: null, returns: [...(t.returns || []), { by: me.employeeNumber, byName: me.name, note, atMs: Date.now(), prevDone: t.done || null }] });
    auditRecord(tx, "sent back", "task", ref.id, me.employeeNumber, { note, test });
    return t;
  });
  await pushTo(test ? [me.employeeNumber] : [task.emp], { title: `${test ? "[TEST] " : ""}↩ Task sent back by ${me.name}`, body: `${task.annTitle}: ${note}`, url: task.annId ? `/?ann=${task.annId}` : "/?messages=1" });
  return { ok: true };
});

// Tasks I can confirm right now (Home): { tasks: [{ id, annTitle, name, emp, annId, rootId, dueMs, assignedByName }] }.
exports.tasksToConfirm = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const snaps = await annTaskCol(test).where("status", "==", "done").get();
  if (snaps.empty) return { tasks: [] };
  const check = await confirmCheck(test);
  const tasks = snaps.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => !check({ id: me.employeeNumber, roles: me.roles }, t).error)
    .map((t) => ({ id: t.id, annTitle: t.annTitle, name: t.name, emp: t.emp, annId: t.annId || null, rootId: t.rootId || null, dueMs: annTasksLib.dueMsOf(t), assignedByName: t.assignedByName }));
  return { tasks };
});

// Every 15 minutes: an open task past its due time stays with the person (red) and its assigner is told once.
exports.taskOverdueAlerts = onSchedule({ schedule: "every 15 minutes", timeZone: "America/Chicago", retryCount: 0 }, async () => {
  const now = Date.now();
  for (const test of [false, true]) {
    const snaps = await annTaskCol(test).where("status", "==", "open").get();
    for (const d of snaps.docs) {
      const t = d.data();
      if (t.overdueAlertedAtMs || annTasksLib.dueMsOf(t) > now) continue;
      await d.ref.update({ overdueAlertedAtMs: now });
      await pushTo([t.assignedBy], { title: `${test ? "[TEST] " : ""}⚠ Task not done: ${t.name}`, body: `${t.annTitle} was due ${fmtClock(annTasksLib.dueMsOf(t))}. It stays with ${t.name} until it's done.`, url: t.annId ? `/?ann=${t.annId}` : "/?messages=1" });
    }
  }
});

// Plant-time helpers for tasks.
const plantDayOf = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(ms));
const fmtClock = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "numeric", minute: "2-digit" });

// ---------------------------------------------------------------------------
// Crew Board step 2 — stations (Decision 69; levels and SOPs from the Shift Station Assignment sheet, Chris 10-23-2026).
// Rules in crewseats.js. The station setup (company data) is in meta/crewStations — server-only, loaded by an admin.
// Each shift's seats live on the Who's here today record: seats { seat: emp }, cells { emp: [station per block] },
// alerted { lineOpOut } (the Production Manager is told once per shift).
// ---------------------------------------------------------------------------

const crewStationsDoc = db.collection("meta").doc("crewStations");
const trainingT = require("./training");

async function crewSetupNow() {
  const snap = await crewStationsDoc.get();
  return snap.exists ? snap.get("setup") || null : null;
}

// Each person's level for the training check: their training-roster position (with the coordinator's override), else
// their position in People. people = peopleList(). → Map emp → position text.
async function crewPositions(people, test) {
  const out = new Map(people.map((p) => [p.id, p.position || ""]));
  try {
    const ref = await db.collection("trainingRef").doc("data").get();
    if (!ref.exists) return out;
    const data = JSON.parse(ref.get("json"));
    const shared = await col("trainingShared", test).doc("state").get();
    const wb = shared.exists && shared.get("wbData") ? JSON.parse(shared.get("wbData")) : null;
    if (wb?.roster?.length && wb.rev === data.rev) Object.assign(data, wb);
    const roster = new Map((data.roster || []).map((r) => [r.name, r]));
    const wanted = people.map((p) => ({ p, r: roster.get(p.trainingName || p.name) })).filter((x) => x.r);
    const docs = wanted.length ? await db.getAll(...wanted.map((x) => col("trainingPeople", test).doc(trainingT.personId(x.r.name)))) : [];
    wanted.forEach(({ p, r }, i) => {
      const ov = docs[i]?.exists ? docs[i].get("posOv") : null;
      const pos = ov && ov.from === r.position ? ov.to : r.position;
      if (pos) out.set(p.id, pos);
    });
  } catch (err) {
    console.error("crew positions: training roster not read", err);
  }
  return out;
}

// Lines running now (names), from the line status the Home bar uses.
async function runningLineNames(test) {
  const [ls, status] = await Promise.all([lines.get(), col("meta", test).doc("plantStatus").get()]);
  const down = (status.exists && status.get("down")) || {};
  return ls.docs.filter((d) => d.get("active") !== false && !down[d.id]).map((d) => d.get("name"));
}

// The board's stations part for crewToday: setup (for the screen), seats, schedule, fits, warnings.
async function crewBoardView(test, s, people, list) {
  const setup = await crewSetupNow();
  if (!setup) return { stations: null };
  const marks = s.saved?.marks || {};
  const here = list.filter((p) => marks[p.id]?.status === "here").map((p) => p.id);
  const seats = s.saved?.seats || {};
  const sched = crewSeatsLib.schedule(setup, seats, s.saved?.cells || {});
  const [positions, runningLines] = await Promise.all([crewPositions(people, test), runningLineNames(test)]);
  const fits = {};
  for (const [emp, row] of Object.entries(sched)) {
    fits[emp] = row.map((id) => crewSeatsLib.fit(setup, crewSeatsLib.stationOf(setup, id), positions.get(emp) || ""));
  }
  return {
    stations: {
      setup: { levels: setup.levels, stations: setup.stations, allShift: setup.allShift, rotation: setup.rotation },
      seats, schedule: sched, fits,
      levels: Object.fromEntries(list.map((p) => [p.id, positions.get(p.id) || ""])),
      warnings: crewSeatsLib.warnings(setup, { here, seats, sched, runningLines }),
    },
  };
}

// After a change to the seats: tell the Production Manager once per shift when a line operator is out.
async function crewLineOpAlert(test, s, me) {
  const fresh = await s.ref.get();
  const saved = fresh.data() || {};
  const setup = await crewSetupNow();
  if (!setup || saved.alerted?.lineOpOut) return;
  const people = await peopleList();
  const list = crewListFor(people, saved.teamId, saved.added || [], test);
  const here = list.filter((p) => saved.marks?.[p.id]?.status === "here").map((p) => p.id);
  const w = crewSeatsLib.warnings(setup, { here, seats: saved.seats || {}, sched: crewSeatsLib.schedule(setup, saved.seats || {}, saved.cells || {}) });
  if (!w.some((x) => x.key === "line-op-out")) return;
  await s.ref.update({ "alerted.lineOpOut": Date.now() });
  const pms = people.filter((p) => p.active && p.roles.includes("plant-manager")).map((p) => p.id);
  await pushTo(test ? [me.employeeNumber] : pms, {
    title: `${test ? "[TEST] " : ""}👥 Line operator out — ${saved.shiftName || "this shift"}`, body: setup.callOffs?.lineOperatorOut || "A line seat can't be filled.", url: "/?crew=1",
  });
}

// Admins and the stations file's department head: the station setup — { setup } (null until loaded).
exports.adminCrewStations = onCall(async (req) => {
  await requireDocEditor(req, "stations");
  return { setup: await crewSetupNow() };
});

// Admins and the stations file's department head: save the station setup (Documents & forms → Crew Board stations,
// from the private sheet file): { setup }. Every save is kept as a revision.
exports.adminSaveCrewStations = onCall(async (req) => {
  const { me } = await requireDocEditor(req, "stations");
  const adminNumber = me.employeeNumber;
  const { setup, error } = crewSeatsLib.cleanSetup(req.data?.setup);
  if (error) throw new HttpsError("invalid-argument", error);
  const rev = await saveLoadRevision("stations", { setup }, me, `${setup.stations.length} stations`);
  await crewStationsDoc.set({ setup, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber });
  await auditLog.add({ type: "updated", kind: "crew stations", recordId: "crewStations", by: adminNumber, at: FieldValue.serverTimestamp(), stations: setup.stations.length, rev });
  return { ok: true, stations: setup.stations.length, rev };
});

// Line Leads, Supervisors, Production Manager, Admins: { seat, emp } (emp null = empty the seat). Only people marked
// Here; seating someone moves them off any other seat. They get a notification with their station(s).
exports.crewSeat = onCall(async (req) => {
  const me = await requireMember(req);
  requireCrewMarker(me);
  const test = isTest(req);
  const setup = await crewSetupNow();
  if (!setup) throw new HttpsError("failed-precondition", "The stations aren't set up yet (Admin → Crew Board stations).");
  const s = await crewShift(test);
  if (!s?.teamId) throw new HttpsError("failed-precondition", "Pick the team that's working first.");
  const seat = String(req.data?.seat || "");
  if (!crewSeatsLib.seatIds(setup).includes(seat)) throw new HttpsError("invalid-argument", "Pick a station from the list.");
  const emp = req.data?.emp ? String(req.data.emp) : null;
  const sched = await db.runTransaction(async (tx) => {
    const snap = await tx.get(s.ref);
    const saved = snap.exists ? snap.data() : {};
    if (emp && saved.marks?.[emp]?.status !== "here") throw new HttpsError("failed-precondition", "Mark them Here first.");
    const seats = { ...(saved.seats || {}) };
    const cells = { ...(saved.cells || {}) };
    if (emp) for (const [k, v] of Object.entries(seats)) if (v === emp) delete seats[k];
    if (seats[seat]) delete cells[seats[seat]];
    if (emp) { seats[seat] = emp; delete cells[emp]; } else delete seats[seat];
    keepHistory(tx, s.ref, saved, { ...historyLib.spread("seats", saved.seats, seats), ...historyLib.spread("cells", saved.cells, cells) }, me.employeeNumber, { byName: me.name, test });
    tx.update(s.ref, { seats, cells, updatedAtMs: Date.now(), updatedBy: me.employeeNumber });
    auditRecord(tx, "seated", "crew station", s.ref.id, me.employeeNumber, { seat, emp, test });
    return crewSeatsLib.schedule(setup, seats, cells);
  });
  if (emp) {
    const name = (id) => crewSeatsLib.stationOf(setup, id)?.name || "no station";
    const body = setup.allShift.includes(seat)
      ? `${name(seat)} — all shift`
      : (sched[emp] || []).map((id, i) => `${setup.rotation.blocks[i]}: ${name(id)}`).join(" → ");
    await pushTo(test ? [me.employeeNumber] : [emp], { title: `${test ? "[TEST] " : ""}👥 Your station today`, body, url: "/?crew=1" });
  }
  await crewLineOpAlert(test, s, me);
  return { ok: true };
});

// The lead's change to one block: { emp, block, station } (station "" = off a station that block).
exports.crewCell = onCall(async (req) => {
  const me = await requireMember(req);
  requireCrewMarker(me);
  const test = isTest(req);
  const setup = await crewSetupNow();
  if (!setup) throw new HttpsError("failed-precondition", "The stations aren't set up yet (Admin → Crew Board stations).");
  const s = await crewShift(test);
  if (!s) throw new HttpsError("failed-precondition", "No shift is running right now.");
  const emp = String(req.data?.emp || "");
  const block = Number(req.data?.block);
  const station = String(req.data?.station ?? "");
  if (!Number.isInteger(block) || block < 0 || block >= setup.rotation.blocks.length) throw new HttpsError("invalid-argument", "Pick a block.");
  if (station && !crewSeatsLib.stationOf(setup, station)) throw new HttpsError("invalid-argument", "Pick a station from the list.");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(s.ref);
    const saved = snap.exists ? snap.data() : {};
    const sched = crewSeatsLib.schedule(setup, saved.seats || {}, saved.cells || {});
    if (!sched[emp]) throw new HttpsError("failed-precondition", "Seat them first.");
    const row = [...sched[emp]];
    row[block] = station;
    keepHistory(tx, s.ref, saved, { [`cells.${emp}`]: row }, me.employeeNumber, { byName: me.name, test });
    tx.update(s.ref, { [`cells.${emp}`]: row, updatedAtMs: Date.now(), updatedBy: me.employeeNumber });
    auditRecord(tx, "moved", "crew station", s.ref.id, me.employeeNumber, { emp, block, station, test });
  });
  if (emp !== me.employeeNumber) {
    await pushTo(test ? [me.employeeNumber] : [emp], {
      title: `${test ? "[TEST] " : ""}👥 Station changed`, body: `${setup.rotation.blocks[block]}: ${crewSeatsLib.stationOf(setup, station)?.name || "no station"}`, url: "/?crew=1",
    });
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Write-ups (Decision 52; who writes and sees: Chris, 10-23-2026). Rules in writeups.js. Server-only collection — every
// read goes through these functions, so only the writer and people with HR access ever get one, and every view and
// print is in the activity log. Steps: the writer fills the form and signs by hand → the employee reads it, adds
// comments, and signs by hand on the writer's device — or the writer marks "Refused to sign" (Decision 101: drawn
// signatures instead of PINs).
// ---------------------------------------------------------------------------

async function requireWriteupAccess(req) {
  const me = await requireMember(req);
  if (!me.hr && !writeupsLib.canWrite(me.roles)) throw new HttpsError("permission-denied", "Write-ups are for Supervisors, the Production Manager, and Admins.");
  return me;
}

// The record, if this person may see it (otherwise "not found" — not even whether it exists).
async function writeupFor(me, id, test) {
  if (typeof id !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(id)) throw new HttpsError("invalid-argument", "Pick a write-up.");
  const snap = await col("writeups", test).doc(id).get();
  if (!snap.exists || !writeupsLib.canSee(me, snap.data())) throw new HttpsError("not-found", "That write-up isn't there, or it isn't yours to see.");
  return snap;
}

// { canWrite, hr, types, people: [{ emp, name, team }] } — people to pick (active, not yourself).
exports.writeupStart = onCall(async (req) => {
  const me = await requireWriteupAccess(req);
  const test = isTest(req);
  const teams = await db.collection("teams").get();
  const teamName = new Map(teams.docs.map((d) => [d.id, d.get("name") || d.id]));
  const people = (await peopleList())
    .filter((p) => p.active && p.id !== me.employeeNumber && (test || !deptLib.isPracticeAccount(p.name)))
    .map((p) => ({ emp: p.id, name: p.name, team: p.team ? teamName.get(p.team) || "" : "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { canWrite: writeupsLib.canWrite(me.roles), hr: me.hr, types: writeupsLib.TYPES, people, test };
});

// The list: everything for HR access; your own for writers. { items: [summary] }
exports.writeupList = onCall(async (req) => {
  const me = await requireWriteupAccess(req);
  const test = isTest(req);
  const c = col("writeups", test);
  const snap = me.hr ? await c.orderBy("date", "desc").limit(500).get() : await c.where("writerEmp", "==", me.employeeNumber).get();
  const items = snap.docs.map((d) => writeupsLib.summary(d.id, d.data())).sort((a, b) => b.date.localeCompare(a.date));
  return { items, hr: me.hr, test };
});

// One write-up: { writeup }. Logged as viewed.
exports.writeupGet = onCall(async (req) => {
  const me = await requireWriteupAccess(req);
  const test = isTest(req);
  const snap = await writeupFor(me, req.data?.id, test);
  await auditLog.add({ type: "viewed", kind: "write-up", recordId: snap.id, by: me.employeeNumber, at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}) });
  const w = snap.data();
  return { writeup: { id: snap.id, ...w, createdAt: null, updatedAt: null } };
});

// Save as PDF / print: logged. { id }
exports.writeupPrinted = onCall(async (req) => {
  const me = await requireWriteupAccess(req);
  const test = isTest(req);
  const snap = await writeupFor(me, req.data?.id, test);
  await auditLog.add({ type: "printed", kind: "write-up", recordId: snap.id, by: me.employeeNumber, at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}) });
  return { ok: true };
});

// What a write-up's signatures sign: the form and the earlier write-ups listed on it (same fields as at saving).
const writeupVersion = (w) => w.version || signoffsLib.contentVersion({ emp: w.emp, date: w.date, type: w.type, policy: w.policy, description: w.description, correctiveAction: w.correctiveAction, priorNotes: w.priorNotes, prior: w.prior });

// The writer (the person signed in) saves the form and signs by hand. { writeup: form, signature (PNG), device } → { id }
exports.saveWriteup = onCall(async (req) => {
  const me = await requireMember(req);
  if (!writeupsLib.canWrite(me.roles)) throw new HttpsError("permission-denied", "Write-ups are written by Supervisors, the Production Manager, and Admins.");
  const test = isTest(req);
  const { writeup, error } = writeupsLib.cleanWriteup(req.data?.writeup, plantToday());
  if (error) throw new HttpsError("invalid-argument", error);
  if (writeup.emp === me.employeeNumber) throw new HttpsError("invalid-argument", "You can't write yourself up.");
  const sig = writeupsLib.cleanPng(req.data?.signature, "Your signature");
  if (sig.error) throw new HttpsError("invalid-argument", sig.error);
  const person = await employees.doc(writeup.emp).get();
  if (!person.exists || person.get("active") === false) throw new HttpsError("invalid-argument", "Pick the employee from the list.");
  const c = col("writeups", test);
  const earlier = await c.where("emp", "==", writeup.emp).get();
  const device = annLib.cleanDevice(req.data?.device);
  const ref = c.doc();
  const prior = writeupsLib.priorList(earlier.docs.map((d) => d.data()), writeup.date);
  // What both people sign (no edits after): the form and the earlier write-ups listed on it (Decision 108).
  const version = signoffsLib.contentVersion({ ...writeup, prior });
  await db.runTransaction(async (tx) => {
    tx.create(ref, {
      ...writeup, empName: person.get("name") || `Employee ${writeup.emp}`, version,
      prior,
      writerEmp: me.employeeNumber, writerName: me.name, writerRole: writeupsLib.writerRole(me.roles),
      writerSig: { emp: me.employeeNumber, name: me.name, role: writeupsLib.writerRole(me.roles), atMs: Date.now(), device, png: sig.png },
      status: "waiting", employeeComments: "", createdAt: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
    });
    logSignoff(tx, test, { kind: "write-up (writer)", refId: ref.id, version, emp: me.employeeNumber, name: me.name, method: "drawn", device, signedOn: me.employeeNumber });
    auditRecord(tx, "created", "write-up", ref.id, me.employeeNumber, test ? { test: true } : {});
  });
  return { id: ref.id };
});

// The employee reads it, adds comments, and signs by hand on the writer's device, with the writer there.
// { id, comments, signature (PNG), device }
exports.writeupEmployeeSign = onCall(async (req) => {
  const me = await requireWriteupAccess(req);
  const test = isTest(req);
  const snap = await writeupFor(me, req.data?.id, test);
  const sig = writeupsLib.cleanPng(req.data?.signature, `${snap.get("empName")}'s signature`);
  if (sig.error) throw new HttpsError("invalid-argument", sig.error);
  const device = annLib.cleanDevice(req.data?.device);
  const comments = writeupsLib.clean(req.data?.comments, writeupsLib.MAX.comments);
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(snap.ref);
    const w = fresh.data();
    if (w.status !== "waiting") throw new HttpsError("failed-precondition", "This write-up is already signed or marked refused.");
    const witness = { emp: me.employeeNumber, name: me.name };
    tx.update(snap.ref, { status: "signed", employeeComments: comments, employeeSig: { emp: w.emp, name: w.empName, atMs: Date.now(), device, png: sig.png, witnessedBy: witness }, updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "write-up (employee)", refId: snap.id, version: w.version || writeupVersion(w), emp: w.emp, name: w.empName, method: "drawn", device, signedOn: me.employeeNumber, recordedBy: me.employeeNumber });
    auditRecord(tx, "signed", "write-up", snap.id, me.employeeNumber, { employee: w.emp, method: "drawn", ...(test ? { test: true } : {}) });
  });
  return { ok: true };
});

// The employee won't sign: the writer (or HR access) records it, with any comments the employee gave. { id, comments }
exports.writeupRefused = onCall(async (req) => {
  const me = await requireWriteupAccess(req);
  const test = isTest(req);
  const snap = await writeupFor(me, req.data?.id, test);
  const comments = writeupsLib.clean(req.data?.comments, writeupsLib.MAX.comments);
  await db.runTransaction(async (tx) => {
    const fresh = await tx.get(snap.ref);
    if (fresh.get("status") !== "waiting") throw new HttpsError("failed-precondition", "This write-up is already signed or marked refused.");
    const w = fresh.data();
    tx.update(snap.ref, { status: "refused", employeeComments: comments, refused: { by: me.employeeNumber, byName: me.name, atMs: Date.now() }, updatedAt: FieldValue.serverTimestamp() });
    logSignoff(tx, test, { kind: "write-up (refused)", refId: snap.id, version: w.version || writeupVersion(w), emp: me.employeeNumber, name: me.name, method: "app", employee: w.emp, employeeName: w.empName, recordedBy: me.employeeNumber });
    auditRecord(tx, "refused to sign", "write-up", snap.id, me.employeeNumber, test ? { test: true } : {});
  });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Crew Board step 3 — "Your station today" on everyone's Home (Decision 69 part 3). Light on purpose: one record and
// the station setup, no people list. Anyone signed in; only their own stations.
// ---------------------------------------------------------------------------

// Who is on which line this shift (no home lines — Decision 104): from the Crew Board seats and the block running now.
// → { now: { emp: [lineId] }, today: { emp: [lineId] }, onLineNow: { lineId: [emp] } } (empty before anyone is seated)
async function shiftLineAssignments(test) {
  const s = await crewShift(test);
  const setup = s?.saved?.seats ? await crewSetupNow() : null;
  if (!s || !setup) return { now: {}, today: {}, onLineNow: {} };
  const lineSnaps = await lines.get();
  const block = crewSeatsLib.blockAt(s.now.startMs, s.now.endMs, Math.max(1, setup.rotation.blocks.length), Date.now());
  return crewSeatsLib.shiftLines(setup, s.saved.seats, s.saved.cells || {}, block, lineSnaps.docs.map((d) => ({ id: d.id, name: d.get("name") })));
}
// People with the lines they're on this shift (lineIds), for line audiences.
const withShiftLines = (people, onLines) => people.map((p) => ({ ...p, lineIds: onLines.today[p.id] || [] }));

// { noShift } | { shift, seated: false } | { shift, seated: true, seat, allShift, blocks: [{ label, station }], current,
//   linesNow, linesToday (line ids) }
exports.crewMyStation = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const s = await crewShift(test);
  if (!s) return { noShift: true, test };
  const shift = { shiftName: s.now.shift.name || s.now.shift.id, startMs: s.now.startMs, endMs: s.now.endMs };
  const setup = s.saved?.seats ? await crewSetupNow() : null;
  const mine = setup ? crewSeatsLib.myStations(setup, s.saved.seats, s.saved.cells || {}, me.employeeNumber) : null;
  if (!mine) return { test, shift, seated: false };
  const current = crewSeatsLib.blockAt(s.now.startMs, s.now.endMs, mine.blocks.length, Date.now());
  const lineSnaps = await lines.get();
  const on = crewSeatsLib.shiftLines(setup, s.saved.seats, s.saved.cells || {}, current, lineSnaps.docs.map((d) => ({ id: d.id, name: d.get("name") })));
  return { test, shift, seated: true, ...mine, current, linesNow: on.now[me.employeeNumber] || [], linesToday: on.today[me.employeeNumber] || [] };
});

// ---------------------------------------------------------------------------
// Record retention (Decision 99; rules in retentionrules.js). Every night the cleanup removes live records older than
// their group's period — never anything still open — and logs a count per group (retentionRuns + Admin activity).
//   meta/retention     periods { key: days | null }, updatedBy, updatedAt
//   retentionRuns/{auto}  atMs, removed { key: n }, keptOpen { key: n }, errors [text]
// Backups (daily kept 7 days, weekly kept 14 weeks) are separate: a removed record can be restored only in that window.
// RETENTION SECTION START — the only place live safety reports may be removed (retention.test.js checks this).
// ---------------------------------------------------------------------------

const retentionDoc = db.collection("meta").doc("retention");
const retentionRuns = db.collection("retentionRuns");
const RETENTION_BATCH = 2000; // per collection per night — anything left over goes the next night

async function retentionPeriods() {
  const snap = await retentionDoc.get();
  return retentionLib.periods(snap.exists ? snap.get("periods") || {} : {});
}

// One collection: records with `field` before `before` (oldest first), minus the open ones. → { removed, keptOpen, keptIds }
async function retentionSweep(name, field, before, open, ctx, extra = null) {
  const snap = await db.collection(name).where(field, "<", before).limit(RETENTION_BATCH).get();
  const writer = db.bulkWriter();
  let removed = 0;
  let keptOpen = 0;
  const keptIds = new Set();
  for (const d of snap.docs) {
    const rec = { id: d.id, ...d.data() };
    if (open(rec, ctx)) { keptOpen += 1; keptIds.add(d.id); continue; }
    if (extra) await extra(d, rec);
    writer.delete(d.ref);
    removed += 1;
  }
  await writer.close();
  return { removed, keptOpen, keptIds };
}

async function runRetention(nowMs = Date.now()) {
  const p = await retentionPeriods();
  const O = retentionLib.OPEN;
  const day = (days) => retentionLib.cutoffDay(nowMs, days);
  const at = (days) => new Date(retentionLib.cutoffMs(nowMs, days));
  const removed = {};
  const keptOpen = {};
  const errors = [];
  const add = (key, r) => { removed[key] = (removed[key] || 0) + r.removed; keptOpen[key] = (keptOpen[key] || 0) + r.keptOpen; };
  const step = async (key, fn) => {
    try { await fn(); } catch (err) { console.error(`retention ${key}`, err); errors.push(`${key}: ${String(err.message || err).slice(0, 200)}`); }
  };

  if (p.checklists != null) await step("checklists", async () => {
    const units = await db.collection("checklistUnits").get();
    const pendingSignoffs = new Set(units.docs.flatMap((u) => Object.keys(u.get("pending") || {})));
    add("checklists", await retentionSweep("shopTasks", "date", day(p.checklists), O.shopTasks, {}));
    add("checklists", await retentionSweep("stationLists", "date", day(p.checklists), O.stationLists, {}));
    add("checklists", await retentionSweep("checklistSignoffs", "at", at(p.checklists), O.checklistSignoffs, { pendingSignoffs }));
  });
  if (p.lineChecks != null) await step("lineChecks", async () => {
    add("lineChecks", await retentionSweep("lineLogs", "date", day(p.lineChecks), O.lineLogs, {}));
    add("lineChecks", await retentionSweep("plantLogs", "date", day(p.lineChecks), O.plantLogs, {}));
  });
  if (p.reels != null) await step("reels", async () => {
    add("reels", await retentionSweep("reels", "flagged.atMs", retentionLib.cutoffMs(nowMs, p.reels), O.reels, {}));
  });
  if (p.downtime != null) await step("downtime", async () => {
    const reports = await retentionSweep("shiftReports", "date", day(p.downtime), O.shiftReports, {});
    add("downtime", reports);
    // Changeovers, downtime, and scrap go with their report — but stay while the report is still open.
    const eventOpen = (e) => reports.keptIds.has(e.reportId);
    for (const name of ["changeoverEvents", "downtimeEvents", "scrapEntries"]) {
      const r = await retentionSweep(name, "date", day(p.downtime), eventOpen, {});
      removed.downtime += r.removed;
    }
  });
  if (p.handoffs != null) await step("handoffs", async () => {
    add("handoffs", await retentionSweep("handoffs", "date", day(p.handoffs), O.handoffs, {}));
  });
  if (p.annSigs != null) await step("annSigs", async () => {
    add("annSigs", await retentionSweep("announcementSigs", "at", at(p.annSigs), O.announcementSigs, {}));
  });
  if (p.tasks != null) await step("tasks", async () => {
    add("tasks", await retentionSweep("annTasks", "closedAtMs", retentionLib.cutoffMs(nowMs, p.tasks), O.annTasks, {}));
  });
  if (p.messages != null) await step("messages", async () => {
    add("messages", await retentionSweep("messages", "atMs", retentionLib.cutoffMs(nowMs, p.messages), O.messages, {}));
  });
  if (p.writeups != null) await step("writeups", async () => {
    add("writeups", await retentionSweep("writeups", "date", day(p.writeups), O.writeups, {}));
  });
  // Safety reports: counted from closing; injury reports never before 5 years (incidentMayGo checks each one again).
  const safetyDays = [p.incidents, p.injury == null ? null : Math.max(p.injury, retentionLib.byKey("injury").minDays)].filter((d) => d != null);
  if (safetyDays.length) await step("safety", async () => {
    const actions = await db.collection("incidentActions").get();
    const openActionIncidents = new Set(actions.docs.filter((a) => !a.get("done")).map((a) => a.get("incidentId")));
    const bucket = getStorage().bucket();
    const notYet = (inc) => !retentionLib.incidentMayGo(inc, p, nowMs);
    const r = await retentionSweep("incidents", "closedAtMs", retentionLib.cutoffMs(nowMs, Math.min(...safetyDays)),
      (inc, ctx) => O.incidents(inc, ctx) || notYet(inc), { openActionIncidents },
      async (d, inc) => {
        const acts = await db.collection("incidentActions").where("incidentId", "==", d.id).get();
        await Promise.all(acts.docs.map((a) => a.ref.delete()));
        await db.recursiveDelete(d.ref.collection("private"));
        await bucket.deleteFiles({ prefix: `safety/${d.id}/` });
        const key = retentionLib.isInjury(inc) ? "injury" : "incidents";
        removed[key] = (removed[key] || 0) + 1;
      });
    // retentionSweep counted removals together; they were split by type above.
    keptOpen.incidents = (keptOpen.incidents || 0) + r.keptOpen;
  });

  const run = { atMs: nowMs, removed, keptOpen, errors, at: FieldValue.serverTimestamp() };
  await retentionRuns.add(run);
  await auditLog.add({ type: "cleanup", kind: "record retention", recordId: "retention", by: "system", at: FieldValue.serverTimestamp(), removed, keptOpen, errors: errors.length });
  return run;
}

exports.recordRetention = onSchedule({ schedule: "every day 02:30", timeZone: "America/Chicago", retryCount: 0, timeoutSeconds: 540 }, async () => {
  await runRetention();
});

// RETENTION SECTION END

// Admins: the periods, who may change each one, and the last 30 nightly runs.
exports.adminRetention = onCall(async (req) => {
  const me = await requireMember(req);
  if (!me.roles.includes("admin")) throw new HttpsError("permission-denied", "Only Admins can see record retention.");
  const [p, runs] = await Promise.all([retentionPeriods(), retentionRuns.orderBy("atMs", "desc").limit(30).get()]);
  return {
    hr: me.hr,
    groups: retentionLib.CATEGORIES.map((c) => ({
      key: c.key, label: c.label, covers: c.covers, hr: !!c.hr, locked: !!c.locked, days: p[c.key], defaultDays: c.days, canChange: retentionLib.canChange(c, me),
      choices: retentionLib.CHOICES.filter((d) => d == null || !c.minDays || d >= c.minDays).map((d) => ({ days: d, label: retentionLib.periodLabel(d) })),
    })),
    runs: runs.docs.map((d) => ({ id: d.id, atMs: d.get("atMs"), removed: d.get("removed") || {}, keptOpen: d.get("keptOpen") || {}, errors: d.get("errors") || [] })),
  };
});

// Admins (HR access too for write-ups and injury reports): { key, days } (days null = never delete).
exports.adminSaveRetention = onCall(async (req) => {
  const me = await requireMember(req);
  const cat = retentionLib.byKey(req.data?.key);
  if (!cat) throw new HttpsError("invalid-argument", "Pick a group of records.");
  if (!retentionLib.canChange(cat, me)) {
    throw new HttpsError("permission-denied", cat.hr ? `Changing how long ${cat.label.toLowerCase()} are kept needs HR access.` : "Only Admins can change record retention.");
  }
  const { days, error } = retentionLib.cleanPeriod(cat.key, req.data?.days);
  if (error) throw new HttpsError("invalid-argument", error);
  const before = (await retentionPeriods())[cat.key];
  await retentionDoc.set({ periods: { [cat.key]: days }, updatedBy: me.employeeNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await auditLog.add({ type: "updated", kind: "record retention", recordId: cat.key, by: me.employeeNumber, at: FieldValue.serverTimestamp(), from: before, to: days });
  return { ok: true, days };
});

// ---------------------------------------------------------------------------
// In-app messaging (Decision 102; rules in messaging.js). Delivery is decided here when a message is sent — the shift
// on now (rotation, or the team picked on Who's here today) and that shift's Here / Out marks. Phones read only the
// messages delivered to them or sent by them (firestore.rules); every write goes through these functions.
// ---------------------------------------------------------------------------

const messagesSeen = (test) => col("messagesSeen", test);

// Day hours for people with no team (Decision 109): meta/messaging.dayHours, set in Admin → Message hours.
const messagingDoc = db.collection("meta").doc("messaging");
async function messageDayHours() {
  const raw = (await messagingDoc.get()).get("dayHours");
  return raw ? messagingLib.cleanDayHours(raw).hours || messagingLib.DEFAULT_DAY_HOURS : messagingLib.DEFAULT_DAY_HOURS;
}
// Plant time now: { dow (0 = Sunday), minutes since midnight }.
function plantClockNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

// The shift on now, for the delivery check: { teamOnShift, marks, lineNow, shiftEndMs, dayHours, dayNow }.
async function messageShiftContext(test) {
  const [s, onLines, dayHours] = await Promise.all([crewShift(test), shiftLineAssignments(test), messageDayHours()]);
  return { teamOnShift: s?.teamId || null, marks: s?.saved?.marks || {}, lineNow: onLines.now, shiftEndMs: s?.now?.endMs || null, dayHours, dayNow: plantClockNow() };
}

// Admins: the day hours for people with no team (Admin → Message hours). → { hours, text, isDefault }
exports.adminMessageHours = onCall(async (req) => {
  await requireAdmin(req);
  const raw = (await messagingDoc.get()).get("dayHours");
  const hours = await messageDayHours();
  return { hours, text: messagingLib.dayHoursText(hours), isDefault: !raw };
});
// Admins: { days: [0–6], start: "HH:MM", end: "HH:MM" } (plant time).
exports.adminSaveMessageHours = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const { hours, error } = messagingLib.cleanDayHours(req.data);
  if (error) throw new HttpsError("invalid-argument", error);
  const before = await messageDayHours();
  await messagingDoc.set({ dayHours: hours, updatedBy: adminNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await auditLog.add({ type: "updated", kind: "message hours", recordId: "dayHours", by: adminNumber, at: FieldValue.serverTimestamp(), from: before, to: hours });
  return { ok: true, hours, text: messagingLib.dayHoursText(hours) };
});

// Active people (practice accounts only on the test site), shaped for messaging.js.
async function messagePeople(test) {
  return (await peopleList()).filter((p) => p.active && (test || !deptLib.isPracticeAccount(p.name)));
}

// Who starts messages (Decision 106): Line Leads, Supervisors, department heads, the Production Manager, Admins.
async function canStartMessages(me) {
  const snap = await employees.doc(me.employeeNumber).get();
  return messagingLib.canStart({ roles: me.roles, deptHead: snap.get("deptHead") === true });
}
async function requireMessageStarter(me) {
  if (!(await canStartMessages(me))) throw new HttpsError("permission-denied", "Only Line Leads, Supervisors, department heads, the Production Manager, and Admins start messages. You can answer with Got it, Done, or Need help.");
}

// The sender as messaging.js needs them: { roles, deptHead, department, team, linesToday (Crew Board, Decision 117) }.
async function messageSender(me, test, snap = null) {
  const [mine, onLines] = await Promise.all([snap || employees.doc(me.employeeNumber).get(), shiftLineAssignments(test)]);
  return {
    roles: me.roles, deptHead: mine.get("deptHead") === true, department: mine.get("department") || null,
    team: mine.get("team") || null, linesToday: onLines.today?.[me.employeeNumber] || [],
  };
}

// What the target is called ("Team A", "Line 2", "Supervisors", "Quality department", "Everyone", a person's name;
// a mix joins its parts: "Quality department + Team B + Sam Sample").
async function messageTargetLabel(to, people) {
  if (to.type === "all") return "Everyone";
  if (to.type === "set") {
    const names = await Promise.all(to.parts.map((p) => messageTargetLabel(p, people)));
    if (names.some((n) => !n)) return null;
    return names.length > 4 ? `${names.slice(0, 3).join(" + ")} + ${names.length - 3} more` : names.join(" + ");
  }
  if (to.type === "department") { const d = (await departmentList()).find((x) => x.id === to.id); return d ? `${d.name} department` : null; }
  if (to.type === "person") return people.find((p) => p.id === to.id)?.name || `#${to.id}`;
  if (to.type === "team") { const t = await teams.doc(to.id).get(); return t.exists ? `Team ${t.get("name") || to.id}` : null; }
  if (to.type === "line") { const l = await lines.doc(to.id).get(); return l.exists ? l.get("name") || to.id : null; }
  const r = await roles.doc(to.id).get();
  return r.exists ? `Everyone who is ${r.get("name") || to.id}` : null;
}

// Screen setup: { canStart, hr, people, teams, lines, roles, noticeSeen, noTeam (Admins: who has no team yet) }
exports.messageStart = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const [people, teamSnaps, lineSnaps, roleSnaps, mine] = await Promise.all([messagePeople(test), teams.get(), lines.get(), roles.get(), employees.doc(me.employeeNumber).get()]);
  const teamName = new Map(teamSnaps.docs.map((d) => [d.id, d.get("name") || d.id]));
  const sender = await messageSender(me, test, mine);
  const start = messagingLib.canStart(sender);
  const opts = messagingLib.sendOptions(sender); // Decision 108: what this sender may pick, and the default "to"
  const allDepts = start && opts.kinds.includes("department") ? await departmentList() : [];
  return {
    test, canStart: start, hr: me.hr, noticeSeen: !!mine.get("messagingNoticeAt"), options: opts,
    departments: opts.departments === "any" ? allDepts : allDepts.filter((x) => (opts.departments || []).includes(x.id)),
    people: (start || me.hr) ? people.filter((p) => p.id !== me.employeeNumber).map((p) => ({ emp: p.id, name: p.name, team: p.team ? teamName.get(p.team) || "" : "" })).sort((a, b) => a.name.localeCompare(b.name)) : [],
    // Only the teams and lines this sender may pick (Line Leads: their own team and today's line — Decision 117).
    teams: start ? teamSnaps.docs.filter((d) => d.get("active") !== false && (opts.teams === "any" || opts.teams.includes(d.id))).map((d) => ({ id: d.id, name: `Team ${d.get("name") || d.id}` })) : [],
    lines: start ? lineSnaps.docs.filter((d) => d.get("active") !== false && (opts.lines === "any" || opts.lines.includes(d.id))).map((d) => ({ id: d.id, name: d.get("name") || d.id })) : [],
    roles: start && opts.kinds.includes("role") ? roleSnaps.docs.filter((d) => d.get("active") !== false).map((d) => ({ id: d.id, name: d.get("name") || d.id })) : [],
    noTeam: me.roles.includes("admin") ? people.filter((p) => !p.team).map((p) => p.name).sort() : [],
  };
});

// Before sending: who it would reach now. { to } → { total, reach, why, name }
exports.messagePreview = onCall(async (req) => {
  const me = await requireMember(req);
  await requireMessageStarter(me);
  const test = isTest(req);
  const { to, error } = messagingLib.cleanTo(req.data?.to);
  if (error) throw new HttpsError("invalid-argument", error);
  const notAllowed = messagingLib.checkTo(to, messagingLib.sendOptions(await messageSender(me, test)));
  if (notAllowed) throw new HttpsError("permission-denied", notAllowed);
  const [people, ctx] = await Promise.all([messagePeople(test), messageShiftContext(test)]);
  const d = messagingLib.deliver(people, to, me.employeeNumber, ctx);
  const label = (await messageTargetLabel(to, people)) || "";
  const nameOf = new Map(people.map((p) => [p.id, p.name]));
  return {
    // name: who it's for, e.g. "Quality department" — the screen shows "Quality department – 4 people" (Decision 108).
    // dayHours: when people with no team receive ("Mon–Fri, 5 AM–5 PM") — for the "off hours" warning (Decision 109).
    total: d.total, reach: d.recipients.length, why: d.why, name: label, noOneOnLine: to.type === "line" && !d.total, dayHours: messagingLib.dayHoursText(ctx.dayHours), offHours: d.offHours,
    // For "This is a task" (Decision 106): who it reaches now, and when this shift ends (the default due time).
    reachList: d.recipients.map((e) => ({ emp: e, name: nameOf.get(e) || `#${e}` })), shiftEndMs: ctx.shiftEndMs || null,
  };
});

// Line Lead and above: { to, text } → { id, delivered, total, why }
exports.messageSend = onCall(async (req) => {
  const me = await requireMember(req);
  await requireMessageStarter(me);
  const test = isTest(req);
  const { to, error } = messagingLib.cleanTo(req.data?.to);
  if (error) throw new HttpsError("invalid-argument", error);
  const t = messagingLib.cleanText(req.data?.text);
  if (t.error) throw new HttpsError("invalid-argument", t.error);
  const notAllowed = messagingLib.checkTo(to, messagingLib.sendOptions(await messageSender(me, test)));
  if (notAllowed) throw new HttpsError("permission-denied", notAllowed);
  const [people, ctx] = await Promise.all([messagePeople(test), messageShiftContext(test)]);
  const label = await messageTargetLabel(to, people);
  if (!label || (to.type === "person" && !people.some((p) => p.id === to.id && p.id !== me.employeeNumber))) throw new HttpsError("invalid-argument", "Pick who it's for from the list.");
  const d = messagingLib.deliver(people, to, me.employeeNumber, ctx);
  if (to.type === "line" && !d.total) throw new HttpsError("failed-precondition", `No one is assigned to ${label} yet this shift.`);
  if (!d.total) throw new HttpsError("failed-precondition", "No one is in that group yet.");
  const nowMs = Date.now();
  const tk = messagingLib.cleanMessageTask(req.data?.task || null, d.recipients, nowMs);
  if (tk.error) throw new HttpsError("invalid-argument", tk.error);
  const ref = col("messages", test).doc();
  const batch = db.batch();
  batch.set(ref, {
    rootId: ref.id, conv: "", kind: "new", fromEmp: me.employeeNumber, fromName: me.name, fromRole: messagingLib.startRole(me.roles),
    to: { ...to, label }, text: t.text, atMs: nowMs, at: FieldValue.serverTimestamp(), shiftEndMs: ctx.shiftEndMs || nowMs + 12 * 3600000,
    recipients: d.recipients, total: d.total, notDelivered: d.notDelivered, why: d.why, acks: {}, task: tk.task, ...(test ? { test: true } : {}),
  });
  // A task on a message (Decision 106): one task per person, in the same task list as announcement tasks.
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const emp of tk.task?.emps || []) {
    batch.create(annTaskCol(test).doc(), {
      // annVersion: a fingerprint of the message, so the Done and Confirm sign-offs are tied to exactly what was sent (Decision 108).
      source: "message", rootId: ref.id, annId: null, annVersion: signoffsLib.contentVersion({ text: t.text, atMs: nowMs }), annTitle: t.text.slice(0, 80), emp, name: byId.get(emp)?.name || `#${emp}`, team: byId.get(emp)?.team || null,
      dueMs: tk.task.dueMs, dueDate: plantDayOf(tk.task.dueMs), note: "", assignedBy: me.employeeNumber, assignedByName: me.name, status: "open", done: null, verified: null,
      returns: [], createdAt: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}),
    });
  }
  await batch.commit();
  if (d.recipients.length) {
    const tasked = new Set(tk.task?.emps || []);
    const plain = d.recipients.filter((e) => !tasked.has(e));
    if (plain.length) await pushTo(test ? [me.employeeNumber] : plain, { title: `${test ? "[TEST] " : ""}💬 ${me.name}`, body: t.text.slice(0, 140), url: "/?messages=1" });
    if (tasked.size) await pushTo(test ? [me.employeeNumber] : [...tasked], { title: `${test ? "[TEST] " : ""}📋 Task from ${me.name}`, body: `${t.text.slice(0, 120)} — due ${fmtClock(tk.task.dueMs)}`, url: "/?messages=1" });
  }
  return { id: ref.id, delivered: d.recipients.length, total: d.total, why: d.why, tasks: tk.task?.emps.length || 0 };
});

// Reply in a conversation: { rootId, participant (the starter names who), text } → { id, delivered, why }.
// The starter replies to one participant; anyone who received the message replies to its starter only.
// Quick replies (Decision 106): { rootId, quick: "got" | "done" | "help" } — anyone who got the message; marks it
// acknowledged for them. Typed replies ({ text }) only for the people who start messages.
exports.messageReply = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const quick = req.data?.quick ? messagingLib.cleanQuick(req.data.quick) : null;
  if (quick?.error) throw new HttpsError("invalid-argument", quick.error);
  if (!quick && !(await canStartMessages(me))) throw new HttpsError("permission-denied", "Reply with Got it, Done, or Need help – see me.");
  const t = quick ? { text: quick.text } : messagingLib.cleanText(req.data?.text);
  if (t.error) throw new HttpsError("invalid-argument", t.error);
  const rootId = String(req.data?.rootId || "");
  if (!/^[A-Za-z0-9]{1,40}$/.test(rootId)) throw new HttpsError("invalid-argument", "Pick a message.");
  const root = await col("messages", test).doc(rootId).get();
  if (!root.exists) throw new HttpsError("not-found", "That message is gone (messages are kept 90 days).");
  const r = root.data();
  let toEmp;
  let participant;
  if (r.fromEmp === me.employeeNumber) {
    participant = String(req.data?.participant || "");
    if (!(r.recipients || []).includes(participant)) throw new HttpsError("invalid-argument", "Pick someone who got this message.");
    toEmp = participant;
  } else {
    if (!(r.recipients || []).includes(me.employeeNumber)) throw new HttpsError("permission-denied", "You can reply only to messages you got.");
    participant = me.employeeNumber;
    toEmp = r.fromEmp;
  }
  const [people, ctx] = await Promise.all([messagePeople(test), messageShiftContext(test)]);
  const person = people.find((p) => p.id === toEmp);
  const d = messagingLib.deliverOne(person, ctx);
  const ref = col("messages", test).doc();
  await ref.set({
    rootId, conv: messagingLib.conv(rootId, participant), kind: "reply", fromEmp: me.employeeNumber, fromName: me.name, fromRole: messagingLib.startRole(me.roles),
    to: { type: "person", id: toEmp, label: person?.name || r.fromName }, text: t.text, atMs: Date.now(), at: FieldValue.serverTimestamp(),
    recipients: d.recipients, total: 1, notDelivered: d.recipients.length ? 0 : 1, why: d.why, quick: quick?.kind || null, ...(test ? { test: true } : {}),
  });
  // Someone who got the message answered: it's acknowledged for them (clears from their screen — Decision 106).
  if (participant === me.employeeNumber && r.fromEmp !== me.employeeNumber) {
    const ack = { kind: quick?.kind || "reply", atMs: Date.now(), name: me.name };
    await root.ref.update({ [`acks.${me.employeeNumber}`]: ack });
    // Acknowledgments go in the sign-off log too (Decision 108), tied to the message as sent.
    await logSignoffNow(test, { kind: "message-ack", refId: rootId, version: signoffsLib.contentVersion({ text: r.text, atMs: r.atMs }), emp: me.employeeNumber, name: me.name, method: "app", ack: ack.kind, replyId: ref.id });
  }
  if (d.recipients.length) {
    const help = quick?.kind === "help";
    await pushTo(test ? [me.employeeNumber] : d.recipients, {
      title: `${test ? "[TEST] " : ""}${help ? "🆘 Need help – see me: " : "💬 "}${me.name}`, body: help ? r.text.slice(0, 120) : t.text.slice(0, 140), url: "/?messages=1", ...(help ? { urgent: true } : {}),
    });
  }
  return { id: ref.id, delivered: d.recipients.length, why: d.why };
});

// Read: { convs: [conversation keys] } → marks them seen now (own record only; entries older than 90 days drop off).
exports.messagesSeenNow = onCall(async (req) => {
  const me = await requireMember(req);
  const test = isTest(req);
  const convs = (Array.isArray(req.data?.convs) ? req.data.convs : []).filter((c) => typeof c === "string" && /^[A-Za-z0-9_]{1,90}$/.test(c)).slice(0, 50);
  if (!convs.length) return { ok: true };
  const ref = messagesSeen(test).doc(me.employeeNumber);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cutoff = Date.now() - 90 * 86400000;
    const seen = Object.fromEntries(Object.entries(snap.exists ? snap.get("seen") || {} : {}).filter(([, ms]) => ms > cutoff));
    for (const c of convs) seen[c] = Date.now();
    tx.set(ref, { emp: me.employeeNumber, seen });
  });
  return { ok: true };
});

// The HR notice was shown: employees/{me}.messagingNoticeAt.
exports.messagingNoticeSeen = onCall(async (req) => {
  const me = await requireMember(req);
  await employees.doc(me.employeeNumber).update({ messagingNoticeAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// HR access: one person's messages (sent and received, last 90 days), only with a reason — every view logged.
// { emp, reason } → { messages }
exports.hrReviewMessages = onCall(async (req) => {
  const me = await requireHr(req);
  const test = isTest(req);
  const emp = String(req.data?.emp || "");
  const person = await employees.doc(emp).get();
  if (!person.exists || emp === me.employeeNumber) throw new HttpsError("invalid-argument", "Pick the person.");
  const { reason, error } = messagingLib.cleanReason(req.data?.reason);
  if (error) throw new HttpsError("invalid-argument", error);
  const c = col("messages", test);
  const [got, sent] = await Promise.all([c.where("recipients", "array-contains", emp).get(), c.where("fromEmp", "==", emp).get()]);
  const byId = new Map([...got.docs, ...sent.docs].map((d) => [d.id, d]));
  const empName = person.get("name") || `#${emp}`;
  await col("messageReviews", test).add({ by: me.employeeNumber, byName: me.name, emp, empName, reason, atMs: Date.now(), at: FieldValue.serverTimestamp() });
  await auditLog.add({ type: "viewed messages", kind: "messages", recordId: emp, by: me.employeeNumber, at: FieldValue.serverTimestamp(), reason, count: byId.size, ...(test ? { test: true } : {}) });
  const messages = [...byId.values()].map((d) => {
    const m = d.data();
    return { id: d.id, fromName: m.fromName, fromEmp: m.fromEmp, to: m.to, text: m.text, atMs: m.atMs, delivered: (m.recipients || []).includes(emp) || m.fromEmp === emp, kind: m.kind };
  }).sort((a, b) => b.atMs - a.atMs);
  return { empName, messages };
});

// HR access: the log of message reviews (last 50).
exports.hrMessageReviewLog = onCall(async (req) => {
  await requireHr(req);
  const test = isTest(req);
  const snap = await col("messageReviews", test).orderBy("atMs", "desc").limit(50).get();
  return { reviews: snap.docs.map((d) => ({ id: d.id, byName: d.get("byName"), empName: d.get("empName"), reason: d.get("reason"), atMs: d.get("atMs") })) };
});
// ---------------------------------------------------------------------------
// Documents & forms (Chris, 10-26-2026, Decision 116). Rules in documents.js. Every master copy has a department;
// Admins edit everything, a department head edits their department's items, and the server checks it on every save.
//   meta/docDepartments          departments { "<item key>": departmentId } (Admins change it; missing = the default)
//   docRevisions/{key}/revs/{n}  each load of the map file, the Crew Board stations file, and the training data
//                                (who, when, what); the file itself is kept in Storage at doc-revisions/{key}/{n}.json
// ---------------------------------------------------------------------------

const docDeptsDoc = db.collection("meta").doc("docDepartments");
const docRevisions = db.collection("docRevisions");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const toMs = (t) => (t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : typeof t === "number" ? t : null);

async function docContext() {
  const [o, set] = await Promise.all([orgData(), docDeptsDoc.get()]);
  return { departments: o.departments, heads: o.headIds, people: o.people, set: set.get("departments") || {} };
}

// The person, if they may change this item: an Admin, or the head of its department. A new item passes
// { newDept } (the department picked when adding; missing = the default for its kind).
async function requireDocEditor(req, key, { newDept } = {}) {
  const me = await requireMember(req);
  if (!docsLib.parseKey(key)) throw new HttpsError("invalid-argument", "Unknown document.");
  const ctx = await docContext();
  if (newDept && !ctx.departments.some((d) => d.id === newDept && d.active !== false)) throw new HttpsError("invalid-argument", "Pick a department from the list.");
  const dept = newDept || docsLib.departmentOf(key, ctx.set, ctx.departments);
  if (!docsLib.canEdit(me, dept, ctx.heads)) {
    const name = ctx.departments.find((d) => d.id === dept)?.name;
    throw new HttpsError("permission-denied", name ? `Only Admins and the head of ${name} can change this.` : "Only Admins can change this (it has no department head).");
  }
  return { me, dept };
}

// Keeps a copy of a loaded file as the item's next revision (Decision 116 b). Returns the revision number.
async function saveLoadRevision(key, payload, me, summary) {
  const ref = docRevisions.doc(key);
  const rev = ((await ref.get()).get("rev") || 0) + 1;
  const path = `doc-revisions/${key}/${rev}.json`;
  await getStorage().bucket().file(path).save(JSON.stringify(payload), { contentType: "application/json", resumable: false });
  const entry = { rev, at: FieldValue.serverTimestamp(), by: me.employeeNumber, byName: me.name, summary, path };
  const b = db.batch();
  b.set(ref, entry);
  b.set(ref.collection("revs").doc(String(rev)), entry);
  await b.commit();
  return rev;
}

// Admins and department heads: every item they can change, with its department, revision, and where it's used.
exports.documentsList = onCall(async (req) => {
  const me = await requireMember(req);
  const ctx = await docContext();
  const admin = me.roles.includes("admin");
  const mine = docsLib.myDepartments(me, ctx.departments.filter((d) => d.active !== false), ctx.heads);
  if (!admin && !mine.length) throw new HttpsError("permission-denied", "Documents & forms is for Admins and department heads.");
  const [forms, checks, refs, layout, crew, training, revs, live] = await Promise.all([
    formTemplates.get(), checklistTemplates.get(), refDocs.get(), db.collection("floorMap").doc("layout").get(),
    crewStationsDoc.get(), db.collection("trainingRef").doc("data").get(), docRevisions.get(), liveUnits(),
  ]);
  const revOf = new Map(revs.docs.map((d) => [d.id, d.data()]));
  const units = new Map();
  for (const u of live.units) units.set(u.templateId, (units.get(u.templateId) || 0) + 1);
  const items = [];
  const push = (key, x) => items.push({ key, kind: docsLib.parseKey(key).kind, department: docsLib.departmentOf(key, ctx.set, ctx.departments), ...x });
  for (const d of forms.docs) {
    const t = d.data();
    push(`form:${d.id}`, { id: d.id, name: t.name, rev: t.rev || 1, at: toMs(t.revAt), byName: t.revByName || "", note: t.revNote || "", active: t.active !== false, usedOn: docsLib.usedOn("form", { formKind: t.kind }) });
  }
  for (const d of checks.docs) {
    const t = d.data();
    push(`checklist:${d.id}`, { id: d.id, name: t.name, rev: t.rev || null, at: toMs(t.updatedAt), byName: "", note: plural((t.items || []).length, "item"), active: t.active !== false, usedOn: docsLib.usedOn("checklist", { units: units.get(d.id) || 0 }) });
  }
  for (const d of refs.docs) {
    const t = d.data();
    push(`refdoc:${d.id}`, { id: d.id, name: t.name, rev: t.rev || 1, at: toMs(t.updatedAt), byName: t.updatedByName || "", note: t.fileName || "", active: t.active !== false, url: t.url || null, fileKind: t.kind || "pdf", usedOn: docsLib.usedOn("refdoc") });
  }
  const loaded = (key, name, exists, loadedAt, note) => {
    const r = revOf.get(key);
    push(key, { id: key, name, rev: r?.rev || null, at: toMs(r?.at) || toMs(loadedAt), byName: r?.byName || "", note: exists ? r?.summary || note : "Not loaded yet", active: true, loaded: exists, usedOn: docsLib.usedOn(key) });
  };
  const L = layout.exists ? layout.data() : null;
  loaded("map", "Shop map file", !!L, L?.importedAt, L ? `${(L.zones || []).length} areas` : "");
  const setup = crew.exists ? crew.get("setup") : null;
  loaded("stations", "Crew Board stations file", !!setup, crew.exists ? crew.get("updatedAt") : null, setup ? `${(setup.stations || []).length} stations` : "");
  loaded("training", "Training data", training.exists, training.exists ? training.get("importedAt") : null, training.exists ? `data ${training.get("rev") || "—"}` : "");
  const shown = items.filter((i) => admin || mine.includes(i.department));
  const nameOf = new Map(ctx.people.map((p) => [p.id, p.name]));
  return {
    admin, mine,
    departments: ctx.departments.filter((d) => d.active !== false).map((d) => ({ id: d.id, name: d.name, head: ctx.heads.get(d.id) ? nameOf.get(ctx.heads.get(d.id)) : null })),
    items: shown.sort((a, b) => String(a.name).localeCompare(String(b.name))),
  };
});

// Admins and the item's department head: its revisions, newest first — { key } → { history: [{ rev, at, byName, note }] }.
exports.docHistory = onCall(async (req) => {
  const key = String(req.data?.key || "");
  await requireDocEditor(req, key);
  const { kind, id } = docsLib.parseKey(key);
  let history = [];
  if (kind === "form") {
    const snap = await formTemplates.doc(id).collection("revisions").orderBy("rev", "desc").limit(50).get();
    history = snap.docs.map((d) => ({ rev: d.get("rev"), at: toMs(d.get("revAt")), byName: d.get("revByName") || "", note: d.get("revNote") || "" }));
  } else if (kind === "checklist") {
    const [snap, people] = await Promise.all([checklistTemplates.doc(id).collection("revisions").orderBy("rev", "desc").limit(50).get(), peopleList()]);
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    history = snap.docs.map((d) => ({ rev: d.get("rev"), at: toMs(d.get("savedAt")), byName: d.get("savedByName") || nameOf.get(d.get("savedBy")) || "", note: plural((d.get("items") || []).length, "item") }));
  } else if (kind === "refdoc") {
    const snap = await refDocs.doc(id).get();
    history = (snap.get("history") || []).slice().reverse().map((h) => ({ rev: h.rev, at: toMs(h.at), byName: h.by || "", note: h.fileName || "", url: h.url || null }));
  } else {
    const snap = await docRevisions.doc(key).collection("revs").orderBy("rev", "desc").limit(50).get();
    history = snap.docs.map((d) => ({ rev: d.get("rev"), at: toMs(d.get("at")), byName: d.get("byName") || "", note: d.get("summary") || "" }));
  }
  return { history };
});

// Admins: { key, department } — move an item to another department (null = back to the default).
exports.docSetDepartment = onCall(async (req) => {
  const adminNumber = await requireAdmin(req);
  const key = String(req.data?.key || "");
  if (!docsLib.parseKey(key)) throw new HttpsError("invalid-argument", "Unknown document.");
  const dept = req.data?.department ? String(req.data.department) : null;
  const ctx = await docContext();
  if (dept && !ctx.departments.some((d) => d.id === dept && d.active !== false)) throw new HttpsError("invalid-argument", "Pick a department from the list.");
  await keepHistoryNow(docDeptsDoc, { [`departments.${key}`]: dept || FieldValue.delete() }, adminNumber);
  await docDeptsDoc.set({ departments: { [key]: dept || FieldValue.delete() }, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminNumber }, { merge: true });
  await auditLog.add({ type: "updated", kind: "document department", recordId: key, by: adminNumber, at: FieldValue.serverTimestamp(), department: dept });
  return { department: dept || docsLib.departmentOf(key, { ...ctx.set, [key]: undefined }, ctx.departments) };
});
