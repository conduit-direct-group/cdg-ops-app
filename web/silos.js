// Low silo alert (Chris, 10-21-2026). Silo levels come from the Shift Handoff and from "Update silo levels"
// (Line Operator / material system, mid-shift). Admin → Silo alerts sets each silo's low line; no alerts until set.
// Logistics, Supervisors, and the Production Manager get a push and a red Home item while a silo is below its line.
// Rules match functions/silos.js.

import { el, friendlyError, spinner, banner, toast } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { callUpdateSiloLevels, callAdminSaveSiloSettings } from "./firebase.js";

export const SILOS = [
  { id: "regrind-silo", name: "Regrind silo", alertByDefault: false },
  { id: "silo-1", name: "Silo 1", alertByDefault: true },
  { id: "silo-2", name: "Silo 2", alertByDefault: true },
  { id: "silo-3", name: "Silo 3", alertByDefault: true },
  { id: "silo-4", name: "Silo 4", alertByDefault: true },
];
export const ALERT_ROLES = ["shipping", "supervisor", "plant-manager"];
export const UPDATE_ROLES = ["operator", "lead", "supervisor", "plant-manager", "admin"];

const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : 0);
const when = (t) => {
  const ms = toMs(t);
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const setting = (id) => data.siloSettings?.silos?.[id] || null;
const levelOf = (id) => { const all = (data.siloLevels || []).filter((l) => l.id === id); return all.find((l) => l.test) || all[0] || null; };

// Silos below their low line right now (alerts on, low line set).
export function lowSilos() {
  return SILOS.filter((s) => {
    const st = setting(s.id);
    const l = levelOf(s.id);
    return st && st.alert !== false && typeof st.low === "number" && l && l.level < st.low;
  }).map((s) => ({ ...s, level: levelOf(s.id).level, low: setting(s.id).low }));
}

// Home → Needs you (Logistics, Supervisors, Production Manager): one red item while any silo is low.
export function siloItems(roles, onOpen) {
  if (!roles.some((r) => ALERT_ROLES.includes(r)) || !data.siloLevels || !data.siloSettings) return [];
  const low = lowSilos();
  if (!low.length) return [];
  return [{ key: "silos", icon: "🛢", title: `Low silo: ${low.map((s) => `${s.name} at ${s.level}%`).join(", ")}`, detail: `low line ${[...new Set(low.map((s) => `${s.low}%`))].join(" / ")} · tap for all levels`, state: "late", onOpen }];
}

// Home → At a glance: each silo's last level, when, and by whom.
export function siloCard(onOpen) {
  const rows = SILOS.map((s) => {
    const l = levelOf(s.id);
    const st = setting(s.id);
    const low = l && st && st.alert !== false && typeof st.low === "number" && l.level < st.low;
    return el("div", { class: low ? "silo-row low" : "silo-row" },
      el("span", { class: "silo-name" }, s.name),
      el("strong", { class: "silo-level" }, l ? `${low ? "⚠ " : ""}${l.level}%` : "—"),
      el("span", { class: "silo-when" }, l ? `${when(l.at)} · ${l.byName || ""}${l.test ? " (test)" : ""}` : "not entered yet"));
  });
  return el(onOpen ? "button" : "div", { class: "dash-card silo-card", type: onOpen ? "button" : null, onclick: onOpen || null, "data-card": "silos" },
    el("span", { class: "dash-title" }, "🛢 Silo levels"),
    data.siloLevels ? el("div", { class: "silo-rows" }, rows) : el("span", { class: "dash-line" }, "Loading…"));
}

// The silo screen: all levels, and (for operators and up) "Update silo levels".
export function openSilos(container, { me, onExit, backLabel = "Home" }) {
  const canUpdate = me.roles.some((r) => UPDATE_ROLES.includes(r));
  const ui = { values: {}, busy: false, message: "", messageKind: "", retry: null };

  async function save() {
    const levels = Object.fromEntries(Object.entries(ui.values).filter(([, v]) => v !== ""));
    if (!Object.keys(levels).length) { Object.assign(ui, { message: "Enter at least one level.", messageKind: "error", retry: null }); return render(); }
    if (Object.values(levels).some((v) => !(Number(v) >= 0 && Number(v) <= 100))) { Object.assign(ui, { message: "Levels are 0–100%.", messageKind: "error", retry: null }); return render(); }
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: save }); return render(); }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const out = (await callUpdateSiloLevels({ levels })).data;
      Object.assign(ui, { busy: false, values: {} });
      toast(out.alerts?.length ? `Saved — low silo alert sent for ${out.alerts.map((id) => SILOS.find((s) => s.id === id)?.name).join(", ")}` : "Silo levels saved");
      render();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: save });
      render();
    }
  }

  function render() {
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "🛢 Silo levels"),
      el("p", { class: "hint" }, "From the Shift Handoff, or updated here mid-shift."),
      banner(ui),
      !data.siloLevels ? spinner() : siloCard(null),
      canUpdate
        ? el("form", { class: "card silo-form", onsubmit: (e) => { e.preventDefault(); save(); } },
            el("strong", {}, "Update silo levels"),
            el("p", { class: "card-note" }, "Read the gauge and enter what it shows now. Leave a silo blank to keep its last level."),
            el("div", { class: "spec-fields" }, SILOS.map((s) => el("label", { class: "spec-field" },
              el("span", { class: "field-label" }, s.name),
              el("input", { class: "field", type: "number", inputmode: "decimal", min: "0", max: "100", step: "any", placeholder: levelOf(s.id) ? `last ${levelOf(s.id).level}%` : "%", value: ui.values[s.id] ?? "", oninput: (e) => { ui.values[s.id] = e.target.value; } })))),
            el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : "Save levels"))
        : null,
    ].filter(Boolean));
  }

  render();
  return onDataChange(() => { if (!Object.values(ui.values).some((v) => v !== "")) render(); });
}

// Admin → Silo alerts: each silo's low line (blank = no alerts) and whether it alerts.
export function openSiloAdmin(container, { onExit }) {
  const ui = { draft: null, busy: false, message: "", messageKind: "", retry: null };
  const draft = () => ui.draft || (ui.draft = Object.fromEntries(SILOS.map((s) => {
    const st = setting(s.id);
    return [s.id, { low: st?.low ?? "", alert: st ? st.alert !== false : s.alertByDefault }];
  })));

  async function save() {
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: save }); return render(); }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      await callAdminSaveSiloSettings({ silos: draft() });
      Object.assign(ui, { busy: false, draft: null });
      toast("Silo alerts saved");
      render();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: save });
      render();
    }
  }

  function render() {
    if (!data.siloSettings) return container.replaceChildren(el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"), spinner());
    const d = draft();
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
      el("h1", {}, "🛢 Silo alerts"),
      el("p", { class: "hint" }, "Logistics, Supervisors, and the Production Manager get one alert when a silo drops below its low line — again only after it's refilled above the line and drops again. Leave the low line blank for no alerts."),
      banner(ui),
      el("form", { class: "card", onsubmit: (e) => { e.preventDefault(); save(); } },
        SILOS.map((s) => el("div", { class: "silo-set" },
          el("strong", {}, s.name),
          el("label", { class: "spec-field" }, el("span", { class: "field-label" }, "Alert below (%)"),
            el("input", { class: "field", type: "number", inputmode: "numeric", min: "1", max: "99", placeholder: "not set", value: d[s.id].low, oninput: (e) => { d[s.id].low = e.target.value; } })),
          el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: d[s.id].alert, onchange: (e) => { d[s.id].alert = e.target.checked; } }), el("span", {}, "Send alerts for this silo")))),
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : "Save")),
    ].filter(Boolean));
  }

  render();
  return onDataChange(() => { if (!ui.draft) render(); });
}
