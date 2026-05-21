/**
 * Autonomous Content Engine — Phase 3 schema (customer-insight clusters).
 *
 * One table: customer_insight_clusters — aggregates customer-question
 * topics observed across messages / call_log / google_reviews into
 * cluster rows. Each row is a topic+city+service tuple with counts +
 * one redacted, paraphrased example sentence.
 *
 * CRITICAL: this table NEVER stores raw transcripts, raw SMS bodies,
 * or unredacted review text. The miner pre-redacts and stores at most
 * one short example_phrasing_anonymized string per cluster. Florida
 * 934.03 two-party-consent requires we treat call recordings carefully;
 * the FTC data-minimization guidance reinforces storing only what's
 * needed.
 *
 * Pre-flight: add `call_recording_consent_disclaimer_played` to
 * `call_log` (operator task — the miner degrades gracefully if missing).
 */

exports.up = async function (knex) {
  const exists = await knex.schema.hasTable('customer_insight_clusters');
  if (exists) return;

  await knex.schema.createTable('customer_insight_clusters', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Topic + locale.
    t.string('topic', 80).notNullable();
    //   pet-safety | rain-after-treatment | same-day-service | price-cost |
    //   termite-vs-flying-ants | rodent-attic-noise | mosquito-timing |
    //   roach-identification | leave-house-after-spray | bugs-worse-after-spray
    //   lawn-fungus-brown-spots | chinch-bug-damage | fire-ants |
    //   ant-trail-kitchen | spider-in-house | fertilizer-blackout | …
    t.text('normalized_question');
    //   one canonical phrasing of the question — never a customer quote
    t.string('city', 40);
    t.string('service', 40);

    // Funnel + urgency.
    t.string('funnel_stage', 20);   // pre-sale | active-customer | post-service | unknown
    t.string('urgency', 10);        // high | medium | low

    // Source counts — by channel.
    t.jsonb('source_counts').notNullable().defaultTo('{}');
    //   { sms: N, call: N, review: N }
    t.integer('total_count').notNullable().defaultTo(0);

    // Provenance summary (counts only — no record IDs that could deanonymize).
    t.timestamp('first_seen');
    t.timestamp('last_seen');

    // The ONE allowed text snippet — paraphrased + redacted.
    t.text('example_phrasing_anonymized');
    t.string('redaction_confidence', 10); // high | medium | low

    // Eligibility audit summary for this cluster (counts only).
    t.jsonb('eligibility_summary').notNullable().defaultTo('{}');
    //   { records_seen: N, records_admitted: N, records_excluded: N,
    //     exclusion_reasons: { consent_missing: N, suppressed: N, … } }

    t.timestamp('mined_at').notNullable().defaultTo(knex.fn.now());
    t.timestamps(true, true);

    t.unique(['topic', 'city', 'service']);
    t.index('topic');
    t.index('last_seen');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('customer_insight_clusters');
};
