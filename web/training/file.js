// Training: file-based exchange with the CDGTRN0009 workbook (no Microsoft admin needed) — from the training
// team's app (workbook-file.js). Change: the updates file never includes trainer PINs.
(function () {
  const REF_COLS = { loto: 'LOTO - Affected Employee - Last Completed', eap: 'Emergency Action Plan & Drill - Last Completed', ppe: 'Safety / PPE / Guarding / Electrical - Last Completed', c10: 'Injury & Incident Reporting (C-10) - Last Completed', qc: 'Dimensional & Wind Quality Check - Last Completed', ld08: 'Lead Injury Response (LD-08) - Leads only - Last Completed' };
  const ORI_COLS = { date: 'C-02 Orientation Date', by: 'Delivered By', topics: 'Section 1.1 Topics Complete', acks: 'Section 1.2 Acknowledgments Signed', verified: 'Coordinator Verified' };
  const toNew = c => c.replace(/^C-(0[4-9]|10)$/, (_, n) => 'C-' + String(+n - 1).padStart(2, '0')), toOld = c => c.replace(/^C-(0[3-9])$/, (_, n) => 'C-' + String(+n + 1).padStart(2, '0'));
  const dec = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const fromSerial = v => { const n = +v; return v !== '' && !isNaN(n) && n > 20000 ? new Date(Date.UTC(1899, 11, 30) + n * 864e5).toISOString().slice(0, 10) : null; };
  const esc = v => { const s = String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014]/g, '-'); return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

  async function parse(buf) {
    if (!window.JSZip) throw new Error('Workbook reader didn’t load. Reload the page');
    const zip = await JSZip.loadAsync(buf);
    const wb = await zip.file('xl/workbook.xml').async('string');
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    const ssF = zip.file('xl/sharedStrings.xml');
    const ss = ssF ? [...(await ssF.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => dec([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''))) : [];
    const attr = (s, a) => (s.match(new RegExp('\\s' + a + '="([^"]*)"')) || [])[1];
    const relMap = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
    const sheets = Object.fromEntries([...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => [dec(attr(m[0], 'name') || ''), 'xl/' + String(relMap[attr(m[0], 'r:id')] || '').replace(/^\/?xl\//, '')]));
    let rosterByRow = null;
    async function rows(name) {
      if (!sheets[name] || !zip.file(sheets[name])) throw new Error('Tab "' + name + '" not found in this file');
      const x = await zip.file(sheets[name]).async('string');
      const all = [...x.matchAll(/<row ([^>]*)>([\s\S]*?)<\/row>/g)].map(r0 => { const r = [r0[0], r0[2]], o = { _r: +((r0[1].match(/\br="(\d+)"/) || [])[1] || 0) }; for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) { const v = (c[3] || '').match(/<v>([\s\S]*?)<\/v>/); const is = (c[3] || '').match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/); let val = v ? dec(v[1]) : is ? dec(is[1]) : ''; if (/t="s"/.test(c[2])) val = ss[+val] ?? ''; if (val !== '') o[c[1]] = val; } return o; });
      if (rosterByRow) all.forEach(r => { if (!String(r.A || '').trim() && rosterByRow[r._r] && Object.keys(r).length > 1) r.A = rosterByRow[r._r]; });
      const hi = all.findIndex(r => String(r.A || '').trim() === 'Employee Name');
      if (hi < 0) throw new Error('No "Employee Name" header on ' + name);
      const norm = v => String(v).replace(/\s+/g, ' ').trim().toLowerCase(); const head0 = Object.fromEntries(Object.entries(all[hi]).map(([k, v]) => [norm(v), k])); const ALIAS = { 'current position': ['job title', 'position', 'title', 'current job title'], 'section 1.1 topics complete': ['card 1.1 topics complete'], 'section 1.2 acknowledgments signed': ['card 1.2 acknowledgments signed'] }; const head = new Proxy(head0, { get: (o, key) => { const n = norm(key); return o[n] ?? (ALIAS[n] || []).map(x => o[x]).find(Boolean); } });
      return { head, raw: Object.fromEntries(Object.entries(all[hi]).map(([k, v]) => [String(v).trim(), k])), data: all.slice(hi + 1).filter(r => String(r.A || '').trim()) };
    }
    async function trainerRows() {
      const nm = Object.keys(sheets).find(n => /^\s*trainers?\s*$/i.test(n)); if (!nm || !zip.file(sheets[nm])) return null;
      const x = await zip.file(sheets[nm]).async('string');
      const all = [...x.matchAll(/<row ([^>]*)>([\s\S]*?)<\/row>/g)].map(r0 => { const r = [r0[0], r0[2]], o = { _r: +((r0[1].match(/\br="(\d+)"/) || [])[1] || 0) }; for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) { const v = (c[3] || '').match(/<v>([\s\S]*?)<\/v>/); const is = (c[3] || '').match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/); let val = v ? dec(v[1]) : is ? dec(is[1]) : ''; if (/t="s"/.test(c[2])) val = ss[+val] ?? ''; if (val !== '') o[c[1]] = val; } return o; });
      const isName = v => /^(trainer name|trainer|name|employee name|full name)$/i.test(String(v).trim());
      const hi = all.findIndex(r => Object.values(r).some(isName)); if (hi < 0) return null;
      const H = all[hi], col = re => (Object.entries(H).find(([, v]) => re.test(String(v).trim())) || [])[0];
      const cN = Object.entries(H).find(([, v]) => isName(v))[0], cR = col(/^(role|title|job title|position)$/i), cP = col(/^pin( ?#| code)?$/i), cA = col(/^(active|status)$/i);
      return all.slice(hi + 1).filter(r => String(r[cN] || '').trim() && String(r[cN]).length < 60).map(r => ({ name: String(r[cN]).trim(), role: cR ? String(r[cR] || '') : '', active: cA ? !/^(no|inactive|n|false|0)$/i.test(String(r[cA] || '').trim()) : true, fields: Object.entries(H).filter(([k, h]) => k !== cN && k !== cP && k !== '_r' && !/pin/i.test(String(h)) && r[k] !== undefined && String(r[k]).trim() !== '').map(([k, h]) => ({ k: String(h).trim(), v: /date/i.test(String(h)) && fromSerial(r[k]) ? fromSerial(r[k]) : String(r[k]) })) }));
    }
    const tr = await trainerRows().catch(() => null);
    const ro = await rows('Roster'); rosterByRow = Object.fromEntries(ro.data.map(r => [r._r, String(r.A).trim()]));
    const mg = await rows('Module Grid'), so = await rows('Safety Orientation'), rl = await rows('Refresher Log');
    const g = (t, r, k) => (t.head[k] ? r[t.head[k]] : '') ?? '';
    const roster = ro.data.map(r => ({ name: String(r.A).trim(), id: String(g(ro, r, 'Employee ID')), team: String(g(ro, r, 'Team')), shift: String(g(ro, r, 'Shift')), hire: fromSerial(g(ro, r, 'Hire Date')), track: String(g(ro, r, 'Track')), position: String(g(ro, r, 'Current Position')), inPosition: fromSerial(g(ro, r, 'Date in Current Position')), needs: String(g(ro, r, 'Needs Program?')), basis: String(g(ro, r, 'Basis / Reason')), baseline: fromSerial(g(ro, r, 'Baseline Assessment Date')), card: String(g(ro, r, 'Qualification Card Issued')), target: fromSerial(g(ro, r, 'Target Qualification Date')), trainer: String(g(ro, r, 'Assigned Trainer')), status: String(g(ro, r, 'Training Status')), notes: String(g(ro, r, 'Notes')) }))
      .filter(r => r.name.length < 60 && (r.id || r.team || r.position));
    const levels = {}, oldNums = 'C-10' in mg.raw;
    mg.data.forEach(r => { const o = {}; Object.entries(mg.raw).forEach(([code, col]) => { if (/^(C|L|W|LD|Q)-/.test(code) && r[col] !== undefined && !isNaN(+r[col])) o[oldNums ? toNew(code) : code] = +r[col]; }); if (Object.keys(o).length) levels[String(r.A).trim()] = o; });
    const extra = {}; try { const am = await rows('Added Modules'); am.data.forEach(r => { const o = {}; Object.entries(am.raw).forEach(([code, col]) => { if (/^(C|L|W|LD|Q)-/.test(code) && r[col] !== undefined && +r[col] > 0) o[oldNums ? toNew(code) : code] = +r[col]; }); if (Object.keys(o).length) extra[String(r.A).trim()] = o; }); } catch (e) {}
    const safety = {};
    so.data.forEach(r => { const d = fromSerial(g(so, r, ORI_COLS.date)); if (d) safety[String(r.A).trim()] = { date: d, by: g(so, r, ORI_COLS.by), topics: g(so, r, ORI_COLS.topics), acks: g(so, r, ORI_COLS.acks), verified: g(so, r, ORI_COLS.verified) }; });
    const refreshers = {};
    rl.data.forEach(r => { const o = {}; Object.entries(REF_COLS).forEach(([k, h]) => { const d = fromSerial(g(rl, r, h)); if (d) o[k] = d; }); if (Object.keys(o).length) refreshers[String(r.A).trim()] = o; });
    return { extra, oldNums, roster, levels, safety, refreshers, trainers: tr ? tr.filter(t => t.active) : null };
  }

  // Full snapshot. Only cells the tablet knows about are included, so levels typed in Excel aren't blanked.
  function csv({ records, refreshers, orient, oldNums, extra }) {
    const out = [['Tab', 'Employee Name', 'Column', 'Value']];
    Object.entries(records || {}).forEach(([name, mods]) => Object.entries(mods).forEach(([code, arr]) => out.push(['Module Grid', name, oldNums ? toOld(code) : code, arr.length || ''])));
    Object.entries(extra || {}).forEach(([name, o]) => Object.entries(o).forEach(([code, l]) => out.push(['Added Modules', name, oldNums ? toOld(code) : code, l || ''])));
    Object.entries(refreshers || {}).forEach(([name, o]) => Object.entries(o).forEach(([k, d]) => { if (REF_COLS[k] && d) out.push(['Refresher Log', name, k === 'c10' && !oldNums ? REF_COLS[k].replace('(C-10)', '(C-09)') : REF_COLS[k], d]); }));
    Object.entries(orient || {}).forEach(([name, o]) => { if (!o) return; Object.entries(ORI_COLS).forEach(([k, h]) => { if (o[k]) out.push(['Safety Orientation', name, h, o[k]]); }); });
    return out.map(r => r.map(esc).join(',')).join('\r\n') + '\r\n';
  }
  window.CDGFile = { parse, csv, REF_COLS, ORI_COLS };
})();
