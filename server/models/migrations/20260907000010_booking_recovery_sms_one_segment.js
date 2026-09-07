/**
 * Booking-recovery SMS → one segment (owner, 2026-09-07).
 *
 * The abandoned-booking recovery text rendered at 224–252 GSM-7 characters
 * (two segments) with the branded short link. Multi-segment texts have
 * failed to deliver on some carriers, so the owner asked for a single
 * segment (≤160). The link already goes out without `https://` — the SMS
 * renderer strips the scheme from portal hosts (admin-sms-templates.js
 * stripPortalUrlScheme) — so the budget is copy alone.
 *
 * What changed in the copy: the "Reply here with any questions." line is
 * dropped; the STOP disclosure stays — this is a lead first-contact template,
 * which the 2026-08-10 sweep deliberately kept it on. With the short link
 * (`portal.wavespestcontrol.com/l/xxxx`) every service label except the
 * former 32-character Bora-Care one lands under 160; that label is shortened
 * in the service (SERVICE_LABELS) in the same change.
 *
 * ADMIN-EDIT SAFETY: same predicate guard as the 2026-08-01 sweep — the
 * UPDATE matches the exact audited body, so a row edited by hand in /admin
 * since is skipped, never clobbered. `down` reverts only a row still
 * carrying exactly what this migration wrote.
 */

const TEMPLATE_KEY = 'booking_abandonment_recovery';
const EXPECTED = "Hello {first_name}! You were almost booked with Waves for {service_type} - your spot isn't reserved yet. Pick a time and you're all set: {booking_url}\n\nReply here with any questions.\n\nReply STOP to opt out.";
const NEXT = "{first_name}, your Waves {service_type} spot isn't reserved yet. Pick a time and you're set: {booking_url}\nReply STOP to opt out.";

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.body) return;
  const patch = { body: NEXT };
  if (cols.updated_at) patch.updated_at = new Date();
  const matched = await knex('sms_templates').where({ template_key: TEMPLATE_KEY, body: EXPECTED }).update(patch);
  console.log(`[booking-recovery-sms] ${matched ? 'rewrote' : 'SKIPPED (edited by hand or missing)'} ${TEMPLATE_KEY}`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.body) return;
  const patch = { body: EXPECTED };
  if (cols.updated_at) patch.updated_at = new Date();
  await knex('sms_templates').where({ template_key: TEMPLATE_KEY, body: NEXT }).update(patch);
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.EXPECTED = EXPECTED;
exports.NEXT = NEXT;
