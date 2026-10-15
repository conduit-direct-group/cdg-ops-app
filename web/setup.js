// Admin setup screens: Lines & machines, and Roles ("lines are data, not code" — Plan §5).
// Lists come live from the database (data.js); every change goes through the server, which
// checks it, records it in the audit log, and only lets admins do it.
// Nothing is deleted — lines, machines, and roles are retired so history never points at nothing.

import { el, friendlyError } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import { callAdminSaveLine, callAdminSaveMachine, callAdminSaveRole } from "./firebase.js";

// The starting roles from the plan (§5). Ids are permanent; names can be edited later.
const STARTING_ROLES = [
  ["operator", "Operator"],
  ["maintenance", "Maintenance"],
  ["shipping", "Shipping"],
  ["lead", "Production Lead / Supervisor"],
  ["admin", "Admin"],
];

// Shared bits for both screens: busy/message state, a server-call wrapper, and redraw on live changes.
function screenKit(container, render, isEditing) {
  const kit = { busy: false, message: "", messageKind: "" };
  kit.say = (message = "", messageKind = "") => Object.assign(kit, { message, messageKind });
  kit.messageBox = () =>
    kit.message
      ? el("p", { class: `message ${kit.messageKind}`, role: kit.messageKind === "error" ? "alert" : null }, kit.message)
      : null;
  kit.back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: kit.busy }, `← ${label}`);
  // Runs a server call. Returns its data, or null after showing the error.
  kit.act = async (fn) => {
    Object.assign(kit, { busy: true, message: "", messageKind: "" });
    render();
    try {
      const { data: result } = await fn();
      kit.busy = false;
      return result;
    } catch (err) {
      Object.assign(kit, { busy: false, message: friendlyError(err), messageKind: "error" });
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
  return el("p", { class: "hint" }, "Loading…");
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
  const line = () => data.lines?.find((l) => l.id === ui.lineId);
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
      el("button", { class: "btn secondary", type: "button", onclick: startImport }, "Paste a list of machines (e.g. from Odoo)"),
      el(
        "div",
        { class: "person-list" },
        activeFirst(data.lines).map((l) => {
          const count = machinesOn(l.id).filter((m) => m.active !== false).length;
          return row(l.name, `${count} ${count === 1 ? "machine" : "machines"}`, [retiredTag(l)], () => openLine(l.id));
        }),
        spare.length ? row("Not on a line", `${spare.length} — spares, shared, or in storage`, [], () => openLine(null)) : null
      ),
      data.lines.length === 0 ? el("div", { class: "card" }, "No lines yet. Add Line 1 to start — machines go on lines.") : null,
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
      el("h1", {}, l ? l.name : "Not on a line"),
      l ? el("p", { class: "tags center" }, retiredTag(l)) : null,
      kit.messageBox(),
      el("button", { class: "btn", type: "button", onclick: () => startMachineForm(null, ui.lineId) }, "+ Add a machine"),
      el(
        "div",
        { class: "person-list" },
        list.map((m) => row(`${m.id} · ${m.name}`, m.type || null, [retiredTag(m)], () => { ui.machineId = m.id; show("machine"); }))
      ),
      list.length === 0 ? el("p", { class: "hint" }, "No machines here yet.") : null,
      l ? el("button", { class: "btn secondary", type: "button", onclick: () => startLineForm(l), disabled: kit.busy }, "Rename line") : null,
      l
        ? el(
            "button",
            { class: l.active === false ? "btn secondary" : "btn danger", type: "button", onclick: () => setLineActive(l, l.active === false), disabled: kit.busy },
            l.active === false ? "Bring line back" : "Retire line"
          )
        : null,
    ];
  }

  async function setLineActive(l, active) {
    const question = active
      ? `Bring ${l.name} back?`
      : `Retire ${l.name}? It stays in history but is hidden from everyday screens. Its machines stay on it — move them first if they're going elsewhere.`;
    if (!confirm(question)) return;
    if (await kit.act(() => callAdminSaveLine({ id: l.id, name: l.name, active }))) show("line", active ? "Line is back." : "Line retired.", "ok");
  }

  // ---- Add / rename a line ------------------------------------------------

  function startLineForm(existing) {
    ui.draft = { id: existing?.id || null, name: existing?.name || "" };
    show("lineForm");
  }

  function renderLineForm() {
    const d = ui.draft;
    async function save(e) {
      e.preventDefault();
      const result = await kit.act(() =>
        d.id ? callAdminSaveLine({ id: d.id, name: d.name }) : callAdminSaveLine({ create: true, name: d.name })
      );
      if (result) {
        ui.lineId = result.id;
        show("line", d.id ? "Saved." : "Line added.", "ok");
      }
    }
    return [
      kit.back(d.id ? "Back" : "Lines & machines", () => show(d.id ? "line" : "lines")),
      el("h1", {}, d.id ? "Rename line" : "Add a line"),
      kit.messageBox(),
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "f-line" }, "Line name (e.g. Line 1)"),
        el("input", { class: "field", id: "f-line", autocomplete: "off", maxlength: "60", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("button", { class: "btn", type: "submit", disabled: kit.busy }, kit.busy ? "Saving…" : d.id ? "Save" : "Add line")
      ),
    ];
  }

  // ---- One machine --------------------------------------------------------

  function renderMachine() {
    const m = machine();
    if (!m) return renderLine();
    return [
      kit.back(lineName(m.lineId), () => { ui.lineId = m.lineId || null; show("line"); }),
      el("div", { class: "machine-id" }, m.id),
      el("h1", {}, m.name),
      el("p", { class: "roles" }, [m.type, lineName(m.lineId)].filter(Boolean).join(" · ")),
      el("p", { class: "tags center" }, retiredTag(m)),
      kit.messageBox(),
      el("div", { class: "card" }, "This ID never changes. Use it in Odoo (equipment reference) and on the machine's QR sticker."),
      el("button", { class: "btn secondary", type: "button", onclick: () => startMachineForm(m), disabled: kit.busy }, "Edit name, type, or line"),
      el(
        "button",
        { class: m.active === false ? "btn secondary" : "btn danger", type: "button", onclick: () => setMachineActive(m, m.active === false), disabled: kit.busy },
        m.active === false ? "Bring machine back" : "Retire machine"
      ),
    ];
  }

  async function setMachineActive(m, active) {
    const question = active
      ? `Bring ${m.id} ${m.name} back?`
      : `Retire ${m.id} ${m.name}? It stays in history (and keeps its ID) but is hidden from everyday screens.`;
    if (!confirm(question)) return;
    const ok = await kit.act(() => callAdminSaveMachine({ id: m.id, name: m.name, type: m.type || "", lineId: m.lineId || null, active }));
    if (ok) show("machine", active ? "Machine is back." : "Machine retired.", "ok");
  }

  // ---- Add / edit a machine -----------------------------------------------

  function startMachineForm(existing, lineId = null) {
    ui.draft = existing
      ? { id: existing.id, name: existing.name, type: existing.type || "", lineId: existing.lineId || "" }
      : { id: null, name: "", type: "", lineId: lineId || "" };
    show("machineForm");
  }

  function renderMachineForm() {
    const d = ui.draft;
    const types = [...new Set((data.machines || []).map((m) => m.type).filter(Boolean))].sort();
    const lineChoices = (data.lines || []).filter((l) => l.active !== false || l.id === d.lineId);

    async function save(e) {
      e.preventDefault();
      const payload = { name: d.name, type: d.type, lineId: d.lineId || null };
      const result = await kit.act(() =>
        d.id ? callAdminSaveMachine({ id: d.id, ...payload }) : callAdminSaveMachine({ create: true, ...payload })
      );
      if (result) {
        ui.machineId = result.id;
        show("machine", d.id ? "Saved." : `Added as ${result.id}.`, "ok");
      }
    }

    return [
      kit.back(d.id ? d.id : lineName(d.lineId || null), () => show(d.id ? "machine" : "line")),
      el("h1", {}, d.id ? `Edit ${d.id}` : "Add a machine"),
      d.id ? null : el("p", { class: "hint" }, "Its ID (M-001, M-002, …) is given automatically when you save."),
      kit.messageBox(),
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "f-mname" }, "Machine name (e.g. Extruder 1)"),
        el("input", { class: "field", id: "f-mname", autocomplete: "off", maxlength: "60", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("label", { class: "field-label", for: "f-type" }, "Type (optional — e.g. Extruder, Puller, Saw)"),
        el("input", { class: "field", id: "f-type", list: "machine-types", autocomplete: "off", maxlength: "60", value: d.type, oninput: (e) => { d.type = e.target.value; } }),
        el("datalist", { id: "machine-types" }, types.map((t) => el("option", { value: t }))),
        el("label", { class: "field-label", for: "f-line" }, "Line"),
        el(
          "select",
          { class: "field", id: "f-line", onchange: (e) => { d.lineId = e.target.value; } },
          el("option", { value: "" }, "Not on a line"),
          lineChoices.map((l) => el("option", { value: l.id, selected: l.id === d.lineId }, l.name))
        ),
        el("button", { class: "btn", type: "submit", disabled: kit.busy }, kit.busy ? "Saving…" : d.id ? "Save" : "Add machine")
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
    if (!rows.length) return [el("p", { class: "hint" }, "Paste names above — one machine per line.")];
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
        done++;
      }
      return { data: true };
    });
    ui.progress = "";
    if (result) {
      ui.importText = "";
      show("lines", `Added ${done} machines.`, "ok");
    } else if (done) {
      // Stopped part-way: the rest can be added by pasting again — what's already in is skipped.
      kit.say(`${kit.message} ${done} were added before it stopped. Paste again to add the rest — ones already in are skipped.`, "error");
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
      ui.progress ? el("p", { class: "message ok" }, ui.progress) : null,
      el("label", { class: "field-label", for: "f-paste" }, "Machine names"),
      box,
      preview,
      el("button", { class: "btn", type: "button", onclick: runImport, disabled: kit.busy }, kit.busy ? "Adding…" : "Add all"),
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
// Roles
// ===========================================================================

export function openRoles(container, { onExit }) {
  const ui = { view: "list", roleId: null, draft: null };
  const kit = screenKit(container, render, () => ui.view === "form");

  function show(view, message = "", kind = "") {
    ui.view = view;
    kit.say(message, kind);
    render();
  }

  const role = () => data.roles?.find((r) => r.id === ui.roleId);

  async function addStartingRoles() {
    const existing = new Set((data.roles || []).map((r) => r.id));
    const missing = STARTING_ROLES.filter(([id]) => !existing.has(id));
    const ok = await kit.act(async () => {
      for (const [id, name] of missing) await callAdminSaveRole({ create: true, id, name });
      return { data: true };
    });
    if (ok) show("list", "Starting roles added.", "ok");
  }

  function renderList() {
    if (!data.roles) return [kit.back("Admin", onExit), el("h1", {}, "Roles"), loading()];
    const ids = new Set(data.roles.map((r) => r.id));
    const missingStarters = STARTING_ROLES.some(([id]) => !ids.has(id));
    return [
      kit.back("Admin", onExit),
      el("h1", {}, "Roles"),
      el("p", { class: "hint" }, "A person's roles decide what shows on their home screen."),
      kit.messageBox(),
      missingStarters
        ? el(
            "div",
            { class: "card" },
            el("strong", {}, "Add the starting roles"),
            el("p", { class: "card-note" }, STARTING_ROLES.map(([, name]) => name).join(" · ")),
            el("button", { class: "btn", type: "button", onclick: addStartingRoles, disabled: kit.busy }, kit.busy ? "Adding…" : "Add the starting roles")
          )
        : null,
      el("button", { class: "btn secondary", type: "button", onclick: () => startForm(null), disabled: kit.busy }, "+ Add a role"),
      el(
        "div",
        { class: "person-list" },
        activeFirst(data.roles).map((r) => row(r.name, null, [retiredTag(r)], () => { ui.roleId = r.id; show("role"); }))
      ),
    ];
  }

  function renderRole() {
    const r = role();
    if (!r) return renderList();
    return [
      kit.back("Roles", () => show("list")),
      el("h1", {}, r.name),
      el("p", { class: "tags center" }, retiredTag(r)),
      kit.messageBox(),
      el("button", { class: "btn secondary", type: "button", onclick: () => startForm(r), disabled: kit.busy }, "Rename role"),
      r.id === "admin"
        ? el("p", { class: "hint" }, "The Admin role can't be retired — someone has to be able to run the app.")
        : el(
            "button",
            { class: r.active === false ? "btn secondary" : "btn danger", type: "button", onclick: () => setActive(r, r.active === false), disabled: kit.busy },
            r.active === false ? "Bring role back" : "Retire role"
          ),
    ];
  }

  async function setActive(r, active) {
    const question = active
      ? `Bring the ${r.name} role back?`
      : `Retire the ${r.name} role? It can't be given to anyone new. People who already have it keep it until you edit them.`;
    if (!confirm(question)) return;
    if (await kit.act(() => callAdminSaveRole({ id: r.id, name: r.name, active }))) show("role", active ? "Role is back." : "Role retired.", "ok");
  }

  function startForm(existing) {
    ui.draft = { id: existing?.id || null, name: existing?.name || "" };
    show("form");
  }

  function renderForm() {
    const d = ui.draft;
    async function save(e) {
      e.preventDefault();
      const result = await kit.act(() =>
        d.id ? callAdminSaveRole({ id: d.id, name: d.name }) : callAdminSaveRole({ create: true, name: d.name })
      );
      if (result) {
        ui.roleId = result.id;
        show("role", d.id ? "Saved." : "Role added.", "ok");
      }
    }
    return [
      kit.back(d.id ? "Back" : "Roles", () => show(d.id ? "role" : "list")),
      el("h1", {}, d.id ? "Rename role" : "Add a role"),
      kit.messageBox(),
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "f-role" }, "Role name (e.g. Quality)"),
        el("input", { class: "field", id: "f-role", autocomplete: "off", maxlength: "60", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("button", { class: "btn", type: "submit", disabled: kit.busy }, kit.busy ? "Saving…" : d.id ? "Save" : "Add role")
      ),
    ];
  }

  function render() {
    const views = { list: renderList, role: renderRole, form: renderForm };
    kit.draw((views[ui.view] || renderList)());
  }

  render();
  return () => kit.stop();
}
