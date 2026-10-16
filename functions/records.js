// Rules for lines, machines, and roles ("lines are data, not code" — Plan §5).
// No database code here, so it can be tested on its own.

// Machine IDs are plant-wide and permanent: M-001, M-002, ... M-999, M-1000.
// The line a machine sits on is stored separately, so moving a machine never changes its ID.
function machineIdFor(number) {
  return `M-${String(number).padStart(3, "0")}`;
}

function isMachineId(value) {
  return typeof value === "string" && /^M-\d{3,}$/.test(value);
}

// Short required text (names): trimmed, single spaces, 1..max characters.
function cleanName(value, max = 60) {
  if (typeof value !== "string") return null;
  const s = value.trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length <= max ? s : null;
}

// Optional text (machine type): same cleanup, empty becomes "".
function cleanOptional(value, max = 60) {
  if (value == null || value === "") return "";
  return cleanName(value, max);
}

// Turns a name into a permanent record id, e.g. "Line 3" -> "line-3", "Maintenance" -> "maintenance".
function idFromName(name) {
  const id = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return /^[a-z][a-z0-9_-]{0,29}$/.test(id) ? id : null;
}

function isRecordId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,29}$/.test(value);
}

// Optional notes (machines): keeps line breaks, trims, empty becomes "". null = too long.
function cleanNotes(value, max = 1000) {
  if (value == null) return "";
  if (typeof value !== "string") return null;
  const s = value.replace(/\r\n/g, "\n").trim();
  return s.length <= max ? s : null;
}

// The app hands out employee numbers: the lowest number from 1001 up that has never been used.
// Turned-off people keep their number (nobody is ever deleted), so a number is never handed out twice.
// Odd numbers typed by hand (e.g. a 9000 test account) don't push the next one up.
function nextEmployeeNumber(numbers) {
  const used = new Set(numbers.map(String));
  let n = 1001;
  while (used.has(String(n))) n++;
  return String(n);
}

module.exports = { machineIdFor, isMachineId, cleanName, cleanOptional, cleanNotes, nextEmployeeNumber, idFromName, isRecordId };
