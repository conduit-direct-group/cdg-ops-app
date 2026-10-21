// Flagged Reels / QC Hold (Chris, 10-21-2026; SOP0012: failed reels stay tagged in QC Staging until next shift).
// No database code here, so it can be tested on its own.
//
//   reels/{auto}   lineId, lineName, winder ("Winder 1" …), tag (reel tag #, free text for now) or noTag, footage,
//                  reasonId, reasonName, product { productId?, size, sdr, color }, photo, note,
//                  status: "flagged" (🏷) → "staged" (in QC Staging) → decision → "reclaim" (♻️ regrind/scrap waiting
//                  on Reclamation) → "done" (✓). Release and Rewind/Rework go straight to done.
//                  flagged {at, by, byName, shiftId, shiftDate}, dueMs (end of the NEXT shift — red after that),
//                  staged {…}, decision { kind, note, by, byName, at, device }, reclaim { footage, segregation, … }
//   Test site: test_reels.
//   meta/reelSettings   reasons [{ id, name, active }], sizes ["3/4\"", …], sdrs ["SDR 11", …] (Admin → QC hold)

const DECIDE_ROLES = ["lead", "quality", "supervisor"];
const WINDERS = ["Winder 1", "Winder 2", "Winder 3"];
const DECISIONS = {
  release: { label: "Release", icon: "✅", next: "done" },
  rework: { label: "Rewind / Rework", icon: "🔁", next: "done" },
  regrind: { label: "Regrind", icon: "♻️", next: "reclaim" },
  scrap: { label: "Scrap", icon: "🗑", next: "reclaim" },
};
// Confirmed by Chris 10-21-2026. Editable in Admin → QC hold; these are only the starting lists.
// Main sizes, each in two walls; specialty sizes are typed in by hand.
const STARTING_SIZES = ["3/4\"", "1\"", "1.25\"", "1.5\"", "2\""];
const STARTING_SDRS = ["SDR 11", "SDR 13.5"];
const STARTING_REASONS = [
  "OD/wall out of spec", "Ovality", "Print missing or faded", "Surface (wood-grain, scuffing)", "Kinks or bends",
  "Wind or tension problem", "Contamination", "Short footage", "Other",
];

const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const canDecide = (roles) => (roles || []).some((r) => DECIDE_ROLES.includes(r));

// A new flagged reel. reasons: the active list from meta/reelSettings. isOurFile(url) for the photo.
// Product: size and SDR from the lists or typed (specialty sizes), color typed (until the scheduling program fills it).
function cleanFlag(raw, { reasons = [], lineIds = [], isOurFile = () => false } = {}) {
  if (!lineIds.includes(raw?.lineId)) return { error: "Pick the line." };
  const winder = WINDERS.includes(raw?.winder) ? raw.winder : "";
  const noTag = raw?.noTag === true;
  const tag = noTag ? "" : clean(raw?.tag, 30);
  if (!noTag && !tag) return { error: "Enter the reel tag #, or tap “No tag yet”." };
  const footage = raw?.footage === "" || raw?.footage == null ? null : Number(raw.footage);
  if (footage !== null && (!Number.isFinite(footage) || footage < 0 || footage > 100000)) return { error: "Footage must be a number." };
  const reason = reasons.find((r) => r.id === raw?.reasonId && r.active !== false);
  if (!reason) return { error: "Pick a reason." };
  const product = { size: clean(raw?.product?.size, 30), sdr: clean(raw?.product?.sdr, 20), color: clean(raw?.product?.color, 30) };
  if (!product.size) return { error: "Pick the size (or type a specialty size)." };
  if (!product.sdr) return { error: "Pick the wall (SDR)." };
  const photo = raw?.photo ? String(raw.photo) : null;
  if (photo && !isOurFile(photo)) return { error: "The photo didn't upload. Add it again." };
  const note = typeof raw?.note === "string" ? raw.note.trim().slice(0, 500) : "";
  if (reason.name === "Other" && !note) return { error: "Add a note saying what's wrong." };
  return { reel: { lineId: raw.lineId, winder, tag, noTag, footage, reasonId: reason.id, reasonName: reason.name, product, photo, note } };
}

function cleanDecision(raw) {
  const kind = Object.prototype.hasOwnProperty.call(DECISIONS, raw?.kind) ? raw.kind : null;
  if (!kind) return { error: "Pick Release, Rewind / Rework, Regrind, or Scrap." };
  const note = typeof raw?.note === "string" ? raw.note.trim().slice(0, 500) : "";
  if (!note) return { error: "Add a note for the decision." };
  return { kind, note };
}

function cleanReclaim(raw) {
  const footage = Number(raw?.footage);
  if (!Number.isFinite(footage) || footage < 0 || footage > 100000) return { error: "Enter the footage reclaimed." };
  const segregation = clean(raw?.segregation, 80);
  if (!segregation) return { error: "Enter the color / grade it was segregated to." };
  return { footage, segregation };
}

// When an undecided reel turns red: the end of the next shift (12-hour shifts → current end + one shift length).
// Without shift times: 24 hours after it was flagged.
function dueAfterNextShift(shiftNow, nowMs) {
  if (shiftNow?.endMs && shiftNow?.startMs) return shiftNow.endMs + (shiftNow.endMs - shiftNow.startMs);
  return nowMs + 24 * 3600000;
}

// Reason list edits from Admin: keep ids (history points at them), new ones get one; at least one active.
function cleanReasons(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 60) return { error: "Add 1 to 60 reasons." };
  const out = [];
  for (const r of raw) {
    const name = clean(r?.name, 60);
    if (!name) return { error: "Every reason needs a name." };
    const id = typeof r?.id === "string" && /^[a-z0-9-]{1,40}$/.test(r.id) ? r.id : slug(name);
    if (!id || out.some((x) => x.id === id)) return { error: `“${name}” is listed twice.` };
    out.push({ id, name, active: r?.active !== false });
  }
  if (!out.some((r) => r.active)) return { error: "Keep at least one reason on." };
  return { reasons: out };
}

// Size or SDR list from Admin: 1–40 short names, no repeats.
function cleanChoices(raw, what) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 40) return { error: `Add 1 to 40 ${what}.` };
  const out = [];
  for (const v of raw) {
    const name = clean(v, 30);
    if (!name) continue;
    if (out.some((x) => x.toLowerCase() === name.toLowerCase())) return { error: `“${name}” is listed twice.` };
    out.push(name);
  }
  return out.length ? { list: out } : { error: `Add at least one of the ${what}.` };
}

module.exports = { DECIDE_ROLES, WINDERS, DECISIONS, STARTING_REASONS, STARTING_SIZES, STARTING_SDRS, slug, canDecide, cleanFlag, cleanDecision, cleanReclaim, dueAfterNextShift, cleanReasons, cleanChoices };
