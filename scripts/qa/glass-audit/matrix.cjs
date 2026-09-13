#!/usr/bin/env node
'use strict';
// Route/state coverage matrix generator: joins scenario metadata with every
// capture found in the named runs → markdown table.
//   node scripts/qa/glass-audit/matrix.cjs <run> [<run>…] > docs/…-coverage-matrix.md
const fs = require('node:fs');
const path = require('node:path');
const { loadScenarios } = require('./scenarios/index.cjs');

const root = path.resolve(__dirname, '../../..');
const runs = process.argv.slice(2);
// The output replaces the committed coverage matrix via shell redirection, so a misspelled or deleted
// run must fail loudly instead of quietly producing a thinner (or all-NOT VERIFIED) document.
if (!runs.length) { console.error('usage: matrix.cjs <run> [<run>…]  (names under .tmp/glass-audit)'); process.exit(1); }
const missingRuns = runs.filter((run) => !fs.existsSync(path.join(root, '.tmp/glass-audit', run)));
if (missingRuns.length) { console.error(`matrix.cjs: run directory not found: ${missingRuns.join(', ')}`); process.exit(1); }
const captures = [];
for (const run of runs) {
  // Read every per-capture JSON (a later --only run overwrites summary.json, the capture files survive).
  const dir = path.join(root, '.tmp/glass-audit', run);
  let engine = 'chromium';
  try { engine = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')).engine || engine; } catch (e) { /* no summary */ }
  for (const sc of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of fs.readdirSync(path.join(dir, sc.name)).filter((x) => x.endsWith('.json'))) {
      // Each capture records its own engine (run.cjs); the run summary is only a fallback for older captures.
      const rec = JSON.parse(fs.readFileSync(path.join(dir, sc.name, f), 'utf8'));
      captures.push({ run, ...rec, engine: rec.engine || engine });
    }
  }
}
const scenarios = loadScenarios();
const byId = {};
for (const c of captures) (byId[c.scenario] = byId[c.scenario] || []).push(c);

const lines = [];
lines.push('| Surface | Route / pattern | Role | Family | Scenario | States captured | Overlays / interactions | 390 | 1440 | Other widths | Engines | Evidence (run) | Findings (ids) | Blockers / exclusions |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
// A state counts as inspected at a width when its LATEST capture (runs are read in argument order)
// IN EVERY ENGINE that captured it succeeded: an earlier success never masks a later failed rerun,
// an earlier failure that was re-run successfully is superseded, not double-counted, and a Chromium
// rerun never supersedes a WebKit capture (a failed latest WebKit capture is reported in the cell).
// Expected states at a width come from the scenario DECLARATION (honouring a state's own `widths`
// restriction), never from whichever captures happen to exist, so a state that was never captured
// at that width shows as `partial` instead of silently passing as `inspected`.
const DEFAULT_WIDTHS = [390, 1440];
const declaredAt = (s, w) => (s.states && s.states.length ? s.states : [{ name: 'default' }])
  .filter((st) => (st.widths || s.widths || DEFAULT_WIDTHS).includes(w)).map((st) => st.name);
// A capture counts only when it neither failed nor came back without metrics — the same test the
// extra-width cell applies below, so "inspected" means one thing across the whole matrix.
const ok = (c) => !!c && !c.failure && !!c.metrics;
const status = (s, list, w) => {
  const rs = list.filter((c) => c.width === w);
  const states = declaredAt(s, w);
  if (!rs.length) return states.length ? 'NOT VERIFIED' : 'n/a';
  const engines = [...new Set(rs.map((c) => c.engine))];
  const latestOf = (st, e) => rs.filter((c) => c.state === st && c.engine === e).pop();
  const failedEngines = engines.filter((e) => states.some((st) => { const c = latestOf(st, e); return c && !ok(c); }));
  // EVERY engine represented at this width must hold a successful latest capture of the state: an
  // interrupted WebKit run that captured only the first state leaves the others partial, not inspected.
  const okStates = states.filter((st) => engines.every((e) => ok(latestOf(st, e))));
  if (!okStates.length) { const c = rs[rs.length - 1]; return `BLOCKED (${c.failure ? c.failure.slice(0, 40) : 'no metrics'})`; }
  const note = failedEngines.length ? `; latest ${failedEngines.join('/')} capture failed` : '';
  return okStates.length === states.length && !note ? 'inspected' : `partial (${okStates.length}/${states.length} states${note})`;
};
const cell = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|');
for (const s of scenarios) {
  const list = byId[s.id] || [];
  // Interaction / unmocked-call cells come from the LATEST capture per state/width/engine: a corrective
  // rerun retires an earlier `(failed)` interaction or unmatched call instead of listing both.
  const latestMap = new Map();
  for (const c of list) latestMap.set(`${c.state}@${c.width}#${c.engine}`, c);
  const latestList = [...latestMap.values()];
  const states = [...new Set(list.map((c) => c.state))];
  const declaredStates = (s.states || [{ name: 'default' }]).map((x) => x.name);
  const missing = declaredStates.filter((x) => !states.includes(x));
  const ix = [...new Set(latestList.flatMap((c) => (c.interactions || []).map((i) => `${i.name}${i.ok ? '' : ' (failed)'}`)))];
  // Driven off latestList (not `list`), same as `ix`/`unmatched` above: a timed-out rerun at an extra
  // width must not hide behind an earlier successful capture of that same width.
  const otherWidths = [...new Set(latestList.map((c) => c.width).filter((w) => w !== 390 && w !== 1440))].sort((a, b) => a - b);
  const failedOtherWidths = otherWidths.filter((w) => !latestList.filter((c) => c.width === w).every(ok));
  const other = otherWidths.map((w) => (failedOtherWidths.includes(w) ? `${w} (failed)` : String(w)));
  const engines = [...new Set(list.map((c) => c.engine))];
  const runsUsed = [...new Set(list.map((c) => c.run))];
  const blockers = [];
  if (!list.length) blockers.push('no capture');
  if (missing.length) blockers.push(`states not captured: ${missing.join(', ')}`);
  if (s.notes) blockers.push(s.notes);
  if (failedOtherWidths.length) blockers.push(`extra-width capture failed: ${failedOtherWidths.join(', ')}`);
  const unmatched = [...new Set(latestList.flatMap((c) => c.unmatched || []))];
  if (unmatched.length) blockers.push(`unmocked: ${unmatched.slice(0, 2).join(', ')}${unmatched.length > 2 ? ` +${unmatched.length - 2}` : ''}`);
  lines.push(['', s.surface, `\`${s.route}\``, s.role, s.family, s.id, states.join(', ') || '—', ix.join(', ') || '—', status(s, list, 390), status(s, list, 1440), other.join('/') || '—', engines.join('+') || '—', runsUsed.join(', ') || '—', s.findings || '', blockers.join('; ') || '—', ''].map(cell).join(' | ').trim());
}
process.stdout.write(lines.join('\n') + '\n');
