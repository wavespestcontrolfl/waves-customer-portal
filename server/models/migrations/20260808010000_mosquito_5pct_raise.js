/**
 * Mosquito +5% across the board (owner directive 2026-08-08).
 *
 * Raises every PRICE cell on the two DB-authoritative mosquito rows by 5%,
 * rounded half-up to whole dollars, derived from the LIVE values (an
 * admin-edited cell gets +5% on the admin's number, never overwritten with
 * a hardcoded table):
 *   - mosquito_base_prices: both programs (seasonal9/monthly12) x all five
 *     lot buckets. Uniform scaling preserves the Monthly-vs-Seasonal
 *     per-visit discount shape; the engine additionally enforces the
 *     monthly12 <= seasonal9 bound at lookup time as of this PR.
 *   - onetime_mosquito: the six bucket prices, OVER_ACRE, and
 *     overAcreIncrementPrice. The stationAddOn/dunkAddOn keys are
 *     product-cost-linked add-ons and are deliberately NOT raised;
 *     overAcreIncrementSqFt is a size, not a price.
 *   - services.mosquito_one_time (base_price / price_range_min /
 *     price_range_max): the hand-scheduled no-lot fallback and Service
 *     Library display, aligned to the lot ladder by 20260728300000 — it
 *     must move with the ladder or no-lot customers stay on the old price
 *     and the catalog displays stale ranges (pre-push audit P0).
 *
 * constants.js mirrors move in the same PR (fresh-env defaults); the client
 * estimator's static anchor tables are hand-synced there too.
 *
 * RE-RUN GUARD - a second up() must not compound another +5%: up() no-ops
 * when this migration's audit capture already exists.
 *
 * ROLLBACK CONTRACT - down() restores each captured before-value only where
 * the cell STILL holds the value up() applied (a later admin edit wins),
 * under the same FOR UPDATE row locks; audit rows tagged :down. down() also
 * deletes the pricing_changelog row so the changelog never reports a
 * rolled-back raise as active (repo convention), and a later reapply
 * records a fresh entry.
 *
 * REAPPLY CONTRACT - a cell down() preserved as a post-raise admin edit is
 * already in the post-raise regime; reapply must NOT put another +5% on it.
 * up() skips exactly the cells the latest :down audit recorded as
 * preserved (a cell edited AFTER the rollback is not in that list and gets
 * raised, per derive-from-live).
 */

const MIGRATION_TAG = 'migration:20260808010000';
const RAISE = 1.05;

const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-08',
  // pricing_changelog_category_check allows bug/leak/rule/cost/architecture/
  // documentation/infrastructure — a price-level change is 'rule' by repo
  // convention (the lawn reprices use it).
  category: 'rule',
  summary: 'Mosquito +5% across the board: recurring program base prices and one-time bucket prices (add-ons excluded).',
};

const PRICE_SHAPES = {
  mosquito_base_prices: { nestedPrograms: ['seasonal9', 'monthly12'] },
  onetime_mosquito: {
    flatKeys: ['SMALL', 'STANDARD', 'LARGE', 'XL', 'ESTATE', 'ACRE_CLASS', 'OVER_ACRE', 'overAcreIncrementPrice'],
  },
};

async function auditInsert(knex, configKey, oldValue, newValue, tag, reason) {
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  await knex('pricing_config_audit').insert({
    config_key: configKey,
    old_value: oldValue == null ? null : JSON.stringify(oldValue),
    new_value: newValue == null ? null : JSON.stringify(newValue),
    changed_by: tag,
    reason,
  });
}

function parseData(row) {
  try { return typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {}); }
  catch { return {}; }
}

function raisedValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * RAISE);
}

// Returns { next, changes } where changes = [{ path, before, after }].
// skipPaths (Set|undefined): cells preserved by a prior down() as post-raise
// admin edits — already raised, never re-raised on reapply.
function applyRaise(configKey, data, skipPaths) {
  const shape = PRICE_SHAPES[configKey];
  const next = JSON.parse(JSON.stringify(data));
  const changes = [];
  if (shape.nestedPrograms) {
    for (const [bucket, programs] of Object.entries(next)) {
      if (!programs || typeof programs !== 'object') continue;
      for (const program of shape.nestedPrograms) {
        const path = bucket + '.' + program;
        if (skipPaths && skipPaths.has(path)) continue;
        const after = raisedValue(programs[program]);
        if (after == null || after === programs[program]) continue;
        changes.push({ path, before: programs[program], after });
        programs[program] = after;
      }
    }
  }
  if (shape.flatKeys) {
    for (const key of shape.flatKeys) {
      if (skipPaths && skipPaths.has(key)) continue;
      const after = raisedValue(next[key]);
      if (after == null || after === next[key]) continue;
      changes.push({ path: key, before: next[key], after });
      next[key] = after;
    }
  }
  return { next, changes };
}

function readPath(data, path) {
  return path.split('.').reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), data);
}

function writePath(data, path, value) {
  const parts = path.split('.');
  let node = data;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object') return false;
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  return true;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;

  // Re-run guard: a second up() must not compound another +5% — but a
  // ROLLBACK must not brick a reapply either (pre-push audit P0: an
  // any-row-exists check treated the surviving up capture as proof the
  // raise was still applied, so down() -> redeploy left DB prices rolled
  // back forever). Applied = the latest audit row for this migration is an
  // UP capture, not a :down restore.
  let reapplyAfterDown = false;
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const lastUp = await knex('pricing_config_audit')
      .where({ changed_by: MIGRATION_TAG })
      .orderBy('id', 'desc')
      .first('id');
    const lastDown = await knex('pricing_config_audit')
      .where({ changed_by: MIGRATION_TAG + ':down' })
      .orderBy('id', 'desc')
      .first('id');
    if (lastUp && (!lastDown || lastUp.id > lastDown.id)) return;
    reapplyAfterDown = Boolean(lastDown);
  }

  // REAPPLY CONTRACT: cells the latest down() preserved as post-raise admin
  // edits already carry the raise (e.g. 100 -> up 105 -> admin 110); putting
  // another +5% on them here would compound to 116. Skip exactly the paths
  // the :down audit recorded as preserved.
  const reapplySkips = {};
  if (reapplyAfterDown) {
    for (const configKey of [...Object.keys(PRICE_SHAPES), 'services_mosquito_one_time']) {
      const downAudit = await knex('pricing_config_audit')
        .where({ config_key: configKey, changed_by: MIGRATION_TAG + ':down' })
        .orderBy('id', 'desc')
        .first('new_value');
      if (!downAudit || !downAudit.new_value) continue;
      try {
        const parsed = JSON.parse(downAudit.new_value);
        const preserved = (parsed.skippedAdminEditedCells || parsed.skippedAdminEditedFields || [])
          .map((entry) => entry.path || entry.field)
          .filter(Boolean);
        if (preserved.length) reapplySkips[configKey] = new Set(preserved);
      } catch { /* an unreadable audit row never blocks the raise */ }
    }
  }

  const allChanges = {};
  for (const configKey of Object.keys(PRICE_SHAPES)) {
    const row = await knex('pricing_config').where({ config_key: configKey }).forUpdate().first();
    if (!row) continue; // fresh envs carry no row - constants (raised in this PR) rule there
    const data = parseData(row);
    const skips = reapplySkips[configKey];
    const { next, changes } = applyRaise(configKey, data, skips);
    if (!changes.length) continue;
    await knex('pricing_config')
      .where({ config_key: configKey })
      .update({ data: JSON.stringify(next), updated_at: knex.fn.now() });
    await auditInsert(
      knex, configKey, data, next, MIGRATION_TAG,
      'Mosquito +5% across the board (owner directive 2026-08-08), rounded half-up, derived from live values: '
        + changes.map((c) => c.path + ' ' + c.before + '->' + c.after).join(', ') + '.'
        + (skips && skips.size ? ' Reapply-preserved (post-raise admin edits, not re-raised): ' + [...skips].join(', ') + '.' : ''),
    );
    allChanges[configKey] = changes;
  }

  // Catalog fallback (services.mosquito_one_time): the no-lot scheduling
  // price and the Service Library range must track the raised ladder.
  if (await knex.schema.hasTable('services')) {
    const svc = await knex('services')
      .where({ service_key: 'mosquito_one_time' })
      .forUpdate()
      .first('base_price', 'price_range_min', 'price_range_max');
    if (svc) {
      const svcSkips = reapplySkips.services_mosquito_one_time;
      const svcChanges = [];
      const svcNext = {};
      for (const field of ['base_price', 'price_range_min', 'price_range_max']) {
        if (svcSkips && svcSkips.has(field)) continue;
        const after = raisedValue(svc[field]);
        if (after == null || after === Number(svc[field])) continue;
        svcChanges.push({ path: field, before: Number(svc[field]), after });
        svcNext[field] = after;
      }
      if (svcChanges.length) {
        await knex('services').where({ service_key: 'mosquito_one_time' }).update({
          ...svcNext,
          updated_at: knex.fn.now(),
        });
        await auditInsert(
          knex, 'services_mosquito_one_time',
          Object.fromEntries(svcChanges.map((c) => [c.path, c.before])),
          Object.fromEntries(svcChanges.map((c) => [c.path, c.after])),
          MIGRATION_TAG,
          'Mosquito +5%: hand-scheduled one-time catalog fallback and Service Library range aligned to the raised lot ladder ('
            + svcChanges.map((c) => c.path + ' ' + c.before + '->' + c.after).join(', ') + ').'
            + (svcSkips && svcSkips.size ? ' Reapply-preserved (post-raise admin edits, not re-raised): ' + [...svcSkips].join(', ') + '.' : ''),
        );
        allChanges.services_mosquito_one_time = svcChanges;
      }
    }
  }

  if (Object.keys(allChanges).length && (await knex.schema.hasTable('pricing_changelog'))) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['mosquito']),
        before_value: JSON.stringify(Object.fromEntries(Object.entries(allChanges).map(([k, cs]) => [k, cs.map((c) => ({ [c.path]: c.before }))]))),
        after_value: JSON.stringify(Object.fromEntries(Object.entries(allChanges).map(([k, cs]) => [k, cs.map((c) => ({ [c.path]: c.after }))]))),
        rationale: 'Owner directive 2026-08-08: raise mosquito prices 5% across the board. Applies to the recurring program base prices (Seasonal-9 and Monthly-12 at every lot bucket) and the one-time bucket prices including the over-acre increment, rounded half-up to whole dollars and derived from the live row values so admin edits are scaled rather than overwritten. Station/dunk add-ons are product-cost-linked and excluded. Uniform scaling preserves the Monthly-vs-Seasonal per-visit discount (~7-12% per bucket), now also enforced at lookup time by the mosquito cadence bound shipping in the same PR. Remains under Terminix ($131.11/mo mosquito+tick) and TruGreen ($85.56/app) comparables.',
      });
    }
  }
};

exports.down = async function down(knex) {
  // The changelog must never report a rolled-back raise as active, and a
  // later reapply must record its own fresh entry — delete before the
  // table-existence early returns below can skip it (repo convention).
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }

  if (!(await knex.schema.hasTable('pricing_config'))) return;
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;

  // Catalog fallback: restore each field only while it still holds the
  // value up() applied (an admin edit through the Service Library wins).
  if (await knex.schema.hasTable('services')) {
    const capture = await knex('pricing_config_audit')
      .where({ config_key: 'services_mosquito_one_time', changed_by: MIGRATION_TAG })
      .orderBy('id', 'desc')
      .first();
    if (capture && capture.old_value && capture.new_value) {
      let before; let after;
      try { before = JSON.parse(capture.old_value); after = JSON.parse(capture.new_value); }
      catch { before = null; }
      if (before) {
        const svc = await knex('services')
          .where({ service_key: 'mosquito_one_time' })
          .forUpdate()
          .first('base_price', 'price_range_min', 'price_range_max');
        if (svc) {
          const restore = {};
          const svcSkipped = [];
          for (const field of Object.keys(before)) {
            if (Number(svc[field]) === Number(after[field])) restore[field] = before[field];
            else svcSkipped.push({ field, current: Number(svc[field]) });
          }
          if (Object.keys(restore).length) {
            await knex('services').where({ service_key: 'mosquito_one_time' }).update({
              ...restore,
              updated_at: knex.fn.now(),
            });
          }
          await auditInsert(
            knex, 'services_mosquito_one_time',
            { restoredFrom: MIGRATION_TAG },
            { restored: restore, skippedAdminEditedFields: svcSkipped },
            MIGRATION_TAG + ':down',
            'Rollback of the mosquito +5% catalog fallback; fields edited by an admin after the raise were preserved.',
          );
        }
      }
    }
  }

  for (const configKey of Object.keys(PRICE_SHAPES)) {
    const capture = await knex('pricing_config_audit')
      .where({ config_key: configKey, changed_by: MIGRATION_TAG })
      .orderBy('id', 'desc')
      .first();
    if (!capture || !capture.old_value || !capture.new_value) continue;
    let before; let after;
    try { before = JSON.parse(capture.old_value); after = JSON.parse(capture.new_value); }
    catch { continue; }

    const row = await knex('pricing_config').where({ config_key: configKey }).forUpdate().first();
    if (!row) continue;
    const data = parseData(row);
    const { changes } = applyRaise(configKey, before); // recompute the applied set from the capture
    const restored = [];
    const skipped = [];
    for (const change of changes) {
      const current = readPath(data, change.path);
      const applied = readPath(after, change.path);
      // A reapply may have skipped this cell entirely (reapply-preserved
      // admin edit) - the capture shows it unchanged; nothing to unwind.
      if (Number(applied) === Number(change.before)) continue;
      // Only unwind cells still holding the value up() applied - a later
      // admin edit through the pricing panel wins.
      if (Number(current) !== Number(applied)) { skipped.push({ path: change.path, current }); continue; }
      if (writePath(data, change.path, change.before)) restored.push({ path: change.path, value: change.before });
    }
    if (restored.length) {
      await knex('pricing_config')
        .where({ config_key: configKey })
        .update({ data: JSON.stringify(data), updated_at: knex.fn.now() });
    }
    await auditInsert(
      knex, configKey,
      { restoredFrom: MIGRATION_TAG },
      { restored, skippedAdminEditedCells: skipped },
      MIGRATION_TAG + ':down',
      'Rollback of the mosquito +5% raise; cells edited by an admin after the raise were preserved.',
    );
  }
};
