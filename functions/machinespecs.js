// Machine Parts & Specs (Decision 51, updated 10-21-2026) — kept in the app for now (Firestore + Storage); nothing goes to
// Odoo yet. No database code here, so it can be tested on its own.
//
//   machineSpecs/{M-001}   info { make, model, serial, vendor, installDate, notes }, parts [], fasteners [], belts [],
//                          fluids [], files [], notes [] (important notes; safety ones pinned in red), partNumbers
//                          (for "which machines use part #6205?"), rev, updatedAt, updatedBy, updatedByName
//   machineSpecs/{id}/versions/{auto}   the record as it was before each change (restore any of them)
//
// Built to match the Odoo mapping in Decision 51, so sending to Odoo later is an add-on:
//   info.vendor → equipment "Vendor" (partner_id) + "Vendor Reference"; info.model / info.serial → "Model" / "Serial
//   Number"; info.notes → "Note"; info.installDate → "Effective date". parts / fasteners / belts → the Studio "Parts" list,
//   one line per row: Part · Part number · Kind (part / fastener / belt / bearing) · Size or spec · Qty · Vendor · Notes
//   (KIND below). files → attachments on the equipment record.
//
// Buying details (Chris, 10-23-2026, Decision 100) on every Parts / Fasteners / Belts & bearings / Fluids row:
//   partNumber, sources [{ vendor, vendorPartNumber, cost (each, dollars) | null, costDate (YYYY-MM-DD), link }] — the
//   first is the main vendor, the rest backups — and photos [{ url, name }] (our storage only). Parts rows also keep
//   vendor / vendorPartNumber = the main source, so older screens still show it.

const SECTIONS = {
  parts: { kind: "part", fields: [["name", "Part name", 120, true], ["partNumber", "Part number", 60], ["vendor", "Vendor", 80], ["vendorPartNumber", "Vendor part #", 60], ["qty", "Quantity used", 0], ["notes", "Notes", 400]] },
  fasteners: { kind: "fastener", fields: [["location", "Location", 120, true], ["size", "Size", 60], ["type", "Type", 60], ["torque", "Torque", 40], ["partNumber", "Part number", 60]] },
  belts: { kind: "belt", fields: [["location", "Location", 120, true], ["partNumber", "Part number", 60], ["size", "Size", 60]] },
  fluids: { kind: null, fields: [["what", "What", 120, true], ["where", "Where", 120], ["howOften", "How often", 80], ["partNumber", "Part number", 60]] },
  notes: { kind: null, fields: [["text", "Note", 600, true]] },
  files: { kind: null, fields: [["name", "File name", 120], ["label", "What it is", 40]] },
};
const INFO_FIELDS = [["make", 60], ["model", 60], ["serial", 60], ["vendor", 80], ["notes", 2000]];
const FILE_LABELS = ["Manual", "Wiring diagram", "Nameplate", "Photo", "Parts list", "Other"];
const MAX_ROWS = 300;
const BUY_SECTIONS = ["parts", "fasteners", "belts", "fluids"];
const MAX_SOURCES = 5;
const MAX_PHOTOS = 6;
const EDIT_DEFAULT = ["maintenance", "admin"];
const VIEW_ROLES = ["maintenance", "plant-manager", "admin"];

const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const isRowId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);

// Edit rights: set per role on the Roles screen (role.editMachines); until set, Maintenance and Admin.
function roleEditsMachines(role) {
  return typeof role.editMachines === "boolean" ? role.editMachines : EDIT_DEFAULT.includes(role.id);
}
function canEditMachines(roleDocs, myRoles) {
  return (roleDocs || []).some((r) => r.active !== false && (myRoles || []).includes(r.id) && roleEditsMachines(r));
}
const canViewMachines = (roleDocs, myRoles) => (myRoles || []).some((r) => VIEW_ROLES.includes(r)) || canEditMachines(roleDocs, myRoles);

function cleanInfo(raw) {
  const info = {};
  for (const [k, max] of INFO_FIELDS) info[k] = clean(raw?.[k], max);
  const d = raw?.installDate ? String(raw.installDate) : "";
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: "The install date isn't a date." };
  info.installDate = d;
  return { info };
}

// One section's rows. Rows keep their id (so history and the future Odoo lines line up); new rows get one.
// isOurFile(url) says whether a file link is in our storage. Returns { items } or { error }.
function cleanSection(section, raw, isOurFile = () => false) {
  const spec = SECTIONS[section];
  if (!spec) return { error: "Unknown section." };
  if (!Array.isArray(raw) || raw.length > MAX_ROWS) return { error: `Up to ${MAX_ROWS} rows.` };
  const seen = new Set();
  const items = [];
  for (const r of raw) {
    const item = { id: isRowId(r?.id) && !seen.has(r.id) ? r.id : newId() };
    seen.add(item.id);
    for (const [k, label, max, required] of spec.fields) {
      if (k === "qty") {
        const q = r?.qty === "" || r?.qty === null || r?.qty === undefined ? null : Number(r.qty);
        if (q !== null && (!Number.isFinite(q) || q < 0 || q > 100000)) return { error: "Quantity must be a number." };
        item.qty = q;
        continue;
      }
      item[k] = clean(r?.[k], max);
      if (required && !item[k]) return { error: `Every row needs “${label}”.` };
    }
    if (section === "notes") item.safety = r?.safety === true;
    if (BUY_SECTIONS.includes(section)) {
      const buy = cleanBuying(r, isOurFile);
      if (buy.error) return { error: `${item[spec.fields[0][0]] || "A row"}: ${buy.error}` };
      Object.assign(item, buy.fields);
      if (section === "parts") Object.assign(item, { vendor: buy.fields.sources[0]?.vendor || "", vendorPartNumber: buy.fields.sources[0]?.vendorPartNumber || "" });
    }
    if (section === "files") {
      const url = String(r?.url || "");
      if (!isOurFile(url)) return { error: "A file didn't upload. Add it again." };
      item.url = url;
      item.kind = r?.kind === "pdf" ? "pdf" : "image";
      if (!FILE_LABELS.includes(item.label)) item.label = "Other";
      if (!item.name) item.name = item.kind === "pdf" ? "Document" : "Photo";
    }
    items.push(item);
  }
  return { items };
}

// Where to buy it and photos for one row → { fields: { sources, photos } } or { error }. A Parts row from an older screen
// (vendor / vendorPartNumber, no sources) becomes its main source. Cost: dollars, 2 decimals; blank = not known.
function cleanBuying(r, isOurFile) {
  let raw = Array.isArray(r?.sources) ? r.sources : [];
  if (!raw.length && (clean(r?.vendor, 80) || clean(r?.vendorPartNumber, 60))) raw = [{ vendor: r.vendor, vendorPartNumber: r.vendorPartNumber }];
  if (raw.length > MAX_SOURCES) return { error: `up to ${MAX_SOURCES} vendors.` };
  const sources = [];
  for (const s of raw) {
    const src = { vendor: clean(s?.vendor, 80), vendorPartNumber: clean(s?.vendorPartNumber, 60), cost: null, costDate: "", link: "" };
    const c = s?.cost === "" || s?.cost == null ? null : Number(String(s.cost).replace(/[$,\s]/g, ""));
    if (c !== null && (!Number.isFinite(c) || c < 0 || c > 1000000)) return { error: "the cost must be a dollar amount." };
    if (c !== null) {
      src.cost = Math.round(c * 100) / 100;
      src.costDate = typeof s?.costDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.costDate) ? s.costDate : "";
    }
    const link = clean(s?.link, 300);
    if (link && !/^https?:\/\/[^\s]+$/i.test(link)) return { error: "a vendor link must start with http:// or https://." };
    src.link = link;
    if (src.vendor || src.vendorPartNumber || src.cost !== null || src.link) sources.push(src);
  }
  const rawPhotos = Array.isArray(r?.photos) ? r.photos : [];
  if (rawPhotos.length > MAX_PHOTOS) return { error: `up to ${MAX_PHOTOS} photos.` };
  const photos = [];
  for (const p of rawPhotos) {
    const url = String(p?.url || "");
    if (!isOurFile(url)) return { error: "a photo didn't upload. Add it again." };
    photos.push({ url, name: clean(p?.name, 120) || "Photo" });
  }
  return { fields: { sources, photos } };
}

// Part numbers in a spec, normalized for search ("62-05 ZZ" and "6205zz" match).
const normPart = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function partNumbersOf(spec) {
  const out = new Set();
  for (const k of BUY_SECTIONS) {
    for (const row of spec[k] || []) {
      for (const v of [row.partNumber, row.vendorPartNumber, ...(row.sources || []).map((s) => s.vendorPartNumber)]) if (normPart(v)) out.add(normPart(v));
    }
  }
  return [...out].sort();
}

// What changed in a section, for the audit log and the trash: { added, removed (rows), changed }.
function diffSection(before, after) {
  const a = new Map((before || []).map((r) => [r.id, r]));
  const b = new Map((after || []).map((r) => [r.id, r]));
  const removed = [...a.values()].filter((r) => !b.has(r.id));
  const added = [...b.values()].filter((r) => !a.has(r.id)).length;
  const changed = [...b.values()].filter((r) => a.has(r.id) && JSON.stringify(a.get(r.id)) !== JSON.stringify(r)).length;
  return { added, removed, changed };
}
const describeDiff = (section, d) => [d.added && `${d.added} added`, d.removed.length && `${d.removed.length} removed`, d.changed && `${d.changed} changed`].filter(Boolean).join(", ") || "no changes";

// Rows copied from another machine get new ids (files are not copied — each machine's photos are its own).
function copyRows(rows) {
  return (rows || []).map((r) => ({ ...r, id: newId() }));
}

module.exports = {
  SECTIONS, INFO_FIELDS, FILE_LABELS, EDIT_DEFAULT, VIEW_ROLES, BUY_SECTIONS, MAX_SOURCES, MAX_PHOTOS, roleEditsMachines, canEditMachines, canViewMachines,
  cleanInfo, cleanSection, cleanBuying, normPart, partNumbersOf, diffSection, describeDiff, copyRows,
};
