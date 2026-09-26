/**
 * ADMIN-BUG-R18 — re-derives 20260926120000's request evidence on the
 * Eastern calendar. That migration is frozen (pushed; a preview database
 * has run it) and compared a request's created_at (timestamptz) with the
 * term's DATE boundaries, which PostgreSQL reads as midnight in the session
 * time zone (UTC on Railway): an end-now request made in the last hours of
 * term_end's ET day fell outside the window, and one from the evening
 * before term_start's ET day fell inside it.
 *
 * It runs in the same release as that backfill, before any code writes the
 * column, so every disposition it can see came from the backfill. A
 * disposition recorded at runtime always carries evidence under these
 * rules too (a fresh end-now writes its note; an end-now upgrade has its
 * Cancel plan request inside the term's window), so none is moved:
 *   - end_at_term with an ET-window end-now request → end_now_refund;
 *   - end_now_refund with no end-now evidence left (no decision note, no
 *     reached case, no ET-window request) → end_at_term.
 *
 * down() is a no-op: the prior values were a UTC artifact, not a state
 * worth restoring.
 */

const END_NOW_NOTE = 'ended now; unused-value refund owed';

async function correctCancelDispositionWindow(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))
    || !(await knex.schema.hasColumn('annual_prepay_terms', 'cancel_disposition'))) return;
  const hasCases = await knex.schema.hasTable('cancellation_cases');
  const hasRequests = await knex.schema.hasTable('service_requests')
    && await knex.schema.hasColumn('service_requests', 'metadata');
  const requestInWindow = hasRequests
    ? `exists (
      select 1 from service_requests r
      where r.customer_id = t.customer_id
        and r.category = 'cancellation'
        and (r.created_at at time zone 'America/New_York')::date between t.term_start and t.term_end
        and jsonb_typeof(r.metadata->'cancel_plan') = 'object'
        and coalesce(jsonb_array_length(case when jsonb_typeof(r.metadata->'cancel_plan'->'scope') = 'array'
          then r.metadata->'cancel_plan'->'scope' end), 0) = 0
        and coalesce(
          nullif(r.metadata->'cancel_plan'->>'prepayDisposition', ''),
          case when coalesce(nullif(r.metadata->'cancel_plan'->>'effectiveDate', ''), 'now') = 'now'
            then 'end_now_refund' else 'end_at_term' end
        ) = 'end_now_refund'
    )`
    : 'false';
  const noteOrCase = [
    'position(? in coalesce(t.renewal_notes, \'\')) > 0',
    hasCases
      ? `exists (
        select 1 from cancellation_cases c
        where c.customer_id = t.customer_id
          and c.snapshot->>'prepayTermId' = t.id::text
          and c.snapshot->>'prepayDisposition' = 'end_now_refund'
          and c.snapshot->>'prepayTermOutcome' in ('ended_now', 'decision_already_recorded')
      )`
      : 'false',
  ].join(' or ');
  await knex.raw(
    `update annual_prepay_terms t
        set cancel_disposition = 'end_now_refund'
      where t.renewal_decision = 'cancel'
        and t.cancel_disposition = 'end_at_term'
        and ${requestInWindow}`,
  );
  await knex.raw(
    `update annual_prepay_terms t
        set cancel_disposition = 'end_at_term'
      where t.renewal_decision = 'cancel'
        and t.cancel_disposition = 'end_now_refund'
        and not (${noteOrCase})
        and not ${requestInWindow}`,
    [END_NOW_NOTE],
  );
}

exports.up = async function up(knex) {
  await correctCancelDispositionWindow(knex);
};

exports.down = async function down() {};

// Exported for the backfill's regression test.
exports.correctCancelDispositionWindow = correctCancelDispositionWindow;
