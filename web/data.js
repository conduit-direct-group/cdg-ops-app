// Live lists shared by every screen: lines, machines, roles, fix categories, fixes, open issues, checklists.
// They update by themselves within a second of a change, on every device, and keep an offline copy.
//
// Test mode (dev test site): practice records from the test_ collections are shown next to the real ones
// (marked TEST), and practice checklist sign-offs sit on top of the real due dates. The live app never reads them.

import { db, TEST_MODE } from "./firebase.js";
import { collection, doc, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const LISTS = ["roles", "lines", "machines", "fixCategories", "checklistTemplates", "requestTypes", "teams", "machineTypes", "formTemplates", "refDocs"];

// null = still loading; [] = loaded and empty.
// myself = my own employee record (live roles). fixes = approved fixes; myFixes = pending suggestions I can see
// (admins: everyone's; others: my own). openIssues = open breakdowns (line down first, newest first).
// checklistUnits = { [unitId]: { [itemId]: { at, by, byName } } } — when each checklist item was last done.
// openIssues: Maintenance and Admin only (others: []). myIssues = maintenance requests I reported (to follow
// their status). requestsForMe = "Need something?" requests sent to me (admins: every open one);
// requestsSent = the ones I sent. plantStatus = { down: { lineId: { since, machineIds } } } (lines with an open
// line-down report; test site: real + practice). urgentRequests = open urgent requests (safety concerns) —
// Supervisor, Training & Safety, Plant Manager, Admin only (others: []).
// announcements = the ones meant for me, plus the ones I track (poster, supervisors); Plant Manager, Office, Admin:
// all of them (newest first; test site: practice ones too, marked TEST). mySigs = { [annId]: { [version]: sig } }
// — my own "Read & understood" signatures.
export const data = {
  myself: null, roles: null, teams: null, machineTypes: null, lines: null, machines: null, fixCategories: null, checklistTemplates: null, requestTypes: null,
  fixes: null, myFixes: null, openIssues: null, myIssues: null, checklistUnits: null, requestsForMe: null, requestsSent: null,
  plantStatus: null, urgentRequests: null, announcements: null, mySigs: null, mySigList: null, formTemplates: null, handoffsOpen: null, shopLists: null, stationLists: null, lineLogs: null, plantLogs: null, refDocs: null,
  machineSpecs: null, machineSpecsError: false,
};

const listeners = new Set();
let stopFns = [];
const parts = {}; // real and test halves of the merged lists

// "Line 2" before "Line 10"; machines by ID (M-002 before M-010).
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
const byId = (a, b) => a.id.localeCompare(b.id, undefined, { numeric: true });
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true });
const time = (t) => (t?.toMillis ? t.toMillis() : 0);
const lineDownFirst = (a, b) => (b.lineDown === true) - (a.lineDown === true) || time(b.reportedAt) - time(a.reportedAt);
// Requests: not-done first, urgent first, newest first.
const requestOrder = (a, b) => (a.status === "done") - (b.status === "done") || (b.urgent === true) - (a.urgent === true) || time(b.createdAt) - time(a.createdAt);

function changed() {
  for (const fn of listeners) fn();
}

function listen(source, onDocs, label) {
  return onSnapshot(
    source,
    (snap) => onDocs(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => {
      console.warn(`Couldn't load ${label}:`, err.code || err);
      onDocs(null);
    }
  );
}

function watch(name, source, sort) {
  return listen(source, (docs) => {
    data[name] = docs ? docs.sort(sort) : data[name] || [];
    changed();
  }, name);
}

// A list made of the real records plus (test mode) the practice ones, each tagged test: true.
function watchMerged(name, realSource, testSource, sort) {
  const merge = () => {
    if (parts[`${name}:real`] === undefined || (TEST_MODE && parts[`${name}:test`] === undefined)) return;
    data[name] = [...(parts[`${name}:real`] || []), ...(parts[`${name}:test`] || []).map((x) => ({ ...x, test: true }))].sort(sort);
    changed();
  };
  const stops = [listen(realSource, (docs) => { parts[`${name}:real`] = docs || []; merge(); }, name)];
  if (TEST_MODE) stops.push(listen(testSource, (docs) => { parts[`${name}:test`] = docs || []; merge(); }, `test ${name}`));
  return () => stops.forEach((s) => s());
}

// Checklist due dates: real sign-offs, with test-site practice sign-offs on top (test mode only).
function watchChecklistUnits() {
  const merge = () => {
    if (parts["units:real"] === undefined || (TEST_MODE && parts["units:test"] === undefined)) return;
    const out = {};
    for (const u of parts["units:real"] || []) out[u.id] = { ...(u.items || {}) };
    for (const u of parts["units:test"] || []) {
      out[u.id] = { ...(out[u.id] || {}) };
      for (const [k, v] of Object.entries(u.items || {})) {
        if (!out[u.id][k] || (v.at || 0) > (out[u.id][k].at || 0)) out[u.id][k] = { ...v, test: true };
      }
    }
    data.checklistUnits = out;
    changed();
  };
  const stops = [listen(collection(db, "checklistUnits"), (docs) => { parts["units:real"] = docs || []; merge(); }, "checklists")];
  if (TEST_MODE) stops.push(listen(collection(db, "test_checklistUnits"), (docs) => { parts["units:test"] = docs || []; merge(); }, "test checklists"));
  return () => stops.forEach((s) => s());
}

// Called once signed in with a real PIN (the database refuses temporary-PIN accounts).
// `me` = { emp, approver, admin, fixer, issueViewer, safetyWatcher } — decides which pending fixes, issues, and requests this person may see.
export function startData(me) {
  stopData();
  stopFns = LISTS.map((name) => watch(name, collection(db, name), name === "machines" ? byId : byName));
  stopFns.push(
    onSnapshot(
      doc(db, "employees", me.emp),
      (snap) => { data.myself = snap.exists() ? snap.data() : { roles: [], active: false }; changed(); },
      () => {} // keep the sign-in pass roles if this can't be read
    )
  );
  const fixQuery = (name) => query(collection(db, name), where("status", "==", "approved"));
  const mineQuery = (name) =>
    me.approver ? query(collection(db, name), where("status", "==", "pending")) : query(collection(db, name), where("createdBy", "==", me.emp));
  stopFns.push(watchMerged("fixes", fixQuery("fixes"), fixQuery("test_fixes"), byTitle));
  stopFns.push(watchMerged("myFixes", mineQuery("fixes"), mineQuery("test_fixes"), byTitle));
  if (me.fixer || me.issueViewer) {
    const openQuery = (name) => query(collection(db, name), where("open", "==", true));
    stopFns.push(watchMerged("openIssues", openQuery("issues"), openQuery("test_issues"), lineDownFirst));
  } else {
    data.openIssues = []; // the board is for Maintenance and Admin (the database refuses others too)
  }
  data.myIssues = []; // Open issues are for Maintenance, Admin, Plant Manager only (Decision 54)
  const forMe = (name) =>
    me.admin ? query(collection(db, name), where("status", "in", ["open", "in-progress"])) : query(collection(db, name), where("recipients", "array-contains", me.emp));
  stopFns.push(watchMerged("requestsForMe", forMe("requests"), forMe("test_requests"), requestOrder));
  const sent = (name) => query(collection(db, name), where("createdBy", "==", me.emp));
  stopFns.push(watchMerged("requestsSent", sent("requests"), sent("test_requests"), requestOrder));
  stopFns.push(watchChecklistUnits());
  // Machines — parts & specs: Maintenance, Plant Manager, Admin (and roles allowed in Admin → Roles). Others: refused → [].
  stopFns.push(onSnapshot(collection(db, "machineSpecs"),
    (snap) => { data.machineSpecs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); data.machineSpecsError = false; changed(); },
    (err) => { data.machineSpecs = data.machineSpecs || []; data.machineSpecsError = err.code !== "permission-denied"; changed(); }));
  stopFns.push(watchAnnouncements(me));
  // Shift handoffs not yet received (drafts and sent ones) — Line Leads, Supervisors, Plant Manager, Admin.
  if ((me.roles || []).some((r) => ["lead", "supervisor", "plant-manager", "admin"].includes(r))) {
    const open = (name) => query(collection(db, name), where("status", "in", ["draft", "sent"]));
    stopFns.push(watchMerged("handoffsOpen", open("handoffs"), open("test_handoffs"), (a, b) => String(b.date).localeCompare(String(a.date))));
  } else {
    data.handoffsOpen = [];
  }
  // Keep the Shop Clean: recent shift lists (leads and managers see all; everyone else, the ones they have a task on).
  const sinceDay = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const shopQuery = (name) => ((me.roles || []).some((r) => ["lead", "supervisor", "plant-manager", "admin"].includes(r))
    ? query(collection(db, name), where("date", ">=", sinceDay))
    : query(collection(db, name), where("assignees", "array-contains", me.emp)));
  const recent = (name) => query(collection(db, name), where("date", ">=", sinceDay));
  stopFns.push(watchMerged("lineLogs", recent("lineLogs"), recent("test_lineLogs"), (a, b) => (b.startMs || 0) - (a.startMs || 0)));
  stopFns.push(watchMerged("plantLogs", recent("plantLogs"), recent("test_plantLogs"), (a, b) => (b.startMs || 0) - (a.startMs || 0)));
  stopFns.push(watchMerged("stationLists", recent("stationLists"), recent("test_stationLists"), (a, b) => (b.startMs || 0) - (a.startMs || 0)));
  stopFns.push(watchMerged("shopLists", shopQuery("shopTasks"), shopQuery("test_shopTasks"), (a, b) => (b.startMs || 0) - (a.startMs || 0)));
  stopFns.push(watchMySigs(me));
  stopFns.push(watchPlantStatus());
  if (me.safetyWatcher) {
    const urgent = (name) => query(collection(db, name), where("urgent", "==", true));
    stopFns.push(watchMerged("urgentRequests", urgent("requests"), urgent("test_requests"), requestOrder));
  } else {
    data.urgentRequests = [];
  }
}

// Several queries make one list (no duplicates); test-site ones are tagged test: true.
function watchUnion(name, sources, sort, after = null) {
  const merge = () => {
    if (sources.some((x) => parts[x.key] === undefined)) return;
    const byId = new Map();
    for (const x of sources) for (const d of parts[x.key] || []) byId.set(d.id, x.test ? { ...d, test: true } : d);
    data[name] = [...byId.values()].sort(sort);
    after?.();
    changed();
  };
  const stops = sources.map((x) => listen(x.source, (docs) => { parts[x.key] = docs || []; merge(); }, x.key));
  return () => stops.forEach((stop) => stop());
}

const SEES_ALL_ANNOUNCEMENTS = ["admin", "plant-manager", "office"];

function watchAnnouncements(me) {
  const all = (me.roles || []).some((r) => SEES_ALL_ANNOUNCEMENTS.includes(r));
  const sources = [];
  for (const test of TEST_MODE ? [false, true] : [false]) {
    const c = collection(db, test ? "test_announcements" : "announcements");
    const t = test ? "test " : "";
    if (all) sources.push({ key: `${t}announcements`, source: c, test });
    else {
      sources.push({ key: `${t}announcements for me`, source: query(c, where("audienceEmps", "array-contains", me.emp)), test });
      sources.push({ key: `${t}announcements I track`, source: query(c, where("trackers", "array-contains", me.emp)), test });
    }
  }
  return watchUnion("announcements", sources, (a, b) => time(b.createdAt) - time(a.createdAt));
}

function watchMySigs(me) {
  const sources = (TEST_MODE ? [false, true] : [false]).map((test) => ({
    key: `${test ? "test " : ""}my signatures`, test,
    source: query(collection(db, test ? "test_announcementSigs" : "announcementSigs"), where("emp", "==", me.emp)),
  }));
  return watchUnion("mySigList", sources, (a, b) => time(b.at) - time(a.at), () => {
    const out = {};
    for (const sig of data.mySigList) (out[sig.annId] ||= {})[sig.version] = sig;
    data.mySigs = out;
  });
}

// Plant status bar: lines down (real), plus practice line-down reports on the test site.
function watchPlantStatus() {
  const merge = () => {
    if (parts["plant:real"] === undefined || (TEST_MODE && parts["plant:test"] === undefined)) return;
    const down = { ...(parts["plant:real"]?.down || {}) };
    for (const [lineId, v] of Object.entries(parts["plant:test"]?.down || {})) {
      down[lineId] = down[lineId] ? { since: Math.min(down[lineId].since || v.since, v.since || down[lineId].since), machineIds: [...new Set([...down[lineId].machineIds, ...v.machineIds])] } : { ...v, test: true };
    }
    data.plantStatus = { down, unknown: (parts["plant:real"]?.unknown || 0) + (parts["plant:test"]?.unknown || 0) };
    changed();
  };
  const one = (path, key) => onSnapshot(doc(db, ...path), (snap) => { parts[key] = snap.exists() ? snap.data() : null; merge(); }, () => { parts[key] = null; merge(); });
  const stops = [one(["meta", "plantStatus"], "plant:real")];
  if (TEST_MODE) stops.push(one(["test_meta", "plantStatus"], "plant:test"));
  return () => stops.forEach((x) => x());
}

export function stopData() {
  stopFns.forEach((stop) => stop());
  stopFns = [];
  for (const k of Object.keys(parts)) delete parts[k];
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
