'use strict';

/**
 * Estimate engagement engine — schema + rule seeds (PR 2 of the
 * engagement-drip lane; PR 1 = #2729 shipped the estimate_followup_sends
 * ledger this engine claims through).
 *
 * estimate_followup_rules: one row per engagement rule. `params` (jsonb)
 * carries every timing knob (windows, delays, eligible categories) so the
 * admin can tune cadence without a deploy; the engine merges params over
 * its code defaults, so a missing key never breaks evaluation. Rules seed
 * enabled — the ENGINE is dark behind GATE_ESTIMATE_ENGAGEMENT_FOLLOWUP,
 * so nothing sends until the gate flips; per-rule `enabled` is the
 * fine-grained kill switch after that.
 *
 * estimate_followup_jobs: durable scheduling queue. View-event rules
 * enqueue a job at view time (due after the rule's fire delay); the 5-min
 * cron processes due jobs, RE-VALIDATING everything at send time. The
 * partial unique index (one PENDING job per estimate+rule) makes enqueues
 * idempotent; terminal rows keep the audit trail.
 *
 * Template keys reference estimate.engage_* rows that PR 3 seeds — the
 * engine fails closed (release claim, retry, then give up) if a template
 * is missing or archived, and the gate stays off until the templates ship.
 */

const RULE_SEEDS = [
  {
    rule_key: 'delivery_unopened_24h',
    trigger_type: 'time_sweep',
    priority: 40,
    template_key: 'estimate.engage_unopened',
    params: { minAgeHours: 24, maxAgeHours: 48, eligibleCategories: ['pest', 'lawn'] },
  },
  {
    rule_key: 'return_visit_hot',
    trigger_type: 'view_event',
    priority: 10,
    template_key: 'estimate.engage_return_visit',
    params: {
      minReturnGapMinutes: 15,
      maxSinceFirstSessionHours: 48,
      fireDelayMinutes: 15,
      spacingExempt: true,
      eligibleCategories: ['pest', 'lawn'],
    },
  },
  {
    rule_key: 'multi_view_high_intent',
    trigger_type: 'view_event',
    priority: 20,
    template_key: 'estimate.engage_high_intent',
    params: { minSessions: 3, windowHours: 72, fireDelayMinutes: 15, eligibleCategories: ['pest', 'lawn'] },
  },
  {
    rule_key: 'dark_then_return',
    trigger_type: 'view_event',
    priority: 15,
    template_key: 'estimate.engage_return_after_dark',
    params: { minDarkDays: 3, fireDelayMinutes: 15, eligibleCategories: ['pest', 'lawn'] },
  },
  {
    rule_key: 'viewed_gone_quiet_72h',
    trigger_type: 'time_sweep',
    priority: 50,
    template_key: 'estimate.engage_gone_quiet',
    params: { minQuietHours: 72, maxQuietHours: 96, eligibleCategories: ['pest', 'lawn'] },
  },
  {
    rule_key: 'expiring_engaged',
    trigger_type: 'time_sweep',
    priority: 30,
    template_key: 'estimate.engage_expiring',
    params: { expiresWithinDays: 2, eligibleCategories: ['pest', 'lawn'] },
  },
  {
    rule_key: 'expiring_never_viewed',
    trigger_type: 'time_sweep',
    priority: 35,
    template_key: 'estimate.engage_expiring_unseen',
    params: { expiresWithinDays: 2, eligibleCategories: ['pest', 'lawn'] },
  },
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_followup_rules'))) {
    await knex.schema.createTable('estimate_followup_rules', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('rule_key', 64).notNullable().unique();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.integer('priority').notNullable().defaultTo(100);
      t.string('trigger_type', 32).notNullable(); // 'view_event' | 'time_sweep'
      t.jsonb('params').notNullable().defaultTo('{}');
      t.string('template_key', 128);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable('estimate_followup_jobs'))) {
    await knex.schema.createTable('estimate_followup_jobs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
      t.string('rule_key', 64).notNullable();
      t.timestamp('due_at', { useTz: true }).notNullable();
      t.jsonb('trigger');
      // pending | done | shadow | skipped | failed
      t.string('status', 16).notNullable().defaultTo('pending');
      t.integer('attempts').notNullable().defaultTo(0);
      t.string('outcome_reason', 128);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.index(['status', 'due_at']);
    });
    // One live job per (estimate, rule) — enqueues are idempotent; terminal
    // rows stay as the audit trail.
    await knex.raw(`
      CREATE UNIQUE INDEX estimate_followup_jobs_pending_uniq
      ON estimate_followup_jobs (estimate_id, rule_key)
      WHERE status = 'pending'
    `);
  }

  // Preserve admin edits: insert-only seeding (an existing row keeps
  // whatever enabled/params the admin last saved).
  for (const seed of RULE_SEEDS) {
    const existing = await knex('estimate_followup_rules').where({ rule_key: seed.rule_key }).first();
    if (!existing) {
      await knex('estimate_followup_rules').insert({
        ...seed,
        params: JSON.stringify(seed.params),
      });
    }
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('estimate_followup_jobs');
  await knex.schema.dropTableIfExists('estimate_followup_rules');
};

// Exported for the seed-pinning test.
exports._RULE_SEEDS = RULE_SEEDS;
