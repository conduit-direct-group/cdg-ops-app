// Crew Board, step 1 — Who's here today (Chris, 10-21-2026, Decision 69; launch list 2). Rules: functions/crew.js.
// At the start of each shift the Line Lead (or Supervisor) marks each person on the crew Here or Out. The crew is the
// team the rotation puts on this shift; on a day with no team (Saturday) the lead picks it. Anyone covering from
// another team can be added. Out reasons (Sick / PTO / No call / Other) are seen only by Supervisors, the Production
// Manager, and Admins — everyone else sees "Out today". Due 2 hours after the shift starts.
//   Home: a Needs you item for the Line Leads and Supervisors of the team on shift; a "Crew today" headcount card for
//   Supervisors and the Production Manager. More → Who's here today for everyone on the floor.

import { el, breakable, friendlyError, spinner, emptyState, banner, toast, picker, choose, confirmSheet } from "./ui.js";
import { callCrewToday, callCrewMark, callCrewSetup } from "./firebase.js";
import { clock } from "./shift.js";

const VIEW_ROLES = ["operator", "lead", "supervisor", "plant-manager", "admin"];
const HOME_ROLES = ["lead", "supervisor"];
const HOME_REFRESH_MS = 2 * 60000;
export const usesCrewBoard = (roles) => roles.some((r) => VIEW_ROLES.includes(r));

const fmtDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- Home: one shared copy of this shift's crew, refreshed every 2 minutes --------------------------------------

const home = { view: null, at: 0, error: false, loading: false, waiting: new Set() };

function refreshHome(onRedraw) {
  if (onRedraw) home.waiting.add(onRedraw);
  if (home.loading) return;
  const fresh = Date.now() - home.at < HOME_REFRESH_MS && !(home.view?.shift && Date.now() >= home.view.shift.endMs);
  if (fresh) return;
  home.loading = true;
  callCrewToday().then(({ data: v }) => { Object.assign(home, { view: v, error: false }); })
    .catch(() => { home.error = true; })
    .finally(() => {
      Object.assign(home, { at: Date.now(), loading: false });
      const fns = [...home.waiting];
      home.waiting.clear();
      fns.forEach((f) => f());
    });
}
function rememberHome(view) { Object.assign(home, { view, at: Date.now(), error: false }); }

// When it's due: gray until the last hour before the due time, then red; overdue after.
function dueState(v) {
  const due = v.shift.dueMs;
  const late = Date.now() >= due - 3600000;
  return { late, text: `${Date.now() >= due ? "overdue — was due by" : "due by"} ${clock(due)}` };
}

export function crewItems(roles, onOpen, onRedraw) {
  if (!roles.some((r) => HOME_ROLES.includes(r))) return [];
  refreshHome(onRedraw);
  const base = { key: "crew", icon: "👥", onOpen };
  const v = home.view;
  if (!v) return [{ ...base, title: "Who's here today", detail: home.error ? "couldn't check — tap to open" : "checking…", state: "due" }];
  if (v.noShift || !v.forMe) return [];
  const due = dueState(v);
  const state = due.late ? "late" : "due";
  if (!v.team) return [{ ...base, title: "Who's here today: pick the team that's working", detail: due.text, state }];
  const c = v.counts;
  if (!c.total) return [{ ...base, title: `Who's here today: no one on Team ${v.team.name} yet`, detail: "add who's working, or set teams in Admin → People", state }];
  if (!c.unmarked) return [{ ...base, title: "Who's here today", detail: `${c.here} here · ${c.out} out · Team ${v.team.name}`, state: "done" }];
  return [{ ...base, title: `Who's here today: ${plural(c.unmarked, "person", "people")} not marked`, detail: `${c.total - c.unmarked} of ${c.total} marked · ${due.text}`, state }];
}

// "At a glance" headcount for Supervisors and the Production Manager: { icon, title, num, line, alert, onOpen } or null.
export function crewCard(onOpen, onRedraw) {
  refreshHome(onRedraw);
  const v = home.view;
  const base = { icon: "👥", title: "Crew today", onOpen };
  if (!v) return home.error ? { ...base, num: "—", line: "Couldn't load — tap to open", alert: false } : null;
  if (v.noShift) return { ...base, num: "—", line: "No shift running right now", alert: false };
  const title = `Crew today · ${v.shift.shiftName}${v.team ? ` · Team ${v.team.name}` : ""}`;
  if (!v.team) return { ...base, title, num: "—", line: "Team not picked yet", alert: Date.now() >= v.shift.dueMs };
  const c = v.counts;
  return { ...base, title, num: c.here,
    line: [`here`, c.out && `${c.out} out`, c.unmarked && `${c.unmarked} not marked`].filter(Boolean).join(" · "),
    alert: c.unmarked > 0 && Date.now() >= v.shift.dueMs };
}

// ---- the board ----------------------------------------------------------------------------------------------------

export function openCrew(container, { onExit, backLabel = "Home" }) {
  const ui = { view: null, loadError: "", busy: false, message: "", messageKind: "", retry: null };

  async function load() {
    if (!navigator.onLine) { ui.loadError = friendlyError({ code: "offline" }); return render(); }
    ui.loadError = "";
    render();
    try {
      ui.view = (await callCrewToday()).data;
      rememberHome(ui.view);
    } catch (err) {
      ui.loadError = friendlyError(err);
    }
    render();
  }

  async function act(fn, retry, okMessage) {
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry }); return render(); }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const out = (await fn()).data;
      if (okMessage) toast(typeof okMessage === "function" ? okMessage(out) : okMessage);
      ui.busy = false;
      await load();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry });
      render();
    }
  }

  const markHere = (p) => act(() => callCrewMark({ emp: p.emp, status: "here" }), () => markHere(p), `${p.name} — here`);
  async function markOut(p) {
    const reason = await choose({ title: `${p.name} is out — why?`, options: ui.view.reasons.map((r) => ({ value: r, label: r })) });
    if (!reason) return;
    const send = () => act(() => callCrewMark({ emp: p.emp, status: "out", reason }), send, `${p.name} — out today`);
    send();
  }
  const markAll = () => act(() => callCrewMark({ all: true }), markAll, (o) => `${plural(o.count, "person", "people")} marked here`);
  const pickTeam = (teamId) => act(() => callCrewSetup({ teamId }), () => pickTeam(teamId), "Team set");
  async function addSomeone() {
    const emp = await choose({ title: "Add someone who's covering", options: ui.view.others.map((o) => ({ value: o.emp, label: `${o.name}${o.team ? ` · Team ${o.team}` : ""}` })) });
    if (!emp) return;
    const name = ui.view.others.find((o) => o.emp === emp)?.name || "";
    const send = () => act(() => callCrewSetup({ add: emp }), send, `${name} added`);
    send();
  }
  async function takeOff(p) {
    if (!(await confirmSheet({ title: `Take ${p.name} off this shift?`, text: "Only for someone added by mistake. Their Here / Out mark goes too.", confirmLabel: "Take off" }))) return;
    const send = () => act(() => callCrewSetup({ remove: p.emp }), send, `${p.name} taken off`);
    send();
  }

  function statusText(p, v) {
    if (p.status === "here") return `✓ Here${v.canMark && p.byName ? ` · marked by ${p.byName} ${clock(p.atMs)}` : ""}`;
    if (p.status === "out") return `Out today${p.reason ? ` — ${p.reason}` : ""}${v.canMark && p.byName ? ` · marked by ${p.byName} ${clock(p.atMs)}` : ""}`;
    return "Not marked yet";
  }

  function personRow(p, v) {
    return el("article", { class: "card crew-person" },
      el("div", { class: "crew-who" },
        el("strong", {}, breakable(p.name)),
        p.added ? el("span", { class: "tag" }, "covering") : null),
      el("span", { class: "person-meta" }, statusText(p, v)),
      v.canMark
        ? el("div", { class: "choices two" },
            el("button", { class: p.status === "here" ? "choice on" : "choice", type: "button", "aria-pressed": String(p.status === "here"), disabled: ui.busy, onclick: () => p.status !== "here" && markHere(p) }, "✓ Here"),
            el("button", { class: p.status === "out" ? "choice on" : "choice", type: "button", "aria-pressed": String(p.status === "out"), disabled: ui.busy, onclick: () => markOut(p) }, "Out"))
        : null,
      v.canMark && p.added ? el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => takeOff(p) }, "Take off this shift") : null);
  }

  function board(v) {
    const c = v.counts;
    const due = dueState(v);
    const teamPick = v.canPickTeam
      ? el("label", { class: "spec-field" }, el("span", { class: "field-label" }, v.team ? "Team working today (no team in the rotation today)" : "Which team is working today?"),
          picker({ title: "Team working today", value: v.team?.id || "", placeholder: "Pick the team…", options: v.teams.map((t) => ({ value: t.id, label: `Team ${t.name}` })), onChange: pickTeam }))
      : null;
    if (!v.team) {
      return [
        teamPick,
        v.canPickTeam ? null : emptyState("The team isn't picked yet", "There's no team in the rotation today. A Line Lead or Supervisor picks the team that's working."),
      ];
    }
    return [
      el("p", { class: "crew-count", role: "status" },
        el("strong", {}, `${c.here} here`), ` · ${c.out} out · ${c.unmarked} not marked`),
      v.canMark && c.unmarked ? el("p", { class: due.late ? "crew-due late" : "crew-due" }, `${due.late ? "⚠ " : ""}Mark everyone ${due.text}`) : null,
      teamPick,
      v.canMark && c.unmarked
        ? el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: markAll }, `✓ Mark the other ${plural(c.unmarked, "person", "people")} here`)
        : null,
      v.people.length
        ? el("div", { class: "crew-list" }, v.people.map((p) => personRow(p, v)))
        : emptyState(`No one is on Team ${v.team.name} yet`, "Admin → People sets each person's team." + (v.canMark ? " Add who's working below." : "")),
      v.canMark && v.others.length ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: addSomeone }, "+ Add someone who's covering") : null,
      !v.canMark ? el("p", { class: "hint" }, "Your Line Lead marks who's here at the start of the shift.") : null,
    ];
  }

  function render() {
    const v = ui.view;
    const sub = v && !v.noShift ? `${v.shift.shiftName} · ${fmtDay(v.shift.date)}${v.team ? ` · Team ${v.team.name}` : ""}${v.test ? " · TEST" : ""}` : "";
    const body = ui.loadError
      ? banner({ message: ui.loadError, messageKind: "error", retry: load })
      : !v ? spinner("Loading the crew…")
      : v.noShift ? emptyState("No shift running right now", "Shift times are set on the Keep the Shop Clean form (Admin → Forms).")
      : board(v);
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "👥 Who's here today"),
      sub ? el("p", { class: "hint" }, sub) : null,
      banner(ui),
      body,
    ].flat(3).filter(Boolean));
  }

  load();
  const onBack = () => { if (navigator.onLine && ui.loadError) load(); };
  window.addEventListener("online", onBack);
  return () => window.removeEventListener("online", onBack);
}
