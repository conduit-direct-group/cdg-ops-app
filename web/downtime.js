// Downtime & Scrap shift report (Chris, 10-22-2026). Line Leads and Supervisors enter each changeover (as many as
// needed), downtime
// event, and partial reel / scrap as it happens, then sign with a PIN. Flagged reels decided Scrap or Regrind show up
// in the scrap list on their own (never entered twice). Rules and workbook columns: functions/downtime.js.
// The SharePoint workbook isn't connected yet — Export to Excel gives the rows for each tab.

import { el, friendlyError, spinner, emptyState, banner, toast, picker, choose, collapsible, fmtMinutes } from "./ui.js";
import { myShiftLines } from "./crew.js";
import { data } from "./data.js";
import { TEST_MODE, callShiftReport, callSaveShiftReport, callSaveShiftEntry, callExportShiftReports, callSignoffPeople, callMarkShiftNone, callShiftReportVerifiers } from "./firebase.js";
import { signOff, signedNote, isLineTablet } from "./signoff.js";
import { offlineSign } from "./outbox.js";
import { openReportForm } from "./issues.js";
import { dueByShiftEnd } from "./shift.js";

export const DOWNTIME_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const SIGN_ROLES = ["lead", "supervisor", "plant-manager"];
const EXPORT_ROLES = ["supervisor", "plant-manager", "admin"];
const LINE_KEY = "cdg.lineCheckLine"; // the line tablet's line (shared with the Line Check Log)
const MAINT = [["none", "No"], ["team", "Fixed by our team"], ["called", "Maintenance called"]];

export const usesDowntime = (roles) => roles.some((r) => DOWNTIME_ROLES.includes(r));
const HOME_ROLES = ["lead", "supervisor"]; // Home "Needs you" item (Chris, 10-22-2026)
const HOME_REFRESH_MS = 2 * 60000;
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const fmtDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const plainNum = (n) => Number(n).toLocaleString("en-US");

// Gray until the last hour, red in the last hour or after, green once signed and verified (two-step sign-off).
const verifiedText = (v) => `${v.name}${v.roleName ? ` (${v.roleName}${v.backup ? " — no Supervisor on shift" : ""})` : ""}`;
const lastHour = (r, now = Date.now()) => !!r.endMs && now >= r.endMs - 3600000;
function signTag(r, now = Date.now()) {
  if (r.verified) return el("span", { class: "tag ok" }, `✓ Signed by ${r.signed.byName} · verified by ${verifiedText(r.verified)}`);
  if (r.signed) return el("span", { class: lastHour(r, now) ? "tag off" : "tag" }, `Signed by ${r.signed.byName} — needs Verified`);
  if (r.endMs && now >= r.endMs - 3600000) return el("span", { class: "tag off" }, `⚠ Not signed — due ${fmtTime(r.endMs)}`);
  return el("span", { class: "tag" }, r.endMs ? `Not signed — due by ${fmtTime(r.endMs)}` : "Not signed");
}

// Home → Needs you (Line Leads, Supervisors): this shift's report for their line — the line tablet's line, else the
// line the Crew Board put them on this shift, else the line they last picked (no home lines — Decision 104). Gray until
// the last hour, red after, green once signed. The status is
// read from the server in the background (every 2 minutes at most) and the Home redraws when it arrives.
const home = { lineId: null, at: 0, busy: false, report: null, events: 0, feet: 0, error: false };

function todaysLine() {
  const lines = (data.lines || []).filter((l) => l.active !== false);
  const today = myShiftLines()?.now?.[0] || myShiftLines()?.today?.[0] || null;
  const order = isLineTablet() ? [stored(LINE_KEY), today] : [today, stored(LINE_KEY)];
  return order.find((id) => id && lines.some((l) => l.id === id)) || null;
}

function rememberHome(view) {
  const r = view.report;
  Object.assign(home, { lineId: r.lineId, at: Date.now(), report: r, error: false,
    events: (view.events || []).length, feet: (view.scraps || []).reduce((a, x) => a + (x.feet || 0), 0) });
}

async function refreshHome(lineId, onRedraw) {
  if (home.busy || !navigator.onLine) return;
  home.busy = true;
  try {
    rememberHome((await callShiftReport({ lineId })).data);
  } catch {
    Object.assign(home, { lineId, at: Date.now(), report: null, error: true });
  }
  home.busy = false;
  onRedraw?.();
}

export function downtimeItems(roles, myself, onOpen, onRedraw) {
  if (!roles.some((r) => HOME_ROLES.includes(r))) return [];
  const lineId = todaysLine();
  const base = { key: "downtime", icon: "⏱", onOpen };
  if (!lineId) { const due = dueByShiftEnd(); return [{ ...base, title: "Downtime & scrap shift report", detail: `pick your line to start · ${due.detail}`, state: due.state }]; }
  if (home.lineId !== lineId || Date.now() - home.at > HOME_REFRESH_MS || (home.report?.endMs && Date.now() > home.report.endMs)) refreshHome(lineId, onRedraw);
  const r = home.lineId === lineId ? home.report : null;
  const name = lines().find((l) => l.id === lineId)?.name || "";
  if (!r) return [{ ...base, title: `Downtime & scrap — ${name}`, detail: home.error ? "couldn't check — tap to open" : "checking…", state: "due" }];
  const counts = `${home.events} downtime · ${plainNum(home.feet)} ft scrap`;
  const late = lastHour(r);
  if (r.verified) return [{ ...base, title: `Downtime & scrap — ${name}`, detail: `signed by ${r.signed.byName} · verified by ${r.verified.name} · ${counts}`, state: "done" }];
  if (r.signed) return [{ ...base, title: `Downtime & scrap — ${name}: needs Verified`, detail: `signed by ${r.signed.byName} · ${late ? "due" : "due by"} ${fmtTime(r.endMs)}`, state: late ? "late" : "due" }];
  return [{ ...base, title: `Downtime & scrap — ${name}: not signed`, detail: `${r.saved ? counts : "not started"} · ${late ? "due" : "due by"} ${fmtTime(r.endMs)}`, state: late ? "late" : "due" }];
}

const lines = () => (data.lines || []).filter((l) => l.active !== false);

export function openDowntime(container, { me, onExit, backLabel = "Home", onCrew = null }) {
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
      if (!ui.reportId) rememberHome(ui.view); // keeps the Home item up to date after each save
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
    return { ...(r.saved ? { reportId: r.id } : { lineId: r.lineId }), size: headSize(), sdr: ui.head.sdr, ...extra };
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
    const what = kind === "changeover" ? `${fmtMinutes(e.minutes)} · ${e.type} changeover` : kind === "downtime" ? `${fmtMinutes(e.minutes)} · ${e.reason}` : `${plainNum(e.feet)} ft · ${e.reason}`;
    const ok = await choose({ title: `Remove ${what}?`, options: [{ value: "yes", label: "Yes, remove it" }] });
    if (ok) await act(() => callSaveShiftEntry({ reportId: report().id, kind, id: e.id, remove: true }), () => removeEntry(kind, e), "Removed");
  }

  async function sign() {
    const r = report();
    const out = await signOff({
      title: "Sign shift report (PIN)", what: `${r.lineName} · ${fmtDay(r.date)} · ${r.shiftName}${r.team ? ` · Team ${r.team}` : ""}`,
      me: me.roles.some((x) => SIGN_ROLES.includes(x)) ? { emp: me.emp, name: me.name } : null,
      others: async () => (await callSignoffPeople({ kind: "shift-report" })).data.people,
      action: offlineSign("signShiftReport", { reportId: r.id, comments: ui.comments ?? r.comments ?? "" }, { label: `Shift report · ${r.lineName} · ${r.shiftName}`, key: `shift-report:${r.id}` }),
    });
    if (out) { toast(signedNote(out, `Signed by ${out.name}${TEST_MODE ? " (test)" : ""}`)); ui.comments = undefined; await load(); }
  }

  // Verified: someone other than the person who signed it (verify.js on the server).
  async function verify() {
    const r = report();
    const canMe = me.roles.some((x) => ["supervisor", "plant-manager", "lead"].includes(x)) && r.signed?.by !== me.emp;
    const out = await signOff({
      title: "Verified", what: `Downtime & scrap · ${r.lineName} · ${fmtDay(r.date)} · ${r.shiftName} · signed by ${r.signed.byName}`,
      me: canMe ? { emp: me.emp, name: me.name } : null,
      others: async () => (await callShiftReportVerifiers({ reportId: r.id })).data.people,
      action: offlineSign("verifyShiftReport", { reportId: r.id }, { label: `Shift report verified · ${r.lineName} · ${r.shiftName}`, key: `shift-report-verify:${r.id}` }),
    });
    if (out) { toast(signedNote(out, `Verified by ${out.name}${out.role ? ` (${out.role})` : ""}${TEST_MODE ? " (test)" : ""}`)); await load(); }
  }

  // "None this shift" for downtime or scrap (or undo it).
  const markNone = (kind, none) => act(() => callMarkShiftNone({ reportId: report().id, kind, none }), () => markNone(kind, none), none ? `No ${kind} this shift` : "Undone");
  function noneRow(kind, empty) {
    const n = report().none?.[kind];
    if (n) return el("p", { class: "none-row" }, el("span", {}, `✓ None this shift — ${n.byName}`), locked() ? null : el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => markNone(kind, false) }, "Undo"));
    if (!empty || locked()) return null;
    return el("button", { class: "btn secondary", type: "button", disabled: ui.busy || !report().saved, onclick: () => markNone(kind, true) }, kind === "downtime" ? "✓ No downtime this shift" : "✓ No scrap this shift");
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
    const changed = !r.saved || headSize() !== (r.size || "") || h.sdr !== (r.sdr || "");
    return el("section", { class: "card" },
      el("strong", {}, "Product running"),
      locked()
        ? el("p", {}, `${r.productSize} · Team ${r.team}`)
        : [
          // No team in the rotation today (Saturday): the team comes from Who's here today (Chris, 10-23-2026).
          r.needTeamPick
            ? el("div", { class: "message", role: "status" },
                el("p", {}, "No team in the rotation today. Pick the team that's working on Who's here today first — the report uses it."),
                onCrew ? el("button", { class: "btn secondary", type: "button", onclick: onCrew }, "👥 Open Who's here today") : null)
            : null,
          label("Size"), chips([...L.sizes, "other"], h.size, (v) => { h.size = v; }, (x) => (x === "other" ? "Other size…" : x)),
          h.size === "other" ? el("input", { class: "field", value: h.otherSize, maxlength: "30", placeholder: "Specialty size, e.g. 3\"", oninput: (e) => { h.otherSize = e.target.value; } }) : null,
          label("Wall"), chips(L.sdrs, h.sdr, (v) => { h.sdr = v; }),
          changed ? el("button", { class: "btn", type: "button", disabled: ui.busy || r.needTeamPick, onclick: () => saveHeader({}, "Product saved") }, ui.busy ? "Saving…" : r.saved ? "Save product change" : "Start the shift report") : null,
          r.saved ? el("p", { class: "card-note" }, "Change it when the product changes — new entries use the product shown here.") : el("p", { class: "card-note" }, "Pick the product first; then add changeovers, downtime, and scrap as they happen."),
        ]);
  }

  // A new changeover asks for the product it changed TO (starts as the current one); saving it also updates
  // "Product running", so the entries after it carry the new size.
  async function saveChangeover() {
    const f = ui.form;
    const size = f.size === "other" ? f.otherSize.trim() : f.size;
    const productChanged = !f.id && (size !== headSize() || f.sdr !== ui.head.sdr);
    await act(async () => {
      if (productChanged) {
        Object.assign(ui.head, { size: f.size, otherSize: f.otherSize, sdr: f.sdr });
        await callSaveShiftReport(headerPayload());
      }
      await callSaveShiftEntry({ reportId: report().id, kind: "changeover", ...(f.id ? { id: f.id } : {}), minutes: f.minutes, type: f.type });
    }, saveChangeover, f.id ? "Updated" : productChanged ? "Changeover added — product updated" : "Changeover added");
  }

  function changeoverForm(f) {
    const L = ui.view.lists;
    return el("div", { class: "entry-form" },
      label("Minutes"), num(f.minutes, (v) => { f.minutes = v; }, "min", "1440"),
      label("Type"), chips(L.changeoverTypes, f.type, (v) => { f.type = v; }),
      f.id ? null : [
        label("New product (after the changeover)"),
        chips([...L.sizes, "other"], f.size, (v) => { f.size = v; }, (x) => (x === "other" ? "Other size…" : x)),
        f.size === "other" ? el("input", { class: "field", value: f.otherSize, maxlength: "30", placeholder: "Specialty size, e.g. 3\"", oninput: (e) => { f.otherSize = e.target.value; } }) : null,
        chips(L.sdrs, f.sdr, (v) => { f.sdr = v; }),
      ],
      el("div", { class: "btn-row" },
        el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: saveChangeover }, ui.busy ? "Saving…" : f.id ? "Save changes" : "Add changeover"),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.form = null; render(); } }, "Cancel")));
  }

  function changeoverCard() {
    const list = ui.view.changeovers || [];
    const f = ui.form?.kind === "changeover" ? ui.form : null;
    const total = list.reduce((a, c) => a + (c.minutes || 0), 0);
    return el("section", { class: "card" },
      el("strong", {}, `🔁 Changeovers${list.length ? ` · ${list.length} · ${fmtMinutes(total)}` : ""}`),
      list.length ? el("div", { class: "dt-list" }, list.map((c) => f?.id === c.id ? changeoverForm(f) : el("div", { class: "dt-entry" },
        el("strong", {}, `${fmtMinutes(c.minutes)} · ${c.type}`),
        el("span", { class: "dt-note" }, [c.productSize, c.atMs ? fmtTime(c.atMs) : ""].filter(Boolean).join(" · ")),
        locked() || f || c.legacy ? null : el("span", { class: "dt-actions" },
          el("button", { class: "link-btn", type: "button", onclick: () => { ui.form = { kind: "changeover", id: c.id, minutes: String(c.minutes), type: c.type }; render(); } }, "Edit"),
          el("button", { class: "link-btn", type: "button", onclick: () => removeEntry("changeover", c) }, "Remove"))))) : null,
      f && !f.id ? changeoverForm(f) : null,
      !list.length && !f ? el("p", { class: "card-note" }, locked() ? "No changeovers this shift." : "None yet — add each one as it happens.") : null,
      locked() || f ? null : el("button", { class: "btn secondary", type: "button", disabled: ui.busy || !report().saved,
        onclick: () => { ui.form = { kind: "changeover", minutes: "", type: "", size: ui.head.size, otherSize: ui.head.otherSize, sdr: ui.head.sdr }; render(); } }, "+ Add changeover"));
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
      el("strong", {}, `⏱ Downtime${events.length ? ` · ${fmtMinutes(total)}` : ""}`),
      events.length ? el("div", { class: "dt-list" }, events.map((e) => f?.id === e.id ? downtimeForm(f) : el("div", { class: "dt-entry" },
        el("strong", {}, `${fmtMinutes(e.minutes)} · ${e.reason}`),
        el("span", { class: "dt-note" }, [e.fix, e.called ? `Called: ${e.calledWho}` : "", e.issueTitle ? `Maintenance: ${e.issueTitle}` : ""].filter(Boolean).join(" · ")),
        el("span", { class: "dt-tags" }, el("span", { class: "tag" }, `Contacted: ${e.contacted}`), el("span", { class: "tag" }, `Maintenance log: ${e.maintLog}`)),
        locked() || f ? null : el("span", { class: "dt-actions" },
          el("button", { class: "link-btn", type: "button", onclick: () => { ui.form = { kind: "downtime", id: e.id, minutes: String(e.minutes), reason: e.reason, called: e.called, calledWho: e.calledWho || "", maintenance: e.maintenance, issueId: e.issueId || null, fix: e.fix }; render(); } }, "Edit"),
          el("button", { class: "link-btn", type: "button", onclick: () => removeEntry("downtime", e) }, "Remove"))))) : null,
      f && !f.id ? downtimeForm(f) : null,
      !events.length && !f && !report().none?.downtime ? el("p", { class: "card-note" }, locked() ? "No downtime this shift." : "None yet — add each stop as it happens, or tap “No downtime this shift.”") : null,
      f ? null : noneRow("downtime", !events.length),
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
      !scraps.length && !f && !report().none?.scrap ? el("p", { class: "card-note" }, locked() ? "No scrap this shift." : "None yet. Flagged reels decided Scrap or Regrind show up here on their own. No scrap? Tap “No scrap this shift.”") : null,
      f ? null : noneRow("scrap", !scraps.length),
      locked() || f ? null : el("button", { class: "btn secondary", type: "button", disabled: ui.busy || !report().saved, onclick: () => { ui.form = { kind: "scrap", feet: "", reason: "", tag: "", notes: "" }; render(); } }, "+ Add scrap"));
  }

  function signCard() {
    const r = report();
    if (locked()) {
      return el("section", { class: "card" }, el("strong", {}, r.verified ? "Signed and verified" : "Signed — needs Verified"), el("p", {}, signTag(r)), r.comments ? el("p", { class: "dt-note" }, r.comments) : null,
        r.verified ? null : [
          el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: verify }, "✍ Verified"),
          el("p", { class: "hint" }, "A Supervisor verifies — or, with no Supervisor on shift, the Production Manager or a Line Lead. Not the person who signed it.")]);
    }
    const missing = [!(ui.view.events || []).length && !r.none?.downtime && "downtime", !(ui.view.scraps || []).length && !r.none?.scrap && "scrap"].filter(Boolean);
    return el("section", { class: "card" },
      el("strong", {}, "✍ Sign at end of shift"),
      lastHour(r) ? el("p", { class: "message error", role: "alert" }, `⚠ Last hour of the shift — fill it in and sign by ${fmtTime(r.endMs)}.`) : null,
      missing.length ? el("p", { class: "hint" }, `Before signing: add the ${missing.join(" and ")}, or tap “None this shift.”`) : null,
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
          el("span", { class: "tags" }, el("span", { class: p.verified ? "tag ok" : "tag" }, p.verified ? "✓ Signed and verified" : p.signed ? "Signed — needs Verified" : "Not signed")))))) : null,
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
