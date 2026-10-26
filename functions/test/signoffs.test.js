const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const s = require("../signoffs");

test("sign-off version: the same content gives the same fingerprint, whatever the key order; any change gives a new one", () => {
  const a = s.contentVersion({ what: "Leak at winder", place: { lineId: "line-1", label: "" } });
  assert.match(a, /^c-[0-9a-f]{16}$/);
  assert.strictEqual(s.contentVersion({ place: { label: "", lineId: "line-1" }, what: "Leak at winder" }), a);
  assert.notStrictEqual(s.contentVersion({ what: "Leak at winder!", place: { lineId: "line-1", label: "" } }), a);
});

test("every sign-off log entry needs name, employee #, and a version (Decision 108 item 10)", () => {
  assert.strictEqual(s.missing({ kind: "checklist", refId: "x", emp: "1001", name: "Test Operator", version: 3 }), "");
  assert.match(s.missing({ kind: "checklist", refId: "x", emp: "1001", name: "Test Operator", version: null }), /version/);
  assert.match(s.missing({ kind: "checklist", refId: "x", name: "Test Operator", version: 1 }), /emp/);
});

test("no sign-off in the server code is logged without a version", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const calls = src.split("logSignoff(").slice(1).concat(src.split("logSignoffNow(").slice(1));
  const bad = calls.map((c) => c.slice(0, 400)).filter((c) => !/^(tx|batch|test), (test, )?entry\)/.test(c) && /^(tx|batch|true|false|test)/.test(c) && !/version[:,]/.test(c.split("});")[0]));
  assert.deepStrictEqual(bad.map((c) => c.slice(0, 80)), []);
});
