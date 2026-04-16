/**
 * Retire the ACH payment discount.
 *
 * Prior payment model: baked a 3% card-processing absorption into all prices,
 * then offered a 3% ACH discount to rebate bank payers.
 *
 * New model: quote prices at base, add a 3% card surcharge at checkout for
 * credit/debit/wallet payments, ACH pays the quoted amount with no discount.
 *
 * This migration deactivates the seeded `ach_payment_discount` row so the
 * discount engine returns no savings for ACH going forward. The row is kept
 * (not deleted) so historical invoices that referenced it remain auditable.
 */
exports.up = async function (knex) {
  // ── 1. Deactivate the ACH payment discount row ──────────────────────
  if (await knex.schema.hasColumn('discounts', 'is_active')) {
    await knex('discounts')
      .where({ discount_key: 'ach_payment_discount' })
      .update({ is_active: false, amount: 0 });
  }

  // ── 2. Revert pricing_config rows that had the 3% markup baked in ──
  if (await knex.schema.hasTable('pricing_config')) {
    const reverts = [
      ['ts_monthly_floors', { standard: 50, enhanced: 65, premium: 80 }],
      ['termite_monitoring', { basic: 35, premier: 65 }],
      ['rodent_monthly', { small: 75, medium: 89, large: 109 }],
      ['rodent_trapping', { base: 350, floor: 350 }],
      ['onetime_pest', { floor: 150, multiplier: 1.30 }],
      ['onetime_lawn', { floor: 85, fungicide_floor: 95, weed_mult: 1.15, fungicide_mult: 1.45 }],
      ['onetime_trenching', { per_lf_dirt: 10, per_lf_concrete: 14, floor: 600, renewal: 325 }],
      ['onetime_exclusion', { simple: 37.5, moderate: 75, advanced: 150, floor: 150, inspection: 85 }],
      ['ach_discount', { percentage: 0, exempt_from_composite_cap: true, payment_method: 'us_bank_account', note: 'Retired — card surcharge now applied at checkout' }],
    ];
    for (const [key, data] of reverts) {
      await knex('pricing_config').where({ config_key: key }).update({ data: JSON.stringify(data) });
    }
  }

  // ── 3. Revert lawn_pricing_brackets to the pre-markup values ─────────
  // The 20260414000013 migration multiplied every monthly_price by 1.03 and
  // rounded. Rather than inverse-rounding, restore the exact original set
  // from the 20260414000011 seed.
  if (await knex.schema.hasTable('lawn_pricing_brackets')) {
    const TRACKS = {
      st_augustine: [[0,35,45,55,65],[3000,35,45,55,65],[3500,35,45,55,68],[4000,35,45,55,73],[5000,35,45,59,84],[6000,35,46,66,96],[7000,38,50,73,107],[8000,41,55,80,118],[10000,47,64,94,140],[12000,54,73,109,162],[15000,63,86,130,195],[20000,80,108,165,250]],
      bermuda:      [[0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,60,86],[6000,40,50,67,97],[7000,40,51,74,108],[8000,42,56,82,120],[10000,48,65,96,142],[12000,55,74,111,165],[15000,65,88,132,199],[20000,81,111,169,256]],
      zoysia:       [[0,40,50,60,75],[4000,40,50,60,75],[5000,40,50,61,87],[6000,40,50,68,98],[7000,40,52,75,110],[8000,42,56,83,121],[10000,49,66,97,144],[12000,56,75,112,167],[15000,66,89,134,202],[20000,83,112,171,259]],
      bahia:        [[0,30,40,50,60],[3000,30,40,50,60],[3500,30,40,50,63],[4000,30,40,50,68],[5000,30,40,55,78],[6000,32,42,61,87],[7000,35,46,67,97],[8000,37,50,73,107],[10000,43,58,86,126],[12000,48,66,98,145],[15000,57,77,117,174],[20000,71,97,148,223]],
    };
    const TIERS = ['basic', 'standard', 'enhanced', 'premium'];
    for (const [track, rows] of Object.entries(TRACKS)) {
      for (const row of rows) {
        const [sqft_bracket, ...tierPrices] = row;
        for (let i = 0; i < TIERS.length; i++) {
          await knex('lawn_pricing_brackets')
            .where({ grass_track: track, sqft_bracket, tier: TIERS[i] })
            .update({ monthly_price: tierPrices[i], updated_at: knex.fn.now() });
        }
      }
    }
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('discounts', 'is_active')) {
    await knex('discounts')
      .where({ discount_key: 'ach_payment_discount' })
      .update({ is_active: true, amount: 3 });
  }
  // Do not reapply price bumps on rollback — operator can re-run the original
  // 20260414000013_payment_model_restructure if they really want that behavior.
};
