const test = require("node:test");
const assert = require("node:assert");
const c = require("../checklists");
const f = require("../fixes");

const lines = [{ id: "line-1" }, { id: "line-2" }, { id: "line-9", active: false }];
const machines = [
  { type: "Extruder", lineId: "line-1" },
  { type: "Cooling Tank", lineId: "line-1" },
  { type: "Cooling Tank", lineId: "line-1" },
  { type: "Extruder", lineId: "line-2" },
  { type: "Extruder", lineId: "line-9" },
  { type: "Chilling/Main Water Supply", lineId: null },
];
const templates = c.STARTING_CHECKLISTS.map((t) => ({ id: t.id, ...c.startingTemplate(t) }));

test("item ids match the old library", () => {
  assert.strictEqual(c.itemId("Check barrel and die temperatures for abnormalities"), "check_barrel_and_die_temperatures_for_abnormalities");
  assert.strictEqual(c.itemId("Puller / Laser / Ink Jet"), "puller_laser_ink_jet");
});

test("one checklist per line per template, plus plant-wide ones", () => {
  const ids = c.checklistUnits(templates, lines, machines).map((u) => u.id).sort();
  assert.deepStrictEqual(ids, ["line-1__cooling-tank", "line-1__extruder", "line-2__extruder", "plant__chiller"]);
});

test("retired templates and machines don't make checklists", () => {
  const off = templates.map((t) => (t.id === "extruder" ? { ...t, active: false } : t));
  assert.ok(!c.checklistUnits(off, lines, machines).some((u) => u.templateId === "extruder"));
  const noChiller = machines.map((m) => (m.lineId === null ? { ...m, active: false } : m));
  assert.ok(!c.checklistUnits(templates, lines, noChiller).some((u) => u.id === "plant__chiller"));
});

test("never done = overdue; done recently = not overdue; 14 days later = overdue", () => {
  const t = templates.find((x) => x.id === "chiller");
  const now = Date.UTC(2026, 9, 16);
  assert.strictEqual(c.unitStatus(t, {}, now).overdue, true);
  assert.strictEqual(c.unitStatus(t, {}, now).never, 2);
  const done = { blow_out_condenser_fins: { at: now - 2 * c.DAY_MS, byName: "Chris" }, clean_main_water_filter: { at: now - 1 * c.DAY_MS } };
  const s = c.unitStatus(t, done, now);
  assert.strictEqual(s.overdue, false);
  assert.strictEqual(s.daysLeft, 12);
  assert.strictEqual(s.lastBy, "");
  assert.strictEqual(c.unitStatus(t, done, now + 13 * c.DAY_MS).overdue, true);
});

test("editing a checklist keeps item ids and training media", () => {
  const existing = { items: [{ id: "a_b", text: "A b", photos: ["https://x/p.jpg"], videos: [] }] };
  const { template } = c.cleanTemplate(
    { name: "Test", machineTypes: ["Extruder"], everyDays: 14, items: [{ id: "a_b", text: "A b, reworded" }, { text: "New one" }] },
    existing
  );
  assert.deepStrictEqual(template.items.map((i) => i.id), ["a_b", "new_one"]);
  assert.deepStrictEqual(template.items[0].photos, ["https://x/p.jpg"]);
  assert.match(c.cleanTemplate({ name: "", machineTypes: ["X"], everyDays: 14, items: [{ text: "a" }] }).error, /name/);
  assert.match(c.cleanTemplate({ name: "T", machineTypes: ["X"], everyDays: 0, items: [{ text: "a" }] }).error, /1 to 365/);
  assert.match(c.cleanTemplate({ name: "T", machineTypes: ["X"], everyDays: 7, items: [{ text: "a" }, { text: "A" }] }).error, /twice/);
});

test("trash: only our own files that came off a fix", () => {
  const own = "https://firebasestorage.googleapis.com/v0/b/cdg-ops-app.firebasestorage.app/o/uploads%2F1001%2F1_a.jpg?alt=media&token=t";
  const other = "https://firebasestorage.googleapis.com/v0/b/line-library.firebasestorage.app/o/uploads%2Fb.jpg?alt=media";
  const yt = "https://youtu.be/abcdefg";
  assert.strictEqual(f.storagePath(own, "cdg-ops-app.firebasestorage.app"), "uploads/1001/1_a.jpg");
  assert.strictEqual(f.storagePath(other, "cdg-ops-app.firebasestorage.app"), null);
  const before = { photos: [own, other], videos: [yt], docLink: "" };
  assert.deepStrictEqual(f.droppedFiles(before, { photos: [], videos: [], docLink: "" }, "cdg-ops-app.firebasestorage.app"), [own]);
  assert.deepStrictEqual(f.droppedFiles(before, before, "cdg-ops-app.firebasestorage.app"), []);
});

test("version keeps the fix's own fields only", () => {
  const v = f.versionOf({ title: "T", body: "B", status: "approved", votes: { 1: true }, createdBy: "1001" });
  assert.deepStrictEqual(Object.keys(v).sort(), [...f.VERSION_FIELDS].sort());
  assert.strictEqual(v.title, "T");
  assert.strictEqual(v.docLink, null);
});
