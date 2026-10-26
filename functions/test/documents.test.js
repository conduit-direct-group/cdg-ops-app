const test = require("node:test");
const assert = require("node:assert");
const d = require("../documents");

// Made-up departments and people.
const departments = [
  { id: "production", name: "Production" }, { id: "maintenance", name: "Maintenance" },
  { id: "training-safety", name: "Training & Safety" }, { id: "office", name: "Office", active: false },
];
const heads = new Map([["production", "101"], ["maintenance", "102"]]);

test("item keys: forms, checklists and reference documents have an id; the three files are single items", () => {
  assert.deepStrictEqual(d.parseKey("form:handoff"), { kind: "form", id: "handoff" });
  assert.deepStrictEqual(d.parseKey("map"), { kind: "map", id: null });
  assert.strictEqual(d.parseKey("form:"), null);
  assert.strictEqual(d.parseKey("roles:admin"), null);
  assert.strictEqual(d.parseKey("form:a/b"), null);
});

test("default departments by kind; an Admin's setting wins while that department exists", () => {
  assert.strictEqual(d.departmentOf("form:handoff", {}, departments), "production");
  assert.strictEqual(d.departmentOf("checklist:extruder", {}, departments), "maintenance");
  assert.strictEqual(d.departmentOf("training", {}, departments), "training-safety");
  assert.strictEqual(d.departmentOf("map", {}, departments), null); // no Operations department: Admins cover it
  assert.strictEqual(d.departmentOf("map", {}, [...departments, { id: "ops", name: "Operations" }]), "ops");
  assert.strictEqual(d.departmentOf("form:handoff", { "form:handoff": "maintenance" }, departments), "maintenance");
  assert.strictEqual(d.departmentOf("form:handoff", { "form:handoff": "gone" }, departments), "production");
});

test("Admins edit everything; a head edits only their own department; no head means Admins only", () => {
  const admin = { employeeNumber: "900", roles: ["admin"] };
  const prodHead = { employeeNumber: "101", roles: ["plant-manager"] };
  const lead = { employeeNumber: "103", roles: ["lead"] };
  assert.strictEqual(d.canEdit(admin, null, heads), true);
  assert.strictEqual(d.canEdit(prodHead, "production", heads), true);
  assert.strictEqual(d.canEdit(prodHead, "maintenance", heads), false);
  assert.strictEqual(d.canEdit(lead, "production", heads), false);
  assert.strictEqual(d.canEdit(prodHead, "training-safety", heads), false);
  assert.strictEqual(d.canEdit(prodHead, null, heads), false);
  assert.deepStrictEqual(d.myDepartments(prodHead, departments, heads), ["production"]);
  assert.deepStrictEqual(d.myDepartments(lead, departments, heads), []);
});

test("used on: each kind says where people see it", () => {
  assert.match(d.usedOn("form", { formKind: "handoff" }), /Shift handoff/);
  assert.match(d.usedOn("checklist", { units: 3 }), /3 in use/);
  assert.match(d.usedOn("map"), /Shop Map/);
});
