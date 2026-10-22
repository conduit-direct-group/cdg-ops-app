const test = require("node:test");
const assert = require("node:assert");
const r = require("../reels");

const reasons = r.STARTING_REASONS.map((name) => ({ id: r.slug(name), name, active: true }));
const ctx = { reasons, lineIds: ["line-1"], isOurFile: (u) => u.startsWith("https://ours/") };
const P = { size: "1.25\"", sdr: "SDR 11", color: "Orange" };

test("flagging a reel: line, tag or no tag, reason, size + SDR (specialty sizes typed)", () => {
  const ok = r.cleanFlag({ lineId: "line-1", winder: "Winder 2", tag: " 104523 ", footage: "850", reasonId: "ovality", product: P }, ctx);
  assert.deepStrictEqual(ok.reel.product, { size: "1.25\"", sdr: "SDR 11", color: "Orange" });
  assert.strictEqual(ok.reel.tag, "104523");
  assert.strictEqual(ok.reel.footage, 850);
  const typed = r.cleanFlag({ lineId: "line-1", noTag: true, reasonId: "kinks-or-bends", product: { size: "3\" specialty", sdr: "SDR 13.5", color: "Orange" } }, ctx);
  assert.strictEqual(typed.reel.noTag, true);
  assert.strictEqual(typed.reel.product.size, "3\" specialty");
  assert.match(r.cleanFlag({ lineId: "line-1", tag: "1", reasonId: "ovality", product: { size: "1\"" } }, ctx).error, /SDR/);
  assert.match(r.cleanFlag({ lineId: "line-9", tag: "1", reasonId: "ovality", product: P }, ctx).error, /line/);
  assert.match(r.cleanFlag({ lineId: "line-1", reasonId: "ovality", product: P }, ctx).error, /tag/);
  assert.match(r.cleanFlag({ lineId: "line-1", tag: "1", reasonId: "nope", product: P }, ctx).error, /reason/);
  assert.match(r.cleanFlag({ lineId: "line-1", tag: "1", reasonId: "other", product: P }, ctx).error, /note/);
  assert.match(r.cleanFlag({ lineId: "line-1", tag: "1", reasonId: "ovality", product: P, photo: "https://evil/x.jpg" }, ctx).error, /photo/);
});

test("decisions need a note; regrind and scrap go to Reclamation; only leads, Quality, supervisors decide", () => {
  assert.deepStrictEqual(r.cleanDecision({ kind: "scrap", note: "Kinked" }), { kind: "scrap", note: "Kinked" });
  assert.match(r.cleanDecision({ kind: "scrap" }).error, /note/);
  assert.match(r.cleanDecision({ kind: "toss", note: "x" }).error, /Release/);
  assert.strictEqual(r.DECISIONS.regrind.next, "reclaim");
  assert.strictEqual(r.DECISIONS.release.next, "done");
  assert.strictEqual(r.canDecide(["quality"]), true);
  assert.strictEqual(r.canDecide(["operator", "admin"]), false);
  assert.deepStrictEqual(r.cleanReclaim({ footage: "600", segregation: "Orange regrind" }), { footage: 600, segregation: "Orange regrind" });
  assert.match(r.cleanReclaim({ footage: "x" }).error, /footage/);
});

test("an undecided reel turns red at the end of the next shift", () => {
  const start = Date.UTC(2026, 9, 21, 10), end = start + 12 * 3600000;
  assert.strictEqual(r.dueAfterNextShift({ startMs: start, endMs: end }, start + 3600000), end + 12 * 3600000);
  assert.strictEqual(r.dueAfterNextShift(null, 1000), 1000 + 24 * 3600000);
});

test("reason, size, and SDR lists", () => {
  const { reasons: list } = r.cleanReasons([{ id: "ovality", name: "Ovality " }, { name: "Gels" }]);
  assert.deepStrictEqual(list.map((x) => x.id), ["ovality", "gels"]);
  assert.match(r.cleanReasons([{ name: "A", active: false }]).error, /at least one/);
  assert.match(r.cleanReasons([{ name: "A" }, { name: "a" }]).error, /twice/);
  assert.deepStrictEqual(r.cleanChoices(r.STARTING_SIZES, "sizes").list, ["3/4\"", "1\"", "1.25\"", "1.5\"", "2\""]);
  assert.deepStrictEqual(r.STARTING_SDRS, ["SDR 11", "SDR 13.5"]);
  assert.match(r.cleanChoices(["SDR 11", "sdr 11"], "walls").error, /twice/);
});

test("color: Orange or typed; a color used before keeps its first spelling; a new one is added to the list", () => {
  const base = { lineId: "line-1", tag: "1", reasonId: "ovality" };
  const color = (c, colors = []) => r.cleanFlag({ ...base, product: { size: "1\"", sdr: "SDR 11", color: c } }, { ...ctx, colors });
  assert.strictEqual(color("Orange").reel.product.color, "Orange");
  assert.strictEqual(color("orange").reel.product.color, "Orange");
  assert.strictEqual(color(" black ", ["Black", "Blue"]).reel.product.color, "Black");
  assert.strictEqual(color("purple", ["Black"]).reel.product.color, "Purple");
  assert.match(color("  ").error, /Orange/);
  assert.deepStrictEqual(r.withColor(["Black"], "Purple"), ["Black", "Purple"]);
  assert.strictEqual(r.withColor(["Black"], "black"), null);
  assert.strictEqual(r.withColor(Array.from({ length: 200 }, (_, i) => `c${i}`), "New"), null);
  assert.deepStrictEqual(r.cleanChoices([], "colors", { optional: true }), { list: [] });
  assert.match(r.cleanChoices([], "sizes").error, /Add 1/);
});

test("Admin merges a duplicate color into the one to keep", () => {
  assert.deepStrictEqual(r.cleanMerge({ from: "Blk", to: "black" }, ["Black", "Blk"]), { from: "Blk", to: "Black" });
  assert.deepStrictEqual(r.cleanMerge({ from: "Blk", to: "orange" }, ["Blk"]), { from: "Blk", to: "Orange" });
  assert.match(r.cleanMerge({ from: "Nope", to: "Black" }, ["Black"]).error, /merge/);
  assert.match(r.cleanMerge({ from: "Blk", to: "" }, ["Blk"]).error, /keep/);
  assert.match(r.cleanMerge({ from: "Blk", to: "blk" }, ["Blk"]).error, /different/);
  assert.deepStrictEqual(r.mergedColors(["Black", "Blk", "Blue"], "Blk", "Black"), ["Black", "Blue"]);
  assert.deepStrictEqual(r.mergedColors(["Blk", "Blue"], "Blk", "Black"), ["Black", "Blue"]);
  assert.deepStrictEqual(r.mergedColors(["Blue"], "Blk", "Black"), ["Blue"]);
});
