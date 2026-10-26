// Admin → Record retention (Decision 99). How long each group of records is kept before the nightly cleanup removes it,
// and a log of what each night's cleanup removed. Write-ups and injury reports need HR access to change; injury reports
// are kept at least 5 years. Nothing still open is ever removed. Rules: functions/retentionrules.js.

import { el, friendlyError, spinner, emptyState, banner, toast, picker, confirmSheet, collapsible } from "./ui.js";
import { callAdminRetention, callAdminSaveRetention } from "./firebase.js";

const fmtRun = (ms) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const label = (g, days) => g.choices.find((c) => c.days === days)?.label || (days == null ? "Never delete" : `${days} days`);

export function openRetentionAdmin(container, { onExit }) {
  const ui = { data: null, loadError: "", busy: false, message: "", messageKind: "", retry: null };

  async function load() {
    if (!navigator.onLine) { ui.loadError = friendlyError({ code: "offline" }); return render(); }
    ui.loadError = "";
    render();
    try { ui.data = (await callAdminRetention()).data; } catch (err) { ui.loadError = friendlyError(err); }
    render();
  }

  async function change(g, days) {
    if (days === g.days) return;
    const shorter = days != null && (g.days == null || days < g.days);
    if (shorter && !(await confirmSheet({
      title: `Keep ${g.label.toLowerCase()} ${label(g, days).toLowerCase()}?`,
      text: `Closed records older than ${label(g, days).toLowerCase()} will be removed at the next nightly cleanup (2:30 AM). After that they can be brought back only from a backup, and only within the backup window.`,
      confirmLabel: "Change it", danger: true,
    }))) return render();
    const send = async () => {
      if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: send }); return render(); }
      Object.assign(ui, { busy: true, message: "" });
      render();
      try {
        await callAdminSaveRetention({ key: g.key, days });
        toast(`${g.label}: ${label(g, days)}`);
        Object.assign(ui, { busy: false, retry: null });
        await load();
      } catch (err) { Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: send }); render(); }
    };
    send();
  }

  function group(g) {
    return el("div", { class: "seat-row" },
      el("div", { class: "seat-head" }, el("strong", {}, g.label), g.hr ? el("span", { class: "tag" }, "🔒 HR access") : null),
      el("span", { class: "person-meta" }, g.covers),
      g.canChange
        ? picker({ title: g.label, value: g.days == null ? "never" : String(g.days), options: g.choices.map((c) => ({ value: c.days == null ? "never" : String(c.days), label: c.label })), onChange: (v) => change(g, v === "never" ? null : Number(v)) })
        : el("p", { class: "ret-period" }, label(g, g.days)),
      g.locked ? el("span", { class: "person-meta" }, "🔒 Locked — always kept as proof people were told.") : !g.canChange && g.hr ? el("span", { class: "person-meta" }, "Changing this needs HR access.") : null,
      g.days !== g.defaultDays ? el("span", { class: "person-meta" }, `Plan default: ${label(g, g.defaultDays)}`) : null);
  }

  function run(r, names) {
    const removed = Object.entries(r.removed).filter(([, n]) => n > 0);
    const kept = Object.entries(r.keptOpen).filter(([, n]) => n > 0);
    return el("div", { class: "ret-run" },
      el("strong", {}, fmtRun(r.atMs)),
      el("span", {}, removed.length ? `Removed: ${removed.map(([k, n]) => `${names[k] || k} ${n}`).join(" · ")}` : "Removed nothing"),
      kept.length ? el("span", { class: "person-meta" }, `Kept because still open: ${kept.map(([k, n]) => `${names[k] || k} ${n}`).join(" · ")}`) : null,
      r.errors.length ? el("span", { class: "message error" }, `⚠ Problems: ${r.errors.join("; ")}`) : null);
  }

  function render() {
    const d = ui.data;
    const names = Object.fromEntries((d?.groups || []).map((g) => [g.key, g.label]));
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
      el("h1", {}, "🗄 Record retention"),
      el("p", { class: "hint" }, "Every night at 2:30 AM the cleanup removes closed records older than these periods. Anything still open — an unfinished checklist, an undecided reel, an open safety action, an unsigned write-up — is never removed, however old."),
      el("p", { class: "message" }, "Backups have their own schedule: daily backups are kept 7 days and weekly backups 14 weeks. A record removed by the cleanup can be brought back only from a backup, and only within that window."),
      banner(ui),
      ui.loadError ? banner({ message: ui.loadError, messageKind: "error", retry: load }) : null,
      !d && !ui.loadError ? spinner("Loading…") : null,
      d ? el("section", { class: "card" }, el("strong", {}, "How long records are kept"), el("div", { class: "seat-list ret-groups" }, d.groups.map(group))) : null,
      d ? el("section", { class: "card" }, el("strong", {}, "Cleanup log"),
        d.runs.length
          ? [run(d.runs[0], names), d.runs.length > 1 ? collapsible("ret-runs", `Earlier nights (${d.runs.length - 1})`, el("div", { class: "ret-runs" }, d.runs.slice(1).map((r) => run(r, names)))) : null]
          : emptyState("No cleanups yet", "The first one runs tonight at 2:30 AM. Each night's count shows here and in Admin activity.")) : null,
    ].flat(3).filter(Boolean));
  }

  load();
  return () => {};
}
