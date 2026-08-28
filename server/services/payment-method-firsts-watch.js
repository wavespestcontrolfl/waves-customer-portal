/**
 * Payment-method guard "firsts" watch (owner request 2026-08-28, after
 * #3556 shipped and both gates flipped).
 *
 * Three one-time events prove the lane works in the field; the owner wants
 * an ops email the first time each one happens instead of grepping:
 *   1. the first portal removal REFUSED by the guard (409 autopay_method_in_use
 *      — the DELETE route logs `removal_refused` to autopay_log for this),
 *   2. the first payment.autopay_disabled customer email attempt,
 *   3. the first payment.method_removed customer email attempt
 *      (both recorded by payment-lifecycle-email as customer_interactions
 *      email_outbound rows carrying template_key + status in metadata).
 *
 * Each first is reported ONCE: the send is stamped in ops_email_send_state
 * (the repo's durable ops-email marker — same table every digest/watcher
 * uses; key `pm-guard-first:<name>`), so a restart or a deploy overlap can
 * never re-send, and once all three are stamped the tick no-ops — the
 * watch retires itself. Read-only on the watched tables;
 * sends no customer-facing communications (ops inbox only).
 *
 * Kill switch: PM_GUARD_FIRSTS_WATCH=off (same convention as
 * EMAIL_BOUNCE_RECOVERY — default on, `off` disables). Also inert while
 * GATE_CRON_JOBS is off, like every other cron.
 */
const db = require('../models/db');
const logger = require('./logger');

const OPS_TO = 'contact@wavespestcontrol.com';
// ops_email_send_state.email_key is varchar(60); longest key here is 35 chars.
const MARKER_PREFIX = 'pm-guard-first:';

const FIRSTS = [
  {
    name: 'removal_refused',
    label: 'First portal removal refused by the Auto Pay guard (409 autopay_method_in_use)',
    async find() {
      const row = await db('autopay_log')
        .where({ event_type: 'removal_refused' })
        .orderBy('created_at', 'asc')
        .first('customer_id', 'payment_method_id', 'details', 'created_at');
      if (!row) return null;
      const details = parseJson(row.details);
      return {
        at: row.created_at,
        lines: [
          `customer_id: ${row.customer_id}`,
          `payment_method_id: ${row.payment_method_id || '—'}`,
          `paused: ${details.paused === true ? 'yes' : 'no'}`,
          `source: ${details.source || 'portal_delete'}`,
        ],
      };
    },
  },
  {
    name: 'autopay_disabled_email',
    label: 'First payment.autopay_disabled customer email',
    find: () => firstLifecycleEmail('payment.autopay_disabled'),
  },
  {
    name: 'method_removed_email',
    label: 'First payment.method_removed customer email',
    find: () => firstLifecycleEmail('payment.method_removed'),
  },
];

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

async function firstLifecycleEmail(templateKey) {
  const row = await db('customer_interactions')
    .where({ interaction_type: 'email_outbound' })
    .whereRaw("(metadata::jsonb)->>'template_key' = ?", [templateKey])
    .orderBy('created_at', 'asc')
    .first('customer_id', 'metadata', 'created_at');
  if (!row) return null;
  const meta = parseJson(row.metadata);
  return {
    at: row.created_at,
    lines: [
      `customer_id: ${row.customer_id}`,
      `status: ${meta.status || 'unknown'}${meta.failure_reason ? ` (${meta.failure_reason})` : ''}`,
      `payment_method_id: ${meta.payment_method_id || '—'}`,
      `provider_message_id: ${meta.provider_message_id || '—'}`,
    ],
  };
}

function markerKey(name) {
  return `${MARKER_PREFIX}${name}`;
}

async function loadMarkers() {
  const rows = await db('ops_email_send_state')
    .whereIn('email_key', FIRSTS.map((f) => markerKey(f.name)))
    .whereNotNull('last_sent_at')
    .select('email_key');
  return new Set(rows.map((r) => r.email_key));
}

// Same upsert shape as promised-estimate-watcher / turf-variance-digest.
async function stampMarker(name) {
  const now = new Date();
  await db('ops_email_send_state')
    .insert({ email_key: markerKey(name), last_sent_at: now, updated_at: now })
    .onConflict('email_key')
    .merge({ last_sent_at: now, updated_at: now });
}

function isOff() {
  return String(process.env.PM_GUARD_FIRSTS_WATCH || '').toLowerCase() === 'off';
}

/**
 * One tick. Returns { skipped } | { retired: true } | { reported: [names] }.
 * Exclusive-run + failure logging live in the scheduler, like every canary.
 */
async function runPaymentMethodFirstsWatch() {
  if (isOff()) return { skipped: true, reason: 'kill_switch' };

  const reported = await loadMarkers();
  const pending = FIRSTS.filter((f) => !reported.has(markerKey(f.name)));
  if (pending.length === 0) return { retired: true };

  const sent = [];
  for (const first of pending) {
    let hit;
    try {
      hit = await first.find();
    } catch (err) {
      // One broken read must not block the other firsts; the next tick retries.
      logger.error(`[pm-guard-firsts] read failed for ${first.name}: ${err.message}`);
      continue;
    }
    if (!hit) continue;

    const when = new Date(hit.at).toLocaleString('en-US', { timeZone: 'America/New_York' });
    const res = await require('./email').send({
      to: OPS_TO,
      subject: `FIRST: ${first.label}`,
      heading: first.label,
      body: `Seen ${when} ET.<ul style="padding-left:20px;margin:12px 0;">${hit.lines.map((l) => `<li>${l}</li>`).join('')}</ul>`
        + 'This is a one-time notice from the #3556 payment-method guard watch; it will not repeat for this event. '
        + `Kill switch: PM_GUARD_FIRSTS_WATCH=off.`,
    });
    if (!res || res.ok === false) {
      // Never mark a first as reported when the email did not go out —
      // an undelivered notice is the one way this watch could lose the
      // signal it exists to deliver. The next tick retries.
      logger.error(`[pm-guard-firsts] ops email for ${first.name} did not send${res?.error ? `: ${res.error}` : ''}`);
      continue;
    }
    await stampMarker(first.name);
    sent.push(first.name);
    logger.info(`[pm-guard-firsts] reported ${first.name} (seen ${new Date(hit.at).toISOString()})`);
  }
  return { reported: sent };
}

module.exports = { runPaymentMethodFirstsWatch, FIRSTS, MARKER_PREFIX, OPS_TO };
