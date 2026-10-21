// Trucks board — Logistics & Distribution (Chris, 10-21-2026). The manager posts the day's trucks; the yard checks
// each one off with one tap ("Arrived" / "Out the door"), with Undo for 5 minutes. Updates live on every device.
// No red/green here (an exception to the status color rule): plain words and icons — 🕒 Expected · 📥 Arrived ·
// 🚚 Out the door. Past days are kept and searchable. Rules match functions/trucks.js.

import { el, breakable, friendlyError, spinner, emptyState, banner, toast, confirmSheet } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { db, TEST_MODE, callSaveTruck, callRemoveTruck, callCopyTrucksFromDay, callCheckTruck, callUndoTruck } from "./firebase.js";
import { collection, onSnapshot, query, where, getDocs } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const POST_DEFAULT = ["shipping"];
const CHECK_ROLES = ["shipping"];
const VIEW_ROLES = ["shipping", "plant-manager", "sales", "admin"];
const UNDO_MS = 5 * 60000;
export const rolePostsTrucks = (r) => (typeof r.postTrucks === "boolean" ? r.postTrucks : POST_DEFAULT.includes(r.id));
export const canPostTrucks = (roles) => (data.roles || []).some((r) => r.active !== false && roles.includes(r.id) && rolePostsTrucks(r));
export const canCheckTrucks = (roles) => roles.some((r) => CHECK_ROLES.includes(r)) || canPostTrucks(roles);
export const canViewTrucks = (roles) => roles.some((r) => VIEW_ROLES.includes(r)) || canPostTrucks(roles);

const plantDay = (ms = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(ms));
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmtDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (hhmm) => (hhmm ? new Date(`2000-01-01T${hhmm}:00`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : 0);
const clockOf = (ms) => (ms ? new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");

// Expected first (by expected time, no time last), then finished ones at the bottom (in the order they finished).
const order = (a, b) => (a.status === "done") - (b.status === "done")
  || (a.status === "done" ? (a.doneAtMs || 0) - (b.doneAtMs || 0) : (a.time || "99:99").localeCompare(b.time || "99:99"));

// Live list of one day's trucks (test site: real + practice, practice marked TEST).
function watchDay(day, onList) {
  const parts = {};
  const merge = () => {
    if (!("real" in parts) || (TEST_MODE && !("test" in parts))) return;
    onList([...(parts.real || []), ...(parts.test || []).map((t) => ({ ...t, test: true }))].filter((t) => t.status !== "removed"));
  };
  const listen = (name, key) => onSnapshot(query(collection(db, name), where("date", "==", day)),
    (snap) => { parts[key] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); merge(); },
    (err) => { parts[key] = parts[key] || []; merge(); if (key === "real") onList(null, err); });
  const stops = [listen("trucks", "real")];
  if (TEST_MODE) stops.push(listen("test_trucks", "test"));
  return () => stops.forEach((s) => s());
}

export function openTrucks(container, { me, onExit, backLabel = "Home" }) {
  const ui = { view: "board", day: plantDay(), list: null, error: "", busy: false, form: null, message: "", messageKind: "", retry: null, search: "", hits: null, histDay: "" };
  const post = () => canPostTrucks(me.roles);
  const check = () => canCheckTrucks(me.roles);
  let stopDay = null;
  let tick = null;

  function follow(day) {
    stopDay?.();
    Object.assign(ui, { day, list: null, error: "" });
    stopDay = watchDay(day, (list, err) => {
      if (err) Object.assign(ui, { error: friendlyError(err) });
      else ui.list = list;
      if (!ui.form) render();
    });
  }

  async function act(fn, retry, okMessage) {
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry }); render(); return false; }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const out = (await fn()).data;
      ui.busy = false;
      if (okMessage) toast(typeof okMessage === "function" ? okMessage(out) : okMessage);
      render();
      return out || true;
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry });
      render();
      return false;
    }
  }

  const tap = (t) => act(() => callCheckTruck({ id: t.id, test: t.test === true }), () => tap(t), t.dir === "in" ? `📥 ${t.carrier} arrived` : `🚚 ${t.carrier} out the door`);
  const undo = (t) => act(() => callUndoTruck({ id: t.id, test: t.test === true }), () => undo(t), "Undone — back to Expected");

  // ---- one truck ----------------------------------------------------------------------------------------------

  function statusLine(t) {
    if (t.status === "done") return `${t.dir === "in" ? "📥 Arrived" : "🚚 Out the door"} ${clockOf(t.doneAtMs || toMs(t.doneAt))} · ${t.doneByName || ""}`;
    return `🕒 Expected${t.time ? ` ${fmtTime(t.time)}` : ""}`;
  }
  function what(t) {
    if (t.forKind === "material") return [t.material ? `Material: ${t.material}` : "Material delivery", t.ref ? `PO # ${t.ref}` : null].filter(Boolean).join(" · ");
    return `Load / order / PO # ${t.ref}`;
  }

  function truckCard(t, { readOnly = false } = {}) {
    const done = t.status === "done";
    const undoable = done && check() && !readOnly && Date.now() - (t.doneAtMs || 0) <= UNDO_MS;
    const minsLeft = undoable ? Math.max(1, Math.ceil((UNDO_MS - (Date.now() - t.doneAtMs)) / 60000)) : 0;
    return el("article", { class: done ? "truck done" : "truck" },
      el("p", { class: "truck-status" }, statusLine(t), t.test ? el("span", { class: "tag test" }, "TEST") : null),
      el("strong", { class: "truck-carrier" }, breakable(t.carrier)),
      el("span", { class: "person-meta" }, breakable(what(t))),
      t.notes ? el("p", { class: "truck-notes" }, breakable(t.notes)) : null,
      !done && check() && !readOnly
        ? el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: () => tap(t) }, t.dir === "in" ? "📥 Arrived" : "🚚 Out the door")
        : null,
      undoable ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => undo(t) }, `↶ Undo (${minsLeft} min left)`) : null,
      post() && !readOnly && !done ? el("button", { class: "link-btn", type: "button", onclick: () => openForm(t) }, "✎ Edit") : null);
  }

  // ---- board --------------------------------------------------------------------------------------------------

  function board() {
    const today = ui.day === plantDay();
    const list = ui.list || [];
    const col = (dir, title, icon) => {
      const rows = list.filter((t) => t.dir === dir).sort(order);
      const left = rows.filter((t) => t.status !== "done").length;
      return el("section", { class: "truck-col", "aria-label": title },
        el("h2", {}, `${icon} ${title} · ${left ? `${left} expected` : rows.length ? "all done" : "none"}`),
        rows.length ? el("div", { class: "truck-list" }, rows.map((t) => truckCard(t, { readOnly: !today }))) : el("p", { class: "card-note" }, today ? `No ${title.toLowerCase()} trucks posted for today.` : "None that day."));
    };
    const copy = async () => {
      const out = await act(() => callCopyTrucksFromDay({ date: ui.day }), copy, (o) => o.count ? `Copied ${o.count} truck${o.count === 1 ? "" : "s"} from ${fmtDay(o.fromDate)}` : `Nothing new to copy from ${fmtDay(o.fromDate)}`);
      return out;
    };
    return [
      el("button", { class: "link-btn", type: "button", onclick: today ? onExit : () => follow(plantDay()) }, today ? `← ${backLabel}` : "← Today"),
      el("h1", {}, `🚚 Trucks · ${today ? "Today" : fmtDay(ui.day)}`),
      el("p", { class: "hint" }, today ? fmtDay(ui.day) : "A past day — view only."),
      banner(ui),
      ui.error ? banner({ message: ui.error, messageKind: "error", retry: () => follow(ui.day) }) : null,
      today && post()
        ? el("div", { class: "btn-row" },
            el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => openForm(null) }, "+ Add a truck"),
            el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: copy }, "📋 Copy from yesterday"))
        : null,
      !post() && !check() ? el("p", { class: "hint" }, "View only. Logistics & Distribution posts and checks off the trucks.") : null,
      ui.list === null && !ui.error ? spinner("Loading trucks…") : el("div", { class: "truck-cols" }, col("in", "Inbound", "📥"), col("out", "Outbound", "🚚")),
      el("button", { class: "btn secondary", type: "button", onclick: () => { ui.view = "history"; render(); } }, "🕘 History — past days"),
    ];
  }

  // ---- add / edit ---------------------------------------------------------------------------------------------

  function openForm(t) {
    ui.form = t ? { ...t } : { dir: "in", carrier: "", time: "", forKind: "order", ref: "", material: "", notes: "" };
    Object.assign(ui, { message: "", retry: null });
    render();
    window.scrollTo(0, 0);
  }

  async function saveForm() {
    const f = ui.form;
    const out = await act(() => callSaveTruck({ ...f, date: ui.day, test: f.test === true }), saveForm, f.id ? "Truck updated" : `Truck added: ${f.carrier}`);
    if (out) { ui.form = null; render(); }
  }

  async function removeForm() {
    const f = ui.form;
    if (!(await confirmSheet({ title: `Take ${f.carrier} off the board?`, text: "It stays in the history as removed.", confirmLabel: "Take it off", danger: true }))) return;
    const out = await act(() => callRemoveTruck({ id: f.id, test: f.test === true }), removeForm, "Taken off the board");
    if (out) { ui.form = null; render(); }
  }

  function form() {
    const f = ui.form;
    const carriers = [...new Set((ui.list || []).map((t) => t.carrier))].sort();
    const field = (label, input) => el("label", { class: "spec-field" }, el("span", { class: "field-label" }, label), input);
    const set = (k) => (e) => { f[k] = e.target.value; };
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => { ui.form = null; render(); } }, "← Trucks"),
      el("h1", {}, f.id ? "✎ Edit truck" : "+ Add a truck"),
      banner(ui),
      el("form", { class: "card truck-form", onsubmit: (e) => { e.preventDefault(); saveForm(); } },
        el("div", { class: "choices two" },
          el("button", { class: f.dir === "in" ? "choice on" : "choice", type: "button", "aria-pressed": String(f.dir === "in"), onclick: () => { f.dir = "in"; render(); } }, "📥 Inbound"),
          el("button", { class: f.dir === "out" ? "choice on" : "choice", type: "button", "aria-pressed": String(f.dir === "out"), onclick: () => { f.dir = "out"; render(); } }, "🚚 Outbound")),
        el("div", { class: "spec-fields" },
          field("Carrier", el("input", { class: "field", value: f.carrier, maxlength: "60", list: "truck-carriers", required: true, autocomplete: "off", oninput: set("carrier") })),
          field("Expected time", el("input", { class: "field", type: "time", value: f.time, oninput: set("time") }))),
        el("datalist", { id: "truck-carriers" }, carriers.map((c) => el("option", { value: c }))),
        el("span", { class: "field-label" }, "What it's for"),
        el("div", { class: "choices two" },
          el("button", { class: f.forKind === "order" ? "choice on" : "choice", type: "button", "aria-pressed": String(f.forKind === "order"), onclick: () => { f.forKind = "order"; render(); } }, "Load / order / PO #"),
          el("button", { class: f.forKind === "material" ? "choice on" : "choice", type: "button", "aria-pressed": String(f.forKind === "material"), onclick: () => { f.forKind = "material"; render(); } }, "Material delivery")),
        el("div", { class: "spec-fields" },
          f.forKind === "material" ? field("Material (e.g. resin)", el("input", { class: "field", value: f.material, maxlength: "80", oninput: set("material") })) : null,
          field(f.forKind === "material" ? "PO # (optional)" : "Load / order / PO #", el("input", { class: "field", value: f.ref, maxlength: "60", oninput: set("ref") }))),
        field("Notes", el("textarea", { class: "field", rows: "2", maxlength: "500", oninput: set("notes") }, f.notes || "")),
        el("div", { class: "btn-row" },
          el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : f.id ? "Save" : "Add truck"),
          el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.form = null; render(); } }, "Cancel")),
        f.id ? el("button", { class: "link-btn danger-link", type: "button", disabled: ui.busy, onclick: removeForm }, "Take this truck off the board") : null),
    ];
  }

  // ---- history ------------------------------------------------------------------------------------------------

  // Search: the last 180 days, by carrier, order / PO #, material, or notes. Any single day: pick its date.
  async function runSearch() {
    const q = ui.search.trim().toLowerCase();
    if (q.length < 2) { ui.hits = null; return render(); }
    ui.hits = "loading";
    render();
    try {
      const since = addDays(plantDay(), -180);
      const reads = [getDocs(query(collection(db, "trucks"), where("date", ">=", since)))];
      if (TEST_MODE) reads.push(getDocs(query(collection(db, "test_trucks"), where("date", ">=", since))));
      const snaps = await Promise.all(reads);
      ui.hits = snaps.flatMap((s, i) => s.docs.map((d) => ({ id: d.id, ...d.data(), test: i === 1 })))
        .filter((t) => t.status !== "removed" && (t.search || "").includes(q))
        .sort((a, b) => b.date.localeCompare(a.date) || order(a, b));
    } catch (err) { ui.hits = { error: friendlyError(err) }; }
    render();
  }

  function history() {
    let timer = null;
    const hits = ui.hits;
    const byDay = Array.isArray(hits) ? [...new Set(hits.map((t) => t.date))] : [];
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => { ui.view = "board"; render(); } }, "← Trucks"),
      el("h1", {}, "🕘 Truck history"),
      el("div", { class: "spec-fields" },
        el("label", { class: "spec-field" }, el("span", { class: "field-label" }, "Open a day"),
          el("input", { class: "field", type: "date", max: plantDay(), value: ui.histDay, onchange: (e) => { ui.histDay = e.target.value; if (e.target.value) { ui.view = "board"; follow(e.target.value); } } })),
        el("label", { class: "spec-field" }, el("span", { class: "field-label" }, "Search carrier, order / PO #, or material"),
          el("input", { class: "field search", type: "search", value: ui.search, placeholder: "e.g. ABC Freight or 45120",
            oninput: (e) => { ui.search = e.target.value; clearTimeout(timer); timer = setTimeout(runSearch, 400); } }))),
      hits === "loading" ? spinner("Searching…") : null,
      hits?.error ? banner({ message: hits.error, messageKind: "error", retry: runSearch }) : null,
      Array.isArray(hits) && !hits.length ? emptyState("Nothing found", "Searches the last 180 days. For an older day, pick its date above.") : null,
      byDay.map((day) => [el("h2", {}, fmtDay(day)), el("div", { class: "truck-list" }, hits.filter((t) => t.date === day).map((t) => truckCard(t, { readOnly: true })))]),
    ];
  }

  function render() {
    const focus = document.activeElement?.classList.contains("search") ? document.activeElement.selectionStart : null;
    const view = ui.form ? form() : ui.view === "history" ? history() : board();
    container.replaceChildren(...[view].flat(4).filter(Boolean));
    if (focus !== null) { const f = container.querySelector(".field.search"); if (f) { f.focus(); f.setSelectionRange(focus, focus); } }
  }

  follow(ui.day);
  render();
  // Undo buttons count down and disappear after 5 minutes; a new day starts at midnight plant time.
  tick = setInterval(() => {
    if (ui.form || ui.view !== "board") return;
    if (ui.day !== plantDay() && ui.day === addDays(plantDay(), -1)) follow(plantDay());
    if ((ui.list || []).some((t) => t.status === "done" && Date.now() - (t.doneAtMs || 0) <= UNDO_MS + 60000)) render();
  }, 30000);
  const stopData = onDataChange(() => { if (!ui.form && ui.view === "board") render(); });
  return () => { stopDay?.(); clearInterval(tick); stopData(); };
}
