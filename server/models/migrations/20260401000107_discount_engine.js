exports.up = async function (knex) {
  // 1. discounts table
  if (!(await knex.schema.hasTable('discounts'))) {
    await knex.schema.createTable('discounts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('discount_key', 80).unique().notNullable();
      t.string('name', 200).notNullable();
      t.text('description');
      t.string('discount_type', 20).notNullable().defaultTo('percentage');
      t.decimal('amount', 10, 2).notNullable().defaultTo(0);
      t.decimal('max_discount_dollars', 10, 2);
      t.string('applies_to', 30).defaultTo('all');
      t.string('service_category_filter', 200);
      t.string('service_key_filter', 200);
      t.string('requires_waveguard_tier', 20);
      t.boolean('is_waveguard_tier_discount').defaultTo(false);
      t.boolean('requires_military').defaultTo(false);
      t.boolean('requires_senior').defaultTo(false);
      t.boolean('requires_referral').defaultTo(false);
      t.boolean('requires_new_customer').defaultTo(false);
      t.boolean('requires_multi_home').defaultTo(false);
      t.boolean('requires_prepayment').defaultTo(false);
      t.integer('min_service_count');
      t.decimal('min_subtotal', 10, 2);
      t.boolean('is_stackable').defaultTo(true);
      t.string('stack_group', 30);
      t.integer('priority').defaultTo(100);
      t.string('promo_code', 50).unique();
      t.timestamp('promo_code_expiry');
      t.integer('promo_code_max_uses');
      t.integer('promo_code_current_uses').defaultTo(0);
      t.boolean('is_active').defaultTo(true);
      t.boolean('is_auto_apply').defaultTo(false);
      t.boolean('show_in_estimates').defaultTo(true);
      t.boolean('show_in_invoices').defaultTo(true);
      t.boolean('show_in_scheduling').defaultTo(false);
      t.integer('sort_order');
      t.string('color', 30);
      t.string('icon', 50);
      t.integer('times_applied').defaultTo(0);
      t.decimal('total_discount_given', 12, 2).defaultTo(0);
      t.timestamps(true, true);
    });

    // Seed 14 discounts
    await knex('discounts').insert([
      { discount_key: 'waveguard_bronze', name: 'WaveGuard Bronze', description: 'Bronze tier — no discount', discount_type: 'percentage', amount: 0, is_waveguard_tier_discount: true, requires_waveguard_tier: 'Bronze', is_auto_apply: true, is_stackable: false, stack_group: 'tier', priority: 10, sort_order: 1, color: '#cd7f32', icon: '🥉' },
      { discount_key: 'waveguard_silver', name: 'WaveGuard Silver', description: 'Silver tier — 10% off all services', discount_type: 'percentage', amount: 10, is_waveguard_tier_discount: true, requires_waveguard_tier: 'Silver', is_auto_apply: true, is_stackable: false, stack_group: 'tier', priority: 10, sort_order: 2, color: '#c0c0c0', icon: '🥈' },
      { discount_key: 'waveguard_gold', name: 'WaveGuard Gold', description: 'Gold tier — 15% off all services', discount_type: 'percentage', amount: 15, is_waveguard_tier_discount: true, requires_waveguard_tier: 'Gold', is_auto_apply: true, is_stackable: false, stack_group: 'tier', priority: 10, sort_order: 3, color: '#ffd700', icon: '🥇' },
      { discount_key: 'waveguard_platinum', name: 'WaveGuard Platinum', description: 'Platinum tier — 20% off all services', discount_type: 'percentage', amount: 20, is_waveguard_tier_discount: true, requires_waveguard_tier: 'Platinum', is_auto_apply: true, is_stackable: false, stack_group: 'tier', priority: 10, sort_order: 4, color: '#e5e4e2', icon: '💎' },
      { discount_key: 'military', name: 'Military Discount', description: '5% discount for active duty & veterans', discount_type: 'percentage', amount: 5, requires_military: true, is_auto_apply: true, is_stackable: true, priority: 50, sort_order: 10, color: '#22c55e', icon: '🎖️' },
      { discount_key: 'family_friends', name: 'Family & Friends', description: '15% family & friends discount', discount_type: 'percentage', amount: 15, is_stackable: false, stack_group: 'relationship', priority: 30, sort_order: 11, color: '#ec4899', icon: '❤️' },
      { discount_key: 'multi_home', name: 'Multi-Home Discount', description: '10% off for customers with multiple properties', discount_type: 'percentage', amount: 10, requires_multi_home: true, is_auto_apply: true, is_stackable: true, priority: 50, sort_order: 12, color: '#8b5cf6', icon: '🏘️' },
      { discount_key: 'new_customer', name: 'New Customer Special', description: 'First service for $149.99', discount_type: 'fixed_amount', amount: 149.99, requires_new_customer: true, is_auto_apply: false, is_stackable: false, stack_group: 'promo', priority: 20, sort_order: 13, color: '#0ea5e9', icon: '🌟' },
      { discount_key: 'prepayment', name: 'Prepayment Discount', description: '5% off when paying upfront for annual service', discount_type: 'percentage', amount: 5, requires_prepayment: true, is_auto_apply: false, is_stackable: true, priority: 60, sort_order: 14, color: '#14b8a6', icon: '💰' },
      { discount_key: 'referral', name: 'Referral Credit', description: '$50 credit for each successful referral', discount_type: 'fixed_amount', amount: 50, requires_referral: true, is_auto_apply: false, is_stackable: true, priority: 40, sort_order: 15, color: '#f97316', icon: '🤝' },
      { discount_key: 'senior', name: 'Senior Discount', description: '5% discount for seniors 65+', discount_type: 'percentage', amount: 5, requires_senior: true, is_auto_apply: true, is_stackable: true, priority: 50, sort_order: 16, color: '#a78bfa', icon: '👴' },
      { discount_key: 'free_termite_inspection', name: 'Free Termite Inspection', description: 'Free termite inspection for Silver tier and above', discount_type: 'free_service', amount: 0, requires_waveguard_tier: 'Silver', service_key_filter: 'termite_inspection', is_auto_apply: true, is_stackable: true, priority: 70, sort_order: 17, color: '#f59e0b', icon: '🐛' },
      { discount_key: 'custom_percent', name: 'Custom Percentage Discount', description: 'Admin-assigned custom percentage discount', discount_type: 'percentage', amount: 0, is_auto_apply: false, is_stackable: true, priority: 90, sort_order: 50, color: '#64748b', icon: '✏️' },
      { discount_key: 'custom_dollar', name: 'Custom Dollar Discount', description: 'Admin-assigned custom dollar amount discount', discount_type: 'fixed_amount', amount: 0, is_auto_apply: false, is_stackable: true, priority: 90, sort_order: 51, color: '#64748b', icon: '✏️' },
    ]).catch(() => {});
  }

  // 2. customer_discounts — join table
  if (!(await knex.schema.hasTable('customer_discounts'))) {
    await knex.schema.createTable('customer_discounts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable();
      t.uuid('discount_id').notNullable();
      t.text('applied_reason');
      t.string('applied_by', 200);
      t.timestamp('expires_at');
      t.boolean('is_active').defaultTo(true);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['customer_id', 'discount_id']);
    });
  }

  // 3. invoice_discounts
  if (!(await knex.schema.hasTable('invoice_discounts'))) {
    await knex.schema.createTable('invoice_discounts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('invoice_id').notNullable();
      t.uuid('discount_id');
      t.string('discount_name', 200);
      t.string('discount_type', 20);
      t.decimal('amount', 10, 2);
      t.decimal('discount_dollars', 10, 2);
      t.string('applied_by', 200);
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
  }

  // 4. ALTER customers — add demographic flags
  if (await knex.schema.hasTable('customers')) {
    if (!(await knex.schema.hasColumn('customers', 'is_military'))) {
      await knex.schema.alterTable('customers', (t) => { t.boolean('is_military').defaultTo(false); });
    }
    if (!(await knex.schema.hasColumn('customers', 'is_senior'))) {
      await knex.schema.alterTable('customers', (t) => { t.boolean('is_senior').defaultTo(false); });
    }
    if (!(await knex.schema.hasColumn('customers', 'has_multi_home'))) {
      await knex.schema.alterTable('customers', (t) => { t.boolean('has_multi_home').defaultTo(false); });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('invoice_discounts');
  await knex.schema.dropTableIfExists('customer_discounts');
  await knex.schema.dropTableIfExists('discounts');
};
