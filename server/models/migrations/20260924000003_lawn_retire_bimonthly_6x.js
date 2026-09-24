// Retire the 6-application/yr ("Bi-Monthly") residential lawn tier for NEW
// sales (owner directive 2026-09-24: "i dont want to offer bi-monthly lawn
// care service anymore, remove this from the estimate and services"). 9x
// (enhanced, the default) and 12x (premium) are unaffected — this mirrors
// the 2026-07-09/2026-08-04 basic/4x retirement's FIRST step (hidden, not
// removed) exactly, one migration doing both halves of that precedent:
//
// 1. pricing_config lawn_pricing_v2.tiers.standard → hidden:true (mirrors
//    20260709000050_lawn_program_minimum_retire_quarterly's tiers.basic
//    shape and reversible down). db-bridge maps this onto
//    LAWN_TIERS.standard.hidden, which drops it from priceLawnCare's
//    customer-facing tiers array (new quotes fall back to enhanced, the
//    existing hidden-tier mechanism) while the tier/bracket column itself
//    stays in LAWN_TIERS/LAWN_SOLD_TIERS as the internal price anchor
//    (lookupLawnBracket's 9x/12x discount caps, priceOneTimeLawn's
//    includeHiddenTiers anchor call) — so re-enabling it needs no deploy,
//    and 9x/12x prices are untouched. The in-code default in constants.js
//    carries the same hidden:true so a fresh DB/no-row also hides it.
// 2. services.public_quote_selectable=false for lawn_care_recurring ("
//    Bi-Monthly Lawn Care Service", the ONLY catalog row selling this
//    tier) — mirrors 20260903000020_public_quote_menu_tier_c_hide.js's
//    seed-once/state-tracked/no-op-down contract exactly: a re-run never
//    re-flips a row an admin re-selected, and down() is a documented
//    no-op because a "still false" row can't be told apart from that
//    admin choice. is_active stays true (historic/completed visits
//    reference the row); the estimate tool, the admin bracket editor, and
//    the Service Library "Quote Form Selectable" checkbox are one-click
//    reverts for each half independently.
//
// A stored estimate/estimate accept that still carries the retired 6x/
// bimonthly cadence does NOT silently reprice at 9x — estimate-public.js's
// retired-cadence requote gate (recurringLawnRowAtRetiredCadence /
// isRetiredLawnTierKey, both already generalized over LAWN_TIERS.*.hidden)
// 409s it toward a requote, exactly like a stored 4x/quarterly row.

const ROW_NAME = 'Lawn Pricing V2 Dense 35% Floor + 6x Retired';
const CHANGED_BY = 'claude-2026-09-24';
const STATE_KEY = 'migration.20260924000003.state';
const SERVICE_KEY = 'lawn_care_recurring';

const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: CHANGED_BY,
  category: 'rule',
  summary: 'Retire the 6x/bi-monthly residential lawn tier for new sales; 9x and 12x unaffected.',
};

function parseConfigData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

async function readLawnPricingData(knex) {
  const existing = await knex('pricing_config')
    .where({ config_key: 'lawn_pricing_v2' })
    .first('data');
  return parseConfigData(existing?.data);
}

async function upsertLawnPricingConfig(knex, data, name) {
  const hasIsActive = await knex.schema.hasColumn('pricing_config', 'is_active');
  const row = {
    name,
    category: 'lawn',
    sort_order: 4,
    data: JSON.stringify(data),
    updated_at: knex.fn.now(),
  };
  if (hasIsActive) row.is_active = true;
  const mergeFields = ['name', 'category', 'sort_order', 'data', 'updated_at'];
  if (hasIsActive) mergeFields.push('is_active');

  await knex('pricing_config')
    .insert({ config_key: 'lawn_pricing_v2', ...row, created_at: knex.fn.now() })
    .onConflict('config_key')
    .merge(mergeFields);
}

async function insertAudit(knex, oldSlice, newSlice, reason) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: 'lawn_pricing_v2',
    old_value: JSON.stringify(oldSlice),
    new_value: JSON.stringify(newSlice),
    changed_by: CHANGED_BY,
    reason,
  });
}

async function insertChangelog(knex) {
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['lawn_care']),
    before_value: JSON.stringify({ lawn_pricing_v2: { tiers: { standard: { customerFacing: true, hidden: false } } } }),
    after_value: JSON.stringify({ lawn_pricing_v2: { tiers: { standard: { customerFacing: false, hidden: true } } } }),
    rationale: 'Owner directive 2026-09-24: "i dont want to offer bi-monthly lawn care service anymore, remove this from the estimate and services." The 6-application/yr (standard/bimonthly) residential lawn tier is retired for NEW sales the same way the 4-application/yr (basic/quarterly) tier was on 2026-07-09: hidden from the customer-facing ladder, kept as the internal pricing anchor (the 6x bracket column the 9x/12x frequency discount is measured against), DB-tunable without a deploy. 9x (enhanced, the default) and 12x (premium) prices are unaffected. Existing customers on a 6x plan keep it — nothing here touches scheduled_services or accepted plans — and an outstanding estimate that still quotes 6x requotes through the existing retired-cadence gate instead of silently repricing at 9x.',
  });
}

exports.up = async function up(knex) {
  // 1. lawn_pricing_v2.tiers.standard.hidden = true.
  if (await knex.schema.hasTable('pricing_config')) {
    const existingData = await readLawnPricingData(knex);
    const oldSlice = { tiers: { standard: (existingData.tiers && existingData.tiers.standard) || null } };

    await upsertLawnPricingConfig(knex, {
      ...existingData,
      tiers: {
        ...(existingData.tiers || {}),
        standard: {
          label: '6x applications/yr',
          applicationsPerYear: 6,
          ...((existingData.tiers && existingData.tiers.standard) || {}),
          customerFacing: false,
          hidden: true,
        },
      },
    }, ROW_NAME);

    const newSlice = { tiers: { standard: { customerFacing: false, hidden: true } } };
    await insertAudit(
      knex,
      oldSlice,
      newSlice,
      'Owner directive 2026-09-24: retire the 6x/bi-monthly residential lawn tier for new sales (standard/6x hidden; 9x/12x unaffected).',
    );
    await insertChangelog(knex);
  }

  // 2. services.public_quote_selectable = false for lawn_care_recurring.
  // Same seed-once/state-tracked/no-op-down contract as 20260903000020: a
  // re-run never re-flips a row an admin re-selected, and is_active is left
  // untouched (historic/completed visits still reference the row).
  if (await knex.schema.hasTable('services') && await knex.schema.hasColumn('services', 'public_quote_selectable')) {
    let prior = [];
    const hasState = await knex.schema.hasTable('system_settings');
    if (hasState) {
      const row = await knex('system_settings').where({ key: STATE_KEY }).first();
      try { prior = row ? (JSON.parse(row.value).hiddenIds || []) : []; } catch { prior = []; }
    }
    const rows = await knex('services')
      .where({ service_key: SERVICE_KEY, public_quote_selectable: true })
      .select('id');
    const ids = rows.map((r) => r.id).filter((id) => !prior.includes(id));
    if (ids.length) {
      await knex('services').whereIn('id', ids).where({ public_quote_selectable: true })
        .update({ public_quote_selectable: false, updated_at: knex.fn.now() });
    }
    if (hasState) {
      await knex('system_settings').where({ key: STATE_KEY }).del();
      await knex('system_settings').insert({ key: STATE_KEY, value: JSON.stringify({ hiddenIds: [...new Set([...prior, ...ids])] }) });
    }
  }
};

exports.down = async function down(knex) {
  // 1. Reverse the pricing_config hidden flag explicitly (mirrors
  // 20260709000050's down — OVERRIDE the value, don't just delete the key,
  // since constants.js's in-code default is now hidden:true too).
  if (await knex.schema.hasTable('pricing_config')) {
    if (await knex.schema.hasTable('pricing_changelog')) {
      await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
    }
    const existingData = await readLawnPricingData(knex);
    await upsertLawnPricingConfig(knex, {
      ...existingData,
      tiers: {
        ...(existingData.tiers || {}),
        standard: {
          label: '6x applications/yr',
          applicationsPerYear: 6,
          ...((existingData.tiers && existingData.tiers.standard) || {}),
          customerFacing: true,
          hidden: false,
        },
      },
    }, 'Lawn Pricing V2 Dense 35% Floor');
    await insertAudit(
      knex,
      { tiers: { standard: { customerFacing: false, hidden: true } } },
      { tiers: { standard: { customerFacing: true, hidden: false } } },
      'Rollback: re-enable the 6x/bi-monthly residential lawn tier for new sales.',
    );
  }

  // 2. services.public_quote_selectable: documented no-op, same reasoning as
  // 20260903000020 — a row still false cannot be told apart from an admin
  // deselection. The state row is retained so a later up() stays idempotent.
};

exports.SERVICE_KEY = SERVICE_KEY;
