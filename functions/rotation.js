// Shift rotation (Chris, 10-21-2026): which team works which days and shift. Kept in meta/rotation
// { teams: [{ teamId, days: [0–6, Sunday = 0], shiftId }] } (Admin → Shift rotation). No database code here.
// A night shift belongs to the day it starts (Tuesday 5 PM – Wednesday 5 AM is Tuesday's night).

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cleanRotation(raw, teamIds, shiftIds) {
  if (!Array.isArray(raw) || raw.length > 20) return { error: "Up to 20 rows." };
  const out = [];
  for (const r of raw) {
    if (!teamIds.includes(r?.teamId)) return { error: "Pick a team from the list." };
    if (!shiftIds.includes(r?.shiftId)) return { error: "Pick a shift from the list." };
    const days = [...new Set((Array.isArray(r?.days) ? r.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) return { error: "Pick at least one day for each team." };
    for (const o of out) if (o.shiftId === r.shiftId && o.days.some((d) => days.includes(d))) return { error: "Two teams can't work the same shift on the same day." };
    out.push({ teamId: r.teamId, days, shiftId: r.shiftId });
  }
  return { teams: out };
}

// The team on now: shiftNow = { shift: { id }, date: "YYYY-MM-DD" (the day the shift started) } → teamId or null.
function teamOnShift(rotation, shiftNow) {
  if (!shiftNow?.shift?.id || !shiftNow.date) return null;
  const dow = new Date(`${shiftNow.date}T12:00:00Z`).getUTCDay();
  return (rotation || []).find((r) => r.shiftId === shiftNow.shift.id && r.days.includes(dow))?.teamId || null;
}

const describe = (r) => `${r.days.map((d) => DAY_NAMES[d]).join(", ")}`;

module.exports = { DAY_NAMES, cleanRotation, teamOnShift, describe };
