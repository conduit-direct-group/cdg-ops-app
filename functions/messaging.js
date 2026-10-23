// In-app messaging (Chris, 10-23-2026, Decision 102; launch list 5). No database code here, so it can be tested alone.
//
// Who starts: Line Lead and above (lead, supervisor, plant-manager, admin) — one-on-one, or to a team, a line, a role,
// or everyone. Everyone replies to what they received; a reply to a group message goes only to its sender.
// Who receives: only people on their designated shift and not marked absent on Who's here today, decided when the
// message is sent — anything else is never delivered (not held, not queued). People with no team are always on shift.
// Covering: someone marked Here on a shift that isn't their team's is covering — they get team, line, and role
// messages for that shift (team messages to the team on shift included), never anyone's one-on-one.
//
//   messages/{auto}   rootId (own id for a new message), conv ("{rootId}__{participant}" for replies; "" for a root),
//                     kind "new" | "reply", fromEmp, fromName, fromRole, to { type, id, label }, text, atMs,
//                     recipients [emp] (who it was delivered to), total (how many it was for), notDelivered (count),
//                     why ("off shift" | "absent" — one-on-one only), test
//   Each conversation is between the starter and one participant: a one-on-one's person, or each group member.
//   messagesSeen/{emp}   seen { conv: atMs } — what that person has read (own only)
//   messageReviews/{auto}  HR access opened someone's messages: by, byName, emp, empName, reason, atMs
// Kept 90 days (record retention, Decision 99). Test site: test_ copies.

const START_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const TARGETS = ["person", "team", "line", "role", "all"];
const MAX_TEXT = 2000;
const MAINT_WORDS = /\b(down|leak|leaking|leaks|broken|broke|jam|jammed|jams|not working)\b/i;
const M_NUMBER = /\bM-?\d{3}\b/i;

const canStart = (roles = []) => roles.some((r) => START_ROLES.includes(r));
// Admin → Roles can turn starting messages on or off per role (Decision 103): role.startMessages; unset = the default.
const roleStarts = (role) => (typeof role.startMessages === "boolean" ? role.startMessages : START_ROLES.includes(role.id));
const canStartWith = (roleDocs, myRoles = []) => (roleDocs || []).some((r) => r.active !== false && myRoles.includes(r.id) && roleStarts(r));
const ROLE_LABELS = [["admin", "Admin"], ["plant-manager", "Production Manager"], ["supervisor", "Supervisor"], ["lead", "Line Lead"]];
const startRole = (roles = []) => ROLE_LABELS.find(([r]) => roles.includes(r))?.[1] || "";

function cleanText(v) {
  const text = typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, MAX_TEXT) : "";
  return text ? { text } : { error: "Write a message." };
}

function cleanTo(raw) {
  const type = TARGETS.includes(raw?.type) ? raw.type : "";
  if (!type) return { error: "Pick who it's for." };
  const id = type === "all" ? "all" : typeof raw?.id === "string" ? raw.id.trim().slice(0, 60) : "";
  if (!id) return { error: "Pick who it's for." };
  return { to: { type, id } };
}

// Where someone stands right now. ctx: { teamOnShift (team id or null), marks ({ emp: { status } } for this shift) }.
//   "on" — on their team's shift · "noteam" — no team yet (always on) · "covering" — Here on another team's shift
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

// Everyone a message to `to` is meant for (before the shift check), not the sender. people: active, non-practice.
function audience(people, to, fromEmp, ctx) {
  const pick = (fn) => people.filter((p) => p.id !== fromEmp && fn(p));
  switch (to.type) {
    case "person": return pick((p) => p.id === to.id);
    // Team messages to the team on shift reach the people covering that shift too.
    case "team": return pick((p) => p.team === to.id || (to.id === ctx.teamOnShift && standing(p, ctx) === "covering"));
    case "line": return pick((p) => p.homeLineId === to.id);
    case "role": return pick((p) => (p.roles || []).includes(to.id));
    default: return pick(() => true);
  }
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
  START_ROLES, TARGETS, MAX_TEXT, canStart, roleStarts, canStartWith, startRole, cleanText, cleanTo, standing, receives, audience, deliver, deliverOne,
  maintenanceHint, machineNumber, conv, cleanReason,
};
