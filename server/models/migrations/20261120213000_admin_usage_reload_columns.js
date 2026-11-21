/**
 * admin_usage_events: two columns for the reload of an out-of-date staff tab
 * (owner 2026-11-19, option A: logging and a daily read-only check).
 *
 * An out-of-date staff tab reloads at its next page move, unless something
 * keeps it on its build (client/src/lib/portalReload.js). Each page view's
 * beacon now carries the tab's build and the code name of what kept its last
 * page move from reloading it (client/src/lib/adminUsage.js).
 * POST /api/admin/usage/track stores:
 * - stale_build: the tab's build is not the build this server serves. Null
 *   when either side has no build tag (a dev server, or a tab from before
 *   the beacon sent one).
 * - reload_hold: that code name ('first-page', 'current', 'field-page', a
 *   hold such as 'card-payment', and the like), kept only when stale_build
 *   is true. Null on a stale row means nothing kept the tab on its build.
 *
 * A nightly read-only check reports the stale rows whose name shows a
 * failed reload. Both columns hold code names only, never customer data. Nullable and additive: older rows and older tabs keep
 * working.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('admin_usage_events'))) return;
  const hasStale = await knex.schema.hasColumn('admin_usage_events', 'stale_build');
  const hasHold = await knex.schema.hasColumn('admin_usage_events', 'reload_hold');
  if (hasStale && hasHold) return;
  await knex.schema.alterTable('admin_usage_events', (t) => {
    if (!hasStale) t.boolean('stale_build');
    if (!hasHold) t.string('reload_hold', 32);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('admin_usage_events'))) return;
  const hasStale = await knex.schema.hasColumn('admin_usage_events', 'stale_build');
  const hasHold = await knex.schema.hasColumn('admin_usage_events', 'reload_hold');
  if (!hasStale && !hasHold) return;
  await knex.schema.alterTable('admin_usage_events', (t) => {
    if (hasStale) t.dropColumn('stale_build');
    if (hasHold) t.dropColumn('reload_hold');
  });
};
