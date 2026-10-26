// In-app messaging (Chris, 10-23-2026, Decision 102; launch list 5). Rules: functions/messaging.js.
// Line Lead and above start messages (one person, a team, a line, a role, or everyone); everyone replies to what they
// got, and a reply to a group message goes only to its sender. You get messages only while on your shift and not
// marked absent — the server decides that when a message is sent, and anything else is never delivered.
// Every conversation is between the starter and one person: "{rootId}__{participant}". A group message the starter
// sent shows as one item with its replies grouped by person. HR access opens one person's messages only with a reason.
//   Home: a "💬 New messages" line under the announcements; More → 💬 Messages; a pop-up when one arrives.

import { el, breakable, friendlyError, spinner, emptyState, banner, toast, picker, confirmSheet, collapsible } from "./ui.js";
import { data, onDataChange } from "./data.js";
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
  for (const c of byConv.values()) {
    c.messages.sort((a, b) => a.atMs - b.atMs);
    const root = roots.get(c.rootId);
    if (root && root.fromEmp === emp && root.to?.type !== "person") { c.groupRoot = root; } // a person's thread inside my group message
    c.last = c.messages[c.messages.length - 1];
    c.unread = c.messages.filter((m) => m.fromEmp !== emp && (m.recipients || []).includes(emp) && m.atMs > (seen[c.key] || 0)).length;
    c.title = c.otherName || "Message";
    if (!c.groupRoot) items.push(c);
  }
  for (const g of groups.values()) {
    const threads = [...byConv.values()].filter((c) => c.groupRoot?.id === g.rootId);
    g.threads = threads;
    g.last = [g.root, ...threads.map((t) => t.last)].sort((a, b) => b.atMs - a.atMs)[0];
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
  if (!unread.length) return null;
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
export function openMessages(container, { me, onExit, backLabel = "Home", onMaintenance = null }) {
  const ui = {
    view: "list", key: null, setup: null, loadError: "", busy: false, message: "", messageKind: "", retry: null,
    draft: "", form: null, preview: null, hr: null,
  };
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
        : delivered ? "Delivered" : `Not delivered — ${m.why === "absent" ? "absent" : "off shift"}`
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

  async function sendReply(c) {
    const text = ui.draft.trim();
    if (!text) return;
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: () => sendReply(c) }); return render(); }
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      const { data: r } = await callMessageReply({ rootId: c.rootId, participant: c.participant, text });
      ui.draft = "";
      toast(r.delivered ? "Sent" : `Not delivered — ${r.why === "absent" ? "they're absent today" : "they're off shift"}`);
    } catch (err) { Object.assign(ui, { message: friendlyError(err), messageKind: "error", retry: () => sendReply(c) }); }
    ui.busy = false;
    render();
  }

  // ---- views ----
  const notices = () => el("div", { class: "msg-notices" }, el("p", {}, `🕒 ${SHIFT_LINE}`), el("p", {}, `🔒 ${HR_LINE}`));

  function listView() {
    const s = ui.setup;
    const { items } = conversations(me.emp);
    return [
      el("button", { class: "link-btn", type: "button", onclick: onExit }, `← ${backLabel}`),
      el("h1", {}, "💬 Messages"),
      notices(),
      banner(ui),
      ui.loadError ? banner({ message: ui.loadError, messageKind: "error", retry: load }) : null,
      s?.canStart ? el("button", { class: "btn", type: "button", onclick: () => { ui.form = { type: "person", id: "", text: "" }; ui.preview = null; go("new"); } }, "✎ New message") : null,
      !data.messages ? spinner("Loading messages…")
        : items.length ? el("div", { class: "msg-list" }, items.map((c) => {
            const mineLast = c.last?.fromEmp === me.emp;
            const sub = c.kind === "group"
              ? `Delivered to ${(c.root.recipients || []).length} of ${c.root.total} · ${c.replies} repl${c.replies === 1 ? "y" : "ies"}`
              : `${mineLast ? "You: " : ""}${c.last?.text || ""}`;
            return el("button", { class: c.unread ? "msg-item unread" : "msg-item", type: "button", onclick: () => go(c.kind === "group" ? "group" : "conv", c.key) },
              el("span", { class: "msg-item-icon", "aria-hidden": "true" }, c.kind === "group" ? TO_ICON[c.root.to?.type] || "📢" : "👤"),
              el("span", { class: "msg-item-text" },
                el("strong", {}, c.title),
                el("span", { class: "person-meta msg-preview" }, sub)),
              el("span", { class: "msg-item-side" }, el("span", { class: "person-meta" }, fmtWhen(c.last?.atMs)), c.unread ? el("span", { class: "msg-dot", "aria-label": `${c.unread} unread` }, String(c.unread)) : null));
          }))
        : emptyState("No messages yet", s?.canStart ? "Tap “New message” to send one." : "Messages from your Line Lead and Supervisors show here."),
      s?.noTeam?.length ? collapsible("msg-noteam", `👥 No team yet — always receive messages (${s.noTeam.length})`,
        el("p", { class: "card-note" }, "Until they have a team (Admin → People), these people are treated as always on shift."),
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
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => (c.groupRoot ? go("group", c.groupRoot.id) : go("list")) }, c.groupRoot ? "← Group message" : "← Messages"),
      el("h1", {}, `💬 ${c.title}`),
      c.groupRoot ? el("p", { class: "hint" }, `Your message to ${c.groupRoot.to.label}, and ${c.title}'s replies — only you see them.`) : null,
      el("div", { class: "msg-thread" }, msgs.map((m) => bubble(m, { mine: m.fromEmp === me.emp, showTo: m.kind === "new" && m.to?.type !== "person" }))),
      banner(ui),
      canReply
        ? el("form", { class: "msg-compose", onsubmit: (e) => { e.preventDefault(); sendReply(c); } },
            el("textarea", { class: "field", rows: "2", maxlength: "2000", placeholder: iStarted ? `Reply to ${c.title}` : `Reply to ${c.title} (only they see it)`, "aria-label": "Reply", oninput: (e) => { ui.draft = e.target.value; } }, ui.draft),
            el("button", { class: "btn", type: "submit", disabled: ui.busy }, ui.busy ? "Sending…" : "Send"))
        : el("p", { class: "card-note" }, "This message didn't reach them, so there's nothing to reply to."),
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
  async function refreshPreview() {
    const f = ui.form;
    ui.preview = null;
    if (!f.id && f.type !== "all") return render();
    try { ui.preview = (await callMessagePreview({ to: { type: f.type, id: f.type === "all" ? "all" : f.id } })).data; } catch { ui.preview = null; }
    if (active) render();
  }
  async function send() {
    const f = ui.form;
    if (!f.text.trim()) { Object.assign(ui, { message: "Write the message.", messageKind: "error" }); return render(); }
    if (f.type !== "all" && !f.id) { Object.assign(ui, { message: "Pick who it's for.", messageKind: "error" }); return render(); }
    if (!navigator.onLine) { Object.assign(ui, { message: friendlyError({ code: "offline" }), messageKind: "error", retry: send }); return render(); }
    const pv = ui.preview;
    if (f.type === "line" && pv?.noOneOnLine) { Object.assign(ui, { message: `No one is assigned to ${pv.name} yet this shift. Seat people on the Crew Board first.`, messageKind: "error", retry: null }); return render(); }
    if (f.type === "person" && pv && pv.reach === 0) {
      const why = pv.why === "absent" ? "absent" : "off shift";
      if (!(await confirmSheet({ title: `${pv.name} is ${why} today.`, text: "They will not receive this. Send it anyway? It will show “Not delivered”.", confirmLabel: "Send anyway", danger: true }))) return;
    }
    Object.assign(ui, { busy: true, message: "" });
    render();
    try {
      const { data: r } = await callMessageSend({ to: { type: f.type, id: f.type === "all" ? "all" : f.id }, text: f.text });
      ui.busy = false;
      toast(f.type === "person" ? (r.delivered ? "Sent" : "Not delivered") : `Delivered to ${r.delivered} of ${r.total}`);
      go(f.type === "person" ? "conv" : "group", f.type === "person" ? conv(r.id, f.id) : r.id);
    } catch (err) { Object.assign(ui, { busy: false, message: friendlyError(err), messageKind: "error", retry: send }); render(); }
  }

  function newView() {
    const s = ui.setup;
    const f = ui.form;
    if (!s) return [spinner("Loading…")];
    const lists = { person: s.people.map((p) => ({ value: p.emp, label: p.team ? `${p.name} · ${p.team}` : p.name })), team: s.teams.map((t) => ({ value: t.id, label: t.name })), line: s.lines.map((l) => ({ value: l.id, label: l.name })), role: s.roles.map((r) => ({ value: r.id, label: r.name })) };
    const pv = ui.preview;
    const reach = !pv ? null
      : f.type === "person"
        ? pv.reach ? el("p", { class: "message" }, `✓ ${pv.name} is on shift now.`) : el("p", { class: "message error" }, `${pv.name} is ${pv.why === "absent" ? "absent" : "off shift"} today. They will not receive this.`)
        : f.type === "line" && pv.noOneOnLine
          ? el("p", { class: "message error" }, `No one is assigned to ${pv.name} yet this shift.`)
          : el("p", { class: "message" }, pv.total ? `Will reach ${pv.reach} of ${pv.total} — only people on shift and not absent get it.` : "No one is in that group yet.");
    return [
      el("button", { class: "link-btn", type: "button", onclick: () => go("list") }, "← Messages"),
      el("h1", {}, "✎ New message"),
      el("form", { class: "card msg-new", onsubmit: (e) => { e.preventDefault(); send(); } },
        el("span", { class: "field-label strong" }, "To"),
        el("div", { class: "choices msg-to" }, [["person", "👤 One person"], ["team", "🅰 A team"], ["line", "🏭 A line"], ["role", "🏷 A role"], ["all", "📢 Everyone"]].map(([t, label]) =>
          el("button", { class: f.type === t ? "choice on" : "choice", type: "button", "aria-pressed": String(f.type === t), onclick: () => { Object.assign(f, { type: t, id: "" }); refreshPreview(); } }, label))),
        f.type !== "all" ? picker({ title: "Who?", value: f.id, placeholder: "Pick…", options: lists[f.type], onChange: (v) => { f.id = v; refreshPreview(); } }) : null,
        reach,
        el("span", { class: "field-label strong" }, "Message"),
        el("textarea", { class: "field", rows: "4", maxlength: "2000", oninput: (e) => { f.text = e.target.value; const h = maintenanceHint(f.text); if (h !== !!ui.hint) { ui.hint = h; render(); } } }, f.text),
        ui.hint && onMaintenance ? el("div", { class: "msg-maint" },
          el("span", { class: "card-note" }, "Sounds like a machine problem — you can also send it to Maintenance."),
          el("button", { class: "btn secondary", type: "button", onclick: () => onMaintenance(machineIn(f.text), f.text) }, "🚨 Send as Maintenance Request")) : null,
        banner(ui),
        el("button", { class: "btn", type: "submit", disabled: ui.busy || (f.type === "line" && !!pv?.noOneOnLine) }, ui.busy ? "Sending…" : "Send")),
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
