/**
 * Add slug and indexability fields to newsletter_sends for the public
 * newsletter API and Astro archive pages.
 *
 * slug: URL-friendly identifier generated from subject + date.
 *   Used by /api/public/newsletter/posts/by-slug/:slug and the
 *   Astro /newsletter/archive/[slug] pages.
 *
 * indexability: controls whether the archive page should be indexed
 *   by search engines. Weekly event digests decay fast so they get
 *   'noindex' after 30 days; evergreen educational content stays 'index'.
 */

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

exports.up = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.string('slug', 128).nullable();
    table.string('indexability', 16).notNullable().defaultTo('index');
    table.unique(['slug']);
  });

  // Backfill slugs for existing sent rows
  const sent = await knex('newsletter_sends')
    .where({ status: 'sent' })
    .whereNotNull('sent_at')
    .select('id', 'subject', 'sent_at');

  for (const row of sent) {
    const datePart = row.sent_at
      ? new Date(row.sent_at).toISOString().slice(0, 10)
      : 'undated';
    const slug = `${slugify(row.subject || 'newsletter')}-${datePart}`;
    await knex('newsletter_sends')
      .where({ id: row.id })
      .update({ slug });
  }

  console.log(`[20260525000001] Backfilled ${sent.length} newsletter slugs`);
};

exports.down = async function (knex) {
  await knex.schema.alterTable('newsletter_sends', (table) => {
    table.dropUnique(['slug']);
    table.dropColumn('slug');
    table.dropColumn('indexability');
  });
};
