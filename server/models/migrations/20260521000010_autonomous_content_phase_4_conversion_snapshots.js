/**
 * Autonomous Content Engine — Phase 4 schema (conversion snapshots).
 *
 * One table: conversion_feedback_snapshots — caches the 90-day
 * conversion rollup for each (city, service) pair so opportunity
 * scoring doesn't recompute joins across leads/estimates/call_log
 * every mine. Computed on a schedule (later phase wires the cron);
 * Step 4 just runs it via CLI.
 *
 * Same NULL-distinct unique-constraint pattern as earlier phases:
 * city + service are NOT NULL with sentinel '_global' for unattributed
 * conversions (rare but real — direct phone calls without lead source).
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('conversion_feedback_snapshots');
  if (exists) return;

  await knex.schema.createTable('conversion_feedback_snapshots', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Window — captured at run time, ET-pinned (see scoring-config /
    // datetime-et discipline applied across the engine).
    t.date('window_end_date').notNullable();
    t.integer('window_days').notNullable().defaultTo(90);

    // Dimensions — NOT NULL with sentinel so unique constraint
    // actually dedupes (Postgres treats NULL as distinct in unique
    // indexes).
    t.string('city', 40).notNullable().defaultTo('_global');
    t.string('service', 40).notNullable().defaultTo('_global');

    // Volume counts.
    t.integer('form_submissions').notNullable().defaultTo(0);
    t.integer('calls_handled').notNullable().defaultTo(0);
    t.integer('calls_booked').notNullable().defaultTo(0);
    t.integer('leads_total').notNullable().defaultTo(0);
    t.integer('estimates_sent').notNullable().defaultTo(0);
    t.integer('estimates_accepted').notNullable().defaultTo(0);

    // Revenue (Stripe/PostgreSQL; estimates are the system of record).
    t.decimal('estimated_revenue', 12, 2).notNullable().defaultTo(0);
    t.decimal('avg_ticket', 12, 2);

    // Derived ratios — stored so downstream scoring doesn't recompute.
    t.decimal('close_rate', 5, 4);            // estimates_accepted / estimates_sent
    t.decimal('call_book_rate', 5, 4);        // calls_booked / calls_handled

    // Scoring outputs (clipped 0..max per scoring-config WEIGHTS).
    t.integer('lead_quality_score').notNullable().defaultTo(0);
    t.integer('close_rate_score').notNullable().defaultTo(0);
    t.integer('revenue_realization_score').notNullable().defaultTo(0);

    t.jsonb('source_breakdown').notNullable().defaultTo('{}');
    //   { lead_source_name: { leads: N, accepted: N, revenue: N }, ... }

    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);

    t.unique(['window_end_date', 'window_days', 'city', 'service']);
    t.index('window_end_date');
    t.index(['city', 'service']);
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('conversion_feedback_snapshots');
};
