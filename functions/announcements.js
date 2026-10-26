// Announcements with "Read & understood" sign-off. No database code here, so it can be tested on its own.
//
// An announcement goes to an audience: everyone, or any mix of roles, teams, lines (home line), and people.
// When it is posted the server turns the audience into a fixed list of employee numbers (`audienceEmps`) —
// the database rules show it only to them. "Keep for new hires": anyone who matches the audience later
// (new hire, new role, new team) is added to the list too.
//
// Editing the words, attachment, or priority makes a new version: everyone signs again (old signatures stay).
// Who tracks it: the poster, Production Manager, Office, Admin (everyone in the audience); Supervisors (their crew).

const PRIORITIES = ["normal", "important", "safety"];

// Roles that may post when an admin hasn't set it on the Roles screen yet (Chris, 10-20-2026).
const DEFAULT_POSTER_ROLES = ["admin", "plant-manager", "supervisor", "training-safety", "office"];

// See every announcement and everyone's sign-offs. Supervisors see their crew only.
const SEE_ALL_ROLES = ["admin", "plant-manager", "office"];
const CREW_ROLES = ["supervisor"];
// May record "Reviewed in person" for someone with no login yet.
const IN_PERSON_ROLES = ["supervisor", "plant-manager", "admin"];
// Important: only the Line Leads and Supervisors in the audience sign ("Read & relayed to crew"); the crew sees it
// but doesn't sign (Chris, 10-23-2026). Normal and Safety: everyone in the audience signs.
const RELAY_ROLES = ["lead", "supervisor"];

const clean = (v, max) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));
const ids = (v) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);

// Can someone with these roles post? `roleDocs` = the Roles list ({ id, canPostAnnouncements? }).
function rolePosts(role) {
  return typeof role.canPostAnnouncements === "boolean" ? role.canPostAnnouncements : DEFAULT_POSTER_ROLES.includes(role.id);
}
// Decision 106: only department heads and Admins post announcements. person: { roles, deptHead }.
const canPostNow = (person) => (person?.roles || []).includes("admin") || person?.deptHead === true;
// (Older rule, kept for screens not yet updated: the per-role switch in Admin → Roles.)
function canPost(roleDocs, myRoles) {
  return (roleDocs || []).some((r) => r.active !== false && (myRoles || []).includes(r.id) && rolePosts(r));
}

// What the poster sends. `known` = { roles, teams, lines } (ids that exist), `bucketPath(url)` = our storage
// path for a file link or null. Returns { announcement } or { error }.
function cleanAnnouncement(data, known, bucketPath, today) {
  const title = clean(data?.title, 120).replace(/\s+/g, " ");
  if (title.length < 3) return { error: "Give it a title (a few words)." };
  const body = clean(data?.body, 10000);
  if (body.length < 3) return { error: "Write the message." };
  const priority = PRIORITIES.includes(data?.priority) ? data.priority : null;
  if (!priority) return { error: "Pick a priority: Normal, Important, or Safety." };
  if (!isDay(data?.ackBy)) return { error: "Pick an “acknowledge by” date." };
  const endDate = data?.endDate ? String(data.endDate) : null;
  if (endDate && !isDay(endDate)) return { error: "The end date isn't a date." };
  if (endDate && endDate < data.ackBy) return { error: "The end date can't be before the “acknowledge by” date." };
  if (endDate && today && endDate < today) return { error: "The end date has already passed." };

  let file = null;
  if (data?.file) {
    const url = String(data.file.url || "");
    const kind = data.file.kind === "pdf" ? "pdf" : data.file.kind === "image" ? "image" : null;
    if (!kind || !bucketPath(url)) return { error: "That attachment didn't upload. Add it again." };
    file = { url, kind, name: clean(data.file.name, 120) || (kind === "pdf" ? "Document.pdf" : "Photo") };
  }

  const a = data?.audience || {};
  // roleTeams: the roles picked reach only people on these teams (their own team, or a team a Supervisor covers) —
  // e.g. the Line Leads and Supervisors of Team B only (Chris, 10-23-2026). Empty = the roles on every team.
  const audience = { everyone: a.everyone === true, roles: ids(a.roles), roleTeams: ids(a.roleTeams), teams: ids(a.teams), lines: ids(a.lines), people: ids(a.people) };
  if (audience.everyone) Object.assign(audience, { roles: [], roleTeams: [], teams: [], lines: [], people: [] });
  if (!audience.roles.length) audience.roleTeams = [];
  if (!audience.everyone && !audience.roles.length && !audience.teams.length && !audience.lines.length && !audience.people.length) {
    return { error: "Pick who it's for: everyone, or some roles, teams, lines, or people." };
  }
  for (const [key, label] of [["roles", "roles"], ["teams", "teams"], ["lines", "lines"]]) {
    if (audience[key].some((id) => !known[key].includes(id))) return { error: `Pick ${label} from the list.` };
  }
  if (audience.roleTeams.some((id) => !known.teams.includes(id))) return { error: "Pick teams from the list." };
  if (audience.people.some((p) => !/^[A-Za-z0-9]{1,12}$/.test(p))) return { error: "Pick people from the list." };

  return { announcement: { title, body, priority, ackBy: data.ackBy, endDate, file, audience, keepForNewHires: data?.keepForNewHires === true, isTask: data?.isTask === true } };
}

// Audience -> employee numbers of everyone on (active) who matches.
// employees: [{ id, roles, team, supervisesTeams, lineIds (the lines they're on this shift — Decision 104), active }]
function matchAudience(audience, employees) {
  const on = employees.filter((e) => e.active !== false);
  const limit = audience.roleTeams || [];
  const onRoleTeams = (e) => !limit.length || limit.includes(e.team) || (e.supervisesTeams || []).some((t) => limit.includes(t));
  const hit = (e) =>
    audience.everyone === true ||
    ((e.roles || []).some((r) => (audience.roles || []).includes(r)) && onRoleTeams(e)) ||
    (e.team && (audience.teams || []).includes(e.team)) ||
    (e.lineIds || []).some((l) => (audience.lines || []).includes(l)) ||
    (audience.people || []).includes(e.id);
  return on.filter(hit).map((e) => e.id).sort();
}

// A supervisor's crew: people on the same team. No team: no crew (set it in Admin → People). No home lines (Decision 104).
function crewOf(supervisor, employees) {
  if (!supervisor) return [];
  const on = employees.filter((e) => e.active !== false && e.id !== supervisor.id);
  if (supervisor.team) return on.filter((e) => e.team === supervisor.team).map((e) => e.id);
  return [];
}

const has = (roles, list) => (roles || []).some((r) => list.includes(r));

// Does someone with these roles sign this announcement? And who in the audience signs: people = [{ id, roles }].
const signsIt = (announcement, roles) => announcement.priority !== "important" || has(roles, RELAY_ROLES);
function signersOf(announcement, people) {
  const byId = new Map(people.map((p) => [p.id, p]));
  return (announcement.audienceEmps || []).filter((e) => signsIt(announcement, byId.get(e)?.roles));
}

// Who may open the tracking list: the poster and Production Manager/Office/Admin see everyone; supervisors their crew.
// Returns "all", "crew", or null.
function trackScope(me, announcement) {
  if (announcement.createdBy === me.id || has(me.roles, SEE_ALL_ROLES)) return "all";
  if (has(me.roles, CREW_ROLES)) return "crew";
  return null;
}

// Stored on the announcement so the database rules can let them read it: the poster plus every supervisor
// with at least one crew member in the audience.
function trackersFor(createdBy, audienceEmps, employees) {
  const inAudience = new Set(audienceEmps);
  const sups = employees.filter((e) => e.active !== false && has(e.roles, CREW_ROLES) && crewOf(e, employees).some((id) => inAudience.has(id)));
  return [...new Set([createdBy, ...sups.map((e) => e.id)])].sort();
}

// New list after people change: kept-for-new-hires announcements add anyone who now matches (nobody is
// dropped — once it was theirs to sign, it stays theirs). Others keep the list they were posted with.
function refreshedAudience(announcement, employees) {
  const now = announcement.audienceEmps || [];
  if (!announcement.keepForNewHires) return now;
  return [...new Set([...now, ...matchAudience(announcement.audience || {}, employees)])].sort();
}

// The words, attachment, or priority changed: a new version that everyone must sign again.
function contentChanged(before, after) {
  return before.title !== after.title || before.body !== after.body || before.priority !== after.priority ||
    (before.file?.url || "") !== (after.file?.url || "");
}

// Dates are plant days ("YYYY-MM-DD", Cedar Rapids time).
function isEnded(a, today) {
  return a.ended === true || (!!a.endDate && a.endDate < today);
}
function isOverdue(a, today) {
  return !!a.ackBy && a.ackBy < today;
}

// Sign-off status of one person on one announcement. sig = their signature for the current version, or null.
// person = { id, name, loginEnabled, team, lineIds }
function personStatus(person, sig) {
  if (sig) return { state: sig.method === "in-person" ? "in-person" : "signed", ...person, sig };
  return { state: person.loginEnabled ? "not-signed" : "no-login", ...person, sig: null };
}

// "18 of 24 signed" — counts for a list of personStatus results.
function countUp(list) {
  const signed = list.filter((p) => p.state === "signed" || p.state === "in-person").length;
  return { total: list.length, signed, notSigned: list.filter((p) => p.state === "not-signed").length, noLogin: list.filter((p) => p.state === "no-login").length };
}

// A short device description for the sign-off record: { id, kind: "line-tablet" | "personal", label }.
function cleanDevice(d) {
  const id = typeof d?.id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(d.id) ? d.id : "unknown";
  const kind = d?.kind === "line-tablet" ? "line-tablet" : "personal";
  const label = clean(d?.label, 80) || (kind === "line-tablet" ? "Line tablet" : "Personal device");
  return { id, kind, label };
}

module.exports = {
  PRIORITIES, canPostNow, DEFAULT_POSTER_ROLES, SEE_ALL_ROLES, CREW_ROLES, IN_PERSON_ROLES, RELAY_ROLES, signsIt, signersOf,
  rolePosts, canPost, cleanAnnouncement, matchAudience, crewOf, trackScope, trackersFor, refreshedAudience,
  contentChanged, isEnded, isOverdue, personStatus, countUp, cleanDevice,
};
