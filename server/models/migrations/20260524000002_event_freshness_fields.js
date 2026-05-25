/**
 * Add freshness classification and admin curation fields to events_raw.
 * These power the newsletter content engine's freshness-first editorial
 * policy: only fresh events (one-time, annual, opening weekends, new
 * series) make it into the weekly digest; stale recurring events are
 * suppressed.
 *
 * Fields are populated by:
 *   1. The normalizer's Claude classification pass (automated)
 *   2. Admin overrides via the Event Inbox UI (manual curation)
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('events_raw', (table) => {
    // Freshness classification
    table.string('event_type', 32).notNullable().defaultTo('unknown');
    table.string('recurrence_type', 16).notNullable().defaultTo('unknown');
    table.string('freshness_status', 40).notNullable().defaultTo('needs_review');
    table.smallint('freshness_score').nullable();

    // Admin curation
    table.string('admin_status', 16).notNullable().defaultTo('pending');
    table.text('suppression_reason').nullable();

    // Feature tracking
    table.timestamp('last_featured_at').nullable();
    table.smallint('times_featured').notNullable().defaultTo(0);

    // Audience metadata
    table.string('region_zone', 32).nullable();
    table.boolean('family_friendly').nullable();
    table.boolean('is_free').nullable();
    table.string('price_text', 64).nullable();

    // Indexes for Event Inbox queries
    table.index(['freshness_status', 'admin_status'], 'idx_events_raw_freshness');
    table.index(['admin_status'], 'idx_events_raw_admin_status');
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('events_raw', (table) => {
    table.dropIndex(['freshness_status', 'admin_status'], 'idx_events_raw_freshness');
    table.dropIndex(['admin_status'], 'idx_events_raw_admin_status');

    table.dropColumn('event_type');
    table.dropColumn('recurrence_type');
    table.dropColumn('freshness_status');
    table.dropColumn('freshness_score');
    table.dropColumn('admin_status');
    table.dropColumn('suppression_reason');
    table.dropColumn('last_featured_at');
    table.dropColumn('times_featured');
    table.dropColumn('region_zone');
    table.dropColumn('family_friendly');
    table.dropColumn('is_free');
    table.dropColumn('price_text');
  });
};
