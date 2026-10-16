// Fix Library rules (Plan Decisions 25–28). No database code here, so it can be tested on its own.

// Roles that can approve fixes and edit approved ones directly (Decision 27, updated: admins only,
// like the old library). Everyone else's new fixes and edits wait for an admin.
const APPROVER_ROLES = ["admin"];

function isApprover(roles) {
  return Array.isArray(roles) && roles.some((r) => APPROVER_ROLES.includes(r));
}

// Old library categories -> machine types in the app (Decision 26). Same mapping the old library used
// for its last-PM panel. Categories with no machine types (Procedures, Pipe Quality, …) are general topics.
const OLD_CATEGORY_TYPES = {
  extruder: ["Extruder"],
  barrels: ["Extruder"],
  "vacuum tank": ["Vacuum Tank"],
  "cooling tanks": ["Cooling Tank"],
  chiller: ["Chilling/Main Water Supply"],
  die: ["Die"],
  "air compressor": ["Air Compressor"],
  receiver: ["Loader/Receiver/Mixer"],
  mixer: ["Loader/Receiver/Mixer"],
  loader: ["Loader/Receiver/Mixer"],
  laser: ["Laser/Ink Jet"],
  inkjet: ["Laser/Ink Jet"],
  puller: ["Puller"],
  winder: ["Winder"],
  grinder: ["Grinder"],
};

function machineTypesForOldCategory(name) {
  return OLD_CATEGORY_TYPES[String(name).trim().toLowerCase()] || [];
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const s = value.replace(/\r\n/g, "\n").trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

// Short labels: tags, single-line.
function cleanTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const tags = [...new Set(value.map((t) => (typeof t === "string" ? t.trim().replace(/\s+/g, " ") : "")).filter(Boolean))];
  return tags.every((t) => t.length <= 40) ? tags : null;
}

// Links to photos, videos, documents: https only (Firebase Storage, SharePoint, YouTube, …).
function isLink(value) {
  if (typeof value !== "string" || value.length > 2000) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function cleanLinks(value, max = 20) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const links = [...new Set(value.map((l) => (typeof l === "string" ? l.trim() : "")).filter(Boolean))];
  return links.every(isLink) ? links : null;
}

function cleanDocLink(value) {
  if (value == null || value === "") return "";
  const s = String(value).trim();
  return isLink(s) ? s : null;
}

// The fields a person can set on a fix. Returns { fix } or { error } (plain-English message).
function cleanFix(data) {
  const title = cleanText(data?.title, 120);
  if (!title) return { error: "Title is required (120 characters max)." };
  const body = cleanText(data?.body, 10000);
  if (!body) return { error: "Write up the fix — symptom, cause, and steps (10,000 characters max)." };
  if (typeof data?.categoryId !== "string" || !data.categoryId) return { error: "Pick a category." };
  const tags = cleanTags(data?.tags);
  if (!tags) return { error: "Tags: up to 20, each 40 characters max." };
  const photos = cleanLinks(data?.photos);
  const videos = cleanLinks(data?.videos);
  if (!photos || !videos) return { error: "Photo and video links must be full https:// links (20 max each)." };
  const docLink = cleanDocLink(data?.docLink);
  if (docLink === null) return { error: "Document link must be a full https:// link." };
  const machineIds = data?.machineIds == null ? [] : data.machineIds;
  if (!Array.isArray(machineIds) || machineIds.length > 50 || !machineIds.every((m) => /^M-\d{3,}$/.test(m))) {
    return { error: "Unknown machine ID." };
  }
  return { fix: { title, body, categoryId: data.categoryId, tags, photos, videos, docLink, machineIds: [...new Set(machineIds)] } };
}

// Firestore REST "typed" values (how the old library's data comes back) -> plain values.
function plainValue(v) {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(plainValue);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, plainValue(x)]));
  return null;
}

// Is this a file stored in the old library's own Firebase Storage (to be copied, Decision 28)?
function isOldLibraryFile(url) {
  return typeof url === "string" && url.startsWith("https://firebasestorage.googleapis.com/v0/b/line-library.");
}

// "…/o/uploads%2F1788_5139_OZTW3968.MOV?alt=media&token=…" -> "1788_5139_OZTW3968.MOV"
function oldFileName(url) {
  const encoded = url.split("/o/")[1]?.split("?")[0] || "";
  return decodeURIComponent(encoded).split("/").pop().replace(/[^A-Za-z0-9._-]/g, "_") || "file";
}

// Searches with no results: lowercase, single spaces, 3–80 characters.
function cleanSearchTerm(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase().replace(/\s+/g, " ");
  return s.length >= 3 && s.length <= 80 ? s : null;
}

// One record per search term: "die heater" -> "die-heater".
function searchGapId(term) {
  return term.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "term";
}

// ---- Trash bin and version history -------------------------------------------------

const TRASH_DAYS = 30;

// Our own uploaded files (not SharePoint/YouTube links): "…/v0/b/<bucket>/o/<path>?…" -> "<path>".
function storagePath(url, bucketName) {
  if (typeof url !== "string") return null;
  const m = url.match(/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?]+)/);
  if (!m || (bucketName && m[1] !== bucketName)) return null;
  return decodeURIComponent(m[2]);
}

// Every file link on a fix (photos, videos, document).
function fileLinks(fix) {
  return [...(fix?.photos || []), ...(fix?.videos || []), ...(fix?.docLink ? [fix.docLink] : [])];
}

// Our own files that were on `before` but aren't on `after` — they go to the trash bin, not away.
function droppedFiles(before, after, bucketName) {
  const kept = new Set(fileLinks(after));
  return [...new Set(fileLinks(before))].filter((u) => !kept.has(u) && storagePath(u, bucketName));
}

// The part of a fix saved in its version history.
const VERSION_FIELDS = ["title", "body", "categoryId", "tags", "photos", "videos", "docLink", "machineIds", "status"];
function versionOf(fix) {
  return Object.fromEntries(VERSION_FIELDS.map((k) => [k, fix?.[k] ?? null]));
}

module.exports = {
  TRASH_DAYS,
  storagePath,
  fileLinks,
  droppedFiles,
  VERSION_FIELDS,
  versionOf,
  cleanSearchTerm,
  searchGapId,
  APPROVER_ROLES,
  isApprover,
  machineTypesForOldCategory,
  cleanFix,
  cleanTags,
  cleanLinks,
  isLink,
  plainValue,
  isOldLibraryFile,
  oldFileName,
};
