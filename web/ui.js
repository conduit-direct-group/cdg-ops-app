// Shared building blocks for every screen (docs/DESIGN-STANDARD.md): elements, loading, empty,
// error-with-retry, toast, on-page confirm, offline banner.

// Builds an element. Text is always set as text (never HTML), so names can't break the page.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value" || key === "checked") node[key] = value;
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Lets long names like "Loader/Receiver/Mixer" wrap after a slash instead of mid-word.
export function breakable(text) {
  return String(text).replace(/\//g, "/​");
}

// Turns server and network errors into plain words.
export function friendlyError(err) {
  const code = err?.code || "";
  if (code === "offline" || !navigator.onLine) {
    return "You're offline. This needs a connection — try again once you're back on Wi-Fi.";
  }
  if (code.endsWith("unavailable") || code.endsWith("internal") || code.endsWith("deadline-exceeded") || code === "auth/network-request-failed") {
    return "Can't reach the server. Check Wi-Fi and try again.";
  }
  // The server's message is already plain English; drop the technical code Firebase tacks on, e.g. " [403]".
  return (err?.message || "").replace(/\s*\[\d+\]$/, "") || "Something went wrong. Try again.";
}

// ---- Loading / empty / error ------------------------------------------------

export function spinner(label = "Loading…") {
  return el("div", { class: "spinner-row", role: "status" }, el("span", { class: "spinner", "aria-hidden": "true" }), label);
}

// What goes here and what to do. `action` is an optional button element.
export function emptyState(title, text, action = null) {
  return el("div", { class: "empty" }, el("strong", {}, title), text ? el("p", {}, text) : null, action);
}

// Plain-language error with a Try again button (when there's something to retry).
export function errorBanner(message, onRetry = null) {
  return el(
    "div",
    { class: "message error", role: "alert" },
    el("div", {}, message),
    onRetry ? el("button", { class: "btn secondary retry", type: "button", onclick: onRetry }, "↻ Try again") : null
  );
}

// Banner for a screen's state: { message, messageKind, retry }. Success goes to a toast instead.
export function banner(state) {
  if (!state.message) return null;
  if (state.messageKind === "error") return errorBanner(state.message, state.retry || null);
  return el("p", { class: "message" }, state.message);
}

// ---- Toast --------------------------------------------------------------------

let toastTimer = null;
export function toast(message, kind = "ok") {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const node = el("div", { class: kind === "error" ? "toast error" : "toast", role: "status" }, kind === "error" ? message : `✔ ${message}`);
  document.body.append(node);
  toastTimer = setTimeout(() => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 200);
  }, 3500);
}

// ---- On-page confirm (never a browser pop-up) ----------------------------------

// Resolves true (confirmed) or false (cancelled). Big buttons for gloves; Esc or tapping outside cancels.
export function confirmSheet({ title, text = "", confirmLabel = "Yes", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    const done = (answer) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(answer);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    const yes = el("button", { class: danger ? "btn danger" : "btn", type: "button", onclick: () => done(true) }, confirmLabel);
    const backdrop = el(
      "div",
      { class: "sheet-backdrop", onclick: (e) => { if (e.target === backdrop) done(false); } },
      el(
        "div",
        { class: danger ? "sheet danger" : "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
        el("h2", {}, title),
        text ? el("p", {}, text) : null,
        yes,
        el("button", { class: "btn secondary", type: "button", onclick: () => done(false) }, cancelLabel)
      )
    );
    document.addEventListener("keydown", onKey);
    document.body.append(backdrop);
    yes.focus();
  });
}

// ---- Offline --------------------------------------------------------------------

// Shows the red Offline bar while there's no connection. Looking things up keeps working
// (the app keeps a copy); saving is blocked with a plain message until the connection is back.
export function watchConnection(bannerEl) {
  const update = () => {
    bannerEl.hidden = navigator.onLine;
  };
  window.addEventListener("online", () => { update(); toast("Back online"); });
  window.addEventListener("offline", update);
  update();
}
