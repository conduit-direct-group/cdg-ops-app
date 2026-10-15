// Live lists shared by every screen: lines, machines, roles, fix categories, and fixes.
// They update by themselves within a second of a change, on every device, and keep an offline copy.

import { db } from "./firebase.js";
import { collection, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const LISTS = ["roles", "lines", "machines", "fixCategories"];

// null = still loading; [] = loaded and empty.
// fixes = approved fixes; myFixes = pending suggestions I can see (approvers: everyone's; others: my own).
// openIssues = open breakdowns from Odoo (line down first, newest first).
export const data = { roles: null, lines: null, machines: null, fixCategories: null, fixes: null, myFixes: null, openIssues: null };

const listeners = new Set();
let stopFns = [];

// "Line 2" before "Line 10"; machines by ID (M-002 before M-010).
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true });
const time = (t) => (t?.toMillis ? t.toMillis() : 0);
const lineDownFirst = (a, b) => (b.lineDown === true) - (a.lineDown === true) || time(b.reportedAt) - time(a.reportedAt);

function changed() {
  for (const fn of listeners) fn();
}

function watch(name, source, sort) {
  return onSnapshot(
    source,
    (snap) => {
      data[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(sort);
      changed();
    },
    (err) => {
      console.warn(`Couldn't load ${name}:`, err.code || err);
      data[name] = data[name] || [];
      changed();
    }
  );
}

// Called once signed in with a real PIN (the database refuses temporary-PIN accounts).
// `me` = { emp, approver } — decides which pending fixes this person may see.
export function startData(me) {
  stopData();
  stopFns = LISTS.map((name) => watch(name, collection(db, name), name === "machines" ? byId : byName));
  const fixes = collection(db, "fixes");
  stopFns.push(watch("fixes", query(fixes, where("status", "==", "approved")), byTitle));
  stopFns.push(
    watch(
      "myFixes",
      me.approver ? query(fixes, where("status", "==", "pending")) : query(fixes, where("createdBy", "==", me.emp)),
      byTitle
    )
  );
  stopFns.push(watch("openIssues", query(collection(db, "issues"), where("open", "==", true)), lineDownFirst));
}

export function stopData() {
  stopFns.forEach((stop) => stop());
  stopFns = [];
  for (const name of Object.keys(data)) data[name] = null;
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
