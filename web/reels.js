// Flagged Reels / QC Hold (Chris, 10-21-2026; SOP0012: failed reels stay tagged in QC Staging until next shift).
// 🏷 Flagged → in QC Staging (Floater) → ⚖️ decision (Line Lead / Quality / Supervisor, PIN) → ♻️ Reclamation closes
// regrind and scrap → ✓ Done. A reel with no decision turns red at the end of the next shift. Rules: functions/reels.js.

import { el, breakable, friendlyError, spinner, emptyState, banner, toast, picker } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { db, storage, TEST_MODE, callFlagReel, callStageReel, callDecideReel, callReclaimReel, callReelDeciders, callAdminSaveReelSettings } from "./firebase.js";
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { signOff } from "./signoff.js";
import { clock } from "./shift.js";

export const DECIDE_ROLES = ["lead", "quality", "supervisor"];
const WINDERS = ["Winder 1", "Winder 2", "Winder 3"];
const DECISIONS = [["release", "✅ Release"], ["rework", "🔁 Rewind / Rework"], ["regrind", "♻️ Regrind"], ["scrap", "🗑 Scrap"]];
const STARTING_REASONS = ["OD/wall out of spec", "Ovality", "Print missing or faded", "Surface (wood-grain, scuffing)", "Kinks or bends", "Wind or tension problem", "Contamination", "Short footage", "Other"];
const STARTING_SIZES = ["3/4\"", "1\"", "1.25\"", "1.5\"", "2\""];
const STARTING_SDRS = ["SDR 11", "SDR 13.5"];
const LINE_KEY = "cdg.reelLine";
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

export const canDecideReels = (roles) => roles.some((r) => DECIDE_ROLES.includes(r));
export function reelSettings() {
  const d = data.reelSettings || {};
  return {
    reasons: d.reasons || STARTING_REASONS.map((name) => ({ id: slug(name), name, active: true })),
    sizes: d.sizes || STARTING_SIZES,
    sdrs: d.sdrs || STARTING_SDRS,
  };
}

const plantDay = (ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(ms));
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmtDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const ft = (n) => `${Math.round(n).toLocaleString("en-US")} ft`;
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// Status words and icons (never color alone).
export function reelStatus(r, now = Date.now()) {
  if (r.status === "done") return { text: `✓ Done${r.decision ? ` · ${r.decision.label}` : ""}`, late: false };
  if (r.status === "reclaim") return { text: `♻️ To Reclamation · ${r.decision?.label || ""}`, late: false };
  const late = now > (r.dueMs || Infinity);
  const where = r.status === "staged" ? "🏷 In QC Staging" : "🏷 Flagged — move to QC Staging";
  return { text: `${late ? "⚠ " : ""}${where} · ⚖️ ${late ? "decision overdue" : `decide by ${clock(r.dueMs)}`}`, late };
}
const scrapFeet = (r) => (r.reclaim?.footage ?? r.footage ?? 0);
const isScrap = (r) => ["regrind", "scrap"].includes(r.decision?.kind);
const productText = (p) => [p?.size, p?.sdr, p?.color].filter(Boolean).join(" · ");

// ---- Home ----------------------------------------------------------------------------------------------------------

// Line Leads, Quality, Supervisors: reels waiting on a decision (red once past the end of the next shift).
// Operators (Floater, Reclamation): reels to move to QC Staging and to cut down.
export function reelItems(roles, onOpen) {
  const open = data.openReels;
  if (!open) return [];
  const items = [];
  if (canDecideReels(roles)) {
    const waiting = open.filter((r) => ["flagged", "staged"].includes(r.status));
    if (waiting.length) {
      const late = waiting.filter((r) => Date.now() > r.dueMs).length;
      const soonest = Math.min(...waiting.map((r) => r.dueMs || Infinity));
      items.push({ key: "reels-decide", icon: "⚖️", title: `Reels waiting for a decision: ${waiting.length}`, detail: late ? `${late} overdue — decide now` : `decide by ${clock(soonest)}`, state: late ? "late" : "due", onOpen });
    }
  }
  if (roles.includes("operator")) {
    const stage = open.filter((r) => r.status === "flagged").length;
    const cut = open.filter((r) => r.status === "reclaim").length;
    if (stage || cut) items.push({ key: "reels-floor", icon: "🏷", title: [stage && `${stage} reel${stage === 1 ? "" : "s"} to move to QC Staging`, cut && `${cut} to cut down at Reclamation`].filter(Boolean).join(" · "), detail: "QC hold", state: "due", onOpen });
  }
  return items;
}

// Home → At a glance cards (Quality: product on hold, scrap reasons this shift; Production Manager: scrap this week).
export function reelCard(id, onOpen) {
  const open = data.openReels;
  const recent = data.recentReels;
  if (id === "reels-hold") {
    if (!open) return null;
    const hold = open.filter((r) => ["flagged", "staged"].includes(r.status));
    // Not red here: an overdue decision is already a red item in Needs you.
    return { icon: "🏷", title: "Product on hold", num: hold.length, line: hold.length ? `${ft(hold.reduce((n, r) => n + (r.footage || 0), 0))} waiting for a decision` : "Nothing on hold", alert: false, onOpen };
  }
  if (id === "reels-shift") {
    if (!recent) return null;
    const since = Date.now() - 12 * 3600000;
    const counts = {};
    for (const r of recent.filter((x) => x.flaggedAtMs >= since)) counts[r.reasonName] = (counts[r.reasonName] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return { icon: "📋", title: "Scrap reasons this shift", num: top.reduce((n, [, c]) => n + c, 0), line: top.length ? top.slice(0, 3).map(([k, c]) => `${k} ${c}`).join(" · ") : "No reels flagged", alert: false, onOpen };
  }
  if (id === "reels-week") {
    if (!recent) return null;
    const { thisWeek, lastWeek } = weekBounds();
    const sum = (from, to) => recent.filter((r) => isScrap(r) && r.flaggedDate >= from && r.flaggedDate <= to).reduce((n, r) => n + scrapFeet(r), 0);
    const now = sum(thisWeek, plantDay());
    const last = sum(lastWeek, addDays(thisWeek, -1));
    const byLine = {};
    for (const r of recent.filter((x) => isScrap(x) && x.flaggedDate >= thisWeek)) (byLine[r.lineName] ||= {})[r.reasonName] = ((byLine[r.lineName] || {})[r.reasonName] || 0) + scrapFeet(r);
    const tops = Object.entries(byLine).map(([line, m]) => `${line}: ${Object.entries(m).sort((a, b) => b[1] - a[1])[0][0]}`);
    return { icon: "🗑", title: "Scrap + regrind this week", num: ft(now), line: `last week ${ft(last)}${tops.length ? ` · top: ${tops.join(" · ")}` : ""}`, alert: false, onOpen };
  }
  return null;
}

function weekBounds(day = plantDay()) {
  const dow = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const thisWeek = addDays(day, -dow);
  return { thisWeek, lastWeek: addDays(thisWeek, -7) };
}

function upload(file, emp, onProgress) {
  return new Promise((resolve, reject) => {
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    task.on("state_changed", (s) => onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)), reject, async () => resolve(await getDownloadURL(task.snapshot.ref)));
  });
}

// ---- the QC hold screen ----------------------------------------------------------------------------------------

export function openReels(container, { me, onExit, backLabel = "Home", start = "list" }) {
  const ui = { view: start, form: null, busy: false, upload: "", message: "", messageKind: "", retry: null, decide: null, reclaim: null, hist: null, filters: { days: 30, line: "", reason: "", decision: "", q: "" } };
  const decider = () => canDecideReels(me.roles);
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false, upload: "" }); render(); };
  const show = (view) => { Object.assign(ui, { view, message: "", retry: null }); render(); window.scrollTo(0, 0); };

  async function act(fn, retry, ok) {
    if (!navigator.onLine) { say(friendlyError({ code: "offline" }), retry); return null; }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const out = (await fn()).data;
      ui.busy = false;
      if (ok) toast(typeof ok === "function" ? ok(out) : ok);
      render();
      return out || true;
    } catch (err) { say(friendlyError(err), retry); return null; }
  }

  // ---- flag a reel ----

  function newForm() {
    const lines = (data.lines || []).filter((l) => l.active !== false);
    const keep = stored(LINE_KEY);
    return { lineId: lines.some((l) => l.id === keep) ? keep : lines[0]?.id || "", winder: "", tag: "", noTag: false, footage: "", reasonId: "", size: "", otherSize: "", sdr: "", color: "", photo: null, note: "" };
  }

  async function addPhoto(file) {
    if (!file.type.startsWith("image/")) return say("A photo only.");
    if (!navigator.onLine) return say(friendlyError({ code: "offline" }));
    Object.assign(ui, { busy: true, message: "" });
    try {
      ui.form.photo = await upload(file, me.emp, (p) => { ui.upload = `Uploading photo: ${p}%`; render(); });
      Object.assign(ui, { busy: false, upload: "" });
      render();
    } catch (err) { say(friendlyError(err)); }
  }

  async function submitFlag() {
    const f = ui.form;
    const size = f.size === "other" ? f.otherSize : f.size;
    const out = await act(() => callFlagReel({ lineId: f.lineId, winder: f.winder, tag: f.tag, noTag: f.noTag, footage: f.footage, reasonId: f.reasonId, product: { size, sdr: f.sdr, color: f.color }, photo: f.photo, note: f.note }), submitFlag, "🏷 Reel flagged — move it to QC Staging");
    if (out) { store(LINE_KEY, f.lineId); ui.form = null; show("list"); }
  }

  function flagForm() {
    const f = ui.form || (ui.form = newForm());
    const s = reelSettings();
    const chips = (list, value, set, labelOf = (x) => x) => el("div", { class: "chips" }, list.map((x) => {
      const v = typeof x === "object" ? x.id : x;
      return el("button", { class: value === v ? "chip on" : "chip", type: "button", "aria-pressed": String(value === v), onclick: () => { set(v); render(); } }, labelOf(x));
    }));
    const label = (t) => el("span", { class: "field-label strong" }, t);
    const fileInput = el("input", { type: "file", accept: "image/*", hidden: true, onchange: (e) => { const x = e.target.files[0]; e.target.value = ""; if (x) addPhoto(x); } });
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => { ui.form = null; show("list"); } }, "← QC hold"),
      el("h1", {}, "🏷 Flag a reel"),
      banner(ui),
      el("form", { class: "card reel-form", onsubmit: (e) => { e.preventDefault(); submitFlag(); } },
        label("Line"), chips((data.lines || []).filter((l) => l.active !== false), f.lineId, (v) => { f.lineId = v; }, (l) => l.name),
        label("Winder"), chips(WINDERS, f.winder, (v) => { f.winder = f.winder === v ? "" : v; }),
        label("Reel tag #"),
        el("div", { class: "reel-tag-row" },
          el("input", { class: "field", value: f.tag, maxlength: "30", disabled: f.noTag, placeholder: f.noTag ? "No tag yet" : "Tag #", autocomplete: "off", oninput: (e) => { f.tag = e.target.value; } }),
          el("button", { class: f.noTag ? "chip on" : "chip", type: "button", "aria-pressed": String(f.noTag), onclick: () => { f.noTag = !f.noTag; render(); } }, "No tag yet")),
        label("Footage"), el("input", { class: "field", type: "number", inputmode: "numeric", min: "0", value: f.footage, placeholder: "ft", oninput: (e) => { f.footage = e.target.value; } }),
        label("Reason"), chips(s.reasons.filter((r) => r.active !== false), f.reasonId, (v) => { f.reasonId = v; }, (r) => r.name),
        label("Size"), chips([...s.sizes, "other"], f.size, (v) => { f.size = v; }, (x) => (x === "other" ? "Other size…" : x)),
        f.size === "other" ? el("input", { class: "field", value: f.otherSize, maxlength: "30", placeholder: "Specialty size, e.g. 3\"", oninput: (e) => { f.otherSize = e.target.value; } }) : null,
        label("Wall"), chips(s.sdrs, f.sdr, (v) => { f.sdr = v; }),
        label("Color"), el("input", { class: "field", value: f.color, maxlength: "30", placeholder: "e.g. Orange", oninput: (e) => { f.color = e.target.value; } }),
        label("Photo (optional)"),
        f.photo ? el("img", { class: "reel-photo", src: f.photo, alt: "Reel photo" }) : null,
        fileInput,
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => fileInput.click() }, f.photo ? "📷 Replace photo" : "📷 Add photo"),
        ui.upload ? el("p", { class: "card-note", role: "status" }, ui.upload) : null,
        label("Note"), el("textarea", { class: "field", rows: "2", maxlength: "500", placeholder: "What you saw (required for Other)", oninput: (e) => { f.note = e.target.value; } }, f.note),
        el("button", { class: "btn big", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : "🏷 Flag this reel")),
    ];
  }

  // ---- reel card + actions ----

  async function stage(r) { await act(() => callStageReel({ id: r.id }), () => stage(r), "Moved to QC Staging"); }

  async function decide(r) {
    const d = ui.decide;
    if (!d.kind) return say("Pick a decision.");
    if (!d.note.trim()) return say("Add a note for the decision.");
    const out = await signOff({
      title: "Decision (PIN)", what: `${r.tag || "No tag"} · ${r.lineName} · ${DECISIONS.find((x) => x[0] === d.kind)[1]}`,
      me: decider() ? { emp: me.emp, name: me.name } : null,
      others: async () => (await callReelDeciders()).data.people,
      action: async ({ signer, device }) => (await callDecideReel({ id: r.id, kind: d.kind, note: d.note, signer, device })).data,
    });
    if (out) { ui.decide = null; toast(`Decided by ${out.name}${out.next === "reclaim" ? " — goes to Reclamation" : ""}${out.test ? " (test)" : ""}`); render(); }
  }

  async function reclaim(r) {
    const c = ui.reclaim;
    const out = await act(() => callReclaimReel({ id: r.id, footage: c.footage, segregation: c.segregation }), () => reclaim(r), "♻️ Closed — logged at Reclamation");
    if (out) { ui.reclaim = null; render(); }
  }

  function reelCard(r, { actions = true } = {}) {
    const st = reelStatus(r);
    const deciding = ui.decide?.id === r.id;
    const reclaiming = ui.reclaim?.id === r.id;
    return el("article", { class: st.late ? "reel late" : r.status === "done" ? "reel done" : "reel" },
      el("p", { class: "reel-status" }, st.text, r.test ? el("span", { class: "tag test" }, "TEST") : null),
      el("strong", { class: "reel-title" }, breakable(`${r.tag ? `Tag ${r.tag}` : "No tag yet"} · ${r.lineName}${r.winder ? ` · ${r.winder}` : ""}`)),
      el("span", { class: "person-meta" }, breakable([productText(r.product), r.footage != null ? ft(r.footage) : null, r.reasonName].filter(Boolean).join(" · "))),
      r.note ? el("p", { class: "reel-note" }, breakable(r.note)) : null,
      el("span", { class: "person-meta" }, `Flagged ${fmtWhen(r.flaggedAtMs)} by ${r.flagged?.byName || ""}${r.decision ? ` · ⚖️ ${r.decision.byName}: ${r.decision.note}` : ""}${r.reclaim ? ` · ♻️ ${ft(r.reclaim.footage)} → ${r.reclaim.segregation}` : ""}`),
      r.photo ? el("a", { href: r.photo, target: "_blank", rel: "noopener", class: "link-btn" }, "📷 Photo") : null,
      actions && r.status === "flagged" ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => stage(r) }, "📦 Moved to QC Staging") : null,
      actions && ["flagged", "staged"].includes(r.status) && !deciding ? el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => { ui.decide = { id: r.id, kind: "", note: "" }; render(); } }, "⚖️ Decide") : null,
      deciding ? el("div", { class: "reel-decide" },
        el("div", { class: "choices two" }, DECISIONS.map(([k, label]) => el("button", { class: ui.decide.kind === k ? (k === "scrap" ? "choice danger on" : "choice on") : "choice", type: "button", "aria-pressed": String(ui.decide.kind === k), onclick: () => { ui.decide.kind = k; render(); } }, label))),
        el("textarea", { class: "field", rows: "2", maxlength: "500", placeholder: "Note (required)", "aria-label": "Decision note", oninput: (e) => { ui.decide.note = e.target.value; } }, ui.decide.note),
        el("div", { class: "btn-row" },
          el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => decide(r) }, "Sign with PIN"),
          el("button", { class: "btn secondary", type: "button", onclick: () => { ui.decide = null; render(); } }, "Cancel")),
        el("p", { class: "card-note" }, "A Line Lead, Quality, or Supervisor signs with their PIN.")) : null,
      actions && r.status === "reclaim" && !reclaiming ? el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => { ui.reclaim = { id: r.id, footage: r.footage ?? "", segregation: "" }; render(); } }, "♻️ Close at Reclamation") : null,
      reclaiming ? el("div", { class: "reel-decide" },
        el("div", { class: "spec-fields" },
          el("label", { class: "spec-field" }, el("span", { class: "field-label" }, "Footage reclaimed"), el("input", { class: "field", type: "number", inputmode: "numeric", min: "0", value: ui.reclaim.footage, oninput: (e) => { ui.reclaim.footage = e.target.value; } })),
          el("label", { class: "spec-field" }, el("span", { class: "field-label" }, "Color / grade segregated to"), el("input", { class: "field", maxlength: "80", value: ui.reclaim.segregation, placeholder: "e.g. Orange regrind", oninput: (e) => { ui.reclaim.segregation = e.target.value; } }))),
        el("div", { class: "btn-row" },
          el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => reclaim(r) }, "Close reel"),
          el("button", { class: "btn secondary", type: "button", onclick: () => { ui.reclaim = null; render(); } }, "Cancel"))) : null);
  }

  // ---- list ----

  function list() {
    const open = data.openReels;
    const byDue = (a, b) => (a.dueMs || 0) - (b.dueMs || 0);
    const waiting = (open || []).filter((r) => ["flagged", "staged"].includes(r.status)).sort(byDue);
    const cut = (open || []).filter((r) => r.status === "reclaim").sort((a, b) => (a.decision?.atMs || 0) - (b.decision?.atMs || 0));
    const section = (title, rows, empty) => el("section", { class: "reel-col" }, el("h2", {}, `${title} · ${rows.length}`), rows.length ? el("div", { class: "reel-list" }, rows.map((r) => reelCard(r))) : el("p", { class: "card-note" }, empty));
    return [
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "🏷 QC hold"),
      el("p", { class: "hint" }, "Flagged reels stay tagged in QC Staging until a decision (SOP0012)."),
      banner(ui),
      el("div", { class: "btn-row" },
        el("button", { class: "btn big", type: "button", onclick: () => { ui.form = newForm(); show("flag"); } }, "🏷 Flag a reel"),
        el("button", { class: "btn secondary", type: "button", onclick: () => show("history") }, "📊 History & trends")),
      open === null ? spinner("Loading reels…") : el("div", { class: "reel-cols" },
        section("⚖️ Waiting for a decision", waiting, "No reels on hold."),
        section("♻️ To cut down at Reclamation", cut, "Nothing waiting at Reclamation.")),
    ];
  }

  // ---- history & trends ----

  async function loadHistory() {
    ui.hist = "loading";
    render();
    try {
      const since = addDays(plantDay(), -Math.max(ui.filters.days, 56));
      const reads = [getDocs(query(collection(db, "reels"), where("flaggedDate", ">=", since)))];
      if (TEST_MODE) reads.push(getDocs(query(collection(db, "test_reels"), where("flaggedDate", ">=", since))));
      const snaps = await Promise.all(reads);
      ui.hist = snaps.flatMap((s, i) => s.docs.map((d) => ({ id: d.id, ...d.data(), test: i === 1 }))).sort((a, b) => b.flaggedAtMs - a.flaggedAtMs);
    } catch (err) { ui.hist = { error: friendlyError(err) }; }
    render();
  }

  // Scrap + regrind footage, reasons × last 8 weeks, one hue (darker = more), the number in every cell.
  function trend(rows) {
    const { thisWeek } = weekBounds();
    const weeks = Array.from({ length: 8 }, (_, i) => addDays(thisWeek, -7 * (7 - i)));
    const weekOf = (day) => weeks.filter((w) => w <= day).pop();
    const grid = {};
    for (const r of rows.filter(isScrap)) {
      const w = weekOf(r.flaggedDate);
      if (!w) continue;
      ((grid[r.reasonName] ||= {})[w] = (grid[r.reasonName]?.[w] || 0) + scrapFeet(r));
    }
    const reasons = Object.keys(grid).sort((a, b) => Object.values(grid[b]).reduce((x, y) => x + y, 0) - Object.values(grid[a]).reduce((x, y) => x + y, 0));
    if (!reasons.length) return emptyState("No scrap or regrind in the last 8 weeks", ui.filters.line ? "For this line." : "");
    const max = Math.max(...reasons.flatMap((k) => Object.values(grid[k])));
    return el("div", { class: "trend-wrap" }, el("table", { class: "trend" },
      el("caption", {}, "Scrap + regrind footage by reason, by week (darker = more)"),
      el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Reason"), weeks.map((w) => el("th", { scope: "col" }, fmtDay(w))), el("th", { scope: "col" }, "Total"))),
      el("tbody", {}, reasons.map((k) => el("tr", {},
        el("th", { scope: "row" }, k),
        weeks.map((w) => {
          const v = grid[k][w] || 0;
          return el("td", { class: v ? "cell" : "cell zero", style: v ? `--heat:${Math.round(15 + 70 * (v / max))}%` : null, title: `${k}, week of ${fmtDay(w)}: ${ft(v)}` }, v ? Math.round(v).toLocaleString("en-US") : "·");
        }),
        el("td", { class: "total" }, Math.round(Object.values(grid[k]).reduce((x, y) => x + y, 0)).toLocaleString("en-US")))))));
  }

  function history() {
    if (ui.hist === null) { loadHistory(); }
    const f = ui.filters;
    const s = reelSettings();
    const all = Array.isArray(ui.hist) ? ui.hist : [];
    const since = addDays(plantDay(), -f.days);
    const q = f.q.trim().toLowerCase();
    const byLine = all.filter((r) => !f.line || r.lineId === f.line);
    const rows = byLine.filter((r) => r.flaggedDate >= since && (!f.reason || r.reasonId === f.reason) && (!f.decision || (f.decision === "none" ? !r.decision : r.decision?.kind === f.decision)) && (!q || (r.search || "").includes(q)));
    const lines = (data.lines || []).filter((l) => l.active !== false);
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => show("list") }, "← QC hold"),
      el("h1", {}, "📊 QC history & trends"),
      el("div", { class: "chips" }, [["", "All lines"], ...lines.map((l) => [l.id, l.name])].map(([v, n]) => el("button", { class: f.line === v ? "chip on" : "chip", type: "button", onclick: () => { f.line = v; render(); } }, n))),
      ui.hist === "loading" || ui.hist === null ? spinner("Loading history…") : ui.hist.error ? banner({ message: ui.hist.error, messageKind: "error", retry: loadHistory }) : [
        el("h2", {}, "Scrap + regrind by reason"),
        trend(byLine),
        el("h2", {}, "Search"),
        el("div", { class: "reel-filters" },
          picker({ title: "Dates", value: String(f.days), options: [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last 90 days"]].map(([value, label]) => ({ value, label })), onChange: (v) => { f.days = Number(v); if (Number(v) > 56) ui.hist = null; render(); } }),
          picker({ title: "Reason", value: f.reason, placeholder: "Any reason", options: [{ value: "", label: "Any reason" }, ...s.reasons.map((r) => ({ value: r.id, label: r.name }))], onChange: (v) => { f.reason = v; render(); } }),
          picker({ title: "Decision", value: f.decision, placeholder: "Any decision", options: [{ value: "", label: "Any decision" }, { value: "none", label: "No decision yet" }, ...DECISIONS.map(([value, label]) => ({ value, label }))], onChange: (v) => { f.decision = v; render(); } })),
        el("input", { class: "field search", type: "search", placeholder: "Tag #, size, color, or note", value: f.q, oninput: (e) => { f.q = e.target.value; const pos = e.target.selectionStart; render(); const x = container.querySelector(".field.search"); x.focus(); x.setSelectionRange(pos, pos); } }),
        el("p", { class: "card-note" }, `${rows.length} reel${rows.length === 1 ? "" : "s"} · ${ft(rows.reduce((n, r) => n + (r.footage || 0), 0))}`),
        rows.length ? el("div", { class: "reel-list" }, rows.slice(0, 200).map((r) => reelCard(r, { actions: false }))) : emptyState("No reels match", ""),
      ],
    ];
  }

  function render() {
    const view = ui.view === "flag" ? flagForm() : ui.view === "history" ? history() : list();
    container.replaceChildren(...[view].flat(4).filter(Boolean));
  }

  render();
  return onDataChange(() => { if (ui.view === "list" && !ui.decide && !ui.reclaim) render(); });
}

// ---- Admin → QC hold lists ------------------------------------------------------------------------------------

export function openReelAdmin(container, { onExit }) {
  const ui = { draft: null, busy: false, message: "", messageKind: "", retry: null };
  const draft = () => ui.draft || (ui.draft = (() => { const s = reelSettings(); return { reasons: s.reasons.map((r) => ({ ...r })), sizes: s.sizes.join("\n"), sdrs: s.sdrs.join("\n") }; })());

  async function save() {
    const d = draft();
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: save }); return render(); }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const lines = (t) => t.split("\n").map((x) => x.trim()).filter(Boolean);
      await callAdminSaveReelSettings({ reasons: d.reasons.filter((r) => r.name.trim()), sizes: lines(d.sizes), sdrs: lines(d.sdrs) });
      Object.assign(ui, { busy: false, draft: null });
      toast("QC hold lists saved");
      render();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: save });
      render();
    }
  }

  function render() {
    const d = draft();
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
      el("h1", {}, "🏷 QC hold lists"),
      el("p", { class: "hint" }, "What people pick on the Flag a reel screen. Turning a reason off hides it from new flags; old reels keep it."),
      banner(ui),
      el("form", { class: "card", onsubmit: (e) => { e.preventDefault(); save(); } },
        el("strong", {}, "Reasons"),
        el("div", { class: "reel-reasons" }, d.reasons.map((r) => el("div", { class: "reel-reason" },
          el("input", { class: "field", value: r.name, maxlength: "60", "aria-label": "Reason name", oninput: (e) => { r.name = e.target.value; } }),
          el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: r.active !== false, onchange: (e) => { r.active = e.target.checked; } }), el("span", {}, "On"))))),
        el("button", { class: "btn secondary", type: "button", onclick: () => { d.reasons.push({ name: "", active: true }); render(); } }, "+ Add reason"),
        el("div", { class: "spec-fields" },
          el("label", { class: "spec-field" }, el("span", { class: "field-label strong" }, "Sizes (one per line)"), el("textarea", { class: "field", rows: "6", oninput: (e) => { d.sizes = e.target.value; } }, d.sizes)),
          el("label", { class: "spec-field" }, el("span", { class: "field-label strong" }, "Walls / SDR (one per line)"), el("textarea", { class: "field", rows: "6", oninput: (e) => { d.sdrs = e.target.value; } }, d.sdrs))),
        el("p", { class: "card-note" }, "Specialty sizes don't need to be listed — people can type them on the flag screen."),
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : "Save")),
    ].filter(Boolean));
  }

  render();
  return onDataChange(() => { if (!ui.draft) render(); });
}
