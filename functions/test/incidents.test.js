const test = require("node:test");
const assert = require("node:assert");
const i = require("../incidents");

const ctx = { lineIds: ["line-1"], stationIds: ["l1-extruder"], isOurFile: (u) => u.startsWith("https://ours/"), nowIso: "2026-10-21T12:00" };
const base = { type: "near-miss", occurredAt: "2026-10-21T09:30", place: { lineId: "line-1" }, what: "Forklift came around the corner fast" };

test("a report needs type, time, place, and what happened; only near misses can be anonymous", () => {
  const ok = i.cleanReport({ ...base, anonymous: true, witnesses: " Sam ", photos: ["https://ours/a.jpg"] }, ctx);
  assert.strictEqual(ok.report.anonymous, true);
  assert.strictEqual(ok.report.witnesses, "Sam");
  assert.strictEqual(i.cleanReport({ ...base, type: "property", anonymous: true }, ctx).report.anonymous, false);
  assert.match(i.cleanReport({ ...base, type: "fire" }, ctx).error, /kind/);
  assert.match(i.cleanReport({ ...base, occurredAt: "2026-10-22T09:30" }, ctx).error, /future/);
  assert.match(i.cleanReport({ ...base, place: {} }, ctx).error, /Where/);
  assert.strictEqual(i.cleanReport({ ...base, place: { label: "Break room" } }, ctx).report.place.label, "Break room");
  assert.match(i.cleanReport({ ...base, what: "x" }, ctx).error, /what happened/);
  assert.match(i.cleanReport({ ...base, photos: ["https://evil/x.jpg"] }, ctx).error, /photo/);
});

test("injury and first aid ask who was hurt; that is kept apart from the report", () => {
  assert.match(i.cleanReport({ ...base, type: "injury" }, ctx).error, /Who was hurt/);
  const r = i.cleanReport({ ...base, type: "first-aid", hurt: { name: "Pat Example", bodyPart: "Left hand" } }, ctx);
  assert.deepStrictEqual(r.hurt, { name: "Pat Example", bodyPart: "Left hand" });
  assert.strictEqual("hurt" in r.report, false);
});

test("follow-up: actions need owner and due date; OSHA days are whole numbers; status steps", () => {
  const owners = [{ id: "1001", name: "Pat Example", active: true }];
  assert.deepStrictEqual(i.cleanAction({ text: "Add a mirror at the corner", ownerEmp: "1001", due: "2026-10-28" }, owners).action, { text: "Add a mirror at the corner", ownerEmp: "1001", ownerName: "Pat Example", due: "2026-10-28" });
  assert.match(i.cleanAction({ text: "x", ownerEmp: "9", due: "2026-10-28" }, owners).error, /owns/);
  assert.match(i.cleanAction({ text: "x", ownerEmp: "1001" }, owners).error, /due/);
  assert.strictEqual(i.cleanOsha({ daysAway: "3", treatment: "medical-treatment" }).osha.daysAway, 3);
  assert.match(i.cleanOsha({ daysAway: "1.5" }).error, /whole/);
  assert.strictEqual(i.cleanOsha({ treatment: "magic" }).osha.treatment, "");
  assert.strictEqual(i.nextStatus("reported", { openActions: 0, started: false }), "reported");
  assert.strictEqual(i.nextStatus("reported", { openActions: 0, started: true }), "investigating");
  assert.strictEqual(i.nextStatus("investigating", { openActions: 2, started: true }), "actions");
  assert.strictEqual(i.nextStatus("actions", { openActions: 0, started: true }), "investigating");
  assert.strictEqual(i.nextStatus("closed", { openActions: 1, started: true }), "closed");
  assert.strictEqual(i.canFollow(["supervisor"]), false);
  assert.strictEqual(i.canFollow(["training-safety"]), true);
  assert.match(i.plantNowIso(Date.UTC(2026, 9, 21, 17, 5)), /^2026-10-21T12:05$/);
});

test("injury / first aid signatures: printed name and a drawn signature (PNG), witnesses up to 6", () => {
  const png = "data:image/png;base64," + "A".repeat(400);
  assert.deepStrictEqual(i.cleanSignature({ name: " Morgan Diaz ", png }).sig, { name: "Morgan Diaz", png });
  assert.match(i.cleanSignature({ name: "", png }, "Supervisor").error, /Supervisor: print/);
  assert.match(i.cleanSignature({ name: "X", png: "data:image/jpeg;base64,AAAA" }).error, /sign in the box/);
  assert.match(i.cleanSignature({ name: "X", png: "data:image/png;base64," + "A".repeat(300001) }).error, /too large/);
  const ok = i.cleanSignatures({ supervisor: { name: "Morgan", png }, witnesses: [{ name: "Sam", png }] });
  assert.strictEqual(ok.signatures.witnesses.length, 1);
  assert.match(i.cleanSignatures({ witnesses: [{ name: "Sam", png: "" }] }).error, /Witness 1/);
  assert.match(i.cleanSignatures({ witnesses: Array(7).fill({ name: "S", png }) }).error, /Up to 6/);
  assert.deepStrictEqual(i.SIG_TYPES, ["injury", "first-aid"]);
});
