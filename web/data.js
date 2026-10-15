// Live lists of lines, machines, and roles, shared by every screen.
// They update by themselves within a second of an admin changing them, on every device.

import { db } from "./firebase.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const LISTS = ["roles", "lines", "machines"];

// null = still loading; [] = loaded and empty.
export const data = { roles: null, lines: null, machines: null };

const listeners = new Set();
let stopFns = [];

// "Line 2" before "Line 10"; machines by ID (M-002 before M-010).
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });

function changed() {
  for (const fn of listeners) fn();
}

// Called once signed in with a real PIN (the database refuses temporary-PIN accounts).
export function startData() {
  stopData();
  stopFns = LISTS.map((name) =>
    onSnapshot(
      collection(db, name),
      (snap) => {
        const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        data[name] = rows.sort(name === "machines" ? byId : byName);
        changed();
      },
      (err) => {
        console.warn(`Couldn't load ${name}:`, err.code || err);
        data[name] = data[name] || [];
        changed();
      }
    )
  );
}

export function stopData() {
  stopFns.forEach((stop) => stop());
  stopFns = [];
  for (const name of LISTS) data[name] = null;
}

// Returns a function that stops listening.
export function onDataChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function lineName(lineId) {
  if (!lineId) return "Not on a line";
  return data.lines?.find((l) => l.id === lineId)?.name || "Unknown line";
}
