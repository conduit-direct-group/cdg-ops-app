// Fix Library (Plan Decisions 25–28): search, browse by category, read a fix, add/edit, approve.
// Approved fixes come live from the database (data.js). Every change goes through the server
// (submitFix, reviewFix, retireFix, voteFix), which checks the person's live role.

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, picker, collapsible, breakable } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import {
  db, storage, TEST_MODE, LIVE_HOST, callSubmitFix, callReviewFix, callRetireFix, callVoteFix, callAdminImportOldLibrary,
  callLogSearchGap, callAdminMarkSearchGap, callAdminBulkAddFixes, callDeleteFix, callRestoreFix, callRestoreFixVersion,
  callRestoreTrashedFile, callAdminListEmployees,
} from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { collection, onSnapshot, getDocs, query, where, orderBy, limit } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { issueCard } from "./issues.js";
import { overdueBanner, overdueUnits, unitsForMachine, checklistCard } from "./checklists.js";

const BODY_TEMPLATE = "Symptom:\n\nCause:\n\nFix (steps):\n1. \n";

// Same Microsoft Form the old library's Maintenance Request button opened.
const MAINTENANCE_FORM_URL =
  "https://forms.cloud.microsoft/pages/responsepage.aspx?id=RYTjE-lToUWZ7ucD-FImerLtIR47y8VNk3kCsQnMjW1UMU9UUFlJNkRaRE9LMk9BOEk5NDQzS080RC4u&origin=QRCode&route=shorturl";

// QR codes always point at the live app, even when printed from the test site.
const APP_URL = `https://${LIVE_HOST}`;

// Local QR code maker (no outside service sees the links). Loaded only when the QR page opens.
const QR_LIBRARY = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";

// Attachment filters, like the old library's chips.
const ATTACH_FILTERS = {
  photo: { label: "📷 Photos", test: (f) => (f.photos || []).length > 0 },
  video: { label: "🎥 Videos", test: (f) => (f.videos || []).length > 0 },
  doc: { label: "📄 Documents", test: (f) => !!f.docLink },
  needsVideo: { label: "Needs video", test: (f) => !(f.videos || []).length },
};

// Old library "bulk add" format:  ### Title / Category: / Tags: a, b / Note: … / Video: / Photo: / Doc:
export function parseBulkFixes(raw) {
  return raw
    .split(/\n(?=###\s)/)
    .map((b) => b.trim())
    .filter((b) => b.startsWith("###"))
    .map((block) => {
      const lines = block.split("\n");
      const item = { title: lines[0].replace(/^###\s*/, "").trim(), category: "", tags: [], body: [], videos: [], photos: [], docLink: "" };
      let inNote = false;
      for (const line of lines.slice(1)) {
        const m = line.match(/^(Category|Tags|Note|Video|Photo|Doc):\s*(.*)$/i);
        const key = m?.[1].toLowerCase();
        const value = m?.[2].trim() ?? "";
        if (key === "category") item.category = value;
        else if (key === "tags") item.tags = value.split(",").map((t) => t.trim()).filter(Boolean);
        else if (key === "note") item.body.push(m[2]);
        else if (key === "video") value && item.videos.push(value);
        else if (key === "photo") value && item.photos.push(value);
        else if (key === "doc") item.docLink = value;
        else if (inNote) item.body.push(line);
        if (m) inNote = key === "note";
      }
      return { ...item, category: item.category || "General", body: item.body.join("\n").trim() };
    })
    .filter((i) => i.title);
}

// `me` = { emp, approver, admin }. Opens on the machine picker. `startMachine` (e.g. "M-001", from a machine's
// QR code) opens that machine; `startCategory` (old category QR codes, ?cat=Die) opens that category's fixes.
export function openFixLibrary(container, { me, onExit, startCategory = null, startMachine = null, onReport = null, onIssues = null, onChecklist = null }) {
  const ui = {
    view: startMachine ? "machine" : "list", // list | machine | fix | form | gaps | qr | bulk | trash | history
    machineId: startMachine,
    search: "",
    category: startCategory || "none", // none | pending | <categoryId> — "Browse by category" (fixes stay hidden until picked)
    attach: "all", // all | photo | video | doc | needsVideo
    gaps: null, // admins: searches with no results (live)
    bulkText: "",
    fixId: null,
    draft: null,
    trash: null, // admins: { fixes, files } while the trash bin is open
    versions: null, // admins: a fix's saved versions while History is open
    names: null, // admins: employee # -> name, for history and trash
    busy: false,
    message: "",
    messageKind: "",
    upload: "", // progress text while a file uploads
  };

  // ---- helpers ------------------------------------------------------------

  // Success goes to a toast; errors and notes stay on the screen.
  function show(view, message = "", kind = "") {
    Object.assign(ui, { view, busy: false, retry: null, message: kind === "ok" ? "" : message, messageKind: kind });
    render();
    container.scrollTop = 0;
    window.scrollTo(0, 0);
    if (kind === "ok" && message) toast(message);
  }

  // Runs a server call. Returns its data, or null after showing the error. `again` = what "Try again" runs.
  async function act(fn, again = null) {
    Object.assign(ui, { busy: true, message: "", messageKind: "", retry: null });
    render();
    try {
      const { data: result } = await fn();
      ui.busy = false;
      return result;
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: again });
      render();
      return null;
    }
  }

  const messageBox = () => banner(ui);
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  const categories = () => (data.fixCategories || []).filter((c) => c.active !== false);
  const categoryName = (id) => data.fixCategories?.find((c) => c.id === id)?.name || "General";
  const allFixes = () => [...(data.fixes || []), ...(data.myFixes || []).filter((f) => f.status !== "approved")];
  const fix = () => allFixes().find((f) => f.id === ui.fixId) || ui.trash?.fixes.find((f) => f.id === ui.fixId);
  const pending = () => (data.myFixes || []).filter((f) => f.status === "pending");
  const machine = () => data.machines?.find((m) => m.id === ui.machineId);
  const activeMachines = () => (data.machines || []).filter((m) => m.active !== false);
  // On the test site, real fixes are read-only (the server refuses changes too).
  const readOnly = (f) => TEST_MODE && !f.test;
  const who = (emp) => (emp === "system" ? "Automatic" : ui.names?.get(emp) || (emp ? `#${emp}` : ""));

  // Machines a fix applies to: every machine of the category's types, plus any pinned ones.
  function machinesFor(f) {
    const types = data.fixCategories?.find((c) => c.id === f.categoryId)?.machineTypes || [];
    return activeMachines().filter((m) => types.includes(m.type) || (f.machineIds || []).includes(m.id));
  }

  // Fixes for one machine: its type's categories, plus fixes pinned to it.
  function fixesForMachine(m) {
    const cats = new Set((data.fixCategories || []).filter((c) => (c.machineTypes || []).includes(m.type)).map((c) => c.id));
    return (data.fixes || []).filter((f) => cats.has(f.categoryId) || (f.machineIds || []).includes(m.id));
  }

  // All words must appear somewhere in the title, write-up, tags, or category.
  function matches(f, words) {
    const text = `${f.title} ${f.body} ${(f.tags || []).join(" ")} ${categoryName(f.categoryId)}`.toLowerCase();
    return words.every((w) => text.includes(w));
  }

  function isOwnFile(url) {
    return url.startsWith("https://firebasestorage.googleapis.com/");
  }

  function youtubeId(url) {
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/);
    return m ? m[1] : null;
  }

  // Admins: employee names for history/trash (one call, then kept).
  async function loadNames() {
    if (ui.names || !me.admin) return;
    try {
      const { data: r } = await callAdminListEmployees();
      ui.names = new Map(r.employees.map((e) => [e.employeeNumber, e.name]));
      render();
    } catch {
      ui.names = new Map(); // numbers still show
    }
  }

  const fmtDay = (d) => {
    if (!d) return "—";
    const [y, mo, da] = d.split("-").map(Number);
    const date = new Date(y, mo - 1, da);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - date) / 86400000);
    return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}) })} · ${days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`}`;
  };

  // ---- the red Maintenance Request banner (full width, every library screen) ---------------

  function maintenanceBanner(m = null) {
    const label = m ? `🚨 Submit a Maintenance Request — ${m.name}` : "🚨 Submit a Maintenance Request";
    if (onReport) return el("button", { class: "mr-banner", type: "button", onclick: () => onReport(null, m?.id || null) }, label);
    return el("a", { class: "mr-banner", href: MAINTENANCE_FORM_URL, target: "_blank", rel: "noopener" }, label);
  }

  // Overdue checklists, at the top and never hidden (on a machine's page: that machine's).
  const overdue = (m = null) => overdueBanner((id) => onChecklist && onChecklist(id), m);

  // Attachment filters (photos, videos, documents, needs video) — tucked under "More filters".
  function attachFilters() {
    const on = ui.attach !== "all" ? ATTACH_FILTERS[ui.attach].label : "";
    const chip = (id, label) =>
      el("button", { class: ui.attach === id ? "chip on" : "chip", type: "button", onclick: () => { ui.attach = ui.attach === id ? "all" : id; render(); } }, label);
    return collapsible("fix-more-filters", on ? `More filters · ${on}` : "More filters",
      el("div", { class: "chips" }, Object.entries(ATTACH_FILTERS).map(([id, f]) => chip(id, f.label))));
  }
  const attachFilter = (list) => (ui.attach === "all" ? list : list.filter(ATTACH_FILTERS[ui.attach].test));

  // ---- library home: overdue, Maintenance Request, search, machines by line ----------------

  function renderList() {
    if (!data.fixes || !data.fixCategories || !data.machines || !data.lines) {
      return [back("Home", onExit), el("h1", {}, "Fix Library"), overdue(), maintenanceBanner(), spinner("Loading the library…")];
    }

    // A category from an old QR code may be a name ("Die", "vacuum tank") rather than an id.
    if (!["none", "pending"].includes(ui.category) && !data.fixCategories.some((c) => c.id === ui.category)) {
      const wanted = String(ui.category).trim().toLowerCase();
      ui.category = data.fixCategories.find((c) => c.name.toLowerCase() === wanted)?.id || "none";
    }

    const counts = new Map();
    for (const f of data.fixes) counts.set(f.categoryId, (counts.get(f.categoryId) || 0) + 1);
    const waiting = me.approver ? pending().length : 0;

    // Fixes stay hidden until someone searches or picks a machine (or a category below).
    // The search box keeps its place while typing: only this part redraws.
    const body = el("div", {});
    const drawBody = () => {
      const w = ui.search.toLowerCase().split(/\s+/).filter(Boolean);
      if (w.length) {
        const l = attachFilter(data.fixes.filter((f) => matches(f, w)));
        body.replaceChildren(
          el("p", { class: "hint" }, `${l.length} fix${l.length === 1 ? "" : "es"} found`),
          l.length
            ? el("div", { class: "person-list" }, l.map(fixRow))
            : emptyState("No fixes match", "Try fewer or different words. If the fix isn't written yet, add it with “+ Add a fix”.")
        );
        if (!l.length) noteSearchGap(ui.search);
        return;
      }
      if (ui.category !== "none") {
        const l = attachFilter(ui.category === "pending" ? pending() : data.fixes.filter((f) => f.categoryId === ui.category));
        body.replaceChildren(
          el("h2", {}, ui.category === "pending" ? "⏳ Waiting for approval" : categoryName(ui.category)),
          el("button", { class: "btn secondary", type: "button", onclick: () => { ui.category = "none"; render(); } }, "← Back to machines"),
          l.length ? el("div", { class: "person-list" }, l.map(fixRow))
            : ui.category === "pending" ? emptyState("Nothing waiting for approval", "New suggestions show up here.")
            : emptyState("No fixes here yet", "Tap “+ Add a fix” to write the first one.")
        );
        return;
      }
      body.replaceChildren(...machinePicker().flat(3));
    };

    const searchBox = el("input", {
      class: "field search", type: "search", placeholder: "Search fixes (e.g. die heater)", value: ui.search,
      "aria-label": "Search fixes", autocomplete: "off",
      oninput: (e) => { ui.search = e.target.value; drawBody(); },
    });
    drawBody();

    const myOwn = !me.approver ? (data.myFixes || []).filter((f) => f.status !== "approved") : [];
    return [
      back("Home", onExit),
      el("h1", {}, "Fix Library"),
      overdue(),
      maintenanceBanner(),
      messageBox(),
      waiting && ui.category !== "pending"
        ? el("button", { class: "btn secondary", type: "button", onclick: () => { ui.search = ""; ui.category = "pending"; render(); } }, `⏳ ${waiting} waiting for your approval`)
        : null,
      searchBox,
      attachFilters(),
      body,
      myOwn.length ? el("div", { class: "card" }, el("strong", {}, "Your suggestions"), myOwn.map((f) => fixRow(f))) : null,
      el("button", { class: "btn secondary", type: "button", onclick: () => startForm(null) }, "+ Add a fix"),
      collapsible(
        "fix-by-category",
        "Browse all fixes by category",
        picker({
          id: "fx-filter-cat", title: "Show fixes for", value: ui.category, placeholder: "Pick a category…",
          options: categories().filter((c) => counts.get(c.id)).map((c) => ({ value: c.id, label: `${c.name} (${counts.get(c.id)})` })),
          onChange: (v) => { ui.search = ""; ui.category = v; render(); window.scrollTo(0, 0); },
        })
      ),
      me.admin ? adminTools() : null,
    ];
  }

  // Machines grouped by line. Each tile shows what needs attention (issue open, checklist overdue).
  function machinePicker() {
    const late = new Set(overdueUnits().map((u) => u.id));
    const issueOn = new Set((data.openIssues || []).map((i) => i.machineId));
    const tile = (m) => {
      const down = (data.openIssues || []).some((i) => i.machineId === m.id && i.lineDown);
      const ckLate = unitsForMachine(m).some((u) => late.has(u.id));
      return el(
        "button",
        { class: down ? "machine-tile down" : "machine-tile", type: "button", onclick: () => { ui.machineId = m.id; show("machine"); } },
        el("span", { class: "person-name" }, breakable(m.name)),
        el("span", { class: "person-meta" }, m.id),
        issueOn.has(m.id) || ckLate
          ? el("span", { class: "tags" },
              issueOn.has(m.id) ? el("span", { class: "tag off" }, down ? "⛔ Line down" : "🚨 Open issue") : null,
              ckLate ? el("span", { class: "tag warn" }, "⚠ Checklist due") : null)
          : null
      );
    };
    const groups = (data.lines || []).filter((l) => l.active !== false)
      .map((l) => [l.name, activeMachines().filter((m) => m.lineId === l.id)])
      .concat([["Plant / other", activeMachines().filter((m) => !m.lineId)]])
      .filter(([, list]) => list.length);
    if (!groups.length) return [emptyState("No machines yet", "An admin adds them in Admin → Lines & machines.")];
    return [
      el("p", { class: "hint" }, "Tap a machine to see its fixes, last service, and checklist — or search above."),
      groups.map(([name, list]) => [el("h2", {}, name), el("div", { class: "machine-grid" }, list.map(tile))]),
    ];
  }

  // ---- one machine ------------------------------------------------------------------

  function renderMachine() {
    const m = machine();
    if (!data.machines || !data.fixes) return [back("Fix Library", () => show("list")), spinner()];
    if (!m) return [back("Fix Library", () => show("list")), emptyState("Machine not found", `There's no machine ${ui.machineId || ""} in the app.`)];
    const open = (data.openIssues || []).filter((i) => i.machineId === m.id);
    const list = attachFilter(fixesForMachine(m));
    return [
      back("Fix Library", () => { ui.machineId = null; show("list"); }),
      el("h1", { class: "fix-title" }, breakable(m.name)),
      el("p", { class: "hint" }, [m.id, m.lineId ? lineName(m.lineId) : "Plant / other", m.type].filter(Boolean).join(" · ")),
      overdue(m),
      maintenanceBanner(m),
      messageBox(),
      el(
        "div",
        { class: "card" },
        el("strong", {}, "🔧 Last service ", el("small", { class: "muted" }, "from Odoo")),
        el("table", { class: "info-table" },
          el("tr", {}, el("th", {}, "Last PM"), el("td", {}, fmtDay(m.lastPmDate))),
          el("tr", {}, el("th", {}, "Last repair"), el("td", {}, fmtDay(m.lastRepairDate))))
      ),
      open.length
        ? el("div", { class: "card" }, el("strong", {}, `🚨 Open issues (${open.length})`), el("div", { class: "issue-grid" }, open.map((i) => issueCard(i, () => onIssues && onIssues()))))
        : null,
      checklistCard(m, (id) => onChecklist && onChecklist(id)),
      el("h2", {}, `Fixes for ${m.name} (${list.length})`),
      attachFilters(),
      list.length ? el("div", { class: "person-list" }, list.map(fixRow)) : emptyState("No fixes for this machine yet", "Tap “+ Add a fix” to write the first one."),
      el("button", { class: "btn secondary", type: "button", onclick: () => startForm(null) }, "+ Add a fix"),
    ];
  }

  // Searches with no results: sent once per search, 1.5 s after typing stops (like the old library).
  const loggedGaps = new Set();
  let gapTimer = null;
  function noteSearchGap(text) {
    clearTimeout(gapTimer);
    const term = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (term.length < 3 || loggedGaps.has(term)) return;
    gapTimer = setTimeout(() => {
      if (ui.search.trim().toLowerCase().replace(/\s+/g, " ") !== term) return;
      loggedGaps.add(term);
      callLogSearchGap({ term }).catch(() => {}); // best effort — never bother the person searching
    }, 1500);
  }

  // ---- admin tools ----------------------------------------------------------

  function adminTools() {
    const open = (ui.gaps || []).filter((g) => !g.done).length;
    return collapsible(
      "fix-admin-tools",
      "⚙ Admin tools",
      el("button", { class: "btn secondary", type: "button", onclick: () => show("gaps") }, `🔍 Searches with no results (${ui.gaps ? open : "…"})`),
      el("button", { class: "btn secondary", type: "button", onclick: openTrash }, "🗑 Trash bin (30 days)"),
      el("button", { class: "btn secondary", type: "button", onclick: () => show("qr") }, "🖨 Print machine QR codes"),
      el("button", { class: "btn secondary", type: "button", onclick: () => { downloadCsv(); toast("Downloading all fixes (CSV)"); } }, "⇩ Download all fixes (CSV, optional)"),
      el("button", { class: "btn secondary", type: "button", onclick: () => show("bulk") }, "📋 Bulk add fixes"),
      importCard()
    );
  }

  // ---- trash bin (admins) ----------------------------------------------------------------

  async function openTrash() {
    loadNames();
    ui.trash = null;
    show("trash");
    try {
      const reads = [getDocs(query(collection(db, "fixes"), where("status", "==", "trashed"))), getDocs(collection(db, "trash"))];
      if (TEST_MODE) reads.push(getDocs(query(collection(db, "test_fixes"), where("status", "==", "trashed"))), getDocs(collection(db, "test_trash")));
      const [f, t, tf, tt] = await Promise.all(reads);
      const rows = (snap, test) => (snap ? snap.docs.map((d) => ({ id: d.id, ...d.data(), ...(test ? { test: true } : {}) })) : []);
      ui.trash = { fixes: [...rows(f), ...rows(tf, true)], files: [...rows(t), ...rows(tt, true)] };
      render();
    } catch (err) {
      ui.trash = { fixes: [], files: [] };
      Object.assign(ui, { message: friendlyError(err), messageKind: "error", retry: openTrash });
      render();
    }
  }

  function renderTrash() {
    const daysLeft = (x) => {
      const ms = (x.purgeAfter?.toMillis?.() || 0) - Date.now();
      return ms > 0 ? `${Math.ceil(ms / 86400000)} days left` : "goes tonight";
    };
    const when = (x) => x.trashedAt?.toDate?.().toLocaleDateString("en-US", { month: "short", day: "numeric" }) || "";
    async function restore(f) {
      if (await act(() => callRestoreFix({ id: f.id }), () => restore(f))) { toast(`“${f.title}” is back`); openTrash(); }
    }
    async function restoreFile(t) {
      if (await act(() => callRestoreTrashedFile({ trashId: t.id }), () => restoreFile(t))) { toast("File put back"); openTrash(); }
    }
    const t = ui.trash;
    return [
      back("Fix Library", () => { ui.trash = null; show("list"); }),
      el("h1", {}, "🗑 Trash bin"),
      el("p", { class: "hint" }, "Deleted fixes and removed photos/videos stay here for 30 days, then they're gone for good. Tap Restore to bring one back."),
      messageBox(),
      !t ? spinner("Loading the trash…") : null,
      t && !t.fixes.length && !t.files.length ? emptyState("The trash is empty", "Deleted fixes and removed files show up here for 30 days.") : null,
      t?.fixes.length ? [el("h2", {}, `Fixes (${t.fixes.length})`), el("div", { class: "import-preview" }, t.fixes.map((f) =>
        el("div", { class: "import-row" },
          el("span", { class: "gap-term" }, f.title, f.test ? " [TEST]" : "", el("small", {}, ` · deleted ${when(f)} by ${who(f.trashedBy)} · ${daysLeft(f)}`)),
          el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => restore(f) }, "Restore"))))] : null,
      t?.files.length ? [el("h2", {}, `Photos, videos, documents (${t.files.length})`), el("div", { class: "import-preview" }, t.files.map((x) =>
        el("div", { class: "import-row" },
          el("a", { href: x.url, target: "_blank", rel: "noopener", class: "gap-term" }, (x.path || "").split("/").pop()),
          el("span", { class: "gap-term" }, el("small", {}, `from “${x.title}” · ${when(x)} by ${who(x.trashedBy)} · ${daysLeft(x)}`)),
          el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => restoreFile(x) }, "Put back"))))] : null,
    ];
  }

  // ---- version history (admins) ----------------------------------------------------------

  async function openHistory() {
    const f = fix();
    loadNames();
    ui.versions = null;
    show("history");
    try {
      const snap = await getDocs(query(collection(db, f.test ? "test_fixes" : "fixes", f.id, "versions"), orderBy("savedAt", "desc"), limit(50)));
      ui.versions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    } catch (err) {
      ui.versions = [];
      Object.assign(ui, { message: friendlyError(err), messageKind: "error", retry: openHistory });
      render();
    }
  }

  function renderHistory() {
    const f = fix();
    if (!f) return renderList();
    async function restore(v, askFirst = true) {
      if (askFirst && !(await confirmSheet({
        title: "Restore this version?",
        text: `“${f.title}” goes back to how it was on ${v.savedAt?.toDate?.().toLocaleString() || "that date"}. What it says now is saved as a version too, so you can undo this.`,
        confirmLabel: "↺ Restore this version",
      }))) return;
      if (await act(() => callRestoreFixVersion({ id: f.id, versionId: v.id }), () => restore(v, false))) show("fix", "Older version restored", "ok");
    }
    return [
      back("Back to the fix", () => show("fix")),
      el("h1", { class: "fix-title" }, "🕘 History"),
      el("p", { class: "hint" }, `“${f.title}” — a copy is saved before every change. Newest first.`),
      messageBox(),
      !ui.versions ? spinner("Loading history…") : !ui.versions.length ? emptyState("No changes yet", "Each time this fix changes, the old version is saved here.") : null,
      (ui.versions || []).map((v) =>
        collapsible(
          `ver-${f.id}-${v.id}`,
          `${v.savedAt?.toDate?.().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) || ""} · before “${v.reason}” by ${who(v.savedBy)}`,
          el("p", { class: "person-name" }, v.title || ""),
          el("div", { class: "fix-body" }, v.body || ""),
          el("p", { class: "hint" }, `${categoryName(v.categoryId)} · ${(v.photos || []).length} photos · ${(v.videos || []).length} videos${v.docLink ? " · document" : ""} · ${v.status || ""}`),
          readOnly(f) ? null : el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => restore(v) }, "↺ Restore this version")
        )
      ),
    ];
  }

  function renderGaps() {
    const gaps = [...(ui.gaps || [])].sort((a, b) => (a.done - b.done) || ((b.lastAt?.toMillis?.() || 0) - (a.lastAt?.toMillis?.() || 0)));
    async function mark(g, done) {
      if (await act(() => callAdminMarkSearchGap({ id: g.id, done }), () => mark(g, done))) show("gaps", done ? "Marked done" : "Back on the list", "ok");
    }
    return [
      back("Fix Library", () => show("list")),
      el("h1", {}, "Searches with no results"),
      el("p", { class: "hint" }, "What people looked for and didn't find — the fixes to write next. Tap Done once it's written."),
      messageBox(),
      !ui.gaps ? spinner() : !gaps.length ? emptyState("No searches without results yet", "When someone searches and finds nothing, it shows up here.") : null,
      el(
        "div",
        { class: "import-preview" },
        gaps.map((g) =>
          el(
            "div",
            { class: g.done ? "import-row skip" : "import-row" },
            el("span", { class: "import-line" }, `×${g.count}`),
            el("span", { class: "gap-term" }, g.term, el("small", {}, ` · last ${g.lastAt?.toDate?.().toLocaleDateString() || ""}`)),
            el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => mark(g, !g.done) }, g.done ? "Undo" : "Done")
          )
        )
      ),
    ];
  }

  // One QR code per machine, printable — scanning opens the app on that machine (?m=M-001):
  // its fixes, last service, open issues, and checklist. (Old category codes, ?cat=Die, still work.)
  function renderQr() {
    const list = activeMachines();
    const grid = el("div", { class: "qr-grid" }, spinner("Making QR codes…"));
    loadQrLibrary().then(
      () => {
        grid.replaceChildren(
          ...list.map((m) => {
            const qr = window.qrcode(0, "M");
            qr.addData(`${APP_URL}/?m=${encodeURIComponent(m.id)}`);
            qr.make();
            const box = el("div", { class: "qr-card" });
            box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }); // made locally from our own link
            box.append(el("strong", {}, breakable(m.name)), el("small", {}, `${m.id} · ${m.lineId ? lineName(m.lineId) : "Plant"}`));
            return box;
          })
        );
      },
      () => grid.replaceChildren(banner({ message: "Couldn't load the QR code maker. Check Wi-Fi and try again.", messageKind: "error", retry: () => show("qr") }))
    );
    return [
      el("div", { class: "no-print" }, back("Fix Library", () => show("list")), el("h1", {}, "Machine QR codes"),
        el("p", { class: "hint" }, "One per machine. Post it on the machine — scanning opens CDG Ops straight to that machine."),
        el("button", { class: "btn", type: "button", onclick: () => window.print() }, "🖨 Print")),
      grid,
    ];
  }

  let qrLibraryLoading = null;
  function loadQrLibrary() {
    if (window.qrcode) return Promise.resolve();
    qrLibraryLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = QR_LIBRARY;
      s.onload = resolve;
      s.onerror = () => { qrLibraryLoading = null; reject(); };
      document.head.append(s);
    });
    return qrLibraryLoading;
  }

  // Backup copy of every approved fix, like the old library's CSV export (opens in Excel).
  function downloadCsv() {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Title", "Category", "Tags", "Fix", "Photos", "Videos", "Document", "Helpful yes", "Helpful no", "Applies to", "ID"]];
    for (const f of data.fixes || []) {
      rows.push([
        f.title, categoryName(f.categoryId), (f.tags || []).join(", "), f.body, (f.photos || []).join("\n"), (f.videos || []).join("\n"),
        f.docLink || "", f.helpfulYes || 0, f.helpfulNo || 0, machinesFor(f).map((m) => m.id).join(" "), f.id,
      ]);
    }
    const csv = "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
    const a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: `cdg-fix-library-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function renderBulk() {
    const preview = el("div", {});
    const drawPreview = () => {
      const items = parseBulkFixes(ui.bulkText);
      preview.replaceChildren(
        el("p", { class: "hint" }, items.length ? `${items.length} fixes ready to add` : "Nothing recognized yet — each fix starts with ### and its title."),
        el("div", { class: "import-preview" }, items.map((i) => el("div", { class: "import-row" }, el("span", { class: "import-line" }, i.category), el("span", {}, i.title))))
      );
    };
    drawPreview();
    async function addAll(askFirst = true) {
      const items = parseBulkFixes(ui.bulkText);
      if (!items.length) return;
      if (askFirst && !(await confirmSheet({ title: `Add ${items.length} fixes?`, text: "They go live right away.", confirmLabel: `Add ${items.length} fixes` }))) return;
      const r = await act(() => callAdminBulkAddFixes({ items }), () => addAll(false));
      if (r) {
        ui.bulkText = "";
        show("list", `Added ${r.added} fixes${r.newCategories.length ? ` · new categories: ${r.newCategories.join(", ")}` : ""}`, "ok");
      }
    }
    return [
      back("Fix Library", () => show("list")),
      el("h1", {}, "Bulk add fixes"),
      el("p", { class: "hint" }, "Same format as the old library. Each fix starts with ### and its title; Note: can run several lines."),
      messageBox(),
      el("textarea", {
        class: "field paste-box", rows: "12", spellcheck: "false", value: ui.bulkText,
        placeholder: "### Die heater won't hold temp\nCategory: Die\nTags: heater, temperature\nNote: Symptom: …\nCheck the thermocouple…\nPhoto: https://…\n\n### Next fix…",
        oninput: (e) => { ui.bulkText = e.target.value; drawPreview(); },
      }),
      preview,
      el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => addAll() }, ui.busy ? "Adding…" : "+ Add all"),
    ];
  }

  function fixRow(f) {
    const n = (list) => (list || []).length;
    const icons = [
      n(f.photos) ? `📷 ${n(f.photos) === 1 ? "Photo" : `${n(f.photos)} photos`}` : "",
      n(f.videos) ? `🎥 ${n(f.videos) === 1 ? "Video" : `${n(f.videos)} videos`}` : "",
      f.docLink ? "📄 Document" : "",
    ].filter(Boolean).join(" · ");
    const tag =
      f.status === "pending" ? el("span", { class: "tag warn" }, f.editOf ? "Suggested change" : "Waiting for approval")
      : f.status === "rejected" ? el("span", { class: "tag off" }, "Not approved")
      : f.status === "retired" ? el("span", { class: "tag off" }, "Retired")
      : f.status === "trashed" ? el("span", { class: "tag off" }, "In the trash")
      : null;
    return el(
      "button",
      { class: "person-row", type: "button", onclick: () => { ui.fixId = f.id; show("fix"); } },
      el("span", { class: "person-name" }, f.title),
      el("span", { class: "person-meta" }, [categoryName(f.categoryId), icons].filter(Boolean).join(" · ")),
      el("span", { class: "tags" }, tag, f.test ? el("span", { class: "tag test" }, "TEST") : null)
    );
  }

  // Admin only: copy the old Line Fix Library in (safe to run again).
  function importCard() {
    const imported = (data.fixes || []).filter((f) => f.legacyId).length;
    return el(
      "div",
      { class: "sub-section" },
      el("strong", {}, "Copy from the old Fix Library"),
      el(
        "p",
        { class: "card-note" },
        imported
          ? `${imported} fixes copied so far. Running it again picks up changes made in the old library; nothing is duplicated.`
          : "Copies the old library's fixes, categories, and uploaded photos/videos into this app. The old library isn't changed. Takes a few minutes."
      ),
      el(
        "button",
        { class: "btn secondary", type: "button", disabled: ui.busy, onclick: runImport },
        ui.busy ? "Copying… (a few minutes — keep this open)" : imported ? "↻ Copy again" : "⇩ Copy the old library"
      )
    );
  }

  async function runImport() {
    const r = await act(() => callAdminImportOldLibrary(), runImport);
    if (r) {
      const gaps = r.searchGapsCopied ? ` · ${r.searchGapsCopied} no-result searches` : "";
      const summary = `Copied ${r.fixesSaved} fixes in ${r.categories} categories · files: ${r.filesCopied} copied, ${r.filesSkipped} already here${gaps}`;
      if (r.fileProblems?.length) {
        show("list", `${summary}. ${r.fileProblems.length} files couldn't be copied.`, "error");
        ui.retry = runImport;
        render();
      } else {
        show("list", summary, "ok");
      }
    }
  }

  // ---- one fix ------------------------------------------------------------

  function media(f) {
    const parts = [];
    (f.photos || []).forEach((url, i) => {
      parts.push(
        isOwnFile(url)
          ? el("a", { href: url, target: "_blank", rel: "noopener" }, el("img", { class: "fix-photo", src: url, alt: `Photo ${i + 1}`, loading: "lazy" }))
          : el("a", { class: "btn secondary", href: url, target: "_blank", rel: "noopener" }, `📷 Open photo ${i + 1}`)
      );
    });
    (f.videos || []).forEach((url, i) => {
      const yt = youtubeId(url);
      if (isOwnFile(url)) parts.push(el("video", { class: "fix-video", src: url, controls: true, preload: "metadata", playsinline: true }));
      else if (yt) parts.push(el("a", { class: "btn secondary", href: `https://www.youtube.com/watch?v=${yt}`, target: "_blank", rel: "noopener" }, `🎥 Watch video ${i + 1} (YouTube)`));
      else parts.push(el("a", { class: "btn secondary", href: url, target: "_blank", rel: "noopener" }, `🎥 Open video ${i + 1}`));
    });
    if (f.docLink) parts.push(el("a", { class: "btn secondary", href: f.docLink, target: "_blank", rel: "noopener" }, "📄 Open document"));
    return parts.length ? el("div", { class: "fix-media" }, parts) : null;
  }

  function appliesTo(f) {
    const list = machinesFor(f);
    if (!list.length) return el("p", { class: "hint" }, `${categoryName(f.categoryId)} · general`);
    const byLine = list.map((m) => `${m.id} (${m.lineId ? lineName(m.lineId) : m.name})`);
    return el("p", { class: "hint" }, `${categoryName(f.categoryId)} — applies to ${byLine.join(", ")}`);
  }

  function renderFix() {
    const f = fix();
    if (!f) return renderList();
    const original = f.editOf ? (data.fixes || []).find((x) => x.id === f.editOf) : null;
    const myVote = f.votes?.[me.emp];

    async function vote(helpful) {
      if (await act(() => callVoteFix({ id: f.id, helpful }), () => vote(helpful))) toast("Thanks for the feedback");
      render();
    }
    async function review(approve, askFirst = true) {
      if (!approve && askFirst && !(await confirmSheet({ title: "Reject this suggestion?", text: "It won't be published.", confirmLabel: "Reject", danger: true }))) return;
      const r = await act(() => callReviewFix({ id: f.id, approve }), () => review(approve, false));
      if (r) {
        ui.fixId = r.id;
        show(approve ? "fix" : "list", approve ? "Approved — everyone can see it now" : "Suggestion rejected", "ok");
      }
    }
    async function remove(askFirst = true) {
      if (askFirst && !(await confirmSheet({
        title: "Delete this fix?", text: "It goes to the trash bin. An admin can restore it for 30 days; after that it's gone for good.", confirmLabel: "🗑 Delete fix", danger: true,
      }))) return;
      if (await act(() => callDeleteFix({ id: f.id }), () => remove(false))) show(ui.machineId ? "machine" : "list", "Fix moved to the trash (30 days)", "ok");
    }
    async function bringBack() {
      if (await act(() => callRestoreFix({ id: f.id }), bringBack)) { ui.trash = null; show("fix", "Fix restored from the trash", "ok"); }
    }
    async function retire(retiring, askFirst = true) {
      if (retiring && askFirst && !(await confirmSheet({
        title: "Retire this fix?", text: "It's hidden from the library but kept in history. You can bring it back.", confirmLabel: "Retire fix", danger: true,
      }))) return;
      if (await act(() => callRetireFix({ id: f.id, retire: retiring }), () => retire(retiring, false))) {
        show("fix", retiring ? "Fix retired" : "Fix is back", "ok");
      }
    }

    const m = machine();
    const locked = readOnly(f);
    const trashed = f.status === "trashed";
    return [
      trashed ? back("Trash bin", openTrash) : m ? back(m.name, () => show("machine")) : back("Fix Library", () => show("list")),
      el("h1", { class: "fix-title" }, f.title),
      appliesTo(f),
      f.test ? el("p", { class: "message test-note" }, "TEST fix — made on the test site. Only the test site shows it.") : null,
      locked ? el("p", { class: "message" }, "Real fix — read-only on the test site. Add a test fix to try editing, approving, or deleting.") : null,
      f.status === "pending"
        ? el("p", { class: "message" }, f.editOf ? `⏳ Suggested change to "${original?.title || "a fix"}" — waiting for an Admin to approve.` : "⏳ Waiting for an Admin to approve.")
        : null,
      f.status === "rejected" ? el("p", { class: "message error" }, "✖ This suggestion wasn't approved.") : null,
      f.status === "retired" ? el("p", { class: "message error" }, "Retired — hidden from the library.") : null,
      trashed ? el("p", { class: "message error" }, "🗑 In the trash — gone for good after 30 days unless restored.") : null,
      messageBox(),
      el("div", { class: "fix-body" }, f.body),
      media(f),
      (f.tags || []).length ? el("p", { class: "tags" }, f.tags.map((t) => el("span", { class: "tag" }, t))) : null,
      f.status === "approved" && !locked
        ? el(
            "div",
            { class: "helpful" },
            el("span", {}, "Was this helpful?"),
            el("button", { class: myVote === true ? "chip on" : "chip", type: "button", disabled: ui.busy, onclick: () => vote(true) }, `👍 Yes · ${f.helpfulYes || 0}`),
            el("button", { class: myVote === false ? "chip on" : "chip", type: "button", disabled: ui.busy, onclick: () => vote(false) }, `👎 No · ${f.helpfulNo || 0}`)
          )
        : null,
      trashed && me.approver
        ? el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: bringBack }, "↺ Restore from the trash")
        : null,
      !locked && !trashed && me.approver && f.status === "pending"
        ? [
            el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => review(true) }, "✔ Approve"),
            el("button", { class: "btn danger", type: "button", disabled: ui.busy, onclick: () => review(false) }, "✖ Reject"),
          ]
        : null,
      !locked && (f.status === "approved" || (f.status === "pending" && (me.approver || f.createdBy === me.emp)))
        ? el(
            "button",
            { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => startForm(f) },
            me.approver || f.status === "pending" ? "✎ Edit" : "✎ Suggest a change"
          )
        : null,
      maintenanceBanner(m),
      !locked && !trashed && me.approver
        ? collapsible(
            "fix-admin-actions",
            "⚙ Admin: history, retire, delete",
            el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: openHistory }, "🕘 History — restore an older version"),
            f.status === "approved" ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => retire(true) }, "Retire fix (hide, keep)") : null,
            f.status === "retired" ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => retire(false) }, "↺ Bring fix back") : null,
            el("button", { class: "btn danger", type: "button", disabled: ui.busy, onclick: () => remove() }, "🗑 Delete fix")
          )
        : null,
      relatedFixes(f),
    ];
  }

  // Up to 4 other fixes in the same category, like the old library's "Related problems".
  function relatedFixes(f) {
    const related = (data.fixes || []).filter((x) => x.id !== f.id && x.categoryId === f.categoryId).slice(0, 4);
    if (!related.length) return null;
    return el("div", { class: "related" }, el("h2", {}, `More ${categoryName(f.categoryId)} fixes`), el("div", { class: "person-list" }, related.map(fixRow)));
  }

  // ---- add / edit ---------------------------------------------------------

  // A new fix starts in the category being browsed, or the first category for the machine being viewed.
  function defaultCategory() {
    if (!["none", "pending"].includes(ui.category)) return ui.category;
    const m = ui.view === "machine" ? machine() : null;
    if (!m) return "";
    const fits = categories().filter((c) => (c.machineTypes || []).includes(m.type));
    return (fits.find((c) => c.name.toLowerCase() === String(m.type).toLowerCase()) || fits[0])?.id || "";
  }

  function startForm(existing) {
    ui.draft = existing
      ? {
          id: existing.id, title: existing.title, categoryId: existing.categoryId, body: existing.body,
          tags: (existing.tags || []).join(", "), photos: [...(existing.photos || [])], videos: [...(existing.videos || [])],
          docLink: existing.docLink || "", machineIds: [...(existing.machineIds || [])], link: "",
        }
      : {
          id: null, title: "", categoryId: defaultCategory(),
          body: BODY_TEMPLATE, tags: "", photos: [], videos: [], docLink: "", machineIds: [], link: "",
        };
    show("form");
  }

  // Uploads a photo/video/PDF from the phone into this person's folder, then attaches its link.
  async function uploadFile(file) {
    const d = ui.draft;
    const kind = file.type.startsWith("video/") ? "videos" : file.type.startsWith("image/") ? "photos" : file.type === "application/pdf" ? "doc" : null;
    if (!kind) {
      Object.assign(ui, { message: "Only photos, videos, or PDFs can be attached.", messageKind: "error" });
      return render();
    }
    if (file.size > 250 * 1024 * 1024) {
      Object.assign(ui, { message: "That file is over 250 MB. Trim the video or send a shorter one.", messageKind: "error" });
      return render();
    }
    if (!navigator.onLine) {
      Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: () => uploadFile(file) });
      return render();
    }
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${me.emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    Object.assign(ui, { busy: true, message: "", retry: null });
    let ok = false;
    await new Promise((resolve) => {
      task.on(
        "state_changed",
        (s) => { ui.upload = `Uploading ${file.name}: ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`; render(); },
        (err) => { Object.assign(ui, { message: friendlyError(err), messageKind: "error", retry: () => uploadFile(file) }); resolve(); },
        async () => {
          const url = await getDownloadURL(task.snapshot.ref);
          if (kind === "doc") d.docLink = url;
          else d[kind].push(url);
          ok = true;
          resolve();
        }
      );
    });
    Object.assign(ui, { busy: false, upload: "" });
    render();
    if (ok) toast(kind === "videos" ? "Video added" : kind === "doc" ? "Document added" : "Photo added");
  }

  function renderForm() {
    const d = ui.draft;
    const cat = data.fixCategories?.find((c) => c.id === d.categoryId);
    const candidates = (data.machines || []).filter((m) => m.active !== false && cat && !(cat.machineTypes || []).includes(m.type));

    async function save(e) {
      e?.preventDefault();
      if (!d.categoryId) {
        Object.assign(ui, { message: "Pick a category.", messageKind: "error", retry: null });
        render();
        return;
      }
      const payload = {
        ...(d.id ? { id: d.id } : {}),
        title: d.title, categoryId: d.categoryId, body: d.body,
        tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
        photos: d.photos, videos: d.videos, docLink: d.docLink.trim(), machineIds: d.machineIds,
      };
      const r = await act(() => callSubmitFix(payload), save);
      if (!r) return;
      ui.fixId = r.id;
      const msg =
        r.status === "approved" ? "Saved — everyone can see it now"
        : r.editOf ? "Thanks! Your change was sent for approval"
        : "Thanks! Your fix was sent for approval";
      show("fix", msg, "ok");
    }

    function attached(kind, label) {
      return d[kind].map((url, i) =>
        el(
          "div",
          { class: "import-row" },
          el("span", {}, `${label} ${i + 1}${isOwnFile(url) ? "" : " (link)"}`),
          el("button", { class: "link-btn", type: "button", onclick: () => { d[kind].splice(i, 1); render(); } }, "Remove")
        )
      );
    }

    function addLink() {
      const url = d.link.trim();
      if (!/^https:\/\//.test(url)) {
        Object.assign(ui, { message: "Paste a full link starting with https://", messageKind: "error" });
        return render();
      }
      (/\.(mov|mp4|m4v|webm)(\?|$)/i.test(url) || youtubeId(url) ? d.videos : d.photos).push(url);
      d.link = "";
      ui.message = "";
      render();
    }

    return [
      back(d.id ? "Back" : machine() ? machine().name : "Fix Library", () => show(d.id ? "fix" : machine() ? "machine" : "list")),
      el("h1", {}, d.id ? (me.approver || fix()?.status === "pending" ? "Edit fix" : "Suggest a change") : "Add a fix"),
      me.approver ? null : el("p", { class: "hint" }, "An Admin approves it before everyone sees it."),
      messageBox(),
      ui.upload ? spinner(ui.upload) : null,
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "fx-title" }, "Title — what's the problem?"),
        el("input", { class: "field", id: "fx-title", maxlength: "120", required: true, value: d.title, oninput: (e) => { d.title = e.target.value; } }),
        el("label", { class: "field-label", for: "fx-cat" }, "Category"),
        picker({
          id: "fx-cat", title: "Category", value: d.categoryId,
          options: categories().map((c) => ({ value: c.id, label: c.name })),
          onChange: (v) => { d.categoryId = v; d.machineIds = []; render(); },
        }),
        cat && (cat.machineTypes || []).length
          ? el("p", { class: "hint" }, `Shows on every ${cat.machineTypes.join(" / ")} machine.`)
          : null,
        el("label", { class: "field-label", for: "fx-body" }, "The fix — symptom, cause, steps"),
        el("textarea", { class: "field paste-box", id: "fx-body", rows: "10", required: true, maxlength: "10000", value: d.body, oninput: (e) => { d.body = e.target.value; } }),

        el("p", { class: "field-label" }, "Photos, videos, PDF"),
        attached("photos", "Photo"),
        attached("videos", "Video"),
        d.docLink ? el("div", { class: "import-row" }, el("span", {}, "Document"), el("button", { class: "link-btn", type: "button", onclick: () => { d.docLink = ""; render(); } }, "Remove")) : null,
        el(
          "label",
          { class: "btn secondary file-btn" },
          ui.busy && ui.upload ? "Uploading…" : "📷 Add photo / video / PDF",
          el("input", {
            type: "file", accept: "image/*,video/*,application/pdf", hidden: true, disabled: ui.busy,
            onchange: (e) => { const file = e.target.files[0]; e.target.value = ""; if (file) uploadFile(file); },
          })
        ),
        el("label", { class: "field-label", for: "fx-link" }, "…or paste a link (SharePoint, YouTube)"),
        el(
          "div",
          { class: "link-row" },
          el("input", { class: "field", id: "fx-link", type: "url", placeholder: "https://", value: d.link, oninput: (e) => { d.link = e.target.value; } }),
          el("button", { class: "btn secondary", type: "button", onclick: addLink }, "+ Add link")
        ),

        el("label", { class: "field-label", for: "fx-tags" }, "Tags (optional, separated by commas)"),
        el("input", { class: "field", id: "fx-tags", value: d.tags, oninput: (e) => { d.tags = e.target.value; } }),

        candidates.length
          ? collapsible(
              "fix-other-machines",
              `Also show on other machines (optional)${d.machineIds.length ? ` · ${d.machineIds.length} picked` : ""}`,
              candidates.map((m) =>
                el(
                  "label",
                  { class: "check-row" },
                  el("input", {
                    type: "checkbox", checked: d.machineIds.includes(m.id),
                    onchange: (e) => { d.machineIds = e.target.checked ? [...d.machineIds, m.id] : d.machineIds.filter((x) => x !== m.id); },
                  }),
                  el("span", {}, `${m.id} · ${m.name} (${lineName(m.lineId)})`)
                )
              )
            )
          : null,

        el(
          "button",
          { class: "btn", type: "submit", disabled: ui.busy },
          ui.busy ? "Saving…" : me.approver ? "✔ Save" : "✔ Send for approval"
        )
      ),
    ];
  }

  function render() {
    const views = {
      list: renderList, machine: renderMachine, fix: renderFix, form: renderForm, gaps: renderGaps, qr: renderQr, bulk: renderBulk,
      trash: renderTrash, history: renderHistory,
    };
    container.replaceChildren(...[(views[ui.view] || renderList)()].flat(2).filter(Boolean));
  }

  // Live updates redraw the screen — but not while typing (form, search box, bulk add) or on the QR page.
  const redraw = () => {
    const typing =
      ["form", "bulk", "qr", "history"].includes(ui.view) || (ui.view === "list" && document.activeElement?.classList.contains("search"));
    if (!ui.busy && !typing) render();
  };
  const stops = [onDataChange(redraw)];

  // Admins: the no-results search list, live.
  if (me.admin) {
    stops.push(
      onSnapshot(
        collection(db, "searchGaps"),
        (snap) => { ui.gaps = snap.docs.map((d) => ({ id: d.id, ...d.data() })); redraw(); },
        () => { ui.gaps = []; redraw(); }
      )
    );
  }

  render();
  return () => stops.forEach((s) => s());
}
