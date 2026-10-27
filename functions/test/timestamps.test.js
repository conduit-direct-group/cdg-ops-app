// Decision 120 (Chris, 10-27-2026): timestamps everywhere — who, line / machine, and old values on every edit.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const h = require("../history");
const reels = require("../reels");
const downtime = require("../downtime");

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const training = fs.readFileSync(path.join(__dirname, "..", "training-api.js"), "utf8");
// The text of one exported function: from "exports.<name> =" to the next "exports." (or the end).
const body = (name, text = src) => {
  const start = text.indexOf(`exports.${name} = `);
  assert.ok(start >= 0, `${name} not found`);
  const next = text.indexOf("\nexports.", start + 10);
  return text.slice(start, next < 0 ? undefined : next);
};

test("every edit that used to overwrite now keeps the old value", () => {
  const edits = [
    "adminUpdateEmployee", "adminSaveOrg", "adminSaveMachine", "adminSetStationMachine", "adminSaveRequestType",
    "postAnnouncement", "adminSetChecklistMedia", "adminSaveRotation", "adminSaveCallSheet", "adminSaveReelSettings",
    "adminSaveSiloSettings", "adminSaveDepartments", "docSetDepartment", "saveHandoffDraft", "saveStationList",
    "saveLineNotes", "saveShiftReport", "saveShiftEntry", "saveTruck", "undoTruck", "crewMark", "crewSetup",
    "crewSeat", "crewCell", "saveIncidentFollowUp",
  ];
  const missing = edits.filter((n) => !/keepHistory(Now)?\(/.test(body(n)));
  assert.deepStrictEqual(missing, [], `no keepHistory in: ${missing.join(", ")}`);
  // roles, lines, teams, shifts share saveNamedRecord
  const named = src.slice(src.indexOf("async function saveNamedRecord"), src.indexOf("// Roles: create"));
  assert.match(named, /keepHistory\(/);
  // Odoo sync changes, trainee records, trainer settings, workbook settings
  assert.match(src.slice(src.indexOf("async function syncFromOdoo"), src.indexOf("async function syncAndRecord")), /historyLib\.diff/);
  assert.match(training, /keepHistory\(tx, ref, before/);
  assert.match(body("adminSetTrainer", training.replace(/const adminSetTrainer = /, "exports.adminSetTrainer = ")), /keepHistoryNow\(/);
});

test("a removed downtime / scrap entry keeps a full copy, and an edit keeps the original author", () => {
  const b = body("saveShiftEntry");
  assert.match(b, /action: "delete"/);
  assert.match(b, /cur \? \{ updatedBy: me\.employeeNumber/);
});

test("who is saved where it was missing", () => {
  assert.match(body("saveLineNotes"), /updatedBy: me\.employeeNumber/);
  assert.match(body("discardHandoff"), /discardedBy: me\.employeeNumber/);
  assert.match(body("voteFix"), /lastVoteBy: me\.employeeNumber/);
  assert.match(body("logSearchGap"), /lastBy: me\.employeeNumber/);
});

test("device time is kept and flagged in the sign-off log, never dropped", () => {
  const log = src.slice(src.indexOf("function logSignoff"), src.indexOf("async function logSignoffNow"));
  assert.match(log, /deviceAtMs/);
  assert.match(log, /type: "clock flag"/);
  assert.match(src.slice(src.indexOf("function signable"), src.indexOf("async function peopleList")), /offlineLib\.clockCheck/);
});

test("line on maintenance requests; machine on downtime and flagged reels", () => {
  assert.strictEqual((src.match(/machineId: machine\.id, lineId: machine\.lineId \|\| null/g) || []).length, 2);
  const ok = downtime.cleanDowntime({ minutes: 5, reason: downtime.DOWNTIME_REASONS[0], called: false, maintenance: "none", fix: "cleaned it", machineId: "M-012" });
  assert.strictEqual(ok.event.machineId, "M-012");
  assert.strictEqual(downtime.cleanDowntime({ minutes: 5, reason: downtime.DOWNTIME_REASONS[0], called: false, maintenance: "none", fix: "cleaned it", machineId: "bad" }).event.machineId, null);
  const ms = [{ id: "M-020", name: "L1 Winder 1", lineId: "line-1" }, { id: "M-021", name: "L1 Winder 2", lineId: "line-1" }, { id: "M-030", name: "Winder 2", lineId: "line-2" }];
  assert.strictEqual(reels.winderMachine(ms, "line-1", "Winder 2"), "M-021");
  assert.strictEqual(reels.winderMachine(ms, "line-2", "Winder 2"), "M-030");
  assert.strictEqual(reels.winderMachine(ms, "line-1", "Winder 3"), null);
});

test("map fields are compared key by key (only what changed is kept)", () => {
  const before = { marks: { 9001: { status: "here" }, 9002: { status: "here" } }, team: "A" };
  const after = { marks: { 9001: { status: "here" }, 9002: { status: "out", reason: "Sick" } }, team: "A" };
  assert.deepStrictEqual(h.diff(before, h.flatten(before, after)), { old: { "marks.9002": { status: "here" } }, new: { "marks.9002": { status: "out", reason: "Sick" } } });
});
