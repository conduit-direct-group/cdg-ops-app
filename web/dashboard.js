// Home (Decision 66; layout replaces the Decision 49 dashboard). Top to bottom:
//   1. Name and role, with each line's status right under it (green running / red down).
//   2. Needs you — every item appears once, in one of three states: gray = not due yet (with its due time),
//      red ⚠ = last hour of the shift or overdue, green ✓ = done. Tapping an item opens it.
//   3. Quick buttons: Shop Map · Need something? · Maintenance Request.
//   4. At a glance — summary cards about other people's work (only ones that don't repeat a Needs you item).
// The navigation bar (Home · Map · Checklists · Announcements · More) is in app.js. Admins can "View as" any role.

import { el, picker, choose } from "./ui.js";
import { data, lineName } from "./data.js";
import { overdueUnits, unitLabel } from "./checklists.js";
import { myOpenRequests } from "./requests.js";
import { announcementItems } from "./announcements.js";
import { handoffItems } from "./handoff.js";
import { shopItems } from "./shoptasks.js";
import { stationItems } from "./stations.js";
import { lineCheckItems } from "./linecheck.js";
import { db, TEST_MODE, callAdminListEmployees, callAnnouncementSummary } from "./firebase.js";
import { siloItems, siloCard } from "./silos.js";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// Role order on a combined screen, and each role's "At a glance" cards (ids are shared, so duplicates merge).
// Cards that would repeat a Needs you item (checklists due, requests for you, lines down, open maintenance
// requests, safety concerns) are gone — Needs you covers them.
export const ROLE_CARDS = [
  ["admin", "Admin", ["system-alerts", "waiting-login"]],
  ["plant-manager", "Plant Manager", ["pm-people", "ack-gaps", "silos"]],
  ["supervisor", "Supervisor", ["crew-gaps", "silos"]],
  ["lead", "Line Lead", []],
  ["operator", "Operator", []],
  ["maintenance", "Maintenance", []],
  ["quality", "Quality", []],
  ["shipping", "Logistics & Distribution", ["silos"]],
  ["sales", "Sales", []],
  ["office", "Office", ["ack-gaps"]],
  ["training-safety", "Training & Safety", ["trainees", "expiring"]],
];

// Office, Sales, Quality, Logistics & Distribution see nothing about machines or maintenance (Decision 53).
export const NON_MACHINE_ROLES = ["office", "sales", "quality", "shipping"];
export const usesMachines = (roles) => roles.some((r) => !NON_MACHINE_ROLES.includes(r));

const DAY = 86400000;
const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : t?.seconds ? t.seconds * 1000 : 0);
function howLong(ms) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- extra data some cards need (loaded only when one of those cards is on screen) ----------------------

const extra = { training: null, odooSync: undefined, waitingLogin: null, ann: { all: null, crew: null } };
let myTrainingName = null; // from the person's own record (Admin → People → Training record)
let extraStops = {};
let redraw = () => {};

// Training records (same data the 🎓 Training page uses): refreshers due and trainees in training.
let trainingParts = null;
function watchTraining() {
  if (trainingParts && trainingParts.myName !== myTrainingName) { trainingParts.myName = myTrainingName; trainingParts.recompute?.(); }
  if (extraStops.training) return;
  const parts = (trainingParts = { myName: myTrainingName });
  const compute = () => {
    if (parts.data === undefined || parts.shared === undefined || parts.people === undefined) return;
    if (!parts.data) { extra.training = { missing: true }; return redraw(); }
    const d = { ...parts.data };
    let wb = null;
    try { wb = parts.shared?.wbData ? JSON.parse(parts.shared.wbData) : null; } catch {}
    if (wb?.roster?.length && wb.rev === d.rev) Object.assign(d, wb);
    const people = new Map(parts.people.map((p) => [p.name, p]));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
    const in30 = new Date(Date.parse(today + "T12:00:00Z") + 30 * DAY).toISOString().slice(0, 10);
    const addYear = (iso) => { const x = new Date(iso + "T12:00:00Z"); x.setUTCFullYear(x.getUTCFullYear() + 1); return x.toISOString().slice(0, 10); };
    let overdue = 0, soon = 0, inTraining = 0, toVerify = 0;
    const mine = { overdue: [], soon: [] };
    const LABEL = { loto: "LOTO", eap: "Emergency Action Plan", ppe: "Safety / PPE", c10: "Injury reporting", qc: "Quality check", ld08: "Lead injury response" };
    for (const r of (d.roster || []).filter((x) => x.name && (x.id || x.team || x.position))) {
      const p = people.get(r.name) || {};
      const position = p.posOv && p.posOv.from === r.position ? p.posOv.to : r.position;
      for (const k of ["loto", "eap", "ppe", "c10", "qc", "ld08"]) {
        if (k === "ld08" && !/Lead/.test(position || "")) continue;
        const last = (p.refresh || {})[k] || ((d.refreshers || {})[r.name] || {})[k];
        if (!last) continue;
        const due = addYear(last);
        if (due < today) overdue++;
        else if (due <= in30) soon++;
        if (r.name === parts.myName && due <= in30) (due < today ? mine.overdue : mine.soon).push({ what: LABEL[k], due });
      }
      if (r.status === "In training") inTraining++;
      const orient = p.orient || (d.safety || {})[r.name];
      if (orient && orient.verified !== "Yes") toVerify++;
    }
    extra.training = { overdue, soon, inTraining, toVerify, mine, myName: parts.myName };
    redraw();
  };
  parts.recompute = compute;
  const col = (n) => collection(db, (TEST_MODE ? "test_" : "") + n);
  const stops = [
    onSnapshot(doc(db, "trainingRef", "data"), (s) => { try { parts.data = s.exists() ? JSON.parse(s.get("json")) : null; } catch { parts.data = null; } compute(); }, () => { parts.data = null; compute(); }),
    onSnapshot(doc(col("trainingShared"), "state"), (s) => { parts.shared = s.exists() ? s.data() : null; compute(); }, () => { parts.shared = null; compute(); }),
    onSnapshot(col("trainingPeople"), (s) => { parts.people = s.docs.map((x) => x.data()); compute(); }, () => { parts.people = []; compute(); }),
  ];
  extraStops.training = () => stops.forEach((x) => x());
}
function watchOdooSync() {
  if (extraStops.odoo) return;
  extraStops.odoo = onSnapshot(doc(db, "meta", "odooSync"), (s) => { extra.odooSync = s.exists() ? s.data() : null; redraw(); }, () => { extra.odooSync = null; redraw(); });
}
let loginCheckedAt = 0;
function checkWaitingLogin() {
  if (Date.now() - loginCheckedAt < 5 * 60000) return;
  loginCheckedAt = Date.now();
  callAdminListEmployees().then(({ data: r }) => {
    extra.waitingLogin = (r.employees || []).filter((p) => p.active && !p.loginEnabled).length;
    redraw();
  }).catch(() => { loginCheckedAt = 0; });
}
// Announcement sign-offs (from the server: the app can't read other people's signatures). Refreshed every 5 minutes.
const annCheckedAt = { all: 0, crew: 0 };
function checkAnnouncements(scope) {
  if (Date.now() - annCheckedAt[scope] < 5 * 60000) return;
  annCheckedAt[scope] = Date.now();
  callAnnouncementSummary({ scope }).then(({ data: r }) => { extra.ann[scope] = r; redraw(); }).catch(() => { annCheckedAt[scope] = 0; extra.ann[scope] = { error: true }; redraw(); });
}
export function stopDashboard() {
  Object.values(extraStops).forEach((f) => f());
  extraStops = {};
  extra.training = null; extra.odooSync = undefined; extra.waitingLogin = null; loginCheckedAt = 0; trainingParts = null;
  extra.ann = { all: null, crew: null }; annCheckedAt.all = annCheckedAt.crew = 0;
}

// ---- the cards ----------------------------------------------------------------------------------------------

// Each returns { icon, title, num, line, alert, onOpen } or null while its data is still loading.
function cardData(id, ctx) {
  const { go } = ctx;
  const down = Object.entries(data.plantStatus?.down || {});
  const openIssues = data.openIssues || [];
  switch (id) {
    case "trainees": {
      watchTraining();
      const t = extra.training;
      if (!t) return null;
      if (t.missing) return { icon: "🎓", title: "Trainees", num: "—", line: "Training data not loaded yet (Admin → Training setup)", alert: false, onOpen: go.training };
      return { icon: "🎓", title: "Trainees", num: t.inTraining, line: t.toVerify ? `${plural(t.toVerify, "orientation")} to verify` : "All clear", alert: t.toVerify > 0, onOpen: go.training };
    }
    case "expiring": {
      watchTraining();
      const t = extra.training;
      if (!t) return null;
      if (t.missing) return { icon: "⏳", title: "Refreshers expiring ≤ 30 days", num: "—", line: "Training data not loaded yet", alert: false, onOpen: go.training };
      return { icon: "⏳", title: "Refreshers expiring ≤ 30 days", num: t.overdue + t.soon,
        line: t.overdue + t.soon ? [t.overdue && `${t.overdue} overdue`, t.soon && `${t.soon} due soon`].filter(Boolean).join(" · ") : "All clear",
        alert: t.overdue > 0, onOpen: go.training };
    }
    case "pm-people": {
      watchTraining();
      const t = extra.training;
      if (!t) return null;
      if (t.missing) return { icon: "👥", title: "People · training", num: "—", line: "Training data not loaded yet", alert: false, onOpen: go.training };
      return { icon: "👥", title: "People · training", num: t.overdue,
        line: t.overdue || t.soon ? [t.overdue && `${t.overdue} refreshers overdue`, t.soon && `${t.soon} due in 30 days`].filter(Boolean).join(" · ") : "All clear",
        alert: t.overdue > 0, onOpen: go.training };
    }
    case "system-alerts": {
      watchOdooSync();
      if (extra.odooSync === undefined) return null;
      const s = extra.odooSync;
      const alerts = [];
      if (!s) alerts.push("Odoo sync has never run");
      else if (s.ok === false) alerts.push(`Odoo sync failing: ${String(s.error || "").slice(0, 60)}`);
      else if (Date.now() - toMs(s.lastAt) > 20 * 60000) alerts.push(`Odoo sync last ran ${howLong(toMs(s.lastAt))} ago`);
      return { icon: "🖥", title: "System alerts", num: alerts.length, line: alerts[0] || "All clear", alert: alerts.length > 0, onOpen: null };
    }
    case "waiting-login": {
      checkWaitingLogin();
      if (extra.waitingLogin === null) return null;
      const n = extra.waitingLogin;
      return { icon: "🔑", title: "People waiting for login", num: n, line: n ? "Admin → People → Enable login" : "All clear", alert: n > 0, onOpen: n ? go.people : null };
    }
    case "ack-gaps":
    case "crew-gaps": {
      const scope = id === "crew-gaps" ? "crew" : "all";
      checkAnnouncements(scope);
      const r = extra.ann[scope];
      const title = scope === "crew" ? "Crew: announcements not signed" : "Who hasn't acknowledged";
      if (!r) return null;
      if (r.error) return { icon: "📣", title, num: "—", line: "Couldn't load — open Announcements", alert: false, onOpen: go.announcements };
      if (r.noCrew) return { icon: "📣", title, num: "—", line: "Set your team in Admin → People to see your crew", alert: false, onOpen: go.announcements };
      const ups = r.items.length;
      return { icon: "📣", title, num: r.behind,
        line: r.behind ? [r.behindOverdue && `${plural(r.behindOverdue, "person", "people")} overdue`, `${plural(ups, "announcement")} up`].filter(Boolean).join(" · ") : ups ? "All clear — everyone has signed" : "All clear",
        alert: r.behindOverdue > 0, onOpen: go.announcements };
    }
    default:
      return null;
  }
}

function card(c, id) {
  if (!c) return el("div", { class: "dash-card loading", "data-card": id }, el("span", { class: "dash-title" }, "Loading…"));
  const body = [
    el("span", { class: "dash-title" }, `${c.icon} ${c.title}`),
    el("span", { class: "dash-num" }, String(c.num)),
    el("span", { class: "dash-line" }, c.line),
  ];
  return c.onOpen
    ? el("button", { class: c.alert ? "dash-card alert" : "dash-card", type: "button", onclick: c.onOpen, "data-card": id }, body)
    : el("div", { class: c.alert ? "dash-card alert" : "dash-card", "data-card": id }, body);
}

// Card ids for these roles, in role order, duplicates merged. Plant Manager may have 5; others 4.
export function cardsFor(roles) {
  const out = [];
  for (const [role, , ids] of ROLE_CARDS) {
    if (!roles.includes(role)) continue;
    const max = role === "plant-manager" ? 5 : 4;
    ids.slice(0, max).forEach((id) => { if (!out.includes(id)) out.push(id); });
  }
  return out;
}

// ---- Needs you ----------------------------------------------------------------------------------------------

const STATE_ORDER = { late: 0, due: 1, done: 2 };
const MARK = { late: "⚠", due: "", done: "✓" };
const SAFETY_WATCHERS = ["supervisor", "training-safety", "plant-manager", "admin"];
const ISSUE_ROLES = ["maintenance", "admin", "plant-manager"];

function needRow(it) {
  return el("button", { class: `need-item ${it.state}`, type: "button", onclick: it.onOpen, "data-key": it.key },
    el("span", { class: "need-icon", "aria-hidden": "true" }, it.icon || "•"),
    el("span", { class: "need-text" }, el("span", { class: "need-title" }, it.title), it.detail ? el("span", { class: "need-detail" }, it.detail) : null),
    el("span", { class: "need-mark", "aria-label": it.state === "late" ? "Needs doing now" : it.state === "done" ? "Done" : "Not due yet" }, MARK[it.state] || "›"));
}

// Several things behind one item: a big pick-one sheet, then open the one picked.
const pickThen = (title, list, open) => async () => {
  if (list.length === 1) return open(list[0].value);
  const v = await choose({ title, options: list });
  if (v != null) open(v);
};

// Every Needs you item for these roles, each once, red first, then gray, then green.
function needsItems(ctx, roles) {
  const { go } = ctx;
  const me = { emp: ctx.emp, roles };
  const machines = usesMachines(roles);
  const items = [];
  items.push(...announcementItems(ctx.emp, go.announcement));

  // Open safety concerns (urgent requests) — Supervisor, Training & Safety, Plant Manager, Admin.
  const watcher = roles.some((r) => SAFETY_WATCHERS.includes(r));
  if (watcher && data.urgentRequests) {
    const open = data.urgentRequests.filter((r) => r.status !== "done");
    if (open.length) items.push({ key: "safety", icon: "⚠", title: `Open safety concern${open.length === 1 ? "" : "s"}: ${open[0].description?.slice(0, 60) || open[0].typeName}${open.length > 1 ? ` (+${open.length - 1})` : ""}`,
      detail: open[0].lineName || "act now", state: "late", onOpen: pickThen("Safety concerns", open.map((r) => ({ value: r.id, label: `${r.description?.slice(0, 70) || r.typeName}${r.lineName ? ` · ${r.lineName}` : ""}` })), go.request) });
  }

  // Open maintenance requests — Maintenance, Admin, Plant Manager (red when a line is down or it's unsafe).
  // "Down" comes from the same summary as the line status at the top, so the two always agree. Requests still
  // flagged line-down whose line is running are named as such, so someone marks them back up in Open issues.
  if (machines && roles.some((r) => ISSUE_ROLES.includes(r)) && data.openIssues) {
    const open = data.openIssues;
    const down = data.plantStatus?.down || {};
    const linesDown = (data.lines || []).filter((l) => down[l.id]).map((l) => l.name);
    const lineOf = (i) => (data.machines || []).find((m) => m.id === i.machineId)?.lineId || null;
    const stale = open.filter((i) => i.lineDown && lineOf(i) && !down[lineOf(i)]).length;
    const unsafe = open.filter((i) => i.unsafe && !i.lineDown).length;
    const detail = [
      linesDown.length && `⛔ ${linesDown.join(", ")} down`,
      stale && `${stale} still marked line-down, but ${stale === 1 ? "its line is" : "their lines are"} running — mark ${stale === 1 ? "it" : "them"} back up`,
      unsafe && `${unsafe} unsafe`,
    ].filter(Boolean).join(" · ");
    items.push(open.length
      ? { key: "maint", icon: "🚨", title: `Open maintenance requests: ${open.length}`, detail: detail || "none urgent", state: linesDown.length + unsafe ? "late" : "due", onOpen: go.issues }
      : { key: "maint", icon: "🚨", title: "Maintenance requests", detail: "none open", state: "done", onOpen: go.issues });
  }

  items.push(...siloItems(roles, go.silos));
  items.push(...handoffItems(me, go.handoff));
  items.push(...shopItems(me, roles, go.shop));
  if (machines) items.push(...stationItems(roles, go.station));
  if (machines) items.push(...lineCheckItems(roles, go.lineCheck));

  // Machine checklists (14-day) — people who work with the machines; operators/leads with a home line: that line.
  if (machines && data.checklistUnits && data.lines && data.checklistTemplates) {
    const home = roles.some((r) => ["operator", "lead"].includes(r)) && !roles.some((r) => ISSUE_ROLES.includes(r)) ? data.myself?.homeLineId || null : null;
    const late = overdueUnits().filter((u) => !home || u.lineId === home || u.lineId === null);
    items.push(late.length
      ? { key: "checklists", icon: "📋", title: `Machine checklists overdue: ${late.length}`, detail: late.slice(0, 2).map(unitLabel).join(" · ") + (late.length > 2 ? ` +${late.length - 2}` : ""), state: "late",
          onOpen: pickThen("Overdue checklists", late.map((u) => ({ value: u.id, label: unitLabel(u) })), go.checklist) }
      : { key: "checklists", icon: "📋", title: "Machine checklists", detail: "all up to date", state: "done", onOpen: go.checklists });
  }

  // "Need something?" requests sent to me (admins: every open one). Safety concerns are their own item above.
  const forMe = (data.requestsForMe || []).filter((r) => r.status !== "done" && !(watcher && r.urgent));
  if (forMe.length) {
    const urgent = forMe.filter((r) => r.urgent).length;
    const oldest = forMe.reduce((a, r) => Math.min(a, toMs(r.createdAt) || a), Date.now());
    items.push({ key: "requests", icon: "📥", title: `${ctx.admin && !ctx.viewAs ? "Open requests (everyone's)" : "Requests for you"}: ${forMe.length}`,
      detail: [urgent && `${urgent} urgent`, `oldest ${howLong(oldest)}`].filter(Boolean).join(" · "), state: urgent ? "late" : "due",
      onOpen: pickThen("Requests", forMe.map((r) => ({ value: r.id, label: `${r.icon || "💬"} ${r.typeName}: ${(r.description || "").slice(0, 60)}` })), go.request) });
  }
  const mine = myOpenRequests();
  if (mine.length) {
    items.push({ key: "my-requests", icon: "🧾", title: `My requests: ${mine.length} not done yet`, detail: "waiting on others", state: "due",
      onOpen: pickThen("My requests", mine.map((r) => ({ value: r.id, label: `${r.icon || "💬"} ${r.typeName}: ${(r.description || "").slice(0, 60)}` })), go.request) });
  }

  // My own yearly refreshers — only when this person is linked to their training record (Admin → People).
  myTrainingName = ctx.viewAs ? null : data.myself?.trainingName || null;
  if (myTrainingName) {
    watchTraining();
    const t = extra.training;
    if (t && !t.missing && t.myName === myTrainingName) {
      const overdue = t.mine.overdue, soon = t.mine.soon;
      items.push(overdue.length
        ? { key: "training", icon: "🎓", title: `My training overdue: ${overdue.map((x) => x.what).join(", ")}`, detail: "ask Training & Safety to schedule it", state: "late", onOpen: () => {} }
        : soon.length
          ? { key: "training", icon: "🎓", title: `My training: ${soon.map((x) => x.what).join(", ")}`, detail: `due by ${soon[0].due}`, state: "due", onOpen: () => {} }
          : { key: "training", icon: "🎓", title: "My training", detail: "all current", state: "done", onOpen: () => {} });
    }
  }
  return items.map((it, i) => ({ ...it, i })).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.i - b.i);
}

// ---- the whole Home -----------------------------------------------------------------------------------------

// ctx = { emp, roles, admin, viewAs, setViewAs, go: { checklist, checklists, request, issues, training, people, map, need, report,
//         announcement, announcements, handoff, shop, station, lineCheck }, onRedraw }
// Returns the pieces; app.js lays them out (one column on phones, two on tablets and desktops).
export function dashboard(ctx) {
  redraw = ctx.onRedraw;
  const roles = ctx.viewAs ? [ctx.viewAs] : ctx.roles;
  const machines = usesMachines(roles);
  const lines = (data.lines || []).filter((l) => l.active !== false);
  const down = data.plantStatus?.down || {};

  // Line status, right under the name: L1 / L2 / L3 — green running, red down.
  const unknown = data.plantStatus?.unknown || 0;
  const short = (name) => String(name).replace(/^Line\s*/i, "L");
  const status = lines.length
    ? el("div", { class: "line-status", role: "list", "aria-label": "Line status" },
        lines.map((l) => {
          const d = down[l.id];
          return el("span", { class: d ? "line-pill down" : "line-pill up", role: "listitem", title: l.name },
            el("strong", {}, short(l.name)), d ? ` ⛔ Down${d.since ? ` ${howLong(d.since)}` : ""}${d.test ? " (test)" : ""}` : " ✓ Running");
        }),
        unknown ? el("span", { class: "line-pill down", role: "listitem" }, `⛔ ${plural(unknown, "line-down request")} with no line set`) : null)
    : null;

  const items = needsItems(ctx, roles);
  const needs = el("section", { class: "needs", "aria-label": "Needs you" },
    el("h2", { class: "home-h2" }, "Needs you"),
    items.length ? el("div", { class: "need-list" }, items.map(needRow)) : el("p", { class: "need-empty" }, "✓ Nothing needs you right now."));

  const quick = el("div", { class: machines ? "quick-row" : "quick-row two" },
    el("button", { class: "btn big secondary", type: "button", onclick: ctx.go.map }, "🗺 Shop Map"),
    el("button", { class: "btn big", type: "button", onclick: ctx.go.need }, "🙋 Need something?"),
    machines ? el("button", { class: "btn big danger", type: "button", onclick: ctx.go.report }, "🚨 Maintenance Request") : null);

  // Admin: View as any role (lists still show your own account's data).
  const viewAs = ctx.admin
    ? el("div", { class: "view-as" },
        picker({
          title: "View as", value: ctx.viewAs || "", placeholder: "👁 View as…",
          options: [{ value: "", label: "👁 My own screen" }, ...ROLE_CARDS.map(([id, name]) => ({ value: id, label: `👁 View as ${name}` }))],
          onChange: (v) => ctx.setViewAs(v || null),
        }))
    : null;

  const ids = cardsFor(roles);
  const cards = ids.length
    ? el("section", { class: "glance", "aria-label": "At a glance" }, el("h2", { class: "home-h2" }, "At a glance"), el("div", { class: "dash-cards" }, ids.map((id) => (id === "silos" ? siloCard(ctx.go.silos) : card(cardData(id, ctx), id)))))
    : null;

  return { status, viewAs, needs, quick, cards };
}

// Lines down for the Open issues button — from the same summary as the plant status bar.
export function linesDownCount() {
  return Object.keys(data.plantStatus?.down || {}).length;
}
