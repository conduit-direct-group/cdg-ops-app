// Fix Library (Plan Decisions 25–28): search, browse by category, read a fix, add/edit, approve.
// Approved fixes come live from the database (data.js). Every change goes through the server
// (submitFix, reviewFix, retireFix, voteFix), which checks the person's live role.

import { el, friendlyError } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import {
  db, storage, callSubmitFix, callReviewFix, callRetireFix, callVoteFix, callAdminImportOldLibrary,
  callLogSearchGap, callAdminMarkSearchGap, callAdminBulkAddFixes,
} from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { issueCard } from "./issues.js";

const BODY_TEMPLATE = "Symptom:\n\nCause:\n\nFix (steps):\n1. \n";

// Same Microsoft Form the old library's Maintenance Request button opened.
const MAINTENANCE_FORM_URL =
  "https://forms.cloud.microsoft/pages/responsepage.aspx?id=RYTjE-lToUWZ7ucD-FImerLtIR47y8VNk3kCsQnMjW1UMU9UUFlJNkRaRE9LMk9BOEk5NDQzS080RC4u&origin=QRCode&route=shorturl";

// QR codes always point at the live app, even when printed from a test copy.
const APP_URL = "https://cdg-ops.netlify.app";

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

// `me` = { emp, approver, admin }. `startCategory` opens the library filtered (e.g. from a QR code).
export function openFixLibrary(container, { me, onExit, startCategory = null, onReport = null, onIssues = null }) {
  const ui = {
    view: "list", // list | fix | form | gaps | qr | bulk
    search: "",
    category: startCategory || "all", // all | pending | <categoryId>
    attach: "all", // all | photo | video | doc | needsVideo
    gaps: null, // admins: searches with no results (live)
    bulkText: "",
    fixId: null,
    draft: null,
    busy: false,
    message: "",
    messageKind: "",
    upload: "", // progress text while a file uploads
  };

  // ---- helpers ------------------------------------------------------------

  function show(view, message = "", kind = "") {
    Object.assign(ui, { view, message, messageKind: kind, busy: false });
    render();
    container.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  async function act(fn) {
    Object.assign(ui, { busy: true, message: "", messageKind: "" });
    render();
    try {
      const { data: result } = await fn();
      ui.busy = false;
      return result;
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error" });
      render();
      return null;
    }
  }

  const messageBox = () =>
    ui.message ? el("p", { class: `message ${ui.messageKind}`, role: ui.messageKind === "error" ? "alert" : null }, ui.message) : null;
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  const categories = () => (data.fixCategories || []).filter((c) => c.active !== false);
  const categoryName = (id) => data.fixCategories?.find((c) => c.id === id)?.name || "General";
  const allFixes = () => [...(data.fixes || []), ...(data.myFixes || []).filter((f) => f.status !== "approved")];
  const fix = () => allFixes().find((f) => f.id === ui.fixId);
  const pending = () => (data.myFixes || []).filter((f) => f.status === "pending");

  // Machines a fix applies to: every machine of the category's types, plus any pinned ones.
  function machinesFor(f) {
    const types = data.fixCategories?.find((c) => c.id === f.categoryId)?.machineTypes || [];
    return (data.machines || []).filter((m) => m.active !== false && (types.includes(m.type) || (f.machineIds || []).includes(m.id)));
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

  // ---- library list -------------------------------------------------------

  function renderList() {
    if (!data.fixes || !data.fixCategories) return [back("Home", onExit), el("h1", {}, "Fix Library"), el("p", { class: "hint" }, "Loading…")];

    // A category from a link/QR code may be a name ("Die", "vacuum tank") rather than an id.
    if (!["all", "pending"].includes(ui.category) && !data.fixCategories.some((c) => c.id === ui.category)) {
      const wanted = String(ui.category).trim().toLowerCase();
      ui.category = data.fixCategories.find((c) => c.name.toLowerCase() === wanted)?.id || "all";
    }

    const counts = new Map();
    for (const f of data.fixes) counts.set(f.categoryId, (counts.get(f.categoryId) || 0) + 1);
    const chip = (id, label) =>
      el("button", { class: ui.category === id ? "chip on" : "chip", type: "button", onclick: () => { ui.category = id; render(); } }, label);

    // Search box keeps its place while typing: only the results redraw.
    const results = el("div", { class: "person-list" });
    const drawResults = () => {
      const w = ui.search.toLowerCase().split(/\s+/).filter(Boolean);
      let l = ui.category === "pending" ? pending() : data.fixes;
      if (ui.category !== "all" && ui.category !== "pending") l = l.filter((f) => f.categoryId === ui.category);
      if (ui.attach !== "all") l = l.filter(ATTACH_FILTERS[ui.attach].test);
      if (w.length) l = l.filter((f) => matches(f, w));
      results.replaceChildren(...(l.length ? l.map(fixRow) : [el("p", { class: "hint" }, w.length ? "No fixes match. Try fewer or different words." : "No fixes here yet.")]));
      if (w.length && !l.length) noteSearchGap(ui.search);
    };

    const searchBox = el("input", {
      class: "field search", type: "search", placeholder: "Search fixes (e.g. die heater)", value: ui.search,
      "aria-label": "Search fixes", autocomplete: "off",
      oninput: (e) => { ui.search = e.target.value; drawResults(); },
    });
    drawResults();

    const attachChip = (id, label) =>
      el("button", { class: ui.attach === id ? "chip on" : "chip", type: "button", onclick: () => { ui.attach = ui.attach === id ? "all" : id; render(); } }, label);

    const myOwn = !me.approver ? (data.myFixes || []).filter((f) => f.status !== "approved") : [];
    return [
      back("Home", onExit),
      el("h1", {}, "Fix Library"),
      messageBox(),
      searchBox,
      el(
        "div",
        { class: "chips" },
        chip("all", `All (${data.fixes.length})`),
        me.approver && pending().length ? chip("pending", `Waiting for approval (${pending().length})`) : null,
        categories().filter((c) => counts.get(c.id)).map((c) => chip(c.id, `${c.name} (${counts.get(c.id)})`))
      ),
      el("div", { class: "chips small" }, Object.entries(ATTACH_FILTERS).map(([id, f]) => attachChip(id, f.label))),
      el("button", { class: "btn", type: "button", onclick: () => startForm(null) }, "+ Add a fix"),
      maintenanceRequestButton(data.fixCategories.find((c) => c.id === ui.category)?.machineTypes),
      !["all", "pending"].includes(ui.category) ? maintenancePanel(machinesOfCategory(ui.category)) : null,
      myOwn.length
        ? el("div", { class: "card" }, el("strong", {}, "Your suggestions"), myOwn.map((f) => fixRow(f)))
        : null,
      results,
      me.admin ? adminTools() : null,
    ];
  }

  // In the app: opens Report a problem (creates the Odoo request), narrowed to these machine types.
  // Without the in-app form available, falls back to the old Microsoft Form.
  function maintenanceRequestButton(machineTypes = null) {
    if (onReport) {
      return el("button", { class: "btn secondary", type: "button", onclick: () => onReport(machineTypes && machineTypes.length ? machineTypes : null) }, "🛠 Maintenance Request");
    }
    return el("a", { class: "btn secondary link-as-btn", href: MAINTENANCE_FORM_URL, target: "_blank", rel: "noopener" }, "🛠 Maintenance Request");
  }

  // Last PM / last repair (from Odoo) and open issues for a set of machines — like the old library's panel.
  function maintenancePanel(machineList) {
    if (!machineList.length) return null;
    const ids = new Set(machineList.map((m) => m.id));
    const open = (data.openIssues || []).filter((i) => ids.has(i.machineId));
    const fmt = (d) => {
      if (!d) return el("span", { class: "muted" }, "—");
      const [y, mo, da] = d.split("-").map(Number);
      const date = new Date(y, mo - 1, da);
      const days = Math.round((new Date().setHours(0, 0, 0, 0) - date) / 86400000);
      return [date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}) }),
        el("small", { class: "muted" }, ` ${days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`}`)];
    };
    return el(
      "div",
      { class: "card maint-panel" },
      open.length
        ? [el("strong", {}, `🚨 Open issues (${open.length})`), el("div", { class: "issue-grid" }, open.map((i) => issueCard(i, () => onIssues && onIssues())))]
        : null,
      el("strong", {}, "🔧 Last maintenance ", el("small", { class: "muted" }, "from Odoo")),
      el(
        "table",
        { class: "info-table" },
        el("tr", {}, el("th", {}, "Machine"), el("th", {}, "Last PM"), el("th", {}, "Last repair")),
        machineList.map((m) => el("tr", {}, el("td", {}, `${m.id} · ${m.lineId ? lineName(m.lineId) : m.name}`), el("td", {}, fmt(m.lastPmDate)), el("td", {}, fmt(m.lastRepairDate))))
      )
    );
  }

  function machinesOfCategory(categoryId) {
    const types = data.fixCategories?.find((c) => c.id === categoryId)?.machineTypes || [];
    return (data.machines || []).filter((m) => m.active !== false && types.includes(m.type));
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
    return el(
      "div",
      { class: "card" },
      el("strong", {}, "Admin tools"),
      el("button", { class: "btn secondary", type: "button", onclick: () => show("gaps") }, `Searches with no results (${ui.gaps ? open : "…"})`),
      el("button", { class: "btn secondary", type: "button", onclick: () => show("qr") }, "Print QR codes"),
      el("button", { class: "btn secondary", type: "button", onclick: downloadCsv }, "Download all fixes (CSV)"),
      el("button", { class: "btn secondary", type: "button", onclick: () => show("bulk") }, "Bulk add fixes"),
      importCard()
    );
  }

  function renderGaps() {
    const gaps = [...(ui.gaps || [])].sort((a, b) => (a.done - b.done) || ((b.lastAt?.toMillis?.() || 0) - (a.lastAt?.toMillis?.() || 0)));
    async function mark(g, done) {
      if (await act(() => callAdminMarkSearchGap({ id: g.id, done }))) show("gaps");
    }
    return [
      back("Fix Library", () => show("list")),
      el("h1", {}, "Searches with no results"),
      el("p", { class: "hint" }, "What people looked for and didn't find — the fixes to write next. Tap Done once it's written."),
      messageBox(),
      !ui.gaps ? el("p", { class: "hint" }, "Loading…") : !gaps.length ? el("p", { class: "hint" }, "None yet.") : null,
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

  // One QR code per category, printable — scanning opens the app on that category (?cat=Name).
  function renderQr() {
    const list = categories().filter((c) => (data.fixes || []).some((f) => f.categoryId === c.id));
    const grid = el("div", { class: "qr-grid" }, el("p", { class: "hint" }, "Making QR codes…"));
    loadQrLibrary().then(
      () => {
        grid.replaceChildren(
          ...list.map((c) => {
            const url = `${APP_URL}/?cat=${encodeURIComponent(c.name)}`;
            const qr = window.qrcode(0, "M");
            qr.addData(url);
            qr.make();
            const box = el("div", { class: "qr-card" });
            box.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true }); // made locally from our own link
            box.append(el("strong", {}, c.name), el("small", {}, "Scan for fixes"));
            return box;
          })
        );
      },
      () => grid.replaceChildren(el("p", { class: "message error" }, "Couldn't load the QR code maker. Check Wi-Fi and try again."))
    );
    return [
      el("div", { class: "no-print" }, back("Fix Library", () => show("list")), el("h1", {}, "QR codes"),
        el("p", { class: "hint" }, "One per category. Scanning opens CDG Ops straight to that category's fixes."),
        el("button", { class: "btn", type: "button", onclick: () => window.print() }, "Print")),
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
    async function addAll() {
      const items = parseBulkFixes(ui.bulkText);
      if (!items.length) return;
      if (!confirm(`Add ${items.length} fixes? They go live right away.`)) return;
      const r = await act(() => callAdminBulkAddFixes({ items }));
      if (r) {
        ui.bulkText = "";
        show("list", `Added ${r.added} fixes.${r.newCategories.length ? ` New categories: ${r.newCategories.join(", ")}.` : ""}`, "ok");
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
      el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: addAll }, ui.busy ? "Adding…" : "Add all"),
    ];
  }

  function fixRow(f) {
    const icons = [(f.photos || []).length ? "📷" : "", (f.videos || []).length ? "🎥" : "", f.docLink ? "📄" : ""].join(" ").trim();
    const tag =
      f.status === "pending" ? el("span", { class: "tag warn" }, f.editOf ? "Suggested change" : "Waiting for approval")
      : f.status === "rejected" ? el("span", { class: "tag off" }, "Not approved")
      : f.status === "retired" ? el("span", { class: "tag off" }, "Retired")
      : null;
    return el(
      "button",
      { class: "person-row", type: "button", onclick: () => { ui.fixId = f.id; show("fix"); } },
      el("span", { class: "person-name" }, f.title),
      el("span", { class: "person-meta" }, [categoryName(f.categoryId), icons].filter(Boolean).join(" · ")),
      el("span", { class: "tags" }, tag)
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
        ui.busy ? "Copying… (a few minutes — keep this open)" : imported ? "Copy again" : "Copy the old library"
      )
    );
  }

  async function runImport() {
    const r = await act(() => callAdminImportOldLibrary());
    if (r) {
      const problems = r.fileProblems?.length ? ` ${r.fileProblems.length} files couldn't be copied — run it again to retry.` : "";
      const gaps = r.searchGapsCopied ? ` ${r.searchGapsCopied} no-result searches copied.` : "";
      show("list", `Copied ${r.fixesSaved} fixes in ${r.categories} categories. Files: ${r.filesCopied} copied, ${r.filesSkipped} already here.${gaps}${problems}`, problems ? "error" : "ok");
    }
  }

  // ---- one fix ------------------------------------------------------------

  function media(f) {
    const parts = [];
    (f.photos || []).forEach((url, i) => {
      parts.push(
        isOwnFile(url)
          ? el("a", { href: url, target: "_blank", rel: "noopener" }, el("img", { class: "fix-photo", src: url, alt: `Photo ${i + 1}`, loading: "lazy" }))
          : el("a", { class: "btn secondary", href: url, target: "_blank", rel: "noopener" }, `Open photo ${i + 1}`)
      );
    });
    (f.videos || []).forEach((url, i) => {
      const yt = youtubeId(url);
      if (isOwnFile(url)) parts.push(el("video", { class: "fix-video", src: url, controls: true, preload: "metadata", playsinline: true }));
      else if (yt) parts.push(el("a", { class: "btn secondary", href: `https://www.youtube.com/watch?v=${yt}`, target: "_blank", rel: "noopener" }, `Watch video ${i + 1} (YouTube)`));
      else parts.push(el("a", { class: "btn secondary", href: url, target: "_blank", rel: "noopener" }, `Open video ${i + 1}`));
    });
    if (f.docLink) parts.push(el("a", { class: "btn secondary", href: f.docLink, target: "_blank", rel: "noopener" }, "Open document"));
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
      await act(() => callVoteFix({ id: f.id, helpful }));
      render();
    }
    async function review(approve) {
      if (!approve && !confirm("Reject this suggestion? It won't be published.")) return;
      const r = await act(() => callReviewFix({ id: f.id, approve }));
      if (r) {
        ui.fixId = r.id;
        show(approve ? "fix" : "list", approve ? "Approved — everyone can see it now." : "Suggestion rejected.", "ok");
      }
    }
    async function retire(retiring) {
      if (retiring && !confirm("Retire this fix? It's hidden from the library but kept in history. You can bring it back.")) return;
      if (await act(() => callRetireFix({ id: f.id, retire: retiring }))) show("fix", retiring ? "Fix retired." : "Fix is back.", "ok");
    }

    return [
      back("Fix Library", () => show("list")),
      el("h1", { class: "fix-title" }, f.title),
      appliesTo(f),
      f.status === "pending"
        ? el("p", { class: "message ok" }, f.editOf ? `Suggested change to "${original?.title || "a fix"}" — waiting for approval.` : "Waiting for approval.")
        : null,
      f.status === "rejected" ? el("p", { class: "message error" }, "This suggestion wasn't approved.") : null,
      f.status === "retired" ? el("p", { class: "message error" }, "Retired — hidden from the library.") : null,
      messageBox(),
      el("div", { class: "fix-body" }, f.body),
      media(f),
      (f.tags || []).length ? el("p", { class: "tags" }, f.tags.map((t) => el("span", { class: "tag" }, t))) : null,
      f.status === "approved"
        ? el(
            "div",
            { class: "helpful" },
            el("span", {}, "Was this helpful?"),
            el("button", { class: myVote === true ? "chip on" : "chip", type: "button", disabled: ui.busy, onclick: () => vote(true) }, `👍 ${f.helpfulYes || 0}`),
            el("button", { class: myVote === false ? "chip on" : "chip", type: "button", disabled: ui.busy, onclick: () => vote(false) }, `👎 ${f.helpfulNo || 0}`)
          )
        : null,
      me.approver && f.status === "pending"
        ? [
            el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => review(true) }, "Approve"),
            el("button", { class: "btn danger", type: "button", disabled: ui.busy, onclick: () => review(false) }, "Reject"),
          ]
        : null,
      f.status === "approved" || (f.status === "pending" && (me.approver || f.createdBy === me.emp))
        ? el(
            "button",
            { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => startForm(f) },
            me.approver || f.status === "pending" ? "Edit" : "Suggest a change"
          )
        : null,
      me.approver && f.status === "approved"
        ? el("button", { class: "btn danger", type: "button", disabled: ui.busy, onclick: () => retire(true) }, "Retire fix")
        : null,
      me.approver && f.status === "retired"
        ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => retire(false) }, "Bring fix back")
        : null,
      maintenanceRequestButton(data.fixCategories?.find((c) => c.id === f.categoryId)?.machineTypes),
      maintenancePanel(machinesFor(f)),
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

  function startForm(existing) {
    ui.draft = existing
      ? {
          id: existing.id, title: existing.title, categoryId: existing.categoryId, body: existing.body,
          tags: (existing.tags || []).join(", "), photos: [...(existing.photos || [])], videos: [...(existing.videos || [])],
          docLink: existing.docLink || "", machineIds: [...(existing.machineIds || [])], link: "",
        }
      : {
          id: null, title: "", categoryId: ui.category !== "all" && ui.category !== "pending" ? ui.category : "",
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
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${me.emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    ui.busy = true;
    await new Promise((resolve) => {
      task.on(
        "state_changed",
        (s) => { ui.upload = `Uploading ${file.name}: ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`; render(); },
        (err) => { Object.assign(ui, { message: friendlyError(err), messageKind: "error" }); resolve(); },
        async () => {
          const url = await getDownloadURL(task.snapshot.ref);
          if (kind === "doc") d.docLink = url;
          else d[kind].push(url);
          resolve();
        }
      );
    });
    Object.assign(ui, { busy: false, upload: "" });
    render();
  }

  function renderForm() {
    const d = ui.draft;
    const cat = data.fixCategories?.find((c) => c.id === d.categoryId);
    const candidates = (data.machines || []).filter((m) => m.active !== false && cat && !(cat.machineTypes || []).includes(m.type));

    async function save(e) {
      e.preventDefault();
      const payload = {
        ...(d.id ? { id: d.id } : {}),
        title: d.title, categoryId: d.categoryId, body: d.body,
        tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
        photos: d.photos, videos: d.videos, docLink: d.docLink.trim(), machineIds: d.machineIds,
      };
      const r = await act(() => callSubmitFix(payload));
      if (!r) return;
      ui.fixId = r.id;
      const msg =
        r.status === "approved" ? "Saved — everyone can see it now."
        : r.editOf ? "Thanks! Your change was sent for approval."
        : "Thanks! Your fix was sent for approval.";
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
      back(d.id ? "Back" : "Fix Library", () => show(d.id ? "fix" : "list")),
      el("h1", {}, d.id ? (me.approver || fix()?.status === "pending" ? "Edit fix" : "Suggest a change") : "Add a fix"),
      me.approver ? null : el("p", { class: "hint" }, "An Admin approves it before everyone sees it."),
      messageBox(),
      ui.upload ? el("p", { class: "message ok" }, ui.upload) : null,
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "fx-title" }, "Title — what's the problem?"),
        el("input", { class: "field", id: "fx-title", maxlength: "120", required: true, value: d.title, oninput: (e) => { d.title = e.target.value; } }),
        el("label", { class: "field-label", for: "fx-cat" }, "Category"),
        el(
          "select",
          { class: "field", id: "fx-cat", required: true, onchange: (e) => { d.categoryId = e.target.value; d.machineIds = []; render(); } },
          el("option", { value: "" }, "Pick one…"),
          categories().map((c) => el("option", { value: c.id, selected: c.id === d.categoryId }, c.name))
        ),
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
          el("button", { class: "btn secondary", type: "button", onclick: addLink }, "Add")
        ),

        el("label", { class: "field-label", for: "fx-tags" }, "Tags (optional, separated by commas)"),
        el("input", { class: "field", id: "fx-tags", value: d.tags, oninput: (e) => { d.tags = e.target.value; } }),

        candidates.length
          ? el(
              "details",
              { class: "more" },
              el("summary", {}, "Also show on other machines (optional)"),
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
          ui.busy ? "Saving…" : me.approver ? "Save" : "Send for approval"
        )
      ),
    ];
  }

  function render() {
    const views = { list: renderList, fix: renderFix, form: renderForm, gaps: renderGaps, qr: renderQr, bulk: renderBulk };
    container.replaceChildren(...[(views[ui.view] || renderList)()].flat(2).filter(Boolean));
  }

  // Live updates redraw the screen — but not while typing (form, search box, bulk add) or on the QR page.
  const redraw = () => {
    const typing =
      ["form", "bulk", "qr"].includes(ui.view) || (ui.view === "list" && document.activeElement?.classList.contains("search"));
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
