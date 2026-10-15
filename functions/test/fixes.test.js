// Run with: npm test   (from the functions folder)
const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("../fixes");

test("Maintenance, Leads, and Admins approve; others suggest", () => {
  assert.equal(f.isApprover(["maintenance"]), true);
  assert.equal(f.isApprover(["operator", "lead"]), true);
  assert.equal(f.isApprover(["admin"]), true);
  assert.equal(f.isApprover(["operator"]), false);
  assert.equal(f.isApprover(["shipping"]), false);
  assert.equal(f.isApprover(undefined), false);
});

test("old categories map to machine types; general topics map to none", () => {
  assert.deepEqual(f.machineTypesForOldCategory("Barrels"), ["Extruder"]);
  assert.deepEqual(f.machineTypesForOldCategory("InkJet"), ["Laser/Ink Jet"]);
  assert.deepEqual(f.machineTypesForOldCategory("Cooling Tanks"), ["Cooling Tank"]);
  assert.deepEqual(f.machineTypesForOldCategory("Chiller"), ["Chilling/Main Water Supply"]);
  assert.deepEqual(f.machineTypesForOldCategory("Procedures"), []);
  assert.deepEqual(f.machineTypesForOldCategory("Striper"), []);
});

const good = { title: "Die heater fault", body: "Symptom: …\nFix: …", categoryId: "die", tags: ["heat", "heat", " die "], photos: ["https://a.example/p.jpg"], videos: [], docLink: "", machineIds: ["M-009"] };

test("a good fix is cleaned up", () => {
  const { fix, error } = f.cleanFix(good);
  assert.equal(error, undefined);
  assert.deepEqual(fix.tags, ["heat", "die"]);
  assert.deepEqual(fix.machineIds, ["M-009"]);
});

test("bad fixes get a plain-English reason", () => {
  assert.match(f.cleanFix({ ...good, title: "" }).error, /Title/);
  assert.match(f.cleanFix({ ...good, body: "   " }).error, /Write up/);
  assert.match(f.cleanFix({ ...good, categoryId: "" }).error, /category/);
  assert.match(f.cleanFix({ ...good, photos: ["javascript:alert(1)"] }).error, /https/);
  assert.match(f.cleanFix({ ...good, photos: ["http://insecure.example/x.jpg"] }).error, /https/);
  assert.match(f.cleanFix({ ...good, docLink: "not a link" }).error, /Document/);
  assert.match(f.cleanFix({ ...good, machineIds: ["L1-Extruder"] }).error, /machine/);
});

test("old library data and file links are understood", () => {
  assert.deepEqual(f.plainValue({ arrayValue: { values: [{ stringValue: "a" }, { integerValue: "3" }] } }), ["a", 3]);
  const url = "https://firebasestorage.googleapis.com/v0/b/line-library.firebasestorage.app/o/uploads%2F1788_5139_OZTW3968.MOV?alt=media&token=x";
  assert.equal(f.isOldLibraryFile(url), true);
  assert.equal(f.isOldLibraryFile("https://conduitdirectgroup.sharepoint.com/:i:/s/x"), false);
  assert.equal(f.oldFileName(url), "1788_5139_OZTW3968.MOV");
});
