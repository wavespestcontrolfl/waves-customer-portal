'use strict';

// Shared "nothing else happened" checks for the workflow case scripts.
//
//   rowState / noWrites  A read (or a refused write) must leave the case's rows with the SAME VALUES, not only the same
//                        counts: a status flipped, a message marked read or a visit edited in place changes no count.
//   sendState / noSends  A read, a refused write or a draft save sends nothing on ANY channel: the SMS provider stub,
//                        SendGrid, the Gmail client, the outbound message rows and the email rows. The harness takes the
//                        row baseline at the case's first turn, after seeding.

/** Rows of one table scoped by a column, ordered by id so two snapshots compare as strings. A missing table is recorded, not thrown. */
async function scoped(h, table, column, values, orderBy = 'id') {
  if (!values.length) return [];
  try {
    return await h.db(table).whereIn(column, values).orderBy(orderBy).select('*');
  } catch {
    try { return await h.db(table).whereIn(column, values).select('*'); } catch (inner) { return [`unreadable: ${String(inner.message).split('\n')[0]}`]; }
  }
}

/** Every row a read could touch for the case's customers, leads, promises, notifications and stock products, table by table. */
async function rowTables(h, cast, { notifications = false } = {}) {
  const customers = cast.customers || [];
  const byCustomer = ['customer_properties', 'scheduled_services', 'service_records', 'sms_log', 'call_log', 'invoices', 'payments', 'customer_credit_ledger', 'collections_flags', 'estimates', 'messaging_audit_log', 'emails', 'email_automation_sends'];
  const state = { customers: await scoped(h, 'customers', 'id', customers) };
  for (const table of byCustomer) state[table] = await scoped(h, table, 'customer_id', customers);
  state.call_commitments = await scoped(h, 'call_commitments', 'id', cast.commitmentIds || []);
  state.leads = await scoped(h, 'leads', 'id', cast.leads || []);
  if (notifications || (cast.notificationIds || []).length) {
    state.notifications = await scoped(h, 'notifications', 'id', cast.notificationIds || []);
    state.notification_total = Number((await h.db('notifications').count('* as n').first()).n);
  }
  const products = cast.productIds || [];
  if (products.length) {
    state.products_catalog = await scoped(h, 'products_catalog', 'id', products);
    state.product_inventory_movements = await scoped(h, 'product_inventory_movements', 'product_id', products, 'created_at');
    state.product_restock_requests = await scoped(h, 'product_restock_requests', 'product_id', products);
    const requests = (state.product_restock_requests || []).filter((r) => r && r.id).map((r) => r.id);
    state.vendor_orders = await scoped(h, 'vendor_orders', 'restock_request_id', requests);
  }
  return state;
}

/** The same, as one comparable string. */
async function rowState(h, cast, options) { return JSON.stringify(await rowTables(h, cast, options)); }

/** Which tables differ between two rowState strings, for the failure detail. */
function changedTables(before, after) {
  const a = JSON.parse(before);
  const b = JSON.parse(after);
  return Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/**
 * The manifest's "unchanged" rows, enforced by the runner. `spec` maps a table to { mode, columns }:
 *   mode 'all'      no step of the case changes that table: every row now equals every row at the baseline
 *   mode 'baseline' the case only adds rows (`table[new]`): every row that existed at the baseline equals its baseline value
 *   columns         null: the complete row is compared; a Set: only the columns the manifest names (`table[*].column`)
 * Returns the tables that differ. A case that changes a seeded row of the same table is not judged here (its own checks are).
 */
async function unchangedViolations(h, cast, baseline, spec) {
  const now = await rowTables(h, cast, { notifications: !!baseline.notifications });
  const bad = [];
  for (const [table, { mode, columns }] of spec) {
    if (!(table in baseline)) continue;
    const project = (row) => (!columns || !row || typeof row !== 'object' ? row : Object.fromEntries([...columns].map((k) => [k, row[k]])));
    const before = (baseline[table] || []).map(project);
    const after = (now[table] || []).map(project);
    if (mode === 'all') {
      if (JSON.stringify(before) !== JSON.stringify(after)) bad.push(table);
    } else {
      const byId = new Map((now[table] || []).filter((r) => r && r.id).map((r) => [r.id, JSON.stringify(project(r))]));
      if ((baseline[table] || []).some((r) => r && r.id && byId.get(r.id) !== JSON.stringify(project(r)))) bad.push(table);
    }
  }
  return bad;
}

/** Compare a row snapshot taken earlier with the rows now. Returns ok. */
async function noWrites(ctx, h, cast, before, { code = 'read_changed_rows', what = 'a read', ...options } = {}) {
  const after = await rowState(h, cast, options);
  const ok = after === before;
  return ctx.check(ok, 'side_effect', code, () => `${what} changed row values in: ${changedTables(before, after).join(', ')}`);
}

const callsOf = (p) => {
  if (!p) return 0;
  if (p.mock) return p.mock.calls.length;
  if (p.sendOne && p.sendOne.mock) return p.sendOne.mock.calls.length;
  return 0;
};

/** What has gone out: provider stub submissions, outbound rows and email rows for the case's customers. */
async function sendState(h, cast) {
  const customers = cast.customers || [];
  const count = async (query) => { try { return Number((await query.count('* as n').first()).n); } catch { return -1; } };
  const providers = h.providers || {};
  return {
    sms_provider: callsOf(providers.sms),
    sendgrid_provider: callsOf(providers.sendgrid),
    gmail_provider: callsOf(providers.gmail),
    outbound_sms_rows: customers.length ? await count(h.db('sms_log').whereIn('customer_id', customers).where({ direction: 'outbound' })) : 0,
    // Accepted attempts only: a blocked attempt (blocked_code set) is a refusal the audit log records, not a send.
    audit_rows: customers.length ? await count(h.db('messaging_audit_log').whereIn('customer_id', customers).whereNull('blocked_code')) : 0,
    email_rows: customers.length ? await count(h.db('emails').whereIn('customer_id', customers)) : 0,
    email_message_rows: customers.length ? await count(h.db('email_messages').whereIn('recipient_id', customers)) : 0,
    email_automation_rows: customers.length ? await count(h.db('email_automation_sends').whereIn('customer_id', customers)) : 0,
    blocked_sender_hosts: h.blockedNetwork.filter((entry) => /sendgrid|googleapis|gmail|twilio/i.test(entry)).length,
  };
}

/**
 * Nothing was sent. The provider stubs are cleared when a case starts, so their counts must be zero; the row counts are
 * compared with the baseline the harness took at the case's first turn (rows the seed itself holds are not sends).
 * `codes` names the failure per channel so a workflow keeps its own wording: { sms, email }.
 */
async function noSends(ctx, h, cast, { what = 'a read', codes = {}, since = null, settle = true } = {}) {
  if (settle) await h.settle();
  const base = since || ctx.sendBaseline || {};
  const now = await sendState(h, cast);
  // The provider stubs are compared with `since` when given (taken right after a mid-case mockClear), else with zero.
  const was = (k) => (since ? since[k] : 0);
  const smsCode = codes.sms || 'read_sent_a_text';
  const emailCode = codes.email || 'read_sent_an_email';
  ctx.check(now.sms_provider === was('sms_provider'), 'side_effect', smsCode, `${now.sms_provider - was('sms_provider')} SMS provider submissions for ${what}`);
  const outboundBase = base.outbound_sms_rows ?? now.outbound_sms_rows;
  // A queued text cancelled (its row removed) is not a send: the count may fall, never rise.
  ctx.check(now.outbound_sms_rows <= outboundBase && now.audit_rows === (base.audit_rows ?? now.audit_rows), 'side_effect', codes.smsRows || `${smsCode}_row`, () => `${what}: outbound sms rows ${base.outbound_sms_rows} -> ${now.outbound_sms_rows}, messaging audit rows ${base.audit_rows} -> ${now.audit_rows}`);
  ctx.check(now.sendgrid_provider === was('sendgrid_provider') && now.gmail_provider === was('gmail_provider') && now.blocked_sender_hosts === (base.blocked_sender_hosts ?? now.blocked_sender_hosts), 'side_effect', emailCode, () => `${what}: SendGrid ${now.sendgrid_provider}, Gmail ${now.gmail_provider}, unstubbed sender calls ${base.blocked_sender_hosts} -> ${now.blocked_sender_hosts}`);
  const rows = ['email_rows', 'email_message_rows', 'email_automation_rows'].filter((k) => now[k] !== (base[k] ?? now[k]));
  ctx.check(rows.length === 0, 'side_effect', codes.emailRows || `${emailCode}_row`, () => `${what}: ${rows.map((k) => `${k} ${base[k]} -> ${now[k]}`).join('; ')}`);
}

module.exports = { rowTables, unchangedViolations, rowState, noWrites, sendState, noSends, changedTables };
