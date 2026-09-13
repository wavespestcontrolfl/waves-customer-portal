#!/usr/bin/env node
'use strict';
// Cross-capture digest for one or more glass-audit runs → markdown + JSON.
//   node scripts/qa/glass-audit/analyze.cjs <run> [<run>…]  (names under .tmp/glass-audit)
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../..');
const runs = process.argv.slice(2);
if (!runs.length) { console.error('usage: analyze.cjs <run> [<run>…]'); process.exit(1); }
const results = [];
for (const run of runs) {
  const dir = path.join(root, '.tmp/glass-audit', run);
  // Each capture records its own engine; the run summary is the fallback for captures made before that.
  let runEngine = 'chromium';
  try { runEngine = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')).engine || runEngine; } catch (e) { /* no summary */ }
  for (const sc of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of fs.readdirSync(path.join(dir, sc.name)).filter((x) => x.endsWith('.json'))) {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, sc.name, f), 'utf8'));
      results.push({ run, ...rec, engine: rec.engine || runEngine });
    }
  }
}
// Runs are read in argument order; a later run's capture of the same scenario/state/width SUPERSEDES an
// earlier one everywhere (summary table and every detail section), so a corrective rerun retires issues.
// The latest record wins even when it FAILED: a failed rerun must not leave an older successful capture
// standing in the tables as if it were current. Such records are excluded from every metric section and
// listed under `supersededByFailure` / "Latest capture failed". The identity includes the ENGINE:
// a Chromium rerun never supersedes a WebKit capture (or vice versa), and non-Chromium captures are
// labelled `[engine]` in every row so one browser's result cannot stand in for another's.
const engineOf = (r) => r.engine || 'chromium';
const latest = new Map();
for (const r of results) latest.set(`${r.scenario}/${r.state}@${r.width}#${engineOf(r)}`, r);
const withMetrics = [...latest.values()].filter((r) => r.metrics && !r.failure);
const latestFailed = [...latest.values()].filter((r) => r.failure || !r.metrics);
const key = (r) => `${r.scenario}/${r.state}${engineOf(r) !== 'chromium' ? ` [${engineOf(r)}]` : ''}`;
const byScenario = {};
for (const r of withMetrics) (byScenario[key(r)] = byScenario[key(r)] || []).push(r);

const count = (map, k) => { map[k] = (map[k] || 0) + 1; };
const lines = [];
const out = { runs, captures: results.length, withMetrics: withMetrics.length, failures: results.filter((r) => r.failure).map((r) => ({ id: key(r), width: r.width, failure: r.failure })), supersededByFailure: latestFailed.map((r) => ({ id: key(r), width: r.width, engine: engineOf(r), run: r.run, failure: r.failure || 'no metrics' })) };
lines.push(`# glass-audit digest — runs: ${runs.join(', ')}`, '', `Captures: ${results.length} (${withMetrics.length} current with metrics, ${out.failures.length} failed in total, ${latestFailed.length} scenario/state/width whose LATEST capture failed and is excluded)`, '');
if (latestFailed.length) {
  lines.push('## Latest capture failed (excluded from every section below)', '');
  for (const r of latestFailed) lines.push(`- ${key(r)} @${r.width} ${engineOf(r)} (${r.run}): ${(r.failure || 'no metrics').slice(0, 160)}`);
  lines.push('');
}

// 1. Per-scenario summary table (390 + 1440)
lines.push('## Per-scenario summary (390 / 1440)', '', '| scenario/state | glass | h1 | <14px | >700 | off-scale | ctrl<44 | nested blur | inline blur | pills | heading≠sheet | contrast<AA | overflow-x | main | footer | unmatched | errors |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
// Runs are read in argument order, so the LAST match is the corrective rerun (e.g. `previews previews-fix`).
const pick = (rs, w) => rs.filter((r) => r.width === w).pop();
// Top-document overflow plus any same-origin iframe's INTERNAL overflow (`+f<n>`), which html.scrollWidth cannot see.
const ovx = (L) => { const f = (L.frameOverflow || []).filter((x) => x.overflowX > 0); return `${L.overflowX}${f.length ? ` +f${f.map((x) => x.overflowX).join('/')}` : ''}`; };
const fmt2 = (a, b, f) => `${a ? f(a) : '–'} / ${b ? f(b) : '–'}`;
for (const [k, rs] of Object.entries(byScenario)) {
  const a = pick(rs, 390); const b = pick(rs, 1440);
  const m = (r) => r.metrics;
  lines.push(`| ${k} | ${fmt2(a, b, (r) => m(r).theme.mounted ? (m(r).theme.attr || 'on') : 'OFF')} | ${fmt2(a, b, (r) => m(r).h1Count)} | ${fmt2(a, b, (r) => m(r).text.under14.length)} | ${fmt2(a, b, (r) => m(r).text.over700.length)} | ${fmt2(a, b, (r) => m(r).text.offScale.length)} | ${fmt2(a, b, (r) => m(r).controls.small.length)} | ${fmt2(a, b, (r) => m(r).glass.nestedBlur.length)} | ${fmt2(a, b, (r) => m(r).glass.inlineBlur.length)} | ${fmt2(a, b, (r) => m(r).pills.length)} | ${fmt2(a, b, (r) => m(r).headingIssues.length)} | ${fmt2(a, b, (r) => r.contrast.length)} | ${fmt2(a, b, (r) => ovx(m(r).layout))} | ${fmt2(a, b, (r) => m(r).layout.mainCount)} | ${fmt2(a, b, (r) => m(r).layout.footer.present ? 'y' : 'n')} | ${fmt2(a, b, (r) => r.unmatched.length)} | ${fmt2(a, b, (r) => r.pageErrors.length)} |`);
}
lines.push('');

// 2. Detail lists (deduped by scenario + ENGINE + selector + text: the same issue seen in Chromium and
//    WebKit is listed once per engine, so the /webkit suffix can show a cross-engine reproduction).
//    `source` defaults to the current successful captures; error sections pass the latest records
//    INCLUDING failed ones, because a failed interaction / page error is exactly what fails a capture.
//    Every captured width is read (320/375/430/768/1024 extra viewports included: a 320px overflow is a
//    finding), and each interaction's own metrics snapshot (opened sheet / menu / dialog / later booking
//    step) is read as a virtual record labelled `/<interaction>`, so overlay-only defects are listed too.
const ixRecords = (r) => (r.interactions || []).filter((i) => i.ok && i.metrics).map((i) => ({ ...r, metrics: i.metrics, contrast: i.contrast || [], focusProbe: [], interactions: [], unmatched: [], pageErrors: [], ix: i.name }));
function section(title, getter, fmt, limitPer = 12, source = withMetrics) {
  lines.push(`## ${title}`, '');
  const seen = new Set();
  const grouped = {};
  for (const r of source.flatMap((x) => [x, ...(source === withMetrics ? ixRecords(x) : [])])) {
    for (const it of getter(r) || []) {
      const id = `${r.scenario}|${engineOf(r)}|${fmt(it)}`;
      if (seen.has(id)) continue; seen.add(id);
      (grouped[r.scenario] = grouped[r.scenario] || []).push(`${fmt(it)} @${r.width}${r.ix ? '/' + r.ix : ''}${engineOf(r) !== 'chromium' ? '/' + engineOf(r) : ''}`);
    }
  }
  const total = Object.values(grouped).reduce((n, a) => n + a.length, 0);
  lines.push(`_${total} distinct items across ${Object.keys(grouped).length} scenarios_`, '');
  for (const [sc, items] of Object.entries(grouped)) {
    lines.push(`- **${sc}** (${items.length}): ${items.slice(0, limitPer).join('; ')}${items.length > limitPer ? `; … +${items.length - limitPer}` : ''}`);
  }
  lines.push('');
  out[title] = grouped;
}
section('Text under 14px', (r) => r.metrics.text.under14, (t) => `${t.sel} ${t.size}px/${t.weight} “${t.text.slice(0, 30)}”`);
section('Weights above 700', (r) => r.metrics.text.over700, (t) => `${t.sel} ${t.size}px/${t.weight} “${t.text.slice(0, 30)}”`);
section('Off-scale sizes (not 14/15/16/18/20/26/32–40)', (r) => r.metrics.text.offScale, (t) => `${t.sel} ${t.size}px “${t.text.slice(0, 30)}”`);
section('Controls under 44px (non-inline)', (r) => r.metrics.controls.small, (c) => `${c.sel} ${c.w}×${c.h}px “${c.name.slice(0, 24)}”`);
section('Inputs (height / font / radius / placeholder)', (r) => r.metrics.controls.inputs, (i) => `${i.sel} h${i.h} ${i.size}px r${i.radius} ph:${i.placeholder ? i.placeholder.size + ' ' + i.placeholder.color : '-'} labelled:${i.labelled}`);
section('Heading sizes ≠ sheet', (r) => r.metrics.headingIssues, (h) => `${h.why} “${h.text.slice(0, 30)}”`);
section('Nested backdrop-filter (glass inside glass)', (r) => r.metrics.glass.nestedBlur, (g) => `${g.sel}`);
section('Elements extending past the viewport edge (clipped overflow)', (r) => r.metrics.layout.overflowers, (o) => `${o.sel} right=${o.right} w=${o.w} y=${o.y}`);
section('Iframe documents with internal horizontal overflow', (r) => (r.metrics.layout.frameOverflow || []).filter((f) => f.overflowX > 0), (f) => `frame ${f.w}px wide scrolls ${f.scrollWidth}px (+${f.overflowX})`);
section('Untagged inline backdrop-filter surfaces', (r) => r.metrics.glass.inlineBlur, (g) => `${g.sel} ${g.backdrop} r${g.radius}`);
section('Status-chip-like pills (no-chips ruling)', (r) => r.metrics.pills, (p) => `${p.sel} “${p.text.slice(0, 24)}” ${p.size}px r${p.radius} ${p.bg}`);
section('Contrast below AA on composited background', (r) => r.contrast, (c) => `${c.sel} “${c.text.slice(0, 24)}” ${c.size}px ${c.color} on ${c.bg} = ${c.avg}:1 (min ${c.min})`);
section('Icon-only controls without a name', (r) => r.metrics.controls.iconOnlyUnnamed, (c) => c.sel);
section('Focus probe: focusable controls with no visible ring', (r) => (r.focusProbe || []).filter((f) => f.focusable !== false && !f.ring), (f) => `${f.sel} “${(f.name || '').slice(0, 20)}” outline:${f.outline}`);
section('Dialogs / overlays captured', (r) => r.interactions.flatMap((i) => (i.metrics ? i.metrics.overlays.dialogs.map((d) => ({ ...d, ix: i.name })) : [])), (d) => `${d.ix}: ${d.sel} glass=${d.glass} r${d.radius} label=${d.label}`);
section('Scrims captured', (r) => r.interactions.flatMap((i) => (i.metrics ? i.metrics.overlays.scrims.map((s) => ({ ...s, ix: i.name })) : [])), (s) => `${s.ix}: ${s.bg} ${s.backdrop}`);
const latestAll = [...latest.values()];
section('Interaction failures', (r) => (r.interactions || []).filter((i) => !i.ok), (i) => `${i.name}: ${(i.error || '').slice(0, 80)}`, 12, latestAll);
section('Unmatched API calls', (r) => (r.unmatched || []).map((u) => ({ u })), (x) => x.u, 12, latestAll);
section('Page errors', (r) => (r.pageErrors || []).map((u) => ({ u })), (x) => x.u.slice(0, 100), 12, latestAll);

// 3. Cross-scenario distributions
lines.push('## Glass tier radius by scenario (390)', '');
for (const r of withMetrics.filter((x) => x.width === 390)) {
  const rb = r.metrics.glass.radiusByTier;
  lines.push(`- ${key(r)}: ${Object.entries(rb).map(([t, m]) => `${t}=${Object.entries(m).map(([rad, n]) => `${rad}×${n}`).join(',')}`).join(' | ')}`);
}
lines.push('', '## Layout geometry (gutter / widest card / header / footer / sticky / fixed-bottom)', '');
for (const w of [320, 390, 768, 1024, 1440]) {
  const rs = withMetrics.filter((x) => x.width === w);
  if (!rs.length) continue;
  lines.push(`### @${w}`, '');
  for (const r of rs) {
    const L = r.metrics.layout;
    lines.push(`- ${key(r)}: gutter=${L.gutterLeft} widest=${L.widestCard} lefts=[${L.cardLefts.slice(0, 5).join(',')}] header=${L.header ? `${L.header.h}px ${L.header.position} pt:${L.header.pt}` : 'none'} footer=${L.footer.present ? `${L.footer.h}px${L.footer.belowFold ? ' BELOW-FOLD' : ''}` : 'none'} sticky=[${L.stickyTop.filter((s) => !s.sel.includes('glass-scene')).map((s) => `${s.sel} ${s.h}px pt:${s.pt}`).join('; ')}] fixedBottom=[${L.fixedBottom.filter((s) => !s.sel.includes('glass-scene')).map((s) => `${s.sel} ${s.h}px pb:${s.pb}`).join('; ')}] main=${L.mainWidth}`);
  }
  lines.push('');
}
lines.push('## Typography census per scenario (390): sizes / weights / families / distinct colours', '');
for (const r of withMetrics.filter((x) => x.width === 390)) {
  const T = r.metrics.text;
  lines.push(`- ${key(r)}: sizes {${Object.entries(T.sizeHist).sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join(' ')}} weights {${Object.entries(T.weightHist).map(([s, n]) => `${s}:${n}`).join(' ')}} families {${Object.entries(T.familyHist).map(([s, n]) => `${s}:${n}`).join(' ')}} colours=${Object.keys(T.colorHist).length} h1=${r.metrics.headings.filter((h) => h.tag === 'h1').map((h) => h.size).join('/')} h2=${[...new Set(r.metrics.headings.filter((h) => h.tag === 'h2').map((h) => h.size))].join('/')} h3=${[...new Set(r.metrics.headings.filter((h) => h.tag === 'h3').map((h) => h.size))].join('/')} eyebrows=${[...new Set(r.metrics.eyebrows.map((e) => `${e.size}/${e.weight}/${e.ls}`))].join(',')}`);
}
lines.push('', '## Text colours used (390, all scenarios)', '');
const colours = {};
for (const r of withMetrics.filter((x) => x.width === 390)) for (const [c, n] of Object.entries(r.metrics.text.colorHist)) { colours[c] = colours[c] || { n: 0, sc: new Set() }; colours[c].n += n; colours[c].sc.add(r.scenario); }
for (const [c, v] of Object.entries(colours).sort((a, b) => b[1].n - a[1].n)) lines.push(`- ${c}: ${v.n} elements in ${v.sc.size} scenarios`);
lines.push('', '## Fonts actually loaded / computed families', '');
for (const r of withMetrics.filter((x) => x.width === 1440)) lines.push(`- ${key(r)}: body=${(r.metrics.fonts.body || '').split(',')[0]} h1=${(r.metrics.fonts.h1 || '').split(',')[0]} button=${(r.metrics.fonts.button || '').split(',')[0]} loaded=[${r.metrics.fonts.loaded.slice(0, 6).join(', ')}]`);

const runLabel = runs.join('+');
const mdPath = path.join(root, '.tmp/glass-audit', `digest-${runLabel}.md`);
fs.writeFileSync(mdPath, lines.join('\n'));
fs.writeFileSync(path.join(root, '.tmp/glass-audit', `digest-${runLabel}.json`), JSON.stringify(out, null, 2));
console.log(`digest → ${path.relative(root, mdPath)} (${lines.length} lines)`);
