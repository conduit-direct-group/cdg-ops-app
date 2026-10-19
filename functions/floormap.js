// Shop map (plant floor map) — checks for the admin import. No database code here, so it can be tested.
// The map's content (zones, stations, SOP text) is company data: it lives only in the database, never in this repo.

const MAX_STATIONS = 200;
const MAX_SOPS = 200;

// Icons are tiny SVG drawings (24×24). Only plain shapes with geometry attributes are allowed —
// no scripts, links, event handlers, or styles — so an icon can never run code in the app.
const ICON_TAGS = /^(path|circle|rect|line|polyline|polygon|ellipse|g)$/;
const ICON_ATTRS = /^(d|cx|cy|r|rx|ry|x|y|x1|y1|x2|y2|width|height|points|transform|fill|stroke|stroke-width|stroke-linecap|stroke-linejoin|stroke-dasharray|opacity)$/;
function safeIcon(svg) {
  if (typeof svg !== "string" || svg.length > 4000) return false;
  const tags = svg.match(/<\/?[^>]*>/g) || [];
  if (svg.replace(/<[^>]*>/g, "").trim()) return false; // no loose text
  for (const t of tags) {
    if (/^<\//.test(t)) {
      if (!ICON_TAGS.test(t.slice(2, -1).trim())) return false;
      continue;
    }
    const m = t.match(/^<([a-z]+)((?:\s+[a-z-]+="[^"<>]*")*)\s*\/?>$/i);
    if (!m || !ICON_TAGS.test(m[1])) return false;
    for (const a of m[2].matchAll(/([a-z-]+)="([^"]*)"/gi)) {
      if (!ICON_ATTRS.test(a[1]) || /url\(|javascript:|expression/i.test(a[2])) return false;
    }
  }
  return true;
}

const num = (v) => typeof v === "number" && Number.isFinite(v);
const str = (v, max) => typeof v === "string" && v.length <= max;
const id = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,60}$/.test(v);

// Checks the whole map file (the original's plant-data.json). Returns { layout, stations, sops } ready to
// save, or { error } in plain English.
function cleanMap(data) {
  if (!data || typeof data !== "object") return { error: "That isn't a map file." };
  const { W, H, building, band, laneY, crowsY, zones, stations, sops, icons } = data;
  if (!num(W) || !num(H) || !building || !band || !Array.isArray(zones) || !Array.isArray(stations) || !sops || !icons) {
    return { error: "That isn't the plant map file (plant-data.json)." };
  }
  if (!zones.length || zones.length > 30 || !zones.every((z) => id(z.id) && str(z.label, 80) && str(z.sub || "", 200) && [z.x, z.y, z.w, z.h].every(num))) {
    return { error: "The zones in the file don't look right." };
  }
  const zoneIds = new Set(zones.map((z) => z.id));
  if (!stations.length || stations.length > MAX_STATIONS) return { error: `The file needs 1–${MAX_STATIONS} stations.` };
  const sopKeys = Object.keys(sops);
  if (sopKeys.length > MAX_SOPS || !sopKeys.every(id)) return { error: "The SOP list in the file doesn't look right." };
  for (const [k, svg] of Object.entries(icons)) {
    if (!id(k) || !safeIcon(svg)) return { error: `Icon "${k}" contains something other than plain shapes — not imported.` };
  }
  const seen = new Set();
  for (const s of stations) {
    const ok = id(s.id) && !seen.has(s.id) && str(s.label, 80) && str(s.tag || "", 40) && str(s.icon || "", 40) && str(s.desc || "", 2000)
      && zoneIds.has(s.zone) && [s.x, s.y, s.w, s.h].every(num) && Array.isArray(s.docs) && s.docs.length <= 40
      && s.docs.every((d) => id(d.key) && str(d.note || "", 400));
    if (!ok) return { error: `Station "${s?.label || s?.id || "?"}" in the file doesn't look right.` };
    seen.add(s.id);
  }
  for (const [k, s] of Object.entries(sops)) {
    if (!str(s.docNo, 40) || !str(s.docTitle, 300) || JSON.stringify(s).length > 60000) return { error: `SOP ${k} in the file doesn't look right.` };
  }
  // The database cannot store a list inside a list: table rows ([cell, cell]) become { a, b }.
  const rowsAsCells = (sop) => ({
    ...sop,
    parts: (sop.parts || []).map((p) => ({ ...p, blocks: (p.blocks || []).map((b) => (Array.isArray(b.rows) ? { ...b, rows: b.rows.map((r) => (Array.isArray(r) ? { a: String(r[0] ?? ""), b: String(r[1] ?? "") } : r)) } : b)) })),
  });
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  return {
    layout: { W, H, building: pick(building, ["x", "y", "w", "h"]), band: pick(band, ["y", "h"]), laneY: laneY || {}, crowsY: crowsY ?? null,
      zones: zones.map((z) => pick(z, ["id", "label", "sub", "x", "y", "w", "h"])), icons },
    stations: stations.map((s) => pick(s, ["id", "label", "tag", "icon", "desc", "shape", "w", "h", "docs", "x", "y", "zone", "line", "kind", "nested", "step", "crows", "over", "room"])),
    sops: Object.fromEntries(Object.entries(sops).map(([k, s]) => [k, rowsAsCells(pick(s, ["docNo", "docTitle", "full", "purpose", "scope", "ppe", "parts", "related", "type"]))])),
  };
}

// Odoo equipment name for a machine, the same way the existing ones are named: "M-001 L1-Extruder",
// or "M-031 Outside Chiller" for plant equipment not on a line.
function odooEquipmentName(machine, lineName) {
  const n = String(lineName || "").match(/(\d+)\s*$/);
  return `${machine.id} ${n ? `L${n[1]}-` : ""}${machine.name}`;
}

module.exports = { safeIcon, cleanMap, odooEquipmentName };
