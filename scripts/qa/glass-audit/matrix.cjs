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
const captures = [];
for (const run of runs) {
  // Read every per-capture JSON (a later --only run overwrites summary.json, the capture files survive).
  const dir = path.join(root, '.tmp/glass-audit', run);
  if (!fs.existsSync(dir)) continue;
  let engine = 'chromium';
  try { engine = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')).engine || engine; } catch (e) { /* no summary */ }
  for (const sc of fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of fs.readdirSync(path.join(dir, sc.name)).filter((x) => x.endsWith('.json'))) {
      captures.push({ run, engine, ...JSON.parse(fs.readFileSync(path.join(dir, sc.name, f), 'utf8')) });
    }
  }
}
const scenarios = loadScenarios();
const byId = {};
for (const c of captures) (byId[c.scenario] = byId[c.scenario] || []).push(c);

const lines = [];
lines.push('| Surface | Route / pattern | Role | Family | Scenario | States captured | Overlays / interactions | 390 | 1440 | Other widths | Engines | Evidence (run) | Findings (ids) | Blockers / exclusions |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
// A state counts as inspected at a width when at least one capture of it succeeded
// (earlier failed attempts that were re-run are superseded, not double-counted).
// Expected states at a width come from the scenario DECLARATION (honouring a state's own `widths`
// restriction), never from whichever captures happen to exist, so a state that was never captured
// at that width shows as `partial` instead of silently passing as `inspected`.
const DEFAULT_WIDTHS = [390, 1440];
const declaredAt = (s, w) => (s.states && s.states.length ? s.states : [{ name: 'default' }])
  .filter((st) => (st.widths || s.widths || DEFAULT_WIDTHS).includes(w)).map((st) => st.name);
const status = (s, list, w) => {
  const rs = list.filter((c) => c.width === w);
  const states = declaredAt(s, w);
  if (!rs.length) return states.length ? 'NOT VERIFIED' : 'n/a';
  const okStates = states.filter((st) => rs.some((c) => c.state === st && !c.failure && c.metrics));
  if (!okStates.length) return `BLOCKED (${rs[0].failure ? rs[0].failure.slice(0, 40) : 'no metrics'})`;
  return okStates.length === states.length ? 'inspected' : `partial (${okStates.length}/${states.length} states)`;
};
const cell = (v) => String(v == null ? '' : v).replace(/\|/g, '\\|');
for (const s of scenarios) {
  const list = byId[s.id] || [];
  const states = [...new Set(list.map((c) => c.state))];
  const declaredStates = (s.states || [{ name: 'default' }]).map((x) => x.name);
  const missing = declaredStates.filter((x) => !states.includes(x));
  const ix = [...new Set(list.flatMap((c) => c.interactions.map((i) => `${i.name}${i.ok ? '' : ' (failed)'}`)))];
  const other = [...new Set(list.map((c) => c.width).filter((w) => w !== 390 && w !== 1440))].sort((a, b) => a - b);
  const engines = [...new Set(list.map((c) => c.engine))];
  const runsUsed = [...new Set(list.map((c) => c.run))];
  const blockers = [];
  if (!list.length) blockers.push('no capture');
  if (missing.length) blockers.push(`states not captured: ${missing.join(', ')}`);
  if (s.notes) blockers.push(s.notes);
  const unmatched = [...new Set(list.flatMap((c) => c.unmatched))];
  if (unmatched.length) blockers.push(`unmocked: ${unmatched.slice(0, 2).join(', ')}${unmatched.length > 2 ? ` +${unmatched.length - 2}` : ''}`);
  lines.push(['', s.surface, `\`${s.route}\``, s.role, s.family, s.id, states.join(', ') || '—', ix.join(', ') || '—', status(s, list, 390), status(s, list, 1440), other.join('/') || '—', engines.join('+') || '—', runsUsed.join(', ') || '—', s.findings || '', blockers.join('; ') || '—', ''].map(cell).join(' | ').trim());
}
process.stdout.write(lines.join('\n') + '\n');
