// Open machine issues (Plan Phase 2). Odoo is the source of truth: reporting a problem creates an
// Odoo maintenance request, the board shows every open breakdown in Odoo (synced every 5 minutes),
// and Mark fixed (Maintenance, Admin) moves the Odoo request to Repaired.

import { el, friendlyError } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import { storage, callReportProblem, callMarkIssueFixed, callAdminSyncOdoo } from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

// Odoo's long-standing link format for one record (redirects to the right screen in Odoo 19).
const odooRequestUrl = (id) => `https://conduit-direct-group.odoo.com/web#model=maintenance.request&id=${id}&view_type=form`;

// Same choice lists as CDG's Odoo fields.
const FAILURE_CATEGORIES = ["Bearing", "Belt/Chain", "Sensor", "Air Leak", "Vacuum Issue", "Water Issue", "Motor", "Electrical Fault", "Overheating", "Contamination", "Other"];
const ROOT_CAUSES = ["Mechanical", "Electrical", "Controls", "Pneumatic", "Hydraulic", "Material", "Operator", "Unknown"];
const SEVERITIES = [["urgent", "Urgent"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]];

export function ago(date) {
  if (!date) return "";
  const mins = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const toDate = (t) => (t?.toDate ? t.toDate() : t instanceof Date ? t : null);

function machineLabel(issue) {
  const m = data.machines?.find((x) => x.id === issue.machineId);
  if (!m) return issue.equipmentName || "No machine linked in Odoo";
  return `${m.lineId ? lineName(m.lineId).replace("Line ", "L") + " · " : ""}${m.id} ${m.name}`;
}

// Short card for the board (also used in the Fix Library panel).
export function issueCard(issue, onclick) {
  const desc = String(issue.description || "").replace(/^Reported in CDG Ops\s*/i, "").replace(/\s+/g, " ").trim();
  const short = desc.length > 110 ? `${desc.slice(0, 107)}…` : desc;
  return el(
    "button",
    { class: issue.lineDown ? "issue-card down" : "issue-card", type: "button", onclick },
    el("span", { class: "issue-top" }, el("strong", {}, machineLabel(issue)), el("span", { class: "issue-tag" }, issue.lineDown ? "⛔ Line down" : "Running")),
    short ? el("span", { class: "issue-desc" }, short) : null,
    el("span", { class: "person-meta" }, [issue.stage, issue.reportedBy ? `by ${issue.reportedBy}` : "", ago(toDate(issue.reportedAt))].filter(Boolean).join(" · "))
  );
}

// ===========================================================================
// Open issues board
// ===========================================================================

export function openIssueBoard(container, { me, onExit, onReport }) {
  const ui = { view: "list", issueId: null, busy: false, message: "", messageKind: "", note: "", confirming: false };

  const show = (view, message = "", kind = "") => {
    Object.assign(ui, { view, message, messageKind: kind, busy: false });
    render();
    window.scrollTo(0, 0);
  };
  const messageBox = () => (ui.message ? el("p", { class: `message ${ui.messageKind}`, role: ui.messageKind === "error" ? "alert" : null }, ui.message) : null);
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  function renderList() {
    const list = data.openIssues;
    const down = (list || []).filter((i) => i.lineDown).length;
    return [
      back("Home", onExit),
      el("h1", {}, "Open issues"),
      list ? el("p", { class: "hint" }, list.length ? `${list.length} open · ${down ? `${down} line${down === 1 ? "" : "s"} down` : "all lines running"}` : "No open issues — all clear.") : el("p", { class: "hint" }, "Loading…"),
      messageBox(),
      el("button", { class: "btn", type: "button", onclick: onReport }, "🚨 Report a problem"),
      el("div", { class: "issue-grid" }, (list || []).map((i) => issueCard(i, () => { Object.assign(ui, { issueId: i.id, confirming: false }); show("issue"); }))),
      el("p", { class: "hint small-print" }, "From Odoo — every open breakdown request, updated every 5 minutes."),
      me.admin ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: syncNow }, ui.busy ? "Syncing with Odoo…" : "↻ Sync with Odoo now") : null,
    ];
  }

  async function syncNow() {
    ui.busy = true;
    render();
    try {
      const { data: r } = await callAdminSyncOdoo();
      show("list", `Synced with Odoo: ${r.openIssues} open, ${r.closedSinceLastSync} closed since last sync, dates for ${r.machinesWithDates} machines.`, "ok");
    } catch (err) {
      show("list", friendlyError(err), "error");
    }
  }

  function renderIssue() {
    const i = data.openIssues?.find((x) => x.id === ui.issueId);
    if (!i) return [back("Open issues", () => show("list")), el("p", { class: "message ok" }, ui.message || "This issue was closed.")];
    const rows = [
      ["Machine", machineLabel(i)],
      ["Status", i.lineDown ? "⛔ Line down" : "Running — problem exists"],
      ["Unsafe to run", i.unsafe ? "YES" : ""],
      ["Odoo stage", i.stage],
      ["Failure category", i.failureCategory],
      ["Suspected cause", i.rootCause],
      ["Reported", [i.reportedBy, toDate(i.reportedAt)?.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }), ago(toDate(i.reportedAt))].filter(Boolean).join(" · ")],
    ].filter(([, v]) => v);

    // Confirmed on the page (not a pop-up — some browsers block those, and big buttons are easier with gloves).
    async function markFixed() {
      Object.assign(ui, { busy: true, confirming: false });
      render();
      try {
        await callMarkIssueFixed({ id: i.id, note: ui.note });
        ui.note = "";
        show("list", "Marked fixed — Odoo updated.", "ok");
      } catch (err) {
        Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error" });
        render();
      }
    }

    return [
      back("Open issues", () => show("list")),
      el("h1", { class: "fix-title" }, i.title || machineLabel(i)),
      el("p", { class: i.lineDown ? "message error" : "message ok" }, i.lineDown ? "⛔ Line down — production stopped" : "⚠ Running — problem exists"),
      messageBox(),
      el("table", { class: "info-table" }, rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, v)))),
      i.description ? el("div", { class: "fix-body" }, i.description) : null,
      (i.photos || []).length ? el("div", { class: "fix-media" }, i.photos.map((u, n) => el("a", { href: u, target: "_blank", rel: "noopener" }, el("img", { class: "fix-photo", src: u, alt: `Photo ${n + 1}`, loading: "lazy" })))) : null,
      me.fixer
        ? el(
            "div",
            { class: "card" },
            el("label", { class: "field-label", for: "fix-note" }, "What was done (optional — goes on the Odoo request)"),
            el("textarea", { class: "field", id: "fix-note", rows: "3", maxlength: "1000", value: ui.note, oninput: (e) => { ui.note = e.target.value; } }),
            ui.confirming
              ? el(
                  "div",
                  { class: "confirm-box" },
                  el("p", {}, `Mark ${machineLabel(i)} fixed? The Odoo request moves to Repaired and it leaves the board for everyone.`),
                  el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: markFixed }, "Yes, mark fixed"),
                  el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.confirming = false; render(); } }, "Cancel")
                )
              : el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => { ui.confirming = true; render(); } }, ui.busy ? "Updating Odoo…" : "✔ Mark fixed")
          )
        : null,
      me.fixer || me.admin
        ? el("p", { class: "hint small-print" }, el("a", { class: "text-link", href: odooRequestUrl(i.odooId), target: "_blank", rel: "noopener" }, `Open request #${i.odooId} in Odoo ↗`))
        : null,
    ];
  }

  function render() {
    container.replaceChildren(...[(ui.view === "issue" ? renderIssue : renderList)()].flat(2).filter(Boolean));
  }

  const stop = onDataChange(() => { if (!ui.busy && document.activeElement?.id !== "fix-note") render(); });
  // "x min ago" stays current.
  const tick = setInterval(() => { if (ui.view === "list") render(); }, 60000);
  render();
  return () => { stop(); clearInterval(tick); };
}

// ===========================================================================
// Report a problem
// ===========================================================================

// `machineTypes` (optional) narrows the machine buttons, e.g. from the Fix Library's Die category.
export function openReportForm(container, { me, onExit, onDone, machineTypes = null }) {
  const d = {
    lineId: null, machineId: null, lineDown: null, description: "", unsafe: false, severity: "normal",
    failureCategory: "", rootCause: "", actions: "", photos: [],
  };
  const ui = { busy: false, upload: "", message: "", messageKind: "", sent: null };

  const activeMachines = () => (data.machines || []).filter((m) => m.active !== false && (!machineTypes || machineTypes.includes(m.type)));
  const linesWithMachines = () => (data.lines || []).filter((l) => l.active !== false && activeMachines().some((m) => m.lineId === l.id));

  async function addPhoto(file) {
    if (!file.type.startsWith("image/")) {
      Object.assign(ui, { message: "Photos only here.", messageKind: "error" });
      return render();
    }
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${me.emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    ui.busy = true;
    await new Promise((resolve) => {
      task.on(
        "state_changed",
        (s) => { ui.upload = `Uploading photo: ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`; render(); },
        (err) => { Object.assign(ui, { message: friendlyError(err), messageKind: "error" }); resolve(); },
        async () => { d.photos.push(await getDownloadURL(task.snapshot.ref)); resolve(); }
      );
    });
    Object.assign(ui, { busy: false, upload: "" });
    render();
  }

  async function send() {
    if (!d.machineId) return say("Pick the machine.");
    if (d.lineDown === null) return say("Is the line down? Tap Yes or No.");
    if (d.description.trim().length < 3) return say("Say what's wrong.");
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      const { data: r } = await callReportProblem({ ...d });
      ui.sent = r;
      Object.assign(ui, { busy: false });
      render();
      window.scrollTo(0, 0);
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error" });
      render();
    }
  }

  function say(message) {
    Object.assign(ui, { message, messageKind: "error" });
    render();
  }

  const choice = (selected, label, onclick, extra = "") =>
    el("button", { class: `choice${selected ? " on" : ""}${extra}`, type: "button", onclick, disabled: ui.busy }, label);

  function render() {
    if (ui.sent) {
      container.replaceChildren(
        ...[
          el("h1", {}, "Sent ✔"),
          el("p", { class: "message ok" }, `Maintenance has it. Odoo request #${ui.sent.odooId} — it's on the Open issues board now.`),
          el("button", { class: "btn", type: "button", onclick: onDone }, "See open issues"),
          el("button", { class: "btn secondary", type: "button", onclick: onExit }, "Done"),
        ]
      );
      return;
    }
    const lineList = linesWithMachines();
    const spare = activeMachines().filter((m) => !m.lineId);
    const machinesHere = d.lineId === "none" ? spare : activeMachines().filter((m) => m.lineId === d.lineId);
    const content = [
      el("button", { class: "link-btn", type: "button", onclick: onExit, disabled: ui.busy }, "← Back"),
      el("h1", {}, "🚨 Report a problem"),
      el("p", { class: "hint" }, "Goes straight to maintenance as an Odoo request."),
      ui.message ? el("p", { class: `message ${ui.messageKind}`, role: "alert" }, ui.message) : null,

      el("p", { class: "field-label" }, "1. Which line?"),
      el("div", { class: "choices" },
        lineList.map((l) => choice(d.lineId === l.id, l.name, () => { d.lineId = l.id; d.machineId = null; render(); })),
        spare.length ? choice(d.lineId === "none", "Other / plant", () => { d.lineId = "none"; d.machineId = null; render(); }) : null
      ),

      d.lineId
        ? [
            el("p", { class: "field-label" }, "2. Which machine?"),
            el("div", { class: "choices" }, machinesHere.map((m) => choice(d.machineId === m.id, `${m.name}`, () => { d.machineId = m.id; render(); }))),
          ]
        : null,

      d.machineId
        ? [
            el("p", { class: "field-label" }, "3. Is the line down?"),
            el("div", { class: "choices two" },
              choice(d.lineDown === true, "⛔ Yes — stopped", () => { d.lineDown = true; render(); }, " danger"),
              choice(d.lineDown === false, "Still running", () => { d.lineDown = false; render(); })
            ),
            el("label", { class: "field-label", for: "rp-desc" }, "4. What's wrong?"),
            el("textarea", { class: "field", id: "rp-desc", rows: "4", maxlength: "3000", placeholder: "e.g. Puller belt slipping, pipe pulling uneven", value: d.description, oninput: (e) => { d.description = e.target.value; } }),
            el("label", { class: "check-row" },
              el("input", { type: "checkbox", checked: d.unsafe, onchange: (e) => { d.unsafe = e.target.checked; } }),
              el("span", {}, "Unsafe to run")
            ),
            el(
              "details",
              { class: "more" },
              el("summary", {}, "More details (optional)"),
              el("p", { class: "field-label" }, "How urgent?"),
              el("div", { class: "choices" }, SEVERITIES.map(([id, label]) => choice(d.severity === id, label, () => { d.severity = id; render(); }))),
              el("label", { class: "field-label", for: "rp-fail" }, "Failure category"),
              el("select", { class: "field", id: "rp-fail", onchange: (e) => { d.failureCategory = e.target.value; } },
                el("option", { value: "" }, "Not sure"), FAILURE_CATEGORIES.map((c) => el("option", { value: c, selected: d.failureCategory === c }, c))),
              el("label", { class: "field-label", for: "rp-cause" }, "Suspected cause"),
              el("select", { class: "field", id: "rp-cause", onchange: (e) => { d.rootCause = e.target.value; } },
                el("option", { value: "" }, "Not sure"), ROOT_CAUSES.map((c) => el("option", { value: c, selected: d.rootCause === c }, c))),
              el("label", { class: "field-label", for: "rp-act" }, "What's been tried already"),
              el("textarea", { class: "field", id: "rp-act", rows: "2", maxlength: "1000", value: d.actions, oninput: (e) => { d.actions = e.target.value; } }),
              el("p", { class: "field-label" }, "Photos"),
              d.photos.map((u, n) => el("div", { class: "import-row" }, el("span", {}, `Photo ${n + 1}`), el("button", { class: "link-btn", type: "button", onclick: () => { d.photos.splice(n, 1); render(); } }, "Remove"))),
              ui.upload ? el("p", { class: "message ok" }, ui.upload) : null,
              el("label", { class: "btn secondary file-btn" }, "📷 Add a photo",
                el("input", { type: "file", accept: "image/*", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) addPhoto(f); } }))
            ),
            el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: send }, ui.busy ? "Sending to Odoo…" : "Send to maintenance"),
          ]
        : null,
    ];
    const open = container.querySelector("details.more")?.open; // keep "More details" open across redraws
    container.replaceChildren(...[content].flat(3).filter(Boolean));
    if (open) container.querySelector("details.more").open = true;
  }

  const stop = onDataChange(() => { if (!ui.busy && !["rp-desc", "rp-act"].includes(document.activeElement?.id)) render(); });
  render();
  return stop;
}
