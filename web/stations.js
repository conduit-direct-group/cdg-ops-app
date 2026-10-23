// Station checklists (Decision 63) — from the Daily Check List: Reel Building and Reclamation, one per station per
// shift. Items come from each station's form (Admin → Forms). Anyone signed in ticks tasks and fills in the counts
// (saved as they go); the person who did it signs Done with their PIN once everything is done, then someone else signs
// Verified (two-step sign-off, functions/verify.js: a Supervisor, or with no Supervisor on shift the Production Manager
// or a Line Lead). Green only when both have signed. "Do again" reopens a signed checklist with a reason; the old
// sign-offs stay in its history. Leads and supervisors see on Home which stations aren't done and verified this shift
// (red in the last hour).

import { el, friendlyError, spinner, emptyState, banner, toast, collapsible, breakable } from "./ui.js";
import { dueByShiftEnd } from "./shift.js";
import { data, onDataChange } from "./data.js";
import { TEST_MODE, callStartStationList, callSaveStationList, callSignStationList, callRedoStationList, callStationVerifiers } from "./firebase.js";
import { signOff, signedNote } from "./signoff.js";
import { offlineSign } from "./outbox.js";

const TASKLIST_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const VERIFY_ROLES = ["supervisor", "plant-manager", "lead"]; // the server decides who may verify right now
const verifiedText = (c) => `${c.name}${c.roleName ? ` (${c.roleName}${c.backup ? " — no Supervisor on shift" : ""})` : ""}`;
const SHIFT_FORM = "clean-shop"; // shift times are kept on the Keep the Shop Clean form
const PLANT_TZ = "America/Chicago";

function plantClock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const addDay = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
function currentShift(shifts, nowMs = Date.now()) {
  const { date, minutes } = plantClock(nowMs);
  for (const s of shifts || []) {
    const a = toMin(s.start), b = toMin(s.end);
    if (b > a && minutes >= a && minutes < b) return { shift: s, date };
    if (b <= a && minutes >= a) return { shift: s, date };
    if (b <= a && minutes < b) return { shift: s, date: addDay(date, -1) };
  }
  return null;
}

export const stationForms = () => (data.formTemplates || []).filter((t) => t.kind === "station" && t.active !== false).sort((a, b) => a.name.localeCompare(b.name));
const shiftNow = () => currentShift((data.formTemplates || []).find((t) => t.id === SHIFT_FORM)?.shifts);
const listFor = (formId, now) => (now ? (data.stationLists || []).find((l) => l.id === `${now.date}__${now.shift.id}__${formId}`) : null) || null;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : t?.seconds ? t.seconds * 1000 : 0);
const fmtWhen = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

// Same rule as the server: every task ticked, every count filled in.
function missing(sections, values) {
  const out = [];
  for (const s of sections || []) for (const f of s.fields || []) {
    if (f.type === "task" && values?.[f.id] !== true) out.push(f.label);
    if (["number", "percent"].includes(f.type) && (values?.[f.id] === undefined || values?.[f.id] === null || values?.[f.id] === "")) out.push(f.label);
  }
  return out;
}

// Home item (Decision 66), leads and supervisors: the station checklists for this shift — gray "due by 5:00 PM",
// red in the last hour, green when every station is signed off.
export function stationItems(roles, onOpen) {
  if (!(roles || []).some((r) => TASKLIST_ROLES.includes(r)) || !data.formTemplates || !data.stationLists) return [];
  const forms = stationForms();
  const now = shiftNow();
  if (!forms.length || !now) return [];
  const open = forms.filter((f) => !listFor(f.id, now)?.verified);
  if (!open.length) return [{ key: "stations", icon: "📋", title: "Station checklists", detail: "all done and verified", state: "done", onOpen: () => onOpen(null) }];
  const due = dueByShiftEnd();
  const toVerify = open.filter((f) => listFor(f.id, now)?.signed);
  const notDone = open.filter((f) => !listFor(f.id, now)?.signed);
  const title = [notDone.length && `not done: ${notDone.map((x) => x.name).join(", ")}`, toVerify.length && `needs Verified: ${toVerify.map((x) => x.name).join(", ")}`].filter(Boolean).join(" · ");
  return [{ key: "stations", icon: "📋", title: `Station checklists — ${title}`, ...due,
    onOpen: () => onOpen(open.length === 1 ? open[0].id : null) }];
}


// ===========================================================================

export function openStations(container, { me, startForm = null, onExit }) {
  const ui = { formId: startForm, id: null, values: null, busy: false, save: "", message: "", messageKind: "", retry: null, starting: false, redo: null };
  const runs = me.roles.some((r) => TASKLIST_ROLES.includes(r));
  let saveTimer = null;
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false }); render(); };
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);

  // Open (or make) this shift's checklist for the station.
  async function openStation(formId) {
    Object.assign(ui, { formId, id: null, values: null, starting: true, message: "", save: "" });
    render();
    try {
      const { data: r } = await callStartStationList({ formId });
      Object.assign(ui, { id: r.id, starting: false });
    } catch (err) {
      ui.starting = false;
      say(friendlyError(err), () => openStation(formId));
    }
    render();
    window.scrollTo(0, 0);
  }

  function setSave(text) {
    ui.save = text;
    const n = container.querySelector("#st-save");
    if (n) n.textContent = text;
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    setSave("Saving…");
    saveTimer = setTimeout(async () => {
      try { await callSaveStationList({ id: ui.id, values: ui.values }); setSave("✓ Saved"); } catch (err) { setSave(`Not saved — ${friendlyError(err)}`); }
    }, 1000);
  }

  async function sign(l) {
    clearTimeout(saveTimer);
    const left = missing(l.sections, ui.values);
    if (left.length) return say(`Not done yet: ${left.slice(0, 4).join(", ")}${left.length > 4 ? ` +${left.length - 4} more` : ""}.`);
    const r = await signOff({
      title: "Sign off", what: `${l.formName} · ${l.shift.name} shift · ${dayLabel(l.date)}`,
      me: { emp: me.emp, name: me.name },
      action: offlineSign("signStationList", { id: l.id, values: ui.values }, { label: `${l.formName} · ${l.shift.name} shift`, key: `station:${l.id}` }),
    });
    if (r) toast(signedNote(r, `${r.form} done — ${r.name}${r.test ? " (test)" : ""}`));
  }

  // Verified: someone other than the person who signed it Done.
  async function verify(l) {
    const canMe = me.roles.some((x) => VERIFY_ROLES.includes(x)) && l.signed?.emp !== me.emp;
    const r = await signOff({
      title: "Verified", what: `${l.formName} · ${l.shift.name} shift · ${dayLabel(l.date)} · done by ${l.signed.name}`,
      me: canMe ? { emp: me.emp, name: me.name } : null,
      others: async () => (await callStationVerifiers({ id: l.id })).data.people,
      action: offlineSign("verifyStationList", { id: l.id }, { label: `${l.formName} verified · ${l.shift.name} shift`, key: `station-verify:${l.id}` }),
    });
    if (r) toast(signedNote(r, `Verified by ${r.name}${r.role ? ` (${r.role})` : ""}${r.test ? " (test)" : ""}`));
  }

  // Do again: reopen with a short reason (the old Done / Verified stay in the history).
  async function redo(l) {
    const reason = (ui.redo?.reason || "").trim();
    if (reason.length < 3) return say("Add a short reason (for example: “Gaylord count is off”).");
    Object.assign(ui, { busy: true, message: "", retry: null });
    render();
    try {
      const { data: r } = await callRedoStationList({ id: l.id, reason });
      Object.assign(ui, { busy: false, redo: null, values: null });
      toast(`Reopened: ${r.form}${r.test ? " (test)" : ""}`);
      render();
    } catch (err) { say(friendlyError(err), () => redo(l)); }
  }
  const historyText = (h) => `↺ Do again — “${h.reason}” · by ${h.byName} · ${fmtWhen(h.at)} (was done by ${h.prevDone?.name || "?"}${h.prevCheck ? `, verified by ${h.prevCheck.name}` : ""})`;

  function field(f, signed) {
    const v = ui.values[f.id];
    if (f.type === "task") {
      return el("label", { class: v === true ? "check-row ck-item on station-task" : "check-row station-task" },
        el("input", { type: "checkbox", checked: v === true, disabled: signed || ui.busy, onchange: (e) => { if (e.target.checked) ui.values[f.id] = true; else delete ui.values[f.id]; scheduleSave(); e.target.closest("label").classList.toggle("on", e.target.checked); } }),
        el("span", {}, el("span", { class: "person-name" }, f.label), f.help ? el("span", { class: "ck-last" }, f.help) : null));
    }
    const id = `st-${f.id}`;
    const input = f.type === "longtext"
      ? el("textarea", { class: "field", id, rows: "3", disabled: signed, value: v ?? "", oninput: (e) => { const x = e.target.value; if (x) ui.values[f.id] = x; else delete ui.values[f.id]; scheduleSave(); } })
      : el("div", { class: "num-wrap" },
          el("input", { class: ["number", "percent"].includes(f.type) ? "field num-field" : "field", id, type: "text", inputmode: ["number", "percent"].includes(f.type) ? "numeric" : "text", autocomplete: "off", disabled: signed, value: v ?? "",
            oninput: (e) => { const x = e.target.value.trim(); if (x) ui.values[f.id] = x; else delete ui.values[f.id]; scheduleSave(); } }),
          f.unit || f.type === "percent" ? el("span", { class: "num-unit" }, f.type === "percent" ? "%" : f.unit) : null);
    return el("div", { class: "ho-field" }, el("label", { class: "field-label strong", for: id }, f.label), f.help ? el("p", { class: "card-note" }, f.help) : null, input);
  }

  function renderList(l) {
    if (!ui.values) ui.values = JSON.parse(JSON.stringify(l.values || {}));
    const signed = !!l.signed;
    const left = missing(l.sections, ui.values).length;
    const late = !signed && Date.now() >= l.endMs - (l.redMinutes ?? 60) * 60000;
    return [
      back("Station checklists", () => { clearTimeout(saveTimer); Object.assign(ui, { formId: null, id: null, values: null }); render(); }),
      el("h1", {}, `📋 ${l.formName}`),
      el("p", { class: "hint" }, `${l.shift.name} shift · ${dayLabel(l.date)} · ends ${fmtTime(l.endMs)} · form revision ${l.formRev}`),
      el("p", { class: "tags ann-tags" },
        el("span", { class: l.verified ? "tag ok" : late ? "tag off" : "tag warn" }, l.verified ? "✓ Done and verified" : signed ? "Done — needs Verified" : left ? `${left} left` : "Ready to sign Done"),
        l.test ? el("span", { class: "tag test" }, "TEST") : null,
        signed ? null : el("span", { class: "save-state", id: "st-save", role: "status" }, ui.save)),
      l.intro ? el("p", { class: "message" }, l.intro) : null,
      banner(ui),
      (l.sections || []).map((s) => el("section", { class: "card ho-section" },
        el("h2", {}, s.title),
        s.help ? el("p", { class: "card-note" }, s.help) : null,
        el("div", { class: "ck-list" }, s.fields.filter((f) => f.type === "task").map((f) => field(f, signed))),
        s.fields.filter((f) => f.type !== "task").map((f) => field(f, signed)))),
      signed
        ? el("p", { class: l.verified ? "message ok" : "message" }, `✓ Done by ${l.signed.name} · ${fmtWhen(l.signed.at)}${l.signed.device?.label ? ` · ${l.signed.device.label}` : ""}`)
        : [el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: () => sign(l) }, "✍ Sign Done"),
           el("p", { class: "hint" }, `Tick every task and fill in every count, then sign with your PIN${TEST_MODE ? " — test site, practice only" : ""}.`)],
      signed && l.verified ? el("p", { class: "message ok" }, `✓ Verified by ${verifiedText(l.verified)} · ${fmtWhen(l.verified.at)}`) : null,
      signed && !l.verified
        ? [el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: () => verify(l) }, "✍ Verified"),
           el("p", { class: "hint" }, "A Supervisor verifies — or, with no Supervisor on shift, the Production Manager or a Line Lead. Not the person who signed it Done.")]
        : null,
      signed && runs && !ui.redo ? el("button", { class: "link-btn", type: "button", disabled: ui.busy, onclick: () => { ui.redo = { reason: "" }; render(); } }, "↺ Do again") : null,
      signed && runs && ui.redo
        ? el("form", { class: "redo-form", onsubmit: (e) => { e.preventDefault(); redo(l); } },
            el("label", { class: "field-label", for: "st-redo" }, "Why does it need doing again?"),
            el("input", { class: "field", id: "st-redo", maxlength: "300", required: true, value: ui.redo.reason, placeholder: "e.g. Gaylord count is off", oninput: (e) => { ui.redo.reason = e.target.value; } }),
            el("div", { class: "btn-row" },
              el("button", { class: "btn", type: "submit", disabled: ui.busy }, "↺ Do again"),
              el("button", { class: "btn secondary", type: "button", disabled: ui.busy, onclick: () => { ui.redo = null; render(); } }, "Cancel")))
        : null,
      (l.history || []).length
        ? collapsible(`station-history-${l.id}`, `🕘 History (${l.history.length})`, el("ul", { class: "history-list" }, [...l.history].reverse().map((h) => el("li", {}, breakable(historyText(h))))))
        : null,
    ];
  }

  function renderPick() {
    const forms = stationForms();
    const now = shiftNow();
    const loading = !data.formTemplates || !data.stationLists;
    const past = (data.stationLists || []).filter((l) => !now || !(l.date === now.date && l.shift.id === now.shift.id));
    return [
      back("Home", onExit),
      el("h1", {}, "📋 Station checklists"),
      el("p", { class: "hint" }, now ? `${now.shift.name} shift · ${dayLabel(now.date)}. Do every item before shift change.` : "Do every item before shift change."),
      banner(ui),
      loading ? spinner() : !forms.length ? emptyState("No station checklists yet", "An admin loads them in Admin → Forms.") : !now ? emptyState("No shift is running right now", "Check the shift times in Admin → Forms.") : null,
      now ? el("div", { class: "person-list" }, forms.map((f) => {
        const l = listFor(f.id, now);
        const left = l ? missing(l.sections, l.values).length : null;
        return el("button", { class: "person-row", type: "button", onclick: () => openStation(f.id) },
          el("span", { class: "person-name" }, f.name),
          el("span", { class: "person-meta" }, l?.verified ? `Done by ${l.signed.name} · verified by ${verifiedText(l.verified)}` : l?.signed ? `Done by ${l.signed.name} · ${fmtWhen(l.signed.at)}` : l ? `${left} left` : "Not started this shift"),
          el("span", { class: "tags" }, el("span", { class: l?.verified ? "tag ok" : "tag warn" }, l?.verified ? "✓ Done and verified" : l?.signed ? "Needs Verified" : "To do"), l?.test ? el("span", { class: "tag test" }, "TEST") : null));
      })) : null,
      past.length ? collapsible("stations-past", `Recent shifts (${past.length})`, el("div", { class: "person-list" }, past.map((l) =>
        el("div", { class: "person-row static" },
          el("span", { class: "person-name" }, `${l.formName} · ${l.shift.name} shift · ${dayLabel(l.date)}`),
          el("span", { class: "person-meta" }, l.verified ? `✓ Done by ${l.signed.name} · verified by ${verifiedText(l.verified)}` : l.signed ? `Done by ${l.signed.name} · not verified` : "Not signed Done"),
          el("span", { class: "person-meta" }, (l.sections || []).flatMap((s) => s.fields).filter((f) => f.type !== "task" && l.values?.[f.id] != null).map((f) => `${f.label}: ${l.values[f.id]}`).join(" · ")))))) : null,
    ];
  }

  function render() {
    const l = ui.id ? (data.stationLists || []).find((x) => x.id === ui.id) : null;
    const content = ui.starting ? [back("Station checklists", () => { ui.starting = false; render(); }), spinner("Opening the checklist…")]
      : l ? renderList(l)
      : ui.id ? [back("Station checklists", () => { ui.id = null; render(); }), spinner("Opening the checklist…")]
      : renderPick();
    container.replaceChildren(...[content].flat(3).filter(Boolean));
  }

  // Live updates redraw the list of stations, and an open checklist only once it's signed (never mid-typing).
  const stop = onDataChange(() => {
    if (ui.busy) return;
    const l = ui.id ? (data.stationLists || []).find((x) => x.id === ui.id) : null;
    if (!ui.id || !ui.values || (l?.signed && !ui.redo)) render();
  });
  if (startForm) openStation(startForm); else render();
  return () => { stop(); clearTimeout(saveTimer); };
}
