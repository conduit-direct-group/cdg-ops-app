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

test("assigning needs people on the shift and a due time that isn't past", () => {
  const now = Date.UTC(2026, 9, 26, 15);
  const ctx = { nowMs: now, crewIds: ["2", "4"] };
  assert.ok(t.cleanAssign({ emps: [], dueMs: now + 3600000 }, ctx).error);
  assert.match(t.cleanAssign({ emps: ["3"], dueMs: now + 3600000 }, ctx).error, /on your shift/);
  assert.match(t.cleanAssign({ emps: ["2"], dueMs: now - 3600000 }, ctx).error, /passed/);
  assert.match(t.cleanAssign({ emps: ["2"], dueMs: now + 40 * 86400000 }, ctx).error, /month/);
  assert.deepStrictEqual(t.cleanAssign({ emps: ["2", "2", "4"], dueMs: now + 3600000, note: " Do it " }, ctx), { task: { emps: ["2", "4"], dueMs: now + 3600000, note: "Do it" } });
  assert.strictEqual(t.dueMsOf({ dueMs: 5 }), 5);
  assert.ok(t.dueMsOf({ dueDate: "2026-10-26" }) > Date.UTC(2026, 9, 27, 4)); // older tasks: end of that day
});

test("confirming (Decision 106): the assigner; when they're off shift, a Line Lead or Supervisor on shift — never the doer", () => {
  const task = { emp: "2", assignedBy: "1", assignedByName: "Lead One" };
  const lead1 = { id: "1", roles: ["lead"] };
  const sup = { id: "5", roles: ["supervisor"] };
  const lead9 = { id: "9", roles: ["lead"] };
  const pm = { id: "7", roles: ["plant-manager"] };
  const doer = { id: "2", roles: ["lead"] };
  assert.ok(!t.canConfirm(lead1, task, { assignerOnShift: true, personOnShift: true }).error);
  assert.ok(!t.canConfirm(lead1, task, { assignerOnShift: false, personOnShift: false }).error); // the assigner always can
  assert.match(t.canConfirm(sup, task, { assignerOnShift: true, personOnShift: true }).error, /Lead One confirms/);
  assert.strictEqual(t.canConfirm(sup, task, { assignerOnShift: false, personOnShift: true }).role, "supervisor");
  assert.strictEqual(t.canConfirm(lead9, task, { assignerOnShift: false, personOnShift: true }).role, "lead");
  assert.ok(t.canConfirm(lead9, task, { assignerOnShift: false, personOnShift: false }).error); // not on shift
  assert.ok(t.canConfirm(pm, task, { assignerOnShift: false, personOnShift: true }).error); // not a lead / supervisor
  assert.match(t.canConfirm(doer, { ...task, assignedBy: "2" }, { assignerOnShift: true, personOnShift: true }).error, /did it/);
  assert.match(t.cleanReturn(" ").error, /note/);
  assert.deepStrictEqual(t.cleanReturn("  Missed the  north bay "), { note: "Missed the north bay" });
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
