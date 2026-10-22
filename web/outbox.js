// Offline sign-offs (Decision 83, launch list 6). Every PIN sign-off goes through here: with a connection it is sent
// right away; without one (or when the Wi-Fi drops mid-send) it is saved on this device and sent when the connection
// is back — the PIN is checked then, as usual. The PIN is kept encrypted with a key that can't leave this device and
// is deleted as soon as the sign-off is sent (or can't be). Each sign-off has its own id, so sending it twice never
// signs twice (functions/offline.js). ⏳ in the top bar shows what's waiting; a PIN that didn't match asks to sign again.

import { el, toast, friendlyError, confirmSheet } from "./ui.js";
import { TEST_MODE, callNamed } from "./firebase.js";
import { signOff } from "./signoff.js";

const DB_NAME = "cdg-outbox";
const RETRY_MS = 60000;
const NETWORK_CODES = ["offline", "unavailable", "deadline-exceeded", "internal", "functions/unavailable", "functions/deadline-exceeded", "functions/internal"];
const MAX_NETWORK_TRIES = 20; // "internal" can also be a real server error; give up after this many tries

const listeners = new Set();
let cache = []; // the items, newest last
let flushing = false;

// ---- storage (IndexedDB: items + one encryption key) ----

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("items", { keyPath: "id" });
      req.result.createObjectStore("keys");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); resolve(out instanceof IDBRequest ? out.result : out); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

async function deviceKey() {
  const found = await tx("keys", "readonly", (s) => s.get("pin"));
  if (found) return found;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); // can't be exported
  await tx("keys", "readwrite", (s) => s.put(key, "pin"));
  return key;
}

async function seal(text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deviceKey(), new TextEncoder().encode(text));
  return { iv, ct: new Uint8Array(ct) };
}
async function open(sealed) {
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, await deviceKey(), sealed.ct));
}

async function reload() {
  try { cache = ((await tx("items", "readonly", (s) => s.getAll())) || []).sort((a, b) => a.signedAtMs - b.signedAtMs); } catch { cache = []; }
  listeners.forEach((fn) => fn(cache));
}
const save = (item) => tx("items", "readwrite", (s) => s.put(item)).then(reload);
const drop = (id) => tx("items", "readwrite", (s) => s.delete(id)).then(reload);

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
const isNetwork = (err) => !navigator.onLine || NETWORK_CODES.includes(err?.code);
const isPinProblem = (err) => /PIN|locked|Too many/i.test(err?.message || "") && /permission-denied|resource-exhausted|failed-precondition/.test(err?.code || "");

// ---- the one way screens sign ----

// For signOff's `action`: signs now, or saves it on this device when there's no connection.
//   name  the server function ("signChecklist")   data  what it needs, without signer / device
//   meta  { label: what is being signed (shown in ⏳), key: what it's for ("checklist:<id>") }
export function offlineSign(name, data, meta = {}) {
  return async ({ signer, device, who }) => {
    if (isPending(meta.key)) {
      throw Object.assign(new Error("Already signed on this device — it's waiting to send (⏳ at the top)."), { code: "already-waiting", plain: true });
    }
    const id = newId();
    const signedAtMs = Date.now();
    // A new sign-off of the same thing replaces one that needed a new PIN or couldn't be saved.
    const replaced = () => Promise.all(cache.filter((i) => meta.key && i.key === meta.key && i.status !== "waiting").map((i) => drop(i.id)));
    if (navigator.onLine) {
      try {
        const out = (await callNamed(name)({ ...data, signer, device, clientId: id, signedAtMs })).data;
        await replaced();
        return out;
      } catch (err) {
        if (!isNetwork(err)) throw err; // wrong PIN, already signed, … — shown on the PIN sheet as usual
      }
    }
    try {
      await save({ id, name, data, device, signedAtMs, emp: signer.emp, whoName: who?.name || `#${signer.emp}`, pin: await seal(signer.pin),
        label: meta.label || "Sign-off", key: meta.key || null, status: "waiting", tries: 0, test: TEST_MODE });
    } catch {
      throw Object.assign(new Error("This device can't save sign-offs while offline (private browsing?). Sign again once you're back online."), { code: "offline", plain: true });
    }
    await replaced();
    return { queued: true, name: who?.name || `#${signer.emp}`, test: TEST_MODE };
  };
}

// Sends everything waiting, oldest first. Stops at the first connection problem.
export async function flushOutbox({ quiet = false } = {}) {
  if (flushing || !navigator.onLine) return;
  flushing = true;
  let sent = 0;
  const problems = [];
  try {
    await reload();
    for (const item of cache.filter((i) => i.status === "waiting")) {
      let pin;
      try { pin = await open(item.pin); } catch { await save({ ...item, status: "needs-pin", pin: null, error: "This device couldn't read the saved PIN." }); problems.push(item); continue; }
      try {
        await callNamed(item.name)({ ...item.data, signer: { emp: item.emp, pin }, device: item.device, clientId: item.id, signedAtMs: item.signedAtMs });
        await drop(item.id);
        sent++;
      } catch (err) {
        if (isNetwork(err) && item.tries + 1 < MAX_NETWORK_TRIES) { await save({ ...item, tries: item.tries + 1 }); break; }
        const needsPin = isPinProblem(err);
        await save({ ...item, status: needsPin ? "needs-pin" : "failed", pin: null, error: friendlyError(err) });
        problems.push(item);
      }
    }
  } finally {
    flushing = false;
  }
  if (!quiet && sent) toast(`${sent} offline sign-off${sent === 1 ? "" : "s"} sent`);
  if (problems.length) toast(`⚠ ${problems.length} sign-off${problems.length === 1 ? "" : "s"} need${problems.length === 1 ? "s" : ""} attention — tap ⚠ at the top`, "error");
}

export const outboxItems = () => cache;
export const isPending = (key) => !!key && cache.some((i) => i.key === key && i.status === "waiting");
export function onOutboxChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Starts the outbox: the ⏳ button, sending on start, when the connection comes back, and every minute.
export function startOutbox(button) {
  if (!button) { // a page without the ⏳ button (an older cached page): add it next to 📞
    button = el("button", { id: "outbox-btn", class: "outbox-btn", type: "button", hidden: true }, "⏳");
    const call = document.getElementById("call-btn");
    if (call) call.before(button); else document.body.append(button);
  }
  const draw = () => {
    const waiting = cache.filter((i) => i.status === "waiting").length;
    const attention = cache.length - waiting;
    button.hidden = !cache.length;
    button.classList.toggle("attention", attention > 0);
    button.textContent = attention ? `⚠ ${cache.length}` : `⏳ ${cache.length}`;
    button.setAttribute("aria-label", attention ? `${attention} sign-off${attention === 1 ? "" : "s"} need attention` : `${waiting} sign-off${waiting === 1 ? "" : "s"} waiting to send`);
  };
  listeners.add(draw);
  button.addEventListener("click", openOutbox);
  window.addEventListener("online", () => flushOutbox());
  setInterval(() => { if (cache.some((i) => i.status === "waiting")) flushOutbox(); }, RETRY_MS);
  if (typeof indexedDB === "undefined") return;
  reload().then(() => flushOutbox());
}

// ---- the ⏳ sheet ----

const when = (ms) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const STATUS = {
  waiting: ["tag", "⏳ Waiting to send"],
  "needs-pin": ["tag off", "⚠ PIN didn't match — sign again"],
  failed: ["tag off", "⚠ Couldn't be saved"],
};

function openOutbox() {
  const close = () => { off(); document.removeEventListener("keydown", onKey); backdrop.remove(); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const sheet = el("div", { class: "sheet outbox-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Waiting to send" });
  const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } }, sheet);

  async function signAgain(item) {
    const r = await signOff({
      title: "Sign again", what: item.label, me: { emp: item.emp, name: item.whoName },
      action: async ({ signer, device, who }) => {
        const out = await offlineSign(item.name, item.data, { label: item.label, key: item.key })({ signer, device, who });
        await drop(item.id);
        return out;
      },
    });
    if (r) toast(r.queued ? "Saved on this device — sends when back online" : `Signed by ${r.name}${r.test ? " (test)" : ""}`);
  }
  async function remove(item) {
    if (await confirmSheet({ title: `Remove “${item.label}”?`, text: "It was never saved — someone will need to sign it again.", confirmLabel: "Remove", danger: true })) await drop(item.id);
  }

  function draw() {
    const items = outboxItems();
    sheet.replaceChildren(...[
      el("h2", {}, "⏳ Sign-offs on this device"),
      el("p", { class: "card-note" }, navigator.onLine
        ? "These were signed while the connection was down. They send on their own — or tap Send now."
        : "You're offline. These are saved on this device and send on their own when the connection is back. Don't clear this browser's data."),
      items.length ? el("div", { class: "outbox-list" }, items.map((i) => {
        const [cls, text] = STATUS[i.status] || STATUS.waiting;
        return el("div", { class: "outbox-entry" },
          el("strong", {}, i.label),
          el("span", { class: "outbox-note" }, `Signed by ${i.whoName} · ${when(i.signedAtMs)}${i.test ? " · TEST" : ""}`),
          el("span", { class: "outbox-row" }, el("span", { class: cls }, text)),
          i.error && i.status === "failed" ? el("span", { class: "outbox-note" }, i.error) : null,
          i.status === "waiting" ? null : el("span", { class: "outbox-row" },
            i.status === "needs-pin" ? el("button", { class: "link-btn", type: "button", onclick: () => signAgain(i) }, "Sign again") : null,
            el("button", { class: "link-btn", type: "button", onclick: () => remove(i) }, "Remove")));
      })) : el("p", { class: "hint" }, "✓ Nothing waiting — everything is sent."),
      navigator.onLine && items.some((i) => i.status === "waiting") ? el("button", { class: "btn", type: "button", disabled: flushing, onclick: () => flushOutbox() }, "Send now") : null,
      el("button", { class: "btn secondary", type: "button", onclick: close }, "Close"),
    ].filter(Boolean));
  }
  const off = onOutboxChange(draw);
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  draw();
}
