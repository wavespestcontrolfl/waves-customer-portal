/**
 * The SMS/MMS preview image's cached row (service_report_notification_assets)
 * stores an opaque input_hash that mixes stable identity (recordId, token,
 * render version, the photo-gate + photo-set signature) with ephemeral
 * build-time context (dynamicContext: weather, pressure trend) that isn't
 * meant to be reproduced at read time — recomputing the WHOLE hash on every
 * GET /preview.jpg would require re-fetching live weather on every image
 * request and would never match anyway. This column carries JUST the piece
 * the public read path (reports-public.js) can and must cheaply re-verify on
 * every read: whether GATE_REPORT_PHOTO_CONTENT and the visit's photo set
 * still match what the stored image was built from (owner pre-push P1,
 * 2026-09-28) — a gate flip or a photo-set change must not keep serving a
 * preview built under the other state.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('service_report_notification_assets', 'photo_content_signature')) return;
  await knex.schema.alterTable('service_report_notification_assets', (t) => {
    t.text('photo_content_signature');
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('service_report_notification_assets', 'photo_content_signature'))) return;
  await knex.schema.alterTable('service_report_notification_assets', (t) => {
    t.dropColumn('photo_content_signature');
  });
};
