/**
 * Advance lawn_pricing_v2.pricingVersion -> LAWN_PRICING_V2_EDGE_PARITY
 * (owner ruling 2026-08-07 on #3274).
 *
 * The cadence frequency discount now ENDS at the table edge: above
 * LAWN_TABLE_MAX_SQFT, extrapolated 9x/12x lookups carry a per-application
 * parity floor against the extrapolated 6x anchor instead of the -4%/-8%
 * caps (the extrapolation slope derives from the discounted 15k/20k anchor
 * cells, so skipping the caps alone would leak the discount past the edge).
 * That RAISES >20k 9x/12x quotes off the discounted slope — a material
 * price movement, so estimates priced before/after must stay
 * distinguishable in estimates.pricing_version (pre-push audit P1).
 *
 * Version-only: no bracket cells exist above the table, so no cell moves.
 * The engine behavior itself ships in code (service-pricing/estimateEngine)
 * and follows the same cadenceFreqDiscountArmed switch as the discount.
 *
 * ROLLBACK CONTRACT — down() restores the audit-captured prior token, only
 * if the version is still EDGE_PARITY (ownership check under FOR UPDATE;
 * a later schedule advance is not this migration's to unwind). Writes are
 * atomic single-key jsonb_set — this row carries keys owned by other
 * migrations and live admin saves and is never read-modify-written
 * wholesale.
 */

const MIGRATION_TAG = 'migration:20260808000000';
const VERSION_FROM = 'LAWN_PRICING_V2_FREQ_DISCOUNT';
const VERSION_TO = 'LAWN_PRICING_V2_EDGE_PARITY';

const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-07',
  category: 'rule',
  summary: 'Lawn cadence frequency discount ends at the table edge: >20k sqft extrapolated 9x/12x carry a per-app parity floor against the 6x anchor.',
};

async function auditInsert(knex, oldValue, newValue, tag, reason) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: 'lawn_pricing_v2',
    old_value: oldValue == null ? null : JSON.stringify(oldValue),
    new_value: newValue == null ? null : JSON.stringify(newValue),
    changed_by: tag,
    reason,
  });
}

async function readRowForUpdate(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const existing = await knex('pricing_config')
    .where({ config_key: 'lawn_pricing_v2' })
    .forUpdate()
    .first();
  if (!existing) return null;
  let data = {};
  try { data = typeof existing.data === 'string' ? JSON.parse(existing.data) : (existing.data || {}); }
  catch { data = {}; }
  return { data };
}

async function stampVersion(knex, version, expectCurrent) {
  let query = knex('pricing_config').where({ config_key: 'lawn_pricing_v2' });
  if (expectCurrent !== undefined) {
    query = query.whereRaw(`data->>'pricingVersion' = ?`, [expectCurrent]);
  }
  return query.update({
    data: version == null
      ? knex.raw(`data - 'pricingVersion'`)
      : knex.raw(`jsonb_set(data, '{pricingVersion}', to_jsonb(?::text), true)`, [version]),
    updated_at: knex.fn.now(),
  });
}

exports.up = async function up(knex) {
  const row = await readRowForUpdate(knex);
  if (!row) return;
  const prior = row.data.pricingVersion ?? null;
  if (prior === VERSION_TO) return; // re-run no-op: never shadow the real capture

  await stampVersion(knex, VERSION_TO);
  await auditInsert(
    knex,
    { pricingVersion: prior },
    { pricingVersion: VERSION_TO },
    MIGRATION_TAG,
    'Lawn pricingVersion advanced to LAWN_PRICING_V2_EDGE_PARITY (owner ruling 2026-08-07: cadence frequency discount ends at the table edge; >20k extrapolated 9x/12x carry a per-app parity floor against the 6x anchor).',
  );

  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['lawn_care']),
        before_value: JSON.stringify({ lawnPricingVersion: prior ?? VERSION_FROM }),
        after_value: JSON.stringify({ lawnPricingVersion: VERSION_TO }),
        rationale: 'Owner ruling 2026-08-07 on PR #3274, after competitive research (TruGreen/Lawn Doctor publish no pricing past ~a half acre): >20,000 sqft is custom-quote territory and a flat -4% per-application discount there made the 9x cadence less profitable than 6x (incremental visit cost ~$28/1,000 sqft outgrows ~$18 of capped incremental revenue). Above the table max, extrapolated 9x/12x lookups now carry a per-application parity floor against the extrapolated 6x anchor — no frequency discount — which restores 12x > 9x > 6x profit ordering everywhere above the table. No bracket cells move (none exist above the table); the engine change ships in code and rides the cadenceFreqDiscountArmed switch. Estimates stamped LAWN_PRICING_V2_FREQ_DISCOUNT priced >20k lawns ~4% lower per application than this schedule.',
      });
    }
  }
};

exports.down = async function down(knex) {
  const row = await readRowForUpdate(knex);
  if (!row) return;
  // Ownership: only unwind a token this migration stamped.
  if (row.data.pricingVersion !== VERSION_TO) {
    await auditInsert(
      knex,
      { restoredFrom: VERSION_TO },
      { skippedRestore: true, currentVersion: row.data.pricingVersion ?? null },
      `${MIGRATION_TAG}:down`,
      'Rollback skipped: pricingVersion is no longer LAWN_PRICING_V2_EDGE_PARITY — the live schedule belongs to a later change.',
    );
    return;
  }

  // Restore the audit-captured prior token (never a hardcoded fallback —
  // an operator/migration may have stamped something else before up()).
  let prior = VERSION_FROM;
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const audits = await knex('pricing_config_audit')
      .where({ config_key: 'lawn_pricing_v2', changed_by: MIGRATION_TAG })
      .orderBy('id', 'desc');
    for (const audit of audits) {
      if (!audit?.old_value) continue;
      try {
        const parsed = JSON.parse(audit.old_value);
        if ('pricingVersion' in parsed) { prior = parsed.pricingVersion; break; }
      } catch { continue; }
    }
  }

  await stampVersion(knex, prior, VERSION_TO);
  await auditInsert(
    knex,
    { pricingVersion: VERSION_TO },
    { pricingVersion: prior },
    `${MIGRATION_TAG}:down`,
    'Rollback of the edge-parity version stamp; pricingVersion restored from the up() capture.',
  );
};
