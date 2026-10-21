// Test site cleanup (Chris, 10-21-2026). Removes practice records from the test_ copies only — never live records,
// never Odoo, never the training workbook. No Odoo or workbook code is used here, and every collection name goes
// through onlyTest() first, so a live name can't slip in. The database is passed in, so the tests can prove it.
//
//   - Daily (3:30 a.m.): practice records not changed for 24 hours are removed.
//   - Admin → "Reset test data" (test site only): shows the counts first, then removes all of them.

// What gets cleaned, with the plain name Chris sees. Training's practice trainers and PINs are left alone (setup,
// not activity), and so is the workbook queue (live only, never has a test_ copy).
const TEST_COLLECTIONS = [
  ["test_issues", "Maintenance requests and line-downs"],
  ["test_requests", "Need something? requests"],
  ["test_checklistUnits", "Machine checklist sign-offs"],
  ["test_checklistSignoffs", "Machine checklist sign-off records"],
  ["test_signoffs", "PIN sign-off records"],
  ["test_announcements", "Announcements"],
  ["test_announcementSigs", "Announcement signatures"],
  ["test_handoffs", "Shift handoffs"],
  ["test_lineLogs", "Line check readings"],
  ["test_plantLogs", "Line check page 2 (plant-wide)"],
  ["test_shopTasks", "Keep the Shop Clean lists"],
  ["test_stationLists", "Station checklists"],
  ["test_fixes", "Fix Library practice fixes"],
  ["test_trash", "Fix Library practice trash"],
  ["test_trucks", "Trucks"],
];
const DAY_MS = 86400000;

function onlyTest(name) {
  if (typeof name !== "string" || !/^test_[A-Za-z]+$/.test(name)) throw new Error(`Refused: ${name} is not a test collection.`);
  return name;
}

const msOf = (t) => (t?.toMillis ? t.toMillis() : 0);

// { counts: [{ name, label, count }], total }. olderThanMs: only records not changed since then (null = all).
// dryRun: count only. deleteDoc(ref) removes one record and anything under it (version history).
async function clearTestData(db, { olderThanMs = null, dryRun = false, deleteDoc }) {
  const counts = [];
  for (const [name, label] of TEST_COLLECTIONS) {
    const snap = await db.collection(onlyTest(name)).get();
    const going = snap.docs.filter((d) => olderThanMs === null || msOf(d.updateTime) < olderThanMs);
    if (!dryRun) for (const d of going) await deleteDoc(d.ref);
    counts.push({ name, label, count: going.length });
  }
  return { counts, total: counts.reduce((n, c) => n + c.count, 0) };
}

module.exports = { TEST_COLLECTIONS, DAY_MS, onlyTest, clearTestData };
