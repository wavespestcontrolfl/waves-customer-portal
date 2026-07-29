/**
 * Retune the Premium (12x) lawn bracket column so the per-application ladder
 * never inverts (owner directive 2026-07-28, pricing audit).
 *
 * The 06-17 35%-recalibration column priced 12x ABOVE 9x per application for
 * turf ≥ ~4,100 sqft (e.g. st_augustine 6,000 sqft: 12x $81/app vs 9x
 * $74.67/app) — on estimate cards that lead with per-application price, the
 * most frequent plan read as the most expensive per visit. Rule:
 * premium_monthly = min(current, floor(enhanced_monthly × 12/9)), i.e. 12x
 * per-app ≤ 9x per-app at every bracket (the engine additionally enforces
 * the cap on interpolated lookups).
 *
 * lawn_pricing_brackets is DB/admin-authoritative, so up() derives the cap
 * from the LIVE enhanced row of each bracket and only ever LOWERS a premium
 * cell that exceeds it — an operator-authored value at or under the cap is
 * never raised or overwritten. On the untouched 06-17 seed this moves
 * exactly the 33 cells documented in PREMIUM_RETUNE below (kept as the
 * rollback fallback); sqft=0 seed rows and small-lawn cells sit under the
 * cap and are skipped naturally.
 *
 * Also advances lawn_pricing_v2.pricingVersion → LAWN_PRICING_V2_LADDER_CAP
 * so estimates priced before/after the reprice stay distinguishable in
 * estimates.pricing_version.
 *
 * ROLLBACK CONTRACT — down() restores from the audit snapshot up() wrote
 * (live before-values, including pre-deploy drift), and only for cells that
 * STILL hold the value up() applied; a cell an operator edited afterward is
 * left alone. The captured prior pricingVersion is restored the same way.
 * down()'s audit rows are tagged `${MIGRATION_TAG}:down` so re-runs never
 * mistake them for the up capture. The hardcoded table below is only the
 * fallback when no snapshot exists.
 */

const MIGRATION_TAG = 'migration:20260729010000';
const VERSION_FROM = 'LAWN_PRICING_V2_SPOT_RESERVE';
const VERSION_TO = 'LAWN_PRICING_V2_LADDER_CAP';
// 12x visits / 9x visits — per-app prices are equal when premium_monthly =
// enhanced_monthly × this ratio.
const PREMIUM_OVER_ENHANCED_FREQ_RATIO = 12 / 9;
// pricing_changelog.version_from/to are varchar(10) engine versions by
// convention — the lawn pricing-version tokens live in before/after_value.
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-07-29',
  category: 'rule',
  summary: 'Premium 12x lawn bracket retune: per-application ladder never inverts (12x ≤ 9x per app).',
};

// Expected effect on the untouched 06-17 seed: [sqft, old, new] per track.
// DOCUMENTATION + rollback fallback only — up() derives everything live.
const PREMIUM_RETUNE = {
  st_augustine: [
    [5000, 71, 66], [6000, 81, 74], [7000, 91, 82], [8000, 100, 90],
    [10000, 118, 106], [12000, 137, 122], [15000, 165, 146], [20000, 212, 186],
  ],
  bermuda: [
    [5000, 73, 68], [6000, 82, 76], [7000, 91, 84], [8000, 102, 92],
    [10000, 120, 108], [12000, 140, 125], [15000, 168, 149], [20000, 217, 190],
  ],
  zoysia: [
    [5000, 74, 69], [6000, 83, 77], [7000, 93, 84], [8000, 102, 93],
    [10000, 122, 109], [12000, 141, 126], [15000, 171, 150], [20000, 219, 193],
  ],
  bahia: [
    [4000, 58, 56], [5000, 66, 62], [6000, 74, 69], [7000, 82, 76],
    [8000, 91, 82], [10000, 107, 97], [12000, 123, 110], [15000, 147, 132],
    [20000, 189, 166],
  ],
};

async function auditInsert(knex, oldValue, newValue, tag, reason) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: 'lawn_pricing_brackets',
    old_value: oldValue == null ? null : JSON.stringify(oldValue),
    new_value: newValue == null ? null : JSON.stringify(newValue),
    changed_by: tag,
    reason,
  });
}

async function loadLatestUpAudit(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return null;
  const audit = await knex('pricing_config_audit')
    .where({ config_key: 'lawn_pricing_brackets', changed_by: MIGRATION_TAG })
    .orderBy('id', 'desc')
    .first();
  if (!audit?.old_value || !audit?.new_value) return null;
  try {
    return { before: JSON.parse(audit.old_value), after: JSON.parse(audit.new_value) };
  } catch {
    return null;
  }
}

async function mergeConfigVersion(knex, version) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const existing = await knex('pricing_config').where({ config_key: 'lawn_pricing_v2' }).first();
  if (!existing) return null;
  let data = {};
  try { data = typeof existing.data === 'string' ? JSON.parse(existing.data) : (existing.data || {}); }
  catch { data = {}; }
  const prior = data.pricingVersion || null;
  // Read-modify-write: this row carries keys owned by other migrations and
  // admin edits (tiers metadata, floor kill state) — merge, never replace.
  const merged = { ...data, pricingVersion: version };
  await knex('pricing_config')
    .where({ config_key: 'lawn_pricing_v2' })
    .update({ data: JSON.stringify(merged), updated_at: knex.fn.now() });
  return prior;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lawn_pricing_brackets'))) return;

  // Live-derived cap: only ever LOWER a premium cell above its bracket's
  // enhanced-based cap. Never raises an admin-authored value.
  const premiumRows = await knex('lawn_pricing_brackets').where({ tier: 'premium' });
  const applied = [];
  for (const row of premiumRows) {
    const enhanced = await knex('lawn_pricing_brackets')
      .where({ grass_track: row.grass_track, sqft_bracket: row.sqft_bracket, tier: 'enhanced' })
      .first();
    if (!enhanced) continue;
    const cap = Math.floor(Number(enhanced.monthly_price) * PREMIUM_OVER_ENHANCED_FREQ_RATIO);
    const before = Number(row.monthly_price);
    if (!(cap > 0) || before <= cap) continue;
    // Conditional on the observed value so a concurrent edit is not clobbered.
    const updated = await knex('lawn_pricing_brackets')
      .where({ id: row.id, monthly_price: row.monthly_price })
      .update({ monthly_price: cap, updated_at: knex.fn.now() });
    if (updated) applied.push({ track: row.grass_track, sqft: row.sqft_bracket, before, after: cap });
  }

  const priorVersion = await mergeConfigVersion(knex, VERSION_TO);

  await auditInsert(
    knex,
    { premiumCells: applied.map(({ track, sqft, before }) => ({ track, sqft, monthly: before })), pricingVersion: priorVersion },
    { premiumCells: applied.map(({ track, sqft, after }) => ({ track, sqft, monthly: after })), pricingVersion: VERSION_TO },
    MIGRATION_TAG,
    'Premium 12x ladder retune (owner directive 2026-07-28): premium cells above floor(enhanced × 12/9) lowered to the cap; pricingVersion advanced to LAWN_PRICING_V2_LADDER_CAP.',
  );

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ lawnPricingVersion: VERSION_FROM, premiumCells: applied.map(({ track, sqft, before }) => ({ track, sqft, monthly: before })) }),
        after_value: JSON.stringify({ lawnPricingVersion: VERSION_TO, premiumCells: applied.map(({ track, sqft, after }) => ({ track, sqft, monthly: after })) }),
        rationale: 'Owner directive 2026-07-28 (pricing audit): the 06-17 Premium column priced 12x above 9x per application for turf >= ~4,100 sqft, so the most frequent plan read as the most expensive per visit on estimate cards. Rule: premium_monthly = min(current, floor(enhanced_monthly x 12/9)) — 12x per-app <= 9x per-app at every bracket; the engine also caps interpolated lookups. On the 06-17 seed this lowers 33 cells across 4 tracks (up to $26/mo at 20k sqft); small lawns unchanged; admin-authored cells at or under the cap are never raised. Some large-lawn cells land ~30.8-32.5% against the 35% report-only margin reference (enforcement disarmed 07-17). Constants and the client mirror move in the same PR; lawn pricingVersion advances to LAWN_PRICING_V2_LADDER_CAP so pre/post-reprice estimates stay distinguishable.',
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('lawn_pricing_brackets'))) return;

  const snapshot = await loadLatestUpAudit(knex);
  const beforeMap = new Map();
  const afterMap = new Map();
  if (snapshot) {
    for (const cell of snapshot.before.premiumCells || []) beforeMap.set(`${cell.track}|${cell.sqft}`, Number(cell.monthly));
    for (const cell of snapshot.after.premiumCells || []) afterMap.set(`${cell.track}|${cell.sqft}`, Number(cell.monthly));
  } else {
    // No audit trail — fall back to the documented 06-17 seed effect.
    for (const [track, cells] of Object.entries(PREMIUM_RETUNE)) {
      for (const [sqft, prev, next] of cells) {
        beforeMap.set(`${track}|${sqft}`, prev);
        afterMap.set(`${track}|${sqft}`, next);
      }
    }
  }

  const restored = [];
  const skipped = [];
  for (const [key, appliedVal] of afterMap.entries()) {
    const [track, sqftText] = key.split('|');
    const sqft = Number(sqftText);
    const row = await knex('lawn_pricing_brackets')
      .where({ grass_track: track, sqft_bracket: sqft, tier: 'premium' })
      .first();
    if (!row) continue;
    const current = Number(row.monthly_price);
    // Only unwind cells still holding the value up() applied — a later
    // operator edit through /admin/pricing-config/lawn-brackets wins.
    if (current !== appliedVal) { skipped.push({ track, sqft, current }); continue; }
    const restoreTo = beforeMap.get(key);
    if (!(restoreTo > 0)) continue;
    await knex('lawn_pricing_brackets')
      .where({ id: row.id })
      .update({ monthly_price: restoreTo, updated_at: knex.fn.now() });
    restored.push({ track, sqft, monthly: restoreTo });
  }

  // Version token unwinds to the CAPTURED prior version (an admin/migration
  // may have stamped something other than SPOT_RESERVE before up() ran);
  // only if nothing re-advanced it since.
  if (await knex.schema.hasTable('pricing_config')) {
    const existing = await knex('pricing_config').where({ config_key: 'lawn_pricing_v2' }).first();
    if (existing) {
      let data = {};
      try { data = typeof existing.data === 'string' ? JSON.parse(existing.data) : (existing.data || {}); }
      catch { data = {}; }
      if (data.pricingVersion === VERSION_TO) {
        const priorVersion = (snapshot && snapshot.before.pricingVersion) || VERSION_FROM;
        await mergeConfigVersion(knex, priorVersion);
      }
    }
  }

  await auditInsert(
    knex,
    { restoredFrom: VERSION_TO },
    { premiumCells: restored, skippedOperatorEditedCells: skipped },
    `${MIGRATION_TAG}:down`,
    'Rollback of the Premium 12x ladder retune; operator-edited cells left untouched; pricingVersion restored from the up() capture.',
  );

  if (await knex.schema.hasTable('pricing_changelog')) {
    const identity = { ...CHANGELOG_IDENTITY, summary: 'Rollback: Premium 12x lawn bracket retune reverted.' };
    const existing = await knex('pricing_changelog').where(identity).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...identity,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ lawnPricingVersion: VERSION_TO }),
        after_value: JSON.stringify({ premiumCells: restored, skippedOperatorEditedCells: skipped }),
        rationale: 'migrate:down of 20260729010000 — restored the audit-captured Premium values for cells still holding the retuned amounts; cells edited by an operator after the retune were preserved.',
      });
    }
  }
};
