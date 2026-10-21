// Admin → Forms: the app's versions of the paper forms, edited with no code change (Decision 60).
// Add, remove, reword, or reorder sections and fields; change types, units, help text. Every save is a new
// revision (number, date, who, what changed). Records already started finish on the revision they started with.
// Who may edit: Admins, and roles that list the form in Admin → Roles. The wording lives only in the database.

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, picker, collapsible } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { db, callSaveFormTemplate } from "./firebase.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

export const FIELD_TYPES = [
  ["number", "Number"], ["percent", "Percent (0–100)"], ["yesno", "Yes / No"], ["text", "Short text"],
  ["longtext", "Notes (long text)"], ["datetime", "Date and time"], ["time", "Time of day"], ["task", "Task (tick when done)"], ["check", "Check (OK / Not OK)"], ["tally", "Tally (one tap each time it's done)"],
];
const KIND_NAMES = { handoff: "Shift handoff", tasklist: "Shift task list", station: "Station checklist", linecheck: "Line check log" };

// Same rule as the server (functions/forms.js).
export function canEditForm(myRoles, formId) {
  if ((myRoles || []).includes("admin")) return true;
  return (data.roles || []).some((r) => r.active !== false && (myRoles || []).includes(r.id) && (r.editForms || []).includes(formId));
}
export const editableForms = (myRoles) => (data.formTemplates || []).filter((t) => canEditForm(myRoles, t.id));

const toMs = (t) => (t?.toMillis ? t.toMillis() : 0);
const fmtWhen = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const copy = (x) => JSON.parse(JSON.stringify(x));

export function openFormsAdmin(container, { me, onExit, backLabel = "Admin" }) {
  const ui = { view: "list", id: null, draft: null, note: "", busy: false, message: "", messageKind: "", retry: null, revs: null };
  let stopRevs = null;
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false }); render(); };
  const show = (view, extra = {}) => { Object.assign(ui, { view, busy: false, message: "", retry: null, ...extra }); render(); window.scrollTo(0, 0); };
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  async function save(payload, again) {
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const { data: r } = await callSaveFormTemplate(payload);
      toast(`Saved as revision ${r.rev} — ${r.changes}`);
      return r;
    } catch (err) {
      say(friendlyError(err), again);
      return null;
    }
  }

  // ---- list --------------------------------------------------------------------------------------------------------
  function renderList() {
    const list = (data.formTemplates || []).filter((t) => canEditForm(me.roles, t.id));
    async function importFile(file) {
      let parsed;
      try { parsed = JSON.parse(await file.text()); } catch { return say("That file isn't a form file (.json)."); }
      const formId = String(parsed.formId || parsed.kind || "");
      const exists = (data.formTemplates || []).some((t) => t.id === formId);
      if (!(await confirmSheet({ title: exists ? `Replace “${parsed.name}” with this file?` : `Add “${parsed.name}”?`, text: exists ? "It's saved as a new revision. Earlier revisions and everything already filled in are kept." : "It becomes revision 1. You can edit it afterwards.", confirmLabel: exists ? "Save new revision" : "Add form" }))) return;
      const r = await save({ ...parsed, formId, create: !exists, note: exists ? "Loaded from a form file" : "First version (from the paper form)" }, () => importFile(file));
      if (r) show("list");
    }
    return [
      back(backLabel, onExit),
      el("h1", {}, "📝 Forms"),
      el("p", { class: "hint" }, "The app's versions of the paper forms. Edit them here — no code change. Every save is a new revision; anything already started keeps the version it started on."),
      banner(ui),
      !data.formTemplates ? spinner() : !list.length ? emptyState("No forms yet", me.admin ? "Load a form file to start (from C:\\CDG\\private\\forms)." : "An admin hasn't given your role any forms to edit.") : null,
      el("div", { class: "person-list" }, list.map((t) =>
        el("button", { class: "person-row", type: "button", onclick: () => openEditor(t) },
          el("span", { class: "person-name" }, t.name),
          el("span", { class: "person-meta" }, `${KIND_NAMES[t.kind] || t.kind} · ${t.sections.reduce((n, s) => n + s.fields.length, 0)} ${t.kind === "tasklist" ? "tasks" : "fields"}`),
          el("span", { class: "person-meta" }, `Revision ${t.rev} · ${fmtWhen(t.revAt)} · ${t.revByName || ""}`)))),
      me.admin
        ? el("label", { class: "btn secondary file-btn" }, ui.busy ? "Working…" : "⇪ Load a form file (.json)",
            el("input", { type: "file", accept: ".json,application/json", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); } }))
        : null,
    ];
  }

  // ---- editor ------------------------------------------------------------------------------------------------------
  function openEditor(t) {
    stopRevs?.();
    ui.revs = null;
    stopRevs = onSnapshot(collection(db, "formTemplates", t.id, "revisions"), (s) => {
      ui.revs = s.docs.map((d) => d.data()).sort((a, b) => b.rev - a.rev);
      if (ui.view === "edit" && !ui.busy) redrawRevs();
    }, () => { ui.revs = []; });
    show("edit", { id: t.id, draft: copy({ name: t.name, kind: t.kind, intro: t.intro || "", sections: t.sections, ...(t.kind === "tasklist" ? { shifts: t.shifts || [], redMinutes: t.redMinutes ?? 60 } : {}), ...(t.kind === "linecheck" ? { everyMinutes: t.everyMinutes ?? 30 } : {}) }), note: "" });
  }

  function move(list, i, d) {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    render();
  }
  const arrows = (list, i, what) => [
    el("button", { class: "icon-btn", type: "button", "aria-label": `Move ${what} up`, disabled: i === 0, onclick: () => move(list, i, -1) }, "↑"),
    el("button", { class: "icon-btn", type: "button", "aria-label": `Move ${what} down`, disabled: i === list.length - 1, onclick: () => move(list, i, 1) }, "↓"),
  ];

  // Answer types each kind of form takes (same as the server).
  function typeOptions(kind, section) {
    if (kind === "linecheck") return section?.scope === "plant" ? ["tally"] : ["number", "check", "text"];
    if (kind === "tasklist") return ["task"];
    if (kind === "station") return ["number", "percent", "yesno", "text", "longtext", "task"];
    return ["number", "percent", "yesno", "text", "longtext", "datetime", "time"];
  }
  const numIn = (label, value, set) => el("label", { class: "shift-time" }, label,
    el("input", { class: "field", type: "text", inputmode: "decimal", value: value ?? "", oninput: (e) => { const t = e.target.value.trim(); set(t === "" ? null : Number(t)); } }));

  // Line Check extras: allowed range (all lines, or a different one per line), which lines it shows on, expected count.
  function lineCheckExtras(s, f) {
    const lines = (data.lines || []).filter((l) => l.active !== false);
    f.lines ||= [];
    f.lineLimits ||= {};
    if (f.type === "tally") {
      return el("div", { class: "limit-box" },
        el("p", { class: "field-label" }, "Expected times per shift (shown as a progress count)"),
        el("div", { class: "shift-row" }, numIn("At least", f.expectMin, (v) => { f.expectMin = v; }), numIn("Up to", f.expectMax, (v) => { f.expectMax = v; })));
    }
    return el("div", { class: "limit-box" },
      f.type === "number" ? [
        el("p", { class: "field-label" }, "Allowed range — outside it turns red, needs a note, and alerts the Line Lead (leave empty for no limit)"),
        el("div", { class: "shift-row" }, numIn("Lowest OK (all lines)", f.min, (v) => { f.min = v; }), numIn("Highest OK (all lines)", f.max, (v) => { f.max = v; })),
        collapsible(`lim-${f.id || f.label}`, "Different range on one line",
          lines.map((l) => el("div", { class: "shift-row" }, el("strong", {}, l.name),
            numIn("Lowest OK", f.lineLimits[l.id]?.min, (v) => { f.lineLimits[l.id] = { ...(f.lineLimits[l.id] || { min: null, max: null }), min: v }; }),
            numIn("Highest OK", f.lineLimits[l.id]?.max, (v) => { f.lineLimits[l.id] = { ...(f.lineLimits[l.id] || { min: null, max: null }), max: v }; })))),
      ] : null,
      el("p", { class: "field-label" }, "Shows on"),
      el("div", { class: "chips" },
        el("button", { class: !f.lines.length ? "chip on" : "chip", type: "button", onclick: () => { f.lines = []; render(); } }, "All lines"),
        lines.map((l) => el("button", { class: f.lines.includes(l.id) ? "chip on" : "chip", type: "button", onclick: () => { f.lines = f.lines.includes(l.id) ? f.lines.filter((x) => x !== l.id) : [...f.lines, l.id]; render(); } }, `Only ${l.name}`))));
  }

  function fieldEditor(s, f, i) {
    const kind = ui.draft.kind;
    const types = typeOptions(kind, s);
    const fixed = types.length === 1; // task lists (tasks) and plant-wide sections (tallies): no type to pick
    if (fixed) f.type = types[0];
    const task = kind === "tasklist";
    const lineUnit = kind === "linecheck" && f.type === "number"
      ? el("div", { class: "form-field-row" }, el("input", { class: "field unit-field", "aria-label": "Unit", maxlength: "12", value: f.unit || "", placeholder: "Unit (PSI, °F…)", oninput: (e) => { f.unit = e.target.value; } }))
      : null;
    return el("div", { class: "form-field-edit" },
      el("div", { class: "row-between" },
        el("span", { class: "field-label" }, `Field ${i + 1}`),
        el("span", { class: "icon-row" }, arrows(s.fields, i, "field"),
          el("button", { class: "icon-btn danger", type: "button", "aria-label": "Remove field", onclick: async () => {
            if (await confirmSheet({ title: `Remove “${f.label || "this field"}”?`, text: "Earlier records keep it — they were filled on an older revision.", confirmLabel: "Remove", danger: true })) { s.fields.splice(i, 1); render(); }
          } }, "✕"))),
      el("input", { class: "field", "aria-label": task ? "Task" : "Field label", maxlength: "120", value: f.label, placeholder: task ? "Task (e.g. Tools put away)" : "Label", oninput: (e) => { f.label = e.target.value; } }),
      fixed ? null : picker({ title: "Type of answer", value: f.type, options: FIELD_TYPES.filter(([v]) => types.includes(v)).map(([value, label]) => ({ value, label })), onChange: (v) => { f.type = v; render(); } }),
      fixed || kind === "linecheck" ? lineUnit
        : el("div", { class: "form-field-row" },
            el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: f.perLine === true, onchange: (e) => { f.perLine = e.target.checked; } }), el("span", {}, "One per line (L1, L2, L3…)")),
            ["number", "percent"].includes(f.type) || f.unit
              ? el("input", { class: "field unit-field", "aria-label": "Unit", maxlength: "12", value: f.unit || "", placeholder: "Unit (ft, °F…)", oninput: (e) => { f.unit = e.target.value; } })
              : null),
      kind === "linecheck" ? lineCheckExtras(s, f) : null,
      el("input", { class: "field", "aria-label": "Help text", maxlength: "400", value: f.help || "", placeholder: "Help text shown under it (optional)", oninput: (e) => { f.help = e.target.value; } }));
  }


  function redrawRevs() {
    const box = container.querySelector("#form-revs");
    if (box) box.replaceChildren(...revList());
  }
  function revList() {
    if (!ui.revs) return [spinner("Loading revisions…")];
    return ui.revs.map((r) => el("div", { class: "import-row" }, el("span", { class: "import-line" }, `Rev ${r.rev}`), el("span", { class: "gap-term" }, `${fmtWhen(r.revAt)} · ${r.revByName || ""} — ${r.revNote || r.revChanges || ""}`)));
  }

  const blankField = (section) => ({ label: "", type: ui.draft.kind === "linecheck" ? (section?.scope === "plant" ? "tally" : "number") : ["tasklist", "station"].includes(ui.draft.kind) ? "task" : "text", perLine: false, unit: "", help: "" });

  // Task lists: the shifts (plant time; an end before the start runs past midnight) and when unfinished tasks turn red.
  function shiftsEditor(d) {
    return el("section", { class: "card form-section-edit" },
      el("strong", {}, "Shifts"),
      el("p", { class: "card-note" }, "Plant time. A shift that ends before it starts (e.g. 5 PM to 5 AM) runs past midnight."),
      d.shifts.map((sh, i) => el("div", { class: "shift-row" },
        el("input", { class: "field", "aria-label": "Shift name", maxlength: "30", value: sh.name, placeholder: "Name (e.g. Days)", oninput: (e) => { sh.name = e.target.value; } }),
        el("label", { class: "shift-time" }, "Starts", el("input", { class: "field", type: "time", value: sh.start, onchange: (e) => { sh.start = e.target.value; } })),
        el("label", { class: "shift-time" }, "Ends", el("input", { class: "field", type: "time", value: sh.end, onchange: (e) => { sh.end = e.target.value; } })),
        el("button", { class: "icon-btn danger", type: "button", "aria-label": "Remove shift", disabled: d.shifts.length < 2, onclick: () => { d.shifts.splice(i, 1); render(); } }, "✕"))),
      d.shifts.length < 6 ? el("button", { class: "btn secondary", type: "button", onclick: () => { d.shifts.push({ name: "", start: "", end: "" }); render(); } }, "+ Add a shift") : null,
      el("label", { class: "field-label", for: "fm-red" }, "Unfinished tasks turn red this many minutes before the shift ends"),
      el("input", { class: "field num-field", id: "fm-red", type: "text", inputmode: "numeric", value: String(d.redMinutes ?? 60), oninput: (e) => { d.redMinutes = Number(e.target.value || 0); } }));
  }

  function renderEdit() {
    const t = (data.formTemplates || []).find((x) => x.id === ui.id);
    const d = ui.draft;
    if (!t || !d) return renderList();
    async function submit(e) {
      e?.preventDefault();
      if (!(await confirmSheet({ title: `Save as revision ${t.rev + 1}?`, text: "It applies to the next one started. Anything already in progress finishes on the version it started with, and past sign-offs keep theirs.", confirmLabel: "✔ Save revision" }))) return;
      const r = await save({ formId: t.id, ...d, note: ui.note }, submit);
      if (r) show("list");
    }
    return [
      back("Forms", () => { stopRevs?.(); show("list"); }),
      el("h1", {}, `Edit: ${t.name}`),
      el("p", { class: "hint" }, `Now on revision ${t.rev} (${fmtWhen(t.revAt)}, ${t.revByName || ""}).`),
      banner(ui),
      el("form", { onsubmit: submit, class: "form-editor" },
        el("label", { class: "field-label", for: "fm-name" }, "Form name"),
        el("input", { class: "field", id: "fm-name", maxlength: "80", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("label", { class: "field-label", for: "fm-intro" }, "Instructions at the top (optional)"),
        el("input", { class: "field", id: "fm-intro", maxlength: "400", value: d.intro, oninput: (e) => { d.intro = e.target.value; } }),
        d.sections.map((s, si) =>
          el("section", { class: "card form-section-edit" },
            el("div", { class: "row-between" },
              el("strong", {}, `Section ${si + 1}`),
              el("span", { class: "icon-row" }, arrows(d.sections, si, "section"),
                el("button", { class: "icon-btn danger", type: "button", "aria-label": "Remove section", onclick: async () => {
                  if (await confirmSheet({ title: `Remove the section “${s.title}” and its fields?`, confirmLabel: "Remove", danger: true })) { d.sections.splice(si, 1); render(); }
                } }, "✕"))),
            el("input", { class: "field", "aria-label": "Section title", maxlength: "80", value: s.title, placeholder: "Section title", oninput: (e) => { s.title = e.target.value; } }),
            el("input", { class: "field", "aria-label": "Section help", maxlength: "400", value: s.help || "", placeholder: "Help text for the section (optional)", oninput: (e) => { s.help = e.target.value; } }),
            d.kind === "linecheck" ? el("div", { class: "choices two" },
              el("button", { class: s.scope !== "plant" ? "choice on" : "choice", type: "button", onclick: () => { s.scope = "line"; s.fields.forEach((x) => { if (x.type === "tally") x.type = "number"; }); render(); } }, "Page 1 — each line, every check"),
              el("button", { class: s.scope === "plant" ? "choice on" : "choice", type: "button", onclick: () => { s.scope = "plant"; s.fields.forEach((x) => { x.type = "tally"; }); render(); } }, "Page 2 — plant-wide tallies")) : null,
            s.fields.map((f, fi) => fieldEditor(s, f, fi)),
            el("button", { class: "btn secondary", type: "button", onclick: () => { s.fields.push(blankField(s)); render(); } }, d.kind === "tasklist" ? "+ Add a task" : "+ Add a field"))),
        el("button", { class: "btn secondary", type: "button", onclick: () => { d.sections.push({ title: "", help: "", fields: [blankField()] }); render(); } }, "+ Add a section"),
        d.kind === "tasklist" ? shiftsEditor(d) : null,
        d.kind === "linecheck" ? el("section", { class: "card form-section-edit" },
          el("label", { class: "field-label strong", for: "fm-every" }, "A check is due every (minutes)"),
          el("input", { class: "field num-field", id: "fm-every", type: "text", inputmode: "numeric", value: String(d.everyMinutes ?? 30), oninput: (e) => { d.everyMinutes = Number(e.target.value || 0); } })) : null,
        el("label", { class: "field-label", for: "fm-note" }, "What changed (short note — optional; the app also lists the changes)"),
        el("input", { class: "field", id: "fm-note", maxlength: "300", value: ui.note, placeholder: "e.g. Added Silo 5", oninput: (e) => { ui.note = e.target.value; } }),
        el("button", { class: "btn big", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : `✔ Save as revision ${t.rev + 1}`)),
      collapsible(`form-revs-${t.id}`, "🕘 Revision history", el("div", { class: "import-preview", id: "form-revs" }, revList())),
    ];
  }

  function render() {
    container.replaceChildren(...[(ui.view === "edit" ? renderEdit : renderList)()].flat(3).filter(Boolean));
  }
  const stop = onDataChange(() => { if (!ui.busy && ui.view === "list") render(); });
  render();
  return () => { stop(); stopRevs?.(); };
}
