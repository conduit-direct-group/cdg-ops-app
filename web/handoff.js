// Shift Handoff Notes (Decision 60) — the Line Lead Pass Down, in the app. The fields come from the handoff form
// (Admin → Forms); each handoff keeps the revision it was started on. What the app already knows (lines down,
// open maintenance issues, overdue checklists) is shown read-only and captured when it's sent.
// The outgoing lead signs with PIN; a Line Lead on the incoming team signs received (it's on their Home until then).
// Readers: Line Leads, Supervisors, Plant Manager, Admin.

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, picker, collapsible } from "./ui.js";
import { dueByShiftEnd } from "./shift.js";
import { data, onDataChange, lineName } from "./data.js";
import {
  db, TEST_MODE, callHandoffAutoFill, callStartHandoff, callSaveHandoffDraft, callSendHandoff, callDiscardHandoff,
  callReceiveHandoff, callHandoffReceivers,
} from "./firebase.js";
import { collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { signOff } from "./signoff.js";

export const HANDOFF_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const BACKUP_ROLES = ["supervisor", "plant-manager", "admin"];
export const usesHandoffs = (roles) => (roles || []).some((r) => HANDOFF_ROLES.includes(r));

const plantToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : t?.seconds ? t.seconds * 1000 : 0);
const fmtWhen = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const fmtDay = (day) => (day ? new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "");
const teamName = (id) => (data.teams || []).find((t) => t.id === id)?.name || id || "?";
const myTeam = () => data.myself?.team || null;

// Handoffs waiting for me to sign received: sent to my team (Line Leads). Backups (Supervisor, Plant Manager, Admin)
// can sign too, from the Handoff screen, but it isn't put on their Home.
export function toReceive(me) {
  if (!(me.roles || []).includes("lead")) return [];
  return (data.handoffsOpen || []).filter((h) => h.status === "sent" && h.toTeam === myTeam() && h.createdBy !== me.emp);
}
export const myDraft = (me) => (data.handoffsOpen || []).find((h) => h.status === "draft" && h.createdBy === me.emp) || null;

// Home items (Decision 66): a handoff to sign received, and your own unsent one — due by the end of the shift
// (gray), red in its last hour.
export function handoffItems(me, onOpen) {
  if (!usesHandoffs(me.roles) || !data.handoffsOpen) return [];
  const out = [];
  const due = dueByShiftEnd();
  const waiting = toReceive(me);
  if (waiting.length) {
    out.push({ key: "handoff-in", icon: "📝", ...due, onOpen: () => onOpen(waiting.length === 1 ? waiting[0].id : null),
      title: waiting.length === 1 ? `Shift handoff from Team ${teamName(waiting[0].team)} — sign received` : `${waiting.length} shift handoffs to sign received` });
  }
  const draft = myDraft(me);
  if (draft) out.push({ key: "handoff-draft", icon: "📝", title: "Your shift handoff — not sent yet", ...due, onOpen: () => onOpen(draft.id) });
  return out;
}


const STATUS = { draft: ["Not sent yet", "tag warn"], sent: ["Sent — waiting for received", "tag warn"], received: ["✓ Received", "tag ok"], discarded: ["Discarded", "tag"] };
function handoffRow(h, onclick, lineId = null) {
  const [label0, cls] = STATUS[h.status] || STATUS.draft;
  const label = h.status === "sent" ? `Sent — waiting for Team ${teamName(h.toTeam)} to sign received` : label0;
  const lineBits = lineId ? lineSummary(h, lineId) : "";
  return el("button", { class: "person-row", type: "button", onclick },
    el("span", { class: "person-name" }, `Team ${teamName(h.team)} → Team ${teamName(h.toTeam)} · ${fmtDay(h.date)}`),
    el("span", { class: "person-meta" }, [h.createdByName ? `by ${h.createdByName}` : "", h.status === "received" && h.receivedBy ? `received by ${h.receivedBy.name}` : "", h.sentBy ? `sent ${fmtWhen(h.sentBy.at)}` : ""].filter(Boolean).join(" · ")),
    lineBits ? el("span", { class: "person-meta" }, lineBits) : null,
    el("span", { class: "tags" }, el("span", { class: cls }, label), h.test ? el("span", { class: "tag test" }, "TEST") : null));
}

// One line's answers in a few words (history filtered by line).
function lineSummary(h, lineId) {
  const bits = [];
  for (const s of h.sections || []) for (const f of s.fields) {
    if (!f.perLine) continue;
    const v = h.values?.[f.id]?.[lineId];
    if (v !== undefined && v !== null && v !== "") bits.push(`${f.label}: ${showValue(f, v)}`);
  }
  return bits.join(" · ").slice(0, 240);
}

function showValue(f, v) {
  if (v === undefined || v === null || v === "") return "—";
  if (f.type === "yesno") return v ? "Yes" : "No";
  if (f.type === "percent") return `${v}%`;
  if (f.type === "number") return `${Number(v).toLocaleString("en-US")}${f.unit ? ` ${f.unit}` : ""}`;
  if (f.type === "datetime") return new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (f.type === "time") { const [hh, mm] = v.split(":").map(Number); return new Date(2000, 0, 1, hh, mm).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); }
  return String(v);
}

// The read-only block: what the app knows (live while filling in; as captured once sent).
function autoBlock(auto, { live = false, onRefresh = null } = {}) {
  if (!auto) return el("section", { class: "card auto-card" }, el("strong", {}, "From the app"), spinner("Checking lines, issues, and checklists…"));
  if (auto.error) return el("section", { class: "card auto-card" }, el("strong", {}, "From the app"), el("div", { class: "message error", role: "alert" }, auto.error, onRefresh ? el("button", { class: "btn secondary retry", type: "button", onclick: onRefresh }, "↻ Try again") : null));
  const issues = auto.openIssues || [];
  return el("section", { class: "card auto-card" },
    el("div", { class: "row-between" }, el("strong", {}, "From the app (read-only)"), onRefresh ? el("button", { class: "link-btn", type: "button", onclick: onRefresh }, "↻ Refresh") : null),
    el("p", { class: "card-note" }, live ? "Filled in by the app. It's saved with the handoff when you send it." : `As it was when sent${auto.at ? ` (${fmtWhen(auto.at)})` : ""}.`),
    el("p", { class: "field-label" }, "Lines down"),
    auto.linesDown?.length
      ? el("ul", { class: "auto-list" }, auto.linesDown.map((d) => el("li", { class: "down" }, `⛔ ${d.line}${d.machineIds?.length ? ` (${d.machineIds.join(", ")})` : ""}${d.since ? ` · since ${fmtWhen(d.since)}` : ""}`)))
      : el("p", { class: "auto-ok" }, "✓ All lines running"),
    el("p", { class: "field-label" }, `Open maintenance issues (${issues.length})`),
    issues.length
      ? el("ul", { class: "auto-list" }, issues.map((i) => el("li", { class: i.lineDown || i.unsafe ? "down" : "" }, `${i.lineDown ? "⛔ " : i.unsafe ? "⚠ " : ""}${i.machineId ? `${i.machineId} · ` : ""}${i.title}`)))
      : el("p", { class: "auto-ok" }, "✓ None open"),
    el("p", { class: "field-label" }, `Overdue checklists (${auto.overdueChecklists?.length || 0})`),
    auto.overdueChecklists?.length
      ? el("ul", { class: "auto-list" }, auto.overdueChecklists.map((c) => el("li", {}, `⚠ ${c}`)))
      : el("p", { class: "auto-ok" }, "✓ All up to date"));
}

// ===========================================================================

export function openHandoff(container, { me, startId = null, onExit }) {
  const ui = {
    view: startId ? "open" : "home", id: startId, busy: false, message: "", messageKind: "", retry: null,
    start: { team: myTeam() || "", toTeam: "", date: plantToday() },
    values: null, header: null, auto: null, save: "", history: null, histFrom: addDays(plantToday(), -30), histDay: "", histTeam: "", histLine: "",
  };
  let stopHist = null;
  let saveTimer = null;
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false }); render(); };
  const show = (view, extra = {}) => { Object.assign(ui, { view, busy: false, message: "", retry: null, ...extra }); render(); window.scrollTo(0, 0); };
  const back = (label, onclick) => el("button", { class: "link-btn no-print", type: "button", onclick, disabled: ui.busy }, `← ${label}`);
  const find = (id) => (data.handoffsOpen || []).find((h) => h.id === id) || (ui.history || []).find((h) => h.id === id);
  const activeTeams = () => (data.teams || []).filter((t) => t.active !== false);

  function loadAuto() {
    ui.auto = null;
    callHandoffAutoFill().then(({ data: r }) => { ui.auto = r; if (ui.view === "open") redrawAuto(); }, (err) => { ui.auto = { error: friendlyError(err) }; if (ui.view === "open") redrawAuto(); });
  }
  function redrawAuto() {
    const box = container.querySelector("#auto-box");
    if (box) box.replaceChildren(autoBlock(ui.auto, { live: true, onRefresh: loadAuto }));
  }

  // History: everything from the last 30 days (or one day), real + practice ones on the test site.
  function watchHistory() {
    stopHist?.();
    ui.history = null;
    const parts = {};
    const cols = TEST_MODE ? ["handoffs", "test_handoffs"] : ["handoffs"];
    const stops = cols.map((c) => onSnapshot(
      ui.histDay ? query(collection(db, c), where("date", "==", ui.histDay)) : query(collection(db, c), where("date", ">=", ui.histFrom)),
      (s) => {
        parts[c] = s.docs.map((d) => ({ id: d.id, ...d.data(), ...(c.startsWith("test_") ? { test: true } : {}) }));
        if (cols.every((x) => parts[x])) {
          ui.history = cols.flatMap((x) => parts[x]).filter((h) => h.status === "sent" || h.status === "received")
            .sort((a, b) => b.date.localeCompare(a.date) || toMs(b.sentAt) - toMs(a.sentAt));
          if (!ui.busy && !filling()) render();
        }
      },
      () => { ui.history = []; if (!filling()) render(); }));
    stopHist = () => stops.forEach((x) => x());
  }

  // ---- home: to receive · your draft · start · history ----------------------------------------------------------
  function renderHome() {
    const loading = !data.handoffsOpen || !data.teams;
    const waiting = loading ? [] : (data.handoffsOpen || []).filter((h) => h.status === "sent" && h.createdBy !== me.emp
      && (h.toTeam === myTeam() || me.roles.some((r) => BACKUP_ROLES.includes(r))));
    const draft = loading ? null : myDraft(me);
    const teams = activeTeams();
    const s = ui.start;
    if (!s.toTeam && teams.length > 1) {
      const i = teams.findIndex((t) => t.id === s.team);
      s.toTeam = teams[(i + 1) % teams.length]?.id || "";
    }
    async function start() {
      Object.assign(ui, { busy: true, message: "", retry: null });
      render();
      try {
        const { data: r } = await callStartHandoff(s);
        if (r.resumed) toast("You already have a handoff started — here it is");
        show("open", { id: r.id, values: null });
      } catch (err) {
        say(friendlyError(err), start);
      }
    }
    const hist = (ui.history || []).filter((h) => (!ui.histTeam || h.team === ui.histTeam || h.toTeam === ui.histTeam) && (!ui.histLine || (h.lines || []).some((l) => l.id === ui.histLine)));
    return [
      back("Home", onExit),
      el("h1", {}, "📝 Shift handoff"),
      el("p", { class: "hint" }, "Fill it in at the end of your shift, sign it, and hand it to the incoming team's Line Lead."),
      banner(ui),
      loading ? spinner() : null,
      waiting.length ? [el("h2", {}, `To read and sign received (${waiting.length})`), el("div", { class: "person-list" }, waiting.map((h) => handoffRow(h, () => show("open", { id: h.id }))))] : null,
      draft
        ? el("section", { class: "card" }, el("strong", {}, "Your handoff isn't sent yet"), el("div", { class: "person-list" }, handoffRow(draft, () => show("open", { id: draft.id, values: null }))))
        : !loading
          ? el("section", { class: "card" },
              el("strong", {}, "Start a handoff"),
              teams.length < 2 ? el("p", { class: "message error" }, "Teams aren't set up. An admin adds them in Admin → Teams.") : null,
              el("p", { class: "field-label" }, "Your team"),
              el("div", { class: "chips" }, teams.map((t) => el("button", { class: s.team === t.id ? "chip on" : "chip", type: "button", "aria-pressed": String(s.team === t.id), onclick: () => { s.team = t.id; if (s.toTeam === t.id) s.toTeam = ""; render(); } }, `Team ${t.name}`))),
              el("p", { class: "field-label" }, "Handing off to"),
              el("div", { class: "chips" }, teams.filter((t) => t.id !== s.team).map((t) => el("button", { class: s.toTeam === t.id ? "chip on" : "chip", type: "button", "aria-pressed": String(s.toTeam === t.id), onclick: () => { s.toTeam = t.id; render(); } }, `Team ${t.name}`))),
              el("label", { class: "field-label", for: "ho-date" }, "Date"),
              el("input", { class: "field date-field", id: "ho-date", type: "date", value: s.date, max: addDays(plantToday(), 1), onchange: (e) => { s.date = e.target.value; } }),
              el("button", { class: "btn big", type: "button", disabled: ui.busy || !s.team || !s.toTeam, onclick: start }, ui.busy ? "Starting…" : "📝 Start the handoff"))
          : null,
      collapsible("handoff-history", "🔎 Past handoffs — search by date, team, line",
        el("div", { class: "date-row" },
          el("div", {}, el("label", { class: "field-label", for: "ho-day" }, "One day (optional)"),
            el("input", { class: "field date-field", id: "ho-day", type: "date", value: ui.histDay, onchange: (e) => { ui.histDay = e.target.value; watchHistory(); render(); } })),
          el("div", {}, el("p", { class: "field-label" }, ui.histDay ? "" : "Showing the last 30 days"),
            ui.histDay ? el("button", { class: "btn secondary", type: "button", onclick: () => { ui.histDay = ""; watchHistory(); render(); } }, "Show the last 30 days") : null)),
        el("p", { class: "field-label" }, "Team"),
        el("div", { class: "chips" }, [["", "All"], ...teams.map((t) => [t.id, `Team ${t.name}`])].map(([id, label]) => el("button", { class: ui.histTeam === id ? "chip on" : "chip", type: "button", onclick: () => { ui.histTeam = id; render(); } }, label))),
        el("p", { class: "field-label" }, "Line"),
        el("div", { class: "chips" }, [["", "All"], ...(data.lines || []).filter((l) => l.active !== false).map((l) => [l.id, l.name])].map(([id, label]) => el("button", { class: ui.histLine === id ? "chip on" : "chip", type: "button", onclick: () => { ui.histLine = id; render(); } }, label))),
        !ui.history ? spinner("Loading past handoffs…")
          : !hist.length ? emptyState("No handoffs match", "Try another day, team, or line.")
          : el("div", { class: "person-list" }, hist.map((h) => handoffRow(h, () => show("open", { id: h.id }), ui.histLine || null)))),
    ];
  }

  // ---- fill in (your own draft) -----------------------------------------------------------------------------------
  function scheduleSave(h) {
    clearTimeout(saveTimer);
    setSave("Saving…");
    saveTimer = setTimeout(async () => {
      try {
        await callSaveHandoffDraft({ id: h.id, ...ui.header, values: ui.values });
        setSave("✓ Saved");
      } catch (err) {
        setSave(`Not saved — ${friendlyError(err)}`);
      }
    }, 1200);
  }
  function setSave(text) {
    ui.save = text;
    const node = container.querySelector("#ho-save");
    if (node) node.textContent = text;
  }

  function input(f, value, onValue, idSuffix, labelText) {
    const id = `ho-${f.id}${idSuffix ? `-${idSuffix}` : ""}`;
    const set = (v) => onValue(v === "" ? null : v);
    switch (f.type) {
      case "yesno":
        return el("div", { class: "choices two yesno", role: "group", "aria-label": labelText },
          el("button", { class: value === true ? "choice on" : "choice", type: "button", "aria-pressed": String(value === true), onclick: () => { onValue(value === true ? null : true); render(); } }, "Yes"),
          el("button", { class: value === false ? "choice on" : "choice", type: "button", "aria-pressed": String(value === false), onclick: () => { onValue(value === false ? null : false); render(); } }, "No"));
      case "longtext":
        return el("textarea", { class: "field", id, rows: "3", maxlength: "4000", "aria-label": labelText, value: value ?? "", oninput: (e) => set(e.target.value) });
      case "text":
        return el("input", { class: "field", id, maxlength: "200", "aria-label": labelText, value: value ?? "", oninput: (e) => set(e.target.value) });
      case "datetime":
        return el("div", { class: "with-now" },
          el("input", { class: "field", id, type: "datetime-local", "aria-label": labelText, value: value ?? "", onchange: (e) => set(e.target.value) }),
          el("button", { class: "btn secondary", type: "button", onclick: () => { const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); onValue(d.toISOString().slice(0, 16)); render(); } }, "Now"));
      case "time":
        return el("input", { class: "field", id, type: "time", "aria-label": labelText, value: value ?? "", onchange: (e) => set(e.target.value) });
      default: // number, percent
        return el("div", { class: "num-wrap" },
          el("input", { class: "field num-field", id, type: "text", inputmode: f.type === "percent" ? "numeric" : "decimal", autocomplete: "off", "aria-label": labelText, value: value ?? "", oninput: (e) => set(e.target.value.trim()) }),
          f.type === "percent" || f.unit ? el("span", { class: "num-unit" }, f.type === "percent" ? "%" : f.unit) : null);
    }
  }

  function renderFill(h) {
    if (!ui.values) {
      ui.values = JSON.parse(JSON.stringify(h.values || {}));
      ui.header = { team: h.team, toTeam: h.toTeam, date: h.date };
      loadAuto();
    }
    const v = ui.values;
    const changed = () => scheduleSave(h);
    async function send() {
      clearTimeout(saveTimer);
      if (!(await confirmSheet({ title: `Sign and send to Team ${teamName(ui.header.toTeam)}?`, text: "Their Line Lead sees it on Home and signs that they received it. You can't change it after sending.", confirmLabel: "✍ Sign and send" }))) return;
      const r = await signOff({
        title: "Sign the handoff", what: `Team ${teamName(ui.header.team)} → Team ${teamName(ui.header.toTeam)} · ${fmtDay(ui.header.date)}`,
        me: { emp: me.emp, name: me.name },
        action: async ({ signer, device }) => (await callSendHandoff({ id: h.id, ...ui.header, values: ui.values, signer, device })).data,
      });
      if (!r) return;
      toast(r.test ? "Sent (test) — only you get the notification" : r.leads ? `Sent — Team ${teamName(ui.header.toTeam)}'s Line Lead${r.leads === 1 ? "" : "s"} notified` : "Sent — but no Line Lead is set on that team yet (Admin → People)");
      show("open", { id: h.id, values: null });
    }
    async function discard() {
      if (!(await confirmSheet({ title: "Throw away this handoff?", text: "It isn't sent to anyone. (It's kept in the records as discarded.)", confirmLabel: "Discard", danger: true }))) return;
      clearTimeout(saveTimer);
      try { await callDiscardHandoff({ id: h.id }); toast("Discarded"); show("home", { values: null }); } catch (err) { say(friendlyError(err), discard); }
    }
    const teams = activeTeams();
    return [
      back("Shift handoff", () => show("home", { values: null })),
      el("h1", {}, h.formName || "Shift handoff"),
      h.intro ? el("p", { class: "hint" }, h.intro) : null,
      el("p", { class: "tags ann-tags" }, el("span", { class: "tag" }, `Form revision ${h.formRev}`), h.test ? el("span", { class: "tag test" }, "TEST") : null, el("span", { class: "save-state", id: "ho-save", role: "status" }, ui.save)),
      banner(ui),
      el("section", { class: "card" },
        el("p", { class: "field-label" }, "Your team"),
        el("div", { class: "chips" }, teams.map((t) => el("button", { class: ui.header.team === t.id ? "chip on" : "chip", type: "button", onclick: () => { ui.header.team = t.id; if (ui.header.toTeam === t.id) ui.header.toTeam = teams.find((x) => x.id !== t.id)?.id; render(); changed(); } }, `Team ${t.name}`))),
        el("p", { class: "field-label" }, "Handing off to"),
        el("div", { class: "chips" }, teams.filter((t) => t.id !== ui.header.team).map((t) => el("button", { class: ui.header.toTeam === t.id ? "chip on" : "chip", type: "button", onclick: () => { ui.header.toTeam = t.id; render(); changed(); } }, `Team ${t.name}`))),
        el("label", { class: "field-label", for: "ho-hdate" }, "Date"),
        el("input", { class: "field date-field", id: "ho-hdate", type: "date", value: ui.header.date, onchange: (e) => { ui.header.date = e.target.value; changed(); } })),
      el("div", { id: "auto-box" }, autoBlock(ui.auto, { live: true, onRefresh: loadAuto })),
      (h.sections || []).map((s) =>
        el("section", { class: "card ho-section" },
          el("h2", {}, s.title),
          s.help ? el("p", { class: "card-note" }, s.help) : null,
          s.fields.map((f) => f.perLine
            ? el("div", { class: "ho-field" },
                el("p", { class: "field-label strong" }, f.label),
                f.help ? el("p", { class: "card-note" }, f.help) : null,
                el("div", { class: "per-line" }, (h.lines || []).map((l) =>
                  el("div", { class: "per-line-cell" },
                    el("label", { class: "line-tag", for: `ho-${f.id}-${l.id}` }, l.name),
                    input(f, v[f.id]?.[l.id], (val) => { v[f.id] = { ...(v[f.id] || {}) }; if (val === null) delete v[f.id][l.id]; else v[f.id][l.id] = val; changed(); }, l.id, `${f.label} — ${l.name}`)))))
            : el("div", { class: "ho-field" },
                el("label", { class: "field-label strong", for: `ho-${f.id}` }, f.label),
                f.help ? el("p", { class: "card-note" }, f.help) : null,
                input(f, v[f.id], (val) => { if (val === null) delete v[f.id]; else v[f.id] = val; changed(); }, "", f.label))))),
      el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: send }, `✍ Sign and send to Team ${teamName(ui.header.toTeam)}`),
      el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: discard }, "Discard this handoff"),
    ];
  }

  // ---- read (sent / received) -------------------------------------------------------------------------------------
  // Who a sent handoff is waiting on, in plain words: the incoming team's Line Leads (it's on their Home), or why
  // nobody can see it yet. Names come from the server (the app can't read other people's records).
  const receivers = {};
  function waitingNote(h) {
    const team = `Team ${teamName(h.toTeam)}`;
    if (receivers[h.id] === undefined) {
      receivers[h.id] = null;
      callHandoffReceivers({ id: h.id }).then(({ data: r }) => { receivers[h.id] = r.people; render(); }, () => { receivers[h.id] = "error"; render(); });
    }
    const list = receivers[h.id];
    const mine = h.createdBy === me.emp ? " You wrote it, so someone else signs received." : "";
    if (list === null) return el("p", { class: "message" }, `Waiting for ${team}'s Line Lead to sign received…`);
    if (list === "error") return el("p", { class: "message" }, `Waiting for ${team}'s Line Lead to sign received. It's on their Home screen.${mine}`);
    if (list.length) return el("p", { class: "message" }, `Waiting for ${team}'s Line Lead to sign received. It's on the Home screen of: ${list.map((p) => p.name).join(", ")}.${mine}`);
    return el("div", { class: "message error", role: "alert" },
      el("strong", {}, `Nobody on ${team} can see this on Home yet.`),
      el("p", {}, `No one on ${team} has the Line Lead role with a login. Set one in Admin → People (role Line Lead, team ${teamName(h.toTeam)}). Until then a Supervisor, the Plant Manager, or an Admin can open it here and sign received.${mine}`));
  }

  function renderView(h) {
    const canReceive = h.status === "sent" && h.createdBy !== me.emp && ((me.roles.includes("lead") && myTeam() === h.toTeam) || me.roles.some((r) => BACKUP_ROLES.includes(r)));
    async function receive() {
      const r = await signOff({
        title: "Sign received", what: `Handoff from Team ${teamName(h.team)} · ${fmtDay(h.date)}`,
        me: { emp: me.emp, name: me.name },
        others: async () => (await callHandoffReceivers({ id: h.id })).data.people,
        action: async ({ signer, device }) => (await callReceiveHandoff({ id: h.id, signer, device })).data,
      });
      if (r) toast(`Received — signed by ${r.name}${r.test ? " (test)" : ""}`);
    }
    const [label, cls] = STATUS[h.status] || STATUS.draft;
    return [
      back("Shift handoff", () => show("home")),
      el("h1", { class: "fix-title" }, `Team ${teamName(h.team)} → Team ${teamName(h.toTeam)}`),
      el("p", { class: "hint" }, `${fmtDay(h.date)} · ${h.formName || "Shift handoff"} · form revision ${h.formRev}`),
      el("p", { class: "tags ann-tags" }, el("span", { class: cls }, label), h.test ? el("span", { class: "tag test" }, "TEST") : null),
      banner(ui),
      el("section", { class: "card sign-card" },
        el("p", {}, h.sentBy ? `✍ Sent by ${h.sentBy.name} · ${fmtWhen(h.sentBy.at)}${h.sentBy.device?.label ? ` · ${h.sentBy.device.label}` : ""}` : "Not sent yet"),
        el("p", {}, h.receivedBy ? `✍ Received by ${h.receivedBy.name} · ${fmtWhen(h.receivedBy.at)}${h.receivedBy.device?.label ? ` · ${h.receivedBy.device.label}` : ""}` : "")),
      h.status === "sent" ? waitingNote(h) : null,
      canReceive ? el("button", { class: "btn big", type: "button", onclick: receive }, "✍ Sign received") : null,
      canReceive ? el("p", { class: "hint" }, `You'll confirm with your PIN${TEST_MODE ? " — test site, practice only" : ""}.`) : null,
      autoBlock(h.auto),
      (h.sections || []).map((s) =>
        el("section", { class: "card ho-section" },
          el("h2", {}, s.title),
          el("table", { class: "info-table ho-table" },
            s.fields.some((f) => f.perLine) ? el("thead", {}, el("tr", {}, el("th", {}, ""), (h.lines || []).map((l) => el("th", {}, l.name)))) : null,
            el("tbody", {}, s.fields.map((f) => f.perLine
              ? el("tr", {}, el("th", {}, f.label), (h.lines || []).map((l) => el("td", { class: f.type === "longtext" ? "keep-lines" : "" }, showValue(f, h.values?.[f.id]?.[l.id]))))
              : el("tr", {}, el("th", {}, f.label), el("td", { class: f.type === "longtext" ? "keep-lines" : "", colspan: String(Math.max(1, s.fields.some((x) => x.perLine) ? (h.lines || []).length : 1)) }, showValue(f, h.values?.[f.id])))))))),
    ];
  }

  function renderOpen() {
    const h = find(ui.id);
    if (!h) return [back("Shift handoff", () => show("home")), !data.handoffsOpen ? spinner() : emptyState("Handoff not found", "Open it from the list of past handoffs.")];
    return h.status === "draft" && h.createdBy === me.emp ? renderFill(h) : renderView(h);
  }

  function render() {
    const views = { home: renderHome, open: renderOpen };
    container.replaceChildren(...[(views[ui.view] || renderHome)()].flat(3).filter(Boolean));
  }

  // Live updates: never while filling in (it would lose your place).
  // (Until the form is on screen — ui.values set — a draft arriving still draws it.)
  const filling = () => ui.view === "open" && !!ui.values && find(ui.id)?.status === "draft" && find(ui.id)?.createdBy === me.emp;
  const stop = onDataChange(() => { if (!ui.busy && !filling()) render(); });
  // Past handoffs (also how a received one, or one opened from a notification, is found).
  watchHistory();
  render();
  return () => { stop(); stopHist?.(); clearTimeout(saveTimer); };
}
