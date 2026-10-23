// Operator checklists (Plan Phase 3) — same checklists and 14-day rule as the old Line Fix Library, signed by
// the signed-in person instead of initials. Overdue checklists show as a red banner at the top of the
// Fix Library (never hidden). Admins edit the checklists and their training photos/videos.
//
// Rules match functions/checklists.js (the server checks every sign-off the same way).

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, picker } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import {
  storage, TEST_MODE, callSignChecklist, callAdminSaveChecklist, callAdminSetChecklistMedia, callAdminStartChecklists,
  callAdminImportOldChecklists, callSignoffPeople, callChecklistVerifiers,
} from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { signOff, signedNote } from "./signoff.js";
import { offlineSign } from "./outbox.js";
import { shiftNow } from "./shift.js";

const DAY_MS = 86400000;

// ---- rules (same as the server) -------------------------------------------------

export function unitId(templateId, lineId) {
  return `${lineId || "plant"}__${templateId}`;
}

// Every checklist in use: one per (line, checklist) where the line has a machine of its types, plus plant-wide ones.
export function checklistUnits() {
  const templates = (data.checklistTemplates || []).filter((t) => t.active !== false);
  const machines = (data.machines || []).filter((m) => m.active !== false);
  const units = [];
  for (const t of templates) {
    const fits = machines.filter((m) => (t.machineTypes || []).includes(m.type));
    if (!t.perLine) {
      if (fits.length) units.push({ id: unitId(t.id, null), template: t, lineId: null });
      continue;
    }
    for (const line of (data.lines || []).filter((l) => l.active !== false)) {
      if (fits.some((m) => m.lineId === line.id)) units.push({ id: unitId(t.id, line.id), template: t, lineId: line.id });
    }
  }
  return units;
}

// The checklist(s) a machine belongs to.
export function unitsForMachine(machine) {
  return checklistUnits().filter((u) => (u.template.machineTypes || []).includes(machine.type) && (!u.template.perLine || u.lineId === machine.lineId));
}

export function unitLabel(u) {
  return u.lineId ? `${lineName(u.lineId)} · ${u.template.name}` : u.template.name;
}

// Test site: checklists start fresh each shift — every item counts as done at the start of this shift unless it was
// practiced since, so overdue counts don't pile up while nothing real is signed there. The live site is unchanged.
function testBaseline(now) {
  if (!TEST_MODE) return 0;
  return shiftNow(now)?.startMs || new Date(now).setHours(0, 0, 0, 0);
}

// When each item of a checklist was last done (on the test site, never earlier than the start of this shift).
export function doneFor(u, now = Date.now()) {
  const base = testBaseline(now);
  const raw = data.checklistUnits?.[u.id] || {};
  return base ? Object.fromEntries((u.template.items || []).map((i) => [i.id, raw[i.id]?.at > base ? raw[i.id] : { at: base, byName: "start of shift (test site)" }])) : raw;
}

// Sign-offs on this checklist waiting for Verified (two-step sign-off, functions/verify.js), oldest first.
export const pendingFor = (u) => [...(data.checklistPending?.[u.id] || [])].sort((a, b) => (a.at || 0) - (b.at || 0));

export function unitStatus(u, now = Date.now()) {
  const done = doneFor(u, now);
  const dueMs = (u.template.everyDays || 14) * DAY_MS;
  let soonestDue = Infinity;
  let never = 0;
  let late = 0;
  let lastAt = 0;
  let lastBy = "";
  for (const item of u.template.items || []) {
    const rec = done[item.id];
    if (!rec?.at) {
      never++;
      soonestDue = -Infinity;
      continue;
    }
    const due = rec.at + dueMs;
    if (due < now) late++;
    if (due < soonestDue) soonestDue = due;
    if (rec.at > lastAt) {
      lastAt = rec.at;
      lastBy = rec.byName || "";
    }
  }
  const total = (u.template.items || []).length;
  return { overdue: never > 0 || late > 0, pending: pendingFor(u).length, never, late, total, daysLeft: Number.isFinite(soonestDue) ? Math.ceil((soonestDue - now) / DAY_MS) : null, lastAt, lastBy };
}

export function overdueUnits() {
  if (!data.checklistTemplates || !data.checklistUnits || !data.machines || !data.lines) return [];
  return checklistUnits().filter((u) => unitStatus(u).overdue);
}

const fmtDate = (ms) => {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};

// "⚠ 2 items overdue" / "Due in 5 days" — as a tag.
export function statusTag(s) {
  if (s.overdue) {
    const n = s.never + s.late;
    return el("span", { class: "tag off" }, `⚠ ${s.never === s.total ? "Not done yet" : `${n} item${n === 1 ? "" : "s"} overdue`}`);
  }
  if (s.pending) return el("span", { class: "tag" }, `Done — ${s.pending} sign-off${s.pending === 1 ? "" : "s"} need${s.pending === 1 ? "s" : ""} Verified`);
  const text = s.daysLeft <= 0 ? "Due today" : s.daysLeft === 1 ? "Due in 1 day" : `Due in ${s.daysLeft} days`;
  return el("span", { class: s.daysLeft <= 3 ? "tag warn" : "tag" }, text);
}

// Red banner listing every overdue checklist (one big button each). Null when nothing is overdue.
// `machine` (optional) limits it to that machine's checklists (its page in the Fix Library).
export function overdueBanner(onOpen, machine = null) {
  const mine = machine ? new Set(unitsForMachine(machine).map((u) => u.id)) : null;
  const late = overdueUnits().filter((u) => !mine || mine.has(u.id));
  if (!late.length) return null;
  return el(
    "div",
    { class: "alert-banner", role: "alert" },
    el("strong", {}, `⚠ ${late.length} machine checklist${late.length === 1 ? "" : "s"} overdue`),
    el("div", { class: "alert-pills" }, late.map((u) => el("button", { class: "alert-pill", type: "button", onclick: () => onOpen(u.id) }, unitLabel(u))))
  );
}

// Machine view: each checklist for this machine, its status, and an Open button.
export function checklistCard(machine, onOpen) {
  const units = unitsForMachine(machine);
  if (!units.length) return null;
  return el(
    "div",
    { class: "card" },
    el("strong", {}, "📋 Operator checklist"),
    units.map((u) => {
      const s = unitStatus(u);
      return el(
        "div",
        { class: "sub-section" },
        el("div", { class: "row-between" }, el("span", { class: "person-name" }, unitLabel(u)), statusTag(s)),
        el("p", { class: "card-note" }, s.lastAt ? `Last done ${fmtDate(s.lastAt)}${s.lastBy ? ` by ${s.lastBy}` : ""} · every ${u.template.everyDays || 14} days` : `Never done · every ${u.template.everyDays || 14} days`),
        el("button", { class: s.overdue ? "btn danger" : "btn", type: "button", onclick: () => onOpen(u.id) }, "📋 Open checklist")
      );
    })
  );
}

// ---- upload (training photos/videos) -----------------------------------------------

function upload(file, me, onProgress) {
  return new Promise((resolve, reject) => {
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${me.emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    task.on(
      "state_changed",
      (s) => onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)),
      reject,
      async () => resolve(await getDownloadURL(task.snapshot.ref))
    );
  });
}

function mediaView(item) {
  const parts = [
    ...(item.videos || []).map((u) => el("video", { class: "fix-video", src: u, controls: true, preload: "metadata", playsinline: true })),
    ...(item.photos || []).map((u, n) => el("a", { href: u, target: "_blank", rel: "noopener" }, el("img", { class: "fix-photo", src: u, alt: `Training photo ${n + 1}`, loading: "lazy" }))),
  ];
  return parts.length ? el("div", { class: "fix-media" }, parts) : emptyState("No training videos or photos yet", "An admin can add them here.");
}

// ===========================================================================
// One checklist: check what you did, sign off as yourself.
// ===========================================================================

export function openChecklist(container, { me, unitId: id, onExit }) {
  const ui = { view: "list", checked: new Set(), itemId: null, busy: false, upload: "", message: "", messageKind: "", retry: null };

  const unit = () => checklistUnits().find((u) => u.id === id);
  const show = (view, message = "", kind = "") => {
    Object.assign(ui, { view, busy: false, retry: null, message: kind === "ok" ? "" : message, messageKind: kind });
    render();
    window.scrollTo(0, 0);
    if (kind === "ok" && message) toast(message);
  };
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  async function submit() {
    if (!ui.checked.size) return Object.assign(ui, { message: "Check at least one item you did.", messageKind: "error" }), render();
    Object.assign(ui, { message: "", retry: null });
    // The shared sign-off: tap your name, then your PIN (Decision 7). On a line tablet the crew can sign here.
    const n = ui.checked.size;
    const r = await signOff({
      title: "Sign off checklist",
      what: `${unitLabel(unit())} · ${n} item${n === 1 ? "" : "s"}`,
      me: { emp: me.emp, name: me.name },
      others: async () => (await callSignoffPeople({ kind: "checklist" })).data.people,
      action: offlineSign("signChecklist", { unitId: id, itemIds: [...ui.checked] }, { label: `Checklist · ${unitLabel(unit())}`, key: `checklist:${id}` }),
    });
    if (!r) return render();
    ui.checked.clear();
    onExit(signedNote(r, `${unitLabel(unit())} signed off by ${r.name} — ${r.count} item${r.count === 1 ? "" : "s"}${r.test ? " (test)" : ""} — needs Verified`));
  }

  // Verified: someone other than the person who signed it.
  async function verify(p) {
    const canMe = me.roles.some((x) => ["supervisor", "plant-manager", "lead"].includes(x)) && p.by !== me.emp;
    const r = await signOff({
      title: "Verified", what: `${unitLabel(unit())} · ${p.items.length} item${p.items.length === 1 ? "" : "s"} · signed by ${p.byName}`,
      me: canMe ? { emp: me.emp, name: me.name } : null,
      others: async () => (await callChecklistVerifiers({ unitId: id, signoffId: p.id })).data.people,
      action: offlineSign("verifyChecklist", { unitId: id, signoffId: p.id }, { label: `Checklist verified · ${unitLabel(unit())}`, key: `checklist-verify:${p.id}` }),
    });
    if (r) toast(signedNote(r, `Verified by ${r.name}${r.role ? ` (${r.role})` : ""}${r.test ? " (test)" : ""}`));
  }
  function pendingCard(u) {
    const list = pendingFor(u);
    if (!list.length) return null;
    const names = new Map((u.template.items || []).map((i) => [i.id, i.text]));
    return el("section", { class: "card" },
      el("strong", {}, `Waiting for Verified (${list.length})`),
      el("p", { class: "card-note" }, "A Supervisor verifies — or, with no Supervisor on shift, the Production Manager or a Line Lead. Not the person who signed it."),
      list.map((p) => el("div", { class: "sub-section" },
        el("span", { class: "person-name" }, `Signed by ${p.byName} · ${fmtDate(p.at)}${p.test ? " (test)" : ""}`),
        el("span", { class: "person-meta" }, p.items.map((i) => names.get(i) || i).join(" · ")),
        el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => verify(p) }, "✍ Verified"))));
  }

  function renderList() {
    if (!data.checklistTemplates || !data.checklistUnits) return [back("Back", () => onExit()), spinner("Loading checklist…")];
    const u = unit();
    if (!u) return [back("Back", () => onExit()), emptyState("This checklist isn't in use any more", "An admin may have changed it.")];
    const done = doneFor(u);
    const dueMs = (u.template.everyDays || 14) * DAY_MS;
    const items = u.template.items || [];
    const allOn = items.length && items.every((i) => ui.checked.has(i.id));
    return [
      back("Back", () => onExit()),
      el("h1", {}, unitLabel(u)),
      el("p", { class: "hint" }, `Check what you did. Each item is due every ${u.template.everyDays || 14} days.`),
      banner(ui),
      pendingCard(u),
      el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { items.forEach((i) => (allOn ? ui.checked.delete(i.id) : ui.checked.add(i.id))); render(); } }, allOn ? "Uncheck all" : "✔ Check all"),
      el(
        "div",
        { class: "ck-list" },
        items.map((item) => {
          const rec = done[item.id];
          const late = !rec?.at || rec.at + dueMs < Date.now();
          const media = (item.videos || []).length + (item.photos || []).length;
          return el(
            "div",
            { class: ui.checked.has(item.id) ? "ck-item on" : "ck-item" },
            el(
              "label",
              { class: "check-row" },
              el("input", { type: "checkbox", checked: ui.checked.has(item.id), disabled: ui.busy, onchange: (e) => { e.target.checked ? ui.checked.add(item.id) : ui.checked.delete(item.id); render(); } }),
              el(
                "span",
                {},
                el("span", { class: "person-name" }, item.text),
                el("span", { class: late ? "ck-last late" : "ck-last" }, rec?.at ? `Last: ${fmtDate(rec.at)}${rec.byName ? ` · ${rec.byName}` : ""}${rec.test ? " (test)" : ""}${late ? " · overdue" : ""}` : "Never done")
              )
            ),
            media || me.admin
              ? el("button", { class: "link-btn", type: "button", onclick: () => { ui.itemId = item.id; show("media"); } }, media ? `🎥 How to (${media})` : "＋ Add training media")
              : null
          );
        })
      ),
      el("p", { class: "hint" }, `You sign with your PIN${TEST_MODE ? " — test site, practice only" : ""}.`),
      el("button", { class: "btn big", type: "button", disabled: ui.busy || !ui.checked.size, onclick: submit }, ui.busy ? "Saving…" : ui.checked.size ? `✔ Sign off ${ui.checked.size} item${ui.checked.size === 1 ? "" : "s"}` : "✔ Sign off"),
    ];
  }

  // Training photos/videos for one item; admins add and remove them.
  function renderMedia() {
    const u = unit();
    const item = u?.template.items.find((i) => i.id === ui.itemId);
    if (!item) return renderList();
    async function save(photos, videos, msg, again) {
      Object.assign(ui, { busy: true, message: "", retry: null });
      render();
      try {
        await callAdminSetChecklistMedia({ templateId: u.template.id, itemId: item.id, photos, videos });
        show("media", msg, "ok");
      } catch (err) {
        Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: again });
        render();
      }
    }
    async function add(file) {
      if (!/^(image|video)\//.test(file.type)) return Object.assign(ui, { message: "Photos or videos only.", messageKind: "error" }), render();
      if (!navigator.onLine) return Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error" }), render();
      Object.assign(ui, { busy: true, message: "" });
      try {
        const url = await upload(file, me, (p) => { ui.upload = `Uploading ${file.name}: ${p}%`; render(); });
        ui.upload = "";
        const isVideo = file.type.startsWith("video/");
        await save(isVideo ? item.photos || [] : [...(item.photos || []), url], isVideo ? [...(item.videos || []), url] : item.videos || [], isVideo ? "Video added" : "Photo added", () => add(file));
      } catch (err) {
        Object.assign(ui, { busy: false, upload: "", message: friendlyError(err), messageKind: "error", retry: () => add(file) });
        render();
      }
    }
    async function remove(kind, url) {
      if (!(await confirmSheet({ title: "Remove this from the training media?", text: "It goes to the trash bin for 30 days.", confirmLabel: "Remove", danger: true }))) return;
      const next = { photos: [...(item.photos || [])], videos: [...(item.videos || [])] };
      next[kind] = next[kind].filter((x) => x !== url);
      await save(next.photos, next.videos, "Removed — in the trash for 30 days", () => remove(kind, url));
    }
    return [
      back(unitLabel(u), () => show("list")),
      el("h1", { class: "fix-title" }, item.text),
      el("p", { class: "hint" }, u.template.name),
      banner(ui),
      ui.upload ? spinner(ui.upload) : null,
      mediaView(item),
      me.admin
        ? el(
            "div",
            { class: "card" },
            el("strong", {}, "Admin: training media"),
            el("label", { class: "btn secondary file-btn" }, "🎥 Add video", el("input", { type: "file", accept: "video/*", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) add(f); } })),
            el("label", { class: "btn secondary file-btn" }, "📷 Add photo", el("input", { type: "file", accept: "image/*", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) add(f); } })),
            [...(item.videos || []).map((url, n) => ["videos", url, `Video ${n + 1}`]), ...(item.photos || []).map((url, n) => ["photos", url, `Photo ${n + 1}`])].map(([kind, url, label]) =>
              el("div", { class: "import-row" }, el("span", { class: "gap-term" }, label), el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => remove(kind, url) }, "Remove"))
            )
          )
        : null,
    ];
  }

  function render() {
    container.replaceChildren(...[(ui.view === "media" ? renderMedia : renderList)()].flat(3).filter(Boolean));
  }
  const stop = onDataChange(() => { if (!ui.busy) render(); });
  render();
  return stop;
}

// ===========================================================================
// Admin → Checklists: the list, add/edit, starting checklists, copy from the old library.
// ===========================================================================

export function openChecklistAdmin(container, { me, onExit }) {
  const ui = { view: "list", id: null, draft: null, busy: false, message: "", messageKind: "", retry: null };
  const show = (view, message = "", kind = "") => {
    Object.assign(ui, { view, busy: false, retry: null, message: kind === "ok" ? "" : message, messageKind: kind });
    render();
    window.scrollTo(0, 0);
    if (kind === "ok" && message) toast(message);
  };
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);
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

  const machineTypes = () => [...new Set((data.machines || []).filter((m) => m.active !== false).map((m) => m.type).filter(Boolean))].sort();

  function renderList() {
    const list = data.checklistTemplates;
    async function start() {
      const r = await act(() => callAdminStartChecklists(), start);
      if (r) show("list", r.added.length ? `Added ${r.added.length} checklists` : "All six are already here", "ok");
    }
    async function copyOld() {
      const r = await act(() => callAdminImportOldChecklists(), copyOld);
      if (r) show("list", `Copied ${r.datesCopied} sign-off dates and training media for ${r.itemsWithMedia} items${r.fileProblems.length ? ` (${r.fileProblems.length} files couldn't be copied)` : ""}`, r.fileProblems.length ? "error" : "ok");
    }
    return [
      back("Admin", onExit),
      el("h1", {}, "Checklists"),
      el("p", { class: "hint" }, "Operator checklists. Each one is done per line (or once for the plant), and each item is due every N days."),
      banner(ui),
      !list ? spinner() : !list.length ? emptyState("No checklists yet", "Add the old library's six checklists to start.") : null,
      el(
        "div",
        { class: "person-list" },
        (list || []).map((t) =>
          el(
            "button",
            { class: "person-row", type: "button", onclick: () => edit(t) },
            el("span", { class: "person-name" }, t.name),
            el("span", { class: "person-meta" }, `${(t.items || []).length} items · every ${t.everyDays} days · ${t.perLine ? "per line" : "once for the plant"} · ${(t.machineTypes || []).join(", ")}`),
            t.active === false ? el("span", { class: "tags" }, el("span", { class: "tag off" }, "Retired")) : null
          )
        )
      ),
      el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => edit(null) }, "+ Add a checklist"),
      el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: start }, "Add the starting checklists"),
      el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: copyOld }, ui.busy ? "Copying…" : "⇩ Copy dates & training media from the old library"),
    ];
  }

  function edit(t) {
    ui.id = t?.id || null;
    ui.draft = t
      ? { name: t.name, machineTypes: [...(t.machineTypes || [])], perLine: t.perLine !== false, everyDays: String(t.everyDays || 14), active: t.active !== false, items: (t.items || []).map((i) => ({ id: i.id, text: i.text })) }
      : { name: "", machineTypes: [], perLine: true, everyDays: "14", active: true, items: [{ text: "" }] };
    show("form");
  }

  function renderForm() {
    const d = ui.draft;
    async function save(e) {
      e?.preventDefault();
      const payload = { ...(ui.id ? { id: ui.id } : { create: true }), name: d.name, machineTypes: d.machineTypes, perLine: d.perLine, everyDays: Number(d.everyDays), active: d.active, items: d.items.filter((i) => i.text.trim()) };
      if (await act(() => callAdminSaveChecklist(payload), save)) show("list", "Checklist saved", "ok");
    }
    const typeChip = (t) =>
      el("button", { class: d.machineTypes.includes(t) ? "chip on" : "chip", type: "button", onclick: () => { d.machineTypes = d.machineTypes.includes(t) ? d.machineTypes.filter((x) => x !== t) : [...d.machineTypes, t]; render(); } }, t);
    return [
      back("Checklists", () => show("list")),
      el("h1", {}, ui.id ? "Edit checklist" : "Add a checklist"),
      banner(ui),
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "ck-name" }, "Name"),
        el("input", { class: "field", id: "ck-name", maxlength: "60", required: true, value: d.name, oninput: (e) => { d.name = e.target.value; } }),
        el("p", { class: "field-label" }, "Machine types it covers"),
        el("div", { class: "chips" }, machineTypes().map(typeChip)),
        el("p", { class: "field-label" }, "Done…"),
        el("div", { class: "choices two" },
          el("button", { class: d.perLine ? "choice on" : "choice", type: "button", onclick: () => { d.perLine = true; render(); } }, "Once per line"),
          el("button", { class: !d.perLine ? "choice on" : "choice", type: "button", onclick: () => { d.perLine = false; render(); } }, "Once for the plant")
        ),
        el("label", { class: "field-label", for: "ck-days" }, "Each item is due every (days)"),
        picker({ id: "ck-days", title: "Due every", value: d.everyDays, options: ["7", "14", "30", "60", "90"].map((v) => ({ value: v, label: `${v} days` })), onChange: (v) => { d.everyDays = v; render(); } }),
        el("p", { class: "field-label" }, "Items"),
        d.items.map((item, n) =>
          el(
            "div",
            { class: "link-row" },
            el("input", { class: "field", "aria-label": `Item ${n + 1}`, maxlength: "200", value: item.text, oninput: (e) => { item.text = e.target.value; } }),
            el("button", { class: "btn secondary", type: "button", onclick: () => { d.items.splice(n, 1); render(); } }, "Remove")
          )
        ),
        el("button", { class: "btn secondary", type: "button", onclick: () => { d.items.push({ text: "" }); render(); } }, "+ Add an item"),
        ui.id
          ? el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: !d.active, onchange: (e) => { d.active = !e.target.checked; } }), el("span", {}, "Retire this checklist (hidden; history kept)"))
          : null,
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
