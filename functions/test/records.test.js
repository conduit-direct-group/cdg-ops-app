// Run with: npm test   (from the functions folder)
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../records");

test("machine IDs are M- plus at least 3 digits", () => {
  assert.equal(r.machineIdFor(1), "M-001");
  assert.equal(r.machineIdFor(42), "M-042");
  assert.equal(r.machineIdFor(1000), "M-1000");
  assert.equal(r.isMachineId("M-001"), true);
  assert.equal(r.isMachineId("M-1000"), true);
  assert.equal(r.isMachineId("M-01"), false);
  assert.equal(r.isMachineId("L3-EXT-01"), false);
});

test("names are tidied and length-checked", () => {
  assert.equal(r.cleanName("  Line   3 "), "Line 3");
  assert.equal(r.cleanName(""), null);
  assert.equal(r.cleanName("x".repeat(61)), null);
  assert.equal(r.cleanName(7), null);
  assert.equal(r.cleanOptional(""), "");
  assert.equal(r.cleanOptional(undefined), "");
  assert.equal(r.cleanOptional(" Extruder "), "Extruder");
});

test("record ids come from names and never change format", () => {
  assert.equal(r.idFromName("Line 3"), "line-3");
  assert.equal(r.idFromName("Production Lead / Supervisor"), "production-lead-supervisor");
  assert.equal(r.idFromName("  Shipping!! "), "shipping");
  assert.equal(r.idFromName("3rd shift"), null); // must start with a letter
  assert.equal(r.idFromName("!!!"), null);
  assert.equal(r.isRecordId("line-3"), true);
  assert.equal(r.isRecordId("Line 3"), false);
});
