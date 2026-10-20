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
