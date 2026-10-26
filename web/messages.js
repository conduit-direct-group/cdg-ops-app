// In-app messaging (Chris, 10-23-2026, Decision 102; launch list 5). Rules: functions/messaging.js.
// Line Leads, Supervisors, department heads, the Production Manager, and Admins start messages (Decision 106) and can
// type replies; everyone else answers with quick buttons — Got it / Done / Need help – see me. A reply to a group
// message goes only to its sender. A message can be a task (one or more people, due by a time).
// Clearing (Decision 106): a message leaves your list once you answer it (and your task on it is confirmed), or at the
// end of the shift it came in — then it's in History (90 days), with the announcements you've finished. You get messages only while on your shift and not
// marked absent — the server decides that when a message is sent, and anything else is never delivered.
// Every conversation is between the starter and one person: "{rootId}__{participant}". A group message the starter
// sent shows as one item with its replies grouped by person. HR access opens one person's messages only with a reason.
//   Home: a "💬 New messages" line under the announcements; More → 💬 Messages; a pop-up when one arrives.

import { el, breakable, friendlyError, spinner, emptyState, banner, toast, picker, confirmSheet, collapsible } from "./ui.js";
import { data, onDataChange } from "./data.js";
import { taskRow, fmtDue } from "./tasks.js";
import {
  callMessageStart, callMessagePreview, callMessageSend, callMessageReply, callMessagesSeenNow, callMessagingNoticeSeen,
  callHrReviewMessages, callHrMessageReviewLog,
} from "./firebase.js";

// Who starts messages: Line Lead and above unless an Admin changed it for a role (Admin → Roles, Decision 103).
const START_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
export const roleStartsMessages = (role) => (typeof role.startMessages === "boolean" ? role.startMessages : START_ROLES.includes(role.id));
const SHIFT_LINE = "You only receive messages during your shift.";
const HR_LINE = "Messages are company records and may be reviewed by HR.";
const MAINT_WORDS = /\b(down|leak|leaking|leaks|broken|broke|jam|jammed|jams|not working)\b/i;
const M_NUMBER = /\bM-?\d{3}\b/i;
const maintenanceHint = (t) => M_NUMBER.test(t || "") || MAINT_WORDS.test(t || "");
const machineIn = (t) => {
  const n = (String(t || "").match(M_NUMBER)?.[0] || "").toUpperCase().replace(/^M-?/, "M-");
  return n && (data.machines || []).some((m) => m.id === n) ? n : null;
};
const conv = (rootId, participant) => `${rootId}__${participant}`;
const fmtWhen = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const TO_ICON = { person: "👤", team: "🅰", line: "🏭", role: "🏷", all: "📢" };

// ---- conversations from the live data (shared with Home) ------------------------------------------------------------
// → { items: [{ key, kind: "conv" | "group", rootId, title, last, unread, ... }], byConv: Map }
export function conversations(emp) {
  const msgs = data.messages || [];
  const seen = data.messagesSeen?.[0]?.seen || {};
  const roots = new Map(msgs.filter((m) => m.kind === "new").map((m) => [m.id, m]));
  const byConv = new Map();
  const groups = new Map();
  const add = (key, m, extra) => {
    if (!byConv.has(key)) byConv.set(key, { key, kind: "conv", messages: [], ...extra });
    byConv.get(key).messages.push(m);
  };
  for (const m of msgs) {
    if (m.kind === "new") {
      if (m.fromEmp === emp && m.to?.type !== "person") {
        groups.set(m.id, { key: m.id, kind: "group", rootId: m.id, root: m, messages: [m], replies: 0 });
      } else if (m.fromEmp === emp) {
        add(conv(m.id, m.to.id), m, { rootId: m.id, participant: m.to.id, otherName: m.to.label });
      } else {
        add(conv(m.id, emp), m, { rootId: m.id, participant: emp, otherName: m.fromName });
      }
    } else {
      const root = roots.get(m.rootId);
      const participant = m.conv.slice(m.rootId.length + 2);
      const other = m.fromEmp === emp ? m.to?.label : m.fromName;
      add(m.conv, m, { rootId: m.rootId, participant, otherName: root && root.fromEmp !== emp ? root.fromName : other });
      if (groups.has(m.rootId) && m.fromEmp !== emp) groups.get(m.rootId).replies += 1;
    }
  }
  const items = [];
  const now = Date.now();
  const myTaskOk = (rootId) => (data.annTasks || []).filter((t) => t.rootId === rootId && t.emp === emp && t.status !== "removed").every((t) => t.status === "verified");
  for (const c of byConv.values()) {
    c.messages.sort((a, b) => a.atMs - b.atMs);
    const root = roots.get(c.rootId);
    if (root && root.fromEmp === emp && root.to?.type !== "person") { c.groupRoot = root; } // a person's thread inside my group message
    c.root = root || c.groupRoot || null;
    c.last = c.messages[c.messages.length - 1];
    // Off my list (into History): I got it and answered it (task confirmed), or the shift it came in has ended.
    c.cleared = !!c.root && (now >= (c.root.shiftEndMs || Infinity) || (c.root.fromEmp !== emp && !!c.root.acks?.[emp] && myTaskOk(c.root.id)));
    c.unread = c.cleared ? 0 : c.messages.filter((m) => m.fromEmp !== emp && (m.recipients || []).includes(emp) && m.atMs > (seen[c.key] || 0)).length;
    c.title = c.otherName || "Message";
    if (!c.groupRoot) items.push(c);
  }
  for (const g of groups.values()) {
    const threads = [...byConv.values()].filter((c) => c.groupRoot?.id === g.rootId);
    g.threads = threads;
    g.last = [g.root, ...threads.map((t) => t.last)].sort((a, b) => b.atMs - a.atMs)[0];
    g.cleared = now >= (g.root.shiftEndMs || Infinity);
    g.unread = threads.reduce((n, t) => n + t.unread, 0);
    g.title = g.root.to?.label || "Group message";
    items.push(g);
  }
  items.sort((a, b) => (b.last?.atMs || 0) - (a.last?.atMs || 0));
  return { items, byConv, groups };
}

export const unreadMessages = (emp) => (data.messages ? conversations(emp).items.reduce((n, c) => n + c.unread, 0) : 0);

// Home: one line under the announcements while something is unread (information, so no status color).
export function messageBar(emp, onOpen, row) {
  if (!data.messages || !emp) return null;
  const unread = conversations(emp).items.filter((c) => c.unread);
  // Always on Home (Decision 115) — Messages isn't in More any more.
  if (!unread.length) {
    return el("section", { class: "ann-bar msg-bar", "aria-label": "Messages" },
      el("button", { class: "msg-line", type: "button", onclick: onOpen }, el("span", { "aria-hidden": "true" }, "💬"), el("span", {}, "Messages — no new messages"), el("span", { class: "msg-line-go", "aria-hidden": "true" }, "›")));
  }
  const n = unread.reduce((s, c) => s + c.unread, 0);
  const names = [...new Set(unread.map((c) => (c.kind === "group" ? c.threads.filter((t) => t.unread).map((t) => t.otherName) : [c.otherName])).flat())];
  return el("section", { class: "ann-bar msg-bar", "aria-label": "New messages", "aria-live": "polite" },
    row({ key: "messages", icon: "💬", title: `${n} new message${n === 1 ? "" : "s"}`, detail: `from ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`, state: "due", onOpen }));
}

// A short pop-up when a message for me arrives (any screen except Messages itself).
const knownIds = new Set();
let primedMsgs = false;
export function noticeNewMessages(emp, onMessages) {
  if (!data.messages || !emp) return;
  for (const m of data.messages) {
    if (knownIds.has(m.id)) continue;
    knownIds.add(m.id);
    if (primedMsgs && m.fromEmp !== emp && (m.recipients || []).includes(emp) && !onMessages) toast(`💬 ${m.fromName}: ${m.text.slice(0, 60)}${m.text.length > 60 ? "…" : ""}`);
  }
  primedMsgs = true;
}

// ---- the screen --------------------------------------------------------------------------------------------------
export function openMessages(container, { me, onExit, backLabel = "Home", onMaintenance = null, startRoot = null, onAnnouncement = null }) {
  const ui = {
    view: "list", key: null, setup: null, loadError: "", busy: false, message: "", messageKind: "", retry: null,
    draft: "", form: null, preview: null, hr: null, tab: "now",
  };
  // Opened from a task on Home: go straight to that message.
  if (startRoot) {
    const root = (data.messages || []).find((m) => m.id === startRoot);
    if (root?.fromEmp === me.emp && root.to?.type !== "person") Object.assign(ui, { view: "group", key: root.id });
    else if (root) Object.assign(ui, { view: "conv", key: root.fromEmp === me.emp ? conv(root.id, root.to.id) : conv(root.id, me.emp) });
  }
  let active = true;

  async function load() {
    if (!navigator.onLine) { ui.loadError = friendlyError({ code: "offline" }); return render(); }
    ui.loadError = "";
    try {
      ui.setup = (await callMessageStart()).data;
      if (!ui.setup.noticeSeen) showNotice();
    } catch (err) { ui.loadError = friendlyError(err); }
    render();
  }

  // The HR notice, the first time someone opens messaging (it also stays on the screen).
  async function showNotice() {
    await confirmSheet({ title: "💬 Messages", text: `${HR_LINE} ${SHIFT_LINE}`, confirmLabel: "I understand", cancelLabel: "Close" });
    try { await callMessagingNoticeSeen(); ui.setup.noticeSeen = true; } catch { /* shown again next time */ }
  }

  const go = (view, key = null) => { Object.assign(ui, { view, key, message: "", retry: null, draft: "" }); render(); window.scrollTo(0, 0); };
  const asked = new Map(); // conversation → when we last told the server it was read (once per new message)
  const markSeen = (keys, lastAt) => {
    const fresh = keys.filter((k) => (asked.get(k) || 0) < lastAt);
    if (!fresh.length) return;
    fresh.forEach((k) => asked.set(k, lastAt));
    callMessagesSeenNow({ convs: fresh }).catch(() => fresh.forEach((k) => asked.delete(k)));
  };

  // ---- bubbles ----
  function bubble(m, { mine, showTo = false }) {
    const delivered = (m.recipients || []).length;
    const status = mine
      ? m.kind === "new" && m.to?.type !== "person"
        ? `Delivered to ${delivered} of ${m.total}`
        : delivered ? "Delivered" : `Not delivered — ${m.why || "off shift"}`
      : "";
    const machineId = machineIn(m.text);
    return el("div", { class: mine ? "msg-bubble mine" : "msg-bubble" },
      !mine ? el("span", { class: "msg-from" }, m.fromName, m.fromRole ? el("span", { class: "person-meta" }, ` · ${m.fromRole}`) : null) : null,
      showTo && m.to ? el("span", { class: "person-meta" }, `${TO_ICON[m.to.type] || ""} To ${m.to.label}`) : null,
      el("p", { class: "msg-text" }, breakable(m.text)),
      el("span", { class: !mine || delivered ? "msg-meta" : "msg-meta warn" }, [fmtWhen(m.atMs), status].filter(Boolean).join(" · ")),
      maintenanceHint(m.text) && onMaintenance
        ? el("button", { class: "btn secondary small-btn", type: "button", onclick: () => onMaintenance(machineId, m.text) }, "🚨 Send as Maintenance Request")
        : null);
  }

  async function sendReply(c, quick = null) {
    const text = ui.draft.trim();
    if (!quick && !text) return;
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: () => sendReply(c, quick) }); return render(); }
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      const { data: r } = await callMessageReply({ rootId: c.rootId, participant: c.participant, ...(quick ? { quick } : { text }) });
      if (!quick) ui.draft = "";
      toast(r.delivered ? (quick === "help" ? "Sent — they've been alerted" : "Sent") : `Not delivered — ${r.why === "absent" ? "they're absent today" : r.why === "off hours" ? "outside their hours" : "they're off shift"}`);
    } catch (err) { Object.assign(ui, { message: friendlyError(err), messageKind: "error", retry: () => sendReply(c, quick) }); }
    ui.busy = false;
    render();
  }
  const QUICK = [["got", "👍 Got it"], ["done", "✔ Done"], ["help", "🆘 Need help – see me"]];
  const ACK_LABEL = { got: "✓ Got it", done: "✓ Done", help: "🆘 Need help", reply: "✓ Replied", "not-acknowledged": "Not acknowledged", waiting: "Waiting" };
  const ackOf = (root, emp) => (root.acks?.[emp] ? root.acks[emp].kind : Date.now() >= (root.shiftEndMs || Infinity) ? "not-acknowledged" : "waiting");
  const tasksOn = (rootId) => (data.annTasks || []).filter((t) => t.rootId === rootId && t.status !== "removed");

  // ---- views ----
  const notices = () => el("div", { class: "msg-notices" }, el("p", {}, `🕒 ${SHIFT_LINE}`), el("p", {}, `🔒 ${HR_LINE}`));

  function listView() {
    const s = ui.setup;
    const { items } = conversations(me.emp);
    const now = items.filter((c) => !c.cleared);
    const past = items.filter((c) => c.cleared);
    const anns = (data.announcements || []).filter((a) => (a.audienceEmps || []).includes(me.emp) && (!!data.mySigs?.[a.id] || (data.myOpens || []).some((o) => o.annId === a.id)))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    const row = (c) => {
      const mineLast = c.last?.fromEmp === me.emp;
      const sub = c.kind === "group"
        ? `Delivered to ${(c.root.recipients || []).length} of ${c.root.total} · ${c.replies} repl${c.replies === 1 ? "y" : "ies"}`
        : `${mineLast ? "You: " : ""}${c.last?.text || ""}`;
      return el("button", { class: c.unread ? "msg-item unread" : "msg-item", type: "button", onclick: () => go(c.kind === "group" ? "group" : "conv", c.key) },
        el("span", { class: "msg-item-icon", "aria-hidden": "true" }, c.kind === "group" ? TO_ICON[c.root.to?.type] || "📢" : c.root?.task ? "📋" : "👤"),
        el("span", { class: "msg-item-text" }, el("strong", {}, c.title), el("span", { class: "person-meta msg-preview" }, sub)),
        el("span", { class: "msg-item-side" }, el("span", { class: "person-meta" }, fmtWhen(c.last?.atMs)), c.unread ? el("span", { class: "msg-dot", "aria-label": `${c.unread} unread` }, String(c.unread)) : null));
    };
    const tabs = el("div", { class: "msg-tabs", role: "tablist" },
      [["now", `Messages${now.length ? ` (${now.length})` : ""}`], ["history", "History"]].map(([k, label]) =>
        el("button", { class: ui.tab === k ? "choice on" : "choice", type: "button", role: "tab", "aria-selected": String(ui.tab === k), onclick: () => { ui.tab = k; render(); } }, label)));
    return [
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "💬 Messages"),
      notices(),
      banner(ui),
      ui.loadError ? banner({ message: ui.loadError, messageKind: "error", retry: load }) : null,
      s?.canStart ? el("button", { class: "btn", type: "button", onclick: () => { ui.form = newForm(s); ui.preview = null; go("new"); if (ui.form.mix) refreshPreview(); } }, "✎ New message") : null,
      tabs,
      !data.messages ? spinner("Loading messages…")
        : ui.tab === "now"
          ? now.length ? el("div", { class: "msg-list" }, now.map(row)) : emptyState("Nothing new", s?.canStart ? "Tap “New message” to send one. Answered messages move to History." : "Messages from your leads show here. Answered ones move to History.")
          : [el("p", { class: "card-note" }, "Your messages from the last 90 days that you answered or that ended with the shift, and announcements you've finished."),
             past.length ? el("div", { class: "msg-list" }, past.map(row)) : el("p", { class: "card-note" }, "No past messages."),
             anns.length ? [el("h2", { class: "home-h2" }, "📣 Announcements you've finished"), el("div", { class: "msg-list" }, anns.map((a) => el("button", { class: "msg-item", type: "button", onclick: () => onAnnouncement?.(a.id) },
               el("span", { class: "msg-item-icon", "aria-hidden": "true" }, "📣"),
               el("span", { class: "msg-item-text" }, el("strong", {}, a.title), el("span", { class: "person-meta msg-preview" }, a.createdByName ? `from ${a.createdByName}` : "")),
               el("span", { class: "msg-item-side" }, el("span", { class: "person-meta" }, fmtWhen(a.createdAt?.toMillis?.() || 0))))))] : null],
      s?.noTeam?.length ? collapsible("msg-noteam", `👥 No team (${s.noTeam.length}) — when they get messages`,
        el("p", { class: "card-note" }, "People with no team (day staff, office) get messages that name them, their department, or everyone — never team, line, or role messages. They receive only in their hours (Admin → Message hours) and not when marked absent. Named, they get it right away unless marked absent."),
        el("p", {}, s.noTeam.join(", "))) : null,
      s?.hr ? el("button", { class: "btn secondary", type: "button", onclick: () => { ui.hr = { emp: "", reason: "", result: null, log: null }; go("hr"); } }, "🔒 Review someone's messages (HR)") : null,
    ];
  }

  function convView() {
    const { byConv } = conversations(me.emp);
    const c = byConv.get(ui.key);
    if (!c) return [el("button", { class: "link-btn", type: "button", onclick: () => go("list") }, "← Messages"), emptyState("That conversation is gone", "Messages are kept 90 days.")];
    if (c.unread) markSeen([c.key], c.last.atMs);
    const root = c.messages.find((m) => m.kind === "new") || c.groupRoot;
    const iStarted = (root?.fromEmp || c.groupRoot?.fromEmp) === me.emp;
    // Can reply: I got the first message, or I started it and it reached this person.
    const rootMsg = root || c.groupRoot;
    const canReply = iStarted ? (rootMsg?.recipients || []).includes(c.participant) : (rootMsg?.recipients || []).includes(me.emp);
    const msgs = c.groupRoot ? [c.groupRoot, ...c.messages] : c.messages;
    const canType = !!ui.setup?.canStart;
    const myAck = !iStarted && rootMsg?.acks?.[me.emp];
    const tasks = rootMsg ? tasksOn(rootMsg.id).filter((t) => (iStarted ? t.emp === c.participant : t.emp === me.emp)) : [];
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => (c.groupRoot ? go("group", c.groupRoot.id) : go("list")) }, c.groupRoot ? "← Group message" : "← Messages"),
      el("h1", {}, `💬 ${c.title}`),
      c.groupRoot ? el("p", { class: "hint" }, `Your message to ${c.groupRoot.to.label}, and ${c.title}'s replies — only you see them.`) : null,
      el("div", { class: "msg-thread" }, msgs.map((m) => bubble(m, { mine: m.fromEmp === me.emp, showTo: m.kind === "new" && m.to?.type !== "person" }))),
      iStarted && rootMsg && (rootMsg.recipients || []).includes(c.participant) ? el("p", { class: "msg-ack" }, `${c.title}: ${ACK_LABEL[ackOf(rootMsg, c.participant)]}`) : null,
      tasks.length ? el("section", { class: "card msg-task" }, el("strong", {}, "📋 Task"), el("div", { class: "task-list" }, tasks.map((t) => taskRow(t, me, { busy: ui.busy })))) : null,
      banner(ui),
      !canReply ? el("p", { class: "card-note" }, "This message didn't reach them, so there's nothing to reply to.")
        : [
            !iStarted ? el("div", { class: "msg-quick" },
              myAck ? el("p", { class: "card-note" }, `You answered: ${ACK_LABEL[myAck.kind]}`) : null,
              QUICK.map(([k, label]) => el("button", { class: k === "help" ? "btn secondary help-btn" : "btn secondary", type: "button", disabled: ui.busy, onclick: () => sendReply(c, k) }, label))) : null,
            canType ? el("form", { class: "msg-compose", onsubmit: (e) => { e.preventDefault(); sendReply(c); } },
              el("textarea", { class: "field", rows: "2", maxlength: "2000", placeholder: iStarted ? `Reply to ${c.title}` : `Reply to ${c.title} (only they see it)`, "aria-label": "Reply", oninput: (e) => { ui.draft = e.target.value; } }, ui.draft),
              el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Sending…" : "Send")) : null,
          ],
      notices(),
    ];
  }

  function groupView() {
    const { groups } = conversations(me.emp);
    const g = groups.get(ui.key);
    if (!g) return [el("button", { class: "link-btn", type: "button", onclick: () => go("list") }, "← Messages"), emptyState("That message is gone", "Messages are kept 90 days.")];
    const names = new Map((ui.setup?.people || []).map((p) => [p.emp, p.name]));
    const repliedBy = new Set(g.threads.map((t) => t.participant));
    const others = (g.root.recipients || []).filter((e) => !repliedBy.has(e));
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => go("list") }, "← Messages"),
      el("h1", {}, `${TO_ICON[g.root.to.type] || "📢"} ${g.root.to.label}`),
      el("div", { class: "msg-thread" }, bubble(g.root, { mine: true })),
      el("h2", { class: "home-h2" }, "Who got it"),
      el("div", { class: "msg-people" }, (g.root.recipients || []).map((e) => {
        const ack = ackOf(g.root, e);
        const t = tasksOn(g.rootId).find((x) => x.emp === e);
        return el("div", { class: ack === "not-acknowledged" ? "msg-person warn" : ack === "help" ? "msg-person help" : "msg-person" },
          el("span", { class: "person-name" }, names.get(e) || `#${e}`),
          el("span", { class: "person-meta" }, [ACK_LABEL[ack], t ? `task: ${t.status === "verified" ? "confirmed" : t.status === "done" ? "waiting for your confirmation" : "not done"}` : ""].filter(Boolean).join(" · ")),
          t && t.status === "done" ? taskRow(t, me, { busy: ui.busy }) : null);
      })),
      g.root.notDelivered ? el("p", { class: "card-note" }, `${g.root.notDelivered} didn't get it (off shift, outside their hours, or absent).`) : null,
      el("h2", { class: "home-h2" }, `Replies (${g.replies})`),
      g.threads.length
        ? el("div", { class: "msg-list" }, g.threads.sort((a, b) => b.last.atMs - a.last.atMs).map((t) => el("button", { class: t.unread ? "msg-item unread" : "msg-item", type: "button", onclick: () => go("conv", t.key) },
            el("span", { class: "msg-item-icon", "aria-hidden": "true" }, "👤"),
            el("span", { class: "msg-item-text" }, el("strong", {}, t.title), el("span", { class: "person-meta msg-preview" }, `${t.last.fromEmp === me.emp ? "You: " : ""}${t.last.text}`)),
            el("span", { class: "msg-item-side" }, el("span", { class: "person-meta" }, fmtWhen(t.last.atMs)), t.unread ? el("span", { class: "msg-dot" }, String(t.unread)) : null))))
        : el("p", { class: "card-note" }, "No replies yet. Replies come only to you."),
      others.length ? collapsible("msg-group-others", `Message someone who got it (${others.length})`,
        el("p", { class: "card-note" }, "Starts a conversation with that one person about this message."),
        picker({ title: "Who?", value: "", placeholder: "Pick someone…", options: others.map((e) => ({ value: e, label: names.get(e) || `#${e}` })), onChange: (e) => {
          const key = conv(g.rootId, e);
          ui.pending = { key, rootId: g.rootId, participant: e, title: names.get(e) || `#${e}` };
          go("start-reply");
        } })) : null,
      notices(),
    ];
  }

  // The starter's first reply to one person in a group message (no conversation yet).
  function startReplyView() {
    const p = ui.pending;
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => go("group", p.rootId) }, "← Group message"),
      el("h1", {}, `💬 ${p.title}`),
      banner(ui),
      el("form", { class: "msg-compose", onsubmit: (e) => { e.preventDefault(); sendReply(p).then(() => { if (!ui.message) go("conv", p.key); }); } },
        el("textarea", { class: "field", rows: "3", maxlength: "2000", placeholder: `Message ${p.title}`, "aria-label": "Message", oninput: (e) => { ui.draft = e.target.value; } }, ui.draft),
        el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Sending…" : "Send")),
    ];
  }

  // ---- new message ----
  // Admins and department heads build a mix (Decision 108): Admins start at Everyone, department heads at their own
  // department, and either adds or removes departments, teams, people (Admins also lines and roles).
  function newForm(s) {
    const start = s?.options?.start;
    const base = { text: "", isTask: false, taskEmps: null, dueMs: null };
    if (!start) return { ...base, type: "person", id: "" };
    return { ...base, mix: true, all: start.type === "all", parts: start.type === "set" ? start.parts.map((p) => ({ ...p })) : [] };
  }
  // What goes to the server: { type, id } or { type: "set", parts } (one person alone is a one-on-one).
  function toOf(f) {
    if (!f.mix) return { type: f.type, id: f.type === "all" ? "all" : f.id };
    if (f.all) return { type: "all", id: "all" };
    return f.parts.length === 1 && f.parts[0].type === "person" ? { ...f.parts[0] } : { type: "set", parts: f.parts };
  }
  const picked = (f) => (f.mix ? f.all || f.parts.length > 0 : f.type === "all" || !!f.id);
  async function refreshPreview() {
    const f = ui.form;
    ui.preview = null;
    if (!picked(f)) return render();
    try { ui.preview = (await callMessagePreview({ to: toOf(f) })).data; } catch { ui.preview = null; }
    // A task goes to people it reaches; all of them unless the sender unticks some. Due: end of this shift.
    f.taskEmps = new Set((ui.preview?.reachList || []).map((p) => p.emp));
    if (!f.dueMs) f.dueMs = ui.preview?.shiftEndMs || Date.now() + 8 * 3600000;
    if (active) render();
  }
  async function send() {
    const f = ui.form;
    if (!f.text.trim()) { Object.assign(ui, { message: "Write the message.", messageKind: "error" }); return render(); }
    if (!picked(f)) { Object.assign(ui, { message: "Pick who it's for.", messageKind: "error" }); return render(); }
    const to = toOf(f);
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: send }); return render(); }
    const pv = ui.preview;
    if (to.type === "line" && pv?.noOneOnLine) { Object.assign(ui, { message: `No one is assigned to ${pv.name} yet this shift. Seat people on the Crew Board first.`, messageKind: "error", retry: null }); return render(); }
    if (to.type === "person" && pv && pv.reach === 0) {
      const title = pv.why === "off hours" ? `${pv.name} gets messages only ${pv.dayHours}.` : `${pv.name} is ${pv.why === "absent" ? "absent" : "off shift"} today.`;
      if (!(await confirmSheet({ title, text: "They will not receive this. Send it anyway? It will show “Not delivered”.", confirmLabel: "Send anyway", danger: true }))) return;
    }
    // People with no team outside their hours (Decision 109): warn before a group message goes.
    if (to.type !== "person" && pv?.offHours && !(await confirmSheet({ title: `${pv.offHours} ${pv.offHours === 1 ? "person" : "people"} with no team won't get this.`, text: `People with no team get messages only ${pv.dayHours}. Send it anyway?`, confirmLabel: "Send anyway" }))) return;
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      const task = f.isTask ? { emps: [...(f.taskEmps || [])], dueMs: f.dueMs } : null;
      if (task && !task.emps.length) { Object.assign(ui, { busy: false, message: "Pick who does the task — only people it reaches now.", messageKind: "error", retry: null }); return render(); }
      const { data: r } = await callMessageSend({ to, text: f.text, task });
      ui.busy = false;
      toast(`${to.type === "person" ? (r.delivered ? "Sent" : "Not delivered") : `Delivered to ${r.delivered} of ${r.total}`}${r.tasks ? ` · task for ${r.tasks}` : ""}`);
      go(to.type === "person" ? "conv" : "group", to.type === "person" ? conv(r.id, to.id) : r.id);
    } catch (err) { Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: send }); render(); }
  }

  function newView() {
    const s = ui.setup;
    const f = ui.form;
    if (!s) return [spinner("Loading…")];
    const lists = { person: s.people.map((p) => ({ value: p.emp, label: p.team ? `${p.name} · ${p.team}` : p.name })), team: s.teams.map((t) => ({ value: t.id, label: t.name })), line: s.lines.map((l) => ({ value: l.id, label: l.name })), role: s.roles.map((r) => ({ value: r.id, label: r.name })) };
    const pv = ui.preview;
    const to = picked(f) ? toOf(f) : null;
    const reach = !pv || !to ? null
      : to.type === "person"
        ? pv.reach ? el("p", { class: "message" }, `✓ ${pv.name} is on shift now.`) : el("p", { class: "message error" }, pv.why === "off hours" ? `${pv.name} gets messages only ${pv.dayHours}. They will not receive this now.` : `${pv.name} is ${pv.why === "absent" ? "absent" : "off shift"} today. They will not receive this.`)
        : to.type === "line" && pv.noOneOnLine
          ? el("p", { class: "message error" }, `No one is assigned to ${pv.name} yet this shift.`)
          : el("p", { class: "message" }, el("strong", {}, `${pv.name || "Who it's for"} – ${pv.total} ${pv.total === 1 ? "person" : "people"}`),
              pv.total ? ` · ${pv.reach} ${pv.reach === 1 ? "gets" : "get"} it now (on shift, not absent).` : " · No one is in that group yet.",
              pv.offHours ? el("span", {}, ` ⚠ ${pv.offHours} with no team won't get it — they receive only ${pv.dayHours}.`) : null);
    // The mix builder (Admins and department heads, Decision 108).
    const o = s.options || {};
    const partName = (p) => (p.type === "department" ? `${(s.departments || []).find((x) => x.id === p.id)?.name || p.id} department`
      : p.type === "person" ? s.people.find((x) => x.emp === p.id)?.name || `#${p.id}`
      : (lists[p.type] || []).find((x) => x.value === p.id)?.label || p.id);
    const has = (type, id) => f.parts?.some((p) => p.type === type && p.id === id);
    const addPart = (type, id) => { if (id && !has(type, id)) f.parts.push({ type, id }); refreshPreview(); };
    const ADD = [["department", "+ Add a department", (s.departments || []).map((x) => ({ value: x.id, label: x.name }))], ["team", "+ Add a team", lists.team], ["line", "+ Add a line", lists.line], ["role", "+ Add a role", lists.role], ["person", "+ Add a person", lists.person]];
    const mixTo = f.mix ? [
      o.all ? el("div", { class: "choices two" },
        el("button", { class: f.all ? "choice on" : "choice", type: "button", "aria-pressed": String(f.all), onclick: () => { f.all = true; refreshPreview(); } }, "📢 Everyone"),
        el("button", { class: !f.all ? "choice on" : "choice", type: "button", "aria-pressed": String(!f.all), onclick: () => { f.all = false; refreshPreview(); } }, "🎯 Pick who"))
        : el("p", { class: "card-note" }, "Starts with your department. Add teams or people to reach more."),
      !f.all ? el("div", { class: "msg-people" },
        f.parts.map((p, i) => el("div", { class: "import-row" }, el("span", { class: "gap-term" }, partName(p)),
          el("button", { class: "link-btn", type: "button", onclick: () => { f.parts.splice(i, 1); refreshPreview(); } }, "Remove"))),
        ADD.filter(([type]) => (o.kinds || []).includes(type)).map(([type, label, options]) => {
          const left = (options || []).filter((x) => !has(type, x.value));
          return left.length ? picker({ title: label.slice(2), value: "", placeholder: label, options: left, onChange: (v) => addPart(type, v) }) : null;
        })) : null,
    ] : null;
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => go("list") }, "← Messages"),
      el("h1", {}, "✎ New message"),
      el("form", { class: "card msg-new", onsubmit: (e) => { e.preventDefault(); send(); } },
        el("span", { class: "field-label strong" }, "To"),
        mixTo,
        // Only the choices this sender has (Line Leads: one person, their team, their line today — Decision 117).
        f.mix ? null : el("div", { class: "choices msg-to" }, [["person", "👤 One person"], ["team", "🅰 A team"], ["line", "🏭 A line"], ["role", "🏷 A role"], ["all", "📢 Everyone"]]
          .filter(([t]) => (t === "all" ? s.options?.all !== false : !s.options?.kinds || s.options.kinds.includes(t))).map(([t, label]) =>
          el("button", { class: f.type === t ? "choice on" : "choice", type: "button", "aria-pressed": String(f.type === t), onclick: () => { Object.assign(f, { type: t, id: "" }); refreshPreview(); } }, label))),
        !f.mix && f.type !== "all" ? picker({ title: "Who?", value: f.id, placeholder: "Pick…", options: lists[f.type], onChange: (v) => { f.id = v; refreshPreview(); } }) : null,
        reach,
        el("span", { class: "field-label strong" }, "Message"),
        el("textarea", { class: "field", rows: "4", maxlength: "2000", oninput: (e) => { f.text = e.target.value; const h = maintenanceHint(f.text); if (h !== !!ui.hint) { ui.hint = h; render(); } } }, f.text),
        el("label", { class: "check-row" },
          el("input", { type: "checkbox", checked: !!f.isTask, onchange: (e) => { f.isTask = e.target.checked; render(); } }),
          el("span", {}, el("strong", {}, "📋 This is a task"), " — they tap Done; you confirm it.")),
        f.isTask ? el("div", { class: "msg-taskbox" },
          (pv?.reachList || []).length
            ? [el("span", { class: "field-label" }, "Who does it? (people it reaches now)"),
               el("div", { class: "ck-list" }, pv.reachList.map((p) => el("div", { class: f.taskEmps?.has(p.emp) ? "ck-item on" : "ck-item" },
                 el("label", { class: "check-row" },
                   el("input", { type: "checkbox", checked: !!f.taskEmps?.has(p.emp), onchange: (e) => { if (e.target.checked) f.taskEmps.add(p.emp); else f.taskEmps.delete(p.emp); render(); } }),
                   el("span", { class: "person-name" }, p.name)))))]
            : el("p", { class: "card-note" }, "Pick who it's for first — the task goes to the people it reaches now."),
          f.dueMs ? [el("label", { class: "field-label", for: "msg-due" }, `Due by (starts at the end of this shift: ${fmtDue(f.dueMs)})`),
            el("input", { class: "field", id: "msg-due", type: "datetime-local", value: new Date(f.dueMs - new Date(f.dueMs).getTimezoneOffset() * 60000).toISOString().slice(0, 16), onchange: (e) => { const ms = new Date(e.target.value).getTime(); if (Number.isFinite(ms)) f.dueMs = ms; } })] : null) : null,
        ui.hint && onMaintenance ? el("div", { class: "msg-maint" },
          el("span", { class: "card-note" }, "Sounds like a machine problem — you can also send it to Maintenance."),
          el("button", { class: "btn secondary", type: "button", onclick: () => onMaintenance(machineIn(f.text), f.text) }, "🚨 Send as Maintenance Request")) : null,
        banner(ui),
        el("button", { class: "btn", type: "submit", disabled: ui.busy || (to?.type === "line" && !!pv?.noOneOnLine) }, ui.busy ? "Sending…" : "Send")),
      notices(),
    ];
  }

  // ---- HR review ----
  async function hrOpen() {
    const h = ui.hr;
    if (!h.emp) { Object.assign(ui, { message: "Pick the person.", messageKind: "error" }); return render(); }
    if (h.reason.trim().length < 10) { Object.assign(ui, { message: "Write the reason (at least 10 characters) — it's kept in the log.", messageKind: "error" }); return render(); }
    Object.assign(ui, { busy: true, message: "" });
    render();
    try { h.result = (await callHrReviewMessages({ emp: h.emp, reason: h.reason })).data; } catch (err) { Object.assign(ui, { message: friendlyError(err), messageKind: "error", retry: hrOpen }); }
    ui.busy = false;
    render();
  }
  async function hrLog() {
    try { ui.hr.log = (await callHrMessageReviewLog()).data.reviews; } catch (err) { ui.hr.log = []; Object.assign(ui, { message: friendlyError(err), messageKind: "error", retry: hrLog }); }
    render();
  }
  function hrView() {
    const h = ui.hr;
    if (h.log === null) { h.log = undefined; hrLog(); }
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => go("list") }, "← Messages"),
      el("h1", {}, "🔒 Review messages"),
      el("p", { class: "hint" }, "Open one person's messages (sent and received, the last 90 days). The reason, your name, and the time are logged."),
      banner(ui),
      h.result
        ? el("section", { class: "card" },
            el("strong", {}, `${h.result.empName} — ${h.result.messages.length} message${h.result.messages.length === 1 ? "" : "s"}`),
            h.result.messages.length ? el("div", { class: "msg-review" }, h.result.messages.map((m) => el("div", { class: "msg-review-row" },
              el("span", { class: "person-meta" }, `${fmtWhen(m.atMs)} · ${m.fromName} → ${m.to?.label || ""}${m.delivered ? "" : " · not delivered to them"}`),
              el("p", { class: "msg-text" }, breakable(m.text))))) : el("p", { class: "card-note" }, "No messages in the last 90 days."),
            el("button", { class: "btn secondary", type: "button", onclick: () => { Object.assign(h, { emp: "", reason: "", result: null }); render(); } }, "Done"))
        : el("section", { class: "card" },
            el("span", { class: "field-label strong" }, "Whose messages"),
            picker({ title: "Whose messages?", value: h.emp, placeholder: "Pick the person…", options: (ui.setup?.people || []).map((p) => ({ value: p.emp, label: p.name })), onChange: (v) => { h.emp = v; render(); } }),
            el("span", { class: "field-label strong" }, "Reason (kept in the log)"),
            el("textarea", { class: "field", rows: "2", maxlength: "300", placeholder: "e.g. Complaint about a message on Oct 22", oninput: (e) => { h.reason = e.target.value; } }, h.reason),
            el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: hrOpen }, ui.busy ? "Opening…" : "Open their messages")),
      collapsible("msg-hr-log", "Review log", h.log === undefined ? spinner("Loading…") : h.log.length
        ? el("div", { class: "msg-review" }, h.log.map((r) => el("div", { class: "msg-review-row" }, el("strong", {}, `${r.byName} opened ${r.empName}'s messages`), el("span", { class: "person-meta" }, `${fmtWhen(r.atMs)} · ${r.reason}`))))
        : el("p", { class: "card-note" }, "No reviews yet.")),
    ];
  }

  // Redraws keep the cursor where it was (a new message can arrive while someone is typing).
  function render() {
    if (!active) return;
    const typing = container.contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA" ? document.activeElement : null;
    const caret = typing ? typing.selectionStart : 0;
    const views = { list: listView, conv: convView, group: groupView, new: newView, hr: hrView, "start-reply": startReplyView };
    const parts = (views[ui.view] || listView)();
    container.replaceChildren(...parts.flat(3).filter(Boolean));
    if (typing) {
      const again = container.querySelector("textarea");
      if (again) { again.focus(); again.setSelectionRange(caret, caret); }
    }
  }

  load();
  render();
  const off = onDataChange(() => { if (ui.view !== "hr") render(); });
  return () => { active = false; off(); };
}
