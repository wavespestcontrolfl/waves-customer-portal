/**
 * Rodent inspection fee: $125 → $75 (owner directive 2026-08-26).
 *
 * The inspection stays fully creditable toward approved treatment within
 * its 14-day window (inspection-credit.js credits the QUOTED fee live from
 * RODENT.inspection.fee, so new closeout offers freeze at $75; offers
 * already frozen at $125 keep the amount they promised). The bundled-work
 * and $995-approved-total waivers are unchanged.
 *
 * Pricing is DB-authoritative: db-bridge overlays
 * pricing_config.rodent_inspection.fee over constants, so the constants.js
 * change in this PR is inert in any env carrying the row unless the DB is
 * updated too. Read-modify-write — creditable_within_days and
 * waive_if_approved_total_over (and any admin-added keys) are preserved.
 */
const MIGRATION_TAG = 'migration:20260826000002';
const UP_REASON = 'Rodent inspection fee $125 -> $75, still fully creditable toward treatment (owner directive 2026-08-26)';
const NEW_FEE = 75;
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-08-26',
  category: 'cost',
  summary: 'Rodent inspection fee lowered to $75; full fee still credits toward approved treatment.',
};

async function loadInspectionRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'rodent_inspection' }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return { row, data };
}

async function saveInspectionRow(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'rodent_inspection' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'rodent_inspection',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}


// Audit rows persist across up/down cycles: a later no-op reapplication
// must NOT consume provenance from an earlier cycle and restore values this
// application never changed (codex #3521 r20 P2, mirroring
// 20260724130000's pattern). Only an UP row with a HIGHER id than the most
// recent matching ROLLBACK row belongs to the current cycle.
async function latestUncancelledUp(knex, configKey) {
  const lastDown = await knex('pricing_config_audit')
    .where({ config_key: configKey, changed_by: MIGRATION_TAG })
    .whereLike('reason', 'Rollback:%')
    .orderBy('id', 'desc')
    .first('id');
  const query = knex('pricing_config_audit')
    .where({ config_key: configKey, changed_by: MIGRATION_TAG, reason: UP_REASON })
    .orderBy('id', 'desc');
  if (lastDown?.id != null) query.where('id', '>', lastDown.id);
  return query.first();
}

exports.up = async function (knex) {
  const loaded = await loadInspectionRow(knex);
  if (!loaded) return;
  const { data } = loaded;
  // Each config row is judged on its own: a primary row an admin already
  // set to $75 must not stop the legacy mirror (or the changelog) from
  // being brought in line (uncapped audit P1 on #3521).
  let anyChange = false;
  if (Number(data.fee) !== NEW_FEE) {
    await saveInspectionRow(knex, data, { ...data, fee: NEW_FEE }, UP_REASON);
    anyChange = true;
  }

  // The legacy exclusion config row mirrors the fee for the admin panel
  // (SPECIALTY.exclusion.inspectionFee — a fallback the live path never
  // reaches since RODENT.inspection always exists). Keep it truthful.
  const exRow = await knex('pricing_config').where({ config_key: 'onetime_exclusion' }).first();
  if (exRow) {
    const exData = typeof exRow.data === 'string' ? JSON.parse(exRow.data) : exRow.data;
    if (exData && typeof exData === 'object' && exData.inspection != null && Number(exData.inspection) !== NEW_FEE) {
      await knex('pricing_config')
        .where({ config_key: 'onetime_exclusion' })
        .update({ data: JSON.stringify({ ...exData, inspection: NEW_FEE }), updated_at: knex.fn.now() });
      if (await knex.schema.hasTable('pricing_config_audit')) {
        await knex('pricing_config_audit').insert({
          config_key: 'onetime_exclusion',
          old_value: JSON.stringify(exData),
          new_value: JSON.stringify({ ...exData, inspection: NEW_FEE }),
          changed_by: MIGRATION_TAG,
          reason: UP_REASON,
        });
      }
      anyChange = true;
    }
  }

  // The changelog entry belongs to an application that changed something —
  // a fully current pair of rows must not mint one that a rollback of a
  // later cycle would then have nothing to pair with.
  if (anyChange && await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['rodent_inspection', 'rodent_exclusion']),
        before_value: JSON.stringify({ fee: data.fee ?? null }),
        after_value: JSON.stringify({ fee: NEW_FEE }),
        rationale: 'Owner directive 2026-08-26: rodent inspections are $75 and the full fee goes toward treatment — inspection-credit already credits the quoted fee on booking, so the credit follows automatically. The 14-day creditable window, the bundled-rodent-work waiver, and the $995 approved-total waiver are unchanged. Exclusion estimates that charge the inspect fee now carry $75 instead of $125.',
      });
    }
  }
};

exports.down = async function (knex) {
  // Only restore the fee this migration's up() replaced — keyed off the
  // audit row, mirroring 20260611000003's ownership pattern.
  if (!(await knex.schema.hasTable('pricing_config_audit'))) return;
  const ownUp = await latestUncancelledUp(knex, 'rodent_inspection');
  // Each audit rolls back on its own: a mirror-only up() (primary already
  // $75) has no primary audit, and must still restore the mirror and drop
  // the changelog (uncapped audit P1 on #3521).
  const loaded = ownUp ? await loadInspectionRow(knex) : null;
  if (ownUp && loaded) {
    const oldValue = typeof ownUp.old_value === 'string' ? JSON.parse(ownUp.old_value) : ownUp.old_value;
    if (oldValue && oldValue.fee != null && Number(loaded.data.fee) === NEW_FEE) {
      await saveInspectionRow(
        knex, loaded.data, { ...loaded.data, fee: oldValue.fee },
        'Rollback: restore prior rodent inspection fee (20260826000002)'
      );
    }
  }
  const exOwnUp = await latestUncancelledUp(knex, 'onetime_exclusion');
  if (exOwnUp) {
    const exRow = await knex('pricing_config').where({ config_key: 'onetime_exclusion' }).first();
    const exOld = typeof exOwnUp.old_value === 'string' ? JSON.parse(exOwnUp.old_value) : exOwnUp.old_value;
    if (exRow && exOld && exOld.inspection != null) {
      const exData = typeof exRow.data === 'string' ? JSON.parse(exRow.data) : exRow.data;
      if (exData && typeof exData === 'object' && Number(exData.inspection) === NEW_FEE) {
        await knex('pricing_config')
          .where({ config_key: 'onetime_exclusion' })
          .update({
            data: JSON.stringify({ ...exData, inspection: exOld.inspection }),
            updated_at: knex.fn.now(),
          });
        // Close the mirror's cycle so a later no-op up() cannot consume this
        // UP row again.
        await knex('pricing_config_audit').insert({
          config_key: 'onetime_exclusion',
          old_value: JSON.stringify(exData),
          new_value: JSON.stringify({ ...exData, inspection: exOld.inspection }),
          changed_by: MIGRATION_TAG,
          reason: 'Rollback: restore prior legacy exclusion inspect fee (20260826000002)',
        });
      }
    }
  }
  // The changelog entry is removed only when THIS cycle changed something.
  if ((ownUp || exOwnUp) && await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }
};
