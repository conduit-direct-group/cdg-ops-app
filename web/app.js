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

import { auth, callPinLogin, callChangePin } from "./firebase.js";
import { signInWithCustomToken, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { el, friendlyError, spinner, toast, watchConnection } from "./ui.js";
import { openAdmin } from "./admin.js";
import { openLines, openRoles } from "./setup.js";
import { openFixLibrary } from "./fixlib.js";
import { startData, stopData, data, onDataChange } from "./data.js";
import { openIssueBoard, openReportForm } from "./issues.js";

const screen = document.getElementById("screen");
const deviceBadge = document.getElementById("device-badge");
watchConnection(document.getElementById("offline-banner"));

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
    signOut(auth);
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
  // Role names from the Roles list ("Production Lead / Supervisor"), not internal ids ("lead").
  const roleNames = new Map((data.roles || []).map((r) => [r.id, r.name]));
  const roles = (state.claims.roles || []).map((r) => roleNames.get(r) || r).join(", ");
  return [
    el("h1", {}, `Hi, ${name}`),
    roles ? el("p", { class: "roles" }, `Employee ${state.claims.emp} · ${roles}`) : null,
    messageBox(),
    el("button", { class: "btn big danger", type: "button", onclick: () => openReport() }, "🚨 Report a problem"),
    issuesButton(),
    el("button", { class: "btn big", type: "button", onclick: () => openFixes() }, "🔧 Fix Library"),
    isAdmin() ? el("button", { class: "btn secondary", type: "button", onclick: () => go("adminMenu") }, "⚙ Admin") : null,
    installCard(),
    el("button", { class: "btn secondary", type: "button", onclick: () => signOut(auth) }, "↪ Sign out"),
  ];
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
  return (state.claims.roles || []).includes("admin");
}

// Admin screens live in admin.js (People) and setup.js (Lines & machines, Roles). They draw into the
// same area until their "← Admin" button; leaving any other way (e.g. idle sign-out) closes them too.
function openModule(open) {
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = open(screen, { myEmployeeNumber: state.claims.emp, onExit: () => go("adminMenu") }) || null;
}

const APPROVER_ROLES = ["admin"]; // Plan Decision 27 (updated: admins only approve fixes)

const FIXER_ROLES = ["maintenance", "admin"]; // can mark issues fixed (moves the Odoo request to Repaired)

function me() {
  const roles = state.claims.roles || [];
  return {
    emp: state.claims.emp,
    admin: roles.includes("admin"),
    approver: roles.some((r) => APPROVER_ROLES.includes(r)),
    fixer: roles.some((r) => FIXER_ROLES.includes(r)),
  };
}

// Fix Library for everyone. `category` (id or name, any case) opens it filtered, e.g. from a QR code (?cat=Die).
function openFixes(category = null) {
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openFixLibrary(screen, {
    me: me(), onExit: () => go("home"), startCategory: category,
    onReport: (machineTypes) => openReport(machineTypes, () => openFixes(category)),
    onIssues: () => openIssues(),
  });
}

// Open issues board (from Odoo).
function openIssues() {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openIssueBoard(screen, { me: me(), onExit: () => go("home"), onReport: () => openReport() });
}

// Report a problem -> Odoo request. `machineTypes` narrows the machine list (from a Fix Library category).
function openReport(machineTypes = null, back = () => go("home")) {
  if (closeModule) closeModule();
  Object.assign(state, { step: "admin", message: "", messageKind: "" });
  closeModule = openReportForm(screen, { me: me(), machineTypes, onExit: back, onDone: () => openIssues() });
}

function issuesButton() {
  const list = data.openIssues;
  const down = (list || []).filter((i) => i.lineDown).length;
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
    el("button", { class: "btn", type: "button", onclick: () => openModule(openRoles) }, "🏷 Roles"),
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
    // Opened from a QR code or link like ?cat=Die: go straight to that Fix Library category (once).
    const cat = new URLSearchParams(location.search).get("cat");
    if (cat) {
      history.replaceState(null, "", location.pathname);
      openFixes(cat);
    }
  }
});

render();
