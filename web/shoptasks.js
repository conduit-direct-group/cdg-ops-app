// Keep the Shop Clean — shift task list (Decision 62). Tasks, shift times, and "turns red" come from the task-list
// form (Admin → Forms, "clean-shop"). One list per shift. A Line Lead or Supervisor assigns each task to a person;
// each person marks their own task done with their PIN (on a line tablet: tap their name, then PIN); the Supervisor
// check is a PIN sign-off once every task is done. Unfinished tasks show on Home — red in the last hour of the shift.

import { el, friendlyError, spinner, emptyState, banner, toast, picker, collapsible } from "./ui.js";
import { data, onDataChange } from "./data.js";
import {
  TEST_MODE, callStartShopTasks, callShopTaskPeople, callAssignShopTask, callMarkShopTaskDone, callCheckShopTasks, callShopTaskSigners,
} from "./firebase.js";
import { signOff } from "./signoff.js";

export const TASKLIST_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const CHECK_ROLES = ["supervisor", "plant-manager", "admin"];
const SHOP_FORM = "clean-shop";
const PLANT_TZ = "America/Chicago";
export const runsShopList = (roles) => (roles || []).some((r) => TASKLIST_ROLES.includes(r));

// ---- shifts in plant time (same as functions/forms.js) -----------------------------------------------------------
function plantClock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const addDay = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function currentShift(shifts, nowMs = Date.now()) {
  const { date, minutes } = plantClock(nowMs);
  for (const s of shifts || []) {
    const a = toMin(s.start), b = toMin(s.end);
    const overnight = b <= a;
    if (!overnight && minutes >= a && minutes < b) return { shift: s, date, id: `${date}__${s.id}` };
    if (overnight && minutes >= a) return { shift: s, date, id: `${date}__${s.id}` };
    if (overnight && minutes < b) { const d = addDay(date, -1); return { shift: s, date: d, id: `${d}__${s.id}` }; }
  }
  return null;
}

const shopForm = () => (data.formTemplates || []).find((t) => t.id === SHOP_FORM && t.active !== false) || null;
const tasksOf = (l) => (l.sections || []).flatMap((s) => s.fields);
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : t?.seconds ? t.seconds * 1000 : 0);
const fmtWhen = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

function listState(l, now = Date.now()) {
  const tasks = tasksOf(l);
  const done = tasks.filter((t) => l.done?.[t.id]).length;
  const allDone = tasks.length > 0 && done === tasks.length;
  const late = now >= l.endMs - (l.redMinutes ?? 60) * 60000;
  return { done, total: tasks.length, allDone, late, checked: !!l.check };
}

// This shift's list (null if not started), and the shift itself.
function thisShift() {
  const form = shopForm();
  const now = form ? currentShift(form.shifts) : null;
  return { form, now, list: now ? (data.shopLists || []).find((l) => l.id === now.id) || null : null };
}

// ---- Home items (Decision 66) -----------------------------------------------------------------------------------
// Your own unfinished task (anyone), and for leads/supervisors this shift's list: gray "due by 5:00 PM", red in the
// last hour of the shift, green when every task is done and the supervisor has checked it.
export function shopItems(me, roles, onOpen) {
  if (!data.shopLists || !data.formTemplates) return [];
  const out = [];
  const mine = [];
  for (const l of data.shopLists) {
    if (l.check) continue;
    for (const t of tasksOf(l)) if (l.assign?.[t.id] === me.emp && !l.done?.[t.id]) mine.push({ l, t });
  }
  if (mine.length) {
    const late = mine.some(({ l }) => listState(l).late);
    out.push({ key: "shop-mine", icon: "🧹", title: `Your shop task${mine.length === 1 ? "" : "s"}: ${mine.map((x) => x.t.label).join(", ")}`,
      detail: `due by ${fmtTime(mine[0].l.endMs)}`, state: late ? "late" : "due", onOpen: () => onOpen(mine[0].l.id) });
  }
  if (runsShopList(roles)) {
    const { form, now, list } = thisShift();
    if (form && now) {
      const s = list ? listState(list) : null;
      const late = list ? s.late : Date.now() >= currentEnd(form, now) - (form.redMinutes ?? 60) * 60000;
      const by = `due by ${fmtTime(list ? list.endMs : currentEnd(form, now))}`;
      if (!list) out.push({ key: "shop", icon: "🧹", title: "Keep the Shop Clean — start and assign tasks", detail: by, state: late ? "late" : "due", onOpen: () => onOpen(null) });
      else if (s.checked) out.push({ key: "shop", icon: "🧹", title: "Keep the Shop Clean", detail: "done and checked", state: "done", onOpen: () => onOpen(list.id) });
      else out.push({ key: "shop", icon: "🧹", title: s.allDone ? "Keep the Shop Clean — supervisor check needed" : `Keep the Shop Clean — ${s.done} of ${s.total} done`,
        detail: by, state: late ? "late" : "due", onOpen: () => onOpen(list.id) });
    }
  }
  return out;
}
// When this shift ends (before the list exists): plant date + the shift's end time.
function currentEnd(form, now) {
  const s = form.shifts.find((x) => x.id === now.shift.id);
  const day = s && toMin(s.end) <= toMin(s.start) ? addDay(now.date, 1) : now.date;
  return plantMs(day, s?.end || "00:00");
}
function plantMs(date, hhmm) {
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


// ===========================================================================

export function openShopTasks(container, { me, startId = null, onExit }) {
  const ui = { id: startId, busy: false, message: "", messageKind: "", retry: null, people: null, peopleError: "" };
  const runs = runsShopList(me.roles);
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false }); render(); };
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  if (runs) {
    callShopTaskPeople().then(({ data: r }) => { ui.people = r.people; render(); }, (err) => { ui.peopleError = friendlyError(err); render(); });
  }

  async function start() {
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const { data: r } = await callStartShopTasks();
      Object.assign(ui, { busy: false, id: r.id });
      toast(`${r.shift} shift list ready — assign the tasks`);
      render();
    } catch (err) { say(friendlyError(err), start); }
  }

  async function assign(l, t, emp) {
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const { data: r } = await callAssignShopTask({ id: l.id, taskId: t.id, emp: emp || null });
      ui.busy = false;
      toast(emp ? `${t.label} → ${personName(emp, l)}${r.test ? " (test: only you are notified)" : ""}` : `${t.label}: no one assigned`);
      render();
    } catch (err) { say(friendlyError(err), () => assign(l, t, emp)); }
  }

  async function markDone(l, t) {
    const emp = l.assign[t.id];
    const r = await signOff({
      title: "Mark done", what: `${t.label} · ${l.shift.name} shift`,
      me: { emp, name: personName(emp, l) },
      action: async ({ signer, device }) => (await callMarkShopTaskDone({ id: l.id, taskId: t.id, signer, device })).data,
    });
    if (r) toast(`${r.task} — done by ${r.name}${r.test ? " (test)" : ""}`);
  }

  async function check(l) {
    const canMe = me.roles.some((x) => CHECK_ROLES.includes(x));
    const r = await signOff({
      title: "Supervisor check", what: `Keep the Shop Clean · ${l.shift.name} shift · ${dayLabel(l.date)}`,
      me: canMe ? { emp: me.emp, name: me.name } : null, // not a supervisor: go straight to the supervisors' names
      others: async () => (await callShopTaskSigners({ id: l.id })).data.people,
      action: async ({ signer, device }) => (await callCheckShopTasks({ id: l.id, signer, device })).data,
    });
    if (r) toast(`Checked by ${r.name}${r.test ? " (test)" : ""}`);
  }

  const personName = (emp, l) => l?.names?.[emp] || ui.people?.find((p) => p.id === emp)?.name || `#${emp}`;
  const myTeam = () => data.myself?.team || null;

  function assignOptions(assigned) {
    const team = myTeam();
    const people = [...(ui.people || [])].sort((a, b) => (b.team === team) - (a.team === team) || a.name.localeCompare(b.name));
    const teamName = (id) => (data.teams || []).find((t) => t.id === id)?.name;
    return [...(assigned ? [{ value: "", label: "No one (unassign)" }] : []), ...people.map((p) => ({ value: p.id, label: `${p.name}${p.team ? ` · Team ${teamName(p.team) || p.team}` : ""}${p.loginEnabled ? "" : " · no login yet"}` }))];
  }

  function renderList(l) {
    const s = listState(l);
    const tasks = tasksOf(l);
    return [
      el("p", { class: "hint" }, `${l.shift.name} shift · ${dayLabel(l.date)} · ends ${fmtTime(l.endMs)} · form revision ${l.formRev}`),
      el("p", { class: "tags ann-tags" },
        el("span", { class: s.checked ? "tag ok" : s.allDone ? "tag warn" : s.late ? "tag off" : "tag warn" }, s.checked ? "✓ Done and checked" : s.allDone ? "All done — supervisor check needed" : `${s.done} of ${s.total} done`),
        l.test ? el("span", { class: "tag test" }, "TEST") : null),
      s.late && !s.allDone ? el("p", { class: "message error", role: "alert" }, `⚠ ${s.total - s.done} task${s.total - s.done === 1 ? "" : "s"} not done — the shift ends at ${fmtTime(l.endMs)}.`) : null,
      l.intro ? el("p", { class: "card-note" }, l.intro) : null,
      banner(ui),
      runs && ui.peopleError ? el("div", { class: "message error", role: "alert" }, ui.peopleError) : null,
      el("div", { class: "task-list" }, tasks.map((t) => {
        const who = l.assign?.[t.id];
        const done = l.done?.[t.id];
        return el("div", { class: done ? "task-row done" : s.late ? "task-row late" : "task-row" },
          el("div", { class: "task-main" },
            el("span", { class: "person-name" }, `${done ? "✓ " : ""}${t.label}`),
            el("span", { class: "person-meta" }, done ? `Done by ${done.name} · ${fmtWhen(done.at)}` : who ? `Assigned to ${personName(who, l)}` : "Not assigned yet"),
            t.help ? el("span", { class: "person-meta" }, t.help) : null),
          !done && runs && !l.check
            ? (ui.people ? picker({ title: `Who does “${t.label}”?`, value: who || "", placeholder: "Assign to…", options: assignOptions(!!who), onChange: (v) => assign(l, t, v) }) : spinner("Loading the crew…"))
            : null,
          !done && who ? el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => markDone(l, t) }, who === me.emp ? "✔ Mark my task done" : `✔ ${personName(who, l)}: mark done`) : null);
      })),
      l.check
        ? el("p", { class: "message ok" }, `✓ Supervisor check: ${l.check.name} · ${fmtWhen(l.check.at)}${l.check.device?.label ? ` · ${l.check.device.label}` : ""}`)
        : s.allDone
          ? el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: () => check(l) }, "✍ Supervisor check")
          : el("p", { class: "hint" }, "The supervisor check opens once every task is done."),
      el("p", { class: "hint" }, `Each person signs with their own PIN${TEST_MODE ? " — test site, practice only" : ""}.`),
    ];
  }

  function render() {
    const { form, now, list } = thisShift();
    const open = ui.id ? (data.shopLists || []).find((l) => l.id === ui.id) : list;
    const loading = !data.shopLists || !data.formTemplates;
    const past = (data.shopLists || []).filter((l) => l.id !== open?.id);
    container.replaceChildren(...[
      back("Home", onExit),
      el("h1", {}, `🧹 ${open?.formName || form?.name || "Keep the Shop Clean"}`),
      loading ? spinner() : null,
      !loading && !form ? emptyState("Not set up yet", "An admin loads the task list in Admin → Forms.") : null,
      !loading && form && !now ? emptyState("No shift is running right now", "Check the shift times in Admin → Forms.") : null,
      open ? renderList(open)
        : !loading && form && now
          ? runs
            ? el("section", { class: "card" }, el("strong", {}, `${now.shift.name} shift · ${dayLabel(now.date)}`), el("p", { class: "card-note" }, "Start this shift's list, then assign each task to someone on the crew."), banner(ui),
                el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: start }, ui.busy ? "Starting…" : "🧹 Start and assign tasks"))
            : emptyState("Nothing assigned to you this shift", "Your lead assigns the shop tasks at the start of the shift.")
          : null,
      past.length ? collapsible("shop-past", `Recent shifts (${past.length})`, el("div", { class: "person-list" }, past.map((l) => {
        const s = listState(l);
        return el("button", { class: "person-row", type: "button", onclick: () => { ui.id = l.id; render(); window.scrollTo(0, 0); } },
          el("span", { class: "person-name" }, `${l.shift.name} shift · ${dayLabel(l.date)}`),
          el("span", { class: "person-meta" }, s.checked ? `✓ Checked by ${l.check.name}` : `${s.done} of ${s.total} done`),
          l.test ? el("span", { class: "tags" }, el("span", { class: "tag test" }, "TEST")) : null);
      }))) : null,
    ].flat(3).filter(Boolean));
  }

  const stop = onDataChange(() => { if (!ui.busy) render(); });
  // Redraw once a minute so the shift-end countdown and red state stay current.
  const tick = setInterval(() => { if (!ui.busy) render(); }, 60000);
  render();
  return () => { stop(); clearInterval(tick); };
}
