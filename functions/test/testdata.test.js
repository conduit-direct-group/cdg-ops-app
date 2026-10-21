const test = require("node:test");
const assert = require("node:assert");
const t = require("../testdata");

// A stand-in database holding live and test records side by side.
function fakeDb(now) {
  const old = { toMillis: () => now - 2 * t.DAY_MS };
  const fresh = { toMillis: () => now - 3600000 };
  const store = {};
  const add = (col, id, updateTime) => (store[col] ||= []).push({ id, updateTime, ref: { col, id } });
  for (const [name] of t.TEST_COLLECTIONS) { add(name, "old", old); add(name, "new", fresh); }
  for (const live of ["issues", "requests", "announcements", "handoffs", "lineLogs", "shopTasks", "checklistUnits", "trainingWbQueue", "machineSpecs"]) add(live, "real", old);
  const opened = [];
  return {
    store, opened,
    collection(name) { opened.push(name); return { get: async () => ({ docs: [...(store[name] || [])] }) }; },
  };
}

test("only test_ collections can be cleaned", () => {
  for (const live of ["issues", "requests", "trainingWbQueue", "machineSpecs", "employees", "test", "test_", "TEST_issues", "test_issues/x", " test_issues"]) {
    assert.throws(() => t.onlyTest(live), /Refused/);
  }
  assert.strictEqual(t.onlyTest("test_issues"), "test_issues");
  assert.ok(t.TEST_COLLECTIONS.every(([name]) => name.startsWith("test_")));
});

test("cleanup never opens or deletes a live record", async () => {
  const now = Date.now();
  const db = fakeDb(now);
  const deleted = [];
  await t.clearTestData(db, { deleteDoc: async (ref) => deleted.push(ref) });
  assert.ok(db.opened.every((n) => n.startsWith("test_")), `opened: ${db.opened.join(", ")}`);
  assert.ok(deleted.every((r) => r.col.startsWith("test_")));
  assert.strictEqual(deleted.length, t.TEST_COLLECTIONS.length * 2);
});

test("daily run removes only test records unchanged for 24 hours; counting deletes nothing", async () => {
  const now = Date.now();
  const db = fakeDb(now);
  const deleted = [];
  const dry = await t.clearTestData(db, { olderThanMs: now - t.DAY_MS, dryRun: true, deleteDoc: async (ref) => deleted.push(ref) });
  assert.strictEqual(deleted.length, 0);
  assert.strictEqual(dry.total, t.TEST_COLLECTIONS.length);
  await t.clearTestData(db, { olderThanMs: now - t.DAY_MS, deleteDoc: async (ref) => deleted.push(ref) });
  assert.ok(deleted.every((r) => r.id === "old" && r.col.startsWith("test_")));
});
