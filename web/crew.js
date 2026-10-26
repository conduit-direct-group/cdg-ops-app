// Crew Board, step 1 — Who's here today (Chris, 10-21-2026, Decision 69; launch list 2). Rules: functions/crew.js.
// At the start of each shift the Line Lead (or Supervisor) marks each person on the crew Here or Out. The crew is the
// team the rotation puts on this shift; on a day with no team (Saturday) the lead picks it. Anyone covering from
// another team can be added. Out reasons (Sick / PTO / No call / Other) are seen only by Supervisors, the Production
// Manager, and Admins — everyone else sees "Out today". Due 2 hours after the shift starts.
//   Home: a Needs you item for the Line Leads and Supervisors of the team on shift; a "Crew today" headcount card for
//   Supervisors and the Production Manager. More → Who's here today for everyone on the floor.

import { el, breakable, friendlyError, spinner, emptyState, banner, toast, picker, choose, confirmSheet, collapsible } from "./ui.js";
import { callCrewMyStation, callCrewToday, callCrewMark, callCrewSetup, callCrewSeat, callCrewCell, callAdminCrewStations, callAdminSaveCrewStations } from "./firebase.js";
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

// The shift running now, when it's this Line Lead's / Supervisor's team: { team: { id, name }, date, endMs } or null.
export function shiftForMe(onRedraw) {
  refreshHome(onRedraw);
  const v = home.view;
  return v && !v.noShift && v.forMe && v.team ? { team: v.team, date: v.shift.date, endMs: v.shift.endMs } : null;
}

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

// ---- Home: "Your station today" (Crew Board step 3) — for anyone the lead has seated --------------------------------
// Checked every 5 minutes (and when a new block starts). Nothing shows when you aren't seated, on a line tablet (shared by
// the crew), or if it can't be checked — it's information, not a duty, so it has no status color.

const STATION_REFRESH_MS = 5 * 60000;
const mine = { view: null, at: 0, loading: false, waiting: new Set() };

function refreshMine(onRedraw) {
  if (onRedraw) mine.waiting.add(onRedraw);
  if (mine.loading) return;
  const v = mine.view;
  const blockMs = v?.seated ? (v.shift.endMs - v.shift.startMs) / v.blocks.length : 0;
  const newBlock = v?.seated && Math.floor((Date.now() - v.shift.startMs) / blockMs) !== v.current;
  if (Date.now() - mine.at < STATION_REFRESH_MS && !newBlock && !(v?.shift && Date.now() >= v.shift.endMs)) return;
  mine.loading = true;
  callCrewMyStation().then(({ data }) => { mine.view = data; }).catch(() => {})
    .finally(() => {
      Object.assign(mine, { at: Date.now(), loading: false });
      const fns = [...mine.waiting];
      mine.waiting.clear();
      fns.forEach((f) => f());
    });
}

// The lines I'm on this shift (no home lines — Decision 104): { now: [lineId], today: [lineId] }, or null when the lead
// hasn't seated me (or it isn't known yet). Uses the same 5-minute check as "Your station today".
export function myShiftLines(onRedraw) {
  refreshMine(onRedraw);
  const v = mine.view;
  return v?.seated ? { now: v.linesNow || [], today: v.linesToday || [] } : null;
}

export function stationPanel({ onOpen, onSop, onRedraw }) {
  refreshMine(onRedraw);
  const v = mine.view;
  if (!v?.seated) return null;
  const now = v.current >= 0 ? v.blocks[v.current] : null;
  const showing = now || v.blocks[0];
  const sops = showing.station?.sops || [];
  return el("section", { class: "card my-station", "aria-label": "Your station today" },
    el("div", { class: "my-station-head" },
      el("h2", { class: "home-h2" }, `🧭 Your station today · ${v.shift.shiftName}`),
      el("button", { class: "link-btn", type: "button", onclick: onOpen }, "Whole crew →")),
    el("p", { class: "my-station-now" },
      v.allShift ? "" : el("span", { class: "person-meta" }, now ? `Now · ${now.label}` : "First"),
      el("strong", {}, showing.station?.name || "No station this block"),
      v.allShift ? el("span", { class: "person-meta" }, "all shift") : null),
    !v.allShift && v.blocks.length > 1
      ? el("div", { class: "block-row" }, v.blocks.map((b, i) => el("div", { class: i === v.current ? "block now" : "block" },
          el("span", { class: "block-time" }, b.label),
          el("span", { class: "block-station" }, b.station?.name || "No station"))))
      : null,
    sops.length ? el("div", { class: "sop-chips" }, el("span", { class: "person-meta" }, "SOPs"), sops.map((code) => /^\d+$/.test(code) && onSop
      ? el("button", { class: "chip small", type: "button", onclick: () => onSop(`cdgsop${code.padStart(4, "0")}`) }, code)
      : el("span", { class: "tag" }, code))) : null);
}

// ---- the board ----------------------------------------------------------------------------------------------------

export function openCrew(container, { onExit, backLabel = "Home", onSop = null, admin = false }) {
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

  // ---- Stations (Crew Board step 2): all-shift seats, the A–E rotation, the level check, SOPs, warnings ----------
  const seat = (seatId, emp) => act(() => callCrewSeat({ seat: seatId, emp: emp || null }), () => seat(seatId, emp), emp ? "Seated" : "Seat emptied");
  async function changeCell(st, emp, name, block) {
    const label = st.setup.rotation.blocks[block];
    const v = await choose({ title: `${name} · ${label}`, options: [...st.setup.stations.map((x) => ({ value: x.id, label: x.name })), { value: "-", label: "No station this block" }] });
    if (v == null) return;
    const send = () => act(() => callCrewCell({ emp, block, station: v === "-" ? "" : v }), send, "Changed");
    send();
  }
  const stationName = (st, id) => st.setup.stations.find((x) => x.id === id)?.name || "No station";
  const sopChips = (station) => (station?.sops?.length
    ? el("div", { class: "sop-chips" }, el("span", { class: "person-meta" }, "SOPs"), station.sops.map((code) => /^\d+$/.test(code) && onSop
        ? el("button", { class: "chip small", type: "button", onclick: () => onSop(`cdgsop${code.padStart(4, "0")}`) }, code)
        : el("span", { class: "tag" }, code)))
    : null);
  const fitNote = (f) => (f ? el("span", { class: f.kind === "below" ? "fit-note warn" : "fit-note" }, `${f.kind === "assist" ? "ℹ" : "⚠"} ${f.text}`) : null);

  function seatPicker(v, st, seatId, title) {
    const here = v.people.filter((p) => p.status === "here");
    const taken = new Set(Object.entries(st.seats).filter(([k]) => k !== seatId).map(([, e]) => e));
    const options = [{ value: "", label: "No one" }, ...here.map((p) => ({ value: p.emp, label: `${p.name}${st.levels[p.emp] ? ` · ${st.levels[p.emp]}` : ""}${taken.has(p.emp) ? " (moves here)" : ""}` }))];
    return picker({ title, value: st.seats[seatId] || "", placeholder: "Pick someone who's here…", options, onChange: (e) => seat(seatId, e) });
  }

  function stationsPanel(v) {
    const st = v.stations;
    if (!st) return v.canMark && admin ? el("section", { class: "card" }, el("strong", {}, "🧭 Stations"), el("p", { class: "card-note" }, "The stations aren't set up yet — Admin → Crew Board stations.")) : null;
    const nameOf = (emp) => v.people.find((p) => p.emp === emp)?.name || `#${emp}`;
    const byId = (id) => st.setup.stations.find((x) => x.id === id);
    const allShift = st.setup.allShift.map((id) => {
      const s = byId(id);
      const emp = st.seats[id];
      return el("div", { class: "seat-row" },
        el("div", { class: "seat-head" }, el("strong", {}, s.name), el("span", { class: "person-meta" }, `Ideal: ${s.idealLevel || s.minLevel} · all shift`)),
        v.canMark ? seatPicker(v, st, id, s.name) : el("p", {}, emp ? nameOf(emp) : "No one yet"),
        emp ? fitNote(st.fits[emp]?.[0]) : null,
        sopChips(s));
    });
    const letters = st.setup.rotation.letters.map((l) => {
      const emp = st.seats[l.letter];
      const row = emp ? st.schedule[emp] || [] : l.stations;
      return el("div", { class: "seat-row" },
        el("div", { class: "seat-head" }, el("strong", {}, `${l.letter}${l.level ? ` · ${l.level}` : ""}`), emp && !v.canMark ? el("span", { class: "person-meta" }, nameOf(emp)) : null),
        v.canMark ? seatPicker(v, st, l.letter, `Rotation ${l.letter}`) : null,
        el("div", { class: "block-row" }, st.setup.rotation.blocks.map((b, i) => {
          const f = emp ? st.fits[emp]?.[i] : null;
          const body = [el("span", { class: "block-time" }, b), el("span", { class: "block-station" }, stationName(st, row[i])), f ? el("span", { class: "block-fit" }, f.kind === "assist" ? "ℹ assist only" : "⚠ level") : null];
          return emp && v.canMark
            ? el("button", { class: f?.kind === "below" ? "block warn" : "block", type: "button", disabled: ui.busy, onclick: () => changeCell(st, emp, nameOf(emp), i) }, body)
            : el("div", { class: "block" }, body);
        })),
        emp ? (st.fits[emp] || []).filter(Boolean).filter((f, i, a) => a.findIndex((x) => x.text === f.text) === i).map(fitNote) : null);
    });
    return el("section", { class: "card stations-card" },
      el("strong", {}, "🧭 Stations"),
      st.warnings.length ? el("div", { class: "warn-list" }, st.warnings.map((w) => el("p", { class: w.kind === "late" ? "message error" : "message" }, `${w.kind === "late" ? "⚠ " : ""}${w.text}`))) : null,
      v.canMark ? el("p", { class: "card-note" }, "Seat people marked Here. Tap a block to change it for that person.") : null,
      el("h3", { class: "home-h2" }, "All shift"),
      el("div", { class: "seat-list" }, allShift),
      st.setup.rotation.letters.length ? [el("h3", { class: "home-h2" }, "Winder rotation"), el("div", { class: "seat-list" }, letters)] : null,
      st.setup.rotation.note ? collapsible("crew-rotation-note", "How to rotate", el("p", { class: "card-note" }, st.setup.rotation.note)) : null);
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
      stationsPanel(v),
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

// ---- Admin → Crew Board stations ------------------------------------------------------------------------------------
// The stations, levels, SOPs, A–E rotation and call-off order (company data from the Shift Station Assignment sheet —
// loaded from a file, never kept in the code). Shows what's saved; "Load from a file" replaces it after a preview.
export function openCrewStationsAdmin(container, { onExit, backLabel = "Admin" }) {
  const ui = { setup: undefined, draft: null, draftText: "", loadError: "", busy: false, message: "", messageKind: "", retry: null };
  async function load() {
    ui.loadError = "";
    render();
    try { ui.setup = (await callAdminCrewStations()).data.setup; } catch (err) { ui.loadError = friendlyError(err); }
    render();
  }
  async function readFile(file) {
    try { ui.draftText = await file.text(); ui.draft = JSON.parse(ui.draftText); ui.message = ""; } catch { Object.assign(ui, { draft: null, message: "That file isn't a stations file (JSON).", messageKind: "error" }); }
    render();
  }
  async function save() {
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: save }); return render(); }
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      const { data: r } = await callAdminSaveCrewStations({ setup: ui.draft });
      toast(`Saved — ${r.stations} stations`);
      Object.assign(ui, { busy: false, draft: null });
      await load();
    } catch (err) { Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: save }); render(); }
  }
  const summary = (s) => [
    el("p", { class: "card-note" }, `Levels, lowest first: ${s.levels.join(" → ")}`),
    el("div", { class: "seat-list" }, s.stations.map((x) => el("div", { class: "seat-row" },
      el("div", { class: "seat-head" }, el("strong", {}, x.name), el("span", { class: "person-meta" }, `Ideal: ${x.idealLevel || x.minLevel}${s.allShift?.includes(x.id) ? " · all shift" : ""}`)),
      x.sops?.length ? el("span", { class: "person-meta" }, `Key SOPs: ${x.sops.join(", ")}`) : null))),
    s.rotation?.letters?.length
      ? el("p", { class: "card-note" }, `Rotation (${s.rotation.blocks.join(" · ")}): ${s.rotation.letters.map((l) => `${l.letter} ${l.stations.map((id) => s.stations.find((x) => x.id === id)?.name || id).join(" → ")}`).join(" | ")}`)
      : null,
  ];
  function render() {
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "🧭 Crew Board stations"),
      el("p", { class: "hint" }, "From the Shift Station Assignment sheet: Ideal level and Key SOPs."),
      banner(ui),
      ui.loadError ? banner({ message: ui.loadError, messageKind: "error", retry: load }) : null,
      ui.setup === undefined && !ui.loadError ? spinner("Loading…") : null,
      ui.draft
        ? el("section", { class: "card" }, el("strong", {}, "Preview — not saved yet"), ...(ui.draft.levels && ui.draft.stations ? summary(ui.draft) : [el("p", {}, "Can't read this file.")]),
            el("div", { class: "btn-row" },
              el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: save }, ui.busy ? "Saving…" : "✔ Save these stations"),
              el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.draft = null; render(); } }, "Cancel")))
        : ui.setup ? el("section", { class: "card" }, el("strong", {}, "Saved now"), ...summary(ui.setup))
        : ui.setup === null ? emptyState("No stations yet", "Load the stations file (private, from the Shift Station Assignment sheet).") : null,
      el("label", { class: "btn secondary file-btn" }, ui.setup ? "📂 Load a new stations file" : "📂 Load the stations file",
        el("input", { type: "file", accept: "application/json,.json", hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) readFile(f); } })),
    ].flat(3).filter(Boolean));
  }
  load();
  return () => {};
}
