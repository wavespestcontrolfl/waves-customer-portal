'use strict';

// Which customer an admin alert is about, by name (owner 2026-11-02: "if it's a customer, the customer
// needs to be named"; docs/admin-notifications.md, "Say who and what"). Many alerts never put the name in
// their own text (an accepted plan that needs a schedule review, an ops check), so the bell and the
// plain-words explainer (admin-alert-explainer.js) read it here, from what the emitter already wrote.
//
// The record, most direct first: a customer id (the row's subject, top level, its trigger payload, the SMS
// thread id, a customer page link), else the visit, estimate, invoice, lead or call the row is about, whose
// customer is read with one query per table for the whole page. An estimate or a lead with no customer
// keeps the name written on it. Read-only; a failed read names nobody and never throws.
const logger = require('./logger');
const { refsFromRow, parseMeta } = require('./admin-alert-relevance');
const { fullName } = require('./admin-alert-names');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_PATH_RE = /^\/admin\/customers\/([0-9a-f-]{36})(?:[/?#]|$)/i;

const uuidOrNull = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const firstUuid = (...values) => values.map(uuidOrNull).find(Boolean) || null;

function linkParams(link) {
  try { return new URL(String(link || ''), 'http://alert.local').searchParams; } catch { return new URLSearchParams(); }
}

// The records one row names. Bad or missing ids read as null.
function alertRecordRefs(row) {
  const meta = parseMeta(row.metadata);
  const payload = parseMeta(meta.payload);
  const subject = meta.subject && typeof meta.subject === 'object' ? meta.subject : {};
  const subjectId = (type) => (subject.type === type ? uuidOrNull(String(subject.id ?? '')) : null);
  const refs = refsFromRow(row);
  const params = linkParams(row.link);
  return {
    customerId: firstUuid(subjectId('customer'), meta.customerId, meta.customer_id, payload.customerId,
      payload.customer_id, meta.threadId, params.get('customerId'), CUSTOMER_PATH_RE.exec(String(row.link || ''))?.[1]),
    visitId: subjectId('visit') || refs.visitId,
    estimateId: subjectId('estimate') || refs.estimateId,
    invoiceId: firstUuid(subjectId('invoice'), meta.invoiceId, meta.invoice_id, payload.invoiceId, payload.invoice_id, params.get('invoice')),
    leadId: subjectId('lead') || refs.leadId,
    callId: firstUuid(subjectId('call'), meta.callLogId, meta.call_log_id, payload.callLogId, payload.call_log_id),
  };
}

// One read of `columns` for these ids, as a Map by id. A failed read is an empty map.
async function readByIds(conn, table, ids, columns) {
  if (!ids.length) return new Map();
  try {
    const rows = await conn(table).whereIn('id', ids).select(columns);
    return new Map(rows.map((r) => [String(r.id), r]));
  } catch (err) {
    // The error code only: a database error's message carries the query's bound values.
    logger.warn(`[alert-customer] ${table} read failed: ${require('./notification-service').safeErrorSummary(err)}`);
    return new Map();
  }
}

// Which table answers for a row that names no customer itself, and where its own fallback name lives.
const RECORD_TABLES = [
  ['visitId', 'scheduled_services', ['id', 'customer_id'], () => ''],
  ['estimateId', 'estimates', ['id', 'customer_id', 'customer_name'], (r) => String(r.customer_name || '').trim()],
  ['invoiceId', 'invoices', ['id', 'customer_id'], () => ''],
  ['leadId', 'leads', ['id', 'customer_id', 'first_name', 'last_name'], (r) => fullName(r)],
  ['callId', 'call_log', ['id', 'customer_id'], () => ''],
];

// Map of row id -> { id, name } for every row whose customer can be named: `id` is the customer id (null
// when only an estimate or a lead carries the name), `name` the display name. Rows that name nobody are
// left out.
async function customersForAlerts(conn, rows) {
  const out = new Map();
  if (!Array.isArray(rows) || !rows.length) return out;
  const items = rows.filter((r) => r && r.id != null).map((row) => ({ row, refs: alertRecordRefs(row) }));
  const pending = items.filter((i) => !i.refs.customerId);
  const records = await Promise.all(RECORD_TABLES.map(([key, table, columns]) => readByIds(
    conn, table, [...new Set(pending.map((i) => i.refs[key]).filter(Boolean))], columns,
  )));
  for (const item of pending) {
    RECORD_TABLES.some(([key, , , ownName], index) => {
      const record = item.refs[key] ? records[index].get(item.refs[key]) : null;
      if (!record) return false;
      item.customerId = uuidOrNull(String(record.customer_id || ''));
      item.ownName = ownName(record);
      return Boolean(item.customerId || item.ownName);
    });
  }
  for (const item of items) item.customerId = item.refs.customerId || item.customerId || null;
  const customers = await readByIds(conn, 'customers',
    [...new Set(items.map((i) => i.customerId).filter(Boolean))], ['id', 'first_name', 'last_name']);
  for (const item of items) {
    const customer = item.customerId ? customers.get(item.customerId) : null;
    const name = (customer && fullName(customer)) || item.ownName || '';
    if (name) out.set(String(item.row.id), { id: customer ? item.customerId : null, name });
  }
  return out;
}

module.exports = { alertRecordRefs, customersForAlerts };
