/**
 * Durable "was this promise-chaser dedupeKey ever successfully delivered"
 * fact for promise-chaser-bell.js's sweepPromiseChasers — NOT a claim/lease
 * table (no per-call ownership, no expiry, no retry bookkeeping): a plain
 * fact, same idea as sms_reply_alert_claims / missed_call_text_claims /
 * dropped_call_sms_claims / voicemail_sms_claims.
 *
 * Covers the one gap the notifications-table dedupe check can't: when
 * every admin has bell disabled (push-only), notifyAdmin never writes a
 * bell row at all, so that check has nothing to find and every 2-minute
 * sweep tick would re-dispatch. A matching push tag only silently replaces
 * a notification still showing on the device — once staff dismiss or open
 * it, the next push displays again (client/public/sw.js closes a clicked
 * notification, then shows the next push with the same tag unconditionally).
 *
 * `dedupe_key` is the PRIMARY KEY: an `INSERT ... ON CONFLICT DO NOTHING`
 * after ANY successful delivery (a bell written OR a push actually sent)
 * durably marks that promise+ET-day+renewal identity done, checked before
 * dispatch alongside (never instead of) the existing notifications check.
 * Rows are swept for housekeeping (delivered_at older than a few days —
 * dedupeKey already carries the ET day, so an old row can never match a
 * live key again) by the same sweep, gated the same way.
 */

exports.up = async function (knex) {
  if (await knex.schema.hasTable('promise_chaser_deliveries')) return;
  await knex.schema.createTable('promise_chaser_deliveries', (t) => {
    t.text('dedupe_key').primary();
    t.timestamp('delivered_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('promise_chaser_deliveries');
};
