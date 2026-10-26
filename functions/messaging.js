// In-app messaging (Chris, 10-23-2026, Decision 102; launch list 5). No database code here, so it can be tested alone.
//
// Who starts (Decision 106 — a list, not role rank): Line Leads, Supervisors, department heads (⭐ head of a department),
// the Production Manager, Admins — one-on-one, or to a team, a line, a role, or everyone. They can type replies;
// everyone else replies only with quick buttons ("Got it" / "Done" / "Need help – see me"). A reply to a group message
// goes only to its sender. "Need help" alerts the sender right away (if they're on shift).
// Clearing (Decision 106): a message leaves a person's screen once they tap a quick reply (and, if it's a task for them,
// once the task is confirmed); unacknowledged, it leaves at the end of the shift it came in — the sender sees
// "Not acknowledged" for that person. Cleared messages are in History (90 days).
// Who receives: only people on their designated shift and not marked absent on Who's here today, decided when the
// message is sent — anything else is never delivered (not held, not queued).
// People with no team (day staff, office — Decision 109): they get only messages that name them — never team, line,
// role, department, or everyone messages. Named, they get it right away unless marked absent.
// Who can send to what (Decision 108): Admins — everyone by default, or any mix of people, teams, departments, lines,
// and roles. Department heads — their own department by default, widened with teams or people. Line Leads,
// Supervisors, the Production Manager — one person, a team, a line, a role, or everyone (as before).
// Covering: someone marked Here on a shift that isn't their team's is covering — they get team, line, and role
// messages for that shift (team messages to the team on shift included), never anyone's one-on-one.
// Lines (Decision 104): nobody has a home line — a line message goes to whoever the Crew Board put on that line for the
// block running now (ctx.lineNow { emp: [lineId] }). No one on it yet: the message isn't sent.
//
//   messages/{auto}   rootId (own id for a new message), conv ("{rootId}__{participant}" for replies; "" for a root),
//                     kind "new" | "reply", fromEmp, fromName, fromRole, to { type, id, label } (type "set": a mix —
//                     { type: "set", parts: [{ type, id }], label }), text, atMs,
//                     recipients [emp] (who it was delivered to), total (how many it was for), notDelivered (count),
//                     why ("off shift" | "absent" — one-on-one only), shiftEndMs (end of the shift it was sent in),
//                     acks { emp: { kind: "got" | "done" | "help" | "reply", atMs } }, task { emps, dueMs } | null, quick
//                     (on a quick reply: its kind), test
//   Each conversation is between the starter and one participant: a one-on-one's person, or each group member.
//   messagesSeen/{emp}   seen { conv: atMs } — what that person has read (own only)
//   messageReviews/{auto}  HR access opened someone's messages: by, byName, emp, empName, reason, atMs
// Kept 90 days (record retention, Decision 99). Test site: test_ copies.

const START_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const TARGETS = ["person", "team", "line", "role", "department", "all", "set"];
const PART_TYPES = ["person", "team", "line", "role", "department"];
const MAX_PARTS = 30;
const MAX_TEXT = 2000;
const MAINT_WORDS = /\b(down|leak|leaking|leaks|broken|broke|jam|jammed|jams|not working)\b/i;
const M_NUMBER = /\bM-?\d{3}\b/i;

// person: { roles, deptHead } — the people on the list start messages and type replies.
const canStart = (person) => (person?.roles || []).some((r) => START_ROLES.includes(r)) || person?.deptHead === true;
const QUICK = { got: "Got it", done: "Done", help: "Need help – see me" };
const cleanQuick = (v) => (Object.prototype.hasOwnProperty.call(QUICK, v) ? { kind: v, text: QUICK[v] } : { error: "Pick Got it, Done, or Need help." });

// A task on a new message: { emps (who it's for — only people it reached), dueMs } → { task } or { error }.
function cleanMessageTask(raw, recipients, nowMs) {
  if (!raw) return { task: null };
  const emps = Array.isArray(raw.emps) ? [...new Set(raw.emps.map(String))] : [];
  if (!emps.length) return { error: "Pick who does the task." };
  if (emps.length > 50) return { error: "Up to 50 people on one task." };
  if (emps.some((e) => !recipients.includes(e))) return { error: "A task can go only to people the message reaches now (on shift, not absent)." };
  const dueMs = Number(raw.dueMs);
  if (!Number.isFinite(dueMs) || dueMs < nowMs - 60000) return { error: "Pick a due time that hasn't passed." };
  if (dueMs > nowMs + 31 * 86400000) return { error: "Pick a due time within a month." };
  return { task: { emps, dueMs: Math.round(dueMs) } };
}

// Where a message stands for one person who got it. → "got" | "done" | "help" | "reply" | "not-acknowledged" | "waiting"
function ackStatus(root, emp, nowMs) {
  const a = root.acks?.[emp];
  if (a) return a.kind;
  return nowMs >= (root.shiftEndMs || Infinity) ? "not-acknowledged" : "waiting";
}
// Off this person's screen (into History)? taskConfirmed: their task on it is confirmed (or there is none).
function clearedFor(root, emp, nowMs, taskConfirmed = true) {
  if (nowMs >= (root.shiftEndMs || Infinity)) return true;
  return !!root.acks?.[emp] && taskConfirmed;
}
const ROLE_LABELS = [["admin", "Admin"], ["plant-manager", "Production Manager"], ["supervisor", "Supervisor"], ["lead", "Line Lead"]];
const startRole = (roles = []) => ROLE_LABELS.find(([r]) => roles.includes(r))?.[1] || "";

function cleanText(v) {
  const text = typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT) : "";
  return text ? { text } : { error: "Write a message." };
}

function cleanTo(raw) {
  const type = TARGETS.includes(raw?.type) ? raw.type : "";
  if (!type) return { error: "Pick who it's for." };
  if (type === "set") {
    const seen = new Set();
    const parts = [];
    for (const x of Array.isArray(raw?.parts) ? raw.parts : []) {
      const t = PART_TYPES.includes(x?.type) ? x.type : "";
      const id = typeof x?.id === "string" ? x.id.trim().slice(0, 60) : "";
      if (!t || !id) return { error: "Pick who it's for from the lists." };
      if (!seen.has(`${t}:${id}`)) { seen.add(`${t}:${id}`); parts.push({ type: t, id }); }
    }
    if (!parts.length) return { error: "Pick who it's for." };
    if (parts.length > MAX_PARTS) return { error: `Up to ${MAX_PARTS} picks on one message.` };
    // One person alone is a one-on-one.
    return { to: parts.length === 1 && parts[0].type === "person" ? parts[0] : { type, parts } };
  }
  const id = type === "all" ? "all" : typeof raw?.id === "string" ? raw.id.trim().slice(0, 60) : "";
  if (!id) return { error: "Pick who it's for." };
  return { to: { type, id } };
}

// What a sender may send to (Decision 108). person: { roles, deptHead, department }.
// → { kinds: [part types], all: bool, departments: "any" | [own department] , start: default "to" or null }
function sendOptions(person) {
  const roles = person?.roles || [];
  const kinds = new Set();
  let all = false;
  let departments = [];
  const admin = roles.includes("admin");
  const head = person?.deptHead === true && !!person?.department;
  if (admin) { ["person", "team", "line", "role", "department"].forEach((k) => kinds.add(k)); all = true; departments = "any"; }
  if (roles.some((r) => ["lead", "supervisor", "plant-manager"].includes(r))) { ["person", "team", "line", "role"].forEach((k) => kinds.add(k)); all = true; }
  if (head) { ["person", "team", "department"].forEach((k) => kinds.add(k)); if (departments !== "any") departments = [person.department]; }
  if (!kinds.has("department")) departments = [];
  const start = admin ? { type: "all" } : head ? { type: "set", parts: [{ type: "department", id: person.department }] } : null;
  return { kinds: [...kinds], all, departments, start };
}
// Is this "to" allowed for the sender? → error text or "".
function checkTo(to, opts) {
  const parts = to.type === "set" ? to.parts : to.type === "all" ? [] : [to];
  if (to.type === "all" && !opts.all) return "Send to your department, teams, or people — not everyone.";
  for (const p of parts) {
    if (!opts.kinds.includes(p.type)) return p.type === "department" ? "Only Admins and department heads send to a department." : `You can't send to a ${p.type} — pick ${opts.kinds.join(", ")}.`;
    if (p.type === "department" && opts.departments !== "any" && !opts.departments.includes(p.id)) return "Department heads send to their own department.";
  }
  return "";
}

// Where someone stands right now. ctx: { teamOnShift (team id or null), marks ({ emp: { status } } for this shift) }.
//   "on" — on their team's shift · "noteam" — no team (gets it when named, unless absent) · "covering" — Here on another team's shift
//   "absent" — marked Out this shift · "off" — not their shift
function standing(p, ctx) {
  const mark = ctx.marks?.[p.id]?.status;
  if (mark === "out") return "absent";
  if (!p.team) return "noteam";
  if (ctx.teamOnShift && p.team === ctx.teamOnShift) return "on";
  if (mark === "here") return "covering";
  return "off";
}
const receives = (s) => s === "on" || s === "noteam" || s === "covering";

// Is one person in one target? Team messages to the team on shift reach the people covering that shift too.
function inPart(p, part, ctx) {
  switch (part.type) {
    case "person": return p.id === part.id;
    case "team": return p.team === part.id || (part.id === ctx.teamOnShift && standing(p, ctx) === "covering");
    case "line": return (ctx.lineNow?.[p.id] || []).includes(part.id);
    case "role": return (p.roles || []).includes(part.id);
    case "department": return p.department === part.id;
    default: return true; // everyone
  }
}
// Everyone a message to `to` is meant for (before the shift check), not the sender. people: active, non-practice.
// People with no team count only where they're named (Decision 109).
function audience(people, to, fromEmp, ctx) {
  const parts = to.type === "set" ? to.parts : [to];
  return people.filter((p) => p.id !== fromEmp && parts.some((part) => inPart(p, part, ctx) && (p.team || part.type === "person")));
}

// Who gets it now: { recipients [emp], total, notDelivered, why (one-on-one: "off shift" | "absent" | "") }.
function deliver(people, to, fromEmp, ctx) {
  const list = audience(people, to, fromEmp, ctx);
  const recipients = list.filter((p) => receives(standing(p, ctx))).map((p) => p.id);
  const why = to.type === "person" && list.length && !recipients.length ? (standing(list[0], ctx) === "absent" ? "absent" : "off shift") : "";
  return { recipients, total: list.length, notDelivered: list.length - recipients.length, why };
}

// One reply goes to one person, with the same shift check. → { recipients, why }
function deliverOne(person, ctx) {
  const s = person ? standing(person, ctx) : "off";
  return receives(s) ? { recipients: [person.id], why: "" } : { recipients: [], why: s === "absent" ? "absent" : "off shift" };
}

// "Send as Maintenance Request" shows for a machine number or trouble words — never blocks the message.
const maintenanceHint = (text) => M_NUMBER.test(text || "") || MAINT_WORDS.test(text || "");
const machineNumber = (text) => (String(text || "").match(M_NUMBER)?.[0] || "").toUpperCase().replace(/^M-?/, "M-");

const conv = (rootId, participant) => `${rootId}__${participant}`;

function cleanReason(v) {
  const reason = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return reason.length >= 10 ? { reason } : { error: "Write the reason (at least 10 characters) — it's kept in the log." };
}

module.exports = {
  START_ROLES, TARGETS, PART_TYPES, MAX_PARTS, sendOptions, checkTo, inPart,
 MAX_TEXT, QUICK, canStart, cleanQuick, cleanMessageTask, ackStatus, clearedFor, startRole, cleanText, cleanTo, standing, receives, audience, deliver, deliverOne,
  maintenanceHint, machineNumber, conv, cleanReason,
};
