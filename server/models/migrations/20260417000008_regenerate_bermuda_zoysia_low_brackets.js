// Session 5 — regenerate Bermuda/Zoysia lawn_pricing_brackets at 4K-7K sqft.
// Basic 4K clamped to $32/mo (35% margin floor); raw $30 regen would be 33%.
// All other brackets use each tier's native 8K→10K scaling rate:
//   Basic $3/K, Standard $4.50/K, Enhanced $7/K.
// Premium already correct in DB — unchanged.

exports.up = async function (knex) {
  const updates = [
    // Bermuda Basic (4K clamped to 32)
    { grass_track: 'bermuda', sqft_bracket: 4000, tier: 'basic',    monthly_price: 32 },
    { grass_track: 'bermuda', sqft_bracket: 5000, tier: 'basic',    monthly_price: 33 },
    { grass_track: 'bermuda', sqft_bracket: 6000, tier: 'basic',    monthly_price: 36 },
    { grass_track: 'bermuda', sqft_bracket: 7000, tier: 'basic',    monthly_price: 39 },
    // Bermuda Standard
    { grass_track: 'bermuda', sqft_bracket: 4000, tier: 'standard', monthly_price: 44 },
    { grass_track: 'bermuda', sqft_bracket: 5000, tier: 'standard', monthly_price: 47 },
    { grass_track: 'bermuda', sqft_bracket: 6000, tier: 'standard', monthly_price: 50 },
    { grass_track: 'bermuda', sqft_bracket: 7000, tier: 'standard', monthly_price: 53 },
    // Bermuda Enhanced
    { grass_track: 'bermuda', sqft_bracket: 4000, tier: 'enhanced', monthly_price: 54 },
    { grass_track: 'bermuda', sqft_bracket: 5000, tier: 'enhanced', monthly_price: 61 },
    { grass_track: 'bermuda', sqft_bracket: 6000, tier: 'enhanced', monthly_price: 68 },
    { grass_track: 'bermuda', sqft_bracket: 7000, tier: 'enhanced', monthly_price: 75 },
    // Zoysia Basic (4K clamped to 32)
    { grass_track: 'zoysia',  sqft_bracket: 4000, tier: 'basic',    monthly_price: 32 },
    { grass_track: 'zoysia',  sqft_bracket: 5000, tier: 'basic',    monthly_price: 33 },
    { grass_track: 'zoysia',  sqft_bracket: 6000, tier: 'basic',    monthly_price: 36 },
    { grass_track: 'zoysia',  sqft_bracket: 7000, tier: 'basic',    monthly_price: 39 },
    // Zoysia Standard
    { grass_track: 'zoysia',  sqft_bracket: 4000, tier: 'standard', monthly_price: 44 },
    { grass_track: 'zoysia',  sqft_bracket: 5000, tier: 'standard', monthly_price: 47 },
    { grass_track: 'zoysia',  sqft_bracket: 6000, tier: 'standard', monthly_price: 50 },
    { grass_track: 'zoysia',  sqft_bracket: 7000, tier: 'standard', monthly_price: 53 },
    // Zoysia Enhanced
    { grass_track: 'zoysia',  sqft_bracket: 4000, tier: 'enhanced', monthly_price: 55 },
    { grass_track: 'zoysia',  sqft_bracket: 5000, tier: 'enhanced', monthly_price: 62 },
    { grass_track: 'zoysia',  sqft_bracket: 6000, tier: 'enhanced', monthly_price: 69 },
    { grass_track: 'zoysia',  sqft_bracket: 7000, tier: 'enhanced', monthly_price: 76 },
  ];
  for (const row of updates) {
    await knex('lawn_pricing_brackets')
      .where({ grass_track: row.grass_track, sqft_bracket: row.sqft_bracket, tier: row.tier })
      .update({ monthly_price: row.monthly_price, updated_at: knex.fn.now() });
  }
};

exports.down = async function (knex) {
  // Revert to pre-Session-5 flat bracket values captured from prod 2026-04-17
  const reverts = [
    // Bermuda Basic — flat $40
    { grass_track: 'bermuda', sqft_bracket: 4000, tier: 'basic',    monthly_price: 40 },
    { grass_track: 'bermuda', sqft_bracket: 5000, tier: 'basic',    monthly_price: 40 },
    { grass_track: 'bermuda', sqft_bracket: 6000, tier: 'basic',    monthly_price: 40 },
    { grass_track: 'bermuda', sqft_bracket: 7000, tier: 'basic',    monthly_price: 40 },
    // Bermuda Standard
    { grass_track: 'bermuda', sqft_bracket: 4000, tier: 'standard', monthly_price: 50 },
    { grass_track: 'bermuda', sqft_bracket: 5000, tier: 'standard', monthly_price: 50 },
    { grass_track: 'bermuda', sqft_bracket: 6000, tier: 'standard', monthly_price: 50 },
    { grass_track: 'bermuda', sqft_bracket: 7000, tier: 'standard', monthly_price: 51 },
    // Bermuda Enhanced
    { grass_track: 'bermuda', sqft_bracket: 4000, tier: 'enhanced', monthly_price: 60 },
    { grass_track: 'bermuda', sqft_bracket: 5000, tier: 'enhanced', monthly_price: 60 },
    { grass_track: 'bermuda', sqft_bracket: 6000, tier: 'enhanced', monthly_price: 67 },
    { grass_track: 'bermuda', sqft_bracket: 7000, tier: 'enhanced', monthly_price: 74 },
    // Zoysia Basic — flat $40
    { grass_track: 'zoysia',  sqft_bracket: 4000, tier: 'basic',    monthly_price: 40 },
    { grass_track: 'zoysia',  sqft_bracket: 5000, tier: 'basic',    monthly_price: 40 },
    { grass_track: 'zoysia',  sqft_bracket: 6000, tier: 'basic',    monthly_price: 40 },
    { grass_track: 'zoysia',  sqft_bracket: 7000, tier: 'basic',    monthly_price: 40 },
    // Zoysia Standard
    { grass_track: 'zoysia',  sqft_bracket: 4000, tier: 'standard', monthly_price: 50 },
    { grass_track: 'zoysia',  sqft_bracket: 5000, tier: 'standard', monthly_price: 50 },
    { grass_track: 'zoysia',  sqft_bracket: 6000, tier: 'standard', monthly_price: 50 },
    { grass_track: 'zoysia',  sqft_bracket: 7000, tier: 'standard', monthly_price: 52 },
    // Zoysia Enhanced
    { grass_track: 'zoysia',  sqft_bracket: 4000, tier: 'enhanced', monthly_price: 60 },
    { grass_track: 'zoysia',  sqft_bracket: 5000, tier: 'enhanced', monthly_price: 61 },
    { grass_track: 'zoysia',  sqft_bracket: 6000, tier: 'enhanced', monthly_price: 68 },
    { grass_track: 'zoysia',  sqft_bracket: 7000, tier: 'enhanced', monthly_price: 75 },
  ];
  for (const row of reverts) {
    await knex('lawn_pricing_brackets')
      .where({ grass_track: row.grass_track, sqft_bracket: row.sqft_bracket, tier: row.tier })
      .update({ monthly_price: row.monthly_price, updated_at: knex.fn.now() });
  }
};
