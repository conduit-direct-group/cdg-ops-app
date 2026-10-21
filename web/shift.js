// The shift running now, in plant time (Cedar Rapids), from the shift times on the Keep the Shop Clean form
// (Admin → Forms) — the one place shift times are kept. Same rules as functions/forms.js.
// Used by Home: "due by 5:00 PM" (Days) / "due by 5:00 AM" (Nights), and red in the last hour of the shift.

import { data } from "./data.js";

const PLANT_TZ = "America/Chicago";
const SHIFT_FORM = "clean-shop";

function plantClock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const addDay = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// A plant-time date + "HH:MM" -> the real moment (ms), daylight saving included.
function plantTimeToMs(date, hhmm) {
  const [y, m, d] = date.split("-").map(Number);
  const want = Date.UTC(y, m - 1, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)));
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const c = plantClock(guess);
    const [cy, cm, cd] = c.date.split("-").map(Number);
    guess += want - Date.UTC(cy, cm - 1, cd, Math.floor(c.minutes / 60), c.minutes % 60);
  }
  return guess;
}

// { shift, date, startMs, endMs, redMinutes } for now, or null when shift times aren't set up.
export function shiftNow(nowMs = Date.now()) {
  const form = (data.formTemplates || []).find((t) => t.id === SHIFT_FORM);
  if (!form?.shifts?.length) return null;
  const { date, minutes } = plantClock(nowMs);
  for (const s of form.shifts) {
    const a = toMin(s.start), b = toMin(s.end);
    const overnight = b <= a;
    let start = null;
    if (!overnight && minutes >= a && minutes < b) start = date;
    else if (overnight && minutes >= a) start = date;
    else if (overnight && minutes < b) start = addDay(date, -1);
    if (!start) continue;
    return { shift: s, date: start, startMs: plantTimeToMs(start, s.start), endMs: plantTimeToMs(overnight ? addDay(start, 1) : start, s.end), redMinutes: form.redMinutes ?? 60 };
  }
  return null;
}

export const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

// Home status for something due by the end of this shift: { state: "due" | "late", detail: "due by 5:00 PM" }.
// Red ("late") in the last hour (the "turns red" minutes on the form) and after.
export function dueByShiftEnd(now = shiftNow()) {
  if (!now) return { state: "due", detail: "due this shift" };
  const t = Date.now();
  if (t >= now.endMs) return { state: "late", detail: `overdue — was due by ${clock(now.endMs)}` };
  return { state: t >= now.endMs - now.redMinutes * 60000 ? "late" : "due", detail: `due by ${clock(now.endMs)}` };
}
