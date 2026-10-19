// Draws the Training screens (training-screens.html) with React, from the values training/app.js computes.
//
// The training team built their app in a design tool whose runtime (support.js) we don't ship. This is our own
// small version of the parts the screens use:
//   {{ a.b }} / {{ !a }}            values in text and attributes (style="color:{{ x }}" works too)
//   <sc-if value="{{ x }}">          shown only when x is truthy
//   <sc-for list="{{ xs }}" as="x">  repeated for each item
//   style-hover="…"                  extra style while hovered
//   onClick="{{ fn }}" ref="{{ r }}" event handlers and element refs
//   <image-slot>                     photo placeholder (read-only, as on the original site)
// No code is ever read from the screens file: values are looked up by name only, never evaluated.

const React = window.React;
const h = React.createElement;

const RAW_WRAP = { select: "sc-raw-select", table: "sc-raw-table", tbody: "sc-raw-tbody", thead: "sc-raw-thead", tr: "sc-raw-tr", td: "sc-raw-td", th: "sc-raw-th" };
const RAW_UNWRAP = Object.fromEntries(Object.entries(RAW_WRAP).map(([k, v]) => [v, k]));
const CAMEL = "sc-camel-";
const EVENTS = {
  onclick: "onClick", onchange: "onChange", oninput: "onInput", onkeydown: "onKeyDown", onkeyup: "onKeyUp",
  onmouseenter: "onMouseEnter", onmouseleave: "onMouseLeave", onfocus: "onFocus", onblur: "onBlur",
  onpointerdown: "onPointerDown", onpointerup: "onPointerUp", onpointermove: "onPointerMove", onpointerleave: "onPointerLeave", onpointercancel: "onPointerCancel",
};
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;

// HTML parsing lowercases attribute names and moves <select>/<table> parts around; protect them first.
function encode(html) {
  html = html.replace(/(\s)([a-z]+[A-Z][A-Za-z0-9]*)(\s*=)/g, (_, sp, name, eq) => sp + CAMEL + name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()) + eq);
  for (const [real, alias] of Object.entries(RAW_WRAP)) html = html.replace(new RegExp("(</?)" + real + "(?=[\\s>])", "gi"), "$1" + alias);
  return html;
}
const kebabToCamel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// Looks up a value by name: "a", "a.b", "a[0]", "!a", true/false/null, numbers, 'text'.
function resolve(vals, src) {
  const e = String(src).trim();
  if (!e) return undefined;
  if (e[0] === "!") return !resolve(vals, e.slice(1));
  if (e === "true") return true;
  if (e === "false") return false;
  if (e === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
  if (e.length >= 2 && (e[0] === "'" || e[0] === '"') && e[e.length - 1] === e[0]) return e.slice(1, -1);
  const head = e.match(IDENT);
  if (!head) return undefined;
  let cur = vals?.[head[0]];
  let i = head[0].length;
  while (i < e.length) {
    if (e[i] === ".") {
      const m = e.slice(i + 1).match(IDENT) || e.slice(i + 1).match(/^\d+/);
      if (!m) return undefined;
      cur = cur == null ? undefined : cur[m[0]];
      i += 1 + m[0].length;
    } else if (e[i] === "[") {
      const j = e.indexOf("]", i);
      if (j < 0) return undefined;
      cur = cur == null ? undefined : cur[resolve(vals, e.slice(i + 1, j))];
      i = j + 1;
    } else return undefined;
  }
  return cur;
}

function compileAttr(raw) {
  const whole = raw.match(/^\s*\{\{([\s\S]+?)\}\}\s*$/);
  if (whole) return (vals) => resolve(vals, whole[1]);
  if (raw.includes("{{")) {
    const parts = raw.split(/\{\{([\s\S]+?)\}\}/g);
    return (vals) => parts.map((s, i) => (i & 1 ? resolve(vals, s) ?? "" : s)).join("");
  }
  return () => raw;
}

// style="a:b;c:d" → { a: "b", c: "d" } (remembered, since the same strings repeat on every redraw)
const styleCache = new Map();
function cssToObj(css) {
  let o = styleCache.get(css);
  if (o) return o;
  o = {};
  for (const decl of css.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    o[prop.startsWith("--") ? prop : kebabToCamel(prop)] = decl.slice(i + 1).trim();
  }
  if (styleCache.size > 5000) styleCache.clear();
  styleCache.set(css, o);
  return o;
}

// style-hover="…" becomes a small CSS class (the template's styles are inline, so they need !important).
let sheet = null;
const pseudo = new Map();
function pseudoClass(kind, css) {
  const k = kind + "|" + css;
  if (pseudo.has(k)) return pseudo.get(k);
  if (!sheet) { sheet = document.createElement("style"); document.head.appendChild(sheet); }
  const cls = "scp" + pseudo.size.toString(36);
  const body = css.split(";").filter((d) => d.includes(":")).map((d) => d.trim().replace(/\s*!important\s*$/, "") + " !important").join(";");
  sheet.sheet.insertRule(`.${cls}:${kind}{${body}}`, sheet.sheet.cssRules.length);
  pseudo.set(k, cls);
  return cls;
}

// Photo slot: the original's slots were filled in the design tool; on its live site they show as empty frames.
function ImageSlot({ placeholder }) {
  return h("div", { style: { width: "100%", height: "100%", minHeight: 80, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 6, background: "oklch(0.95 0.006 85)", border: "1.5px dashed oklch(0.82 0.01 85)", borderRadius: "inherit", color: "oklch(0.55 0.01 85)", fontSize: 12.5, textAlign: "center", padding: 8 } },
    h("span", { "aria-hidden": "true", style: { fontSize: 20 } }, "🖼"), placeholder || "Photo");
}

function walkChildren(node) {
  return [...node.childNodes].map(walk).filter(Boolean);
}
function walk(node) {
  if (node.nodeType === Node.TEXT_NODE) return walkText(node);
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const tag = node.localName;
  if (tag === "sc-for") return walkFor(node);
  if (tag === "sc-if") return walkIf(node);
  if (tag === "image-slot") {
    const ph = node.getAttribute("placeholder") || "";
    return (vals, key) => h(ImageSlot, { key, placeholder: ph });
  }
  return walkElement(node);
}
function walkText(node) {
  const txt = node.nodeValue ?? "";
  if (!txt.includes("{{")) {
    if (!txt.trim() && !txt.includes(" ")) return null;
    return () => txt;
  }
  const parts = txt.split(/\{\{([\s\S]+?)\}\}/g);
  return (vals, key) => h(React.Fragment, { key }, ...parts.map((p, i) => {
    if (!(i & 1)) return p;
    const v = resolve(vals, p);
    return v == null || typeof v === "boolean" ? null : String(v);
  }));
}
function walkFor(el) {
  const listGet = compileAttr(el.getAttribute("list") || "");
  const as = el.getAttribute("as") || "item";
  const kids = walkChildren(el);
  return (vals, key) => {
    const list = listGet(vals);
    if (!Array.isArray(list)) return null;
    return h(React.Fragment, { key }, list.map((item, i) => {
      const sub = { ...vals, [as]: item, $index: i };
      return h(React.Fragment, { key: i }, kids.map((b, j) => b(sub, j)));
    }));
  };
}
function walkIf(el) {
  const get = compileAttr(el.getAttribute("value") || "");
  const kids = walkChildren(el);
  return (vals, key) => (get(vals) ? h(React.Fragment, { key }, kids.map((b, j) => b(vals, j))) : null);
}
function walkElement(el) {
  const tag = RAW_UNWRAP[el.localName] || el.localName;
  const getters = [];
  const classes = [];
  for (const { name, value } of [...el.attributes]) {
    let key = name.startsWith(CAMEL) ? kebabToCamel(name.slice(CAMEL.length)) : name;
    if (key.startsWith("hint-")) continue;
    if (key.startsWith("style-")) { classes.push(pseudoClass(key.slice(6), value)); continue; }
    if (key === "class") key = "className";
    else if (key === "for") key = "htmlFor";
    else if (key.startsWith("on")) key = EVENTS[key.toLowerCase()] || "on" + key[2].toUpperCase() + key.slice(3);
    getters.push([key, compileAttr(value)]);
  }
  const kids = walkChildren(el);
  return (vals, key) => {
    const props = { key };
    for (const [k, g] of getters) {
      let v = g(vals);
      if (k === "style" && typeof v === "string") v = cssToObj(v);
      if (k === "value" && v === undefined) v = "";
      props[k] = v;
    }
    if (classes.length) props.className = [props.className, ...classes].filter(Boolean).join(" ");
    return kids.length ? h(tag, props, ...kids.map((b, j) => b(vals, j))) : h(tag, props);
  };
}

export function compileTemplate(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = encode(html); // the app's own screens file, from the same site — never user content
  const builders = walkChildren(tpl.content);
  return (vals) => builders.map((b, i) => b(vals, i));
}

// The screen logic is a class with state, setState(), and renderVals() (the values the template shows).
export class DCLogic {
  constructor(props) {
    this.props = props || {};
    this.state = {};
  }
  setState(update, cb) { this.__host && this.__host.setLogicState(update, cb); }
  forceUpdate() { this.__host && this.__host.forceUpdate(); }
  componentDidMount() {}
  componentDidUpdate() {}
  componentWillUnmount() {}
  renderVals() { return {}; }
}

export function mount(rootEl, html, Logic, props, onError) {
  const render = compileTemplate(html);
  class Host extends React.Component {
    constructor(p) {
      super(p);
      this.logic = new Logic(props);
      this.logic.__host = this;
      this.state = { n: 0, failed: null };
    }
    // Same behavior as React's setState for the logic: object patches merge; functions get the latest state.
    setLogicState(update, cb) {
      this.setState((hs) => {
        const prev = this.logic.state;
        const patch = typeof update === "function" ? update(prev, this.logic.props) : update;
        if (patch == null) return null;
        this.logic.state = { ...prev, ...patch };
        return { n: hs.n + 1 };
      }, cb);
    }
    componentDidMount() { this.logic.componentDidMount(); }
    componentDidUpdate() { this.logic.componentDidUpdate(); }
    componentWillUnmount() { this.logic.componentWillUnmount(); }
    static getDerivedStateFromError(err) { return { failed: err }; }
    componentDidCatch(err) { onError && onError(err); }
    render() {
      if (this.state.failed) return h(Failed, { err: this.state.failed });
      return h(React.Fragment, null, ...render({ ...props, ...this.logic.renderVals() }));
    }
  }
  window.ReactDOM.createRoot(rootEl).render(h(Host));
}

// Error screen with a way out (Design standard: every screen handles errors, with retry).
function Failed({ err }) {
  return h("div", { style: { minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24, textAlign: "center", fontFamily: "Figtree, system-ui, sans-serif" } },
    h("strong", { style: { fontSize: 20 } }, "Training hit a problem."),
    h("span", { style: { color: "#666", maxWidth: 480 } }, String(err?.message || err).slice(0, 200)),
    h("button", { type: "button", onClick: () => location.reload(), style: { minHeight: 56, padding: "0 24px", borderRadius: 12, border: 0, background: "#111", color: "#fff", fontSize: 16, fontWeight: 600 } }, "Reload"),
    h("a", { href: "./", style: { color: "#111", minHeight: 44, display: "flex", alignItems: "center" } }, "← CDG Ops"));
}
