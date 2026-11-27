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
const VENDOR_NAMES = { amazon: 'Amazon', siteone: 'SiteOne' };

const plural = (n) => (n === 1 ? '' : 's');
const lineKey = ({ vendor, orderNumber, shipmentKey, lineNo }) => [vendor, orderNumber || 'unknown', shipmentKey, lineNo].join('|');
const normalizeTitle = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);
const emailKey = (vendor, emailId) => `email|${vendor}|${emailId}`;

// What the sweep records for a failed line (sweep.js recordLineOutcome). The
// reason is the thrown message with emails, quoted SQL, amounts and numbers masked.
function failedLineEntry({ receipt, email, orderNumber, shipmentKey, lineNo, item, err }) {
  const entry = { vendor: receipt.vendor, orderNumber: orderNumber || 'unknown', shipmentKey, lineNo };
  return {
    ...entry, key: lineKey(entry), title: cutAtWord(String(item.title || '').trim(), 80), titleKey: normalizeTitle(item.title), emailId: email.id,
    reason: cutAtWord(scrubSentryText(String(err.message || err).split('\n')[0]), 100),
    receivedAt: new Date(email.received_at).toISOString(),
  };
}

// An invoice email the sweep could not read (siteone-invoices read threw before any line was attempted).
function failedEmailEntry({ vendor, email }) {
  return { kind: 'email', key: emailKey(vendor, email.id), vendor, emailId: email.id, receivedAt: new Date(email.received_at).toISOString() };
}

// A line's identity across copies of one invoice. The sweep keys a SiteOne invoice by its number whichever email
// carries it (siteOneInvoiceLines: the first copy handled owns the shipment), so a row from ANY email under the same
// vendor and shipment_key can be this line. The exact line number (with the same product text) comes first. Product text is a one-to-one fallback
// for a copy that numbered the lines differently, and clears an entry only when it is unambiguous: the entry's text
// is the only failed entry with it on that invoice, exactly one row on the invoice has that text, that row came from
// ANOTHER email (a sibling line of the failing email, even with identical text, is a different line) and its line
// number is not another entry's own number. Texts that collapse to one normalized text count as the same text.
const sameText = (row, entry) => normalizeTitle(row.raw_title) === entry.titleKey;

function textClears(entry, rows, group) {
  if (!entry.titleKey || entry.emailId == null) return false;
  if (group.filter((other) => other.titleKey === entry.titleKey).length !== 1) return false;
  const matches = rows.filter((row) => sameText(row, entry));
  return matches.length === 1 && String(matches[0].email_id) !== String(entry.emailId)
    && !group.some((other) => other.key !== entry.key && Number(other.lineNo) === Number(matches[0].line_no));
}

// Keys that already have a purchase_receipt_lines row: a line by its identity above; an email ONLY by a row whose
// source email is that email (an older email's rows under the same invoice number say nothing about a newer read).
async function recordedKeys(entries, conn) {
  const recorded = new Set();
  const lines = entries.filter((entry) => entry.kind !== 'email');
  const shipments = [...new Set(lines.map((entry) => entry.shipmentKey))];
  const rowsByShipment = new Map();
  for (let i = 0; i < shipments.length; i += ROW_CHECK_CHUNK) {
    const rows = await conn('purchase_receipt_lines').whereIn('shipment_key', shipments.slice(i, i + ROW_CHECK_CHUNK))
      .select('vendor', 'shipment_key', 'line_no', 'raw_title', 'email_id');
    for (const row of rows) {
      const id = `${row.vendor}|${row.shipment_key}`;
      rowsByShipment.set(id, [...(rowsByShipment.get(id) || []), row]);
    }
  }
  for (const entry of lines) {
    const id = `${entry.vendor}|${entry.shipmentKey}`;
    const rows = rowsByShipment.get(id) || [];
    const group = lines.filter((other) => `${other.vendor}|${other.shipmentKey}` === id);
    // The same line number from a copy that ordered its lines differently can be another product: it clears only with the same text.
    const sameLine = rows.some((row) => Number(row.line_no) === Number(entry.lineNo) && (!entry.titleKey || sameText(row, entry)));
    if (sameLine || textClears(entry, rows, group)) recorded.add(entry.key);
  }
  const emails = entries.filter((entry) => entry.kind === 'email');
  if (emails.length) {
    const rows = await conn('purchase_receipt_lines').whereIn('email_id', emails.map((e) => e.emailId)).select('vendor', 'email_id');
    for (const row of rows) recorded.add(emailKey(row.vendor, row.email_id));
  }
  return recorded;
}

// This run's failures plus the open alert's carried entries, minus those with positive evidence, oldest first.
async function openFailedLines({ failed, settled, prior, since, conn }) {
  const settledKeys = new Set(settled.map((entry) => entry.key));
  const merged = new Map();
  // Received before the physical count at PURCHASE_RECEIPT_SINCE: the count already includes it (inventory-agent.js
  // closeBeforeCutoff retires its lines by the same rule), so it is nothing to add by hand.
  const atOrAfterCutoff = (entry) => !since || !(new Date(entry.receivedAt) < since);
  for (const entry of [...prior, ...failed].filter(atOrAfterCutoff)) merged.set(entry.key, entry);
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

// The newest alert row for the key. `prior` is what an open row carries (a cleared row is a closed episode and
// carries none). `handled` survives a clear. `personDone`: a PERSON pressed Done (done_by a user id or claude); the
// quiet 72-hour fall-off and other automatic closes are not "handled".
async function standingAlert(conn) {
  const row = await conn('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [DEDUPE_KEY])
    .orderBy('created_at', 'desc').first('metadata', 'done_at', 'done_by');
  const meta = (typeof row?.metadata === 'string' ? JSON.parse(row.metadata) : row?.metadata) || {};
  const cleared = meta.autoCleared === true;
  const { isPersonDoneBy } = require('../notification-service')._private;
  return {
    prior: !cleared && Array.isArray(meta.failedLines) ? meta.failedLines : [],
    handled: new Set((meta.handledKeys || []).map(String)),
    cleared,
    personDone: Boolean(row?.done_at) && isPersonDoneBy(row.done_by),
  };
}

/**
 * @param {{failed: object[], settled: {key: string}[], since?: Date}} params failed: this run's failedLines bucket;
 *   settled: keys this run recorded an outcome for without throwing; since: PURCHASE_RECEIPT_SINCE
 * @returns {Promise<number>} entries still unapplied
 */
async function reconcileFailedLineAlert({ failed = [], settled = [], since = null }, conn = db) {
  const episodes = require('../admin-alert-episodes');
  const { prior, handled, cleared, personDone } = await standingAlert(conn);
  // A person pressing Done says every entry the row held was dealt with: they are never listed again, even when a NEW
  // entry reopens the row, so staff do not add the same stock twice.
  if (personDone) prior.forEach((entry) => handled.add(entry.key));
  if (!failed.length && !prior.length) return 0;
  const open = await openFailedLines({ failed, settled, prior, since, conn });
  if (!open.length) {
    if (!prior.length) return 0;
    await conn.transaction((trx) => episodes.closeAdminAlertKeys(trx, [DEDUPE_KEY], 'count_zero', {
      resolution: 'Cleared: every receipt line that failed has since been applied',
    }));
    return 0;
  }
  const keys = open.map((entry) => entry.key);
  const handledKeys = keys.filter((key) => handled.has(key));
  const active = open.filter((entry) => !handled.has(entry.key));
  if (!active.length) {
    // Only entries staff already handled remain. A row a person left done stays as it is; a reopened row whose new
    // entries resolved would otherwise keep its stale detail, so it resolves (the handled keys stay in its metadata).
    if (!cleared && !personDone && prior.length) {
      await conn.transaction((trx) => episodes.closeAdminAlertKeys(trx, [DEDUPE_KEY], 'count_zero', {
        resolution: 'Cleared: only entries staff already handled remain',
      }));
    }
    return open.length;
  }
  const { alert, detail } = composeFailedLinesAlert(active);
  await episodes.raiseAdminAlertWithReopen('inventory', alert.headline, alert.why, {
    dedupeKey: DEDUPE_KEY,
    bell: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewLine(keys),
    bumpOnRefresh: true,
    detail,
    link: alert.link,
    metadata: { ...alert.metadata, failedLines: open, itemKeys: keys, handledKeys, count: active.length },
  });
  return open.length;
}

module.exports = { reconcileFailedLineAlert, failedLineEntry, failedEmailEntry, lineKey, emailKey, DEDUPE_KEY, SHOWN };
