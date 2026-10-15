// Talking to CDG's Odoo (maintenance requests). Uses Odoo 19's JSON-2 API: the API key alone
// identifies the account — no login or password is stored anywhere.
// The key lives in Google Secret Manager (ODOO_API_KEY); this file never sees where it came from.

const ODOO_URL = "https://conduit-direct-group.odoo.com";
const ODOO_DB = "conduit-direct-group";

// Calls one Odoo method, e.g. odooCall(key, "maintenance.request", "search_read", { domain, fields }).
// Throws an Error with a plain-English message if Odoo says no.
async function odooCall(apiKey, model, method, args = {}) {
  const res = await fetch(`${ODOO_URL}/json/2/${model}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `bearer ${apiKey}`,
      "X-Odoo-Database": ODOO_DB,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = (body && (body.message || body.name)) || `HTTP ${res.status}`;
    throw new Error(`Odoo ${model}.${method} failed: ${detail}`);
  }
  return body;
}

// Odoo equipment names start with the app's machine ID: "M-019 L3-Extruder" -> "M-019".
function machineIdFromEquipmentName(name) {
  const m = String(name || "").match(/^(M-\d{3,})\s/);
  return m ? m[1] : null;
}

// Severity in the app -> Odoo's star priority (0 Very Low … 3 High) and CDG's "New Priority" field
// (0 Normal, 1 Low, 2 High, 3 Very High).
const SEVERITY = {
  urgent: { label: "Urgent", priority: "3", newPriority: "3" },
  high: { label: "High", priority: "3", newPriority: "2" },
  normal: { label: "Normal", priority: "2", newPriority: "0" },
  low: { label: "Low", priority: "1", newPriority: "1" },
};

// CDG's own Odoo choice lists (Studio fields). Anything else is sent as empty.
const FAILURE_CATEGORIES = ["Bearing", "Belt/Chain", "Sensor", "Air Leak", "Vacuum Issue", "Water Issue", "Motor", "Electrical Fault", "Overheating", "Contamination", "Other"];
const ROOT_CAUSES = ["Mechanical", "Electrical", "Controls", "Pneumatic", "Hydraulic", "Material", "Operator", "Unknown"];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The Odoo request for a problem reported in the app. `report` is already checked; `machine` is the
// app record; `equipmentId`/`teamId` are Odoo ids; `today` is "YYYY-MM-DD" in plant time.
function requestValues(report, machine, equipmentId, equipmentName, teamId, reporterName, today) {
  const sev = SEVERITY[report.severity] || SEVERITY.normal;
  const short = report.description.split("\n")[0].slice(0, 80);
  const rows = [
    ["Machine", `${machine.id} ${machine.name}${report.lineName ? ` (${report.lineName})` : ""}`],
    ["Line down", report.lineDown ? "YES — production stopped" : "No — still running"],
    ["Unsafe to run", report.unsafe ? "YES" : "No"],
    ["Severity", sev.label],
    ["What's wrong", report.description],
    ["Actions already taken", report.actions],
    ["Failure category", report.failureCategory],
    ["Suspected cause", report.rootCause],
    ["Reported by", reporterName],
  ].filter(([, v]) => v);
  const photos = (report.photos || []).map((u, i) => `<a href="${escapeHtml(u)}">Photo ${i + 1}</a>`).join(" · ");
  const description =
    "<p><b>Reported in CDG Ops</b></p><table>" +
    rows.map(([k, v]) => `<tr><td><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v).replace(/\n/g, "<br>")}</td></tr>`).join("") +
    "</table>" +
    (photos ? `<p>${photos}</p>` : "");

  return {
    name: `${report.lineDown ? "⛔ LINE DOWN" : "🚨 Machine issue"} – ${machine.id} ${machine.name} – ${short}`,
    equipment_id: equipmentId,
    maintenance_type: "corrective",
    maintenance_team_id: teamId,
    request_date: today,
    priority: sev.priority,
    description,
    x_studio_equipment_name: equipmentName,
    x_studio_unsafe_to_run: !!report.unsafe,
    x_studio_downtime_related: !!report.lineDown,
    x_studio_selection_field_vm_1jn7t9l2g: sev.newPriority,
    ...(FAILURE_CATEGORIES.includes(report.failureCategory) ? { x_studio_failure_category: report.failureCategory } : {}),
    ...(ROOT_CAUSES.includes(report.rootCause) ? { x_studio_root_cause: report.rootCause } : {}),
  };
}

// Checks what a person sent from the Report a problem form. Returns { report } or { error }.
function cleanReport(data) {
  if (typeof data?.machineId !== "string" || !/^M-\d{3,}$/.test(data.machineId)) return { error: "Pick the machine." };
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (description.length < 3 || description.length > 3000) return { error: "Say what's wrong (3,000 characters max)." };
  if (typeof data.lineDown !== "boolean") return { error: "Is the line down? Pick Yes or No." };
  const severity = SEVERITY[data.severity] ? data.severity : "normal";
  const actions = typeof data.actions === "string" ? data.actions.trim().slice(0, 1000) : "";
  const photos = Array.isArray(data.photos) ? data.photos.filter((u) => typeof u === "string" && u.startsWith("https://")).slice(0, 10) : [];
  return {
    report: {
      machineId: data.machineId,
      description,
      lineDown: data.lineDown,
      unsafe: data.unsafe === true,
      severity,
      actions,
      failureCategory: FAILURE_CATEGORIES.includes(data.failureCategory) ? data.failureCategory : "",
      rootCause: ROOT_CAUSES.includes(data.rootCause) ? data.rootCause : "",
      photos,
    },
  };
}

// HTML from Odoo -> plain text for the app (descriptions are shown as text, never as HTML).
function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<\/td>/gi, "  ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// From closed requests [{ equipment_id: [id, name], maintenance_type, close_date }] ->
// { "M-019": { pm: "2026-10-02", repair: "2026-10-06" }, … } (latest date of each kind).
function lastDatesByMachine(closedRequests) {
  const out = {};
  for (const r of closedRequests) {
    const machineId = machineIdFromEquipmentName(Array.isArray(r.equipment_id) ? r.equipment_id[1] : "");
    if (!machineId || !r.close_date) continue;
    const kind = r.maintenance_type === "preventive" ? "pm" : "repair";
    out[machineId] ||= {};
    if (!out[machineId][kind] || r.close_date > out[machineId][kind]) out[machineId][kind] = r.close_date;
  }
  return out;
}

module.exports = {
  ODOO_URL,
  odooCall,
  machineIdFromEquipmentName,
  SEVERITY,
  FAILURE_CATEGORIES,
  ROOT_CAUSES,
  requestValues,
  cleanReport,
  htmlToText,
  lastDatesByMachine,
};
