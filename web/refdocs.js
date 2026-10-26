// Reference documents (Decision 65) — posted-on-the-floor documents like the Shift Station Assignment Sheet, viewable
// from the Shop Map and the Training page. The files live in the app's storage and the list in the database (signed-in
// people only) — never in this repo. Read-only here: documents are added and replaced in 📁 Documents & forms (Decision 116).

import { el, spinner, emptyState } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { storage } from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : t?.seconds ? t.seconds * 1000 : 0);
const fmtDay = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

// Upload a file into my own uploads/ folder; resolves with its link (Documents & forms uses it too).
export function uploadFile(file, emp, onProgress) {
  return new Promise((resolve, reject) => {
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    task.on("state_changed", (s) => onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)), reject, async () => resolve(await getDownloadURL(task.snapshot.ref)));
  });
}

export function openRefDocs(container, { onExit, backLabel = "Home" }) {
  function render() {
    const docs = (data.refDocs || []).filter((d) => d.active !== false);
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "📄 Reference documents"),
      el("p", { class: "hint" }, "Documents posted on the production floor. Tap one to open it."),
      !data.refDocs ? spinner() : !docs.length ? emptyState("No documents yet", "They're added in 📁 Documents & forms.") : null,
      el("div", { class: "person-list" }, docs.map((d) =>
        el("div", { class: "person-row static doc-row" },
          el("a", { class: "doc-link", href: d.url, target: "_blank", rel: "noopener" },
            el("span", { class: "person-name" }, `${d.kind === "pdf" ? "📄" : "🖼"} ${d.name}`),
            el("span", { class: "person-meta" }, `Revision ${d.rev || 1} · ${fmtDay(d.updatedAt)}${d.updatedByName ? ` · ${d.updatedByName}` : ""}`))))),
    ].flat(3).filter(Boolean));
  }

  const stop = onDataChange(render);
  render();
  return stop;
}
