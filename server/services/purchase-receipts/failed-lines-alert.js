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
 * Each run: this run's failures + the open alert's carried lines. A carried
 * line drops when (a) its email is still in the window and did not fail this
 * run (it was retried and applied, or no longer applies), or (b) a
 * purchase_receipt_lines row now exists for its key (a person or another lane
 * recorded it). Nothing left closes the alert (count_zero). The row refreshes
 * quietly while the set is the same and rings only when a NEW line joins it.
 * Staff marking the alert Done keeps it done until a new line fails.
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
const MAX_STORED = 200;
const VENDOR_NAMES = { amazon: 'Amazon', siteone: 'SiteOne' };

const plural = (n) => (n === 1 ? '' : 's');
const lineKey = ({ vendor, orderNumber, shipmentKey, lineNo }) => [vendor, orderNumber || 'unknown', shipmentKey, lineNo].join('|');

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

async function hasLineRow(entry, conn) {
  return Boolean(await conn('purchase_receipt_lines')
    .where({ vendor: entry.vendor, order_number: entry.orderNumber, shipment_key: entry.shipmentKey, line_no: entry.lineNo }).first('id'));
}

// The lines this run failed plus the open alert's lines still unapplied, oldest first.
async function openFailedLines({ failed, prior, floor, conn }) {
  const current = new Map(failed.map((entry) => [entry.key, entry]));
  const open = [...current.values()];
  for (const entry of prior) {
    if (current.has(entry.key) || open.some((kept) => kept.key === entry.key)) continue;
    // Inside the window the sweep retried it this run and it did not fail again.
    if (new Date(entry.receivedAt) >= floor) continue;
    if (!(await hasLineRow(entry, conn))) open.push(entry);
  }
  return open.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)) || a.key.localeCompare(b.key)).slice(0, MAX_STORED);
}

function describe(entry) {
  const vendor = VENDOR_NAMES[entry.vendor] || entry.vendor;
  return `- ${vendor}, ${formatETDate(new Date(entry.receivedAt))}: "${entry.title}" - ${entry.reason}`;
}

function composeFailedLinesAlert(open) {
  const count = open.length;
  const alert = composeAdminAlert({
    area: 'Inventory', action: `add ${count} failed receipt line${plural(count)} by hand`,
    why: 'These lines failed to apply, so their stock was not added.',
    severity: 'needs-you', who: 'person', link: INVENTORY_LINK,
    subject: { type: 'check', id: DEDUPE_KEY }, doneWhen: 'count_zero',
  });
  const detail = [
    `${count} receipt line${plural(count)} failed and ${count === 1 ? 'was' : 'were'} not added to stock. The sweep retries a line for 7 days after its email; after that nothing retries it, so log it by hand if it is stock.`,
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
 * @param {{failed: object[], floor: Date}} params failed: this run's failedLines bucket; floor: the sweep's lookback floor
 * @returns {Promise<number>} lines still unapplied
 */
async function reconcileFailedLineAlert({ failed = [], floor }, conn = db) {
  const episodes = require('../admin-alert-episodes');
  const prior = (await episodes.openAdminAlertMetadata(conn, DEDUPE_KEY))
    .flatMap((meta) => (Array.isArray(meta.failedLines) ? meta.failedLines : []));
  if (!failed.length && !prior.length) return 0;
  const open = await openFailedLines({ failed, prior, floor, conn });
  if (!open.length) {
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

module.exports = { reconcileFailedLineAlert, failedLineEntry, DEDUPE_KEY, SHOWN };
