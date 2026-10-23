const test = require("node:test");
const assert = require("node:assert");
const m = require("../messaging");

// Made-up people: Team A on shift, Team B off; one with no team.
const people = [
  { id: "9001", name: "Lead Larry", team: "a", homeLineId: "l1", roles: ["lead"] },
  { id: "9002", name: "Op One", team: "a", homeLineId: "l1", roles: ["operator"] },
  { id: "9003", name: "Op Two", team: "a", homeLineId: "l2", roles: ["operator"] },
  { id: "9004", name: "Op Three", team: "b", homeLineId: "l1", roles: ["operator"] },
  { id: "9005", name: "Test Coverer", team: "b", homeLineId: "l2", roles: ["operator"] },
  { id: "9006", name: "Office Olive", team: null, homeLineId: null, roles: ["office"] },
];
const ctx = { teamOnShift: "a", marks: { 9002: { status: "here" }, 9003: { status: "out" }, 9005: { status: "here" } } };

test("messaging: only Line Lead and above start messages", () => {
  assert.ok(m.canStart(["lead"]) && m.canStart(["supervisor"]) && m.canStart(["plant-manager"]) && m.canStart(["admin"]));
  assert.ok(!m.canStart(["operator"]) && !m.canStart(["maintenance", "office"]) && !m.canStart([]));
  assert.strictEqual(m.startRole(["lead", "supervisor"]), "Supervisor");
});

test("messaging: on shift, absent, off shift, covering, no team", () => {
  const s = (id) => m.standing(people.find((p) => p.id === id), ctx);
  assert.deepStrictEqual(["9002", "9003", "9004", "9005", "9006"].map(s), ["on", "absent", "off", "covering", "noteam"]);
  assert.strictEqual(m.standing(people[1], { teamOnShift: null, marks: {} }), "off"); // a day with no team on
});

test("messaging: one-on-one to someone off shift or absent is not delivered, and says why", () => {
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9002" }, "9001", ctx), { recipients: ["9002"], total: 1, notDelivered: 0, why: "" });
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9004" }, "9001", ctx), { recipients: [], total: 1, notDelivered: 1, why: "off shift" });
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9003" }, "9001", ctx), { recipients: [], total: 1, notDelivered: 1, why: "absent" });
  assert.deepStrictEqual(m.deliver(people, { type: "person", id: "9006" }, "9001", ctx).recipients, ["9006"]); // no team = always on
});

test("messaging: group messages reach only those on shift and not absent; covering people get the shift's team messages", () => {
  const team = m.deliver(people, { type: "team", id: "a" }, "9001", ctx);
  assert.deepStrictEqual([team.recipients, team.total, team.notDelivered], [["9002", "9005"], 3, 1]); // 9003 absent; 9005 covering (Test Coverer)
  const off = m.deliver(people, { type: "team", id: "b" }, "9001", ctx);
  assert.deepStrictEqual([off.recipients, off.total], [["9005"], 2]); // Team B is off; the coverer is here covering
  const line = m.deliver(people, { type: "line", id: "l1" }, "9001", ctx);
  assert.deepStrictEqual([line.recipients, line.total], [["9002"], 2]); // 9004 off shift
  const role = m.deliver(people, { type: "role", id: "operator" }, "9001", ctx);
  assert.deepStrictEqual([role.recipients, role.total], [["9002", "9005"], 4]);
  const all = m.deliver(people, { type: "all", id: "all" }, "9001", ctx);
  assert.deepStrictEqual([all.recipients, all.total, all.why], [["9002", "9005", "9006"], 5, ""]); // never the sender
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
