const test = require("node:test");
const assert = require("node:assert");
const r = require("../requests");

const people = [
  { id: "1001", roles: ["admin"] },
  { id: "2001", roles: ["maintenance"] },
  { id: "2002", roles: ["maintenance"], active: false },
  { id: "3001", roles: ["lead"] },
  { id: "4001", roles: ["operator"] },
];

test("starting routing matches Chris's defaults", () => {
  const by = Object.fromEntries(r.STARTING_TYPES.map((t) => [t.id, t]));
  assert.deepStrictEqual(by.tool.routeRoles, ["maintenance"]);
  assert.deepStrictEqual(by.building.routeRoles, ["maintenance"]);
  assert.deepStrictEqual(by.safety.routeRoles, ["lead", "admin"]);
  assert.strictEqual(by.safety.urgent, true);
  assert.deepStrictEqual(by.other.routeRoles, ["lead"]);
  assert.strictEqual(r.startingType(by.supplies).needsRouting, true);
});

test("routing becomes the people on now (roles + named people, no one turned off)", () => {
  assert.deepStrictEqual(r.recipientsFor({ routeRoles: ["maintenance"] }, people), ["2001"]);
  assert.deepStrictEqual(r.recipientsFor({ routeRoles: ["lead", "admin"] }, people), ["1001", "3001"]);
  assert.deepStrictEqual(r.recipientsFor({ routeRoles: [], routePeople: ["4001", "2002"] }, people), ["4001"]);
});

test("a request needs a type and a few words; line and place are optional", () => {
  assert.match(r.cleanRequest({ typeId: "tool", description: "" }).error, /Say what you need/);
  assert.match(r.cleanRequest({ description: "need gloves" }).error, /Pick what kind/);
  const ok = r.cleanRequest({ typeId: "supplies", description: "  Out of gloves  ", lineId: "line-2", place: "by the winder", photos: ["https://x/y.jpg", "http://bad"] });
  assert.deepStrictEqual(ok.request, { typeId: "supplies", description: "Out of gloves", place: "by the winder", lineId: "line-2", photos: ["https://x/y.jpg"] });
  assert.strictEqual(r.cleanRequest({ typeId: "x", description: "abc", lineId: "Line 2!" }).request.lineId, null);
});

test("admin type edits: known roles only, at least one role or person", () => {
  const roles = ["admin", "maintenance", "lead"];
  assert.match(r.cleanType({ name: "Forklift", routeRoles: ["driver"] }, roles).error, /roles from the list/);
  assert.match(r.cleanType({ name: "Forklift" }, roles).error, /at least one/);
  const { type } = r.cleanType({ name: " Forklift ", icon: "🚜", routePeople: ["4001"], urgent: true }, roles);
  assert.strictEqual(type.name, "Forklift");
  assert.strictEqual(type.urgent, true);
  assert.strictEqual(type.needsRouting, false);
});

test("who can move a request, and which way", () => {
  assert.strictEqual(r.canWork({ recipients: ["2001"] }, "2001", ["maintenance"]), true);
  assert.strictEqual(r.canWork({ recipients: ["2001"] }, "4001", ["operator"]), false);
  assert.strictEqual(r.canWork({ recipients: ["2001"] }, "1001", ["admin"]), true);
  assert.strictEqual(r.canMove("open", "in-progress"), true);
  assert.strictEqual(r.canMove("in-progress", "done"), true);
  assert.strictEqual(r.canMove("open", "done"), true);
  assert.strictEqual(r.canMove("done", "in-progress"), false);
  assert.strictEqual(r.canMove("done", "open"), true);
  assert.strictEqual(r.canMove("open", "open"), false);
});

test("routing that reaches nobody goes to the Admins as a backup", () => {
  assert.deepStrictEqual(r.withBackup(["2001"], people), { recipients: ["2001"], backup: false });
  assert.deepStrictEqual(r.withBackup([], people), { recipients: ["1001"], backup: true });
  assert.deepStrictEqual(r.withBackup(r.recipientsFor({ routeRoles: ["shipping"] }, people), people), { recipients: ["1001"], backup: true });
});
