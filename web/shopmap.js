// Shop Map — the plant floor map, rebuilt from the training team's original (same zones, stations, layout,
// and behavior) in CDG colors, with the app's own code so it needs nothing from outside websites.
//
// Views: Map (pan / pinch / zoom), Zones (tap an area), Lines (station strips). Tap a station for its
// description and documents grouped Safety / LOTO · SOPs · Troubleshooting · Training videos, step through
// an SOP (PPE first), read the full document, go upstream / downstream, and search.
//
// The content (layout, stations, SOP text) is company data: it comes from the database (signed-in people
// only) and is kept on the device for bad Wi-Fi. This file only has the screens and logic.

import { el, spinner, emptyState } from "./ui.js";
import { db } from "./firebase.js";
import { data as appData } from "./data.js";
import { collection, doc, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

// Document types, same grouping and order as the original.
const TYPE = {
  safety: { label: "Safety / LOTO", short: "SAFETY", cls: "t-safety" },
  sop: { label: "SOPs", short: "SOP", cls: "t-sop" },
  trouble: { label: "Troubleshooting", short: "FIX", cls: "t-trouble" },
  video: { label: "Training videos", short: "VIDEO", cls: "t-video" },
};
const SAFETY_KEYS = ["cdgsop0009", "cdgsop0033"];
const LOTO_KEYS = ["cdgsop0008", "cdgsop0015", "cdgsop0033"];
const VIDEO_ICONS = ["loader", "blend", "extrude", "dies", "tank", "size", "print", "pull", "reel", "recycle"];
const SHORT_LABEL = { "cooling-a": "Cooling A", "cooling-b": "Cooling B", vactank: "Vac Tank", sleeve: "Sleeve", puller: "Puller", blender: "Blender", "grinder-granulator": "Grinder" };
const QUICK = ["Extruder", "Winder", "Silo", "Chiller", "Grinder", "Puller"];
const LANES = [{ label: "LINE 3", y: 595, ly: 650, lx: 235 }, { label: "LINE 2", y: 825, ly: 880, lx: 235 }, { label: "LINE 1", y: 1055, ly: 1110, lx: 235 }];
const SVGNS = "http://www.w3.org/2000/svg";

// ---- data (same preparation as the original's plant-logic) -------------------------

function prep(layout, stations, sops) {
  const D = { ...layout, stations, sops, byId: {}, zoneById: {} };
  D.zones.forEach((z) => (D.zoneById[z.id] = z));
  stations.forEach((s) => {
    D.byId[s.id] = s;
    s.zoneLabel = D.zoneById[s.zone]?.label || "";
    s.search = `${s.label} ${s.tag || ""} ${s.zoneLabel} ${s.desc || ""} ${(s.docs || []).map((x) => x.key).join(" ")}`.toLowerCase();
  });
  D.lineOrder = {};
  [1, 2, 3].forEach((l) => {
    const arr = stations.filter((s) => s.zone === `line${l}`).sort((a, b) => a.x - b.x);
    if (D.byId[`winder-${l}`]) arr.push(D.byId[`winder-${l}`]);
    D.lineOrder[l] = arr.map((s) => s.id);
  });
  D.zoneOrder = {};
  D.zones.forEach((z) => {
    D.zoneOrder[z.id] = z.id.startsWith("line")
      ? D.lineOrder[+z.id.slice(4)] || []
      : stations.filter((s) => s.zone === z.id).sort((a, b) => a.y - b.y || a.x - b.x).map((s) => s.id);
  });
  Object.entries(sops).forEach(([k, s]) => { s.key = k; if (SAFETY_KEYS.includes(k)) s.type = "safety"; if (!TYPE[s.type]) s.type = "sop"; });
  return D;
}

function docItem(D, key, note) {
  const s = D.sops[key] || { docNo: key.toUpperCase(), docTitle: "Unknown document", full: false, type: "sop" };
  return { key, docNo: s.docNo, title: s.docTitle, note, type: s.type, short: TYPE[s.type].short, refOnly: !s.full, loto: LOTO_KEYS.includes(key), isVideo: false };
}

function groups(D, st) {
  const items = (st.docs || []).map((x) => docItem(D, x.key, x.note));
  if (!st.room && VIDEO_ICONS.includes(st.icon)) {
    items.push({ key: `video-${st.id}`, docNo: "VIDEO", title: `${st.label.replace(/ \/.*/, "")} — operator walkthrough`, note: "Captioned · no audio needed", type: "video", short: "VIDEO", isVideo: true });
  }
  return ["safety", "sop", "trouble", "video"].map((id) => ({ id, ...TYPE[id], items: items.filter((i) => i.type === id) })).filter((g) => g.items.length);
}

function locate(D, st) {
  if (st.zone.startsWith("line")) {
    const ord = D.lineOrder[st.line] || [];
    const i = ord.indexOf(st.id);
    return { eyebrow: `LINE ${st.line} · STATION ${i + 1} OF ${ord.length}${st.crows ? " · CROW’S NEST" : ""}`, prev: D.byId[ord[i - 1]] || null, next: D.byId[ord[i + 1]] || null };
  }
  const ord = D.zoneOrder[st.zone] || [];
  const i = ord.indexOf(st.id);
  return { eyebrow: `${st.zoneLabel.toUpperCase()}${st.tag ? ` · ${st.tag}` : ""}`, prev: D.byId[ord[i - 1]] || null, next: D.byId[ord[i + 1]] || null };
}

function steps(sop) {
  const out = [];
  if (sop.ppe?.length) out.push({ isPpe: true, part: "Before you start", section: "Required PPE", items: sop.ppe });
  (sop.parts || []).forEach((p) => {
    let section = "";
    (p.blocks || []).forEach((b) => {
      if (b.type === "heading") { section = b.text; return; }
      out.push({ part: p.title || "Procedure", section, type: b.type, n: b.n, text: b.text, title: b.title, rows: b.rows || [], items: b.items || [] });
    });
  });
  return out;
}

function search(D, q) {
  q = q.trim().toLowerCase();
  if (!q) return { stations: [], docs: [] };
  return {
    stations: D.stations.filter((s) => s.search.includes(q)).slice(0, 12),
    docs: Object.values(D.sops).filter((s) => `${s.docNo} ${s.docTitle}`.toLowerCase().includes(q)).slice(0, 8),
  };
}

// ---- small drawing helpers ------------------------------------------------------------

function icon(D, key, size) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("sm-icon");
  svg.innerHTML = D.icons?.[key] || ""; // plain shapes only — checked by the server when the map was imported
  return svg;
}

const px = (n) => `${n}px`;

// ===========================================================================

// Where the map content comes from: the database (default). `source` can be swapped for a local test copy.
function databaseSource(onLayout, onStations, onSops, onFail) {
  const stops = [
    onSnapshot(doc(db, "floorMap", "layout"), (s) => (s.exists() ? onLayout(s.data()) : onFail()), onFail),
    onSnapshot(collection(db, "floorStations"), (s) => onStations(s.docs.map((d) => ({ id: d.id, ...d.data() }))), onFail),
    onSnapshot(collection(db, "sops"), (s) => onSops(Object.fromEntries(s.docs.map((d) => [d.id, d.data()]))), onFail),
  ];
  return () => stops.forEach((x) => x());
}

export function openShopMap(container, { onExit, onFixes, onReport, startStation = null, source = databaseSource }) {
  const st = {
    ready: false, failed: false, view: "map", sel: null, sheetFull: false, doc: null, mode: "steps", stepIdx: 0,
    searchOpen: false, q: "", v: { s: 0.5, tx: 0, ty: 0 }, anim: false, zone: null, w: 0, vw: 390, vh: 800,
  };
  let D = null;
  const raw = { layout: null, stations: null, sops: null };

  // Full-bleed: the map uses the whole screen below the top bar.
  const prevWidth = container.dataset.width;
  container.dataset.width = "full";

  const root = el("div", { class: "sm-root" });
  const area = el("div", { class: "sm-area" }); // map / zones / lines (left of the side panel on tablets)
  const vp = el("div", { class: "sm-viewport" });
  const canvas = el("div", { class: "sm-canvas" });
  vp.append(canvas);
  const overlay = el("div", { class: "sm-overlay" }); // search bar, chips, zoom buttons, zone headers
  const linesList = el("div", { class: "sm-lines" });
  const panel = el("div", { class: "sm-panel" });
  const docLayer = el("div", { class: "sm-doc", hidden: true });
  const searchLayer = el("div", { class: "sm-search", hidden: true });
  area.append(vp, linesList, overlay);
  root.append(topBar(), el("div", { class: "sm-body" }, area, panel), docLayer, searchLayer);
  container.replaceChildren(root);

  // ---- sizing ----
  function measure() {
    const top = root.getBoundingClientRect().top;
    root.style.height = px(Math.max(420, window.innerHeight - top));
    const r = root.querySelector(".sm-body").getBoundingClientRect();
    const wasTab = tablet();
    st.w = r.width;
    st.vw = r.width - (tablet() ? 400 : 0);
    st.vh = r.height;
    if (st.ready && wasTab !== tablet()) fitStart();
  }
  const tablet = () => st.w >= 820;
  const ro = new ResizeObserver(() => { measure(); render(); });
  ro.observe(container);
  window.addEventListener("resize", measure);

  // ---- view switch + home ----
  function topBar() {
    return el("div", { class: "sm-top" },
      el("button", { class: "link-btn", type: "button", onclick: onExit }, "← Home"),
      el("div", { class: "sm-tabs", role: "tablist" }, ["map", "zones", "lines"].map((v) =>
        el("button", { class: "sm-tab", type: "button", role: "tab", "data-view": v, onclick: () => setView(v) }, { map: "🗺 Map", zones: "▦ Zones", lines: "☰ Lines" }[v]))));
  }
  function setView(v) {
    if (st.view === v) return;
    Object.assign(st, { view: v, zone: null, sheetFull: false });
    if (D) fitStart();
    render();
  }

  // ---- pan / zoom (same limits and feel as the original) ----
  function fitRect(rc, pad, topPad = 0) {
    const rp = st.view === "map" ? 72 : 0;
    const s = Math.min((st.vw - pad * 2 - rp) / rc.w, (st.vh - pad * 2 - topPad) / rc.h);
    return { s, tx: (st.vw - rp) / 2 - (rc.x + rc.w / 2) * s, ty: topPad + (st.vh - topPad) / 2 - (rc.y + rc.h / 2) * s };
  }
  function fitStart() {
    if (st.view === "zones") { st.zone = null; return setV(fitRect(D.building, 12, 120)); }
    if (tablet()) return setV(fitRect(D.building, 16, 120));
    const s = 0.52;
    setV({ s, tx: st.vw / 2 - 540 * s, ty: st.vh * 0.55 - 820 * s });
  }
  function setV(v, anim = false) {
    const zoomChanged = !st.v || Math.abs(v.s - st.v.s) > 1e-6;
    st.v = v;
    canvas.style.transition = anim ? "transform .45s cubic-bezier(.2,.8,.2,1)" : "none";
    canvas.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.s})`;
    if (zoomChanged) drawCanvas();
  }
  function zoomAt(x, y, f) {
    const s = Math.min(2.4, Math.max(0.12, st.v.s * f));
    const k = s / st.v.s;
    setV({ s, tx: x - (x - st.v.tx) * k, ty: y - (y - st.v.ty) * k });
  }
  const pointers = new Map();
  let dragged = false;
  let start = null;
  vp.addEventListener("wheel", (e) => {
    if (st.view !== "map") return;
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  vp.addEventListener("pointerdown", (e) => {
    if (st.view === "lines" || (st.view === "zones" && !st.zone)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { dragged = false; start = { x: e.clientX, y: e.clientY }; }
  });
  function onMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      p.x = e.clientX; p.y = e.clientY;
      const [a2, b2] = [...pointers.values()];
      const d1 = Math.hypot(a2.x - b2.x, a2.y - b2.y);
      const r = vp.getBoundingClientRect();
      dragged = true;
      if (d0) zoomAt((a2.x + b2.x) / 2 - r.left, (a2.y + b2.y) / 2 - r.top, d1 / d0);
      return;
    }
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) dragged = true;
    if (dragged) setV({ ...st.v, tx: st.v.tx + dx, ty: st.v.ty + dy });
  }
  const onUp = (e) => pointers.delete(e.pointerId);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);

  // ---- selecting ----
  function select(id, fromMap = false) {
    if (fromMap && dragged) return;
    const s = D.byId[id];
    if (!s) return;
    Object.assign(st, { sel: id, searchOpen: false, q: "" });
    if (st.view === "map") {
      const sc = Math.max(st.v.s, tablet() ? 0.7 : 0.85);
      const cy = tablet() ? st.vh / 2 : st.vh * 0.2;
      setV({ s: sc, tx: st.vw / 2 - s.x * sc, ty: cy - s.y * sc }, true);
    } else if (st.view === "zones" && st.zone !== s.zone) {
      goZone(s.zone);
    }
    drawCanvas();
    render();
    if (st.view === "lines") {
      const tile = linesList.querySelector(`[data-sid="${id}"]`);
      const strip = tile?.closest("[data-strip]");
      if (strip) strip.scrollTo({ left: tile.offsetLeft - 20, behavior: "smooth" });
    }
  }
  function goZone(id) {
    if (!id) { st.zone = null; setV(fitRect(D.building, 12, st.view === "zones" ? 120 : 0), true); drawCanvas(); return render(); }
    st.zone = id;
    const z = D.zoneById[id];
    const top = st.view === "zones" ? 176 : 150;
    let v = fitRect(z, 14, top);
    if (!tablet() && v.s < 0.8) {
      const s = Math.min(0.8, (st.vh - top - 40) / z.h);
      v = { s, tx: 14 - z.x * s, ty: top + (st.vh - top) / 2 - (z.y + z.h / 2) * s };
    }
    setV(v, true);
    drawCanvas();
    render();
  }

  // ---- the map drawing (in map coordinates; the canvas is scaled) ----
  function drawCanvas() {
    if (!D) return;
    const s = st.v.s;
    const over = st.view === "zones" && !st.zone;
    canvas.style.width = px(D.W);
    canvas.style.height = px(D.H);
    const b = D.building;
    const parts = [
      el("div", { class: "sm-building", style: `left:${px(b.x)};top:${px(b.y)};width:${px(b.w)};height:${px(b.h)}` }),
      el("div", { class: "sm-band", style: `left:${px(b.x)};top:${px(D.band.y)};width:${px(b.w)};height:${px(D.band.h)}` }),
    ];
    const lf = Math.min(14 / s, 44);
    for (const ln of LANES) {
      parts.push(el("div", { class: "sm-lane-label", style: `left:40px;top:${px(ln.y)};font-size:${px(lf)}` }, ln.label));
      parts.push(el("div", { class: "sm-lane", style: `left:${px(ln.lx)};top:${px(ln.ly)};width:${px(1180 - ln.lx)}` }));
    }
    if (s >= 0.2) {
      const fs = Math.min(11 / s, 30);
      parts.push(el("div", { class: "sm-crows", style: `left:228px;top:${px(596 - fs * 1.3)};width:180px;font-size:${px(fs)};border-bottom-width:${px(Math.min(2 / s, 5))}` }, "▲ CROW’S NEST"));
    }
    const list = [...D.stations].sort((a, c) => (c.room ? 1 : 0) - (a.room ? 1 : 0));
    for (const m of list) {
      const on = st.sel === m.id;
      const hw = m.room ? m.w : Math.max(m.w, 50 / s);
      const hh = m.room ? m.h : Math.max(m.h, 50 / s);
      const cls = ["sm-st", on && "on", m.room && "room", m.crows && "crows", (m.zone === "storage" || m.nested) && "plain"].filter(Boolean).join(" ");
      const radius = m.shape === "circle" ? "50%" : m.shape === "capsule" ? px(m.h / 2) : m.room ? "10px" : "6px";
      const bw = (on ? 3 : 1.6) / Math.min(1, s * 1.4);
      const box = el("div", { class: cls, style: `width:${px(m.w)};height:${px(m.h)};border-radius:${radius};border-width:${px(bw)}` });
      if (!m.room && s >= 0.7 && Math.min(m.w, m.h) >= 40) box.append(icon(D, m.icon, Math.min(m.w, m.h) * 0.5));
      const label = m.room ? m.label : SHORT_LABEL[m.kind || m.id] || m.label;
      if (m.room) {
        const roomFs = Math.min(14 / s, 46, (m.w - 16) / (Math.max(...m.label.split(" ").map((w) => w.length)) * 0.66));
        box.append(el("div", { class: "sm-room-label", style: `font-size:${px(roomFs)}` }, label));
      } else if (s >= 0.42) {
        const fs = Math.min(Math.max(13 / s, 13), 30);
        box.append(el("div", { class: "sm-st-label", style: `top:${px(m.nested ? -(fs * 1.5) - 4 : m.h + 6)};font-size:${px(fs)}` }, label));
      }
      const hit = el("div", {
        class: "sm-hit", role: "button", tabindex: over ? "-1" : "0", "aria-label": `${m.label}${m.tag ? `, ${m.tag}` : ""}`,
        style: `left:${px(m.x - hw / 2)};top:${px(m.y - hh / 2)};width:${px(hw)};height:${px(hh)};pointer-events:${over ? "none" : "auto"};z-index:${m.room ? 1 : m.nested || m.over ? 3 : 2}`,
        onclick: () => select(m.id, true),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(m.id); } },
      }, box);
      parts.push(hit);
    }
    if (over) {
      for (const z of D.zones) {
        parts.push(el("button", {
          class: "sm-zone", type: "button", style: `left:${px(z.x)};top:${px(z.y)};width:${px(z.w)};height:${px(z.h)};border-width:${px(3 / s)}`,
          onclick: () => goZone(z.id),
        }, el("span", { style: `font-size:${px(24 / s)}` }, z.label)));
      }
    }
    canvas.replaceChildren(...parts);
  }

  // ---- overlays per view ----
  const searchBtn = (label, cls = "sm-searchbar") => el("button", { class: cls, type: "button", onclick: openSearch }, el("span", { class: "sm-lens", "aria-hidden": "true" }), label);
  const zoneChips = () => el("div", { class: "sm-chips" }, D.zones.map((z) =>
    el("button", { class: st.zone === z.id ? "sm-chip on" : "sm-chip", type: "button", onclick: () => goZone(st.zone === z.id && st.view === "map" ? null : z.id) }, z.label)));

  function renderOverlay() {
    if (st.view === "map") {
      return [
        el("div", { class: "sm-maptop" }, searchBtn("Search machine or SOP #"), zoneChips()),
        el("div", { class: "sm-zoom" },
          el("button", { type: "button", "aria-label": "Zoom in", onclick: () => zoomAt(st.vw / 2, st.vh / 2, 1.4) }, "+"),
          el("button", { type: "button", "aria-label": "Zoom out", onclick: () => zoomAt(st.vw / 2, st.vh / 2, 1 / 1.4) }, "−"),
          el("button", { type: "button", class: "fit", onclick: () => { st.zone = null; setV(tablet() ? fitRect(D.building, 16, 120) : fitRect(D.building, 10, 0), true); render(); } }, "FIT")),
      ];
    }
    if (st.view === "zones") {
      const head = st.zone
        ? el("div", { class: "sm-zonehead" },
            el("div", { class: "sm-row" },
              el("button", { class: "sm-pill", type: "button", onclick: () => goZone(null) }, "‹ All areas"),
              el("div", { class: "sm-grow" }, el("h1", {}, D.zoneById[st.zone].label), el("p", { class: "sm-sub" }, D.zoneById[st.zone].sub || "")),
              searchBtn("", "sm-square")),
            zoneChips())
        : el("div", { class: "sm-zonehead" },
            el("div", { class: "sm-row" },
              el("div", { class: "sm-grow" }, el("p", { class: "sm-eyebrow" }, "CONDUIT · PLANT FLOOR"), el("h1", {}, "Tap your area")),
              searchBtn("", "sm-square")));
      return [head, el("p", { class: "sm-hintline" }, st.zone ? "DRAG SIDEWAYS TO FOLLOW THE LINE · TAP A MACHINE" : `${D.stations.length} STATIONS · ${D.zones.length} AREAS`)];
    }
    return [];
  }

  // Lines view: a strip per line (loader → winder), a grid per area.
  function renderLines() {
    const tile = (id, i, n) => {
      const s = D.byId[id];
      const on = st.sel === id;
      return el("div", { class: "sm-tilewrap", "data-sid": id },
        el("button", { class: on ? "sm-tile on" : "sm-tile", type: "button", onclick: () => select(id) },
          el("span", { class: "sm-row sm-between" }, el("span", { class: "sm-num" }, String(i + 1).padStart(2, "0")), icon(D, s.icon, 30)),
          el("span", { class: "sm-tile-label" }, s.label),
          el("span", { class: "sm-docs" }, `${(s.docs || []).length} docs`)),
        i < n - 1 ? el("div", { class: "sm-arrow" }) : null);
    };
    const gridTile = (id) => {
      const s = D.byId[id];
      return el("button", { class: st.sel === id ? "sm-gtile on" : "sm-gtile", type: "button", "data-sid": id, onclick: () => select(id) },
        icon(D, s.icon, 30), el("span", { class: "sm-col" }, el("span", { class: "sm-tile-label" }, s.label), el("span", { class: "sm-docs" }, `${(s.docs || []).length} docs`)));
    };
    const order = ["line1", "line2", "line3", "north", "reclaim", "storage"].filter((z) => D.zoneById[z]);
    return [
      el("div", { class: "sm-lines-head" }, el("p", { class: "sm-eyebrow" }, "CONDUIT · PLANT FLOOR"), el("h1", {}, "Find your station"), searchBtn("Search machine, area or SOP #")),
      order.map((zid) => {
        const z = D.zoneById[zid];
        const ord = D.zoneOrder[zid] || [];
        const strip = zid.startsWith("line");
        return el("section", { class: "sm-section" },
          el("div", { class: "sm-sechead" }, el("h2", {}, z.label), el("span", { class: "sm-eyebrow" }, strip ? `${ord.length} stations · loader → winder` : z.sub || "")),
          strip
            ? el("div", { class: "sm-strip", "data-strip": "1" }, ord.map((id, i) => tile(id, i, ord.length)))
            : el("div", { class: "sm-grid" }, ord.map(gridTile)));
      }),
    ];
  }

  // ---- station panel: side panel (tablet), bottom sheet (phone map), full screen (phone zones/lines) ----
  function renderPanel() {
    const s = st.sel && D.byId[st.sel];
    const tab = tablet();
    const sheet = !tab && st.view === "map";
    panel.className = `sm-panel ${tab ? "side" : sheet ? `sheet${st.sheetFull ? " full" : ""}` : "slide"}${s ? " open" : ""}`;
    const close = () => { Object.assign(st, { sel: null, sheetFull: false }); drawCanvas(); render(); };
    const parts = [];
    if (sheet) parts.push(el("button", { class: "sm-handle", type: "button", "aria-label": st.sheetFull ? "Collapse" : "Expand", onclick: () => { st.sheetFull = !st.sheetFull; render(); } }, el("span", {})));
    if (!s) {
      parts.push(el("div", { class: "sm-nosel" }, el("p", { class: "sm-eyebrow" }, "NO STATION SELECTED"), el("h2", {}, "Tap a machine on the map to open its SOPs, safety and training docs.")));
      return panel.replaceChildren(...parts);
    }
    const loc = locate(D, s);
    const machine = s.machineId ? appData.machines?.find((m) => m.id === s.machineId) : null;
    parts.push(
      el("div", { class: "sm-panelhead" },
        !tab && !sheet ? el("button", { class: "sm-sqbtn", type: "button", "aria-label": "Back", onclick: close }, "‹") : null,
        el("div", { class: "sm-iconbox" }, icon(D, s.icon, 28)),
        el("div", { class: "sm-grow" }, el("p", { class: "sm-eyebrow accent" }, loc.eyebrow), el("h2", {}, s.label)),
        sheet || tab ? el("button", { class: "sm-sqbtn", type: "button", "aria-label": "Close", onclick: close }, "×") : null),
      el("div", { class: "sm-panelbody" },
        el("p", { class: "sm-desc" }, s.desc || ""),
        s.machineId && (onFixes || onReport)
          ? el("div", { class: "sm-machine" },
              el("span", { class: "sm-eyebrow" }, `MACHINE ${s.machineId}${machine ? ` · ${machine.name}` : ""}`),
              el("div", { class: "sm-row" },
                onFixes ? el("button", { class: "btn secondary", type: "button", onclick: () => onFixes(s.machineId) }, "🔧 Fixes & last service") : null,
                onReport ? el("button", { class: "btn danger", type: "button", onclick: () => onReport(s.machineId) }, "🚨 Maintenance Request") : null))
          : null,
        groups(D, s).map((g) =>
          el("div", { class: "sm-group" },
            el("div", { class: "sm-grouphead" }, el("span", { class: `sm-dot ${g.cls}` }), el("h3", {}, g.label), el("span", { class: "sm-count" }, String(g.items.length))),
            g.items.map((it) =>
              el("button", { class: "sm-docitem", type: "button", onclick: () => openDoc(it) },
                it.isVideo ? el("div", { class: "sm-vthumb" }, "VIDEO") : null,
                el("span", { class: "sm-col sm-grow" },
                  el("span", { class: "sm-row sm-wrap" },
                    el("span", { class: `sm-docno ${TYPE[it.type].cls}` }, it.docNo),
                    it.loto ? el("span", { class: "sm-badge loto" }, "LOTO") : null,
                    it.refOnly ? el("span", { class: "sm-badge ref" }, "REFERENCE ONLY") : null),
                  el("span", { class: "sm-doctitle" }, it.title),
                  it.note ? el("span", { class: "sm-note" }, it.note) : null),
                el("span", { class: "sm-chev", "aria-hidden": "true" }, "›")))))),
      el("div", { class: "sm-prevnext" },
        el("button", { type: "button", disabled: !loc.prev, onclick: () => loc.prev && select(loc.prev.id) },
          el("span", { class: "sm-eyebrow" }, "‹ UPSTREAM"), el("span", { class: "sm-pnlabel" }, loc.prev ? loc.prev.label : "Start of run")),
        el("button", { type: "button", class: "right", disabled: !loc.next, onclick: () => loc.next && select(loc.next.id) },
          el("span", { class: "sm-eyebrow" }, "DOWNSTREAM ›"), el("span", { class: "sm-pnlabel" }, loc.next ? loc.next.label : "End of run"))));
    panel.replaceChildren(...parts);
  }

  // ---- documents: steps (PPE first), full doc, reference only, training video ----
  function openDoc(it) { Object.assign(st, { doc: it.key, stepIdx: 0, mode: "steps" }); render(); }
  function renderDoc() {
    docLayer.hidden = !st.doc;
    if (!st.doc) return docLayer.replaceChildren();
    const close = () => { st.doc = null; render(); };
    const back = el("button", { class: "sm-sqbtn big", type: "button", "aria-label": "Back", onclick: close }, "‹");
    if (st.doc.startsWith("video-")) {
      const s = D.byId[st.doc.slice(6)];
      return docLayer.replaceChildren(
        el("div", { class: "sm-dochead" }, back, el("div", { class: "sm-grow" }, el("p", { class: "sm-eyebrow accent" }, "TRAINING VIDEO"), el("h2", {}, `${s.label} — operator walkthrough`))),
        el("div", { class: "sm-video" },
          el("div", { class: "sm-vbox" }, "TRAINING VIDEO · DROP FILE HERE"),
          el("div", { class: "sm-row" }, el("span", { class: "sm-badge solid" }, "CAPTIONS ON"), el("span", { class: "sm-badge ref" }, "NO AUDIO NEEDED")),
          el("p", { class: "sm-desc" }, "Videos play muted with burned-in captions so they work on a loud floor.")));
    }
    const sop = D.sops[st.doc];
    if (!sop) { st.doc = null; return render(); }
    const head = el("div", { class: "sm-dochead" }, back,
      el("div", { class: "sm-grow" }, el("p", { class: "sm-eyebrow accent" }, sop.docNo), el("h2", { class: "clamp" }, sop.docTitle)),
      sop.full
        ? el("div", { class: "sm-toggle" },
            el("button", { type: "button", class: st.mode === "steps" ? "on" : "", onclick: () => { st.mode = "steps"; render(); } }, "Steps"),
            el("button", { type: "button", class: st.mode === "full" ? "on" : "", onclick: () => { st.mode = "full"; render(); } }, "Full doc"))
        : null);
    if (!sop.full) {
      return docLayer.replaceChildren(head, el("div", { class: "sm-refonly" }, el("span", { class: "sm-eyebrow" }, "REFERENCE ONLY"),
        el("p", {}, "This document exists but its text hasn’t been loaded into the app yet. Ask your lead for the controlled copy.")));
    }
    if (st.mode === "full") return docLayer.replaceChildren(head, fullDoc(sop));
    const list = steps(sop);
    const n = list.length;
    const i = Math.min(st.stepIdx, Math.max(0, n - 1));
    const cur = list[i] || {};
    const go = (dlt) => { st.stepIdx = Math.max(0, Math.min(n - 1, i + dlt)); render(); };
    const card = el("div", { class: cur.type === "caution" ? "sm-card caution" : "sm-card" },
      cur.section ? el("span", { class: "sm-section-name" }, cur.section) : null,
      cur.type === "step" ? [el("span", { class: "sm-stepno" }, String(cur.n ?? "")), el("p", { class: "sm-steptext" }, cur.text)] : null,
      cur.type === "caution" ? [el("span", { class: "sm-badge loto big" }, "CAUTION"), el("p", { class: "sm-steptext strong" }, cur.text)] : null,
      cur.type === "para" ? el("p", { class: "sm-steptext" }, cur.text) : null,
      cur.isPpe ? el("div", { class: "sm-list" }, cur.items.map((p) => el("div", { class: "sm-li ppe" }, el("span", { class: "sm-sq" }), el("span", {}, p)))) : null,
      cur.type === "bullets" ? el("div", { class: "sm-list" }, cur.items.map((p) => el("div", { class: "sm-li" }, el("span", { class: "sm-bul" }), el("span", {}, p)))) : null,
      cur.type === "table" ? [el("span", { class: "sm-table-title" }, cur.title || ""), table(cur.rows)] : null);
    return docLayer.replaceChildren(head,
      el("div", { class: "sm-progress" }, el("div", { style: `width:${n ? ((i + 1) / n) * 100 : 0}%` })),
      el("div", { class: "sm-stepscroll" },
        el("div", { class: "sm-row sm-between" }, el("span", { class: "sm-eyebrow" }, cur.part || ""), el("span", { class: "sm-stepcount" }, `${i + 1} / ${n}`)),
        card),
      el("div", { class: "sm-stepnav" },
        el("button", { type: "button", class: "back", disabled: i === 0, onclick: () => go(-1) }, "‹ Back"),
        el("button", { type: "button", class: i === n - 1 ? "next done" : "next", onclick: i === n - 1 ? close : () => go(1) }, i === n - 1 ? "Done" : "Next step ›")));
  }
  function table(rows) {
    return el("div", { class: "sm-table" }, rows.map((r) => el("div", { class: "sm-tr" }, el("span", { class: "a" }, (Array.isArray(r) ? r[0] : r.a) ?? ""), el("span", { class: "b" }, (Array.isArray(r) ? r[1] : r.b) ?? ""))));
  }
  function fullDoc(sop) {
    return el("div", { class: "sm-full" },
      sop.purpose ? el("div", { class: "sm-col" }, el("span", { class: "sm-eyebrow" }, "PURPOSE"), el("p", {}, sop.purpose)) : null,
      sop.scope ? el("div", { class: "sm-col" }, el("span", { class: "sm-eyebrow" }, "SCOPE"), el("p", {}, sop.scope)) : null,
      sop.ppe?.length ? el("div", { class: "sm-ppebox" }, el("span", { class: "sm-eyebrow accent" }, "REQUIRED PPE"), sop.ppe.map((p) => el("div", { class: "sm-li ppe" }, el("span", { class: "sm-sq" }), el("span", {}, p)))) : null,
      (sop.parts || []).map((p) => el("div", { class: "sm-col sm-part" },
        p.title ? el("h3", {}, p.title) : null,
        (p.blocks || []).map((b) =>
          b.type === "heading" ? el("h4", {}, b.text)
          : b.type === "step" ? el("div", { class: "sm-fstep" }, el("span", { class: "n" }, String(b.n ?? "")), el("span", {}, b.text))
          : b.type === "caution" ? el("div", { class: "sm-fcaution" }, el("span", { class: "sm-eyebrow" }, "CAUTION"), " ", b.text)
          : b.type === "para" ? el("p", {}, b.text)
          : b.type === "bullets" ? el("div", { class: "sm-list indent" }, (b.items || []).map((x) => el("div", { class: "sm-li" }, el("span", { class: "sm-bul" }), el("span", {}, x))))
          : b.type === "table" ? el("div", { class: "sm-ftable" }, el("div", { class: "sm-ftable-title" }, b.title || ""), table(b.rows || []))
          : null))),
      sop.related?.length ? el("div", { class: "sm-col sm-related" }, el("span", { class: "sm-eyebrow" }, "RELATED DOCUMENTS"), sop.related.map((r) => el("span", {}, r))) : null);
  }

  // ---- search ----
  function openSearch() { st.searchOpen = true; render(); setTimeout(() => searchLayer.querySelector("input")?.focus(), 60); }
  function renderSearch() {
    searchLayer.hidden = !st.searchOpen;
    if (!st.searchOpen) return searchLayer.replaceChildren();
    const results = el("div", { class: "sm-results" });
    const draw = () => {
      const q = st.q.trim();
      const r = search(D, st.q);
      results.replaceChildren(...[
        !q ? [el("span", { class: "sm-eyebrow" }, "QUICK FIND"), el("div", { class: "sm-quick" }, QUICK.map((t) => el("button", { type: "button", onclick: () => { st.q = t; input.value = t; draw(); } }, t)))] : null,
        r.stations.length ? [el("span", { class: "sm-eyebrow" }, "STATIONS"), r.stations.map((s) =>
          el("button", { class: "sm-ritem", type: "button", onclick: () => select(s.id) }, icon(D, s.icon, 26),
            el("span", { class: "sm-col sm-grow" }, el("span", { class: "sm-tile-label" }, s.label), el("span", { class: "sm-note" }, s.zone.startsWith("line") ? `Line ${s.line}` : s.zoneLabel)),
            el("span", { class: "sm-docs" }, `${(s.docs || []).length} docs`)))] : null,
        r.docs.length ? [el("span", { class: "sm-eyebrow" }, "DOCUMENTS"), r.docs.map((s) =>
          el("button", { class: "sm-ritem col", type: "button", onclick: () => { Object.assign(st, { doc: s.key, stepIdx: 0, mode: "steps" }); render(); } },
            el("span", { class: "sm-docno t-sop" }, s.docNo), el("span", { class: "sm-doctitle" }, s.docTitle)))] : null,
        q && !r.stations.length && !r.docs.length ? el("p", { class: "sm-desc" }, `Nothing matches “${q}”.`) : null,
      ].flat(2).filter(Boolean));
    };
    const input = el("input", { class: "field", type: "search", placeholder: "Machine, area or SOP #", "aria-label": "Search the shop map", value: st.q, autocomplete: "off", oninput: (e) => { st.q = e.target.value; draw(); } });
    draw();
    searchLayer.replaceChildren(
      el("div", { class: "sm-searchhead" }, input, el("button", { class: "sm-pill", type: "button", onclick: () => { Object.assign(st, { searchOpen: false, q: "" }); render(); } }, "Cancel")),
      results);
  }

  // ---- render ----
  function render() {
    root.querySelectorAll(".sm-tab").forEach((b) => { b.classList.toggle("on", b.dataset.view === st.view); b.setAttribute("aria-selected", b.dataset.view === st.view); });
    if (!D) {
      area.replaceChildren(st.failed
        ? emptyState("The shop map isn't set up yet", "An admin loads it once in Admin → Shop map. If you're offline, connect to Wi-Fi once to download it.")
        : el("div", { class: "sm-loading" }, spinner("Loading plant map…")));
      panel.replaceChildren();
      return;
    }
    if (!area.contains(vp)) area.replaceChildren(vp, linesList, overlay);
    root.classList.toggle("tablet", tablet());
    vp.hidden = st.view === "lines";
    linesList.hidden = st.view !== "lines";
    if (st.view === "lines") linesList.replaceChildren(...renderLines().flat(2).filter(Boolean));
    overlay.replaceChildren(...renderOverlay().flat(2).filter(Boolean));
    renderPanel();
    if (!searchLayer.contains(document.activeElement)) renderSearch();
    else searchLayer.hidden = !st.searchOpen;
    renderDoc();
  }

  // ---- data (live; kept on the device for bad Wi-Fi) ----
  function ready() {
    if (!raw.layout || !raw.stations || !raw.sops) return;
    const first = !D;
    D = prep(raw.layout, raw.stations.filter((s) => s.active !== false), raw.sops);
    st.ready = true;
    measure();
    if (first) {
      fitStart();
      if (startStation && D.byId[startStation]) select(startStation);
    }
    drawCanvas();
    render();
  }
  const fail = () => { st.failed = true; render(); };
  const stopSource = source(
    (layout) => { raw.layout = layout; ready(); },
    (stations) => { raw.stations = stations; ready(); },
    (sops) => { raw.sops = sops; ready(); },
    fail
  );

  measure();
  render();
  return () => {
    stopSource();
    ro.disconnect();
    window.removeEventListener("resize", measure);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    container.dataset.width = prevWidth || "wide";
  };
}
