const test = require("node:test");
const assert = require("node:assert");
const c = require("../crewseats");

// A made-up setup (the real one is company data, loaded in Admin — never in the code).
const raw = {
  levels: ["Helper I", "Helper II", "Runner", "Chief Operator"],
  stations: [
    { id: "chief", name: "Chief", kind: "line", idealLevel: "Chief Operator", minLevel: "Chief Operator", sops: ["0001"] },
    { id: "spool-1", name: "Spool 1", kind: "winder", line: "Line 1", minLevel: "Helper II", sops: ["0002"] },
    { id: "spool-2", name: "Spool 2", kind: "winder", line: "Line 2", minLevel: "Helper I" },
    { id: "rover", name: "Rover", kind: "support", minLevel: "Helper II" },
    { id: "bins", name: "Bins", kind: "support", minLevel: "Helper II", assistLevel: "Helper I" },
  ],
  allShift: ["chief", "rover"],
  rotation: { blocks: ["First half", "Second half"], letters: [{ letter: "A", stations: ["spool-1", "bins"] }, { letter: "B", stations: ["spool-2", "spool-1"] }] },
  callOffs: { steps: [{ station: "bins", text: "Bins closes." }, { station: "rover", text: "Rover goes away." }], lineOperatorOut: "Ask the manager." },
};

test("the station setup is checked: levels, stations, rotation rows", () => {
  const { setup } = c.cleanSetup(raw);
  assert.deepStrictEqual(c.seatIds(setup), ["chief", "rover", "A", "B"]);
  assert.match(c.cleanSetup({ ...raw, levels: [] }).error, /levels/);
  assert.match(c.cleanSetup({ ...raw, stations: [{ ...raw.stations[0], minLevel: "Wizard" }] }).error, /isn't in the levels/);
  assert.match(c.cleanSetup({ ...raw, rotation: { blocks: ["x"], letters: [{ letter: "A", stations: ["spool-1", "bins"] }] } }).error, /one known station per block/);
});

test("levels match whatever the position says: Operator or Op, any case", () => {
  const levels = ["Winder Op I", "Winder Op II", "Lead Operator"];
  assert.strictEqual(c.levelRank(levels, "Winder Operator II"), 1);
  assert.strictEqual(c.levelRank(levels, "winder op i"), 0);
  assert.strictEqual(c.levelRank(levels, "Lead Operator"), 2);
  assert.strictEqual(c.levelRank(levels, "Accounting"), -1);
});

test("schedule: all-shift seats every block, letters follow their row, the lead's changes win", () => {
  const { setup } = c.cleanSetup(raw);
  const sched = c.schedule(setup, { chief: "1", rover: "2", A: "3", B: "4" }, { 3: ["", "spool-2"] });
  assert.deepStrictEqual(sched, { 1: ["chief", "chief"], 2: ["rover", "rover"], 3: ["", "spool-2"], 4: ["spool-2", "spool-1"] });
});

test("training check: below the level, can only assist, or level not known", () => {
  const { setup } = c.cleanSetup(raw);
  const bins = c.stationOf(setup, "bins");
  assert.strictEqual(c.fit(setup, bins, "Helper II"), null);
  assert.strictEqual(c.fit(setup, bins, "Helper I").kind, "assist");
  assert.strictEqual(c.fit(setup, c.stationOf(setup, "chief"), "Runner").kind, "below");
  assert.strictEqual(c.fit(setup, bins, "").kind, "unknown");
});

test("warnings: call-off order when short, a line seat nobody can fill, and a running winder with no one", () => {
  const { setup } = c.cleanSetup(raw);
  const w1 = c.warnings(setup, { here: ["1", "2", "3"], seats: {}, sched: {} });
  assert.deepStrictEqual(w1.map((w) => w.text), ["Bins closes."]);
  const seats = { rover: "2", A: "3" };
  const w2 = c.warnings(setup, { here: ["2", "3"], seats, sched: c.schedule(setup, seats) });
  assert.ok(w2.some((w) => w.key === "line-op-out"));
  assert.ok(w2.some((w) => w.text === "Spool 2 has no one in First half"));
  const w3 = c.warnings(setup, { here: ["2", "3"], seats, sched: c.schedule(setup, seats), runningLines: ["Line 1"] });
  assert.ok(!w3.some((w) => w.text.startsWith("Spool 2")));
});

test("step 3: my stations for the shift — all-shift seat, rotation letter, a lead's change, not seated", () => {
  const { setup } = c.cleanSetup(raw);
  const seats = { chief: "9001", A: "9002", B: "9003" };
  assert.deepStrictEqual(c.myStations(setup, seats, {}, "9001"), {
    seat: "Chief", allShift: true,
    blocks: [{ label: "First half", station: { id: "chief", name: "Chief", sops: ["0001"] } }, { label: "Second half", station: { id: "chief", name: "Chief", sops: ["0001"] } }],
  });
  const a = c.myStations(setup, seats, { 9002: ["", "rover"] }, "9002");
  assert.strictEqual(a.seat, "Rotation A");
  assert.deepStrictEqual(a.blocks.map((b) => b.station?.name || null), [null, "Rover"]);
  assert.strictEqual(c.myStations(setup, seats, {}, "9099"), null);
});

test("lines come from today's seats: a station can cover several lines; support stations none (no home line)", () => {
  const { setup } = c.cleanSetup({ ...raw, stations: raw.stations.map((s) => (s.id === "chief" ? { ...s, line: undefined, lines: ["Line 1", "Line 2"] } : s)) });
  assert.deepStrictEqual(setup.stations.find((s) => s.id === "chief").lines, ["Line 1", "Line 2"]);
  assert.strictEqual(setup.stations.find((s) => s.id === "spool-1").line, "Line 1"); // older files: line → lines
  const lineDocs = [{ id: "l1", name: "Line 1" }, { id: "l2", name: "line 2" }];
  const seats = { chief: "9001", rover: "9004", A: "9002", B: "9003" };
  const r = c.shiftLines(setup, seats, {}, 0, lineDocs);
  assert.deepStrictEqual(r.now, { 9001: ["l1", "l2"], 9004: [], 9002: ["l1"], 9003: ["l2"] });
  assert.deepStrictEqual(r.today[9002], ["l1"]); // A: spool-1 (Line 1) then bins (no line)
  assert.deepStrictEqual(r.today[9003], ["l2", "l1"]); // B: spool-2 then spool-1
  assert.deepStrictEqual(r.onLineNow, { l1: ["9001", "9002"], l2: ["9001", "9003"] });
  assert.deepStrictEqual(c.shiftLines(setup, seats, {}, -1, lineDocs).now[9002], []); // outside the shift
});

test("step 3: the block running now splits the shift evenly", () => {
  const start = 0, end = 12 * 3600000;
  assert.strictEqual(c.blockAt(start, end, 3, 0), 0);
  assert.strictEqual(c.blockAt(start, end, 3, 4 * 3600000), 1);
  assert.strictEqual(c.blockAt(start, end, 3, end - 1), 2);
  assert.strictEqual(c.blockAt(start, end, 3, end), -1);
  assert.strictEqual(c.blockAt(start, end, 3, -1), -1);
});
