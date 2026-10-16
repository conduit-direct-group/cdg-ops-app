// "Need something?" — in-app requests (app only; nothing goes to Odoo). Machine problems still go through
// the red Maintenance Request (Odoo). Types and routing are data: Admin → Request types & routing.
// Status: Open → In progress → Done. The sender follows it on their home screen and gets a notification.

import { el, friendlyError, spinner, emptyState, banner, toast, picker, confirmSheet, breakable } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import {
  storage, TEST_MODE, callSubmitRequest, callUpdateRequest, callAdminSaveRequestType, callAdminStartRequestTypes,
  callAdminListEmployees,
} from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { ago } from "./issues.js";

const STATUS = {
  open: { label: "Open", tag: "tag warn" },
  "in-progress": { label: "🔧 In progress", tag: "tag" },
  done: { label: "✔ Done", tag: "tag" },
};

const toDate = (t) => (t?.toDate ? t.toDate() : t instanceof Date ? t : null);
const when = (t) => toDate(t)?.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) || "";
const activeTypes = () => (data.requestTypes || []).filter((t) => t.active !== false).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
const WEEK = 7 * 86400000;
const recent = (r) => r.status !== "done" || Date.now() - (toDate(r.doneAt)?.getTime() || 0) < WEEK;

export function statusTag(status) {
  const s = STATUS[status] || STATUS.open;
  return el("span", { class: s.tag }, s.label);
}

export function requestRow(r, onclick) {
  return el(
    "button",
    { class: r.urgent && r.status !== "done" ? "person-row urgent" : "person-row", type: "button", onclick },
    el("span", { class: "person-name" }, `${r.icon || "💬"} ${r.typeName}`),
    el("span", { class: "person-meta" }, [r.description?.slice(0, 80), [r.lineName, r.place].filter(Boolean).join(" · ")].filter(Boolean).join(" — ")),
    el("span", { class: "person-meta" }, [r.createdByName ? `from ${r.createdByName}` : "", ago(toDate(r.createdAt)), r.status === "done" && r.doneByName ? `done by ${r.doneByName}` : r.status === "in-progress" && r.takenByName ? `${r.takenByName} is on it` : ""].filter(Boolean).join(" · ")),
    el("span", { class: "tags" }, r.urgent && r.status !== "done" ? el("span", { class: "tag off" }, "⚠ Urgent") : null, statusTag(r.status), r.test ? el("span", { class: "tag test" }, "TEST") : null)
  );
}

// Home: requests sent to me that aren't done (admins: every open request). Never folded away.
export function inboxCard(me, onOpen) {
  const list = (data.requestsForMe || []).filter((r) => r.status !== "done");
  if (!list.length) return null;
  const urgent = list.filter((r) => r.urgent).length;
  return el(
    "div",
    { class: urgent ? "card inbox urgent" : "card inbox" },
    el("strong", {}, `📥 ${me.admin ? "Open requests" : "Requests for you"} (${list.length})${urgent ? ` · ⚠ ${urgent} urgent` : ""}`),
    el("div", { class: "person-list" }, list.slice(0, 8).map((r) => requestRow(r, () => onOpen(r.id)))),
    list.length > 8 ? el("p", { class: "card-note" }, `…and ${list.length - 8} more.`) : null
  );
}

// Home: what I asked for — "Need something?" requests and my Maintenance Requests — with their status.
export function myRequestsCard(onOpenRequest) {
  const reqs = (data.requestsSent || []).filter(recent);
  const issues = (data.myIssues || []).filter((i) => i.open || Date.now() - (toDate(i.closedAt)?.getTime() || 0) < WEEK);
  if (!reqs.length && !issues.length) return null;
  return el(
    "div",
    { class: "card" },
    el("strong", {}, "🧾 My requests"),
    el(
      "div",
      { class: "person-list" },
      reqs.slice(0, 6).map((r) => requestRow(r, () => onOpenRequest(r.id))),
      issues.slice(0, 6).map((i) =>
        el(
          "div",
          { class: "person-row static" },
          el("span", { class: "person-name" }, `🚨 Maintenance Request${i.machineId ? ` · ${i.machineId}` : ""}`),
          el("span", { class: "person-meta" }, String(i.description || i.title || "").slice(0, 80)),
          el("span", { class: "person-meta" }, ago(toDate(i.reportedAt))),
          el("span", { class: "tags" },
            el("span", { class: i.open ? "tag warn" : "tag" }, i.open ? `Open · ${i.stage || "New Request"}` : `✔ Done${i.closedBy ? ` · ${i.closedBy}` : ""}`),
            i.test ? el("span", { class: "tag test" }, "TEST") : null)
        )
      )
    )
  );
}

// ===========================================================================
// Need something? — pick a type, then one short form on the same screen.
// ===========================================================================

export function openNeedSomething(container, { me, onExit, onMaintenance, onSent }) {
  const d = { typeId: null, description: "", lineId: "", place: "", photos: [] };
  const ui = { busy: false, upload: "", message: "", messageKind: "", retry: null };

  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry }); render(); };

  async function addPhoto(file) {
    if (!file.type.startsWith("image/")) return say("Photos only here.");
    if (!navigator.onLine) return say(friendlyError({ code: "offline" }), () => addPhoto(file));
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${me.emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    Object.assign(ui, { busy: true, message: "", retry: null });
    await new Promise((resolve) => {
      task.on(
        "state_changed",
        (s) => { ui.upload = `Uploading photo: ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`; render(); },
        (err) => { Object.assign(ui, { message: friendlyError(err), messageKind: "error", retry: () => addPhoto(file) }); resolve(); },
        async () => { d.photos.push(await getDownloadURL(task.snapshot.ref)); toast("Photo added"); resolve(); }
      );
    });
    Object.assign(ui, { busy: false, upload: "" });
    render();
  }

  async function send() {
    if (!d.typeId) return say("Pick what kind of request it is.");
    if (d.description.trim().length < 3) return say("Say what you need (a few words is fine).");
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const { data: r } = await callSubmitRequest({ typeId: d.typeId, description: d.description, lineId: d.lineId || null, place: d.place, photos: d.photos });
      onSent(r.test ? "Test request sent — only you get the notification" : `Sent to ${r.recipients} ${r.recipients === 1 ? "person" : "people"}`);
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: send });
      render();
    }
  }

  function render() {
    const types = activeTypes();
    const type = types.find((t) => t.id === d.typeId);
    const lines = (data.lines || []).filter((l) => l.active !== false);
    container.replaceChildren(
      ...[
        el("button", { class: "link-btn", type: "button", onclick: onExit, disabled: ui.busy }, "← Home"),
        el("h1", {}, "🙋 Need something?"),
        el(
          "button",
          { class: "mr-redirect", type: "button", onclick: onMaintenance },
          el("strong", {}, "Machine down or broken?"),
          el("span", {}, "Use 🚨 Maintenance Request →")
        ),
        !data.requestTypes ? spinner() : !types.length ? emptyState("No request types yet", "An admin sets them up in Admin → Request types & routing.") : null,
        types.length ? el("p", { class: "field-label" }, "1. What do you need?") : null,
        el("div", { class: "choices type-choices" }, types.map((t) =>
          el("button", { class: d.typeId === t.id ? "choice on" : "choice", type: "button", disabled: ui.busy, onclick: () => { d.typeId = t.id; ui.message = ""; render(); } },
            el("span", { class: "choice-icon", "aria-hidden": "true" }, t.icon || "💬"), breakable(t.name)))),
        type
          ? [
              type.urgent ? el("p", { class: "message error" }, "⚠ Marked urgent — it goes out right away. If anyone is in danger, stop and get your supervisor now.") : null,
              el("label", { class: "field-label", for: "rq-desc" }, "2. What's going on?"),
              el("textarea", { class: "field", id: "rq-desc", rows: "3", maxlength: "2000", placeholder: "e.g. Out of size 10 gloves at Line 2", value: d.description, oninput: (e) => { d.description = e.target.value; } }),
              el("p", { class: "field-label" }, "Where? (optional)"),
              picker({
                id: "rq-line", title: "Where?", value: d.lineId, placeholder: "Pick a line (optional)",
                options: [{ value: "", label: "Not on a line" }, ...lines.map((l) => ({ value: l.id, label: l.name }))],
                onChange: (v) => { d.lineId = v; render(); },
              }),
              el("input", { class: "field", id: "rq-place", maxlength: "80", placeholder: "Or the spot (e.g. break room, dock door 3)", "aria-label": "Place (optional)", value: d.place, oninput: (e) => { d.place = e.target.value; } }),
              d.photos.map((u, n) => el("div", { class: "import-row" }, el("span", { class: "gap-term" }, `Photo ${n + 1}`), el("button", { class: "link-btn", type: "button", onclick: () => { d.photos.splice(n, 1); render(); } }, "Remove"))),
              ui.upload ? spinner(ui.upload) : null,
              el("label", { class: "btn secondary file-btn" }, "📷 Add a photo (optional)",
                el("input", { type: "file", accept: "image/*", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) addPhoto(f); } })),
              banner(ui),
              el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: send }, ui.busy ? "Sending…" : `📨 Send${TEST_MODE ? " (test)" : ""}`),
            ]
          : banner(ui),
      ].flat(3).filter(Boolean)
    );
  }

  const stop = onDataChange(() => { if (!ui.busy && !["rq-desc", "rq-place"].includes(document.activeElement?.id)) render(); });
  render();
  return stop;
}

// ===========================================================================
// One request: details, status history, and (for the people it went to) the next step.
// ===========================================================================

export function openRequest(container, { me, id, onExit }) {
  const ui = { busy: false, note: "", message: "", messageKind: "", retry: null };
  const find = () => [...(data.requestsForMe || []), ...(data.requestsSent || [])].find((r) => r.id === id);

  async function move(status, askFirst = true) {
    const r = find();
    if (askFirst && status === "done" && !(await confirmSheet({ title: "Mark this done?", text: `${r.createdByName || "The person who asked"} will see it's done, with your name.`, confirmLabel: "✔ Yes, done" }))) return;
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      await callUpdateRequest({ id, status, note: ui.note });
      ui.note = "";
      Object.assign(ui, { busy: false });
      toast(status === "done" ? "Marked done" : status === "in-progress" ? "Marked in progress" : "Reopened");
      if (status === "done") return onExit();
      render();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: () => move(status, false) });
      render();
    }
  }

  function render() {
    const r = find();
    if (!r) {
      container.replaceChildren(
        el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Home"),
        !data.requestsForMe || !data.requestsSent ? spinner() : emptyState("Request not found", "It may be for someone else, or no longer here.")
      );
      return;
    }
    const canWork = (r.recipients || []).includes(me.emp) || me.admin;
    const rows = [
      ["From", `${r.createdByName || ""} · ${when(r.createdAt)}`],
      ["Where", [r.lineName, r.place].filter(Boolean).join(" · ")],
      ["Status", (STATUS[r.status] || STATUS.open).label],
      ["Done by", r.status === "done" ? `${r.doneByName || ""} · ${when(r.doneAt)}` : ""],
    ].filter(([, v]) => v);
    container.replaceChildren(
      ...[
        el("button", { class: "link-btn", type: "button", onclick: onExit, disabled: ui.busy }, "← Home"),
        el("h1", { class: "fix-title" }, `${r.icon || "💬"} ${r.typeName}`),
        el("p", { class: "hint" }, r.test ? "TEST request — test site only" : `Request · ${ago(toDate(r.createdAt))}`),
        r.urgent && r.status !== "done" ? el("p", { class: "message error" }, "⚠ Urgent") : null,
        banner(ui),
        el("div", { class: "fix-body" }, r.description),
        (r.photos || []).length ? el("div", { class: "fix-media" }, r.photos.map((u, n) => el("a", { href: u, target: "_blank", rel: "noopener" }, el("img", { class: "fix-photo", src: u, alt: `Photo ${n + 1}`, loading: "lazy" })))) : null,
        el("table", { class: "info-table" }, rows.map(([k, v]) => el("tr", {}, el("th", {}, k), el("td", {}, v)))),
        el("h2", {}, "History"),
        el("div", { class: "import-preview" }, (r.history || []).map((h) =>
          el("div", { class: "import-row" }, el("span", { class: "import-line" }, (STATUS[h.status] || STATUS.open).label), el("span", { class: "gap-term" }, `${h.byName || ""} · ${when(h.at)}${h.note ? ` — ${h.note}` : ""}`)))),
        canWork && r.status !== "done"
          ? el(
              "div",
              { class: "card" },
              el("label", { class: "field-label", for: "rq-note" }, "Note (optional — the sender sees it)"),
              el("textarea", { class: "field", id: "rq-note", rows: "2", maxlength: "1000", value: ui.note, oninput: (e) => { ui.note = e.target.value; } }),
              r.status === "open" ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => move("in-progress") }, "🔧 I'm on it (In progress)") : null,
              el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => move("done") }, ui.busy ? "Saving…" : "✔ Done")
            )
          : null,
        canWork && r.status === "done" ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => move("open", false) }, "↺ Reopen") : null,
      ].flat(2).filter(Boolean)
    );
  }

  const stop = onDataChange(() => { if (!ui.busy && document.activeElement?.id !== "rq-note") render(); });
  render();
  return stop;
}

// ===========================================================================
// Admin → Request types & routing
// ===========================================================================

export function openRequestTypesAdmin(container, { onExit }) {
  const ui = { view: "list", id: null, draft: null, people: null, busy: false, message: "", messageKind: "", retry: null };
  const show = (view, message = "", kind = "") => {
    Object.assign(ui, { view, busy: false, retry: null, message: kind === "ok" ? "" : message, messageKind: kind });
    render();
    window.scrollTo(0, 0);
    if (kind === "ok" && message) toast(message);
  };
  async function act(fn, again) {
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const { data: r } = await fn();
      ui.busy = false;
      return r;
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: again });
      render();
      return null;
    }
  }
  callAdminListEmployees().then(
    ({ data: r }) => { ui.people = r.employees.filter((e) => e.active); render(); },
    () => { ui.people = []; render(); }
  );
  const roleName = (id) => data.roles?.find((r) => r.id === id)?.name || id;
  const personName = (emp) => ui.people?.find((p) => p.employeeNumber === emp)?.name || `#${emp}`;
  const routeText = (t) => [...(t.routeRoles || []).map(roleName), ...(t.routePeople || []).map(personName)].join(", ") || "—";

  function renderList() {
    const list = [...(data.requestTypes || [])].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    async function start() {
      const r = await act(() => callAdminStartRequestTypes(), start);
      if (r) show("list", r.added.length ? `Added ${r.added.length} request types` : "All five are already here", "ok");
    }
    return [
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
      el("h1", {}, "Request types & routing"),
      el("p", { class: "hint" }, "What people can ask for under “Need something?”, and who gets each one (a notification plus the request on their home screen)."),
      banner(ui),
      !data.requestTypes ? spinner() : !list.length ? emptyState("No request types yet", "Add the five starting types to begin.") : null,
      el("div", { class: "person-list" }, list.map((t) =>
        el("button", { class: "person-row", type: "button", onclick: () => edit(t) },
          el("span", { class: "person-name" }, `${t.icon || "💬"} ${t.name}`),
          el("span", { class: "person-meta" }, `Goes to: ${routeText(t)}`),
          el("span", { class: "tags" },
            t.urgent ? el("span", { class: "tag off" }, "⚠ Urgent") : null,
            t.needsRouting ? el("span", { class: "tag warn" }, "Pick who handles this") : null,
            t.active === false ? el("span", { class: "tag off" }, "Retired") : null)))),
      el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => edit(null) }, "+ Add a request type"),
      list.length < 5 ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: start }, "Add the starting types") : null,
    ];
  }

  function edit(t) {
    ui.id = t?.id || null;
    ui.draft = t
      ? { name: t.name, icon: t.icon || "", routeRoles: [...(t.routeRoles || [])], routePeople: [...(t.routePeople || [])], urgent: t.urgent === true, active: t.active !== false, order: t.order ?? 99 }
      : { name: "", icon: "💬", routeRoles: [], routePeople: [], urgent: false, active: true, order: (data.requestTypes || []).length + 1 };
    show("form");
  }

  function renderForm() {
    const d = ui.draft;
    async function save(e) {
      e?.preventDefault();
      const payload = { ...(ui.id ? { id: ui.id } : { create: true }), ...d };
      if (await act(() => callAdminSaveRequestType(payload), save)) show("list", "Saved — new requests use this routing", "ok");
    }
    const toggle = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
    const unpicked = (ui.people || []).filter((p) => !d.routePeople.includes(p.employeeNumber));
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => show("list"), disabled: ui.busy }, "← Request types"),
      el("h1", {}, ui.id ? "Edit request type" : "Add a request type"),
      banner(ui),
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "rt-name" }, "Name"),
        el("input", { class: "field", id: "rt-name", maxlength: "60", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("label", { class: "field-label", for: "rt-icon" }, "Icon (one emoji)"),
        el("input", { class: "field", id: "rt-icon", maxlength: "8", value: d.icon, oninput: (e) => { d.icon = e.target.value; } }),
        el("p", { class: "field-label" }, "Goes to these roles (everyone with the role)"),
        el("div", { class: "chips" }, (data.roles || []).filter((r) => r.active !== false).map((r) =>
          el("button", { class: d.routeRoles.includes(r.id) ? "chip on" : "chip", type: "button", onclick: () => { d.routeRoles = toggle(d.routeRoles, r.id); render(); } }, r.name))),
        el("p", { class: "field-label" }, "…and/or these people"),
        d.routePeople.map((emp) =>
          el("div", { class: "import-row" }, el("span", { class: "gap-term" }, personName(emp)), el("button", { class: "link-btn", type: "button", onclick: () => { d.routePeople = toggle(d.routePeople, emp); render(); } }, "Remove"))),
        !ui.people ? spinner("Loading people…") : unpicked.length
          ? picker({ id: "rt-person", title: "Add a person", value: "", placeholder: "+ Add a person", options: unpicked.map((p) => ({ value: p.employeeNumber, label: `${p.name} (#${p.employeeNumber})` })), onChange: (v) => { d.routePeople = [...d.routePeople, v]; render(); } })
          : null,
        el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: d.urgent, onchange: (e) => { d.urgent = e.target.checked; } }), el("span", {}, "⚠ Urgent (marked urgent, shown first)")),
        ui.id ? el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: !d.active, onchange: (e) => { d.active = !e.target.checked; } }), el("span", {}, "Retire this type (hidden from “Need something?”)")) : null,
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : "✔ Save")
      ),
    ];
  }

  function render() {
    container.replaceChildren(...[(ui.view === "form" ? renderForm : renderList)()].flat(3).filter(Boolean));
  }
  const stop = onDataChange(() => { if (!ui.busy && ui.view === "list") render(); });
  render();
  return stop;
}
