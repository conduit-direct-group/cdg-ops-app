// Admin → Reset test data (test site only). Shows how many practice records there are, and the REAL open requests
// (which are never changed here — close them in Odoo or tap "Line is back up" in Open issues), then removes every
// practice record on a confirm. Practice records older than 24 hours also clear themselves every night.

import { el, friendlyError, spinner, banner, toast, confirmSheet, emptyState } from "./ui.js";
import { callAdminTestData } from "./firebase.js";

const age = (ms) => {
  if (!ms) return "";
  const h = Math.floor((Date.now() - ms) / 3600000);
  return h < 24 ? `${h} h old` : `${Math.floor(h / 24)} days old`;
};

export function openTestReset(container, { onExit, onIssues = null }) {
  const ui = { loading: true, busy: false, counts: null, total: 0, real: [], message: "", messageKind: "", retry: null };

  async function load() {
    Object.assign(ui, { loading: true, message: "", retry: null });
    render();
    try {
      const out = (await callAdminTestData({ reset: false })).data;
      Object.assign(ui, { loading: false, counts: out.counts, total: out.total, real: out.real || [] });
    } catch (err) {
      Object.assign(ui, { loading: false, message: friendlyError(err), messageKind: "error", retry: load });
    }
    render();
  }

  async function reset() {
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: reset }); return render(); }
    if (!(await confirmSheet({ title: `Delete all ${ui.total} practice records?`, text: "Only TEST records on the test site. Live records, Odoo, and the training workbook are never touched. This can't be undone.", confirmLabel: "Delete practice records", danger: true }))) return;
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const out = (await callAdminTestData({ reset: true })).data;
      toast(`${out.total} practice records deleted`);
      ui.busy = false;
      await load();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: reset });
      render();
    }
  }

  function render() {
    const rows = (ui.counts || []).filter((c) => c.count);
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
      el("h1", {}, "🧹 Reset test data"),
      el("p", { class: "hint" }, "Test site only. Practice (TEST) records older than 24 hours also delete themselves every night."),
      banner(ui),
      ui.loading ? spinner("Counting practice records…") : [
        el("section", { class: "card" },
          el("strong", {}, ui.total ? `Practice records: ${ui.total}` : "✓ No practice records"),
          rows.length ? el("table", { class: "info-table" }, rows.map((c) => el("tr", {}, el("th", {}, c.label), el("td", {}, String(c.count))))) : null,
          ui.total ? el("button", { class: "btn danger", type: "button", disabled: ui.busy, onclick: reset }, ui.busy ? "Deleting…" : `Delete all ${ui.total} practice records`) : null),
        el("section", { class: "card" },
          el("strong", {}, `Real open maintenance requests (not touched): ${ui.real.length}`),
          el("p", { class: "card-note" }, "These come from Odoo. Close them in Odoo, or tap “Line is back up” in Open issues once the line runs."),
          ui.real.length
            ? el("div", { class: "person-list" }, ui.real.map((r) => el("div", { class: r.lineDown || r.unsafe ? "person-row urgent static" : "person-row static" },
                el("span", { class: "person-name" }, `${r.odooId ? `Odoo #${r.odooId}` : "No Odoo #"} · ${r.machine ? `${r.machine} (${r.machineId})` : r.machineId || "no machine set"}`),
                el("span", { class: "person-meta" }, [r.lineDown ? "⛔ Line down" : null, r.unsafe ? "⚠ Unsafe" : null, age(r.reportedAt), r.title].filter(Boolean).join(" · ")))))
            : emptyState("None open", ""),
          onIssues && ui.real.length ? el("button", { class: "btn secondary", type: "button", onclick: onIssues }, "Open issues") : null),
      ],
    ].flat(3).filter(Boolean));
  }

  load();
  return () => {};
}
