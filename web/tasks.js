// Tasks (Chris, 10-23-2026; Decision 106, 10-26-2026) — message and announcement tasks, one list (annTasks). Rules:
// functions/anntasks.js. The person taps Done (PIN); the assigner confirms — or, when the assigner is off shift, a Line
// Lead or Supervisor on this shift. Until then it shows "Waiting for confirmation" (not green). The confirmer can send it
// back with a note. Home: gray = not due, red ⚠ = last hour or overdue, green ✓ = confirmed.

import { el, toast, friendlyError } from "./ui.js";
import { data } from "./data.js";
import { callAnnTaskSigners, callReturnAnnTask, callTasksToConfirm } from "./firebase.js";
import { signOff, signedNote } from "./signoff.js";
import { offlineSign } from "./outbox.js";

const HOUR = 3600000;
// When it's due (older tasks have a due date only: the end of that day, plant time).
export const dueMsOf = (t) => (Number.isFinite(t?.dueMs) ? t.dueMs : t?.dueDate ? Date.parse(`${t.dueDate}T23:59:00-06:00`) : Infinity);
export const fmtDue = (ms) => {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
// gray "due" until the last hour, red "late" in the last hour and after, green "done" once confirmed.
export function taskState(t, now = Date.now()) {
  if (t.status === "verified") return "done";
  return now >= dueMsOf(t) - HOUR ? "late" : "due";
}
export function taskStatusText(t, now = Date.now()) {
  const due = dueMsOf(t);
  if (t.status === "verified") return `✓ Done by ${t.done?.name || t.name} · confirmed by ${t.verified?.name}`;
  if (t.status === "done") return `Waiting for confirmation — done by ${t.done?.name || t.name}`;
  const back = (t.returns || []).slice(-1)[0];
  return [now >= due ? `⚠ Overdue — was due ${fmtDue(due)}` : now >= due - HOUR ? `⚠ Due ${fmtDue(due)}` : `Due ${fmtDue(due)}`, back ? `sent back: “${back.note}” (${back.byName})` : ""].filter(Boolean).join(" · ");
}

// ---- actions ------------------------------------------------------------------------------------------------------
export async function markTaskDone(t, me) {
  const r = await signOff({
    title: "Task done", what: `${t.annTitle} · ${t.name}`,
    me: t.emp === me.emp ? { emp: me.emp, name: me.name } : null,
    others: async () => (await callAnnTaskSigners({ id: t.id, step: "done" })).data.people,
    action: offlineSign("markAnnTaskDone", { id: t.id }, { label: `Task done · ${t.annTitle}`, key: `anntask-done:${t.id}` }),
  });
  if (r) toast(signedNote(r, `Done — ${r.name}. Waiting for confirmation.${r.test ? " (test)" : ""}`));
  return r;
}
export async function confirmTask(t, me) {
  const r = await signOff({
    title: "Confirm the task", what: `${t.annTitle} · done by ${t.done?.name || t.name}`,
    me: t.emp !== me.emp ? { emp: me.emp, name: me.name } : null,
    others: async () => (await callAnnTaskSigners({ id: t.id, step: "verify" })).data.people,
    action: offlineSign("signAnnTask", { id: t.id }, { label: `Task confirmed · ${t.annTitle}`, key: `anntask-verify:${t.id}` }),
  });
  if (r) { toast(signedNote(r, `Confirmed by ${r.name}${r.test ? " (test)" : ""}`)); confirmCache.at = 0; }
  return r;
}
// Send it back with a short note (a small pop-up). → true when sent.
export function sendTaskBack(t) {
  return new Promise((resolve) => {
    const st = { busy: false, message: "", note: "" };
    const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Send it back" });
    const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop && !st.busy) done(false); } }, sheet);
    const onKey = (e) => { if (e.key === "Escape" && !st.busy) done(false); };
    function done(v) { document.removeEventListener("keydown", onKey); backdrop.remove(); resolve(v); }
    async function send() {
      if (st.note.trim().length < 3) { st.message = "Write a short note — what still needs doing."; return draw(); }
      if (!navigator.onLine) { st.message = friendlyError({ code: "offline" }); return draw(); }
      Object.assign(st, { busy: true, message: "" });
      draw();
      try { await callReturnAnnTask({ id: t.id, note: st.note }); toast(`Sent back to ${t.name}`); confirmCache.at = 0; done(true); } catch (err) { Object.assign(st, { busy: false, message: friendlyError(err) }); draw(); }
    }
    function draw() {
      sheet.replaceChildren(...[
        el("h2", {}, `↩ Send back to ${t.name}`),
        el("p", { class: "card-note" }, t.annTitle),
        el("textarea", { class: "field", rows: "3", maxlength: "300", placeholder: "What still needs doing?", "aria-label": "Note", oninput: (e) => { st.note = e.target.value; } }, st.note),
        st.message ? el("p", { class: "message error" }, st.message) : null,
        el("div", { class: "btn-row" },
          el("button", { class: "btn", type: "button", disabled: st.busy, onclick: send }, st.busy ? "Sending…" : "↩ Send it back"),
          el("button", { class: "btn secondary", type: "button", disabled: st.busy, onclick: () => done(false) }, "Cancel")),
      ].filter(Boolean));
      sheet.querySelector("textarea")?.focus();
    }
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    draw();
  });
}

// One task: name, status, and the buttons this person may use (the server has the final say on confirming).
const FLOOR = ["lead", "supervisor"];
export function taskRow(t, me, { busy = false } = {}) {
  const mine = t.emp === me.emp;
  const mayConfirm = !mine && (t.assignedBy === me.emp || (me.roles || []).some((r) => FLOOR.includes(r)));
  const state = taskState(t);
  return el("div", { class: state === "done" ? "task-row done" : state === "late" && t.status === "open" ? "task-row late" : "task-row" },
    el("div", { class: "task-main" },
      el("span", { class: "person-name" }, mine ? "You" : t.name),
      el("span", { class: "person-meta" }, taskStatusText(t)),
      t.note ? el("span", { class: "person-meta" }, t.note) : null,
      el("span", { class: "person-meta" }, `Assigned by ${t.assignedByName}${t.test ? " · TEST" : ""}`)),
    t.status === "open" && mine ? el("button", { class: "btn", type: "button", disabled: busy, onclick: () => markTaskDone(t, me) }, "✔ Done") : null,
    t.status === "done" && mayConfirm ? el("div", { class: "btn-row" },
      el("button", { class: "btn", type: "button", disabled: busy, onclick: () => confirmTask(t, me) }, "✔ Confirm"),
      el("button", { class: "btn secondary", type: "button", disabled: busy, onclick: () => sendTaskBack(t) }, "↩ Send back")) : null);
}

// ---- Home ---------------------------------------------------------------------------------------------------------
// Tasks I can confirm right now come from the server (it knows who's on shift), checked every 2 minutes at most.
const confirmCache = { list: null, at: 0, loading: false, waiting: new Set() };
function refreshConfirm(onRedraw) {
  if (onRedraw) confirmCache.waiting.add(onRedraw);
  if (confirmCache.loading || Date.now() - confirmCache.at < 2 * 60000) return;
  confirmCache.loading = true;
  callTasksToConfirm().then(({ data: r }) => { confirmCache.list = r.tasks; }).catch(() => {})
    .finally(() => {
      Object.assign(confirmCache, { at: Date.now(), loading: false });
      const fns = [...confirmCache.waiting];
      confirmCache.waiting.clear();
      fns.forEach((f) => f());
    });
}

// Home items: my tasks (gray / red; waiting for confirmation), tasks to confirm, announcement tasks to assign.
// open.announcement(annId), open.message(rootId)
export function taskItems(me, open, onRedraw) {
  if (!data.annTasks) return [];
  const go = (t) => () => (t.annId ? open.announcement(t.annId) : open.message?.(t.rootId));
  const mine = data.annTasks.filter((t) => t.emp === me.emp && (t.status === "open" || t.status === "done"));
  const items = mine.map((t) => ({
    key: `task:${t.id}`, icon: "📋", title: `Task: ${t.annTitle}`,
    detail: `from ${t.assignedByName} · ${taskStatusText(t)}`, state: taskState(t), onOpen: go(t),
  }));
  refreshConfirm(onRedraw);
  for (const t of confirmCache.list || []) {
    items.push({ key: `task-confirm:${t.id}`, icon: "📋", title: `Confirm: ${t.name} did “${t.annTitle}”`, detail: `waiting for confirmation · ${t.assignedByName !== me.name ? `assigned by ${t.assignedByName} (off shift)` : "you assigned it"}`, state: taskState(t), onOpen: go(t) });
  }
  // Announcements marked as a task that still need assigning (Line Leads and Supervisors who got them).
  if ((me.roles || []).some((r) => FLOOR.includes(r))) {
    const assigned = new Set((data.annTasks || []).filter((t) => t.annId && t.status !== "removed").map((t) => t.annId));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    for (const a of data.announcements || []) {
      if (!a.isTask || a.ended || (a.endDate && a.endDate < today) || assigned.has(a.id) || !(a.audienceEmps || []).includes(me.emp)) continue;
      items.push({ key: `task-assign:${a.id}`, icon: "📋", title: `Assign this task: ${a.title}`, detail: "announcement marked as a task — pick who does it on your shift", state: "due", onOpen: () => open.announcement(a.id) });
    }
  }
  return items;
}
