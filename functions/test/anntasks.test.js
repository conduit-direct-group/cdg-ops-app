const test = require("node:test");
const assert = require("node:assert");
const t = require("../anntasks");

const P = (id, roles, team, extra = {}) => ({ id, name: `P${id}`, roles, team, active: true, ...extra });
const people = [
  P("1", ["lead"], "a"), P("2", ["operator"], "a"), P("3", ["operator"], "b"),
  P("4", ["supervisor"], "a", { supervisesTeams: ["b"] }), P("5", ["plant-manager"], null), P("6", ["lead"], "b"),
];

test("a lead assigns to people on their team; a supervisor also to teams they supervise", () => {
  assert.deepStrictEqual(t.crewFor(people[0], people).map((p) => p.id), ["2", "4"]);
  assert.deepStrictEqual(t.crewFor(people[3], people).map((p) => p.id), ["1", "2", "3", "6"]);
  assert.strictEqual(t.canAssign(["operator"]), false);
});

test("assigning needs people from the list and a due date that isn't past", () => {
  const ctx = { today: "2026-10-23", crewIds: ["2", "4"] };
  assert.ok(t.cleanAssign({ emps: [], dueDate: "2026-10-25" }, ctx).error);
  assert.ok(t.cleanAssign({ emps: ["3"], dueDate: "2026-10-25" }, ctx).error);
  assert.ok(t.cleanAssign({ emps: ["2"], dueDate: "2026-10-22" }, ctx).error);
  assert.deepStrictEqual(t.cleanAssign({ emps: ["2", "2", "4"], dueDate: "2026-10-23", note: " Do it " }, ctx), { task: { emps: ["2", "4"], dueDate: "2026-10-23", note: "Do it" } });
});

test("second sign-off: a lead or supervisor on that team, or the Production Manager — never the person who did it", () => {
  const task = { emp: "2", team: "a", assignedBy: "1" };
  assert.strictEqual(t.secondSigner(people[0], task).role, "lead");
  assert.strictEqual(t.secondSigner(people[3], task).role, "supervisor");
  assert.strictEqual(t.secondSigner(people[4], task).role, "plant-manager");
  assert.ok(t.secondSigner(people[5], task).error); // a lead on another team
  assert.ok(t.secondSigner(people[1], task).error); // the person who did it
  assert.ok(t.secondSigner({ ...people[0], id: "2" }, task).error);
});
