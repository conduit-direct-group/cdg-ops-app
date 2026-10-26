// Announcements with "Read & understood" sign-off (Decision 58).
//
// Posting: roles allowed in Admin → Roles (starting: Admin, Production Manager, Supervisor, Training & Safety, Office).
// Signing: the "Read & understood" button wakes up only after the whole message has been seen (scrolled to the
// end, attachment opened); then the shared sign-off (tap your name, then your PIN — signoff.js).
// Until signed it stays in "Needs you" on Home (red after the acknowledge-by date; Safety at the very top).
// Tracking (poster, Production Manager, Office, Admin; Supervisors for their crew) comes from the server, because the
// app can't read other people's records: "18 of 24 signed", who hasn't, Remind, Reviewed in person, Print.

import { el, friendlyError, spinner, emptyState, banner, toast, confirmSheet, picker, collapsible } from "./ui.js";
import { data, onDataChange } from "./data.js";
import {
  storage, TEST_MODE, callAnnouncementPeople, callPostAnnouncement, callEndAnnouncement, callSignAnnouncement,
  callRecordReviewedInPerson, callAnnouncementTracking, callRemindAnnouncement, callSignoffPeople,
  callAnnTaskPeople, callAssignAnnouncementTask, callRemoveAnnTask, callMarkAnnouncementOpened,
} from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-storage.js";
import { signOff, signedNote, isLineTablet } from "./signoff.js";
import { offlineSign } from "./outbox.js";
import { taskRow } from "./tasks.js";

// Same as the server (functions/announcements.js).
const DEFAULT_POSTER_ROLES = ["admin", "plant-manager", "supervisor", "training-safety", "office"];
// Priority labels (Chris, 10-23-2026) — separate from the gray / red / green status colors: Normal is plain,
// Important an orange ⚡ badge, Safety a red ⚠ badge.
const PRIORITY = {
  normal: { label: "Normal", tag: "", icon: "📣" },
  important: { label: "⚡ Important", tag: "prio-badge important", icon: "⚡" },
  safety: { label: "⚠ Safety", tag: "prio-badge safety", icon: "⚠" },
};
export const prioBadge = (priority) => (PRIORITY[priority]?.tag ? el("span", { class: PRIORITY[priority].tag }, PRIORITY[priority].label) : null);

// Important: only Line Leads and Supervisors sign ("Read & relayed to crew"); the crew sees it but doesn't sign.
// Normal and Safety: everyone in the audience signs. Same rule as the server (functions/announcements.js).
const RELAY_ROLES = ["lead", "supervisor"];
const isRelay = (a) => a.priority === "important";
const iSign = (a, roles = data.myself?.roles || []) => !isRelay(a) || roles.some((r) => RELAY_ROLES.includes(r));
const signLabel = (a) => (isRelay(a) ? "Read & relayed to crew" : "Read & understood");

export const rolePosts = (role) => (typeof role.canPostAnnouncements === "boolean" ? role.canPostAnnouncements : DEFAULT_POSTER_ROLES.includes(role.id));
// Decision 106: department heads, Admins, and people ticked "Can post announcements" in Admin → People (the server checks too).
export function canPost(myRoles) {
  return (myRoles || []).includes("admin") || data.myself?.deptHead === true || data.myself?.canPost === true;
}

// Plant days ("YYYY-MM-DD", Cedar Rapids time).
export const plantToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fmtDay = (day) => {
  if (!day) return "";
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};
const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : 0);
const fmtWhen = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");

const isEnded = (a, today = plantToday()) => a.ended === true || (!!a.endDate && a.endDate < today);
const isOverdue = (a, today = plantToday()) => !!a.ackBy && a.ackBy < today;
const version = (a) => a.version || 1;
const mySig = (a) => data.mySigs?.[a.id]?.[version(a)] || null;
const signedBefore = (a) => Object.keys(data.mySigs?.[a.id] || {}).map(Number).filter((v) => v < version(a)).sort((x, y) => y - x)[0] || null;

// Still up, meant for me, and not signed (this version). Safety first, then overdue, then soonest due.
export function toSign(emp) {
  if (!data.announcements || !data.mySigs) return [];
  const today = plantToday();
  return data.announcements
    .filter((a) => (a.audienceEmps || []).includes(emp) && !isEnded(a, today) && !mySig(a) && iSign(a))
    .sort((a, b) => (b.priority === "safety") - (a.priority === "safety") || (b.priority === "important") - (a.priority === "important") || isOverdue(b, today) - isOverdue(a, today) || String(a.ackBy).localeCompare(String(b.ackBy)));
}
export const forMeNow = (emp) => (data.announcements || []).filter((a) => (a.audienceEmps || []).includes(emp) && !isEnded(a));

function statusTag(a, emp) {
  if (isEnded(a)) return el("span", { class: "tag" }, "Ended");
  if (!(a.audienceEmps || []).includes(emp)) return null;
  if (mySig(a)) return el("span", { class: "tag ok" }, "✓ Signed");
  if (!iSign(a)) return el("span", { class: "tag" }, "No sign-off needed");
  if (isOverdue(a)) return el("span", { class: "tag off" }, "⚠ Overdue");
  return el("span", { class: "tag warn" }, signedBefore(a) ? "Updated — sign again" : "To sign");
}

export function annRow(a, emp, onclick) {
  const urgent = (a.audienceEmps || []).includes(emp) && !isEnded(a) && !mySig(a) && iSign(a) && (a.priority === "safety" || isOverdue(a));
  return el(
    "button",
    { class: urgent ? "person-row urgent" : "person-row", type: "button", onclick },
    el("span", { class: "person-name" }, `${PRIORITY[a.priority]?.icon || "📣"} ${a.title}`),
    el("span", { class: "person-meta" }, [a.createdByName ? `From ${a.createdByName}` : "", toMs(a.createdAt) ? `posted ${fmtWhen(a.createdAt)}` : "", isEnded(a) ? "" : `acknowledge by ${fmtDay(a.ackBy)}`].filter(Boolean).join(" · ")),
    el("span", { class: "tags" }, prioBadge(a.priority), statusTag(a, emp), a.test ? el("span", { class: "tag test" }, "TEST") : null)
  );
}

// ---- Home item (Decision 66) ----------------------------------------------------------------------------------
// One line on Home: gray = waiting, with its sign-by date; red ⚠ = a Safety announcement waiting, or past its
// acknowledge-by date; green ✓ = all signed. Tapping opens the one to sign (or the list).
// Needs you: only the green "all signed" line. The ones still to read are at the top of Home (announcementBar).
export function announcementItems(emp, onOpen) {
  if (!data.announcements || !data.mySigs) return [];
  if (toSign(emp).length || toSee(emp).length) return [];
  return forMeNow(emp).length ? [{ key: "ann", icon: "📣", title: "Announcements", detail: "all signed", state: "done", onOpen: () => onOpen(null) }] : [];
}

// ---- Tasks (Decision 106): message and announcement tasks share one list and one look — web/tasks.js. ---------------
const ASSIGN_ROLES = ["lead", "supervisor"];
const tasksFor = (annId) => (data.annTasks || []).filter((t) => t.annId === annId && t.status !== "removed");

// Important ones the crew doesn't sign: shown at the top until they open it once (Chris, 10-23-2026). "Opened" is saved
// per person on the server (markAnnouncementOpened), so it clears on all their devices. On a shared line tablet it
// never clears — everyone who uses that tablet still sees it until the announcement ends.
const openedNow = new Set(); // opened on this screen, before the server record arrives
const wasSeen = (emp, a) => openedNow.has(`${a.id}__v${version(a)}`) || (data.myOpens || []).some((o) => o.annId === a.id && o.version === version(a) && o.emp === emp);
function markSeen(emp, a) {
  if (isLineTablet() || wasSeen(emp, a)) return;
  openedNow.add(`${a.id}__v${version(a)}`);
  callMarkAnnouncementOpened({ id: a.id }).catch(() => openedNow.delete(`${a.id}__v${version(a)}`)); // offline: shows again; opens again later
}
const toSee = (emp) => (data.announcements || []).filter((a) => (a.audienceEmps || []).includes(emp) && !isEnded(a) && isRelay(a) && !iSign(a) && (isLineTablet() || !wasSeen(emp, a)));

// Home, right under the name (Chris, 10-23-2026): every announcement still to read, live as soon as it's posted, one
// line each with its priority badge. Safety first, then Important, then overdue, then soonest due. Null when none.
export function announcementBar(emp, onOpen, row) {
  if (!data.announcements || !data.mySigs) return null;
  const items = [
    ...toSign(emp).map((a) => ({
      key: `ann:${a.id}`, icon: PRIORITY[a.priority]?.icon || "📣", badge: prioBadge(a.priority), title: a.title,
      detail: [isOverdue(a) ? `was due ${fmtDay(a.ackBy)}` : a.priority === "safety" ? "read and sign now" : `sign by ${fmtDay(a.ackBy)}`,
        isRelay(a) ? "read & relay to your crew" : ""].filter(Boolean).join(" · "),
      state: a.priority === "safety" || isOverdue(a) ? "late" : "due", onOpen: () => onOpen(a.id),
    })),
    ...toSee(emp).map((a) => ({
      key: `ann-see:${a.id}`, icon: PRIORITY[a.priority]?.icon || "📣", badge: prioBadge(a.priority), title: a.title,
      detail: `${a.createdByName ? `from ${a.createdByName} · ` : ""}tap to read — no sign-off needed`, state: "due", onOpen: () => onOpen(a.id),
    })),
  ];
  if (!items.length) return null;
  return el("section", { class: "ann-bar", "aria-label": "Announcements", "aria-live": "polite" },
    el("h2", { class: "home-h2" }, `📣 Announcements (${items.length})`),
    el("div", { class: "need-list" }, items.map(row)));
}

// A short pop-up the moment a new announcement for me is posted (or one I signed is changed), on any screen.
const known = new Map(); // id → version
let primed = false;
export function noticeNewAnnouncements(emp) {
  if (!data.announcements || !emp) return;
  for (const a of data.announcements) {
    const was = known.get(a.id);
    known.set(a.id, version(a));
    if (!primed || isEnded(a) || !(a.audienceEmps || []).includes(emp) || a.createdBy === emp) continue;
    if (was === undefined) toast(`📣 New announcement: ${a.title}`);
    else if (was !== version(a) && iSign(a)) toast(`📣 Updated — please read again: ${a.title}`);
  }
  primed = true;
}

// ---- upload (photo or PDF) -------------------------------------------------------------------------------------

function upload(file, emp, onProgress) {
  return new Promise((resolve, reject) => {
    const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
    const task = uploadBytesResumable(ref(storage, `uploads/${emp}/${Date.now()}_${safe}`), file, { contentType: file.type });
    task.on("state_changed", (s) => onProgress(Math.round((s.bytesTransferred / s.totalBytes) * 100)), reject, async () => resolve(await getDownloadURL(task.snapshot.ref)));
  });
}

// ===========================================================================
// The Announcements screen: list · read & sign · post/edit · reviewed in person · print.
// ===========================================================================

// me = { emp, name, roles, admin }. startId opens one announcement (from Home or a notification).
// prefill { title, body } opens the post form filled in (e.g. a lessons-learned near miss); onPosted(id) after posting.
export function openAnnouncements(container, { me, startId = null, onExit, prefill = null, onPosted = null }) {
  const ui = {
    view: startId ? "read" : "list", id: startId, back: startId ? "home" : "list",
    busy: false, upload: "", message: "", messageKind: "", retry: null,
    seenEnd: false, openedFile: false, track: null, draft: null, people: null, peopleError: "",
    inPerson: null, search: "", assign: null,
  };
  const find = (id) => (data.announcements || []).find((a) => a.id === id);
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false }); render(); };
  const backBtn = (label, onclick) => el("button", { class: "link-btn no-print", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  function show(view, extra = {}) {
    Object.assign(ui, { view, busy: false, message: "", messageKind: "", retry: null, ...extra });
    render();
    window.scrollTo(0, 0);
  }
  function openOne(id, back = "list") {
    show("read", { id, back, seenEnd: false, openedFile: false, track: null });
  }
  const leaveRead = () => (ui.back === "home" ? onExit() : show("list"));

  // ---- list ----------------------------------------------------------------------------------------------------

  function renderList() {
    const all = data.announcements;
    const loading = !all || !data.mySigs;
    const waiting = loading ? [] : toSign(me.emp);
    const current = loading ? [] : all.filter((a) => !isEnded(a) && (a.audienceEmps || []).includes(me.emp) && (mySig(a) || !iSign(a, me.roles)));
    const tracking = loading ? [] : all.filter((a) => !isEnded(a) && !(a.audienceEmps || []).includes(me.emp));
    const past = loading ? [] : all.filter((a) => isEnded(a));
    return [
      backBtn("Home", onExit),
      el("h1", {}, "📣 Announcements"),
      el("p", { class: "hint" }, "Read each one to the end, then sign “Read & understood” with your PIN."),
      canPost(me.roles) ? el("button", { class: "btn", type: "button", onclick: () => startForm(null) }, "+ Post an announcement") : null,
      banner(ui),
      loading ? spinner("Loading announcements…") : null,
      !loading && !waiting.length && !current.length && !tracking.length && !past.length
        ? emptyState("No announcements yet", "When one is posted for you, it shows here and on your Home screen.")
        : null,
      waiting.length ? [el("h2", {}, `To read and sign (${waiting.length})`), el("div", { class: "person-list" }, waiting.map((a) => annRow(a, me.emp, () => openOne(a.id))))] : null,
      !loading && !waiting.length && (current.length || tracking.length) ? el("p", { class: "message ok" }, "✓ You've signed every announcement meant for you.") : null,
      current.length ? collapsible("ann-current", `✓ Signed or no sign-off needed, still up (${current.length})`, el("div", { class: "person-list" }, current.map((a) => annRow(a, me.emp, () => openOne(a.id))))) : null,
      tracking.length ? collapsible("ann-tracking", `📊 Sign-offs you're tracking (${tracking.length})`, el("div", { class: "person-list" }, tracking.map((a) => annRow(a, me.emp, () => openOne(a.id))))) : null,
      past.length ? collapsible("ann-archive", `🗄 Archive — past announcements (${past.length})`, archive(past)) : null,
    ];
  }

  // Searchable archive. Typing updates only the results (so the keyboard stays up).
  function archive(past) {
    const results = el("div", { class: "person-list" });
    const fill = () => {
      const q = ui.search.trim().toLowerCase();
      const hits = past.filter((a) => !q || [a.title, a.body, a.createdByName].some((t) => String(t || "").toLowerCase().includes(q)));
      results.replaceChildren(...(hits.length ? hits.map((a) => annRow(a, me.emp, () => openOne(a.id))) : [emptyState("Nothing matches", "Try another word.")]));
    };
    fill();
    return [
      el("input", { class: "field search", id: "ann-search", type: "search", placeholder: "Search past announcements", "aria-label": "Search past announcements", value: ui.search, oninput: (e) => { ui.search = e.target.value; fill(); } }),
      results,
    ];
  }

  // ---- read & sign ---------------------------------------------------------------------------------------------

  function canSign(a) {
    return (a.audienceEmps || []).includes(me.emp) && !isEnded(a) && !mySig(a) && iSign(a, me.roles);
  }
  const gateOpen = (a) => ui.seenEnd && (a.file?.kind !== "pdf" || ui.openedFile);

  async function sign(a) {
    const r = await signOff({
      title: signLabel(a),
      what: `${a.title}${version(a) > 1 ? ` · version ${version(a)}` : ""}`,
      me: { emp: me.emp, name: me.name },
      others: async () => (await callSignoffPeople({ kind: "announcement", id: a.id })).data.people,
      action: offlineSign("signAnnouncement", { id: a.id, version: version(a) }, { label: `${signLabel(a)} · ${a.title}`, key: `ann:${a.id}` }),
    });
    if (!r) return;
    toast(signedNote(r, `${r.already ? "Already signed" : "Signed"} — ${r.name}${r.test ? " (test)" : ""}`));
    ui.track = null;
    render();
  }

  // The sign area is redrawn on its own when the end of the message comes into view.
  function signArea(a) {
    if (!canSign(a)) return null;
    const needPdf = a.file?.kind === "pdf" && !ui.openedFile;
    const ready = gateOpen(a);
    return [
      !ready ? el("p", { class: "hint" }, !ui.seenEnd ? "⬇ Scroll to the end of the message to sign." : needPdf ? "📄 Open the attached PDF to sign." : "") : null,
      el("button", { class: "btn big", type: "button", disabled: !ready, onclick: () => sign(a) }, `✔ ${signLabel(a)}`),
      el("p", { class: "hint" }, `You'll confirm with your PIN${TEST_MODE ? " — test site, practice only" : ""}.`),
    ];
  }

  let endWatch = null;
  function watchEnd(a) {
    endWatch?.disconnect();
    endWatch = null;
    const end = container.querySelector(".ann-end");
    if (!end || ui.seenEnd || !canSign(a)) return;
    endWatch = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      ui.seenEnd = true;
      endWatch.disconnect();
      redrawSign(a);
    });
    endWatch.observe(end);
  }
  function redrawSign(a) {
    const box = container.querySelector("#ann-sign");
    if (box) box.replaceChildren(...[signArea(a)].flat(2).filter(Boolean));
  }

  // ---- tasks on this announcement (Decision 106) ------------------------------------------------------------------
  // Only announcements marked "This is a task". A Line Lead or Supervisor who got it assigns it to people on their
  // shift, due by a time (default: end of the shift). Each person taps Done; the assigner confirms.
  const canAssignHere = (a) => a.isTask && me.roles.some((r) => ASSIGN_ROLES.includes(r)) && (a.audienceEmps || []).includes(me.emp) && !isEnded(a);
  const toLocalInput = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

  async function taskRemove(t) {
    if (!(await confirmSheet({ title: `Take this task back from ${t.name}?`, text: "It comes off their Home. You can assign it again.", confirmLabel: "Take it back" }))) return;
    Object.assign(ui, { busy: true, message: "" });
    render();
    try { await callRemoveAnnTask({ id: t.id }); ui.busy = false; toast(`Taken back from ${t.name}`); render(); } catch (err) { say(friendlyError(err), () => taskRemove(t)); }
  }
  async function openAssign(a) {
    ui.assign = { emps: new Set(), dueMs: null, note: "", people: null, error: "" };
    render();
    try {
      const { data: r } = await callAnnTaskPeople({ annId: a.id });
      Object.assign(ui.assign, { people: r.people, dueMs: r.shiftEndMs || Date.now() + 8 * 3600000 });
    } catch (err) { ui.assign.error = friendlyError(err); }
    render();
  }
  async function saveAssign(a) {
    const x = ui.assign;
    if (!x.emps.size) return say("Pick at least one person.");
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      const { data: r } = await callAssignAnnouncementTask({ annId: a.id, emps: [...x.emps], dueMs: x.dueMs, note: x.note });
      Object.assign(ui, { busy: false, assign: null });
      toast(`Assigned to ${r.assigned} ${r.assigned === 1 ? "person" : "people"}${r.skipped ? ` (${r.skipped} already had it)` : ""}${r.test ? " — test: only you are notified" : ""}`);
      render();
    } catch (err) { say(friendlyError(err), () => saveAssign(a)); }
  }
  const mayTakeBack = (t) => t.status === "open" && (t.assignedBy === me.emp || me.roles.some((r) => ["plant-manager", "admin"].includes(r)));

  function assignForm(a) {
    const x = ui.assign;
    return el("form", { class: "redo-form", onsubmit: (e) => { e.preventDefault(); saveAssign(a); } },
      el("strong", {}, "📋 Assign this task"),
      x.error ? el("div", { class: "message error", role: "alert" }, x.error) : null,
      !x.people && !x.error ? spinner("Loading who's on your shift…") : null,
      x.people && !x.people.length ? emptyState("No one on your shift yet", "Tasks go to people marked Here on this shift. Mark who's here first (More → 👥 Who's here today).") : null,
      x.people?.length
        ? [el("span", { class: "field-label" }, "Who does it? (people on your shift — pick one or more)"),
           el("div", { class: "ck-list" }, x.people.map((p) => el("div", { class: x.emps.has(p.emp) ? "ck-item on" : "ck-item" },
             el("label", { class: "check-row" },
               el("input", { type: "checkbox", checked: x.emps.has(p.emp), onchange: (e) => { if (e.target.checked) x.emps.add(p.emp); else x.emps.delete(p.emp); render(); } }),
               el("span", {}, el("span", { class: "person-name" }, p.name), el("span", { class: "ck-last" }, [p.team ? `Team ${p.team}` : "", p.loginEnabled ? "" : "no login yet"].filter(Boolean).join(" · "))))))) ]
        : null,
      x.dueMs ? [el("label", { class: "field-label", for: "task-due" }, "Due by (starts at the end of this shift)"),
        el("input", { class: "field", id: "task-due", type: "datetime-local", required: true, value: toLocalInput(x.dueMs), onchange: (e) => { const ms = new Date(e.target.value).getTime(); if (Number.isFinite(ms)) x.dueMs = ms; } })] : null,
      el("label", { class: "field-label", for: "task-note" }, "Note (optional)"),
      el("input", { class: "field", id: "task-note", maxlength: "500", value: x.note, placeholder: "e.g. Both winders on Line 2", oninput: (e) => { x.note = e.target.value; } }),
      el("div", { class: "btn-row" },
        el("button", { class: "btn", type: "submit", disabled: ui.busy || !x.emps.size }, x.emps.size ? `Assign to ${x.emps.size} ${x.emps.size === 1 ? "person" : "people"}` : "Assign"),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.assign = null; render(); } }, "Cancel")),
      el("p", { class: "hint" }, "Each person taps Done; then you confirm it. If you're off shift, a Line Lead or Supervisor on that shift can confirm."));
  }

  function tasksPanel(a) {
    const list = tasksFor(a.id);
    const canAssign = canAssignHere(a);
    if (!list.length && !canAssign) return null;
    return el("section", { class: "card" },
      el("strong", {}, list.length ? `📋 Task (${list.filter((t) => t.status === "verified").length} of ${list.length} confirmed)` : "📋 This is a task"),
      list.length ? el("div", { class: "task-list" }, list.map((t) => [taskRow(t, me, { busy: ui.busy }), mayTakeBack(t) ? el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => taskRemove(t) }, `Take it back from ${t.name}`) : null]))
        : el("p", { class: "card-note" }, "Pick who on your shift does it."),
      ui.assign ? assignForm(a) : canAssign ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => openAssign(a) }, "📋 Assign to people on my shift") : null);
  }

  function renderRead() {
    const a = find(ui.id);
    if (!a) {
      return [backBtn(ui.back === "home" ? "Home" : "Announcements", leaveRead),
        !data.announcements ? spinner("Loading announcement…")
          : tasksFor(ui.id).length ? tasksPanel({ id: ui.id, title: tasksFor(ui.id)[0].annTitle, ackBy: null, audienceEmps: [] })
          : emptyState("Announcement not found", "It may have been for someone else.")];
    }
    if (!iSign(a, me.roles)) markSeen(me.emp, a); // Important, crew: off the top of Home once opened
    const sig = mySig(a);
    const older = signedBefore(a);
    const file = a.file
      ? a.file.kind === "image"
        ? el("a", { href: a.file.url, target: "_blank", rel: "noopener", class: "ann-photo" }, el("img", { class: "fix-photo", src: a.file.url, alt: a.file.name || "Attached photo" }))
        : el("a", { class: ui.openedFile ? "btn secondary" : "btn", href: a.file.url, target: "_blank", rel: "noopener", onclick: () => { ui.openedFile = true; render(); } },
            `📄 ${ui.openedFile ? "Opened" : "Open"}: ${a.file.name || "attached PDF"}`)
      : null;
    return [
      backBtn(ui.back === "home" ? "Home" : "Announcements", leaveRead),
      el("h1", { class: "fix-title" }, a.title),
      el("p", { class: "hint" }, [a.createdByName ? `From ${a.createdByName}` : "", fmtWhen(a.createdAt), `acknowledge by ${fmtDay(a.ackBy)}`, a.endDate ? `up until ${fmtDay(a.endDate)}` : ""].filter(Boolean).join(" · ")),
      el("p", { class: "tags ann-tags" },
        prioBadge(a.priority),
        version(a) > 1 ? el("span", { class: "tag" }, `Version ${version(a)}`) : null,
        statusTag(a, me.emp),
        a.test ? el("span", { class: "tag test" }, "TEST") : null),
      banner(ui),
      canSign(a) && older ? el("p", { class: "message" }, `Updated since you signed version ${older}. Read it again and sign the new version.`) : null,
      canSign(a) && isOverdue(a) ? el("p", { class: "message error" }, `⚠ This was due by ${fmtDay(a.ackBy)}.`) : null,
      el("div", { class: "fix-body keep-lines ann-body" }, a.body),
      file,
      el("p", { class: "ann-end", "aria-hidden": "true" }, "— End of message —"),
      isRelay(a) && (a.audienceEmps || []).includes(me.emp) && !iSign(a, me.roles)
        ? el("p", { class: "message" }, "Your Line Lead or Supervisor goes over this with the crew — no sign-off needed from you.")
        : null,
      isRelay(a) && canSign(a) ? el("p", { class: "hint" }, "Important: go over it with your crew, then sign that you've read it and relayed it.") : null,
      sig ? el("p", { class: "message ok" }, `✓ ${sig.method === "in-person" ? `Reviewed in person (recorded by ${sig.recordedByName || "a supervisor"})` : "You signed this"} ${fmtWhen(sig.at)}${version(a) > 1 ? ` · version ${version(a)}` : ""}.`) : null,
      el("div", { id: "ann-sign" }, signArea(a)),
      tasksPanel(a),
      trackingPanel(a),
    ];
  }

  // ---- tracking ------------------------------------------------------------------------------------------------

  const tracks = (a) => a.createdBy === me.emp || (a.trackers || []).includes(me.emp) || me.roles.some((r) => ["admin", "plant-manager", "office"].includes(r));

  async function loadTracking(a) {
    ui.track = { loading: true };
    try {
      const { data: t } = await callAnnouncementTracking({ id: a.id });
      ui.track = t;
    } catch (err) {
      ui.track = { error: friendlyError(err) };
    }
    if (ui.view === "read" || ui.view === "print") render();
  }

  function personMeta(p) {
    return [`#${p.id}`, p.team ? `Team ${data.teams?.find((t) => t.id === p.team)?.name || p.team}` : "", p.olderVersion ? `signed version ${p.olderVersion}` : ""].filter(Boolean).join(" · ");
  }
  function sigText(p) {
    if (!p.sig) return "";
    return p.sig.method === "in-person"
      ? `Reviewed in person · ${fmtWhen(p.sig.at)} · by ${p.sig.recordedByName}${p.sig.note ? ` — ${p.sig.note}` : ""}`
      : `Signed ${fmtWhen(p.sig.at)}${p.sig.device ? ` · ${p.sig.device}` : ""}`;
  }

  function trackingPanel(a) {
    if (!tracks(a)) return null;
    if (!ui.track) { loadTracking(a); return spinner("Loading sign-offs…"); }
    const t = ui.track;
    if (t.loading) return spinner("Loading sign-offs…");
    if (t.error) return el("div", { class: "message error", role: "alert" }, t.error, el("button", { class: "btn secondary retry", type: "button", onclick: () => loadTracking(a) }, "↻ Try again"));
    const notSigned = t.people.filter((x) => x.state === "not-signed");
    const noLogin = t.people.filter((x) => x.state === "no-login");
    const waitingRow = (x) =>
      el("div", { class: "person-row static" },
        el("span", { class: "person-name" }, x.name),
        el("span", { class: "person-meta" }, personMeta(x)),
        el("span", { class: "tags" }, x.state === "no-login" ? el("span", { class: "tag warn" }, "No login") : el("span", { class: "tag off" }, t.overdue ? "⚠ Overdue" : "Not signed")),
        x.state === "no-login" && t.canInPerson && !t.ended
          ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => show("inperson", { inPerson: { id: x.id, name: x.name, note: "" } }) }, "🤝 Reviewed in person")
          : null);
    const done = t.people.filter((x) => x.state === "signed" || x.state === "in-person");
    const c = t.counts;
    async function remind() {
      const n = t.people.filter((x) => x.state === "not-signed").length;
      if (!(await confirmSheet({ title: `Remind ${n} ${n === 1 ? "person" : "people"}?`, text: TEST_MODE ? "Test site: only you get the notification." : "Only the people who haven't signed (and have a login) get another notification.", confirmLabel: "🔔 Send reminder" }))) return;
      Object.assign(ui, { busy: true, message: "" });
      render();
      try {
        const { data: r } = await callRemindAnnouncement({ id: a.id });
        ui.busy = false;
        toast(r.test ? "Test reminder sent — only to you" : `Reminder sent to ${r.reminded} ${r.reminded === 1 ? "person" : "people"}`);
        render();
      } catch (err) {
        say(friendlyError(err), remind);
      }
    }
    async function endNow() {
      if (!(await confirmSheet({ title: "End this announcement now?", text: "It moves to the archive. Everyone's sign-offs are kept.", confirmLabel: "End it", danger: true }))) return;
      Object.assign(ui, { busy: true, message: "" });
      render();
      try {
        await callEndAnnouncement({ id: a.id });
        toast("Ended — moved to the archive");
        ui.track = null;
        show("read", { id: a.id });
      } catch (err) {
        say(friendlyError(err), endNow);
      }
    }
    return el(
      "section",
      { class: "card ann-track" },
      el("h2", {}, t.scope === "crew" ? "Your crew's sign-offs" : "Sign-offs"),
      t.noCrew ? el("p", { class: "message" }, "Your crew is the people on your team. Ask an admin to set your team in Admin → People.") : null,
      el("p", { class: "ann-count" }, el("strong", {}, `${isRelay(a) ? "Line Leads & Supervisors: " : ""}${c.signed} of ${c.total} signed`), c.noLogin ? ` · ${c.noLogin} with no login, not reviewed yet` : ""),
      t.readOnly ? el("p", { class: "card-note" }, "Real announcement — on the test site, signatures here are practice only.") : null,
      // People with a login who haven't signed stay in view; people with no login yet fold away (until launch that
      // is nearly everyone, and they can't sign themselves — a supervisor records "Reviewed in person").
      notSigned.length ? [el("p", { class: "field-label" }, `Not signed yet (${notSigned.length})`), el("div", { class: "person-list" }, notSigned.map(waitingRow))] : null,
      noLogin.length ? collapsible(`ann-nologin-${a.id}`, `No login yet — not signed (${noLogin.length})`, el("div", { class: "person-list" }, noLogin.map(waitingRow))) : null,
      !notSigned.length && !noLogin.length ? el("p", { class: "message ok" }, "✓ Everyone has signed.") : null,
      !notSigned.length && noLogin.length ? el("p", { class: "message ok" }, "✓ Everyone with a login has signed.") : null,
      done.length
        ? collapsible(`ann-signed-${a.id}`, `✓ Signed (${done.length})`, el("div", { class: "person-list" }, done.map((x) =>
            el("div", { class: "person-row static" }, el("span", { class: "person-name" }, x.name), el("span", { class: "person-meta" }, sigText(x))))))
        : null,
      el("div", { class: "btn-row" },
        !t.ended && c.notSigned ? el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: remind }, `🔔 Remind the ${c.notSigned} who haven't signed`) : null,
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => show("print") }, "🖨 Print / Save as PDF"),
        el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => loadTracking(a) }, "↻ Refresh"),
        t.canEdit && !t.ended ? el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => startForm(a) }, "✎ Edit") : null,
        t.canEdit && !t.ended ? el("button", { class: "btn danger", type: "button", disabled: ui.busy, onclick: endNow }, "⏹ End now") : null)
    );
  }

  // ---- reviewed in person (no login yet) ----------------------------------------------------------------------

  function renderInPerson() {
    const a = find(ui.id);
    const x = ui.inPerson;
    if (!a || !x) return renderRead();
    async function record() {
      if (x.note.trim().length < 3) return say("Add a short note — for example, “Read it together at the start of shift.”");
      Object.assign(ui, { message: "" });
      const r = await signOff({
        title: "Record: reviewed in person",
        what: `${x.name} · ${a.title}`,
        me: { emp: me.emp, name: me.name },
        action: offlineSign("recordReviewedInPerson", { id: a.id, emp: x.id, note: x.note }, { label: `Reviewed in person · ${x.name} · ${a.title}` }),
        doneLabel: "Saving…",
      });
      if (!r) return render();
      toast(signedNote(r, `Recorded — ${r.name} reviewed in person${r.test ? " (test)" : ""}`));
      show("read", { id: a.id, track: null });
    }
    return [
      backBtn(a.title, () => show("read", { id: a.id })),
      el("h1", {}, "🤝 Reviewed in person"),
      el("p", { class: "hint" }, `${x.name} has no login yet. Go over “${a.title}” with them, then record it here with your own PIN.`),
      banner(ui),
      el("label", { class: "field-label", for: "ann-note" }, "Note (how it was reviewed)"),
      el("textarea", { class: "field", id: "ann-note", rows: "3", maxlength: "500", placeholder: "e.g. Read it together at the start of shift; they had no questions.", value: x.note, oninput: (e) => { x.note = e.target.value; } }),
      el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: record }, "✍ Record with my PIN"),
    ];
  }

  // ---- print / save as PDF ---------------------------------------------------------------------------------------

  function renderPrint() {
    const a = find(ui.id);
    const t = ui.track;
    if (!a || !t || t.loading || t.error) { if (a && !t) loadTracking(a); return [backBtn("Back", () => show("read", { id: ui.id })), spinner("Getting the sign-off list ready…")]; }
    const STATE = { signed: "Signed", "in-person": "Reviewed in person", "not-signed": "Not signed", "no-login": "No login — not signed" };
    return [
      el("div", { class: "no-print btn-row" },
        el("button", { class: "btn", type: "button", onclick: () => window.print() }, "🖨 Print / Save as PDF"),
        el("button", { class: "btn secondary", type: "button", onclick: () => show("read", { id: a.id }) }, "← Back")),
      el("p", { class: "hint no-print" }, "To save a PDF, pick “Save as PDF” as the printer."),
      el(
        "article",
        { class: "print-doc" },
        el("h1", {}, `Sign-off record: ${a.title}`),
        el("p", {}, [`Version ${t.version}`, `Priority: ${PRIORITY[a.priority]?.label.replace(/^\W+\s*/, "") || "Normal"}`, `Posted by ${t.createdByName} ${fmtWhen(t.createdAt)}`, `Acknowledge by ${fmtDay(t.ackBy)}`].join(" · ")),
        el("p", {}, el("strong", {}, `${t.counts.signed} of ${t.counts.total} signed`), t.counts.noLogin ? ` · ${t.counts.noLogin} with no login, not reviewed yet` : "", t.scope === "crew" ? " · your crew only" : "", a.test ? " · TEST (practice)" : ""),
        el("table", { class: "print-table" },
          el("thead", {}, el("tr", {}, ["Name", "Employee #", "Status", "When", "Device / note"].map((h) => el("th", {}, h)))),
          el("tbody", {}, t.people.map((x) =>
            el("tr", {},
              el("td", {}, x.name), el("td", {}, x.id), el("td", {}, STATE[x.state] + (x.olderVersion && !x.sig ? ` (signed v${x.olderVersion})` : "")),
              el("td", {}, x.sig ? fmtWhen(x.sig.at) : ""),
              el("td", {}, x.sig ? (x.sig.method === "in-person" ? `By ${x.sig.recordedByName}: ${x.sig.note}` : x.sig.device) : ""))))),
        el("p", { class: "print-foot" }, `Printed ${new Date().toLocaleString("en-US")} from CDG Ops.`)
      ),
    ];
  }

  // ---- post / edit -------------------------------------------------------------------------------------------------

  function loadPeople() {
    if (ui.people) return;
    ui.peopleError = "";
    callAnnouncementPeople().then(
      ({ data: r }) => {
        Object.assign(ui, { people: r.people, annDepts: r.departments || [], annOpts: r.options || { any: true, start: { everyone: true } } });
        startAudience();
        if (ui.view === "form") render();
      },
      (err) => { ui.peopleError = friendlyError(err); if (ui.view === "form") render(); }
    );
  }

  function startForm(a) {
    const today = plantToday();
    ui.draft = a
      ? {
          id: a.id, title: a.title, body: a.body, priority: a.priority, ackBy: a.ackBy, endDate: a.endDate || "", file: a.file || null,
          everyone: a.audience?.everyone === true, roles: [...(a.audience?.roles || [])], roleTeams: [...(a.audience?.roleTeams || [])], teams: [...(a.audience?.teams || [])],
          lines: [...(a.audience?.lines || [])], people: [...(a.audience?.people || [])], keepForNewHires: a.keepForNewHires === true, isTask: a.isTask === true,
          was: { title: a.title, body: a.body, priority: a.priority, fileUrl: a.file?.url || "" },
        }
      : { id: null, title: "", body: "", priority: "normal", ackBy: addDays(today, 7), endDate: "", file: null, everyone: true, roles: [], roleTeams: [], teams: [], lines: [], people: [], keepForNewHires: false, isTask: false, fresh: true };
    ui.draft.departments = a ? [...(a.audience?.departments || [])] : [];
    loadPeople();
    startAudience();
    show("form");
  }

  // A new announcement starts where the poster's choices start (Decision 108): Admins — everyone; department heads —
  // their own department (they can add teams or people).
  function startAudience() {
    const d = ui.draft;
    if (!d?.fresh || !ui.annOpts) return;
    const s = ui.annOpts.start || { everyone: true };
    Object.assign(d, { everyone: s.everyone === true, departments: [...(s.departments || [])], fresh: false });
  }

  // Who it reaches right now (same matching as the server). No team (Decision 108): only when named or their
  // department is picked.
  function reach(d) {
    if (!ui.people) return null;
    const onRoleTeams = (p) => !d.roleTeams.length || d.roleTeams.includes(p.team) || (p.supervisesTeams || []).some((t) => d.roleTeams.includes(t));
    const named = (p) => d.people.includes(p.id) || (!!p.department && d.departments.includes(p.department));
    return ui.people.filter((p) => named(p) || (!!p.team && (d.everyone || (p.roles.some((r) => d.roles.includes(r)) && onRoleTeams(p)) || d.teams.includes(p.team) || (p.lineIds || []).some((l) => d.lines.includes(l)))));
  }
  // Who it's for, in words: "Quality department + Team B + 2 people" (Decision 108).
  function audienceLabel(d) {
    if (d.everyone) return "Everyone on a team";
    const name = (list, id) => list.find((x) => x.id === id)?.name || id;
    const parts = [
      ...d.departments.map((id) => `${name(ui.annDepts || [], id)} department`),
      ...d.roles.map((id) => name(data.roles || [], id)),
      ...d.teams.map((id) => `Team ${name(data.teams || [], id)}`),
      ...d.lines.map((id) => name(data.lines || [], id)),
      ...(d.people.length ? [d.people.length === 1 ? ui.people?.find((p) => p.id === d.people[0])?.name || "1 person" : `${d.people.length} people by name`] : []),
    ];
    return parts.join(" + ");
  }

  function renderForm() {
    const d = ui.draft;
    const toggle = (key, v) => { d[key] = d[key].includes(v) ? d[key].filter((x) => x !== v) : [...d[key], v]; render(); };
    const chip = (key, v, label) => el("button", { class: d[key].includes(v) ? "chip on" : "chip", type: "button", "aria-pressed": String(d[key].includes(v)), onclick: () => toggle(key, v) }, label);
    const reached = reach(d);
    const noLogin = reached ? reached.filter((p) => !p.loginEnabled).length : 0;
    const signAgain = d.id && (d.title.trim() !== d.was.title || d.body.trim() !== d.was.body || d.priority !== d.was.priority || (d.file?.url || "") !== d.was.fileUrl);

    async function addFile(file) {
      const kind = file.type === "application/pdf" ? "pdf" : file.type.startsWith("image/") ? "image" : null;
      if (!kind) return say("A photo or a PDF only.");
      if (file.size > 50 * 1024 * 1024) return say("That file is over 50 MB. Use a smaller one.");
      if (!navigator.onLine) return say(friendlyError({ code: "offline" }), () => addFile(file));
      Object.assign(ui, { busy: true, message: "", retry: null });
      try {
        const url = await upload(file, me.emp, (p) => { ui.upload = `Uploading ${file.name}: ${p}%`; render(); });
        d.file = { url, kind, name: file.name.slice(0, 120) };
        Object.assign(ui, { busy: false, upload: "" });
        toast(kind === "pdf" ? "PDF attached" : "Photo attached");
        render();
      } catch (err) {
        Object.assign(ui, { upload: "" });
        say(friendlyError(err), () => addFile(file));
      }
    }

    async function post(e) {
      e?.preventDefault();
      if (d.title.trim().length < 3) return say("Give it a title (a few words).");
      if (d.body.trim().length < 3) return say("Write the message.");
      if (!d.ackBy) return say("Pick an “acknowledge by” date.");
      if (!d.everyone && !d.departments.length && !d.roles.length && !d.teams.length && !d.lines.length && !d.people.length) return say("Pick who it's for.");
      const n = reached?.length;
      const ok = await confirmSheet({
        title: d.id ? (signAgain ? "Save and ask everyone to sign again?" : "Save changes?") : `Post to ${n ?? "the"} ${n === 1 ? "person" : "people"}?`,
        text: d.id
          ? signAgain ? "The words, attachment, or priority changed, so everyone signs the new version. Their earlier signatures stay in the history." : "Dates and audience changed only — nobody has to sign again."
          : `They get a notification${TEST_MODE ? " (test site: only you)" : ""}, and it stays on their Home until they sign.`,
        confirmLabel: d.id ? "✔ Save" : "📣 Post",
      });
      if (!ok) return;
      Object.assign(ui, { busy: true, message: "", retry: null });
      render();
      try {
        const { data: r } = await callPostAnnouncement({
          ...(d.id ? { id: d.id } : {}), title: d.title, body: d.body, priority: d.priority, ackBy: d.ackBy, endDate: d.endDate || null, file: d.file,
          audience: { everyone: d.everyone, roles: d.roles, roleTeams: d.roles.length ? d.roleTeams : [], teams: d.teams, departments: d.departments, lines: d.lines, people: d.people }, keepForNewHires: d.keepForNewHires, isTask: d.isTask,
        });
        toast(d.id ? (r.signAgain ? `Saved — everyone signs version ${r.version}` : "Saved") : `Posted to ${r.audience} ${r.audience === 1 ? "person" : "people"}${r.test ? " (test)" : ""}`);
        ui.draft = null;
        if (!d.id) onPosted?.(r.id);
        openOne(r.id);
      } catch (err) {
        say(friendlyError(err), post);
      }
    }

    const activeRoles = (data.roles || []).filter((r) => r.active !== false);
    const activeTeams = (data.teams || []).filter((t) => t.active !== false);
    const activeLines = (data.lines || []).filter((l) => l.active !== false);
    const unpicked = (ui.people || []).filter((p) => !d.people.includes(p.id));
    const personName = (id) => ui.people?.find((p) => p.id === id)?.name || `#${id}`;
    const today = plantToday();
    // Department heads (Decision 108): their own department, teams, and people — not everyone, roles, or lines.
    const any = ui.annOpts ? ui.annOpts.any !== false : true;
    const depts = (ui.annDepts || []).filter((x) => any || (ui.annOpts?.departments || []).includes(x.id));
    const pickAll = any && d.everyone;

    return [
      backBtn(d.id ? "Back" : "Announcements", () => (d.id ? show("read", { id: d.id }) : show("list"))),
      el("h1", {}, d.id ? "Edit announcement" : "Post an announcement"),
      d.id ? el("p", { class: "message" }, "Changing the title, message, attachment, or priority asks everyone to sign again. Changing dates or who it's for doesn't.") : null,
      el(
        "form",
        { onsubmit: post },
        el("label", { class: "field-label", for: "ann-title" }, "Title"),
        el("input", { class: "field", id: "ann-title", maxlength: "120", required: true, value: d.title, placeholder: "e.g. New glove rule at the winders", oninput: (e) => { d.title = e.target.value; } }),
        el("label", { class: "field-label", for: "ann-body" }, "Message"),
        el("textarea", { class: "field", id: "ann-body", rows: "8", maxlength: "10000", required: true, value: d.body, oninput: (e) => { d.body = e.target.value; } }),
        el("p", { class: "field-label" }, "Photo or PDF (optional)"),
        d.file
          ? el("div", { class: "import-row" }, el("span", { class: "gap-term" }, `${d.file.kind === "pdf" ? "📄" : "📷"} ${d.file.name}`), el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => { d.file = null; render(); } }, "Remove"))
          : el("label", { class: "btn secondary file-btn" }, "📎 Add a photo or PDF",
              el("input", { type: "file", accept: "image/*,application/pdf", hidden: true, disabled: ui.busy, onchange: (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) addFile(f); } })),
        ui.upload ? spinner(ui.upload) : null,
        el("p", { class: "field-label" }, "Priority"),
        el("div", { class: "choices three" }, ["normal", "important", "safety"].map((k) =>
          el("button", { class: `${d.priority === k ? "choice on" : "choice"}${k === "safety" ? " danger" : ""}`, type: "button", "aria-pressed": String(d.priority === k), onclick: () => { d.priority = k; render(); } }, PRIORITY[k].label))),
        d.priority === "safety" ? el("p", { class: "card-note" }, "Safety shows in red at the very top of everyone's Home until they sign.") : null,
        d.priority === "important" ? el("p", { class: "card-note" }, "Important: only the Line Leads and Supervisors in the audience sign “Read & relayed to crew.” The crew sees it but doesn't sign.") : null,
        el("div", { class: "date-row" },
          el("div", {},
            el("label", { class: "field-label", for: "ann-ack" }, "Acknowledge by"),
            el("input", { class: "field", id: "ann-ack", type: "date", min: today, required: true, value: d.ackBy, onchange: (e) => { d.ackBy = e.target.value; render(); } })),
          el("div", {},
            el("label", { class: "field-label", for: "ann-end" }, "End date (optional)"),
            el("input", { class: "field", id: "ann-end", type: "date", min: d.ackBy || today, value: d.endDate, onchange: (e) => { d.endDate = e.target.value; render(); } }),
            d.endDate ? el("button", { class: "link-btn", type: "button", onclick: () => { d.endDate = ""; render(); } }, "No end date") : el("p", { class: "card-note" }, "No end date: stays up until ended."))),
        el("p", { class: "field-label" }, "Who it's for"),
        any
          ? el("div", { class: "choices two" },
              el("button", { class: d.everyone ? "choice on" : "choice", type: "button", "aria-pressed": String(d.everyone), onclick: () => { d.everyone = true; render(); } }, "Everyone"),
              el("button", { class: !d.everyone ? "choice on" : "choice", type: "button", "aria-pressed": String(!d.everyone), onclick: () => { d.everyone = false; render(); } }, "Pick who"))
          : el("p", { class: "card-note" }, "Department heads post to their own department. Add teams or people to reach more."),
        !pickAll
          ? el("div", { class: "card" },
              depts.length ? [el("p", { class: "field-label" }, any ? "Departments (everyone in them, on a team or not)" : "Your department"), el("div", { class: "chips" }, depts.map((x) => chip("departments", x.id, x.name)))] : null,
              any ? [el("p", { class: "field-label" }, "Roles"),
              el("div", { class: "chips" }, activeRoles.map((r) => chip("roles", r.id, r.name)))] : null,
              // The roles picked, on which teams? (e.g. only Team B's Line Leads and Supervisors — Chris, 10-23-2026)
              any && d.roles.length && activeTeams.length
                ? [el("p", { class: "field-label" }, "Those roles on which teams?"),
                   el("div", { class: "chips" },
                     el("button", { class: d.roleTeams.length ? "chip" : "chip on", type: "button", "aria-pressed": String(!d.roleTeams.length), onclick: () => { d.roleTeams = []; render(); } }, "All teams"),
                     activeTeams.map((t) => chip("roleTeams", t.id, `Team ${t.name}`))),
                   el("p", { class: "card-note" }, d.roleTeams.length
                     ? "Only the people with those roles on the teams picked — Supervisors also count for the teams they cover."
                     : "Every person with those roles, on every team.")]
                : null,
              activeTeams.length ? [el("p", { class: "field-label" }, "Whole teams (everyone on them)"), el("div", { class: "chips" }, activeTeams.map((t) => chip("teams", t.id, `Team ${t.name}`)))] : null,
              any && activeLines.length ? [el("p", { class: "field-label" }, "Lines (the people on that line this shift)"), el("div", { class: "chips" }, activeLines.map((l) => chip("lines", l.id, l.name)))] : null,
              el("p", { class: "field-label" }, "People"),
              d.people.map((id) => el("div", { class: "import-row" }, el("span", { class: "gap-term" }, personName(id)), el("button", { class: "link-btn", type: "button", onclick: () => toggle("people", id) }, "Remove"))),
              ui.peopleError
                ? el("div", { class: "message error", role: "alert" }, ui.peopleError, el("button", { class: "btn secondary retry", type: "button", onclick: () => { ui.people = null; loadPeople(); render(); } }, "↻ Try again"))
                : !ui.people ? spinner("Loading people…")
                : unpicked.length ? picker({ id: "ann-person", title: "Add a person", value: "", placeholder: "+ Add a person", options: unpicked.map((p) => ({ value: p.id, label: `${p.name} (#${p.id})` })), onChange: (v) => toggle("people", v) }) : null)
          : null,
        el("p", { class: "ann-reach" }, reached === null ? (ui.peopleError ? "" : "Counting who it reaches…")
          : el("strong", {}, `${audienceLabel(d) || "Nobody picked yet"} – ${reached.length} ${reached.length === 1 ? "person" : "people"}`),
          reached === null ? null : noLogin ? ` (${noLogin} with no login yet — a supervisor can record “Reviewed in person”).` : ""),
        el("p", { class: "card-note" }, "People with no team (day staff, office) get it only when their name or their department is picked."),
        el("label", { class: "check-row" },
          el("input", { type: "checkbox", checked: d.isTask, onchange: (e) => { d.isTask = e.target.checked; } }),
          el("span", {}, el("strong", {}, "📋 This is a task"), " — Line Leads and Supervisors who get it assign it to people on their shift; each person taps Done and the assigner confirms. (Reading and signing it stays separate.)")),
        el("label", { class: "check-row" },
          el("input", { type: "checkbox", checked: d.keepForNewHires, onchange: (e) => { d.keepForNewHires = e.target.checked; } }),
          el("span", {}, el("strong", {}, "Keep for new hires"), " — anyone who joins this audience later (new hire, new role, team, or line) gets it too. Use it for standing policies.")),
        banner(ui),
        el("button", { class: "btn big", type: "submit", disabled: ui.busy }, ui.busy ? "Saving…" : d.id ? "✔ Save changes" : `📣 Post${TEST_MODE ? " (test)" : ""}`)
      ),
    ];
  }

  // ---- drawing -----------------------------------------------------------------------------------------------------

  function render() {
    const views = { list: renderList, read: renderRead, form: renderForm, inperson: renderInPerson, print: renderPrint };
    container.replaceChildren(...[(views[ui.view] || renderList)()].flat(3).filter(Boolean));
    container.classList.toggle("printing", ui.view === "print");
    if (ui.view === "read") { const a = find(ui.id); if (a) watchEnd(a); }
  }

  // Live updates redraw the list and the reading view, but never while someone is typing or saving.
  const typing = () => ["ann-search", "ann-title", "ann-body", "ann-note"].includes(document.activeElement?.id);
  const stop = onDataChange(() => { if (!ui.busy && !typing() && ["list", "read"].includes(ui.view)) render(); });
  if (prefill) { startForm(null); Object.assign(ui.draft, prefill); }
  render();
  return () => { stop(); endWatch?.disconnect(); container.classList.remove("printing"); };
}
