const test = require("node:test");
const assert = require("node:assert");
const m = require("../machinespecs");

test("edit rights: Maintenance and Admin until the Roles screen says otherwise; Production Manager views", () => {
  const roles = [{ id: "maintenance" }, { id: "admin" }, { id: "plant-manager" }, { id: "lead", editMachines: true }, { id: "operator" }];
  assert.strictEqual(m.canEditMachines(roles, ["maintenance"]), true);
  assert.strictEqual(m.canEditMachines(roles, ["plant-manager"]), false);
  assert.strictEqual(m.canEditMachines(roles, ["lead"]), true);
  assert.strictEqual(m.canEditMachines([{ id: "maintenance", editMachines: false }], ["maintenance"]), false);
  assert.strictEqual(m.canViewMachines(roles, ["plant-manager"]), true);
  assert.strictEqual(m.canViewMachines(roles, ["operator"]), false);
});

test("info: fields trimmed, install date must be a date", () => {
  assert.deepStrictEqual(m.cleanInfo({ make: " Davis-Standard ", installDate: "2019-06-01", extra: "x" }).info,
    { make: "Davis-Standard", model: "", serial: "", vendor: "", notes: "", installDate: "2019-06-01" });
  assert.match(m.cleanInfo({ installDate: "June" }).error, /date/);
});

test("rows keep their ids, new rows get one, required field checked, quantity is a number", () => {
  const { items } = m.cleanSection("parts", [{ id: "a1", name: "Bearing", partNumber: "6205-ZZ", qty: "2" }, { name: "Belt" }]);
  assert.strictEqual(items[0].id, "a1");
  assert.strictEqual(items[0].qty, 2);
  assert.match(items[1].id, /^r/);
  assert.strictEqual(items[1].qty, null);
  assert.match(m.cleanSection("parts", [{ partNumber: "1" }]).error, /Part name/);
  assert.match(m.cleanSection("parts", [{ name: "x", qty: "lots" }]).error, /number/);
  assert.match(m.cleanSection("teeth", []).error, /Unknown/);
});

test("files must be in our storage; labels from the list; safety notes flagged", () => {
  const ours = (u) => u.startsWith("https://ours/");
  assert.match(m.cleanSection("files", [{ url: "https://evil/x.pdf" }], ours).error, /upload/);
  const { items } = m.cleanSection("files", [{ url: "https://ours/a.pdf", kind: "pdf", label: "Manual" }, { url: "https://ours/b.jpg", label: "Selfie" }], ours);
  assert.deepStrictEqual(items.map((i) => [i.kind, i.label, i.name]), [["pdf", "Manual", "Document"], ["image", "Other", "Photo"]]);
  assert.strictEqual(m.cleanSection("notes", [{ text: "Lock out first", safety: true }]).items[0].safety, true);
});

test("part numbers for search are normalized; diff finds added, removed, changed", () => {
  const spec = { parts: [{ partNumber: "62-05 ZZ", vendorPartNumber: "SKF6205" }], belts: [{ partNumber: "B-42" }] };
  assert.deepStrictEqual(m.partNumbersOf(spec), ["6205zz", "b42", "skf6205"]);
  assert.strictEqual(m.normPart(" 6205-zz "), "6205zz");
  const d = m.diffSection([{ id: "a", name: "x" }, { id: "b", name: "y" }], [{ id: "a", name: "x2" }, { id: "c", name: "z" }]);
  assert.deepStrictEqual([d.added, d.removed.map((r) => r.id), d.changed], [1, ["b"], 1]);
  assert.strictEqual(m.describeDiff("parts", d), "1 added, 1 removed, 1 changed");
  const copy = m.copyRows([{ id: "a", name: "x" }]);
  assert.notStrictEqual(copy[0].id, "a");
  assert.strictEqual(copy[0].name, "x");
});

test("buying details: main + backup vendors with cost, photos in our storage, on every part section", () => {
  const ours = (u) => u.startsWith("https://ours/");
  const { items } = m.cleanSection("belts", [{ location: "Puller", partNumber: "B-42", sources: [
    { vendor: "Main Supply", vendorPartNumber: "MS-42", cost: "$1,234.567", costDate: "2026-10-23", link: "https://example.com/b42" },
    { vendor: "Backup Co", cost: "" },
    { vendor: "", vendorPartNumber: "", cost: "" }, // empty source dropped
  ], photos: [{ url: "https://ours/p.jpg", name: "Belt" }] }], ours);
  assert.deepStrictEqual(items[0].sources, [
    { vendor: "Main Supply", vendorPartNumber: "MS-42", cost: 1234.57, costDate: "2026-10-23", link: "https://example.com/b42" },
    { vendor: "Backup Co", vendorPartNumber: "", cost: null, costDate: "", link: "" },
  ]);
  assert.deepStrictEqual(items[0].photos, [{ url: "https://ours/p.jpg", name: "Belt" }]);
  assert.match(m.cleanSection("fluids", [{ what: "Oil", sources: [{ vendor: "x", cost: "cheap" }] }]).error, /Oil: the cost/);
  assert.match(m.cleanSection("parts", [{ name: "Gear", photos: [{ url: "https://evil/x.jpg" }] }], ours).error, /photo/);
  assert.match(m.cleanSection("parts", [{ name: "Gear", sources: [{ vendor: "x", link: "javascript:alert(1)" }] }]).error, /link/);
  assert.match(m.cleanSection("parts", [{ name: "Gear", sources: Array(6).fill({ vendor: "x" }) }]).error, /up to 5/);
  assert.strictEqual(m.cleanSection("fasteners", [{ location: "Die bolt", partNumber: "FB-1" }]).items[0].partNumber, "FB-1");
});

test("buying details: an older screen's vendor becomes the main source, and the main source is mirrored back", () => {
  const { items } = m.cleanSection("parts", [{ name: "Bearing", vendor: "SKF", vendorPartNumber: "6205" }]);
  assert.deepStrictEqual(items[0].sources, [{ vendor: "SKF", vendorPartNumber: "6205", cost: null, costDate: "", link: "" }]);
  const two = m.cleanSection("parts", [{ name: "Bearing", vendor: "old", sources: [{ vendor: "New Main", vendorPartNumber: "N1" }] }]).items[0];
  assert.deepStrictEqual([two.vendor, two.vendorPartNumber], ["New Main", "N1"]);
});

test("part number search covers every part section and backup vendors' part numbers", () => {
  const spec = { fasteners: [{ partNumber: "FB-1" }], fluids: [{ partNumber: "OIL 68", sources: [{ vendorPartNumber: "X-9" }, { vendorPartNumber: "Y 7" }] }] };
  assert.deepStrictEqual(m.partNumbersOf(spec), ["fb1", "oil68", "x9", "y7"]);
});
