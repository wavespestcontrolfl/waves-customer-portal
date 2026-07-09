/**
 * Partial unique index on blog_posts slug (blog-engine audit, queue/state
 * lane).
 *
 * Slug dedupe was entirely in-memory read-then-insert (blog-writer), and
 * the manual publish lane's existing-file SHA pass makes a same-slug
 * second publish silently REPLACE the first post's Astro file. This is
 * the DB backstop: two ACTIVE rows can never share a slug; a racing
 * insert surfaces as a unique violation (fail closed) instead of a
 * silent overwrite.
 *
 * Scope decisions:
 *   - lower(slug): the writer dedupes case-insensitively and slugify()
 *     lowercases, so case variants are the same URL namespace.
 *   - WHERE status <> 'archived': the archive flow keeps the DB row but
 *     removes the Astro file, so an archived slug is legitimately
 *     reusable by a new post. (Restoring an archived post whose slug was
 *     since reused fails the index — correct: two live posts on one slug
 *     is the disaster this exists to prevent.)
 *   - Verified against prod 2026-07-03: 0 duplicate non-archived slugs,
 *     0 NULL slugs (526 rows, 283 archived) — the index applies cleanly.
 */
exports.up = async function (knex) {
  // Pre-check with an actionable error: if any environment does hold
  // duplicates, name them instead of failing with a bare 23505.
  const dupes = await knex.raw(`
    SELECT lower(slug) AS slug_lc, count(*) AS n
    FROM blog_posts
    WHERE slug IS NOT NULL AND status IS DISTINCT FROM 'archived'
    GROUP BY lower(slug) HAVING count(*) > 1
  `);
  if (dupes.rows.length > 0) {
    const list = dupes.rows.map((r) => `${r.slug_lc} (x${r.n})`).join(', ');
    throw new Error(
      `blog_posts has duplicate non-archived slugs — resolve before this migration can add the unique index: ${list}`
    );
  }
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS blog_posts_slug_unique_active
      ON blog_posts (lower(slug))
      WHERE slug IS NOT NULL AND status IS DISTINCT FROM 'archived'
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS blog_posts_slug_unique_active`);
};
