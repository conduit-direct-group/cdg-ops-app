// Home = the role dashboard (plan Decision 49). Same layout for every role:
//   1. "Needs you" strip (hidden when empty)   2. Quick buttons   3. Plant status bar   4. Role cards
// People with several roles get one screen with the cards merged (no duplicates). Admins can "View as" any role.
//
// Only cards whose data exists are here; cards for modules not built yet (schedule, handoffs, notices, PMs,
// QC, trucks, write-ups…) are added when those modules are built — never as placeholders.

import { el, picker } from "./ui.js";
import { data, lineName } from "./data.js";
import { overdueUnits, unitLabel } from "./checklists.js";
import { db, TEST_MODE, callAdminListEmployees } from "./firebase.js";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// Role order on a combined screen, and each role's cards (ids are shared, so duplicates merge).
export const ROLE_CARDS = [
  ["admin", "Admin", ["plant-today", "system-alerts", "waiting-login"]],
  ["plant-manager", "Plant Manager", ["safety", "pm-maintenance", "pm-people"]],
  ["supervisor", "Supervisor", ["safety"]],
  ["lead", "Line Lead", ["line-checklists"]],
  ["operator", "Operator", ["line-checklists"]],
  ["maintenance", "Maintenance", ["lines-down", "maint-requests", "routed"]],
  ["quality", "Quality", []],
  ["shipping", "Logistics & Distribution", ["routed"]],
  ["sales", "Sales", []],
  ["office", "Office", ["routed"]],
  ["training-safety", "Training & Safety", ["trainees", "expiring", "safety"]],
];

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

const extra = { training: null, odooSync: undefined, waitingLogin: null };
let extraStops = {};
let redraw = () => {};

// Training records (same data the 🎓 Training page uses): refreshers due and trainees in training.
function watchTraining() {
  if (extraStops.training) return;
  const parts = {};
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
      }
      if (r.status === "In training") inTraining++;
      const orient = p.orient || (d.safety || {})[r.name];
      if (orient && orient.verified !== "Yes") toVerify++;
    }
    extra.training = { overdue, soon, inTraining, toVerify };
    redraw();
  };
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
export function stopDashboard() {
  Object.values(extraStops).forEach((f) => f());
  extraStops = {};
  extra.training = null; extra.odooSync = undefined; extra.waitingLogin = null; loginCheckedAt = 0;
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
        line: down.length ? down.slice(0, 2).map(([l, v]) => `${lineName(l)}${v.since ? ` ${howLong(v.since)}` : ""} (${v.machineIds.join(", ")})`).join(" · ") : "All clear",
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
      return { icon: "📥", title: ctx.admin ? "Open requests (everyone's)" : "Requests for you", num: open.length,
        line: open.length ? [urgent && `${urgent} urgent`, `oldest ${howLong(oldest)}`].filter(Boolean).join(" · ") : "All clear",
        alert: open.length > 0, onOpen: open.length ? go.inbox : null };
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

// ctx = { roles, admin, viewAs, setViewAs, go: { checklist, request, issues, inbox, training, people, map, need, report }, onRedraw }
export function dashboard(ctx) {
  redraw = ctx.onRedraw;
  const roles = ctx.viewAs ? [ctx.viewAs] : ctx.roles;
  const ids = cardsFor(roles);
  const late = data.checklistUnits && data.lines ? overdueUnits() : [];
  const lines = (data.lines || []).filter((l) => l.active !== false);
  const down = data.plantStatus?.down || {};

  // 1. Needs you: sign-offs due (overdue machine checklists). Notices and personal training due join when built.
  const needs = late.length
    ? el("section", { class: "needs-you", "aria-label": "Needs you" },
        el("strong", { class: "needs-title" }, "Needs you"),
        el("div", { class: "alert-banner", role: "alert" },
          el("strong", {}, `⚠ ${plural(late.length, "machine checklist")} overdue`),
          el("div", { class: "alert-pills" }, late.map((u) => el("button", { class: "alert-pill", type: "button", onclick: () => ctx.go.checklist(u.id) }, unitLabel(u))))))
    : null;

  // 2. Quick buttons.
  const quick = el("div", { class: "quick-row" },
    el("button", { class: "btn big secondary", type: "button", onclick: ctx.go.map }, "🗺 Shop Map"),
    el("button", { class: "btn big", type: "button", onclick: ctx.go.need }, "🙋 Need something?"),
    el("button", { class: "btn big danger", type: "button", onclick: ctx.go.report }, "🚨 Maintenance Request"));

  // 3. Plant status bar: a line is "down" while it has an open Maintenance Request marked line down.
  const bar = lines.length
    ? el("section", { class: "plant-bar", "aria-label": "Plant status" },
        lines.map((l) => {
          const d = down[l.id];
          return el("span", { class: d ? "line-chip down" : "line-chip" },
            el("strong", {}, l.name), d ? ` ⛔ Down${d.since ? ` ${howLong(d.since)}` : ""}${d.test ? " (TEST)" : ""}` : " ✓ Running");
        }))
    : null;

  // Admin: View as any role (numbers are still from your own account).
  const viewAs = ctx.admin
    ? el("div", { class: "view-as" },
        picker({
          title: "View as", value: ctx.viewAs || "", placeholder: "👁 View as…",
          options: [{ value: "", label: "👁 My own screen" }, ...ROLE_CARDS.map(([id, name]) => ({ value: id, label: `👁 View as ${name}` }))],
          onChange: (v) => ctx.setViewAs(v || null),
        }),
        ctx.viewAs ? el("p", { class: "message" }, `Viewing as ${ROLE_CARDS.find(([id]) => id === ctx.viewAs)?.[1]}. Cards show your own account's data.`) : null)
    : null;

  // 4. Role cards.
  const cards = ids.length
    ? el("section", { class: "dash-cards", "aria-label": "Your cards" }, ids.map((id) => card(cardData(id, ctx), id)))
    : null;

  return [viewAs, needs, quick, bar, cards];
}
