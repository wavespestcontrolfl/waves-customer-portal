// Lawn program minimum + quarterly retirement (owner directive 2026-07-09).
//
// 1. lawn_pricing_v2.programMinimumMonthly = 45 — no recurring lawn plan is
//    sold below $45/mo on any track/size/cadence. The engine clamps new
//    quotes (priceLawnCare) and the customer ladder re-clamps AFTER
//    WaveGuard/manual discounts (estimate-public), so the bracket bottom
//    cells ($25/mo Bahia, $30/mo St. Augustine) and discount stacking can no
//    longer produce a below-floor plan.
// 2. tiers.basic → hidden (customerFacing: false) — the 4-app/Quarterly
//    cadence is retired for NEW sales. db-bridge maps this metadata onto
//    LAWN_TIERS.basic.hidden, so flipping it back in this row re-enables
//    quarterly without a deploy. Existing quarterly customers are untouched
//    (billing runs off their accepted service records, not the engine).
//
// The lawn_pricing_brackets table is intentionally NOT edited — the bracket
// curve stays as the market reference; the floor clamps on top of it.
//
// Read-modify-write per house rules: this row also carries keys owned by
// other migrations and admin Pricing Logic edits.

const PROGRAM_MINIMUM_MONTHLY = 45;
const ROW_NAME = 'Lawn Pricing V2 Dense 35% Floor + $45 Program Minimum';
const CHANGED_BY = 'claude-2026-07-09';

const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: CHANGED_BY,
  category: 'rule',
  summary: 'Add $45/mo recurring lawn program minimum; retire the quarterly (4-app) cadence for new sales.',
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
    affected_services: JSON.stringify(['lawn_care', 'waveguard_bundle_totals']),
    before_value: JSON.stringify({
      lawn_pricing_v2: { programMinimumMonthly: null, tiers: { basic: { customerFacing: true, hidden: false } } },
    }),
    after_value: JSON.stringify({
      lawn_pricing_v2: { programMinimumMonthly: PROGRAM_MINIMUM_MONTHLY, tiers: { basic: { customerFacing: false, hidden: true } } },
    }),
    rationale: 'Owner directive 2026-07-09: the quarterly lawn bottom cells ($25/mo Bahia, $30/mo St. Augustine at ≤5,000 sqft) priced small-lawn plans far below sustainable account economics, and the 35% cost floor never binds at small sizes (≈$244/yr computed floor vs a $360/yr bracket price). Quarterly (basic/4-app) is retired for NEW sales — 4 apps/yr cannot maintain SWFL turf and it anchors lawn care value at an unsellable sticker — and a hard $45/mo program minimum now holds under every recurring lawn plan, enforced post-WaveGuard and post-manual-discount so Platinum 20% or manual discounts cannot recreate a below-floor price. One-time lawn keeps the raw market baseline (applyProgramMinimum: false) so this floor does not inflate one-time treatment pricing. Existing quarterly customers keep their accepted plans; outstanding estimate links stop offering the quarterly cadence and re-clamp below-floor cadences at view/accept.',
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  const existingData = await readLawnPricingData(knex);
  const oldSlice = {
    programMinimumMonthly: existingData.programMinimumMonthly ?? null,
    tiers: { basic: (existingData.tiers && existingData.tiers.basic) || null },
  };

  await upsertLawnPricingConfig(knex, {
    ...existingData,
    programMinimumMonthly: PROGRAM_MINIMUM_MONTHLY,
    tiers: {
      ...(existingData.tiers || {}),
      basic: {
        label: 'Basic',
        applicationsPerYear: 4,
        ...((existingData.tiers && existingData.tiers.basic) || {}),
        customerFacing: false,
        hidden: true,
      },
    },
  }, ROW_NAME);

  const newSlice = {
    programMinimumMonthly: PROGRAM_MINIMUM_MONTHLY,
    tiers: { basic: { customerFacing: false, hidden: true } },
  };
  await insertAudit(
    knex,
    oldSlice,
    newSlice,
    'Owner directive 2026-07-09: $45/mo recurring lawn program minimum (post-discount); quarterly (basic/4-app) cadence retired for new sales.',
  );
  await insertChangelog(knex);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }

  const existingData = await readLawnPricingData(knex);
  const { programMinimumMonthly, ...rest } = existingData;

  await upsertLawnPricingConfig(knex, {
    ...rest,
    tiers: {
      ...(rest.tiers || {}),
      basic: {
        label: 'Basic',
        applicationsPerYear: 4,
        ...((rest.tiers && rest.tiers.basic) || {}),
        customerFacing: true,
        hidden: false,
      },
    },
  }, 'Lawn Pricing V2 Dense 35% Floor');

  await insertAudit(
    knex,
    { programMinimumMonthly: programMinimumMonthly ?? null, tiers: { basic: { customerFacing: false, hidden: true } } },
    { programMinimumMonthly: null, tiers: { basic: { customerFacing: true, hidden: false } } },
    'Rollback: remove the $45/mo lawn program minimum and re-enable the quarterly cadence.',
  );
};
