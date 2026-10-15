// Run with: npm test   (from the functions folder)
const test = require("node:test");
const assert = require("node:assert/strict");
const o = require("../odoo");

test("machine IDs are read off the front of Odoo equipment names", () => {
  assert.equal(o.machineIdFromEquipmentName("M-019 L3-Extruder"), "M-019");
  assert.equal(o.machineIdFromEquipmentName("M-028 Chilling/Main Water Supply"), "M-028");
  assert.equal(o.machineIdFromEquipmentName("L3-Extruder"), null);
  assert.equal(o.machineIdFromEquipmentName(""), null);
});

test("a report is checked and tidied", () => {
  const { report } = o.cleanReport({ machineId: "M-001", description: "  Screw won't turn  ", lineDown: true, severity: "urgent", failureCategory: "Motor", rootCause: "Made up" });
  assert.equal(report.description, "Screw won't turn");
  assert.equal(report.failureCategory, "Motor");
  assert.equal(report.rootCause, ""); // not one of CDG's Odoo choices
  assert.match(o.cleanReport({ description: "x", lineDown: true }).error, /machine/);
  assert.match(o.cleanReport({ machineId: "M-001", description: "ok?", }).error, /line down/);
});

test("the Odoo request gets real fields, linked to the machine", () => {
  const { report } = o.cleanReport({ machineId: "M-001", description: "Screw won't turn\nmore detail", lineDown: true, unsafe: true, severity: "urgent", failureCategory: "Motor", rootCause: "Electrical" });
  const v = o.requestValues({ ...report, lineName: "Line 1" }, { id: "M-001", name: "Extruder" }, 1, "M-001 L1-Extruder", 1, "Pat Smith", "2026-10-15");
  assert.equal(v.equipment_id, 1);
  assert.equal(v.maintenance_type, "corrective");
  assert.equal(v.priority, "3");
  assert.equal(v.x_studio_downtime_related, true);
  assert.equal(v.x_studio_unsafe_to_run, true);
  assert.equal(v.x_studio_failure_category, "Motor");
  assert.equal(v.x_studio_root_cause, "Electrical");
  assert.match(v.name, /^⛔ LINE DOWN – M-001 Extruder – Screw won't turn$/);
  assert.match(v.description, /Pat Smith/);
  assert.doesNotMatch(o.requestValues({ ...report, description: "<script>x</script>" }, { id: "M-001", name: "E" }, 1, "", 1, "P", "d").description, /<script>/);
});

test("Odoo HTML becomes plain text", () => {
  assert.equal(o.htmlToText("<p>Line one</p><p>A &amp; B<br>next</p>"), "Line one\nA & B\nnext");
});

test("last PM and last repair per machine come from closed requests", () => {
  const dates = o.lastDatesByMachine([
    { equipment_id: [22, "M-019 L3-Extruder"], maintenance_type: "corrective", close_date: "2026-10-06" },
    { equipment_id: [22, "M-019 L3-Extruder"], maintenance_type: "corrective", close_date: "2026-09-01" },
    { equipment_id: [22, "M-019 L3-Extruder"], maintenance_type: "preventive", close_date: "2026-10-02" },
    { equipment_id: false, maintenance_type: "corrective", close_date: "2026-10-07" },
  ]);
  assert.deepEqual(dates, { "M-019": { repair: "2026-10-06", pm: "2026-10-02" } });
});
