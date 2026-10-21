// Machines — parts & specs for each machine (Decision 51, updated 10-21-2026). Maintenance and Admin add and edit
// (Admin → Roles: "Can edit machines"); the Production Manager views. Kept in the app only for now — nothing goes to Odoo yet,
// but the fields match the Decision 51 mapping so sending them later is an add-on.
// Every change saves the old version first (History → Restore); removed rows and files wait 30 days in Removed.

import { el, breakable, friendlyError, spinner, emptyState, banner, toast, confirmSheet, choose, collapsible, picker } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import { db, storage, callSaveMachineSpecs, callCopyMachineSpecs, callRestoreMachineSpecsVersion, callRestoreMachineSpecItem } from "./firebase.js";
import { collection, getDocs, orderBy, query, limit } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

const EDIT_DEFAULT = ["maintenance", "admin"];
const VIEW_ROLES = ["maintenance", "plant-manager", "admin"];
export const roleEditsMachines = (r) => (typeof r.editMachines === "boolean" ? r.editMachines : EDIT_DEFAULT.includes(r.id));
export const canEditMachines = (roles) => (data.roles || []).some((r) => r.active !== false && roles.includes(r.id) && roleEditsMachines(r));
export const canViewMachines = (roles) => roles.some((r) => VIEW_ROLES.includes(r)) || canEditMachines(roles);

// Sections and their fields: [key, label, wide?]. The first field is the row's title.
const SECTIONS = [
  { key: "parts", icon: "🔩", title: "Parts", noun: "part", fields: [["name", "Part name"], ["partNumber", "Part number"], ["vendor", "Vendor"], ["vendorPartNumber", "Vendor part #"], ["qty", "Quantity used"], ["notes", "Notes", true]] },
  { key: "fasteners", icon: "🪛", title: "Fasteners", noun: "fastener", fields: [["location", "Location"], ["size", "Size"], ["type", "Type"], ["torque", "Torque (if known)"]] },
  { key: "belts", icon: "⚙", title: "Belts & bearings", noun: "belt or bearing", fields: [["location", "Location"], ["partNumber", "Part number"], ["size", "Size"]] },
  { key: "fluids", icon: "🛢", title: "Fluids & lubrication", noun: "fluid", fields: [["what", "What"], ["where", "Where"], ["howOften", "How often"]] },
];
const INFO = [["make", "Make"], ["model", "Model"], ["serial", "Serial number"], ["vendor", "Vendor"], ["installDate", "Install date"], ["notes", "Notes"]];
const FILE_LABELS = ["Manual", "Wiring diagram", "Nameplate", "Photo", "Parts list", "Other"];
const COPYABLE = [["info", "Info (make, model, vendor)"], ["parts", "Parts"], ["fasteners", "Fasteners"], ["belts", "Belts & bearings"], ["fluids", "Fluids & lubrication"], ["notes", "Important notes"]];

const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : t?.seconds ? t.seconds * 1000 : 0);
const fmtDay = (t) => {
  if (typeof t === "string" && /^\d{4}-\d{2}-\d{2}/.test(t)) t = new Date(`${t.slice(0, 10)}T12:00:00`);
  return toMs(t) ? new Date(toMs(t)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
};
const fmtWhen = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const normPart = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const copy = (v) => JSON.parse(JSON.stringify(v ?? null));
const newRowId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function upload(file, emp, onProgress) {
  return new Promise((resolve, reject) => {
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    task.on("state_changed", (s) => onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)), reject, async () => resolve(await getDownloadURL(task.snapshot.ref)));
  });
}

// Running or down, the same way Home's line status works (an open line-down request on this machine's line).
export function machineDown(m) {
  return !!(m.lineId && (data.plantStatus?.down?.[m.lineId]?.machineIds || []).includes(m.id));
}

export function openMachines(container, { me, startMachine = null, onExit, backLabel = "Home", onFixes = null, onIssues = null, onReport = null }) {
  const ui = { machineId: startMachine, search: "", edit: null, info: null, busy: false, upload: "", message: "", messageKind: "", retry: null, copy: null, history: null, removed: null };
  const editor = () => canEditMachines(me.roles);
  const spec = (id) => (data.machineSpecs || []).find((s) => s.id === id) || null;
  const machine = () => (data.machines || []).find((m) => m.id === ui.machineId) || null;
  const active = () => (data.machines || []).filter((m) => m.active !== false);
  const openFor = (id) => (data.openIssues || []).filter((i) => i.machineId === id);
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false, upload: "" }); render(); };
  const show = (id) => { Object.assign(ui, { machineId: id, edit: null, info: null, copy: null, history: null, removed: null, message: "", retry: null }); render(); window.scrollTo(0, 0); };

  async function act(fn, retry) {
    if (!navigator.onLine) { say(friendlyError({ code: "offline" }), retry); return null; }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const out = await fn();
      ui.busy = false;
      return out || true;
    } catch (err) {
      // Someone else saved first: keep their changes on screen, ask to redo ours.
      if (String(err?.code || "").endsWith("aborted")) Object.assign(ui, { edit: null, info: null });
      say(friendlyError(err), String(err?.code || "").endsWith("aborted") ? null : retry);
      return null;
    }
  }

  // ---- list ------------------------------------------------------------------------

  function groups() {
    const lines = (data.lines || []).filter((l) => l.active !== false);
    return lines.map((l) => [l.name, active().filter((m) => m.lineId === l.id)])
      .concat([["Shared", active().filter((m) => !m.lineId || !lines.some((l) => l.id === m.lineId))]])
      .filter(([, list]) => list.length);
  }

  function tile(m) {
    const down = machineDown(m);
    const open = openFor(m.id).length;
    const s = spec(m.id);
    return el("button", { class: down ? "machine-tile down" : "machine-tile", type: "button", onclick: () => show(m.id) },
      el("span", { class: "person-name" }, breakable(m.name)),
      el("span", { class: "person-meta" }, m.id),
      el("span", { class: "tags" },
        down ? el("span", { class: "tag off" }, "⛔ Down") : el("span", { class: "tag ok" }, "✓ Running"),
        open ? el("span", { class: "tag" }, `🚨 ${open} open`) : null,
        (s?.notes || []).some((n) => n.safety) ? el("span", { class: "tag off" }, "⚠ Safety note") : null));
  }

  // "Which machines use part #6205?" — every row whose part number (or vendor part #) contains what was typed.
  function partHits(q) {
    const n = normPart(q);
    if (n.length < 2) return [];
    const hits = [];
    for (const s of data.machineSpecs || []) {
      const m = (data.machines || []).find((x) => x.id === s.id);
      if (!m || m.active === false) continue;
      for (const p of s.parts || []) if (normPart(p.partNumber).includes(n) || normPart(p.vendorPartNumber).includes(n)) hits.push({ m, what: p.name, num: p.partNumber || p.vendorPartNumber, extra: [p.qty != null ? `qty ${p.qty}` : "", p.vendor].filter(Boolean).join(" · "), where: "Parts" });
      for (const b of s.belts || []) if (normPart(b.partNumber).includes(n)) hits.push({ m, what: b.location, num: b.partNumber, extra: b.size || "", where: "Belts & bearings" });
    }
    return hits;
  }

  function renderList() {
    if (!data.machines || !data.lines || !data.machineSpecs) return [back(backLabel, onExit), el("h1", {}, "⚙ Machines"), spinner()];
    const q = ui.search.trim().toLowerCase();
    const matches = (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || normPart(m.id).includes(normPart(q))
      || (spec(m.id)?.parts || []).some((p) => (p.name || "").toLowerCase().includes(q));
    const hits = q ? partHits(q) : [];
    const shown = groups().map(([name, list]) => [name, list.filter(matches)]).filter(([, list]) => list.length);
    const searchBox = el("input", {
      class: "field search", type: "search", placeholder: "Name, M-number, or part #", "aria-label": "Search machines and part numbers", value: ui.search,
      oninput: (e) => { ui.search = e.target.value; const pos = e.target.selectionStart; render(); const f = container.querySelector(".field.search"); f.focus(); f.setSelectionRange(pos, pos); },
    });
    return [
      back(backLabel, onExit),
      el("h1", {}, "⚙ Machines"),
      data.machineSpecsError ? banner({ message: "Couldn't load the parts lists. Check Wi-Fi, then reopen this page.", messageKind: "error" }) : null,
      searchBox,
      hits.length
        ? el("section", { class: "card mach-hits" },
            el("strong", {}, `Part # “${ui.search.trim()}” — used on ${new Set(hits.map((h) => h.m.id)).size} machine${new Set(hits.map((h) => h.m.id)).size === 1 ? "" : "s"}`),
            el("div", { class: "person-list" }, hits.map((h) =>
              el("button", { class: "person-row", type: "button", onclick: () => show(h.m.id) },
                el("span", { class: "person-name" }, `${h.m.name} · ${h.m.id}`),
                el("span", { class: "person-meta" }, [h.where, h.what, h.num, h.extra].filter(Boolean).join(" · "))))))
        : null,
      !shown.length && !hits.length
        ? emptyState(q ? "Nothing matches" : "No machines yet", q ? "Try part of the name, the M-number (M-001), or a part number." : "An admin adds them in Admin → Lines & machines.")
        : shown.map(([name, list]) => [el("h2", {}, name), el("div", { class: "machine-grid" }, list.map(tile))]),
    ];
  }

  // ---- one machine -----------------------------------------------------------------

  const back = (label, fn) => el("button", { class: "link-btn", type: "button", onclick: fn }, `← ${label}`);
  const lastChange = (s) => (s?.updatedAt ? el("p", { class: "hint mach-changed" }, `Last changed ${fmtWhen(s.updatedAt)} by ${s.updatedByName || s.updatedBy}`) : null);

  async function saveSection(m, section, items) {
    const s = spec(m.id);
    const ok = await act(() => callSaveMachineSpecs({ machineId: m.id, section, rev: s?.rev || 0, ...(section === "info" ? { info: items } : { items }) }), () => saveSection(m, section, items));
    if (ok) { Object.assign(ui, { edit: null, info: null, history: null, removed: null }); toast("Saved"); render(); }
    return ok;
  }

  // View: one card per row — the first field as the title, the rest as "Label: value".
  function rowView(sec, r) {
    const [first, ...rest] = sec.fields;
    const bits = rest.map(([k, label]) => (r[k] !== "" && r[k] != null ? `${label}: ${r[k]}` : null)).filter(Boolean);
    return el("div", { class: "spec-row" }, el("strong", {}, breakable(r[first[0]] || "—")), bits.length ? el("span", { class: "person-meta" }, bits.join(" · ")) : null);
  }

  // Edit: every row as a small form; Save sends the whole section (the server keeps each row's id).
  function sectionEdit(m, sec) {
    const rows = ui.edit.rows;
    const field = (r, [k, label, wide]) => el("label", { class: wide ? "spec-field wide" : "spec-field" },
      el("span", { class: "field-label" }, label),
      el("input", { class: "field", value: r[k] ?? "", inputmode: k === "qty" ? "decimal" : null, maxlength: k === "notes" ? "400" : "120", oninput: (e) => { r[k] = e.target.value; } }));
    return [
      rows.length ? null : el("p", { class: "card-note" }, `No ${sec.noun}s yet. Tap “+ Add” below.`),
      rows.map((r, i) => el("div", { class: "spec-edit" },
        el("div", { class: "spec-fields" }, sec.fields.map((f) => field(r, f))),
        el("button", { class: "link-btn danger-link", type: "button", onclick: () => { rows.splice(i, 1); render(); } }, `✕ Remove this ${sec.noun}`))),
      el("button", { class: "btn secondary", type: "button", onclick: () => { rows.push({ id: newRowId() }); render(); container.querySelectorAll(".spec-edit .field")[sec.fields.length * (rows.length - 1)]?.focus(); } }, `+ Add ${sec.noun}`),
      el("div", { class: "btn-row" },
        el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => saveSection(m, sec.key, rows) }, ui.busy ? "Saving…" : "Save"),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.edit = null; render(); } }, "Cancel")),
      el("p", { class: "card-note" }, "Removed rows can be put back for 30 days (History, below)."),
    ];
  }

  function sectionFold(m, s, sec) {
    const rows = s?.[sec.key] || [];
    const editing = ui.edit?.section === sec.key;
    const startEdit = () => { Object.assign(ui, { edit: { section: sec.key, rows: copy(rows) }, info: null }); render(); };
    return collapsible(`mach-${sec.key}`, `${sec.icon} ${sec.title} · ${rows.length}`,
      editing ? sectionEdit(m, sec) : [
        rows.length ? el("div", { class: "spec-list" }, rows.map((r) => rowView(sec, r))) : el("p", { class: "card-note" }, `No ${sec.noun}s listed yet.`),
        editor() ? el("button", { class: "btn secondary", type: "button", disabled: !!ui.edit || !!ui.info, onclick: startEdit }, rows.length ? `✎ Edit ${sec.title.toLowerCase()}` : `+ Add ${sec.noun}s`) : null,
      ]);
  }

  function infoFold(m, s) {
    const info = s?.info || {};
    if (ui.info) {
      const d = ui.info;
      return collapsible("mach-info", "ℹ Info",
        el("div", { class: "spec-fields" }, INFO.map(([k, label]) => el("label", { class: k === "notes" ? "spec-field wide" : "spec-field" },
          el("span", { class: "field-label" }, label),
          k === "notes"
            ? el("textarea", { class: "field", rows: "3", maxlength: "2000", oninput: (e) => { d[k] = e.target.value; } }, d[k] || "")
            : el("input", { class: "field", type: k === "installDate" ? "date" : "text", value: d[k] || "", maxlength: "80", oninput: (e) => { d[k] = e.target.value; } })))),
        el("div", { class: "btn-row" },
          el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => saveSection(m, "info", d) }, ui.busy ? "Saving…" : "Save"),
          el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.info = null; render(); } }, "Cancel")));
    }
    const any = INFO.some(([k]) => info[k]);
    return collapsible("mach-info", "ℹ Info",
      el("table", { class: "info-table" }, INFO.map(([k, label]) => el("tr", {}, el("th", {}, label), el("td", {}, k === "installDate" ? fmtDay(info[k]) : breakable(info[k] || "—"))))),
      !any ? el("p", { class: "card-note" }, "Nothing entered yet — the nameplate usually has the make, model, and serial number.") : null,
      editor() ? el("button", { class: "btn secondary", type: "button", disabled: !!ui.edit, onclick: () => { Object.assign(ui, { info: { ...info }, edit: null }); render(); } }, any ? "✎ Edit info" : "+ Add info") : null);
  }

  // Important notes: always pinned at the top; safety ones in red.
  function pinnedNotes(m, s) {
    const notes = s?.notes || [];
    if (ui.edit?.section === "notes") {
      const rows = ui.edit.rows;
      return el("section", { class: "card mach-notes-edit" },
        el("strong", {}, "📌 Important notes"),
        rows.map((r, i) => el("div", { class: "spec-edit" },
          el("textarea", { class: "field", rows: "2", maxlength: "600", "aria-label": "Note", oninput: (e) => { r.text = e.target.value; } }, r.text || ""),
          el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: r.safety === true, onchange: (e) => { r.safety = e.target.checked; } }), el("span", {}, "Safety note (shows in red)")),
          el("button", { class: "link-btn danger-link", type: "button", onclick: () => { rows.splice(i, 1); render(); } }, "✕ Remove this note"))),
        el("button", { class: "btn secondary", type: "button", onclick: () => { rows.push({ id: newRowId(), text: "", safety: false }); render(); } }, "+ Add note"),
        el("div", { class: "btn-row" },
          el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => saveSection(m, "notes", rows) }, ui.busy ? "Saving…" : "Save"),
          el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.edit = null; render(); } }, "Cancel")));
    }
    const ordered = [...notes.filter((n) => n.safety), ...notes.filter((n) => !n.safety)];
    return [
      ordered.map((n) => el("div", { class: n.safety ? "mach-note safety" : "mach-note", role: n.safety ? "alert" : null },
        el("strong", {}, n.safety ? "⚠ Safety" : "📌 Note"), el("p", {}, breakable(n.text)))),
      editor() ? el("button", { class: "link-btn", type: "button", disabled: !!ui.edit || !!ui.info, onclick: () => { Object.assign(ui, { edit: { section: "notes", rows: copy(notes) }, info: null }); render(); } }, notes.length ? "✎ Edit important notes" : "+ Add an important note (e.g. lockout points)") : null,
    ];
  }

  // Photos & documents: upload from the phone (camera or files); tap to open.
  async function addFile(m, file) {
    if (file.type !== "application/pdf" && !file.type.startsWith("image/")) return say("A photo or a PDF only.");
    if (file.size > 50 * 1024 * 1024) return say("That file is over 50 MB.");
    if (!navigator.onLine) return say(friendlyError({ code: "offline" }), () => addFile(m, file));
    const label = await choose({ title: "What is it?", options: FILE_LABELS.map((l) => ({ value: l, label: l })) });
    if (!label) return;
    Object.assign(ui, { busy: true, message: "", retry: null });
    try {
      const url = await upload(file, me.emp, (p) => { ui.upload = `Uploading ${file.name}: ${p}%`; render(); });
      ui.upload = "";
      const files = [...(spec(m.id)?.files || []), { id: newRowId(), url, kind: file.type === "application/pdf" ? "pdf" : "image", name: file.name.slice(0, 120), label }];
      ui.busy = false;
      await saveSection(m, "files", files);
    } catch (err) { say(friendlyError(err), () => addFile(m, file)); }
  }

  async function removeFile(m, f) {
    if (!(await confirmSheet({ title: `Remove “${f.name}”?`, text: "It goes to Removed for 30 days, where it can be put back.", confirmLabel: "Remove", danger: true }))) return;
    await saveSection(m, "files", (spec(m.id)?.files || []).filter((x) => x.id !== f.id));
  }

  function filesFold(m, s) {
    const files = s?.files || [];
    const input = el("input", { type: "file", accept: "image/*,application/pdf", hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) addFile(m, f); } });
    return collapsible("mach-files", `📷 Photos & documents · ${files.length}`,
      files.length
        ? el("div", { class: "mach-files" }, files.map((f) => el("div", { class: "mach-file" },
            el("a", { href: f.url, target: "_blank", rel: "noopener", class: "mach-file-open" },
              f.kind === "image" ? el("img", { src: f.url, alt: f.label, loading: "lazy" }) : el("span", { class: "mach-pdf", "aria-hidden": "true" }, "PDF"),
              el("span", { class: "mach-file-label" }, el("strong", {}, f.label), el("span", { class: "person-meta" }, breakable(f.name)))),
            editor() ? el("button", { class: "link-btn danger-link", type: "button", disabled: ui.busy, onclick: () => removeFile(m, f) }, "✕ Remove") : null)))
        : el("p", { class: "card-note" }, "No photos or documents yet — manuals, wiring diagrams, nameplates."),
      ui.upload ? el("p", { class: "card-note", role: "status" }, ui.upload) : null,
      editor() ? [input, el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => input.click() }, "+ Add photo or document")] : null);
  }

  // Already in the app, read-only: last PM, last repair, open requests, related Fix Library fixes.
  function fixesFor(m) {
    const cats = new Set((data.fixCategories || []).filter((c) => (c.machineTypes || []).includes(m.type)).map((c) => c.id));
    return (data.fixes || []).filter((f) => cats.has(f.categoryId) || (f.machineIds || []).includes(m.id));
  }
  function appCard(m) {
    const open = openFor(m.id);
    const fixes = fixesFor(m);
    return el("section", { class: "card mach-app" },
      el("strong", {}, "🔧 Service & fixes ", el("small", { class: "muted" }, "already in the app")),
      el("table", { class: "info-table" },
        el("tr", {}, el("th", {}, "Last PM"), el("td", {}, fmtDay(m.lastPmDate))),
        el("tr", {}, el("th", {}, "Last repair"), el("td", {}, fmtDay(m.lastRepairDate))),
        el("tr", {}, el("th", {}, "Open requests"), el("td", {}, open.length ? String(open.length) : "None"))),
      open.length ? el("div", { class: "person-list" }, open.map((i) => el("button", { class: i.lineDown ? "person-row urgent" : "person-row", type: "button", onclick: () => onIssues && onIssues() },
        el("span", { class: "person-name" }, breakable(i.title || "Maintenance request")),
        el("span", { class: "person-meta" }, [i.lineDown ? "⛔ Marked line down" : null, i.unsafe ? "⚠ Unsafe" : null, i.reportedAt ? `reported ${fmtWhen(i.reportedAt)}` : null].filter(Boolean).join(" · "))))) : null,
      el("p", { class: "card-note" }, fixes.length ? `${fixes.length} Fix Library fix${fixes.length === 1 ? "" : "es"} for this machine:` : "No Fix Library fixes for this machine yet."),
      fixes.length ? el("ul", { class: "mach-fixes" }, fixes.slice(0, 6).map((f) => el("li", {}, breakable(f.title)))) : null,
      el("div", { class: "btn-row" },
        onFixes ? el("button", { class: "btn secondary", type: "button", onclick: () => onFixes(m.id) }, fixes.length > 6 ? `Open all ${fixes.length} in Fix Library` : "Open in Fix Library") : null,
        onReport ? el("button", { class: "btn danger", type: "button", onclick: () => onReport(m.id) }, "🚨 Maintenance Request") : null));
  }

  // Copy from another machine (e.g. L1 Extruder's parts list onto L2 Extruder), then edit.
  function copyFold(m, s) {
    const sources = active().filter((x) => x.id !== m.id && spec(x.id));
    const c = ui.copy || (ui.copy = { from: null, sections: [], replace: false });
    const src = c.from ? spec(c.from) : null;
    const count = (k) => (k === "info" ? (Object.values(src?.info || {}).some(Boolean) ? 1 : 0) : (src?.[k] || []).length);
    const targetHas = c.sections.some((k) => k !== "info" && (s?.[k] || []).length);
    const run = async () => {
      const fromName = active().find((x) => x.id === c.from)?.name || c.from;
      const ok = await act(() => callCopyMachineSpecs({ fromId: c.from, toId: m.id, sections: c.sections, replace: c.replace, rev: s?.rev || 0 }), run);
      if (ok) { ui.copy = null; toast(`Copied from ${fromName} — edit anything that's different`); render(); }
    };
    return collapsible("mach-copy", "📋 Copy from another machine",
      !sources.length ? el("p", { class: "card-note" }, "No other machine has parts or specs yet. Fill one in, then copy it to the others.") : [
        el("p", { class: "card-note" }, "Copy rows from a machine that's built the same way, then edit what's different. Photos and serial numbers aren't copied."),
        picker({ title: "Copy from", value: c.from, placeholder: "Pick a machine…", options: sources.map((x) => ({ value: x.id, label: `${x.name} · ${x.id}` })), onChange: (v) => { c.from = v; c.sections = []; render(); } }),
        src ? el("div", { class: "chips" }, COPYABLE.map(([k, label]) => {
          const on = c.sections.includes(k);
          return el("button", { class: on ? "chip on" : "chip", type: "button", "aria-pressed": String(on), disabled: !count(k), onclick: () => { c.sections = on ? c.sections.filter((x) => x !== k) : [...c.sections, k]; render(); } }, `${on ? "✓ " : ""}${label}${k === "info" ? "" : ` (${count(k)})`}`);
        })) : null,
        targetHas ? el("div", { class: "choices two" },
          el("button", { class: c.replace ? "choice" : "choice on", type: "button", onclick: () => { c.replace = false; render(); } }, "Add to what's here"),
          el("button", { class: c.replace ? "choice danger on" : "choice", type: "button", onclick: () => { c.replace = true; render(); } }, "Replace what's here")) : null,
        el("button", { class: "btn", type: "button", disabled: ui.busy || !c.from || !c.sections.length || !!ui.edit, onclick: run }, ui.busy ? "Copying…" : "Copy"),
      ]);
  }

  // History: every saved version (restore), and removed rows/files (put back within 30 days).
  async function loadHistory(m) {
    try {
      const base = collection(db, "machineSpecs", m.id, "versions");
      const [v, r] = await Promise.all([getDocs(query(base, orderBy("savedAt", "desc"), limit(30))), getDocs(query(collection(db, "machineSpecs", m.id, "removed"), orderBy("removedAt", "desc"), limit(100)))]);
      ui.history = v.docs.map((d) => ({ id: d.id, ...d.data() }));
      ui.removed = r.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) { ui.history = { error: friendlyError(err) }; }
    render();
  }
  function historyFold(m, s) {
    if (!s) return null;
    const label = (section) => ({ parts: "Parts", fasteners: "Fasteners", belts: "Belts & bearings", fluids: "Fluids & lubrication", files: "Photos & documents", notes: "Important notes" }[section] || section);
    const rowTitle = (section, row) => row.name || row.location || row.what || row.text || row.label || "row";
    const body = () => {
      if (ui.history === null) return el("button", { class: "btn secondary", type: "button", onclick: () => { ui.history = "loading"; render(); loadHistory(m); } }, "Show history");
      if (ui.history === "loading") return spinner("Loading history…");
      if (ui.history.error) return banner({ message: ui.history.error, messageKind: "error", retry: () => { ui.history = null; render(); } });
      const restore = async (v) => {
        if (!(await confirmSheet({ title: `Put this machine back to how it was on ${fmtWhen(v.savedAt)}?`, text: "What's there now is saved first, so this can be undone too.", confirmLabel: "Restore" }))) return;
        if (await act(() => callRestoreMachineSpecsVersion({ machineId: m.id, versionId: v.id }), () => restore(v))) { Object.assign(ui, { history: null, removed: null }); toast("Restored"); render(); }
      };
      const putBack = async (r) => {
        if (await act(() => callRestoreMachineSpecItem({ machineId: m.id, removedId: r.id }), () => putBack(r))) { Object.assign(ui, { history: null, removed: null }); toast("Put back"); render(); }
      };
      return [
        el("h3", {}, "Removed (kept 30 days)"),
        ui.removed?.length
          ? el("div", { class: "spec-list" }, ui.removed.map((r) => el("div", { class: "spec-row hist" },
              el("span", {}, el("strong", {}, breakable(rowTitle(r.section, r.row || {}))), el("span", { class: "person-meta" }, `${label(r.section)} · removed ${fmtWhen(r.removedAt)} by ${r.removedByName || r.removedBy}`)),
              editor() ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => putBack(r) }, "Put back") : null)))
          : el("p", { class: "card-note" }, "Nothing removed in the last 30 days."),
        el("h3", {}, "Earlier versions"),
        ui.history.length
          ? el("div", { class: "spec-list" }, ui.history.map((v) => el("div", { class: "spec-row hist" },
              el("span", {}, el("strong", {}, `Before: ${v.reason || "a change"}`), el("span", { class: "person-meta" }, `${fmtWhen(v.savedAt)} · ${v.savedByName || v.savedBy}`)),
              editor() ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => restore(v) }, "Restore") : null)))
          : el("p", { class: "card-note" }, "No earlier versions yet."),
      ];
    };
    return collapsible("mach-history", "🕘 History & removed items", body());
  }

  function renderMachine() {
    const m = machine();
    const backBtn = back("Machines", () => show(null));
    if (!data.machines || !data.machineSpecs) return [backBtn, spinner()];
    if (!m) return [backBtn, emptyState("Machine not found", `There's no machine ${ui.machineId || ""} in the app.`)];
    const s = spec(m.id);
    const down = machineDown(m);
    return [
      backBtn,
      el("div", { class: "mach-head" },
        el("h1", { class: "fix-title" }, breakable(m.name)),
        el("span", { class: "tags" }, down ? el("span", { class: "tag off" }, "⛔ Down") : el("span", { class: "tag ok" }, "✓ Running"), openFor(m.id).length ? el("span", { class: "tag" }, `🚨 ${openFor(m.id).length} open`) : null)),
      el("p", { class: "hint" }, [m.id, m.lineId ? lineName(m.lineId) : "Shared", (data.machineTypes || []).find((t) => t.id === m.type)?.name || m.type].filter(Boolean).join(" · ")),
      banner(ui),
      data.machineSpecsError ? banner({ message: "Couldn't load the parts lists. Check Wi-Fi, then reopen this page.", messageKind: "error" }) : null,
      pinnedNotes(m, s),
      el("div", { class: "mach-cols" },
        el("div", { class: "mach-col" }, infoFold(m, s), SECTIONS.map((sec) => sectionFold(m, s, sec)), filesFold(m, s)),
        el("div", { class: "mach-col" }, appCard(m), editor() ? copyFold(m, s) : null, historyFold(m, s), lastChange(s))),
      !editor() ? el("p", { class: "hint" }, "View only. Maintenance and Admin keep these lists up to date.") : null,
    ];
  }

  function render() {
    container.replaceChildren(...[ui.machineId ? renderMachine() : renderList()].flat(4).filter(Boolean));
  }

  render();
  // Live updates redraw the page — except while someone is typing in an edit form (their typing isn't lost).
  return onDataChange(() => { if (!ui.edit && !ui.info) render(); });
}
