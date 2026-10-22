// Line Check Log (Decision 64) — from the Line Daily Checklist. On the line tablet, every N minutes (30), per line:
// readings (vacuum, flow meters, barrel and die temps) and checks (front waters, pipe appearance, inkjet, die buildup,
// purge steam on L3). Big number boxes, never pre-filled — the last reading shows in gray so people read the gauge.
// A reading outside its range (set in Admin → Forms; none yet) or a "Not OK" check turns red, needs a note, and alerts
// the Line Lead. A timer shows when the next check is due (red when overdue). Page 2 is plant-wide: one tap per item
// stamps the time and name, with the expected count per shift. Operator signs at end of shift; Supervisor reviews.

import { el, friendlyError, spinner, emptyState, banner, toast, collapsible } from "./ui.js";
import { data, onDataChange } from "./data.js";
import {
  TEST_MODE, callStartLineLog, callAddLineRound, callSaveLineNotes, callTapPlantItem, callSignLineLog, callReviewLineLog, callLineLogReviewers,
} from "./firebase.js";
import { signOff, signedNote } from "./signoff.js";
import { offlineSign } from "./outbox.js";

const LINE_FORM = "line-check";
const SHIFT_FORM = "clean-shop";
const LEAD_ROLES = ["lead", "supervisor", "plant-manager", "admin"];
const CHECK_ROLES = ["supervisor", "plant-manager", "admin"];
const PLANT_TZ = "America/Chicago";
const LINE_KEY = "cdg.lineCheckLine"; // the line this device last logged (line tablets stay on their line)

function plantClock(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: PLANT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const addDay = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
// The shift running now and roughly when it started (ms), from plant time.
function currentShift(shifts, nowMs = Date.now()) {
  const { date, minutes } = plantClock(nowMs);
  for (const s of shifts || []) {
    const a = toMin(s.start), b = toMin(s.end);
    let d = null, since = 0;
    if (b > a && minutes >= a && minutes < b) { d = date; since = minutes - a; }
    else if (b <= a && minutes >= a) { d = date; since = minutes - a; }
    else if (b <= a && minutes < b) { d = addDay(date, -1); since = minutes + 1440 - a; }
    if (d) return { shift: s, date: d, startMs: nowMs - since * 60000 };
  }
  return null;
}

const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const toMs = (t) => (typeof t === "number" ? t : t?.toMillis ? t.toMillis() : t instanceof Date ? t.getTime() : t?.seconds ? t.seconds * 1000 : 0);
const fmtTime = (t) => new Date(toMs(t)).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const fmtWhen = (t) => (toMs(t) ? new Date(toMs(t)).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const lineForm = () => (data.formTemplates || []).find((t) => t.id === LINE_FORM && t.active !== false) || null;
const shiftNow = () => currentShift((data.formTemplates || []).find((t) => t.id === SHIFT_FORM)?.shifts);
const logFor = (lineId, now) => (now ? (data.lineLogs || []).find((l) => l.id === `${now.date}__${now.shift.id}__${lineId}`) : null) || null;
const plantFor = (now) => (now ? (data.plantLogs || []).find((p) => p.id === `${now.date}__${now.shift.id}`) : null) || null;
const activeLines = () => (data.lines || []).filter((l) => l.active !== false);

// Same as the server: a line's own range wins, else the all-lines range.
function limitsFor(field, lineId) {
  const own = field.lineLimits?.[lineId];
  const min = own && (own.min !== null || own.max !== null) ? own.min : field.min ?? null;
  const max = own && (own.min !== null || own.max !== null) ? own.max : field.max ?? null;
  return min === null && max === null ? null : { min, max };
}
const outOfRange = (field, lineId, v) => {
  if (v === "" || v === null || v === undefined) return false;
  const n = Number(String(v).replace(/,/g, ""));
  const lim = limitsFor(field, lineId);
  return Number.isFinite(n) && !!lim && ((lim.min !== null && n < lim.min) || (lim.max !== null && n > lim.max));
};
const rangeText = (lim, unit) => (!lim ? "" : lim.min !== null && lim.max !== null ? `${lim.min}–${lim.max}${unit ? ` ${unit}` : ""}` : lim.min !== null ? `at least ${lim.min}` : `at most ${lim.max}`);

// Next check due: every N minutes after the last round (or after the shift started).
function due(log, now, every) {
  const last = log?.rounds?.length ? toMs(log.rounds[log.rounds.length - 1].at) : 0;
  const dueAt = (last || log?.startMs || now?.startMs || Date.now()) + (log?.everyMinutes || every || 30) * 60000;
  const diff = dueAt - Date.now();
  return { dueAt, overdue: diff < 0, minutes: Math.max(0, Math.round(Math.abs(diff) / 60000)) };
}
const dueText = (d) => (d.overdue ? `overdue by ${d.minutes} min` : d.minutes <= 1 ? "due now" : `next due in ${d.minutes} min`);

// ---- Home items (Decision 66) -----------------------------------------------------------------------------------
// Operators: their line (home line, or the line this tablet logs) — gray "next check due 10:30 AM", red when overdue.
// Leads/supervisors: one line for all lines (the soonest due, or which are overdue); lines that are down are left out.
// Supervisors: logs waiting for their review.
export function lineCheckItems(roles, onOpen) {
  const form = lineForm();
  const now = shiftNow();
  if (!form || !now || !data.lineLogs) return [];
  const out = [];
  const lead = (roles || []).some((r) => LEAD_ROLES.includes(r));
  const down = data.plantStatus?.down || {};
  const status = activeLines().filter((l) => !down[l.id]).map((l) => ({ l, log: logFor(l.id, now) }))
    .filter(({ log }) => !log?.operatorSign).map((x) => ({ ...x, d: due(x.log, now, form.everyMinutes) }));
  const item = (list, title) => {
    const late = list.filter((x) => x.d.overdue);
    const next = [...list].sort((a, b) => a.d.dueAt - b.d.dueAt)[0];
    return late.length
      ? { key: "linecheck", icon: "📈", title: list.length === 1 ? `${title} — overdue` : `${title} overdue: ${late.map((x) => x.l.name).join(", ")}`, detail: `${late[0].d.minutes} min late`, state: "late", onOpen: () => onOpen(late[0].l.id) }
      : { key: "linecheck", icon: "📈", title, detail: `next due ${fmtTime(next.d.dueAt)}`, state: "due", onOpen: () => onOpen(list.length === 1 ? next.l.id : null) };
  };
  if (lead) {
    if (status.length) out.push(item(status, "Line checks"));
    if ((roles || []).some((r) => CHECK_ROLES.includes(r))) {
      const review = (data.lineLogs || []).filter((g) => g.operatorSign && !g.review);
      if (review.length) out.push({ key: "linecheck-review", icon: "📈", title: `Line logs to review: ${review.map((g) => `${g.lineName} (${g.shift?.name})`).join(", ")}`, detail: "supervisor review", state: "due", onOpen: () => onOpen(review[0].lineId, review[0].id) });
    }
  } else {
    const mine = data.myself?.homeLineId || stored(LINE_KEY);
    const x = status.find((s) => s.l.id === mine);
    if (x) out.push(item([x], `Line check · ${x.l.name}`));
  }
  return out;
}


// ===========================================================================

export function openLineCheck(container, { me, startLine = null, startLogId = null, onExit }) {
  const ui = {
    view: startLine ? "log" : "pick", lineId: startLine, logId: startLogId, busy: false, message: "", messageKind: "", retry: null,
    values: {}, notes: {}, opening: false, notesText: null, notesSave: "",
  };
  let notesTimer = null;
  const say = (message, retry = null) => { Object.assign(ui, { message, messageKind: "error", retry, busy: false }); render(); };
  const show = (view, extra = {}) => { Object.assign(ui, { view, busy: false, message: "", retry: null, ...extra }); render(); window.scrollTo(0, 0); };
  const back = (label, onclick) => el("button", { class: "link-btn", type: "button", onclick, disabled: ui.busy }, `← ${label}`);
  const currentLog = () => (ui.logId ? (data.lineLogs || []).find((l) => l.id === ui.logId) : logFor(ui.lineId, shiftNow()));

  async function openLine(lineId) {
    store(LINE_KEY, lineId);
    Object.assign(ui, { lineId, logId: null, opening: true, notesText: null, message: "" });
    show("log");
    try {
      const { data: r } = await callStartLineLog({ lineId });
      Object.assign(ui, { logId: r.id, plantId: r.plantId, opening: false });
    } catch (err) {
      ui.opening = false;
      say(friendlyError(err), () => openLine(lineId));
    }
    render();
  }

  // ---- pick a line ------------------------------------------------------------------------------------------------
  function renderPick() {
    const form = lineForm();
    const now = shiftNow();
    const loading = !data.formTemplates || !data.lineLogs;
    const mine = stored(LINE_KEY);
    return [
      back("Home", onExit),
      el("h1", {}, `📈 ${form?.name || "Line Check Log"}`),
      el("p", { class: "hint" }, now ? `${now.shift.name} shift · a check every ${form?.everyMinutes || 30} minutes on each line.` : ""),
      banner(ui),
      loading ? spinner() : !form ? emptyState("Not set up yet", "An admin loads the Line Check Log in Admin → Forms.") : !now ? emptyState("No shift is running right now", "Check the shift times in Admin → Forms.") : null,
      form && now ? el("div", { class: "person-list" }, activeLines().map((l) => {
        const log = logFor(l.id, now);
        const d = due(log, now, form.everyMinutes);
        const state = log?.review ? ["✓ Reviewed", "tag ok"] : log?.operatorSign ? ["Signed — waiting for review", "tag warn"] : d.overdue ? [`⚠ ${dueText(d)}`, "tag off"] : [dueText(d), "tag warn"];
        return el("button", { class: d.overdue && !log?.operatorSign ? "person-row urgent" : "person-row", type: "button", onclick: () => openLine(l.id) },
          el("span", { class: "person-name" }, `${l.name}${l.id === mine ? " · this tablet's line" : ""}`),
          el("span", { class: "person-meta" }, log?.rounds?.length ? `${log.rounds.length} check${log.rounds.length === 1 ? "" : "s"} · last ${fmtTime(log.rounds[log.rounds.length - 1].at)} by ${log.rounds[log.rounds.length - 1].name}` : "No checks yet this shift"),
          el("span", { class: "tags" }, el("span", { class: state[1] }, state[0]), log?.test ? el("span", { class: "tag test" }, "TEST") : null));
      })) : null,
      form && now && (form.sections || []).some((s) => s.scope === "plant")
        ? el("button", { class: "btn big secondary", type: "button", onclick: () => openPlant() }, "🏭 Plant-wide checks (page 2)")
        : null,
    ];
  }

  // ---- one line's log ---------------------------------------------------------------------------------------------
  function renderLog() {
    const log = currentLog();
    if (ui.opening || !log) return [back("Lines", () => show("pick")), banner(ui), ui.message ? null : spinner("Opening the log…")];
    const d = due(log, null, log.everyMinutes);
    const signed = !!log.operatorSign;
    const fields = (log.sections || []).flatMap((s) => s.fields);
    if (ui.notesText === null) ui.notesText = log.notes || "";
    async function sign() {
      const r = await signOff({
        title: "Operator sign-off", what: `${log.lineName} · ${log.shift.name} shift · ${log.rounds.length} checks`,
        me: { emp: me.emp, name: me.name },
        action: offlineSign("signLineLog", { id: log.id }, { label: `Line Check Log · ${log.lineName} · ${log.shift.name} shift`, key: `linelog:${log.id}` }),
      });
      if (r) toast(signedNote(r, `Signed by ${r.name}${r.test ? " (test)" : ""}`));
    }
    async function review() {
      const canMe = me.roles.some((x) => CHECK_ROLES.includes(x));
      const r = await signOff({
        title: "Supervisor review", what: `${log.lineName} · ${log.shift.name} shift`,
        me: canMe ? { emp: me.emp, name: me.name } : null,
        others: async () => (await callLineLogReviewers()).data.people,
        action: offlineSign("reviewLineLog", { id: log.id }, { label: `Line Check review · ${log.lineName} · ${log.shift.name} shift`, key: `linelog-review:${log.id}` }),
      });
      if (r) toast(signedNote(r, `Reviewed by ${r.name}${r.test ? " (test)" : ""}`));
    }
    const rounds = [...(log.rounds || [])].reverse();
    return [
      back("Lines", () => show("pick", { logId: null })),
      el("h1", {}, `📈 ${log.lineName}`),
      el("p", { class: "hint" }, `${log.shift.name} shift · form revision ${log.formRev}${log.test ? " · TEST" : ""}`),
      banner(ui),
      signed ? null : el("section", { class: d.overdue ? "timer-card late" : "timer-card", role: "status" },
        el("span", { class: "timer-label" }, d.overdue ? "⚠ Check overdue" : "Next check"),
        el("span", { class: "timer-big" }, d.overdue ? `${d.minutes} min late` : d.minutes <= 1 ? "Now" : `in ${d.minutes} min`),
        el("span", { class: "timer-sub" }, `Due ${fmtTime(d.dueAt)} · every ${log.everyMinutes} minutes`)),
      signed ? null : el("button", { class: d.overdue ? "btn big danger" : "btn big", type: "button", onclick: () => show("round", { values: {}, notes: {} }) }, "＋ Record a check"),
      el("h2", {}, `Checks this shift (${rounds.length})`),
      !rounds.length ? emptyState("No checks yet", "Tap “Record a check” to log the first one.") : el("div", { class: "round-list" }, rounds.map((r) =>
        el("div", { class: r.flags?.length ? "round-row flagged" : "round-row" },
          el("div", { class: "row-between" }, el("strong", {}, fmtTime(r.at)), el("span", { class: "person-meta" }, `${r.name}${r.flags?.length ? ` · ⚠ ${r.flags.length} flagged` : ""}`)),
          el("p", { class: "round-values" }, fields.filter((f) => r.values?.[f.id] !== undefined).map((f) => {
            const v = r.values[f.id];
            const bad = r.flags?.includes(f.id);
            return el("span", { class: bad ? "rv bad" : "rv" }, `${f.label} ${f.type === "check" ? (v ? "✓" : "✗") : v}`);
          })),
          r.flags?.length ? el("ul", { class: "auto-list" }, r.flags.map((id) => el("li", {}, `${fields.find((f) => f.id === id)?.label}: ${r.notes?.[id] || ""}`))) : null))),
      el("label", { class: "field-label", for: "lc-notes" }, "Notes / issues this shift"),
      el("textarea", { class: "field", id: "lc-notes", rows: "3", maxlength: "4000", disabled: signed, value: ui.notesText, oninput: (e) => {
        ui.notesText = e.target.value;
        clearTimeout(notesTimer);
        setNotesSave("Saving…");
        notesTimer = setTimeout(async () => { try { await callSaveLineNotes({ id: log.id, notes: ui.notesText }); setNotesSave("✓ Saved"); } catch (err) { setNotesSave(`Not saved — ${friendlyError(err)}`); } }, 1000);
      } }),
      el("p", { class: "save-state", id: "lc-notes-save" }, ui.notesSave),
      log.operatorSign
        ? el("p", { class: "message ok" }, `✍ Operator: ${log.operatorSign.name} · ${fmtWhen(log.operatorSign.at)}`)
        : el("button", { class: "btn secondary", type: "button", disabled: !rounds.length, onclick: sign }, "✍ End of shift: operator sign-off"),
      log.review
        ? el("p", { class: "message ok" }, `✍ Supervisor review: ${log.review.name} · ${fmtWhen(log.review.at)}`)
        : log.operatorSign ? el("button", { class: "btn", type: "button", onclick: review }, "✍ Supervisor review") : null,
      el("p", { class: "hint" }, `Sign-offs use your PIN${TEST_MODE ? " — test site, practice only" : ""}.`),
    ];
  }
  function setNotesSave(t) { ui.notesSave = t; const n = container.querySelector("#lc-notes-save"); if (n) n.textContent = t; }

  // ---- record a check -----------------------------------------------------------------------------------------------
  function renderRound() {
    const log = currentLog();
    if (!log) return renderLog();
    const last = log.rounds?.length ? log.rounds[log.rounds.length - 1] : null;
    const v = ui.values;
    const flagged = (f) => (f.type === "check" ? v[f.id] === false : f.type === "number" && outOfRange(f, log.lineId, v[f.id]));
    // Only the flag notes and the red outline change while typing, so the keyboard stays up.
    const refresh = (f) => {
      const box = container.querySelector(`[data-f="${f.id}"]`);
      if (!box) return;
      box.classList.toggle("bad", flagged(f));
      const note = box.querySelector(".flag-note");
      if (note) note.hidden = !flagged(f);
    };
    async function save() {
      const fields = (log.sections || []).flatMap((s) => s.fields);
      const missingNote = fields.find((f) => flagged(f) && (ui.notes[f.id] || "").trim().length < 3);
      if (missingNote) return say(`“${missingNote.label}” is ${missingNote.type === "check" ? "Not OK" : "out of range"} — add a note saying what you did.`);
      Object.assign(ui, { busy: true, message: "", retry: null });
      render();
      try {
        const { data: r } = await callAddLineRound({ id: log.id, values: v, notes: ui.notes });
        toast(r.flags ? `Check saved — ${r.flags} flagged${r.test ? " (test: alert only to you)" : ", Line Lead alerted"}` : "Check saved");
        show("log");
      } catch (err) { say(friendlyError(err), save); }
    }
    const flagNote = (f) => el("div", { class: "flag-note", hidden: !flagged(f) },
      el("label", { class: "field-label", for: `lc-n-${f.id}` }, f.type === "check" ? "Not OK — what did you do? (required)" : "Out of range — what did you do? (required)"),
      el("input", { class: "field", id: `lc-n-${f.id}`, maxlength: "500", value: ui.notes[f.id] || "", oninput: (e) => { ui.notes[f.id] = e.target.value; } }));
    return [
      back(log.lineName, () => show("log")),
      el("h1", {}, `Check · ${log.lineName}`),
      el("p", { class: "hint" }, `Read each gauge — the gray number is the last reading (${last ? fmtTime(last.at) : "none yet"}). Leave a box empty if you didn't check it.`),
      banner(ui),
      (log.sections || []).map((s) => el("section", { class: "card ho-section" },
        el("h2", {}, s.title),
        s.help ? el("p", { class: "card-note" }, s.help) : null,
        el("div", { class: s.fields.every((f) => f.type === "number") ? (s.fields.length === 1 ? "reading-grid one" : "reading-grid") : "check-grid" }, s.fields.map((f) => {
          const lim = f.type === "number" ? limitsFor(f, log.lineId) : null;
          if (f.type === "check") {
            return el("div", { class: flagged(f) ? "check-item bad" : "check-item", "data-f": f.id },
              el("p", { class: "field-label strong" }, f.label),
              f.help ? el("p", { class: "card-note help-tip" }, f.help) : null,
              el("div", { class: "choices two" },
                el("button", { class: v[f.id] === true ? "choice on" : "choice", type: "button", "aria-pressed": String(v[f.id] === true), onclick: () => { v[f.id] = v[f.id] === true ? undefined : true; render(); } }, "✓ OK"),
                el("button", { class: v[f.id] === false ? "choice danger on" : "choice danger", type: "button", "aria-pressed": String(v[f.id] === false), onclick: () => { v[f.id] = v[f.id] === false ? undefined : false; render(); } }, "✗ Not OK")),
              flagNote(f));
          }
          return el("div", { class: flagged(f) ? "reading bad" : "reading", "data-f": f.id },
            el("label", { class: "reading-label", for: `lc-${f.id}` }, f.label),
            el("input", { class: "field reading-input", id: `lc-${f.id}`, type: "text", inputmode: "decimal", autocomplete: "off",
              placeholder: last?.values?.[f.id] !== undefined ? String(last.values[f.id]) : "", value: v[f.id] ?? "",
              oninput: (e) => { v[f.id] = e.target.value.trim(); refresh(f); } }),
            el("span", { class: "reading-sub" }, [f.unit, lim ? `OK ${rangeText(lim, "")}` : ""].filter(Boolean).join(" · ")),
            f.help ? el("span", { class: "reading-sub" }, f.help) : null,
            flagNote(f));
        })))),
      el("button", { class: "btn big", type: "button", disabled: ui.busy, onclick: save }, ui.busy ? "Saving…" : "✔ Save this check"),
    ];
  }

  // ---- page 2: plant-wide --------------------------------------------------------------------------------------------
  async function openPlant() {
    show("plant", { opening: true });
    const first = activeLines()[0];
    try {
      const { data: r } = await callStartLineLog({ lineId: stored(LINE_KEY) || first?.id });
      Object.assign(ui, { plantId: r.plantId, opening: false });
    } catch (err) { ui.opening = false; say(friendlyError(err), openPlant); }
    render();
  }
  function renderPlant() {
    const p = ui.plantId ? (data.plantLogs || []).find((x) => x.id === ui.plantId) : plantFor(shiftNow());
    if (ui.opening || !p) return [back("Lines", () => show("pick")), banner(ui), ui.message ? null : spinner()];
    async function tap(f) {
      Object.assign(ui, { busy: true, message: "" });
      render();
      try {
        const { data: r } = await callTapPlantItem({ id: p.id, fieldId: f.id });
        ui.busy = false;
        toast(`${f.label} — ${r.count}${f.expectMax ? ` of ${f.expectMin ?? 0}–${f.expectMax}` : ""}`);
        render();
      } catch (err) { say(friendlyError(err), () => tap(f)); }
    }
    return [
      back("Lines", () => show("pick")),
      el("h1", {}, "🏭 Plant-wide checks"),
      el("p", { class: "hint" }, `${p.shift.name} shift · logged once for the whole plant. Tap when you do it — the app stamps the time and your name.`),
      banner(ui),
      (p.sections || []).map((s) => el("section", { class: "card ho-section" },
        el("h2", {}, s.title),
        el("div", { class: "tally-list" }, s.fields.map((f) => {
          const taps = p.taps?.[f.id] || [];
          const hasRange = f.expectMin !== null && f.expectMin !== undefined && f.expectMax !== null && f.expectMax !== undefined;
          const enough = hasRange ? taps.length >= f.expectMin : true;
          return el("div", { class: "tally-row" },
            el("div", { class: "task-main" },
              el("span", { class: "person-name" }, f.label),
              el("span", { class: "person-meta" }, [hasRange ? `${f.expectMin === f.expectMax ? f.expectMin : `${f.expectMin}–${f.expectMax}`}× per shift` : "", f.help].filter(Boolean).join(" · ")),
              taps.length ? el("span", { class: "person-meta" }, taps.map((t) => fmtTime(t.at)).join(" · ")) : null),
            el("span", { class: enough && taps.length ? "tally-count ok" : "tally-count" }, hasRange ? `${taps.length} of ${f.expectMin === f.expectMax ? f.expectMin : `${f.expectMin}–${f.expectMax}`}` : String(taps.length)),
            el("button", { class: "btn", type: "button", disabled: ui.busy, onclick: () => tap(f) }, "＋ Done now"));
        })))),
    ];
  }

  function render() {
    const views = { pick: renderPick, log: renderLog, round: renderRound, plant: renderPlant };
    container.replaceChildren(...[(views[ui.view] || renderPick)()].flat(3).filter(Boolean));
  }

  // Live updates: never while recording a check or typing notes; the timer redraws every 30 seconds.
  const busyTyping = () => ui.view === "round" || document.activeElement?.id === "lc-notes";
  const stop = onDataChange(() => { if (!ui.busy && !busyTyping()) render(); });
  const tick = setInterval(() => { if (!ui.busy && !busyTyping()) render(); }, 30000);
  if (startLine && !startLogId) openLine(startLine); else render();
  return () => { stop(); clearInterval(tick); clearTimeout(notesTimer); };
}
