// The one sign-off part (Decision 7): tap your name, then your own 6-digit PIN, checked on the server.
// Checklists, announcements, and anything later use it. On a line tablet anyone on the crew can sign without
// signing in ("Someone else?" lists their names), so a crew can sign one after another.
// Each sign-off records which device it was made on.

import { el, friendlyError } from "./ui.js";

const LINE_TABLET_KEY = "cdg.lineTablet"; // set by app.js (Admin → Make this a line tablet)
const DEVICE_KEY = "cdg.deviceId";

function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function isLineTablet() {
  return stored(LINE_TABLET_KEY) === "yes";
}

function platform() {
  const ua = navigator.userAgent;
  if (/iphone/i.test(ua)) return "iPhone";
  if (/ipad/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/android/i.test(ua)) return /mobile/i.test(ua) ? "Android phone" : "Android tablet";
  if (/windows/i.test(ua)) return "Windows PC";
  if (/cros/i.test(ua)) return "Chromebook";
  if (/mac/i.test(ua)) return "Mac";
  return "Browser";
}

// { id, kind, label } — the id is made once per device and kept (a new one if storage is blocked).
let sessionId = null;
export function deviceInfo() {
  let id = stored(DEVICE_KEY);
  if (!id) {
    id = sessionId || (sessionId = (crypto.randomUUID?.() || `d${Date.now()}${Math.random().toString(16).slice(2)}`).slice(0, 40));
    try { localStorage.setItem(DEVICE_KEY, id); } catch {}
  }
  const kind = isLineTablet() ? "line-tablet" : "personal";
  return { id, kind, label: `${kind === "line-tablet" ? "Line tablet" : "Personal device"} · ${platform()}` };
}

// Opens the sign-off sheet. Resolves with what `action` returned, or null if cancelled.
//   title      "Read & understood"
//   what       what is being signed ("New glove rule · version 2")
//   me         { emp, name } — the first name shown (usually the person signed in); null = go straight to `others`
//   others     optional async () => [{ emp, name }] — other people who may sign here (line tablets only)
//   action     async ({ signer: { emp, pin }, device }) => result — the server call; throw to show the error
//   doneLabel  shown while saving ("Signing…")
export function signOff({ title, what, me, others = null, action, doneLabel = "Signing…" }) {
  return new Promise((resolve) => {
    const ui = { step: "who", who: null, pin: "", busy: false, message: "", list: null, listError: "" };
    const canPickOthers = !!others && (isLineTablet() || !me);

    const close = (result) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(result);
    };

    async function submit() {
      Object.assign(ui, { busy: true, message: "" });
      draw();
      try {
        const result = await action({ signer: { emp: ui.who.emp, pin: ui.pin }, device: deviceInfo() });
        close(result);
      } catch (err) {
        Object.assign(ui, { busy: false, pin: "", message: friendlyError(err) });
        draw();
      }
    }

    function press(d) {
      if (ui.busy || ui.step !== "pin" || ui.pin.length >= 6) return;
      ui.pin += d;
      ui.message = "";
      draw();
      if (ui.pin.length === 6) submit();
    }
    function back() {
      if (ui.busy) return;
      ui.pin = ui.pin.slice(0, -1);
      draw();
    }
    function pick(person) {
      Object.assign(ui, { step: "pin", who: person, pin: "", message: "" });
      draw();
    }
    async function showOthers() {
      Object.assign(ui, { step: "others", listError: "" });
      draw();
      if (ui.list) return;
      try {
        ui.list = await others();
      } catch (err) {
        ui.listError = friendlyError(err);
      }
      draw();
    }

    const onKey = (e) => {
      if (e.key === "Escape" && !ui.busy) return close(null);
      if (ui.step !== "pin" || e.target.closest?.("input, textarea")) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") back();
    };

    const sheet = el("div", { class: "sheet signoff-sheet", role: "dialog", "aria-modal": "true", "aria-label": title });
    const backdrop = el("div", { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop && !ui.busy) close(null); } }, sheet);

    function whoStep() {
      return [
        el("p", { class: "field-label" }, "Tap your name"),
        el("button", { class: "btn signoff-name", type: "button", onclick: () => pick(me) }, `✍ ${me.name}`),
        canPickOthers ? el("button", { class: "btn secondary", type: "button", onclick: showOthers }, "Someone else? Find your name") : null,
      ];
    }

    function othersStep() {
      return [
        me ? el("button", { class: "link-btn", type: "button", onclick: () => { ui.step = "who"; draw(); } }, "← Back") : null,
        el("p", { class: "field-label" }, "Tap your name"),
        ui.listError
          ? el("div", { class: "message error", role: "alert" }, ui.listError, el("button", { class: "btn secondary retry", type: "button", onclick: () => { ui.list = null; showOthers(); } }, "↻ Try again"))
          : !ui.list
            ? el("div", { class: "spinner-row", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), "Loading names…")
            : !ui.list.length
              ? el("p", { class: "card-note" }, "Nobody else needs to sign this here.")
              : el("div", { class: "signoff-names" }, ui.list.map((p) => el("button", { class: "picker-option", type: "button", onclick: () => pick(p) }, el("span", {}, p.name)))),
      ];
    }

    function pinStep() {
      const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => el("button", { class: "key", type: "button", disabled: ui.busy, onclick: () => press(d) }, d));
      return [
        el("div", { class: "who" },
          el("span", {}, el("strong", {}, ui.who.name)),
          el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => { Object.assign(ui, { step: me ? "who" : "others", pin: "", message: "" }); draw(); } }, "Not you?")),
        el("p", { class: "hint" }, "Enter your 6-digit PIN to sign"),
        el("div", { class: "entry" }, el("div", { class: "dots", "aria-label": `${ui.pin.length} of 6 digits entered` },
          Array.from({ length: 6 }, (_, i) => el("span", { class: i < ui.pin.length ? "dot filled" : "dot" })))),
        ui.message ? el("p", { class: "message error", role: "alert" }, ui.message) : null,
        ui.busy ? el("p", { class: "hint" }, doneLabel) : null,
        el("div", { class: "keypad" },
          keys,
          el("button", { class: "key small", type: "button", disabled: ui.busy, onclick: () => { ui.pin = ""; draw(); } }, "Clear"),
          el("button", { class: "key", type: "button", disabled: ui.busy, onclick: () => press("0") }, "0"),
          el("button", { class: "key small", type: "button", disabled: ui.busy, onclick: back, "aria-label": "Delete" }, "⌫ Delete")),
      ];
    }

    function draw() {
      const body = ui.step === "pin" ? pinStep() : ui.step === "others" ? othersStep() : whoStep();
      sheet.replaceChildren(...[
        el("h2", {}, title),
        what ? el("p", { class: "signoff-what" }, what) : null,
        ...body,
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => close(null) }, "Cancel"),
      ].flat().filter(Boolean));
    }

    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    if (!me) showOthers();
    draw();
    sheet.querySelector(".signoff-name")?.focus();
  });
}
