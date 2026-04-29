/**
 * Bump WaveGuard Platinum tier discount from 0.18 → 0.20.
 *
 * The WaveGuard Platinum bundle ships at 20% — that's what the customer-facing
 * spec says, what server/services/pricing-engine/constants.js encodes, and
 * what docs/pricing/POLICY.md establishes as the source of truth.
 *
 * The original `admin-pricing-config.js` seed (which created the
 * pricing_config.waveguard_tiers row on first install) accidentally shipped
 * Platinum at 0.18. db-bridge.syncConstantsFromDB() reads that row at startup
 * and overwrites constants.WAVEGUARD.tiers.platinum.discount with the DB
 * value, so production has been pricing AND activating Platinum at 18% all
 * along — 2pp below what the bundle actually promises.
 *
 * This migration aligns the prod row to the spec. Guarded so it only fires
 * when Platinum is currently 0.18 — leaves later admin-driven overrides
 * (e.g. someone tuning the tier table from the admin UI) alone.
 */
exports.up = async function up(knex) {
  // Only update if the row exists AND platinum.discount is still 0.18.
  // Using the raw `data->'platinum'->>'discount'` path so the WHERE works
  // against jsonb without needing the row in a particular shape.
  const result = await knex.raw(`
    UPDATE pricing_config
       SET data       = jsonb_set(data, '{platinum,discount}', '0.20'::jsonb, false),
           updated_at = NOW()
     WHERE config_key = 'waveguard_tiers'
       AND (data -> 'platinum' ->> 'discount')::numeric = 0.18
  `);

  if (result.rowCount === 0) {
    // Either the seed hasn't run yet (admin-pricing-config.js will seed
    // 0.20 directly on first install now) or the value isn't 0.18 anymore
    // (admin already tuned it, or a prior migration already fixed it).
    // Both are fine — just skip.
    // eslint-disable-next-line no-console
    console.log('[migration] waveguard_tiers Platinum already aligned, skipping.');
  }
};

exports.down = async function down(knex) {
  // Symmetric revert — only fires if Platinum is currently 0.20.
  await knex.raw(`
    UPDATE pricing_config
       SET data       = jsonb_set(data, '{platinum,discount}', '0.18'::jsonb, false),
           updated_at = NOW()
     WHERE config_key = 'waveguard_tiers'
       AND (data -> 'platinum' ->> 'discount')::numeric = 0.20
  `);
};
