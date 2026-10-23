const test = require("node:test");
const assert = require("node:assert");
const w = require("../writeups");

const form = { emp: "9101", date: "2026-10-20", type: "written", policy: "Safety glasses on the floor", description: "No glasses at the mixer.", correctiveAction: "Wear them at all times." };

test("write-ups: Supervisors, Production Manager and Admins write them; Line Leads and operators don't", () => {
  assert.ok(w.canWrite(["supervisor"]));
  assert.ok(w.canWrite(["operator", "plant-manager"]));
  assert.ok(w.canWrite(["admin"]));
  assert.ok(!w.canWrite(["lead"]));
  assert.ok(!w.canWrite(["operator", "office"]));
  assert.ok(!w.canWrite([]));
});

test("write-ups: only the writer and people with HR access see one", () => {
  const rec = { writerEmp: "9001" };
  assert.ok(w.canSee({ employeeNumber: "9001", hr: false }, rec));
  assert.ok(w.canSee({ employeeNumber: "9050", hr: true }, rec));
  assert.ok(!w.canSee({ employeeNumber: "9002", hr: false }, rec)); // another supervisor, an Admin, the Production Manager
  assert.ok(!w.canSee(null, rec));
});

test("write-ups: the form needs date, employee, type, policy, what happened, and corrective action", () => {
  const { writeup } = w.cleanWriteup({ ...form, priorNotes: "  Talked to him  in May. " }, "2026-10-23");
  assert.deepStrictEqual(writeup, { ...form, priorNotes: "Talked to him in May." });
  assert.match(w.cleanWriteup({ ...form, date: "2026-10-24" }, "2026-10-23").error, /future/);
  assert.match(w.cleanWriteup({ ...form, date: "" }, "2026-10-23").error, /date/);
  assert.match(w.cleanWriteup({ ...form, emp: "" }, "2026-10-23").error, /employee/);
  assert.match(w.cleanWriteup({ ...form, type: "suspension" }, "2026-10-23").error, /type/);
  assert.match(w.cleanWriteup({ ...form, policy: " " }, "2026-10-23").error, /policy/);
  assert.match(w.cleanWriteup({ ...form, description: "" }, "2026-10-23").error, /what happened/);
  assert.match(w.cleanWriteup({ ...form, correctiveAction: "" }, "2026-10-23").error, /corrective/);
  assert.strictEqual(w.cleanWriteup({ ...form, description: "x".repeat(5000) }, "2026-10-23").writeup.description.length, w.MAX.text);
});

test("write-ups: earlier write-ups for the person are listed by date and type only", () => {
  const others = [
    { date: "2026-09-01", type: "written", description: "private" },
    { date: "2026-03-01", type: "verbal", description: "private" },
    { date: "2026-11-01", type: "final" }, // after this one's date
  ];
  assert.deepStrictEqual(w.priorList(others, "2026-10-20"), [{ date: "2026-03-01", type: "verbal" }, { date: "2026-09-01", type: "written" }]);
  assert.strictEqual(w.typeLabel("final"), "Final warning");
});

test("write-ups: the writer's role shows on the sheet; signatures are drawn pictures (PNG)", () => {
  assert.strictEqual(w.writerRole(["supervisor", "admin"]), "Supervisor");
  assert.strictEqual(w.writerRole(["plant-manager"]), "Production Manager");
  assert.strictEqual(w.writerRole(["admin"]), "Admin");
  assert.strictEqual(w.writerRole(["operator"]), "");
  const png = `data:image/png;base64,${"A".repeat(400)}`;
  assert.deepStrictEqual(w.cleanPng(png, "Your signature"), { png });
  assert.match(w.cleanPng("", "Your signature").error, /sign in the box/);
  assert.match(w.cleanPng("data:image/jpeg;base64,AAAA", "Sam's signature").error, /Sam's signature: sign in the box/);
  assert.match(w.cleanPng(`data:image/png;base64,${"A".repeat(400000)}`, "x").error, /too large/);
});
