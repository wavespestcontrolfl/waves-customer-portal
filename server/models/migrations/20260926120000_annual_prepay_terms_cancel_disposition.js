/**
 * ADMIN-BUG-R18 (re-cut of #4911) — annual_prepay_terms.cancel_disposition.
 *
 * A term's 'cancel' decision (status 'cancelled', renewal_decision 'cancel')
 * is recorded the moment it is made, months before term_end, and has two
 * shapes the rest of billing must tell apart:
 *   - 'end_at_term': coverage runs out at term_end ("End of paid coverage",
 *     or a renewal-time lapse). Its paid visits stay owed through term_end:
 *     a hand-added replacement is stamped prepaid, and the nightly sweep
 *     replaces a skipped one.
 *   - 'end_now_refund': Cancel plan pulled every visit and owes the unused
 *     value back. Nothing is ever reseeded or stamped for it.
 * recordDecision writes the disposition in the same UPDATE as the decision,
 * and an end-at-term lapse later ended now is upgraded in place — never the
 * reverse (Cancel plan refuses end-now → end-at-term). Null on every term
 * without a cancel decision.
 *
 * Backfill for decisions recorded before this column, failing closed: any
 * end-now evidence makes a decided lapse 'end_now_refund' —
 *   - the end-now decision note ("ended now; unused-value refund owed"),
 *     written with a fresh end-now decision;
 *   - a cancellation case that reached the term with end_now_refund
 *     (prepayTermOutcome 'ended_now' / 'decision_already_recorded' — the
 *     only evidence for an end-at-term lapse later ended now);
 *   - a whole-account Cancel plan request inside the term's window whose
 *     accepted disposition is end_now_refund, stated or derived the way
 *     resolvePrepay derives it (blank disposition + effective date 'now').
 *     It is written before anything destructive, so it outlives a lost
 *     case write; a failed attempt it cannot rule out only withholds a
 *     replacement visit, never recreates visits for a refunded customer.
 * Every other decided lapse is 'end_at_term'.
 *
 * Additive and nullable; hasTable/hasColumn-guarded, and the backfill only
 * fills nulls, so it is safe to run more than once.
 */

const END_NOW_NOTE = 'ended now; unused-value refund owed';

async function backfillCancelDisposition(knex) {
  const hasCases = await knex.schema.hasTable('cancellation_cases');
  const hasRequests = await knex.schema.hasTable('service_requests')
    && await knex.schema.hasColumn('service_requests', 'metadata');
  const evidence = [
    'position(? in coalesce(t.renewal_notes, \'\')) > 0',
  ];
  const bindings = [END_NOW_NOTE];
  if (hasCases) {
    evidence.push(`exists (
      select 1 from cancellation_cases c
      where c.customer_id = t.customer_id
        and c.snapshot->>'prepayTermId' = t.id::text
        and c.snapshot->>'prepayDisposition' = 'end_now_refund'
        and c.snapshot->>'prepayTermOutcome' in ('ended_now', 'decision_already_recorded')
    )`);
  }
  if (hasRequests) {
    evidence.push(`exists (
      select 1 from service_requests r
      where r.customer_id = t.customer_id
        and r.category = 'cancellation'
        and r.created_at >= t.term_start
        and r.created_at < t.term_end + 1
        and jsonb_typeof(r.metadata->'cancel_plan') = 'object'
        and coalesce(jsonb_array_length(case when jsonb_typeof(r.metadata->'cancel_plan'->'scope') = 'array'
          then r.metadata->'cancel_plan'->'scope' end), 0) = 0
        and coalesce(
          nullif(r.metadata->'cancel_plan'->>'prepayDisposition', ''),
          case when coalesce(nullif(r.metadata->'cancel_plan'->>'effectiveDate', ''), 'now') = 'now'
            then 'end_now_refund' else 'end_at_term' end
        ) = 'end_now_refund'
    )`);
  }
  await knex.raw(
    `update annual_prepay_terms t
        set cancel_disposition = 'end_now_refund'
      where t.renewal_decision = 'cancel'
        and t.cancel_disposition is null
        and (${evidence.join(' or ')})`,
    bindings,
  );
  await knex.raw(
    `update annual_prepay_terms
        set cancel_disposition = 'end_at_term'
      where renewal_decision = 'cancel'
        and cancel_disposition is null`,
  );
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'cancel_disposition'))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.string('cancel_disposition', 20);
    });
  }
  await knex.raw('alter table annual_prepay_terms drop constraint if exists annual_prepay_terms_cancel_disposition_check');
  await knex.raw(`alter table annual_prepay_terms add constraint annual_prepay_terms_cancel_disposition_check
    check (cancel_disposition is null or cancel_disposition in ('end_at_term', 'end_now_refund'))`);
  await backfillCancelDisposition(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  await knex.raw('alter table annual_prepay_terms drop constraint if exists annual_prepay_terms_cancel_disposition_check');
  if (await knex.schema.hasColumn('annual_prepay_terms', 'cancel_disposition')) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.dropColumn('cancel_disposition');
    });
  }
};

// Exported for the backfill's regression test (a migration file is not a
// module anything else imports).
exports.backfillCancelDisposition = backfillCancelDisposition;
