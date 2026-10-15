// Run with: npm test   (from the functions folder)
const test = require("node:test");
const assert = require("node:assert/strict");
const pin = require("../pin");

test("PIN must be exactly 6 digits", () => {
  assert.equal(pin.isValidPinFormat("482915"), true);
  assert.equal(pin.isValidPinFormat("48291"), false);
  assert.equal(pin.isValidPinFormat("4829156"), false);
  assert.equal(pin.isValidPinFormat("48a915"), false);
  assert.equal(pin.isValidPinFormat(482915), false);
});

test("easy-to-guess PINs are rejected", () => {
  for (const weak of ["000000", "111111", "123456", "234567", "654321", "987654"]) {
    assert.equal(pin.isWeakPin(weak), true, weak);
  }
  assert.equal(pin.isWeakPin("482915"), false);
});

test("employee numbers are cleaned up and checked", () => {
  assert.equal(pin.normalizeEmployeeNumber(" 1042 "), "1042");
  assert.equal(pin.normalizeEmployeeNumber(1042), "1042");
  assert.equal(pin.normalizeEmployeeNumber("cdg-07"), "CDG-07");
  assert.equal(pin.normalizeEmployeeNumber(""), null);
  assert.equal(pin.normalizeEmployeeNumber("12/34"), null);
  assert.equal(pin.normalizeEmployeeNumber("1234567890123"), null);
});

test("roles are cleaned up and checked", () => {
  assert.deepEqual(pin.normalizeRoles(["Operator", "operator", "maintenance"]), ["operator", "maintenance"]);
  assert.equal(pin.normalizeRoles([]), null);
  assert.equal(pin.normalizeRoles(["bad role"]), null);
  assert.equal(pin.normalizeRoles("admin"), null);
});

test("a hashed PIN matches only the right PIN, and never stores the PIN", async () => {
  const record = await pin.hashPin("482915");
  assert.ok(!JSON.stringify(record).includes("482915"));
  assert.equal(await pin.pinMatches("482915", record), true);
  assert.equal(await pin.pinMatches("482916", record), false);
});

test("the same PIN hashes differently for two people (salt)", async () => {
  const a = await pin.hashPin("482915");
  const b = await pin.hashPin("482915");
  assert.notEqual(a.hash, b.hash);
});

test("temporary PINs are 6 digits and never weak", () => {
  for (let i = 0; i < 1000; i++) {
    const p = pin.randomTempPin();
    assert.equal(pin.isValidPinFormat(p), true);
    assert.equal(pin.isWeakPin(p), false);
  }
});

test("5th wrong try locks for 15 minutes, then it unlocks by itself", () => {
  const now = 1_000_000;
  let record = { wrongCount: 0, lockedUntilMs: null };
  for (let i = 1; i <= 4; i++) {
    const next = pin.afterWrongPin(record, now);
    assert.equal(next.justLocked, false);
    assert.equal(next.wrongCount, i);
    record = next;
  }
  const locked = pin.afterWrongPin(record, now);
  assert.equal(locked.justLocked, true);
  assert.equal(locked.wrongCount, 0);

  assert.deepEqual(pin.lockStatus(locked, now), { locked: true, minutesLeft: 15 });
  assert.deepEqual(pin.lockStatus(locked, now + 14 * 60000 + 1), { locked: true, minutesLeft: 1 });
  assert.deepEqual(pin.lockStatus(locked, now + 15 * 60000), { locked: false });
});
