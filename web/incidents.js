// Near-Miss & Incident Reports (Chris, 10-21-2026). Anyone reports in under 2 minutes (near misses can be anonymous);
// Training & Safety, the Plant Manager, and Admins follow up: 5 Whys, corrective actions with owners and due dates,
// 🆕 Reported → 🔍 Investigating → 🛠 Actions open → ✓ Closed (PIN). Reports are visible only to them (database
// rules); the reporter sees their own report's status. The app keeps the fields OSHA Forms 300/301 ask for so they
// can be exported later — it doesn't by itself make the company OSHA-compliant. Rules: functions/incidents.js.

import { el, breakable, friendlyError, spinner, emptyState, banner, toast, picker, confirmSheet } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { db, storage, TEST_MODE, callReportIncident, callMyIncidents, callSaveIncidentFollowUp, callAddIncidentAction, callCompleteIncidentAction, callCloseIncident, callMarkIncidentShared, callIncidentPeople, callAdminSaveRotation } from "./firebase.js";
import { collection, doc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { signOff } from "./signoff.js";

export const FOLLOW_ROLES = ["training-safety", "plant-manager", "admin"];
export const canFollowIncidents = (roles) => roles.some((r) => FOLLOW_ROLES.includes(r));
const TYPES = [["near-miss", "⚠ Near miss"], ["first-aid", "🩹 First aid"], ["injury", "🚑 Injury"], ["property", "🏚 Property damage"], ["spill", "🛢 Spill / environmental"]];
const TYPE_LABEL = Object.fromEntries(TYPES);
const STATUS = { reported: "🆕 Reported", investigating: "🔍 Investigating", actions: "🛠 Actions open", closed: "✓ Closed" };
const TREATMENTS = [["", "—"], ["first-aid-only", "First aid only"], ["medical-treatment", "Medical treatment beyond first aid"], ["emergency-room", "Emergency room"], ["hospitalized-overnight", "Hospitalized overnight"]];
const OUTCOMES = [["", "—"], ["not-recordable", "Not recordable"], ["other-recordable", "Other recordable case"], ["restricted", "Job transfer or restriction"], ["days-away", "Days away from work"], ["death", "Death"]];
const ANON_KEY = "cdg.anonIncidents";
const WHY_PROMPTS = ["Why did it happen?", "Why was that?", "Why was that?", "Why was that?", "Why was that? (often the root cause)"];

const stored = (k) => { try { return JSON.parse(localStorage.getItem(k) || "[]"); } catch { return []; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const plantNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const today = () => plantNow().slice(0, 10);
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const fmtDay = (day) => (day ? new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const monthName = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" });

function upload(file, emp, onProgress) {
  return new Promise((resolve, reject) => {
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    task.on("state_changed", (s) => onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)), reject, async () => resolve(await getDownloadURL(task.snapshot.ref)));
  });
}

// ---- Home ----------------------------------------------------------------------------------------------------------

// Follow-up (Training & Safety, Plant Manager, Admin): new reports. Owners: their corrective actions (gray with the
// due date, red on or after it).
export function incidentItems(roles, me, go) {
  const items = [];
  if (canFollowIncidents(roles) && data.openIncidents) {
    const fresh = data.openIncidents.filter((i) => i.status === "reported");
    if (fresh.length) {
      const hurt = fresh.filter((i) => ["injury", "first-aid"].includes(i.type)).length;
      items.push({ key: "incidents-new", icon: "🦺", title: `New safety reports: ${fresh.length}`, detail: hurt ? `${hurt} injury / first aid — review now` : "review today", state: hurt ? "late" : "due", onOpen: () => go("list") });
    }
  }
  const mine = (data.myIncidentActions || []).filter((a) => !a.done && a.ownerEmp === me.emp);
  for (const a of mine.sort((x, y) => x.due.localeCompare(y.due)).slice(0, 5)) {
    const late = a.due <= today();
    items.push({ key: `incident-action-${a.id}`, icon: "🛠", title: `Safety action: ${a.text}`, detail: late ? (a.due < today() ? `overdue — was due ${fmtDay(a.due)}` : "due today") : `due ${fmtDay(a.due)}`, state: late ? "late" : "due", onOpen: () => go("actions") });
  }
  return items;
}

// Home → At a glance (Training & Safety, Plant Manager).
export function incidentCard(id, onOpen) {
  if (id === "incidents-open") {
    if (!data.openIncidents) return null;
    const open = data.openIncidents;
    const actions = open.reduce((n, i) => n + (i.openActions || 0), 0);
    return { icon: "🦺", title: "Open safety reports", num: open.length, line: open.length ? `${actions} corrective action${actions === 1 ? "" : "s"} open` : "None open", alert: false, onOpen };
  }
  if (id === "incidents-month") {
    if (!data.recentIncidents) return null;
    const m = today().slice(0, 7);
    const list = data.recentIncidents.filter((i) => i.month === m);
    const nm = list.filter((i) => i.type === "near-miss").length;
    return { icon: "📈", title: "This month", num: list.length, line: `${nm} near miss${nm === 1 ? "" : "es"} · ${list.length - nm} incident${list.length - nm === 1 ? "" : "s"}`, alert: false, onOpen };
  }
  return null;
}

// ---- the screen ------------------------------------------------------------------------------------------------

export function openIncidents(container, { me, start = "home", startId = null, onExit, backLabel = "Home", onAnnounce = null }) {
  const ui = { view: startId ? "one" : start, id: startId, form: null, busy: false, upload: "", message: "", messageKind: "", retry: null, mine: null, people: null, one: null, stations: null };
  const follower = () => canFollowIncidents(me.roles);
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false, upload: "" }); render(); };
  const show = (view, extra = {}) => { Object.assign(ui, { view, message: "", retry: null, ...extra }); render(); window.scrollTo(0, 0); };
  const back = (label, fn) => el("button", { class: "link-btn", type: "button", onclick: fn }, `← ${label}`);

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

  // ---- report ----

  function loadStations() {
    if (ui.stations) return;
    ui.stations = "loading";
    getDocs(collection(db, "floorStations")).then((s) => { ui.stations = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false && x.label).sort((a, b) => a.label.localeCompare(b.label)); render(); }, () => { ui.stations = []; render(); });
  }

  const newForm = () => ({ type: "", occurredAt: plantNow(), lineId: "", stationId: "", label: "", what: "", immediate: "", photos: [], witnesses: "", anonymous: false, hurtName: "", bodyPart: "" });

  async function addPhoto(file) {
    if (!file.type.startsWith("image/")) return say("A photo only.");
    if (ui.form.photos.length >= 6) return say("Up to 6 photos.");
    if (!navigator.onLine) return say(friendlyError({ code: "offline" }));
    Object.assign(ui, { busy: true, message: "" });
    try {
      ui.form.photos.push(await upload(file, me.emp, (p) => { ui.upload = `Uploading photo: ${p}%`; render(); }));
      Object.assign(ui, { busy: false, upload: "" });
      render();
    } catch (err) { say(friendlyError(err)); }
  }

  async function submit() {
    const f = ui.form;
    const out = await act(() => callReportIncident({
      type: f.type, occurredAt: f.occurredAt, place: { lineId: f.lineId, stationId: f.stationId, label: f.label }, what: f.what, immediate: f.immediate,
      photos: f.photos, witnesses: f.witnesses, anonymous: f.anonymous, hurt: { name: f.hurtName, bodyPart: f.bodyPart },
    }), submit);
    if (!out) return;
    if (out.anonymous) store(ANON_KEY, [out.id, ...stored(ANON_KEY)].slice(0, 30));
    Object.assign(ui, { form: null, mine: null });
    toast(out.anonymous ? "Sent anonymously — thank you" : "Report sent — thank you");
    show("thanks", { sentAnon: out.anonymous });
  }

  function reportForm() {
    const f = ui.form || (ui.form = newForm());
    loadStations();
    const lines = (data.lines || []).filter((l) => l.active !== false);
    const label = (t) => el("span", { class: "field-label strong" }, t);
    const hurt = ["injury", "first-aid"].includes(f.type);
    const fileInput = el("input", { type: "file", accept: "image/*", hidden: true, onchange: (e) => { const x = e.target.files[0]; e.target.value = ""; if (x) addPhoto(x); } });
    return [
      back("Safety reports", () => { ui.form = null; show("home"); }),
      el("h1", {}, "🦺 Report a safety issue"),
      f.type === "injury" ? el("section", { class: "inc-911", role: "alert" },
        el("strong", {}, "Emergency? Call 911 first."),
        el("a", { class: "btn big danger", href: "tel:911" }, "🚑 Call 911"),
        el("p", {}, "Serious injuries have short OSHA reporting deadlines — notify the Plant Manager immediately.")) : null,
      banner(ui),
      el("form", { class: "card inc-form", onsubmit: (e) => { e.preventDefault(); submit(); } },
        label("What kind?"),
        el("div", { class: "chips" }, TYPES.map(([v, n]) => el("button", { class: f.type === v ? "chip on" : "chip", type: "button", "aria-pressed": String(f.type === v), onclick: () => { f.type = v; if (v !== "near-miss") f.anonymous = false; render(); } }, n))),
        label("When"), el("input", { class: "field", type: "datetime-local", value: f.occurredAt, max: plantNow(), oninput: (e) => { f.occurredAt = e.target.value; } }),
        label("Where"),
        el("div", { class: "chips" }, lines.map((l) => el("button", { class: f.lineId === l.id ? "chip on" : "chip", type: "button", onclick: () => { f.lineId = f.lineId === l.id ? "" : l.id; render(); } }, l.name))),
        Array.isArray(ui.stations) && ui.stations.length ? picker({ title: "Station (Shop Map)", value: f.stationId, placeholder: "Pick a station on the Shop Map (optional)", options: [{ value: "", label: "No station" }, ...ui.stations.map((s) => ({ value: s.id, label: s.label }))], onChange: (v) => { f.stationId = v; render(); } }) : null,
        el("input", { class: "field", value: f.label, maxlength: "80", placeholder: "Or type the spot (e.g. break room, dock 2)", oninput: (e) => { f.label = e.target.value; } }),
        hurt ? [label("Who was hurt?"), el("input", { class: "field", value: f.hurtName, maxlength: "80", oninput: (e) => { f.hurtName = e.target.value; } }),
          label("Body part (optional)"), el("input", { class: "field", value: f.bodyPart, maxlength: "80", placeholder: "e.g. left hand", oninput: (e) => { f.bodyPart = e.target.value; } }),
          el("p", { class: "card-note" }, "Only Training & Safety, the Plant Manager, and Admins see this report. Leave out medical details — they're added at follow-up only if needed.")] : null,
        label("What happened?"), el("textarea", { class: "field", rows: "3", maxlength: "2000", oninput: (e) => { f.what = e.target.value; } }, f.what),
        label("What was done right away?"), el("textarea", { class: "field", rows: "2", maxlength: "1000", placeholder: "e.g. stopped the line, cleaned up the spill", oninput: (e) => { f.immediate = e.target.value; } }, f.immediate),
        label("Witnesses (optional)"), el("input", { class: "field", value: f.witnesses, maxlength: "300", oninput: (e) => { f.witnesses = e.target.value; } }),
        label("Photos (optional)"),
        f.photos.length ? el("div", { class: "inc-photos" }, f.photos.map((u) => el("img", { src: u, alt: "Photo" }))) : null,
        fileInput,
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => fileInput.click() }, "📷 Add photo"),
        ui.upload ? el("p", { class: "card-note", role: "status" }, ui.upload) : null,
        f.type === "near-miss" ? el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: f.anonymous, onchange: (e) => { f.anonymous = e.target.checked; } }), el("span", {}, "Send anonymously (your name isn't saved)")) : null,
        el("button", { class: "btn big", type: "submit", disabled: ui.busy || !f.type }, ui.busy ? "Sending…" : "Send report")),
    ];
  }

  // ---- my reports ----

  async function loadMine() {
    ui.mine = "loading";
    render();
    try { ui.mine = (await callMyIncidents({ ids: stored(ANON_KEY) })).data.reports; } catch (err) { ui.mine = { error: friendlyError(err) }; }
    render();
  }

  function mineList() {
    if (ui.mine === null) loadMine();
    if (ui.mine === "loading" || ui.mine === null) return spinner("Loading your reports…");
    if (ui.mine.error) return banner({ message: ui.mine.error, messageKind: "error", retry: loadMine });
    if (!ui.mine.length) return el("p", { class: "card-note" }, "You haven't sent any reports from this account or device.");
    return el("div", { class: "person-list" }, ui.mine.map((r) => el("div", { class: "person-row static" },
      el("span", { class: "person-name" }, `${TYPE_LABEL[r.type]} · ${STATUS[r.status]}`),
      el("span", { class: "person-meta" }, [fmtWhen(r.occurredAt), r.placeName, r.anonymous ? "sent anonymously" : null].filter(Boolean).join(" · ")))));
  }

  // ---- home of the screen ----

  function homeView() {
    const open = data.openIncidents || [];
    return [
      back(backLabel, onExit),
      el("h1", {}, "🦺 Safety reports"),
      el("p", { class: "hint" }, "Near misses, first aid, injuries, property damage, spills. Reporting a near miss helps prevent the next injury."),
      banner(ui),
      el("button", { class: "btn big", type: "button", onclick: () => { ui.form = newForm(); show("report"); } }, "🦺 Report a near miss or incident"),
      (data.myIncidentActions || []).some((a) => !a.done && a.ownerEmp === me.emp) ? el("button", { class: "btn secondary", type: "button", onclick: () => show("actions") }, "🛠 My safety actions") : null,
      follower() ? el("section", { class: "inc-follow" },
        el("h2", {}, `Open reports · ${open.length}`),
        data.openIncidents === null ? spinner() : open.length ? el("div", { class: "person-list" }, open.map(reportRow)) : el("p", { class: "card-note" }, "Nothing open."),
        el("button", { class: "btn secondary", type: "button", onclick: () => show("trends") }, "📈 By month & closed reports")) : null,
      el("h2", {}, "My reports"),
      mineList(),
    ];
  }

  function reportRow(i) {
    const hurt = ["injury", "first-aid"].includes(i.type);
    return el("button", { class: hurt && i.status === "reported" ? "person-row urgent" : "person-row", type: "button", onclick: () => show("one", { id: i.id, one: null }) },
      el("span", { class: "person-name" }, `${TYPE_LABEL[i.type]} · ${STATUS[i.status]}${i.test ? " · TEST" : ""}`),
      el("span", { class: "person-meta" }, breakable([fmtWhen(i.occurredAt), i.placeName, i.what?.slice(0, 80)].filter(Boolean).join(" · "))));
  }

  // ---- one report (follow-up) ----

  async function loadOne() {
    ui.one = "loading";
    render();
    try {
      const pick = async (name) => { const s = await getDoc(doc(db, name, ui.id)); return s.exists() ? { id: s.id, ...s.data(), test: name.startsWith("test_") } : null; };
      const inc = (await pick("incidents")) || (TEST_MODE ? await pick("test_incidents") : null);
      if (!inc) { ui.one = { missing: true }; return render(); }
      const base = inc.test ? "test_incidents" : "incidents";
      const osha = ["injury", "first-aid"].includes(inc.type) ? ((await getDoc(doc(db, base, inc.id, "private", "osha"))).data() || {}) : null;
      const acts = await getDocs(query(collection(db, inc.test ? "test_incidentActions" : "incidentActions"), where("incidentId", "==", inc.id)));
      ui.one = { inc, osha, actions: acts.docs.map((d) => ({ id: d.id, ...d.data() })), whys: [...(inc.whys || []), "", "", "", "", ""].slice(0, 5), rootCause: inc.rootCause || "", newAction: { text: "", ownerEmp: "", due: "" } };
      if (!ui.people) callIncidentPeople().then((r) => { ui.people = r.data; render(); }, () => { ui.people = { owners: [], closers: [] }; render(); });
    } catch (err) { ui.one = { error: friendlyError(err) }; }
    render();
  }

  async function saveFollowUp(start = false) {
    const o = ui.one;
    const out = await act(() => callSaveIncidentFollowUp({ id: o.inc.id, whys: o.whys, rootCause: o.rootCause, start, ...(o.osha ? { osha: o.osha } : {}) }), () => saveFollowUp(start), "Saved");
    if (out) loadOne();
  }
  async function addAction() {
    const a = ui.one.newAction;
    const out = await act(() => callAddIncidentAction({ id: ui.one.inc.id, ...a }), addAction, `Action added — ${(ui.people?.owners || []).find((p) => p.id === a.ownerEmp)?.name || "the owner"} is notified`);
    if (out) loadOne();
  }
  async function doneAction(a) {
    const out = await act(() => callCompleteIncidentAction({ actionId: a.id, note: "" }), () => doneAction(a), "Action done");
    if (out && ui.view === "one") loadOne();
  }
  async function close() {
    const inc = ui.one.inc;
    const out = await signOff({
      title: "Close report (PIN)", what: `${TYPE_LABEL[inc.type]} · ${fmtWhen(inc.occurredAt)}`,
      me: follower() && me.roles.some((r) => ["training-safety", "plant-manager", "admin"].includes(r)) ? { emp: me.emp, name: me.name } : null,
      others: async () => ui.people?.closers || [],
      action: async ({ signer, device }) => (await callCloseIncident({ id: inc.id, signer, device })).data,
    });
    if (out) { toast(`Closed by ${out.name}${out.test ? " (test)" : ""}`); loadOne(); }
  }
  async function share() {
    const inc = ui.one.inc;
    if (!(await confirmSheet({ title: "Share as a lessons-learned announcement?", text: "The announcement form opens filled in from this near miss. Remove every name before posting.", confirmLabel: "Open the form" }))) return;
    onAnnounce?.({
      title: "Lessons learned: near miss",
      body: `What happened: ${inc.what}\n\nWhat was done: ${inc.immediate || "—"}${inc.rootCause ? `\n\nWhy it happened: ${inc.rootCause}` : ""}\n\nThank you to whoever reported this. Near misses help us prevent injuries.`,
    }, async (annId) => { await callMarkIncidentShared({ id: inc.id, annId }).catch(() => {}); });
  }

  function oneView() {
    if (ui.one === null) loadOne();
    const o = ui.one;
    const head = [back("Safety reports", () => show("home", { one: null }))];
    if (o === null || o === "loading") return [...head, spinner()];
    if (o.error) return [...head, banner({ message: o.error, messageKind: "error", retry: loadOne })];
    if (o.missing) return [...head, emptyState("Report not found", "")];
    const i = o.inc;
    const closed = i.status === "closed";
    const field = (label, input, wide = false) => el("label", { class: wide ? "spec-field wide" : "spec-field" }, el("span", { class: "field-label" }, label), input);
    const sel = (opts, value, set) => el("select", { class: "field", disabled: closed, onchange: (e) => set(e.target.value) }, opts.map(([v, n]) => el("option", { value: v, selected: value === v }, n)));
    const txt = (obj, k, max = 120) => el("input", { class: "field", value: obj[k] ?? "", maxlength: String(max), disabled: closed, oninput: (e) => { obj[k] = e.target.value; } });
    const openActs = o.actions.filter((a) => !a.done).length;
    return [
      ...head,
      el("h1", {}, `${TYPE_LABEL[i.type]}`),
      el("p", { class: "hint" }, `${STATUS[i.status]} · ${fmtWhen(i.occurredAt)} · ${i.placeName || ""}${i.test ? " · TEST" : ""}`),
      i.type === "injury" ? el("p", { class: "inc-osha-note" }, "Serious injuries have short OSHA reporting deadlines — notify the Plant Manager immediately.") : null,
      banner(ui),
      el("div", { class: "mach-cols" },
        el("div", { class: "mach-col" },
          el("section", { class: "card" },
            el("strong", {}, "What happened"), el("p", { class: "inc-text" }, breakable(i.what)),
            i.immediate ? [el("strong", {}, "Done right away"), el("p", { class: "inc-text" }, breakable(i.immediate))] : null,
            el("p", { class: "card-note" }, [i.anonymous ? "Sent anonymously" : `Reported by ${i.createdByName || ""}`, i.witnesses ? `Witnesses: ${i.witnesses}` : null].filter(Boolean).join(" · ")),
            i.photos?.length ? el("div", { class: "inc-photos" }, i.photos.map((u) => el("a", { href: u, target: "_blank", rel: "noopener" }, el("img", { src: u, alt: "Photo" })))) : null),
          el("section", { class: "card" },
            el("strong", {}, "Root cause — 5 Whys"),
            el("p", { class: "card-note" }, "Ask “why?” until you reach something you can fix."),
            o.whys.map((w, n) => field(`${n + 1}. ${WHY_PROMPTS[n]}`, el("input", { class: "field", value: w, maxlength: "500", disabled: closed, oninput: (e) => { o.whys[n] = e.target.value; } }), true)),
            field("Root cause", el("textarea", { class: "field", rows: "2", maxlength: "1000", disabled: closed, oninput: (e) => { o.rootCause = e.target.value; } }, o.rootCause), true),
            o.osha ? [
              el("strong", { class: "inc-sub" }, "OSHA 300 / 301 details"),
              el("p", { class: "card-note" }, "Kept for recordkeeping and export later. Only Training & Safety, the Plant Manager, and Admins can see these. Record only what's needed."),
              el("div", { class: "spec-fields" },
                field("Injured person", txt(o.osha, "injuredName", 80)), field("Employee #", txt(o.osha, "injuredEmp", 10)), field("Job title", txt(o.osha, "jobTitle", 60)),
                field("Date of hire", el("input", { class: "field", type: "date", value: o.osha.dateOfHire || "", disabled: closed, oninput: (e) => { o.osha.dateOfHire = e.target.value; } })),
                field("Time began work", el("input", { class: "field", type: "time", value: o.osha.timeBeganWork || "", disabled: closed, oninput: (e) => { o.osha.timeBeganWork = e.target.value; } })),
                field("Body part", txt(o.osha, "bodyPart", 80)), field("Injury or illness (e.g. cut, strain)", txt(o.osha, "nature", 120)),
                field("Object or substance", txt(o.osha, "objectOrSubstance", 200)),
                field("What they were doing", el("textarea", { class: "field", rows: "2", maxlength: "500", disabled: closed, oninput: (e) => { o.osha.activity = e.target.value; } }, o.osha.activity || ""), true),
                field("Treatment", sel(TREATMENTS, o.osha.treatment || "", (v) => { o.osha.treatment = v; })),
                field("Physician / provider", txt(o.osha, "physician", 120)), field("Facility", txt(o.osha, "facility", 160)),
                field("Outcome", sel(OUTCOMES, o.osha.outcome || "", (v) => { o.osha.outcome = v; })),
                field("Days away", el("input", { class: "field", type: "number", min: "0", value: o.osha.daysAway ?? "", disabled: closed, oninput: (e) => { o.osha.daysAway = e.target.value; } })),
                field("Days restricted / transferred", el("input", { class: "field", type: "number", min: "0", value: o.osha.daysRestricted ?? "", disabled: closed, oninput: (e) => { o.osha.daysRestricted = e.target.value; } }))),
              el("label", { class: "check-row" }, el("input", { type: "checkbox", checked: o.osha.privacyCase === true, disabled: closed, onchange: (e) => { o.osha.privacyCase = e.target.checked; } }), el("span", {}, "Privacy case (name left off the 300 log)")),
            ] : null,
            closed ? null : el("div", { class: "btn-row" },
              el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => saveFollowUp(false) }, "Save"),
              i.status === "reported" ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => saveFollowUp(true) }, "🔍 Start investigating") : null))),
        el("div", { class: "mach-col" },
          el("section", { class: "card" },
            el("strong", {}, `Corrective actions · ${openActs} open`),
            o.actions.length ? el("div", { class: "person-list" }, o.actions.map((a) => el("div", { class: a.done ? "person-row static" : a.due <= today() ? "person-row static urgent" : "person-row static" },
              el("span", { class: "person-name" }, `${a.done ? "✓ " : a.due <= today() ? "⚠ " : ""}${a.text}`),
              el("span", { class: "person-meta" }, `${a.ownerName} · ${a.done ? `done ${a.done.byName ? `by ${a.done.byName}` : ""}` : `due ${fmtDay(a.due)}`}`),
              !a.done && !closed ? el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => doneAction(a) }, "✓ Mark done") : null))) : el("p", { class: "card-note" }, "No actions yet."),
            closed ? null : el("div", { class: "spec-fields" },
              field("New action", el("input", { class: "field", value: o.newAction.text, maxlength: "300", placeholder: "What will be done", oninput: (e) => { o.newAction.text = e.target.value; } }), true),
              field("Owner", ui.people ? sel([["", "Pick…"], ...ui.people.owners.map((p) => [p.id, p.name])], o.newAction.ownerEmp, (v) => { o.newAction.ownerEmp = v; }) : spinner()),
              field("Due", el("input", { class: "field", type: "date", min: today(), value: o.newAction.due, oninput: (e) => { o.newAction.due = e.target.value; } }))),
            closed ? null : el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: addAction }, "+ Add action"),
            el("p", { class: "card-note" }, "Keep names and medical details out of the action text — the owner sees it.")),
          el("section", { class: "card" },
            el("strong", {}, "Close"),
            closed ? el("p", {}, `✓ Closed by ${i.closed?.byName || ""}`) : [
              el("p", { class: "card-note" }, openActs ? `Finish the ${openActs} open action${openActs === 1 ? "" : "s"} first.` : "Training & Safety or the Plant Manager signs with their PIN."),
              el("button", { class: "btn", type: "button", disabled: ui.busy || openActs > 0, onclick: close }, "✓ Close with PIN"),
            ]),
          i.type === "near-miss" && onAnnounce ? el("section", { class: "card" },
            el("strong", {}, "Lessons learned"),
            i.sharedAnnId ? el("p", {}, "📣 Shared as an announcement.") : [el("p", { class: "card-note" }, "Share what happened (no names) so everyone learns from it."), el("button", { class: "btn secondary", type: "button", onclick: share }, "📣 Share as lessons learned")]) : null)),
    ];
  }

  // ---- my actions (owner) ----

  function actionsView() {
    const mine = (data.myIncidentActions || []).filter((a) => a.ownerEmp === me.emp).sort((a, b) => (!!a.done - !!b.done) || a.due.localeCompare(b.due));
    return [
      back("Safety reports", () => show("home")),
      el("h1", {}, "🛠 My safety actions"),
      banner(ui),
      mine.length ? el("div", { class: "person-list" }, mine.map((a) => el("div", { class: !a.done && a.due <= today() ? "person-row static urgent" : "person-row static" },
        el("span", { class: "person-name" }, `${a.done ? "✓ " : a.due <= today() ? "⚠ " : ""}${a.text}`),
        el("span", { class: "person-meta" }, a.done ? "done" : `due ${fmtDay(a.due)}`),
        !a.done ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => doneAction(a) }, "✓ Done") : null))) : emptyState("No safety actions for you", ""),
    ];
  }

  // ---- by month (follow-up) ----

  let closedList = null;
  function trendsView() {
    const all = data.recentIncidents || [];
    const months = Array.from({ length: 12 }, (_, n) => { const d = new Date(`${today().slice(0, 7)}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - (11 - n)); return d.toISOString().slice(0, 7); });
    const count = (t, m) => all.filter((i) => i.type === t && i.month === m).length;
    const max = Math.max(1, ...TYPES.flatMap(([t]) => months.map((m) => count(t, m))));
    closedList = all.filter((i) => i.status === "closed").sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    return [
      back("Safety reports", () => show("home")),
      el("h1", {}, "📈 Safety reports by month"),
      data.recentIncidents === null ? spinner() : el("div", { class: "trend-wrap" }, el("table", { class: "trend" },
        el("caption", {}, "Reports by type, last 12 months (darker = more)"),
        el("thead", {}, el("tr", {}, el("th", { scope: "col" }, "Type"), months.map((m) => el("th", { scope: "col" }, monthName(m))), el("th", { scope: "col" }, "Total"))),
        el("tbody", {}, TYPES.map(([t, n]) => el("tr", {}, el("th", { scope: "row" }, n), months.map((m) => {
          const v = count(t, m);
          return el("td", { class: v ? "cell" : "cell zero", style: v ? `--heat:${Math.round(15 + 70 * (v / max))}%` : null, title: `${n}, ${monthName(m)}: ${v}` }, v || "·");
        }), el("td", { class: "total" }, String(months.reduce((x, m) => x + count(t, m), 0)))))))),
      el("h2", {}, `Closed · ${closedList.length}`),
      closedList.length ? el("div", { class: "person-list" }, closedList.slice(0, 100).map(reportRow)) : el("p", { class: "card-note" }, "None closed yet."),
    ];
  }

  function render() {
    const views = { report: reportForm, thanks: thanksView, one: oneView, actions: actionsView, trends: trendsView };
    container.replaceChildren(...[(views[ui.view] || homeView)()].flat(4).filter(Boolean));
  }
  function thanksView() {
    return [
      el("h1", {}, "✓ Thank you"),
      el("p", {}, ui.sentAnon ? "Your near miss was sent anonymously. You can follow its status from this device under My reports." : "Training & Safety and the Plant Manager have it. You can follow its status under My reports."),
      el("button", { class: "btn", type: "button", onclick: () => show("home") }, "Done"),
    ];
  }

  render();
  return onDataChange(() => { if (["home", "actions", "trends"].includes(ui.view)) render(); });
}

// ---- Admin → Shift rotation (which team works which days and shift) -------------------------------------------

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function openRotationAdmin(container, { onExit }) {
  const ui = { draft: null, busy: false, message: "", messageKind: "", retry: null };
  const shifts = () => (data.formTemplates || []).find((t) => t.id === "clean-shop")?.shifts || [];
  const teams = () => (data.teams || []).filter((t) => t.active !== false);
  const draft = () => ui.draft || (ui.draft = teams().map((t) => {
    const r = (data.rotation?.teams || []).find((x) => x.teamId === t.id);
    return { teamId: t.id, days: [...(r?.days || [])], shiftId: r?.shiftId || "" };
  }));

  async function save() {
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: save }); return render(); }
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      await callAdminSaveRotation({ teams: draft().filter((r) => r.shiftId && r.days.length) });
      Object.assign(ui, { busy: false, draft: null });
      toast("Shift rotation saved");
      render();
    } catch (err) {
      Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: save });
      render();
    }
  }

  function render() {
    if (!data.teams || !data.formTemplates || data.rotation === null) return container.replaceChildren(el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"), spinner());
    const d = draft();
    container.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Admin"),
      el("h1", {}, "🗓 Shift rotation"),
      el("p", { class: "hint" }, "Which team works which days and shift. Used to tell the Supervisor on shift (e.g. about safety reports). A night shift belongs to the day it starts."),
      banner(ui),
      !shifts().length ? emptyState("Shift times aren't set", "Set them on the Keep the Shop Clean form (Admin → Forms).") : el("form", { class: "card", onsubmit: (e) => { e.preventDefault(); save(); } },
        d.map((r) => el("div", { class: "rot-row" },
          el("strong", {}, `Team ${(data.teams || []).find((t) => t.id === r.teamId)?.name || r.teamId}`),
          el("div", { class: "chips" }, DAY_NAMES.map((n, i) => el("button", { class: r.days.includes(i) ? "chip on" : "chip", type: "button", "aria-pressed": String(r.days.includes(i)), onclick: () => { r.days = r.days.includes(i) ? r.days.filter((x) => x !== i) : [...r.days, i]; render(); } }, n))),
          el("div", { class: "chips" }, shifts().map((s) => el("button", { class: r.shiftId === s.id ? "chip on" : "chip", type: "button", onclick: () => { r.shiftId = s.id; render(); } }, `${s.name} ${s.start}–${s.end}`))))),
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : "Save")),
    ].filter(Boolean));
  }

  render();
  return onDataChange(() => { if (!ui.draft) render(); });
}
