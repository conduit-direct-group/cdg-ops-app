// 📁 Documents & forms (Chris, 10-26-2026, Decision 116): the master copy of every form, machine checklist, reference
// document, and the map / Crew Board stations / training data files — grouped by department, each with where it's used
// and its revision history. New uploads of master copies happen only here. Admins see and change everything; a
// department head sees and changes their own department's items (the server checks every save). Everyone else uses the
// read-only working versions where they work (Checklists & documents, Home, Shop Map, Training).

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, picker, collapsible } from "./ui.js";
import { data } from "./data.js";
import {
  callDocumentsList, callDocHistory, callDocSetDepartment, callSaveFormTemplate, callSaveRefDoc, callAdminImportFloorMap,
  callAdminImportTrainingData,
} from "./firebase.js";
import { openFormsAdmin } from "./forms.js";
import { openChecklistAdmin } from "./checklists.js";
import { openCrewStationsAdmin } from "./crew.js";
import { uploadFile } from "./refdocs.js";
import { readOriginal } from "./trainingadmin.js";

const KIND = {
  form: "📝 Form", checklist: "📋 Machine checklist", refdoc: "📄 Reference document",
  map: "🗺 Map file", stations: "🧭 Stations file", training: "🎓 Training data",
};
const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

// Who has it in More: Admins and department heads (the Production Manager heads Production unless someone else is
// ticked). The server decides what each one can change.
export const usesDocuments = (roles, myself) => (roles || []).some((r) => ["admin", "plant-manager"].includes(r)) || myself?.deptHead === true;

export function openDocuments(container, { me, onExit, backLabel = "More" }) {
  const ui = { list: undefined, loadError: "", busy: false, upload: "", message: "", messageKind: "", retry: null, hist: {}, addDept: undefined, draft: null };
  let closeSub = null;
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false, upload: "" }); render(); };

  async function load() {
    ui.loadError = "";
    if (!navigator.onLine) { ui.loadError = friendlyError({ code: "offline" }); return render(); }
    render();
    try {
      ui.list = (await callDocumentsList()).data;
      if (ui.addDept === undefined) ui.addDept = ui.list.admin ? "" : ui.list.mine[0] || "";
    } catch (err) { ui.loadError = friendlyError(err); }
    render();
  }

  async function act(fn, again) {
    if (!navigator.onLine) return say(friendlyError({ code: "offline" }), again), null;
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const { data: r } = await fn();
      ui.busy = false;
      return r || true;
    } catch (err) { say(friendlyError(err), again); return null; }
  }

  // An editor screen (forms, checklists, stations) draws over this one; its back button comes here and reloads.
  function openSub(open) {
    const back = () => { closeSub?.(); closeSub = null; load(); window.scrollTo(0, 0); };
    closeSub = open(container, { me, onExit: back, backLabel: "Documents & forms" }) || null;
  }
  const deptName = (id) => ui.list?.departments.find((d) => d.id === id)?.name || "";
  const newDept = () => ui.addDept || undefined; // "" = the default for its type (Admins)

  // ---- loads and uploads -----------------------------------------------------------------------------------------
  async function loadForm(file) {
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { return say("That file isn't a form file (.json)."); }
    const formId = String(parsed.formId || parsed.kind || "");
    const exists = (data.formTemplates || []).some((t) => t.id === formId);
    if (!(await confirmSheet({ title: exists ? `Replace “${parsed.name}” with this file?` : `Add “${parsed.name}”?`, text: exists ? "It's saved as a new revision. Earlier revisions and everything already filled in are kept." : "It becomes revision 1. You can edit it afterwards.", confirmLabel: exists ? "Save new revision" : "Add form" }))) return;
    const r = await act(() => callSaveFormTemplate({ ...parsed, formId, create: !exists, ...(exists ? {} : { department: newDept() }), note: exists ? "Loaded from a form file" : "First version (from the paper form)" }), () => loadForm(file));
    if (r) { toast(`Saved as revision ${r.rev}`); load(); }
  }

  async function addRefDoc(file, existing = null) {
    if (file.type !== "application/pdf" && !file.type.startsWith("image/")) return say("A PDF or a photo only.");
    if (file.size > 50 * 1024 * 1024) return say("That file is over 50 MB.");
    if (!navigator.onLine) return say(friendlyError({ code: "offline" }), () => addRefDoc(file, existing));
    if (existing && !(await confirmSheet({ title: `Replace the file for “${existing.name}”?`, text: `It becomes revision ${(existing.rev || 1) + 1}. Earlier revisions stay in its history.`, confirmLabel: "Replace" }))) return;
    Object.assign(ui, { busy: true, message: "", retry: null });
    try {
      const url = await uploadFile(file, me.emp, (p) => { ui.upload = `Uploading ${file.name}: ${p}%`; render(); });
      ui.upload = "";
      const kind = file.type === "application/pdf" ? "pdf" : "image";
      if (!existing) {
        Object.assign(ui, { busy: false, draft: { url, kind, fileName: file.name, name: file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() } });
        return render();
      }
      ui.busy = false;
      if (await act(() => callSaveRefDoc({ id: existing.id, name: existing.name, url, kind, fileName: file.name, note: "New file" }), () => addRefDoc(file, existing))) {
        toast(`“${existing.name}” updated — revision ${(existing.rev || 1) + 1}`);
        load();
      }
    } catch (err) { say(friendlyError(err), () => addRefDoc(file, existing)); }
  }

  async function saveNewRefDoc() {
    const d = ui.draft;
    if (d.name.trim().length < 3) return say("Give the document a title.");
    if (await act(() => callSaveRefDoc({ name: d.name, url: d.url, kind: d.kind, fileName: d.fileName, note: "First version", department: newDept() }), saveNewRefDoc)) {
      ui.draft = null;
      toast("Document added");
      load();
    }
  }

  async function retireRefDoc(item) {
    if (!(await confirmSheet({ title: `Take “${item.name}” off the list?`, text: "It's hidden, not deleted — its history is kept.", confirmLabel: "Take it off", danger: true }))) return;
    if (await act(() => callSaveRefDoc({ id: item.id, name: item.name, active: false }), () => retireRefDoc(item))) { toast("Taken off the list"); load(); }
  }

  async function loadMap(file, item) {
    let map;
    try { map = JSON.parse(await file.text()); } catch { return say("That file isn't the map file (plant-data.json)."); }
    if (!(await confirmSheet({ title: "Load this map file?", text: `It replaces the map, stations, and SOP text${item.loaded ? " and is kept as the next revision" : ""}. Station-to-machine links are kept.`, confirmLabel: "Load map" }))) return;
    const r = await act(() => callAdminImportFloorMap({ map }), () => loadMap(file, item));
    if (r) { toast(`Map loaded — ${r.zones} areas, ${r.stations} stations, ${r.sops} SOPs`); load(); }
  }

  async function loadTraining(file, item) {
    let parsed;
    try { parsed = await readOriginal(file); } catch (err) { return say(err.message || "Couldn't read that file."); }
    if (!(await confirmSheet({ title: "Load this training data?", text: `It replaces the modules, roster, SOP and trainer-guide text${item.loaded ? " and is kept as the next revision" : ""}. Sign-offs and other records in the app are kept.`, confirmLabel: "Load training data" }))) return;
    const r = await act(() => callAdminImportTrainingData(parsed), () => loadTraining(file, item));
    if (r) { toast(`Training data loaded — ${r.modules} modules, ${r.roster} on the roster, ${r.sops} SOPs`); load(); }
  }

  async function setDept(item, dept) {
    if (await act(() => callDocSetDepartment({ key: item.key, department: dept || null }), () => setDept(item, dept))) {
      toast(`${item.name}: ${dept ? deptName(dept) : "back to its usual department"}`);
      load();
    }
  }

  async function toggleHistory(item) {
    const h = ui.hist[item.key];
    if (h) { delete ui.hist[item.key]; return render(); }
    ui.hist[item.key] = { list: null, error: "" };
    render();
    try { ui.hist[item.key].list = (await callDocHistory({ key: item.key })).data.history; } catch (err) { ui.hist[item.key].error = friendlyError(err); }
    render();
  }

  // ---- drawing ------------------------------------------------------------------------------------------------
  const fileBtn = (label, accept, onFile, cls = "btn secondary file-btn") => el("label", { class: cls }, ui.busy ? "Working…" : label,
    el("input", { type: "file", accept, hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) onFile(f); } }));

  function actions(item) {
    const open = (label, fn) => el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: fn }, label);
    if (item.kind === "form") return [open("✎ Open the editor", () => openSub((c, o) => openFormsAdmin(c, { ...o, formId: item.id })))];
    if (item.kind === "checklist") return [open("✎ Open the editor", () => openSub((c, o) => openChecklistAdmin(c, { ...o, templateId: item.id })))];
    if (item.kind === "stations") return [open(item.loaded ? "✎ Open the stations file" : "⇪ Load the stations file", () => openSub(openCrewStationsAdmin))];
    if (item.kind === "map") return [fileBtn(item.loaded ? "⇪ Load the map file again" : "⇪ Load the map file (plant-data.json)", ".json,application/json", (f) => loadMap(f, item))];
    if (item.kind === "training") return [fileBtn(item.loaded ? "⇪ Load the training data again" : "⇪ Load the original training app file", ".html,.htm,.js,text/html,text/javascript", (f) => loadTraining(f, item))];
    if (item.kind === "refdoc") {
      return [
        item.url ? el("a", { class: "btn secondary", href: item.url, target: "_blank", rel: "noopener" }, "Open") : null,
        item.active ? fileBtn("⇪ Replace file", "application/pdf,image/*", (f) => addRefDoc(f, item)) : null,
        item.active ? open("Take off the list", () => retireRefDoc(item)) : null,
      ];
    }
    return [];
  }

  function historyBody(item) {
    const h = ui.hist[item.key];
    if (!h) return null;
    if (h.error) return banner({ message: h.error, messageKind: "error", retry: () => { delete ui.hist[item.key]; toggleHistory(item); } });
    if (!h.list) return spinner("Loading history…");
    if (!h.list.length) return el("p", { class: "card-note" }, "No revisions kept yet — the next change or load starts the history.");
    return el("div", { class: "import-preview" }, h.list.map((r) => el("div", { class: "import-row" },
      el("span", { class: "import-line" }, `Rev ${r.rev}`),
      r.url ? el("a", { class: "gap-term", href: r.url, target: "_blank", rel: "noopener" }, `${fmtDay(r.at)}${r.byName ? ` · ${r.byName}` : ""} — ${r.note || "file"}`)
        : el("span", { class: "gap-term" }, `${fmtDay(r.at)}${r.byName ? ` · ${r.byName}` : ""}${r.note ? ` — ${r.note}` : ""}`))));
  }

  function itemCard(item) {
    const L = ui.list;
    const revText = item.rev ? `Revision ${item.rev}` : item.loaded === false ? "Not loaded yet" : "Loaded before history was kept";
    return el("section", { class: "card doc-card" },
      el("div", { class: "doc-head" },
        el("strong", {}, item.name),
        item.active === false ? el("span", { class: "tag off" }, "Retired") : null),
      el("p", { class: "card-note" }, `${KIND[item.kind]} · ${revText}${item.at ? ` · ${fmtDay(item.at)}` : ""}${item.byName ? ` · ${item.byName}` : ""}`),
      item.note && item.loaded !== false ? el("p", { class: "card-note" }, item.note) : null,
      el("p", { class: "card-note" }, el("strong", {}, "Used on: "), item.usedOn),
      el("div", { class: "btn-row" }, ...actions(item),
        el("button", { class: "link-btn", type: "button", "aria-expanded": String(!!ui.hist[item.key]), onclick: () => toggleHistory(item) }, ui.hist[item.key] ? "Hide history" : "🕘 Revision history")),
      historyBody(item),
      L.admin ? el("div", { class: "doc-dept" },
        el("span", { class: "card-note" }, "Department"),
        picker({ title: `Department for ${item.name}`, value: item.department || "", options: [
          ...L.departments.map((d) => ({ value: d.id, label: d.name })),
          ...(item.department ? [] : [{ value: "", label: "No department (Admins cover it)" }]),
        ], onChange: (v) => { if (v !== (item.department || "")) setDept(item, v); } })) : null);
  }

  function addCard() {
    const L = ui.list;
    const choices = L.admin
      ? [{ value: "", label: "Its usual department" }, ...L.departments.map((d) => ({ value: d.id, label: d.name }))]
      : L.departments.filter((d) => L.mine.includes(d.id)).map((d) => ({ value: d.id, label: d.name }));
    return collapsible("docs-add", "＋ Add a document, form, or checklist",
      el("p", { class: "hint" }, choices.length > 1 ? "New master copies are added only here. Pick the department first." : "New master copies are added only here, under your department."),
      choices.length > 1 ? el("label", { class: "field-label" }, "Department") : null,
      choices.length > 1 ? picker({ title: "Department", value: ui.addDept || "", options: choices, onChange: (v) => { ui.addDept = v; render(); } })
        : el("p", { class: "card-note" }, `Saved under ${choices[0]?.label || ""}.`),
      ui.draft
        ? el("section", { class: "card" },
            el("strong", {}, `New document: ${ui.draft.fileName}`),
            el("label", { class: "field-label", for: "doc-name" }, "Title"),
            el("input", { class: "field", id: "doc-name", maxlength: "120", value: ui.draft.name, oninput: (e) => { ui.draft.name = e.target.value; } }),
            el("div", { class: "btn-row" },
              el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: saveNewRefDoc }, "✔ Add to the list"),
              el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.draft = null; render(); } }, "Cancel")))
        : el("div", { class: "btn-row" },
            fileBtn("📄 Reference document (PDF or photo)", "application/pdf,image/*", (f) => addRefDoc(f)),
            fileBtn("📝 Form file (.json)", ".json,application/json", loadForm),
            el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => openSub((c, o) => openChecklistAdmin(c, { ...o, templateId: "new", department: newDept() })) }, "📋 New machine checklist")));
  }

  function render() {
    if (closeSub) return;
    const L = ui.list;
    const groups = L ? [
      ...L.departments.map((d) => ({ id: d.id, title: d.name, sub: d.head ? `Head: ${d.head}` : "No head — Admins cover it" })),
      { id: null, title: "No department", sub: "Admins cover these until one is set" },
    ].map((g) => ({ ...g, items: L.items.filter((i) => (i.department || null) === g.id) })).filter((g) => g.items.length) : [];
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit, disabled: ui.busy }, `← ${backLabel}`),
      el("h1", {}, "📁 Documents & forms"),
      el("p", { class: "hint" }, L?.admin
        ? "Every master copy, by department. Admins change everything; a department head changes their own department's items. Every change keeps a revision."
        : "Your department's master copies. Every change keeps a revision; people see the new version where they use it."),
      banner(ui),
      ui.upload ? spinner(ui.upload) : null,
      ui.loadError ? banner({ message: ui.loadError, messageKind: "error", retry: load }) : null,
      !L && !ui.loadError ? spinner("Loading documents…") : null,
      L ? addCard() : null,
      L && !L.items.length ? emptyState("Nothing here yet", "Add a document, form, or checklist above.") : null,
      // One department: shown open. Several (Admins): each folds, so the page stays short.
      groups.length === 1
        ? [el("h2", { class: "doc-group" }, groups[0].title, el("span", { class: "card-note" }, ` · ${groups[0].sub}`)), groups[0].items.map(itemCard)]
        : groups.map((g) => collapsible(`docs-dept-${g.id || "none"}`, `${g.title} (${g.items.length}) · ${g.sub}`, g.items.map(itemCard))),
    ].flat(3).filter(Boolean));
  }

  load();
  return () => { closeSub?.(); };
}
