/**
 * Migration 100 — Referral Unification
 * Extends both existing referral tables (007 + 054) into a single unified system.
 * Does NOT drop any tables. Safe to re-run (hasColumn checks everywhere).
 */
exports.up = async function (knex) {

  // =========================================================================
  // A. ALTER referral_promoters — drop Clicki, add unified fields
  // =========================================================================
  await knex.schema.alterTable('referral_promoters', (t) => {
    // Drop Clicki-specific columns
    if (knex.client.config.client === 'pg' || true) {
      // Wrapped individually so each is safe
    }
  });

  // Drop columns one at a time with hasColumn checks
  for (const col of ['clicki_referral_link', 'clicki_promoter_id', 'click_balance_cents']) {
    if (await knex.schema.hasColumn('referral_promoters', col)) {
      await knex.schema.alterTable('referral_promoters', (t) => { t.dropColumn(col); });
    }
  }

  // Add new unified columns
  await knex.schema.alterTable('referral_promoters', async (t) => {
    if (!(await knex.schema.hasColumn('referral_promoters', 'referral_code'))) {
      t.string('referral_code', 20).unique();
    }
    if (!(await knex.schema.hasColumn('referral_promoters', 'referral_link'))) {
      t.string('referral_link', 500);
    }
    if (!(await knex.schema.hasColumn('referral_promoters', 'milestone_level'))) {
      t.string('milestone_level', 30).defaultTo('none');
    }
    if (!(await knex.schema.hasColumn('referral_promoters', 'milestone_earned_at'))) {
      t.timestamp('milestone_earned_at');
    }
    if (!(await knex.schema.hasColumn('referral_promoters', 'available_balance_cents'))) {
      t.integer('available_balance_cents').defaultTo(0);
    }
    if (!(await knex.schema.hasColumn('referral_promoters', 'pending_earnings_cents'))) {
      t.integer('pending_earnings_cents').defaultTo(0);
    }
    if (!(await knex.schema.hasColumn('referral_promoters', 'last_share_at'))) {
      t.timestamp('last_share_at');
    }
    if (!(await knex.schema.hasColumn('referral_promoters', 'last_referral_at'))) {
      t.timestamp('last_referral_at');
    }
  });

  // Backfill referral_code from customers.referral_code where customer_id matches
  try {
    await knex.raw(`
      UPDATE referral_promoters rp
      SET referral_code = c.referral_code
      FROM customers c
      WHERE rp.customer_id = c.id
        AND c.referral_code IS NOT NULL
        AND (rp.referral_code IS NULL OR rp.referral_code = '')
    `);
  } catch (e) { /* backfill is best-effort */ }

  // =========================================================================
  // B. ALTER referrals (007 table) — add unified fields
  // =========================================================================
  const referralCols = {
    promoter_id: () => (t) => t.integer('promoter_id'),
    lead_id: () => (t) => t.uuid('lead_id'),
    service_interest: () => (t) => t.string('service_interest'),
    source: () => (t) => t.string('source', 30).defaultTo('portal'),
    referrer_reward_amount: () => (t) => t.decimal('referrer_reward_amount', 10, 2).defaultTo(50),
    referrer_reward_status: () => (t) => t.string('referrer_reward_status', 20).defaultTo('pending'),
    referee_discount_applied: () => (t) => t.boolean('referee_discount_applied').defaultTo(false),
    converted_tier: () => (t) => t.string('converted_tier'),
    converted_monthly_value: () => (t) => t.decimal('converted_monthly_value', 10, 2),
    first_service_completed: () => (t) => t.boolean('first_service_completed').defaultTo(false),
    lost_reason: () => (t) => t.string('lost_reason'),
    expires_at: () => (t) => t.timestamp('expires_at'),
  };

  for (const [col, builder] of Object.entries(referralCols)) {
    if (!(await knex.schema.hasColumn('referrals', col))) {
      await knex.schema.alterTable('referrals', builder());
    }
  }

  // Backfill promoter_id from referrer_customer_id -> referral_promoters.customer_id
  try {
    if (await knex.schema.hasColumn('referrals', 'referrer_customer_id')) {
      await knex.raw(`
        UPDATE referrals r
        SET promoter_id = rp.id
        FROM referral_promoters rp
        WHERE r.referrer_customer_id = rp.customer_id
          AND r.promoter_id IS NULL
      `);
    }
  } catch (e) { /* backfill is best-effort */ }

  // =========================================================================
  // C. ALTER referral_clicks — drop old, add unified
  // =========================================================================
  for (const col of ['reward_amount_cents', 'is_verified']) {
    if (await knex.schema.hasColumn('referral_clicks', col)) {
      await knex.schema.alterTable('referral_clicks', (t) => { t.dropColumn(col); });
    }
  }

  const clickCols = {
    referral_code: () => (t) => t.string('referral_code', 20),
    user_agent: () => (t) => t.text('user_agent'),
    referer_url: () => (t) => t.text('referer_url'),
    device_type: () => (t) => t.string('device_type', 20),
    is_unique: () => (t) => t.boolean('is_unique').defaultTo(true),
    fingerprint: () => (t) => t.string('fingerprint', 64),
    converted_to_lead: () => (t) => t.boolean('converted_to_lead').defaultTo(false),
    lead_id: () => (t) => t.uuid('lead_id'),
  };

  for (const [col, builder] of Object.entries(clickCols)) {
    if (!(await knex.schema.hasColumn('referral_clicks', col))) {
      await knex.schema.alterTable('referral_clicks', builder());
    }
  }

  // =========================================================================
  // D. ALTER referral_payouts — drop Square, add unified
  // =========================================================================
  for (const col of ['square_invoice_id', 'square_order_id', 'square_discount_id']) {
    if (await knex.schema.hasColumn('referral_payouts', col)) {
      await knex.schema.alterTable('referral_payouts', (t) => { t.dropColumn(col); });
    }
  }

  const payoutCols = {
    payout_method: () => (t) => t.string('payout_method', 20),
    external_reference: () => (t) => t.string('external_reference'),
    tax_year: () => (t) => t.integer('tax_year'),
    ytd_total_at_payout: () => (t) => t.integer('ytd_total_at_payout'),
    requires_1099: () => (t) => t.boolean('requires_1099').defaultTo(false),
  };

  for (const [col, builder] of Object.entries(payoutCols)) {
    if (!(await knex.schema.hasColumn('referral_payouts', col))) {
      await knex.schema.alterTable('referral_payouts', builder());
    }
  }

  // =========================================================================
  // E. CREATE referral_program_settings (single-row config)
  // =========================================================================
  if (!(await knex.schema.hasTable('referral_program_settings'))) {
    await knex.schema.createTable('referral_program_settings', (t) => {
      t.integer('id').primary().defaultTo(1);
      t.boolean('program_active').defaultTo(true);
      t.string('base_url', 500).defaultTo('https://wavespestcontrol.com/r/');
      t.integer('referrer_reward_cents').defaultTo(5000);
      t.integer('referee_discount_cents').defaultTo(2500);
      t.integer('bonus_silver_cents').defaultTo(5000);
      t.integer('bonus_gold_cents').defaultTo(7500);
      t.integer('bonus_platinum_cents').defaultTo(10000);
      t.integer('milestone_3_bonus_cents').defaultTo(2500);
      t.integer('milestone_5_bonus_cents').defaultTo(5000);
      t.integer('milestone_10_bonus_cents').defaultTo(10000);
      t.integer('min_payout_cents').defaultTo(1000);
      t.boolean('auto_credit_enabled').defaultTo(true);
      t.boolean('require_service_completion').defaultTo(true);
      t.integer('max_referrals_per_month').defaultTo(20);
      t.integer('cooldown_days').defaultTo(30);
      t.text('invite_sms_template');
      t.text('reward_sms_template');
      t.text('milestone_sms_template');
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });

    // Seed defaults
    await knex('referral_program_settings').insert({
      id: 1,
      invite_sms_template: 'Hi {referee_name}! Your neighbor {referrer_name} thinks you\'d love Waves Pest Control. You\'ll both save when you sign up: {referral_link}',
      reward_sms_template: 'Great news, {referrer_name}! Your referral {referee_name} signed up. You earned {reward_amount} in credit!',
      milestone_sms_template: 'Congrats {referrer_name}! You hit the {milestone_level} milestone with {count} referrals. Bonus: {bonus_amount}!',
    }).onConflict('id').ignore();
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('referral_program_settings');

  // Restore dropped columns (best-effort, order matters)
  const restoreCols = [
    ['referral_payouts', ['square_invoice_id', 'square_order_id', 'square_discount_id'], 'string'],
    ['referral_clicks', ['reward_amount_cents'], 'integer'],
    ['referral_clicks', ['is_verified'], 'boolean'],
    ['referral_promoters', ['clicki_referral_link'], 'text'],
    ['referral_promoters', ['clicki_promoter_id'], 'string'],
    ['referral_promoters', ['click_balance_cents'], 'integer'],
  ];

  for (const [table, cols, type] of restoreCols) {
    for (const col of cols) {
      if (!(await knex.schema.hasColumn(table, col))) {
        await knex.schema.alterTable(table, (t) => {
          if (type === 'integer') t.integer(col);
          else if (type === 'boolean') t.boolean(col);
          else if (type === 'text') t.text(col);
          else t.string(col);
        });
      }
    }
  }

  // Drop added columns from referrals
  const addedReferralCols = ['promoter_id', 'lead_id', 'service_interest', 'source', 'referrer_reward_amount', 'referrer_reward_status', 'referee_discount_applied', 'converted_tier', 'converted_monthly_value', 'first_service_completed', 'lost_reason', 'expires_at'];
  for (const col of addedReferralCols) {
    if (await knex.schema.hasColumn('referrals', col)) {
      await knex.schema.alterTable('referrals', (t) => { t.dropColumn(col); });
    }
  }

  // Drop added columns from referral_clicks
  const addedClickCols = ['referral_code', 'user_agent', 'referer_url', 'device_type', 'is_unique', 'fingerprint', 'converted_to_lead', 'lead_id'];
  for (const col of addedClickCols) {
    if (await knex.schema.hasColumn('referral_clicks', col)) {
      await knex.schema.alterTable('referral_clicks', (t) => { t.dropColumn(col); });
    }
  }

  // Drop added columns from referral_payouts
  const addedPayoutCols = ['payout_method', 'external_reference', 'tax_year', 'ytd_total_at_payout', 'requires_1099'];
  for (const col of addedPayoutCols) {
    if (await knex.schema.hasColumn('referral_payouts', col)) {
      await knex.schema.alterTable('referral_payouts', (t) => { t.dropColumn(col); });
    }
  }

  // Drop added columns from referral_promoters
  const addedPromoterCols = ['referral_code', 'referral_link', 'milestone_level', 'milestone_earned_at', 'available_balance_cents', 'pending_earnings_cents', 'last_share_at', 'last_referral_at'];
  for (const col of addedPromoterCols) {
    if (await knex.schema.hasColumn('referral_promoters', col)) {
      await knex.schema.alterTable('referral_promoters', (t) => { t.dropColumn(col); });
    }
  }
};
