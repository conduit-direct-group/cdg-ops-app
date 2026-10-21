// Who to Call (Chris, 10-21-2026) — the posted call sheet, better than paper: tap-to-call (main number + extension),
// a big red Call 911, Maintenance as a quick decision, on-call contacts by shift, and a line-tablet reminder when a
// line has been down an hour and nobody tapped Call Maintenance. The numbers live only in the database
// (meta/callSheet, Admin → Who to Call). Rules match functions/callsheet.js.

import { el, friendlyError, spinner, emptyState, banner, toast } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import { callAdminSaveCallSheet, callLogCallTap } from "./firebase.js";

const KINDS = [["safety", "Safety"], ["maintenance", "Maintenance"], ["production", "Production"], ["other", "Other"]];
const REMIND_MS = 60 * 60000;
const ICON = { safety: "⚠", maintenance: "🔧", production: "🏭", other: "📞" };
const digits = (v) => String(v || "").replace(/\D/g, "");

export function telLink(number, ext = "") {
  let d = digits(number);
  if (d.length === 10) d = `1${d}`;
  return `tel:+${d}${digits(ext) ? `,${digits(ext)}` : ""}`;
}

export function linesToRemind(down, taps, nowMs = Date.now()) {
  return Object.entries(down || {})
    .filter(([, d]) => d?.since && nowMs - d.since >= REMIND_MS)
    .filter(([lineId, d]) => !(taps || []).some((t) => t.kind === "maintenance" && t.atMs >= d.since && (!t.lineId || t.lineId === lineId)))
    .map(([lineId, d]) => ({ lineId, since: d.since }));
}

const sheet = () => data.callSheet || null;
const entryOf = (kind) => (sheet()?.entries || []).find((e) => e.kind === kind) || null;

// A tap-to-call button. The tap is noted (the phone can't tell us whether the call went through).
export function callButton(entry, { lineId = null, big = false, label = null } = {}) {
  const s = sheet();
  if (!s?.mainNumber || !entry) return null;
  return el("a", {
    class: big ? "btn big call-link" : "btn call-link", href: telLink(s.mainNumber, entry.ext),
    onclick: () => { callLogCallTap({ ext: entry.ext, kind: entry.kind, lineId }).catch(() => {}); },
  }, label || `📞 Call ${entry.title} · ext ${entry.ext}`);
}

// Line tablet, on Home: "Line down 1 hour — call Maintenance, ext 5" (only this tablet's line when it has one).
export function lineDownReminder(myLineId = null) {
  const maint = entryOf("maintenance");
  if (!maint || !data.plantStatus || !data.callTaps) return null;
  const list = linesToRemind(data.plantStatus.down, data.callTaps).filter((x) => !myLineId || x.lineId === myLineId);
  if (!list.length) return null;
  return el("div", { class: "call-reminds" }, list.map((x) => {
    const mins = Math.floor((Date.now() - x.since) / 60000);
    return el("section", { class: "call-remind", role: "alert" },
      el("strong", {}, `⚠ ${lineName(x.lineId)} down ${mins >= 120 ? `${Math.floor(mins / 60)} hours` : "1 hour"} — call Maintenance, ext ${maint.ext}`),
      el("p", {}, "Still down after an hour of trying the Fix Library? Call now."),
      callButton(maint, { lineId: x.lineId, big: true, label: `📞 Call Maintenance · ext ${maint.ext}` }));
  }));
}

export function openWhoToCall(container, { onExit, backLabel = "Home", onFixes = null, onReport = null }) {
  const ui = { maint: null }; // null | "no" | "yes"

  function maintenanceCard(e) {
    return el("section", { class: "card call-card" },
      el("h2", {}, `${ICON.maintenance} Ext ${e.ext} · ${e.title}`),
      e.lines.length ? el("ul", { class: "call-lines" }, e.lines.map((l) => el("li", {}, l))) : null,
      el("p", { class: "call-q" }, "Do you know what's wrong?"),
      el("div", { class: "choices two" },
        el("button", { class: ui.maint === "no" ? "choice on" : "choice", type: "button", "aria-pressed": String(ui.maint === "no"), onclick: () => { ui.maint = "no"; render(); } }, "No — not sure why it's down"),
        el("button", { class: ui.maint === "yes" ? "choice on" : "choice", type: "button", "aria-pressed": String(ui.maint === "yes"), onclick: () => { ui.maint = "yes"; render(); } }, "Yes, but we can't run")),
      ui.maint === "no" ? el("div", { class: "call-step" },
        el("p", {}, "Try the Fix Library first — work it for up to 1 hour."),
        onFixes ? el("button", { class: "btn", type: "button", onclick: onFixes }, "🔧 Open the Fix Library") : null,
        el("p", { class: "card-note" }, `Still down after 1 hour? Call Maintenance, ext ${e.ext}.`),
        callButton(e)) : null,
      ui.maint === "yes" ? el("div", { class: "call-step" },
        el("p", {}, `1. Submit a Maintenance Request so it's tracked. 2. Then call Maintenance, ext ${e.ext}.`),
        onReport ? el("button", { class: "btn danger", type: "button", onclick: onReport }, "🚨 1 · Maintenance Request") : null,
        callButton(e, { label: `📞 2 · Call Maintenance · ext ${e.ext}` })) : null);
  }

  function entryCard(e) {
    if (e.kind === "maintenance") return maintenanceCard(e);
    return el("section", { class: e.kind === "safety" ? "card call-card safety" : "card call-card" },
      el("h2", {}, `${ICON[e.kind] || "📞"} Ext ${e.ext} · ${e.title}`),
      e.lines.length ? el("ul", { class: "call-lines" }, e.lines.map((l) => el("li", {}, l))) : null,
      callButton(e));
  }

  function render() {
    const s = sheet();
    const byShift = {};
    for (const c of s?.onCall || []) (byShift[c.shift || "Any shift"] ||= []).push(c);
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "📞 Who to Call"),
      el("a", { class: "btn big danger call-911", href: "tel:911" }, "🚑 Emergency? Call 911"),
      data.callSheet === null ? spinner()
        : !s?.mainNumber ? emptyState("The call sheet isn't set up yet", "An admin adds it in Admin → Who to Call.")
        : [
            el("p", { class: "hint" }, `Main number ${s.mainNumber} — the buttons dial it and the extension for you.`),
            el("div", { class: "call-grid" }, (s.entries || []).map(entryCard)),
            (s.onCall || []).length ? el("section", { class: "card" },
              el("h2", {}, "On call"),
              Object.entries(byShift).map(([shift, list]) => [el("h3", {}, shift), el("div", { class: "person-list" }, list.map((c) =>
                el("a", { class: "person-row call-person", href: telLink(c.number), onclick: () => { callLogCallTap({ ext: "", kind: "other" }).catch(() => {}); } },
                  el("span", { class: "person-name" }, `📞 ${c.name}`), el("span", { class: "person-meta" }, [c.role, c.number].filter(Boolean).join(" · ")))))])) : null,
          ],
    ].flat(3).filter(Boolean));
  }

  render();
  return onDataChange(() => { if (!ui.maint) render(); });
}

// Admin → Who to Call: main number, extensions (with what to call about), and on-call contacts who agreed.
export function openCallAdmin(container, { onExit }) {
  const ui = { draft: null, busy: false, message: "", messageKind: "", retry: null };
  const draft = () => ui.draft || (ui.draft = (() => {
    const s = sheet() || {};
    return { mainNumber: s.mainNumber || "", entries: (s.entries || []).map((e) => ({ ...e, text: (e.lines || []).join("\n") })), onCall: (s.onCall || []).map((c) => ({ ...c })) };
  })());

  async function save() {
    const d = draft();
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: save }); return render(); }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      await callAdminSaveCallSheet({ mainNumber: d.mainNumber, entries: d.entries.map((e) => ({ id: e.id, ext: e.ext, title: e.title, kind: e.kind, lines: e.text.split("\n") })), onCall: d.onCall });
      Object.assign(ui, { busy: false, draft: null });
      toast("Call sheet saved");
      render();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: save });
      render();
    }
  }

  function render() {
    if (data.callSheet === null) return container.replaceChildren(el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"), spinner());
    const d = draft();
    const field = (label, input, wide = false) => el("label", { class: wide ? "spec-field wide" : "spec-field" }, el("span", { class: "field-label" }, label), input);
    const set = (o, k) => (e) => { o[k] = e.target.value; };
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
      el("h1", {}, "📞 Who to Call"),
      el("p", { class: "hint" }, "What everyone sees in Who to Call. Numbers are kept in the app's database only."),
      banner(ui),
      el("form", { class: "card", onsubmit: (e) => { e.preventDefault(); save(); } },
        field("Main number", el("input", { class: "field", type: "tel", value: d.mainNumber, placeholder: "e.g. 319-555-0100", oninput: set(d, "mainNumber") })),
        el("h2", {}, "Extensions"),
        d.entries.map((e, i) => el("div", { class: "spec-edit" },
          el("div", { class: "spec-fields" },
            field("Ext", el("input", { class: "field", inputmode: "numeric", value: e.ext, maxlength: "6", oninput: set(e, "ext") })),
            field("Name", el("input", { class: "field", value: e.title, maxlength: "40", oninput: set(e, "title") })),
            field("Type", el("select", { class: "field", onchange: set(e, "kind") }, KINDS.map(([v, n]) => el("option", { value: v, selected: e.kind === v }, n)))),
            field("When to call (one line each)", el("textarea", { class: "field", rows: "3", oninput: set(e, "text") }, e.text), true)),
          el("p", { class: "card-note" }, e.kind === "maintenance" ? "Maintenance shows the “Do you know what's wrong?” choice (Fix Library / Maintenance Request) and the line-down reminder." : ""),
          el("button", { class: "link-btn danger-link", type: "button", onclick: () => { d.entries.splice(i, 1); render(); } }, "✕ Remove this extension"))),
        el("button", { class: "btn secondary", type: "button", onclick: () => { d.entries.push({ ext: "", title: "", kind: "other", text: "" }); render(); } }, "+ Add extension"),
        el("h2", {}, "On-call contacts (optional)"),
        el("p", { class: "card-note" }, "Only add people who agreed to have their number shown to everyone in the app."),
        d.onCall.map((c, i) => el("div", { class: "spec-edit" },
          el("div", { class: "spec-fields" },
            field("Name", el("input", { class: "field", value: c.name || "", maxlength: "60", oninput: set(c, "name") })),
            field("Role", el("input", { class: "field", value: c.role || "", maxlength: "40", oninput: set(c, "role") })),
            field("Shift", el("input", { class: "field", value: c.shift || "", maxlength: "30", placeholder: "e.g. Days", oninput: set(c, "shift") })),
            field("Number", el("input", { class: "field", type: "tel", value: c.number || "", oninput: set(c, "number") }))),
          el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: c.agreed === true, onchange: (e) => { c.agreed = e.target.checked; } }), el("span", {}, "They agreed to have this number shown")),
          el("button", { class: "link-btn danger-link", type: "button", onclick: () => { d.onCall.splice(i, 1); render(); } }, "✕ Remove"))),
        el("button", { class: "btn secondary", type: "button", onclick: () => { d.onCall.push({ name: "", role: "", shift: "", number: "", agreed: false }); render(); } }, "+ Add on-call contact"),
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : "Save")),
    ].flat(3).filter(Boolean));
  }

  render();
  return onDataChange(() => { if (!ui.draft) render(); });
}
