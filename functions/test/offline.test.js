const test = require("node:test");
const assert = require("node:assert");
const o = require("../offline");

test("offline sign-off ids: device-made, safe characters only", () => {
  assert.strictEqual(o.cleanClientId("k3x9-2f8a_77QZ"), "k3x9-2f8a_77QZ");
  assert.strictEqual(o.cleanClientId("short"), null);
  assert.strictEqual(o.cleanClientId("has/slash/in-it"), null);
  assert.strictEqual(o.cleanClientId(42), null);
});

test("the time it was signed on the floor is kept only if believable", () => {
  const now = Date.UTC(2026, 9, 22, 18);
  assert.strictEqual(o.cleanSignedAt(now - 3600000, now), now - 3600000);
  assert.strictEqual(o.cleanSignedAt(now + 60000, now), now); // a clock a minute ahead counts as now
  assert.strictEqual(o.cleanSignedAt(now + 3600000, now), null); // an hour in the future
  assert.strictEqual(o.cleanSignedAt(now - o.MAX_AGE_MS - 1, now), null); // older than 3 days
  assert.strictEqual(o.cleanSignedAt(undefined, now), null);
  assert.strictEqual(o.cleanSignedAt("abc", now), null);
});

test("clock check (Decision 120): device time kept, flagged when ahead or far apart — never dropped", () => {
  const now = Date.UTC(2026, 9, 27, 15, 0, 0);
  assert.deepStrictEqual(o.clockCheck(now - 30000, now), { deviceAtMs: now - 30000, clockFlag: null });
  assert.deepStrictEqual(o.clockCheck(now + 60000, now), { deviceAtMs: now + 60000, clockFlag: null }); // a minute ahead is fine
  assert.deepStrictEqual(o.clockCheck(now + 3600000, now), { deviceAtMs: now + 3600000, clockFlag: "device-ahead" });
  assert.deepStrictEqual(o.clockCheck(now - 40 * 60000, now), { deviceAtMs: now - 40 * 60000, clockFlag: "far-apart" });
  assert.deepStrictEqual(o.clockCheck(now - o.MAX_AGE_MS - 1, now).clockFlag, "far-apart");
  assert.deepStrictEqual(o.clockCheck(undefined, now), { deviceAtMs: null, clockFlag: null });
});
