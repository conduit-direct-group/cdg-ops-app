// Small helpers shared by every screen.

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

// Turns server and network errors into plain words.
export function friendlyError(err) {
  const code = err?.code || "";
  if (code.endsWith("unavailable") || code.endsWith("internal") || code.endsWith("deadline-exceeded") || code === "auth/network-request-failed") {
    return "Can't reach the server. Check Wi-Fi and try again.";
  }
  // The server's message is already plain English; drop the technical code Firebase tacks on, e.g. " [403]".
  return (err?.message || "").replace(/\s*\[\d+\]$/, "") || "Something went wrong. Try again.";
}
