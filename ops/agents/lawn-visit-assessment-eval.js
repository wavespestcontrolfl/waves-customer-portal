#!/usr/bin/env node
/**
 * lawn-visit-assessment-eval.js — READ-ONLY
 *
 * Stage-2b eval for the single-call lawn visit assessment
 * (server/services/lawn-visit-assessment.js, GATE_LAWN_VISIT_ASSESSMENT). It
 * replays CONFIRMED assessments through the one call and compares what it
 * derives against the scores the technician confirmed and against the legacy
 * two-model AI scores on the same row, so the owner can hand-check findings
 * and numbers before the gate is ever flipped. Scoring lives in
 * server/services/eval/lawn-visit-assessment-eval.js (unit-tested); this file
 * is the I/O.
 *
 * Two phases, because the two things it needs live in two Railway envs:
 *
 *   1. EXPORT (prod Postgres, read-only) — ids, dates, photo keys, confirmed +
 *      legacy AI scores and agronomic context only, as JSON on STDOUT (the
 *      operator redirects it). No names, addresses, phones, notes or photo
 *      bytes ever enter the fixture. Legacy rows have no prompt snapshot or
 *      pre-call timestamp: mutable context is omitted and reported. The
 *      fixture records the export's GATE_LAWN_PROPERTY_HISTORY setting.
 *        railway run --service Postgres node ops/agents/lawn-visit-assessment-eval.js \
 *          --export --ids <id>,<id> --sample 20 > /tmp/lawn-visit-eval-fixture.json
 *
 *   2. RUN (portal env: model keys + S3) — reads photos from S3 by key, makes
 *      LIVE model calls, prints the markdown report on STDOUT (or the full
 *      results JSON with --json); progress goes to stderr.
 *        railway run --service waves-customer-portal node ops/agents/lawn-visit-assessment-eval.js \
 *          --run /tmp/lawn-visit-eval-fixture.json [--thinking LOW|MEDIUM|HIGH] [--force-fallback] \
 *          [--repeat 2] [--concurrency 2] [--ids <id>,…] [--limit N] [--json] > /tmp/lawn-visit-eval-results.md
 *
 * This script never writes a file: READ-ONLY here means stdout only
 * (ops/agents/README.md convention), so the operator chooses what to keep.
 *
 * --force-fallback points the Gemini selector at a model id that does not
 * exist BEFORE the registry loads, so every case misses Gemini and answers on
 * the GPT-6 Astra leg — the way to prove the fallback (and its structured
 * output) works before relying on it.
 *
 * READ-ONLY is enforced, not asserted: the run phase deletes the LLM ledger
 * gates before the first require and ABORTS if any still resolves enabled
 * (compliance-gate-eval.js precedent — `railway run` injects the live env, so
 * inheriting them is the normal case). Nothing here writes to the database or
 * S3, and no customer communication can be reached from this path.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SCORE_COLUMNS = ['turf_density', 'weed_suppression', 'color_health', 'fungus_control', 'thatch_level', 'stress_damage'];
const FIXTURE_VERSION = 1; // Older exports could contain mutable, post-visit prompt context.

// A count flag: a finite positive whole number, or the script stops before
// any export or paid call — `--sample -1` / `--limit -1` sliced almost the
// whole population and `--repeat Infinity` never ended (Codex #4153 r4).
const positiveInt = (flag) => (raw) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) { console.error(`${flag} needs a positive whole number, got ${JSON.stringify(raw ?? null)}`); process.exit(2); }
  return n;
};
// A choice flag: one of the listed values (any case), or the script stops
// the same way — every flag's value is checked where it is read.
const oneOf = (flag, values) => (raw) => {
  const v = String(raw || '').toUpperCase();
  if (!values.includes(v)) { console.error(`${flag} must be ${values.slice(0, -1).join(', ')} or ${values.at(-1)}, got ${JSON.stringify(raw ?? null)}`); process.exit(2); }
  return v;
};
const idsList = (raw) => {
  const value = String(raw ?? '').trim();
  const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
  if (!value || value.startsWith('--') || !ids.length) { console.error(`--ids needs at least one comma-separated id, got ${JSON.stringify(raw ?? null)}`); process.exit(2); }
  return ids;
};

// One row per flag: the args key, whether it takes a value, and how that
// value is read. Boolean flags take none.
const ARG_SPECS = {
  '--export': { key: 'export' },
  '--all': { key: 'all' },
  '--json': { key: 'json' },
  '--force-fallback': { key: 'forceFallback' },
  '--run': { key: 'run', value: true, parse: (v) => v },
  '--ids': { key: 'ids', value: true, parse: idsList },
  '--sample': { key: 'sample', value: true, parse: positiveInt('--sample') },
  '--limit': { key: 'limit', value: true, parse: positiveInt('--limit') },
  '--thinking': { key: 'thinking', value: true, parse: oneOf('--thinking', ['LOW', 'MEDIUM', 'HIGH']) },
  '--repeat': { key: 'repeat', value: true, parse: positiveInt('--repeat') },
  '--concurrency': { key: 'concurrency', value: true, parse: positiveInt('--concurrency') },
};

function parseArgs(argv) {
  const args = { export: false, run: null, ids: [], sample: null, all: false, json: false, thinking: null, forceFallback: false, repeat: 1, concurrency: 2, limit: Infinity };
  for (let i = 2; i < argv.length; i += 1) {
    const spec = ARG_SPECS[argv[i]];
    if (!spec) { console.error(`unknown argument: ${argv[i]}`); process.exit(2); }
    args[spec.key] = spec.value ? spec.parse(argv[++i]) : true;
  }
  // analyzeVisit passes thinkingLevel to the Gemini leg only (the Astra
  // fallback runs at its fixed reasoning effort), so on a forced-fallback run
  // the level would change nothing while labelling every result with it —
  // a thinking-level comparison built on that would be wrong (Codex #4153 r9).
  if (args.forceFallback && args.thinking) { console.error('--thinking has no effect with --force-fallback (only the Gemini leg takes a thinking level) — drop one of them'); process.exit(2); }
  // --sample selects cases at EXPORT; a replay takes the fixture as exported
  // (bounded by --ids / --limit) — accepting it here would look bounded while
  // replaying the whole corpus with paid calls (Codex #4153 r13).
  if (args.run && args.sample) { console.error('--sample is an export option; bound a replay with --ids or --limit'); process.exit(2); }
  return args;
}

// ── Phase 1: export ───────────────────────────────────────────────────
async function exportFixture(args) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres node ops/agents/lawn-visit-assessment-eval.js --export …');
    process.exit(2);
  }
  if (!args.ids.length && !args.sample && !args.all) { console.error('--export needs --ids, --sample N or --all'); process.exit(2); }
  const knexFactory = require('knex');
  const evalLib = require(path.join(REPO, 'server/services/eval/lawn-visit-assessment-eval'));
  const propertyHistoryEnabled = require(path.join(REPO, 'server/config/feature-gates')).gateEnvValue('GATE_LAWN_PROPERTY_HISTORY');
  const knex = knexFactory({ client: 'pg', connection: { connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } }, pool: { min: 0, max: 2 } });
  try {
    // Confirmed rows with at least one stored photo — the population the eval
    // draws from. A run-backed row (produced by the single call itself once
    // the gate is on) is excluded: its composite_scores ARE the new pipeline's
    // derived scores, so it would benchmark a replay against itself, not
    // against the legacy two-model baseline (Codex #4153 r7). A database
    // without the run table yet has no such rows.
    const hasRunTable = await knex.schema.hasTable('lawn_assessment_runs');
    const rows = await knex('lawn_assessments as la')
      .leftJoin('scheduled_services as ss', 'ss.id', 'la.service_id')
      .where('la.confirmed_by_tech', true)
      .whereExists(function () { this.select(1).from('lawn_assessment_photos as p').whereRaw('p.assessment_id = la.id').andWhere('p.s3_key', 'not like', 'pending/%'); })
      // A visit with a failed upload (a `pending/` key) was scored on the full
      // set: a partial replay is not comparable, so the case is out.
      .whereNotExists(function () { this.select(1).from('lawn_assessment_photos as p').whereRaw('p.assessment_id = la.id').andWhere('p.s3_key', 'like', 'pending/%'); })
      .modify((q) => { if (hasRunTable) q.whereNotExists(function () { this.select(1).from('lawn_assessment_runs as r').whereRaw('r.assessment_id = la.id'); }); })
      .select('la.id', 'la.customer_id', 'la.service_id', 'la.service_date', 'la.season', 'la.created_at', 'la.photos', 'la.composite_scores', ...SCORE_COLUMNS.map((c) => `la.${c}`), 'ss.scheduled_date')
      .orderByRaw('COALESCE(ss.scheduled_date, la.service_date) DESC, la.created_at DESC');
    // Selection is the library's tested mechanism: the explicit ids plus the
    // deterministic sample, or the whole population with --all.
    const all = rows.map((row) => evalLib.fixtureCase(row, [], {}));
    const chosen = new Set((args.all ? all : evalLib.selectCases(all, { ids: args.ids, sample: args.sample })).map((c) => c.assessmentId));
    const missing = args.ids.filter((id) => !chosen.has(id));
    if (missing.length) console.error(`warning: ${missing.length} requested id(s) are not confirmed assessments with stored photos and were skipped`);
    const cases = [];
    for (const row of rows.filter((r) => chosen.has(r.id))) {
      // Each case's photos load with the case — one small query per exported row.
      const photos = await knex('lawn_assessment_photos').where({ assessment_id: row.id }).orderBy('photo_order').select('id', 's3_key', 'mime_type', 'photo_order', 'zone');
      // The legacy population has neither a prompt snapshot nor a pre-call
      // timestamp. created_at is AFTER analysis; subtracting a guessed call
      // duration cannot prove that a current profile/customer/summary value
      // was read by the original model. Completion turf readings are editable
      // after Analyze too. Omit these fields instead of replaying later data.
      cases.push(evalLib.fixtureCase(row, photos, {
        omitted: ['grassType', 'irrigation', 'turfHeightIn', 'priorSummary', 'technicianNotes'].map((field) => ({ field, reason: 'legacy_assessment_has_no_prompt_snapshot' })),
      }));
    }
    const fixture = { fixtureVersion: FIXTURE_VERSION, generatedAt: new Date().toISOString(), propertyHistory: propertyHistoryEnabled, population: all.length, cases };
    const omittedCases = cases.filter((c) => c.context.omitted.length).length;
    console.error(`context omitted (not provably visit-time) in ${omittedCases} of ${cases.length} case(s)${omittedCases ? `: ${Object.entries(cases.flatMap((c) => c.context.omitted).reduce((acc, o) => ({ ...acc, [o.field]: (acc[o.field] || 0) + 1 }), {})).map(([f, n]) => `${f} ×${n}`).join(', ')}` : ''}`);
    console.error(`exported ${cases.length} case(s) of ${all.length} confirmed assessments with photos · export property history ${propertyHistoryEnabled ? 'on' : 'off'} · photos ${cases.reduce((n, c) => n + c.photos.length, 0)} · zone-labeled ${cases.reduce((n, c) => n + c.photos.filter((p) => p.zone).length, 0)}`);
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await knex.destroy();
  }
}

// ── Phase 2: run ──────────────────────────────────────────────────────
// The ledger gates are read at CALL time (feature-gates), so the promise is
// checked after every import that could set them: server/config loads the
// checkout's .env (dotenv fills MISSING variables — a deleted gate would come
// back), so it loads FIRST, then the gates are cleared, then verified, and
// verified again once every module the replay uses is loaded (Codex #4153
// r11). A promise that can be broken by moving a line is not a promise
// (compliance-gate-eval.js precedent).
const LEDGER_GATES = ['GATE_LLM_DISPATCH_METRICS', 'GATE_LLM_CALL_LEDGER', 'GATE_LLM_CALL_TRACES'];
function assertNoLedgerWrites(gates, when) {
  if (gates.isEnabled('llmDispatchMetrics') || gates.gateEnvValue('GATE_LLM_CALL_LEDGER') || gates.gateEnvValue('GATE_LLM_CALL_TRACES')) {
    console.error(`ABORT (${when}): an LLM ledger gate resolved ENABLED — this run would write llm_dispatch_log rows. Unset ${LEDGER_GATES.join(' / ')} and re-run.`);
    process.exit(2);
  }
}

function configureReplayLogging() {
  const winston = require('winston');
  const logger = require(path.join(REPO, 'server/services/logger'));
  // stdout is the report document, including when a provider warns or fails.
  logger.clear().add(new winston.transports.Console({ stderrLevels: Object.keys(winston.config.npm.levels) }));
}

async function runReplay(args) {
  // NO DB WRITES. The dispatcher's ledger + chain rows are written whenever
  // these gates resolve enabled. server/config (dotenv) loads before the
  // gates are cleared, so nothing can refill them afterwards.
  const config = require(path.join(REPO, 'server/config'));
  configureReplayLogging();
  for (const gate of LEDGER_GATES) delete process.env[gate];
  // The registry reads the selector at load: a nonexistent Gemini id makes
  // every primary leg miss so the GPT-6 Astra fallback carries the run.
  if (args.forceFallback) process.env.MODEL_GEMINI_VISION = 'gemini-eval-forced-miss';

  const gates = require(path.join(REPO, 'server/config/feature-gates'));
  assertNoLedgerWrites(gates, 'before imports');
  if (!config.s3?.bucket) { console.error('S3 is not configured in this environment — run via: railway run --service waves-customer-portal node ops/agents/lawn-visit-assessment-eval.js --run …'); process.exit(2); }
  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) console.error('warning: no Gemini key — every primary leg will miss (no_key)');
  if (!process.env.OPENAI_API_KEY) console.error('warning: no OpenAI key — the GPT-6 Astra fallback cannot answer (no_key)');

  const MODELS = require(path.join(REPO, 'server/config/models'));
  const PhotoService = require(path.join(REPO, 'server/services/photos'));
  const visit = require(path.join(REPO, 'server/services/lawn-visit-assessment'));
  const { PROMPT_VERSION, PROMPT_DIGEST } = require(path.join(REPO, 'server/services/lawn-visit-input'));
  const evalLib = require(path.join(REPO, 'server/services/eval/lawn-visit-assessment-eval'));
  assertNoLedgerWrites(gates, 'after imports');

  const fixture = JSON.parse(fs.readFileSync(args.run, 'utf8'));
  if (fixture?.fixtureVersion !== FIXTURE_VERSION || !Array.isArray(fixture.cases)) {
    throw new Error('Unsupported evaluation fixture; re-export with this version before replaying. Older exports may contain unproven prompt context.');
  }
  const cases = evalLib.selectCases(fixture.cases, { ids: args.ids }).slice(0, args.limit);
  if (!cases.length) { console.error('no cases selected'); process.exit(2); }
  const policy = MODELS.TEXT_POLICIES.lawnVisitAssessment;
  // What this replay varies from the production policy, named once — on the
  // progress line and in the report's title.
  const variant = [args.forceFallback ? 'forced fallback (Gemini made to miss)' : '', args.thinking ? `thinking ${args.thinking}` : ''].filter(Boolean).map((v) => ` · ${v}`).join('');
  console.error(`replaying ${cases.length} case(s) × ${args.repeat} · policy ${policy.primary.provider}:${policy.primary.model} → ${policy.fallback.provider}:${policy.fallback.model}${variant}`);

  const { results, skipped, summary } = await evalLib.runEval(cases, {
    analyzeVisit: (input) => visit.analyzeVisit(input),
    loadPhoto: (s3Key) => PhotoService.getPhotoBase64(s3Key),
    log: (line) => console.error(line),
  }, { repeat: args.repeat, concurrency: args.concurrency, thinkingLevel: args.thinking });

  const title = `Lawn visit assessment eval — ${PROMPT_VERSION}${variant}`;
  // Every output format carries the fixture's property-history branch and the prompt digest (see renderMarkdown).
  const propertyHistory = typeof fixture.propertyHistory === 'boolean' ? fixture.propertyHistory : null;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      generatedAt: new Date().toISOString(), promptVersion: PROMPT_VERSION, promptDigest: PROMPT_DIGEST, propertyHistory,
      policy, options: { thinking: args.thinking, forceFallback: args.forceFallback, repeat: args.repeat, concurrency: args.concurrency },
      summary, skipped, results,
    }, null, 2)}\n`);
    return;
  }
  console.log(evalLib.renderMarkdown(summary, results, { title, promptVersion: PROMPT_VERSION, promptDigest: PROMPT_DIGEST, propertyHistory }));
  if (skipped.length) console.log(`\nskipped: ${skipped.map((s) => `${String(s.assessmentId).slice(0, 8)} (${s.reason})`).join(', ')}`);
}

if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv);
    if (args.export) await exportFixture(args);
    else if (args.run) await runReplay(args);
    else { console.error('nothing to do: pass --export … or --run <fixture.json> (see the header for both recipes)'); process.exit(2); }
  })().catch((err) => {
    console.error(`eval failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { _internals: { parseArgs, ARG_SPECS, exportFixture, runReplay, configureReplayLogging } };
