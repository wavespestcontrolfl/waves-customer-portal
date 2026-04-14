/**
 * Migration 007 — Lawn Assessment Photos + Knowledge Bridge
 *
 * 1. lawn_assessment_photos — S3-backed photo storage with per-photo AI scores
 * 2. knowledge_bridge — cross-links knowledge_base (Claudeopedia) ↔ knowledge_entries (Agronomic Wiki)
 * 3. Add best_photo_id to lawn_assessments for customer portal hero image
 * 4. Add photo_url fields to treatment_outcomes for before/after
 */

exports.up = async function (knex) {

  // ── Lawn Assessment Photos ──────────────────────────────────
  if (!(await knex.schema.hasTable('lawn_assessment_photos'))) {
    await knex.schema.createTable('lawn_assessment_photos', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('assessment_id').notNullable().references('id').inTable('lawn_assessments').onDelete('CASCADE');
      t.uuid('customer_id').notNullable();

      // S3 storage
      t.string('s3_key', 500).notNullable();
      t.string('filename', 300);
      t.string('mime_type', 50).defaultTo('image/jpeg');
      t.integer('file_size_bytes');

      // Photo metadata
      t.string('photo_type', 30).defaultTo('general'); // general, front_yard, back_yard, side_yard, trouble_spot
      t.string('zone', 50); // optional zone/area label
      t.integer('photo_order').defaultTo(0);

      // Per-photo AI scores (raw composite before averaging)
      t.integer('turf_density');
      t.integer('weed_coverage');
      t.decimal('color_health', 3, 1);
      t.string('fungal_activity', 20);
      t.string('thatch_visibility', 20);
      t.text('observations');

      // Quality score for selecting "best" photo
      t.integer('quality_score').defaultTo(50); // 0-100, computed from sharpness + coverage + lighting

      // Customer-visible flag
      t.boolean('customer_visible').defaultTo(true);
      t.boolean('is_best_photo').defaultTo(false);

      t.timestamp('taken_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.index(['assessment_id']);
      t.index(['customer_id', 'created_at']);
      t.index(['customer_id', 'is_best_photo']);
    });
  }

  // ── Add best_photo_id to lawn_assessments ───────────────────
  if (await knex.schema.hasTable('lawn_assessments')) {
    if (!(await knex.schema.hasColumn('lawn_assessments', 'best_photo_id'))) {
      await knex.schema.alterTable('lawn_assessments', t => {
        t.uuid('best_photo_id');
        t.integer('overall_score'); // weighted composite 0-100
        t.text('ai_summary'); // one-liner customer-safe summary
        t.text('recommendations'); // AI recommendations from wiki context
      });
    }
  }

  // ── Add photo refs to treatment_outcomes ─────────────────────
  if (await knex.schema.hasTable('treatment_outcomes')) {
    if (!(await knex.schema.hasColumn('treatment_outcomes', 'pre_best_photo_key'))) {
      await knex.schema.alterTable('treatment_outcomes', t => {
        t.string('pre_best_photo_key', 500);
        t.string('post_best_photo_key', 500);
      });
    }
  }

  // ── Knowledge Bridge ────────────────────────────────────────
  if (!(await knex.schema.hasTable('knowledge_bridge'))) {
    await knex.schema.createTable('knowledge_bridge', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // Claudeopedia side
      t.uuid('kb_entry_id').references('id').inTable('knowledge_base').onDelete('CASCADE');
      t.string('kb_slug', 200);

      // Agronomic Wiki side
      t.uuid('wiki_entry_id').references('id').inTable('knowledge_entries').onDelete('CASCADE');
      t.string('wiki_slug', 200);

      // Relationship type
      t.string('link_type', 50).notNullable();
      // Types: 'product_reference', 'condition_treatment', 'protocol_outcome',
      //        'seasonal_guide', 'cross_reference', 'data_enrichment'

      // Metadata
      t.decimal('relevance_score', 3, 2).defaultTo(0.5); // 0.00-1.00
      t.text('link_reason'); // why these are linked
      t.string('created_by', 50).defaultTo('system'); // system | manual | ai
      t.boolean('bidirectional').defaultTo(true);

      t.timestamps(true, true);

      t.unique(['kb_entry_id', 'wiki_entry_id', 'link_type']);
      t.index(['kb_entry_id']);
      t.index(['wiki_entry_id']);
      t.index(['link_type']);
    });
  }

  // ── Add wiki_entry_id to knowledge_base for direct mapping ──
  if (await knex.schema.hasTable('knowledge_base')) {
    if (!(await knex.schema.hasColumn('knowledge_base', 'wiki_entry_id'))) {
      await knex.schema.alterTable('knowledge_base', t => {
        t.uuid('wiki_entry_id');
      });
    }
  }

  // ── Add kb_entry_id to knowledge_entries for reverse mapping ─
  if (await knex.schema.hasTable('knowledge_entries')) {
    if (!(await knex.schema.hasColumn('knowledge_entries', 'kb_entry_id'))) {
      await knex.schema.alterTable('knowledge_entries', t => {
        t.uuid('kb_entry_id');
      });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('knowledge_bridge');
  await knex.schema.dropTableIfExists('lawn_assessment_photos');

  if (await knex.schema.hasTable('lawn_assessments')) {
    for (const col of ['best_photo_id', 'overall_score', 'ai_summary', 'recommendations']) {
      if (await knex.schema.hasColumn('lawn_assessments', col)) {
        await knex.schema.alterTable('lawn_assessments', t => t.dropColumn(col));
      }
    }
  }

  if (await knex.schema.hasTable('treatment_outcomes')) {
    for (const col of ['pre_best_photo_key', 'post_best_photo_key']) {
      if (await knex.schema.hasColumn('treatment_outcomes', col)) {
        await knex.schema.alterTable('treatment_outcomes', t => t.dropColumn(col));
      }
    }
  }

  if (await knex.schema.hasTable('knowledge_base')) {
    if (await knex.schema.hasColumn('knowledge_base', 'wiki_entry_id')) {
      await knex.schema.alterTable('knowledge_base', t => t.dropColumn('wiki_entry_id'));
    }
  }

  if (await knex.schema.hasTable('knowledge_entries')) {
    if (await knex.schema.hasColumn('knowledge_entries', 'kb_entry_id')) {
      await knex.schema.alterTable('knowledge_entries', t => t.dropColumn('kb_entry_id'));
    }
  }
};
