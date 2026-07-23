'use strict';

/**
 * Engaged-moment rules fire fast (owner 2026-07-21: "send them 1 minute
 * after they click, for someone that is engaged").
 *
 * The three behavior-triggered "they're actively looking" rules —
 * return_visit_hot, multi_view_high_intent, dark_then_return — drop their
 * fire delay from 15 minutes to 1 and opt out of the engine's mid-read
 * hold (new per-rule param activeViewHoldExempt, honored by the engine in
 * the same PR). The email is meant to land while the estimate is still
 * open in front of them; effective latency is the 1-minute delay plus the
 * engine's 5-minute cron tick.
 *
 * jsonb-merge, key-by-key: any OTHER param an admin has tuned on these
 * rows survives untouched. Time-based rules (unopened / gone-quiet /
 * expiring) keep the hold — nobody wants a deadline email mid-read.
 *
 * Same owner directive, second half ("space them at least 12 hrs apart"):
 * return_visit_hot loses its seeded spacingExempt — the 12h minimum
 * spacing now applies to EVERY send. The fast fire governs latency from
 * the click; spacing defers the job to the 12h boundary when another
 * email went out recently.
 */

const FAST_RULES = ['return_visit_hot', 'multi_view_high_intent', 'dark_then_return'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_followup_rules'))) return;
  await knex('estimate_followup_rules')
    .whereIn('rule_key', FAST_RULES)
    .update({
      params: knex.raw(`params || '{"fireDelayMinutes":1,"activeViewHoldExempt":true}'::jsonb`),
      updated_at: new Date(),
    });
  await knex('estimate_followup_rules')
    .where({ rule_key: 'return_visit_hot' })
    .update({
      params: knex.raw(`params || '{"spacingExempt":false}'::jsonb`),
      updated_at: new Date(),
    });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimate_followup_rules'))) return;
  await knex('estimate_followup_rules')
    .whereIn('rule_key', FAST_RULES)
    .update({
      params: knex.raw(`(params - 'activeViewHoldExempt') || '{"fireDelayMinutes":15}'::jsonb`),
      updated_at: new Date(),
    });
  await knex('estimate_followup_rules')
    .where({ rule_key: 'return_visit_hot' })
    .update({
      params: knex.raw(`params || '{"spacingExempt":true}'::jsonb`),
      updated_at: new Date(),
    });
};

exports._FAST_RULES = FAST_RULES;
