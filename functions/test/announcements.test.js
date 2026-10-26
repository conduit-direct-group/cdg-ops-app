const test = require("node:test");
const assert = require("node:assert");
const a = require("../announcements");

const people = [
  { id: "1001", roles: ["admin"], team: null, lineIds: [] },
  { id: "2001", roles: ["operator"], team: "team-a", lineIds: ["line-1"] },
  { id: "2002", roles: ["operator"], team: "team-b", lineIds: ["line-2"] },
  { id: "2003", roles: ["operator"], team: "team-a", lineIds: ["line-2"], active: false },
  { id: "3001", roles: ["supervisor"], team: "team-a", lineIds: [] },
  { id: "3002", roles: ["supervisor"], team: null, lineIds: ["line-2"] },
  { id: "3003", roles: ["supervisor"], team: null, lineIds: [] },
  { id: "4001", roles: ["office"], team: null, lineIds: [], department: "office" },
  { id: "4002", roles: ["quality"], team: null, lineIds: [], department: "quality" },
  { id: "4003", roles: ["quality"], team: "team-b", lineIds: [], department: "quality" },
];
const known = { roles: ["admin", "operator", "supervisor", "office", "quality"], teams: ["team-a", "team-b"], lines: ["line-1", "line-2"], departments: ["office", "quality"] };
const ours = (url) => (url.startsWith("https://firebasestorage.googleapis.com/v0/b/cdg/o/uploads") ? "uploads/x" : null);
const good = { title: "New glove rule", body: "Cut gloves at the winder from Monday.", priority: "safety", ackBy: "2026-10-25", audience: { everyone: true } };

test("posting: Chris's default roles may post until the Roles screen says otherwise", () => {
  const roles = [{ id: "admin" }, { id: "operator" }, { id: "office" }, { id: "supervisor", canPostAnnouncements: false }, { id: "quality", canPostAnnouncements: true }];
  assert.strictEqual(a.canPost(roles, ["office"]), true);
  assert.strictEqual(a.canPost(roles, ["operator"]), false);
  assert.strictEqual(a.canPost(roles, ["supervisor"]), false);
  assert.strictEqual(a.canPost(roles, ["quality"]), true);
  assert.strictEqual(a.canPost([{ id: "office", active: false }], ["office"]), false);
});

test("an announcement needs a title, message, priority, acknowledge-by date, and an audience", () => {
  assert.match(a.cleanAnnouncement({ ...good, title: "" }, known, ours).error, /title/);
  assert.match(a.cleanAnnouncement({ ...good, body: "" }, known, ours).error, /message/);
  assert.match(a.cleanAnnouncement({ ...good, priority: "huge" }, known, ours).error, /priority/);
  assert.match(a.cleanAnnouncement({ ...good, ackBy: "next week" }, known, ours).error, /acknowledge by/);
  assert.match(a.cleanAnnouncement({ ...good, audience: {} }, known, ours).error, /who it's for/);
  assert.match(a.cleanAnnouncement({ ...good, audience: { roles: ["pilot"] } }, known, ours).error, /roles from the list/);
  assert.match(a.cleanAnnouncement({ ...good, endDate: "2026-10-20" }, known, ours).error, /before/);
  assert.match(a.cleanAnnouncement({ ...good, endDate: "2026-10-26" }, known, ours, "2026-10-27").error, /passed/);
  assert.match(a.cleanAnnouncement({ ...good, file: { url: "https://evil.example/x.pdf", kind: "pdf" } }, known, ours).error, /attachment/);
  const { announcement } = a.cleanAnnouncement({ ...good, title: "  New   glove rule ", audience: { everyone: true, roles: ["admin"] }, file: { url: "https://firebasestorage.googleapis.com/v0/b/cdg/o/uploads%2F1001%2Fa.pdf", kind: "pdf", name: "Rule.pdf" }, keepForNewHires: true }, known, ours);
  assert.strictEqual(announcement.title, "New glove rule");
  assert.deepStrictEqual(announcement.audience, { everyone: true, roles: [], roleTeams: [], teams: [], departments: [], lines: [], people: [] });
  assert.match(a.cleanAnnouncement({ ...good, audience: { departments: ["moon"] } }, known, ours).error, /departments from the list/);
  assert.strictEqual(announcement.file.kind, "pdf");
  assert.strictEqual(announcement.keepForNewHires, true);
  assert.strictEqual(announcement.endDate, null);
});

test("audience: everyone, or any mix of roles, teams, departments, lines, people — never someone turned off", () => {
  // No team (Decision 109): only when named — a department reaches its people on a team.
  assert.deepStrictEqual(a.matchAudience({ everyone: true }, people), ["2001", "2002", "3001", "4003"]);
  assert.deepStrictEqual(a.matchAudience({ roles: ["office"], teams: ["team-a"] }, people), ["2001", "3001"]);
  assert.deepStrictEqual(a.matchAudience({ lines: ["line-2"], people: ["1001", "2003"] }, people), ["1001", "2002"]);
  assert.deepStrictEqual(a.matchAudience({ departments: ["quality"] }, people), ["4003"]);
  assert.deepStrictEqual(a.matchAudience({ departments: ["quality"], teams: ["team-a"], people: ["4001"] }, people), ["2001", "3001", "4001", "4003"]);
});

test("who picks what (Decision 108): Admins any audience, everyone first; department heads their department, teams, people", () => {
  const admin = a.postOptions({ roles: ["admin"], deptHead: true, department: "office" });
  assert.deepStrictEqual(admin.start, { everyone: true });
  assert.strictEqual(a.checkAudience({ roles: ["operator"] }, admin), "");
  const head = a.postOptions({ roles: ["quality"], deptHead: true, department: "quality" });
  assert.deepStrictEqual(head.start, { everyone: false, departments: ["quality"] });
  assert.strictEqual(a.checkAudience({ departments: ["quality"], teams: ["team-a"], people: ["2001"] }, head), "");
  assert.match(a.checkAudience({ everyone: true }, head), /own department/);
  assert.match(a.checkAudience({ roles: ["operator"] }, head), /own department/);
  assert.match(a.checkAudience({ departments: ["office"] }, head), /own department/);
  assert.strictEqual(a.postOptions({ roles: ["supervisor"], canPost: true }).any, true); // ticked in Admin → People (107)
});

test("a supervisor's crew is their team, else nobody (no home lines)", () => {
  const by = Object.fromEntries(people.map((p) => [p.id, p]));
  assert.deepStrictEqual(a.crewOf(by["3001"], people), ["2001"]);
  assert.deepStrictEqual(a.crewOf(by["3002"], people), []); // no team: no crew (Decision 104)
  assert.deepStrictEqual(a.crewOf(by["3003"], people), []);
});

test("trackers: the poster plus supervisors with crew in the audience; scope by role", () => {
  assert.deepStrictEqual(a.trackersFor("4001", ["2001"], people), ["3001", "4001"]);
  assert.deepStrictEqual(a.trackersFor("1001", ["2002", "4001"], people), ["1001"]); // 3002 has no team, so no crew
  const ann = { createdBy: "4001" };
  assert.strictEqual(a.trackScope({ id: "4001", roles: ["office"] }, ann), "all");
  assert.strictEqual(a.trackScope({ id: "9", roles: ["plant-manager"] }, ann), "all");
  assert.strictEqual(a.trackScope({ id: "3001", roles: ["supervisor"] }, ann), "crew");
  assert.strictEqual(a.trackScope({ id: "2001", roles: ["operator"] }, ann), null);
});

test("keep for new hires: new matches are added, nobody is dropped; otherwise the list stays", () => {
  const kept = { keepForNewHires: true, audience: { roles: ["operator"] }, audienceEmps: ["2002", "4001"] };
  assert.deepStrictEqual(a.refreshedAudience(kept, [...people, { id: "5001", roles: ["operator"], team: "team-a" }]), ["2001", "2002", "4001", "5001"]);
  assert.deepStrictEqual(a.refreshedAudience({ ...kept, keepForNewHires: false }, [...people, { id: "5001", roles: ["operator"], team: "team-a" }]), ["2002", "4001"]);
});

test("editing the words, attachment, or priority means everyone signs again; dates and audience don't", () => {
  const before = { title: "A", body: "B", priority: "normal", file: null };
  assert.strictEqual(a.contentChanged(before, { ...before, ackBy: "2026-11-01", endDate: "2026-12-01" }), false);
  assert.strictEqual(a.contentChanged(before, { ...before, body: "B!" }), true);
  assert.strictEqual(a.contentChanged(before, { ...before, priority: "safety" }), true);
  assert.strictEqual(a.contentChanged(before, { ...before, file: { url: "https://x" } }), true);
});

test("dates: overdue after the acknowledge-by day, ended after the end day or when ended early", () => {
  assert.strictEqual(a.isOverdue({ ackBy: "2026-10-20" }, "2026-10-20"), false);
  assert.strictEqual(a.isOverdue({ ackBy: "2026-10-20" }, "2026-10-21"), true);
  assert.strictEqual(a.isEnded({ endDate: "2026-10-20" }, "2026-10-20"), false);
  assert.strictEqual(a.isEnded({ endDate: "2026-10-20" }, "2026-10-21"), true);
  assert.strictEqual(a.isEnded({ ended: true }, "2026-10-01"), true);
  assert.strictEqual(a.isEnded({ endDate: null }, "2099-01-01"), false);
});

test("tracking: no login shows as No login, not just not signed; in-person counts as signed", () => {
  const list = [
    a.personStatus({ id: "1", loginEnabled: true }, { method: "pin" }),
    a.personStatus({ id: "2", loginEnabled: true }, null),
    a.personStatus({ id: "3", loginEnabled: false }, null),
    a.personStatus({ id: "4", loginEnabled: false }, { method: "in-person" }),
  ];
  assert.deepStrictEqual(list.map((p) => p.state), ["signed", "not-signed", "no-login", "in-person"]);
  assert.deepStrictEqual(a.countUp(list), { total: 4, signed: 2, notSigned: 1, noLogin: 1 });
});

test("device on a sign-off is cleaned up", () => {
  assert.deepStrictEqual(a.cleanDevice({ id: "abc12345-x", kind: "line-tablet", label: "Line tablet · iPad" }), { id: "abc12345-x", kind: "line-tablet", label: "Line tablet · iPad" });
  assert.deepStrictEqual(a.cleanDevice({ id: "<script>", kind: "hack" }), { id: "unknown", kind: "personal", label: "Personal device" });
});

test("Important: only the Line Leads and Supervisors in the audience sign; Normal and Safety: everyone", () => {
  const people = [{ id: "1", roles: ["operator"] }, { id: "2", roles: ["lead"] }, { id: "3", roles: ["supervisor", "admin"] }, { id: "4", roles: ["office"] }];
  const audienceEmps = ["1", "2", "3"];
  assert.deepStrictEqual(a.signersOf({ priority: "important", audienceEmps }, people), ["2", "3"]);
  assert.deepStrictEqual(a.signersOf({ priority: "normal", audienceEmps }, people), audienceEmps);
  assert.deepStrictEqual(a.signersOf({ priority: "safety", audienceEmps }, people), audienceEmps);
  assert.strictEqual(a.signsIt({ priority: "important" }, ["operator"]), false);
  assert.strictEqual(a.signsIt({ priority: "important" }, ["lead"]), true);
  assert.deepStrictEqual(a.signersOf({ priority: "important", audienceEmps: ["1", "4"] }, people), []);
});

test("roles on chosen teams only: e.g. the Supervisors of Team B — their own team or a team they cover", () => {
  const out = a.cleanAnnouncement({ ...good, audience: { roles: ["supervisor"], roleTeams: ["team-b"] } }, known, ours);
  assert.deepStrictEqual(out.announcement.audience.roleTeams, ["team-b"]);
  assert.match(a.cleanAnnouncement({ ...good, audience: { roles: ["supervisor"], roleTeams: ["team-z"] } }, known, ours).error, /teams/);
  assert.deepStrictEqual(a.cleanAnnouncement({ ...good, audience: { teams: ["team-a"], roleTeams: ["team-b"] } }, known, ours).announcement.audience.roleTeams, []);
  const staff = [
    { id: "1", roles: ["supervisor"], team: "team-a" },
    { id: "2", roles: ["supervisor"], team: "team-a", supervisesTeams: ["team-a", "team-b"] },
    { id: "3", roles: ["supervisor"], team: "team-b" },
    { id: "4", roles: ["operator"], team: "team-b" },
  ];
  assert.deepStrictEqual(a.matchAudience({ roles: ["supervisor"], roleTeams: ["team-b"] }, staff), ["2", "3"]);
  assert.deepStrictEqual(a.matchAudience({ roles: ["supervisor"] }, staff), ["1", "2", "3"]);
  assert.deepStrictEqual(a.matchAudience({ roles: ["supervisor"], roleTeams: ["team-b"], people: ["4"] }, staff), ["2", "3", "4"]);
});

test("who posts (Decision 106): Admins, department heads, and people ticked Can post", () => {
  assert.ok(a.canPostNow({ roles: ["admin"] }));
  assert.ok(a.canPostNow({ roles: ["office"], deptHead: true }));
  assert.ok(a.canPostNow({ roles: ["supervisor"], canPost: true }));
  assert.ok(!a.canPostNow({ roles: ["supervisor"] }));
  assert.ok(!a.canPostNow({ roles: ["office"], canPost: "yes" }));
});
