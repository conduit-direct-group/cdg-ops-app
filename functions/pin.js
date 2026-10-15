// PIN rules and scrambling (hashing). No database code here, so it can be tested on its own.
//
// PINs are never stored. We store a scrypt hash plus a random "salt" per person.
// scrypt is deliberately slow, which makes guessing PINs from a leaked hash expensive.

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);

const MAX_WRONG_TRIES = 5;
const LOCK_MINUTES = 15;
const KEY_LENGTH = 32;

function isValidPinFormat(pin) {
  return typeof pin === "string" && /^\d{6}$/.test(pin);
}

// Too easy to guess: 000000, 111111, 123456, 654321, etc.
function isWeakPin(pin) {
  return /^(\d)\1{5}$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin);
}

// Employee numbers: letters, digits, dashes, up to 12 characters. Stored uppercase.
function normalizeEmployeeNumber(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const s = String(value).trim().toUpperCase();
  return /^[A-Z0-9-]{1,12}$/.test(s) ? s : null;
}

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const s = value.trim().replace(/\s+/g, " ");
  return s.length >= 1 && s.length <= 60 ? s : null;
}

// Role ids like "operator", "maintenance", "admin". Roles are data, so any well-formed id is allowed.
function normalizeRoles(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return null;
  const roles = [...new Set(value.map((r) => (typeof r === "string" ? r.trim().toLowerCase() : "")))];
  return roles.every((r) => /^[a-z][a-z0-9_-]{0,29}$/.test(r)) ? roles : null;
}

async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pin, salt, KEY_LENGTH);
  return { hash: key.toString("base64"), salt: salt.toString("base64") };
}

async function pinMatches(pin, record) {
  const expected = Buffer.from(record.hash, "base64");
  const actual = await scrypt(pin, Buffer.from(record.salt, "base64"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Temporary PIN an admin reads out to a new hire (or after a reset). Never a weak one.
function randomTempPin() {
  let pin;
  do {
    pin = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  } while (isWeakPin(pin));
  return pin;
}

function lockStatus(record, nowMs) {
  const until = record.lockedUntilMs || 0;
  return until > nowMs
    ? { locked: true, minutesLeft: Math.ceil((until - nowMs) / 60000) }
    : { locked: false };
}

// What the PIN record looks like after one more wrong try. The 5th wrong try locks for 15 minutes.
function afterWrongPin(record, nowMs) {
  const wrongCount = (record.wrongCount || 0) + 1;
  if (wrongCount >= MAX_WRONG_TRIES) {
    return { wrongCount: 0, lockedUntilMs: nowMs + LOCK_MINUTES * 60000, justLocked: true };
  }
  return { wrongCount, lockedUntilMs: null, justLocked: false };
}

module.exports = {
  MAX_WRONG_TRIES,
  LOCK_MINUTES,
  isValidPinFormat,
  isWeakPin,
  normalizeEmployeeNumber,
  normalizeName,
  normalizeRoles,
  hashPin,
  pinMatches,
  randomTempPin,
  lockStatus,
  afterWrongPin,
};
