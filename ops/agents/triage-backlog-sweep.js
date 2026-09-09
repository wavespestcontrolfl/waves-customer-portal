// MUTATES (dry-run default): one-time drain of the Needs Review backlog
// after the 2026-09-08 call-agent audit. The queue held 1,705 open cards
// across 502 calls (oldest 2026-05-28); the two flags the audit retired had
// filed 370 of them, 601 were advisories nobody would act on, and 404
// belonged to calls whose customer was booked within three days anyway.
// Four passes over OPEN cards only, all `dismissed` (never `resolved` — the
// knowledge index learns from resolved cards, and an aged-out card carries
// no resolution knowledge), each idempotent:
//   1. retired_flag  — reason_code low_extraction_confidence, or
//                      caller_not_authorized when the call's V2 extraction
//                      names an owner / spouse / unknown relationship (the
//                      firings the audit retired; derivation changed in the
//                      same PR). An EXPLICIT third party (tenant, agent,
//                      manager, other) keeps its card: that flag still fires
//                      and blocks for them, so only passes 2-4 may touch it
//                      (codex r1 P1).
//   2. booked_after  — a booking created within 3 days AFTER the call
//                      answers it: this call's own booking, or a PARENT
//                      (not a follow-up child or recurring occurrence) in a
//                      live or completed status (the auto-resolver's
//                      LIVE_BOOKING_STATUSES), for the call's matched customer. The
//                      auto-resolver's stricter proof (service, window and
//                      address against the card's filing-time snapshot)
//                      cannot run here: the historical backlog predates the
//                      snapshot, and the resolver deliberately gives those
//                      cards no booking evidence. This pass is the owner-
//                      approved coarser rule for the one-time drain.
//   3. aged_advisory — severity advisory, older than --advisory-days (30)
//   4. aged_blocking — anything else older than --stale-days (30): the
//                      moment has passed; a reschedule from July is not
//                      actionable in September
// Owed-work reason codes the auto-resolver never touches (quote_promised,
// cancellation_request, after_hours_emergency, prior_complaint_unresolved,
// commercial_requires_quote, hoa_common_area_requires_approval) are ONLY
// swept by the aged passes (3/4), never by 1/2, and the aged passes skip
// in_progress (human-claimed) rows. missing_unit_number is owed until the
// office collects the unit (a later booking does not prove it was supplied)
// and is exempt from EVERY pass (codex r1 P1). call_log.review_status is
// re-synced the way the auto-resolver does it: 'open' while open cards
// remain, else 'dismissed'.
// Reversible: every row carries the run tag as a resolution_note prefix. The
// revert reopens the cards AND re-syncs their calls in one statement (the
// tag is gone once resolution_note is cleared, so the two cannot be split):
//   WITH r AS (UPDATE triage_items SET status='open', resolved_at=NULL,
//     resolution_note=NULL, resolution_source=NULL
//     WHERE resolution_note LIKE '<tag>%' RETURNING call_log_id)
//   UPDATE call_log SET review_status='open', updated_at=now()
//     WHERE id IN (SELECT call_log_id FROM r) AND review_status IS DISTINCT FROM 'open';
//
// Usage (repo root):
//   railway run --service Postgres node ops/agents/triage-backlog-sweep.js                 # dry run
//   railway run --service Postgres node ops/agents/triage-backlog-sweep.js --execute
//   ... --stale-days=45 --advisory-days=14
if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service Postgres node ops/agents/triage-backlog-sweep.js');
  process.exit(1);
}
const { Client } = require('pg');

const execute = process.argv.includes('--execute');
const num = (flag, dflt, min) => {
  const a = process.argv.find((x) => x.startsWith(`--${flag}=`));
  if (!a) return dflt;
  const n = Number(a.split('=')[1]);
  if (!(Number.isInteger(n) && n >= min)) { console.error(`--${flag} must be an integer >= ${min}`); process.exit(1); }
  return n;
};
const staleDays = num('stale-days', 30, 7);
const advisoryDays = num('advisory-days', 30, 7);
const RETIRED_FLAGS = ['low_extraction_confidence'];
// caller_not_authorized was retired only for these relationships; the flag
// still fires and blocks for an explicit third party.
const OWNER_EQUIVALENT = ['owner', 'spouse_partner', 'unknown'];
// Owed until a human verdict — never swept by any pass.
const NEVER_SWEEP = ['missing_unit_number'];
const OWED_WORK = ['quote_promised', 'cancellation_request', 'after_hours_emergency', 'prior_complaint_unresolved', 'commercial_requires_quote', 'hoa_common_area_requires_approval', 'auto_booking_skipped_after_approval', 'outbound_booking_review', 'email_bounce_reverify'];

const etStamp = new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T').replace(/:/g, '');
const tag = `triage-backlog-sweep-${etStamp}-${require('crypto').randomBytes(3).toString('hex')}`;
const NOTES = {
  retired_flag: `${tag}: dismissed — flag retired by the 2026-09-08 call-agent audit (fired on ordinary calls).`,
  booked_after: `${tag}: dismissed — the customer was booked within 3 days of this call; the ask was handled.`,
  aged_advisory: `${tag}: dismissed — informational flag unactioned after ${advisoryDays} days.`,
  aged_blocking: `${tag}: dismissed — hold unactioned after ${staleDays} days; the moment has passed.`,
};

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const classify = `
    WITH t AS (
      SELECT t.id, t.call_log_id, t.reason_code, t.severity, t.status, t.created_at,
        LOWER(COALESCE(NULLIF(TRIM(cl.ai_extraction_enriched->'caller'->>'relationship_to_property'), ''), 'unknown')) AS relationship,
        EXISTS (SELECT 1 FROM scheduled_services s
                WHERE s.created_at > cl.created_at AND s.created_at < cl.created_at + interval '3 days'
                  AND s.parent_service_id IS NULL AND s.recurring_parent_id IS NULL
                  AND s.status IN ('pending', 'confirmed', 'en_route', 'on_site', 'completed')
                  AND (s.source_call_log_id = cl.id OR (cl.customer_id IS NOT NULL AND s.customer_id = cl.customer_id))) AS booked_after
      FROM triage_items t LEFT JOIN call_log cl ON cl.id = t.call_log_id
      WHERE t.status = 'open' AND NOT (t.reason_code = ANY($5)))
    SELECT id, call_log_id, reason_code,
      CASE
        WHEN reason_code = ANY($1) THEN 'retired_flag'
        WHEN reason_code = 'caller_not_authorized' AND relationship = ANY($6) THEN 'retired_flag'
        WHEN booked_after AND NOT (reason_code = ANY($2)) THEN 'booked_after'
        WHEN severity = 'advisory' AND created_at < now() - ($3 || ' days')::interval THEN 'aged_advisory'
        WHEN created_at < now() - ($4 || ' days')::interval THEN 'aged_blocking'
        ELSE NULL END AS rule
    FROM t`;
  const { rows } = await c.query(classify, [RETIRED_FLAGS, OWED_WORK, String(advisoryDays), String(staleDays), NEVER_SWEEP, OWNER_EQUIVALENT]);
  const byRule = {}; const byReason = {}; const remaining = {};
  for (const r of rows) {
    if (r.rule) { byRule[r.rule] = (byRule[r.rule] || 0) + 1; byReason[`${r.rule}:${r.reason_code}`] = (byReason[`${r.rule}:${r.reason_code}`] || 0) + 1; }
    else remaining[r.reason_code] = (remaining[r.reason_code] || 0) + 1;
  }
  const toSweep = rows.filter((r) => r.rule);
  console.log(`${execute ? 'EXECUTE' : 'DRY RUN'} ${tag}`);
  console.log(`open cards: ${rows.length}  would dismiss: ${toSweep.length}  remain open: ${rows.length - toSweep.length}`);
  console.log('by rule:', JSON.stringify(byRule));
  console.log('by rule:reason:', JSON.stringify(byReason, null, 1));
  console.log('remaining open by reason:', JSON.stringify(remaining, null, 1));
  if (!execute || !toSweep.length) { await c.end(); return; }

  await c.query('BEGIN');
  try {
    const now = new Date();
    const touched = new Set();
    for (const rule of Object.keys(NOTES)) {
      const ids = toSweep.filter((r) => r.rule === rule).map((r) => r.id);
      if (!ids.length) continue;
      const res = await c.query(
        `UPDATE triage_items SET status = 'dismissed', resolution_note = $2, resolution_source = 'auto', resolved_at = $3, updated_at = $3
         WHERE id = ANY($1) AND status = 'open' RETURNING call_log_id`,
        [ids, NOTES[rule], now],
      );
      console.log(`${rule}: dismissed ${res.rowCount}`);
      for (const r of res.rows) touched.add(r.call_log_id);
    }
    const sync = await c.query(
      `UPDATE call_log cl SET review_status = CASE WHEN EXISTS (
          SELECT 1 FROM triage_items ti WHERE ti.call_log_id = cl.id AND ti.status IN ('open', 'in_progress')) THEN 'open' ELSE 'dismissed' END,
        updated_at = $2
       WHERE cl.id = ANY($1) AND cl.review_status IS DISTINCT FROM CASE WHEN EXISTS (
          SELECT 1 FROM triage_items ti WHERE ti.call_log_id = cl.id AND ti.status IN ('open', 'in_progress')) THEN 'open' ELSE 'dismissed' END`,
      [[...touched], now],
    );
    console.log(`review_status re-synced on ${sync.rowCount} calls (of ${touched.size} touched)`);
    await c.query('COMMIT');
    console.log(`done. revert (reopens the cards AND re-syncs their calls' review_status — one statement, the tag is gone once the note is cleared):
WITH r AS (UPDATE triage_items SET status='open', resolved_at=NULL, resolution_note=NULL, resolution_source=NULL WHERE resolution_note LIKE '${tag}%' RETURNING call_log_id)
UPDATE call_log SET review_status='open', updated_at=now() WHERE id IN (SELECT call_log_id FROM r) AND review_status IS DISTINCT FROM 'open';`);
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    await c.end();
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
