// Downtime & Scrap shift report (Chris, 10-22-2026). Line Leads and Supervisors enter each changeover, downtime
// event, and partial reel / scrap as it happens, then sign with a PIN. Flagged reels decided Scrap or Regrind show up
// in the scrap list on their own (never entered twice). Rules and workbook columns: functions/downtime.js.
// The SharePoint workbook isn't connected yet — Export to Excel gives the rows for each tab.

import { el, friendlyError, spinner, emptyState, banner, toast, picker, choose, collapsible } from "./ui.js";
import { data } from "./data.js";
import { TEST_MODE, callShiftReport, callSaveShiftReport, callSaveShiftEntry, callSignShiftReport, callExportShiftReports, callSignoffPeople } from "./firebase.js";
import { signOff } from "./signoff.js";
import { openReportForm } from "./issues.js";

export const DOWNTIME_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const SIGN_ROLES = ["lead", "supervisor", "plant-manager"];
const EXPORT_ROLES = ["supervisor", "plant-manager", "admin"];
const LINE_KEY = "cdg.lineCheckLine"; // the line tablet's line (shared with the Line Check Log)
const MAINT = [["none", "No"], ["team", "Fixed by our team"], ["called", "Maintenance called"]];

export const usesDowntime = (roles) => roles.some((r) => DOWNTIME_ROLES.includes(r));
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const fmtDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const plainNum = (n) => Number(n).toLocaleString("en-US");

// Gray until the last hour, red in the last hour or after, green once signed (Home color rule).
function signTag(r, now = Date.now()) {
  if (r.signed) return el("span", { class: "tag ok" }, `✓ Signed by ${r.signed.byName}`);
  if (r.endMs && now >= r.endMs - 3600000) return el("span", { class: "tag off" }, `⚠ Not signed — due ${fmtTime(r.endMs)}`);
  return el("span", { class: "tag" }, r.endMs ? `Not signed — due by ${fmtTime(r.endMs)}` : "Not signed");
}

export function openDowntime(container, { me, onExit, backLabel = "Home" }) {
  const lines = () => (data.lines || []).filter((l) => l.active !== false);
  const keepLine = stored(LINE_KEY);
  const ui = {
    lineId: lines().some((l) => l.id === keepLine) ? keepLine : null, reportId: null,
    view: null, loading: false, loadError: "", busy: false, message: "", messageKind: "", retry: null,
    head: null, form: null, exp: null, sub: null,
  };

  const say = (message, retry = null, kind = "error") => { Object.assign(ui, { busy: false, message, messageKind: kind, retry }); render(); };

  async function load(keepForm = false) {
    if (!ui.lineId && !ui.reportId) return render();
    if (!navigator.onLine) { Object.assign(ui, { loadError: friendlyError({ code: "offline" }), loading: false }); return render(); }
    Object.assign(ui, { loading: true, loadError: "" });
    render();
    try {
      ui.view = (await callShiftReport(ui.reportId ? { reportId: ui.reportId } : { lineId: ui.lineId })).data;
      const r = ui.view.report;
      ui.head = { team: r.team || "", size: r.size || "", sdr: r.sdr || "", otherSize: "" };
      if (r.size && !ui.view.lists.sizes.includes(r.size)) Object.assign(ui.head, { size: "other", otherSize: r.size });
      if (!keepForm) ui.form = null;
      ui.loading = false;
    } catch (err) {
      Object.assign(ui, { loading: false, loadError: friendlyError(err) });
    }
    render();
  }

  // Runs a save; reloads the report after. Returns true when it worked.
  async function act(fn, retry, done) {
    if (!navigator.onLine) { say(friendlyError({ code: "offline" }), retry); return false; }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      await fn();
      ui.busy = false;
      if (done) toast(done);
      await load();
      return true;
    } catch (err) { say(friendlyError(err), retry); return false; }
  }

  const report = () => ui.view?.report;
  const locked = () => !!report()?.signed;
  const headSize = () => (ui.head.size === "other" ? ui.head.otherSize.trim() : ui.head.size);

  function headerPayload(extra = {}) {
    const r = report();
    return { ...(r.saved ? { reportId: r.id } : { lineId: r.lineId }), team: ui.head.team, size: headSize(), sdr: ui.head.sdr, ...extra };
  }

  async function saveHeader(extra = {}, done = "Saved") {
    return act(() => callSaveShiftReport(headerPayload(extra)), () => saveHeader(extra, done), done);
  }

  async function saveEntry(kind) {
    const f = ui.form;
    const payload = kind === "downtime"
      ? { minutes: f.minutes, reason: f.reason, called: f.called === true, calledWho: f.calledWho, maintenance: f.maintenance, issueId: f.maintenance === "called" ? f.issueId : null, fix: f.fix }
      : { feet: f.feet, reason: f.reason, notes: f.notes, tag: f.tag };
    if (kind === "scrap" && f.tag && (ui.view.scraps || []).some((s) => s.source === "reel" && s.tag && s.tag.toLowerCase() === f.tag.trim().toLowerCase())) {
      const go = await choose({ title: `Reel tag ${f.tag.trim()} is already counted from Flagged Reels. Add it again anyway?`, options: [{ value: "yes", label: "Yes — it's a different piece" }] });
      if (!go) return;
    }
    await act(() => callSaveShiftEntry({ reportId: report().id, kind, ...(f.id ? { id: f.id } : {}), ...payload }), () => saveEntry(kind), f.id ? "Updated" : kind === "downtime" ? "Downtime added" : "Scrap added");
  }

  async function removeEntry(kind, e) {
    const ok = await choose({ title: kind === "downtime" ? `Remove ${e.minutes} min · ${e.reason}?` : `Remove ${plainNum(e.feet)} ft · ${e.reason}?`, options: [{ value: "yes", label: "Yes, remove it" }] });
    if (ok) await act(() => callSaveShiftEntry({ reportId: report().id, kind, id: e.id, remove: true }), () => removeEntry(kind, e), "Removed");
  }

  async function sign() {
    const r = report();
    const out = await signOff({
      title: "Sign shift report (PIN)", what: `${r.lineName} · ${fmtDay(r.date)} · ${r.shiftName}${r.team ? ` · Team ${r.team}` : ""}`,
      me: me.roles.some((x) => SIGN_ROLES.includes(x)) ? { emp: me.emp, name: me.name } : null,
      others: async () => (await callSignoffPeople({ kind: "shift-report" })).data.people,
      action: async ({ signer, device }) => (await callSignShiftReport({ reportId: r.id, comments: ui.comments ?? r.comments ?? "", signer, device })).data,
    });
    if (out) { toast(`Signed by ${out.name}${TEST_MODE ? " (test)" : ""}`); ui.comments = undefined; await load(); }
  }

  // "+ New Maintenance Request" opens the usual form; back here, the newest request on the line is picked.
  function newRequest() {
    const before = new Set((ui.view.issues || []).map((i) => i.id));
    ui.sub = true;
    openReportForm(container, {
      me, onExit: async () => {
        ui.sub = null;
        await load(true);
        const added = (ui.view?.issues || []).find((i) => !before.has(i.id));
        if (added && ui.form) { ui.form.issueId = added.id; render(); }
      },
    });
  }

  async function exportXlsx() {
    const x = ui.exp;
    if (!navigator.onLine) return say(friendlyError({ code: "offline" }), exportXlsx);
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const out = (await callExportShiftReports({ from: x.from, to: x.to })).data;
      await downloadWorkbook(out);
      ui.busy = false;
      const n = Object.values(out.rows).reduce((a, r) => a + r.length, 0);
      toast(`Exported ${n} row${n === 1 ? "" : "s"}`);
      render();
    } catch (err) { say(friendlyError(err), exportXlsx); }
  }

  // ---- drawing ----

  const label = (t) => el("span", { class: "field-label strong" }, t);
  const chips = (list, value, set, labelOf = (x) => x) => el("div", { class: "chips" }, list.map((x) =>
    el("button", { class: value === x ? "chip on" : "chip", type: "button", "aria-pressed": String(value === x), disabled: ui.busy, onclick: () => { set(x); render(); } }, labelOf(x))));
  const num = (value, set, placeholder, max) => el("input", { class: "field", type: "number", inputmode: "numeric", min: "1", max, step: "1", value: value ?? "", placeholder, oninput: (e) => set(e.target.value) });

  function linePicker() {
    return el("div", {},
      label("Line"),
      chips(lines().map((l) => l.id), ui.lineId, (v) => { ui.lineId = v; ui.reportId = null; store(LINE_KEY, v); load(); }, (id) => lines().find((l) => l.id === id)?.name || id));
  }

  function headerCard() {
    const r = report();
    const L = ui.view.lists;
    const h = ui.head;
    const changed = !r.saved || headSize() !== (r.size || "") || h.sdr !== (r.sdr || "") || (r.needTeamPick && h.team !== r.team) || (ui.view.lists.saturdayTeams.includes(r.team) && h.team !== r.team);
    const needTeam = r.needTeamPick || L.saturdayTeams.includes(r.team);
    return el("section", { class: "card" },
      el("strong", {}, "Product running"),
      locked()
        ? el("p", {}, `${r.productSize} · Team ${r.team}`)
        : [
          needTeam ? [label("Team (Saturday)"), chips(L.saturdayTeams, h.team, (v) => { h.team = v; })] : null,
          label("Size"), chips([...L.sizes, "other"], h.size, (v) => { h.size = v; }, (x) => (x === "other" ? "Other size…" : x)),
          h.size === "other" ? el("input", { class: "field", value: h.otherSize, maxlength: "30", placeholder: "Specialty size, e.g. 3\"", oninput: (e) => { h.otherSize = e.target.value; } }) : null,
          label("Wall"), chips(L.sdrs, h.sdr, (v) => { h.sdr = v; }),
          changed ? el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => saveHeader({}, "Product saved") }, ui.busy ? "Saving…" : r.saved ? "Save product change" : "Start the shift report") : null,
          r.saved ? el("p", { class: "card-note" }, "Change it when the product changes — new entries use the product shown here.") : el("p", { class: "card-note" }, "Pick the product first; then add changeover, downtime, and scrap as they happen."),
        ]);
  }

  function changeoverCard() {
    const r = report();
    const f = ui.form?.kind === "changeover" ? ui.form : null;
    const c = r.changeover;
    return el("section", { class: "card" },
      el("strong", {}, "🔁 Changeover (once per shift)"),
      f
        ? [
          label("Minutes"), num(f.minutes, (v) => { f.minutes = v; }, "min", "1440"),
          label("Type"), chips(ui.view.lists.changeoverTypes, f.type, (v) => { f.type = v; }),
          el("p", { class: "card-note" }, `Logged for the product above: ${headSize()} ${ui.head.sdr}`.trim()),
          el("div", { class: "btn-row" },
            el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => saveHeader({ changeover: { minutes: f.minutes, type: f.type } }, "Changeover saved") }, ui.busy ? "Saving…" : "Save changeover"),
            el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.form = null; render(); } }, "Cancel")),
        ]
        : c
          ? [
            el("p", {}, `${c.minutes} min · ${c.type} · ${c.productSize}`),
            locked() ? null : el("span", { class: "dt-actions" },
              el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => { ui.form = { kind: "changeover", minutes: String(c.minutes), type: c.type }; render(); } }, "Edit"),
              el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: async () => { if (await choose({ title: "Remove the changeover?", options: [{ value: "yes", label: "Yes, remove it" }] })) saveHeader({ changeover: null }, "Changeover removed"); } }, "Remove")),
          ]
          : locked() ? el("p", { class: "card-note" }, "No changeover this shift.")
            : el("button", { class: "btn secondary", type: "button", disabled: ui.busy || !r.saved, onclick: () => { ui.form = { kind: "changeover", minutes: "", type: "" }; render(); } }, "+ Add changeover"));
  }

  function downtimeForm(f) {
    const issues = ui.view.issues || [];
    return el("div", { class: "entry-form" },
      label("Minutes down"),
      // Redraw only when it crosses 60 minutes (shows / hides the tag), keeping the cursor in the box.
      el("input", { id: "dt-min", class: "field", type: "number", inputmode: "numeric", min: "1", max: "1440", step: "1", value: f.minutes ?? "", placeholder: "min",
        oninput: (e) => { const was = Number(f.minutes) > 60; f.minutes = e.target.value; if (was !== Number(f.minutes) > 60) { render(); container.querySelector("#dt-min")?.focus(); } } }),
      Number(f.minutes) > 60 ? el("p", {}, el("span", { class: "tag" }, "Down more than 60 minutes")) : null,
      label("Reason"),
      picker({ id: "dt-reason", title: "Downtime reason", value: f.reason, placeholder: "Pick the reason…", options: ui.view.lists.downtimeReasons.map((x) => ({ value: x, label: x })), onChange: (v) => { f.reason = v; render(); } }),
      label("Was someone called?"), chips(["yes", "no"], f.called === true ? "yes" : f.called === false ? "no" : "", (v) => { f.called = v === "yes"; }, (x) => (x === "yes" ? "Yes" : "No")),
      f.called ? el("input", { class: "field", value: f.calledWho, maxlength: "60", placeholder: "Who? e.g. Production Manager, Maintenance ext 5", oninput: (e) => { f.calledWho = e.target.value; } }) : null,
      label("Maintenance needed?"), chips(MAINT.map((m) => m[0]), f.maintenance, (v) => { f.maintenance = v; }, (x) => MAINT.find((m) => m[0] === x)[1]),
      f.maintenance === "called"
        ? el("div", {},
          el("p", { class: "card-note" }, "Link the Maintenance Request so it isn't entered twice."),
          issues.length
            ? picker({ id: "dt-issue", title: "Maintenance Request on this line", value: f.issueId || "", placeholder: "Pick the request…", options: [{ value: "", label: "Not linked yet" }, ...issues.map((i) => ({ value: i.id, label: i.title }))], onChange: (v) => { f.issueId = v || null; render(); } })
            : el("p", { class: "hint" }, "No open Maintenance Requests on this line."),
          el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: newRequest }, "🚨 New Maintenance Request"))
        : null,
      label("What was done to find and fix it"), el("textarea", { class: "field", rows: "3", maxlength: "1000", placeholder: "e.g. Float filter clogged on vac tank — cleaned it", oninput: (e) => { f.fix = e.target.value; } }, f.fix),
      el("div", { class: "btn-row" },
        el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => saveEntry("downtime") }, ui.busy ? "Saving…" : f.id ? "Save changes" : "Add downtime"),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.form = null; render(); } }, "Cancel")));
  }

  function downtimeCard() {
    const events = ui.view.events || [];
    const f = ui.form?.kind === "downtime" ? ui.form : null;
    const total = events.reduce((a, e) => a + e.minutes, 0);
    return el("section", { class: "card" },
      el("strong", {}, `⏱ Downtime${events.length ? ` · ${total} min` : ""}`),
      events.length ? el("div", { class: "dt-list" }, events.map((e) => f?.id === e.id ? downtimeForm(f) : el("div", { class: "dt-entry" },
        el("strong", {}, `${e.minutes} min · ${e.reason}`),
        el("span", { class: "dt-note" }, [e.fix, e.called ? `Called: ${e.calledWho}` : "", e.issueTitle ? `Maintenance: ${e.issueTitle}` : ""].filter(Boolean).join(" · ")),
        el("span", { class: "dt-tags" }, el("span", { class: "tag" }, `Contacted: ${e.contacted}`), el("span", { class: "tag" }, `Maintenance log: ${e.maintLog}`)),
        locked() || f ? null : el("span", { class: "dt-actions" },
          el("button", { class: "link-btn", type: "button", onclick: () => { ui.form = { kind: "downtime", id: e.id, minutes: String(e.minutes), reason: e.reason, called: e.called, calledWho: e.calledWho || "", maintenance: e.maintenance, issueId: e.issueId || null, fix: e.fix }; render(); } }, "Edit"),
          el("button", { class: "link-btn", type: "button", onclick: () => removeEntry("downtime", e) }, "Remove"))))) : null,
      f && !f.id ? downtimeForm(f) : null,
      !events.length && !f ? el("p", { class: "card-note" }, locked() ? "No downtime this shift." : "None yet — add each stop as it happens.") : null,
      locked() || f ? null : el("button", { class: "btn secondary", type: "button", disabled: ui.busy || !report().saved, onclick: () => { ui.form = { kind: "downtime", minutes: "", reason: "", called: null, calledWho: "", maintenance: "", issueId: null, fix: "" }; render(); } }, "+ Add downtime"));
  }

  function scrapForm(f) {
    return el("div", { class: "entry-form" },
      label("Feet"), num(f.feet, (v) => { f.feet = v; }, "ft", "100000"),
      label("Reason"),
      picker({ id: "sc-reason", title: "Scrap reason", value: f.reason, placeholder: "Pick the reason…", options: ui.view.lists.scrapReasons.map((x) => ({ value: x, label: x })), onChange: (v) => { f.reason = v; render(); } }),
      label("Reel tag # (optional)"), el("input", { class: "field", value: f.tag, maxlength: "30", placeholder: "Tag #", autocomplete: "off", oninput: (e) => { f.tag = e.target.value; } }),
      label(f.reason === "Other" ? "Notes (required for Other)" : "Notes"), el("textarea", { class: "field", rows: "2", maxlength: "500", placeholder: "What happened", oninput: (e) => { f.notes = e.target.value; } }, f.notes),
      el("div", { class: "btn-row" },
        el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => saveEntry("scrap") }, ui.busy ? "Saving…" : f.id ? "Save changes" : "Add scrap"),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.form = null; render(); } }, "Cancel")));
  }

  function scrapCard() {
    const scraps = ui.view.scraps || [];
    const f = ui.form?.kind === "scrap" ? ui.form : null;
    const total = scraps.reduce((a, s) => a + (s.feet || 0), 0);
    return el("section", { class: "card" },
      el("strong", {}, `✂️ Partial reels / scrap${scraps.length ? ` · ${plainNum(total)} ft` : ""}`),
      scraps.length ? el("div", { class: "dt-list" }, scraps.map((s) => f?.id === s.id ? scrapForm(f) : el("div", { class: "dt-entry" },
        el("strong", {}, `${s.feet ? `${plainNum(s.feet)} ft` : "Feet not entered yet"} · ${s.reason}`),
        s.notes || s.tag ? el("span", { class: "dt-note" }, [s.source === "reel" ? "" : s.tag ? `Tag ${s.tag}` : "", s.notes].filter(Boolean).join(" · ")) : null,
        s.source === "reel" ? el("span", { class: "dt-tags" }, el("span", { class: "tag" }, "🏷 From Flagged Reels")) : null,
        s.source === "reel" || locked() || f ? null : el("span", { class: "dt-actions" },
          el("button", { class: "link-btn", type: "button", onclick: () => { ui.form = { kind: "scrap", id: s.id, feet: String(s.feet), reason: s.reason, tag: s.tag || "", notes: s.notes || "" }; render(); } }, "Edit"),
          el("button", { class: "link-btn", type: "button", onclick: () => removeEntry("scrap", s) }, "Remove"))))) : null,
      f && !f.id ? scrapForm(f) : null,
      !scraps.length && !f ? el("p", { class: "card-note" }, locked() ? "No scrap this shift." : "None yet. Flagged reels decided Scrap or Regrind show up here on their own.") : null,
      locked() || f ? null : el("button", { class: "btn secondary", type: "button", disabled: ui.busy || !report().saved, onclick: () => { ui.form = { kind: "scrap", feet: "", reason: "", tag: "", notes: "" }; render(); } }, "+ Add scrap"));
  }

  function signCard() {
    const r = report();
    if (locked()) return el("section", { class: "card" }, el("strong", {}, "Signed"), el("p", {}, signTag(r)), r.comments ? el("p", { class: "dt-note" }, r.comments) : null);
    return el("section", { class: "card" },
      el("strong", {}, "✍ Sign at end of shift"),
      label("Additional comments"),
      el("textarea", { class: "field", rows: "3", maxlength: "2000", placeholder: "Anything the next shift or the office should know", oninput: (e) => { ui.comments = e.target.value; } }, ui.comments ?? r.comments ?? ""),
      el("button", { class: "btn big", type: "button", disabled: ui.busy || !r.saved, onclick: sign }, "✍ Sign with PIN"));
  }

  function extrasFolds() {
    const recent = ui.view.recent || [];
    const canExport = me.roles.some((r) => EXPORT_ROLES.includes(r));
    const x = ui.exp || (ui.exp = { from: new Date(Date.now() - 6 * 86400000).toLocaleDateString("en-CA"), to: new Date().toLocaleDateString("en-CA") });
    return [
      recent.length ? collapsible("dt-recent", `Earlier shifts on this line (${recent.length})`,
        el("div", { class: "person-list" }, recent.map((p) => el("button", { class: "person-row", type: "button", onclick: () => { ui.reportId = p.id; load(); } },
          el("span", { class: "person-name" }, `${fmtDay(p.date)} · ${p.shiftName}${p.team ? ` · Team ${p.team}` : ""}`),
          el("span", { class: "tags" }, el("span", { class: p.signed ? "tag ok" : "tag" }, p.signed ? "✓ Signed" : "Not signed")))))) : null,
      canExport ? collapsible("dt-export", "⬇ Export to Excel",
        el("p", { class: "card-note" }, "One sheet per workbook tab (Changeover Log, Downtime Log, Scrap Log), data columns only — paste the rows into the matching tab. Until SharePoint is connected, this is how entries reach your workbook."),
        el("div", { class: "spec-fields" },
          el("label", { class: "spec-field" }, el("span", { class: "field-label" }, "From"), el("input", { class: "field", type: "date", value: x.from, oninput: (e) => { x.from = e.target.value; } })),
          el("label", { class: "spec-field" }, el("span", { class: "field-label" }, "To"), el("input", { class: "field", type: "date", value: x.to, oninput: (e) => { x.to = e.target.value; } }))),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: exportXlsx }, ui.busy ? "Working…" : "⬇ Download Excel file")) : null,
    ];
  }

  function render() {
    if (ui.sub) return;
    const r = report();
    const top = [
      el("button", { class: "link-btn", type: "button", onclick: ui.reportId && ui.lineId ? () => { ui.reportId = null; load(); } : onExit }, ui.reportId && ui.lineId ? "← This shift" : `← ${backLabel}`),
      el("h1", {}, "⏱ Downtime & scrap"),
    ];
    if (!lines().length && !data.lines) return container.replaceChildren(...top, spinner());
    if (!ui.lineId && !ui.reportId) return container.replaceChildren(...top, el("p", { class: "hint" }, "Pick the line for this shift report."), linePicker());
    if (ui.loadError && !ui.view) return container.replaceChildren(...top, banner({ message: ui.loadError, messageKind: "error", retry: () => load() }), ui.reportId ? null : linePicker());
    if (!ui.view || (ui.loading && !r)) return container.replaceChildren(...top, spinner());
    container.replaceChildren(...[
      ...top,
      el("p", { class: "dt-meta" }, `${r.lineName} · ${fmtDay(r.date)} · ${r.shiftName}${r.team ? ` · Team ${r.team}` : ""} `, signTag(r)),
      ui.view.test ? el("p", { class: "card-note" }, "Test site — practice entries only; nothing goes to the workbook.") : null,
      banner(ui),
      ui.loadError ? banner({ message: ui.loadError, messageKind: "error", retry: () => load() }) : null,
      ui.reportId ? null : collapsible("dt-line", `Line: ${r.lineName} — change`, linePicker()),
      headerCard(),
      changeoverCard(),
      downtimeCard(),
      scrapCard(),
      signCard(),
      ...extrasFolds(),
    ].filter(Boolean));
  }

  if (ui.lineId) load(); else render();
  return () => { ui.sub = null; };
}

// ---- Export to Excel: a real .xlsx (one sheet per tab), built in the browser with JSZip ----

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i) => String.fromCharCode(65 + i);

function sheetXml(headers, rows) {
  const cell = (v, r, c, header) => {
    const ref = `${colName(c)}${r}`;
    if (!header && c === 0 && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const serial = Math.round((Date.parse(`${v}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
      return `<c r="${ref}" s="1"><v>${serial}</v></c>`; // a real date, like the workbook's Date column
    }
    if (!header && typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    if (!header && /^\d+$/.test(String(v)) && c === 1) return `<c r="${ref}"><v>${v}</v></c>`; // Line #
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v ?? "")}</t></is></c>`;
  };
  const all = [headers, ...rows];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    all.map((row, i) => `<row r="${i + 1}">${row.map((v, c) => cell(v, i + 1, c, i === 0)).join("")}</row>`).join("")}</sheetData></worksheet>`;
}

async function loadJsZip() {
  if (window.JSZip) return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "vendor/jszip-3.10.1.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the Excel helper — check the connection and try again."));
    document.head.append(s);
  });
  return window.JSZip;
}

async function downloadWorkbook({ headers, rows, from, to, test }) {
  const JSZip = await loadJsZip();
  const tabs = [["Changeover Log", "changeover"], ["Downtime Log", "downtime"], ["Scrap Log", "scrap"]];
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${tabs.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${tabs.map(([name], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tabs.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${tabs.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="m/d/yyyy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`);
  tabs.forEach(([, key], i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(headers[key], rows[key])));
  const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `${test ? "TEST " : ""}Downtime and Scrap ${from} to ${to}.xlsx` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
