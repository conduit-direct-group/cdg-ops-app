// Forms that admins edit without code changes (paper forms turned into app features), and Shift Handoff Notes.
// No database code here, so it can be tested on its own. The wording of each form lives only in the database
// (formTemplates), never in this repo.
//
// A form template = sections of fields. Every save makes a new revision (rev number, date, who, "what changed").
// Records (a handoff, a checklist) copy the fields of the revision they were started on, so a later edit never
// changes what someone already filled in or signed. A change applies to the next record started.

const FIELD_TYPES = ["number", "percent", "yesno", "text", "longtext", "datetime", "time"];
const FORM_KINDS = ["handoff"];

// Who writes and reads handoffs (Chris, 10-20-2026: Line Leads, Supervisors, Plant Manager, Admin).
const HANDOFF_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
// Who may sign "received" besides a Line Lead on the incoming team (a backup when no lead is on that team).
const HANDOFF_BACKUP_ROLES = ["supervisor", "plant-manager", "admin"];

const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
const slug = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const isId = (v) => typeof v === "string" && /^[a-z][a-z0-9-]{0,39}$/.test(v);

// Can this person edit this form? Admins always; other roles when the Roles screen lists the form for them.
function canEditForm(roleDocs, myRoles, formId) {
  if ((myRoles || []).includes("admin")) return true;
  return (roleDocs || []).some((r) => r.active !== false && (myRoles || []).includes(r.id) && (r.editForms || []).includes(formId));
}

// A template from the editor or a form file. Returns { template } or { error }.
// Field ids are kept when a field is reworded, so records stay comparable across revisions.
function cleanTemplate(data) {
  const name = clean(data?.name, 80).replace(/\s+/g, " ");
  if (!name) return { error: "The form needs a name." };
  const kind = FORM_KINDS.includes(data?.kind) ? data.kind : null;
  if (!kind) return { error: "Unknown kind of form." };
  const intro = clean(data?.intro, 400);
  if (!Array.isArray(data?.sections) || !data.sections.length || data.sections.length > 30) return { error: "Add 1 to 30 sections." };
  const sectionIds = new Set();
  const fieldIds = new Set();
  const sections = [];
  for (const raw of data.sections) {
    const title = clean(raw?.title, 80).replace(/\s+/g, " ");
    if (!title) return { error: "Every section needs a title." };
    const id = isId(raw?.id) ? raw.id : slug(title);
    if (!isId(id) || sectionIds.has(id)) return { error: `Section “${title}” needs its own name.` };
    sectionIds.add(id);
    if (!Array.isArray(raw?.fields) || !raw.fields.length || raw.fields.length > 40) return { error: `Section “${title}” needs 1 to 40 fields.` };
    const fields = [];
    for (const f of raw.fields) {
      const label = clean(f?.label, 120).replace(/\s+/g, " ");
      if (!label) return { error: `A field in “${title}” has no label.` };
      const fid = isId(f?.id) ? f.id : slug(label);
      if (!isId(fid) || fieldIds.has(fid)) return { error: `Field “${label}” needs its own name (two fields can't share one).` };
      fieldIds.add(fid);
      if (!FIELD_TYPES.includes(f?.type)) return { error: `Pick a type for “${label}”.` };
      fields.push({ id: fid, label, type: f.type, perLine: f.perLine === true, unit: clean(f?.unit, 12), help: clean(f?.help, 400) });
    }
    sections.push({ id, title, help: clean(raw?.help, 400), fields });
  }
  return { template: { name, kind, intro, sections } };
}

// What changed between two revisions, in plain words (shown with the revision when no note is typed).
function describeChange(before, after) {
  if (!before) return "First version";
  const label = (f) => f.label;
  const flat = (t) => t.sections.flatMap((s) => s.fields.map((f) => ({ ...f, section: s.title })));
  const a = new Map(flat(before).map((f) => [f.id, f]));
  const b = new Map(flat(after).map((f) => [f.id, f]));
  const out = [];
  for (const [id, f] of b) if (!a.has(id)) out.push(`added “${label(f)}”`);
  for (const [id, f] of a) if (!b.has(id)) out.push(`removed “${label(f)}”`);
  for (const [id, f] of b) {
    const o = a.get(id);
    if (o && (o.label !== f.label || o.type !== f.type || o.perLine !== f.perLine || o.unit !== f.unit || o.help !== f.help)) out.push(`changed “${label(f)}”`);
  }
  const order = (t) => flat(t).map((f) => f.id).filter((id) => a.has(id) && b.has(id)).join();
  if (!out.length && order(before) !== order(after)) out.push("reordered fields");
  if (!out.length && JSON.stringify(before.sections.map((s) => [s.title, s.help])) !== JSON.stringify(after.sections.map((s) => [s.title, s.help]))) out.push("changed section titles or help");
  if (!out.length && (before.name !== after.name || before.intro !== after.intro)) out.push("changed the name or intro");
  return out.length ? out.join("; ").slice(0, 300) : "No changes";
}

// One filled-in value, checked against its field. Returns { value } (null = left blank) or { error }.
function cleanValue(field, raw) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  switch (field.type) {
    case "number":
    case "percent": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, ""));
      if (!Number.isFinite(n)) return { error: `“${field.label}” must be a number.` };
      if (field.type === "percent" && (n < 0 || n > 100)) return { error: `“${field.label}” is a percent (0–100).` };
      if (Math.abs(n) > 1e9) return { error: `“${field.label}” is too big.` };
      return { value: n };
    }
    case "yesno":
      if (raw === true || raw === "yes") return { value: true };
      if (raw === false || raw === "no") return { value: false };
      return { error: `Answer Yes or No for “${field.label}”.` };
    case "datetime":
      return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? { value: raw } : { error: `“${field.label}” needs a date and time.` };
    case "time":
      return typeof raw === "string" && /^\d{2}:\d{2}$/.test(raw) ? { value: raw } : { error: `“${field.label}” needs a time.` };
    case "text":
      return { value: clean(String(raw), 200) || null };
    case "longtext":
      return { value: clean(String(raw), 4000) || null };
    default:
      return { error: "Unknown field." };
  }
}

// All values of a record against the revision it was started on. Per-line fields hold { [lineId]: value }.
// Unknown fields are dropped. Returns { values } or { error }.
function cleanValues(sections, lines, raw) {
  const values = {};
  const lineIds = (lines || []).map((l) => l.id);
  for (const s of sections || []) {
    for (const f of s.fields || []) {
      const v = raw?.[f.id];
      if (f.perLine) {
        const per = {};
        for (const lineId of lineIds) {
          const r = cleanValue(f, v?.[lineId]);
          if (r.error) return { error: `${(lines.find((l) => l.id === lineId) || {}).name || lineId}: ${r.error}` };
          if (r.value !== null) per[lineId] = r.value;
        }
        if (Object.keys(per).length) values[f.id] = per;
      } else {
        const r = cleanValue(f, v);
        if (r.error) return { error: r.error };
        if (r.value !== null) values[f.id] = r.value;
      }
    }
  }
  return { values };
}

// Handoff header: team, date, incoming team. teamIds = active teams.
function cleanHandoffHeader(data, teamIds) {
  const team = String(data?.team || "");
  const toTeam = String(data?.toTeam || "");
  const date = String(data?.date || "");
  if (!teamIds.includes(team)) return { error: "Pick your team." };
  if (!teamIds.includes(toTeam)) return { error: "Pick the incoming team." };
  if (team === toTeam) return { error: "The incoming team has to be a different team." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return { error: "Pick the date." };
  return { header: { team, toTeam, date } };
}

// Who may sign "received": a Line Lead on the incoming team, or (backup) a Supervisor, Plant Manager, or Admin.
function canReceive(person, handoff) {
  const roles = person?.roles || [];
  if (roles.includes("lead") && person.team === handoff.toTeam) return true;
  return roles.some((r) => HANDOFF_BACKUP_ROLES.includes(r));
}

// The incoming team's Line Leads (they see it on Home and get the notification). employees: [{ id, roles, team, active }]
function incomingLeads(handoff, employees) {
  return employees.filter((e) => e.active !== false && (e.roles || []).includes("lead") && e.team === handoff.toTeam).map((e) => e.id).sort();
}

module.exports = {
  FIELD_TYPES, FORM_KINDS, HANDOFF_ROLES, HANDOFF_BACKUP_ROLES,
  canEditForm, cleanTemplate, describeChange, cleanValue, cleanValues, cleanHandoffHeader, canReceive, incomingLeads,
};
