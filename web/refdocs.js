// Reference documents (Decision 65) — posted-on-the-floor documents like the Shift Station Assignment Sheet, viewable
// from the Shop Map and the Training page. The files live in the app's storage and the list in the database (signed-in
// people only) — never in this repo. Admins add a document or replace its file (each replacement is a new revision).

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, collapsible } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { storage, callSaveRefDoc } from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : t?.seconds ? t.seconds * 1000 : 0);
const fmtDay = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

function upload(file, emp, onProgress) {
  return new Promise((resolve, reject) => {
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    task.on("state_changed", (s) => onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)), reject, async () => resolve(await getDownloadURL(task.snapshot.ref)));
  });
}

export function openRefDocs(container, { me, onExit, backLabel = "Home" }) {
  const ui = { busy: false, upload: "", message: "", messageKind: "", retry: null, draft: null };
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false, upload: "" }); render(); };

  // Add a document, or replace an existing one's file (new revision).
  async function addFile(file, existing = null) {
    if (file.type !== "application/pdf" && !file.type.startsWith("image/")) return say("A PDF or a photo only.");
    if (file.size > 50 * 1024 * 1024) return say("That file is over 50 MB.");
    if (!navigator.onLine) return say(friendlyError({ code: "offline" }), () => addFile(file, existing));
    let name = existing?.name || file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    let note = "";
    if (existing && !(await confirmSheet({ title: `Replace the file for “${existing.name}”?`, text: `It becomes revision ${(existing.rev || 1) + 1}. Earlier revisions stay in its history.`, confirmLabel: "Replace" }))) return;
    Object.assign(ui, { busy: true, message: "", retry: null });
    try {
      const url = await upload(file, me.emp, (p) => { ui.upload = `Uploading ${file.name}: ${p}%`; render(); });
      ui.upload = "";
      if (!existing) { ui.draft = { url, kind: file.type === "application/pdf" ? "pdf" : "image", fileName: file.name, name, note }; ui.busy = false; render(); return; }
      await callSaveRefDoc({ id: existing.id, name: existing.name, url, kind: file.type === "application/pdf" ? "pdf" : "image", fileName: file.name, note: "New file" });
      Object.assign(ui, { busy: false });
      toast(`“${existing.name}” updated — revision ${(existing.rev || 1) + 1}`);
      render();
    } catch (err) { say(friendlyError(err), () => addFile(file, existing)); }
  }

  async function saveNew() {
    const d = ui.draft;
    if (d.name.trim().length < 3) return say("Give the document a title.");
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      await callSaveRefDoc({ name: d.name, url: d.url, kind: d.kind, fileName: d.fileName, note: "First version" });
      Object.assign(ui, { busy: false, draft: null });
      toast("Document added");
      render();
    } catch (err) { say(friendlyError(err), saveNew); }
  }

  async function retire(doc) {
    if (!(await confirmSheet({ title: `Take “${doc.name}” off the list?`, text: "It's hidden, not deleted — its history is kept.", confirmLabel: "Take it off", danger: true }))) return;
    Object.assign(ui, { busy: true });
    try { await callSaveRefDoc({ id: doc.id, name: doc.name, active: false }); ui.busy = false; toast("Taken off the list"); render(); } catch (err) { say(friendlyError(err)); }
  }

  function render() {
    const docs = (data.refDocs || []).filter((d) => d.active !== false);
    const fileInput = (onFile) => el("input", { type: "file", accept: "application/pdf,image/*", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) onFile(f); } });
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit, disabled: ui.busy }, `← ${backLabel}`),
      el("h1", {}, "📄 Reference documents"),
      el("p", { class: "hint" }, "Documents posted on the production floor. Tap one to open it."),
      banner(ui),
      ui.upload ? spinner(ui.upload) : null,
      !data.refDocs ? spinner() : !docs.length ? emptyState("No documents yet", me.admin ? "Add one below (a PDF or a photo)." : "An admin adds them.") : null,
      el("div", { class: "person-list" }, docs.map((d) =>
        el("div", { class: "person-row static doc-row" },
          el("a", { class: "doc-link", href: d.url, target: "_blank", rel: "noopener" },
            el("span", { class: "person-name" }, `${d.kind === "pdf" ? "📄" : "🖼"} ${d.name}`),
            el("span", { class: "person-meta" }, `Revision ${d.rev || 1} · ${fmtDay(d.updatedAt)}${d.updatedByName ? ` · ${d.updatedByName}` : ""}`)),
          me.admin ? el("div", { class: "btn-row" },
            el("label", { class: "btn secondary file-btn" }, "⇪ Replace file", fileInput((f) => addFile(f, d))),
            el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => retire(d) }, "Take off the list")) : null,
          (d.history || []).length > 1 ? collapsible(`doc-hist-${d.id}`, "Earlier revisions", el("div", { class: "import-preview" }, [...d.history].reverse().slice(1).map((h) =>
            el("div", { class: "import-row" }, el("span", { class: "import-line" }, `Rev ${h.rev}`), el("a", { class: "gap-term", href: h.url, target: "_blank", rel: "noopener" }, `${h.fileName || "file"} · ${fmtDay(h.at)}`))))) : null))),
      me.admin && !ui.draft ? el("label", { class: "btn file-btn" }, ui.busy ? "Working…" : "＋ Add a document (PDF or photo)", fileInput((f) => addFile(f))) : null,
      ui.draft ? el("section", { class: "card" },
        el("strong", {}, `New document: ${ui.draft.fileName}`),
        el("label", { class: "field-label", for: "rd-name" }, "Title"),
        el("input", { class: "field", id: "rd-name", maxlength: "120", value: ui.draft.name, oninput: (e) => { ui.draft.name = e.target.value; } }),
        el("div", { class: "btn-row" },
          el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: saveNew }, "✔ Add to the list"),
          el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.draft = null; render(); } }, "Cancel"))) : null,
    ].flat(3).filter(Boolean));
  }

  const stop = onDataChange(() => { if (!ui.busy && document.activeElement?.id !== "rd-name") render(); });
  render();
  return stop;
}
