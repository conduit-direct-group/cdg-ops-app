// CDG Operations — login, change-PIN, and (placeholder) home screens.
//
// Flow:
//   1. Employee number  →  2. PIN (sends as soon as 6 digits are in)
//   3. If on a temporary PIN: pick your own (type it twice)
//   4. Home. Personal phones stay signed in until "Sign out".
//
// Line tablets (shared, one per line): an admin marks the device once from the home screen.
// On a line tablet, 5 minutes with no taps signs the person out (and clears any half-typed
// number or PIN), so the next person never acts as the last one.

import { auth, callPinLogin, callChangePin, TEST_MODE } from "./firebase.js";
import { signInWithCustomToken, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { el, friendlyError, spinner, emptyState, toast, watchConnection } from "./ui.js";
import { openAdmin } from "./admin.js";
import { openLines, openRoles, openTeams, openMachineTypes } from "./setup.js";
import { openFixLibrary } from "./fixlib.js";
import { startData, stopData, data, onDataChange, lineName } from "./data.js";
import { openIssueBoard, openReportForm } from "./issues.js";
import { openChecklist, openChecklistAdmin, checklistUnits, unitStatus, statusTag as checklistTag } from "./checklists.js";
import { openActivity } from "./activity.js";
import { openShopMap } from "./shopmap.js";
import { openMapAdmin } from "./mapadmin.js";
import { openTrainingAdmin } from "./trainingadmin.js";
import { openNeedSomething, openRequest, openRequestTypesAdmin } from "./requests.js";
import { pushState, turnOnPush, turnOffPush, refreshPush } from "./push.js";
import { dashboard, stopDashboard, usesMachines } from "./dashboard.js";
import { openAnnouncements, toSign as announcementsToSign, noticeNewAnnouncements } from "./announcements.js";
import { openHandoff, usesHandoffs } from "./handoff.js";
import { openFormsAdmin, editableForms } from "./forms.js";
import { openShopTasks, runsShopList } from "./shoptasks.js";
import { openStations, stationForms } from "./stations.js";
import { openLineCheck } from "./linecheck.js";
import { openRefDocs } from "./refdocs.js";
import { openMachines, canViewMachines } from "./machines.js";
import { openTestReset } from "./testdata.js";
import { openTrucks, canViewTrucks, canCheckTrucks } from "./trucks.js";
import { openReels, openReelAdmin } from "./reels.js";
import { startOutbox } from "./outbox.js";
import { openDowntime, usesDowntime } from "./downtime.js";
import { openCrew, openCrewStationsAdmin, usesCrewBoard } from "./crew.js";
import { openDepartmentsAdmin, openProfile } from "./departments.js";
import { openWhoToCall, openCallAdmin, lineDownReminder } from "./whotocall.js";
import { openIncidents, openRotationAdmin, openInjuryExport, openHrAccess } from "./incidents.js";
import { openWriteups, canWriteUps } from "./writeups.js";
import { openSilos, openSiloAdmin, UPDATE_ROLES as SILO_UPDATE_ROLES, ALERT_ROLES as SILO_ALERT_ROLES } from "./silos.js";

const screen = document.getElementById("screen");
const deviceBadge = document.getElementById("device-badge");
watchConnection(document.getElementById("offline-banner"));
startOutbox(document.getElementById("outbox-btn"));

// Test site: a solid orange bar on every screen, so nobody mistakes it for the real app.
document.getElementById("test-banner").hidden = !TEST_MODE;

const IDLE_LIMIT_MS = 5 * 60 * 1000;
const LINE_TABLET_KEY = "cdg.lineTablet";
const LAST_ACTIVITY_KEY = "cdg.lastActivity";

const state = {
  step: "loading", // employee | pin | currentPin | newPin | confirmPin | home | admin
  employeeNumber: "",
  typed: "",
  knownPin: "", // the PIN just used to log in, kept in memory only so a temp PIN can be swapped without retyping
  newPin: "",
  message: "",
  messageKind: "",
  busy: false,
  user: null,
  claims: {},
  idleSignOut: false, // true while signing out because of the idle timer, to explain why
};

// ---------------------------------------------------------------------------
// Line tablet setting and idle sign-out
// ---------------------------------------------------------------------------

// Device storage can be blocked (private browsing); the app still works, just without these extras.
function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

// The line a line tablet is on: the line its Line Check Log last used.
function lineTabletLine() {
  return stored("cdg.lineCheckLine") || null;
}

function isLineTablet() {
  return stored(LINE_TABLET_KEY) === "yes";
}

// Saved as a clock time (not a countdown) so it still works after the tablet sleeps or the page reloads.
function noteActivity() {
  store(LAST_ACTIVITY_KEY, String(Date.now()));
}

function idleTooLong() {
  const last = Number(stored(LAST_ACTIVITY_KEY) || 0);
  return last > 0 && Date.now() - last >= IDLE_LIMIT_MS;
}

function checkIdle() {
  if (!isLineTablet() || state.step === "loading" || state.busy || !idleTooLong()) return;
  noteActivity();
  if (state.user) {
    state.idleSignOut = true;
    signOutNow();
  } else if (state.step !== "employee" || state.typed) {
    state.employeeNumber = "";
    go("employee", "Cleared after 5 minutes of no use.", "ok");
  }
}

for (const type of ["pointerdown", "keydown"]) {
  document.addEventListener(type, noteActivity, { capture: true, passive: true });
}
setInterval(checkIdle, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkIdle();
});

function toggleLineTablet() {
  store(LINE_TABLET_KEY, isLineTablet() ? null : "yes");
  noteActivity();
  render();
  toast(isLineTablet() ? "This device is now a line tablet" : "This device is now a personal device");
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

let closeModule = null; // set while an admin screen from admin.js / setup.js is open

function go(step, message = "", messageKind = "") {
  if (closeModule) {
    closeModule();
    closeModule = null;
  }
  Object.assign(state, { step, typed: "", message, messageKind });
  if (step === "home") state.nav = "home";
  else if (step === "adminMenu") state.nav = "more";
  render();
  window.scrollTo(0, 0);
}

function showError(message) {
  Object.assign(state, { typed: "", message, messageKind: "error", busy: false });
  render();
}

// ---------------------------------------------------------------------------
// Number pad screen (used for employee number and every PIN step)
// ---------------------------------------------------------------------------

const PIN_STEPS = {
  pin: { title: "Enter your PIN", hint: "6 digits" },
  currentPin: { title: "Enter your temporary PIN", hint: "The PIN your admin gave you" },
  newPin: { title: "Pick your own PIN", hint: "6 digits only you know. Not 111111 or 123456." },
  confirmPin: { title: "Type it again", hint: "Same 6 digits, to be sure" },
};

function maxLength() {
  return state.step === "employee" ? 12 : 6;
}

function press(digit) {
  if (state.busy || state.typed.length >= maxLength()) return;
  state.typed += digit;
  if (state.messageKind === "error") state.message = state.messageKind = "";
  render();
  if (state.step !== "employee" && state.typed.length === 6) submit();
}

function backspace() {
  if (state.busy) return;
  state.typed = state.typed.slice(0, -1);
  render();
}

function keypad() {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) =>
    el("button", { class: "key", type: "button", onclick: () => press(d), disabled: state.busy }, d)
  );
  let back;
  if (state.step === "employee") {
    back = el("button", { class: "key small", type: "button", onclick: backspace, disabled: state.busy, "aria-label": "Delete" }, "⌫ Delete");
  } else if (state.step === "pin") {
    back = el("button", { class: "key small", type: "button", onclick: () => go("employee"), disabled: state.busy }, "← Back");
  } else {
    // Mid-way through picking a PIN: already signed in, so "back" means sign out and start over.
    back = el("button", { class: "key small", type: "button", onclick: () => signOut(auth), disabled: state.busy }, "Start over");
  }
  const zero = el("button", { class: "key", type: "button", onclick: () => press("0"), disabled: state.busy }, "0");
  const right =
    state.step === "employee"
      ? el("button", { class: "key small", type: "button", onclick: () => { state.typed = ""; render(); }, disabled: state.busy }, "Clear")
      : el("button", { class: "key small", type: "button", onclick: backspace, disabled: state.busy, "aria-label": "Delete" }, "⌫ Delete");
  return el("div", { class: "keypad" }, keys, back, zero, right);
}

// Sign-in screens: errors and notes in a banner (the keypad is the "try again").
function messageBox() {
  return state.message
    ? el("p", { class: `message ${state.messageKind}`, role: state.messageKind === "error" ? "alert" : null }, state.message)
    : null;
}

function renderEmployee() {
  const entry = state.typed
    ? el("div", { class: "entry" }, state.typed)
    : el("div", { class: "entry placeholder" }, "Employee number");
  return [
    el("h1", {}, "Sign in"),
    el("p", { class: "hint" }, "Enter your employee number"),
    entry,
    messageBox(),
    keypad(),
    el("button", { class: "btn", type: "button", onclick: submit, disabled: state.busy || !state.typed }, "Next"),
  ];
}

function renderPinStep() {
  const { title, hint } = PIN_STEPS[state.step];
  const dots = el(
    "div",
    { class: "dots", "aria-label": `${state.typed.length} of 6 digits entered` },
    Array.from({ length: 6 }, (_, i) => el("span", { class: i < state.typed.length ? "dot filled" : "dot" }))
  );
  // On the PIN step, make it obvious whose PIN this is, with a quick way out if it isn't yours.
  const who =
    state.step === "pin"
      ? el(
          "div",
          { class: "who" },
          el("span", {}, "Employee ", el("strong", {}, state.employeeNumber)),
          el("button", { class: "link-btn", type: "button", onclick: () => go("employee"), disabled: state.busy }, "Not you?")
        )
      : el("p", { class: "hint" }, hint);
  return [
    el("h1", {}, title),
    who,
    el("div", { class: "entry" }, dots),
    messageBox(),
    state.busy ? el("p", { class: "hint" }, "Checking…") : null,
    keypad(),
  ];
}

function renderHome() {
  const name = state.user?.displayName || "there";
  const m = me();
  // Role names from the Roles list ("Line Lead"), not internal ids ("lead").
  const roleNames = new Map((data.roles || []).map((r) => [r.id, r.name]));
  const roles = (data.myself?.roles || state.claims.roles || []).map((r) => roleNames.get(r) || r).join(", ");
  // Home (Decision 66): name + line status · Needs you · quick buttons · at a glance. Everything else is in the
  // navigation bar (Home · Map · Checklists · Announcements · More).
  const p = dashboard({
    emp: m.emp, roles: m.roles, admin: m.admin, viewAs: m.admin ? state.viewAs : null,
    setViewAs: (v) => { state.viewAs = v; render(); renderNav(); },
    onRedraw: () => { if (state.step === "home") render(); },
    go: {
      checklist: (id) => openChecklistScreen(id, () => go("home")),
      checklists: () => openChecklistsHub(),
      request: (id) => openRequestScreen(id),
      issues: () => openIssues(),
      training: () => { location.href = "training.html"; },
      people: () => openModule(openAdmin),
      map: () => openMap(),
      need: () => openNeed(),
      report: () => openReport(),
      announcement: (id) => openAnn(id),
      announcements: () => openAnn(),
      handoff: (id) => openHandoffScreen(id),
      shop: (id) => openShopScreen(id),
      station: (formId) => openStationScreen(formId),
      lineCheck: (lineId, logId) => openLineCheckScreen(lineId, logId),
      silos: () => openSiloScreen(),
      reels: (view) => openReelScreen(view),
      downtime: () => openDowntimeScreen(),
      crew: () => openCrewScreen(),
      incidents: (view, id) => openIncidentScreen(view, id),
    },
  });
  return [
    el("section", { class: "home-head" },
      el("div", { class: "home-hello" },
        el("h1", {}, `Hi, ${name}`),
        roles ? el("p", { class: "roles" }, `Employee ${state.claims.emp} · ${roles}`) : null),
      p.annBar,
      p.viewAs,
      p.status),
    // Line tablets: a line down an hour with nobody tapping Call Maintenance (this tablet's line when it has one).
    isLineTablet() ? lineDownReminder(lineTabletLine()) : null,
    m.admin && state.viewAs ? el("p", { class: "view-note" }, `👁 Viewing as ${roleNames.get(state.viewAs) || state.viewAs} — lists show your own account's data.`) : null,
    messageBox(),
    el("div", { class: p.cards ? "home-grid" : "home-grid no-side-cards" },
      p.needs,
      el("div", { class: "home-side" }, p.quick, p.cards)),
  ];
}

// ---------------------------------------------------------------------------
// Navigation bar (Decision 66): always visible once signed in — a bottom bar on phones and tablets, a side bar on
// desktops. Home · Map · Checklists (people who work with the machines) · Machines (Maintenance, Production Manager, Admin)
// · Trucks (Logistics & Distribution; view-only roles find it in More) · Announcements · More.
// ---------------------------------------------------------------------------

const nav = document.getElementById("app-nav");
// 📞 Who to Call, in the top bar on every screen once signed in.
const callBtn = document.getElementById("call-btn");
callBtn.addEventListener("click", () => openCallScreen());
function setNav(key) {
  state.nav = key;
  renderNav();
}
// What the bar and the More menu show follow the roles (or the role an admin is viewing as).
const shownRoles = () => (me().admin && state.viewAs ? [state.viewAs] : me().roles);
function renderNav() {
  const on = !!state.user && !NARROW_STEPS.includes(state.step) && state.claims.pinTemp !== true;
  nav.hidden = !on;
  callBtn.hidden = !on;
  document.body.classList.toggle("has-nav", on);
  if (!on) return;
  const unsigned = data.announcements && data.mySigs ? announcementsToSign(state.claims.emp).length : 0;
  const item = (key, icon, label, onclick, badge = 0) =>
    el("button", { class: state.nav === key ? "nav-btn on" : "nav-btn", type: "button", onclick, "aria-current": state.nav === key ? "page" : null },
      el("span", { class: "nav-icon", "aria-hidden": "true" }, icon),
      el("span", { class: "nav-label" }, label),
      badge ? el("span", { class: "nav-badge", "aria-label": `${badge} to sign` }, String(badge)) : null);
  nav.replaceChildren(...[
    el("span", { class: "nav-brand" }, "CDG Ops"),
    item("home", "🏠", "Home", () => go("home")),
    item("map", "🗺", "Map", () => openMap()),
    usesMachines(shownRoles()) ? item("checklists", "📋", "Checklists", () => openChecklistsHub()) : null,
    canViewMachines(shownRoles()) ? item("machines", "⚙", "Machines", () => openMachineScreen()) : null,
    canCheckTrucks(shownRoles()) ? item("trucks", "🚚", "Trucks", () => openTrucksScreen()) : null,
    shownRoles().includes("quality") ? item("qc", "🏷", "QC hold", () => openReelScreen()) : null,
    item("ann", "📣", "Announce\u00adments" /* soft hyphen: wraps as Announce-ments on phones */, () => openAnn(), unsigned),
    item("more", "☰", "More", openMore),
  ].filter(Boolean));
}

// More: everything that isn't on Home or the bar, only for the roles that have it.
function openMore() {
  const roles = shownRoles();
  const m = me();
  const close = () => { document.removeEventListener("keydown", onKey); backdrop.remove(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const act = (fn) => () => { close(); fn(); };
  const row = (icon, label, fn, cls = "") => el("button", { class: `more-item ${cls}`, type: "button", onclick: act(fn) }, el("span", { "aria-hidden": "true" }, icon), el("span", {}, label));
  const items = [
    usesCrewBoard(roles) ? row("👥", "Who's here today", () => openCrewScreen()) : null,
    usesHandoffs(roles) ? row("📝", "Shift handoff", () => openHandoffScreen()) : null,
    runsShopList(roles) ? row("🧹", "Keep the Shop Clean", () => openShopScreen()) : null,
    usesMachines(roles) ? row("🔧", "Fix Library", () => openFixes()) : null,
    roles.some((r) => ["maintenance", "admin", "plant-manager"].includes(r)) ? row("🚨", "Open issues", () => openIssues()) : null,
    roles.some((r) => ["training-safety", "admin"].includes(r)) ? row("🎓", "Training", () => { location.href = "training.html"; }) : null,
    canViewTrucks(roles) && !canCheckTrucks(roles) ? row("🚚", "Trucks", () => openTrucksScreen()) : null,
    usesQc(roles) && !roles.includes("quality") ? row("🏷", "QC hold — flagged reels", () => openReelScreen()) : null,
    usesDowntime(roles) ? row("⏱", "Downtime & scrap shift report", () => openDowntimeScreen()) : null,
    row("🦺", "Safety reports — near miss / incident", () => openIncidentScreen()),
    canWriteUps(roles, m.hr) ? row("🧾", "Write-ups", () => openWriteupsScreen()) : null,
    row("👤", "My profile — who I report to, org chart", () => openProfileScreen()),
    row("📞", "Who to Call", () => openCallScreen()),
    row("📄", "Reference documents", () => openDocsScreen()),
    !m.admin && editableForms(m.roles).length ? row("📝", "Edit forms", () => openFormsScreen()) : null,
    m.admin ? row("⚙", "Admin", () => go("adminMenu")) : null,
    pushNow === "off" ? row("🔔", "Turn on notifications", turnOnNotifications) : null,
    !isInstalled() && (installPrompt || isIPhoneOrIPad())
      ? row("📲", "Add CDG Ops to your home screen", installPrompt ? install : () => toast("In Safari, tap Share (the square with an arrow), then “Add to Home Screen.”")) : null,
    row("↪", "Sign out", signOutNow, "danger"),
  ].filter(Boolean);
  const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } },
    el("div", { class: "sheet more-sheet", role: "dialog", "aria-modal": "true", "aria-label": "More" },
      el("h2", {}, "More"),
      el("div", { class: "more-list" }, items),
      el("button", { class: "btn secondary", type: "button", onclick: close }, "Close")));
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  backdrop.querySelector(".more-item")?.focus();
}

async function turnOnNotifications() {
  try {
    pushNow = await turnOnPush(state.claims.emp);
    if (pushNow === "on") toast("Notifications are on for this device");
    else if (pushNow === "denied") toast("Notifications are blocked — turn them on in the phone's Settings → Notifications.", "error");
    else if (pushNow === "install-first") toast("On iPhone, add CDG Ops to your home screen first, then open it from there.", "error");
  } catch (err) {
    toast(friendlyError(err), "error");
  }
}

// Checklists: the machine checklists (14-day), the station checklists, and the Line Check Log, in one place.
function openChecklistsHub() {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  setNav("checklists");
  const draw = () => {
    const units = checklistUnits();
    const byLine = new Map();
    for (const u of units) {
      const k = u.lineId || "plant";
      if (!byLine.has(k)) byLine.set(k, []);
      byLine.get(k).push(u);
    }
    const loading = !data.checklistTemplates || !data.checklistUnits || !data.lines;
    screen.replaceChildren(...[
      el("button", { class: "link-btn", type: "button", onclick: () => go("home") }, "← Home"),
      el("h1", {}, "📋 Checklists"),
      el("div", { class: "hub-row" },
        (data.formTemplates || []).some((t) => t.id === "line-check" && t.active !== false)
          ? el("button", { class: "btn big secondary", type: "button", onclick: () => openLineCheckScreen() }, "📈 Line Check Log") : null,
        stationForms().length ? el("button", { class: "btn big secondary", type: "button", onclick: () => openStationScreen() }, "📋 Station checklists") : null,
        el("button", { class: "btn big secondary", type: "button", onclick: () => openReelScreen("flag", openChecklistsHub, "Checklists") }, "🏷 Flag a reel"),
        usesDowntime(shownRoles()) ? el("button", { class: "btn big secondary", type: "button", onclick: () => openDowntimeScreen(openChecklistsHub, "Checklists") }, "⏱ Downtime & scrap") : null,
        shownRoles().some((r) => SILO_UPDATE_ROLES.includes(r)) ? el("button", { class: "btn big secondary", type: "button", onclick: () => openSiloScreen(openChecklistsHub, "Checklists") }, "🛢 Update silo levels") : null),
      el("h2", {}, "Machine checklists"),
      loading ? spinner() : !units.length ? emptyState("No machine checklists yet", "An admin sets them up in Admin → Checklists.") : null,
      el("div", { class: "hub-lines" }, [...byLine.entries()].map(([lineId, list]) =>
        el("section", { class: "card hub-line" },
          el("strong", {}, lineId === "plant" ? "Plant-wide" : lineName(lineId)),
          el("div", { class: "person-list" }, list.map((u) => {
            const st = unitStatus(u);
            return el("button", { class: st.overdue ? "person-row urgent" : "person-row", type: "button", onclick: () => openChecklistScreen(u.id, openChecklistsHub) },
              el("span", { class: "person-name" }, u.template.name), el("span", { class: "tags" }, checklistTag(st)));
          }))))),
    ].flat(3).filter(Boolean));
  };
  draw();
  closeModule = onDataChange(draw);
}

// Shop Map (plant floor map). A station linked to a machine opens its Fix Library page or a Maintenance Request.
function openMap(station = null) {
  if (closeModule) closeModule();
  setNav("map");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openShopMap(screen, {
    startStation: station,
    onExit: () => go("home"),
    // Office, Sales, Quality, Logistics: the map without machine buttons (Decision 53).
    // Maintenance, Production Manager, Admin: the machine's page (parts, specs, service, fixes); others: its Fix Library page.
    onFixes: usesMachines(me().roles) && !canViewMachines(me().roles) ? (machineId) => openFixes(null, machineId) : null,
    onMachine: canViewMachines(me().roles) ? (machineId) => openMachineScreen(machineId, () => openMap(station), "Shop Map") : null,
    onReport: usesMachines(me().roles) ? (machineId) => openReport(null, () => openMap(station), machineId) : null,
    onDocs: () => openDocsScreen(() => openMap(station), "Shop Map"),
  });
}

// "Need something?" — app-only requests (types and routing set in Admin → Request types & routing).
function openNeed() {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openNeedSomething(screen, {
    me: me(), onExit: () => go("home"), onMaintenance: usesMachines(me().roles) ? () => openReport(null, openNeed) : null,
    onSent: (message) => { go("home"); toast(message); },
  });
}

// Announcements: the list, or one announcement to read and sign (from Home or a notification).
function openAnn(id = null) {
  if (closeModule) closeModule();
  setNav("ann");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openAnnouncements(screen, { me: me(), startId: id, onExit: () => go("home") });
}

// Shift handoff: the list, or one handoff (from Home or a notification).
function openHandoffScreen(id = null) {
  if (closeModule) closeModule();
  setNav("more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openHandoff(screen, { me: me(), startId: id, onExit: () => go("home") });
}

// Keep the Shop Clean: this shift's task list, or one list (from Home or a notification).
function openShopScreen(id = null) {
  if (closeModule) closeModule();
  setNav("more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openShopTasks(screen, { me: me(), startId: id, onExit: () => go("home") });
}

// Station checklists: pick a station, or open one (from Home).
function openStationScreen(formId = null) {
  if (closeModule) closeModule();
  setNav("checklists");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openStations(screen, { me: me(), startForm: formId, onExit: () => go("home") });
}

// Line Check Log: pick a line, or open one line's log (from Home or a notification).
function openLineCheckScreen(lineId = null, logId = null) {
  if (closeModule) closeModule();
  setNav("checklists");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openLineCheck(screen, { me: me(), startLine: lineId, startLogId: logId, onExit: () => go("home") });
}

// Safety reports — near misses and incidents (Home quick button, More, notifications ?incident=<id>, actions ?actions=1).
function openIncidentScreen(view = "home", id = null) {
  if (closeModule) closeModule();
  setNav(view === "report" ? "home" : "more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openIncidents(screen, {
    me: me(), start: view, startId: id, onExit: () => go("home"),
    // A near miss shared as lessons learned: the announcement form opens filled in.
    onAnnounce: (prefill, onPosted) => {
      if (closeModule) closeModule();
      setNav("ann");
      closeModule = openAnnouncements(screen, { me: me(), onExit: () => openIncidentScreen("one", id), prefill, onPosted });
    },
  });
}

// Who to Call (📞 in the top bar, or More). Maintenance's "No" opens the Fix Library; "Yes, but can't run" the request form.
// More → My profile: who I report to, and the org chart (everyone; Departments + reports to, launch list 1).
// More → Write-ups (Supervisors, Production Manager, Admins write them; the writer and HR access see them).
function openWriteupsScreen() {
  if (closeModule) closeModule();
  setNav("more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openWriteups(screen, { me: me(), onExit: () => go("home"), backLabel: "Home" });
}

function openProfileScreen() {
  if (closeModule) closeModule();
  setNav("more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openProfile(screen, { me: me(), onExit: () => go("home"), backLabel: "Home" });
}

function openCallScreen() {
  if (closeModule) closeModule();
  setNav("more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openWhoToCall(screen, {
    onExit: () => go("home"),
    onFixes: usesMachines(me().roles) ? () => openFixes() : null,
    onReport: usesMachines(me().roles) ? () => openReport(null, openCallScreen) : null,
  });
}

// Flagged reels / QC hold: Quality's bar, the Checklists page (Flag a reel), More, Home items and cards (?reels=1).
const usesQc = (roles) => roles.includes("quality") || usesMachines(roles);
function openReelScreen(view = "list", back = () => go("home"), backLabel = "Home") {
  if (closeModule) closeModule();
  setNav(shownRoles().includes("quality") ? "qc" : back === openChecklistsHub ? "checklists" : "more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openReels(screen, { me: me(), start: view, onExit: back, backLabel });
}

// Downtime & scrap shift report (Line Leads, Supervisors, Production Manager, Admins): Checklists page and More.
function openDowntimeScreen(back = () => go("home"), backLabel = "Home") {
  if (closeModule) closeModule();
  setNav(back === openChecklistsHub ? "checklists" : "more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openDowntime(screen, { me: me(), onExit: back, backLabel, onCrew: () => openCrewScreen() });
}

// Who's here today (Crew Board step 1): Home's Needs you item / Crew today card, and More.
function openCrewScreen(back = () => go("home"), backLabel = "Home") {
  if (closeModule) closeModule();
  setNav(back === openChecklistsHub ? "checklists" : "more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openCrew(screen, { onExit: back, backLabel, admin: isAdmin(), onSop: (key) => openSop(key, () => openCrewScreen(back, backLabel)) });
}

// One SOP from the Shop Map documents (a Crew Board station's SOP chip); closing it goes back.
function openSop(key, back) {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openShopMap(screen, { startDoc: key, onExit: back, onFixes: null, onReport: null });
}

// Silo levels (Checklists page, Home's silo card / low silo item, or a low silo notification: ?silos=1).
function openSiloScreen(back = () => go("home"), backLabel = "Home") {
  if (closeModule) closeModule();
  setNav(back === openChecklistsHub ? "checklists" : "home");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openSilos(screen, { me: me(), onExit: back, backLabel });
}

// Trucks board (from the bar, or a truck notification: ?trucks=1).
function openTrucksScreen() {
  if (!canViewTrucks(me().roles)) return go("home");
  if (closeModule) closeModule();
  setNav(canCheckTrucks(shownRoles()) ? "trucks" : "more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openTrucks(screen, { me: me(), onExit: () => go("home") });
}

// Machines — parts & specs (from the bar, or a machine on the Shop Map).
function openMachineScreen(machineId = null, back = () => go("home"), backLabel = "Home") {
  if (!canViewMachines(me().roles)) return go("home");
  if (closeModule) closeModule();
  setNav("machines");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  const here = () => openMachineScreen(machineId, back, backLabel);
  closeModule = openMachines(screen, {
    me: me(), startMachine: machineId, onExit: back, backLabel,
    onFixes: (id) => openFixes(null, id),
    onIssues: () => openIssues(),
    onReport: (id) => openReport(null, here, id),
  });
}

// Reference documents (from the Shop Map, or the Training page's link: ?docs=1).
function openDocsScreen(back = () => go("home"), backLabel = "Home") {
  if (closeModule) closeModule();
  setNav("more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openRefDocs(screen, { me: me(), onExit: back, backLabel });
}

// Forms editor for non-admins allowed on the Roles screen (admins use Admin → Forms).
function openFormsScreen() {
  if (closeModule) closeModule();
  setNav("more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openFormsAdmin(screen, { me: me(), onExit: () => go("home"), backLabel: "Home" });
}

function openRequestScreen(id) {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openRequest(screen, { me: me(), id, onExit: () => go("home") });
}


// Notifications: turned on once per device, from More (Decision 66). The current state decides whether More offers it.
let pushNow = null;
function refreshPushState() {
  pushState().then((s) => { pushNow = s; });
}
// The bar's Announcements badge follows the live data.
onDataChange(() => { if (state.user) { renderNav(); noticeNewAnnouncements(state.claims?.emp); } });

// Signing out also stops this person's notifications on a shared line tablet.
async function signOutNow() {
  if (isLineTablet()) await turnOffPush().catch(() => {});
  signOut(auth);
}

// ---------------------------------------------------------------------------
// Add to Home Screen (Decision 10) and the offline helper
// ---------------------------------------------------------------------------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {}); // the app still works without it
}

let installPrompt = null; // Android/Chrome hands us this when the app can be installed

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  render();
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  render();
});

function isInstalled() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function isIPhoneOrIPad() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

async function install() {
  const prompt = installPrompt;
  installPrompt = null;
  prompt.prompt();
  await prompt.userChoice;
  render();
}


function isAdmin() {
  return me().admin;
}

// Admin screens live in admin.js (People) and setup.js (Lines & machines, Roles). They draw into the
// same area until their "← Admin" button; leaving any other way (e.g. idle sign-out) closes them too.
function openModule(open) {
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = open(screen, { myEmployeeNumber: state.claims.emp, onExit: () => go("adminMenu") }) || null;
}

const APPROVER_ROLES = ["admin"]; // Plan Decision 27 (updated: admins only approve fixes)

const FIXER_ROLES = ["maintenance", "admin"]; // can mark issues fixed (moves the Odoo request to Repaired)

// Roles come from the live employee record (data.myself) once it loads, so removing a role hides its
// buttons right away; until then, from the sign-in pass. The server checks live roles on every change either way.
function me() {
  const roles = data.myself?.roles || state.claims.roles || [];
  return {
    emp: state.claims.emp,
    name: data.myself?.name || state.user?.displayName || `Employee ${state.claims.emp}`,
    admin: roles.includes("admin"),
    approver: roles.some((r) => APPROVER_ROLES.includes(r)),
    hr: data.myself?.hrAccess === true, // HR access: injury details, write-ups, reviews (a per-person switch, not a role)
    fixer: roles.some((r) => FIXER_ROLES.includes(r)),
    issueViewer: roles.includes("plant-manager"), // sees the Open issues board; can't mark fixed
    safetyWatcher: roles.some((r) => ["supervisor", "training-safety", "plant-manager", "admin"].includes(r)),
    roles,
  };
}

// Fix Library for everyone. `category` (id or name, any case) opens it filtered, e.g. from a QR code (?cat=Die).
// `machine` (e.g. "M-001", from a machine's QR code ?m=M-001) opens that machine's page.
function openFixes(category = null, machine = null) {
  if (closeModule) closeModule();
  setNav("more");
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openFixLibrary(screen, {
    me: me(), onExit: () => go("home"), startCategory: category, startMachine: machine,
    onReport: (machineTypes, machineId) => openReport(machineTypes, () => openFixes(category, machineId || machine), machineId),
    onIssues: () => openIssues(),
    onChecklist: (unitId) => openChecklistScreen(unitId, () => openFixes(category, machine)),
  });
}

// One operator checklist (signed as the signed-in person). `back` returns where it was opened from.
function openChecklistScreen(unitId, back) {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openChecklist(screen, {
    me: me(), unitId,
    onExit: (message) => { back(); if (message) toast(message); },
  });
}

// Open issues board (from Odoo).
function openIssues() {
  if (!me().fixer && !me().issueViewer) return go("home"); // the board is for Maintenance, Admin, Production Manager (the database refuses others too)
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openIssueBoard(screen, { me: me(), onExit: () => go("home"), onReport: () => openReport() });
}

// Report a problem -> Odoo request. `machineTypes` narrows the machine list (from a Fix Library category).
function openReport(machineTypes = null, back = () => go("home"), machineId = null) {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openReportForm(screen, { me: me(), machineTypes, machineId, onExit: back, onDone: me().fixer ? () => openIssues() : null });
}


// Keep the home screen's issue count live.
onDataChange(() => { if (state.step === "home") render(); });

function renderAdminMenu() {
  return [
    el("button", { class: "link-btn", type: "button", onclick: () => go("home") }, "← Home"),
    el("h1", {}, "Admin"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openAdmin) }, "👥 People"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openLines) }, "🏭 Lines & machines"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openMachineTypes) }, "🔩 Machine types"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openDepartmentsAdmin) }, "🏢 Departments"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openTeams) }, "🅰 Teams"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openRoles) }, "🏷 Roles"),
    el("button", { class: "btn", type: "button", onclick: () => openModule((c, o) => openChecklistAdmin(c, { ...o, me: me() })) }, "📋 Checklists"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openRequestTypesAdmin) }, "🙋 Request types & routing"),
    el("button", { class: "btn", type: "button", onclick: () => openModule((c, o) => openFormsAdmin(c, { ...o, me: me() })) }, "📝 Forms"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openMapAdmin) }, "🗺 Shop map setup"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openSiloAdmin) }, "🛢 Silo alerts"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openReelAdmin) }, "🏷 QC hold lists"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openCallAdmin) }, "📞 Who to Call"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openRotationAdmin) }, "🗓 Shift rotation"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openCrewStationsAdmin) }, "🧭 Crew Board stations"),
    me().hr ? el("button", { class: "btn", type: "button", onclick: () => openModule(openInjuryExport) }, "🗂 Export injury reports (PDF)") : null,
    me().hr ? el("button", { class: "btn", type: "button", onclick: () => openModule(openHrAccess) }, "🔒 HR access") : null,
    el("button", { class: "btn", type: "button", onclick: () => openModule(openTrainingAdmin) }, "🎓 Training setup"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openActivity) }, "📜 Admin activity"),
    TEST_MODE ? el("button", { class: "btn secondary", type: "button", onclick: () => openModule((c, o) => openTestReset(c, { ...o, onIssues: () => openIssues() })) }, "🧹 Reset test data") : null,
    deviceCard(), // one-time device setup, so it lives here rather than on Home
  ];
}

// Admins only: mark this device as a shared line tablet (or back to a personal device).
function deviceCard() {
  if (!isAdmin()) return null;
  const tablet = isLineTablet();
  return el(
    "div",
    { class: "card" },
    el("strong", {}, tablet ? "This device is a line tablet." : "This device is a personal device."),
    el(
      "p",
      { class: "card-note" },
      tablet
        ? "Anyone using it is signed out after 5 minutes of no use."
        : "Stays signed in. If this device is shared on a line, make it a line tablet."
    ),
    el(
      "button",
      { class: "btn secondary", type: "button", onclick: toggleLineTablet },
      tablet ? "Make this a personal device" : "Make this a line tablet"
    )
  );
}

// Sign-in and PIN screens stay a narrow, centered column on any screen (a keypad looks right that way);
// everything else uses the full width on desktops and tablets (styles.css).
const NARROW_STEPS = ["loading", "employee", "pin", "currentPin", "newPin", "confirmPin"];

function render() {
  deviceBadge.hidden = !isLineTablet();
  renderNav();
  screen.dataset.width = NARROW_STEPS.includes(state.step) ? "narrow" : "wide";
  if (state.step === "admin") return; // admin.js draws its own screens
  let content;
  if (state.step === "loading") content = [el("div", { class: "loading-screen" }, spinner())];
  else if (state.step === "employee") content = renderEmployee();
  else if (state.step === "home") content = renderHome();
  else if (state.step === "adminMenu") content = renderAdminMenu();
  else content = renderPinStep();
  screen.replaceChildren(...content.filter(Boolean));
}

// ---------------------------------------------------------------------------
// What happens when a step is finished
// ---------------------------------------------------------------------------

async function submit() {
  if (state.busy) return;
  const typed = state.typed;

  if (state.step === "employee") {
    if (!typed) return;
    state.employeeNumber = typed;
    go("pin");
    return;
  }

  if (state.step === "pin") {
    state.busy = true;
    render();
    try {
      const { data } = await callPinLogin({ employeeNumber: state.employeeNumber, pin: typed });
      state.knownPin = typed;
      await signInWithCustomToken(auth, data.token);
      // onAuthStateChanged takes it from here.
    } catch (err) {
      showError(friendlyError(err));
    }
    return;
  }

  if (state.step === "currentPin") {
    state.knownPin = typed;
    go("newPin");
    return;
  }

  if (state.step === "newPin") {
    state.newPin = typed;
    go("confirmPin");
    return;
  }

  if (state.step === "confirmPin") {
    if (typed !== state.newPin) {
      state.newPin = "";
      go("newPin", "Those didn't match. Pick your PIN again.", "error");
      return;
    }
    state.busy = true;
    render();
    try {
      await callChangePin({ currentPin: state.knownPin, newPin: state.newPin });
      await state.user.getIdToken(true); // pick up pinTemp: false
      await loadClaims();
      startData(me()); // the database only answers once the PIN is no longer temporary
      Object.assign(state, { knownPin: "", newPin: "", busy: false });
      go("home");
      toast("Your PIN is set. Use it from now on.");
    } catch (err) {
      const message = friendlyError(err);
      state.newPin = "";
      state.busy = false;
      // Wrong current PIN → ask for it again; anything else (e.g. too easy) → pick again.
      if (message.startsWith("Current PIN")) {
        state.knownPin = "";
        go("currentPin", message, "error");
      } else {
        go("newPin", message, "error");
      }
    }
  }
}

async function loadClaims() {
  const result = await state.user.getIdTokenResult();
  state.claims = result.claims;
}

// Physical keyboards work too (tablets with keyboards, testing on a PC).
document.addEventListener("keydown", (e) => {
  if (["loading", "home", "admin", "adminMenu"].includes(state.step)) return;
  if (e.target.closest?.("input, textarea, select")) return;
  if (/^\d$/.test(e.key)) press(e.key);
  else if (e.key === "Backspace") backspace();
  else if (e.key === "Enter" && state.step === "employee") submit();
});

// ---------------------------------------------------------------------------
// Signed in or not? Decides which screen to show, including after a reload.
// ---------------------------------------------------------------------------

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.busy = false;
  if (!user) {
    stopData();
    stopDashboard();
    const why = state.idleSignOut ? "Signed out after 5 minutes of no use." : "";
    Object.assign(state, { claims: {}, knownPin: "", newPin: "", employeeNumber: "", idleSignOut: false });
    go("employee", why, why ? "ok" : "");
    return;
  }
  // A line tablet that sat idle (asleep, or the page was closed) opens signed out, not as the last person.
  if (isLineTablet() && idleTooLong()) {
    state.idleSignOut = true;
    noteActivity();
    signOut(auth);
    return;
  }
  noteActivity();
  try {
    await loadClaims();
  } catch (err) {
    showError(friendlyError(err));
    return;
  }
  if (state.claims.pinTemp === true) {
    go(state.knownPin ? "newPin" : "currentPin", "Welcome! First, pick your own PIN.", "ok");
  } else {
    startData(me());
    go("home");
    // Opened from a QR code: ?m=M-001 goes straight to that machine; older ?cat=Die codes to that category (once).
    refreshPushState();
    refreshPush(state.claims.emp);
    const params = new URLSearchParams(location.search);
    const cat = params.get("cat");
    const machine = params.get("m");
    const req = params.get("req"); // opened from a notification
    const issuesLink = params.get("issues"); // a Maintenance Request notification
    const ann = params.get("ann"); // an announcement notification
    const handoff = params.get("handoff"); // a shift handoff notification
    const shop = params.get("shop"); // a shop task notification
    const lineLog = params.get("linelog"); // an out-of-spec line check alert
    const docs = params.get("docs"); // the Training page's "Reference documents" link
    const machinePage = params.get("machine"); // a link to one machine's parts & specs page
    const trucksLink = params.get("trucks"); // a truck arrived / out the door notification
    const silosLink = params.get("silos"); // a low silo notification
    const reelsLink = params.get("reels"); // QC hold
    const incidentLink = params.get("incident"); // a safety report notification
    const actionsLink = params.get("actions"); // a safety action assigned to me
    if (cat || machine || req || issuesLink || ann || handoff || shop || lineLog || docs || machinePage || trucksLink || silosLink || reelsLink || incidentLink || actionsLink) history.replaceState(null, "", location.pathname);
    if (ann) openAnn(ann);
    else if (handoff) openHandoffScreen(handoff);
    else if (shop) openShopScreen(shop);
    else if (lineLog) openLineCheckScreen(lineLog.split("__")[2] || null, lineLog);
    else if (docs) openDocsScreen();
    else if (machinePage) openMachineScreen(machinePage);
    else if (trucksLink) openTrucksScreen();
    else if (silosLink) openSiloScreen();
    else if (reelsLink) openReelScreen();
    else if (incidentLink) openIncidentScreen("one", incidentLink);
    else if (actionsLink) openIncidentScreen("actions");
    else if (req) openRequestScreen(req);
    else if (issuesLink) openIssues();
    else if (cat || machine) openFixes(cat, machine);
  }
});

render();
