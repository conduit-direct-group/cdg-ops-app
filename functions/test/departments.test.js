const test = require("node:test");
const assert = require("node:assert");
const d = require("../departments");

const depts = d.startingDepartments();
const P = (id, name, roles, extra = {}) => ({ id, name, roles, active: true, ...extra });

test("department suggested from roles; Admin alone suggests none", () => {
  assert.strictEqual(d.suggestDepartment(["operator"], depts), "production");
  assert.strictEqual(d.suggestDepartment(["admin", "training-safety"], depts), "training-safety");
  assert.strictEqual(d.suggestDepartment(["supervisor", "admin", "plant-manager"], depts), "production");
  assert.strictEqual(d.suggestDepartment(["shipping"], depts), "logistics");
  assert.strictEqual(d.suggestDepartment(["admin"], depts), null);
  assert.strictEqual(d.suggestDepartment(["sales"], depts.map((x) => (x.id === "sales" ? { ...x, active: false } : x))), null);
});

test("departments list: names required, no repeats, ids kept", () => {
  assert.deepStrictEqual(d.cleanDepartments([{ name: "Shipping & Receiving" }]).departments, [{ id: "shipping-and-receiving", name: "Shipping & Receiving", active: true }]);
  assert.deepStrictEqual(d.cleanDepartments([{ id: "logistics", name: "Logistics" }]).departments[0].id, "logistics");
  assert.match(d.cleanDepartments([{ name: "A" }, { name: "a" }]).error, /twice/);
  assert.match(d.cleanDepartments([{ name: "A", active: false }]).error, /at least one/);
  assert.match(d.cleanDepartments([]).error, /1 to 30/);
});

test("a person's department fields are checked", () => {
  const people = [P("1001", "Chris", ["admin"]), P("1002", "Ann", ["operator"])];
  assert.deepStrictEqual(d.cleanOrg({ department: "quality", head: true, reportsTo: "1001" }, { departments: depts, people, emp: "1002" }).org, { department: "quality", head: true, reportsTo: "1001" });
  assert.match(d.cleanOrg({ department: "nope" }, { departments: depts, people, emp: "1002" }).error, /department/);
  assert.match(d.cleanOrg({ head: true }, { departments: depts, people, emp: "1002" }).error, /department first/);
  assert.match(d.cleanOrg({ department: "quality", reportsTo: "1002" }, { departments: depts, people, emp: "1002" }).error, /themselves/);
  assert.match(d.cleanOrg({ department: "quality", reportsTo: "9999" }, { departments: depts, people, emp: "1002" }).error, /list/);
});

test("Production reports by shift: Operator → team Line Lead → team Supervisor → Production Manager", () => {
  const people = [
    P("pm", "Pat", ["supervisor", "admin", "plant-manager"], { department: "production" }),
    P("supA", "Sam", ["supervisor"], { department: "production", team: "a" }),
    P("leadA1", "Lee", ["lead"], { department: "production", team: "a", homeLineId: "line-1" }),
    P("leadA2", "Lou", ["lead"], { department: "production", team: "a", homeLineId: "line-2" }),
    P("opA", "Olive", ["operator"], { department: "production", team: "a", homeLineId: "line-2" }),
    P("opB", "Otto", ["operator"], { department: "production", team: "b" }),
    P("leadC", "Lana", ["lead"], { department: "production", team: "c" }),
    P("opNoTeam", "Ned", ["operator"], { department: "production" }),
  ];
  const r = d.reportsToAll(people);
  assert.deepStrictEqual(r.get("pm"), { reportsTo: null, source: "top" }); // the Production Manager is Production's head
  assert.strictEqual(r.get("supA").reportsTo, "pm");
  assert.strictEqual(r.get("leadA1").reportsTo, "supA");
  assert.strictEqual(r.get("opA").reportsTo, "leadA2"); // same team, same home line first
  assert.strictEqual(r.get("opB").reportsTo, "pm"); // team B has no lead or supervisor
  assert.strictEqual(r.get("leadC").reportsTo, "pm"); // team C has no supervisor
  assert.strictEqual(r.get("opNoTeam").reportsTo, "pm");
});

test("other departments report to their head; heads to the Production Manager or whoever is set", () => {
  const people = [
    P("pm", "Pat", ["plant-manager"], { department: "production" }),
    P("qh", "Quinn", ["quality"], { department: "quality", deptHead: true }),
    P("q1", "Quill", ["quality"], { department: "quality" }),
    P("s1", "Sid", ["sales"], { department: "sales" }),
    P("ceo", "Morgan", [], { department: "office", deptHead: true }),
    P("x", "Xena", ["operator"]),
  ];
  let r = d.reportsToAll(people);
  assert.strictEqual(r.get("q1").reportsTo, "qh");
  assert.strictEqual(r.get("qh").reportsTo, "pm");
  assert.deepStrictEqual(r.get("s1"), { reportsTo: null, source: "missing" }); // Sales has no head
  assert.deepStrictEqual(r.get("x"), { reportsTo: null, source: "missing" }); // no department
  r = d.reportsToAll(people, { headsReportTo: "ceo" });
  assert.strictEqual(r.get("qh").reportsTo, "ceo");
  assert.deepStrictEqual(d.departmentsWithoutHead(people, d.startingDepartments()), ["sales"]);
});

test("an admin's override wins; turned-off people are never reported to", () => {
  const people = [
    P("pm", "Pat", ["plant-manager"], { department: "production" }),
    P("qh", "Quinn", ["quality"], { department: "quality", deptHead: true, active: false }),
    P("q1", "Quill", ["quality"], { department: "quality" }),
    P("q2", "Quade", ["quality"], { department: "quality", reportsTo: "pm" }),
  ];
  const r = d.reportsToAll(people);
  assert.deepStrictEqual(r.get("q2"), { reportsTo: "pm", source: "override" });
  assert.deepStrictEqual(r.get("q1"), { reportsTo: null, source: "missing" }); // the head is turned off
  assert.strictEqual(d.headOf("quality", people), null);
});
