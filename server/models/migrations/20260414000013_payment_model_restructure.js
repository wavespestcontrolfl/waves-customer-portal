/**
 * Payment Model Restructure: 3% bracket increase + ACH discount infrastructure
 *
 * 1. Apply 1.03x multiplier to all customer-facing prices in lawn_pricing_brackets
 * 2. Apply 1.03x to customer-facing pricing_config constants
 * 3. Add ACH discount to discounts table
 * 4. Create ach_failure_log table
 * 5. Add ach_status / ach_failure_count to customers
 * 6. Add payment_method_condition to discounts table
 */
exports.up = async function(knex) {

  // ── 1. Lawn pricing brackets: multiply all monthly_price by 1.03, round ──
  if (await knex.schema.hasTable('lawn_pricing_brackets')) {
    await knex.raw(`
      UPDATE lawn_pricing_brackets
      SET monthly_price = ROUND(monthly_price * 1.03),
          updated_at = NOW()
    `);
  }

  // ── 2. Customer-facing pricing_config constants ──
  // These are all dollar amounts customers see — NOT internal costs/rates/ratios
  const customerFacingKeys = [
    // Pest control
    'PEST_BASE_PRICE', 'PEST_FLOOR',
    // Tree & Shrub floors
    'TS_FLOOR_STANDARD', 'TS_FLOOR_ENHANCED', 'TS_FLOOR_PREMIUM',
    // Palm injection
    'PALM_PRICE_NUTRITION', 'PALM_PRICE_INSECTICIDE', 'PALM_PRICE_COMBO',
    'PALM_PRICE_FUNGAL', 'PALM_PRICE_LB_FLOOR', 'PALM_PRICE_TREEAGE_FLOOR',
    // Termite monitoring
    'TERMITE_BASIC_MONTHLY', 'TERMITE_PREMIER_MONTHLY',
    // Rodent
    'RODENT_SMALL', 'RODENT_MEDIUM', 'RODENT_LARGE', 'RODENT_TRAPPING_BASE',
    // One-time
    'OT_PEST_FLOOR', 'OT_LAWN_FLOOR', 'OT_LAWN_FUNGICIDE_FLOOR',
    // Trenching
    'TRENCH_FLOOR', 'TRENCH_RENEWAL',
    // Exclusion
    'EXCL_SIMPLE', 'EXCL_MODERATE', 'EXCL_ADVANCED', 'EXCL_INSPECTION',
  ];

  if (await knex.schema.hasTable('pricing_config')) {
    // Check which column holds the value — the migration table uses config_value,
    // but the route's ensureTable uses jsonb 'data'. Handle both.
    const cols = await knex.raw(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'pricing_config' AND column_name IN ('config_value', 'data')
    `);
    const colNames = cols.rows.map(r => r.column_name);

    if (colNames.includes('config_value')) {
      for (const key of customerFacingKeys) {
        const row = await knex('pricing_config').where({ config_key: key }).first();
        if (row) {
          const oldVal = parseFloat(row.config_value);
          const newVal = Math.round(oldVal * 1.03 * 100) / 100;
          // Round dollar amounts to whole numbers (floors, bases, monthly prices)
          const rounded = oldVal >= 10 ? Math.round(newVal) : newVal;
          await knex('pricing_config').where({ config_key: key }).update({
            config_value: rounded,
            updated_at: knex.fn.now(),
          });
          // Audit log
          try {
            await knex('pricing_config_audit').insert({
              config_key: key,
              old_value: oldVal,
              new_value: rounded,
              changed_by: 'migration:payment_model_restructure',
              reason: 'Payment model restructure: absorb processing cost into base pricing (+3%)',
            });
          } catch { /* audit table may have different schema */ }
        }
      }
    }

    // Also handle the jsonb 'data' column format used by admin-pricing-config route
    if (colNames.includes('data')) {
      // Update pest_base config (jsonb with base/floor)
      const pestBase = await knex('pricing_config').where({ config_key: 'pest_base' }).first();
      if (pestBase) {
        const d = typeof pestBase.data === 'string' ? JSON.parse(pestBase.data) : pestBase.data;
        if (d.base) d.base = Math.round(d.base * 1.03);
        if (d.floor) d.floor = Math.round(d.floor * 1.03);
        await knex('pricing_config').where({ config_key: 'pest_base' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
      }

      // Update pest_footprint adjustments
      const pestFp = await knex('pricing_config').where({ config_key: 'pest_footprint' }).first();
      if (pestFp) {
        const d = typeof pestFp.data === 'string' ? JSON.parse(pestFp.data) : pestFp.data;
        if (d.breakpoints) {
          d.breakpoints = d.breakpoints.map(bp => ({ ...bp, adj: Math.round(bp.adj * 1.03) }));
          await knex('pricing_config').where({ config_key: 'pest_footprint' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
        }
      }

      // Update lawn_st_augustine bracket config (jsonb array-of-arrays)
      const lawnConfig = await knex('pricing_config').where({ config_key: 'lawn_st_augustine' }).first();
      if (lawnConfig) {
        const d = typeof lawnConfig.data === 'string' ? JSON.parse(lawnConfig.data) : lawnConfig.data;
        if (Array.isArray(d)) {
          const updated = d.map(row => [row[0], ...row.slice(1).map(v => Math.round(v * 1.03))]);
          await knex('pricing_config').where({ config_key: 'lawn_st_augustine' }).update({ data: JSON.stringify(updated), updated_at: knex.fn.now() });
        }
      }

      // Update T&S monthly floors
      const tsFloors = await knex('pricing_config').where({ config_key: 'ts_monthly_floors' }).first();
      if (tsFloors) {
        const d = typeof tsFloors.data === 'string' ? JSON.parse(tsFloors.data) : tsFloors.data;
        if (d.standard) d.standard = Math.round(d.standard * 1.03);
        if (d.enhanced) d.enhanced = Math.round(d.enhanced * 1.03);
        if (d.premium) d.premium = Math.round(d.premium * 1.03);
        await knex('pricing_config').where({ config_key: 'ts_monthly_floors' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
      }

      // Update palm pricing
      const palm = await knex('pricing_config').where({ config_key: 'palm_pricing' }).first();
      if (palm) {
        const d = typeof palm.data === 'string' ? JSON.parse(palm.data) : palm.data;
        for (const k of Object.keys(d)) {
          if (typeof d[k] === 'number') d[k] = Math.round(d[k] * 1.03);
        }
        await knex('pricing_config').where({ config_key: 'palm_pricing' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
      }

      // Update termite monitoring
      const termMon = await knex('pricing_config').where({ config_key: 'termite_monitoring' }).first();
      if (termMon) {
        const d = typeof termMon.data === 'string' ? JSON.parse(termMon.data) : termMon.data;
        if (d.basic) d.basic = Math.round(d.basic * 1.03);
        if (d.premier) d.premier = Math.round(d.premier * 1.03);
        await knex('pricing_config').where({ config_key: 'termite_monitoring' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
      }

      // Update rodent monthly
      const rodent = await knex('pricing_config').where({ config_key: 'rodent_monthly' }).first();
      if (rodent) {
        const d = typeof rodent.data === 'string' ? JSON.parse(rodent.data) : rodent.data;
        for (const k of Object.keys(d)) {
          if (typeof d[k] === 'number') d[k] = Math.round(d[k] * 1.03);
        }
        await knex('pricing_config').where({ config_key: 'rodent_monthly' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
      }

      // Update rodent trapping
      const rodTrap = await knex('pricing_config').where({ config_key: 'rodent_trapping' }).first();
      if (rodTrap) {
        const d = typeof rodTrap.data === 'string' ? JSON.parse(rodTrap.data) : rodTrap.data;
        if (d.base) d.base = Math.round(d.base * 1.03);
        await knex('pricing_config').where({ config_key: 'rodent_trapping' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
      }

      // Update trenching rates
      const trench = await knex('pricing_config').where({ config_key: 'onetime_trenching' }).first();
      if (trench) {
        const d = typeof trench.data === 'string' ? JSON.parse(trench.data) : trench.data;
        if (d.per_lf_dirt) d.per_lf_dirt = Math.round(d.per_lf_dirt * 1.03 * 100) / 100;
        if (d.per_lf_concrete) d.per_lf_concrete = Math.round(d.per_lf_concrete * 1.03 * 100) / 100;
        if (d.floor) d.floor = Math.round(d.floor * 1.03);
        await knex('pricing_config').where({ config_key: 'onetime_trenching' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
      }

      // Update exclusion pricing
      const excl = await knex('pricing_config').where({ config_key: 'onetime_exclusion' }).first();
      if (excl) {
        const d = typeof excl.data === 'string' ? JSON.parse(excl.data) : excl.data;
        for (const k of Object.keys(d)) {
          if (typeof d[k] === 'number') d[k] = Math.round(d[k] * 1.03 * 100) / 100;
        }
        await knex('pricing_config').where({ config_key: 'onetime_exclusion' }).update({ data: JSON.stringify(d), updated_at: knex.fn.now() });
      }
    }
  }

  // ── 3. Add payment_method_condition column to discounts ──
  if (await knex.schema.hasTable('discounts')) {
    if (!(await knex.schema.hasColumn('discounts', 'payment_method_condition'))) {
      await knex.schema.alterTable('discounts', t => {
        t.string('payment_method_condition', 50);
      });
    }

    // Insert ACH discount
    const exists = await knex('discounts').where({ discount_key: 'ach_payment_discount' }).first();
    if (!exists) {
      await knex('discounts').insert({
        discount_key: 'ach_payment_discount',
        name: 'Bank Payment Discount',
        discount_type: 'percentage',
        amount: 3,
        is_stackable: true,
        priority: 999,
        is_auto_apply: true,
        is_active: true,
        payment_method_condition: 'us_bank_account',
        show_in_estimates: false,
        show_in_invoices: true,
        description: 'Save 3% with bank payment',
        color: '#10b981',
        icon: '🏦',
      });
    }
  }

  // ── 4. ACH failure log table ──
  if (!(await knex.schema.hasTable('ach_failure_log'))) {
    // Create without the FK first so the table always lands cleanly
    await knex.schema.createTable('ach_failure_log', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id'); // FK added below after orphan cleanup
      t.string('stripe_payment_intent_id', 255);
      t.string('failure_reason', 255);
      t.timestamp('failure_date').defaultTo(knex.fn.now());
      t.timestamp('retry_date');
      t.boolean('resolved').defaultTo(false);
      t.string('resolution', 50); // retry_success, card_fallback, customer_updated
      t.index('customer_id');
    });
  }

  // Delete orphaned rows where customer_id has no matching customer, then add
  // the FK constraint if it does not already exist.  We check the information
  // schema so the step is idempotent across repeated migration runs.
  if (await knex.schema.hasTable('ach_failure_log') && await knex.schema.hasTable('customers')) {
    await knex.raw(`
      DELETE FROM ach_failure_log
      WHERE customer_id IS NOT NULL
        AND customer_id NOT IN (SELECT id FROM customers)
    `);

    const fkExists = await knex.raw(`
      SELECT 1 FROM information_schema.table_constraints
      WHERE table_name = 'ach_failure_log'
        AND constraint_name = 'ach_failure_log_customer_id_foreign'
        AND constraint_type = 'FOREIGN KEY'
    `);

    if (fkExists.rows.length === 0) {
      await knex.schema.alterTable('ach_failure_log', t => {
        t.foreign('customer_id').references('id').inTable('customers');
      });
    }
  }

  // ── 5. Add ACH status columns to customers ──
  if (await knex.schema.hasTable('customers')) {
    if (!(await knex.schema.hasColumn('customers', 'ach_status'))) {
      await knex.schema.alterTable('customers', t => {
        t.string('ach_status', 50).defaultTo('active'); // active, needs_verification, suspended
      });
    }
    if (!(await knex.schema.hasColumn('customers', 'ach_failure_count'))) {
      await knex.schema.alterTable('customers', t => {
        t.integer('ach_failure_count').defaultTo(0);
      });
    }
  }
};

exports.down = async function(knex) {
  // Reverse the 3% increase on lawn brackets
  if (await knex.schema.hasTable('lawn_pricing_brackets')) {
    await knex.raw(`
      UPDATE lawn_pricing_brackets
      SET monthly_price = ROUND(monthly_price / 1.03),
          updated_at = NOW()
    `);
  }

  await knex.schema.dropTableIfExists('ach_failure_log');

  if (await knex.schema.hasTable('customers')) {
    if (await knex.schema.hasColumn('customers', 'ach_status')) {
      await knex.schema.alterTable('customers', t => { t.dropColumn('ach_status'); });
    }
    if (await knex.schema.hasColumn('customers', 'ach_failure_count')) {
      await knex.schema.alterTable('customers', t => { t.dropColumn('ach_failure_count'); });
    }
  }

  if (await knex.schema.hasTable('discounts')) {
    await knex('discounts').where({ discount_key: 'ach_payment_discount' }).del();
    if (await knex.schema.hasColumn('discounts', 'payment_method_condition')) {
      await knex.schema.alterTable('discounts', t => { t.dropColumn('payment_method_condition'); });
    }
  }
};
