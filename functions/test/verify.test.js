const test = require("node:test");
const assert = require("node:assert");
const v = require("../verify");

test("a Supervisor verifies; the Production Manager or a Line Lead only when no Supervisor is on shift", () => {
  assert.deepStrictEqual(v.verifierRole("1", ["supervisor"], { supervisorOnShift: true }), { role: "supervisor", roleName: "Supervisor", backup: false });
  assert.ok(v.verifierRole("2", ["lead"], { supervisorOnShift: true }).error);
  assert.deepStrictEqual(v.verifierRole("2", ["lead"], { supervisorOnShift: false }), { role: "lead", roleName: "Line Lead", backup: true });
  assert.deepStrictEqual(v.verifierRole("3", ["plant-manager", "lead"], { supervisorOnShift: false }), { role: "plant-manager", roleName: "Production Manager", backup: true });
  assert.ok(v.verifierRole("4", ["operator"], { supervisorOnShift: false }).error);
  assert.ok(v.verifierRole("5", ["admin"], { supervisorOnShift: false }).error);
});

test("nobody verifies their own work", () => {
  assert.ok(v.verifierRole("1", ["supervisor"], { supervisorOnShift: true, doers: ["1", "7"] }).error);
  const people = [{ id: "1", roles: ["supervisor"] }, { id: "2", roles: ["lead"] }, { id: "3", roles: ["operator"] }];
  assert.deepStrictEqual(v.verifiers(people, { supervisorOnShift: true, doers: [] }).map((p) => p.id), ["1"]);
  assert.deepStrictEqual(v.verifiers(people, { supervisorOnShift: false, doers: ["1"] }).map((p) => p.id), ["2"]);
});

test("Do again needs a short reason; leads, supervisors, Production Manager, Admins", () => {
  assert.ok(v.cleanReason("").error);
  assert.ok(v.cleanReason("  no ").error);
  assert.strictEqual(v.cleanReason("wet").reason, "wet");
  assert.deepStrictEqual(v.cleanReason("  Floor   still wet "), { reason: "Floor still wet" });
  assert.strictEqual(v.canRedo(["operator"]), false);
  assert.strictEqual(v.canRedo(["lead"]), true);
});
