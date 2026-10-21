const test = require("node:test");
const assert = require("node:assert");
const s = require("../silos");

test("levels come from the handoff's silo fields only, 0–100", () => {
  assert.deepStrictEqual(s.levelsFrom({ "silo-1": 40, "silo-2": "", "silo-3": 120, "regrind-silo": "55.55", "tape-footage": 900 }), { "silo-1": 40, "regrind-silo": 55.6 });
});

test("settings: no low level until set; Silos 1–4 alert by default, Regrind off", () => {
  const { silos } = s.cleanSettings({ "silo-1": { low: "25" } });
  assert.deepStrictEqual(silos["silo-1"], { low: 25, alert: true });
  assert.deepStrictEqual(silos["silo-2"], { low: null, alert: true });
  assert.deepStrictEqual(silos["regrind-silo"], { low: null, alert: false });
  assert.match(s.cleanSettings({ "silo-1": { low: 0 } }).error, /1–99/);
});

test("one alert per drop; again only after a refill above the line", () => {
  const set = { low: 25, alert: true };
  let st = s.judge(set, false, 30); assert.deepStrictEqual(st, { alert: false, alerted: false });
  st = s.judge(set, st.alerted, 20); assert.deepStrictEqual(st, { alert: true, alerted: true });
  st = s.judge(set, st.alerted, 15); assert.deepStrictEqual(st, { alert: false, alerted: true }); // no repeat
  st = s.judge(set, st.alerted, 60); assert.deepStrictEqual(st, { alert: false, alerted: false }); // refilled
  st = s.judge(set, st.alerted, 22); assert.deepStrictEqual(st, { alert: true, alerted: true }); // new drop
});

test("no alerts when the low level isn't set or the silo's alert is off", () => {
  assert.strictEqual(s.judge({ low: null, alert: true }, false, 5).alert, false);
  assert.strictEqual(s.judge({ low: 25, alert: false }, false, 5).alert, false);
  assert.strictEqual(s.judge(undefined, false, 5).alert, false);
});
