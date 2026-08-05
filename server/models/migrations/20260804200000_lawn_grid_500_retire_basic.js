/**
 * Lawn bracket re-grid + basic/4x tier retirement (owner directives
 * 2026-08-04, from the accepted/expired funnel review).
 *
 * 1) Re-grid `lawn_pricing_brackets`: 500-sqft rows 1,500–8,000 and
 *    1,000-sqft rows to 12,000 (then 15,000 / 20,000) for finer owner
 *    control. Every pre-existing anchor row keeps its exact price; new
 *    in-between rows are the linear interpolation of the old curve rounded
 *    to whole dollars. New sub-3,000 rows taper small-lawn tickets that
 *    previously clamped to the first bracket (that segment closed 0-for-12
 *    under the current table); every new cell verified ≥35% list margin
 *    against the engine cost model. st_augustine 3,000-row 9x softened
 *    47 → 44 ($62.67 → $58.67/app — puts the 3,000–3,300 sqft rate under
 *    the $20/1k-sqft dead zone found in the funnel).
 * 2) Retire basic/4x END TO END: its bracket rows are deleted and the
 *    tier meta removed from lawn_pricing_v2 — a half-removed hidden column
 *    would make db-bridge seed $0 basic cells for any bracket row without
 *    one. Sold tiers are 6x / 9x / 12x only (code LAWN_TIERS matches).
 * 3) Tier display names become application counts (no Standard/Enhanced/
 *    Premium naming — owner directive); keys are unchanged.
 *
 * lawn_pricing_brackets is DB/admin-authoritative (db-bridge overlays it
 * onto constants.LAWN_BRACKETS), so the constants.js change in this PR is
 * inert in any env carrying rows unless this migration runs.
 *
 * ROLLBACK CONTRACT — up() captures the complete per-track before-state and
 * the prior lawn_pricing_v2 data in audit rows; down() restores exactly
 * those snapshots (keyed off the up audit rows) and deletes the changelog
 * entry. down()'s audit rows are tagged `${MIGRATION_TAG}:down`.
 */

const MIGRATION_TAG = 'migration:20260804200000';
const UP_REASON = 'Lawn 500-sqft re-grid + sub-3,000 taper + basic/4x retirement + application-count tier names (owner directives 2026-08-04).';
const VERSION_TO = 'LAWN_PRICING_V2_GRID_500';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-04',
  // 'cost' — pricing_changelog_category_check (20260417000004) allows only
  // bug/leak/rule/cost/architecture/documentation/infrastructure; a price
  // retune is 'cost' by that taxonomy (codex #3190 P1 — 'price' would
  // violate the CHECK and fail the deploy mid-migration).
  category: 'cost',
  summary: 'Lawn brackets re-gridded at 500 sqft with sub-3,000 taper; basic/4x tier fully retired.',
};

// [sqft, standard(6x), enhanced(9x), premium(12x)] monthly — owner-approved
// grid 2026-08-04. Anchors reproduce the prior table exactly (except the
// approved st_augustine 3,000 9x soften); other rows are rounded
// interpolations plus the new sub-3,000 taper.
const GRIDS = {
  st_augustine: [
    [1500, 30, 34, 40], [2000, 32, 38, 44], [2500, 35, 42, 49], [3000, 38, 44, 55],
    [3500, 38, 47, 58], [4000, 38, 47, 62], [4500, 38, 48, 64], [5000, 38, 50, 66],
    [5500, 38, 53, 70], [6000, 39, 56, 74], [6500, 40, 59, 78], [7000, 42, 62, 82],
    [7500, 44, 65, 86], [8000, 47, 68, 90], [9000, 50, 74, 98], [10000, 54, 80, 106],
    [11000, 58, 86, 114], [12000, 62, 92, 122], [15000, 73, 110, 146], [20000, 91, 140, 186],
  ],
  bermuda: [
    [1500, 31, 36, 42], [2000, 34, 40, 46], [2500, 37, 44, 52], [3000, 39, 46, 56],
    [3500, 40, 49, 59], [4000, 42, 51, 63], [4500, 42, 51, 65], [5000, 42, 51, 68],
    [5500, 42, 54, 72], [6000, 42, 57, 76], [6500, 42, 60, 80], [7000, 43, 63, 84],
    [7500, 45, 66, 88], [8000, 47, 69, 92], [9000, 51, 75, 100], [10000, 55, 81, 108],
    [11000, 59, 87, 116], [12000, 63, 94, 125], [15000, 74, 112, 149], [20000, 94, 143, 190],
  ],
  zoysia: [
    [1500, 31, 36, 42], [2000, 34, 40, 46], [2500, 37, 44, 52], [3000, 39, 46, 56],
    [3500, 40, 49, 59], [4000, 42, 51, 63], [4500, 42, 51, 66], [5000, 42, 52, 69],
    [5500, 42, 55, 73], [6000, 42, 58, 77], [6500, 43, 60, 80], [7000, 44, 63, 84],
    [7500, 45, 66, 88], [8000, 47, 70, 93], [9000, 51, 76, 101], [10000, 56, 82, 109],
    [11000, 59, 88, 117], [12000, 63, 95, 126], [15000, 75, 113, 150], [20000, 95, 145, 193],
  ],
  bahia: [
    [1500, 27, 30, 36], [2000, 29, 34, 39], [2500, 31, 38, 44], [3000, 34, 42, 51],
    [3500, 34, 42, 53], [4000, 34, 42, 56], [4500, 34, 44, 58], [5000, 34, 47, 62],
    [5500, 35, 49, 65], [6000, 36, 52, 69], [6500, 37, 54, 72], [7000, 39, 57, 76],
    [7500, 40, 59, 78], [8000, 42, 62, 82], [9000, 45, 67, 89], [10000, 49, 73, 97],
    [11000, 52, 78, 103], [12000, 56, 83, 110], [15000, 65, 99, 132], [20000, 82, 125, 166],
  ],
};
const TIER_COLUMNS = ['standard', 'enhanced', 'premium'];
const TIER_LABELS = {
  standard: '6 Applications / Year',
  enhanced: '9 Applications / Year',
  premium: '12 Applications / Year',
};

async function auditInsert(knex, oldValue, newValue, tag, reason, configKey = 'lawn_pricing_brackets') {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: configKey,
    old_value: oldValue == null ? null : JSON.stringify(oldValue),
    new_value: newValue == null ? null : JSON.stringify(newValue),
    changed_by: tag,
    reason,
  });
}

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_pricing_brackets'))) return;

  for (const [track, rows] of Object.entries(GRIDS)) {
    // Locking read (knex runs migrations in a transaction): an admin saving
    // this track through the Pricing Logic panel mid-deploy must serialize
    // with the wholesale replacement below.
    const before = await knex('lawn_pricing_brackets')
      .where({ grass_track: track })
      .orderBy('sqft_bracket').orderBy('tier')
      .forUpdate();
    const beforeSnapshot = before.map((r) => ({
      sqft_bracket: Number(r.sqft_bracket), tier: r.tier, monthly_price: Number(r.monthly_price),
    }));
    const inserts = [];
    for (const [sqft, std, enh, prem] of rows) {
      const prices = { standard: std, enhanced: enh, premium: prem };
      for (const tier of TIER_COLUMNS) {
        inserts.push({ grass_track: track, sqft_bracket: sqft, tier, monthly_price: prices[tier] });
      }
    }
    await knex('lawn_pricing_brackets').where({ grass_track: track }).del();
    await knex('lawn_pricing_brackets').insert(inserts);
    await auditInsert(knex, beforeSnapshot, inserts.map(({ grass_track, ...cell }) => cell),
      MIGRATION_TAG, `${UP_REASON} [track=${track}]`);
  }

  // lawn_pricing_v2 tier meta: drop basic, application-count labels, and
  // advance pricingVersion so pre/post-reprice estimates stay
  // distinguishable in estimates.pricing_version.
  if (await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: 'lawn_pricing_v2' }).forUpdate().first();
    if (row) {
      const oldData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
      if (oldData && typeof oldData === 'object' && !Array.isArray(oldData)) {
        const newData = { ...oldData, pricingVersion: VERSION_TO };
        if (newData.tiers && typeof newData.tiers === 'object') {
          const tiers = { ...newData.tiers };
          delete tiers.basic;
          for (const key of TIER_COLUMNS) {
            if (tiers[key] && typeof tiers[key] === 'object') {
              tiers[key] = { ...tiers[key], label: TIER_LABELS[key] };
            }
          }
          newData.tiers = tiers;
        }
        await knex('pricing_config')
          .where({ config_key: 'lawn_pricing_v2' })
          .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
        await auditInsert(knex, oldData, newData, MIGRATION_TAG, UP_REASON, 'lawn_pricing_v2');
      }
    }
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ grid: 'pre-2026-08-04 tables (see pricing_config_audit rows tagged ' + MIGRATION_TAG + ')' }),
        after_value: JSON.stringify({ grid: '500-sqft grid 1,500-8,000 + 1,000-sqft to 12,000; sub-3,000 taper; st_augustine 3,000 9x 47->44; basic/4x retired' }),
        rationale: 'Owner directives 2026-08-04 from the accepted/expired funnel review: sub-3,000 sqft lawns clamped to the first bracket row and closed 0-for-12 (median $28/1k-sqft/app vs a $12-18 winning band); new rows taper small-lawn tickets to $40-58/app at 40-46% list margin. Finer 500-sqft grid gives direct owner control where quotes concentrate; anchor rows keep their exact prices so no existing size repricess beyond rounding (<=$0.50/mo). basic/4x fully retired (extends the 2026-07-09 no-quarterly ruling); tier names become application counts.',
      });
    }
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const upAudits = await knex('pricing_config_audit')
    .where({ changed_by: MIGRATION_TAG })
    .orderBy('id');
  if (!upAudits.length) return;

  for (const audit of upAudits) {
    if (audit.config_key === 'lawn_pricing_brackets') {
      const match = /\[track=([a-z_0-9]+)\]/.exec(audit.reason || '');
      if (!match) continue;
      const track = match[1];
      const snapshot = typeof audit.old_value === 'string' ? JSON.parse(audit.old_value) : audit.old_value;
      if (!Array.isArray(snapshot)) continue;
      await knex('lawn_pricing_brackets').where({ grass_track: track }).del();
      if (snapshot.length) {
        await knex('lawn_pricing_brackets').insert(snapshot.map((cell) => ({ grass_track: track, ...cell })));
      }
      await auditInsert(knex, null, snapshot, `${MIGRATION_TAG}:down`,
        `Rollback: restore pre-re-grid lawn brackets [track=${track}]`);
    } else if (audit.config_key === 'lawn_pricing_v2') {
      const oldData = typeof audit.old_value === 'string' ? JSON.parse(audit.old_value) : audit.old_value;
      if (oldData && (await knex.schema.hasTable('pricing_config'))) {
        await knex('pricing_config')
          .where({ config_key: 'lawn_pricing_v2' })
          .update({ data: JSON.stringify(oldData), updated_at: knex.fn.now() });
        await auditInsert(knex, null, oldData, `${MIGRATION_TAG}:down`,
          'Rollback: restore pre-re-grid lawn_pricing_v2 tier meta', 'lawn_pricing_v2');
      }
    }
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
