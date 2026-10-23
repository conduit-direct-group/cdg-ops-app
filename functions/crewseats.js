// Crew Board step 2 — stations (Chris, 10-21-2026, Decision 69; levels and SOPs from the Shift Station Assignment
// sheet's "Ideal level" and "Key SOPs" columns, Chris 10-23-2026). No database code here, so it can be tested alone.
//
// The station setup is company data, loaded by an admin (Admin → Crew Board stations) into meta/crewStations — never
// in the code:  { levels: [lowest … highest], stations: [{ id, name, kind: "line" | "winder" | "support", line?,
//   covers, idealLevel (words from the sheet), minLevel, assistLevel?, sops: ["0005", …] }], allShift: [station ids],
//   rotation: { blocks: ["Hours 1–4", …], letters: [{ letter, level, stations: [one per block] }], note },
//   callOffs: { steps: [{ station, text }], lineOperatorOut } }
//
// Each shift's seats are saved on the Who's here today record (attendance): seats { seatId: emp } where a seat is an
// all-shift station id or a rotation letter; cells { emp: [station id or "" per block] } are the lead's changes.

const MAX = { levels: 20, stations: 40, blocks: 6, letters: 12, sops: 30, text: 600 };
const clean = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const idOk = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v);

// "Winder Operator II" / "Winder Op II" → "winder op ii" so Gusto / training positions match the sheet's level names.
const normLevel = (s) => String(s || "").toLowerCase().replace(/operator/g, "op").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const levelRank = (levels, s) => { const n = normLevel(s); return n ? levels.findIndex((l) => normLevel(l) === n) : -1; };

// The admin's setup file → { setup } or { error }.
function cleanSetup(raw) {
  const levels = (Array.isArray(raw?.levels) ? raw.levels : []).map((l) => clean(l, 40)).filter(Boolean);
  if (!levels.length || levels.length > MAX.levels) return { error: "List the levels, lowest first (up to 20)." };
  const stations = [];
  for (const s of Array.isArray(raw?.stations) ? raw.stations : []) {
    if (!idOk(s?.id)) return { error: "Each station needs a short id (lowercase letters, numbers, dashes)." };
    if (stations.some((x) => x.id === s.id)) return { error: `Two stations have the id ${s.id}.` };
    const st = {
      id: s.id, name: clean(s.name, 60), kind: ["line", "winder", "support"].includes(s.kind) ? s.kind : "support",
      line: clean(s.line, 40) || null, covers: clean(s.covers, MAX.text), idealLevel: clean(s.idealLevel, 60),
      minLevel: clean(s.minLevel, 40), assistLevel: clean(s.assistLevel, 40) || null,
      sops: (Array.isArray(s.sops) ? s.sops : []).map((x) => clean(String(x), 20)).filter(Boolean).slice(0, MAX.sops),
    };
    if (!st.name) return { error: `Station ${s.id} needs a name.` };
    if (levelRank(levels, st.minLevel) < 0) return { error: `${st.name}: the lowest level "${st.minLevel}" isn't in the levels list.` };
    if (st.assistLevel && levelRank(levels, st.assistLevel) < 0) return { error: `${st.name}: "${st.assistLevel}" isn't in the levels list.` };
    stations.push(st);
  }
  if (!stations.length || stations.length > MAX.stations) return { error: "List the stations (up to 40)." };
  const known = new Set(stations.map((s) => s.id));
  const allShift = (Array.isArray(raw?.allShift) ? raw.allShift : []).filter((id) => known.has(id));
  const r = raw?.rotation || {};
  const blocks = (Array.isArray(r.blocks) ? r.blocks : []).map((b) => clean(b, 30)).filter(Boolean);
  if (blocks.length > MAX.blocks) return { error: "Up to 6 rotation blocks." };
  const letters = [];
  for (const l of Array.isArray(r.letters) ? r.letters : []) {
    const letter = clean(l?.letter, 3);
    const seq = (Array.isArray(l?.stations) ? l.stations : []).map(String);
    if (!letter || letters.some((x) => x.letter === letter)) return { error: "Each rotation row needs its own letter." };
    if (seq.length !== blocks.length || seq.some((id) => !known.has(id))) return { error: `Rotation ${letter}: one known station per block.` };
    if (allShift.includes(letter)) return { error: `Rotation letter ${letter} clashes with a station id.` };
    letters.push({ letter, level: clean(l.level, 40), stations: seq });
  }
  if (letters.length > MAX.letters) return { error: "Up to 12 rotation rows." };
  const steps = (Array.isArray(raw?.callOffs?.steps) ? raw.callOffs.steps : [])
    .filter((x) => known.has(x?.station)).map((x) => ({ station: x.station, text: clean(x.text, MAX.text) }));
  return {
    setup: {
      levels, stations, allShift,
      rotation: { blocks, letters, note: clean(r.note, MAX.text) },
      callOffs: { steps, lineOperatorOut: clean(raw?.callOffs?.lineOperatorOut, MAX.text) },
    },
  };
}

const seatIds = (setup) => [...setup.allShift, ...setup.rotation.letters.map((l) => l.letter)];
const stationOf = (setup, id) => setup.stations.find((s) => s.id === id) || null;

// Each seated person's station per block: { emp: [station id or "" per block] }. All-shift seats fill every block;
// rotation letters follow their row; the lead's changes (cells) win.
function schedule(setup, seats = {}, cells = {}) {
  const n = Math.max(1, setup.rotation.blocks.length);
  const out = {};
  for (const id of setup.allShift) if (seats[id]) out[seats[id]] = Array(n).fill(id);
  for (const l of setup.rotation.letters) if (seats[l.letter]) out[seats[l.letter]] = [...l.stations];
  for (const [emp, row] of Object.entries(cells || {})) {
    if (!out[emp] || !Array.isArray(row)) continue;
    out[emp] = out[emp].map((cur, i) => (typeof row[i] === "string" && (row[i] === "" || stationOf(setup, row[i])) ? row[i] : cur));
  }
  return out;
}

// Training check for one person at one station: null (fine), or { kind: "below" | "assist" | "unknown", text }.
function fit(setup, station, position) {
  if (!station) return null;
  const rank = levelRank(setup.levels, position);
  if (rank < 0) return { kind: "unknown", text: `Level not known${position ? ` (${position})` : ""} — station calls for ${station.idealLevel || station.minLevel}` };
  if (rank >= levelRank(setup.levels, station.minLevel)) return null;
  if (station.assistLevel && rank >= levelRank(setup.levels, station.assistLevel)) return { kind: "assist", text: `${setup.levels[rank]} can only assist at ${station.name}` };
  return { kind: "below", text: `Below the ideal level for ${station.name} (${station.idealLevel || station.minLevel})` };
}

// What the lead should know now: [{ kind: "late" | "info", key, text }].
//   here: employee #s marked Here; runningLines: names of the lines running now (null = treat all as running).
function warnings(setup, { here = [], seats = {}, sched = {}, runningLines = null }) {
  const out = [];
  const all = seatIds(setup);
  const seated = new Set(Object.values(seats).filter(Boolean));
  // Fewer people here than seats: the sheet's call-off order, one step for each person short.
  const short = all.length - here.length;
  if (here.length && short > 0) {
    setup.callOffs.steps.slice(0, short).forEach((step, i) => out.push({ kind: "info", key: `calloff-${i}`, text: step.text }));
  }
  // A line seat is empty and nobody here is left to put there: a line operator is out — the Production Manager decides.
  const lineEmpty = setup.allShift.filter((id) => stationOf(setup, id)?.kind === "line" && !seats[id]);
  const left = here.filter((e) => !seated.has(e)).length;
  if (here.length && lineEmpty.length && left === 0 && setup.callOffs.lineOperatorOut) {
    out.push({ kind: "late", key: "line-op-out", text: setup.callOffs.lineOperatorOut });
  }
  // Never leave a running winder unmanned (once seating has started): every block, every winder on a running line.
  if (Object.keys(sched).length) {
    setup.rotation.blocks.forEach((b, i) => {
      for (const w of setup.stations.filter((x) => x.kind === "winder")) {
        if (runningLines && w.line && !runningLines.includes(w.line)) continue;
        if (!Object.values(sched).some((row) => row[i] === w.id)) out.push({ kind: "late", key: `unmanned-${w.id}-${i}`, text: `${w.name} has no one in ${b}` });
      }
    });
  }
  return out;
}

module.exports = { normLevel, levelRank, cleanSetup, seatIds, stationOf, schedule, fit, warnings };
