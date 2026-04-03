/**
 * Migration 034 — Blog Content Pipeline
 *
 * Tables:
 *  - blog_posts          (content calendar + WordPress-imported posts)
 *  - blog_voice_config   (voice/tone configuration for AI content generation)
 *  - ai_audits           (blog audit + other AI audit reports)
 */

exports.up = function (knex) {
  return knex.schema

    // ── Blog Posts ─────────────────────────────────────────────────
    .createTable('blog_posts', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.date('publish_date');
      t.string('title').notNullable();
      t.string('keyword');
      t.string('tag');       // Pest Control, Lawn Care, Rodents, etc.
      t.string('slug');
      t.text('meta_description');
      t.string('city');
      t.string('status').defaultTo('queued'); // queued, draft, wp_draft, scheduled, published, idea
      t.text('content');             // plain text / markdown content
      t.text('content_html');        // HTML content (from WordPress)
      t.string('wordpress_post_id'); // WP post ID once published
      t.integer('word_count');
      t.integer('seo_score');        // 0-100
      t.string('featured_image_url');
      t.string('source').defaultTo('calendar'); // calendar, wordpress_import, ai_generated, manual
      t.jsonb('optimization_suggestions'); // AI optimization suggestions
      t.timestamps(true, true);

      t.index('status');
      t.index('publish_date');
      t.index('tag');
      t.index('city');
    })

    // ── Blog Voice Config ─────────────────────────────────────────
    .createTable('blog_voice_config', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('name').defaultTo('default');
      t.text('voice_description');
      t.jsonb('sample_titles');
      t.jsonb('sample_metas');
      t.jsonb('tone_rules');
      t.jsonb('swfl_knowledge');
      t.boolean('active').defaultTo(true);
      t.timestamps(true, true);
    })

    // ── AI Audits (generic for blog, SEO, etc.) ───────────────────
    .createTable('ai_audits', t => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('audit_type'); // blog_content, seo, operations
      t.date('audit_date');
      t.jsonb('report_data');
      t.integer('recommendation_count').defaultTo(0);
      t.integer('critical_issues').defaultTo(0);
      t.string('status').defaultTo('completed');
      t.timestamps(true, true);
    })

    // ── Seed voice config ─────────────────────────────────────────
    .then(() => knex('blog_voice_config').insert({
      name: 'waves_default',
      voice_description: "You're the homeowner's smartest, slightly snarky neighbor who happens to know everything about pest control and lawn care in Southwest Florida. You're not selling — you're educating with personality. You use \"you\" and \"your\" constantly. You name the specific city. You reference SWFL conditions (sandy soil, afternoon storms, St. Augustine, nitrogen blackout). Your titles are provocative and curiosity-driven. Your meta descriptions have punch. Short paragraphs. Dashes. Real numbers. Active ingredient names, not brands. You end with a practical takeaway, not a sales pitch.",
      sample_titles: JSON.stringify([
        "Your Parrish Lawn Doesn't Need Micronutrients — It Needs You to Stop Skipping the Basics",
        "Seeing Roaches in the Daytime in Venice? Yeah, Your Problem Is Way Worse Than You Think",
        "The 'Just One Roach' Lie Every Parrish Homeowner Has Told Themselves at Least Once",
        "That Damp Spot Near Your Foundation? Termites Already Know About It",
        "How Rats Get Into Lakewood Ranch Attics (Spoiler: It's Embarrassingly Easy)",
        "Florida Rain Doesn't Kill Bugs — It Sends Them Straight Into Your Palmetto Living Room",
        "Overwatering Your Bradenton Lawn? Congrats — You Just Built a Fungus Factory",
      ]),
      sample_metas: JSON.stringify([
        "Those wings on your windowsill? Could be nothing. Could be termites. Here's how Port Charlotte homeowners tell the difference.",
        "Your Sarasota sprinklers don't know it's rainy season. Here's how to cut back without killing your turf.",
        "There's no such thing as 'just one roach' in Parrish. That solo sighting? It's the PR rep for a much bigger operation.",
      ]),
      tone_rules: JSON.stringify([
        "Write like a smart, snarky neighbor — not a corporate pest blog",
        "Use 'you' and 'your' constantly — address the reader directly",
        "City-specific — mention the city by name multiple times",
        "Reference SWFL-specific conditions: sandy soil, afternoon storms, St. Augustine grass, nitrogen blackout",
        "Titles: provocative, curiosity-driven, slightly confrontational",
        "Meta descriptions: punchy, 150-160 chars, with personality",
        "Short sentences. Paragraph breaks often. Dashes liberally.",
        "Include specific product names (active ingredients, not brands) and specific numbers",
        "End with a soft CTA — not 'CALL US NOW' but 'worth getting a professional eye on it'",
        "NEVER sound like a press release, brochure, or generic SEO content",
        "800-1200 words, H2 every 200-300 words, 1-2 pro tip callouts",
      ]),
      swfl_knowledge: JSON.stringify({
        grass_types: ['St. Augustine (Full Sun and Shade)', 'Bermuda', 'Zoysia', 'Bahia'],
        nitrogen_blackout: 'June 1 – September 30 in Sarasota and Manatee counties',
        common_pests: ['chinch bugs', 'ghost ants', 'German roaches', 'subterranean termites', 'whitefly', 'scale'],
        common_weeds: ['dollar weed', 'crabgrass', 'torpedo grass', 'doveweed', 'sedge'],
        soil: 'Sandy soil = low water-holding capacity, nutrients leach fast',
        weather: 'Daily afternoon thunderstorms June-September',
        service_areas: ['Bradenton', 'Lakewood Ranch', 'Parrish', 'Palmetto', 'Sarasota', 'Venice', 'North Port', 'Port Charlotte'],
      }),
      active: true,
    }));
};

exports.down = function (knex) {
  return knex.schema
    .dropTableIfExists('ai_audits')
    .dropTableIfExists('blog_voice_config')
    .dropTableIfExists('blog_posts');
};
