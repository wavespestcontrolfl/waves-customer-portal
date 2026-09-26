// Retire the 4-application/yr ("Quarterly"/"Light") residential tree & shrub
// tier for NEW sales (owner directive 2026-09-24: "remove quarterly tree
// and shrub care from the estimates and services, anywhere we mention it,
// like we did with bi-monthly lawn"). Standard (6x, mandated default) and
// Enhanced (9x, upsell) are unaffected.
//
// Mirrors 20260924000010 + 20260924000020 (the bi-monthly lawn retirement)
// combined into ONE migration, since T&S has no live-tunable pricing_config
// row for tier sellability the way lawn does — TREE_SHRUB.tiers.light.hidden
// is a plain in-code flag (server/services/pricing-engine/constants.js),
// re-enabled only by a future code change, not a DB flip. What this
// migration DOES own is the catalog row `tree_shrub_quarterly` ("Quarterly
// Tree & Shrub Care Service") — the only catalog row selling the Light tier:
//   customer_visible = false        (public MCP service catalog)
//   booking_enabled  = false        (call-agent bookable catalog)
//   public_quote_selectable = false (public quote-to-estimate menu)
// is_active stays true: the one existing quarterly customer's historic and
// scheduled visits, and any invoice, still reference this row. Nothing here
// touches scheduled_services, estimates, or that customer's data — they are
// grandfathered on their existing plan; the pricing engine, converter and
// seeder all still resolve tier:'light' / the quarterly cadence correctly
// when explicitly given (see priceTreeShrub / TREE_SHRUB_CADENCE_CATALOG_KEYS
// / cadenceCatalogKeyForProfile). This migration only stops NEW customers
// from being offered or able to select it.
//
// Unlike 20260924000020's no-op down (state-tracked, because a "still
// false" flag can't be told apart from an admin's own later deselection),
// this migration ships as ONE step with a real, direct down() — there is no
// split-migration window in which an admin could have already re-selected
// the row in the Service Library between up() and a same-day rollback.

const SERVICE_KEY = 'tree_shrub_quarterly';
const FLAGS = ['customer_visible', 'booking_enabled', 'public_quote_selectable'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const patch = {};
  for (const flag of FLAGS) {
    if (await knex.schema.hasColumn('services', flag)) patch[flag] = false;
  }
  if (!Object.keys(patch).length) return;
  await knex('services')
    .where({ service_key: SERVICE_KEY })
    .update({ ...patch, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('services'))) return;
  const patch = {};
  for (const flag of FLAGS) {
    if (await knex.schema.hasColumn('services', flag)) patch[flag] = true;
  }
  if (!Object.keys(patch).length) return;
  await knex('services')
    .where({ service_key: SERVICE_KEY })
    .update({ ...patch, updated_at: knex.fn.now() });
};

exports.SERVICE_KEY = SERVICE_KEY;
exports.FLAGS = FLAGS;
