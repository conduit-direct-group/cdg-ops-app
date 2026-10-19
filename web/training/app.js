// Training — the training team's trainer app (CDGTRN0009), inside CDG Ops.
//
// This is the original app's screen logic, kept as close to the original as possible so the screens and
// workflow stay the same. What changed (security, plus living in CDG Ops):
//   - Everything is saved in the database (signed-in people only) through the server, not in the tablet's
//     browser storage: roster, levels, signatures, checklists, knowledge checks, safety, to-dos, workbook queue.
//   - Trainer PINs are checked on the server and stored hashed. No PINs in the code; no default PINs.
//   - A change is accepted only from an unlocked trainer (server session), and the server re-checks the
//     sign-off rules (own competency, LD-01 level, overdue refreshers, coordinator countersign with PIN).
//   - The coordinator is whoever an admin marks as coordinator (Admin → Training setup), not a name in the code.
//   - Test mode (dev site): records go to test copies and nothing is written to the workbook.

import { auth, db, TEST_MODE, callTrainingUnlock, callTrainingLock, callTrainingAddTrainer, callTrainingSave } from "../firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { collection, doc, onSnapshot, getDoc, query, orderBy } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { DCLogic, mount } from "./runtime.js";

const React = window.React;
const APP_VERSION = 'v47', APP_DATE = 'Oct 14, 2026';
const ME_KEY = 'cdg-training-me', DEVICE_KEY = 'cdg-training-device';
const col = name => collection(db, (TEST_MODE ? 'test_' : '') + name);
const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
// Server messages are already plain English; the rest get a short version.
const friendly = e => e?.code === 'offline' ? 'You’re offline. Try again when you’re back online' : String(e?.message || e || 'Something went wrong').replace(/^FirebaseError:\s*/, '').slice(0, 110);
const NEXT_POS = { 'Line Operator I': 'Line Operator II', 'Line Operator II': 'Line Operator III', 'Line Operator III': 'Lead Operator', 'Winder Operator I': 'Winder Operator II', 'Winder Operator II': 'Lead Winder' };
const SCALE = ['Not Trained', 'Trained / Aware', 'Assisted', 'Independent', 'Qualified to Train'];
const SERIES = { 'C - Core (all personnel)': 'Core · all personnel', 'L - Line track': 'Line track', 'W - Winder track': 'Winder track', 'LD - Leadership': 'Leadership', 'Q - Quality Control': 'Quality Control' };
const C = { ink: 'oklch(0.22 0.01 85)', muted: 'oklch(0.5 0.01 85)', accent: 'oklch(0.58 0.12 165)', soft: 'oklch(0.93 0.04 165)', softInk: 'oklch(0.4 0.1 165)', link: 'oklch(0.45 0.11 165)', border: 'oklch(0.9 0.008 85)', border2: 'oklch(0.8 0.01 85)', amber: 'oklch(0.94 0.05 80)', amberInk: 'oklch(0.45 0.09 70)', gray: 'oklch(0.93 0.008 85)', red: 'oklch(0.55 0.15 25)', track: 'oklch(0.92 0.008 85)' };
const REFS = [['loto', 'LOTO — Affected Employee'], ['eap', 'Emergency Action Plan & Drill'], ['ppe', 'Safety / PPE / Guarding / Electrical'], ['c10', 'Injury & Incident Reporting (C-09)'], ['qc', 'Dimensional & Wind Quality Check'], ['ld08', 'Lead Injury Response (LD-08) · leads only']];
const iso = d => d.toISOString().slice(0, 10);
const addYear = s => { const d = new Date(s + 'T12:00:00'); d.setFullYear(d.getFullYear() + 1); return iso(d); };
const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const inits = n => n.replace(/".*?"/g, '').split(/\s+/).filter(Boolean).map(x => x[0]).slice(0, 2).join('').toUpperCase();
const fmtISO = s => s ? fmt(new Date(s + 'T12:00:00')) : '—';
// "Today" in plant time, same as the server.
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
// A trainee with no records in the app yet: one imported entry per workbook level (the server does the same).
const seedOne = levels => Object.fromEntries(Object.entries(levels || {}).map(([c, l]) => [c, Array.from({ length: Math.max(0, Math.min(4, +l || 0)) }, (_, i) => ({ level: i + 1, trainer: 'Workbook', date: 'Imported from CDGTRN0009', imported: true }))]));
class Component extends DCLogic {
  detailRef = React.createRef();
  pads = { i: { ref: React.createRef() }, s: { ref: React.createRef() }, c: { ref: React.createRef() } };
  state = { data: null, records: null, trainers: null, me: null, screen: 'home', sel: null, mod: null, tab: 'modules', filter: 'all', q: '', open: {}, sign: null, ink: { i: false, s: false, c: false }, addOpen: false, newName: '', newRole: 'Trainer', newPin: '', newCoord: false, pinFor: null, pinVal: '', pinErr: false, coWho: null, coPin: '', sops: {}, newStep: '', lib: null, mtab: 'ov', sopSel: null, checks: {}, locked: false, newEmp: '', refresh: {}, orient: {}, wbClient: (window.CDGSync && CDGSync.config().clientId) || '', wbTenant: (window.CDGSync && CDGSync.config().tenantId) || '', wbLink: (window.CDGSync && CDGSync.config().link) || '', refSel: null, refQ: '', todos: [], todoText: '', fileDirty: 0, lastSaved: null, lastLoaded: null, kcAns: {}, kcAtt: {}, kcShow: false, extra: {}, addMod: '', addLvl: 3, toast: null };
  sopView(so) {
    if (!so) return { no: '', title: '', purpose: '', scope: '', ppe: [], parts: [], photoId: 'sop-none' };
    const blocks = p => p.blocks.map(b => ({ isSub: b.k === 'sub', isStep: b.k === 'step', isCaution: b.k === 'caution', isNote: b.k === 'note', isTable: b.k === 'table', isBlank: !!b.blank, text: b.text || '', n: b.n || '', subs: (b.subs || []).map(t => ({ text: t })), caption: b.caption || 'Table',
      cols: b.rows ? 'repeat(' + Math.max(...b.rows.map(x => x.length)) + ', minmax(0,1fr))' : '1fr', rows: (b.rows || []).map((x, i) => ({ cells: x.map(t => ({ text: t })), bg: i === 0 ? 'oklch(0.965 0.006 85)' : '#fff', w: i === 0 ? 600 : 400 })) }));
    return { no: so.no, title: so.title, purpose: so.purpose, scope: so.scope, ppe: so.ppe.map(t => ({ text: t })), photoId: 'sop-' + so.no + '-hero', parts: so.parts.map(p => ({ title: p.title, blocks: blocks(p) })) };
  }
  markDirty() { if (window.CDGSync && CDGSync.ready()) return; this.setState(st => ({ fileDirty: (st.fileDirty || 0) + 1 })); }
  fileRef = React.createRef();
  // Workbook data pulled from Microsoft or a workbook file: shown right away, and saved for every tablet.
  mergeWorkbook(wb) {
    const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    this.setState(st => {
      const data = { ...st.data, roster: wb.roster.length ? wb.roster : st.data.roster, levels: wb.levels, safety: { ...(st.data.safety || {}), ...wb.safety }, refreshers: { ...(st.data.refreshers || {}), ...wb.refreshers } };
      const records = { ...st.records };
      Object.entries(wb.levels).forEach(([n, o]) => { const p = { ...(records[n] || {}) }; Object.entries(o).forEach(([c, l]) => { const a = p[c] || []; if (l > a.length) p[c] = [...a, ...Array.from({ length: l - a.length }, (_, i) => ({ level: a.length + i + 1, trainer: 'Workbook', date: 'From CDGTRN0009', imported: true }))]; }); records[n] = p; });
      if (wb.trainers) data.trainerInfo = wb.trainers;
      const extra = { ...(st.extra || {}) }; Object.entries(wb.extra || {}).forEach(([n, o]) => { extra[n] = { ...o, ...(extra[n] || {}) }; });
      return { extra, data, records, lastLoaded: stamp, wbOld: typeof wb.oldNums === 'boolean' ? wb.oldNums : st.wbOld, wbData: { trainerInfo: data.trainerInfo, rev: st.data.rev, roster: data.roster, levels: data.levels, safety: data.safety, refreshers: data.refreshers } };
    });
    return this.save({ op: 'wbMerge', wb, stamp }, { quiet: !this._token });
  }
  async pullWorkbook(manual) {
    if (!window.CDGSync || !CDGSync.ready() || !this.state.data) { if (manual) this.flash('Sign in with Microsoft first'); return; }
    if (!this._token) { if (manual) this.flash('Unlock with your PIN first'); return; }
    try {
      const wb = await CDGSync.pull(); this.mergeWorkbook(wb);
      if (manual) this.flash('Pulled ' + wb.roster.length + ' people' + ' from the workbook');
    } catch (e) { if (manual) this.flash('Pull failed: ' + String(e.message || e).slice(0, 70)); }
  }
  componentWillUnmount() { clearInterval(this._lockT); clearInterval(this._pullT); this._unsub && this._unsub(); (this._stops || []).forEach(f => f()); ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(e => window.removeEventListener(e, this._act, true)); }

  // --- saving: every change goes to the server with this trainer's unlock session ---------------------------
  // The screen updates right away; if the server says no, the message shows and the screen goes back to what
  // the database has. Resolves to the server's answer, or null if it didn't save.
  save(payload, { quiet } = {}) {
    if (!this._token) { if (!quiet) { this.flash('Locked. Enter your PIN'); this.lockUp(); } this.rebuild(); return Promise.resolve(null); }
    return callTrainingSave({ token: this._token, dirty: !(window.CDGSync && CDGSync.ready()), ...payload }).then(r => r.data).catch(e => {
      if (e?.code === 'functions/unauthenticated') this.lockUp();
      if (!quiet) this.flash(friendly(e));
      this.rebuild();
      return null;
    });
  }
  // Lock: the session ends on the server too, so the PIN is needed again.
  lockUp() {
    const t = this._token; this._token = null;
    if (t) callTrainingLock({ token: t }).catch(() => {});
    if (this.state.me) this.setState({ locked: true, pinFor: this.state.me, pinVal: '', pinErr: false, pinMsg: null, sign: null, addOpen: false });
  }
  // First unlock on this tablet: get the latest from the workbook if signed in to Microsoft.
  afterUnlock() { if (window.CDGSync && CDGSync.ready() && !this._pulled) { this._pulled = true; setTimeout(() => this.pullWorkbook(false), 0); } }
  signOutTrainer() {
    const t = this._token; this._token = null;
    if (t) callTrainingLock({ token: t }).catch(() => {});
    this.setState({ me: null, locked: false, pinFor: null, pinVal: '' });
  }
  // Signature pictures load when first shown, and are kept for the visit.
  sigOf(rec) {
    if (!rec) return '';
    if (rec.sig) return rec.sig;
    const id = rec.sigId; if (!id) return '';
    const hit = this._sigs.get(id);
    if (hit !== undefined) return hit || '';
    this._sigs.set(id, null);
    getDoc(doc(col('trainingSigs'), id)).then(s => { this._sigs.set(id, s.exists() ? s.get('png') : ''); this.forceUpdate(); }).catch(() => this._sigs.delete(id));
    return '';
  }
  safetyOf(r) {
    const d = this.state.data, base = (d.refreshers || {})[r.name] || {}, ov = this.state.refresh[r.name] || {}, today = todayIso(), lead = /Lead/.test(r.position || '');
    const list = REFS.filter(([k]) => k !== 'ld08' || lead).map(([k, label]) => { const last = ov[k] || base[k] || null, due = last ? addYear(last) : null;
      const days = due ? Math.round((new Date(due + 'T12:00:00') - new Date(today + 'T12:00:00')) / 864e5) : null;
      return { k, label, last, due, st: !last ? 'none' : days < 0 ? 'over' : days <= 30 ? 'soon' : 'ok' }; });
    return { list, orient: this.state.orient[r.name] || (d.safety || {})[r.name] || null, overdue: list.filter(x => x.st === 'over').length, soon: list.filter(x => x.st === 'soon').length };
  }
  gateFor(meT, r) {
    if (this.safetyOf(r).overdue) return { ok: false, msg: 'Refresher overdue: no level advances until it’s current' };
    if (meT.coordinator) return { ok: true };
    if (meT.employee && meT.employee === r.name) return { ok: false, msg: 'No one may sign off their own competency' };
    const need = this.props.ld01MinLevel ?? 3, lv = meT.employee ? ((this.state.records[meT.employee] || {})['LD-01'] || []).length : 0;
    if (lv < need) return { ok: false, msg: meT.employee ? 'Your LD-01 is Level ' + lv + '; Level ' + need + ' required to sign' : 'Link your roster record: LD-01 required to sign' };
    return { ok: true };
  }
  componentDidMount() {
    this._sigs = new Map();
    this._token = null;
    this._snap = { ref: {}, trainers: null, people: null, shared: undefined, queue: [] };
    if (window.CDGSync) this._unsub = CDGSync.on(() => { this.forceUpdate(); if (CDGSync.ready() && this.state.data && this._token && !this._pulled) { this._pulled = true; this.pullWorkbook(false); } });
    this._pullT = setInterval(() => this.pullWorkbook(false), 5 * 60000);
    this.lastAct = Date.now(); this._act = () => { this.lastAct = Date.now(); };
    ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(e => window.addEventListener(e, this._act, true));
    ['online', 'offline', 'resize'].forEach(e => window.addEventListener(e, () => this.forceUpdate()));
    this._lockT = setInterval(() => { const s = this.state, mins = this.props.lockMinutes ?? 2; if (s.me && !s.locked && mins > 0 && Date.now() - this.lastAct > mins * 60000) this.lockUp(); }, 5000);
    // On this device only: which alerts were dismissed / to-dos hidden, and the last trainer (who must enter their PIN again).
    const dev = ls(DEVICE_KEY, {}), me = ls(ME_KEY, null);
    this.setState({ alertDismissed: dev.alertDismissed || null, todoHidden: dev.todoHidden || [], me, locked: !!me, pinFor: me, sel: null, open: { 'C-04': true }, promoFor: null });
    this.listen();
  }
  // Live copies of the training records: every tablet sees changes as they happen (and keeps a copy for bad Wi-Fi).
  listen() {
    (this._stops || []).forEach(f => f());
    this._snap = { ref: {}, trainers: null, people: null, shared: undefined, queue: [] };
    const fail = e => { this._snap.error = friendly(e); this.rebuild(); };
    const parse = s => { try { return s.exists() ? JSON.parse(s.get('json')) : 'missing'; } catch (e) { return 'missing'; } };
    this._stops = [
      ...['data', 'lib-guides', 'lib-sops', 'lib-kc', 'lib-rest'].map(id => onSnapshot(doc(db, 'trainingRef', id), s => { this._snap.ref[id] = parse(s); this.rebuild(); }, fail)),
      onSnapshot(doc(db, 'trainingRef', 'entra'), s => { this._snap.entra = s.exists() ? s.data() : null; this.rebuild(); }, () => { this._snap.entra = null; }),
      onSnapshot(col('trainingTrainers'), s => { this._snap.trainers = s.docs.map(d => ({ id: d.id, ...d.data() })); this.rebuild(); }, fail),
      onSnapshot(col('trainingPeople'), s => { this._snap.people = s.docs.map(d => d.data()); this.rebuild(); }, fail),
      onSnapshot(doc(col('trainingShared'), 'state'), s => { this._snap.shared = s.exists() ? s.data() : null; this.rebuild(); }, fail),
      ...(TEST_MODE ? [] : [onSnapshot(query(collection(db, 'trainingWbQueue'), orderBy('at')), s => { this._snap.queue = s.docs.map(d => ({ id: d.id, job: d.get('job'), failed: d.get('failed') || null })); this.rebuild(); }, () => {})]),
    ];
  }
  // Builds the same state the original app kept in the tablet's storage, from the database copies.
  rebuild() {
    const S = this._snap; if (!S) return;
    if (S.error) return this.setState({ loadError: S.error });
    const R = S.ref, ids = ['data', 'lib-guides', 'lib-sops', 'lib-kc', 'lib-rest'];
    if (ids.some(id => R[id] === 'missing')) return this.setState({ loadError: 'missing' });
    if (ids.some(id => !R[id]) || !S.trainers || !S.people || S.shared === undefined) return;
    const data = JSON.parse(JSON.stringify(R.data)), sh = S.shared || {};
    let wbData = null; try { wbData = sh.wbData ? JSON.parse(sh.wbData) : null; } catch (e) {}
    if (wbData?.roster?.length && wbData.rev === data.rev) Object.assign(data, wbData);
    data.roster = data.roster.filter(r => r.name && r.name.length < 60 && (r.id || r.team || r.position));
    const lib = { ...R['lib-rest'], guides: R['lib-guides'], sops: R['lib-sops'], kc: R['lib-kc'] };
    const known = new Set(data.modules.map(m => m.code)), keep = o => o && Object.fromEntries(Object.entries(o).filter(([c]) => known.has(c)));
    const out = { records: {}, checks: {}, kcAns: {}, kcAtt: {}, extra: {}, refresh: {}, orient: {}, posOv: {} };
    S.people.forEach(p => { if (!p.name) return;
      out.records[p.name] = keep(p.records) || seedOne((data.levels || {})[p.name]);
      ['checks', 'kcAns', 'kcAtt'].forEach(k => { if (p[k]) out[k][p.name] = keep(p[k]); });
      ['extra', 'refresh', 'orient', 'posOv'].forEach(k => { if (p[k]) out[k][p.name] = p[k]; }); });
    data.roster.forEach(r => { if (!out.records[r.name]) out.records[r.name] = seedOne((data.levels || {})[r.name]); });
    const trainers = S.trainers.filter(t => t.active !== false).map(t => ({ id: t.id, name: t.name, role: t.coordinator ? 'Training & Safety Coordinator' : (t.role || 'Trainer'), coordinator: t.coordinator === true, employee: t.employee || null, info: t.info || undefined }));
    if (this._newTrainer && !trainers.some(t => t.id === this._newTrainer.id)) trainers.push(this._newTrainer);
    this.setState({ loadError: null, data, lib, ...out, trainers, todos: sh.todos || [], fileDirty: sh.fileDirty || 0, lastSaved: sh.lastSaved || null, lastLoaded: sh.lastLoaded || null, wbOld: sh.wbOld, wbData });
    // Workbook sync: settings from the coordinator (or the original app's), and the changes waiting to be written.
    if (window.CDGSync) {
      const pick = o => o && o.clientId ? o : null, cfg = pick(sh.wbConfig) || pick(S.entra) || { clientId: '', tenantId: '', link: '' };
      const key = cfg.clientId + '|' + cfg.tenantId + '|' + cfg.link;
      if (key !== this._cfgKey) { this._cfgKey = key; CDGSync.useConfig(cfg, TEST_MODE); this.setState({ wbClient: cfg.clientId, wbTenant: cfg.tenantId, wbLink: cfg.link }); }
      CDGSync.setQueue(S.queue, { done: ids2 => this.save({ op: 'wbDone', ids: ids2 }, { quiet: true }), failed: (id, failed) => this.save({ op: 'wbFailed', id, failed }, { quiet: true }) });
    }
  }
  componentDidUpdate() {
    const s = this.state, ps = this._prev || {};
    const V = ['sel', 'mod', 'tab', 'mtab', 'sopSel', 'me', 'alertDismissed', 'todoHidden'];
    this._prev = Object.fromEntries(V.map(k => [k, s[k]]));
    if (ps.me !== s.me) lsSet(ME_KEY, s.me || null);
    if (ps.alertDismissed !== s.alertDismissed || ps.todoHidden !== s.todoHidden) lsSet(DEVICE_KEY, { alertDismissed: s.alertDismissed || null, todoHidden: s.todoHidden || [] });
    if ((ps.sel !== s.sel || ps.mod !== s.mod || ps.tab !== s.tab || ps.mtab !== s.mtab || ps.sopSel !== s.sopSel) && this.detailRef.current) this.detailRef.current.scrollTop = 0;
  }
  flash(m) { clearTimeout(this._t); this.setState({ toast: m }); this._t = setTimeout(() => this.setState({ toast: null }), 2600); }
  pad(k) {
    const p = this.pads[k];
    const pt = e => { const c = p.ref.current, r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
    return {
      ref: p.ref,
      down: e => { const c = p.ref.current; if (!c) return; try { c.setPointerCapture(e.pointerId); } catch (x) {} const g = c.getContext('2d'); g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#1d2433'; p.drawing = true; g.beginPath(); g.moveTo(...pt(e)); },
      move: e => { if (!p.drawing) return; const g = p.ref.current.getContext('2d'); g.lineTo(...pt(e)); g.stroke(); if (!this.state.ink[k]) this.setState(s => ({ ink: { ...s.ink, [k]: true } })); },
      up: () => { p.drawing = false; },
      clear: () => { const c = p.ref.current; if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height); this.setState(s => ({ ink: { ...s.ink, [k]: false } })); }
    };
  }
  roleKey(r) { const R = this.state.data.reqMin; if (/^\s*office\s*$/i.test(r.track || '') && R['Office Staff']) return 'Office Staff'; return this.roleKey0(r); }
  roleKey0(r) { const k = this.roleKey1(r), R = this.state.data.reqMin; return R[k] ? k : (R['Other Job Titles'] && r.position ? 'Other Job Titles' : k); }
  roleKey1(r) { const R = this.state.data.reqMin, hit = v => Object.keys(R).find(k => /Shipping|Maintenance/.test(k) && new RegExp(k.split(' ')[0], 'i').test(v || ''));
    return R[r.position] ? r.position : hit(r.position) || hit(r.team) || r.position; }
  person(r) {
    const d = this.state.data, base = d.reqMin[this.roleKey(r)] || {}, ex = (this.state.extra || {})[r.name] || {}, mins = { ...base };
    Object.entries(ex).forEach(([c, l]) => { if (!(base[c] > 0)) mins[c] = l; });
    const extra = new Set(Object.keys(ex).filter(c => !(base[c] > 0))), req = d.modules.filter(m => (mins[m.code] || 0) > 0);
    const rec = this.state.records[r.name] || {}, lv = c => (rec[c] || []).length;
    const met = req.filter(m => lv(m.code) >= mins[m.code]).length, pct = req.length ? Math.round(met / req.length * 100) : 0;
    return { r, mins, req, met, pct, lv, rec, extra, qualified: req.length > 0 && met === req.length };
  }
  setRecords(name, code, fn) { this.setState(s => { const p = { ...(s.records[name] || {}) }; p[code] = fn(p[code] || []); return { records: { ...s.records, [name]: p } }; }); }
  levelsFor(P, m) {
    const min = P.mins[m.code] || 0, cur = P.lv(m.code), list = P.rec[m.code] || [];
    return [1, 2, 3, 4].map(k => {
      const rec = list[k - 1], signed = k <= cur, next = k > cur, skip = k > cur + 1;
      return {
        k, name: SCALE[k], next: next && this._gate.ok, canRevoke: signed && k === cur && (this._me.coordinator || rec?.trainerId === this._me.id),
        tag: skip ? 'Can sign directly · fills in ' + (k - cur - 1 === 1 ? 'Level ' + (cur + 1) : 'Levels ' + (cur + 1) + '–' + (k - 1)) : k === min ? 'Position minimum' : k > min ? 'Beyond minimum' : 'Required step', tagColor: k === min ? C.link : C.muted,
        who: !rec && next && !this._gate.ok ? this._gate.msg : rec ? (rec.imported ? 'Imported from CDGTRN0009' : rec.filled ? `${rec.trainer} · ${rec.date} · recorded with Level ${rec.filled} sign-off` : `${rec.trainer} · ${rec.date}` + (rec.coordinator ? ` · countersigned by ${rec.coordinator}` : '')) : k === 4 && next ? 'Needs Coordinator countersign' : (signed ? '' : next ? '' : `Sign Level ${k - 1} first`),
        hasInk: !!(rec && (rec.sig || rec.sigId)), ini: rec?.initials || '', sig: this.sigOf(rec),
        boxBg: signed ? C.accent : '#fff', boxBorder: signed ? C.accent : next ? C.ink : C.border2, checkOp: signed ? 1 : 0, rowOp: !signed && !next ? 0.45 : 1,
        sign: () => this.setState({ sign: { name: P.r.name, code: m.code, level: k }, ink: { i: false, s: false, c: false }, coWho: null, coPin: '' }),
        revoke: () => { this.markDirty(); this.save({ op: 'revoke', name: P.r.name, code: m.code, level: k }); this.setRecords(P.r.name, m.code, a => a.slice(0, k - 1)); this.flash(`Level ${k} removed from ${m.code}`); }
      };
    });
  }
  chip(st, q) { if (q) return { status: 'Minimums met', chipBg: C.accent, chipInk: '#fff' }; if (st === 'In training') return { status: st, chipBg: C.soft, chipInk: C.softInk }; if (st === 'Scheduled') return { status: st, chipBg: C.amber, chipInk: C.amberInk }; return { status: st || 'No status', chipBg: C.gray, chipInk: C.muted }; }
  renderVals() {
    const s = this.state;
    const bare = !!this.props.bare;
    // The screens are laid out for a 1000px+ tablet. Smaller tablets and sideways phones get the whole screen scaled to fit;
    // an upright phone is asked to turn sideways (or can show it anyway, unscaled, as the original did).
    const vw = window.innerWidth || 1000, z = vw >= 1000 || (vw < 640 && s.narrowOk) ? 1 : Math.max(vw / 1000, 0.64);
    const base = { narrow: vw < 640 && !s.narrowOk, narrowOk: () => this.setState({ narrowOk: true }), alertBar: { show: false }, fr: bare ? { zoom: z, w: (100 / z).toFixed(3) + 'vw', h: (100 / z).toFixed(3) + 'dvh', r: '0', b: '0', sh: 'none' } : { w: '1194px', h: '834px', r: '40px', b: '14px solid #16181b', sh: '0 30px 60px -20px rgba(0,0,0,.35)' }, notBare: !bare, testMode: TEST_MODE, opsHome: './', offline: !navigator.onLine,
      newEmp: s.newEmp, empOpts: [{ v: '', label: 'Not linked' }].concat((s.data?.roster || []).map(x => ({ v: x.name, label: x.name + ' · ' + (x.position || 'No position') }))),
      wbTrOpts: (() => { const have = new Set((s.trainers || []).flatMap(t => [t.name.toLowerCase(), (t.employee || '').toLowerCase()])); const first = new Set((s.trainers || []).filter(t => !/\s/.test(t.name.trim())).map(t => t.name.trim().toLowerCase())); const L = (s.data?.trainerInfo || []).filter(t => !have.has(t.name.toLowerCase()) && !first.has(t.name.split(' ')[0].toLowerCase())); return [{ v: '', label: L.length ? 'Choose a trainer from the workbook…' : (s.data?.trainerInfo ? 'Everyone on the Trainers tab has a profile' : 'Load the workbook to see the Trainers tab') }].concat(L.map(t => ({ v: t.name, label: t.name + (t.role ? ' · ' + t.role : '') }))); })(),
      hasWbTr: !!(s.data?.trainerInfo || []).length, newWbTr: s.newWbTr || '', newInfo: s.newInfo || [], hasNewInfo: !!(s.newInfo || []).length,
      onWbTr: e => { const v = e.target.value, t = (this.state.data?.trainerInfo || []).find(x => x.name === v); if (!t) return this.setState({ newWbTr: '', newInfo: [] });
        const emp = (this.state.data?.roster || []).find(x => x.name.toLowerCase() === t.name.toLowerCase());
        this.setState({ newWbTr: v, newName: t.name, newRole: t.role || 'Trainer', newEmp: emp ? emp.name : '', newInfo: t.fields || [] }); },
      onNewEmp: e => { const v = e.target.value; this.setState(st => ({ newEmp: v, newName: v || st.newName })); },
      detailRef: this.detailRef, toast: s.toast, hasToast: !!s.toast, addOpen: s.addOpen, newName: s.newName, newRole: s.newRole,
      openAdd: () => this.setState({ addOpen: true, newName: '', newRole: 'Trainer', newPin: '', newCoord: false, newEmp: '', newWbTr: '', newInfo: [] }), newPin: s.newPin, closeAdd: () => this.setState({ addOpen: false }),
      onNewName: e => this.setState({ newName: e.target.value }), onNewRole: e => this.setState({ newRole: e.target.value }),
      onNewPin: e => this.setState({ newPin: e.target.value.replace(/\D/g, '').slice(0, 4) }), toggleCoord: () => this.setState(st => ({ newCoord: !st.newCoord })),
      coordBox: { bg: s.newCoord ? C.accent : '#fff', border: s.newCoord ? C.accent : C.border2, op: s.newCoord ? 1 : 0 },
      addHint: !s.newName.trim() ? 'Enter a name' : s.newPin.length !== 4 ? 'Choose a 4-digit PIN' : '', addBtnBg: s.newName.trim() && s.newPin.length === 4 ? C.accent : C.border2,
      saveTrainer: () => { const n = s.newName.trim(); if (!n || s.newPin.length !== 4 || this._adding) return; this._adding = true;
        const t = { name: n, role: s.newRole.trim() || 'Trainer', coordinator: false, employee: s.newEmp || null, info: s.newInfo && s.newInfo.length ? s.newInfo : undefined };
        // The server keeps the PIN (hashed) and unlocks the new trainer on this login.
        callTrainingAddTrainer({ ...t, pin: s.newPin }).then(({ data: r }) => { this._token = r.token; this.afterUnlock(); this._newTrainer = { ...t, id: r.id }; this.lastAct = Date.now();
          this.setState(st => ({ trainers: [...st.trainers, this._newTrainer], me: r.id, locked: false, pinFor: null, addOpen: false, screen: 'home' })); this.flash(`Profile created for ${n}`); })
          .catch(e => this.flash(friendly(e))).finally(() => { this._adding = false; }); } };
    if (!s.data) return { ...base, loadMsg: s.loadError === 'missing' ? 'The training data isn’t loaded yet. An admin loads it in CDG Ops → Admin → Training setup.' : s.loadError ? 'Couldn’t load the training data: ' + s.loadError : navigator.onLine ? 'Loading roster from CDGTRN0009…' : 'Offline, and this device has no copy of the training data yet. Connect to Wi-Fi.', loadRetry: s.loadError ? () => { this.setState({ loadError: null }); this.listen(); } : null, loading: true, signedOut: false, signedIn: false, sm: { open: false } };
    const pov = s.posOv || {}, d = { ...s.data, roster: s.data.roster.map(r => pov[r.name] && pov[r.name].from === r.position ? { ...r, position: pov[r.name].to, inPosition: pov[r.name].date } : r) }, people = d.roster.map(r => this.person(r));
    const allSign = Object.entries(s.records).flatMap(([n, o]) => Object.entries(o).flatMap(([c, a]) => a.filter(x => !x.imported).map(x => ({ ...x, trainee: n, code: c }))));
    const trainerCards = s.trainers.map(t => ({ name: t.name, role: t.role, initials: inits(t.name), count: allSign.filter(x => x.trainerId === t.id).length, pick: () => this.setState({ pinFor: t.id, pinVal: '', pinErr: false, pinMsg: null }) }));
    const pinT = s.trainers.find(t => t.id === s.pinFor);
    const press = k => () => { if (k === 'del') return this.setState(st => ({ pinVal: st.pinVal.slice(0, -1), pinErr: false, pinMsg: null })); if (k === '') return;
      const v = (s.pinVal + k).slice(0, 4); if (v.length < 4) return this.setState({ pinVal: v, pinErr: false, pinMsg: null });
      // The PIN is checked on the server (5 wrong tries locks this trainer for 15 minutes).
      if (this._pinBusy) return; this._pinBusy = true; this.setState({ pinVal: v, pinErr: false, pinMsg: 'Checking…' });
      callTrainingUnlock({ trainerId: pinT.id, pin: v }).then(({ data: r }) => { this._token = r.token; this.afterUnlock(); const wasLocked = this.state.locked && this.state.me === pinT.id; this.setState(wasLocked ? { locked: false, pinFor: null, pinVal: '', pinMsg: null } : { me: pinT.id, locked: false, screen: 'home', pinFor: null, pinVal: '', pinMsg: null }); this.lastAct = Date.now(); if (wasLocked) return; this.flash(`Signed in as ${pinT.name}`); })
        .catch(e => this.setState({ pinVal: '', pinErr: true, pinMsg: friendly(e) })).finally(() => { this._pinBusy = false; }); };
    base.pinOpen = !!pinT;
    base.pin = pinT ? { name: pinT.name, initials: inits(pinT.name), err: s.pinErr, msg: s.pinErr ? (s.pinMsg || 'Incorrect PIN, try again') : s.pinMsg ? s.pinMsg : s.locked ? 'Locked. Enter PIN to resume' : 'Enter your 4-digit PIN', msgColor: s.pinErr ? C.red : C.muted,
      dots: [0, 1, 2, 3].map(i => ({ bg: i < s.pinVal.length ? C.ink : 'transparent', border: s.pinErr ? C.red : C.ink })),
      keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map(k => ({ label: k === 'del' ? '⌫' : k, op: k === '' ? 0 : 1, press: press(k) })),
      overlay: s.locked ? 'oklch(0.94 0.006 85)' : 'rgba(20,22,26,.45)', cancelLabel: s.locked ? 'Switch trainer' : 'Cancel',
      cancel: () => s.locked ? this.signOutTrainer() : this.setState({ pinFor: null, pinVal: '', pinErr: false, pinMsg: null }) } : {};
    const meT = s.trainers.find(t => t.id === s.me);
    if (!meT) return { ...base, loading: false, signedOut: true, signedIn: false, trainerCards, sm: { open: false } };
    const mySign = allSign.filter(x => x.trainerId === meT.id).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const modBy = Object.fromEntries(d.modules.map(m => [m.code, m]));
    const openP = name => () => this.setState({ screen: 'roster', sel: name, mod: null, tab: 'modules' });
    const pRow = P => ({ name: P.r.name, initials: inits(P.r.name), position: P.r.position || (this.roleKey(P.r) !== P.r.position ? this.roleKey(P.r) : 'Position not set'), team: P.r.team, id: P.r.id, pctW: P.pct + '%', metLabel: P.req.length ? `${P.met}/${P.req.length}` : '—', open: openP(P.r.name) });
    const safeAll = people.map(P => this.safetyOf(P.r));
    const totReq = people.reduce((a, P) => a + P.req.length, 0), totMet = people.reduce((a, P) => a + P.met, 0), hp = totReq ? Math.round(totMet / totReq * 100) : 0;
    const home = {
      pct: hp, deg: hp * 3.6 + 'deg',
      tiles: [{ v: people.filter(P => P.r.status === 'In training').length, k: 'In training' }, { v: people.filter(P => P.qualified).length, k: 'Minimums met' }, { v: safeAll.reduce((a, x) => a + x.overdue + x.soon, 0), k: 'Refreshers overdue or due ≤30 days' }, { v: safeAll.filter(x => !x.orient).length, k: 'C-02 orientation outstanding' }],
      active: people.filter(P => P.r.status === 'In training' || P.r.status === 'Scheduled').sort((a, b) => b.pct - a.pct).map(pRow),
      teams: ['Team A', 'Team B', 'Team C', 'Team D'].map(t => { const xs = people.filter(P => P.r.team === t); const rq = xs.reduce((a, P) => a + P.req.length, 0), mt = xs.reduce((a, P) => a + P.met, 0), pct = rq ? Math.round(mt / rq * 100) : 0; return { name: t, shift: (xs[0]?.r.shift || '').split(' ')[0], pct, pctW: pct + '%', count: xs.length, open: () => this.setState({ screen: 'roster', filter: t }) }; })
    };
    const GAP_N = this.props.gapMinPeople ?? 3, GAP_P = (this.props.gapMinPct ?? 50) / 100;
    const gapsAll = [];
    [...new Set(people.map(P => P.r.team).filter(Boolean))].forEach(t => { const xs = people.filter(P => P.r.team === t);
      d.modules.forEach(m => { const need = xs.filter(P => (P.mins[m.code] || 0) > 0); if (!need.length) return; const below = need.filter(P => P.lv(m.code) < P.mins[m.code]);
        const n = below.length, share = n / need.length; if (n >= GAP_N && share >= GAP_P) gapsAll.push({ team: t, shift: (xs[0]?.r.shift || '').trim(), m, n, of: need.length, share, names: below.map(P => P.r.name), sev: share >= 0.75 || n >= GAP_N * 2 ? 'high' : 'med' }); }); });
    gapsAll.sort((a, b) => (b.sev === 'high') - (a.sev === 'high') || b.n - a.n || b.share - a.share);
    const gapKey = new Set(gapsAll.map(g => g.team + '|' + g.m.code));
    const tOrder = t => { const m = /^Team ([A-Z])$/.exec(t); return m ? m[1].charCodeAt(0) : 1000; };
    const teamNames = [...new Set(people.map(P => P.r.team).filter(Boolean))].sort((a, b) => tOrder(a) - tOrder(b) || a.localeCompare(b));
    const mTeam = teamNames.includes(s.mxTeam) ? s.mxTeam : teamNames[0], mSer = s.mxSeries || 'all';
    const mPeople = people.filter(P => P.r.team === mTeam);
    const serKeys = Object.keys(SERIES), shortSer = { 'C - Core (all personnel)': 'Core', 'L - Line track': 'Line', 'W - Winder track': 'Winder', 'LD - Leadership': 'Leadership', 'Q - Quality Control': 'QC' };
    const mCols = d.modules.filter(m => (mSer === 'all' || m.series === mSer) && mPeople.some(P => (P.mins[m.code] || 0) > 0));
    const LV = [['#fff', C.muted], ['oklch(0.93 0.035 165)', 'oklch(0.4 0.08 165)'], ['oklch(0.82 0.08 165)', 'oklch(0.3 0.08 165)'], [C.accent, '#fff'], ['oklch(0.36 0.09 165)', '#fff']];
    const byTeam = [...new Set(gapsAll.map(g => g.team))].map(t => { const gs = gapsAll.filter(g => g.team === t), xs = people.filter(P => P.r.team === t);
      const reqMods = d.modules.filter(m => xs.some(P => (P.mins[m.code] || 0) > 0)).length, high = gs.filter(g => g.sev === 'high').length, broad = reqMods > 0 && gs.length / reqMods >= 0.8;
      return { t, gs, high, broad, reqMods, shift: gs[0].shift, people: xs.length }; }).sort((a, b) => b.high - a.high || b.gs.length - a.gs.length);
    const alertTeams = byTeam.filter(T => T.high || T.broad), alertSig = alertTeams.map(T => T.t + ':' + T.gs.map(g => g.m.code + g.n).join(',')).join('|');
    const alertBar = { show: alertTeams.length > 0 && s.alertDismissed !== alertSig,
      title: alertTeams.length === 1 ? alertTeams[0].t + ' has a shared training gap' : alertTeams.length + ' teams have shared training gaps',
      sub: alertTeams.slice(0, 3).map(T => T.t + (T.broad ? ': training largely not started' : ': ' + T.gs[0].m.code + ' ' + T.gs[0].n + '/' + T.gs[0].of + (T.gs.length > 1 ? ' +' + (T.gs.length - 1) + ' more' : ''))).join(' · '),
      view: () => this.setState({ screen: 'home', mxTeam: alertTeams[0]?.t, mxSeries: 'all', mxFocus: alertTeams[0]?.gs[0].m.code, alertDismissed: alertSig }),
      dismiss: () => this.setState({ alertDismissed: alertSig }) };
    const gaps = { has: byTeam.length > 0, none: !byTeam.length, count: byTeam.length + ' team' + (byTeam.length === 1 ? '' : 's') + ' · ' + gapsAll.length + ' module gap' + (gapsAll.length === 1 ? '' : 's'),
      rule: 'Alert when ' + GAP_N + '+ people on a team, and at least ' + Math.round(GAP_P * 100) + '% of those who need it, are below minimum on the same module',
      list: byTeam.map(T => ({ team: T.t, shift: T.shift, dot: T.high ? C.red : 'oklch(0.75 0.13 75)', tag: T.broad ? 'Widespread' : T.high ? 'High' : 'Watch', tagBg: T.high || T.broad ? 'oklch(0.95 0.04 25)' : C.amber, tagInk: T.high || T.broad ? C.red : C.amberInk,
        headline: T.broad ? 'Training largely not started: ' + T.gs.length + ' of ' + T.reqMods + ' required modules below minimum for most of the team' : T.gs.length + ' shared gap' + (T.gs.length === 1 ? '' : 's') + ' across ' + T.people + ' people',
        rows: T.gs.slice(0, 3).map(g => ({ code: g.m.code, title: g.m.title, stat: g.n + '/' + g.of, bar: Math.round(g.share * 100) + '%', dot: g.sev === 'high' ? C.red : 'oklch(0.75 0.13 75)', go: () => this.setState({ mxTeam: T.t, mxSeries: 'all', mxFocus: g.m.code }) })),
        more: T.gs.length > 3 ? '+' + (T.gs.length - 3) + ' more in the matrix' : '', hasMore: T.gs.length > 3, open: () => this.setState({ mxTeam: T.t, mxSeries: 'all', mxFocus: T.gs[0].m.code }) })) };
    const mx = { has: mCols.length > 0 && mPeople.length > 0, empty: !mCols.length || !mPeople.length, gridCols: '170px repeat(' + mCols.length + ', 34px)',
      summary: (() => { const rq = mPeople.reduce((a, P) => a + P.req.length, 0), mt = mPeople.reduce((a, P) => a + P.met, 0); return mPeople.length + ' people · ' + (rq ? Math.round(mt / rq * 100) : 0) + '% of required modules at minimum'; })(),
      teams: teamNames.map(t => { const on = t === mTeam; return { name: t, count: people.filter(P => P.r.team === t).length, bg: on ? C.ink : '#fff', ink: on ? '#fff' : C.ink, border: on ? C.ink : C.border, alarm: gapsAll.filter(g => g.team === t).length, hasAlarm: gapsAll.some(g => g.team === t), pick: () => this.setState({ mxTeam: t, mxFocus: null }) }; }),
      series: [['all', 'All modules']].concat(serKeys.map(k => [k, shortSer[k] || SERIES[k]])).map(([k, label]) => { const on = k === mSer; return { label, bg: on ? C.soft : '#fff', ink: on ? C.softInk : C.muted, border: on ? C.accent : C.border, pick: () => this.setState({ mxSeries: k }) }; }),
      cols: mCols.map((m, i) => { const g = gapKey.has(mTeam + '|' + m.code), foc = s.mxFocus === m.code; const nb = mPeople.filter(P => (P.mins[m.code] || 0) > 0 && P.lv(m.code) < P.mins[m.code]).length;
        return { code: m.code, title: m.code + ' · ' + m.title + (nb ? ' · ' + nb + ' below minimum' : ''), headBg: foc ? 'oklch(0.92 0.06 25)' : g ? 'oklch(0.96 0.04 25)' : serKeys.indexOf(m.series) % 2 ? 'oklch(0.975 0.006 85)' : '#fff', badge: nb ? String(nb) : '', badgeBg: g ? C.red : 'oklch(0.9 0.01 85)', badgeInk: g ? '#fff' : C.muted }; }),
      rows: mPeople.map(P => ({ name: P.r.name, pos: P.r.position || '—', met: P.met + '/' + P.req.length, open: () => this.setState({ screen: 'roster', sel: P.r.name, mod: null, tab: 'modules' }),
        cells: mCols.map(m => { const min = P.mins[m.code] || 0, lv = P.lv(m.code), req = min > 0, [bg, ink] = req || lv ? LV[lv] : ['transparent', C.border2];
          return { t: req || lv ? String(lv) : '·', bg, ink, ring: req && lv < min ? '2px ' + C.red : req && lv === 0 ? '1px ' + C.border2 : '0 transparent', colBg: s.mxFocus === m.code ? 'oklch(0.97 0.03 25)' : gapKey.has(mTeam + '|' + m.code) ? 'oklch(0.985 0.015 25)' : serKeys.indexOf(m.series) % 2 ? 'oklch(0.985 0.004 85)' : 'transparent',
            tip: m.code + ' · Level ' + lv + (req ? ' of ' + min + ' required' : ' · not required'), go: () => this.setState(st => ({ screen: 'roster', sel: P.r.name, mod: null, tab: 'modules', open: { ...st.open, [m.code]: true } })) }; }) })),
      legend: [{ t: '0', bg: '#fff', ink: C.muted, ring: '1px ' + C.border2, label: 'Not trained' }, { t: '1', bg: LV[1][0], ink: LV[1][1], ring: '0 transparent', label: 'Aware' }, { t: '2', bg: LV[2][0], ink: LV[2][1], ring: '0 transparent', label: 'Assisted' }, { t: '3', bg: LV[3][0], ink: '#fff', ring: '0 transparent', label: 'Independent' }, { t: '4', bg: LV[4][0], ink: '#fff', ring: '0 transparent', label: 'Qualified to train' }, { t: '', bg: '#fff', ink: C.ink, ring: '2px ' + C.red, label: 'Below minimum' }, { t: '·', bg: 'transparent', ink: C.border2, ring: '0 transparent', label: 'Not required' }] };
    const q = s.q.trim().toLowerCase();
    const listed = people.filter(P => (s.filter === 'all' || P.r.team === s.filter) && (!q || P.r.name.toLowerCase().includes(q) || (P.r.id || '').toLowerCase().includes(q)));
    const filters = [['all', 'All'], ['Team A', 'A'], ['Team B', 'B'], ['Team C', 'C'], ['Team D', 'D']].map(([k, label]) => ({ label, bg: s.filter === k ? '#fff' : 'transparent', color: s.filter === k ? C.ink : C.muted, pick: () => this.setState({ filter: k }) }));
    const rows = listed.map(P => ({ ...pRow(P), bg: P.r.name === s.sel ? C.soft : 'transparent' }));
    const Pp = people.find(P => P.r.name === s.sel) || people[0], r = Pp.r, first = r.name.split(' ')[0];
    this._me = meT; this._gate = this.gateFor(meT, r);
    const groups = Object.keys(SERIES).map(ser => {
      const mods = Pp.req.filter(m => m.series === ser); if (!mods.length) return null;
      return { title: SERIES[ser], count: `${mods.filter(m => Pp.lv(m.code) >= Pp.mins[m.code]).length}/${mods.length}`, modules: mods.map(m => {
        const min = Pp.mins[m.code], cur = Pp.lv(m.code), met = cur >= min, isOpen = !!s.open[m.code], last = (Pp.rec[m.code] || [])[cur - 1];
        return { code: m.code, title: m.title, isOpen, chev: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          isExtra: Pp.extra.has(m.code), removeExtra: () => { this.setState(st => { const e = { ...(st.extra || {}) }, p = { ...(e[r.name] || {}) }; delete p[m.code]; e[r.name] = p; return { extra: e }; }); this.markDirty(); this.save({ op: 'extra', name: r.name, code: m.code, level: null }); this.flash(m.code + ' removed from ' + first + '’s plan. Signed levels are kept.'); },
          meta: `Level ${cur} · minimum ${min}` + (Pp.extra.has(m.code) ? ' · added outside track' : '') + (last && !last.imported ? ` · last signed ${last.date} by ${last.trainer}` : ''), metaColor: met ? C.link : C.muted,
          border: met ? 'oklch(0.8 0.07 165)' : C.border, boxBg: met ? C.accent : '#fff', boxBorder: met ? C.accent : C.border2, checkOp: met ? 1 : 0,
          pips: [1, 2, 3, 4].map(k => ({ bg: k <= cur ? C.accent : C.track, outline: k === min ? `1.5px solid ${C.link}` : 'none' })),
          toggleOpen: () => this.setState(st => ({ open: { ...st.open, [m.code]: !st.open[m.code] } })),
          openPage: () => this.setState({ mod: m.code, mtab: 'ov', sopSel: null, kcShow: false }), levels: isOpen ? this.levelsFor(Pp, m) : [] };
      }) };
    }).filter(Boolean);
    const below = Pp.req.filter(m => Pp.lv(m.code) < Pp.mins[m.code]);
    const P = { name: r.name, first: r.name.split(' ')[0], position: r.position || (this.roleKey(r) !== r.position ? this.roleKey(r) : 'Position not set'), team: r.team, shift: r.shift || '—', id: r.id, pct: Pp.pct, deg: Pp.pct * 3.6 + 'deg', ...this.chip(r.status, Pp.qualified),
      facts: [{ k: 'Required modules', v: `${Pp.met} of ${Pp.req.length} met` }, { k: 'Program entry', v: (r.needs || '—').replace('Yes - ', '') }, { k: 'Baseline assessed', v: fmtISO(r.baseline) }, { k: 'Target qualification', v: fmtISO(r.target) }],
      addOpts: [{ v: '', label: 'Choose a module…' }].concat(d.modules.filter(m => !(Pp.mins[m.code] > 0)).map(m => ({ v: m.code, label: m.code + ' · ' + m.title }))), addMod: s.addMod || '', addLvl: String(s.addLvl || 3),
      lvlOpts: [1, 2, 3, 4].map(k => ({ v: String(k), label: 'Level ' + k + ' · ' + SCALE[k] })), addBtnBg2: s.addMod ? C.ink : C.border2,
      onAddMod: e => this.setState({ addMod: e.target.value }), onAddLvl: e => this.setState({ addLvl: +e.target.value }),
      doAddMod: () => { const c = s.addMod; if (!c) return this.flash('Choose a module first'); const l = s.addLvl || 3; this.setState(st => { const e = { ...(st.extra || {}) }; e[r.name] = { ...(e[r.name] || {}), [c]: l }; return { extra: e, addMod: '', open: { ...st.open, [c]: true } }; }); this.markDirty(); this.save({ op: 'extra', name: r.name, code: c, level: l }); this.flash(c + ' added to ' + first + '’s plan at Level ' + l); },
      nextPos: NEXT_POS[r.position] || '', hasNext: Pp.qualified && !!NEXT_POS[r.position] && !!d.reqMin[NEXT_POS[r.position]],
      nextLabel: 'Proceed to ' + (NEXT_POS[r.position] || '') + ' track', nextSub: NEXT_POS[r.position] ? (() => { const nP = this.person({ ...r, position: NEXT_POS[r.position] }); return (nP.req.length - nP.met) + ' of ' + nP.req.length + ' ' + NEXT_POS[r.position] + ' modules still to sign · signed levels carry over'; })() : '',
      promoAsk: s.promoFor === r.name, askPromo: () => this.setState({ promoFor: r.name }), cancelPromo: () => this.setState({ promoFor: null }),
      doPromo: () => { const to = NEXT_POS[r.position], date = new Date().toISOString().slice(0, 10), base = s.data.roster.find(x => x.name === r.name);
        this.setState(st => ({ promoFor: null, posOv: { ...(st.posOv || {}), [r.name]: { from: base ? base.position : r.position, to, date, by: meT.name } }, todos: [{ id: 'p' + Date.now(), text: 'Update ' + r.name + ' to ' + to + ' on the paper qualification card', done: false }, ...(st.todos || [])] }));
        this.markDirty(); this.save({ op: 'position', name: r.name, to });
        this.flash(r.name.split(' ')[0] + ' is now on the ' + to + ' track'); },
      groups, noPosition: !Pp.req.length, qualified: Pp.qualified, notQualified: !Pp.qualified && Pp.req.length > 0, reqCount: Pp.req.length, belowCount: below.length,
      below: below.map(m => ({ code: m.code, title: m.title, meta: `Level ${Pp.lv(m.code)} of ${Pp.mins[m.code]} required`, go: () => this.setState(st => ({ tab: 'modules', open: { ...st.open, [m.code]: true } })) })) };
    const lib = s.lib || { guides: {}, sops: {}, moduleSops: {}, levelTable: [] };
    let mp = { code: '', title: '', series: '', guideNo: '', facts: [], tabs: [], levels: [], mustSay: [], objectives: [], meta: [], sopChips: [], sop: { ppe: [], parts: [] }, ck: [], crit: [], signOff: [], photo0: 'x0', photo1: 'x1', photo2: 'x2', pend0: 'p0', pend1: 'p1', pend2: 'p2' };
    if (s.mod && modBy[s.mod]) {
      const m = modBy[s.mod], g = lib.guides[m.code], ms = lib.moduleSops[m.code] || { available: [], missing: [] }, min = Pp.mins[m.code] || 0;
      const sopNo = ms.available.includes(s.sopSel) ? s.sopSel : ms.available[0], so = sopNo ? lib.sops[sopNo] : null;
      const ckState = (s.checks[r.name] || {})[m.code] || {}, ckItems = g ? g.checklist : [], ckDone = ckItems.filter(c => ckState[c.n]).length, allMet = ckItems.length > 0 && ckDone === ckItems.length;
      const K = (lib.kc || {})[m.code], kAns = (s.kcAns[r.name] || {})[m.code] || {}, kAtt = (s.kcAtt[r.name] || {})[m.code] || [];
      const setAns = (n, v) => { this.save({ op: 'kcAns', name: r.name, code: m.code, n, value: kAns[n] === v ? null : v }); this.setState(st => { const pn = { ...(st.kcAns[r.name] || {}) }, c = { ...(pn[m.code] || {}) }; c[n] = c[n] === v ? undefined : v; pn[m.code] = c; return { kcAns: { ...st.kcAns, [r.name]: pn } }; }); };
      const kRight = q => K.type === 'written' ? !!kAns[q.n] && kAns[q.n] === q.correct : kAns[q.n] === 'ok';
      const kTot = K ? K.questions.length : 0, kDone = K ? K.questions.filter(q => kAns[q.n]).length : 0, kScore = K ? K.questions.filter(kRight).length : 0, kPass = !!K && kScore >= K.pass, kShow = !!s.kcShow;
      const kBest = kAtt.find(a => a.pass), kcBadge = kBest ? '✓' : kAtt.length ? kAtt[kAtt.length - 1].score + '/' + kAtt[kAtt.length - 1].total : '';
      const tabDefs = [['ov', 'Overview', ''], ['sop', 'SOP', ms.available.length ? String(ms.available.length) : ''], ['ck', 'Checklist', ckItems.length ? ckDone + '/' + ckItems.length : ''], ['kc', 'Knowledge check', kcBadge], ['sg', 'Sign-off', 'L' + Pp.lv(m.code) + '/' + min]];
      const gNames = { QCTRN: 'QC Technician Trainer Guide', CDGTRN0005: 'CDGTRN0005 Line Series Guide', CDGTRN0004: 'CDGTRN0004 Core Series Guide', CDGTRN0006: 'CDGTRN0006 Winder Series Guide', CDGTRN0007: 'CDGTRN0007 Leadership Series Guide' };
      const blocks = p => p.blocks.map(b => ({ isSub: b.k === 'sub', isStep: b.k === 'step', isCaution: b.k === 'caution', isNote: b.k === 'note', isTable: b.k === 'table', isBlank: !!b.blank, text: b.text || '', n: b.n || '', subs: (b.subs || []).map(t => ({ text: t })), caption: b.caption || 'Table',
        cols: b.rows ? 'repeat(' + Math.max(...b.rows.map(x => x.length)) + ', minmax(0,1fr))' : '1fr', rows: (b.rows || []).map((x, i) => ({ cells: x.map(t => ({ text: t })), bg: i === 0 ? 'oklch(0.965 0.006 85)' : '#fff', w: i === 0 ? 600 : 400 })) }));
      const toggleCk = n => () => { this.save({ op: 'check', name: r.name, code: m.code, n, value: !ckState[n] }); this.setState(st => { const pn = { ...(st.checks[r.name] || {}) }, c = { ...(pn[m.code] || {}) }; c[n] = !c[n]; pn[m.code] = c; return { checks: { ...st.checks, [r.name]: pn } }; }); };
      mp = { mustLabel: g?.labels?.must || 'Must say to every trainee', objLabel: g?.labels?.obj || 'Learning objectives', hasWatch: !!(g?.watch || []).length, watch: (g?.watch || []).map(t => ({ text: t })),
        code: m.code, title: m.title, series: SERIES[m.series], guideNo: g ? gNames[g.guide] : 'Trainer guide not uploaded',
        facts: [{ k: 'Delivery', v: m.method || '—' }, { k: 'Target hours', v: m.hours ? m.hours + ' h' : '—' }, { k: 'Minimum · ' + r.position, v: 'Level ' + min + ' · ' + SCALE[min] }, { k: 'Knowledge check', v: g && g.check ? g.check[0].toUpperCase() + g.check.slice(1) : '—' }],
        tabs: tabDefs.map(([k, label, count]) => ({ label, count, bg: s.mtab === k ? '#fff' : 'transparent', color: s.mtab === k ? C.ink : C.muted, go: () => this.setState({ mtab: k, kcShow: false }) })),
        isOv: s.mtab === 'ov', isSop: s.mtab === 'sop', isCk: s.mtab === 'ck', isSg: s.mtab === 'sg',
        hasGuide: !!g, noGuide: !g, purpose: g?.purpose || '', mustSay: (g?.mustSay || []).map(t => ({ text: t })), objectives: (g?.objectives || []).map((t, i) => ({ n: i + 1, text: t })),
        meta: g ? ['Audience', 'Prerequisites', 'Who May Deliver', 'Location'].filter(k => g.meta[k]).map(k => ({ k, v: g.meta[k] })).concat(g.sources.length ? [{ k: 'Source documents', v: g.sources.join(' · ') }] : []) : [],
        photo0: 'mod-' + m.code + '-0', photo1: 'mod-' + m.code + '-1', photo2: 'mod-' + m.code + '-2', pend0: 'sop-pend-' + m.code + '-0', pend1: 'sop-pend-' + m.code + '-1', pend2: 'sop-pend-' + m.code + '-2',
        hasSop: !!so, noSop: !so, hasMissing: ms.missing.length > 0, missing: ms.missing.join(', '),
        sopChips: ms.available.map(no => ({ no, title: lib.sops[no].title, bg: no === sopNo ? C.soft : '#fff', border: no === sopNo ? C.accent : C.border, pick: () => this.setState({ sopSel: no }) })),
        sop: so ? { no: so.no, title: so.title, purpose: so.purpose, scope: so.scope, ppe: so.ppe.map(t => ({ text: t })), photoId: 'sop-' + so.no + '-hero', parts: so.parts.map(p => ({ title: p.title, blocks: blocks(p) })) } : { ppe: [], parts: [] },
        hasCk: ckItems.length > 0, ckIntro: g ? g.checklistIntro || '' : 'The practical checklist will load once this series’ trainer guide is uploaded.', ckCount: ckDone + ' of ' + ckItems.length + ' met',
        ck: ckItems.map(c => { const d = !!ckState[c.n]; return { n: c.n, task: c.task, standard: c.standard, boxBg: d ? C.accent : '#fff', boxBorder: d ? C.accent : C.border2, op: d ? 1 : 0, toggle: toggleCk(c.n) }; }),
        resText: allMet ? 'All steps met: Level 3 may be signed' : (g?.result || 'Check each step as the trainee performs it to standard.'), resBg: allMet ? C.soft : 'oklch(0.955 0.006 85)', resInk: allMet ? C.softInk : C.muted,
        crit: (lib.levelTable || []).slice(1).map(x => ({ lvl: x[0], name: x[1], when: x[2], tag: +x[0] === min ? 'Minimum for ' + r.position : '', bg: +x[0] === min ? 'oklch(0.97 0.025 165)' : '#fff' })),
        signOff: (g?.signOff || []).map(t => ({ text: t })), levels: this.levelsFor(Pp, m),
        isKc: s.mtab === 'kc', hasKc: !!K, noKc: !K,
        kcLabel: K ? (K.type === 'written' ? 'Written' : 'Oral') + ' · ' + kTot + ' questions · pass ' + K.pass + '/' + kTot : '',
        kcHint: !K ? '' : K.type === 'written' ? (kShow ? 'Answer key showing. Correct answers are green and wrong picks are red.' : 'Hand the tablet to the trainee to pick answers, then show the key to grade.') : 'Ask each question aloud and mark the response. Show the key for the acceptable answers.',
        kcKeyLabel: kShow ? 'Hide answer key' : 'Show answer key · trainer only', kcKeyBg: kShow ? C.ink : '#fff', kcKeyInk: kShow ? '#fff' : C.ink, kcKeyBorder: kShow ? C.ink : C.border2,
        kcToggle: () => this.setState(st => ({ kcShow: !st.kcShow })),
        kcWarn: kAtt.filter(a => !a.pass).length >= 2 && !kBest,
        kcq: K ? K.questions.map(q => { const a = kAns[q.n];
          return { n: q.n, q: q.q, answer: q.answer, ref: q.ref ? 'Ref: ' + q.ref : '', isW: K.type === 'written' && q.options.length > 0, isO: K.type === 'oral' || !q.options.length, showKey: kShow, keyLabel: K.type === 'written' ? 'Correct answer' : 'Acceptable answer',
            opts: q.options.map(o => { const sel = a === o.l, cor = o.l === q.correct;
              return { l: o.l, t: o.t, bg: kShow && cor ? C.soft : sel ? (kShow ? 'oklch(0.95 0.04 25)' : 'oklch(0.95 0.02 250)') : '#fff', border: kShow && cor ? C.accent : sel ? (kShow ? C.red : 'oklch(0.55 0.13 250)') : C.border,
                tag: kShow && cor ? 'Correct' : kShow && sel ? 'Picked' : sel ? 'Picked' : '', tagInk: kShow && cor ? C.link : kShow && sel ? C.red : 'oklch(0.5 0.12 250)', pick: () => setAns(q.n, o.l) }; }),
            okBg: a === 'ok' ? C.accent : '#fff', okInk: a === 'ok' ? '#fff' : C.ink, noBg: a === 'no' ? C.red : '#fff', noInk: a === 'no' ? '#fff' : C.ink, markOk: () => setAns(q.n, 'ok'), markNo: () => setAns(q.n, 'no') }; }) : [],
        kcScore: !K ? '' : K.type === 'written' && !kShow ? 'Answered ' + kDone + ' of ' + kTot : 'Score ' + kScore + ' / ' + kTot,
        kcChip: !K ? '' : kDone < kTot ? (kTot - kDone) + ' to go' : kPass ? 'Pass' : 'Below ' + K.pass, kcChipBg: kDone < kTot ? C.gray : kPass ? C.accent : C.red, kcChipInk: kDone < kTot ? C.muted : '#fff',
        kcRecBg: K && kDone === kTot ? C.ink : C.border2, kcRecCursor: K && kDone === kTot ? 'pointer' : 'not-allowed',
        kcReset: () => { this.save({ op: 'kcReset', name: r.name, code: m.code }); this.setState(st => { const pn = { ...(st.kcAns[r.name] || {}) }; delete pn[m.code]; return { kcAns: { ...st.kcAns, [r.name]: pn }, kcShow: false }; }); },
        kcRecord: () => { if (!K || kDone < kTot) return this.flash('Mark every question first');
          const att = { score: kScore, total: kTot, pass: kPass, by: meT.name, date: fmt(new Date()) };
          this.save({ op: 'kcAttempt', name: r.name, code: m.code, score: kScore, total: kTot, pass: kPass });
          this.setState(st => { const pa = { ...(st.kcAtt[r.name] || {}) }; pa[m.code] = [...(pa[m.code] || []), att]; const pn = { ...(st.kcAns[r.name] || {}) }; delete pn[m.code]; return { kcAtt: { ...st.kcAtt, [r.name]: pa }, kcAns: { ...st.kcAns, [r.name]: pn }, kcShow: false }; });
          this.flash(m.code + ' knowledge check: ' + kScore + '/' + kTot + (kPass ? ' · Pass' : ' · retrain missed points and retest')); },
        kcHasAtt: kAtt.length > 0, kcAtts: kAtt.map((x, i) => ({ n: i + 1, score: x.score + ' / ' + x.total, res: x.pass ? 'Pass' : 'Not yet', bg: x.pass ? C.soft : 'oklch(0.95 0.04 25)', ink: x.pass ? C.softInk : C.red, by: x.by, date: x.date })) };
    }
    let sm = { open: false };
    if (s.sign) { const m = modBy[s.sign.code], L4 = s.sign.level === 4, pi = this.pad('i'), ps = this.pad('s');
      const coords = s.trainers.filter(t => t.coordinator && t.id !== meT.id), coT = coords.find(t => t.id === s.coWho);
      const selfCo = L4 && !!meT.coordinator;
      const coOk = !L4 || selfCo || (coT && s.coPin.length === 4 && s.ink.c), ok = s.ink.s && coOk && !s.signBusy;
      const coHint = !L4 || selfCo ? '' : !coT ? 'Coordinator countersign required' : s.coPin.length < 4 ? 'Coordinator PIN required' : !s.ink.c ? 'Coordinator signature required' : '';
      base.padC = this.pad('c');
      const curLv = ((s.records[s.sign.name] || {})[s.sign.code] || []).length, fillN = Math.max(0, s.sign.level - 1 - curLv);
      sm = { hasFill: fillN > 0, fillNote: fillN ? (fillN === 1 ? 'Level ' + (curLv + 1) + ' is' : 'Levels ' + (curLv + 1) + '–' + (s.sign.level - 1) + ' are') + ' not signed yet. Signing Level ' + s.sign.level + ' records ' + (fillN === 1 ? 'it' : 'them') + ' too, with this signature and today’s date.' : '', open: true, coords: coords.map(t => ({ name: t.name, bg: s.coWho === t.id ? C.soft : '#fff', border: s.coWho === t.id ? C.accent : C.border, pick: () => this.setState({ coWho: t.id, coPin: '' }) })),
        selfCo, needCo: L4 && !selfCo, selfName: meT.name, noCoords: L4 && !selfCo && !coords.length, coPin: s.coPin, onCoPin: e => this.setState({ coPin: e.target.value.replace(/\D/g, '').slice(0, 4) }),
        coPinBorder: coT && s.coPin.length === 4 ? C.accent : C.border2, cBorder: s.ink.c ? C.accent : C.border2, coName: coT ? coT.name : 'Select a coordinator', code: m.code, title: m.title, level: s.sign.level, levelName: SCALE[s.sign.level], isL4: s.sign.level === 4, trainee: s.sign.name, trainer: meT.name, date: fmt(new Date()),
        iBorder: s.ink.i ? C.accent : C.border2, sBorder: s.ink.s ? C.accent : C.border2,
        hint: s.signBusy ? 'Saving…' : ok ? '' : !s.ink.s ? 'Trainer signature required' : coHint,
        btnBg: ok ? C.accent : C.border2, cursor: ok ? 'pointer' : 'not-allowed',
        cancel: () => !s.signBusy && this.setState({ sign: null }),
        // Saved on the server first (it re-checks who may sign, and the coordinator's PIN); then shown.
        confirm: async () => { if (!ok) return; const sig = this.pads.s.ref.current.toDataURL('image/png'), sg = s.sign, csig0 = L4 && !selfCo ? this.pads.c.ref.current.toDataURL('image/png') : null;
          this.setState({ signBusy: true });
          const done = await this.save({ op: 'sign', name: sg.name, code: sg.code, level: sg.level, sig, ...(csig0 ? { coordinatorId: coT.id, coPin: s.coPin, csig: csig0 } : {}) });
          this.setState({ signBusy: false }); if (!done) { if (csig0) this.setState({ coPin: '' }); return; }
          this.setRecords(sg.name, sg.code, a => [...a.slice(0, sg.level - 1), ...Array.from({ length: Math.max(0, sg.level - 1 - a.length) }, (_, i) => ({ level: a.length + i + 1, trainer: meT.name, trainerId: meT.id, date: fmt(new Date()), ts: Date.now(), sig, filled: sg.level })), { level: sg.level, trainer: meT.name, trainerId: meT.id, date: fmt(new Date()), ts: Date.now(), sig, ...(L4 ? (selfCo ? { coordinator: meT.name, coordinatorId: meT.id, csig: sig } : { coordinator: coT.name, coordinatorId: coT.id, csig: csig0 }) : {}) }]);
          const nowMet = sg.level === (Pp.mins[sg.code] || 0);
          this.markDirty(); this.setState({ sign: null }); this.flash(nowMet ? `${sg.code} at minimum — module checked for ${sg.name.split(' ')[0]}` : `${sg.code} Level ${sg.level} signed for ${sg.name.split(' ')[0]}`); } };
      base.padI = pi; base.padS = ps; }
    const SF = this.safetyOf(r), chipFor = st => ({ over: ['Overdue', C.red, '#fff'], soon: ['Due ≤30 days', C.amber, C.amberInk], ok: ['Current', C.soft, C.softInk], none: ['Not recorded', C.gray, C.muted] })[st];
    const sf = { hasOrient: !!SF.orient, noOrient: !SF.orient, hasWarn: SF.overdue > 0, warn: SF.overdue ? SF.overdue + ' refresher' + (SF.overdue > 1 ? 's' : '') + ' overdue. Level sign-offs are blocked until current.' : '',
      orient: SF.orient ? [{ k: 'C-02 orientation date', v: fmtISO(SF.orient.date) }, { k: 'Delivered by', v: SF.orient.by || '—' }, { k: 'Card 1.1 topics complete', v: SF.orient.topics || '—' }, { k: 'Card 1.2 acknowledgments', v: SF.orient.acks || '—' }, { k: 'Coordinator verified', v: SF.orient.verified || '—' }, { k: 'Next review due', v: fmtISO(SF.orient.nextReview) }] : [],
      canVerify: !!SF.orient && SF.orient.verified !== 'Yes' && !!meT.coordinator,
      recordOrient: () => { const t = todayIso(); this.markDirty(); this.save({ op: 'orient', name: r.name }); this.setState(st => ({ orient: { ...st.orient, [r.name]: { date: t, by: meT.name, topics: 'Yes', acks: 'Yes', verified: meT.coordinator ? 'Yes' : 'Pending', nextReview: addYear(t) } } })); this.flash('C-02 orientation recorded for ' + first); },
      verify: () => { this.markDirty(); this.save({ op: 'orientVerify', name: r.name }); this.setState(st => ({ orient: { ...st.orient, [r.name]: { ...SF.orient, verified: 'Yes' } } })); this.flash('Orientation verified for ' + first); },
      rows: SF.list.map(x => { const [chip, bg, ink] = chipFor(x.st); return { label: x.label, last: x.last ? fmtISO(x.last) : '—', due: x.due ? fmtISO(x.due) : '—', chip, bg, ink,
        record: () => { this.markDirty(); this.save({ op: 'refresher', name: r.name, key: x.k }); this.setState(st => ({ refresh: { ...st.refresh, [r.name]: { ...(st.refresh[r.name] || {}), [x.k]: todayIso() } } })); this.flash(x.label.split(' ·')[0] + ' recorded for ' + first); } }; }) };
    const ws = window.CDGSync ? CDGSync.status() : { state: 'off', msg: 'Sync unavailable', pending: 0 };
    const wc = { off: ['Not set up', C.gray, C.muted, 'oklch(0.75 0.01 85)', 'Sync not set up'], signin: ['Sign-in needed', C.amber, C.amberInk, 'oklch(0.75 0.13 75)', 'Sign in'], syncing: ['Saving…', C.soft, C.softInk, C.accent, ws.pending + ' sending'], signingin: ['Signing in…', C.amber, C.amberInk, 'oklch(0.75 0.13 75)', 'Signing in'], ok: ['Connected', C.soft, C.softInk, C.accent, 'Saved'], error: ['Error', C.red, '#fff', C.red, 'Retrying'] }[ws.state] || ['—', C.gray, C.muted, C.border2, ''];
    const wb = { chip: wc[0], chipBg: wc[1], chipInk: wc[2], dot: wc[3], rail: ws.pending && ws.state !== 'syncing' ? ws.pending + ' waiting' : wc[4],
      detail: [ws.account ? 'Signed in as ' + ws.account : '', ws.file ? 'File: ' + ws.file : '', ws.pending ? ws.pending + ' change' + (ws.pending > 1 ? 's' : '') + ' waiting' : '', ws.msg, ws.last ? 'Last sync ' + ws.last.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''].filter(Boolean).join(' · '),
      open: () => { this.setState({ screen: 'profile' }); if (ws.state === 'off') this.flash(meT.coordinator ? 'Enter the IDs from IT under Workbook sync, then tap Save settings' : 'The Training & Safety Coordinator needs to set up workbook sync'); },
      showSignIn: ws.configured && !ws.signedIn, signedIn: !!ws.signedIn, cfgOpen: !ws.configured || !!s.wbCfgOpen, cfgLabel: !ws.configured ? 'Connection settings' : s.wbCfgOpen ? 'Hide connection settings' : 'Connection settings', toggleCfg: () => this.setState(st => ({ wbCfgOpen: !st.wbCfgOpen })), redirect: window.CDGSync && CDGSync.redirectUri ? CDGSync.redirectUri() : location.origin + '/auth.html',
      canEdit: !!meT.coordinator, client: s.wbClient, tenant: s.wbTenant, link: s.wbLink,
      onClient: e => this.setState({ wbClient: e.target.value }), onTenant: e => this.setState({ wbTenant: e.target.value }), onLink: e => this.setState({ wbLink: e.target.value }),
      save: async () => { if (!window.CDGSync) return; const c = { clientId: s.wbClient, tenantId: s.wbTenant, link: s.wbLink }, bad = CDGSync.checkConfig(c); if (bad.length) return this.flash(bad[0]); if (await this.save({ op: 'wbConfig', ...c })) this.flash('Settings saved. Now tap Sign in with Microsoft'); },
      signIn: () => {
        if (!window.CDGSync) return this.flash('Sync library didn’t load. Reload the page');
        const c = CDGSync.config();
        if (c.clientId !== s.wbClient.trim() || c.tenantId !== s.wbTenant.trim() || c.link !== s.wbLink.trim()) return this.flash('Tap Save settings first');
        CDGSync.signIn().then(n => n && this.flash('Signed in as ' + n)).catch(e => this.flash(String(e.message || e).slice(0, 90)));
      }, signOut: () => window.CDGSync && CDGSync.signOut(), retry: () => window.CDGSync && CDGSync.retry(), pull: () => this.pullWorkbook(true),
      test: async () => { try { const n = await CDGSync.test(); this.flash('Connected to ' + n); } catch (e) { this.flash('Test failed: ' + String(e.message || e).slice(0, 70)); } } };
    const LOOK = ['CDGSOP0011', 'CDGSOP0013', 'CDGSOP0014'], allSops = Object.values(lib.sops || {}).sort((x, y) => x.no.localeCompare(y.no));
    const usedBy = no => Object.entries(lib.moduleSops || {}).filter(([c, v]) => v.available.includes(no) && modBy[c]).map(([c]) => c);
    const refNo = s.refSel && lib.sops[s.refSel] ? s.refSel : 'CDGSOP0011', rq = (s.refQ || '').toLowerCase(), filt = so => !rq || (so.no + ' ' + so.title).toLowerCase().includes(rq);
    const mkRef = so => { const u = usedBy(so.no); return { no: so.no, title: so.title, mods: u.length ? 'Used in ' + u.slice(0, 5).join(' · ') + (u.length > 5 ? ' +' + (u.length - 5) : '') : 'Not linked to a module', bg: so.no === refNo ? C.soft : 'transparent', pick: () => this.setState({ refSel: so.no }) }; };
    const ref = { look: allSops.filter(so => LOOK.includes(so.no) && filt(so)).map(mkRef), all: allSops.filter(so => !LOOK.includes(so.no) && filt(so)).map(mkRef), q: s.refQ, onQ: e => this.setState({ refQ: e.target.value }), count: allSops.length + ' SOPs' };
    const rsU = usedBy(refNo);
    const rs = { ...this.sopView(lib.sops[refNo]), used: rsU.map(c => ({ code: c, title: modBy[c].title })), hasUsed: rsU.length > 0 };
    const DOT = { red: C.red, amber: 'oklch(0.75 0.13 75)', gray: C.border2 };
    const auto = [];
    if (meT.coordinator) byTeam.filter(T => T.high || T.broad).forEach(T => { const top = T.gs[0]; auto.push({ text: T.t + ': ' + (T.broad ? 'training largely not started (' + T.gs.length + ' modules)' : T.gs.length + ' shared module gap' + (T.gs.length > 1 ? 's' : '')), sub: 'Biggest: ' + top.m.code + ' · ' + top.n + ' of ' + top.of + ' below minimum', tone: 'red', kind: 'Team gap', go: () => this.setState({ screen: 'home', mxTeam: T.t, mxSeries: 'all', mxFocus: top.m.code }) }); });
    if (meT.coordinator) {
      const goP = name => () => this.setState({ screen: 'roster', sel: name, mod: null, tab: 'safety' });
      if (ws.state === 'signin' && ws.configured) auto.push({ text: 'Sign in to Microsoft to resume workbook sync', sub: ws.pending ? ws.pending + ' changes waiting' : 'Workbook updates are paused', tone: 'red', kind: 'Sync', go: () => this.setState({ screen: 'profile' }) });
      else if (ws.pending && ws.state !== 'syncing') auto.push({ text: ws.pending + ' change' + (ws.pending > 1 ? 's' : '') + ' not yet in the workbook', sub: ws.msg, tone: ws.state === 'error' ? 'red' : 'amber', kind: 'Sync', go: () => window.CDGSync && CDGSync.retry() });
      people.forEach((P, i) => { const sa = safeAll[i];
        if (sa.orient && sa.orient.verified !== 'Yes') auto.push({ text: 'Verify C-02 orientation for ' + P.r.name, sub: 'Recorded ' + fmtISO(sa.orient.date) + (sa.orient.by ? ' by ' + sa.orient.by : ''), tone: 'amber', kind: 'Safety', go: goP(P.r.name) });
        sa.list.filter(x => x.st === 'over' || x.st === 'soon').forEach(x => auto.push({ text: x.label.split(' ·')[0] + (x.st === 'over' ? ' overdue: ' : ' due soon: ') + P.r.name, sub: 'Due ' + fmtISO(x.due), tone: x.st === 'over' ? 'red' : 'amber', kind: 'Refresher', go: goP(P.r.name) })); });
      const noC02 = people.filter((P, i) => !safeAll[i].orient);
      if (noC02.length) auto.push({ text: noC02.length + ' people have no C-02 orientation recorded', sub: noC02.slice(0, 4).map(P => P.r.name).join(', ') + (noC02.length > 4 ? ' …' : ''), tone: 'gray', kind: 'Safety', go: goP(noC02[0].r.name) });
      (lib.gaps || []).forEach(g => auto.push({ text: g.no + ' ' + g.title + ': ' + g.caption, sub: g.rows.join(' · '), tone: 'gray', kind: 'SOP gap', go: () => this.setState({ screen: 'ref', refSel: g.no }) }));
      const missing = [...new Set(Object.values(lib.moduleSops || {}).flatMap(v => v.missing))].sort();
      if (missing.length) auto.push({ text: 'Upload ' + missing.join(', '), sub: 'Referenced by the trainer guides but not in the app yet', tone: 'gray', kind: 'SOP', go: () => {} });
    }
    if (meT.coordinator && s.fileDirty && !ws.signedIn) auto.unshift({ text: s.fileDirty + ' change' + (s.fileDirty > 1 ? 's' : '') + ' not yet saved to the workbook file', sub: 'Profile → Save updates file, then run the import macro in Excel', tone: 'amber', kind: 'Workbook', go: () => this.setState({ screen: 'profile' }) });
    const addTodo = () => { const t = (s.todoText || '').trim(); if (!t) return; this.save({ op: 'todoAdd', text: t }); this.setState(st => ({ todoText: '', todos: [{ id: Date.now().toString(36), text: t, done: false, at: fmt(new Date()), by: meT.name }, ...st.todos] })); };
    const hidSet = new Set(s.todoHidden || []), autoV = auto.filter(x => !hidSet.has(x.text)), hiddenN = auto.length - autoV.length;
    const todo = { show: !!meT.coordinator, text: s.todoText, onText: e => this.setState({ todoText: e.target.value }), onKey: e => { if (e.key === 'Enter') addTodo(); }, add: addTodo,
      manual: s.todos.map(t => ({ text: t.text, meta: (t.done ? 'Done · ' : 'Added ') + t.at, bg: t.done ? C.accent : '#fff', border: t.done ? C.accent : C.border2, op: t.done ? 1 : 0, deco: t.done ? 'line-through' : 'none', color: t.done ? C.muted : C.ink,
        toggle: () => { this.save({ op: 'todoToggle', id: t.id }); this.setState(st => ({ todos: st.todos.map(x => x.id === t.id ? { ...x, done: !x.done } : x) })); }, del: () => { this.save({ op: 'todoDel', id: t.id }); this.setState(st => ({ todos: st.todos.filter(x => x.id !== t.id) })); } })),
      auto: autoV.map(x => ({ ...x, dot: DOT[x.tone], remove: () => { this.setState(st => ({ todoHidden: [...(st.todoHidden || []), x.text].slice(-200) })); this.flash('Removed. It comes back if the details change.'); } })), none: !autoV.length && !s.todos.length,
      hasHidden: hiddenN > 0, hiddenLabel: 'Show ' + hiddenN + ' removed item' + (hiddenN > 1 ? 's' : ''), restore: () => this.setState({ todoHidden: [] }),
      hasDone: s.todos.some(t => t.done), clearDone: () => { this.save({ op: 'todoClearDone' }); this.setState(st => ({ todos: st.todos.filter(t => !t.done) })); },
      count: (s.todos.filter(t => !t.done).length + autoV.length) + ' open' };
    const snapshot = () => { const refr = {}, ori = {};
      d.roster.forEach(x => { const b0 = (d.refreshers || {})[x.name] || {}, o0 = s.refresh[x.name] || {}; const m = { ...b0, ...o0 }; delete m.handbook; if (Object.keys(m).length) refr[x.name] = m; const so0 = s.orient[x.name] || (d.safety || {})[x.name]; if (so0) ori[x.name] = so0; });
      const known = new Set(d.modules.map(m => m.code)); const recs = Object.fromEntries(Object.entries(s.records).map(([n, mm]) => [n, Object.fromEntries(Object.entries(mm).filter(([c]) => known.has(c)))]));
      return CDGFile.csv({ extra: s.extra, oldNums: this._wbOld ?? s.wbOld ?? true, records: recs, refreshers: refr, orient: ori }); };
    const dirty = s.fileDirty || 0;
    const fb = { canEdit: !!meT.coordinator, inputRef: this.fileRef,
      chip: dirty ? dirty + ' unsaved' : s.lastSaved ? 'Up to date' : 'Not saved yet', chipBg: dirty ? C.amber : s.lastSaved ? C.soft : C.gray, chipInk: dirty ? C.amberInk : s.lastSaved ? C.softInk : C.muted,
      dot: dirty ? 'oklch(0.75 0.13 75)' : s.lastSaved ? C.accent : C.border2, rail: dirty ? dirty + ' unsaved' : s.lastSaved ? 'Saved' : 'Not saved',
      detail: [dirty ? dirty + ' change' + (dirty > 1 ? 's' : '') + ' since the last updates file' : 'No changes since the last updates file', s.lastSaved ? 'Saved ' + s.lastSaved : '', s.lastLoaded ? 'Workbook loaded ' + s.lastLoaded : 'Workbook not loaded yet'].filter(Boolean).join(' · '),
      open: () => this.setState({ screen: 'profile' }),
      save: async () => {
        if (!window.CDGFile) return this.flash('File tools didn’t load. Reload the page');
        const name = 'CDG_Tablet_Updates.csv', file = new File([snapshot()], name, { type: 'text/csv' });
        const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        try {
          if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: name });
          else { const u = URL.createObjectURL(file), el = document.createElement('a'); el.href = u; el.download = name; document.body.appendChild(el); el.click(); el.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); }
          this.save({ op: 'fileSaved', stamp }); this.setState({ fileDirty: 0, lastSaved: stamp }); this.flash('Updates file ready. Save it to OneDrive → CDG Training Updates');
        } catch (e) { if (e && e.name !== 'AbortError') this.flash('Couldn’t save: ' + String(e.message || e).slice(0, 60)); }
      },
      pick: () => this.fileRef.current && this.fileRef.current.click(),
      onFile: async e => { const fl = e.target.files && e.target.files[0]; e.target.value = ''; if (!fl) return;
        try { const wb = await CDGFile.parse(await fl.arrayBuffer()); this.mergeWorkbook(wb);
          this.setState({ lastLoaded: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) });
          this.flash('Loaded ' + fl.name + ': ' + wb.roster.length + ' people'); }
        catch (err) { this.flash('Couldn’t read the workbook: ' + String(err.message || err).slice(0, 70)); } } };
    fb.show = !ws.signedIn;
    const rail = ws.configured ? { open: () => this.setState({ screen: 'profile' }), detail: wb.detail, dot: wb.dot, rail: wb.rail } : { open: fb.open, detail: fb.detail, dot: fb.dot, rail: fb.rail };
    const navOn = s.screen;
    const nav = [['home', 'Home', '5px'], ['roster', 'Roster', '50%'], ['ref', 'SOPs', '2px'], ['profile', 'Profile', '50% 50% 5px 5px']].map(([k, label, shape]) => ({ label, shape, color: navOn === k ? C.link : C.muted, bg: navOn === k ? C.soft : 'transparent', go: () => this.setState({ screen: k }) }));
    const myGate = meT.coordinator ? null : (() => { const need = this.props.ld01MinLevel ?? 3, lv = meT.employee ? ((s.records[meT.employee] || {})['LD-01'] || []).length : 0; return { ok: lv >= need, lv, need }; })();
    const me = { ld01: meT.coordinator ? 'Training & Safety Coordinator: signs and countersigns' : !meT.employee ? 'Not linked to a roster record, so you can’t sign' : myGate.ok ? 'LD-01 Level ' + myGate.lv + ', cleared to sign' : 'LD-01 Level ' + myGate.lv + ' of ' + myGate.need + ' required, so you can’t sign yet', ldBg: meT.coordinator || myGate?.ok ? C.soft : C.amber, ldInk: meT.coordinator || myGate?.ok ? C.softInk : C.amberInk,
      name: meT.name, first: meT.name.split(' ')[0], role: meT.role, initials: inits(meT.name), count: mySign.length, assigned: d.roster.filter(x => x.trainer && meT.name.toLowerCase().includes(x.trainer.toLowerCase())).length, none: !mySign.length,
      list: mySign.map(x => ({ code: x.code, title: modBy[x.code]?.title || '', trainee: x.trainee, level: x.level, date: x.date, ini: x.initials, sig: this.sigOf(x) })) };
    return { ...base, loading: false, signedOut: false, signedIn: true, trainerCards, nav, me, wb, today: fmt(new Date()),
      isHome: s.screen === 'home', isRoster: s.screen === 'roster', isProfile: s.screen === 'profile', isRef: s.screen === 'ref', ref, rs, todo, fb, wb, rail, mx, gaps, alertBar, appVersion: APP_VERSION, appDate: APP_DATE, dataRev: d.rev || '—', home,
      q: s.q, onSearch: e => this.setState({ q: e.target.value }), filters, rows, listCount: `${listed.length} people`,
      P, showPerson: !s.mod, showModule: !!s.mod, mp, closeModule: () => this.setState({ mod: null }),
      viewModules: s.tab === 'modules' && Pp.req.length > 0, viewQual: s.tab === 'qual', viewSafety: s.tab === 'safety', sf, showSafety: () => this.setState({ tab: 'safety' }), lockNow: () => this.lockUp(),
      tabC: { bg: s.tab === 'safety' ? '#fff' : 'transparent', color: s.tab === 'safety' ? C.ink : C.muted, dot: SF.overdue ? C.red : SF.soon || !SF.orient ? 'oklch(0.75 0.13 75)' : 'transparent' }, showModules: () => this.setState({ tab: 'modules' }), showQual: () => this.setState({ tab: 'qual' }),
      tabA: { bg: s.tab === 'modules' ? '#fff' : 'transparent', color: s.tab === 'modules' ? C.ink : C.muted }, tabB: { bg: s.tab === 'qual' ? '#fff' : 'transparent', color: s.tab === 'qual' ? C.ink : C.muted },
      sm, switchTrainer: () => this.signOutTrainer(),
      exportCsv: () => { const codes = d.modules.map(m => m.code); const esc = v => `"${String(v).replace(/"/g, '""')}"`;
        const lines = [['Employee Name', 'Current Position', ...codes].map(esc).join(',')].concat(people.map(P => [P.r.name, P.r.position, ...codes.map(c => P.lv(c) || '')].map(esc).join(',')));
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'CDGTRN0009_Module_Grid_export.csv'; a.click(); this.flash('Module Grid exported in workbook column order'); }
    };
  }
}

// --- start ------------------------------------------------------------------------------------------------
// Training opens from CDG Ops and uses the same sign-in (employee # + PIN). Not signed in → back to CDG Ops.
// Line tablets: the same 5-minute idle sign-out as the rest of the app.
const IDLE_LIMIT_MS = 5 * 60 * 1000;
const stored = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const noteActivity = () => { try { localStorage.setItem('cdg.lastActivity', String(Date.now())); } catch (e) {} };
const lineTablet = () => stored('cdg.lineTablet') === 'yes';
const idleTooLong = () => { const last = Number(stored('cdg.lastActivity') || 0); return last > 0 && Date.now() - last >= IDLE_LIMIT_MS; };

function start() {
  if (lineTablet() && idleTooLong()) return location.replace('./'); // CDG Ops signs the person out
  noteActivity();
  ['pointerdown', 'keydown'].forEach(e => window.addEventListener(e, noteActivity, true));
  setInterval(() => { if (lineTablet() && idleTooLong()) location.replace('./'); }, 15000);
  let started = false;
  onAuthStateChanged(auth, async user => {
    if (!user) return location.replace('./');
    const claims = (await user.getIdTokenResult()).claims;
    if (claims.pinTemp === true) return location.replace('./');
    if (started) return;
    started = true;
    try {
      const html = await fetch('training-screens.html').then(r => { if (!r.ok) throw new Error('Couldn’t load the Training screens'); return r.text(); });
      mount(document.getElementById('root'), html, Component, { lockMinutes: 2, ld01MinLevel: 3, bare: true });
    } catch (e) {
      document.getElementById('root').innerHTML = '';
      const box = document.createElement('div'); box.className = 'boot-msg';
      const msg = document.createElement('p'); msg.textContent = navigator.onLine ? friendly(e) : 'You’re offline. Training needs a connection the first time it opens on this device.';
      const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Try again'; btn.onclick = () => location.reload();
      box.append(msg, btn); document.getElementById('root').append(box);
    }
  });
}
start();
