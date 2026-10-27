// Decision 120: every overwriting edit keeps the old value (history.js). Made-up data.
const test = require("node:test");
const assert = require("node:assert");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const h = require("../history");

test("only changed fields are kept, old and new", () => {
  const d = h.diff({ carrier: "Acme", time: "08:00", ref: "PO 1" }, { carrier: "Acme", time: "09:30", ref: "PO 2", updatedAt: FieldValue.serverTimestamp() });
  assert.deepStrictEqual(d, { old: { time: "08:00", ref: "PO 1" }, new: { time: "09:30", ref: "PO 2" } });
});

test("nothing changed → nothing to keep", () => {
  assert.strictEqual(h.diff({ notes: "ok" }, { notes: "ok", updatedAt: FieldValue.serverTimestamp() }), null);
});

test("a new field counts as a change from empty", () => {
  assert.deepStrictEqual(h.diff({}, { comments: "Die swap" }), { old: { comments: null }, new: { comments: "Die swap" } });
});

test("a delete keeps the whole old record; times become text", () => {
  const d = h.diff({ minutes: 20, reason: "Die", by: "9001", at: Timestamp.fromMillis(0) }, null);
  assert.deepStrictEqual(d, { old: { minutes: 20, reason: "Die", by: "9001", at: "1970-01-01T00:00:00.000Z" }, new: null });
});

test("deleting one field and dotted keys compare against the nested value", () => {
  const d = h.diff({ none: { downtime: { by: "9001" } }, marks: { "9002": { status: "here" } } },
    { "none.downtime": FieldValue.delete(), "marks.9002": { status: "out", reason: "Sick" } });
  assert.deepStrictEqual(d.old, { "none.downtime": { by: "9001" }, "marks.9002": { status: "here" } });
  assert.deepStrictEqual(d.new, { "none.downtime": null, "marks.9002": { status: "out", reason: "Sick" } });
});

test("write-only markers (server time, array union) aren't compared", () => {
  assert.strictEqual(h.diff({ colors: ["Orange"] }, { colors: FieldValue.arrayUnion("Blue"), at: FieldValue.serverTimestamp() }), null);
});

test("huge values are noted, not copied", () => {
  const big = "x".repeat(25000);
  assert.match(h.diff({ json: "a" }, { json: big }).new.json, /too large/);
});
