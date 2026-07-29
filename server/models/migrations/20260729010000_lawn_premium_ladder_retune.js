/**
 * Retune the Premium (12x) lawn bracket column so the per-application ladder
 * never inverts (owner directive 2026-07-28, pricing audit).
 *
 * The 06-17 35%-recalibration column priced 12x ABOVE 9x per application for
 * turf ≥ ~4,100 sqft (e.g. st_augustine 6,000 sqft: 12x $81/app vs 9x
 * $74.67/app) — on estimate cards that lead with per-application price, the
 * most frequent plan read as the most expensive per visit. New rule:
 * premium_monthly = min(previous, floor(enhanced_monthly × 4/3)), i.e. 12x
 * per-app ≤ 9x per-app at every bracket. Small-lawn cells already under the
 * cap are untouched, as are the sqft=0 seed rows (they mirror the smallest
 * bracket, whose premium is unchanged in every track).
 *
 * Lawn pricing is DB-authoritative (db-bridge replaces LAWN_BRACKETS from
 * lawn_pricing_brackets) — constants.js and the client mirror move in the
 * same PR, this migration moves the live table.
 */

// [sqft_bracket, old monthly_price, new monthly_price] per grass track.
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

async function applyPremium(knex, valueIndex) {
  if (!(await knex.schema.hasTable('lawn_pricing_brackets'))) return;
  for (const [track, cells] of Object.entries(PREMIUM_RETUNE)) {
    for (const cell of cells) {
      await knex('lawn_pricing_brackets')
        .where({ grass_track: track, sqft_bracket: cell[0], tier: 'premium' })
        .update({ monthly_price: cell[valueIndex], updated_at: knex.fn.now() });
    }
  }
}

exports.up = async function up(knex) {
  await applyPremium(knex, 2);
};

exports.down = async function down(knex) {
  await applyPremium(knex, 1);
};
