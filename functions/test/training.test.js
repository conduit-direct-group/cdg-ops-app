const test = require("node:test");
const assert = require("node:assert");
const t = require("../training");

const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("person ids are stable, safe, and different for different names", () => {
  assert.strictEqual(t.personId("Pat Doe"), t.personId("  Pat Doe "));
  assert.match(t.personId("Pat \"PJ\" O'Doe"), /^p-[a-z0-9-]+-[a-f0-9]{6}$/);
  assert.notStrictEqual(t.personId("Pat Doe"), t.personId("Pat Do"));
});

test("dates: today in plant time, refreshers due a year later", () => {
  assert.strictEqual(t.todayIso(Date.UTC(2026, 9, 20, 3)), "2026-10-19"); // 10 pm in Chicago
  assert.strictEqual(t.addYear("2026-02-28"), "2027-02-28");
  const base = { loto: "2025-10-01", eap: "2026-01-01", ld08: "2024-01-01" };
  assert.deepStrictEqual(t.refreshersOverdue("Line Operator I", base, {}, "2026-10-19"), ["loto"]);
  assert.deepStrictEqual(t.refreshersOverdue("Lead Operator", base, { loto: "2026-10-19" }, "2026-10-19"), ["ld08"]);
});

test("who may sign: same rules as the tablet", () => {
  const trainer = { id: "t1", employee: "Sam Lee", coordinator: false };
  assert.strictEqual(t.gate({ trainer, traineeName: "Pat", overdue: [], trainerLd01: 3 }).ok, true);
  assert.match(t.gate({ trainer, traineeName: "Sam Lee", overdue: [], trainerLd01: 4 }).msg, /own competency/);
  assert.match(t.gate({ trainer, traineeName: "Pat", overdue: [], trainerLd01: 2 }).msg, /LD-01 is Level 2/);
  assert.match(t.gate({ trainer: { ...trainer, employee: null }, traineeName: "Pat", overdue: [], trainerLd01: 0 }).msg, /Link your roster/);
  assert.match(t.gate({ trainer: { coordinator: true }, traineeName: "Pat", overdue: ["loto"], trainerLd01: 0 }).msg, /Refresher overdue/);
  assert.strictEqual(t.gate({ trainer: { coordinator: true }, traineeName: "Pat", overdue: [], trainerLd01: 0 }).ok, true);
});

test('levels: workbook levels become imported records; level = records signed', () => {
  const r = t.seedRecords({ 'C-01': 2, bad: 3 });
  assert.deepStrictEqual(Object.keys(r), ['C-01']);
  assert.deepStrictEqual(r['C-01'].map((x) => [x.level, x.imported]), [[1, true], [2, true]]);
  assert.strictEqual(t.levelOf(r, 'C-01'), 2);
  assert.strictEqual(t.levelOf(null, 'C-01'), 0);
});

test("signing a higher level fills in the skipped ones", () => {
  const out = t.signedRecords([{ level: 1 }], 3, { trainer: "Sam", sigId: "x" });
  assert.deepStrictEqual(out.map((r) => [r.level, r.filled]), [[1, undefined], [2, 3], [3, undefined]]);
  assert.strictEqual(out[2].sigId, "x");
});

test("reference data: PINs are removed from the workbook's Trainers tab", () => {
  const data = { modules: [{ code: "C-01", title: "x", series: "C" }], reqMin: {}, roster: [{ name: "A" }], trainerInfo: [{ name: "A", pin: "1234", fields: [{ k: "PIN", v: "1234" }, { k: "Role", v: "Lead" }] }] };
  const lib = { guides: {}, sops: {}, moduleSops: {}, kc: {} };
  const r = t.cleanReference(data, lib);
  assert.ok(!r.error);
  assert.strictEqual(r.data.trainerInfo[0].pin, undefined);
  assert.deepStrictEqual(r.data.trainerInfo[0].fields, [{ k: "Role", v: "Lead" }]);
  assert.match(t.cleanReference({}, lib).error, /CDG_DATA/);
  assert.deepStrictEqual(Object.keys(t.libPieces(lib)).sort(), ["lib-guides", "lib-kc", "lib-rest", "lib-sops"]);
});

test("backup: signatures move out of the records, PINs stay only on trainers, counts add up", () => {
  const backup = {
    tablet: {
      trainers: [{ id: "jul", name: "Coord", pin: "4321" }, { id: "t1", name: "Sam", role: "Trainer", pin: "12" }, { id: "bad id!", name: "X" }],
      records: { Pat: { "C-01": [{ level: 1, imported: true }, { level: 2, trainer: "Sam", trainerId: "t1", sig: PNG, initials: "SL" }], "nope": [{}] } },
      kcAtt: { Pat: { "C-01": [{ score: 9, total: 10, pass: true }] } },
      checks: { Pat: { "C-01": { 1: true } } },
      todos: [{ id: "a", text: "Do it" }],
    },
    queue: [{ t: "level", name: "Pat", code: "C-01", level: 2 }, { t: "trainer", name: "Sam", pin: "1234" }],
    wbConfig: { clientId: "c", tenantId: "t", link: "https://x.sharepoint.com/y" },
  };
  const s = t.splitBackup(backup);
  assert.ok(!s.error);
  assert.deepStrictEqual(s.trainers.map((x) => [x.id, x.coordinator, x.pin]), [["jul", true, "4321"], ["t1", false, null]]);
  const rec = s.people.Pat.records["C-01"][1];
  assert.strictEqual(rec.sig, undefined);
  assert.strictEqual(rec.initials, undefined);
  assert.strictEqual(s.sigs[rec.sigId], PNG);
  assert.strictEqual(rec.sigId, t.sigId(PNG));
  assert.deepStrictEqual(Object.keys(s.people.Pat.records), ["C-01"]);
  assert.deepStrictEqual(s.queue, [{ t: "level", name: "Pat", code: "C-01", level: 2 }]);
  assert.ok(t.cleanPerson(s.people.Pat));
  assert.strictEqual(t.cleanPerson({ records: { "C-01": [{ sig: PNG }] } }), null);
  assert.deepStrictEqual(t.backupCounts(s), { trainers: 2, trainersWithPin: 1, people: 1, signOffs: 1, signatures: 1, knowledgeChecks: 1, todos: 1, unsentWorkbookChanges: 1 });
  assert.match(t.splitBackup({}).error, /backup/);
});

test("workbook data from a tablet: PINs dropped, levels kept to 0-4", () => {
  const wb = t.cleanWorkbook({ roster: [{ name: "Pat", team: "Team A" }], levels: { Pat: { "C-01": 3, "C-02": 9, bad: 1 } }, trainers: [{ name: "Sam", pin: "1234" }], oldNums: false });
  assert.deepStrictEqual(wb.levels.Pat, { "C-01": 3, "C-02": 4 });
  assert.strictEqual(wb.trainerInfo[0].pin, undefined);
  assert.strictEqual(wb.roster[0].team, "Team A");
  assert.strictEqual(t.cleanWorkbook({}), null);
});

test("signature pictures: PNG data only", () => {
  assert.ok(t.isSigImage(PNG));
  assert.ok(!t.isSigImage("data:image/svg+xml;base64,AAAA"));
  assert.ok(!t.isSigImage("javascript:alert(1)"));
});

test("workbook jobs match what the old tablet sent", () => {
  assert.deepStrictEqual(t.workbookJob({ op: "revoke", name: "Pat", code: "C-01", level: 2 }), { t: "level", name: "Pat", code: "C-01", level: 1 });
  assert.strictEqual(t.workbookJob({ op: "check" }), null);
});

test("module codes: letters, number, and an optional small letter (L-03a)", () => {
  for (const c of ["C-01", "LD-08", "L-03a", "Q-12"]) assert.ok(t.isCode(c), c);
  for (const c of ["c-01", "L-03ab", "L03", "<x>"]) assert.ok(!t.isCode(c), c);
});
