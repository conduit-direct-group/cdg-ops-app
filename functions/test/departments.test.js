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
  assert.deepStrictEqual(d.cleanOrg({ department: "quality", head: true, reportsTo: "1001" }, { departments: depts, people, emp: "1002" }).org, { department: "quality", head: true, reportsTo: "1001", supervisesTeams: [] });
  assert.match(d.cleanOrg({ department: "nope" }, { departments: depts, people, emp: "1002" }).error, /department/);
  assert.match(d.cleanOrg({ head: true }, { departments: depts, people, emp: "1002" }).error, /department first/);
  assert.match(d.cleanOrg({ department: "quality", reportsTo: "1002" }, { departments: depts, people, emp: "1002" }).error, /themselves/);
  assert.match(d.cleanOrg({ department: "quality", reportsTo: "9999" }, { departments: depts, people, emp: "1002" }).error, /list/);
});

test("Production reports by shift: Operator → team Line Lead → team Supervisor → Production Manager", () => {
  const people = [
    P("pm", "Pat", ["supervisor", "admin", "plant-manager"], { department: "production" }),
    P("supA", "Sam", ["supervisor"], { department: "production", team: "a" }),
    P("leadA1", "Lee", ["lead"], { department: "production", team: "a" }),
    P("leadA2", "Lou", ["lead"], { department: "production", team: "a" }),
    P("opA", "Olive", ["operator"], { department: "production", team: "a" }),
    P("opB", "Otto", ["operator"], { department: "production", team: "b" }),
    P("leadC", "Lana", ["lead"], { department: "production", team: "c" }),
    P("opNoTeam", "Ned", ["operator"], { department: "production" }),
  ];
  const r = d.reportsToAll(people);
  assert.deepStrictEqual(r.get("pm"), { reportsTo: null, source: "top" }); // the Production Manager is Production's head
  assert.strictEqual(r.get("supA").reportsTo, "pm");
  assert.strictEqual(r.get("leadA1").reportsTo, "supA");
  assert.strictEqual(r.get("opA").reportsTo, "leadA1"); // same team (no home lines — Decision 104)
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

test("an admin can set someone at the top of the chart (reports to no one)", () => {
  const people = [P("ceo", "Morgan", ["office"], { department: "office", deptHead: true, reportsTo: "none" }), P("m", "Robin", ["office"], { department: "office" })];
  const r = d.reportsToAll(people);
  assert.deepStrictEqual(r.get("ceo"), { reportsTo: null, source: "top" });
  assert.strictEqual(r.get("m").reportsTo, "ceo");
  assert.deepStrictEqual(d.cleanOrg({ department: "office", reportsTo: "none" }, { departments: depts, people, emp: "ceo" }).org.reportsTo, "none");
});

test("a Supervisor can cover several teams (shifts)", () => {
  const people = [
    P("pm", "Pat", ["plant-manager"], { department: "production" }),
    P("supAC", "Sam Reed", ["supervisor"], { department: "production", team: "a", supervisesTeams: ["a", "c"] }),
    P("supBD", "Lee", ["supervisor"], { department: "production", team: "d", supervisesTeams: ["b", "d"] }),
    P("leadA", "Avery", ["lead"], { department: "production", team: "a" }),
    P("leadC", "Quinn", ["lead"], { department: "production", team: "c" }),
    P("leadD", "Drew", ["lead"], { department: "production", team: "d" }),
    P("opB", "Blake", ["operator"], { department: "production", team: "b" }),
    P("opD", "Rowan", ["operator"], { department: "production", team: "d" }),
  ];
  const r = d.reportsToAll(people);
  assert.strictEqual(r.get("leadA").reportsTo, "supAC");
  assert.strictEqual(r.get("leadC").reportsTo, "supAC"); // team C is covered by Sam
  assert.strictEqual(r.get("leadD").reportsTo, "supBD");
  assert.strictEqual(r.get("opB").reportsTo, "supBD"); // team B has no lead; Lee covers B
  assert.strictEqual(r.get("opD").reportsTo, "leadD");
  assert.strictEqual(r.get("supAC").reportsTo, "pm");
  const teams = ["a", "b", "c", "d"];
  assert.deepStrictEqual(d.cleanOrg({ department: "production", supervisesTeams: ["b", "d", "b"] }, { departments: d.startingDepartments(), people, emp: "supBD", teamIds: teams }).org.supervisesTeams, ["b", "d"]);
  assert.match(d.cleanOrg({ department: "production", supervisesTeams: ["z"] }, { departments: d.startingDepartments(), people, emp: "supBD", teamIds: teams }).error, /teams/);
});

test("practice accounts are left off the org chart", () => {
  assert.strictEqual(d.isPracticeAccount("test"), true);
  assert.strictEqual(d.isPracticeAccount("TEST Operator"), true);
  assert.strictEqual(d.isPracticeAccount(" TEST Lead"), true);
  assert.strictEqual(d.isPracticeAccount("Testa Smith"), false);
  assert.strictEqual(d.isPracticeAccount("Pat Lopez"), false);
});

test("a Supervisor is on shift for their own team and every team they supervise", () => {
  const sup = P("1", "Sup", ["supervisor"], { team: "a", supervisesTeams: ["c"] });
  assert.strictEqual(d.covers(sup, "a", "supervisor"), true);
  assert.strictEqual(d.covers(sup, "c", "supervisor"), true);
  assert.strictEqual(d.covers(sup, "b", "supervisor"), false);
  assert.strictEqual(d.covers(sup, "c", "lead"), false);
});
