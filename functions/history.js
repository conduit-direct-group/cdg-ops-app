// Change history (Chris, 10-27-2026, Decision 120): nothing is overwritten without a record. No database code here,
// so it can be tested on its own. index.js keepHistory() saves what diff() returns:
//
//   changeHistory/{auto}   collection, docId, action ("update" | "delete"), old { field: value }, new { field: value }
//                          (only the fields that changed; all of them on delete), by (employee #, or "system:<job>"),
//                          byName, at (server time). Test site: test_changeHistory. Read only by the server.

const SKIP = new Set(["updatedAt", "updatedAtMs", "updatedBy", "updatedByName", "syncedAt"]); // bookkeeping, not content
const MAX_JSON = 20000; // a value bigger than this is noted, not copied (versions / revisions keep those)

// Firestore values → plain JSON (timestamps as ISO text). Write-only markers (serverTimestamp, arrayUnion …) → undefined.
function plain(v) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v?.toDate === "function") return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && v.constructor && !["Object", "Array"].includes(v.constructor.name)) return undefined; // FieldValue
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]).filter(([, x]) => x !== undefined));
  return v;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const capped = (v) => (v !== undefined && JSON.stringify(v ?? null).length > MAX_JSON ? "(too large to copy — see the record's versions)" : v);

// before: the record as it was (null if new). after: the fields being written (null = deleted).
// Dotted keys ("none.downtime") are compared against the nested value. → { old, new } or null when nothing changed.
function diff(before, after) {
  const b = before || {};
  if (after === null) {
    const old = plain(b);
    return old && Object.keys(old).length ? { old: Object.fromEntries(Object.entries(old).map(([k, v]) => [k, capped(v)])), new: null } : null;
  }
  const out = { old: {}, new: {} };
  for (const [key, raw] of Object.entries(after || {})) {
    if (SKIP.has(key)) continue;
    const isDelete = raw?.constructor?.name === "DeleteTransform"; // FieldValue.delete()
    const next = isDelete ? null : plain(raw);
    if (next === undefined) continue; // a write-only marker: nothing to compare
    const prev = plain(key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), b)) ?? null;
    if (same(prev, next)) continue;
    out.old[key] = capped(prev);
    out.new[key] = capped(next);
  }
  return Object.keys(out.old).length ? out : null;
}

// A map field compared key by key ("values.f1", "marks.9001"), so a save keeps only what changed in it.
function spread(prefix, before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return Object.fromEntries([...keys].map((k) => [`${prefix}.${k}`, (after || {})[k] ?? null]));
}

// A whole record: its object fields compared key by key (spread), everything else as is.
function flatten(before, after) {
  const isMap = (v) => v && typeof v === "object" && !Array.isArray(v) && (v.constructor?.name === "Object");
  const out = {};
  for (const [k, v] of Object.entries(after || {})) {
    if (isMap(v) || isMap(before?.[k])) Object.assign(out, spread(k, isMap(before?.[k]) ? before[k] : {}, isMap(v) ? v : {}));
    else out[k] = v;
  }
  return out;
}

module.exports = { diff, plain, spread, flatten, SKIP };
