// Write-ups (Decision 52; who sees and writes: Chris, 10-23-2026, Decision 97). No database code here, so it can be
// tested alone.
//
// Who writes: Supervisors, the Production Manager, Admins. Who sees a write-up: the person who wrote it, and anyone
// with HR access (hraccess.js) — nobody else, not even a count. The collection is server-only (firestore.rules has no
// read rule for it); every view and every print goes in the activity log.
//
//   writeups/{auto}   emp, empName, date (YYYY-MM-DD), type, policy, description, correctiveAction, priorNotes,
//                     prior [{ date, type }] (earlier write-ups for that person, filled in by the server),
//                     writerEmp, writerName, writerSig { emp, name, atMs, device },
//                     status "waiting" | "signed" | "refused", employeeComments,
//                     employeeSig { emp, name, atMs, device } | refused { by, byName, atMs }
// Test site: test_writeups.

const WRITER_ROLES = ["supervisor", "plant-manager", "admin"];
const TYPES = [
  { value: "verbal", label: "Verbal warning" },
  { value: "written", label: "Written warning" },
  { value: "final", label: "Final warning" },
];
const MAX = { policy: 200, text: 4000, comments: 2000 };

const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, max) : "");
const canWrite = (roles = []) => roles.some((r) => WRITER_ROLES.includes(r));
// me: { employeeNumber, hr }
const canSee = (me, w) => !!me && !!w && (me.hr === true || w.writerEmp === me.employeeNumber);
const typeLabel = (t) => TYPES.find((x) => x.value === t)?.label || t;

// The form → { writeup } or { error }. today: YYYY-MM-DD (plant time); no dates in the future.
function cleanWriteup(raw, today) {
  const date = typeof raw?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : "";
  if (!date) return { error: "Pick the date." };
  if (date > today) return { error: "The date can't be in the future." };
  const emp = typeof raw?.emp === "string" ? raw.emp.trim() : "";
  if (!/^\d{1,6}$/.test(emp)) return { error: "Pick the employee." };
  const type = TYPES.some((t) => t.value === raw?.type) ? raw.type : "";
  if (!type) return { error: "Pick the type: verbal, written, or final." };
  const policy = clean(raw?.policy, MAX.policy);
  if (!policy) return { error: "Write which policy or rule." };
  const description = clean(raw?.description, MAX.text);
  if (!description) return { error: "Describe what happened." };
  const correctiveAction = clean(raw?.correctiveAction, MAX.text);
  if (!correctiveAction) return { error: "Write the corrective action expected." };
  return { writeup: { emp, date, type, policy, description, correctiveAction, priorNotes: clean(raw?.priorNotes, MAX.text) } };
}

// Earlier write-ups for the same person, oldest first (date and type only — the record itself stays private).
function priorList(others, date) {
  return others.filter((w) => w.date <= date).map((w) => ({ date: w.date, type: w.type })).sort((a, b) => a.date.localeCompare(b.date));
}

// What the list shows.
const summary = (id, w) => ({ id, emp: w.emp, empName: w.empName, date: w.date, type: w.type, status: w.status, writerName: w.writerName });

module.exports = { WRITER_ROLES, TYPES, MAX, canWrite, canSee, typeLabel, cleanWriteup, priorList, summary, clean };
