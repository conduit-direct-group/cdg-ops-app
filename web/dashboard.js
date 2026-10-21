// Home = the role dashboard (plan Decision 49). Same layout for every role:
//   1. "Needs you" strip (hidden when empty)   2. Quick buttons   3. Plant status bar   4. Role cards
// People with several roles get one screen with the cards merged (no duplicates). Admins can "View as" any role.
//
// Only cards whose data exists are here; cards for modules not built yet (schedule, handoffs, notices, PMs,
// QC, trucks, write-ups…) are added when those modules are built — never as placeholders.

import { el, picker, statusFold } from "./ui.js";
import { data, lineName } from "./data.js";
import { overdueUnits, unitLabel } from "./checklists.js";
import { requestRow, myOpenRequests } from "./requests.js";
import { safetyBanner, needsYouFold } from "./announcements.js";
import { handoffFolds } from "./handoff.js";
import { shopFolds } from "./shoptasks.js";
import { stationFold } from "./stations.js";
import { lineCheckFolds } from "./linecheck.js";
import { db, TEST_MODE, callAdminListEmployees, callAnnouncementSummary } from "./firebase.js";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// Role order on a combined screen, and each role's cards (ids are shared, so duplicates merge).
export const ROLE_CARDS = [
  ["admin", "Admin", ["plant-today", "system-alerts", "waiting-login"]],
  ["plant-manager", "Plant Manager", ["safety", "pm-maintenance", "pm-people", "ack-gaps"]],
  ["supervisor", "Supervisor", ["safety", "crew-gaps"]],
  ["lead", "Line Lead", ["line-checklists"]],
  ["operator", "Operator", ["line-checklists"]],
  ["maintenance", "Maintenance", ["lines-down", "maint-requests", "routed"]],
  ["quality", "Quality", []],
  ["shipping", "Logistics & Distribution", ["routed"]],
  ["sales", "Sales", []],
  ["office", "Office", ["routed", "ack-gaps"]],
  ["training-safety", "Training & Safety", ["trainees", "expiring", "safety"]],
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
    case "line-checklists": {
      if (!data.checklistUnits || !data.lines) return null;
      const home = data.myself?.homeLineId || null;
      const late = overdueUnits().filter((u) => !home || u.lineId === home || u.lineId === null);
      return { icon: "📋", title: home ? `Checklists due · ${lineName(home)}` : "Checklists due · all lines", num: late.length,
        line: late.length ? late.slice(0, 2).map(unitLabel).join(" · ") + (late.length > 2 ? ` +${late.length - 2}` : "") : "All clear",
        alert: late.length > 0, onOpen: late.length ? () => go.checklist(late[0].id) : null };
    }
    case "safety": {
      if (!data.urgentRequests) return null;
      const open = data.urgentRequests.filter((r) => r.status !== "done");
      const top = open[0];
      return { icon: "⚠", title: "Open safety concerns", num: open.length,
        line: top ? `${top.description?.slice(0, 60) || top.typeName}${top.lineName ? ` · ${top.lineName}` : ""}` : "All clear",
        alert: open.length > 0, onOpen: top ? () => go.request(top.id) : null };
    }
    case "lines-down": {
      if (!data.plantStatus) return null;
      const longest = down.reduce((a, [, v]) => (v.since && (!a || v.since < a) ? v.since : a), 0);
      return { icon: "⛔", title: "Lines down now", num: down.length,
        line: down.length ? down.slice(0, 2).map(([l, v]) => `${lineName(l)}${v.since ? ` ${howLong(v.since)}` : ""}${v.machineIds.length ? ` (${v.machineIds.join(", ")})` : ""}`).join(" · ") : "All clear",
        alert: down.length > 0, onOpen: down.length ? go.issues : null, longest };
    }
    case "maint-requests": {
      if (!data.openIssues) return null;
      const ld = openIssues.filter((i) => i.lineDown).length, unsafe = openIssues.filter((i) => i.unsafe && !i.lineDown).length;
      const high = openIssues.filter((i) => !i.lineDown && !i.unsafe && ["urgent", "high"].includes(i.severity)).length;
      const rest = openIssues.length - ld - unsafe - high;
      const bits = [ld && `${ld} line down`, unsafe && `${unsafe} unsafe`, high && `${high} high`, rest && `${rest} normal`].filter(Boolean);
      return { icon: "🚨", title: "Open Maintenance Requests", num: openIssues.length, line: bits.length ? bits.join(" · ") : "All clear",
        alert: ld + unsafe + high > 0, onOpen: go.issues };
    }
    case "routed": {
      if (!data.requestsForMe) return null;
      const open = data.requestsForMe.filter((r) => r.status !== "done");
      const urgent = open.filter((r) => r.urgent).length;
      const oldest = open.reduce((a, r) => Math.min(a, toMs(r.createdAt) || a), Date.now());
      return { icon: "📥", title: ctx.admin && !ctx.viewAs ? "Open requests (everyone's)" : "Requests for you", num: open.length,
        line: open.length ? [urgent && `${urgent} urgent`, `oldest ${howLong(oldest)}`].filter(Boolean).join(" · ") : "All clear",
        alert: open.length > 0, onOpen: open.length ? () => go.request(open[0].id) : null };
    }
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
    case "pm-maintenance": {
      if (!data.plantStatus || !data.openIssues) return null;
      const longest = down.reduce((a, [, v]) => (v.since && (!a || v.since < a) ? v.since : a), 0);
      const critical = openIssues.filter((i) => i.lineDown || i.unsafe || i.severity === "urgent").length;
      return { icon: "🔧", title: "Maintenance", num: down.length,
        line: down.length || critical ? [down.length && `${plural(down.length, "line")} down${longest ? ` (longest ${howLong(longest)})` : ""}`, critical && `${critical} critical`, `${openIssues.length} open`].filter(Boolean).join(" · ") : "All clear",
        alert: down.length > 0 || critical > 0, onOpen: go.issues };
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
    case "plant-today": {
      if (!data.plantStatus || !data.lines) return null;
      const lines = data.lines.filter((l) => l.active !== false);
      return { icon: "🏭", title: "Plant today", num: down.length,
        line: `${down.length} of ${lines.length} lines down · ${openIssues.length} open maintenance requests`, alert: down.length > 0, onOpen: openIssues.length ? go.issues : null };
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

// ---- the whole dashboard ------------------------------------------------------------------------------------

// ctx = { emp, roles, admin, viewAs, setViewAs, go: { checklist, request, issues, training, people, map, need, report, announcement, announcements, handoff, shop, station, lineCheck }, onRedraw }
export function dashboard(ctx) {
  redraw = ctx.onRedraw;
  const roles = ctx.viewAs ? [ctx.viewAs] : ctx.roles;
  const machines = usesMachines(roles);
  const ids = cardsFor(roles);
  const lines = (data.lines || []).filter((l) => l.active !== false);
  const down = data.plantStatus?.down || {};
  const everyone = ctx.admin && !ctx.viewAs;

  // 1. Needs you: one fold-away line per list — red while something isn't done, green when it's all done.
  // Announcements first (orange while waiting, red once overdue); unsigned Safety ones also sit at the very top.
  const tabs = [];
  const ann = needsYouFold(ctx.emp, ctx.go.announcement);
  if (ann) tabs.push(ann);
  tabs.push(...handoffFolds({ emp: ctx.emp, roles }, ctx.go.handoff)); // a handoff to sign received; your unsent one
  tabs.push(...shopFolds({ emp: ctx.emp }, roles, ctx.go.shop)); // Keep the Shop Clean: your tasks; the shift list for leads
  const stations = stationFold(roles, ctx.go.station); // Reel Building / Reclamation not signed off this shift (leads)
  if (stations) tabs.push(stations);
  tabs.push(...lineCheckFolds(roles, ctx.go.lineCheck)); // line checks due/overdue; logs to review (supervisors)
  if (machines && data.checklistUnits && data.lines) {
    const late = overdueUnits();
    tabs.push(statusFold("home-checklists", !late.length,
      late.length ? `⚠ Machine checklists · ${late.length} overdue` : "✓ Machine checklists · all done",
      late.length
        ? el("div", { class: "alert-pills" }, late.map((u) => el("button", { class: "alert-pill", type: "button", onclick: () => ctx.go.checklist(u.id) }, unitLabel(u))))
        : el("p", { class: "card-note" }, "Every machine checklist is signed off and up to date.")));
  }
  const forMe = data.requestsForMe || [];
  const forMeOpen = forMe.filter((r) => r.status !== "done");
  if (forMe.length) {
    const urgent = forMeOpen.filter((r) => r.urgent).length;
    const name = everyone ? "Open requests" : "Requests for you";
    tabs.push(statusFold("home-for-me", !forMeOpen.length,
      forMeOpen.length ? `⚠ ${name} · ${forMeOpen.length} open${urgent ? ` (${urgent} urgent)` : ""}` : `✓ ${name} · all done`,
      forMeOpen.length
        ? el("div", { class: "person-list" }, forMeOpen.map((r) => requestRow(r, () => ctx.go.request(r.id))))
        : el("p", { class: "card-note" }, "Nothing waiting on you.")));
  }
  const mine = myOpenRequests();
  if (mine.length) {
    tabs.push(statusFold("home-mine", false, `⚠ My requests · ${mine.length} not done yet`,
      el("div", { class: "person-list" }, mine.map((r) => requestRow(r, () => ctx.go.request(r.id))))));
  }
  // My own training — only when this person is linked to their training record (Admin → People).
  myTrainingName = ctx.viewAs ? null : data.myself?.trainingName || null;
  if (myTrainingName) {
    watchTraining();
    const t = extra.training;
    if (t && !t.missing && t.myName === myTrainingName) {
      const due = [...t.mine.overdue, ...t.mine.soon];
      tabs.push(statusFold("home-training", !due.length,
        t.mine.overdue.length ? `⚠ My training · ${t.mine.overdue.length} overdue`
          : t.mine.soon.length ? `⚠ My training · ${t.mine.soon.length} due within 30 days` : "✓ My training · all current",
        due.length
          ? el("ul", { class: "count-list" }, due.map((x) => el("li", {}, el("span", {}, x.what), el("strong", {}, `due ${x.due}`))))
          : el("p", { class: "card-note" }, "Your yearly refreshers are current."),
        due.length ? el("p", { class: "card-note" }, "Ask the Training & Safety team to schedule it.") : null));
    }
  }
  const anyTodo = tabs.some((t) => t.classList.contains("fold-todo") || t.classList.contains("fold-due"));
  const needs = tabs.length
    ? el("section", { class: "needs-you", "aria-label": "Needs you" }, anyTodo ? el("strong", { class: "needs-title" }, "Needs you") : null, tabs)
    : null;

  // 2. Quick buttons (Maintenance Request only for people who work with the machines).
  const quick = el("div", { class: machines ? "quick-row" : "quick-row two" },
    el("button", { class: "btn big secondary", type: "button", onclick: ctx.go.map }, "🗺 Shop Map"),
    el("button", { class: "btn big", type: "button", onclick: ctx.go.need }, "🙋 Need something?"),
    machines ? el("button", { class: "btn big danger", type: "button", onclick: ctx.go.report }, "🚨 Maintenance Request") : null);

  // 3. Plant status: green ✓ Running, red ⛔ Down — the same source as the Open issues button (meta/plantStatus).
  const unknown = data.plantStatus?.unknown || 0;
  const bar = lines.length
    ? el("section", { class: "plant-bar", "aria-label": "Plant status" },
        lines.map((l) => {
          const d = down[l.id];
          return el("span", { class: d ? "line-chip down" : "line-chip up" },
            el("strong", {}, l.name), d ? ` ⛔ Down${d.since ? ` ${howLong(d.since)}` : ""}${d.test ? " (TEST)" : ""}` : " ✓ Running");
        }),
        unknown ? el("span", { class: "line-chip down" }, `⛔ ${plural(unknown, "line-down request")} with no line set`) : null)
    : null;

  // Admin: View as any role (cards and lists still show your own account's data).
  const viewAs = ctx.admin
    ? el("div", { class: "view-as" },
        picker({
          title: "View as", value: ctx.viewAs || "", placeholder: "👁 View as…",
          options: [{ value: "", label: "👁 My own screen" }, ...ROLE_CARDS.map(([id, name]) => ({ value: id, label: `👁 View as ${name}` }))],
          onChange: (v) => ctx.setViewAs(v || null),
        }),
        ctx.viewAs ? el("p", { class: "message" }, `Viewing as ${ROLE_CARDS.find(([id]) => id === ctx.viewAs)?.[1]}. Cards and lists show your own account's data.`) : null)
    : null;

  // 4. Role cards.
  const cards = ids.length
    ? el("section", { class: "dash-cards", "aria-label": "Your cards" }, ids.map((id) => card(cardData(id, ctx), id)))
    : null;

  return [safetyBanner(ctx.emp, ctx.go.announcement), viewAs, needs, quick, bar, cards];
}

// Lines down for the Open issues button — from the same summary as the plant status bar.
export function linesDownCount() {
  return Object.keys(data.plantStatus?.down || {}).length;
}
