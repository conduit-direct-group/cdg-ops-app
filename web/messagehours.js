// Admin → Message hours (Decision 109). People with no team (day staff, office) receive messages only on these days and
// hours (plant time) and not when marked absent; anything sent outside them isn't delivered, and the sender is warned
// first. Starts Mon–Fri 5 AM–5 PM. Rules: functions/messaging.js (cleanDayHours, inDayHours).

import { el, friendlyError, spinner, banner, toast } from "./ui.js";
import { callAdminMessageHours, callAdminSaveMessageHours } from "./firebase.js";

const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];

export function openMessageHoursAdmin(container, { onExit }) {
  const ui = { data: null, draft: null, loadError: "", busy: false, message: "", messageKind: "", retry: null };

  async function load() {
    if (!navigator.onLine) { ui.loadError = friendlyError({ code: "offline" }); return render(); }
    ui.loadError = "";
    render();
    try {
      ui.data = (await callAdminMessageHours()).data;
      ui.draft = { days: [...ui.data.hours.days], start: ui.data.hours.start, end: ui.data.hours.end };
    } catch (err) { ui.loadError = friendlyError(err); }
    render();
  }

  async function save() {
    const d = ui.draft;
    if (!d.days.length) { Object.assign(ui, { message: "Pick at least one day.", messageKind: "error", retry: null }); return render(); }
    if (!d.start || !d.end || d.end <= d.start) { Object.assign(ui, { message: "The end time must be after the start time.", messageKind: "error", retry: null }); return render(); }
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: save }); return render(); }
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      const { data: r } = await callAdminSaveMessageHours(d);
      toast(`Message hours: ${r.text}`);
      Object.assign(ui, { busy: false, retry: null });
      await load();
    } catch (err) { Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: save }); render(); }
  }

  function render() {
    const d = ui.draft;
    const toggle = (n) => { d.days = d.days.includes(n) ? d.days.filter((x) => x !== n) : [...d.days, n]; render(); };
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
      el("h1", {}, "🕔 Message hours"),
      el("p", { class: "hint" }, "People with no team (day staff, office) get messages only during these hours, and not when they're marked absent. A message sent outside them isn't delivered — the sender is warned first. People on a team follow their shift."),
      banner(ui),
      ui.loadError ? banner({ message: ui.loadError, messageKind: "error", retry: load }) : null,
      !ui.data && !ui.loadError ? spinner("Loading…") : null,
      d ? el("section", { class: "card" },
        el("strong", {}, `Now: ${ui.data.text}${ui.data.isDefault ? " (the starting hours)" : ""}`),
        el("p", { class: "field-label" }, "Days"),
        el("div", { class: "chips" }, DAYS.map(([n, name]) =>
          el("button", { class: d.days.includes(n) ? "chip on" : "chip", type: "button", "aria-pressed": String(d.days.includes(n)), onclick: () => toggle(n) }, name))),
        el("div", { class: "date-row" },
          el("div", {},
            el("label", { class: "field-label", for: "mh-start" }, "From"),
            el("input", { class: "field", id: "mh-start", type: "time", step: "900", value: d.start, onchange: (e) => { d.start = e.target.value; } })),
          el("div", {},
            el("label", { class: "field-label", for: "mh-end" }, "To"),
            el("input", { class: "field", id: "mh-end", type: "time", step: "900", value: d.end, onchange: (e) => { d.end = e.target.value; } }))),
        el("p", { class: "card-note" }, "Plant time (Cedar Rapids)."),
        el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: save }, ui.busy ? "Saving…" : "✔ Save hours")) : null,
    ].filter(Boolean));
  }

  load();
  return () => {};
}
