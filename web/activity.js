// Admin → Admin activity: every admin action (and other changes the server logs) with who and when.
// Read straight from the audit log, which only the server writes and only admins can read.

import { el, friendlyError, spinner, emptyState, banner, collapsible } from "./ui.js";
import { db, callAdminListEmployees } from "./firebase.js";
import { collection, getDocs, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const KINDS = {
  fix: "fix", issue: "problem report", line: "line", machine: "machine", role: "role", checklist: "checklist",
  search: "no-result search", odoo: "Odoo", trash: "trash bin",
};

const ACTIONS = {
  created: "added", updated: "changed", "suggested-edit": "suggested a change to", approved: "approved", "approved-edit": "approved a change to",
  rejected: "rejected", retired: "retired", restored: "brought back", deleted: "deleted (to trash)", "restored-from-trash": "restored from the trash",
  "restored-version": "restored an older version of", "restored-file": "put a file back on", "bulk-added": "bulk-added", imported: "copied from the old library:",
  reported: "reported a problem on", fixed: "marked fixed", "updated-media": "changed training media on", "marked-done": "marked done:",
  "marked-not-done": "put back on the list:", synced: "synced", purged: "emptied old items from", cleanup: "ran the nightly",
  "pin-reset": "reset the PIN of", unlocked: "unlocked", locked: "was locked out —", "pin-changed": "changed their PIN —",
};

function describe(e, name) {
  const action = ACTIONS[e.type] || e.type;
  // Record retention (Decision 99): the nightly count per group, and period changes.
  if (e.type === "cleanup") {
    const parts = Object.entries(e.removed || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`);
    return `${action} record cleanup — removed ${parts.length ? parts.join(", ") : "nothing"}${e.errors ? ` (${e.errors} problem${e.errors === 1 ? "" : "s"} — see Record retention)` : ""}`;
  }
  if (e.kind === "record retention" && e.type === "updated") {
    const days = (d) => (d == null ? "never delete" : `${d} days`);
    return `changed how long “${e.recordId}” records are kept: ${days(e.from)} → ${days(e.to)}`;
  }
  if (e.employeeNumber) return `${action} employee ${name(e.employeeNumber)}${e.type === "updated" && e.changes ? ` (${Object.keys(e.changes).join(", ")})` : ""}`;
  const what = e.title || e.name || e.term || e.machineId || e.recordId || "";
  const extra = e.type === "bulk-added" ? `${e.count} fixes` : e.type === "purged" ? `${e.fixes || 0} fixes, ${e.files || 0} files` : "";
  return [action, KINDS[e.kind] || e.kind || "", what && `“${what}”`, extra, e.test ? "[TEST]" : ""].filter(Boolean).join(" ");
}

export function openActivity(container, { onExit }) {
  const ui = { list: null, names: new Map(), message: "", messageKind: "", retry: null };

  async function load() {
    Object.assign(ui, { list: null, message: "", retry: null });
    render();
    try {
      const [snap, people] = await Promise.all([
        getDocs(query(collection(db, "auditLog"), orderBy("at", "desc"), limit(300))),
        callAdminListEmployees().catch(() => ({ data: { employees: [] } })),
      ]);
      ui.names = new Map(people.data.employees.map((e) => [e.employeeNumber, e.name]));
      ui.list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
      Object.assign(ui, { list: [], message: friendlyError(err), messageKind: "error", retry: load });
    }
    render();
  }

  const name = (emp) => (emp === "system" ? "Automatic" : emp === "old-library" ? "Old library" : ui.names.get(emp) || `#${emp}`);

  function render() {
    const days = new Map();
    for (const e of ui.list || []) {
      const d = e.at?.toDate?.();
      const key = d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Just now";
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(e);
    }
    const row = (e) =>
      el(
        "div",
        { class: "import-row" },
        el("span", { class: "import-line" }, e.at?.toDate?.().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) || ""),
        el("span", { class: "gap-term" }, el("strong", {}, name(e.by)), ` ${describe(e, name)}`)
      );
    container.replaceChildren(
      ...[
        el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
        el("h1", {}, "📜 Admin activity"),
        el("p", { class: "hint" }, "Every change made through the app, newest first: who did it and when. Kept permanently; nobody can edit it."),
        banner(ui),
        !ui.list ? spinner("Loading activity…") : !ui.list.length && !ui.message ? emptyState("Nothing yet", "Admin actions show up here as they happen.") : null,
        [...days].map(([day, list], n) =>
          n < 2
            ? [el("h2", {}, day), el("div", { class: "import-preview" }, list.map(row))]
            : collapsible(`activity-${day}`, `${day} (${list.length})`, el("div", { class: "import-preview" }, list.map(row)))
        ),
      ].flat(3).filter(Boolean)
    );
  }

  load();
  return () => {};
}
