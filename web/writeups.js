// Write-ups (Decision 52; who writes and sees: Chris, 10-23-2026). Supervisors, the Production Manager, and Admins write
// them; only the writer and people with HR access ever see one — the server checks every read and logs every view and
// print (nothing is kept on the device, not even a draft). Steps: fill the form → the writer signs with their PIN →
// hand the device to the employee: they add comments and sign with their own PIN, or the writer marks "Refused to sign"
// → Save as PDF for Gusto (People → the employee → Documents → Add Document).

import { el, friendlyError, spinner, emptyState, banner, toast, picker, confirmSheet, collapsible } from "./ui.js";
import { TEST_MODE, callWriteupStart, callWriteupList, callWriteupGet, callWriteupPrinted, callSaveWriteup, callWriteupEmployeeSign, callWriteupRefused } from "./firebase.js";
import { signOff } from "./signoff.js";

const WRITER_ROLES = ["supervisor", "plant-manager", "admin"];
export const canWriteUps = (roles = [], hr = false) => hr || roles.some((r) => WRITER_ROLES.includes(r));

const TYPE_LABEL = { verbal: "Verbal warning", written: "Written warning", final: "Final warning" };
const STATUS = { waiting: "Waiting for the employee", signed: "Signed by the employee", refused: "Refused to sign" };
const STATUS_ICON = { waiting: "🕒", signed: "✍", refused: "✋" };
const plantToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const fmtDay = (day) => (day ? new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const offline = () => !navigator.onLine;

export function openWriteups(container, { me, onExit, backLabel = "Home" }) {
  const ui = {
    view: "list", list: null, hr: false, start: null, writeup: null, form: null, comments: "", who: "",
    loading: false, busy: false, message: "", messageKind: "", retry: null,
  };
  const fail = (err, retry) => { Object.assign(ui, { busy: false, loading: false, message: friendlyError(err), messageKind: "error", retry }); render(); };
  const ok = (text) => Object.assign(ui, { message: "", messageKind: "", retry: null }) && text && toast(text);

  // ---- loading ----
  async function loadList() {
    if (offline()) return fail({ code: "offline" }, loadList);
    Object.assign(ui, { view: "list", loading: true, message: "", retry: null });
    render();
    try {
      const { data: d } = await callWriteupList();
      Object.assign(ui, { list: d.items, hr: d.hr, loading: false });
    } catch (err) { return fail(err, loadList); }
    render();
  }
  async function openNew() {
    if (offline()) return fail({ code: "offline" }, openNew);
    Object.assign(ui, { view: "new", loading: true, message: "", retry: null });
    render();
    try {
      if (!ui.start) ui.start = (await callWriteupStart()).data;
    } catch (err) { return fail(err, openNew); }
    ui.form = { emp: "", date: plantToday(), type: "", policy: "", description: "", correctiveAction: "", priorNotes: "" };
    ui.loading = false;
    render();
  }
  async function openOne(id) {
    if (offline()) return fail({ code: "offline" }, () => openOne(id));
    Object.assign(ui, { view: "one", writeup: null, comments: "", loading: true, message: "", retry: null });
    render();
    try {
      ui.writeup = (await callWriteupGet({ id })).data.writeup;
      ui.comments = ui.writeup.employeeComments || "";
    } catch (err) { return fail(err, () => openOne(id)); }
    ui.loading = false;
    render();
  }

  // ---- actions ----
  async function save() {
    const f = ui.form;
    const missing = !f.emp ? "Pick the employee." : !f.type ? "Pick the type." : !f.policy.trim() ? "Write which policy or rule."
      : !f.description.trim() ? "Describe what happened." : !f.correctiveAction.trim() ? "Write the corrective action expected." : "";
    if (missing) { Object.assign(ui, { message: missing, messageKind: "error", retry: null }); return render(); }
    if (offline()) return fail({ code: "offline" }, save);
    const person = ui.start.people.find((p) => p.emp === f.emp);
    const result = await signOff({
      title: "Sign as the writer", what: `${TYPE_LABEL[f.type]} for ${person?.name || f.emp} · ${fmtDay(f.date)}`, me: { emp: me.emp, name: me.name },
      action: ({ signer, device }) => callSaveWriteup({ writeup: f, signer, device }),
    });
    if (!result) return;
    ok("Saved — now the employee reads and signs");
    ui.list = null;
    await openOne(result.data.id);
  }
  async function employeeSign() {
    const w = ui.writeup;
    if (offline()) return fail({ code: "offline" }, employeeSign);
    const result = await signOff({
      title: `${w.empName}: acknowledge this write-up`, what: `${TYPE_LABEL[w.type]} · ${fmtDay(w.date)} — signing means you received it, not that you agree`,
      me: { emp: w.emp, name: w.empName },
      action: ({ signer, device }) => callWriteupEmployeeSign({ id: w.id, comments: ui.comments, signer, device }),
    });
    if (!result) return;
    ok("Signed by the employee");
    ui.list = null;
    await openOne(w.id);
  }
  async function refused() {
    const w = ui.writeup;
    if (!(await confirmSheet({ title: `${w.empName} won't sign?`, text: "It's saved as \"Refused to sign\", with your name and the time, plus anything typed in the comments box. This can't be changed later.", confirmLabel: "✋ Refused to sign", danger: true }))) return;
    if (offline()) return fail({ code: "offline" }, refused);
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      await callWriteupRefused({ id: w.id, comments: ui.comments });
    } catch (err) { return fail(err, refused); }
    ui.busy = false;
    ok("Marked refused to sign");
    ui.list = null;
    await openOne(w.id);
  }
  async function printIt() {
    try { await callWriteupPrinted({ id: ui.writeup.id }); } catch (err) { return fail(err, printIt); }
    window.print();
  }

  // ---- screens ----
  const back = (label, fn) => el("button", { class: "link-btn no-print", type: "button", onclick: fn }, `← ${label}`);
  const label = (t, req = true) => el("span", { class: "field-label strong" }, req ? t : `${t} (optional)`);

  function listView() {
    const items = ui.list || [];
    const canWrite = WRITER_ROLES.some((r) => (me.roles || []).includes(r));
    return [
      back(backLabel, onExit),
      el("h1", {}, "🧾 Write-ups"),
      el("p", { class: "hint" }, ui.hr ? "Every write-up (you have HR access). Each view and print is logged." : "Write-ups you wrote. Only you and HR can see them; each view and print is logged."),
      banner(ui),
      canWrite ? el("button", { class: "btn", type: "button", disabled: ui.loading, onclick: openNew }, "+ New write-up") : null,
      ui.loading ? spinner("Loading write-ups…") : null,
      !ui.loading && ui.list && !items.length ? emptyState("No write-ups yet", canWrite ? "Tap “New write-up” to start one." : "") : null,
      items.length ? el("div", { class: "wu-list" }, items.map((w) => el("button", { class: "card wu-item", type: "button", onclick: () => openOne(w.id) },
        el("div", { class: "wu-item-head" }, el("strong", {}, w.empName), el("span", { class: "tag" }, TYPE_LABEL[w.type] || w.type)),
        el("span", { class: "person-meta" }, `${fmtDay(w.date)} · by ${w.writerName}`),
        el("span", { class: "wu-status" }, `${STATUS_ICON[w.status] || ""} ${STATUS[w.status] || w.status}`)))) : null,
    ];
  }

  function newView() {
    const f = ui.form;
    if (!f) return [back("Write-ups", loadList), ui.loading ? spinner("Loading…") : null, banner(ui)];
    const people = ui.start.people;
    return [
      back("Write-ups", loadList),
      el("h1", {}, "🧾 New write-up"),
      el("p", { class: "hint" }, "Fill it in, sign with your PIN, then hand the device to the employee to read and sign."),
      el("form", { class: "card wu-form", onsubmit: (e) => { e.preventDefault(); save(); } },
        label("Employee"),
        people.length
          ? picker({ title: "Employee", value: f.emp, placeholder: "Pick the employee…", options: people.map((p) => ({ value: p.emp, label: p.team ? `${p.name} · ${p.team}` : p.name })), onChange: (v) => { f.emp = v; render(); } })
          : el("p", { class: "message error" }, "No one to pick — add people in Admin → People first."),
        label("Date"),
        el("input", { class: "field", type: "date", value: f.date, max: plantToday(), oninput: (e) => { f.date = e.target.value; } }),
        label("Type"),
        el("div", { class: "choices three" }, ui.start.types.map((t) => el("button", { class: f.type === t.value ? "choice on" : "choice", type: "button", "aria-pressed": String(f.type === t.value), onclick: () => { f.type = t.value; render(); } }, t.label))),
        label("Policy or rule"),
        el("input", { class: "field", value: f.policy, maxlength: "200", placeholder: "e.g. Safety glasses on the floor", oninput: (e) => { f.policy = e.target.value; } }),
        label("What happened"),
        el("textarea", { class: "field", rows: "4", maxlength: "4000", oninput: (e) => { f.description = e.target.value; } }, f.description),
        label("Corrective action expected"),
        el("textarea", { class: "field", rows: "3", maxlength: "4000", oninput: (e) => { f.correctiveAction = e.target.value; } }, f.correctiveAction),
        collapsible("wu-prior", "Earlier history (optional)",
          el("p", { class: "card-note" }, "Earlier write-ups in the app are added automatically (date and type). Add anything else here, like an earlier talk that wasn't written up."),
          el("textarea", { class: "field", rows: "3", maxlength: "4000", oninput: (e) => { f.priorNotes = e.target.value; } }, f.priorNotes)),
        banner(ui),
        el("button", { class: "btn", type: "submit", disabled: ui.busy || !people.length }, "✍ Sign and save")),
    ];
  }

  function doc(w) {
    const row = (k, v) => el("tr", {}, el("th", {}, k), el("td", {}, v || "—"));
    const prior = [...(w.prior || []).map((p) => `${fmtDay(p.date)} — ${TYPE_LABEL[p.type] || p.type}`), w.priorNotes].filter(Boolean);
    const empLine = w.status === "signed" ? `${w.employeeSig.name} · signed with PIN · ${fmtWhen(w.employeeSig.atMs)}`
      : w.status === "refused" ? `Refused to sign · recorded by ${w.refused.byName} · ${fmtWhen(w.refused.atMs)}` : "Not signed yet";
    return el("article", { class: "print-doc wu-doc" },
      el("h1", {}, `Employee write-up — ${TYPE_LABEL[w.type] || w.type}${TEST_MODE ? " (TEST SITE — practice)" : ""}`),
      el("p", {}, "Conduit Direct Group · CDG Ops"),
      el("table", { class: "print-table" },
        row("Employee", `${w.empName} (#${w.emp})`), row("Date", fmtDay(w.date)), row("Type", TYPE_LABEL[w.type]), row("Policy or rule", w.policy),
        row("What happened", w.description), row("Corrective action expected", w.correctiveAction),
        row("Earlier history", prior.length ? prior.join("\n") : "None"), row("Employee comments", w.employeeComments)),
      el("div", { class: "wu-sigs" },
        el("p", {}, el("strong", {}, "Written by: "), `${w.writerSig.name} · signed with PIN · ${fmtWhen(w.writerSig.atMs)}`),
        el("p", {}, el("strong", {}, "Employee: "), empLine)),
      el("p", { class: "print-foot" }, "Signing means the employee received this write-up, not that they agree with it."));
  }

  function oneView() {
    const w = ui.writeup;
    if (!w) return [back("Write-ups", loadList), ui.loading ? spinner("Opening…") : null, banner(ui)];
    const waiting = w.status === "waiting";
    return [
      el("div", { class: "no-print" },
        back("Write-ups", loadList),
        el("h1", {}, `🧾 ${w.empName}`),
        el("p", { class: "wu-status center" }, `${STATUS_ICON[w.status]} ${STATUS[w.status]}`),
        banner(ui),
        waiting ? el("p", { class: "message" }, `Hand the device to ${w.empName}. They read the write-up below, then add comments and sign at the bottom.`) : null),
      doc(w),
      waiting ? el("section", { class: "card wu-hand no-print" },
        el("strong", {}, `${w.empName}: after reading`),
        el("p", { class: "card-note" }, "Add comments if you want, then sign with your own PIN. Signing means you received it, not that you agree. If they won't sign, the writer taps Refused to sign."),
        el("span", { class: "field-label strong" }, "Employee comments (optional)"),
        el("textarea", { class: "field", rows: "3", maxlength: "2000", oninput: (e) => { ui.comments = e.target.value; } }, ui.comments),
        el("div", { class: "btn-row" },
          el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: employeeSign }, `✍ ${w.empName} signs with their PIN`),
          el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: refused }, "✋ Refused to sign"))) : null,
      !waiting ? el("section", { class: "card no-print" },
        el("button", { class: "btn", type: "button", onclick: printIt }, "🖨 Save as PDF"),
        el("p", { class: "card-note" }, "In the print window, choose “Save as PDF”. Then in Gusto: People → the employee → Documents → Add Document, and upload the PDF.")) : null,
    ];
  }

  function render() {
    const parts = ui.view === "new" ? newView() : ui.view === "one" ? oneView() : listView();
    container.replaceChildren(...parts.flat(3).filter(Boolean));
  }

  loadList();
  return () => {};
}
