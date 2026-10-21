// Records rule (Chris, 10-21-2026): injury and first-aid reports are kept 5 years — no trash, no purge. This test
// reads the server code and fails if anything could delete a live safety report or its private files.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const testData = require("../testdata");

const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
const lines = src.split(/\r?\n/);

test("no server code deletes a live safety report (5-year rule)", () => {
  const bad = lines.filter((l) => /incident/i.test(l) && /\.delete\(|recursiveDelete|deleteFiles/.test(l) && !/test_incidents|safety\/test\//.test(l));
  assert.deepStrictEqual(bad, [], "A line deletes something about incidents outside the test site");
});

test("the trash cleanup never looks at safety reports", () => {
  const purge = src.slice(src.indexOf("async function purgeOnce"), src.indexOf("exports.purgeTrash"));
  assert.ok(purge.length > 100, "purgeOnce found");
  assert.doesNotMatch(purge, /incident|safety\//);
});

test("test cleanup only touches the practice copies of safety reports", () => {
  const names = testData.TEST_COLLECTIONS.map(([n]) => n);
  assert.ok(names.includes("test_incidents"));
  assert.ok(!names.includes("incidents") && !names.includes("incidentActions"));
});
