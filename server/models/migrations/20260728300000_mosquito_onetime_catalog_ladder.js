/**
 * Align the hand-scheduled one-time mosquito catalog defaults to the lot
 * ladder (owner decision 2026-07-28).
 *
 * `services.mosquito_one_time.base_price` was $250 from the deliberate
 * 2026-07-09 scheduling-default batch, and admin-schedule bills hand-scheduled
 * one-times from it regardless of lot size. The owner has now aligned this
 * path with the #3026 lot ladder: admin-schedule computes the ladder price
 * from the customer's lot size when no price is typed (same PR), so the
 * catalog row becomes the no-lot-data fallback and the range display —
 * base $149 (SMALL entry), range $149–269 (through one acre).
 *
 * ROLLBACK CONTRACT — up() snapshots the pre-migration values into the
 * pricing_changelog row's before_value; down() restores each field only while
 * it still holds the value up() applied (an operator-edited field is left
 * alone). No changelog row/table means no proof of ownership; leave data
 * alone.
 */
const CHANGELOG_IDENTITY = {
  version_from: 'v4.3',
  version_to: 'v4.3',
  changed_by: 'claude-2026-07-28',
  category: 'rule',
  summary: 'Align hand-scheduled one-time mosquito catalog defaults to the lot ladder.',
};

const NEW_VALUES = { base_price: 149, price_range_min: 149, price_range_max: 269 };

function toComparable(value) {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : value;
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const row = await knex('services')
    .where({ service_key: 'mosquito_one_time' })
    .first('base_price', 'price_range_min', 'price_range_max');
  if (!row) return;

  await knex('services').where({ service_key: 'mosquito_one_time' }).update({
    ...NEW_VALUES,
    updated_at: knex.fn.now(),
  });

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['one_time_mosquito']),
        before_value: JSON.stringify({
          services_mosquito_one_time: {
            base_price: toComparable(row.base_price),
            price_range_min: toComparable(row.price_range_min),
            price_range_max: toComparable(row.price_range_max),
          },
        }),
        after_value: JSON.stringify({ services_mosquito_one_time: NEW_VALUES }),
        rationale: 'Owner decision 2026-07-28: hand-scheduled one-time mosquito now follows the #3026 lot ladder — admin-schedule computes priceOneTimeMosquito from the customer lot size when no price is typed. The catalog base becomes the no-lot-data fallback ($149 SMALL entry) and the range display ($149-269 through one acre; over-acre keeps climbing $40/10k sf in the engine). Supersedes the flat $250 scheduling default from the 2026-07-09 batch for this one service; the rest of that batch is untouched.',
      });
    }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const entry = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id', 'before_value');
  if (!entry) return;

  const captured = (() => {
    try {
      const parsed = typeof entry.before_value === 'string' ? JSON.parse(entry.before_value) : entry.before_value;
      return parsed?.services_mosquito_one_time || null;
    } catch {
      return null;
    }
  })();

  const row = await knex('services')
    .where({ service_key: 'mosquito_one_time' })
    .first('base_price', 'price_range_min', 'price_range_max');
  if (captured && row) {
    const restore = {};
    for (const field of Object.keys(NEW_VALUES)) {
      // Restore only fields still holding the value up() applied.
      if (toComparable(row[field]) === NEW_VALUES[field]) restore[field] = captured[field];
    }
    if (Object.keys(restore).length) {
      await knex('services').where({ service_key: 'mosquito_one_time' }).update({
        ...restore,
        updated_at: knex.fn.now(),
      });
    }
  }

  await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
};
