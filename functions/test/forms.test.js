const test = require("node:test");
const assert = require("node:assert");
const f = require("../forms");

// Made-up form (the real wording lives only in the database).
const form = {
  name: "Practice handoff", kind: "handoff",
  sections: [
    { title: "Counts", fields: [{ label: "Widgets made", type: "number", perLine: true, unit: "ft" }, { label: "Bin full", type: "percent" }] },
    { title: "Checks", fields: [{ label: "Swept the floor", type: "yesno" }, { label: "Last swept", type: "datetime", perLine: true }, { label: "Next change", type: "time", perLine: true }, { label: "Notes", type: "longtext" }] },
  ],
};
const lines = [{ id: "line-1", name: "Line 1" }, { id: "line-2", name: "Line 2" }];

test("form editing: admins always; other roles only for the forms listed on the Roles screen", () => {
  const roles = [{ id: "admin" }, { id: "training-safety", editForms: ["handoff"] }, { id: "office" }];
  assert.strictEqual(f.canEditForm(roles, ["admin"], "anything"), true);
  assert.strictEqual(f.canEditForm(roles, ["training-safety"], "handoff"), true);
  assert.strictEqual(f.canEditForm(roles, ["training-safety"], "clean-shop"), false);
  assert.strictEqual(f.canEditForm(roles, ["office"], "handoff"), false);
});

test("a template needs a name, kind, sections, labelled typed fields; ids come from labels and are unique", () => {
  const { template } = f.cleanTemplate(form);
  assert.deepStrictEqual(template.sections.map((s) => s.id), ["counts", "checks"]);
  assert.deepStrictEqual(template.sections[0].fields[0], { id: "widgets-made", label: "Widgets made", type: "number", perLine: true, unit: "ft", help: "" });
  assert.match(f.cleanTemplate({ ...form, name: "" }).error, /name/);
  assert.match(f.cleanTemplate({ ...form, kind: "poem" }).error, /kind/);
  assert.match(f.cleanTemplate({ ...form, sections: [{ title: "A", fields: [{ label: "X", type: "color" }] }] }).error, /type/);
  assert.match(f.cleanTemplate({ ...form, sections: [{ title: "A", fields: [{ label: "X", type: "text" }, { label: "x", type: "text" }] }] }).error, /share/);
});

test("rewording keeps the field id, so old records still line up", () => {
  const { template } = f.cleanTemplate(form);
  const edited = JSON.parse(JSON.stringify(template));
  edited.sections[0].fields[0].label = "Widgets made (feet)";
  const again = f.cleanTemplate(edited).template;
  assert.strictEqual(again.sections[0].fields[0].id, "widgets-made");
  assert.strictEqual(f.describeChange(template, again), "changed “Widgets made (feet)”");
});

test("what changed: added, removed, reordered", () => {
  const a = f.cleanTemplate(form).template;
  const b = JSON.parse(JSON.stringify(a));
  b.sections[1].fields.push({ id: "mopped", label: "Mopped", type: "yesno", perLine: false, unit: "", help: "" });
  assert.strictEqual(f.describeChange(a, b), "added “Mopped”");
  const c = JSON.parse(JSON.stringify(a));
  c.sections[1].fields.reverse();
  assert.strictEqual(f.describeChange(a, c), "reordered fields");
  const d = JSON.parse(JSON.stringify(a));
  d.sections[0].fields.pop();
  assert.strictEqual(f.describeChange(a, d), "removed “Bin full”");
  assert.strictEqual(f.describeChange(null, a), "First version");
});

test("values are checked against the revision; per-line fields hold one value per line; blanks are fine", () => {
  const { sections } = f.cleanTemplate(form).template;
  const { values } = f.cleanValues(sections, lines, {
    "widgets-made": { "line-1": "1,200", "line-2": "" }, "bin-full": 55, "swept-the-floor": "yes",
    "last-swept": { "line-1": "2026-10-20T06:30" }, "next-change": { "line-2": "14:00" }, notes: "  ok  ", junk: "x",
  });
  assert.deepStrictEqual(values, {
    "widgets-made": { "line-1": 1200 }, "bin-full": 55, "swept-the-floor": true,
    "last-swept": { "line-1": "2026-10-20T06:30" }, "next-change": { "line-2": "14:00" }, notes: "ok",
  });
  assert.match(f.cleanValues(sections, lines, { "bin-full": 120 }).error, /0–100/);
  assert.match(f.cleanValues(sections, lines, { "widgets-made": { "line-2": "lots" } }).error, /^Line 2: .*number/);
  assert.match(f.cleanValues(sections, lines, { "next-change": { "line-1": "2pm" } }).error, /time/);
});

test("handoff header: own team, a different incoming team, a date", () => {
  const teams = ["team-a", "team-b"];
  assert.deepStrictEqual(f.cleanHandoffHeader({ team: "team-a", toTeam: "team-b", date: "2026-10-20" }, teams).header, { team: "team-a", toTeam: "team-b", date: "2026-10-20" });
  assert.match(f.cleanHandoffHeader({ team: "team-a", toTeam: "team-a", date: "2026-10-20" }, teams).error, /different/);
  assert.match(f.cleanHandoffHeader({ team: "team-x", toTeam: "team-b", date: "2026-10-20" }, teams).error, /your team/);
  assert.match(f.cleanHandoffHeader({ team: "team-a", toTeam: "team-b", date: "today" }, teams).error, /date/);
});

test("received: a Line Lead on the incoming team, or a Supervisor / Plant Manager / Admin as backup", () => {
  const h = { toTeam: "team-b" };
  assert.strictEqual(f.canReceive({ roles: ["lead"], team: "team-b" }, h), true);
  assert.strictEqual(f.canReceive({ roles: ["lead"], team: "team-a" }, h), false);
  assert.strictEqual(f.canReceive({ roles: ["operator"], team: "team-b" }, h), false);
  assert.strictEqual(f.canReceive({ roles: ["supervisor"], team: null }, h), true);
  const people = [{ id: "1", roles: ["lead"], team: "team-b" }, { id: "2", roles: ["lead"], team: "team-a" }, { id: "3", roles: ["lead"], team: "team-b", active: false }];
  assert.deepStrictEqual(f.incomingLeads(h, people), ["1"]);
});

// ---- Keep the Shop Clean (task lists) ----
const shopForm = {
  name: "Practice task list", kind: "tasklist",
  sections: [{ title: "Before you leave", fields: [{ label: "Sweep it", type: "task" }, { label: "Stack it", type: "task" }] }],
  shifts: [{ name: "Days", start: "05:00", end: "17:00" }, { name: "Nights", start: "17:00", end: "05:00" }],
};

test("task lists: only tasks, shifts required, red minutes 0–720", () => {
  const { template } = f.cleanTemplate(shopForm);
  assert.deepStrictEqual(template.shifts.map((s) => s.id), ["days", "nights"]);
  assert.strictEqual(template.redMinutes, 60);
  assert.match(f.cleanTemplate({ ...shopForm, sections: [{ title: "A", fields: [{ label: "X", type: "number" }] }] }).error, /must be a task/);
  assert.match(f.cleanTemplate({ ...form, sections: [{ title: "A", fields: [{ label: "X", type: "task" }] }] }).error, /task lists/);
  assert.match(f.cleanTemplate({ ...shopForm, shifts: [] }).error, /shifts/);
  assert.match(f.cleanTemplate({ ...shopForm, shifts: [{ name: "Days", start: "5am", end: "17:00" }] }).error, /start/);
  assert.match(f.cleanTemplate({ ...shopForm, redMinutes: 9999 }).error, /720/);
});

test("current shift in plant time, overnight shifts start the day before after midnight", () => {
  const { shifts } = f.cleanTemplate(shopForm).template;
  // 2026-10-20 10:00 CDT (UTC-5) = 15:00 UTC → Days, started 10-20 05:00 CDT = 10:00 UTC, ends 22:00 UTC.
  const day = f.currentShift(shifts, Date.UTC(2026, 9, 20, 15, 0));
  assert.strictEqual(day.shift.id, "days");
  assert.strictEqual(day.date, "2026-10-20");
  assert.strictEqual(day.startMs, Date.UTC(2026, 9, 20, 10, 0));
  assert.strictEqual(day.endMs, Date.UTC(2026, 9, 20, 22, 0));
  // 2026-10-21 02:00 CDT = 07:00 UTC → Nights that started 10-20 17:00 CDT, ends 10-21 05:00 CDT = 10:00 UTC.
  const night = f.currentShift(shifts, Date.UTC(2026, 9, 21, 7, 0));
  assert.strictEqual(night.shift.id, "nights");
  assert.strictEqual(night.date, "2026-10-20");
  assert.strictEqual(night.endMs, Date.UTC(2026, 9, 21, 10, 0));
  // Winter (CST, UTC-6): 2026-12-01 05:00 CST = 11:00 UTC.
  assert.strictEqual(f.plantTimeToMs("2026-12-01", "05:00"), Date.UTC(2026, 11, 1, 11, 0));
});

test("home colors: open, red in the last hour or after, done once all done and checked", () => {
  const list = { sections: [{ fields: [{ id: "a" }, { id: "b" }] }], endMs: 10 * 3600000, redMinutes: 60, done: { a: {} } };
  assert.strictEqual(f.taskListState(list, 8 * 3600000).state, "open");
  assert.strictEqual(f.taskListState(list, 9.5 * 3600000).state, "late");
  assert.strictEqual(f.taskListState({ ...list, done: { a: {}, b: {} } }, 11 * 3600000).state, "open");
  assert.strictEqual(f.taskListState({ ...list, done: { a: {}, b: {} }, check: {} }, 11 * 3600000).state, "done");
});

// ---- Station checklists ----
test("station checklists: tasks and numbers together; signing needs every task ticked and every count", () => {
  const { template } = f.cleanTemplate({ name: "Practice station", kind: "station", sections: [{ title: "Do", fields: [{ label: "Sweep", type: "task" }, { label: "Bins filled", type: "number" }] }] });
  assert.strictEqual(template.kind, "station");
  const { values } = f.cleanValues(template.sections, [], { sweep: true, "bins-filled": "3" });
  assert.deepStrictEqual(values, { sweep: true, "bins-filled": 3 });
  assert.deepStrictEqual(f.stationMissing(template.sections, {}), ["Sweep", "Bins filled"]);
  assert.deepStrictEqual(f.stationMissing(template.sections, values), []);
  assert.match(f.cleanTemplate({ name: "H", kind: "handoff", sections: [{ title: "A", fields: [{ label: "X", type: "task" }] }] }).error, /task lists and station/);
});
