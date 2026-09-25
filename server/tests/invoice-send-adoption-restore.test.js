// claimInvoiceForSend's adoption (adoptsQueuedInvoiceSend) CONSUMES a
// pre-existing queued pay-link SMS (the invoice_send_deferred row a held
// send left on the scheduled rail) BEFORE the replacement delivery is even
// attempted, so the queue worker can never double-send while the live
// replacement is in flight. If that replacement delivery then fails, the
// cancellation must be undone (restoreConsumedQueuedSend) — otherwise the
// customer's already-scheduled text is silently lost; if it succeeds, the
// adopted row must be discharged (resolveConsumedQueuedSend), never
// restored — restoring a row a live send actually delivered would double-
// text the pay link. An uncertain provider outcome must do neither: the
// adopted row stays exactly as consumeQueuedInvoiceSend left it (cancelled,
// pending) until an operator resolves the ambiguous send.
//
// This suite models 'invoices' and 'sms_log' as small in-memory tables so
// assertions are about durable STATE rather than a hand-counted call order.

const QUEUE_ADOPTION_PENDING_KEY = 'invoice_send_adoption_pending';
const QUEUE_ADOPTION_HANDOFF_KEY = 'invoice_send_adoption_handoff_token';
const QUEUE_ADOPTION_HANDOFF_AT_KEY = 'invoice_send_adoption_handoff_at';
const INVOICE_SEND_DEFERRED_ENTRY_POINT = 'invoice_send_deferred';

function makeInvoicesTable(row, { onUpdate = null } = {}) {
  let state = { ...row };
  return {
    state: () => state,
    reset: (next) => { state = { ...next }; },
    query() {
      const filters = {};
      // Round-2 Codex P1 (PR #4633): the claim's atomic flip now carries
      // the first-delivery/review-hold guards as REAL predicates
      // (.whereNull/.whereRaw) on the UPDATE — several tests here call
      // sendViaSMS(AndEmail) without allowClaimed, which always runs that
      // flip, so both must actually filter instead of no-op-chaining.
      const predicates = [];
      const q = {};
      const applyFilters = (rows) => rows.filter((r) => (
        Object.entries(filters).every(([k, v]) => r[k] === v)
        && predicates.every((p) => p(r))
      ));
      q.where = jest.fn((crit) => { Object.assign(filters, crit); return q; });
      q.whereIn = jest.fn(() => q);
      q.whereNull = jest.fn((col) => { predicates.push((r) => r[col] == null); return q; });
      q.whereRaw = jest.fn((sql, bindings) => { predicates.push((r) => evaluateWhereRaw(sql, bindings, r)); return q; });
      q.forUpdate = jest.fn(() => q);
      q.update = jest.fn((payload) => {
        if (onUpdate) onUpdate(payload);
        const matched = applyFilters([state]);
        for (const r of matched) {
          for (const [k, v] of Object.entries(payload)) {
            if (k === 'status' && ((typeof v === 'string' && v.startsWith('CASE WHEN'))
              || (v && v.__sqlRaw && v.__sqlRaw.startsWith('CASE WHEN')))) {
              r[k] = ['draft', 'scheduled', 'sending'].includes(r.status) ? 'sent' : r.status;
            } else if (k === 'scheduled_send_error' && v && v.__sqlRaw) {
              // preserveWithdrawalStamp raw CASE — irrelevant to this suite's
              // fixtures (no withdrawal stamp), so it always resolves null.
              r[k] = null;
            } else {
              r[k] = v;
            }
          }
        }
        q.__affected = matched.length;
        return q;
      });
      // Single-row table: RETURNING after an UPDATE reflects the WHERE
      // clause evaluated once (real knex/PostgreSQL semantics), never a
      // re-filter against the now-mutated state — a status-changing update
      // would otherwise filter itself out of its own RETURNING.
      q.returning = jest.fn(async () => (q.__affected ? [{ ...state }] : []));
      // Cloned — a real DB row is a value, never a live reference into the
      // server's mutable row; the caller's read must not observe a LATER
      // update through this object.
      q.first = jest.fn(async () => { const m = applyFilters([state])[0]; return m ? { ...m } : undefined; });
      q.then = (resolve) => Promise.resolve(q.__affected ?? applyFilters([state]).length).then(resolve);
      q.catch = () => Promise.resolve();
      return q;
    },
  };
}

// Interprets a raw metadata expression GENERICALLY rather than special-
// casing exact SQL strings, so a production shape change (more keys, more
// nesting) does not silently stop exercising the mock:
//   - every `- 'key'` subtraction token, at any nesting depth, deletes that
//     key (covers COALESCE(...)/plain-subtraction forms alike);
//   - a trailing `jsonb_build_object(k1, v1, k2, v2, ...)` sets each key,
//     pulling `?`/`?::text` placeholder values from bindings in order and
//     literal `'text'`/`true`/`false` tokens as-is.
function applyRawMetadataUpdate(row, rawValue) {
  const sql = rawValue.__sqlRaw;
  const bindings = rawValue.__bindings || [];
  const meta = { ...(row.metadata || {}) };

  for (const m of sql.matchAll(/-\s*'([^']+)'/g)) delete meta[m[1]];

  const buildMatch = /jsonb_build_object\(([^)]*)\)/.exec(sql);
  if (buildMatch) {
    const parts = buildMatch[1].split(',').map((p) => p.trim());
    let bindingIndex = 0;
    for (let i = 0; i < parts.length; i += 2) {
      const key = parts[i].replace(/^'|'$/g, '');
      const valueToken = parts[i + 1];
      if (valueToken === '?' || valueToken === '?::text') {
        meta[key] = bindings[bindingIndex]; bindingIndex += 1;
      } else if (valueToken === 'true') meta[key] = true;
      else if (valueToken === 'false') meta[key] = false;
      else meta[key] = valueToken.replace(/^'|'$/g, '');
    }
  }
  row.metadata = meta;
}

function makeSmsLogTable(initialRows, { failResolve = false, failRestore = false, failFence = false, onUpdate = null } = {}) {
  let rows = initialRows.map((r) => ({ ...r, metadata: { ...r.metadata } }));
  return {
    rows: () => rows,
    query() {
      const rawFilters = [];
      let idFilter = null;
      let simpleWhere = {};
      const q = {};
      q.where = jest.fn((crit) => { Object.assign(simpleWhere, crit); return q; });
      q.whereIn = jest.fn((field, values) => {
        if (field === 'id') idFilter = values;
        else rawFilters.push((row) => values.includes(row[field]));
        return q;
      });
      q.whereNull = jest.fn(() => q);
      q.forUpdate = jest.fn(() => q);
      q.whereRaw = jest.fn((sql, bindings) => {
        const eqMatch = /metadata->>'(\w+)' = \?$/.exec(sql);
        if (eqMatch && Array.isArray(bindings) && typeof bindings[0] !== 'object') {
          const key = eqMatch[1];
          rawFilters.push((row) => (row.metadata || {})[key] === bindings[0]);
        } else if (sql.includes("entry_point' = ANY")) {
          const list = bindings[0];
          rawFilters.push((row) => list.includes((row.metadata || {}).entry_point));
        } else if (sql.includes("status = 'scheduled' OR")) {
          rawFilters.push((row) => row.status === 'scheduled'
            || (row.status === 'cancelled' && !!(row.metadata || {})[QUEUE_ADOPTION_PENDING_KEY]));
        } else if (sql.includes("cancelled_reason' = 'superseded_by_live_send'")) {
          rawFilters.push((row) => (row.metadata || {}).cancelled_reason === 'superseded_by_live_send');
        } else if (sql.includes(QUEUE_ADOPTION_PENDING_KEY)) {
          rawFilters.push((row) => !!(row.metadata || {})[QUEUE_ADOPTION_PENDING_KEY]);
        } else if (sql.includes('finalize_pending')) {
          if (bindings) {
            const excludedEntryPoint = bindings[0];
            // Only the FIXED SQL literal (ADOPTABLE_PAY_LINK_QUEUE_ROW_SQL,
            // post 1b536dff1b) embeds FINALIZE_ONLY_ROW_SQL — checking for
            // that substring (rather than hardcoding the new behavior)
            // means a revert of the production string genuinely reverts
            // this mock's semantics too, so the regression test can fail
            // honestly against the old code.
            const checksFinalizeOnly = sql.includes('finalize_only');
            // The adopter's view: a still-scheduled row under a DIFFERENT
            // entry point blocks (someone else's queue), and so does one
            // under THIS invoice's own entry point when the stale-
            // finalization sweep stamped it finalize_only — its text
            // already reached the provider, only the bookkeeping is owed.
            rawFilters.push((row) => row.status === 'sending'
              || (row.status === 'sent' && (row.metadata || {}).finalize_pending === true)
              || (row.status === 'scheduled' && ((row.metadata || {}).entry_point !== excludedEntryPoint
                || (checksFinalizeOnly && (row.metadata || {}).finalize_only === true))));
          } else {
            rawFilters.push((row) => row.status === 'scheduled' || row.status === 'sending'
              || (row.status === 'sent' && (row.metadata || {}).finalize_pending === true));
          }
        } else if (sql.startsWith('NOT (') && sql.includes('finalize_only')) {
          // consumeQueuedInvoiceSend's own defense-in-depth: never consume a
          // row stamped finalize_only, even if something upstream let the
          // claim through. Only the fixed SQL emits this clause at all.
          rawFilters.push((row) => (row.metadata || {}).finalize_only !== true);
        } else if (sql.includes(QUEUE_ADOPTION_HANDOFF_KEY) && sql.includes('IS NULL OR')) {
          // restoreConsumedQueuedSend's fence check: only a row never handed
          // to a provider, or handed over by THIS episode's own token, may
          // go back on the schedule.
          const token = bindings && String(bindings[0]);
          rawFilters.push((row) => {
            const fence = (row.metadata || {})[QUEUE_ADOPTION_HANDOFF_KEY];
            return fence == null || fence === token;
          });
        } else if (sql.includes(QUEUE_ADOPTION_HANDOFF_KEY)) {
          // fenceAdoptedRowsBeforeHandoff's own guard: only stamp a row
          // that isn't already fenced.
          rawFilters.push((row) => (row.metadata || {})[QUEUE_ADOPTION_HANDOFF_KEY] == null);
        }
        return q;
      });
      const matched = () => {
        let candidates = idFilter ? rows.filter((r) => idFilter.includes(r.id)) : rows.slice();
        for (const [k, v] of Object.entries(simpleWhere)) candidates = candidates.filter((r) => r[k] === v);
        for (const f of rawFilters) candidates = candidates.filter(f);
        return candidates;
      };
      q.first = jest.fn(async () => matched()[0]);
      // A held-SMS requeue inserts a fresh row on the scheduled rail — the
      // replacement invoice_send_deferred text a queued-hold discharge
      // leaves behind.
      q.insert = jest.fn((payload) => {
        const metadata = typeof payload.metadata === 'string' ? JSON.parse(payload.metadata) : (payload.metadata || {});
        rows.push({ ...payload, metadata });
        q.__affected = 1;
        return q;
      });
      q.update = jest.fn((payload) => {
        // Simulates resolveConsumedQueuedSend's UPDATE failing after
        // provider acceptance — the row must stay exactly as consumeQueued-
        // InvoiceSend left it (cancelled, pending) rather than silently
        // "succeeding" here.
        if (failResolve && payload.metadata && payload.metadata.__sqlRaw
          && payload.metadata.__sqlRaw.includes('adoption_resolved_at')) {
          throw new Error('sms_log resolve update failed (injected)');
        }
        // Simulates restoreConsumedQueuedSend's UPDATE failing (or
        // reporting 0 rows) when giving an adopted row back — distinguished
        // from the resolve update above (which never sets `status`, only
        // strips/adds metadata keys) by its literal status:'scheduled'.
        // Deliberately NOT keyed to the exact subtraction-expression text —
        // a nesting-depth change (more keys stripped) must not silently
        // stop exercising this injection.
        if (failRestore && payload.status === 'scheduled' && payload.metadata && payload.metadata.__sqlRaw) {
          throw new Error('sms_log restore update failed (injected)');
        }
        // Simulates fenceAdoptedRowsBeforeHandoff's UPDATE failing before
        // the provider is ever contacted — distinguished from both the
        // resolve and restore updates above by carrying the handoff key
        // itself and never setting `status`.
        if (failFence && !payload.status && payload.metadata && payload.metadata.__sqlRaw
          && payload.metadata.__sqlRaw.includes(QUEUE_ADOPTION_HANDOFF_KEY)) {
          throw new Error('sms_log fence update failed (injected)');
        }
        if (onUpdate) onUpdate(payload);
        const targets = matched();
        q.__matched = targets;
        for (const row of targets) {
          for (const [k, v] of Object.entries(payload)) {
            if (k === 'metadata' && v && v.__sqlRaw) applyRawMetadataUpdate(row, v);
            else if (k !== 'updated_at') row[k] = v;
          }
        }
        q.__affected = targets.length;
        return q;
      });
      // Reflects the WHERE clause evaluated once, before the update applied
      // (real knex/PostgreSQL RETURNING semantics) — never a re-filter
      // against the now-mutated rows.
      q.returning = jest.fn(async () => (q.__matched || matched()).map((r) => ({ ...r })));
      q.then = (resolve) => Promise.resolve(q.__affected ?? matched().length).then(resolve);
      q.catch = () => Promise.resolve();
      return q;
    },
  };
}

jest.mock('../models/db', () => {
  const database = jest.fn();
  database.raw = jest.fn((sql, bindings) => ({ __sqlRaw: sql, __bindings: bindings }));
  database.transaction = jest.fn(async (callback) => callback(database));
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  invoiceShortCodePrefix: jest.fn(() => 'wpc'),
}));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://waves.test' }));
jest.mock('../services/invoice-prepay', () => ({
  loadInvoiceAnnualPrepay: jest.fn(async () => null),
  buildPrepayCoverageSummary: jest.fn(),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  isTemplateActive: jest.fn(async () => true),
  getTemplate: jest.fn(async () => 'Your invoice is ready: https://waves.test/pay/abc'),
}));
jest.mock('../services/invoice-followups', () => ({ scheduleForInvoice: jest.fn(async () => true) }));
jest.mock('../services/invoice-helpers', () => ({
  ...jest.requireActual('../services/invoice-helpers'),
  assertInvoiceVoidable: jest.fn(),
  invoiceAmountDue: (invoice) => Number(invoice.total) - Number(invoice.credit_applied || 0),
  formatCardLine: jest.fn(),
  preserveWithdrawalStamp: jest.fn(() => null),
  selfPayAtDispatch: jest.fn(() => async () => ({ ok: true })),
}));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => true),
  withInvoiceDepositSettlement: jest.fn(async (_id, callback) => callback(null, null)),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => null),
  reverseAppliedCredit: jest.fn(async () => {}),
}));
jest.mock('../services/lead-estimate-link', () => ({ convertLeadFromEvent: jest.fn(async () => null) }));
jest.mock('../services/invoice-issued-closeout', () => ({ closeOutVisitForIssuedInvoice: jest.fn(async () => null) }));
jest.mock('../services/invoice-email', () => ({ sendInvoiceEmail: jest.fn() }));

const db = require('../models/db');
const { evaluateWhereRaw } = require('./helpers/sql-predicate');
const { withInvoiceDepositSettlement } = require('../services/estimate-deposits');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { sendInvoiceEmail } = require('../services/invoice-email');
const { autoApplyAccountCreditIfEnabled } = require('../services/customer-credit');
const logger = require('../services/logger');
const InvoiceService = require('../services/invoice');

function customerQuery(customer) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => customer);
  return q;
}

function passthroughQuery() {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'update', 'insert']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => undefined);
  q.then = (resolve) => Promise.resolve(1).then(resolve);
  q.catch = () => Promise.resolve();
  return q;
}

describe('invoice send claim adoption of a queued pay-link SMS', () => {
  const ORIGINAL_SCHEDULED_FOR = new Date('2026-09-11T12:00:00.000Z');
  let invoices;
  let smsLog;
  let customer;

  beforeEach(() => {
    jest.clearAllMocks();
    invoices = makeInvoicesTable({
      id: 'inv-1',
      invoice_number: 'WPC-2026-2001',
      status: 'draft',
      customer_id: 'cust-1',
      payer_id: null,
      token: 'tok-1',
      total: 100,
      credit_applied: 0,
      send_claim_token: null,
    });
    smsLog = makeSmsLogTable([{
      id: 'sms-queued-1',
      status: 'scheduled',
      scheduled_for: ORIGINAL_SCHEDULED_FOR,
      metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
    }]);
    customer = { id: 'cust-1', first_name: 'Pat', phone: '+19415550100' };
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoices.query();
      if (table === 'sms_log') return smsLog.query();
      if (table === 'customers') return customerQuery(customer);
      if (table === 'notification_prefs') return customerQuery({});
      if (table === 'activity_log') return passthroughQuery();
      throw new Error(`Unexpected table: ${table}`);
    });
    withInvoiceDepositSettlement.mockImplementation(async (_id, callback) => callback(db, invoices.state()));
  });

  test('a no-phone failure restores the adopted queued row — same id, same schedule — before releasing the invoice claim', async () => {
    customer.phone = null;

    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toThrow('Customer has no phone number');

    // The invoice claim gave back to 'draft' and the token cleared.
    expect(invoices.state()).toMatchObject({ status: 'draft', send_claim_token: null });
    // The adopted row is restored to exactly its original schedule — not a
    // fresh one.
    const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
    expect(row.status).toBe('scheduled');
    expect(row.scheduled_for).toEqual(ORIGINAL_SCHEDULED_FOR);
    expect(row.metadata.cancelled_reason).toBeUndefined();
    expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
  });

  test('a fully delivered send resolves the adopted row — it stays cancelled, never restored', async () => {
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
      withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'accepted' }))
    ));

    await expect(InvoiceService.sendViaSMS('inv-1')).resolves.toMatchObject({ sent: true });

    expect(invoices.state().status).toBe('sent');
    const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
    // Consumed by the adoption and never given back — a live send actually
    // delivered the pay link it superseded.
    expect(row.status).toBe('cancelled');
    expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
    // The pending marker is cleared (durably resolved) so a later resend
    // can never mistake this historically superseded row for an owed leg.
    expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
    expect(row.metadata.adoption_resolved_at).toEqual(expect.any(String));
  });

  test('an uncertain provider outcome leaves the adopted row exactly as consumed — neither restored nor resolved', async () => {
    const uncertainErr = Object.assign(new Error('provider socket closed'), {
      providerOutcome: { deliveryOutcome: 'uncertain', code: 'PROVIDER_TIMEOUT' },
    });
    sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
      withProviderHandoff(async () => { throw uncertainErr; })
    ));

    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toMatchObject({ deliveryOutcome: 'uncertain' });

    // The claim is retained (parked for review), never restored to draft.
    expect(invoices.state()).toMatchObject({ status: 'sending' });
    const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
    // Consumed but neither resolved nor restored — the durable "may have
    // sent" marker stays exactly as the adoption left it until an operator
    // resolves the ambiguous send.
    expect(row.status).toBe('cancelled');
    expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
    expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBe(true);
  });

  test('a live queued row not owned by this send refuses the claim outright (no adoption)', async () => {
    // A completion-deferred text (not this invoice's own held SMS leg) is
    // never adoptable — it always refuses, whether or not the caller is
    // authorized to adopt its OWN leg.
    smsLog = makeSmsLogTable([{
      id: 'sms-completion-1',
      status: 'scheduled',
      scheduled_for: ORIGINAL_SCHEDULED_FOR,
      metadata: { entry_point: 'dispatch_completion_deferred', invoice_id: 'inv-1' },
    }]);
    db.mockImplementation((table) => {
      if (table === 'invoices') return invoices.query();
      if (table === 'sms_log') return smsLog.query();
      if (table === 'customers') return customerQuery(customer);
      if (table === 'activity_log') return passthroughQuery();
      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toMatchObject({ code: 'queued_pay_link' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Refused before ever claiming — the invoice never left 'draft'.
    expect(invoices.state()).toMatchObject({ status: 'draft', send_claim_token: null });
  });
  // The combined send (sendViaSMSAndEmail) discharges an adopted queued
  // pay-link text by the SMS leg's OWN outcome, never by email success or
  // the combined `ok`: email says nothing about whether the customer's
  // ORIGINAL queued text is still owed (round-0 audit, commit 5ca48b748e).
  describe("sendViaSMSAndEmail settles the adopted queued SMS by the SMS leg's own outcome, not the combined result", () => {
    test('email-only delivery gives back the adopted queued SMS', async () => {
      // The SMS leg fails DEFINITELY (not_sent, no hold/defer code) while
      // the email leg delivers — email success must not discharge the
      // customer's original queued text; it goes back under the claim
      // before finalize clears the token.
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
        withProviderHandoff(async () => ({
          sent: false, blocked: true, deliveryOutcome: 'not_sent',
          code: 'PROVIDER_REJECTED', reason: 'number opted out',
        }))
      ));
      sendInvoiceEmail.mockResolvedValueOnce({ ok: true });

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: true, sms: { ok: false }, email: { ok: true } });
      // The invoice still finalizes sent — one delivered channel is enough.
      expect(invoices.state()).toMatchObject({ status: 'sent', send_claim_token: null });
      // But the queued text the SMS leg's own failure never delivered is
      // handed back exactly as it was — not silently dropped.
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('scheduled');
      expect(row.scheduled_for).toEqual(ORIGINAL_SCHEDULED_FOR);
      expect(row.metadata.cancelled_reason).toBeUndefined();
      expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
    });

    test('a provider-accepted SMS leg resolves the adopted row instead of restoring it', async () => {
      // The SMS leg itself is provider-accepted this time — its own outcome
      // discharges the adopted text; the row is never given back.
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
        withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'accepted' }))
      ));
      sendInvoiceEmail.mockResolvedValueOnce({ ok: true });

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: true, sms: { ok: true }, email: { ok: true } });
      expect(invoices.state()).toMatchObject({ status: 'sent', send_claim_token: null });
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('cancelled');
      expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
      expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
      expect(row.metadata.adoption_resolved_at).toEqual(expect.any(String));
    });

    test('a queued replacement discharges the adopted SMS instead of restoring it', async () => {
      // The SMS leg is held (quiet hours) and requeues a REPLACEMENT text on
      // the scheduled rail (sms.scheduled = true) — that replacement now
      // owns delivery, so the ORIGINAL adopted row must be resolved
      // (discharged), never restored: restoring it too would leave TWO
      // scheduled copies of the same pay link.
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
        withProviderHandoff(async () => ({
          sent: false, blocked: true, deferred: true,
          code: 'QUIET_HOURS_HOLD', reason: 'outside send window',
          nextAllowedAt: '2026-09-12T12:00:00.000Z',
        }))
      ));
      sendInvoiceEmail.mockResolvedValueOnce({ ok: false, error: 'SMTP rejected' });

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: false, sms: { ok: false, scheduled: true }, email: { ok: false } });
      // The invoice claim gave back to its previous status — no channel
      // delivered, so nothing here is finalized.
      expect(invoices.state()).toMatchObject({ status: 'draft', send_claim_token: null });
      // Exactly one 'scheduled' row remains for this invoice: the
      // replacement — the original was consumed by the adoption and is
      // never re-scheduled behind its own replacement.
      const scheduledRows = smsLog.rows().filter((r) => (
        r.status === 'scheduled' && r.metadata.invoice_id === 'inv-1'
      ));
      expect(scheduledRows).toHaveLength(1);
      expect(scheduledRows[0].id).not.toBe('sms-queued-1');
      const original = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(original.status).toBe('cancelled');
      expect(original.metadata.cancelled_reason).toBe('superseded_by_live_send');
      expect(original.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
      expect(original.metadata.adoption_resolved_at).toEqual(expect.any(String));
    });
  });

  // Round-0 audit P1s (commit 1b536dff1b): a scheduled invoice_send_deferred
  // row the stale-finalization sweep re-queued with finalize_only already
  // reached the provider — it is delivered-but-unfinalized work, not an
  // unsent text, so it blocks adoption like any other live queue and is
  // never consumed. And once the provider has accepted (or credit settled
  // the invoice), a failed queue-resolution UPDATE must never turn that
  // delivered send into a reported failure — it is logged and surfaced as
  // queueResolutionError on an otherwise-successful result instead.
  describe('finalize-only rows and post-delivery resolution failures (commit 1b536dff1b)', () => {
    test('a finalize-only scheduled row blocks adoption and is never consumed', async () => {
      smsLog = makeSmsLogTable([{
        id: 'sms-finalize-only-1',
        status: 'scheduled',
        scheduled_for: ORIGINAL_SCHEDULED_FOR,
        metadata: {
          entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT,
          invoice_id: 'inv-1',
          finalize_only: true,
        },
      }]);
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      // Explicit (not leftover from a prior test's mock state): if the
      // refusal below did NOT happen, this would let the send go on to
      // deliver — making a regression here fail loudly instead of
      // coincidentally matching on stale sendCustomerMessage behavior.
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
        withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'accepted' }))
      ));

      await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toMatchObject({ code: 'queued_pay_link' });

      expect(sendCustomerMessage).not.toHaveBeenCalled();
      // Refused before ever claiming — the invoice never left 'draft', let
      // alone got stranded under 'sending'.
      expect(invoices.state()).toMatchObject({ status: 'draft', send_claim_token: null });
      const row = smsLog.rows().find((r) => r.id === 'sms-finalize-only-1');
      expect(row.status).toBe('scheduled');
      expect(row.metadata.finalize_only).toBe(true);
      expect(row.metadata.cancelled_reason).toBeUndefined();
    });

    test('a failed resolution after provider acceptance keeps the send successful', async () => {
      smsLog = makeSmsLogTable(
        [{
          id: 'sms-queued-1',
          status: 'scheduled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
        }],
        { failResolve: true },
      );
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
        withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'accepted' }))
      ));

      const result = await InvoiceService.sendViaSMS('inv-1');

      // The provider-accepted send is still reported as delivered — a
      // bookkeeping failure on the adopted queue row must never read back
      // as a failed SMS the caller could offer to resend.
      expect(result).toMatchObject({ sent: true, queueResolutionError: expect.stringContaining('injected') });
      expect(invoices.state()).toMatchObject({ status: 'sent', send_claim_token: null });
      // The adopted row is left exactly as consumeQueuedInvoiceSend put it
      // — cancelled, still pending — never restored to 'scheduled' on top
      // of a text the provider already accepted.
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('cancelled');
      expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
      expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBe(true);
    });
    test('a failed resolution after a delivered SMS keeps the combined send successful', async () => {
      // Same injection as the sendViaSMS case, but through the WRAPPER:
      // sendViaSMSAndEmail owns the claim and its own post-delivery
      // resolution call must go through the same guarded helper — a
      // resolution failure here must not reject the combined send (which
      // would strand the invoice mid-delivery and invite a duplicate
      // resend) once the SMS leg has actually delivered.
      smsLog = makeSmsLogTable(
        [{
          id: 'sms-queued-1',
          status: 'scheduled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
        }],
        { failResolve: true },
      );
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
        withProviderHandoff(async () => ({ sent: true, deliveryOutcome: 'accepted' }))
      ));
      sendInvoiceEmail.mockResolvedValueOnce({ ok: true });

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({
        ok: true, sms: { ok: true }, queueResolutionError: expect.stringContaining('injected'),
      });
      expect(invoices.state()).toMatchObject({ status: 'sent', send_claim_token: null });
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('cancelled');
      expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
      expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBe(true);
    });
    test('a failed restore after an email-only delivery retains the claim for review', async () => {
      // Same shape as 'email-only delivery gives back the adopted queued
      // SMS' — SMS leg definitely fails, email leg delivers — but the
      // restore of the adopted queued row itself now fails. Finalizing
      // here would clear the claim and lose the only automatic recovery
      // path for the customer's cancelled text; the wrapper must instead
      // hold the claim exactly like a post-delivery bookkeeping failure.
      smsLog = makeSmsLogTable(
        [{
          id: 'sms-queued-1',
          status: 'scheduled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
        }],
        { failRestore: true },
      );
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
        withProviderHandoff(async () => ({
          sent: false, blocked: true, deliveryOutcome: 'not_sent',
          code: 'PROVIDER_REJECTED', reason: 'number opted out',
        }))
      ));
      sendInvoiceEmail.mockResolvedValueOnce({ ok: true });

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({
        ok: true, sms: { ok: false }, email: { ok: true },
        code: 'ADOPTED_QUEUE_RESTORE_FAILED', deliveryHeld: true,
      });
      // NOT finalized — the claim is retained exactly as a post-delivery
      // bookkeeping failure would leave it, so stale-claim recovery parks
      // it for operator review instead of silently losing the text.
      const finalState = invoices.state();
      expect(finalState.status).toBe('sending');
      expect(finalState.send_claim_token).toEqual(expect.any(String));
      expect(finalState.sent_at).toBeUndefined();
      // The adopted row is left exactly as consumeQueuedInvoiceSend put it
      // — cancelled, still pending — so the operator's resend can re-adopt
      // it through the normal chokepoint.
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('cancelled');
      expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
      expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBe(true);
    });
    test('a row fenced by an earlier episode is never re-scheduled by a later definite failure', async () => {
      // 'sms-older-fence' is a row a PRIOR episode already adopted and
      // fenced before its own provider handoff, then crashed before either
      // restoring or resolving it (the QUEUE_ADOPTION_PENDING_KEY marker is
      // exactly that unresolved-crash evidence). It is still re-adoptable
      // (consumeQueuedInvoiceSend matches cancelled+pending rows too), but
      // its OLD fence must survive being re-consumed: only that OLDER
      // episode ever knew whether its own provider handoff delivered it.
      // 'sms-own-fence' carries THIS new episode's own (predictable) token
      // instead, to prove the SAME failure restores a row fenced by itself.
      jest.spyOn(require('crypto'), 'randomUUID').mockReturnValueOnce('own-episode-token');
      customer.phone = null;
      smsLog = makeSmsLogTable([
        {
          id: 'sms-older-fence',
          status: 'cancelled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: {
            entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT,
            invoice_id: 'inv-1',
            cancelled_reason: 'superseded_by_live_send',
            [QUEUE_ADOPTION_PENDING_KEY]: true,
            [QUEUE_ADOPTION_HANDOFF_KEY]: 'older-token',
            [QUEUE_ADOPTION_HANDOFF_AT_KEY]: '2026-09-11T11:00:00.000Z',
          },
        },
        {
          id: 'sms-own-fence',
          status: 'cancelled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: {
            entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT,
            invoice_id: 'inv-1',
            cancelled_reason: 'superseded_by_live_send',
            [QUEUE_ADOPTION_PENDING_KEY]: true,
            [QUEUE_ADOPTION_HANDOFF_KEY]: 'own-episode-token',
            [QUEUE_ADOPTION_HANDOFF_AT_KEY]: '2026-09-11T11:05:00.000Z',
          },
        },
      ]);
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'notification_prefs') return customerQuery({});
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });

      await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toThrow('Customer has no phone number');

      // The claim still gave back to 'draft' — a row an earlier episode
      // fenced must never strand THIS send's claim.
      expect(invoices.state()).toMatchObject({ status: 'draft', send_claim_token: null });
      const olderFenced = smsLog.rows().find((r) => r.id === 'sms-older-fence');
      expect(olderFenced.status).toBe('cancelled');
      expect(olderFenced.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBe(true);
      expect(olderFenced.metadata[QUEUE_ADOPTION_HANDOFF_KEY]).toBe('older-token');
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sms-older-fence'));
      // The row fenced with THIS episode's own token IS restored — the same
      // failure that could not touch the other episode's evidence.
      const ownFenced = smsLog.rows().find((r) => r.id === 'sms-own-fence');
      expect(ownFenced.status).toBe('scheduled');
      expect(ownFenced.metadata[QUEUE_ADOPTION_HANDOFF_KEY]).toBeUndefined();
      expect(ownFenced.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
    });

    test('a fence write failure aborts before the provider and restores the row', async () => {
      smsLog = makeSmsLogTable(
        [{
          id: 'sms-queued-1',
          status: 'scheduled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
        }],
        { failFence: true },
      );
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });

      await expect(InvoiceService.sendViaSMS('inv-1')).rejects.toThrow('sms_log fence update failed (injected)');

      // Pre-provider: the fence write throwing must never reach the provider.
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      // Never fenced, so it goes back exactly like any other pre-provider
      // failure — same id, same schedule.
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('scheduled');
      expect(row.scheduled_for).toEqual(ORIGINAL_SCHEDULED_FOR);
      expect(row.metadata[QUEUE_ADOPTION_HANDOFF_KEY]).toBeUndefined();
      expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
      expect(invoices.state()).toMatchObject({ status: 'draft', send_claim_token: null });
    });

    test('a credit-covered send (sendViaSMSAndEmail) resolves the adopted rows before clearing the token', async () => {
      const order = [];
      invoices = makeInvoicesTable({
        id: 'inv-1',
        invoice_number: 'WPC-2026-2001',
        status: 'draft',
        customer_id: 'cust-1',
        payer_id: null,
        token: 'tok-1',
        total: 100,
        credit_applied: 0,
        send_claim_token: null,
      }, {
        onUpdate: (payload) => { if (payload.send_claim_token === null) order.push('invoice_token_clear'); },
      });
      smsLog = makeSmsLogTable([{
        id: 'sms-queued-1',
        status: 'scheduled',
        scheduled_for: ORIGINAL_SCHEDULED_FOR,
        metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
      }], {
        onUpdate: (payload) => {
          if (payload.metadata && payload.metadata.__sqlRaw && payload.metadata.__sqlRaw.includes('adoption_resolved_at')) {
            order.push('sms_resolve');
          }
        },
      });
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ fullyCovered: true, applied: 100 });

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(result).toMatchObject({ ok: true, covered_by_credit: true });
      // The resolve ran while the token still owned the row — BEFORE it was
      // cleared, or the resolve's own ownership check would have silently
      // no-op'd against an already-cleared claim.
      expect(order).toEqual(['sms_resolve', 'invoice_token_clear']);
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('cancelled');
      expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
      expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBeUndefined();
      expect(row.metadata.adoption_resolved_at).toEqual(expect.any(String));
    });

    test('a credit-covered send (direct sendViaSMS) resolves the adopted rows before clearing the token', async () => {
      const order = [];
      invoices = makeInvoicesTable({
        id: 'inv-1',
        invoice_number: 'WPC-2026-2001',
        status: 'draft',
        customer_id: 'cust-1',
        payer_id: null,
        token: 'tok-1',
        total: 100,
        credit_applied: 0,
        send_claim_token: null,
      }, {
        onUpdate: (payload) => { if (payload.send_claim_token === null) order.push('invoice_token_clear'); },
      });
      smsLog = makeSmsLogTable([{
        id: 'sms-queued-1',
        status: 'scheduled',
        scheduled_for: ORIGINAL_SCHEDULED_FOR,
        metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
      }], {
        onUpdate: (payload) => {
          if (payload.metadata && payload.metadata.__sqlRaw && payload.metadata.__sqlRaw.includes('adoption_resolved_at')) {
            order.push('sms_resolve');
          }
        },
      });
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ fullyCovered: true, applied: 100 });

      const result = await InvoiceService.sendViaSMS('inv-1');

      expect(result).toMatchObject({ sent: false, ok: true, covered_by_credit: true });
      expect(order).toEqual(['sms_resolve', 'invoice_token_clear']);
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('cancelled');
      expect(row.metadata.adoption_resolved_at).toEqual(expect.any(String));
    });
    test('an unrestorable adopted text after a total failure holds the preclaimed send instead of failing it', async () => {
      // Preclaimed: processScheduledSends already flipped the invoice to
      // 'sending' and hands sendViaSMSAndEmail the exact token — this
      // exercises the NO-CHANNEL-DELIVERED branch (both legs fail), not
      // the email-only-delivery branch the earlier restore-failure test
      // above covers.
      invoices.reset({
        id: 'inv-1',
        invoice_number: 'WPC-2026-2001',
        status: 'sending',
        customer_id: 'cust-1',
        payer_id: null,
        token: 'tok-1',
        total: 100,
        credit_applied: 0,
        send_claim_token: 'claim-1',
      });
      smsLog = makeSmsLogTable(
        [{
          id: 'sms-queued-1',
          status: 'scheduled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
        }],
        { failRestore: true },
      );
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      sendCustomerMessage.mockImplementation(async ({ withProviderHandoff }) => (
        withProviderHandoff(async () => ({
          sent: false, blocked: true, deliveryOutcome: 'not_sent',
          code: 'PROVIDER_REJECTED', reason: 'number opted out',
        }))
      ));
      sendInvoiceEmail.mockResolvedValueOnce({ ok: false, error: 'SMTP rejected' });

      const result = await InvoiceService.sendViaSMSAndEmail('inv-1', {
        allowClaimed: true, claimToken: 'claim-1',
      });

      expect(result).toMatchObject({
        ok: false, sms: { ok: false }, email: { ok: false },
        code: 'ADOPTED_QUEUE_RESTORE_FAILED', deliveryHeld: true,
      });
      // Never touched — the queue-restore threw before restoreSendClaim
      // could even consider moving the invoice row.
      expect(invoices.state()).toMatchObject({ status: 'sending', send_claim_token: 'claim-1' });
      const row = smsLog.rows().find((r) => r.id === 'sms-queued-1');
      expect(row.status).toBe('cancelled');
      expect(row.metadata.cancelled_reason).toBe('superseded_by_live_send');
      expect(row.metadata[QUEUE_ADOPTION_PENDING_KEY]).toBe(true);
    });

    test('a credit-covered send surfaces a failed adopted-row resolution', async () => {
      smsLog = makeSmsLogTable(
        [{
          id: 'sms-queued-1',
          status: 'scheduled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
        }],
        { failResolve: true },
      );
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ fullyCovered: true, applied: 100 });

      const wrapperResult = await InvoiceService.sendViaSMSAndEmail('inv-1');

      expect(wrapperResult).toMatchObject({
        ok: true, covered_by_credit: true, queueResolutionError: expect.stringContaining('injected'),
      });

      // Same guarantee through the direct sendViaSMS credit-covered branch
      // — fresh invoice/queue state, same injected resolution failure.
      invoices.reset({
        id: 'inv-1',
        invoice_number: 'WPC-2026-2001',
        status: 'draft',
        customer_id: 'cust-1',
        payer_id: null,
        token: 'tok-1',
        total: 100,
        credit_applied: 0,
        send_claim_token: null,
      });
      smsLog = makeSmsLogTable(
        [{
          id: 'sms-queued-2',
          status: 'scheduled',
          scheduled_for: ORIGINAL_SCHEDULED_FOR,
          metadata: { entry_point: INVOICE_SEND_DEFERRED_ENTRY_POINT, invoice_id: 'inv-1' },
        }],
        { failResolve: true },
      );
      db.mockImplementation((table) => {
        if (table === 'invoices') return invoices.query();
        if (table === 'sms_log') return smsLog.query();
        if (table === 'customers') return customerQuery(customer);
        if (table === 'activity_log') return passthroughQuery();
        throw new Error(`Unexpected table: ${table}`);
      });
      autoApplyAccountCreditIfEnabled.mockResolvedValueOnce({ fullyCovered: true, applied: 100 });

      const directResult = await InvoiceService.sendViaSMS('inv-1');

      expect(directResult).toMatchObject({
        sent: false, ok: true, covered_by_credit: true, queueResolutionError: expect.stringContaining('injected'),
      });
    });
  });
});
