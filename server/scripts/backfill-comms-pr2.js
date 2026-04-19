/**
 * PR 2 backfill — historical sms_log + call_log → conversations + messages.
 *
 * Idempotent on (channel, twilio_sid). Safe to re-run.
 * Run:  node server/scripts/backfill-comms-pr2.js
 *       node server/scripts/backfill-comms-pr2.js --dry-run
 *       node server/scripts/backfill-comms-pr2.js --table sms
 *       node server/scripts/backfill-comms-pr2.js --table voice
 *
 * Strategy
 * - Walk each legacy row in created_at order so created_at on messages
 *   stays monotonic per thread.
 * - Resolve (customer_id, channel, our_endpoint) — outbound: from is ours;
 *   inbound: to is ours.
 * - Find-or-create conversation (uses the same partial-unique dedup
 *   indexes the live dual-write relies on).
 * - INSERT messages with the legacy row's created_at preserved.
 * - Skip if twilio_sid already exists in messages for this channel
 *   (PR 1's dual-write writes inbound rows from 2026-04-18 onward, and
 *   re-runs of this script must not double up).
 *
 * What's intentionally NOT in scope
 * - emails table — has no twilio_sid, lives on a separate Gmail-sync flow
 *   (EmailPage), and the strategy doc parks email cutover for PR 5
 *   alongside the Beehiiv/newsletter intake. Schema is ready when needed.
 * - sms_log rows with status='scheduled' — those are queue rows, not
 *   message history. Cron still picks them up from sms_log.
 * - call_log processing fields (processing_status, ai_extraction,
 *   classification, recording_url) — these are async-job state, not
 *   customer-visible messages. Recording url + duration are migrated
 *   into messages.media; the rest stays on call_log for the recordings
 *   admin page.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require('../models/db');

const DRY_RUN = process.argv.includes('--dry-run');
const TABLE_FILTER = (() => {
  const i = process.argv.indexOf('--table');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const BATCH_SIZE = 500;

function logProgress(label, n, total) {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0;
  process.stdout.write(`\r  ${label}: ${n}/${total} (${pct}%)`);
}

async function findOrCreateThread({ customerId, channel, ourEndpointId, contactPhone }) {
  if (customerId) {
    const existing = await db('conversations')
      .where({ customer_id: customerId, channel, our_endpoint_id: ourEndpointId || null })
      .first();
    if (existing) return existing;
    const [row] = await db('conversations').insert({
      customer_id: customerId, channel,
      our_endpoint_id: ourEndpointId || null, unknown_contact: false,
    }).returning('*');
    return row;
  }
  if (contactPhone) {
    const existing = await db('conversations')
      .where({ contact_phone: contactPhone, channel, our_endpoint_id: ourEndpointId || null })
      .whereNull('customer_id')
      .first();
    if (existing) return existing;
    const [row] = await db('conversations').insert({
      channel, our_endpoint_id: ourEndpointId || null,
      contact_phone: contactPhone, unknown_contact: true,
    }).returning('*');
    return row;
  }
  return null; // unparseable row — skip
}

async function backfillSms() {
  const total = await db('sms_log')
    .whereNot('status', 'scheduled')
    .count('* as c').first();
  const totalCount = parseInt(total.c);
  console.log(`\n[sms_log] candidates: ${totalCount}`);
  if (DRY_RUN) { console.log('  (dry-run — no writes)'); return { inserted: 0, skipped: 0, unparseable: 0 }; }

  let offset = 0, inserted = 0, skipped = 0, unparseable = 0;
  while (true) {
    const batch = await db('sms_log')
      .whereNot('status', 'scheduled')
      .orderBy('created_at', 'asc')
      .limit(BATCH_SIZE).offset(offset);
    if (batch.length === 0) break;

    for (const row of batch) {
      // Direction-aware endpoint/contact resolution.
      const ourEndpoint = row.direction === 'inbound' ? row.to_phone : row.from_phone;
      const contact = row.direction === 'inbound' ? row.from_phone : row.to_phone;

      // Dedup on twilio_sid per channel.
      if (row.twilio_sid) {
        const exists = await db('messages')
          .where({ channel: 'sms', twilio_sid: row.twilio_sid })
          .first();
        if (exists) { skipped++; continue; }
      }

      const thread = await findOrCreateThread({
        customerId: row.customer_id || null,
        channel: 'sms',
        ourEndpointId: ourEndpoint || null,
        contactPhone: row.customer_id ? null : contact,
      });
      if (!thread) { unparseable++; continue; }

      await db('messages').insert({
        conversation_id: thread.id,
        channel: 'sms',
        direction: row.direction,
        body: row.message_body || null,
        author_type: row.direction === 'inbound'
          ? 'customer'
          : (row.admin_user_id ? 'admin' : 'system'),
        admin_user_id: row.admin_user_id || null,
        twilio_sid: row.twilio_sid || null,
        delivery_status: row.status || null,
        message_type: row.message_type || null,
        is_read: row.is_read === true,
        created_at: row.created_at,
      });

      // Bump conversation rollup so the inbox sort order matches reality.
      const updates = {
        last_message_at: row.created_at,
        message_count: db.raw('message_count + 1'),
        updated_at: new Date(),
      };
      if (row.direction === 'inbound') updates.last_inbound_at = row.created_at;
      await db('conversations').where({ id: thread.id }).update(updates);

      inserted++;
    }
    offset += batch.length;
    logProgress('sms', offset, totalCount);
  }
  process.stdout.write('\n');
  return { inserted, skipped, unparseable };
}

async function backfillVoice() {
  const total = await db('call_log').count('* as c').first();
  const totalCount = parseInt(total.c);
  console.log(`\n[call_log] candidates: ${totalCount}`);
  if (DRY_RUN) { console.log('  (dry-run — no writes)'); return { inserted: 0, skipped: 0, unparseable: 0 }; }

  let offset = 0, inserted = 0, skipped = 0, unparseable = 0;
  while (true) {
    const batch = await db('call_log')
      .orderBy('created_at', 'asc')
      .limit(BATCH_SIZE).offset(offset);
    if (batch.length === 0) break;

    for (const row of batch) {
      const ourEndpoint = row.direction === 'inbound' ? row.to_phone : row.from_phone;
      const contact = row.direction === 'inbound' ? row.from_phone : row.to_phone;

      if (row.twilio_call_sid) {
        const exists = await db('messages')
          .where({ channel: 'voice', twilio_sid: row.twilio_call_sid })
          .first();
        if (exists) { skipped++; continue; }
      }

      const thread = await findOrCreateThread({
        customerId: row.customer_id || null,
        channel: 'voice',
        ourEndpointId: ourEndpoint || null,
        contactPhone: row.customer_id ? null : contact,
      });
      if (!thread) { unparseable++; continue; }

      // Recording → media JSON (the unified schema's preferred home).
      const media = [];
      if (row.recording_url) {
        media.push({
          type: 'recording',
          url: row.recording_url,
          sid: row.recording_sid || null,
          duration_seconds: row.recording_duration_seconds || row.duration_seconds || null,
        });
      }

      await db('messages').insert({
        conversation_id: thread.id,
        channel: 'voice',
        direction: row.direction,
        body: row.transcription || null,
        ai_summary: row.call_summary || null,
        media: JSON.stringify(media),
        author_type: row.direction === 'inbound' ? 'customer' : 'admin',
        twilio_sid: row.twilio_call_sid || null,
        recording_sid: row.recording_sid || null,
        duration_seconds: row.duration_seconds || null,
        answered_by: row.answered_by || null,
        delivery_status: row.status || null,
        is_read: false,
        created_at: row.created_at,
      });

      const updates = {
        last_message_at: row.created_at,
        message_count: db.raw('message_count + 1'),
        updated_at: new Date(),
      };
      if (row.direction === 'inbound') updates.last_inbound_at = row.created_at;
      await db('conversations').where({ id: thread.id }).update(updates);

      inserted++;
    }
    offset += batch.length;
    logProgress('voice', offset, totalCount);
  }
  process.stdout.write('\n');
  return { inserted, skipped, unparseable };
}

(async () => {
  console.log(`PR 2 backfill ${DRY_RUN ? '(dry-run)' : ''} — sms_log + call_log → messages`);
  if (TABLE_FILTER) console.log(`  filter: --table ${TABLE_FILTER}`);

  const results = {};
  if (!TABLE_FILTER || TABLE_FILTER === 'sms') results.sms = await backfillSms();
  if (!TABLE_FILTER || TABLE_FILTER === 'voice') results.voice = await backfillVoice();

  console.log('\nSummary');
  console.log(JSON.stringify(results, null, 2));

  await db.destroy();
})().catch(async (err) => {
  console.error('\nbackfill failed:', err);
  await db.destroy();
  process.exit(1);
});
