// Admin setup screens: Lines & machines, Machine types, Teams, and Roles ("lines are data, not code" — Plan §5).
// Lists come live from the database (data.js); every change goes through the server, which
// checks it, records it in the audit log, and only lets admins do it.
// Nothing is deleted — lines, machines, and roles are retired so history never points at nothing.

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, picker } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import { rolePosts } from "./announcements.js";
import { roleEditsMachines } from "./machines.js";
import { rolePostsTrucks } from "./trucks.js";
import { callAdminSaveLine, callAdminSaveMachine, callAdminSaveRole, callAdminSaveTeam, callAdminSaveMachineType, callAdminListEmployees } from "./firebase.js";

// The starting roles from the plan (§5). Ids are permanent; names can be edited later.
const STARTING_ROLES = [
  ["operator", "Operator"],
  ["lead", "Line Lead"],
  ["supervisor", "Supervisor"],
  ["plant-manager", "Production Manager"],
  ["maintenance", "Maintenance"],
  ["quality", "Quality"],
  ["shipping", "Logistics & Distribution"],
  ["sales", "Sales"],
  ["office", "Office"],
  ["training-safety", "Training & Safety"],
  ["admin", "Admin"],
];

// Shared bits for both screens: busy/message state, a server-call wrapper, and redraw on live changes.
function screenKit(container, render, isEditing) {
  const kit = { busy: false, message: "", messageKind: "", retry: null };
  // Success goes to a toast; errors and notes stay on the screen.
  kit.say = (message = "", messageKind = "") => {
    Object.assign(kit, { message: messageKind === "ok" ? "" : message, messageKind, retry: null });
    if (messageKind === "ok" && message) toast(message);
  };
  kit.messageBox = () => banner(kit);
  kit.back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: kit.busy }, `← ${label}`);
  // Runs a server call. Returns its data, or null after showing the error. `again` = what "Try again" runs.
  kit.act = async (fn, again = null) => {
    Object.assign(kit, { busy: true, message: "", messageKind: "", retry: null });
    render();
    try {
      const { data: result } = await fn();
      kit.busy = false;
      return result;
    } catch (err) {
      Object.assign(kit, { busy: false, message: friendlyError(err), messageKind: "error", retry: again });
      render();
      return null;
    }
  };
  kit.draw = (content) => container.replaceChildren(...content.flat().filter(Boolean));
  // Redraw when someone changes the lists — but not mid-typing in a form, which would lose your place.
  kit.stop = onDataChange(() => { if (!kit.busy && !isEditing()) render(); });
  return kit;
}

function loading() {
  return spinner();
}

function retiredTag(record) {
  return record.active === false ? el("span", { class: "tag off" }, "Retired") : null;
}

function row(title, meta, tags, onclick) {
  return el(
    "button",
    { class: "person-row", type: "button", onclick },
    el("span", { class: "person-name" }, title),
    meta ? el("span", { class: "person-meta" }, meta) : null,
    el("span", { class: "tags" }, tags)
  );
}

// Active first, retired last.
function activeFirst(list) {
  return [...list.filter((r) => r.active !== false), ...list.filter((r) => r.active === false)];
}

// Reads a pasted list of machine names, one per row, e.g. copied from Odoo's Equipment list.
// "L2-Puller" -> Line 2, name "Puller", type "Puller". "L1-Cooling Tank 2" -> type "Cooling Tank".
// No "L<number>-" in front -> not on a line (plant equipment). Anything after a tab (other columns) is ignored.
// Each row says whether its line exists yet and whether the machine is already in the app (so it's skipped).
export function parseMachineList(text, lines, machines) {
  const rows = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const cell = raw.split("\t")[0].trim().replace(/\s+/g, " ");
    if (!cell) continue;
    const match = cell.match(/^L(\d+)\s*[-–]\s*(.+)$/i);
    const lineLabel = match ? `Line ${Number(match[1])}` : null;
    const name = (match ? match[2] : cell).trim().slice(0, 60);
    const type = name.replace(/\s+\d+$/, "");
    const line = lineLabel ? lines.find((l) => l.name.toLowerCase() === lineLabel.toLowerCase()) : null;
    const key = `${(lineLabel || "").toLowerCase()}|${name.toLowerCase()}`;
    const inApp = machines.some(
      (m) => (m.lineId || null) === (line?.id || null) && (lineLabel ? !!line : true) && m.name.toLowerCase() === name.toLowerCase()
    );
    rows.push({ lineLabel, lineId: line?.id || null, newLine: !!lineLabel && !line, name, type, skip: inApp || seen.has(key), inApp });
    seen.add(key);
  }
  // Line 1 first, then Line 2, …, then plant equipment; pasted order kept within each.
  const lineNo = (r) => (r.lineLabel ? Number(r.lineLabel.slice(5)) : Infinity);
  return rows.map((r, i) => ({ ...r, i })).sort((a, b) => lineNo(a) - lineNo(b) || a.i - b.i);
}

// ===========================================================================
// Lines & machines
// ===========================================================================

export function openLines(container, { onExit }) {
  const ui = { view: "lines", lineId: null, machineId: null, draft: null };
  const kit = screenKit(container, render, () => ui.view.endsWith("Form"));

  function show(view, message = "", kind = "") {
    ui.view = view;
    kit.say(message, kind);
    render();
  }

  const machinesOn = (lineId) => (data.machines || []).filter((m) => (m.lineId || null) === lineId);
  const line = (id = ui.lineId) => data.lines?.find((l) => l.id === id);
  const machine = () => data.machines?.find((m) => m.id === ui.machineId);

  // ---- All lines ----------------------------------------------------------

  function renderLines() {
    if (!data.lines || !data.machines) return [kit.back("Admin", onExit), el("h1", {}, "Lines & machines"), loading()];
    const spare = machinesOn(null);
    return [
      kit.back("Admin", onExit),
      el("h1", {}, "Lines & machines"),
      el("p", { class: "hint" }, `${data.lines.filter((l) => l.active !== false).length} lines · ${data.machines.filter((m) => m.active !== false).length} machines`),
      kit.messageBox(),
      el("button", { class: "btn", type: "button", onclick: () => startLineForm(null) }, "+ Add a line"),
      el("button", { class: "btn secondary", type: "button", onclick: startImport }, "📋 Paste a list of machines (e.g. from Odoo)"),
      el(
        "div",
        { class: "person-list" },
        activeFirst(data.lines).map((l) => {
          const count = machinesOn(l.id).filter((m) => m.active !== false).length;
          return row(l.name, [l.building || "Building not set", `${count} ${count === 1 ? "machine" : "machines"}`].join(" · "), [retiredTag(l)], () => openLine(l.id));
        }),
        spare.length ? row("Shared / not on a line", `${spare.length} — shared, spares, or in storage`, [], () => openLine(null)) : null
      ),
      data.lines.length === 0 ? emptyState("No lines yet", "Add Line 1 to start — machines go on lines. Or paste a list of machines from Odoo and the lines are made for you.") : null,
    ];
  }

  function openLine(lineId) {
    ui.lineId = lineId;
    show("line");
  }

  // ---- One line and its machines -----------------------------------------

  function renderLine() {
    const l = ui.lineId ? line() : null;
    if (ui.lineId && !l) return renderLines();
    const list = activeFirst(machinesOn(ui.lineId));
    return [
      kit.back("Lines & machines", () => show("lines")),
      el("h1", {}, l ? l.name : "Shared / not on a line"),
      l ? el("p", { class: "roles" }, l.building || "Building not set") : null,
      l ? el("p", { class: "tags center" }, retiredTag(l)) : null,
      kit.messageBox(),
      el("button", { class: "btn", type: "button", onclick: () => startMachineForm(null, ui.lineId) }, "+ Add a machine"),
      el(
        "div",
        { class: "person-list" },
        list.map((m) => row(`${m.id} · ${m.name}`, m.type || null, [retiredTag(m)], () => { ui.machineId = m.id; show("machine"); }))
      ),
      list.length === 0 ? emptyState("No machines here yet", "Tap “+ Add a machine” — each one gets its permanent M-number.") : null,
      l ? el("button", { class: "btn secondary", type: "button", onclick: () => startLineForm(l), disabled: kit.busy }, "✎ Edit name or building") : null,
      l
        ? el(
            "button",
            { class: l.active === false ? "btn secondary" : "btn danger", type: "button", onclick: () => setLineActive(l, l.active === false), disabled: kit.busy },
            l.active === false ? "↺ Bring line back" : "Retire line"
          )
        : null,
    ];
  }

  async function setLineActive(l, active, askFirst = true) {
    const ok = !askFirst || (await confirmSheet(active
      ? { title: `Bring ${l.name} back?`, confirmLabel: "Bring it back" }
      : { title: `Retire ${l.name}?`, text: "It stays in history but is hidden from everyday screens. Its machines stay on it — move them first if they're going elsewhere.", confirmLabel: "Retire line", danger: true }));
    if (!ok) return;
    if (await kit.act(() => callAdminSaveLine({ id: l.id, name: l.name, building: l.building || "", active }), () => setLineActive(l, active, false))) {
      show("line", active ? "Line is back" : "Line retired", "ok");
    }
  }

  // ---- Add / rename a line ------------------------------------------------

  function startLineForm(existing, building = "") {
    ui.draft = { id: existing?.id || null, name: existing?.name || "", building: existing?.building || building };
    show("lineForm");
  }

  function renderLineForm() {
    const d = ui.draft;
    // `again` = keep the form open for the next line (same building).
    async function save(e, again = false) {
      e?.preventDefault();
      const payload = { name: d.name, building: d.building };
      const result = await kit.act(() =>
        d.id ? callAdminSaveLine({ id: d.id, ...payload }) : callAdminSaveLine({ create: true, ...payload }), () => save(null, again)
      );
      if (!result) return;
      if (again) {
        kit.say(`${d.name.trim()} added`, "ok");
        startLineForm(null, d.building);
        document.getElementById("f-line")?.focus();
        return;
      }
      ui.lineId = result.id;
      show("line", d.id ? "Saved" : "Line added", "ok");
    }
    const buildings = [...new Set((data.lines || []).map((l) => l.building).filter(Boolean))].sort();
    return [
      kit.back(d.id ? "Back" : "Lines & machines", () => show(d.id ? "line" : "lines")),
      el("h1", {}, d.id ? "Edit line" : "Add a line"),
      kit.messageBox(),
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "f-line" }, "Line name (e.g. Line 4)"),
        el("input", { class: "field", id: "f-line", autocomplete: "off", maxlength: "60", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("label", { class: "field-label", for: "f-building" }, "Building (e.g. Main plant, New building)"),
        el("input", { class: "field", id: "f-building", autocomplete: "off", maxlength: "60", value: d.building, oninput: (e) => { d.building = e.target.value; } }),
        buildings.length
          ? el("div", { class: "chips" }, buildings.map((b) => el("button", { class: d.building === b ? "chip on" : "chip", type: "button", onclick: () => { d.building = b; render(); } }, b)))
          : null,
        el("button", { class: "btn", type: "submit", disabled: kit.busy }, kit.busy ? "Saving…" : d.id ? "Save" : "Add line"),
        d.id ? null : el("button", { class: "btn secondary", type: "button", disabled: kit.busy, onclick: () => save(null, true) }, "+ Save & add another line")
      ),
    ];
  }

  // ---- One machine --------------------------------------------------------

  function renderMachine() {
    const m = machine();
    if (!m) return renderLine();
    return [
      kit.back(m.lineId ? lineName(m.lineId) : "Shared / not on a line", () => { ui.lineId = m.lineId || null; show("line"); }),
      el("div", { class: "machine-id" }, m.id),
      el("h1", {}, m.name),
      el("p", { class: "roles" }, [m.type, m.lineId ? lineName(m.lineId) : "Shared / not on a line"].filter(Boolean).join(" · ")),
      el("p", { class: "tags center" }, retiredTag(m)),
      kit.messageBox(),
      el("table", { class: "info-table" },
        [["Make", m.make], ["Model", m.model], ["Serial number", m.serial], ["Building", m.lineId ? line(m.lineId)?.building : ""], ["Notes", m.notes]]
          .filter(([, v]) => v)
          .map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", { class: "keep-lines" }, v)))),
      el("div", { class: "card" }, "This ID never changes. Use it in Odoo (equipment reference) and on the machine's QR sticker."),
      el("button", { class: "btn secondary", type: "button", onclick: () => startMachineForm(m), disabled: kit.busy }, "✎ Edit details or move to another line"),
      el(
        "button",
        { class: m.active === false ? "btn secondary" : "btn danger", type: "button", onclick: () => setMachineActive(m, m.active === false), disabled: kit.busy },
        m.active === false ? "↺ Bring machine back" : "Retire machine"
      ),
    ];
  }

  async function setMachineActive(m, active, askFirst = true) {
    const ok = !askFirst || (await confirmSheet(active
      ? { title: `Bring ${m.id} ${m.name} back?`, confirmLabel: "Bring it back" }
      : { title: `Retire ${m.id} ${m.name}?`, text: "It stays in history (and keeps its ID — it's never given to another machine) but is hidden from everyday screens.", confirmLabel: "Retire machine", danger: true }));
    if (!ok) return;
    const done = await kit.act(
      () => callAdminSaveMachine({ id: m.id, name: m.name, type: m.type || "", lineId: m.lineId || null, active }),
      () => setMachineActive(m, active, false)
    );
    if (done) show("machine", active ? "Machine is back" : "Machine retired", "ok");
  }

  // ---- Add / edit a machine -----------------------------------------------

  const blankDetails = { make: "", model: "", serial: "", notes: "" };
  function startMachineForm(existing, lineId = null, type = "") {
    ui.draft = existing
      ? { id: existing.id, name: existing.name, type: existing.type || "", lineId: existing.lineId || "", make: existing.make || "", model: existing.model || "", serial: existing.serial || "", notes: existing.notes || "" }
      : { id: null, name: "", type, lineId: lineId || "", ...blankDetails };
    show("machineForm");
  }

  // The ID the next new machine will get (the server hands it out; numbers are never reused).
  function nextMachineId() {
    const top = Math.max(0, ...(data.machines || []).map((m) => Number(m.id.slice(2)) || 0));
    return `M-${String(top + 1).padStart(3, "0")}`;
  }

  function renderMachineForm() {
    const d = ui.draft;
    const typeList = (data.machineTypes || []).filter((t) => t.active !== false || t.name === d.type).map((t) => t.name).sort();
    const lineChoices = (data.lines || []).filter((l) => l.active !== false || l.id === d.lineId);

    // `again` = keep the form open for the next machine (same type and line, other fields cleared).
    async function save(e, again = false) {
      e?.preventDefault();
      const payload = { name: d.name, type: d.type, lineId: d.lineId || null, make: d.make, model: d.model, serial: d.serial, notes: d.notes };
      const result = await kit.act(() =>
        d.id ? callAdminSaveMachine({ id: d.id, ...payload }) : callAdminSaveMachine({ create: true, ...payload }), () => save(null, again)
      );
      if (!result) return;
      if (again) {
        kit.say(`Added ${d.name.trim()} as ${result.id}`, "ok");
        startMachineForm(null, d.lineId, d.type);
        document.getElementById("f-mname")?.focus();
        return;
      }
      ui.machineId = result.id;
      show("machine", d.id ? "Saved" : `Added as ${result.id}`, "ok");
    }
    const text = (id, label, key, max = "60") => [
      el("label", { class: "field-label", for: id }, label),
      el("input", { class: "field", id, autocomplete: "off", maxlength: max, value: d[key], oninput: (e) => { d[key] = e.target.value; } }),
    ];

    return [
      kit.back(d.id ? d.id : d.lineId ? lineName(d.lineId) : "Shared / not on a line", () => show(d.id ? "machine" : "line")),
      el("h1", {}, d.id ? `Edit ${d.id}` : "Add a machine"),
      d.id ? null : el("p", { class: "hint" }, `It will get ID ${nextMachineId()} when you save (IDs are permanent and never reused).`),
      kit.messageBox(),
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "f-mname" }, "Machine name (e.g. Extruder 1)"),
        el("input", { class: "field", id: "f-mname", autocomplete: "off", maxlength: "60", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("label", { class: "field-label", for: "f-type" }, "Type"),
        typeList.length
          ? picker({ id: "f-type", title: "Machine type", value: d.type, placeholder: "Pick a type…", options: typeList.map((t) => ({ value: t, label: t })), onChange: (v) => { d.type = v; render(); } })
          : el("p", { class: "message" }, "No machine types yet — add them in Admin → Machine types first."),
        el("label", { class: "field-label", for: "f-line" }, "Line"),
        picker({
          id: "f-line", title: "Line", value: d.lineId || "",
          options: [{ value: "", label: "Shared / not on a line" }, ...lineChoices.map((l) => ({ value: l.id, label: `${l.name}${l.building ? ` (${l.building})` : ""}` }))],
          onChange: (v) => { d.lineId = v; render(); },
        }),
        text("f-make", "Make (optional)", "make"),
        text("f-model", "Model (optional)", "model"),
        text("f-serial", "Serial number (optional)", "serial"),
        el("label", { class: "field-label", for: "f-notes" }, "Notes (optional)"),
        el("textarea", { class: "field", id: "f-notes", rows: "3", maxlength: "1000", value: d.notes, oninput: (e) => { d.notes = e.target.value; } }),
        el("button", { class: "btn", type: "submit", disabled: kit.busy }, kit.busy ? "Saving…" : d.id ? "Save" : "Add machine"),
        d.id ? null : el("button", { class: "btn secondary", type: "button", disabled: kit.busy, onclick: () => save(null, true) }, "+ Save & add another machine")
      ),
    ];
  }

  // ---- Paste a list of machines (e.g. from Odoo) --------------------------

  function startImport() {
    ui.importText = ui.importText || "";
    ui.progress = "";
    show("importForm");
  }

  function previewRows() {
    return parseMachineList(ui.importText, data.lines || [], data.machines || []);
  }

  function previewList() {
    const rows = previewRows();
    if (!rows.length) return [emptyState("Nothing to add yet", "Paste names above — one machine per line.")];
    const adding = rows.filter((r) => !r.skip);
    const newLines = [...new Set(adding.filter((r) => r.newLine).map((r) => r.lineLabel))];
    return [
      el(
        "p",
        { class: "hint" },
        `${adding.length} to add` +
          (rows.length > adding.length ? ` · ${rows.length - adding.length} already in the app (skipped)` : "") +
          (newLines.length ? ` · new: ${newLines.join(", ")}` : "")
      ),
      el(
        "div",
        { class: "import-preview" },
        rows.map((r) =>
          el(
            "div",
            { class: r.skip ? "import-row skip" : "import-row" },
            el("span", { class: "import-line" }, r.lineLabel ? `${r.lineLabel}${r.newLine ? " (new)" : ""}` : "Not on a line"),
            el("span", {}, r.name),
            r.skip ? el("span", { class: "tag" }, r.inApp ? "Already in app" : "Listed twice") : null
          )
        )
      ),
    ];
  }

  async function runImport() {
    const rows = previewRows().filter((r) => !r.skip);
    if (!rows.length) return;
    const lineIds = new Map(); // "Line 2" -> id, for lines created during this import
    let done = 0;
    const result = await kit.act(async () => {
      for (const label of [...new Set(rows.filter((r) => r.newLine).map((r) => r.lineLabel))]) {
        ui.progress = `Adding ${label}…`;
        render();
        const { data: line } = await callAdminSaveLine({ create: true, name: label });
        lineIds.set(label, line.id);
      }
      for (const r of rows) {
        ui.progress = `Adding machine ${done + 1} of ${rows.length}: ${r.name}`;
        render();
        await callAdminSaveMachine({ create: true, name: r.name, type: r.type, lineId: r.lineId || lineIds.get(r.lineLabel) || null });
        // (The type must be on Admin → Machine types; a new type stops the paste with a clear message.)
        done++;
      }
      return { data: true };
    }, runImport);
    ui.progress = "";
    if (result) {
      ui.importText = "";
      show("lines", `Added ${done} machines`, "ok");
    } else if (done) {
      // Stopped part-way: the rest can be added by pasting again — what's already in is skipped.
      const why = kit.message;
      kit.say(`${why} ${done} were added before it stopped. Tap Try again to add the rest — ones already in are skipped.`, "error");
      kit.retry = runImport;
      render();
    }
  }

  function renderImport() {
    const preview = el("div", {}, previewList());
    const box = el("textarea", {
      class: "field paste-box", id: "f-paste", rows: "8", spellcheck: "false",
      placeholder: "L1-Extruder\nL1-Vacuum Tank\nL2-Puller\nGrinder",
      value: ui.importText,
      // Update only the preview while typing, so the text box keeps its place.
      oninput: (e) => { ui.importText = e.target.value; preview.replaceChildren(...previewList()); },
    });
    return [
      kit.back("Lines & machines", () => show("lines")),
      el("h1", {}, "Paste a list of machines"),
      el("p", { class: "hint" }, "One machine per line. \"L2-Puller\" goes on Line 2 as \"Puller\"; names without L1-, L2-… are added as Not on a line. Each gets the next M-number."),
      kit.messageBox(),
      ui.progress ? spinner(ui.progress) : null,
      el("label", { class: "field-label", for: "f-paste" }, "Machine names"),
      box,
      preview,
      el("button", { class: "btn", type: "button", onclick: runImport, disabled: kit.busy }, kit.busy ? "Adding…" : "+ Add all"),
    ];
  }

  function render() {
    const views = {
      lines: renderLines, line: renderLine, lineForm: renderLineForm,
      machine: renderMachine, machineForm: renderMachineForm, importForm: renderImport,
    };
    kit.draw((views[ui.view] || renderLines)());
  }

  render();
  return () => kit.stop();
}

// ===========================================================================
// Roles, Teams, Machine types — the same simple list: add, rename (not types), retire / bring back.
// Nothing is deleted. "Save & add another" keeps the form open for fast entry.
// ===========================================================================

const STARTING_TEAMS = [["team-a", "A"], ["team-b", "B"], ["team-c", "C"], ["team-d", "D"]];

function openNamedList(container, { onExit, cfg }) {
  const ui = { view: "list", itemId: null, draft: null };
  const kit = screenKit(container, render, () => ui.view === "form");

  function show(view, message = "", kind = "") {
    ui.view = view;
    kit.say(message, kind);
    render();
  }

  const items = () => cfg.items();
  const item = () => items()?.find((r) => r.id === ui.itemId);

  async function addStarters() {
    const starters = cfg.starters();
    const existing = new Set((items() || []).map((r) => r.id));
    const names = new Set((items() || []).map((r) => r.name.toLowerCase()));
    const missing = starters.filter(([id, name]) => !existing.has(id) && !names.has(name.toLowerCase()));
    const ok = await kit.act(async () => {
      for (const [id, name] of missing) await cfg.save({ create: true, id, name });
      return { data: true };
    }, addStarters);
    if (ok) show("list", `Added ${missing.length} ${cfg.plural}`, "ok");
  }

  function renderList() {
    if (!items()) return [kit.back("Admin", onExit), el("h1", {}, cfg.title), loading()];
    const starters = cfg.starters();
    const names = new Set(items().map((r) => r.name.toLowerCase()));
    const missingStarters = starters.filter(([, name]) => !names.has(name.toLowerCase()));
    return [
      kit.back("Admin", onExit),
      el("h1", {}, cfg.title),
      el("p", { class: "hint" }, cfg.hint),
      kit.messageBox(),
      missingStarters.length
        ? el(
            "div",
            { class: "card" },
            el("strong", {}, cfg.startersTitle),
            el("p", { class: "card-note" }, missingStarters.map(([, name]) => name).join(" · ")),
            el("button", { class: "btn", type: "button", onclick: addStarters, disabled: kit.busy }, kit.busy ? "Adding…" : `+ Add ${missingStarters.length === starters.length ? "them" : "the missing ones"}`)
          )
        : null,
      el("button", { class: "btn secondary", type: "button", onclick: () => startForm(null), disabled: kit.busy }, `+ Add ${cfg.a}`),
      el("div", { class: "person-list" }, activeFirst(items()).map((r) => row(r.name, cfg.meta ? cfg.meta(r) : null, [retiredTag(r)], () => { ui.itemId = r.id; show("item"); }))),
      items().length === 0 && !missingStarters.length ? emptyState(`No ${cfg.plural} yet`, `Tap “+ Add ${cfg.a}”.`) : null,
    ];
  }

  function renderItem() {
    const r = item();
    if (!r) return renderList();
    const locked = cfg.cantRetire?.(r);
    return [
      kit.back(cfg.title, () => show("list")),
      el("h1", {}, r.name),
      cfg.meta ? el("p", { class: "roles" }, cfg.meta(r)) : null,
      el("p", { class: "tags center" }, retiredTag(r)),
      kit.messageBox(),
      cfg.members ? cfg.members(r, { kit, show }) : null,
      cfg.rename ? el("button", { class: "btn secondary", type: "button", onclick: () => startForm(r), disabled: kit.busy }, `✎ Rename ${cfg.noun}`) : el("p", { class: "hint" }, cfg.noRenameNote),
      locked
        ? el("p", { class: "hint" }, locked)
        : el(
            "button",
            { class: r.active === false ? "btn secondary" : "btn danger", type: "button", onclick: () => setActive(r, r.active === false), disabled: kit.busy },
            r.active === false ? `↺ Bring ${cfg.noun} back` : `Retire ${cfg.noun}`
          ),
    ];
  }

  async function setActive(r, active, askFirst = true) {
    const ok = !askFirst || (await confirmSheet(active
      ? { title: `Bring ${r.name} back?`, confirmLabel: "Bring it back" }
      : { title: `Retire ${r.name}?`, text: cfg.retireText, confirmLabel: `Retire ${cfg.noun}`, danger: true }));
    if (!ok) return;
    const payload = cfg.rename ? { id: r.id, name: r.name, active } : { id: r.id, active };
    if (await kit.act(() => cfg.save(payload), () => setActive(r, active, false))) {
      show("item", active ? `${r.name} is back` : `${r.name} retired`, "ok");
    }
  }

  function startForm(existing) {
    ui.draft = { id: existing?.id || null, name: existing?.name || "" };
    show("form");
  }

  function renderForm() {
    const d = ui.draft;
    async function save(e, again = false) {
      e?.preventDefault();
      const result = await kit.act(() => (d.id ? cfg.save({ id: d.id, name: d.name }) : cfg.save({ create: true, name: d.name })), () => save(null, again));
      if (!result) return;
      if (again) {
        kit.say(`${d.name.trim()} added`, "ok");
        startForm(null);
        document.getElementById("f-named")?.focus();
        return;
      }
      ui.itemId = result.id;
      show("item", d.id ? "Saved" : `${d.name.trim()} added`, "ok");
    }
    return [
      kit.back(d.id ? "Back" : cfg.title, () => show(d.id ? "item" : "list")),
      el("h1", {}, d.id ? `Rename ${cfg.noun}` : `Add ${cfg.a}`),
      kit.messageBox(),
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "f-named" }, cfg.nameLabel),
        el("input", { class: "field", id: "f-named", autocomplete: "off", maxlength: "60", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("button", { class: "btn", type: "submit", disabled: kit.busy }, kit.busy ? "Saving…" : d.id ? "Save" : `Add ${cfg.noun}`),
        d.id ? null : el("button", { class: "btn secondary", type: "button", disabled: kit.busy, onclick: () => save(null, true) }, `+ Save & add another`)
      ),
    ];
  }

  function render() {
    const views = { list: renderList, item: renderItem, form: renderForm };
    kit.draw((views[ui.view] || renderList)());
  }

  render();
  cfg.init?.(render);
  return () => kit.stop();
}

export function openRoles(container, { onExit }) {
  return openNamedList(container, {
    onExit,
    cfg: {
      title: "Roles", noun: "role", a: "a role", plural: "roles", nameLabel: "Role name (e.g. Quality)",
      hint: "A person's roles decide what shows on their home screen and what they can do.",
      items: () => data.roles, save: callAdminSaveRole, rename: true,
      meta: (r) => [rolePosts(r) ? "📣 Can post announcements" : null, roleEditsMachines(r) ? "⚙ Can edit machines" : null, rolePostsTrucks(r) ? "🚚 Can post trucks" : null].filter(Boolean).join(" · ") || null,
      // Who may post announcements (Decision 58). Starts on for Admin, Production Manager, Supervisor, Training & Safety, Office.
      members: (r, { kit, show }) => {
        const on = rolePosts(r);
        const flip = async () => {
          const ok = await kit.act(() => callAdminSaveRole({ id: r.id, name: r.name, canPostAnnouncements: !on }), flip);
          if (ok) show("item", on ? `${r.name}: posting announcements turned off` : `${r.name} can now post announcements`, "ok");
        };
        // Which forms people with this role may edit in Forms (Decision 60). Admins edit every form.
        const editing = r.editForms || [];
        const toggleForm = async (formId) => {
          const next = editing.includes(formId) ? editing.filter((x) => x !== formId) : [...editing, formId];
          const ok = await kit.act(() => callAdminSaveRole({ id: r.id, name: r.name, editForms: next }), () => toggleForm(formId));
          if (ok) show("item", `${r.name}: forms they can edit updated`, "ok");
        };
        const forms = (data.formTemplates || []).filter((t) => t.active !== false);
        // Who may post the day's trucks (Trucks board). Starts on for Logistics & Distribution.
        const postsTrucks = rolePostsTrucks(r);
        const flipTrucks = async () => {
          const ok = await kit.act(() => callAdminSaveRole({ id: r.id, name: r.name, postTrucks: !postsTrucks }), flipTrucks);
          if (ok) show("item", postsTrucks ? `${r.name}: posting trucks turned off` : `${r.name} can now post trucks`, "ok");
        };
        // Who may add and edit machine parts & specs (Decision 51). Starts on for Maintenance and Admin.
        const edits = roleEditsMachines(r);
        const flipMachines = async () => {
          const ok = await kit.act(() => callAdminSaveRole({ id: r.id, name: r.name, editMachines: !edits }), flipMachines);
          if (ok) show("item", edits ? `${r.name}: editing machines turned off` : `${r.name} can now edit machines`, "ok");
        };
        return [
          el("div", { class: "card" },
            el("strong", {}, "📣 Announcements"),
            el("p", { class: "card-note" }, on ? "People with this role can post announcements." : "People with this role can't post announcements."),
            el("button", { class: on ? "btn secondary" : "btn", type: "button", disabled: kit.busy, onclick: flip }, on ? "Turn off posting" : "✔ Allow posting")),

          el("div", { class: "card" },
            el("strong", {}, "⚙ Machines"),
            el("p", { class: "card-note" }, edits ? "People with this role can add and edit machine parts, specs, photos, and notes." : "People with this role can't edit machines. (Maintenance, Production Manager, and Admin can always view them.)"),
            el("button", { class: edits ? "btn secondary" : "btn", type: "button", disabled: kit.busy, onclick: flipMachines }, edits ? "Turn off editing" : "✔ Allow editing")),
          el("div", { class: "card" },
            el("strong", {}, "🚚 Trucks"),
            el("p", { class: "card-note" }, postsTrucks ? "People with this role post the day's trucks (add, edit, copy from yesterday) and get a notification when one arrives or leaves." : "People with this role can't post trucks. (Logistics & Distribution always checks trucks off.)"),
            el("button", { class: postsTrucks ? "btn secondary" : "btn", type: "button", disabled: kit.busy, onclick: flipTrucks }, postsTrucks ? "Turn off posting" : "✔ Allow posting")),
          el("div", { class: "card" },
            el("strong", {}, "📝 Forms this role can edit"),
            r.id === "admin"
              ? el("p", { class: "card-note" }, "Admins can edit every form.")
              : [
                  el("p", { class: "card-note" }, forms.length ? "Tap a form to let people with this role edit it (fields, order, help text). Every change is a new revision." : "No forms yet — an admin loads them in Admin → Forms."),
                  el("div", { class: "chips" }, forms.map((t) => el("button", { class: editing.includes(t.id) ? "chip on" : "chip", type: "button", "aria-pressed": String(editing.includes(t.id)), disabled: kit.busy, onclick: () => toggleForm(t.id) }, `${editing.includes(t.id) ? "✓ " : ""}${t.name}`))),
                ]),
        ];
      },
      starters: () => STARTING_ROLES, startersTitle: "Add the starting roles",
      cantRetire: (r) => (r.id === "admin" ? "The Admin role can't be retired — someone has to be able to run the app." : null),
      retireText: "It can't be given to anyone new. People who already have it keep it until you edit them.",
    },
  });
}

export function openTeams(container, { onExit }) {
  // Everyone (from the People list) so each team's page can show who's on it.
  let people = null;
  let loadError = "";
  const onTeam = (t) => (people || []).filter((p) => p.team === t.id && p.active).sort((a, b) => a.name.localeCompare(b.name));
  const roleNames = (ids) => ids.map((id) => data.roles?.find((r) => r.id === id)?.name || id).join(", ");
  return openNamedList(container, {
    onExit,
    cfg: {
      title: "Teams", noun: "team", a: "a team", plural: "teams", nameLabel: "Team name (e.g. A)",
      hint: "Crews (A, B, C, D). Tap a team to see who's on it.",
      items: () => data.teams, save: callAdminSaveTeam, rename: true,
      init: (redraw) => {
        callAdminListEmployees().then(
          ({ data: r }) => { people = r.employees; redraw(); },
          () => { people = []; loadError = "Couldn't load the people list. Go back and open Teams again."; redraw(); }
        );
      },
      meta: (t) => (people ? `${onTeam(t).length} ${onTeam(t).length === 1 ? "person" : "people"}` : "…"),
      members: (t) => {
        if (!people) return spinner("Loading who's on this team…");
        if (loadError) return el("p", { class: "message error" }, loadError);
        const list = onTeam(t);
        if (!list.length) return emptyState("Nobody on this team yet", "Set a person's team in Admin → People.");
        return [
          el("h2", {}, `On Team ${t.name} (${list.length})`),
          el("div", { class: "person-list" }, list.map((p) =>
            el("div", { class: "person-row static" },
              el("span", { class: "person-name" }, p.name),
              el("span", { class: "person-meta" }, [`#${p.employeeNumber}`, p.roles.length ? roleNames(p.roles) : p.position].filter(Boolean).join(" · "))))),
        ];
      },
      starters: () => STARTING_TEAMS, startersTitle: "Add teams A, B, C, D",
      retireText: "It can't be given to anyone new. People on it stay on it until you edit them.",
    },
  });
}

export function openMachineTypes(container, { onExit }) {
  return openNamedList(container, {
    onExit,
    cfg: {
      title: "Machine types", noun: "type", a: "a type", plural: "types", nameLabel: "Type name (e.g. Saw)",
      hint: "The kinds of machines. Fix Library categories and checklists match machines by type.",
      items: () => data.machineTypes, save: callAdminSaveMachineType, rename: false,
      noRenameNote: "Type names can't be changed — fixes and checklists match on them. To use a new name, add a new type.",
      meta: (t) => {
        const n = (data.machines || []).filter((m) => m.type === t.name && m.active !== false).length;
        return `${n} ${n === 1 ? "machine" : "machines"}`;
      },
      // Starting types = the types your machines already have (from the Odoo import).
      starters: () => [...new Set((data.machines || []).map((m) => m.type).filter(Boolean))].sort().map((name) => [null, name]),
      startersTitle: "Add the types your machines already use",
      retireText: "It can't be picked for new machines. Machines that have it keep it.",
    },
  });
}
