// Training (the training team's trainer app, moved into CDG Ops) — server functions.
//
// Data (test site: the same names with test_ in front, except trainingRef and the workbook queue):
//   trainingRef/{data, lib-*, entra}   the original app's reference data (roster, modules, SOP and guide text),
//                                      loaded by an admin from the original file. Stored as text. Real data only.
//   trainingTrainers/{id}              trainer profiles: name, role, coordinator, linked roster record
//   trainingPins/{id}                  trainer 4-digit PINs, hashed (phones can never read these)
//   trainingSessions/{hash}            "this trainer unlocked on this login" — expires after 15 idle minutes
//   trainingPeople/{personId}          one trainee: sign-off records, checklists, knowledge checks, safety
//   trainingSigs/{sigId}               signature pictures (PNG), stored once each
//   trainingShared/state               coordinator to-dos, workbook file status, workbook data pulled on a tablet,
//                                      Microsoft sign-in settings
//   trainingWbQueue/{auto}             changes waiting to be written to the CDGTRN0009 workbook (live only)
//
// A trainer unlocks with their own 4-digit PIN (checked here, 5 wrong tries = locked 15 minutes). Every change
// carries the trainer's session, so the server knows which trainer did it — the tablet can't claim to be someone else.

const crypto = require("node:crypto");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { FieldValue } = require("firebase-admin/firestore");
const pin = require("./pin");
const T = require("./training");
const signoffsLib = require("./signoffs");

module.exports = function trainingApi({ db, auditLog, requireMember, requireAdmin, isTest, col, requireDocEditor, saveLoadRevision }) {
  const refCol = db.collection("trainingRef");
  const queueCol = db.collection("trainingWbQueue");
  const C = (name, test) => col(name, test);

  const WEAK_4 = /^(\d)\1{3}$|^(0123|1234|2345|3456|4567|5678|6789|9876|8765|7654|6543|5432|4321|3210)$/;

  // --- sessions ---------------------------------------------------------------------------------------

  const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

  async function newSession(trainerId, emp, test) {
    const token = crypto.randomBytes(24).toString("hex");
    const now = Date.now();
    await C("trainingSessions", false).doc(hashToken(token)).set({ trainerId, emp, test, createdMs: now, lastMs: now });
    return token;
  }

  // The trainer behind a request, from its session. Refreshes the idle timer.
  async function requireTrainer(req) {
    const me = await requireMember(req);
    const test = isTest(req);
    const token = req.data?.token;
    if (typeof token !== "string" || token.length > 100) throw new HttpsError("unauthenticated", "Locked. Enter your trainer PIN.");
    const ref = C("trainingSessions", false).doc(hashToken(token));
    const snap = await ref.get();
    const s = snap.exists ? snap.data() : null;
    const now = Date.now();
    if (!s || s.emp !== me.employeeNumber || s.test !== test || now - s.lastMs > T.SESSION_IDLE_MS || now - s.createdMs > T.SESSION_MAX_MS) {
      if (s) await ref.delete();
      throw new HttpsError("unauthenticated", "Locked. Enter your trainer PIN.");
    }
    const tSnap = await C("trainingTrainers", test).doc(s.trainerId).get();
    if (!tSnap.exists || tSnap.get("active") === false) throw new HttpsError("permission-denied", "This trainer profile is turned off.");
    await ref.update({ lastMs: now });
    return { me, test, trainer: { id: tSnap.id, ...tSnap.data() } };
  }

  // Checks a trainer's PIN with the same lockout as login PINs (5 wrong tries → 15 minutes).
  async function checkTrainerPin(trainerId, entered, test) {
    const ref = C("trainingPins", test).doc(trainerId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, noPin: true };
      const rec = snap.data();
      const now = Date.now();
      const lock = pin.lockStatus(rec, now);
      if (lock.locked) return { ok: false, minutesLeft: lock.minutesLeft };
      if (!(await pin.pinMatches(entered, rec))) {
        const next = pin.afterWrongPin(rec, now);
        tx.update(ref, { wrongCount: next.wrongCount, lockedUntilMs: next.lockedUntilMs });
        return { ok: false, minutesLeft: next.justLocked ? pin.LOCK_MINUTES : undefined };
      }
      if (rec.wrongCount || rec.lockedUntilMs) tx.update(ref, { wrongCount: 0, lockedUntilMs: null });
      return { ok: true };
    });
  }
  function pinFailure(r, who = "") {
    if (r.noPin) throw new HttpsError("failed-precondition", `${who || "This trainer"} has no PIN yet. An admin sets it in Admin → Training setup.`);
    if (r.minutesLeft) throw new HttpsError("resource-exhausted", `Too many wrong tries. Try again in ${r.minutesLeft} minutes, or ask an admin.`);
    throw new HttpsError("permission-denied", `Incorrect ${who ? who + "’s " : ""}PIN, try again`);
  }
  async function savePin(trainerId, value, test) {
    const hashed = await pin.hashPin(value);
    await C("trainingPins", test).doc(trainerId).set({ ...hashed, wrongCount: 0, lockedUntilMs: null, updatedAt: FieldValue.serverTimestamp() });
  }

  // --- reference data and trainee records ---------------------------------------------------------------

  // The original app's data, with the latest workbook data pulled on a tablet laid over it (same rule as the tablet).
  async function loadBase(test, tx) {
    const refs = [refCol.doc("data"), C("trainingShared", test).doc("state")];
    const [d, s] = tx ? await tx.getAll(...refs) : await db.getAll(...refs);
    if (!d.exists) throw new HttpsError("failed-precondition", "The training data isn't loaded yet (Admin → Training setup).");
    const data = JSON.parse(d.get("json"));
    const shared = s.exists ? s.data() : {};
    const wb = shared.wbData ? JSON.parse(shared.wbData) : null;
    if (wb?.roster?.length && wb.rev === data.rev) Object.assign(data, wb);
    return { data, shared };
  }
  function rosterEntry(data, name) {
    const r = (data.roster || []).find((x) => x.name === name);
    if (!r) throw new HttpsError("not-found", `${name} isn't on the training roster.`);
    return r;
  }
  function personOf(snap, name, data) {
    const p = snap.exists ? snap.data() : { name };
    if (!p.records) p.records = T.seedRecords((data.levels || {})[name]);
    return p;
  }
  const personRef = (name, test) => C("trainingPeople", test).doc(T.personId(name));
  const position = (r, p) => (p.posOv && p.posOv.from === r.position ? p.posOv.to : r.position);
  const isCoordinator = (t) => t.coordinator === true;
  function requireCoordinator(t) {
    if (!isCoordinator(t)) throw new HttpsError("permission-denied", "Only the Training & Safety Coordinator can do this.");
  }
  function requireModule(data, code) {
    if (!T.isCode(code) || !(data.modules || []).some((m) => m.code === code)) throw new HttpsError("invalid-argument", "Unknown module.");
  }
  function wbConfigured(shared, entra) {
    const c = { ...(entra || {}), ...Object.fromEntries(Object.entries(shared.wbConfig || {}).filter(([, v]) => v)) };
    return !!(c.clientId && c.tenantId && c.link);
  }

  // --- everyone signed in -------------------------------------------------------------------------------

  // { trainerId, pin } → { token }. Unlocks the trainer on this login (also used after the tablet locks itself).
  const trainingUnlock = onCall(async (req) => {
    const me = await requireMember(req);
    const test = isTest(req);
    const id = req.data?.trainerId;
    if (!T.isTrainerId(id) || !T.isPin(req.data?.pin)) throw new HttpsError("invalid-argument", "Enter your 4-digit PIN");
    const t = await C("trainingTrainers", test).doc(id).get();
    if (!t.exists || t.get("active") === false) throw new HttpsError("not-found", "That trainer profile is turned off.");
    const r = await checkTrainerPin(id, req.data.pin, test);
    if (!r.ok) pinFailure(r);
    return { token: await newSession(id, me.employeeNumber, test) };
  });

  // { token } — lock now (the session ends; the PIN is needed again).
  const trainingLock = onCall(async (req) => {
    await requireMember(req);
    if (typeof req.data?.token === "string") await C("trainingSessions", false).doc(hashToken(req.data.token)).delete();
    return { ok: true };
  });

  // { name, role, pin, employee, info } → { id, token }. Anyone signed in can add a trainer profile (as on the
  // tablet). New profiles are trainers, never coordinators; they can sign once their LD-01 is high enough.
  const trainingAddTrainer = onCall(async (req) => {
    const me = await requireMember(req);
    const test = isTest(req);
    const name = T.cleanName(req.data?.name);
    const p = req.data?.pin;
    if (!name) throw new HttpsError("invalid-argument", "Enter a name");
    if (!T.isPin(p)) throw new HttpsError("invalid-argument", "Choose a 4-digit PIN");
    if (WEAK_4.test(p)) throw new HttpsError("invalid-argument", "That PIN is too easy to guess. Pick another.");
    const employee = req.data?.employee ? T.cleanName(req.data.employee) : null;
    if (employee) rosterEntry((await loadBase(test)).data, employee);
    const info = Array.isArray(req.data?.info) ? T.stripPin({ fields: req.data.info.slice(0, 40) }).fields
      .filter((f) => T.isObj(f) && typeof f.k === "string" && f.k.length < 100).map((f) => ({ k: f.k, v: String(f.v ?? "").slice(0, 500) })) : null;
    const id = `t${Date.now()}`;
    await C("trainingTrainers", test).doc(id).set({
      name, role: T.cleanName(req.data?.role) || "Trainer", coordinator: false, employee, info, active: true, hasPin: true,
      createdAt: FieldValue.serverTimestamp(), createdBy: me.employeeNumber,
    });
    await savePin(id, p, test);
    await auditLog.add({ type: "created", kind: "trainer", recordId: id, by: me.employeeNumber, at: FieldValue.serverTimestamp(), name, test });
    return { id, token: await newSession(id, me.employeeNumber, test) };
  });

  // { token, op, … } — every change a trainer makes. See the switch below for each op.
  const trainingSave = onCall({ memory: "512MiB" }, async (req) => {
    const { me, test, trainer } = await requireTrainer(req);
    // The sign-off rule (Decision 108): the trainer's employee # (their profile's roster name → Admin → People
    // "Training record"), who was signed in on the tablet, and the module as it was signed.
    const empOfRosterName = async (rosterName) => {
      if (!rosterName) return null;
      const q = await db.collection("employees").where("trainingName", "==", rosterName).limit(1).get();
      return q.empty ? null : q.docs[0].id;
    };
    const logs = [];
    const d = req.data || {};
    const op = String(d.op || "");
    const now = Date.now();
    const today = T.todayIso(now);
    let job = null; // what to write to the workbook, if anything
    let result = { ok: true };

    // Changes to one trainee, in a transaction so two tablets can't overwrite each other.
    async function onPerson(fn) {
      const name = T.cleanName(d.name);
      if (!name) throw new HttpsError("invalid-argument", "Pick a trainee.");
      return db.runTransaction(async (tx) => {
        const { data, shared } = await loadBase(test, tx);
        const r = rosterEntry(data, name);
        const ref = personRef(name, test);
        const extraRefs = fn.reads ? fn.reads(data) : [];
        const [snap, ...more] = await tx.getAll(ref, ...extraRefs);
        const p = personOf(snap, name, data);
        const out = await fn(p, { data, shared, r, name, tx, more });
        tx.set(ref, { ...p, name, updatedAt: FieldValue.serverTimestamp(), updatedBy: trainer.id });
        return out;
      });
    }
    const setIn = (p, field, code, key, value) => {
      const all = { ...(p[field] || {}) };
      const m = { ...(all[code] || {}) };
      if (value === undefined || value === null) delete m[key]; else m[key] = value;
      all[code] = m;
      p[field] = all;
    };

    switch (op) {
      // Sign a level: { name, code, level 1–4, sig (PNG), coordinatorId?, coPin?, csig? }
      case "sign": {
        const level = Number(d.level);
        if (![1, 2, 3, 4].includes(level)) throw new HttpsError("invalid-argument", "Pick a level.");
        if (!T.isSigImage(d.sig)) throw new HttpsError("invalid-argument", "Trainer signature required");
        const selfCo = level === 4 && isCoordinator(trainer);
        let co = null;
        if (level === 4 && !selfCo) {
          if (!T.isTrainerId(d.coordinatorId) || d.coordinatorId === trainer.id) throw new HttpsError("invalid-argument", "Coordinator countersign required");
          const cs = await C("trainingTrainers", test).doc(d.coordinatorId).get();
          if (!cs.exists || cs.get("active") === false || cs.get("coordinator") !== true) throw new HttpsError("invalid-argument", "Coordinator countersign required");
          if (!T.isPin(d.coPin)) throw new HttpsError("invalid-argument", "Coordinator PIN required");
          if (!T.isSigImage(d.csig)) throw new HttpsError("invalid-argument", "Coordinator signature required");
          const r = await checkTrainerPin(cs.id, d.coPin, test);
          if (!r.ok) pinFailure(r, "Coordinator");
          co = { id: cs.id, name: cs.get("name") };
        }
        const sigId = T.sigId(d.sig);
        const csigId = co ? T.sigId(d.csig) : selfCo ? sigId : null;
        const trainerEmp = await empOfRosterName(trainer.employee);
        const fn = async (p, { data, r, name, more }) => {
          requireModule(data, d.code);
          const cur = T.levelOf(p.records, d.code);
          if (level <= cur) throw new HttpsError("failed-precondition", `Level ${level} is already signed.`);
          const mine = trainer.employee ? personOf(more[0], trainer.employee, data) : null;
          const g = T.gate({
            trainer, traineeName: name, trainerLd01: mine ? T.levelOf(mine.records, "LD-01") : 0,
            overdue: T.refreshersOverdue(position(r, p), (data.refreshers || {})[name], p.refresh, today),
          });
          if (!g.ok) throw new HttpsError("failed-precondition", g.msg);
          const mod = (data.modules || []).find((m) => m.code === d.code);
          const moduleVersion = signoffsLib.contentVersion(mod);
          const entry = { trainer: trainer.name, trainerId: trainer.id, trainerEmp, signedInEmp: me.employeeNumber, moduleVersion, date: T.fmtDate(now), ts: now, sigId,
            ...(level === 4 ? { coordinator: selfCo ? trainer.name : co.name, coordinatorId: selfCo ? trainer.id : co.id, csigId } : {}) };
          logs.push({ kind: "training-level", refId: `${name}:${d.code}:${level}`, version: moduleVersion, emp: trainerEmp || `trainer:${trainer.id}`, name: trainer.name, method: "pin+drawn", signedOn: me.employeeNumber, trainee: name, code: d.code, level });
          p.records = { ...p.records, [d.code]: T.signedRecords(p.records[d.code], level, entry) };
        };
        fn.reads = () => (trainer.employee ? [personRef(trainer.employee, test)] : []);
        await onPerson(fn);
        const sigs = C("trainingSigs", test);
        await sigs.doc(sigId).set({ png: d.sig });
        if (co) await sigs.doc(csigId).set({ png: d.csig });
        job = T.workbookJob({ op, name: d.name, code: d.code, level });
        break;
      }
      // Remove the top signed level: { name, code, level } — the coordinator, or the trainer who signed it.
      case "revoke": {
        const level = Number(d.level);
        const revokedByEmp = await empOfRosterName(trainer.employee);
        await onPerson(async (p, { data }) => {
          requireModule(data, d.code);
          const list = p.records[d.code] || [];
          if (level !== list.length || level < 1) throw new HttpsError("failed-precondition", "Only the top signed level can be removed.");
          if (!isCoordinator(trainer) && list[level - 1].trainerId !== trainer.id) throw new HttpsError("permission-denied", "Only the coordinator or the trainer who signed it can remove it.");
          // Kept, not deleted (Decision 108): the removed level moves to p.revoked with who removed it and when.
          const removed = { ...list[level - 1], level, revokedBy: trainer.name, revokedById: trainer.id, revokedByEmp, revokedSignedInEmp: me.employeeNumber, revokedTs: now };
          p.revoked = { ...(p.revoked || {}), [d.code]: [...((p.revoked || {})[d.code] || []), removed] };
          p.records = { ...p.records, [d.code]: list.slice(0, level - 1) };
          logs.push({ kind: "training-level-removed", refId: `${d.name}:${d.code}:${level}`, version: list[level - 1].moduleVersion || signoffsLib.contentVersion(list[level - 1]), emp: revokedByEmp || `trainer:${trainer.id}`, name: trainer.name, method: "pin", signedOn: me.employeeNumber, trainee: d.name, code: d.code, level });
        });
        job = T.workbookJob({ op, name: d.name, code: d.code, level });
        break;
      }
      // Add a module outside the trainee's track, or take it off: { name, code, level (1–4) or null }
      case "extra": {
        const level = d.level == null || d.level === "" ? null : Number(d.level);
        if (level !== null && ![1, 2, 3, 4].includes(level)) throw new HttpsError("invalid-argument", "Pick a level.");
        await onPerson(async (p, { data }) => {
          requireModule(data, d.code);
          const all = { ...(p.extra || {}) };
          if (level === null) delete all[d.code]; else all[d.code] = level;
          p.extra = all;
        });
        job = T.workbookJob({ op, name: d.name, code: d.code, level });
        break;
      }
      // Move a trainee to the next position's track: { name, to }
      case "position": {
        const to = String(d.to || "");
        let from = "";
        await onPerson(async (p, { data, r }) => {
          if (!(data.reqMin || {})[to]) throw new HttpsError("invalid-argument", "Unknown position.");
          from = r.position;
          p.posOv = { from: r.position, to, date: today, by: trainer.name };
        });
        await C("trainingShared", test).doc("state").set({
          todos: FieldValue.arrayUnion({ id: `p${now}`, text: `Update ${d.name} to ${to} on the paper qualification card`, done: false, at: T.fmtDate(now), by: trainer.name }),
        }, { merge: true });
        result = { from };
        job = T.workbookJob({ op, name: d.name, to, date: today });
        break;
      }
      // Practical checklist step met / not met: { name, code, n, value }
      case "check": {
        await onPerson(async (p, { data }) => {
          requireModule(data, d.code);
          setIn(p, "checks", d.code, String(d.n).slice(0, 10), d.value ? true : null);
        });
        break;
      }
      // Knowledge check answer (tapping the same answer again clears it): { name, code, n, value }
      case "kcAns": {
        await onPerson(async (p, { data }) => {
          requireModule(data, d.code);
          setIn(p, "kcAns", d.code, String(d.n).slice(0, 10), d.value == null ? null : String(d.value).slice(0, 4));
        });
        break;
      }
      case "kcReset": {
        await onPerson(async (p, { data }) => {
          requireModule(data, d.code);
          const all = { ...(p.kcAns || {}) };
          delete all[d.code];
          p.kcAns = all;
        });
        break;
      }
      // Record a knowledge check attempt: { name, code, score, total, pass }
      case "kcAttempt": {
        await onPerson(async (p, { data }) => {
          requireModule(data, d.code);
          const score = Math.max(0, Math.round(Number(d.score) || 0)), total = Math.max(0, Math.round(Number(d.total) || 0));
          const att = { score, total, pass: d.pass === true, by: trainer.name, date: T.fmtDate(now) };
          p.kcAtt = { ...(p.kcAtt || {}), [d.code]: [...((p.kcAtt || {})[d.code] || []), att] };
          const ans = { ...(p.kcAns || {}) };
          delete ans[d.code];
          p.kcAns = ans;
        });
        break;
      }
      // C-02 safety orientation delivered today: { name }
      case "orient": {
        const verified = isCoordinator(trainer) ? "Yes" : "Pending";
        await onPerson(async (p) => {
          p.orient = { date: today, by: trainer.name, topics: "Yes", acks: "Yes", verified, nextReview: T.addYear(today) };
        });
        job = T.workbookJob({ op, name: d.name, date: today, by: trainer.name, verified });
        break;
      }
      // Coordinator verifies an orientation: { name }
      case "orientVerify": {
        requireCoordinator(trainer);
        await onPerson(async (p, { data, name }) => {
          const cur = p.orient || (data.safety || {})[name];
          if (!cur) throw new HttpsError("failed-precondition", "No orientation recorded yet.");
          p.orient = { ...cur, verified: "Yes" };
        });
        job = T.workbookJob({ op, name: d.name });
        break;
      }
      // Yearly refresher done today: { name, key }
      case "refresher": {
        if (!T.REFRESHERS.includes(d.key)) throw new HttpsError("invalid-argument", "Unknown refresher.");
        await onPerson(async (p) => {
          p.refresh = { ...(p.refresh || {}), [d.key]: today };
        });
        job = T.workbookJob({ op, name: d.name, key: d.key, date: today });
        break;
      }
      // Coordinator to-dos: { op: todoAdd, text } · todoToggle / todoDel { id } · todoClearDone
      case "todoAdd": case "todoToggle": case "todoDel": case "todoClearDone": {
        requireCoordinator(trainer);
        const ref = C("trainingShared", test).doc("state");
        await db.runTransaction(async (tx) => {
          const s = await tx.get(ref);
          let todos = (s.exists && s.get("todos")) || [];
          if (op === "todoAdd") {
            const text = String(d.text || "").trim().slice(0, 300);
            if (!text) throw new HttpsError("invalid-argument", "Type a to-do first.");
            todos = [{ id: now.toString(36), text, done: false, at: T.fmtDate(now), by: trainer.name }, ...todos];
          } else if (op === "todoToggle") todos = todos.map((x) => (x.id === d.id ? { ...x, done: !x.done } : x));
          else if (op === "todoDel") todos = todos.filter((x) => x.id !== d.id);
          else todos = todos.filter((x) => !x.done);
          tx.set(ref, { todos: todos.slice(0, 500) }, { merge: true });
        });
        break;
      }
      // Workbook data pulled from Microsoft or a workbook file on a tablet: { wb }. Saved for every tablet;
      // trainees' records are filled in up to the workbook's levels (as on the tablet).
      case "wbMerge": {
        const wb = T.cleanWorkbook(d.wb);
        if (!wb) throw new HttpsError("invalid-argument", "That workbook data doesn't look right.");
        const { data } = await loadBase(test);
        const people = await C("trainingPeople", test).get();
        const byName = new Map(people.docs.map((s) => [s.get("name"), s]));
        const writes = [];
        for (const name of new Set([...Object.keys(wb.levels), ...Object.keys(wb.extra)])) {
          const snap = byName.get(name);
          if (!snap) continue; // no records in the app yet: they're seeded from the workbook levels when first used
          const p = personOf(snap, name, data);
          let changed = false;
          const recs = { ...p.records };
          for (const [code, l] of Object.entries(wb.levels[name] || {})) {
            const a = recs[code] || [];
            if (l > a.length) { recs[code] = [...a, ...Array.from({ length: l - a.length }, (_, i) => ({ level: a.length + i + 1, trainer: "Workbook", date: "From CDGTRN0009", imported: true }))]; changed = true; }
          }
          const extra = { ...(wb.extra[name] || {}), ...(p.extra || {}) };
          if (JSON.stringify(extra) !== JSON.stringify(p.extra || {})) changed = true;
          if (changed) writes.push([snap.ref, { records: recs, extra }]);
        }
        for (let i = 0; i < writes.length; i += 400) {
          const b = db.batch();
          writes.slice(i, i + 400).forEach(([ref, v]) => b.update(ref, { ...v, updatedAt: FieldValue.serverTimestamp() }));
          await b.commit();
        }
        const keep = { rev: data.rev, roster: wb.roster.length ? wb.roster : data.roster, levels: wb.levels, safety: { ...(data.safety || {}), ...wb.safety }, refreshers: { ...(data.refreshers || {}), ...wb.refreshers }, trainerInfo: wb.trainerInfo || data.trainerInfo || [] };
        await C("trainingShared", test).doc("state").set({
          wbData: JSON.stringify(keep), ...(wb.oldNums === null ? {} : { wbOld: wb.oldNums }), lastLoaded: String(d.stamp || T.fmtDate(now)).slice(0, 40),
        }, { merge: true });
        result = { people: keep.roster.length };
        break;
      }
      // Coordinator: Microsoft sign-in settings for workbook sync: { clientId, tenantId, link }
      case "wbConfig": {
        requireCoordinator(trainer);
        const n = { clientId: String(d.clientId || "").trim(), tenantId: String(d.tenantId || "").trim(), link: String(d.link || "").trim() };
        const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!guid.test(n.clientId)) throw new HttpsError("invalid-argument", "Client ID should look like 1a2b3c4d-…");
        if (!guid.test(n.tenantId) && !/^[a-z0-9.-]+\.[a-z]+$/i.test(n.tenantId)) throw new HttpsError("invalid-argument", "Tenant ID should look like 1a2b3c4d-… or cdg.onmicrosoft.com");
        if (!/^https:\/\/[^\s]+sharepoint\.com\//i.test(n.link) || n.link.length > 2000) throw new HttpsError("invalid-argument", "Workbook link should start with https://…sharepoint.com/");
        await C("trainingShared", test).doc("state").set({ wbConfig: n }, { merge: true });
        break;
      }
      // Coordinator saved the updates file for the workbook: { stamp }
      case "fileSaved": {
        requireCoordinator(trainer);
        await C("trainingShared", test).doc("state").set({ fileDirty: 0, lastSaved: String(d.stamp || T.fmtDate(now)).slice(0, 40) }, { merge: true });
        break;
      }
      // A tablet signed in to Microsoft wrote these queued changes to the workbook: { ids }
      case "wbDone": {
        const ids = Array.isArray(d.ids) ? d.ids.filter((x) => typeof x === "string" && /^[A-Za-z0-9]{1,40}$/.test(x)).slice(0, 200) : [];
        const b = db.batch();
        ids.forEach((id) => b.delete(queueCol.doc(id)));
        await b.commit();
        break;
      }
      // A queued change that the workbook can't take (name or column missing): { id, failed }
      case "wbFailed": {
        if (typeof d.id === "string" && /^[A-Za-z0-9]{1,40}$/.test(d.id)) await queueCol.doc(d.id).set({ failed: String(d.failed || "").slice(0, 200), at: now }, { merge: true });
        break;
      }
      default:
        throw new HttpsError("invalid-argument", "Unknown change.");
    }

    // The sign-off log (Decision 108): name, employee #, time, and the module version signed.
    for (const e of new Map(logs.map((x) => [`${x.kind}|${x.refId}`, x])).values()) { // once each, even if the transaction re-ran
      const gap = signoffsLib.missing(e);
      if (gap) throw new HttpsError("internal", gap);
      await C("signoffs", test).add({ ...e, at: FieldValue.serverTimestamp(), ...(test ? { test: true } : {}) });
    }

    // The workbook gets the same change: through Microsoft sign-in (queue), or the coordinator's updates file.
    if (job) {
      const s = await C("trainingShared", test).doc("state").get();
      const entra = await refCol.doc("entra").get();
      const shared = s.exists ? s.data() : {};
      if (!test && wbConfigured(shared, entra.exists ? entra.data() : null)) await queueCol.add({ job, at: now, by: trainer.id });
      if (d.dirty === true) await C("trainingShared", test).doc("state").set({ fileDirty: FieldValue.increment(1) }, { merge: true });
    }
    return result;
  });

  // --- admins -------------------------------------------------------------------------------------------

  // { data, lib, entra } — the original app's CDG_DATA / CDG_LIB (Documents & forms → Training data → load the original
  // training app file). Saved as text; the workbook PIN column is dropped. Real data on both sites, like the Shop map.
  // Admins and the training data's department head (Decision 116); every load is kept as a revision.
  const adminImportTrainingData = onCall({ memory: "512MiB" }, async (req) => {
    const { me } = await requireDocEditor(req, "training");
    const adminNumber = me.employeeNumber;
    const { data, lib, error } = T.cleanReference(req.data?.data, req.data?.lib);
    if (error) throw new HttpsError("invalid-argument", error);
    const rev = await saveLoadRevision("training", { data, lib }, me, `data ${data.rev || "—"} · ${data.modules.length} modules · ${data.roster.length} on the roster`);
    const now = FieldValue.serverTimestamp();
    const b = db.batch();
    b.set(refCol.doc("data"), { json: JSON.stringify(data), rev: String(data.rev || ""), importedAt: now, importedBy: adminNumber });
    for (const [id, part] of Object.entries(T.libPieces(lib))) b.set(refCol.doc(id), { json: JSON.stringify(part), importedAt: now });
    const e = req.data?.entra;
    if (T.isObj(e)) b.set(refCol.doc("entra"), { clientId: String(e.clientId || "").slice(0, 100), tenantId: String(e.tenantId || "").slice(0, 100), link: String(e.link || "").slice(0, 2000) });
    await b.commit();
    await auditLog.add({ type: "imported", kind: "training data", recordId: "trainingRef", by: adminNumber, at: now, modules: data.modules.length, roster: data.roster.length, rev });
    return { modules: data.modules.length, roster: data.roster.length, sops: Object.keys(lib.sops).length, guides: Object.keys(lib.guides).length, rev };
  });

  // Import from the old tablet's backup file, in parts (the file can be several MB because of signatures):
  //   { part: "people", tablet: { records, checks, … for a few trainees } }   trainees + their signature pictures
  //   { part: "rest", tablet: { trainers, todos, … }, queue, wbConfig }       trainers (PINs hashed), to-dos, settings
  // Trainers keep their current PINs. On the test site everything goes to the test_ copies.
  const adminImportTrainingBackup = onCall({ memory: "1GiB", timeoutSeconds: 300 }, async (req) => {
    const adminNumber = await requireAdmin(req);
    const test = isTest(req);
    const part = req.data?.part;
    const split = T.splitBackup({ tablet: { trainers: [], records: {}, ...(req.data?.tablet || {}) }, queue: req.data?.queue, wbConfig: req.data?.wbConfig });
    if (split.error) throw new HttpsError("invalid-argument", split.error);
    const now = FieldValue.serverTimestamp();
    const writes = [];
    if (part === "people") {
      for (const [id, png] of Object.entries(split.sigs)) writes.push((b) => b.set(C("trainingSigs", test).doc(id), { png }));
      for (const [name, p] of Object.entries(split.people)) {
        const clean = T.cleanPerson(p);
        if (!clean) throw new HttpsError("invalid-argument", `${name}'s records in the backup don't look right.`);
        writes.push((b) => b.set(personRef(name, test), { name, ...clean, updatedAt: now, importedAt: now }));
      }
    } else if (part === "rest") {
      for (const t of split.trainers) {
        const { pin: p, id, ...rest } = t;
        writes.push((b) => b.set(C("trainingTrainers", test).doc(id), { ...rest, active: true, hasPin: !!p, importedAt: now }, { merge: true }));
      }
      const shared = { todos: split.todos, ...split.shared, ...(split.wbData ? { wbData: JSON.stringify(split.wbData) } : {}) };
      if (split.wbConfig.clientId || split.wbConfig.link) shared.wbConfig = split.wbConfig;
      writes.push((b) => b.set(C("trainingShared", test).doc("state"), shared, { merge: true }));
      if (!test) split.queue.forEach((job, i) => writes.push((b) => b.set(queueCol.doc(), { job, at: Date.now() + i, by: "import" })));
      for (const t of split.trainers.filter((x) => x.pin)) await savePin(t.id, t.pin, test);
    } else {
      throw new HttpsError("invalid-argument", "Unknown import step.");
    }
    for (let i = 0; i < writes.length; i += 300) {
      const b = db.batch();
      writes.slice(i, i + 300).forEach((w) => w(b));
      await b.commit();
    }
    if (part === "rest") await auditLog.add({ type: "imported", kind: "training backup", recordId: "trainingTrainers", by: adminNumber, at: now, test, trainers: split.trainers.length });
    return { people: Object.keys(split.people).length, signatures: Object.keys(split.sigs).length, trainers: split.trainers.length };
  });

  // { id, coordinator?, active?, pin? } — set a trainer as coordinator, turn a profile off/on, or set a new PIN.
  const adminSetTrainer = onCall(async (req) => {
    const adminNumber = await requireAdmin(req);
    const test = isTest(req);
    const id = req.data?.id;
    if (!T.isTrainerId(id)) throw new HttpsError("invalid-argument", "Unknown trainer.");
    const ref = C("trainingTrainers", test).doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Unknown trainer.");
    const upd = {};
    if (typeof req.data.coordinator === "boolean") { upd.coordinator = req.data.coordinator; upd.role = req.data.coordinator ? "Training & Safety Coordinator" : (snap.get("role") === "Training & Safety Coordinator" ? "Trainer" : snap.get("role")); }
    if (typeof req.data.active === "boolean") upd.active = req.data.active;
    if (req.data.pin != null) {
      if (!T.isPin(req.data.pin)) throw new HttpsError("invalid-argument", "The PIN must be 4 digits.");
      if (WEAK_4.test(req.data.pin)) throw new HttpsError("invalid-argument", "That PIN is too easy to guess. Pick another.");
      await savePin(id, req.data.pin, test);
      upd.hasPin = true;
    }
    await ref.update({ ...upd, updatedAt: FieldValue.serverTimestamp() });
    await auditLog.add({ type: "updated", kind: "trainer", recordId: id, by: adminNumber, at: FieldValue.serverTimestamp(), test,
      changes: Object.keys(upd).filter((k) => k !== "hasPin").concat(req.data.pin != null ? ["pin"] : []) });
    return { ok: true };
  });

  return { trainingUnlock, trainingLock, trainingAddTrainer, trainingSave, adminImportTrainingData, adminImportTrainingBackup, adminSetTrainer };
};
