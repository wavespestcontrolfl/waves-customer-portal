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
 *      legacy AI scores and agronomic context only. No names, addresses,
 *      phones, notes or photo bytes ever enter the fixture file.
 *        railway run --service Postgres node ops/agents/lawn-visit-assessment-eval.js \
 *          --export --ids <id>,<id> --sample 20 --out /tmp/lawn-visit-eval-fixture.json
 *
 *   2. RUN (portal env: model keys + S3) — reads photos from S3 by key, makes
 *      LIVE model calls, prints the markdown report, optionally saves JSON.
 *        railway run --service waves-customer-portal node ops/agents/lawn-visit-assessment-eval.js \
 *          --run /tmp/lawn-visit-eval-fixture.json [--thinking LOW|MEDIUM|HIGH] [--force-fallback] \
 *          [--repeat 2] [--concurrency 2] [--ids <id>,…] [--limit N] [--out /tmp/lawn-visit-eval-results.json]
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

function parseArgs(argv) {
  const args = { export: false, run: null, ids: [], sample: null, all: false, out: null, thinking: null, forceFallback: false, repeat: 1, concurrency: 2, limit: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--export') args.export = true;
    else if (a === '--run') args.run = next();
    else if (a === '--ids') args.ids = String(next() || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--sample') args.sample = Number(next());
    else if (a === '--all') args.all = true;
    else if (a === '--out') args.out = next();
    else if (a === '--thinking') args.thinking = String(next() || '').toUpperCase();
    else if (a === '--force-fallback') args.forceFallback = true;
    else if (a === '--repeat') args.repeat = Math.max(1, Number(next()) || 1);
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(next()) || 1);
    else if (a === '--limit') args.limit = Number(next());
    else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  return args;
}

// ── Phase 1: export ───────────────────────────────────────────────────
async function exportFixture(args) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres node ops/agents/lawn-visit-assessment-eval.js --export …');
    process.exit(2);
  }
  if (!args.out) { console.error('--export needs --out <fixture.json>'); process.exit(2); }
  if (!args.ids.length && !args.sample && !args.all) { console.error('--export needs --ids, --sample N or --all'); process.exit(2); }
  const { Client } = require('pg');
  const evalLib = require(path.join(REPO, 'server/services/eval/lawn-visit-assessment-eval'));
  const { GRASS_TYPE_LABELS, normalizeGrassType } = require(path.join(REPO, 'server/services/lawn-grass-context'));
  const client = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // Confirmed rows with at least one stored photo — the population the eval draws from.
    const { rows } = await client.query(`
      SELECT la.id, la.customer_id, la.service_id, la.service_date, la.season, la.observations, la.composite_scores,
             ${SCORE_COLUMNS.map((c) => `la.${c}`).join(', ')},
             ss.scheduled_date, ctp.grass_type, ctp.irrigation_type, ctp.irrigation_inches_per_week
        FROM lawn_assessments la
        LEFT JOIN scheduled_services ss ON ss.id = la.service_id
        LEFT JOIN customer_turf_profiles ctp ON ctp.customer_id = la.customer_id
       WHERE la.confirmed_by_tech = true
         AND EXISTS (SELECT 1 FROM lawn_assessment_photos p WHERE p.assessment_id = la.id AND p.s3_key NOT LIKE 'pending/%')
       ORDER BY COALESCE(ss.scheduled_date, la.service_date) DESC, la.created_at DESC`);
    const all = rows.map((row) => evalLib.fixtureCase(row, [], {}));
    const chosen = new Map();
    for (const c of evalLib.selectCases(all, { ids: args.ids })) chosen.set(c.assessmentId, c);
    if (args.sample) for (const c of evalLib.selectCases(all, { sample: args.sample })) chosen.set(c.assessmentId, c);
    if (args.all) for (const c of all) chosen.set(c.assessmentId, c);
    const missing = args.ids.filter((id) => !chosen.has(id));
    if (missing.length) console.error(`warning: ${missing.length} requested id(s) are not confirmed assessments with stored photos and were skipped`);
    const ids = [...chosen.keys()];
    const { rows: photos } = await client.query(
      'SELECT id, assessment_id, s3_key, mime_type, photo_order, zone FROM lawn_assessment_photos WHERE assessment_id = ANY($1::uuid[]) ORDER BY photo_order',
      [ids],
    );
    const byAssessment = new Map();
    for (const p of photos) { if (!byAssessment.has(p.assessment_id)) byAssessment.set(p.assessment_id, []); byAssessment.get(p.assessment_id).push(p); }
    const cases = [];
    for (const row of rows.filter((r) => chosen.has(r.id))) {
      // The previous visit's summary as the route would have seen it: the latest
      // earlier confirmed row of the same customer with a summary.
      const visitDate = String(row.scheduled_date || row.service_date).slice(0, 10);
      const { rows: prior } = await client.query(`
        SELECT p.ai_summary FROM lawn_assessments p LEFT JOIN scheduled_services pss ON pss.id = p.service_id
         WHERE p.customer_id = $1 AND p.id <> $2 AND p.ai_summary IS NOT NULL AND p.confirmed_by_tech = true
           AND COALESCE(pss.scheduled_date, p.service_date) < $3::date
         ORDER BY COALESCE(pss.scheduled_date, p.service_date) DESC LIMIT 1`, [row.customer_id, row.id, visitDate]);
      const grassKey = normalizeGrassType(row.grass_type);
      const irrigation = [];
      if (row.irrigation_type) irrigation.push(String(row.irrigation_type).replace(/_/g, ' '));
      if (row.irrigation_inches_per_week != null) irrigation.push(`${row.irrigation_inches_per_week} in/wk`);
      cases.push(evalLib.fixtureCase(row, byAssessment.get(row.id) || [], {
        grassType: grassKey && grassKey !== 'unknown' ? (GRASS_TYPE_LABELS[grassKey] || grassKey) : null,
        irrigation: irrigation.join(', ') || null,
        priorSummary: prior[0]?.ai_summary || null,
      }));
    }
    const fixture = { generatedAt: new Date().toISOString(), population: all.length, cases };
    fs.writeFileSync(args.out, JSON.stringify(fixture, null, 2));
    console.log(`exported ${cases.length} case(s) of ${all.length} confirmed assessments with photos → ${args.out}`);
    console.log(`photos: ${cases.reduce((s, c) => s + c.photos.length, 0)} · zone-labeled: ${cases.reduce((s, c) => s + c.photos.filter((p) => p.zone).length, 0)}`);
  } finally {
    await client.end();
  }
}

// ── Phase 2: run ──────────────────────────────────────────────────────
async function runReplay(args) {
  // NO DB WRITES. The dispatcher's ledger + chain rows are written whenever
  // these gates resolve enabled; delete BEFORE the first require (feature-gates
  // snapshots at load) and verify after — a promise that can be broken by
  // moving a line is not a promise (compliance-gate-eval.js precedent).
  delete process.env.GATE_LLM_DISPATCH_METRICS;
  delete process.env.GATE_LLM_CALL_LEDGER;
  delete process.env.GATE_LLM_CALL_TRACES;
  // The registry reads the selector at load: a nonexistent Gemini id makes
  // every primary leg miss so the GPT-6 Astra fallback carries the run.
  if (args.forceFallback) process.env.MODEL_GEMINI_VISION = 'gemini-eval-forced-miss';

  const gates = require(path.join(REPO, 'server/config/feature-gates'));
  if (gates.isEnabled('llmDispatchMetrics') || gates.gateEnvValue('GATE_LLM_CALL_LEDGER') || gates.gateEnvValue('GATE_LLM_CALL_TRACES')) {
    console.error('ABORT: an LLM ledger gate resolved ENABLED — this run would write llm_dispatch_log rows. Unset GATE_LLM_DISPATCH_METRICS / GATE_LLM_CALL_LEDGER / GATE_LLM_CALL_TRACES and re-run.');
    process.exit(2);
  }
  if (args.thinking && !['LOW', 'MEDIUM', 'HIGH'].includes(args.thinking)) { console.error('--thinking must be LOW, MEDIUM or HIGH'); process.exit(2); }
  const config = require(path.join(REPO, 'server/config'));
  if (!config.s3?.bucket) { console.error('S3 is not configured in this environment — run via: railway run --service waves-customer-portal node ops/agents/lawn-visit-assessment-eval.js --run …'); process.exit(2); }
  if (!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) console.error('warning: no Gemini key — every primary leg will miss (no_key)');
  if (!process.env.OPENAI_API_KEY) console.error('warning: no OpenAI key — the GPT-6 Astra fallback cannot answer (no_key)');

  const MODELS = require(path.join(REPO, 'server/config/models'));
  const PhotoService = require(path.join(REPO, 'server/services/photos'));
  const visit = require(path.join(REPO, 'server/services/lawn-visit-assessment'));
  const evalLib = require(path.join(REPO, 'server/services/eval/lawn-visit-assessment-eval'));

  const fixture = JSON.parse(fs.readFileSync(args.run, 'utf8'));
  let cases = evalLib.selectCases(fixture.cases || [], { ids: args.ids });
  if (args.limit) cases = cases.slice(0, args.limit);
  if (!cases.length) { console.error('no cases selected'); process.exit(2); }
  const policy = MODELS.TEXT_POLICIES.lawnVisitAssessment;
  console.error(`replaying ${cases.length} case(s) × ${args.repeat} · policy ${policy.primary.provider}:${policy.primary.model} → ${policy.fallback.provider}:${policy.fallback.model}${args.forceFallback ? ' (Gemini FORCED to miss)' : ''}${args.thinking ? ` · thinking ${args.thinking}` : ''}`);

  const { results, skipped, summary } = await evalLib.runEval(cases, {
    analyzeVisit: (input) => visit.analyzeVisit(input),
    loadPhoto: (s3Key) => PhotoService.getPhotoBase64(s3Key),
    log: (line) => console.error(line),
  }, { repeat: args.repeat, concurrency: args.concurrency, thinkingLevel: args.thinking || undefined });

  const title = `Lawn visit assessment eval — ${visit.PROMPT_VERSION}${args.forceFallback ? ' · forced fallback' : ''}${args.thinking ? ` · thinking ${args.thinking}` : ''}`;
  console.log(evalLib.renderMarkdown(summary, results, { title }));
  if (skipped.length) console.log(`\nskipped: ${skipped.map((s) => `${String(s.assessmentId).slice(0, 8)} (${s.reason})`).join(', ')}`);
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify({
      generatedAt: new Date().toISOString(), promptVersion: visit.PROMPT_VERSION,
      policy, options: { thinking: args.thinking, forceFallback: args.forceFallback, repeat: args.repeat, concurrency: args.concurrency },
      summary, skipped, results,
    }, null, 2));
    console.error(`results → ${args.out}`);
  }
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.export) await exportFixture(args);
  else if (args.run) await runReplay(args);
  else { console.error('nothing to do: pass --export … or --run <fixture.json> (see the header for both recipes)'); process.exit(2); }
})().catch((err) => {
  console.error(`eval failed: ${err.message}`);
  process.exit(1);
});
