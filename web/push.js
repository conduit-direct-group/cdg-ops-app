// Push notifications (Firebase Cloud Messaging). A person turns them on once per device from the home
// screen; the server then sends a notification when a request is sent to them or their request changes.
//
// iPhone/iPad: only works once the app is on the home screen (Safari → Share → Add to Home Screen), and
// the permission must be asked from a tap — that's why it's a button, never an automatic pop-up.

import { getMessaging, getToken, deleteToken, onMessage, isSupported } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging.js";
import { app, callSaveDeviceToken, callRemoveDeviceToken } from "./firebase.js";
import { toast } from "./ui.js";

// Public web-push key from Firebase (Project settings → Cloud Messaging). Public by design, safe here.
const VAPID_KEY = "BFrGpLw0NYhCcFLPKyswgYMepJOE8EV4HJhD5zpeG9hWlsdk3yTauFqwLZVN-FQ3Cs31FWDNGvXopHy025Me2Gs";
const ON_KEY = "cdg.pushOn";

const remember = (v) => { try { v ? localStorage.setItem(ON_KEY, v) : localStorage.removeItem(ON_KEY); } catch {} };
const remembered = () => { try { return localStorage.getItem(ON_KEY); } catch { return null; } };

const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const appleMobile = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let supported = null;
async function canPush() {
  if (supported === null) supported = "Notification" in window && "serviceWorker" in navigator && (await isSupported().catch(() => false));
  return supported;
}

// "on" | "off" | "denied" | "install-first" (iPhone, not on the home screen yet) | "unsupported"
export async function pushState() {
  if (appleMobile() && !standalone()) return "install-first";
  if (!(await canPush())) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && remembered() ? "on" : "off";
}

async function currentToken() {
  const reg = await navigator.serviceWorker.ready;
  return getToken(getMessaging(app), { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
}

// Asks permission (from a tap) and signs this device up. Returns the new state.
export async function turnOnPush(emp) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return pushState();
  const token = await currentToken();
  await callSaveDeviceToken({ token });
  remember(emp);
  listenInApp();
  return "on";
}

// Signing out on a shared tablet: stop sending this person's notifications here.
export async function turnOffPush() {
  if (!remembered() || !(await canPush())) return;
  try {
    const token = await currentToken();
    await callRemoveDeviceToken({ token }).catch(() => {});
    await deleteToken(getMessaging(app)).catch(() => {});
  } finally {
    remember(null);
  }
}

// Already on (this device, this person): refresh the sign-up so the server has the current token.
export async function refreshPush(emp) {
  if ((await pushState()) !== "on") return;
  if (remembered() !== emp) return remember(null); // a different person turned it on here
  try {
    await callSaveDeviceToken({ token: await currentToken() });
    listenInApp();
  } catch {}
}

// While the app is open, a notification shows as a toast instead.
let listening = false;
function listenInApp() {
  if (listening) return;
  listening = true;
  onMessage(getMessaging(app), (msg) => toast(`🔔 ${msg.data?.title || "New notification"}`));
}
