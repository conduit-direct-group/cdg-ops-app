const test = require("node:test");
const assert = require("node:assert");
const r = require("../retentionrules");

const DAY = 86400000;

test("retention: Chris's periods are the defaults", () => {
  const p = r.periods();
  assert.deepStrictEqual(p, { checklists: 90, lineChecks: 730, reels: 730, downtime: 730, handoffs: 365, annSigs: null, injury: null, incidents: null, writeups: null });
  assert.strictEqual(r.periods({ handoffs: 730 }).handoffs, 730);
  assert.strictEqual(r.periods({ writeups: null }).writeups, null);
  assert.strictEqual(r.periodLabel(730), "2 years");
  assert.strictEqual(r.periodLabel(null), "Never delete");
});

test("retention: Admins change periods; write-ups and injury reports also need HR access", () => {
  const admin = { roles: ["admin"], hr: false };
  const adminHr = { roles: ["admin"], hr: true };
  assert.ok(r.canChange(r.byKey("handoffs"), admin));
  assert.ok(!r.canChange(r.byKey("writeups"), admin));
  assert.ok(!r.canChange(r.byKey("injury"), admin));
  assert.ok(r.canChange(r.byKey("injury"), adminHr));
  assert.ok(!r.canChange(r.byKey("handoffs"), { roles: ["supervisor"], hr: true }));
});

test("retention: only listed periods; injury reports never below 5 years", () => {
  assert.deepStrictEqual(r.cleanPeriod("handoffs", 730), { days: 730 });
  assert.deepStrictEqual(r.cleanPeriod("handoffs", "never"), { days: null });
  assert.match(r.cleanPeriod("handoffs", 45).error, /listed/);
  assert.match(r.cleanPeriod("nope", 90).error, /group/);
  assert.match(r.cleanPeriod("injury", 730).error, /at least 5 years/);
  assert.deepStrictEqual(r.cleanPeriod("injury", 1825), { days: 1825 });
});

test("retention: anything still open is never removed", () => {
  const ctx = { pendingSignoffs: new Set(["s1"]), openActionIncidents: new Set(["i2"]) };
  assert.ok(r.OPEN.shopTasks({}) && !r.OPEN.shopTasks({ check: { emp: "1" } }));
  assert.ok(r.OPEN.stationLists({ signed: {} }) && !r.OPEN.stationLists({ verified: {} }));
  assert.ok(r.OPEN.checklistSignoffs({ id: "s1" }, ctx) && !r.OPEN.checklistSignoffs({ id: "s2" }, ctx));
  assert.ok(r.OPEN.lineLogs({}) && !r.OPEN.lineLogs({ operatorSign: {} }));
  assert.ok(r.OPEN.reels({ status: "staged" }) && !r.OPEN.reels({ status: "done" }));
  assert.ok(r.OPEN.shiftReports({ signed: {} }) && !r.OPEN.shiftReports({ signed: {}, verified: {} }));
  assert.ok(r.OPEN.handoffs({ status: "sent" }) && r.OPEN.handoffs({ status: "received", needsVerify: true }));
  assert.ok(!r.OPEN.handoffs({ status: "received", needsVerify: false }) && !r.OPEN.handoffs({ status: "discarded" }));
  assert.ok(r.OPEN.incidents({ id: "i1", status: "actions" }, ctx) && r.OPEN.incidents({ id: "i2", status: "closed" }, ctx));
  assert.ok(!r.OPEN.incidents({ id: "i3", status: "closed", openActions: 0 }, ctx));
  assert.ok(r.OPEN.writeups({ status: "waiting" }) && !r.OPEN.writeups({ status: "refused" }));
});

test("retention: the cutoff day is in plant time", () => {
  const now = Date.UTC(2026, 9, 23, 3, 0); // Oct 23 03:00 UTC = Oct 22 evening in Chicago
  assert.strictEqual(r.cutoffDay(now, 0), "2026-10-22");
  assert.strictEqual(r.cutoffDay(now, 90), "2026-07-24");
});

test("retention: safety reports go only after closing + their period; injury reports never before 5 years", () => {
  const now = Date.UTC(2032, 0, 1);
  const closed = (years) => now - years * 365 * DAY - DAY;
  const p = r.periods({ incidents: 730, injury: 1825 });
  assert.ok(r.incidentMayGo({ type: "near-miss", closedAtMs: closed(3) }, p, now));
  assert.ok(!r.incidentMayGo({ type: "near-miss", closedAtMs: closed(1) }, p, now));
  assert.ok(!r.incidentMayGo({ type: "near-miss" }, p, now)); // never closed
  assert.ok(!r.incidentMayGo({ type: "injury", closedAtMs: closed(4) }, p, now));
  assert.ok(r.incidentMayGo({ type: "injury", closedAtMs: closed(5) }, p, now));
  // even if the saved setting were somehow lower, the 5-year floor holds
  assert.ok(!r.incidentMayGo({ type: "first-aid", closedAtMs: closed(3) }, { ...p, injury: 365 }, now));
  // never delete (the default) keeps everything
  assert.ok(!r.incidentMayGo({ type: "near-miss", closedAtMs: closed(9) }, r.periods(), now));
});
