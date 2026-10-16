// Operator checklists (Plan Phase 3) — same checklists, items, and 14-day due rule as the old Line Fix Library.
// No database code here, so it can be tested on its own.
//
// A checklist (template) covers machine types. It is done once per line ("Line 1 Cooling Tank" covers both
// of Line 1's cooling tanks) or once for the plant (Chiller). Each item is due `everyDays` after it was last done.
//   unit id: "<lineId>__<templateId>"  or  "plant__<templateId>"

const DAY_MS = 86400000;

// The old library's checklists, word for word. Ids match the old library so its history and training
// media copy straight across.
const STARTING_CHECKLISTS = [
  { id: "extruder", name: "Extruder", perLine: true, machineTypes: ["Extruder"], items: [
    "Blow out control cabinet and filters",
    "Clean on and around extruder",
    "Check barrel and die temperatures for abnormalities",
    "Clean out die port hole",
    "Clean die head",
  ] },
  { id: "vacuum-tank", name: "Vacuum Tank", perLine: true, machineTypes: ["Vacuum Tank"], items: [
    "Blow out water lines",
    "Blow out vacuum lines",
    "Clean sizing sleeve",
    "Check water nozzles",
    "Check rubbers",
    "Check rollers",
    "Tighten all hose clamps",
    "Check alignment",
    "Clean water filters",
  ] },
  { id: "cooling-tank", name: "Cooling Tank", perLine: true, machineTypes: ["Cooling Tank"], items: [
    "Clean water filters",
    "Check water nozzles",
    "Check rubbers",
    "Check rollers",
    "Tighten hose clamps",
  ] },
  { id: "puller-laser-inkjet", name: "Puller / Laser / Ink Jet", perLine: true, machineTypes: ["Puller", "Laser/Ink Jet"], items: [
    "Check belt adjustment and alignment",
    "Clean laser filters",
    "Clean laser lens",
    "Check print quality and correct if needed",
    "Check ink and solvent levels",
    "Check for any ink jet errors",
  ] },
  { id: "mixer-loader", name: "Mixer / Vacuum Loader", perLine: true, machineTypes: ["Loader/Receiver/Mixer"], items: [
    "Clean all hopper filters",
    "Clean vacuum filters",
    "Blow out mixer",
    "Clean up around area",
  ] },
  { id: "chiller", name: "Chiller", perLine: false, machineTypes: ["Chilling/Main Water Supply"], items: [
    "Blow out condenser fins",
    "Clean main water filter",
  ] },
];

// Same item ids as the old library: "Clean die head" -> "clean_die_head".
function itemId(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function startingTemplate(t) {
  return {
    name: t.name, perLine: t.perLine, machineTypes: t.machineTypes, everyDays: 14, active: true,
    items: t.items.map((text) => ({ id: itemId(text), text, photos: [], videos: [] })),
  };
}

function unitId(templateId, lineId) {
  return `${lineId || "plant"}__${templateId}`;
}

// Every checklist that applies right now: one per (line, template) where the line has a machine of the
// template's types; one per plant-wide template if any such machine exists.
// templates: [{ id, perLine, machineTypes, active }], lines: [{ id, active }], machines: [{ type, lineId, active }]
function checklistUnits(templates, lines, machines) {
  const liveMachines = machines.filter((m) => m.active !== false);
  const units = [];
  for (const t of templates.filter((x) => x.active !== false)) {
    const fits = liveMachines.filter((m) => (t.machineTypes || []).includes(m.type));
    if (!t.perLine) {
      if (fits.length) units.push({ id: unitId(t.id, null), templateId: t.id, lineId: null });
      continue;
    }
    for (const line of lines.filter((l) => l.active !== false)) {
      if (fits.some((m) => m.lineId === line.id)) units.push({ id: unitId(t.id, line.id), templateId: t.id, lineId: line.id });
    }
  }
  return units;
}

// Status of one checklist: an item never done counts as overdue (like the old library).
// done: { [itemId]: { at: ms } }
function unitStatus(template, done, nowMs) {
  const dueMs = (template.everyDays || 14) * DAY_MS;
  let soonestDue = Infinity;
  let never = 0;
  let late = 0;
  let lastAt = 0;
  let lastBy = "";
  for (const item of template.items || []) {
    const rec = done?.[item.id];
    if (!rec || !rec.at) {
      never++;
      soonestDue = -Infinity;
      continue;
    }
    const due = rec.at + dueMs;
    if (due < nowMs) late++;
    if (due < soonestDue) soonestDue = due;
    if (rec.at > lastAt) {
      lastAt = rec.at;
      lastBy = rec.byName || "";
    }
  }
  const total = (template.items || []).length;
  return {
    overdue: never > 0 || late > 0,
    never,
    late,
    total,
    daysLeft: Number.isFinite(soonestDue) ? Math.ceil((soonestDue - nowMs) / DAY_MS) : null,
    lastAt,
    lastBy,
  };
}

// Admin edits to a checklist. Returns { template } or { error }. Existing items keep their id (and so
// their history and training media) when their wording is edited; `existing` is the saved template.
function cleanTemplate(data, existing = null) {
  const name = typeof data?.name === "string" ? data.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 60) return { error: "Checklist name is required (60 characters max)." };
  const machineTypes = Array.isArray(data?.machineTypes)
    ? [...new Set(data.machineTypes.map((t) => String(t).trim()).filter(Boolean))]
    : [];
  if (!machineTypes.length || machineTypes.length > 10 || machineTypes.some((t) => t.length > 60)) {
    return { error: "Pick at least one machine type." };
  }
  const everyDays = Number(data?.everyDays);
  if (!Number.isInteger(everyDays) || everyDays < 1 || everyDays > 365) return { error: "Due every 1 to 365 days." };
  if (!Array.isArray(data?.items) || !data.items.length || data.items.length > 40) return { error: "Add 1 to 40 items." };
  const old = new Map((existing?.items || []).map((i) => [i.id, i]));
  const items = [];
  for (const raw of data.items) {
    const text = typeof raw?.text === "string" ? raw.text.trim().replace(/\s+/g, " ") : "";
    if (!text || text.length > 200) return { error: "Each item needs words (200 characters max)." };
    const id = raw?.id && old.has(raw.id) ? raw.id : itemId(text);
    if (!id) return { error: `"${text}" needs a letter or number.` };
    if (items.some((i) => i.id === id)) return { error: `"${text}" is on the list twice.` };
    const prev = old.get(id);
    items.push({ id, text, photos: prev?.photos || [], videos: prev?.videos || [] });
  }
  return { template: { name, machineTypes, perLine: data?.perLine !== false, everyDays, active: data?.active !== false, items } };
}

module.exports = { STARTING_CHECKLISTS, DAY_MS, itemId, startingTemplate, unitId, checklistUnits, unitStatus, cleanTemplate };
