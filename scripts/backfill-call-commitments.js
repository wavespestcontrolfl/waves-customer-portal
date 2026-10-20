#!/usr/bin/env node
/**
 * One-off backfill for the call promise tracker (call_commitments).
 *
 * Why: the commitments model pass called Anthropic only. The Anthropic monthly
 * limit was hit on 2026-10-15 and every request returned 400 until about
 * 10-19, so calls with a spoken staff promise got no call_commitments row (call
 * audit 2026-10-19). The pass now falls back to OpenAI; this script re-runs it
 * for the calls it missed.
 *
 *   node scripts/backfill-call-commitments.js --from 2026-10-15 --to 2026-10-18
 *       DRY RUN (default): one READ ONLY transaction, prints what would run.
 *   node scripts/backfill-call-commitments.js --from 2026-10-15 --to 2026-10-18 --apply
 *       Runs the pipeline's own commitments step for each call, one at a time.
 *   --limit N   cap candidate calls (default 100, either mode)
 *
 * --from / --to are inclusive ET calendar dates (YYYY-MM-DD).
 *
 * OWNER NOTE: --apply replays each stored transcript to the model provider
 * (Anthropic first, OpenAI if it cannot answer). The owner approved this one
 * replay on 2026-10-19.
 *
 * Candidates: calls created in the range that are processed (not spam, not
 * voicemail, not a voice-relay sandbox call), hold no processing claim, have a
 * stored transcript, and have NO call_commitments row of any kind. No durable
 * marker records a skipped model pass (the pipeline only logs it), so "no rows
 * at all" is the criterion. A call whose model pass failed but whose
 * deterministic seed wrote a row is NOT found by this script.
 *
 * It does not write rows itself. Apply calls recordCommitmentsStep from
 * call-recording-processor.js, the exact function the pipeline runs after
 * finalization, which goes through recordCallCommitments and upsertCommitments:
 * the per-call advisory lock, the processing_generation fence and the
 * recording_sid fence all apply. A call a live pass claimed meanwhile is
 * skipped by that fence (written 0, no row). Re-running is safe: a call that
 * gained a row drops out of the candidate list.
 *
 * Output is call id (first 8 characters), ET date and counts only. No
 * transcript text, names or phone numbers are ever printed.
 */
require('dotenv').config();

const { parseETDateTime, etDateString } = require('../server/utils/datetime-et');

const DEFAULT_LIMIT = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Model outcomes that mean the replay did not get an answer.
const FAILED_SKIPS = new Set(['model_failed', 'parse_failed', 'schema_failed', 'no_provider']);
const MIN_TRANSCRIPT_CHARS = 40; // mirrors extractCommitmentsWithModel's own floor

const id8 = (id) => String(id).slice(0, 8);

function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };
  const limit = Number.parseInt(val('--limit'), 10);
  return {
    from: val('--from'),
    to: val('--to'),
    apply: argv.includes('--apply'),
    limit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT,
  };
}

// [start, end) in UTC instants for inclusive ET dates. The end is the ET
// midnight after `to`, found by reading the next calendar day as ET.
// A real calendar date only: 2026-00-01 or 2026-02-30 would normalize to
// another day and replay calls outside the approved range (Codex #6346 r1).
function realDate(d) {
  if (!DATE_RE.test(String(d))) return false;
  const t = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  return t.toISOString().slice(0, 10) === d;
}

function etRange(from, to) {
  if (!realDate(from) || !realDate(to)) throw new Error('--from and --to must be real ET dates (YYYY-MM-DD)');
  const start = parseETDateTime(`${from}T00:00:00`);
  const next = new Date(Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10) + 1));
  const nextDay = next.toISOString().slice(0, 10);
  const end = parseETDateTime(`${nextDay}T00:00:00`);
  if (!(start < end)) throw new Error('--from must not be after --to');
  return { start, end };
}

// Read-only. Same exclusions the pipeline uses for "a live two-way call":
// voicemail by call_outcome / answered_by / processing_status, spam by
// processing_status, the relay sandbox source, and a held processing claim.
function candidateQuery(dbh, { start, end, limit }) {
  const { whereNotSandboxCall } = require('../server/services/voice-agent/relay-protocol');
  return dbh('call_log as c')
    .modify((q) => whereNotSandboxCall(q, 'c.source'))
    .where('c.created_at', '>=', start)
    .where('c.created_at', '<', end)
    .where('c.processing_status', 'processed')
    .whereNull('c.processing_token')
    .whereRaw("COALESCE(c.call_outcome, '') <> 'voicemail'")
    .whereRaw("COALESCE(c.answered_by, '') <> 'voicemail'")
    .whereRaw("COALESCE(c.ai_extraction_enriched ->> 'call_nature', '') <> 'voicemail_message'")
    .whereRaw('LENGTH(COALESCE(c.transcription, \'\')) >= ?', [MIN_TRANSCRIPT_CHARS])
    .whereNotExists(function none() {
      this.select(dbh.raw('1')).from('call_commitments as cc').whereRaw('cc.call_log_id = c.id');
    })
    .orderBy('c.created_at', 'asc')
    .limit(limit)
    .select('c.id', 'c.created_at');
}

const findCandidates = (dbh, args) => candidateQuery(dbh, args);

// The pipeline's own post-finalization step, fed the way processRecording
// feeds it: the stored (already scrubbed) transcription, the valid V2
// extraction if there is one, and the call's current processing_generation.
async function runPipelineStep(dbh, id, { recordCommitmentsStep }) {
  const call = await dbh('call_log').where({ id }).first();
  if (!call || call.processing_status !== 'processed' || call.processing_token || !call.transcription) return { ran: false, reason: 'not_eligible_now' };
  const already = await dbh('call_commitments').where({ call_log_id: id }).first('id');
  if (already) return { ran: false, reason: 'row_exists_now' };
  const v2Result = call.v2_extraction_status === 'valid' && call.ai_extraction_enriched
    ? { status: 'valid', extraction: call.ai_extraction_enriched }
    : null;
  const summary = await recordCommitmentsStep({
    call,
    callSid: call.twilio_call_sid || null,
    transcription: call.transcription,
    extracted: { is_spam: false },
    v2Result,
    procGeneration: call.processing_generation ?? null,
  });
  // A provider/model failure, a write error or a lost claim is a FAILED replay,
  // never "nothing promised" (Codex #6346 r1). A step that did not run at all
  // (gate off, spam) returns null.
  const failure = !summary ? 'step_did_not_run'
    : summary.error ? 'write_failed'
      : summary.ownershipLost ? 'superseded'
        : FAILED_SKIPS.has(summary.skipped) ? summary.skipped : null;
  if (failure) return { ran: false, failed: true, reason: failure };
  const rows = await dbh('call_commitments').where({ call_log_id: id }).count({ n: '*' }).first();
  return { ran: true, rows: Number(rows?.n || 0) };
}

async function run({ dbh, from, to, apply = false, limit = DEFAULT_LIMIT, log = console.log, find = findCandidates, step = runPipelineStep, gateLive = null } = {}) {
  const { start, end } = etRange(from, to);
  const totals = { candidates: 0, ran: 0, withRows: 0, noRows: 0, skipped: 0, failed: 0 };
  let candidates;
  // Dry run (and the candidate read of an apply) is one READ ONLY transaction.
  await dbh.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION READ ONLY');
    candidates = await find(trx, { start, end, limit });
  });
  totals.candidates = candidates.length;
  log(`${apply ? 'APPLY' : 'DRY RUN (no writes)'}: ${candidates.length} candidate call(s), ET ${from} to ${to}, limit ${limit}`);

  if (!apply) {
    for (const c of candidates) log(`  would run  ${id8(c.id)}  ${etDateString(new Date(c.created_at))}`);
    log('  Nothing was written. Re-run with --apply to replay these transcripts to the model provider.');
    return totals;
  }

  const live = gateLive === null ? require('../server/config/feature-gates').isEnabled('callCommitments') : gateLive;
  if (!live) {
    log('  GATE_CALL_COMMITMENTS is not live here: the pipeline step would write nothing. Stopping.');
    totals.failed = candidates.length;
    return totals;
  }
  const deps = step === runPipelineStep ? { recordCommitmentsStep: require('../server/services/call-recording-processor').recordCommitmentsStep } : {};
  for (const c of candidates) {
    try {
      const out = await step(dbh, c.id, deps);
      if (out.failed) {
        totals.failed += 1;
        log(`  failed     ${id8(c.id)}  ${etDateString(new Date(c.created_at))}  ${out.reason}`);
        continue;
      }
      if (!out.ran) {
        totals.skipped += 1;
        log(`  skipped    ${id8(c.id)}  ${etDateString(new Date(c.created_at))}  ${out.reason}`);
        continue;
      }
      totals.ran += 1;
      if (out.rows > 0) totals.withRows += 1; else totals.noRows += 1;
      log(`  ran        ${id8(c.id)}  ${etDateString(new Date(c.created_at))}  rows=${out.rows}`);
    } catch (err) {
      totals.failed += 1;
      log(`  failed     ${id8(c.id)}  ${etDateString(new Date(c.created_at))}  ${String(err?.code || 'error')}`);
    }
  }
  log(`  ran ${totals.ran} (rows written for ${totals.withRows}, nothing promised or still unreadable for ${totals.noRows}), skipped ${totals.skipped}, failed ${totals.failed}`);
  return totals;
}

module.exports = { parseArgs, etRange, candidateQuery, findCandidates, runPipelineStep, run };

if (require.main === module) {
  const db = require('../server/models/db');
  const opts = parseArgs(process.argv.slice(2));
  run({ ...opts, dbh: db })
    .then(() => db.destroy())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`backfill failed (code ${err?.code || 'n/a'}): ${String(err?.message || err).split('\n')[0].slice(0, 200)}`);
      process.exit(1);
    });
}
