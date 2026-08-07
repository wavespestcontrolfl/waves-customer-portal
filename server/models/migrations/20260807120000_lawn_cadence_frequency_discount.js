/**
 * Give the lawn cadences a real per-application frequency discount
 * (owner directive 2026-08-07).
 *
 * PROBLEM. The estimate card leads with the per-application price (owner
 * 2026-07-23: lawn bills per application). After the 2026-07-28 ladder cap
 * (12x per-app never above 9x) the three cadences converged to within ~1.5%
 * per application at large lawns — 12,500 sqft St. Augustine rendered
 * $128.00 / $126.67 / $126.00, which reads to a customer as a broken page
 * rather than three different programs.
 *
 * RULE. Each higher-frequency cadence lands at a fixed per-application
 * discount off the 6x anchor at the same bracket:
 *   9x  per-app <= 6x per-app * 0.96   ->  enhanced_monthly <= floor(std * 1.44)
 *   12x per-app <= 6x per-app * 0.92   ->  premium_monthly  <= floor(std * 1.84)
 * (pa(v) = monthly * 12 / v, so the monthly ratio carries the visit ratio.)
 * The engine additionally enforces both caps on interpolated lookups.
 *
 * SIZING. Lawn is not pest. Pest cost per visit falls with frequency (the
 * truck roll dominates), which funds the PEST v2 curve 1.00/0.88/0.78. Lawn
 * cost per visit is FLAT across cadences because materials are applied every
 * visit — 12,500 sqft St. Augustine measures $86.33/visit at 6x, $91.99 at
 * 9x, $86.48 at 12x. The discount is therefore funded entirely out of the
 * higher plans' larger absolute profit, and -4%/-8% is the measured maximum
 * that keeps annual profit RISING with frequency (12x > 9x > 6x) at every
 * bracket the caps bind on. A -10%/-20% curve was modeled and rejected: it
 * made the 12x plan less profitable than 6x at every lawn size.
 *
 * SCOPE. The caps bind from ~5,500 sqft up (~10-12 rows per track, 44 cells
 * total). Smaller brackets already separated naturally and are untouched, so
 * the pre-existing small-lawn shape — including the 3,000/4,500 rows where
 * 9x already earns under 6x — is preserved exactly.
 *
 * lawn_pricing_brackets is DB/admin-authoritative, so up() derives each cap
 * from the LIVE standard row of the same bracket and only ever LOWERS a cell
 * that exceeds it — an operator-authored value at or under the cap is never
 * raised or overwritten.
 *
 * Also advances lawn_pricing_v2.pricingVersion -> LAWN_PRICING_V2_FREQ_DISCOUNT
 * so estimates priced before/after the reprice stay distinguishable in
 * estimates.pricing_version.
 *
 * ROLLBACK CONTRACT — down() restores from the audit snapshot up() wrote
 * (live before-values, including pre-deploy drift), and only for cells that
 * STILL hold the value up() applied; a cell an operator edited afterward is
 * left alone. The captured prior pricingVersion is restored the same way.
 * down()'s audit rows are tagged `${MIGRATION_TAG}:down` so re-runs never
 * mistake them for the up capture.
 */

const MIGRATION_TAG = 'migration:20260807120000';
const VERSION_FROM = 'LAWN_PRICING_V2_GRID_500';
const VERSION_TO = 'LAWN_PRICING_V2_FREQ_DISCOUNT';

// Per-application discount off the 6x anchor, converted to a multiplier on
// the MONTHLY cell: monthly_cap = std_monthly * (1 - discount) * visits / 6.
const ENHANCED_MONTHLY_CAP_RATIO = 0.96 * 9 / 6;   // 1.44
const PREMIUM_MONTHLY_CAP_RATIO = 0.92 * 12 / 6;   // 1.84

// pricing_changelog.version_from/to are varchar(10) engine versions by
// convention — the lawn pricing-version tokens live in before/after_value.
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-07',
  category: 'rule',
  summary: 'Lawn cadence frequency discount: 9x -4% and 12x -8% per application off the 6x anchor.',
};

const TIER_CAP_RATIO = {
  enhanced: ENHANCED_MONTHLY_CAP_RATIO,
  premium: PREMIUM_MONTHLY_CAP_RATIO,
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

// Latest up() capture that actually recorded cell changes. A repeat up() on an
// already-migrated table applies nothing, and a bare "newest row wins" lookup
// would then hand down() an EMPTY capture and silently restore nothing — the
// rollback contract has to survive a re-run, so skip capture rows with no cells.
async function loadLatestUpAudit(knex) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return null;
  const audits = await knex('pricing_config_audit')
    .where({ config_key: 'lawn_pricing_brackets', changed_by: MIGRATION_TAG })
    .orderBy('id', 'desc');
  for (const audit of audits) {
    if (!audit?.old_value || !audit?.new_value) continue;
    let parsed;
    try {
      parsed = { before: JSON.parse(audit.old_value), after: JSON.parse(audit.new_value) };
    } catch {
      continue;
    }
    if (Array.isArray(parsed.after?.cells) && parsed.after.cells.length > 0) return parsed;
  }
  return null;
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

  const applied = [];
  // Enhanced first, then premium: the premium cap is also bounded by the
  // (already capped) enhanced cell, so ordering keeps the ladder monotonic.
  for (const tier of ['enhanced', 'premium']) {
    const rows = await knex('lawn_pricing_brackets').where({ tier });
    for (const row of rows) {
      const standard = await knex('lawn_pricing_brackets')
        .where({ grass_track: row.grass_track, sqft_bracket: row.sqft_bracket, tier: 'standard' })
        .first();
      if (!standard) continue;
      let cap = Math.floor(Number(standard.monthly_price) * TIER_CAP_RATIO[tier]);
      if (tier === 'premium') {
        // Second bound: 12x per-app never above 9x per-app, measured against
        // the enhanced cell as it stands AFTER this migration's enhanced pass.
        const enhanced = await knex('lawn_pricing_brackets')
          .where({ grass_track: row.grass_track, sqft_bracket: row.sqft_bracket, tier: 'enhanced' })
          .first();
        if (enhanced && Number(enhanced.monthly_price) > 0) {
          cap = Math.min(cap, Math.floor(Number(enhanced.monthly_price) * 12 / 9));
        }
      }
      const before = Number(row.monthly_price);
      if (!(cap > 0) || before <= cap) continue;
      // Conditional on the observed value so a concurrent edit is not clobbered.
      const updated = await knex('lawn_pricing_brackets')
        .where({ id: row.id, monthly_price: row.monthly_price })
        .update({ monthly_price: cap, updated_at: knex.fn.now() });
      if (updated) applied.push({ track: row.grass_track, sqft: row.sqft_bracket, tier, before, after: cap });
    }
  }

  const priorVersion = await mergeConfigVersion(knex, VERSION_TO);

  // Nothing moved (already-migrated table, or an operator authored every cell
  // under the cap): skip the capture row entirely rather than leaving an empty
  // one that a later down() could pick up in place of the real capture.
  if (applied.length > 0) {
    await auditInsert(
      knex,
      { cells: applied.map(({ track, sqft, tier, before }) => ({ track, sqft, tier, monthly: before })), pricingVersion: priorVersion },
      { cells: applied.map(({ track, sqft, tier, after }) => ({ track, sqft, tier, monthly: after })), pricingVersion: VERSION_TO },
      MIGRATION_TAG,
      'Lawn cadence frequency discount (owner directive 2026-08-07): 9x cells above floor(standard x 1.44) and 12x cells above floor(standard x 1.84) lowered to the cap; pricingVersion advanced to LAWN_PRICING_V2_FREQ_DISCOUNT.',
    );
  }

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ lawnPricingVersion: VERSION_FROM, cells: applied.map(({ track, sqft, tier, before }) => ({ track, sqft, tier, monthly: before })) }),
        after_value: JSON.stringify({ lawnPricingVersion: VERSION_TO, cells: applied.map(({ track, sqft, tier, after }) => ({ track, sqft, tier, monthly: after })) }),
        rationale: 'Owner directive 2026-08-07. The estimate card leads with the per-application price, and after the 07-28 ladder cap the three lawn cadences sat within ~1.5% per application at large lawns (12,500 sqft St. Augustine: $128.00 / $126.67 / $126.00), reading as a rendering bug rather than three programs. Each cadence now carries a real per-application discount off the 6x anchor: 9x -4% (enhanced_monthly <= floor(standard x 1.44)), 12x -8% (premium_monthly <= floor(standard x 1.84)); the engine enforces both on interpolated lookups. Sizing rationale: lawn cost per visit is FLAT across cadences (12,500 sqft measures $86.33/$91.99/$86.48 per visit at 6x/9x/12x) because materials are applied every visit — unlike pest, where the truck roll dominates and funds the steeper 1.00/0.88/0.78 curve. The discount is funded out of the higher plans absolute profit, and -4%/-8% is the measured maximum that keeps annual profit rising with frequency at every bracket the caps bind on; a modeled -10%/-20% curve made the 12x plan less profitable than 6x at every size and was rejected. Binds from ~5,500 sqft up (44 cells across 4 tracks); smaller brackets already separated naturally and are untouched. Margins are report-only (floors disarmed 07-17). Constants and the client mirror move in the same PR; lawn pricingVersion advances to LAWN_PRICING_V2_FREQ_DISCOUNT.',
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
    for (const cell of snapshot.before.cells || []) beforeMap.set(`${cell.track}|${cell.sqft}|${cell.tier}`, Number(cell.monthly));
    for (const cell of snapshot.after.cells || []) afterMap.set(`${cell.track}|${cell.sqft}|${cell.tier}`, Number(cell.monthly));
  }

  const restored = [];
  const skipped = [];
  for (const [key, appliedVal] of afterMap.entries()) {
    const [track, sqftText, tier] = key.split('|');
    const row = await knex('lawn_pricing_brackets')
      .where({ grass_track: track, sqft_bracket: Number(sqftText), tier })
      .first();
    if (!row) continue;
    // Only unwind cells still holding the value up() applied — a later
    // operator edit through /admin/pricing-config/lawn-brackets wins.
    if (Number(row.monthly_price) !== appliedVal) { skipped.push({ track, sqft: Number(sqftText), tier, current: Number(row.monthly_price) }); continue; }
    const restoreTo = beforeMap.get(key);
    if (!(restoreTo > 0)) continue;
    await knex('lawn_pricing_brackets')
      .where({ id: row.id })
      .update({ monthly_price: restoreTo, updated_at: knex.fn.now() });
    restored.push({ track, sqft: Number(sqftText), tier, monthly: restoreTo });
  }

  // Version token unwinds to the CAPTURED prior version (an admin/migration
  // may have stamped something other than GRID_500 before up() ran); only if
  // nothing re-advanced it since.
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
    { cells: restored, skippedOperatorEditedCells: skipped },
    `${MIGRATION_TAG}:down`,
    'Rollback of the lawn cadence frequency discount; operator-edited cells left untouched; pricingVersion restored from the up() capture.',
  );

  if (await knex.schema.hasTable('pricing_changelog')) {
    const identity = { ...CHANGELOG_IDENTITY, summary: 'Rollback: lawn cadence frequency discount reverted.' };
    const existing = await knex('pricing_changelog').where(identity).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...identity,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ lawnPricingVersion: VERSION_TO }),
        after_value: JSON.stringify({ cells: restored, skippedOperatorEditedCells: skipped }),
        rationale: 'migrate:down of 20260807120000 — restored the audit-captured 9x/12x values for cells still holding the discounted amounts; cells edited by an operator after the reprice were preserved.',
      });
    }
  }
};
