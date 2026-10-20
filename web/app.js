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
import { el, friendlyError, spinner, toast, watchConnection } from "./ui.js";
import { openAdmin } from "./admin.js";
import { openLines, openRoles, openTeams, openMachineTypes } from "./setup.js";
import { openFixLibrary } from "./fixlib.js";
import { startData, stopData, data, onDataChange } from "./data.js";
import { openIssueBoard, openReportForm } from "./issues.js";
import { openChecklist, openChecklistAdmin } from "./checklists.js";
import { openActivity } from "./activity.js";
import { openShopMap } from "./shopmap.js";
import { openMapAdmin } from "./mapadmin.js";
import { openTrainingAdmin } from "./trainingadmin.js";
import { openNeedSomething, openRequest, openRequestTypesAdmin } from "./requests.js";
import { pushState, turnOnPush, turnOffPush, refreshPush } from "./push.js";
import { dashboard, stopDashboard, usesMachines, linesDownCount } from "./dashboard.js";
import { openAnnouncements } from "./announcements.js";
import { openHandoff, usesHandoffs } from "./handoff.js";
import { openFormsAdmin, editableForms } from "./forms.js";

const screen = document.getElementById("screen");
const deviceBadge = document.getElementById("device-badge");
watchConnection(document.getElementById("offline-banner"));

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
  render();
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
  // Role names from the Roles list ("Production Lead / Supervisor"), not internal ids ("lead").
  const roleNames = new Map((data.roles || []).map((r) => [r.id, r.name]));
  const roles = (data.myself?.roles || state.claims.roles || []).map((r) => roleNames.get(r) || r).join(", ");
  // The role dashboard (Decision 49): Needs you · quick buttons · plant status · role cards. The rest below.
  const dash = dashboard({
    emp: m.emp, roles: m.roles, admin: m.admin, viewAs: m.admin ? state.viewAs : null,
    setViewAs: (v) => { state.viewAs = v; render(); },
    onRedraw: () => { if (state.step === "home") render(); },
    go: {
      checklist: (id) => openChecklistScreen(id, () => go("home")),
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
    },
  });
  // What this screen shows follows the roles (or the role an admin is viewing as) — Decision 53.
  const shown = m.admin && state.viewAs ? [state.viewAs] : m.roles;
  return [
    el("h1", {}, `Hi, ${name}`),
    roles ? el("p", { class: "roles" }, `Employee ${state.claims.emp} · ${roles}`) : null,
    messageBox(),
    ...dash,
    el("button", { class: "btn big secondary", type: "button", onclick: () => openAnn() }, "📣 Announcements"),
    // Shift handoff (Line Lead Pass Down): Line Leads, Supervisors, Plant Manager, Admin.
    usesHandoffs(shown) ? el("button", { class: "btn big secondary", type: "button", onclick: () => openHandoffScreen() }, "📝 Shift handoff") : null,
    // People whose role may edit a form (Admin → Roles) but who aren't admins.
    !m.admin && editableForms(m.roles).length ? el("button", { class: "btn secondary", type: "button", onclick: () => openFormsScreen() }, "📝 Edit forms") : null,
    // Open issues: Maintenance, Admin, Plant Manager only.
    shown.some((r) => ["maintenance", "admin", "plant-manager"].includes(r)) ? issuesButton() : null,
    // Fix Library: people who work with the machines (not Office, Sales, Quality, Logistics).
    usesMachines(shown) ? el("button", { class: "btn big secondary", type: "button", onclick: () => openFixes() }, "🔧 Fix Library") : null,
    // Training (the training team's own app, on its own page): Training & Safety and Admin.
    shown.some((r) => ["training-safety", "admin"].includes(r)) ? el("a", { class: "btn big secondary", href: "training.html" }, "🎓 Training") : null,
    isAdmin() ? el("button", { class: "btn secondary", type: "button", onclick: () => go("adminMenu") }, "⚙ Admin") : null,
    pushCard(),
    installCard(),
    el("button", { class: "btn secondary", type: "button", onclick: signOutNow }, "↪ Sign out"),
  ];
}

// Shop Map (plant floor map). A station linked to a machine opens its Fix Library page or a Maintenance Request.
function openMap(station = null) {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openShopMap(screen, {
    startStation: station,
    onExit: () => go("home"),
    // Office, Sales, Quality, Logistics: the map without machine buttons (Decision 53).
    onFixes: usesMachines(me().roles) ? (machineId) => openFixes(null, machineId) : null,
    onReport: usesMachines(me().roles) ? (machineId) => openReport(null, () => openMap(station), machineId) : null,
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
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openAnnouncements(screen, { me: me(), startId: id, onExit: () => go("home") });
}

// Shift handoff: the list, or one handoff (from Home or a notification).
function openHandoffScreen(id = null) {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openHandoff(screen, { me: me(), startId: id, onExit: () => go("home") });
}

// Forms editor for non-admins allowed on the Roles screen (admins use Admin → Forms).
function openFormsScreen() {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openFormsAdmin(screen, { me: me(), onExit: () => go("home"), backLabel: "Home" });
}

function openRequestScreen(id) {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openRequest(screen, { me: me(), id, onExit: () => go("home") });
}

// Notifications: one tap to turn on (per device). Shown until it's on; explains when it can't be.
let pushNow = null;
function refreshPushState() {
  pushState().then((s) => { if (s !== pushNow) { pushNow = s; if (state.step === "home") render(); } });
}
function pushCard() {
  if (!pushNow || pushNow === "on" || pushNow === "unsupported") return null;
  const note = {
    off: "Get a notification when a request is sent to you, or when yours is in progress or done.",
    denied: "Notifications are blocked for this app. Turn them on in the phone's Settings → Notifications.",
    "install-first": "On iPhone, add CDG Ops to your home screen first (Share → Add to Home Screen), then open it from there to turn on notifications.",
  }[pushNow];
  return el(
    "div",
    { class: "card" },
    el("strong", {}, "🔔 Notifications"),
    el("p", { class: "card-note" }, note),
    pushNow === "off"
      ? el("button", {
          class: "btn", type: "button",
          onclick: async () => {
            try {
              pushNow = await turnOnPush(state.claims.emp);
              render();
              if (pushNow === "on") toast("Notifications are on for this device");
            } catch (err) {
              toast(friendlyError(err), "error");
            }
          },
        }, "🔔 Turn on notifications")
      : null
  );
}

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

function installCard() {
  if (isInstalled()) return null;
  const title = el("strong", {}, "Put CDG Ops on your home screen");
  if (installPrompt) {
    return el(
      "div",
      { class: "card" },
      title,
      el("p", { class: "card-note" }, "Opens full screen like an app, even on bad Wi-Fi."),
      el("button", { class: "btn", type: "button", onclick: install }, "Add to home screen")
    );
  }
  if (isIPhoneOrIPad()) {
    return el(
      "div",
      { class: "card" },
      title,
      el("p", { class: "card-note" }, "In Safari, tap the Share button (square with an arrow), then “Add to Home Screen.”")
    );
  }
  return null;
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
  if (!me().fixer && !me().issueViewer) return go("home"); // the board is for Maintenance, Admin, Plant Manager (the database refuses others too)
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

function issuesButton() {
  const list = data.openIssues;
  const down = linesDownCount(); // same source as the plant status bar
  const label = !list ? "Open issues" : !list.length ? "Open issues — all clear" : `Open issues (${list.length})${down ? ` · ⛔ ${down} line${down === 1 ? "" : "s"} down` : ""}`;
  return el("button", { class: down ? "btn big danger" : "btn big secondary", type: "button", onclick: openIssues }, label);
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
    el("button", { class: "btn", type: "button", onclick: () => openModule(openTeams) }, "🅰 Teams"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openRoles) }, "🏷 Roles"),
    el("button", { class: "btn", type: "button", onclick: () => openModule((c, o) => openChecklistAdmin(c, { ...o, me: me() })) }, "📋 Checklists"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openRequestTypesAdmin) }, "🙋 Request types & routing"),
    el("button", { class: "btn", type: "button", onclick: () => openModule((c, o) => openFormsAdmin(c, { ...o, me: me() })) }, "📝 Forms"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openMapAdmin) }, "🗺 Shop map setup"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openTrainingAdmin) }, "🎓 Training setup"),
    el("button", { class: "btn", type: "button", onclick: () => openModule(openActivity) }, "📜 Admin activity"),
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
    if (cat || machine || req || issuesLink || ann || handoff) history.replaceState(null, "", location.pathname);
    if (ann) openAnn(ann);
    else if (handoff) openHandoffScreen(handoff);
    else if (req) openRequestScreen(req);
    else if (issuesLink) openIssues();
    else if (cat || machine) openFixes(cat, machine);
  }
});

render();
