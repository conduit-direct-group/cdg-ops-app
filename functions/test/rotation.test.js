const test = require("node:test");
const assert = require("node:assert");
const r = require("../rotation");

// Chris's rotation, 10-21-2026: A Sun–Tue days, B Sun–Tue nights, C Wed–Fri days, D Wed–Fri nights.
const rows = [
  { teamId: "team-a", days: [0, 1, 2], shiftId: "days" }, { teamId: "team-b", days: [0, 1, 2], shiftId: "nights" },
  { teamId: "team-c", days: [3, 4, 5], shiftId: "days" }, { teamId: "team-d", days: [3, 4, 5], shiftId: "nights" },
];

test("rotation: teams and shifts from the lists, no two teams on the same shift and day", () => {
  const { teams } = r.cleanRotation(rows, ["team-a", "team-b", "team-c", "team-d"], ["days", "nights"]);
  assert.strictEqual(teams.length, 4);
  assert.match(r.cleanRotation([{ teamId: "team-x", days: [1], shiftId: "days" }], ["team-a"], ["days"]).error, /team/);
  assert.match(r.cleanRotation([{ teamId: "team-a", days: [], shiftId: "days" }], ["team-a"], ["days"]).error, /day/);
  assert.match(r.cleanRotation([rows[0], { teamId: "team-c", days: [2], shiftId: "days" }], ["team-a", "team-c"], ["days"]).error, /same shift/);
});

test("team on shift: the night belongs to the day it started; Saturday has no team", () => {
  // 2026-10-20 is a Tuesday, 2026-10-21 Wednesday, 2026-10-24 Saturday.
  assert.strictEqual(r.teamOnShift(rows, { shift: { id: "days" }, date: "2026-10-20" }), "team-a");
  assert.strictEqual(r.teamOnShift(rows, { shift: { id: "nights" }, date: "2026-10-20" }), "team-b"); // Tue 5 PM – Wed 5 AM
  assert.strictEqual(r.teamOnShift(rows, { shift: { id: "days" }, date: "2026-10-21" }), "team-c");
  assert.strictEqual(r.teamOnShift(rows, { shift: { id: "nights" }, date: "2026-10-23" }), "team-d"); // Fri night
  assert.strictEqual(r.teamOnShift(rows, { shift: { id: "days" }, date: "2026-10-24" }), null);
  assert.strictEqual(r.teamOnShift(rows, null), null);
});
