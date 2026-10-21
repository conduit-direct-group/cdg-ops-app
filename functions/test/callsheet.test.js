const test = require("node:test");
const assert = require("node:assert");
const c = require("../callsheet");

// Made-up numbers only (555) — the real ones live in the database.
test("tap-to-call dials the main number, then the extension", () => {
  assert.strictEqual(c.telLink("319-555-0100", "4"), "tel:+13195550100,4");
  assert.strictEqual(c.telLink("(319) 555-0100"), "tel:+13195550100");
  assert.strictEqual(c.telLink("1 319 555 0100", "ext 5"), "tel:+13195550100,5");
});

test("call sheet: main number, extensions with kinds, on-call only with consent", () => {
  const { sheet } = c.cleanSheet({ mainNumber: "319-555-0100", entries: [{ ext: "5", title: "Maintenance", kind: "maintenance", lines: ["Try the Fix Library first", ""] }] });
  assert.deepStrictEqual([sheet.entries[0].ext, sheet.entries[0].kind, sheet.entries[0].lines], ["5", "maintenance", ["Try the Fix Library first"]]);
  assert.match(c.cleanSheet({ mainNumber: "555", entries: [] }).error, /10-digit/);
  assert.match(c.cleanSheet({ mainNumber: "319-555-0100", entries: [{ title: "Safety" }] }).error, /extension/);
  assert.match(c.cleanSheet({ mainNumber: "319-555-0100", entries: [], onCall: [{ name: "Pat", number: "319-555-0101" }] }).error, /agreed/);
  assert.strictEqual(c.cleanSheet({ mainNumber: "319-555-0100", entries: [], onCall: [{ name: "Pat", number: "319-555-0101", agreed: true, shift: "Days" }] }).sheet.onCall[0].shift, "Days");
});

test("line-down reminder after 1 hour, unless Maintenance was called since it went down", () => {
  const now = Date.now();
  const down = { "line-1": { since: now - 70 * 60000 }, "line-2": { since: now - 30 * 60000 }, "line-3": { since: now - 2 * 3600000 } };
  const taps = [{ kind: "maintenance", lineId: "line-3", atMs: now - 3600000 }, { kind: "production", lineId: "line-1", atMs: now - 60000 }];
  assert.deepStrictEqual(c.linesToRemind(down, taps, now).map((x) => x.lineId), ["line-1"]);
  assert.deepStrictEqual(c.linesToRemind(down, [{ kind: "maintenance", lineId: null, atMs: now - 1000 }], now), []);
  assert.deepStrictEqual(c.linesToRemind(down, [{ kind: "maintenance", lineId: "line-1", atMs: now - 3 * 3600000 }], now).map((x) => x.lineId), ["line-1", "line-3"]);
});
