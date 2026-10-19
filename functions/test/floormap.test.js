const test = require("node:test");
const assert = require("node:assert");
const f = require("../floormap");

test("icons: plain shapes only", () => {
  assert.ok(f.safeIcon('<path d="M4 4h16l-6 8v6l-4 2v-8L4 4Z"/>'));
  assert.ok(f.safeIcon('<circle cx="12" cy="12" r="4"/><rect x="2" y="3" width="20" height="6" rx="1"/>'));
  assert.ok(!f.safeIcon('<script>alert(1)</script>'));
  assert.ok(!f.safeIcon('<path d="M0 0" onclick="x()"/>'));
  assert.ok(!f.safeIcon('<image href="https://x/y.png"/>'));
  assert.ok(!f.safeIcon('<path d="M0 0" fill="url(javascript:x)"/>'));
  assert.ok(!f.safeIcon('hello <path d="M0"/>'));
});

const small = () => ({
  W: 100, H: 100, building: { x: 0, y: 0, w: 100, h: 100 }, band: { y: 80, h: 20 }, laneY: { 1: 50 }, crowsY: 10,
  zones: [{ id: "line1", label: "Line 1", sub: "Loader → puller", x: 0, y: 0, w: 50, h: 50 }],
  stations: [{ id: "l1-extruder", label: "Extruder", tag: "LINE 1", icon: "extrude", desc: "Melts resin.", shape: "rect", w: 10, h: 10, x: 5, y: 5, zone: "line1", line: 1, docs: [{ key: "cdgsop0003", note: "Startup" }] }],
  sops: { cdgsop0003: { docNo: "CDG-SOP-0003", docTitle: "Startup", full: true, ppe: ["Gloves"], parts: [] } },
  icons: { extrude: '<path d="M0 0h1"/>' },
});

test("map file: a good one passes and keeps only known fields", () => {
  const d = small();
  d.stations[0].secret = "x";
  const r = f.cleanMap(d);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.stations.length, 1);
  assert.strictEqual(r.stations[0].secret, undefined);
  assert.strictEqual(r.layout.zones[0].label, "Line 1");
});

test("map file: bad zones, stations, or icons are refused", () => {
  assert.match(f.cleanMap({}).error, /plant map file/);
  const z = small(); z.stations[0].zone = "nowhere";
  assert.match(f.cleanMap(z).error, /Extruder/);
  const i = small(); i.icons.bad = "<script>x</script>";
  assert.match(f.cleanMap(i).error, /Icon "bad"/);
});

test("Odoo equipment names match the existing ones", () => {
  assert.strictEqual(f.odooEquipmentName({ id: "M-039", name: "Cooling Tank 2" }, "Line 3"), "M-039 L3-Cooling Tank 2");
  assert.strictEqual(f.odooEquipmentName({ id: "M-031", name: "Outside Chiller" }, ""), "M-031 Outside Chiller");
});
