/**
 * Migration: Enhanced Square Import fields
 *
 * - customers: internal_notes, square_notes, square_groups, square_created_at,
 *              tags, preferred_time, gate_code, pet_info, access_notes
 * - payments: receipt_url, square_order_id, card_brand, card_last_four, refunded_at
 * - scheduled_services: no_show, booking_source
 */

exports.up = async function (knex) {
  // ── customers ──────────────────────────────────────────────────────────
  if (await knex.schema.hasTable('customers')) {
    await knex.schema.alterTable('customers', t => {
      // Each column guarded individually
    });

    const cols = {
      internal_notes:    () => knex.schema.alterTable('customers', t => t.text('internal_notes')),
      square_notes:      () => knex.schema.alterTable('customers', t => t.text('square_notes')),
      square_groups:     () => knex.schema.alterTable('customers', t => t.jsonb('square_groups')),
      square_created_at: () => knex.schema.alterTable('customers', t => t.timestamp('square_created_at')),
      tags:              () => knex.schema.alterTable('customers', t => t.jsonb('tags').defaultTo('[]')),
      preferred_time:    () => knex.schema.alterTable('customers', t => t.string('preferred_time', 20)),
      gate_code:         () => knex.schema.alterTable('customers', t => t.string('gate_code', 50)),
      pet_info:          () => knex.schema.alterTable('customers', t => t.string('pet_info', 200)),
      access_notes:      () => knex.schema.alterTable('customers', t => t.text('access_notes')),
    };

    for (const [col, addFn] of Object.entries(cols)) {
      if (!(await knex.schema.hasColumn('customers', col))) {
        await addFn();
      }
    }
  }

  // ── payments ───────────────────────────────────────────────────────────
  if (await knex.schema.hasTable('payments')) {
    const cols = {
      receipt_url:     () => knex.schema.alterTable('payments', t => t.string('receipt_url', 500)),
      square_order_id: () => knex.schema.alterTable('payments', t => t.string('square_order_id', 100)),
      card_brand:      () => knex.schema.alterTable('payments', t => t.string('card_brand', 20)),
      card_last_four:  () => knex.schema.alterTable('payments', t => t.string('card_last_four', 4)),
      refunded_at:     () => knex.schema.alterTable('payments', t => t.timestamp('refunded_at')),
    };

    for (const [col, addFn] of Object.entries(cols)) {
      if (!(await knex.schema.hasColumn('payments', col))) {
        await addFn();
      }
    }
  }

  // ── scheduled_services ─────────────────────────────────────────────────
  if (await knex.schema.hasTable('scheduled_services')) {
    const cols = {
      no_show:        () => knex.schema.alterTable('scheduled_services', t => t.boolean('no_show').defaultTo(false)),
      booking_source: () => knex.schema.alterTable('scheduled_services', t => t.string('booking_source', 30)),
    };

    for (const [col, addFn] of Object.entries(cols)) {
      if (!(await knex.schema.hasColumn('scheduled_services', col))) {
        await addFn();
      }
    }
  }
};

exports.down = async function (knex) {
  // customers
  if (await knex.schema.hasTable('customers')) {
    for (const col of ['internal_notes', 'square_notes', 'square_groups', 'square_created_at', 'tags', 'preferred_time', 'gate_code', 'pet_info', 'access_notes']) {
      if (await knex.schema.hasColumn('customers', col)) {
        await knex.schema.alterTable('customers', t => t.dropColumn(col));
      }
    }
  }

  // payments
  if (await knex.schema.hasTable('payments')) {
    for (const col of ['receipt_url', 'square_order_id', 'card_brand', 'card_last_four', 'refunded_at']) {
      if (await knex.schema.hasColumn('payments', col)) {
        await knex.schema.alterTable('payments', t => t.dropColumn(col));
      }
    }
  }

  // scheduled_services
  if (await knex.schema.hasTable('scheduled_services')) {
    for (const col of ['no_show', 'booking_source']) {
      if (await knex.schema.hasColumn('scheduled_services', col)) {
        await knex.schema.alterTable('scheduled_services', t => t.dropColumn(col));
      }
    }
  }
};
