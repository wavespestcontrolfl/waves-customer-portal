#!/usr/bin/env node
// Literal future dates are the one defect class this harness keeps regrowing. A fixture written
// with a date that is ahead of its authoring day renders a state the public route could emit that
// week and cannot emit later: the appointment page, the reschedule availability, the ranked slot
// list, the contract and outline token expiries, the invoice and statement due dates and the
// prep-guide upcoming band each shipped as a literal and each rotted into a state production would
// never serve -- so the evidence kept claiming coverage of a screen that can no longer exist.
//
// The rule is mechanical, so it is enforced rather than remembered: no literal YYYY-MM-DD in a
// scenario or fixture may be in the future. A date that must stay ahead of the run belongs to
// `etDateString(addETDays(new Date(), n))` (or a re-basing helper such as `liveReschedule` /
// `liveTrack`), which cannot go stale. Past literals are left alone -- a paid invoice, a delivered
// newsletter, a completed service report are historical records and stay true as they age.
const fs = require('node:fs');
const path = require('node:path');
const { etDateString } = require('../../../server/utils/datetime-et');

const ROOT = __dirname;
const DIRS = ['scenarios', 'fixtures'];
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/g;

// A recorded extraction keeps the dates it was captured with; what matters is that nothing serves
// them raw. These fixtures are re-based onto the run date by the named helper before they reach a
// scenario handler, so their literals are evidence, not state. The helper name is verified to still
// exist below -- delete or rename it and the fixture is checked like any other.
const REBASED = {
  'schedule-flow-reschedule.json': 'liveReschedule',
  'track-en-route.json': 'liveTrack',
};

const today = etDateString(new Date());
const files = DIRS.flatMap((d) => {
  const dir = path.join(ROOT, d);
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => /\.(cjs|json)$/.test(f)).map((f) => path.join(dir, f))
    : [];
});

// Re-basing helpers are found across the scenario sources, not one known file, so a helper that
// moves between scenario modules keeps its exemption while a deleted one revokes it.
const scenarioSrc = files.filter((f) => f.endsWith('.cjs')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const missingHelpers = Object.entries(REBASED).filter(([, fn]) => !new RegExp(`\\b(?:const|function)\\s+${fn}\\b`).test(scenarioSrc));
if (missingHelpers.length) {
  process.stderr.write(`glass-audit: re-basing helper(s) gone, so their fixtures are no longer exempt: ${missingHelpers.map(([fx, fn]) => `${fn} (${fx})`).join(', ')}\n`);
  process.exit(1);
}

const offenders = [];
for (const file of files) {
  if (REBASED[path.basename(file)]) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // An `audit-ok-date` trailing marker documents a literal that is deliberately fixed and explains why.
    if (/audit-ok-date/.test(line)) return;
    for (const m of line.matchAll(DATE)) {
      if (m[1] > today) offenders.push({ file: path.relative(ROOT, file), line: i + 1, date: m[1], text: line.trim().slice(0, 120) });
    }
  });
}

if (!offenders.length) {
  process.stdout.write(`glass-audit: no future-dated literals in ${files.length} scenario/fixture files (ET today ${today})\n`);
  process.exit(0);
}
process.stderr.write(`glass-audit: ${offenders.length} future-dated literal(s) -- these render states the public routes stop emitting once the date passes (ET today ${today}):\n`);
for (const o of offenders) process.stderr.write(`  ${o.file}:${o.line}  ${o.date}  ${o.text}\n`);
process.stderr.write('\nGenerate the date from the run instead -- etDateString(addETDays(new Date(), n)) -- or mark the line `audit-ok-date` with the reason it is deliberately fixed.\n');
process.exit(1);
