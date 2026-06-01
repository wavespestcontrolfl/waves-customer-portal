const POLICY_KEY = 'review_incentives.policy';

function parsePolicy(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

exports.up = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS uq_review_incentive_payouts_review_request');

  if (!(await knex.schema.hasTable('system_settings'))) return;

  const existing = await knex('system_settings').where({ key: POLICY_KEY }).first();
  const current = parsePolicy(existing?.value);
  const next = {
    enabled: current.enabled !== false,
    amountCents: Number.isFinite(Number(current.amountCents)) ? Number(current.amountCents) : 500,
    currency: current.currency || 'USD',
    eligibleSources: ['google_review'],
    minRating: Number.isFinite(Number(current.minRating)) ? Number(current.minRating) : 1,
    requireCustomerMatchForGoogle: current.requireCustomerMatchForGoogle !== false,
  };

  const row = {
    key: POLICY_KEY,
    value: JSON.stringify(next),
    category: 'reviews',
    description: 'Technician review incentive automation policy; payouts require confirmed Google reviews',
    updated_at: knex.fn.now(),
  };

  if (existing) {
    await knex('system_settings').where({ key: POLICY_KEY }).update(row);
  } else {
    await knex('system_settings').insert({
      ...row,
      created_at: knex.fn.now(),
    });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return;

  if (await knex.schema.hasTable('review_incentive_payouts')) {
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_review_incentive_payouts_review_request
      ON review_incentive_payouts (review_request_id)
      WHERE review_request_id IS NOT NULL
    `);
  }

  const existing = await knex('system_settings').where({ key: POLICY_KEY }).first();
  if (!existing) return;
  const current = parsePolicy(existing.value);
  await knex('system_settings').where({ key: POLICY_KEY }).update({
    value: JSON.stringify({
      ...current,
      eligibleSources: ['review_request', 'google_review'],
    }),
    updated_at: knex.fn.now(),
  });
};
