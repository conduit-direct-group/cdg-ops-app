// Station checklists (Decision 63) — from the Daily Check List: Reel Building and Reclamation, one per station per
// shift. Items come from each station's form (Admin → Forms). Anyone signed in ticks tasks and fills in the counts
// (saved as they go); one person signs it off with their PIN once everything is done.
// Leads and supervisors see on Home which stations aren't signed off this shift (red in the last hour).

import { el, friendlyError, spinner, emptyState, banner, toast, collapsible } from "./ui.js";
import { dueByShiftEnd } from "./shift.js";
import { data, onDataChange } from "./data.js";
import { TEST_MODE, callStartStationList, callSaveStationList, callSignStationList } from "./firebase.js";
import { signOff, signedNote } from "./signoff.js";
import { offlineSign } from "./outbox.js";

const TASKLIST_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
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
  const open = forms.filter((f) => !listFor(f.id, now)?.signed);
  if (!open.length) return [{ key: "stations", icon: "📋", title: "Station checklists", detail: "all signed off", state: "done", onOpen: () => onOpen(null) }];
  const due = dueByShiftEnd();
  return [{ key: "stations", icon: "📋", title: `Station checklists — not signed off: ${open.map((x) => x.name).join(", ")}`, ...due,
    onOpen: () => onOpen(open.length === 1 ? open[0].id : null) }];
}


// ===========================================================================

export function openStations(container, { me, startForm = null, onExit }) {
  const ui = { formId: startForm, id: null, values: null, busy: false, save: "", message: "", messageKind: "", retry: null, starting: false };
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
    if (r) toast(signedNote(r, `${r.form} signed off by ${r.name}${r.test ? " (test)" : ""}`));
  }

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
        el("span", { class: signed ? "tag ok" : late ? "tag off" : "tag warn" }, signed ? "✓ Signed off" : left ? `${left} left` : "Ready to sign off"),
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
        ? el("p", { class: "message ok" }, `✓ Signed off by ${l.signed.name} · ${fmtWhen(l.signed.at)}${l.signed.device?.label ? ` · ${l.signed.device.label}` : ""}`)
        : [el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: () => sign(l) }, "✍ Sign off"),
           el("p", { class: "hint" }, `Tick every task and fill in every count, then sign with your PIN${TEST_MODE ? " — test site, practice only" : ""}.`)],
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
          el("span", { class: "person-meta" }, l?.signed ? `Signed off by ${l.signed.name} · ${fmtWhen(l.signed.at)}` : l ? `${left} left` : "Not started this shift"),
          el("span", { class: "tags" }, el("span", { class: l?.signed ? "tag ok" : "tag warn" }, l?.signed ? "✓ Signed off" : "To do"), l?.test ? el("span", { class: "tag test" }, "TEST") : null));
      })) : null,
      past.length ? collapsible("stations-past", `Recent shifts (${past.length})`, el("div", { class: "person-list" }, past.map((l) =>
        el("div", { class: "person-row static" },
          el("span", { class: "person-name" }, `${l.formName} · ${l.shift.name} shift · ${dayLabel(l.date)}`),
          el("span", { class: "person-meta" }, l.signed ? `✓ Signed off by ${l.signed.name}` : "Not signed off"),
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
    if (!ui.id || !ui.values || l?.signed) render();
  });
  if (startForm) openStation(startForm); else render();
  return () => { stop(); clearTimeout(saveTimer); };
}
