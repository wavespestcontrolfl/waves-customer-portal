/**
 * Backfill lead_activities timeline rows from historical sms_log.
 *
 * Live logging (services/lead-activity-logger.js) only fires from the moment
 * the helper shipped — every SMS sent or received before that left the lead
 * detail page Activity Timeline blank. This walks sms_log in chronological
 * order and inserts the rows that should have been there.
 *
 * Idempotent on metadata->>'twilio_sid'. Safe to re-run; rows already
 * backfilled are skipped.
 *
 * Run:
 *   node server/scripts/backfill-lead-activities-from-sms.js --dry-run
 *   node server/scripts/backfill-lead-activities-from-sms.js
 *   node server/scripts/backfill-lead-activities-from-sms.js --since=2026-01-01
 *
 * Multiple leads per phone (e.g. recurring inbound from the same number)
 * are resolved by picking the lead whose created_at is the most recent at-
 * or-before the sms_log row's created_at. That way each SMS attaches to the
 * lead that was active when the message happened.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const db = require('../models/db');
const { toE164 } = require('../utils/phone');

const DRY_RUN = process.argv.includes('--dry-run');
const SINCE = (() => {
  const arg = process.argv.find((a) => a.startsWith('--since='));
  if (arg) return arg.split('=')[1];
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
})();

function classifyOutbound({ messageType, adminUserId }) {
  if (messageType === 'internal_alert' || messageType === 'lead_response') return null;
  if (adminUserId) return { activity_type: 'sms_sent', performer: 'manual_admin' };
  if (messageType === 'auto_reply') return { activity_type: 'sms_auto_reply', performer: 'system' };
  if (messageType === 'lead_outreach') return { activity_type: 'sms_auto_reply', performer: 'lead_response_agent' };
  return { activity_type: 'sms_sent', performer: 'system' };
}

async function findLeadAt(phone, atTimestamp) {
  const e164 = toE164(phone);
  if (!e164) return null;

  const all = await db('leads')
    .where({ phone: e164 })
    .orderBy('created_at', 'desc');
  if (all.length === 0) return null;
  // Single lead for this phone — attach unconditionally. Handles the
  // common race where lead-webhook fires the auto-reply a few ms before
  // the leads row commits (Fibi: SMS at 14:12:37.499, lead row at .541).
  if (all.length === 1) return all[0];
  // Multiple leads — pick the most recent one created at-or-before the
  // SMS, falling back to the very first lead if everything came after.
  const inWindow = all.find((l) => l.created_at <= atTimestamp);
  return inWindow || all[all.length - 1];
}

async function getTechnicianName(adminUserId, cache) {
  if (!adminUserId) return null;
  if (cache.has(adminUserId)) return cache.get(adminUserId);
  const tech = await db('technicians').where({ id: adminUserId }).first();
  const name = tech?.name || null;
  cache.set(adminUserId, name);
  return name;
}

async function main() {
  const tStart = Date.now();
  console.log(`[backfill] dry_run=${DRY_RUN} since=${SINCE}`);

  const rows = await db('sms_log')
    .whereIn('direction', ['inbound', 'outbound'])
    .andWhere('created_at', '>=', SINCE)
    .andWhereNot('status', 'scheduled')
    .orderBy('created_at', 'asc')
    .select('id', 'direction', 'from_phone', 'to_phone', 'message_body', 'twilio_sid',
            'message_type', 'admin_user_id', 'created_at');

  console.log(`[backfill] candidate sms_log rows: ${rows.length}`);

  const techCache = new Map();
  const counts = {
    inserted: 0, skipped_existing: 0, skipped_no_lead: 0,
    skipped_no_sid: 0, skipped_classified_out: 0,
  };

  for (const row of rows) {
    if (!row.twilio_sid) {
      counts.skipped_no_sid++;
      continue;
    }

    const counterpartyPhone = row.direction === 'inbound' ? row.from_phone : row.to_phone;
    const lead = await findLeadAt(counterpartyPhone, row.created_at);
    if (!lead) {
      counts.skipped_no_lead++;
      continue;
    }

    const existing = await db('lead_activities')
      .where({ lead_id: lead.id })
      .whereRaw(`metadata->>'twilio_sid' = ?`, [row.twilio_sid])
      .first();
    if (existing) {
      counts.skipped_existing++;
      continue;
    }

    let activity_type;
    let performed_by;
    let descriptionPrefix;

    if (row.direction === 'inbound') {
      activity_type = 'sms_received';
      performed_by = `${lead.first_name || 'Lead'} ${lead.last_name || ''}`.trim() || 'Lead';
      descriptionPrefix = 'Reply received';
    } else {
      const cls = classifyOutbound({
        messageType: row.message_type,
        adminUserId: row.admin_user_id,
      });
      if (!cls) {
        counts.skipped_classified_out++;
        continue;
      }
      activity_type = cls.activity_type;
      if (cls.performer === 'manual_admin') {
        performed_by = (await getTechnicianName(row.admin_user_id, techCache)) || 'Admin';
      } else if (cls.performer === 'lead_response_agent') {
        performed_by = 'Lead Response Agent';
      } else {
        performed_by = 'System';
      }
      descriptionPrefix = activity_type === 'sms_auto_reply' ? 'Auto-reply sent' : 'SMS sent';
    }

    const safeBody = row.message_body || '';
    const snippet = safeBody.slice(0, 100);
    const truncated = safeBody.length > 100 ? '…' : '';

    const payload = {
      lead_id: lead.id,
      activity_type,
      description: `${descriptionPrefix}: ${snippet}${truncated}`,
      performed_by,
      metadata: JSON.stringify({
        message_type: row.message_type || null,
        twilio_sid: row.twilio_sid,
        body: safeBody,
        backfilled: true,
        backfill_source: 'sms_log',
      }),
      created_at: row.created_at,
    };

    if (DRY_RUN) {
      console.log(`  [DRY] ${row.created_at.toISOString()} ${row.direction} ` +
        `lead=${lead.id.slice(0, 8)} type=${activity_type} by=${performed_by} ` +
        `"${snippet.slice(0, 50)}${snippet.length > 50 ? '…' : ''}"`);
    } else {
      await db('lead_activities').insert(payload);
    }
    counts.inserted++;
  }

  const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`\n[backfill] done in ${elapsed}s`);
  console.log(`  inserted:              ${counts.inserted}${DRY_RUN ? ' (dry-run, nothing written)' : ''}`);
  console.log(`  skipped (already had): ${counts.skipped_existing}`);
  console.log(`  skipped (no lead):     ${counts.skipped_no_lead}`);
  console.log(`  skipped (no sid):      ${counts.skipped_no_sid}`);
  console.log(`  skipped (classified):  ${counts.skipped_classified_out}`);

  await db.destroy();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
