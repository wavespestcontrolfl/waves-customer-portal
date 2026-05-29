/**
 * Migration — server-authoritative pricing audit columns on `estimates`.
 *
 * Decision #2 of the lawn-pricing audit: the server recomputes pricing from the
 * stored engine inputs on save and persists the server-computed price as
 * authoritative; the client number is retained only as an auditable preview.
 * These columns make that auditable and lockable:
 *
 *   pricing_authority      'SERVER' | 'CLIENT_FALLBACK' | 'LOCKED' — indexed so
 *                          "find all non-authoritative estimates" is a WHERE,
 *                          not a JSON dig.
 *   server_computed_price  authoritative recurring ANNUAL at save time. Annual is
 *                          the source of truth (the 55% floor is defined on annual;
 *                          monthly is derived = round(annual/12) and may differ from
 *                          stored_monthly*12 by a few cents — reconcile on annual).
 *   client_preview_price   recurring annual the client sent (audit only).
 *   pricing_drift          jsonb { annualDelta, monthlyDelta, onetimeDelta,
 *                          pctAnnual, hasDrift, computedAt }. Recorded, not enforced.
 *   price_locked_at        set at acceptance; an accepted estimate keeps its price.
 *   price_locked_by        'customer_accept' | 'manual_accept' | 'backfill'.
 *
 * Idempotent (hasColumn guards), mirroring 20260417000003_pricing_version_column.js.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('estimates');
  if (!hasTable) return;

  const cols = {
    pricing_authority: (t) => t.string('pricing_authority', 20),
    server_computed_price: (t) => t.decimal('server_computed_price', 10, 2),
    client_preview_price: (t) => t.decimal('client_preview_price', 10, 2),
    pricing_drift: (t) => t.jsonb('pricing_drift'),
    price_locked_at: (t) => t.timestamp('price_locked_at', { useTz: true }),
    price_locked_by: (t) => t.string('price_locked_by', 40),
  };

  for (const [name, build] of Object.entries(cols)) {
    const has = await knex.schema.hasColumn('estimates', name);
    if (!has) {
      // One alterTable per column keeps the migration re-runnable after a
      // partial failure (each column is independently guarded).
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable('estimates', (t) => build(t));
    }
  }

  const hasAuthIndex = await knex.schema.hasColumn('estimates', 'pricing_authority');
  if (hasAuthIndex) {
    await knex.schema.alterTable('estimates', (t) => {
      t.index('pricing_authority', 'idx_estimates_pricing_authority');
    }).catch(() => { /* index already exists — safe to ignore on re-run */ });
  }

  // Backfill: legacy accepted estimates have no lock, so the acceptance guard
  // wouldn't protect them. Stamp their existing accepted price as locked.
  const hasAcceptedAt = await knex.schema.hasColumn('estimates', 'accepted_at');
  if (hasAcceptedAt) {
    await knex('estimates')
      .where({ status: 'accepted' })
      .whereNull('price_locked_at')
      .update({
        price_locked_at: knex.ref('accepted_at'),
        price_locked_by: 'backfill',
        pricing_authority: 'LOCKED',
      });
  }
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('estimates');
  if (!hasTable) return;

  const hasAuthIndex = await knex.schema.hasColumn('estimates', 'pricing_authority');
  if (hasAuthIndex) {
    await knex.schema.alterTable('estimates', (t) => {
      t.dropIndex('pricing_authority', 'idx_estimates_pricing_authority');
    }).catch(() => { /* index may not exist */ });
  }

  for (const name of [
    'pricing_authority',
    'server_computed_price',
    'client_preview_price',
    'pricing_drift',
    'price_locked_at',
    'price_locked_by',
  ]) {
    const has = await knex.schema.hasColumn('estimates', name);
    if (has) {
      // eslint-disable-next-line no-await-in-loop
      await knex.schema.alterTable('estimates', (t) => t.dropColumn(name));
    }
  }
};
