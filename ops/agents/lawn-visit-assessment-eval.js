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
 *      bytes ever enter the fixture. Context is rebuilt the way the live route
 *      builds it: the canonical grass-context loaders, the prior summary on
 *      the route's GATE_LAWN_PROPERTY_HISTORY branch (the fixture records it).
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

// One row per flag: the args key, whether it takes a value, and how that
// value is read. Boolean flags take none.
const ARG_SPECS = {
  '--export': { key: 'export' },
  '--all': { key: 'all' },
  '--json': { key: 'json' },
  '--force-fallback': { key: 'forceFallback' },
  '--run': { key: 'run', value: true, parse: (v) => v },
  '--ids': { key: 'ids', value: true, parse: (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean) },
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
  // The same loaders the live route uses, so the replay context is the
  // context the assessment actually received: active-profile grass with the
  // legacy customers.lawn_type fallback, and the previous visit's summary on
  // the SAME gate branch the route takes — property- and reset-scoped with
  // GATE_LAWN_PROPERTY_HISTORY on (never another lawn's summary), the legacy
  // customer-wide lookup off. The gate is read the way the route reads it,
  // so set it on the `railway run` command line to export the other
  // configuration; the fixture records which branch it took.
  const { loadPriorSummary } = require(path.join(REPO, 'server/services/lawn-grass-context'));
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
    const hasServiceRecordColumn = await knex.schema.hasColumn('lawn_assessments', 'service_record_id');
    const rows = await knex('lawn_assessments as la')
      .leftJoin('scheduled_services as ss', 'ss.id', 'la.service_id')
      .where('la.confirmed_by_tech', true)
      .whereExists(function () { this.select(1).from('lawn_assessment_photos as p').whereRaw('p.assessment_id = la.id').andWhere('p.s3_key', 'not like', 'pending/%'); })
      // A visit with a failed upload (a `pending/` key) was scored on the full
      // set: a partial replay is not comparable, so the case is out.
      .whereNotExists(function () { this.select(1).from('lawn_assessment_photos as p').whereRaw('p.assessment_id = la.id').andWhere('p.s3_key', 'like', 'pending/%'); })
      .modify((q) => { if (hasRunTable) q.whereNotExists(function () { this.select(1).from('lawn_assessment_runs as r').whereRaw('r.assessment_id = la.id'); }); })
      .select('la.id', 'la.customer_id', 'la.service_id', 'la.service_date', 'la.season', 'la.created_at', 'la.photos', 'la.composite_scores', ...SCORE_COLUMNS.map((c) => `la.${c}`), 'ss.scheduled_date', ...(hasServiceRecordColumn ? ['la.service_record_id'] : []))
      .orderByRaw('COALESCE(ss.scheduled_date, la.service_date) DESC, la.created_at DESC');
    // Selection is the library's tested mechanism: the explicit ids plus the
    // deterministic sample, or the whole population with --all.
    const all = rows.map((row) => evalLib.fixtureCase(row, [], {}));
    const chosen = new Set((args.all ? all : evalLib.selectCases(all, { ids: args.ids, sample: args.sample })).map((c) => c.assessmentId));
    const missing = args.ids.filter((id) => !chosen.has(id));
    if (missing.length) console.error(`warning: ${missing.length} requested id(s) are not confirmed assessments with stored photos and were skipped`);
    const cases = [];
    for (const row of rows.filter((r) => chosen.has(r.id))) {
      const visitDate = evalLib.dateString(row.scheduled_date) || evalLib.dateString(row.service_date);
      const scheduledService = row.service_id ? await knex('scheduled_services').where({ id: row.service_id }).first() : null;
      // Each case's photos load with the case — one small query per exported row.
      const [photos, irrigation, customer, prior, turfHeight] = await Promise.all([
        knex('lawn_assessment_photos').where({ assessment_id: row.id }).orderBy('photo_order').select('id', 's3_key', 'mime_type', 'photo_order', 'zone'),
        loadVisitIrrigation(row, knex),
        knex('customers').where({ id: row.customer_id }).first('first_name', 'last_name'),
        loadPriorSummary({ customerId: row.customer_id, serviceId: row.service_id, scheduledService, visitDate, propertyHistoryEnabled }, knex).catch((err) => { console.error(`warning: prior-visit summary failed for ${row.id}: ${err.message}`); return null; }),
        loadVisitTurfHeight(row, knex),
      ]);
      cases.push(evalLib.fixtureCase(row, photos, {
        grassType: await loadVisitGrassType(row, knex),
        irrigation,
        turfHeightIn: turfHeight,
        // Scrubbed in fixtureCase: the summary was written with the customer's name in the prompt.
        priorSummary: prior,
        customerNames: [customer?.first_name, customer?.last_name],
      }));
    }
    const fixture = { generatedAt: new Date().toISOString(), propertyHistory: propertyHistoryEnabled, population: all.length, cases };
    console.error(`exported ${cases.length} case(s) of ${all.length} confirmed assessments with photos · prior summary ${propertyHistoryEnabled ? 'property-scoped (GATE_LAWN_PROPERTY_HISTORY on)' : 'legacy customer-wide (GATE_LAWN_PROPERTY_HISTORY off)'} · photos ${cases.reduce((n, c) => n + c.photos.length, 0)} · zone-labeled ${cases.reduce((n, c) => n + c.photos.filter((p) => p.zone).length, 0)}`);
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
  } finally {
    await knex.destroy();
  }
}

// The grass type the route could have known AT THE VISIT. /assess auto-captures
// the model's own grass read into customer_turf_profiles after scoring — and
// touches the row's updated_at even when COALESCE keeps an existing value —
// so the timestamp cannot tell a pre-existing value from this assessment's
// outcome (Codex #4153 r8, r13). What can: the capture only ever FILLS a
// blank, so a profile row that already EXISTED before the assessment
// (created_at earlier than la.created_at — intake and estimates create it
// with the grass) is the value the route read; a row this or a later
// assessment created is that capture. Otherwise the legacy
// customers.lawn_type (never written by /assess), or nothing.
async function loadVisitGrassType(row, knex) {
  const { grassTypeLabel, normalizeGrassType } = require(path.join(REPO, 'server/services/lawn-grass-context'));
  const profile = await visitTimeProfile(row, knex);
  const customer = profile?.grass_type ? null : await knex('customers').where({ id: row.customer_id }).first('lawn_type');
  const grassType = profile?.grass_type || normalizeGrassType(customer?.lawn_type) || null;
  return grassType ? grassTypeLabel(grassType) : null;
}

// The customer's turf profile when it provably existed before this
// assessment; null otherwise.
async function visitTimeProfile(row, knex) {
  const assessedAt = row.created_at ? new Date(row.created_at) : null;
  const profile = await knex('customer_turf_profiles').where({ customer_id: row.customer_id, active: true }).first('grass_type', 'irrigation_type', 'irrigation_inches_per_week', 'created_at').catch(() => null);
  if (!profile || !assessedAt || !profile.created_at || !(new Date(profile.created_at) < assessedAt)) return null;
  return profile;
}

// The irrigation line the route could have known AT THE VISIT. Both of its
// sources live on customer_turf_profiles (irrigation_type,
// irrigation_inches_per_week); the only assessment writer of those fields is
// a confirm's protocol field checks (persistProtocolFieldChecks), which also
// stamp the same inches on the confirming assessment row. So the profile's
// irrigation is visit-time when the profile existed before this assessment
// AND no assessment of this customer created at or after it recorded
// irrigation checks — the assessment ledger proves it where the profile's
// updated_at (touched by every grass capture) cannot (Codex #4153 r11, r13).
// Formatted as lawn-grass-context's loadIrrigationContext formats it.
async function loadVisitIrrigation(row, knex) {
  const profile = await visitTimeProfile(row, knex);
  if (!profile) return null;
  const hasInches = await knex.schema.hasColumn('lawn_assessments', 'irrigation_inches_per_week');
  if (hasInches) {
    const later = await knex('lawn_assessments').where({ customer_id: row.customer_id }).where('created_at', '>=', row.created_at).whereNotNull('irrigation_inches_per_week').first('id');
    if (later) return null;
  }
  const parts = [];
  if (profile.irrigation_type) parts.push(String(profile.irrigation_type).replace(/_/g, ' '));
  if (profile.irrigation_inches_per_week != null) parts.push(`${profile.irrigation_inches_per_week} in/wk`);
  return parts.length ? parts.join(', ') : null;
}

// The gauge reading the visit's completion recorded: turf_height_readings
// keys on the service record (one per completion), reached through the
// assessment's own back-link or, for a row completed before the back-link
// existed, the scheduled service's latest record. Null when the visit
// recorded none — the route's visionContext omits the line the same way.
async function loadVisitTurfHeight(row, knex) {
  let serviceRecordId = row.service_record_id || null;
  if (!serviceRecordId && row.service_id) {
    const record = await knex('service_records').where({ scheduled_service_id: row.service_id }).orderBy('created_at', 'desc').first('id');
    serviceRecordId = record?.id || null;
  }
  if (!serviceRecordId) return null;
  const reading = await knex('turf_height_readings').where({ service_record_id: serviceRecordId }).first('manual_height_in').catch(() => null);
  return reading?.manual_height_in ?? null;
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

async function runReplay(args) {
  // NO DB WRITES. The dispatcher's ledger + chain rows are written whenever
  // these gates resolve enabled. server/config (dotenv) loads before the
  // gates are cleared, so nothing can refill them afterwards.
  const config = require(path.join(REPO, 'server/config'));
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
  const evalLib = require(path.join(REPO, 'server/services/eval/lawn-visit-assessment-eval'));
  assertNoLedgerWrites(gates, 'after imports');

  const fixture = JSON.parse(fs.readFileSync(args.run, 'utf8'));
  const cases = evalLib.selectCases(fixture.cases || [], { ids: args.ids }).slice(0, args.limit);
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

  const title = `Lawn visit assessment eval — ${visit.PROMPT_VERSION}${variant}`;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      generatedAt: new Date().toISOString(), promptVersion: visit.PROMPT_VERSION, promptDigest: visit.PROMPT_DIGEST,
      policy, options: { thinking: args.thinking, forceFallback: args.forceFallback, repeat: args.repeat, concurrency: args.concurrency },
      summary, skipped, results,
    }, null, 2)}\n`);
    return;
  }
  console.log(evalLib.renderMarkdown(summary, results, { title }));
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

module.exports = { _internals: { parseArgs, ARG_SPECS } };
