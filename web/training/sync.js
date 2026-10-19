// Training ↔ CDGTRN0009 workbook sync (Microsoft Graph, Microsoft sign-in via MSAL) — from the training team's
// app (workbook-sync.js), with these changes:
//   - The sign-in settings (client ID, tenant ID, workbook link) come from the database, not the tablet.
//   - Changes waiting for the workbook are kept in the database (trainingWbQueue), not in one tablet's storage.
//     The server adds them; any tablet signed in to Microsoft writes them and marks them done.
//   - PINs are never written to the workbook.
//   - Test mode (dev site): nothing is written to the workbook.
// Exposes window.CDGSync with the same calls the screens use.

(function () {
  const SCOPES = ["User.Read", "Files.ReadWrite.All"];
  let cfg = { clientId: "", tenantId: "", link: "" }, app = null, account = null, cache = {}, busy = false, timer = null;
  let queue = [];           // [{ id, job }] from the database, oldest first
  const done = new Set();   // written here; waiting for the database to drop them
  let hooks = { done: () => {}, failed: () => {} };
  let testMode = false;
  let status = { state: "off", msg: "Not connected", last: null };
  const subs = new Set(), emit = () => subs.forEach((f) => { try { f(); } catch (e) {} });
  const setStatus = (state, msg) => { status = { ...status, state, msg }; emit(); };
  const colLetter = (n) => { let s = ""; n++; while (n) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const colIndex = (l) => l.split("").reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const serial = (iso) => { const [y, m, d] = iso.split("-").map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5; };
  const fromSerial = (v) => (typeof v === "number" && v > 20000 ? new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10) : null);
  if (location.protocol !== "https:" && location.hostname !== "localhost") status = { state: "error", msg: "Sign-in needs the https:// web address", last: null };
  const configured = () => !!(cfg.clientId && cfg.tenantId && cfg.link);
  const pending = () => queue.filter((q) => !done.has(q.id)).length;

  async function init() {
    for (let i = 0; i < 60 && !window.msal; i++) await new Promise((r) => setTimeout(r, 100));
    if (!configured()) { setStatus("off", "Not set up"); return; }
    if (!window.msal) { setStatus("error", "Microsoft sign-in library didn’t load"); return; }
    try {
      const redirectUri = new URL("auth.html", location.origin + location.pathname).href;
      app = new msal.PublicClientApplication({ auth: { clientId: cfg.clientId, authority: "https://login.microsoftonline.com/" + cfg.tenantId, redirectUri, navigateToLoginRequestUrl: false }, cache: { cacheLocation: "localStorage", storeAuthStateInCookie: true } });
      if (app.initialize) await app.initialize();
      try { await app.handleRedirectPromise(); } catch (e) {}
      account = app.getAllAccounts()[0] || null;
      if (!account) { setStatus("signin", "Sign in with Microsoft"); return; }
      setStatus("ok", testMode ? "Connected · test mode: changes are not written to the workbook" : "Connected"); pump();
    } catch (e) { setStatus("error", e.message || String(e)); }
  }
  async function token() {
    try { return (await app.acquireTokenSilent({ scopes: SCOPES, account })).accessToken; }
    catch (e) { const c = (e && (e.errorCode || "")) + " " + ((e && e.errorMessage) || ""); setStatus("signin", /consent|AADSTS65001/i.test(c) ? "Permissions not approved. Grant admin consent in Entra" : "Sign-in expired. Sign in again"); throw new Error("Sign-in needed"); }
  }
  async function g(path, opt = {}) {
    const t = await token();
    const r = await fetch("https://graph.microsoft.com/v1.0" + path, { ...opt, headers: { Authorization: "Bearer " + t, "Content-Type": "application/json", ...(opt.headers || {}) } });
    if (!r.ok) { let m = r.status + ""; try { const j = await r.json(); m += " " + (j.error?.message || ""); } catch (e) {} throw new Error(m); }
    return r.status === 204 ? null : r.json();
  }
  async function item() {
    if (cache.item) return cache.item;
    const enc = "u!" + btoa(unescape(encodeURIComponent(cfg.link.trim()))).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
    const it = await g("/shares/" + enc + "/driveItem?$select=id,name,parentReference");
    cache.item = "/drives/" + it.parentReference.driveId + "/items/" + it.id; cache.name = it.name; return cache.item;
  }
  async function sheet(name, fresh) {
    const hit = cache["s:" + name];
    if (hit && !fresh && Date.now() - hit.at < 5 * 60000) return hit;
    const base = await item();
    const r = await g(base + "/workbook/worksheets('" + encodeURIComponent(name) + "')/usedRange(valuesOnly=true)?$select=address,values");
    const tl = r.address.split("!").pop().split(":")[0].match(/([A-Z]+)(\d+)/);
    const s = { values: r.values, startCol: colIndex(tl[1]), startRow: +tl[2], at: Date.now() };
    const isName = (v) => /^(employee name|trainer name|trainer|name|full name)$/i.test(String(v).trim());
    s.hr = s.values.findIndex((row) => row.some(isName));
    if (s.hr < 0) throw new Error('No "Employee Name" header on ' + name);
    s.nc = s.values[s.hr].findIndex(isName);
    cache["s:" + name] = s; return s;
  }
  function locate(s, name, test, label) {
    const c = s.values[s.hr].findIndex((h) => test(String(h).trim()));
    if (c < 0) throw new Error("Column not found: " + label);
    const r = s.values.findIndex((row, i) => i > s.hr && String(row[s.nc || 0]).trim().toLowerCase() === name.toLowerCase());
    if (r < 0) throw new Error(name + " not on tab");
    return colLetter(s.startCol + c) + (s.startRow + r);
  }
  async function write(tab, addr, v) {
    const base = await item();
    await g(base + "/workbook/worksheets('" + encodeURIComponent(tab) + "')/range(address='" + addr + "')", { method: "PATCH", body: JSON.stringify({ values: [[v]] }) });
  }
  const REF = { loto: /^LOTO.*Last Completed/i, eap: /^Emergency Action.*Last Completed/i, ppe: /^Safety \/ PPE.*Last Completed/i, c10: /^Injury & Incident.*Last Completed/i, qc: /^Dimensional.*Last Completed/i, ld08: /^Lead Injury.*Last Completed/i };
  const ORI = { date: /^C-02 Orientation Date/i, by: /^Delivered By/i, topics: /^(Card|Section) 1\.1/i, acks: /^(Card|Section) 1\.2/i, verified: /^Coordinator Verified/i };
  const toNew = (c) => String(c).replace(/^C-(0[4-9]|10)$/, (_, n) => "C-" + String(+n - 1).padStart(2, "0")), toOld = (c) => c.replace(/^C-(0[3-9])$/, (_, n) => "C-" + String(+n + 1).padStart(2, "0"));
  async function run(j) {
    if (j.t === "level") { const s = await sheet("Module Grid"), old = s.values[s.hr].some((h) => String(h).trim() === "C-10"), code = old ? toOld(j.code) : j.code; await write("Module Grid", locate(s, j.name, (h) => h === code, code), j.level || ""); }
    else if (j.t === "extra") { const s = await sheet("Added Modules"), old = s.values[s.hr].some((h) => String(h).trim() === "C-10"), code = old ? toOld(j.code) : j.code; await write("Added Modules", locate(s, j.name, (h) => h === code, code), j.level || ""); }
    else if (j.t === "position") { const s = await sheet("Roster"); await write("Roster", locate(s, j.name, (h) => /^(current position|job title|position)$/i.test(h), "Current Position"), j.position); try { await write("Roster", locate(s, j.name, (h) => /^date in current position$/i.test(h), "Date in Current Position"), serial(j.date)); } catch (e) {} }
    else if (j.t === "refresher") { const s = await sheet("Refresher Log"); await write("Refresher Log", locate(s, j.name, (h) => REF[j.key].test(h), j.key), serial(j.date)); }
    else if (j.t === "orient") {
      const s = await sheet("Safety Orientation");
      for (const [k, v] of Object.entries({ date: serial(j.date), by: j.by, topics: "Yes", acks: "Yes", verified: j.verified })) await write("Safety Orientation", locate(s, j.name, (h) => ORI[k].test(h), k), v);
    }
    else if (j.t === "orientVerify") { const s = await sheet("Safety Orientation"); await write("Safety Orientation", locate(s, j.name, (h) => ORI.verified.test(h), "verified"), "Yes"); }
  }
  async function pump() {
    if (testMode) return;
    const todo = () => queue.filter((q) => !done.has(q.id) && !q.failed);
    if (busy || !account || !todo().length) { if (account && !todo().length && status.state !== "error") setStatus("ok", "All changes saved"); return; }
    busy = true; clearTimeout(timer);
    try {
      let next;
      while ((next = todo()[0])) {
        setStatus("syncing", "Saving " + todo().length + " change" + (todo().length > 1 ? "s" : "") + "…");
        try { await run(next.job); }
        catch (e) {
          const m = e.message || String(e);
          if (/not on tab|Column not found/.test(m)) { next.failed = m; hooks.failed(next.id, m); continue; } // the workbook can't take it; skip it
          throw e;
        }
        done.add(next.id); hooks.done([next.id]);
      }
      status.last = new Date(); setStatus("ok", "All changes saved");
    } catch (e) {
      if (status.state !== "signin") setStatus("error", e.message || String(e));
      timer = setTimeout(() => { busy = false; pump(); }, 20000); return;
    }
    busy = false;
  }
  async function pull() {
    const [ro, mg, so, rl] = await Promise.all(["Roster", "Module Grid", "Safety Orientation", "Refresher Log"].map((n) => sheet(n, true)));
    const H = (s) => Object.fromEntries(s.values[s.hr].map((h, i) => [String(h).trim(), i]));
    const rows = (s) => s.values.slice(s.hr + 1).filter((r) => String(r[0]).trim());
    const h = H(ro), v = (r, k) => (h[k] !== undefined ? r[h[k]] : k === "Current Position" ? ["Job Title", "Position", "Title"].map((a) => (h[a] !== undefined ? r[h[a]] : "")).find(Boolean) : "") ?? "";
    const roster = rows(ro).map((r) => ({ name: String(r[0]).trim(), id: String(v(r, "Employee ID")), team: String(v(r, "Team")), shift: String(v(r, "Shift")), hire: fromSerial(v(r, "Hire Date")), track: String(v(r, "Track")), position: String(v(r, "Current Position")), inPosition: fromSerial(v(r, "Date in Current Position")), needs: String(v(r, "Needs Program?")), basis: String(v(r, "Basis / Reason")), baseline: fromSerial(v(r, "Baseline Assessment Date")), card: String(v(r, "Qualification Card Issued")), target: fromSerial(v(r, "Target Qualification Date")), trainer: String(v(r, "Assigned Trainer")), status: String(v(r, "Training Status")), notes: String(v(r, "Notes")) }))
      .filter((r) => r.name.length < 60 && (r.id || r.team || r.position));
    let trainers = null;
    try {
      const ts = await sheet("Trainers", true), th = ts.values[ts.hr], ci = (re) => th.findIndex((x) => re.test(String(x).trim()));
      const cR = ci(/^(role|title|job title|position)$/i), cP = ci(/^pin/i), cA = ci(/^(active|status)$/i);
      // The Trainers tab's PIN column is skipped: PINs live only in the app, hashed.
      trainers = ts.values.slice(ts.hr + 1).filter((r) => String(r[ts.nc]).trim() && String(r[ts.nc]).length < 60).map((r) => ({ name: String(r[ts.nc]).trim(), role: cR >= 0 ? String(r[cR] || "") : "", active: cA >= 0 ? !/^(no|inactive|n|false|0)$/i.test(String(r[cA] || "").trim()) : true, fields: th.map((hh, i) => [String(hh).trim(), r[i], i]).filter(([hh, vv, i]) => i !== ts.nc && i !== cP && !/pin/i.test(hh) && hh && vv !== "" && vv !== null).map(([hh, vv]) => ({ k: hh, v: /date/i.test(hh) && fromSerial(vv) ? fromSerial(vv) : String(vv) })) })).filter((t) => t.active);
    } catch (e) {}
    const levels = {}, mh = mg.values[mg.hr], oldNums = mh.some((x) => String(x).trim() === "C-10");
    rows(mg).forEach((r) => { const o = {}; mh.forEach((code, i) => { if (/^(C|L|W|LD|Q)-/.test(String(code)) && typeof r[i] === "number") o[oldNums ? toNew(String(code).trim()) : code] = r[i]; }); if (Object.keys(o).length) levels[String(r[0]).trim()] = o; });
    const extra = {}; try { const am = await sheet("Added Modules", true), ah = am.values[am.hr]; am.values.slice(am.hr + 1).forEach((r) => { const nm = String(r[0]).trim(); if (!nm) return; const o = {}; ah.forEach((code, i) => { const c = String(code).trim(); if (/^(C|L|W|LD|Q)-/.test(c) && typeof r[i] === "number" && r[i] > 0) o[oldNums ? toNew(c) : c] = r[i]; }); if (Object.keys(o).length) extra[nm] = o; }); } catch (e) {}
    const safety = {}, sh = so.values[so.hr], si = (k) => sh.findIndex((x) => ORI[k].test(String(x).trim()));
    rows(so).forEach((r) => { const d = fromSerial(r[si("date")]); if (d) safety[String(r[0]).trim()] = { date: d, by: r[si("by")] || "", topics: r[si("topics")] || "", acks: r[si("acks")] || "", verified: r[si("verified")] || "" }; });
    const refreshers = {}, rh = rl.values[rl.hr];
    rows(rl).forEach((r) => { const o = {}; Object.entries(REF).forEach(([k, re]) => { const i = rh.findIndex((x) => re.test(String(x).trim())); const d = i >= 0 ? fromSerial(r[i]) : null; if (d) o[k] = d; }); if (Object.keys(o).length) refreshers[String(r[0]).trim()] = o; });
    status.last = new Date(); emit();
    return { extra, oldNums, roster, levels, safety, refreshers, trainers };
  }
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  window.CDGSync = {
    on: (f) => { subs.add(f); return () => subs.delete(f); },
    status: () => ({ ...status, pending: pending(), account: account ? account.name || account.username : "", file: cache.name || "", configured: configured(), signedIn: !!account }),
    config: () => ({ ...cfg }),
    // Settings from the database (the app calls this whenever they change).
    useConfig: (c, isTest) => {
      testMode = !!isTest;
      const n = { clientId: (c?.clientId || "").trim(), tenantId: (c?.tenantId || "").trim(), link: (c?.link || "").trim() };
      if (n.clientId === cfg.clientId && n.tenantId === cfg.tenantId && n.link === cfg.link && (app || !configured())) { emit(); return; }
      cfg = n; cache = {}; account = null; app = null; init();
    },
    // Checks typed settings; returns a list of problems (empty = fine). Saving them is the app's job.
    checkConfig: (c) => {
      const n = { clientId: (c.clientId || "").trim(), tenantId: (c.tenantId || "").trim(), link: (c.link || "").trim() }, bad = [];
      if (!guid.test(n.clientId)) bad.push("Client ID should look like 1a2b3c4d-…");
      if (!guid.test(n.tenantId) && !/\./.test(n.tenantId)) bad.push("Tenant ID should look like 1a2b3c4d-… or cdg.onmicrosoft.com");
      if (!/^https:\/\/.+sharepoint\.com\//i.test(n.link)) bad.push("Workbook link should start with https://…sharepoint.com/");
      return bad;
    },
    // Changes waiting for the workbook, from the database: [{ id, job, failed }]
    setQueue: (items, h) => {
      hooks = h || hooks;
      queue = items;
      const ids = new Set(items.map((q) => q.id));
      [...done].forEach((id) => { if (!ids.has(id)) done.delete(id); });
      emit();
      pump();
    },
    signIn: () => {
      if (!configured()) return Promise.reject(new Error("Enter the client ID, tenant ID and workbook link, then tap Save settings"));
      if (!app) return init().then(() => { throw new Error("Still starting up. Tap Sign in again"); });
      try { [sessionStorage, localStorage].forEach((st) => Object.keys(st).filter((k) => /interaction\.status|interaction_in_progress/i.test(k)).forEach((k) => st.removeItem(k))); } catch (e) {}
      setStatus("signingin", "Opening Microsoft sign-in…");
      return app.loginRedirect({ scopes: SCOPES, prompt: "select_account" }).catch((e) => {
        const m = (e && (e.errorMessage || e.message)) || String(e); setStatus("error", m); throw new Error(m);
      });
    },
    redirectUri: () => new URL("auth.html", location.origin + location.pathname).href,
    signOut: async () => { if (app && account) await app.logoutRedirect({ account }); },
    ready: () => !!account,
    push: () => {}, // the server queues workbook changes now
    retry: () => { busy = false; queue.forEach((q) => { delete q.failed; }); pump(); },
    test: async () => { cache = {}; await item(); await sheet("Module Grid", true); return cache.name; },
    pull,
  };
})();
