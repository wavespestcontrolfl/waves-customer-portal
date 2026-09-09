// Manual historical backlog drain; dry run by default. No scheduler calls this.
// Dismisses retired flags, later-booked calls and aged cards under the audit's
// coarse policy. Missing-unit cards are never swept; claimed cards stay open.
// Historical booking proof is intentionally coarser than the live resolver's
// filing-time snapshot proof. Execute only after reviewing the dry-run counts.
// Both execution and reversal serialize with admin/nightly triage writers:
// sorted per-call advisory locks -> sibling card locks -> fresh classification
// -> transitions and call aggregate in the same transaction. Evidence rows
// are re-read without extra row locks, matching the resolver's lock contract.
//
// DATABASE_URL=<preview> node ops/agents/triage-backlog-sweep.js [--execute]
// ... --stale-days=45 --advisory-days=14
// ... --revert=triage-backlog-sweep-<run-tag> [--execute]
const knex = require('knex');
const { randomBytes } = require('crypto');
const { lockTriageCall } = require('../../server/utils/triage-locks');

const RETIRED_FLAGS = ['low_extraction_confidence'];
const OWNER_EQUIVALENT = ['owner', 'spouse_partner', 'unknown'];
const NEVER_SWEEP = ['missing_unit_number'];
const OWED_WORK = ['quote_promised', 'cancellation_request', 'after_hours_emergency', 'prior_complaint_unresolved', 'commercial_requires_quote', 'hoa_common_area_requires_approval', 'auto_booking_skipped_after_approval', 'outbound_booking_review', 'email_bounce_reverify'];
// Freeze the one-time audit scope; newly filed cards are never historical backlog.
const AUDIT_CUTOFF = '2026-09-09T00:00:00-04:00';
const RULES = ['retired_flag', 'booked_after', 'aged_advisory', 'aged_blocking'];
const runTag = () => `triage-backlog-sweep-${new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T').replace(/:/g, '')}-${randomBytes(3).toString('hex')}`;
function validateTag(tag) {
  if (!/^triage-backlog-sweep-[A-Za-z0-9-]+$/.test(tag)) throw new Error('Invalid backlog run tag');
  return tag;
}
function ageDays(value = 30) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 7) throw new Error('Age thresholds must be integers >= 7');
  return days;
}

async function classify(database, { staleDays, advisoryDays }, ids = null) {
  const result = await database.raw(`
    WITH candidates AS (
      SELECT t.id, t.call_log_id, t.reason_code, t.severity, t.created_at,
        LOWER(COALESCE(NULLIF(TRIM(cl.ai_extraction_enriched->'caller'->>'relationship_to_property'), ''), 'unknown')) AS relationship,
        EXISTS (SELECT 1 FROM scheduled_services s
          WHERE s.created_at > cl.created_at AND s.created_at < cl.created_at + interval '3 days'
            AND s.parent_service_id IS NULL AND s.recurring_parent_id IS NULL
            AND s.status IN ('pending', 'confirmed', 'en_route', 'on_site', 'completed')
            AND (s.source_call_log_id = cl.id OR (cl.customer_id IS NOT NULL AND s.customer_id = cl.customer_id))) AS booked_after
      FROM triage_items t JOIN call_log cl ON cl.id = t.call_log_id
      WHERE t.status = 'open' AND NOT (t.reason_code = ANY(?))
        AND t.created_at < ? AND (?::uuid[] IS NULL OR t.id = ANY(?::uuid[])))
    SELECT id, call_log_id, reason_code,
      CASE WHEN reason_code = ANY(?) THEN 'retired_flag'
        WHEN reason_code = 'caller_not_authorized' AND relationship = ANY(?) THEN 'retired_flag'
        WHEN booked_after AND NOT (reason_code = ANY(?)) THEN 'booked_after'
        WHEN severity = 'advisory' AND created_at < now() - (? || ' days')::interval THEN 'aged_advisory'
        WHEN created_at < now() - (? || ' days')::interval THEN 'aged_blocking'
        ELSE NULL END AS rule FROM candidates`,
  [NEVER_SWEEP, AUDIT_CUTOFF, ids, ids, RETIRED_FLAGS, OWNER_EQUIVALENT, OWED_WORK, String(advisoryDays), String(staleDays)]);
  return result.rows;
}

async function lockCallsAndCards(trx, candidates) {
  const ids = [...new Set(candidates.map(row => row.call_log_id))].sort();
  for (const id of ids) await lockTriageCall(trx, id);
  await trx('triage_items').whereIn('call_log_id', ids).orderBy('id', 'asc').forUpdate().select('id');
}
async function syncCalls(trx, rows) {
  const ids = [...new Set(rows.map(row => row.call_log_id))];
  if (!ids.length) return 0;
  const aggregate = `CASE WHEN EXISTS (SELECT 1 FROM triage_items ti
    WHERE ti.call_log_id = call_log.id AND ti.status IN ('open', 'in_progress')) THEN 'open' ELSE 'dismissed' END`;
  return trx('call_log').whereIn('id', ids).whereRaw(`review_status IS DISTINCT FROM ${aggregate}`)
    .update({ review_status: trx.raw(aggregate), updated_at: trx.fn.now() });
}

async function sweepBacklog(database, options = {}) {
  const { execute = false, tag = runTag() } = options;
  validateTag(tag);
  const ages = { staleDays: ageDays(options.staleDays), advisoryDays: ageDays(options.advisoryDays) };
  const rows = await classify(database, ages);
  const candidates = rows.filter(row => row.rule);
  const plannedByRule = Object.fromEntries(RULES.map(rule => [rule, candidates.filter(row => row.rule === rule).length]));
  const result = { tag, dryRun: !execute, cutoff: AUDIT_CUTOFF, scanned: rows.length, plannedByRule, applied: 0, callsSynced: 0 };
  if (!execute || !candidates.length) return result;
  const notes = {
    retired_flag: 'historical flag retired by the 2026-09-08 call-agent audit.',
    booked_after: 'customer booked within 3 days of this call (historical coarse rule).',
    aged_advisory: `informational flag unactioned after ${ages.advisoryDays} days.`,
    aged_blocking: `hold unactioned after ${ages.staleDays} days.`,
  };
  await database.transaction(async trx => {
    await lockCallsAndCards(trx, candidates);
    const fresh = await classify(trx, ages, candidates.map(row => row.id));
    const before = new Map(candidates.map(row => [row.id, row]));
    const eligible = fresh.filter(row => row.rule === before.get(row.id)?.rule && row.call_log_id === before.get(row.id)?.call_log_id);
    const touched = [];
    for (const rule of RULES) {
      const ids = eligible.filter(row => row.rule === rule).map(row => row.id);
      if (!ids.length) continue;
      const changed = await trx('triage_items').whereIn('id', ids).where({ status: 'open' })
        .update({ status: 'dismissed', resolution_note: `${tag}: dismissed — ${notes[rule]}`,
          resolution_source: 'auto', resolved_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('call_log_id');
      touched.push(...changed);
    }
    result.applied = touched.length;
    result.callsSynced = await syncCalls(trx, touched);
  });
  return result;
}

async function revertBacklog(database, tag, { execute = false } = {}) {
  validateTag(tag);
  const tagged = conn => conn('triage_items').where({ status: 'dismissed', resolution_source: 'auto' })
    .whereNotNull('call_log_id').where('resolution_note', 'like', `${tag}:%`);
  const candidates = await tagged(database).select('id', 'call_log_id');
  const result = { tag, dryRun: !execute, wouldReopen: candidates.length, applied: 0, callsSynced: 0 };
  if (!execute || !candidates.length) return result;
  await database.transaction(async trx => {
    await lockCallsAndCards(trx, candidates);
    const fresh = await tagged(trx).whereIn('id', candidates.map(row => row.id)).select('id', 'call_log_id');
    const before = new Map(candidates.map(row => [row.id, row.call_log_id]));
    const ids = fresh.filter(row => row.call_log_id === before.get(row.id)).map(row => row.id);
    const changed = await tagged(trx).whereIn('id', ids).update({ status: 'open', resolved_at: null,
      resolution_note: null, resolution_source: null, updated_at: trx.fn.now() }).returning('call_log_id');
    result.applied = changed.length;
    result.callsSynced = await syncCalls(trx, changed);
  });
  return result;
}

async function main(args = process.argv.slice(2)) {
  const connection = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!connection) throw new Error('Set DATABASE_URL to the intended database before running the dry run');
  const value = flag => args.find(arg => arg.startsWith(`--${flag}=`))?.split('=').slice(1).join('=');
  const database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  try {
    const execute = args.includes('--execute');
    const result = value('revert') ? await revertBacklog(database, value('revert'), { execute })
      : await sweepBacklog(database, { execute, staleDays: value('stale-days'), advisoryDays: value('advisory-days') });
    console.log(`${execute ? 'EXECUTE' : 'DRY RUN'} ${JSON.stringify(result, null, 2)}`);
    if (execute && !value('revert')) console.log(`Revert dry run: node ops/agents/triage-backlog-sweep.js --revert=${result.tag}`);
  } finally { await database.destroy(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { sweepBacklog, revertBacklog, AUDIT_CUTOFF };
