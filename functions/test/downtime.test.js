const test = require("node:test");
const assert = require("node:assert");
const d = require("../downtime");

test("lists match the workbook's Lists tab, without No reason given", () => {
  assert.deepStrictEqual(d.CHANGEOVER_TYPES, ["Full", "Pin/Mandrel", "Color", "SDR"]);
  assert.ok(!d.DOWNTIME_REASONS.includes("No reason given") && d.DOWNTIME_REASONS.includes("Unknown"));
  assert.ok(!d.SCRAP_REASONS.includes("No reason given") && d.SCRAP_REASONS.includes("Other"));
});

test("Decision 141: reasons in three groups, renames, old names kept", () => {
  assert.deepStrictEqual(d.REASON_GROUPS.map((g) => g.id), ["planned", "not-downtime", "unplanned"]);
  assert.strictEqual(d.DOWNTIME_REASONS.length, 20);
  assert.strictEqual(new Set(d.DOWNTIME_REASONS).size, 20);
  for (const r of ["Scheduled Maintenance", "Controlled Shutdown", "Changeover", "Startup"]) assert.strictEqual(d.groupOf(r), "planned");
  assert.strictEqual(d.groupOf("Printer only – line running"), "not-downtime");
  for (const r of ["Extruder", "Water (temp/level)", "Heat / temperature", "Staffing", "Unknown", "Other"]) assert.strictEqual(d.groupOf(r), "unplanned");
  assert.ok(!d.DOWNTIME_REASONS.includes("Water") && !d.DOWNTIME_REASONS.includes("Heat"));
  // old names stay Unplanned; anything unknown counts as Unplanned, to be safe
  for (const r of ["Water", "Heat", "No reason given", "Something new"]) assert.strictEqual(d.countsAsDowntime(r), true);
  assert.strictEqual(d.countsAsDowntime("Startup"), false);
  assert.strictEqual(d.needsReview("Unknown"), true);
  assert.strictEqual(d.needsReview("Other"), false);
  assert.deepStrictEqual(d.minutesByGroup([{ reason: "Extruder", minutes: 30 }, { reason: "Water", minutes: 10 }, { reason: "Startup", minutes: 45 }, { reason: "Printer only – line running", minutes: 12 }]),
    { unplanned: 40, planned: 45, notDowntime: 12 });
});

test("Decision 141: the What happened write-up and Changeover", () => {
  const base = { minutes: "20", reason: "Extruder", maintenance: "team" };
  assert.match(d.cleanDowntime({ ...base, fix: "Fixed it" }).error, /full sentence/);
  assert.match(d.cleanDowntime({ ...base, fix: "a - - - -" }).error, /full sentence/);
  assert.strictEqual(d.cleanDowntime({ ...base, fix: "Screen pack clogged, swapped it out" }).event.fix, "Screen pack clogged, swapped it out");
  assert.match(d.cleanDowntime({ ...base, reason: "Changeover", fix: "Float filter clogged on the vac tank, cleaned it" }).error, /Changeover Log/);
  // a new entry can't use an old name; editing an old entry may keep it
  assert.match(d.cleanDowntime({ ...base, reason: "Water", fix: "Float filter clogged on the vac tank, cleaned it" }).error, /reason/);
  assert.strictEqual(d.cleanDowntime({ ...base, reason: "Water", fix: "Float filter clogged on the vac tank, cleaned it" }, { reason: "Water" }).event.reason, "Water");
  assert.match(d.cleanDowntime({ ...base, reason: "Heat", fix: "Float filter clogged on the vac tank, cleaned it" }, { reason: "Water" }).error, /reason/);
});

test("product size is saved like the workbook; line # and team", () => {
  assert.deepStrictEqual(d.cleanProduct({ size: "1.25\"", sdr: "SDR 13.5" }).productSize, "1.25\" SDR 13.5");
  assert.match(d.cleanProduct({ size: "1\"" }).error, /SDR/);
  assert.strictEqual(d.lineNumber("Line 2"), "2");
  assert.strictEqual(d.reportId("line-1", "2026-10-22", "nights"), "line-1__2026-10-22__nights");
});

test("changeover, downtime, and scrap entries are checked", () => {
  assert.deepStrictEqual(d.cleanChangeover({ minutes: "45", type: "Color" }), { changeover: { minutes: 45, type: "Color" } });
  assert.match(d.cleanChangeover({ minutes: "45", type: "Fast" }).error, /type/);
  const W = "Water (temp/level)";
  const ok = d.cleanDowntime({ minutes: "90", reason: W, called: true, calledWho: " Sam ", maintenance: "called", issueId: "odoo-124", fix: "Float filter clogged on the vac tank, cleaned it" });
  assert.deepStrictEqual(ok.event, { minutes: 90, over60: true, reason: W, called: true, calledWho: "Sam", maintenance: "called", issueId: "odoo-124", fix: "Float filter clogged on the vac tank, cleaned it", machineId: null });
  assert.match(d.cleanDowntime({ minutes: "10", reason: W, called: true, maintenance: "none", fix: "Float filter clogged on the vac tank, cleaned it" }).error, /who/);
  assert.match(d.cleanDowntime({ minutes: "10", reason: "No reason given", maintenance: "none", fix: "Float filter clogged on the vac tank, cleaned it" }).error, /reason/);
  assert.match(d.cleanDowntime({ minutes: "10", reason: W, fix: "Float filter clogged on the vac tank, cleaned it" }).error, /maintenance/);
  assert.match(d.cleanDowntime({ minutes: "10", reason: W, maintenance: "team", fix: "" }).error, /what happened/i);
  assert.strictEqual(d.cleanDowntime({ minutes: "10", reason: W, maintenance: "team", issueId: "x", fix: "Float filter clogged on the vac tank, cleaned it" }).event.issueId, null);
  assert.deepStrictEqual(d.cleanScrap({ feet: "800", reason: "Startup/Purge", notes: "" }).scrap, { feet: 800, reason: "Startup/Purge", notes: "", tag: "" });
  assert.match(d.cleanScrap({ feet: "800", reason: "Other" }).error, /note/);
  assert.match(d.cleanScrap({ feet: "0", reason: "Other" }).error, /Feet/);
});

test("Someone Contacted? and Maintenance Log Completed? follow the approved rule", () => {
  const ev = (x) => ({ minutes: 30, called: false, maintenance: "none", issueId: null, ...x });
  assert.strictEqual(d.someoneContacted(ev({ called: true })), "Yes");
  assert.strictEqual(d.someoneContacted(ev({ minutes: 61 })), "No");
  assert.strictEqual(d.someoneContacted(ev({ maintenance: "called" })), "No");
  assert.strictEqual(d.someoneContacted(ev({ maintenance: "team" })), "Not Needed");
  assert.strictEqual(d.maintenanceLog(ev({ maintenance: "called", issueId: "odoo-1" })), "Yes");
  assert.strictEqual(d.maintenanceLog(ev({ maintenance: "called" })), "No");
  assert.strictEqual(d.maintenanceLog(ev({ maintenance: "team" })), "Not Needed");
  assert.strictEqual(d.downtimeNotes({ fix: "Cleared filter.", called: true, calledWho: "Sam Sample", maintenance: "called", issueTitle: "#124 Vac tank" }),
    "Cleared filter. Called: Sam Sample. Maintenance: #124 Vac tank");
});

test("a flagged reel decided Scrap or Regrind is a scrap entry, counted once", () => {
  const reel = { id: "r1", tag: "1045", reasonName: "Ovality", footage: 900, product: { size: "1\"", sdr: "SDR 11" }, decision: { kind: "regrind", label: "Regrind" } };
  const s = d.reelScrap(reel);
  assert.deepStrictEqual([s.feet, s.reason, s.productSize, s.source], [900, "Sizing Out of Spec", "1\" SDR 11", "reel"]);
  assert.match(s.notes, /tag 1045, Ovality, Regrind/);
  assert.strictEqual(d.reelScrap({ ...reel, reclaim: { footage: 650 } }).feet, 650);
  assert.strictEqual(d.reelScrap({ ...reel, reasonName: "Kinks or bends" }).reason, "Other");
  assert.strictEqual(d.reelScrap({ ...reel, decision: { kind: "release" } }), null);
  assert.strictEqual(d.duplicateTag(" 1045 ", [reel]), true);
  assert.strictEqual(d.duplicateTag("", [reel]), false);
});

test("workbook rows: data columns only, in column order", () => {
  const report = { date: "2026-10-22", lineNumber: "1", team: "A", productSize: "1.25\" SDR 13.5" };
  const changeovers = [{ minutes: 30, type: "SDR", productSize: "1.25\" SDR 11", atMs: 2 }, { minutes: 60, type: "Color", productSize: "1\" SDR 11", atMs: 1 }];
  const rows = d.sheetRows(report, [{ minutes: 50, reason: "Water", fix: "Topped up", called: false, maintenance: "team" }], [{ feet: 300, reason: "Startup/Purge", notes: "" }, { feet: null, reason: "Other" }], changeovers);
  assert.deepStrictEqual(rows.changeover, [["2026-10-22", "1", "A", "1\" SDR 11", 60, "Color"], ["2026-10-22", "1", "A", "1.25\" SDR 11", 30, "SDR"]]);
  // the first practice reports kept one changeover on the report itself — still exported
  assert.strictEqual(d.sheetRows({ ...report, changeover: { minutes: 45, type: "Full", atMs: 0 } }, [], [], changeovers).changeover.length, 3);
  assert.deepStrictEqual(rows.downtime, [["2026-10-22", "1", "A", "1.25\" SDR 13.5", 50, "Water", "Topped up. Fixed by team", "Not Needed", "Not Needed"]]);
  assert.deepStrictEqual(rows.scrap, [["2026-10-22", "1", "A", "1.25\" SDR 13.5", 300, "Startup/Purge", ""]]);
  for (const k of Object.keys(rows)) assert.strictEqual(d.SHEET_HEADERS[k].length, (rows[k][0] || d.SHEET_HEADERS[k]).length);
});

test("before signing, downtime and scrap each need entries or None this shift", () => {
  assert.ok(d.notReadyToSign({}, { downtime: 0, scrap: 0 }).includes("downtime and scrap"));
  assert.ok(d.notReadyToSign({ none: { downtime: { by: "1" } } }, { downtime: 0, scrap: 0 }).includes("scrap"));
  assert.strictEqual(d.notReadyToSign({ none: { scrap: { by: "1" } } }, { downtime: 2, scrap: 0 }), null);
  assert.strictEqual(d.notReadyToSign({}, { downtime: 1, scrap: 3 }), null);
  // Decision 141: every downtime entry needs its write-up first (older entries had a few words only)
  assert.match(d.notReadyToSign({}, { downtime: 2, scrap: 1 }, [{ fix: "Topped up" }, { fix: "Float filter clogged on the vac tank, cleaned it" }]), /1 downtime entry needs/);
  assert.strictEqual(d.notReadyToSign({}, { downtime: 1, scrap: 1 }, [{ fix: "Float filter clogged on the vac tank, cleaned it" }]), null);
});
