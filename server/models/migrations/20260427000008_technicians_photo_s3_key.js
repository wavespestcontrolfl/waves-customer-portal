/**
 * Add technicians.photo_s3_key for the canonical S3 reference of a
 * tech's profile photo. The existing technicians.photo_url stays as
 * a stable public URL pointing to a same-origin proxy
 * (GET /api/public/tech-photo/:technicianId) so:
 *   - Customer tracker (track-public.js) and document renderers
 *     (documents.js) keep using photo_url verbatim — no read-site
 *     changes needed.
 *   - The proxy 302-redirects to a freshly presigned S3 URL on
 *     every request, so the bucket can stay private.
 *   - photo_url is stable (no expiry baked into the row) — re-uploading
 *     a new photo updates photo_s3_key in place; photo_url doesn't
 *     have to change.
 *
 * Nullable: old technicians don't have an S3-managed photo. They
 * may still have a photo_url pointing at an external image (e.g.,
 * Google Business profile) — those keep working.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('technicians', 'photo_s3_key'))) {
    await knex.schema.alterTable('technicians', (t) => {
      t.string('photo_s3_key', 500);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('technicians', 'photo_s3_key')) {
    await knex.schema.alterTable('technicians', (t) => {
      t.dropColumn('photo_s3_key');
    });
  }
};
