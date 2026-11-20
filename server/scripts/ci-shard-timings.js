#!/usr/bin/env node
/**
 * Rebuild server/tests/helpers/ci-shard-timings.json from GitHub Actions job logs.
 *
 * The time-balanced test sequencer (tests/helpers/time-balanced-sequencer.js)
 * splits the `server-unit` and `server-db` jest runs by these per-file
 * seconds. Stale numbers only make the shards uneven; they never drop a test
 * file, because every file the run finds is assigned to exactly one shard.
 *
 * Refresh (read-only, no secrets): save the logs of the `server-unit (N)` and
 * `server-db (N)` jobs of a few green main runs, then run this script on them:
 *
 *   gh run view <run-id> --log --job <job-id> > /tmp/ci-logs/<job-id>.log
 *   node server/scripts/ci-shard-timings.js \
 *     --out server/tests/helpers/ci-shard-timings.json /tmp/ci-logs/*.log
 *
 * New times merge into the existing file: a test file the given logs do not
 * mention keeps its recorded time, so logs from only some shards (or a log
 * format the script does not recognise) can update times but never erase them.
 *
 * A file's time is the median over the logs that ran it. Jest prints a file's
 * time only when it is slow ("PASS tests/x.test.js (12.3 s)"); in a serial
 * (--runInBand) step the gap between two result lines is the later file's time.
 *
 * The two jobs get separate maps: a DB-gated suite runs for real in
 * `server-db` (DATABASE_URL set) but skips in under a second in `server-unit`.
 */
const fs = require('fs');

const RESULT = /^(?:PASS|FAIL)\s+(tests\/\S+\.test\.js)(?:\s+\(([\d.]+) s\))?/;
// A result Jest prints without a time ran in under 5 s. Measured 2026-11-20 on
// three main runs: (shard wall time x 3 workers - printed file times) / unprinted
// files = 0.4 s. That is the time recorded for such a result when no serial gap
// measures it, and the unit default: a unit file whose median falls to it leaves
// the map, so a suite that got fast loses its old weight. A DB file the map does
// not list gets the median of the listed DB files.
const UNIT_DEFAULT_SECONDS = 0.4;
const SECTION_BY_JOB = [['server-db', 'db'], ['server-unit', 'unit']];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Per-file seconds measured in one log, by section:
// `job<TAB>step<TAB><ISO time> <text>` lines -> { unit: Map, db: Map }.
function timingsFromLog(text) {
  const found = { unit: new Map(), db: new Map() };
  const serialSteps = new Set();
  const lastResultAt = new Map();
  for (const line of text.split('\n')) {
    const [job, step, rest] = line.split('\t');
    const section = SECTION_BY_JOB.find(([prefix]) => (job || '').startsWith(prefix))?.[1];
    if (rest === undefined || !section) continue;
    const space = rest.indexOf(' ');
    const at = Date.parse(rest.slice(0, space));
    const body = rest.slice(space + 1).trim();
    const stepKey = `${job}\t${step}`;
    if (body.includes('--runInBand')) serialSteps.add(stepKey);
    const match = body.match(RESULT);
    if (!match || Number.isNaN(at)) continue;
    const [, file, printed] = match;
    const previous = lastResultAt.get(stepKey);
    lastResultAt.set(stepKey, at);
    if (printed) found[section].set(file, Number(printed));
    else if (serialSteps.has(stepKey) && previous !== undefined) found[section].set(file, (at - previous) / 1000);
    else found[section].set(file, UNIT_DEFAULT_SECONDS);
  }
  return found;
}

function main(args) {
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const paths = args.filter((_, i) => i !== outIndex && i !== outIndex + 1);
  if (!outPath || !paths.length) {
    process.stderr.write('usage: node server/scripts/ci-shard-timings.js --out <timings.json> <job log>...\n');
    process.exit(2);
  }
  const samples = { unit: new Map(), db: new Map() };
  for (const path of paths) {
    const found = timingsFromLog(fs.readFileSync(path, 'utf8'));
    for (const section of Object.keys(samples)) {
      for (const [file, seconds] of found[section]) {
        if (!samples[section].has(file)) samples[section].set(file, []);
        samples[section].get(file).push(seconds);
      }
    }
  }
  const previous = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const round = (seconds) => Math.round(seconds * 10) / 10;
  const out = {};
  for (const [section, bySection] of Object.entries(samples)) {
    const merged = { ...previous[section]?.files };
    for (const [file, seconds] of bySection) {
      const value = round(median(seconds));
      if (section === 'unit' && value <= UNIT_DEFAULT_SECONDS) delete merged[file];
      else merged[file] = value;
    }
    const files = Object.fromEntries(Object.keys(merged).sort().map((file) => [file, merged[file]]));
    const measured = Object.values(files);
    const defaultSeconds = section === 'unit' || !measured.length ? UNIT_DEFAULT_SECONDS : round(median(measured));
    out[section] = { defaultSeconds, files };
  }
  fs.writeFileSync(`${outPath}.tmp`, `${JSON.stringify(out, null, 2)}\n`);
  fs.renameSync(`${outPath}.tmp`, outPath);
  process.stdout.write(`${outPath}: updated ${samples.unit.size} unit and ${samples.db.size} DB file times; `
    + `${Object.keys(out.unit.files).length} unit and ${Object.keys(out.db.files).length} DB in all\n`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { timingsFromLog, median };
