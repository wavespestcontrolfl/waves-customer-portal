/**
 * purchase-receipts/failed-lines-alert.js — the one standing alert for receipt
 * lines the sweep tried to apply and could not.
 *
 * A line that throws (sweep.js recordLineOutcome) rolls back whole: no
 * purchase_receipt_lines row, no stock. The next sweep retries it, but only
 * while its email is inside SWEEP_LOOKBACK_MS (7 days). After that nothing
 * reads it again, and job_health says "success" because the run itself worked.
 * So the failure has no row to find; this alert's own metadata (`failedLines`)
 * is the record, and it carries a line past the 7-day window.
 *
 * An email the sweep could not read at all (a SiteOne invoice read that threw
 * before any line was attempted) is carried the same way, as one entry keyed
 * `email|<vendor>|<email id>`.
 *
 * Each run: this run's failures + the open alert's carried entries. An entry
 * drops ONLY on positive evidence: this run recorded an outcome for that exact
 * key without throwing (`settled`: applied, held, or skipped by a known rule;
 * for an email, it was read), or purchase_receipt_lines already holds a row for
 * it (checked for every entry, after both vendors ran, so a second copy that
 * recorded the same key later in the sweep never lands in the alert). Not
 * attempting an entry is not evidence. Nothing left closes the alert
 * (count_zero). The row refreshes quietly while the set is the same and rings
 * only when a NEW entry joins it. Staff marking it Done keeps it done until a
 * new entry fails. Every open key stays in metadata (about 250 bytes each, no
 * cap); only the listed detail is cut to SHOWN.
 *
 * docs/admin-notifications.md, "Receipt lines that failed".
 */
const db = require('../../models/db');
const { composeAdminAlert, cutAtWord } = require('../admin-alert-compose');
const { formatETDate } = require('../../utils/datetime-et');
const { scrubSentryText } = require('../../utils/sentry-scrub');

const DEDUPE_KEY = 'purchase-receipt-failed-lines';
const INVENTORY_LINK = '/admin/inventory?tab=products';
const SHOWN = 5;
const ROW_CHECK_CHUNK = 200;
const ROW_COLUMNS = ['vendor', 'order_number', 'shipment_key', 'line_no'];
const VENDOR_NAMES = { amazon: 'Amazon', siteone: 'SiteOne' };

const plural = (n) => (n === 1 ? '' : 's');
const lineKey = ({ vendor, orderNumber, shipmentKey, lineNo }) => [vendor, orderNumber || 'unknown', shipmentKey, lineNo].join('|');
const emailKey = (vendor, emailId) => `email|${vendor}|${emailId}`;

// What the sweep records for a failed line (sweep.js recordLineOutcome). The
// reason is the thrown message with emails, quoted SQL, amounts and numbers masked.
function failedLineEntry({ receipt, email, orderNumber, shipmentKey, lineNo, item, err }) {
  const entry = { vendor: receipt.vendor, orderNumber: orderNumber || 'unknown', shipmentKey, lineNo };
  return {
    ...entry, key: lineKey(entry), title: cutAtWord(String(item.title || '').trim(), 80),
    reason: cutAtWord(scrubSentryText(String(err.message || err).split('\n')[0]), 100),
    receivedAt: new Date(email.received_at).toISOString(),
  };
}

// An invoice email the sweep could not read (siteone-invoices read threw before any line was attempted).
function failedEmailEntry({ vendor, email }) {
  return { kind: 'email', key: emailKey(vendor, email.id), vendor, emailId: email.id, receivedAt: new Date(email.received_at).toISOString() };
}

// Keys that already have a purchase_receipt_lines row: a line by its table key, an email by any row it wrote.
async function recordedKeys(entries, conn) {
  const recorded = new Set();
  const lines = entries.filter((entry) => entry.kind !== 'email');
  for (let i = 0; i < lines.length; i += ROW_CHECK_CHUNK) {
    const chunk = lines.slice(i, i + ROW_CHECK_CHUNK);
    const rows = await conn('purchase_receipt_lines')
      .whereIn(ROW_COLUMNS, chunk.map((e) => [e.vendor, e.orderNumber, e.shipmentKey, e.lineNo])).select(ROW_COLUMNS);
    for (const row of rows) {
      recorded.add(lineKey({ vendor: row.vendor, orderNumber: row.order_number, shipmentKey: row.shipment_key, lineNo: row.line_no }));
    }
  }
  const emails = entries.filter((entry) => entry.kind === 'email');
  if (emails.length) {
    const rows = await conn('purchase_receipt_lines').whereIn('email_id', emails.map((e) => e.emailId)).select('vendor', 'email_id');
    for (const row of rows) recorded.add(emailKey(row.vendor, row.email_id));
  }
  return recorded;
}

// This run's failures plus the open alert's carried entries, minus those with positive evidence, oldest first.
async function openFailedLines({ failed, settled, prior, conn }) {
  const settledKeys = new Set(settled.map((entry) => entry.key));
  const merged = new Map();
  for (const entry of [...prior, ...failed]) merged.set(entry.key, entry);
  // A key this run failed AND settled (two copies of one invoice) is judged by its row alone.
  const failedKeys = new Set(failed.map((entry) => entry.key));
  const candidates = [...merged.values()].filter((entry) => failedKeys.has(entry.key) || !settledKeys.has(entry.key));
  const recorded = await recordedKeys(candidates, conn);
  return candidates.filter((entry) => !recorded.has(entry.key))
    .sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)) || a.key.localeCompare(b.key));
}

function describe(entry) {
  const vendor = VENDOR_NAMES[entry.vendor] || entry.vendor;
  const date = formatETDate(new Date(entry.receivedAt));
  if (entry.kind === 'email') return `- invoice email could not be read: ${vendor} ${date}`;
  return `- ${vendor}, ${date}: "${entry.title}" - ${entry.reason}`;
}

function composeFailedLinesAlert(open) {
  const count = open.length;
  const alert = composeAdminAlert({
    area: 'Inventory', action: `check ${count} failed receipt item${plural(count)}`,
    why: 'Their stock was not added; log it by hand if it is stock.',
    severity: 'needs-you', who: 'person', link: INVENTORY_LINK,
    subject: { type: 'check', id: DEDUPE_KEY }, doneWhen: 'count_zero',
  });
  const detail = [
    `${count} receipt item${plural(count)} failed and ${count === 1 ? 'was' : 'were'} not added to stock. The sweep retries a line for 7 days after its email; after that nothing retries it, so log it by hand if it is stock.`,
    '',
    ...open.slice(0, SHOWN).map(describe),
    ...(count > SHOWN ? [`and ${count - SHOWN} more`] : []),
  ].join('\n');
  return { alert, detail };
}

// A refresh rings only when a line joins the set that the standing row did not hold.
function ringOnNewLine(keys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return keys.some((key) => !prior.has(key));
  };
}

/**
 * @param {{failed: object[], settled: {key: string}[]}} params failed: this run's failedLines bucket;
 *   settled: keys this run recorded an outcome for without throwing
 * @returns {Promise<number>} entries still unapplied
 */
async function reconcileFailedLineAlert({ failed = [], settled = [] }, conn = db) {
  const episodes = require('../admin-alert-episodes');
  const prior = (await episodes.openAdminAlertMetadata(conn, DEDUPE_KEY))
    .flatMap((meta) => (Array.isArray(meta.failedLines) ? meta.failedLines : []));
  if (!failed.length && !prior.length) return 0;
  const open = await openFailedLines({ failed, settled, prior, conn });
  if (!open.length) {
    if (!prior.length) return 0;
    await conn.transaction((trx) => episodes.closeAdminAlertKeys(trx, [DEDUPE_KEY], 'count_zero', {
      resolution: 'Cleared: every receipt line that failed has since been applied',
    }));
    return 0;
  }
  const { alert, detail } = composeFailedLinesAlert(open);
  const keys = open.map((entry) => entry.key);
  await episodes.raiseAdminAlertWithReopen('inventory', alert.headline, alert.why, {
    dedupeKey: DEDUPE_KEY,
    bell: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewLine(keys),
    bumpOnRefresh: true,
    detail,
    link: alert.link,
    metadata: { ...alert.metadata, failedLines: open, itemKeys: keys, count: open.length },
  });
  return open.length;
}

module.exports = { reconcileFailedLineAlert, failedLineEntry, failedEmailEntry, lineKey, emailKey, DEDUPE_KEY, SHOWN };
