// Live lists shared by every screen: lines, machines, roles, fix categories, fixes, open issues, checklists.
// They update by themselves within a second of a change, on every device, and keep an offline copy.
//
// Test mode (dev test site): practice records from the test_ collections are shown next to the real ones
// (marked TEST), and practice checklist sign-offs sit on top of the real due dates. The live app never reads them.

import { db, TEST_MODE } from "./firebase.js";
import { collection, doc, getDoc, onSnapshot, query, where } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { batch } from "./batch.js";

const LISTS = ["roles", "lines", "machines", "fixCategories", "checklistTemplates", "requestTypes", "teams", "machineTypes", "formTemplates", "refDocs"];

// null = still loading; [] = loaded and empty.
// myself = my own employee record (live roles). fixes = approved fixes; myFixes = pending suggestions I can see
// (admins: everyone's; others: my own). openIssues = open breakdowns (line down first, newest first).
// checklistUnits = { [unitId]: { [itemId]: { at, by, byName } } } — when each checklist item was last done.
// openIssues: Maintenance and Admin only (others: []). myIssues = maintenance requests I reported (to follow
// their status). requestsForMe = "Need something?" requests sent to me (admins: every open one);
// requestsSent = the ones I sent. plantStatus = { down: { lineId: { since, machineIds } } } (lines with an open
// line-down report; test site: real + practice). urgentRequests = open urgent requests (safety concerns) —
// Supervisor, Training & Safety, Production Manager, Admin only (others: []).
// announcements = the ones meant for me, plus the ones I track (poster, supervisors); Production Manager, Office, Admin:
// all of them (newest first; test site: practice ones too, marked TEST). mySigs = { [annId]: { [version]: sig } }
// — my own "Read & understood" signatures.
export const data = {
  myself: null, roles: null, teams: null, machineTypes: null, lines: null, machines: null, fixCategories: null, checklistTemplates: null, requestTypes: null,
  fixes: null, myFixes: null, openIssues: null, myIssues: null, checklistUnits: null, requestsForMe: null, requestsSent: null,
  plantStatus: null, urgentRequests: null, announcements: null, mySigs: null, mySigList: null, formTemplates: null, handoffsOpen: null, shopLists: null, stationLists: null, lineLogs: null, plantLogs: null, refDocs: null,
  machineSpecs: null, machineSpecsError: false, siloLevels: null, siloSettings: null,
  openReels: null, recentReels: null, reelSettings: null, callSheet: null, callTaps: null,
  openIncidents: null, recentIncidents: null, myIncidentActions: null, rotation: null,
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

// Every listener calls this; the screens redraw once per burst, not once per listener (batch.js).
const changed = batch(() => { for (const fn of listeners) fn(); });

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
    // checklistPending = { [unitId]: [{ id, items, by, byName, at, test? }] } — sign-offs waiting for Verified.
    const pending = {};
    const addPending = (u, test) => {
      for (const [id, p] of Object.entries(u.pending || {})) (pending[u.id] = pending[u.id] || []).push({ id, ...p, ...(test ? { test: true } : {}) });
    };
    // Pending sign-offs are verified where they were made: the test site shows only its practice ones.
    for (const u of parts["units:real"] || []) { out[u.id] = { ...(u.items || {}) }; if (!TEST_MODE) addPending(u, false); }
    for (const u of parts["units:test"] || []) {
      out[u.id] = { ...(out[u.id] || {}) };
      for (const [k, v] of Object.entries(u.items || {})) {
        if (!out[u.id][k] || (v.at || 0) > (out[u.id][k].at || 0)) out[u.id][k] = { ...v, test: true };
      }
      addPending(u, true);
    }
    data.checklistUnits = out;
    data.checklistPending = pending;
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
  data.myIssues = []; // Open issues are for Maintenance, Admin, Production Manager only (Decision 54)
  const forMe = (name) =>
    me.admin ? query(collection(db, name), where("status", "in", ["open", "in-progress"])) : query(collection(db, name), where("recipients", "array-contains", me.emp));
  stopFns.push(watchMerged("requestsForMe", forMe("requests"), forMe("test_requests"), requestOrder));
  const sent = (name) => query(collection(db, name), where("createdBy", "==", me.emp));
  stopFns.push(watchMerged("requestsSent", sent("requests"), sent("test_requests"), requestOrder));
  stopFns.push(watchChecklistUnits());
  // Silo levels (test site: practice levels laid over the real ones) and their low lines (Admin → Silo alerts).
  stopFns.push(watchMerged("siloLevels", collection(db, "siloLevels"), collection(db, "test_siloLevels"), byId));
  stopFns.push(onSnapshot(doc(db, "meta", "siloSettings"), (snap) => { data.siloSettings = snap.exists() ? snap.data() : {}; changed(); }, () => { data.siloSettings = {}; changed(); }));
  // Safety reports: open ones and the last 12 months (Training & Safety, Production Manager, Admin — the database refuses
  // everyone else), and my corrective actions (everyone). Shift rotation (which team works when).
  if ((me.roles || []).some((r) => ["training-safety", "plant-manager", "admin"].includes(r))) {
    const openInc = (name) => query(collection(db, name), where("status", "in", ["reported", "investigating", "actions"]));
    stopFns.push(watchMerged("openIncidents", openInc("incidents"), openInc("test_incidents"), (a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)));
    const d = new Date(); d.setMonth(d.getMonth() - 11);
    const since = d.toISOString().slice(0, 7);
    const recentInc = (name) => query(collection(db, name), where("month", ">=", since));
    stopFns.push(watchMerged("recentIncidents", recentInc("incidents"), recentInc("test_incidents"), (a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0)));
  } else {
    data.openIncidents = [];
    data.recentIncidents = [];
  }
  const myActs = (name) => query(collection(db, name), where("ownerEmp", "==", me.emp));
  stopFns.push(watchMerged("myIncidentActions", myActs("incidentActions"), myActs("test_incidentActions"), (a, b) => String(a.due).localeCompare(String(b.due))));
  stopFns.push(onSnapshot(doc(db, "meta", "rotation"), (snap) => { data.rotation = snap.exists() ? snap.data() : {}; changed(); }, () => { data.rotation = {}; changed(); }));
  // Who to Call: the call sheet, and call-button taps from the last day (for the line-down reminder).
  stopFns.push(onSnapshot(doc(db, "meta", "callSheet"), (snap) => { data.callSheet = snap.exists() ? snap.data() : {}; changed(); }, () => { data.callSheet = {}; changed(); }));
  const taps = (name) => query(collection(db, name), where("atMs", ">=", Date.now() - 86400000));
  stopFns.push(watchMerged("callTaps", taps("callTaps"), taps("test_callTaps"), (a, b) => (b.atMs || 0) - (a.atMs || 0)));
  // Flagged reels / QC hold: reels not done yet (everyone — the floor works the list), the last 15 days (Quality,
  // Production Manager, Supervisor, Admin — for their cards), and the reason / size / SDR lists.
  const openReels = (name) => query(collection(db, name), where("status", "in", ["flagged", "staged", "reclaim"]));
  stopFns.push(watchMerged("openReels", openReels("reels"), openReels("test_reels"), (a, b) => (a.dueMs || 0) - (b.dueMs || 0)));
  if ((me.roles || []).some((r) => ["quality", "plant-manager", "supervisor", "admin"].includes(r))) {
    const since = new Date(Date.now() - 15 * 86400000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    const recentReels = (name) => query(collection(db, name), where("flaggedDate", ">=", since));
    stopFns.push(watchMerged("recentReels", recentReels("reels"), recentReels("test_reels"), (a, b) => (b.flaggedAtMs || 0) - (a.flaggedAtMs || 0)));
  } else {
    data.recentReels = [];
  }
  stopFns.push(onSnapshot(doc(db, "meta", "reelSettings"), (snap) => { data.reelSettings = snap.exists() ? snap.data() : {}; changed(); }, () => { data.reelSettings = {}; changed(); }));
  // Machines — parts & specs: Maintenance, Production Manager, Admin (and roles allowed in Admin → Roles). Others: refused → [].
  stopFns.push(onSnapshot(collection(db, "machineSpecs"),
    (snap) => { data.machineSpecs = snap.docs.map((d) => ({ id: d.id, ...d.data() })); data.machineSpecsError = false; changed(); },
    (err) => { data.machineSpecs = data.machineSpecs || []; data.machineSpecsError = err.code !== "permission-denied"; changed(); }));
  stopFns.push(watchAnnouncements(me));
  stopFns.push(watchAnnTasks(me));
  // Shift handoffs not yet received (drafts and sent ones) — Line Leads, Supervisors, Production Manager, Admin.
  if ((me.roles || []).some((r) => ["lead", "supervisor", "plant-manager", "admin"].includes(r))) {
    const open = (name) => query(collection(db, name), where("status", "in", ["draft", "sent"]));
    stopFns.push(watchMerged("handoffsOpen", open("handoffs"), open("test_handoffs"), (a, b) => String(b.date).localeCompare(String(a.date))));
    // Received ones waiting for Verified (two-step sign-off).
    const toVerify = (name) => query(collection(db, name), where("needsVerify", "==", true));
    stopFns.push(watchMerged("handoffsToVerify", toVerify("handoffs"), toVerify("test_handoffs"), (a, b) => String(b.date).localeCompare(String(a.date))));
    // This and last shift's handoffs, any status — the all-shift Home item (Decision 115).
    const since = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const recent = (name) => query(collection(db, name), where("date", ">=", since));
    stopFns.push(watchMerged("handoffsRecent", recent("handoffs"), recent("test_handoffs"), (a, b) => String(b.date).localeCompare(String(a.date))));
  } else {
    data.handoffsOpen = [];
    data.handoffsToVerify = [];
    data.handoffsRecent = [];
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
  stopFns.push(watchMyOpens(me));
  stopFns.push(watchMessages(me));
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

// Announcement tasks: my own; Supervisors, Production Manager, Admins see everyone's; a Line Lead sees only their own
// team's (Chris, 10-23-2026 — same as the database rules). Tasks are made where they're assigned, so the test site
// reads only test_annTasks.
function watchAnnTasks(me) {
  const c = collection(db, TEST_MODE ? "test_annTasks" : "annTasks");
  const mine = { key: "my announcement tasks", source: query(c, where("emp", "==", me.emp)), test: TEST_MODE };
  const assigned = { key: "tasks I assigned", source: query(c, where("assignedBy", "==", me.emp)), test: TEST_MODE }; // Decision 106
  const sort = (a, b) => (a.dueMs || Date.parse(a.dueDate || "") || 0) - (b.dueMs || Date.parse(b.dueDate || "") || 0);
  const sources = [mine, assigned];
  const seesAll = (me.roles || []).some((r) => ["supervisor", "plant-manager", "admin"].includes(r));
  if (!seesAll && (me.roles || []).includes("lead")) {
    let stop = () => {};
    let cancelled = false;
    getDoc(doc(db, "employees", me.emp)).then((snap) => {
      if (cancelled) return;
      const team = snap.exists() ? snap.data()?.team || null : null;
      stop = watchUnion("annTasks", team ? [mine, assigned, { key: "my team's announcement tasks", source: query(c, where("team", "==", team)), test: TEST_MODE }] : [mine, assigned], sort);
    }, () => { if (!cancelled) stop = watchUnion("annTasks", [mine, assigned], sort); });
    return () => { cancelled = true; stop(); };
  }
  if (seesAll) {
    sources.push({ key: "open announcement tasks", source: query(c, where("status", "in", ["open", "done"])), test: TEST_MODE });
    // …and the last 30 days of finished ones, so a signed-off task still shows (green) on its announcement.
    sources.push({ key: "recent announcement tasks", source: query(c, where("createdAt", ">=", new Date(Date.now() - 30 * 86400000))), test: TEST_MODE });
  }
  return watchUnion("annTasks", sources, sort);
}

// Messages (Decision 102): the ones delivered to me and the ones I sent, and what I've read. Messages are made where
// they're sent, so the test site reads only test_ copies.
function watchMessages(me) {
  const c = collection(db, TEST_MODE ? "test_messages" : "messages");
  const seen = collection(db, TEST_MODE ? "test_messagesSeen" : "messagesSeen");
  const stopA = watchUnion("messages", [
    { key: "messages to me", source: query(c, where("recipients", "array-contains", me.emp)), test: TEST_MODE },
    { key: "messages I sent", source: query(c, where("fromEmp", "==", me.emp)), test: TEST_MODE },
  ], (a, b) => (a.atMs || 0) - (b.atMs || 0));
  const stopB = watchUnion("messagesSeen", [{ key: "messages I read", source: query(seen, where("emp", "==", me.emp)), test: TEST_MODE }], () => 0);
  return () => { stopA(); stopB(); };
}

// Important announcements I opened (the crew doesn't sign those) — per person, on every device. Opening one on the
// test site is practice, saved in test_announcementOpens.
function watchMyOpens(me) {
  const c = collection(db, TEST_MODE ? "test_announcementOpens" : "announcementOpens");
  return watchUnion("myOpens", [{ key: "my opened announcements", source: query(c, where("emp", "==", me.emp)), test: TEST_MODE }], () => 0);
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
  changed.cancel();
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
