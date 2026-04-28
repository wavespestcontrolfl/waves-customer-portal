/**
 * Phase 2E: per-tech and per-customer auto-flip opt-out flags.
 *
 * The master toggle `geofence.auto_flip_on_departure` plus the
 * customer-level `notification_prefs.tech_en_route` already gate the
 * auto-flip pipeline at the system + SMS layers. These two new
 * columns add finer-grained control without touching either of those:
 *
 *   technicians.auto_flip_enabled
 *     Per-tech opt-out. Default TRUE so the rollout doesn't change
 *     behavior for existing techs. An operator can flip a single
 *     tech's row to FALSE if a specific tech is generating false
 *     positives (e.g. a long-time-off-the-route worker), without
 *     disabling the master toggle for the whole org.
 *
 *   notification_prefs.auto_flip_en_route
 *     Per-customer opt-out, distinct from the existing tech_en_route
 *     flag. The existing flag gates ALL en_route SMS — manual flip,
 *     auto-flip, geofence-arrival. This new flag is auto-flip-specific:
 *     a customer can keep manual en_route SMS but opt out of the
 *     automated departure-triggered version. Defaults TRUE so existing
 *     opt-in customers keep the auto-flip pipeline.
 *
 * Both checks are layered on top of (not replacements for) the master
 * toggle and the SMS-layer gating. Auto-flip skips with a distinct
 * action_taken value so misfires can be sorted into "tech disabled"
 * vs "customer disabled" buckets in geofence_events forensics.
 */
exports.up = async function (knex) {
  const techHasCol = await knex.schema.hasColumn('technicians', 'auto_flip_enabled');
  if (!techHasCol) {
    await knex.schema.alterTable('technicians', (t) => {
      t.boolean('auto_flip_enabled').notNullable().defaultTo(true);
    });
  }

  const prefsHasCol = await knex.schema.hasColumn('notification_prefs', 'auto_flip_en_route');
  if (!prefsHasCol) {
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.boolean('auto_flip_en_route').notNullable().defaultTo(true);
    });
  }
};

exports.down = async function (knex) {
  const techHasCol = await knex.schema.hasColumn('technicians', 'auto_flip_enabled');
  if (techHasCol) {
    await knex.schema.alterTable('technicians', (t) => {
      t.dropColumn('auto_flip_enabled');
    });
  }

  const prefsHasCol = await knex.schema.hasColumn('notification_prefs', 'auto_flip_en_route');
  if (prefsHasCol) {
    await knex.schema.alterTable('notification_prefs', (t) => {
      t.dropColumn('auto_flip_en_route');
    });
  }
};
