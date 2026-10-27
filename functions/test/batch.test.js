// The app's screens redraw once per burst of live updates, never once per listener (Chris, 10-27-2026: 70+ full Home
// redraws in a row froze Chrome — "Page unresponsive"). Checks web/batch.js and that web/data.js uses it.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const WEB = path.join(__dirname, "..", "..", "web");
const loadBatch = async () => (await import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(WEB, "batch.js"), "utf8"))}`)).batch;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a burst of 73 changes runs the redraw once", async () => {
  const batch = await loadBatch();
  let runs = 0;
  const changed = batch(() => { runs++; }, 10);
  for (let i = 0; i < 73; i++) changed();
  assert.strictEqual(runs, 0, "nothing runs in the middle of the burst");
  await wait(30);
  assert.strictEqual(runs, 1);
  changed();
  await wait(30);
  assert.strictEqual(runs, 2, "a later change still redraws");
});

test("cancel stops a waiting redraw (signing out)", async () => {
  const batch = await loadBatch();
  let runs = 0;
  const changed = batch(() => { runs++; }, 10);
  changed();
  changed.cancel();
  await wait(30);
  assert.strictEqual(runs, 0);
});

const loadServerCheck = async () => (await import(`data:text/javascript,${encodeURIComponent(fs.readFileSync(path.join(WEB, "batch.js"), "utf8"))}`)).serverCheck;

test("server checks: redraws asked for between loads are not kept (they used to pile up and all run later)", async () => {
  const serverCheck = await loadServerCheck();
  let loads = 0;
  let redraws = 0;
  let fresh = true;
  const check = serverCheck(async () => { loads++; await wait(5); }, () => fresh);
  for (let i = 0; i < 1000; i++) check(() => { redraws++; }); // 1000 Home redraws while the answer is fresh
  await wait(20);
  assert.strictEqual(loads, 0);
  fresh = false; // 2 minutes later
  check(() => { redraws++; });
  fresh = true;
  await wait(20);
  assert.strictEqual(loads, 1);
  assert.strictEqual(redraws, 1, "one redraw after the load — not 1001");
});

test("server checks: one load at a time, and one redraw however many asked during it", async () => {
  const serverCheck = await loadServerCheck();
  let loads = 0;
  let redraws = 0;
  let fresh = false;
  const check = serverCheck(async () => { loads++; await wait(10); fresh = true; }, () => fresh);
  for (let i = 0; i < 50; i++) check(() => { redraws++; });
  await wait(30);
  assert.strictEqual(loads, 1);
  assert.strictEqual(redraws, 1);
});

test("a failed load still ends (the next check can run) and still redraws", async () => {
  const serverCheck = await loadServerCheck();
  let loads = 0;
  let redraws = 0;
  const check = serverCheck(async () => { loads++; throw new Error("offline"); }, () => false);
  check(() => { redraws++; });
  await wait(10);
  check(() => { redraws++; });
  await wait(10);
  assert.strictEqual(loads, 2);
  assert.strictEqual(redraws, 2);
});

test("Home's server checks (crew, my station, tasks to confirm) use serverCheck, with no pile of waiting redraws", () => {
  for (const f of ["crew.js", "tasks.js"]) {
    const src = fs.readFileSync(path.join(WEB, f), "utf8");
    assert.match(src, /serverCheck\(/, `${f} uses serverCheck`);
    assert.doesNotMatch(src, /waiting: new Set|\.waiting\.add\(/, `${f} keeps no set of waiting redraws`);
  }
});

test("web/data.js tells the screens about changes only through batch()", () => {
  const src = fs.readFileSync(path.join(WEB, "data.js"), "utf8");
  assert.match(src, /const changed = batch\(/, "changed() must be batched");
  // The listeners are called in exactly one place — inside the batched function.
  assert.strictEqual((src.match(/for \(const fn of listeners\) fn\(\)/g) || []).length, 1);
  assert.doesNotMatch(src, /function changed\s*\(/, "no unbatched changed()");
});
