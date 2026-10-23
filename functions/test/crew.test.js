const test = require("node:test");
const assert = require("node:assert");
const c = require("../crew");

const P = (id, name, team, extra = {}) => ({ id, name, team, active: true, ...extra });
const people = [
  P("1", "Ann", "a"), P("2", "Bob", "a"), P("3", "Cal", "b"), P("4", "Dee", "a", { active: false }),
  P("5", "TEST Operator", "a"),
];
const isPractice = (n) => /^test\b/i.test(n);

test("the crew is the team on shift plus anyone added; off and practice accounts left out on the live site", () => {
  const list = c.crewList(people, { teamId: "a", added: ["3"], isPractice });
  assert.deepStrictEqual(list.map((p) => [p.id, p.added]), [["1", false], ["2", false], ["3", true]]);
  assert.ok(c.crewList(people, { teamId: "a", test: true, isPractice }).some((p) => p.id === "5"));
  assert.deepStrictEqual(c.crewList(people, { teamId: null, isPractice }), []);
});

test("marks: Here, Out with a reason, or cleared", () => {
  assert.deepStrictEqual(c.cleanMark({ status: "here" }), { mark: { status: "here" } });
  assert.deepStrictEqual(c.cleanMark({ status: "out", reason: "PTO" }), { mark: { status: "out", reason: "PTO" } });
  assert.deepStrictEqual(c.cleanMark({ status: null }), { mark: null });
  assert.ok(c.cleanMark({ status: "out" }).error);
  assert.ok(c.cleanMark({ status: "out", reason: "flu" }).error);
  assert.ok(c.cleanMark({ status: "late" }).error);
});

test("Out reasons only for Supervisors, the Production Manager, and Admins", () => {
  const list = c.crewList(people, { teamId: "a", isPractice });
  const marks = { 1: { status: "out", reason: "Sick", byName: "Lead" }, 2: { status: "here" } };
  assert.strictEqual(c.crewView(list, marks)[0].reason, undefined);
  assert.strictEqual(c.crewView(list, marks)[0].status, "out");
  assert.strictEqual(c.crewView(list, marks, { reasons: true })[0].reason, "Sick");
  assert.strictEqual(c.canSeeReasons(["lead"]), false);
  assert.strictEqual(c.canSeeReasons(["supervisor"]), true);
  assert.strictEqual(c.canMark(["operator"]), false);
  assert.strictEqual(c.canMark(["lead"]), true);
});

test("counts and due time (2 hours after the shift starts)", () => {
  const list = c.crewList(people, { teamId: "a", added: ["3"], isPractice });
  assert.deepStrictEqual(c.counts(list, { 1: { status: "here" }, 3: { status: "out" }, 9: { status: "here" } }), { here: 1, out: 1, unmarked: 1, total: 3 });
  assert.strictEqual(c.dueMs(1000), 1000 + 2 * 3600000);
  assert.strictEqual(c.docId("2026-10-23", "days"), "2026-10-23__days");
});
