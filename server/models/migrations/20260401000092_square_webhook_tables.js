/**
 * Migration: Square Webhook Automation Tables
 * 
 * Creates tables needed by the expanded Square webhook handler:
 * 1. customer_subscriptions — tracks Square subscriptions for WaveGuard tier computation
 * 2. email_automation_sends — tracks which automations have been sent to which customers
 * 3. Adds square_booking_id to scheduled_services for booking sync
 * 4. Adds square_team_member_id to technicians for team member sync
 */

exports.up = async function (knex) {
  // 1. Customer subscriptions — for WaveGuard tier auto-computation
  if (!(await knex.schema.hasTable('customer_subscriptions'))) {
    await knex.schema.createTable('customer_subscriptions', t => {
      t.increments('id').primary();
      t.uuid('customer_id').notNullable();
      t.string('square_subscription_id', 100).unique();
      t.string('square_customer_id', 100);
      t.string('service_type', 100);
      t.string('status', 30).defaultTo('active'); // active, paused, cancelled
      t.date('start_date');
      t.date('end_date');
      t.decimal('monthly_amount', 10, 2);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());

      t.index('customer_id');
      t.index('status');
      t.index('square_subscription_id');
    });
  }

  // 2. Email automation sends — prevents duplicate sends
  if (!(await knex.schema.hasTable('email_automation_sends'))) {
    await knex.schema.createTable('email_automation_sends', t => {
      t.increments('id').primary();
      t.uuid('customer_id').notNullable();
      t.string('automation_key', 100).notNullable(); // 'new_recurring', 'lawn_onboarding', etc.
      t.string('status', 30).defaultTo('queued'); // queued, sent, failed
      t.jsonb('metadata');
      t.timestamp('queued_at');
      t.timestamp('sent_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.index(['customer_id', 'automation_key']);
      t.unique(['customer_id', 'automation_key']); // One send per automation per customer
    });
  }

  // 3. Add square_booking_id to scheduled_services (for booking sync dedup)
  if (await knex.schema.hasTable('scheduled_services')) {
    const hasCol = await knex.schema.hasColumn('scheduled_services', 'square_booking_id');
    if (!hasCol) {
      await knex.schema.alterTable('scheduled_services', t => {
        t.string('square_booking_id', 100).nullable();
        t.string('source', 50).nullable(); // 'square_booking', 'manual', 'portal'
        t.index('square_booking_id');
      });
    }
  }

  // 4. Add square_team_member_id to technicians (for team member sync)
  if (await knex.schema.hasTable('technicians')) {
    const hasCol = await knex.schema.hasColumn('technicians', 'square_team_member_id');
    if (!hasCol) {
      await knex.schema.alterTable('technicians', t => {
        t.string('square_team_member_id', 100).nullable();
        t.index('square_team_member_id');
      });
    }
  }

  // 5. Add stage to customers if not exists (for lifecycle pipeline)
  if (await knex.schema.hasTable('customers')) {
    const hasStage = await knex.schema.hasColumn('customers', 'stage');
    if (!hasStage) {
      await knex.schema.alterTable('customers', t => {
        t.string('stage', 50).defaultTo('new_lead');
      });
    }
    const hasLastPayment = await knex.schema.hasColumn('customers', 'last_payment_at');
    if (!hasLastPayment) {
      await knex.schema.alterTable('customers', t => {
        t.timestamp('last_payment_at').nullable();
      });
    }
    const hasTotalRevenue = await knex.schema.hasColumn('customers', 'total_revenue');
    if (!hasTotalRevenue) {
      await knex.schema.alterTable('customers', t => {
        t.decimal('total_revenue', 10, 2).defaultTo(0);
      });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('email_automation_sends');
  await knex.schema.dropTableIfExists('customer_subscriptions');

  if (await knex.schema.hasTable('scheduled_services')) {
    const hasCol = await knex.schema.hasColumn('scheduled_services', 'square_booking_id');
    if (hasCol) {
      await knex.schema.alterTable('scheduled_services', t => {
        t.dropColumn('square_booking_id');
        t.dropColumn('source');
      });
    }
  }

  if (await knex.schema.hasTable('technicians')) {
    const hasCol = await knex.schema.hasColumn('technicians', 'square_team_member_id');
    if (hasCol) {
      await knex.schema.alterTable('technicians', t => {
        t.dropColumn('square_team_member_id');
      });
    }
  }
};
