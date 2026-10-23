// Crew Board, step 1 — Who's here today (Chris, 10-21-2026, Decision 69; launch list 2). At the start of each shift
// the lead marks each person on the crew Here or Out. No database code here, so it can be tested on its own.
//
//   attendance/{date__shiftId}  date (the day the shift started), shiftId, shiftName, startMs, endMs, teamId,
//                  teamName, added: [employee #] (covering from another team), marks: { [employee #]: { status:
//                  "here" | "out", reason (Out only), by, byName, atMs } }. Test site: test_attendance.
//
// The crew is the team the rotation puts on this shift; on a day with no team (Saturday) the lead picks the team
// (Chris, 10-23-2026). The lead can add anyone else who is covering. Out reasons — Sick / PTO / No call / Other, no
// medical details — are seen only by Supervisors, the Production Manager, and Admins; everyone else sees "Out today".
// Due 2 hours after the shift starts (Chris, 10-23-2026): red in the last hour before that.

const OUT_REASONS = ["Sick", "PTO", "No call", "Other"];
const MARK_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const REASON_ROLES = ["supervisor", "plant-manager", "admin"];
const DUE_HOURS = 2;

const docId = (date, shiftId) => `${date}__${shiftId}`;
const canMark = (roles) => (roles || []).some((r) => MARK_ROLES.includes(r));
const canSeeReasons = (roles) => (roles || []).some((r) => REASON_ROLES.includes(r));
const dueMs = (startMs) => startMs + DUE_HOURS * 3600000;

// { status: "here" | "out" | null (clear), reason } → { mark } or { error }.
function cleanMark(raw) {
  const status = raw?.status ?? null;
  if (status === null) return { mark: null };
  if (status === "here") return { mark: { status: "here" } };
  if (status !== "out") return { error: "Here or Out?" };
  if (!OUT_REASONS.includes(raw?.reason)) return { error: `Pick why: ${OUT_REASONS.join(", ")}.` };
  return { mark: { status: "out", reason: raw.reason } };
}

// The crew: active people on the team, plus anyone added (covering), sorted by name. Practice accounts ("TEST …")
// only on the test site. people = [{ id, name, team, active }].
function crewList(people, { teamId, added = [], test = false, isPractice = () => false }) {
  const extra = new Set(added);
  return people
    .filter((p) => p.active !== false && (test || !isPractice(p.name)) && ((teamId && p.team === teamId) || extra.has(p.id)))
    .map((p) => ({ ...p, added: !(teamId && p.team === teamId) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Each person with their mark; the reason only when `reasons` is true.
function crewView(list, marks = {}, { reasons = false } = {}) {
  return list.map((p) => {
    const m = marks[p.id];
    return {
      emp: p.id, name: p.name, title: p.title || "", added: p.added,
      status: m?.status || null, ...(m && reasons && m.reason ? { reason: m.reason } : {}),
      ...(m ? { byName: m.byName || "", atMs: m.atMs || 0 } : {}),
    };
  });
}

function counts(list, marks = {}) {
  const out = { here: 0, out: 0, unmarked: 0, total: list.length };
  for (const p of list) {
    const s = marks[p.id]?.status;
    if (s === "here") out.here++;
    else if (s === "out") out.out++;
    else out.unmarked++;
  }
  return out;
}

module.exports = { OUT_REASONS, MARK_ROLES, REASON_ROLES, DUE_HOURS, docId, canMark, canSeeReasons, dueMs, cleanMark, crewList, crewView, counts };
