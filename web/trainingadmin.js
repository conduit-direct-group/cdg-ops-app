// Admin → Training setup: load the training app's data, move the old tablet's records in, and manage trainers.
// The training content (roster, levels, SOP and trainer-guide text) goes straight to the database — never this repo.

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, collapsible } from "./ui.js";
import { db, TEST_MODE, callAdminImportTrainingData, callAdminImportTrainingBackup, callAdminSetTrainer } from "./firebase.js";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const col = (name) => collection(db, (TEST_MODE ? "test_" : "") + name);

// --- reading the original app's file -------------------------------------------------------------------------

// The original is one self-unpacking file (original_CDG_Training_App.html); its parts are stored inside as
// base64 (sometimes gzipped). cdg-data.js on its own works too.
async function unpackParts(text) {
  const m = text.match(/<script type="__bundler\/manifest">([\s\S]*?)<\/script>/);
  if (!m) return [text];
  const manifest = JSON.parse(m[1]);
  const parts = [];
  for (const e of Object.values(manifest)) {
    if (!/javascript/.test(e.mime || "")) continue;
    let bytes = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
    if (e.compressed) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    const s = new TextDecoder().decode(bytes);
    if (/^\s*(window\.CDG_DATA|\/\/ CDG Training: Microsoft Entra)/.test(s)) parts.push(s);
  }
  return parts;
}
// Reads `window.NAME = {…};` as data (JSON) — the file's code is never run.
function jsonAfter(text, name) {
  const i = text.indexOf(`window.${name} = `);
  if (i < 0) return null;
  const start = i + `window.${name} = `.length;
  const next = text.indexOf("\nwindow.", start);
  const body = text.slice(start, next < 0 ? undefined : next).trim().replace(/;$/, "");
  return JSON.parse(body);
}
export async function readOriginal(file) {
  const parts = await unpackParts(await file.text());
  const dataText = parts.find((p) => p.includes("window.CDG_DATA"));
  if (!dataText) throw new Error("That file doesn't have the training data in it. Pick original_CDG_Training_App.html or cdg-data.js.");
  const data = jsonAfter(dataText, "CDG_DATA"), lib = jsonAfter(dataText, "CDG_LIB");
  const entraText = parts.find((p) => p.includes("window.CDG_ENTRA")) || "";
  const val = (k) => (entraText.match(new RegExp(`${k}:\\s*'([^']*)'`)) || [])[1] || "";
  const entra = entraText ? { clientId: val("clientId"), tenantId: val("tenantId"), link: val("link") } : null;
  return { data, lib, entra };
}

// --- reading the old tablet's backup ------------------------------------------------------------------------

const PERSON_FIELDS = ["records", "checks", "kcAns", "kcAtt", "extra", "refresh", "orient", "posOv"];

// Tablets that never updated to the newer module numbers get the same fix the old app made when it loaded.
function upgradeOldNumbers(t) {
  if (t.cnum === 2) return t;
  const tn = (c) => c.replace(/^C-(0[4-9]|10)$/, (_, n) => "C-" + String(+n - 1).padStart(2, "0"));
  const rk = (o) => o && Object.fromEntries(Object.entries(o).map(([n, m]) => [n, m && typeof m === "object" ? Object.fromEntries(Object.entries(m).filter(([c]) => c !== "C-03").map(([c, v]) => [tn(c), v])) : m]));
  const out = { ...t, cnum: 2, wbData: null };
  ["records", "checks", "kcAns", "kcAtt", "extra"].forEach((k) => { if (out[k]) out[k] = rk(out[k]); });
  return out;
}
function readBackup(json) {
  if (json?.app !== "cdg-training-backup" || !json.tablet || typeof json.tablet !== "object") throw new Error("That isn't the backup file from the old training tablet (cdg-training-backup.json).");
  const tablet = upgradeOldNumbers(json.tablet);
  const names = new Set();
  PERSON_FIELDS.forEach((f) => Object.keys(tablet[f] || {}).forEach((n) => names.add(n)));
  const sigs = new Set();
  let signOffs = 0;
  Object.values(tablet.records || {}).forEach((mods) => Object.values(mods || {}).forEach((list) => (list || []).forEach((r) => {
    if (!r.imported) signOffs++;
    if (r.sig) sigs.add(r.sig);
    if (r.csig) sigs.add(r.csig);
  })));
  const queue = (json.queue || []).filter((j) => j && j.t !== "trainer" && j.t !== "trainerAdd");
  const trainers = tablet.trainers || [];
  return {
    backup: { ...json, tablet, queue },
    names: [...names],
    counts: [
      ["Trainers", trainers.length],
      ["Trainers with a PIN (they keep it)", trainers.filter((t) => /^\d{4}$/.test(t.pin || "")).length],
      ["Trainees with records", names.size],
      ["Sign-offs (not counting workbook imports)", signOffs],
      ["Signatures", sigs.size],
      ["Knowledge checks", Object.values(tablet.kcAtt || {}).reduce((a, m) => a + Object.values(m || {}).reduce((b, l) => b + (l || []).length, 0), 0)],
      ["Coordinator to-dos", (tablet.todos || []).length],
      ["Changes not yet sent to the workbook", queue.length],
    ],
    savedAt: json.savedAt,
  };
}
// Groups trainees into uploads of about 2 MB each (signatures make some trainees big).
function chunks(tablet, names) {
  const out = [];
  let cur = {}, size = 0;
  for (const n of names) {
    const one = Object.fromEntries(PERSON_FIELDS.map((f) => [f, tablet[f]?.[n]]).filter(([, v]) => v != null));
    const s = JSON.stringify(one).length;
    if (size && size + s > 2_000_000) { out.push(cur); cur = {}; size = 0; }
    PERSON_FIELDS.forEach((f) => { if (one[f] != null) (cur[f] ||= {})[n] = one[f]; });
    size += s;
  }
  if (size) out.push(cur);
  return out;
}

// --- the screen ------------------------------------------------------------------------------------------

export function openTrainingAdmin(container, { onExit }) {
  const ui = { ref: undefined, trainers: null, people: null, busy: false, progress: "", message: "", messageKind: "", retry: null, pending: null };

  async function run(fn, again) {
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const r = await fn();
      Object.assign(ui, { busy: false, progress: "" });
      render();
      return r || true;
    } catch (err) {
      Object.assign(ui, { busy: false, progress: "", message: friendlyError(err), messageKind: "error", retry: again });
      render();
      return null;
    }
  }

  async function pickBackup(file) {
    try {
      ui.pending = readBackup(JSON.parse(await file.text()));
      Object.assign(ui, { message: "", retry: null });
    } catch (err) {
      Object.assign(ui, { pending: null, message: err.message || "Couldn't read that file.", messageKind: "error", retry: null });
    }
    render();
  }

  async function saveBackup() {
    const { backup, names } = ui.pending;
    const ok = await confirmSheet({
      title: TEST_MODE ? "Save to the test copy?" : "Save the old tablet's records?",
      text: TEST_MODE ? "Test site: this goes into the practice copy only. The live app is not changed." : "Trainees in the backup get the tablet's records in the app (replacing what the app has for them). Trainers keep their PINs.",
      confirmLabel: "Save to the app",
    });
    if (!ok) return;
    const parts = chunks(backup.tablet, names);
    const r = await run(async () => {
      let n = 0;
      for (const tablet of parts) {
        ui.progress = `Saving trainees… ${Math.round((n / (parts.length + 1)) * 100)}%`;
        render();
        await callAdminImportTrainingBackup({ part: "people", tablet });
        n++;
      }
      ui.progress = "Saving trainers and to-dos…";
      render();
      const { trainers, todos, fileDirty, lastSaved, lastLoaded, wbOld, wbData } = backup.tablet;
      return (await callAdminImportTrainingBackup({ part: "rest", tablet: { trainers, todos, fileDirty, lastSaved, lastLoaded, wbOld, wbData }, queue: backup.queue, wbConfig: backup.wbConfig })).data;
    }, saveBackup);
    if (r) { ui.pending = null; render(); toast(`Saved: ${names.length} trainees, ${r.trainers} trainers. Check the counts in Training.`); }
  }

  async function setTrainer(t, change, done) {
    if (await run(async () => callAdminSetTrainer({ id: t.id, ...change }), () => setTrainer(t, change, done))) toast(done);
  }
  function pinSheet(t) {
    const input = el("input", { class: "field", type: "password", inputmode: "numeric", autocomplete: "off", maxlength: "4", id: "f-tpin", "aria-label": "New 4-digit PIN" });
    const close = () => backdrop.remove();
    const save = () => {
      const v = input.value.trim();
      if (!/^\d{4}$/.test(v)) { input.focus(); return toast("The PIN must be 4 digits.", "error"); }
      close();
      setTrainer(t, { pin: v }, `New PIN set for ${t.name}. Tell them in person.`);
    };
    const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } },
      el("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": `New PIN for ${t.name}` },
        el("h2", {}, `New PIN for ${t.name}`),
        el("label", { class: "field-label", for: "f-tpin" }, "4-digit trainer PIN (not 1234, 0000, and the like)"),
        input,
        el("button", { class: "btn", type: "button", onclick: save }, "Set PIN"),
        el("button", { class: "btn secondary", type: "button", onclick: close }, "Cancel")));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    document.body.append(backdrop);
    input.focus();
  }

  function trainerRow(t) {
    return el("div", { class: "card" },
      el("strong", {}, t.name),
      el("p", { class: "card-note" }, [t.coordinator ? "Training & Safety Coordinator" : t.role || "Trainer", t.employee ? `Roster: ${t.employee}` : "Not linked to the roster"].join(" · ")),
      el("span", { class: "tags" },
        t.active === false ? el("span", { class: "tag off" }, "Off") : null,
        t.hasPin ? null : el("span", { class: "tag warn" }, "No PIN — can't unlock"),
        t.coordinator ? el("span", { class: "tag" }, "Coordinator") : null),
      el("div", { class: "btn-row" },
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => pinSheet(t) }, t.hasPin ? "Set a new PIN" : "Set PIN"),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => setTrainer(t, { coordinator: !t.coordinator }, t.coordinator ? `${t.name} is a trainer now` : `${t.name} is the coordinator now`) },
          t.coordinator ? "Remove coordinator" : "Make coordinator"),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => setTrainer(t, { active: t.active === false }, t.active === false ? `${t.name} turned on` : `${t.name} turned off`) },
          t.active === false ? "Turn on" : "Turn off")));
  }

  function render() {
    const ref = ui.ref;
    const trainers = (ui.trainers || []).slice().sort((a, b) => (b.coordinator === true) - (a.coordinator === true) || a.name.localeCompare(b.name));
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit, disabled: ui.busy }, "← Admin"),
      el("h1", {}, "Training setup"),
      el("p", { class: "hint" }, "The training team's trainer app (🎓 Training on Home). Its content lives in the database (signed-in people only), never in the app's code."),
      TEST_MODE ? el("p", { class: "message" }, "Test site: the old tablet's records and trainers go into a practice copy. The training data (modules, roster, SOP text) is shared with the live app, like the Shop map.") : null,
      banner(ui),
      ui.progress ? spinner(ui.progress) : null,

      el("h2", {}, "1. Training data"),
      ref === undefined ? spinner() : null,
      ref === null ? emptyState("Not loaded yet", "Load the original training app file in More → 📁 Documents & forms.") : null,
      ref ? el("div", { class: "card" }, el("strong", {}, `Loaded · data ${ref.rev || "—"}`), el("p", { class: "card-note" }, `${ref.importedAt?.toDate?.().toLocaleString() || ""}`)) : null,
      ref ? el("p", { class: "hint" }, "To load new training data: More → 📁 Documents & forms (every load is kept as a revision).") : null,

      el("h2", {}, "2. Records from the old tablet"),
      el("p", { class: "hint" }, `${ui.people ? ui.people.length : "…"} trainees have records in the app${TEST_MODE ? " (test copy)" : ""}.`),
      collapsible("training-backup-how", "How to get the backup file from the old tablet",
        el("ol", { class: "steps" },
          el("li", {}, "On the training tablet, open the old training app and let it sync."),
          el("li", {}, "Add the one-time “Save training backup” bookmark (instructions on the next page), then tap it while the old app is open."),
          el("li", {}, "It saves cdg-training-backup.json. It does not change anything on the old app."),
          el("li", {}, "Load that file below, check the counts, then save."),
          el("li", {}, "Delete the backup file afterwards — it holds the trainers' PINs.")),
        el("a", { class: "btn secondary", href: "training-backup.html" }, "Open the bookmark instructions")),
      ui.pending
        ? el("div", { class: "card" },
            el("strong", {}, "Backup file — check these against the old tablet"),
            ui.pending.savedAt ? el("p", { class: "card-note" }, `Saved on the tablet ${new Date(ui.pending.savedAt).toLocaleString()}`) : null,
            el("ul", { class: "count-list" }, ui.pending.counts.map(([k, v]) => el("li", {}, el("span", {}, k), el("strong", {}, String(v))))),
            el("button", { class: "btn", type: "button", disabled: ui.busy || !ref, onclick: saveBackup }, ref ? "Save to the app" : "Load the training data first (step 1)"),
            el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.pending = null; render(); } }, "Cancel"))
        : el("label", { class: "btn secondary file-btn" }, "⇪ Load the backup file (cdg-training-backup.json)",
            el("input", { type: "file", accept: ".json,application/json", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) pickBackup(f); } })),

      el("h2", {}, "3. Trainers"),
      el("p", { class: "hint" }, "Each trainer unlocks Training with their own 4-digit PIN. The coordinator countersigns Level 4 and runs the to-do list."),
      ui.trainers === null ? spinner("Loading trainers…") : null,
      ui.trainers && !trainers.length ? emptyState("No trainers yet", "They come over with the old tablet's backup (step 2), or anyone can tap “Add trainer” in Training.") : null,
      trainers.map(trainerRow),
    ].flat(3).filter(Boolean));
  }

  const stops = [
    onSnapshot(doc(db, "trainingRef", "data"), (s) => { ui.ref = s.exists() ? { rev: s.get("rev"), importedAt: s.get("importedAt") } : null; if (!ui.busy) render(); }, () => { ui.ref = null; render(); }),
    onSnapshot(col("trainingTrainers"), (s) => { ui.trainers = s.docs.map((d) => ({ id: d.id, ...d.data() })); if (!ui.busy) render(); }, (e) => { Object.assign(ui, { trainers: [], message: friendlyError(e), messageKind: "error" }); render(); }),
    onSnapshot(col("trainingPeople"), (s) => { ui.people = s.docs.map((d) => d.id); if (!ui.busy) render(); }, () => {}),
  ];
  render();
  return () => stops.forEach((x) => x());
}
