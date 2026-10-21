const test = require("node:test");
const assert = require("node:assert");
const h = require("../hraccess");

test("HR access is a per-person switch, separate from Admin", () => {
  assert.strictEqual(h.hasHr({ roles: ["admin"], active: true }), false);
  assert.strictEqual(h.hasHr({ roles: ["operator"], hrAccess: true, active: true }), true);
  assert.strictEqual(h.hasHr({ roles: ["admin"], hrAccess: true, active: false }), false);
});

test("only someone with HR access can grant it; the first grant is an Admin giving it to himself", () => {
  const chris = { employeeNumber: "1001", roles: ["admin"], hr: false };
  const newAdmin = { employeeNumber: "1050", roles: ["admin", "training-safety"], hr: false };
  assert.deepStrictEqual(h.canSetHr(chris, "1001", false), { ok: true, firstSetup: true });
  assert.strictEqual(h.canSetHr(chris, "1050", false).ok, false); // first setup is for yourself only
  assert.strictEqual(h.canSetHr(newAdmin, "1050", true).ok, false); // a second Admin can't give it to himself
  assert.strictEqual(h.canSetHr({ ...chris, hr: true }, "1050", true).ok, true);
  assert.strictEqual(h.wouldLeaveNobody(["1001"], "1001", false), true);
  assert.strictEqual(h.wouldLeaveNobody(["1001", "1050"], "1001", false), false);
});

test("injury and first-aid photos need HR access; near-miss photos don't", () => {
  assert.strictEqual(h.photosNeedHr("injury"), true);
  assert.strictEqual(h.photosNeedHr("first-aid"), true);
  assert.strictEqual(h.photosNeedHr("near-miss"), false);
});
