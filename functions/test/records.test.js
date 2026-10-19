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

test("the app hands out the lowest unused employee number from 1001 up", () => {
  assert.strictEqual(r.nextEmployeeNumber([]), "1001");
  assert.strictEqual(r.nextEmployeeNumber(["1001"]), "1002");
  assert.strictEqual(r.nextEmployeeNumber(["1001", "9000"]), "1002");
  assert.strictEqual(r.nextEmployeeNumber(["1001", "1002", "1004"]), "1003");
  assert.strictEqual(r.nextEmployeeNumber(["A12", "15"]), "1001");
});

test("machine notes keep line breaks and have a length limit", () => {
  assert.strictEqual(r.cleanNotes("  Bought 2019\r\nRebuilt 2024 "), "Bought 2019\nRebuilt 2024");
  assert.strictEqual(r.cleanNotes(undefined), "");
  assert.strictEqual(r.cleanNotes("x".repeat(1001)), null);
});

test("suggested roles from Gusto job titles", () => {
  const s = r.suggestRoles;
  assert.deepStrictEqual(s("Extrusion Operator"), ["operator"]);
  assert.deepStrictEqual(s("Production Line Lead"), ["lead"]);
  assert.deepStrictEqual(s("Production Supervisor"), ["supervisor"]);
  assert.deepStrictEqual(s("Maintenance Technician"), ["maintenance"]);
  assert.deepStrictEqual(s("Quality Control Inspector"), ["quality"]);
  assert.deepStrictEqual(s("Shipping & Receiving"), ["shipping"]);
  assert.deepStrictEqual(s("Forklift Driver"), ["shipping"]);
  assert.deepStrictEqual(s("Inside Sales"), ["sales"]);
  assert.deepStrictEqual(s("Office Manager"), ["office"]);
  assert.deepStrictEqual(s("HR Generalist"), ["office"]);
  assert.deepStrictEqual(s("Safety & Training Coordinator"), ["training-safety"]);
  assert.deepStrictEqual(s("Business Administrator"), ["office"]);
  assert.deepStrictEqual(s("Shop Help"), ["operator"]);
  assert.deepStrictEqual(s("Director of Operations"), ["supervisor"]);
  assert.deepStrictEqual(s("Plant Manager"), ["plant-manager"]);
  assert.deepStrictEqual(s("Facilities & Maintenance Manager"), ["maintenance"]);
  assert.deepStrictEqual(s("Supply Chain and Logistics Manager"), ["shipping"]);
  assert.deepStrictEqual(s("Owner"), []);
  assert.deepStrictEqual(s("CEO"), []);
});
