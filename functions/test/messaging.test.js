const test = require("node:test");
const assert = require("node:assert");
const m = require("../messaging");

// Made-up people: Team A on shift, Team B off; one with no team.
const people = [
  { id: "9001", name: "Lead Larry", team: "a", roles: ["lead"] },
  { id: "9002", name: "Op One", team: "a", roles: ["operator"] },
  { id: "9003", name: "Op Two", team: "a", roles: ["operator"] },
  { id: "9004", name: "Op Three", team: "b", roles: ["operator"] },
  { id: "9005", name: "Test Coverer", team: "b", roles: ["operator"] },
  { id: "9006", name: "Office Olive", team: null, roles: ["office"], department: "office" },
  { id: "9007", name: "Quality Quinn", team: null, roles: ["quality"], department: "quality" },
  { id: "9008", name: "Quality Pat", team: "c", roles: ["quality"], department: "quality" },
];
// Today's line assignments (Crew Board, Decision 104) — no home lines.
const ctx = { teamOnShift: "a", marks: { 9002: { status: "here" }, 9003: { status: "out" }, 9005: { status: "here" } }, lineNow: { 9002: ["l1"], 9005: ["l1", "l2"] } };

test("messaging (Decision 106): Line Leads, Supervisors, department heads, Production Manager, Admins start messages", () => {
  for (const r of ["lead", "supervisor", "plant-manager", "admin"]) assert.ok(m.canStart({ roles: [r] }), r);
  assert.ok(m.canStart({ roles: ["office"], deptHead: true })); // a department head, whatever the role
  assert.ok(!m.canStart({ roles: ["maintenance", "office"] }) && !m.canStart({ roles: ["operator"] }) && !m.canStart({ roles: [] }) && !m.canStart(null));
  assert.strictEqual(m.startRole(["lead", "supervisor"]), "Supervisor");
});

test("messaging: quick replies only Got it / Done / Need help", () => {
  assert.deepStrictEqual(m.cleanQuick("help"), { kind: "help", text: "Need help – see me" });
  assert.deepStrictEqual(m.cleanQuick("got"), { kind: "got", text: "Got it" });
  assert.ok(m.cleanQuick("lol").error);
});

test("messaging: a task goes only to people the message reached, due by a time", () => {
  const now = 1000000000000;
  assert.deepStrictEqual(m.cleanMessageTask(null, ["1"], now), { task: null });
  assert.deepStrictEqual(m.cleanMessageTask({ emps: ["1", "1"], dueMs: now + 5 }, ["1", "2"], now), { task: { emps: ["1"], dueMs: now + 5 } });
  assert.match(m.cleanMessageTask({ emps: ["3"], dueMs: now + 5 }, ["1"], now).error, /reaches/);
  assert.match(m.cleanMessageTask({ emps: ["1"], dueMs: now - 3600000 }, ["1"], now).error, /passed/);
  assert.match(m.cleanMessageTask({ emps: [], dueMs: now }, ["1"], now).error, /who/);
});

test("messaging: acknowledged or the shift ended → off the screen; the sender sees Not acknowledged", () => {
  const root = { shiftEndMs: 100, acks: { 1: { kind: "got", atMs: 10 } } };
  assert.strictEqual(m.ackStatus(root, "1", 50), "got");
  assert.strictEqual(m.ackStatus(root, "2", 50), "waiting");
  assert.strictEqual(m.ackStatus(root, "2", 100), "not-acknowledged");
  assert.ok(m.clearedFor(root, "1", 50, true));
  assert.ok(!m.clearedFor(root, "1", 50, false)); // their task isn't confirmed yet
  assert.ok(!m.clearedFor(root, "2", 50));
  assert.ok(m.clearedFor(root, "2", 100)); // end of the shift
});

test("messaging: on shift, absent, off shift, covering, no team", () => {
  const s = (id) => m.standing(people.find((p) => p.id === id), ctx);
  assert.deepStrictEqual(["9002", "9003", "9004", "9005", "9006"].map(s), ["on", "absent", "off", "covering", "noteam"]);
  assert.strictEqual(m.standing(people[1], { teamOnShift: null, marks: {} }), "off"); // a day with no team on
});

test("messaging: one-on-one to someone off shift or absent is not delivered, and says why", () => {
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9002" }, "9001", ctx), { recipients: ["9002"], total: 1, notDelivered: 0, why: "", offHours: 0 });
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9004" }, "9001", ctx), { recipients: [], total: 1, notDelivered: 1, why: "off shift", offHours: 0 });
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9003" }, "9001", ctx), { recipients: [], total: 1, notDelivered: 1, why: "absent", offHours: 0 });
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9006" }, "9001", ctx).recipients, ["9006"]); // no team, no hour check here
});

test("messaging: group messages reach only those on shift and not absent; covering people get the shift's team messages", () => {
  const team = m.deliver(people, { type: "team", id: "a" }, "9001", ctx);
  assert.deepStrictEqual([team.recipients, team.total, team.notDelivered], [["9002", "9005"], 3, 1]); // 9003 absent; 9005 covering (Test Coverer)
  const off = m.deliver(people, { type: "team", id: "b" }, "9001", ctx);
  assert.deepStrictEqual([off.recipients, off.total], [["9005"], 2]); // Team B is off; the coverer is here covering
  const line = m.deliver(people, { type: "line", id: "l1" }, "9001", ctx);
  assert.deepStrictEqual([line.recipients, line.total], [["9002", "9005"], 2]); // whoever is on Line 1 now, covering included
  assert.deepStrictEqual(m.deliver(people, { type: "line", id: "l3" }, "9001", ctx).total, 0); // no one on Line 3 yet
  const role = m.deliver(people, { type: "role", id: "operator" }, "9001", ctx);
  assert.deepStrictEqual([role.recipients, role.total], [["9002", "9005"], 4]);
  const all = m.deliver(people, { type: "all", id: "all" }, "9001", ctx);
  assert.deepStrictEqual([all.recipients, all.total, all.why], [["9002", "9005", "9006", "9007"], 7, ""]); // never the sender; no team included (no hour check here)
});

test("messaging (Decision 109): no team — named, their department, or everyone; never team, line, or role", () => {
  assert.strictEqual(m.deliver(people, { type: "role", id: "office" }, "9001", ctx).total, 0);
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9006" }, "9001", ctx).recipients, ["9006"]);
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9006" }, "9001", { ...ctx, marks: { 9006: { status: "out" } } }).why, "absent");
  const dept = m.deliver(people, { type: "department", id: "quality" }, "9001", ctx);
  assert.deepStrictEqual([dept.recipients, dept.total], [["9007"], 2]); // 9008 is on Team C, off shift
  const mix = m.deliver(people, { type: "set", parts: [{ type: "department", id: "quality" }, { type: "team", id: "b" }, { type: "person", id: "9006" }] }, "9001", ctx);
  assert.deepStrictEqual([mix.recipients, mix.total], [["9005", "9006", "9007"], 5]); // 9004 and 9008 off shift
});

test("messaging (Decision 109): people with no team receive only in the day hours (Mon–Fri 5 AM–5 PM to start)", () => {
  const H = m.DEFAULT_DAY_HOURS;
  assert.strictEqual(m.dayHoursText(H), "Mon–Fri, 5 AM–5 PM");
  assert.strictEqual(m.inDayHours(H, { dow: 2, minutes: 5 * 60 }), true);
  assert.strictEqual(m.inDayHours(H, { dow: 2, minutes: 17 * 60 }), false); // 5:00 PM is the end
  assert.strictEqual(m.inDayHours(H, { dow: 6, minutes: 10 * 60 }), false); // Saturday
  const night = { ...ctx, dayHours: H, dayNow: { dow: 3, minutes: 22 * 60 } };
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9006" }, "9001", night).why, "off hours");
  assert.deepStrictEqual(m.deliverOne(people[5], night), { recipients: [], why: "off hours" });
  const all = m.deliver(people, { type: "all", id: "all" }, "9001", night);
  assert.deepStrictEqual([all.recipients, all.offHours], [["9002", "9005"], 2]); // the sender is warned about 2
  const day = { ...night, dayNow: { dow: 3, minutes: 9 * 60 } };
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9006" }, "9001", day).recipients, ["9006"]);
  assert.deepStrictEqual(m.cleanDayHours({ days: [5, 1, 1], start: "06:30", end: "15:00" }), { hours: { days: [1, 5], start: "06:30", end: "15:00" } });
  assert.match(m.cleanDayHours({ days: [], start: "05:00", end: "17:00" }).error, /day/);
  assert.match(m.cleanDayHours({ days: [1], start: "17:00", end: "05:00" }).error, /after/);
  assert.match(m.cleanDayHours({ days: [1], start: "5am", end: "17:00" }).error, /time/);
});

test("messaging (Decision 108): who sends to what, and where a new message starts", () => {
  const admin = m.sendOptions({ roles: ["admin"] });
  assert.deepStrictEqual(admin.start, { type: "all" });
  assert.strictEqual(m.checkTo({ type: "set", parts: [{ type: "department", id: "office" }, { type: "line", id: "l1" }] }, admin), "");
  const head = m.sendOptions({ roles: ["quality"], deptHead: true, department: "quality" });
  assert.deepStrictEqual(head.start, { type: "set", parts: [{ type: "department", id: "quality" }] });
  assert.strictEqual(m.checkTo({ type: "set", parts: [{ type: "department", id: "quality" }, { type: "team", id: "b" }, { type: "person", id: "9002" }] }, head), "");
  assert.match(m.checkTo({ type: "all", id: "all" }, head), /not everyone/);
  assert.match(m.checkTo({ type: "department", id: "office" }, head), /own department/);
  assert.match(m.checkTo({ type: "line", id: "l1" }, head), /can't send/);
  const lead = m.sendOptions({ roles: ["lead"] });
  assert.strictEqual(lead.start, null);
  assert.strictEqual(m.checkTo({ type: "all", id: "all" }, lead), "");
  assert.match(m.checkTo({ type: "department", id: "quality" }, lead), /Only Admins and department heads/);
  // A supervisor who heads a department: the supervisor's choices plus their own department, which is where it starts.
  const both = m.sendOptions({ roles: ["supervisor"], deptHead: true, department: "logistics" });
  assert.strictEqual(m.checkTo({ type: "line", id: "l1" }, both), "");
  assert.deepStrictEqual(both.start, { type: "set", parts: [{ type: "department", id: "logistics" }] });
  // A mix is cleaned; one person alone is a one-on-one.
  assert.deepStrictEqual(m.cleanTo({ type: "set", parts: [{ type: "person", id: "9002" }, { type: "person", id: "9002" }] }), { to: { type: "person", id: "9002" } });
  assert.match(m.cleanTo({ type: "set", parts: [] }).error, /who/);
  assert.match(m.cleanTo({ type: "set", parts: [{ type: "planet", id: "x" }] }).error, /lists/);
});

test("messaging: a reply goes to one person with the same shift check", () => {
  assert.deepStrictEqual(m.deliverOne(people[0], ctx), { recipients: ["9001"], why: "" });
  assert.deepStrictEqual(m.deliverOne(people[3], ctx), { recipients: [], why: "off shift" });
  assert.deepStrictEqual(m.deliverOne(people[2], ctx), { recipients: [], why: "absent" });
});

test("messaging: text, who it's for, HR reason", () => {
  assert.deepStrictEqual(m.cleanText("  hi  "), { text: "hi" });
  assert.match(m.cleanText("  ").error, /Write/);
  assert.strictEqual(m.cleanText("x".repeat(3000)).text.length, m.MAX_TEXT);
  assert.deepStrictEqual(m.cleanTo({ type: "all" }), { to: { type: "all", id: "all" } });
  assert.match(m.cleanTo({ type: "planet", id: "x" }).error, /who/);
  assert.match(m.cleanTo({ type: "team" }).error, /who/);
  assert.match(m.cleanReason("because").error, /reason/);
  assert.deepStrictEqual(m.cleanReason(" Complaint about a message on 10/22 "), { reason: "Complaint about a message on 10/22" });
});

test("messaging: the maintenance button shows for an M-number or trouble words", () => {
  for (const t of ["M-017 is making noise", "line 2 is down", "oil leak by the puller", "jammed again", "printer not working", "m017 hot"]) assert.ok(m.maintenanceHint(t), t);
  for (const t of ["see you at 5", "download the form", "jamboree"]) assert.ok(!m.maintenanceHint(t), t);
  assert.strictEqual(m.machineNumber("check m017 please"), "M-017");
  assert.strictEqual(m.conv("abc", "9002"), "abc__9002");
});
