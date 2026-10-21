const test = require("node:test");
const assert = require("node:assert");
const t = require("../trucks");

test("who posts, checks off, and views trucks", () => {
  const roles = [{ id: "shipping" }, { id: "admin" }, { id: "plant-manager" }, { id: "sales" }, { id: "supervisor", postTrucks: true }, { id: "operator" }];
  assert.strictEqual(t.canPostTrucks(roles, ["shipping"]), true);
  assert.strictEqual(t.canPostTrucks(roles, ["admin"]), false); // Admin views only until the Roles screen says otherwise
  assert.strictEqual(t.canPostTrucks(roles, ["supervisor"]), true);
  assert.strictEqual(t.canPostTrucks([{ id: "shipping", postTrucks: false }], ["shipping"]), false);
  assert.strictEqual(t.canCheckTrucks([{ id: "shipping", postTrucks: false }], ["shipping"]), true); // the yard still checks off
  assert.strictEqual(t.canCheckTrucks(roles, ["sales"]), false);
  assert.strictEqual(t.canViewTrucks(roles, ["sales"]), true);
  assert.strictEqual(t.canViewTrucks(roles, ["operator"]), false);
});

test("a truck needs a direction, day, carrier, and an order # or material", () => {
  const ok = t.cleanTruck({ dir: "in", date: "2026-10-21", carrier: "  ABC  Freight ", time: "07:30", forKind: "material", material: "Resin", notes: "Dock 2" });
  assert.deepStrictEqual(ok.truck, { date: "2026-10-21", dir: "in", carrier: "ABC Freight", time: "07:30", forKind: "material", ref: "", material: "Resin", notes: "Dock 2", search: "abc freight resin dock 2" });
  assert.match(t.cleanTruck({ date: "2026-10-21", carrier: "x", ref: "1" }).error, /Inbound or Outbound/);
  assert.match(t.cleanTruck({ dir: "out", date: "2026-10-21", carrier: "", ref: "1" }).error, /carrier/);
  assert.match(t.cleanTruck({ dir: "out", date: "2026-10-21", carrier: "X" }).error, /order/);
  assert.match(t.cleanTruck({ dir: "out", date: "2026-10-21", carrier: "X", ref: "1", time: "7pm" }).error, /time/);
  assert.match(t.cleanTruck({ dir: "out", date: "today", carrier: "X", ref: "1" }).error, /day/);
});

test("undo only within 5 minutes; copy from yesterday skips trucks already on today", () => {
  const now = Date.now();
  assert.strictEqual(t.canUndo({ status: "done", doneAtMs: now - 4 * 60000 }, now), true);
  assert.strictEqual(t.canUndo({ status: "done", doneAtMs: now - 6 * 60000 }, now), false);
  assert.strictEqual(t.canUndo({ status: "expected" }, now), false);
  const y = [
    { dir: "in", carrier: "ABC", forKind: "material", material: "Resin", time: "07:00", status: "done" },
    { dir: "out", carrier: "XYZ", forKind: "order", ref: "SO-1", status: "expected" },
    { dir: "out", carrier: "Gone", forKind: "order", ref: "SO-2", status: "removed" },
  ];
  const copies = t.copyTrucks(y, [{ dir: "out", carrier: "xyz", ref: "so-1", status: "expected" }], "2026-10-22");
  assert.deepStrictEqual(copies.map((c) => [c.carrier, c.date, c.time]), [["ABC", "2026-10-22", "07:00"]]);
});
