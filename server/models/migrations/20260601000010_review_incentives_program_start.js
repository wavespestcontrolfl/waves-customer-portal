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

function validIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

exports.up = async function (knex) {
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
    programStartsAt: validIso(current.programStartsAt) || new Date().toISOString(),
  };

  const row = {
    key: POLICY_KEY,
    value: JSON.stringify(next),
    category: 'reviews',
    description: 'Technician review incentive automation policy; payouts start from program activation',
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

  const existing = await knex('system_settings').where({ key: POLICY_KEY }).first();
  if (!existing) return;

  const current = parsePolicy(existing.value);
  delete current.programStartsAt;

  await knex('system_settings').where({ key: POLICY_KEY }).update({
    value: JSON.stringify(current),
    updated_at: knex.fn.now(),
  });
};
