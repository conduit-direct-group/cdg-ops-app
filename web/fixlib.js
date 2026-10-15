// Fix Library (Plan Decisions 25–28): search, browse by category, read a fix, add/edit, approve.
// Approved fixes come live from the database (data.js). Every change goes through the server
// (submitFix, reviewFix, retireFix, voteFix), which checks the person's live role.

import { el, friendlyError } from "./ui.js";
import { data, onDataChange, lineName } from "./data.js";
import { storage, callSubmitFix, callReviewFix, callRetireFix, callVoteFix, callAdminImportOldLibrary } from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";

const BODY_TEMPLATE = "Symptom:\n\nCause:\n\nFix (steps):\n1. \n";

// `me` = { emp, approver, admin }. `startCategory` opens the library filtered (e.g. from a QR code).
export function openFixLibrary(container, { me, onExit, startCategory = null }) {
  const ui = {
    view: "list", // list | fix | form
    search: "",
    category: startCategory || "all", // all | pending | <categoryId>
    fixId: null,
    draft: null,
    busy: false,
    message: "",
    messageKind: "",
    upload: "", // progress text while a file uploads
  };

  // ---- helpers ------------------------------------------------------------

  function show(view, message = "", kind = "") {
    Object.assign(ui, { view, message, messageKind: kind, busy: false });
    render();
    container.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  async function act(fn) {
    Object.assign(ui, { busy: true, message: "", messageKind: "" });
    render();
    try {
      const { data: result } = await fn();
      ui.busy = false;
      return result;
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error" });
      render();
      return null;
    }
  }

  const messageBox = () =>
    ui.message ? el("p", { class: `message ${ui.messageKind}`, role: ui.messageKind === "error" ? "alert" : null }, ui.message) : null;
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  const categories = () => (data.fixCategories || []).filter((c) => c.active !== false);
  const categoryName = (id) => data.fixCategories?.find((c) => c.id === id)?.name || "General";
  const allFixes = () => [...(data.fixes || []), ...(data.myFixes || []).filter((f) => f.status !== "approved")];
  const fix = () => allFixes().find((f) => f.id === ui.fixId);
  const pending = () => (data.myFixes || []).filter((f) => f.status === "pending");

  // Machines a fix applies to: every machine of the category's types, plus any pinned ones.
  function machinesFor(f) {
    const types = data.fixCategories?.find((c) => c.id === f.categoryId)?.machineTypes || [];
    return (data.machines || []).filter((m) => m.active !== false && (types.includes(m.type) || (f.machineIds || []).includes(m.id)));
  }

  // All words must appear somewhere in the title, write-up, tags, or category.
  function matches(f, words) {
    const text = `${f.title} ${f.body} ${(f.tags || []).join(" ")} ${categoryName(f.categoryId)}`.toLowerCase();
    return words.every((w) => text.includes(w));
  }

  function isOwnFile(url) {
    return url.startsWith("https://firebasestorage.googleapis.com/");
  }

  function youtubeId(url) {
    const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/);
    return m ? m[1] : null;
  }

  // ---- library list -------------------------------------------------------

  function renderList() {
    if (!data.fixes || !data.fixCategories) return [back("Home", onExit), el("h1", {}, "Fix Library"), el("p", { class: "hint" }, "Loading…")];

    // A category from a link/QR code may be a name ("Die", "vacuum tank") rather than an id.
    if (!["all", "pending"].includes(ui.category) && !data.fixCategories.some((c) => c.id === ui.category)) {
      const wanted = String(ui.category).trim().toLowerCase();
      ui.category = data.fixCategories.find((c) => c.name.toLowerCase() === wanted)?.id || "all";
    }

    const counts = new Map();
    for (const f of data.fixes) counts.set(f.categoryId, (counts.get(f.categoryId) || 0) + 1);
    const chip = (id, label) =>
      el("button", { class: ui.category === id ? "chip on" : "chip", type: "button", onclick: () => { ui.category = id; render(); } }, label);

    // Search box keeps its place while typing: only the results redraw.
    const results = el("div", { class: "person-list" });
    const drawResults = () => {
      const w = ui.search.toLowerCase().split(/\s+/).filter(Boolean);
      let l = ui.category === "pending" ? pending() : data.fixes;
      if (ui.category !== "all" && ui.category !== "pending") l = l.filter((f) => f.categoryId === ui.category);
      if (w.length) l = l.filter((f) => matches(f, w));
      results.replaceChildren(...(l.length ? l.map(fixRow) : [el("p", { class: "hint" }, w.length ? "No fixes match. Try fewer or different words." : "No fixes here yet.")]));
    };

    const searchBox = el("input", {
      class: "field search", type: "search", placeholder: "Search fixes (e.g. die heater)", value: ui.search,
      "aria-label": "Search fixes", autocomplete: "off",
      oninput: (e) => { ui.search = e.target.value; drawResults(); },
    });
    drawResults();

    const myOwn = !me.approver ? (data.myFixes || []).filter((f) => f.status !== "approved") : [];
    return [
      back("Home", onExit),
      el("h1", {}, "Fix Library"),
      messageBox(),
      searchBox,
      el(
        "div",
        { class: "chips" },
        chip("all", `All (${data.fixes.length})`),
        me.approver && pending().length ? chip("pending", `Waiting for approval (${pending().length})`) : null,
        categories().filter((c) => counts.get(c.id)).map((c) => chip(c.id, `${c.name} (${counts.get(c.id)})`))
      ),
      el("button", { class: "btn", type: "button", onclick: () => startForm(null) }, "+ Add a fix"),
      myOwn.length
        ? el("div", { class: "card" }, el("strong", {}, "Your suggestions"), myOwn.map((f) => fixRow(f)))
        : null,
      results,
      me.admin ? importCard() : null,
    ];
  }

  function fixRow(f) {
    const icons = [(f.photos || []).length ? "📷" : "", (f.videos || []).length ? "🎥" : "", f.docLink ? "📄" : ""].join(" ").trim();
    const tag =
      f.status === "pending" ? el("span", { class: "tag warn" }, f.editOf ? "Suggested change" : "Waiting for approval")
      : f.status === "rejected" ? el("span", { class: "tag off" }, "Not approved")
      : f.status === "retired" ? el("span", { class: "tag off" }, "Retired")
      : null;
    return el(
      "button",
      { class: "person-row", type: "button", onclick: () => { ui.fixId = f.id; show("fix"); } },
      el("span", { class: "person-name" }, f.title),
      el("span", { class: "person-meta" }, [categoryName(f.categoryId), icons].filter(Boolean).join(" · ")),
      el("span", { class: "tags" }, tag)
    );
  }

  // Admin only: copy the old Line Fix Library in (safe to run again).
  function importCard() {
    const imported = (data.fixes || []).filter((f) => f.legacyId).length;
    return el(
      "div",
      { class: "card" },
      el("strong", {}, "Copy from the old Fix Library"),
      el(
        "p",
        { class: "card-note" },
        imported
          ? `${imported} fixes copied so far. Running it again picks up changes made in the old library; nothing is duplicated.`
          : "Copies the old library's fixes, categories, and uploaded photos/videos into this app. The old library isn't changed. Takes a few minutes."
      ),
      el(
        "button",
        { class: "btn secondary", type: "button", disabled: ui.busy, onclick: runImport },
        ui.busy ? "Copying… (a few minutes — keep this open)" : imported ? "Copy again" : "Copy the old library"
      )
    );
  }

  async function runImport() {
    const r = await act(() => callAdminImportOldLibrary());
    if (r) {
      const problems = r.fileProblems?.length ? ` ${r.fileProblems.length} files couldn't be copied — run it again to retry.` : "";
      show("list", `Copied ${r.fixesSaved} fixes in ${r.categories} categories. Files: ${r.filesCopied} copied, ${r.filesSkipped} already here.${problems}`, problems ? "error" : "ok");
    }
  }

  // ---- one fix ------------------------------------------------------------

  function media(f) {
    const parts = [];
    (f.photos || []).forEach((url, i) => {
      parts.push(
        isOwnFile(url)
          ? el("a", { href: url, target: "_blank", rel: "noopener" }, el("img", { class: "fix-photo", src: url, alt: `Photo ${i + 1}`, loading: "lazy" }))
          : el("a", { class: "btn secondary", href: url, target: "_blank", rel: "noopener" }, `Open photo ${i + 1}`)
      );
    });
    (f.videos || []).forEach((url, i) => {
      const yt = youtubeId(url);
      if (isOwnFile(url)) parts.push(el("video", { class: "fix-video", src: url, controls: true, preload: "metadata", playsinline: true }));
      else if (yt) parts.push(el("a", { class: "btn secondary", href: `https://www.youtube.com/watch?v=${yt}`, target: "_blank", rel: "noopener" }, `Watch video ${i + 1} (YouTube)`));
      else parts.push(el("a", { class: "btn secondary", href: url, target: "_blank", rel: "noopener" }, `Open video ${i + 1}`));
    });
    if (f.docLink) parts.push(el("a", { class: "btn secondary", href: f.docLink, target: "_blank", rel: "noopener" }, "Open document"));
    return parts.length ? el("div", { class: "fix-media" }, parts) : null;
  }

  function appliesTo(f) {
    const list = machinesFor(f);
    if (!list.length) return el("p", { class: "hint" }, `${categoryName(f.categoryId)} · general`);
    const byLine = list.map((m) => `${m.id} (${m.lineId ? lineName(m.lineId) : m.name})`);
    return el("p", { class: "hint" }, `${categoryName(f.categoryId)} — applies to ${byLine.join(", ")}`);
  }

  function renderFix() {
    const f = fix();
    if (!f) return renderList();
    const original = f.editOf ? (data.fixes || []).find((x) => x.id === f.editOf) : null;
    const myVote = f.votes?.[me.emp];

    async function vote(helpful) {
      await act(() => callVoteFix({ id: f.id, helpful }));
      render();
    }
    async function review(approve) {
      if (!approve && !confirm("Reject this suggestion? It won't be published.")) return;
      const r = await act(() => callReviewFix({ id: f.id, approve }));
      if (r) {
        ui.fixId = r.id;
        show(approve ? "fix" : "list", approve ? "Approved — everyone can see it now." : "Suggestion rejected.", "ok");
      }
    }
    async function retire(retiring) {
      if (retiring && !confirm("Retire this fix? It's hidden from the library but kept in history. You can bring it back.")) return;
      if (await act(() => callRetireFix({ id: f.id, retire: retiring }))) show("fix", retiring ? "Fix retired." : "Fix is back.", "ok");
    }

    return [
      back("Fix Library", () => show("list")),
      el("h1", { class: "fix-title" }, f.title),
      appliesTo(f),
      f.status === "pending"
        ? el("p", { class: "message ok" }, f.editOf ? `Suggested change to "${original?.title || "a fix"}" — waiting for approval.` : "Waiting for approval.")
        : null,
      f.status === "rejected" ? el("p", { class: "message error" }, "This suggestion wasn't approved.") : null,
      f.status === "retired" ? el("p", { class: "message error" }, "Retired — hidden from the library.") : null,
      messageBox(),
      el("div", { class: "fix-body" }, f.body),
      media(f),
      (f.tags || []).length ? el("p", { class: "tags" }, f.tags.map((t) => el("span", { class: "tag" }, t))) : null,
      f.status === "approved"
        ? el(
            "div",
            { class: "helpful" },
            el("span", {}, "Was this helpful?"),
            el("button", { class: myVote === true ? "chip on" : "chip", type: "button", disabled: ui.busy, onclick: () => vote(true) }, `👍 ${f.helpfulYes || 0}`),
            el("button", { class: myVote === false ? "chip on" : "chip", type: "button", disabled: ui.busy, onclick: () => vote(false) }, `👎 ${f.helpfulNo || 0}`)
          )
        : null,
      me.approver && f.status === "pending"
        ? [
            el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => review(true) }, "Approve"),
            el("button", { class: "btn danger", type: "button", disabled: ui.busy, onclick: () => review(false) }, "Reject"),
          ]
        : null,
      f.status === "approved" || (f.status === "pending" && (me.approver || f.createdBy === me.emp))
        ? el(
            "button",
            { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => startForm(f) },
            me.approver || f.status === "pending" ? "Edit" : "Suggest a change"
          )
        : null,
      me.approver && f.status === "approved"
        ? el("button", { class: "btn danger", type: "button", disabled: ui.busy, onclick: () => retire(true) }, "Retire fix")
        : null,
      me.approver && f.status === "retired"
        ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => retire(false) }, "Bring fix back")
        : null,
    ];
  }

  // ---- add / edit ---------------------------------------------------------

  function startForm(existing) {
    ui.draft = existing
      ? {
          id: existing.id, title: existing.title, categoryId: existing.categoryId, body: existing.body,
          tags: (existing.tags || []).join(", "), photos: [...(existing.photos || [])], videos: [...(existing.videos || [])],
          docLink: existing.docLink || "", machineIds: [...(existing.machineIds || [])], link: "",
        }
      : {
          id: null, title: "", categoryId: ui.category !== "all" && ui.category !== "pending" ? ui.category : "",
          body: BODY_TEMPLATE, tags: "", photos: [], videos: [], docLink: "", machineIds: [], link: "",
        };
    show("form");
  }

  // Uploads a photo/video/PDF from the phone into this person's folder, then attaches its link.
  async function uploadFile(file) {
    const d = ui.draft;
    const kind = file.type.startsWith("video/") ? "videos" : file.type.startsWith("image/") ? "photos" : file.type === "application/pdf" ? "doc" : null;
    if (!kind) {
      Object.assign(ui, { message: "Only photos, videos, or PDFs can be attached.", messageKind: "error" });
      return render();
    }
    if (file.size > 250 * 1024 * 1024) {
      Object.assign(ui, { message: "That file is over 250 MB. Trim the video or send a shorter one.", messageKind: "error" });
      return render();
    }
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${me.emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    ui.busy = true;
    await new Promise((resolve) => {
      task.on(
        "state_changed",
        (s) => { ui.upload = `Uploading ${file.name}: ${Math.round((s.bytesTransferred / s.totalBytes) * 100)}%`; render(); },
        (err) => { Object.assign(ui, { message: friendlyError(err), messageKind: "error" }); resolve(); },
        async () => {
          const url = await getDownloadURL(task.snapshot.ref);
          if (kind === "doc") d.docLink = url;
          else d[kind].push(url);
          resolve();
        }
      );
    });
    Object.assign(ui, { busy: false, upload: "" });
    render();
  }

  function renderForm() {
    const d = ui.draft;
    const cat = data.fixCategories?.find((c) => c.id === d.categoryId);
    const candidates = (data.machines || []).filter((m) => m.active !== false && cat && !(cat.machineTypes || []).includes(m.type));

    async function save(e) {
      e.preventDefault();
      const payload = {
        ...(d.id ? { id: d.id } : {}),
        title: d.title, categoryId: d.categoryId, body: d.body,
        tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
        photos: d.photos, videos: d.videos, docLink: d.docLink.trim(), machineIds: d.machineIds,
      };
      const r = await act(() => callSubmitFix(payload));
      if (!r) return;
      ui.fixId = r.id;
      const msg =
        r.status === "approved" ? "Saved — everyone can see it now."
        : r.editOf ? "Thanks! Your change was sent for approval."
        : "Thanks! Your fix was sent for approval.";
      show("fix", msg, "ok");
    }

    function attached(kind, label) {
      return d[kind].map((url, i) =>
        el(
          "div",
          { class: "import-row" },
          el("span", {}, `${label} ${i + 1}${isOwnFile(url) ? "" : " (link)"}`),
          el("button", { class: "link-btn", type: "button", onclick: () => { d[kind].splice(i, 1); render(); } }, "Remove")
        )
      );
    }

    function addLink() {
      const url = d.link.trim();
      if (!/^https:\/\//.test(url)) {
        Object.assign(ui, { message: "Paste a full link starting with https://", messageKind: "error" });
        return render();
      }
      (/\.(mov|mp4|m4v|webm)(\?|$)/i.test(url) || youtubeId(url) ? d.videos : d.photos).push(url);
      d.link = "";
      ui.message = "";
      render();
    }

    return [
      back(d.id ? "Back" : "Fix Library", () => show(d.id ? "fix" : "list")),
      el("h1", {}, d.id ? (me.approver || fix()?.status === "pending" ? "Edit fix" : "Suggest a change") : "Add a fix"),
      me.approver ? null : el("p", { class: "hint" }, "A Maintenance tech, Production Lead, or Admin approves it before everyone sees it."),
      messageBox(),
      ui.upload ? el("p", { class: "message ok" }, ui.upload) : null,
      el(
        "form",
        { onsubmit: save },
        el("label", { class: "field-label", for: "fx-title" }, "Title — what's the problem?"),
        el("input", { class: "field", id: "fx-title", maxlength: "120", required: true, value: d.title, oninput: (e) => { d.title = e.target.value; } }),
        el("label", { class: "field-label", for: "fx-cat" }, "Category"),
        el(
          "select",
          { class: "field", id: "fx-cat", required: true, onchange: (e) => { d.categoryId = e.target.value; d.machineIds = []; render(); } },
          el("option", { value: "" }, "Pick one…"),
          categories().map((c) => el("option", { value: c.id, selected: c.id === d.categoryId }, c.name))
        ),
        cat && (cat.machineTypes || []).length
          ? el("p", { class: "hint" }, `Shows on every ${cat.machineTypes.join(" / ")} machine.`)
          : null,
        el("label", { class: "field-label", for: "fx-body" }, "The fix — symptom, cause, steps"),
        el("textarea", { class: "field paste-box", id: "fx-body", rows: "10", required: true, maxlength: "10000", value: d.body, oninput: (e) => { d.body = e.target.value; } }),

        el("p", { class: "field-label" }, "Photos, videos, PDF"),
        attached("photos", "Photo"),
        attached("videos", "Video"),
        d.docLink ? el("div", { class: "import-row" }, el("span", {}, "Document"), el("button", { class: "link-btn", type: "button", onclick: () => { d.docLink = ""; render(); } }, "Remove")) : null,
        el(
          "label",
          { class: "btn secondary file-btn" },
          ui.busy && ui.upload ? "Uploading…" : "📷 Add photo / video / PDF",
          el("input", {
            type: "file", accept: "image/*,video/*,application/pdf", hidden: true, disabled: ui.busy,
            onchange: (e) => { const file = e.target.files[0]; e.target.value = ""; if (file) uploadFile(file); },
          })
        ),
        el("label", { class: "field-label", for: "fx-link" }, "…or paste a link (SharePoint, YouTube)"),
        el(
          "div",
          { class: "link-row" },
          el("input", { class: "field", id: "fx-link", type: "url", placeholder: "https://", value: d.link, oninput: (e) => { d.link = e.target.value; } }),
          el("button", { class: "btn secondary", type: "button", onclick: addLink }, "Add")
        ),

        el("label", { class: "field-label", for: "fx-tags" }, "Tags (optional, separated by commas)"),
        el("input", { class: "field", id: "fx-tags", value: d.tags, oninput: (e) => { d.tags = e.target.value; } }),

        candidates.length
          ? el(
              "details",
              { class: "more" },
              el("summary", {}, "Also show on other machines (optional)"),
              candidates.map((m) =>
                el(
                  "label",
                  { class: "check-row" },
                  el("input", {
                    type: "checkbox", checked: d.machineIds.includes(m.id),
                    onchange: (e) => { d.machineIds = e.target.checked ? [...d.machineIds, m.id] : d.machineIds.filter((x) => x !== m.id); },
                  }),
                  el("span", {}, `${m.id} · ${m.name} (${lineName(m.lineId)})`)
                )
              )
            )
          : null,

        el(
          "button",
          { class: "btn", type: "submit", disabled: ui.busy },
          ui.busy ? "Saving…" : me.approver ? "Save" : "Send for approval"
        )
      ),
    ];
  }

  function render() {
    const views = { list: renderList, fix: renderFix, form: renderForm };
    container.replaceChildren(...[(views[ui.view] || renderList)()].flat(2).filter(Boolean));
  }

  // Live updates redraw the screen — but not while typing in the form or search box.
  const stop = onDataChange(() => {
    const typing = ui.view === "form" || (ui.view === "list" && document.activeElement?.classList.contains("search"));
    if (!ui.busy && !typing) render();
  });

  render();
  return stop;
}
