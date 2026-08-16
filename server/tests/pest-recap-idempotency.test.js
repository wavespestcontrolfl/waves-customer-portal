/**
 * Codex P1 (PR #1405): the pest-control Service Recap submit path must be
 * idempotent under concurrency. A double-tap / browser retry / admin+tech
 * race must not duplicate the service_records row or text the customer
 * twice.
 *
 * The fix has two parts, both exercised here against a table-dispatching
 * knex mock:
 *   1. A FOR UPDATE lock on the parent scheduled_services row serializes
 *      concurrent submits, so the second one sees the first's committed
 *      service_records row and UPDATES it instead of inserting a duplicate.
 *   2. recap_sms_sent_at is claimed inside that locked transaction, so only
 *      the first submit sends the recap SMS; a submit that finds the column
 *      already set skips the send.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn().mockResolvedValue() }));
jest.mock('../services/track-transitions', () => ({
  markComplete: jest.fn().mockResolvedValue({ ok: true }),
  isFutureScheduledDate: jest.fn(() => false),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }),
}));
jest.mock('../services/completion-recap', () => ({
  ...jest.requireActual('../services/completion-recap'),
  generateRecap: jest.fn().mockResolvedValue({ recap: 'Service complete.', source: 'test' }),
}));
jest.mock('../services/service-completion-profiles', () => ({
  resolveCompletionProfileForScheduledService: jest.fn().mockResolvedValue({ category: 'pest_control' }),
}));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-05-29' }));
// The FDACS writer is its own unit (compliance-ledger.test.js) — here we
// only assert the recap invokes it in-trx after the product replace.
jest.mock('../services/compliance', () => ({
  createComplianceRecords: jest.fn().mockResolvedValue([]),
}));

const { transitionJobStatus } = require('../services/job-status');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { submitRecap } = require('../services/pest-recap');

const SERVICE_ID = 'svc-1';
const CUSTOMER = {
  id: SERVICE_ID,
  customer_id: 'cust-1',
  technician_id: null,
  service_type: 'Quarterly Pest Control',
  status: 'scheduled',
  scheduled_date: '2026-05-29',
  first_name: 'Pat',
  last_name: 'Jones',
  cust_phone: '+19415551234',
};

/**
 * Build a knex mock backed by an in-memory store, so two submitRecap calls
 * sharing it behave like two transactions against the same DB.
 *
 * store.serviceStatus   — scheduled_services.status (FOR UPDATE re-read)
 * store.records         — service_records rows (the dedup target)
 */
function makeKnex(store) {
  function tableApi(table) {
    const q = {
      _table: table,
      where: jest.fn(function where(...args) {
        q._where = args;
        return q;
      }),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn(function whereNotIn(col, vals) {
        q._whereNotIn = { col, vals };
        return q;
      }),
      whereIn: jest.fn(function whereIn(col, vals) {
        q._whereIn = { col, vals };
        return q;
      }),
      whereRaw: jest.fn(function whereRaw(...args) {
        q._whereRaw = args;
        return q;
      }),
      orderBy: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      // The preserve-prior-rate lookup reads the existing service_products
      // rows; a test opts in by seeding store.priorProductRows.
      select: table === 'service_products'
        ? jest.fn(() => Promise.resolve(store.priorProductRows || []))
        // The legacy product-less ledger capture — a test opts in by
        // seeding store.legacyLedgerRows.
        : table === 'property_application_history'
          ? jest.fn(() => Promise.resolve(store.legacyLedgerRows || []))
          : jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      del: jest.fn(() => {
        if (table === 'service_products') {
          store.productDeletes = (store.productDeletes || 0) + 1;
          store.productDeleteScopes = (store.productDeleteScopes || []).concat([
            q._whereRaw ? { partial: true, names: q._whereRaw[1] } : { partial: false },
          ]);
        }
        if (table === 'property_application_history') {
          store.ledgerDeletes = store.ledgerDeletes || [];
          store.ledgerDeletes.push({ where: q._where?.[0], notIn: q._whereNotIn || null });
        }
        return Promise.resolve(1);
      }),
    };

    q.first = jest.fn(async () => {
      if (table === 'scheduled_services') return { id: SERVICE_ID, status: store.serviceStatus };
      // The ledger-sync catalog resolution (name ilike) — a test opts in
      // by seeding store.catalogRow.
      if (table === 'products_catalog') return store.catalogRow;
      if (table === 'service_records') {
        const latest = store.records[store.records.length - 1];
        return latest
          ? {
            id: latest.id,
            recap_sms_sent_at: latest.recap_sms_sent_at,
            structured_notes: latest.structured_notes || null,
          }
          : undefined;
      }
      return undefined;
    });

    q.insert = jest.fn((row) => {
      if (table === 'service_records') {
        const id = `rec-${store.records.length + 1}`;
        store.records.push({ id, recap_sms_sent_at: row.recap_sms_sent_at || null });
        return { returning: jest.fn().mockResolvedValue([{ id }]) };
      }
      if (table === 'service_products') {
        store.productInserts = (store.productInserts || 0) + 1;
        const rows = Array.isArray(row) ? row : [row];
        store.productRows = (store.productRows || []).concat(rows);
        // The ledger sync reads the inserted rows back (with ids).
        const returned = rows.map((r, i) => ({
          id: `sp-${(store.productRows || []).length - rows.length + i + 1}`,
          product_name: r.product_name,
          application_rate: r.application_rate ?? null,
          rate_unit: r.rate_unit ?? null,
        }));
        return { returning: jest.fn().mockResolvedValue(returned) };
      }
      return { returning: jest.fn().mockResolvedValue([]) };
    });

    q.update = jest.fn((patch) => {
      if (table === 'property_application_history') {
        store.ledgerUpdates = store.ledgerUpdates || [];
        store.ledgerUpdates.push({
          where: q._where?.[0], notIn: q._whereNotIn || null, whereIn: q._whereIn || null, patch,
        });
      }
      if (table === 'service_records') {
        store.recordUpdates = store.recordUpdates || [];
        store.recordUpdates.push(patch);
        if (store.records.length) {
          const rec = store.records[store.records.length - 1];
          if (Object.prototype.hasOwnProperty.call(patch, 'recap_sms_sent_at')) {
            rec.recap_sms_sent_at = patch.recap_sms_sent_at;
          }
        }
      }
      // Support both `await update(...)` and `update(...).catch(...)` (the
      // claim-release path).
      return Object.assign(Promise.resolve(1), { catch: () => Promise.resolve(1) });
    });

    return q;
  }

  const knex = jest.fn((table) => {
    if (table === 'scheduled_services') {
      const base = tableApi('scheduled_services');
      // loadServiceWithCustomer joins customers and reads the full row.
      base.first = jest.fn(async () => CUSTOMER);
      // The in-transaction FOR UPDATE lock re-reads live status.
      base.forUpdate = jest.fn(() => ({
        first: jest.fn(async () => ({
          id: SERVICE_ID,
          status: store.serviceStatus,
          // Lock-time scheduled_date — lets a test simulate a reschedule
          // committing while this submit waited on the lock.
          scheduled_date: store.lockedScheduledDate || CUSTOMER.scheduled_date,
        })),
      }));
      return base;
    }
    return tableApi(table);
  });

  knex.schema = { hasColumn: jest.fn().mockResolvedValue(true) };

  knex.transaction = jest.fn(async (cb) => {
    const result = await cb(knex);
    // First successful completion flips live status to terminal, like the
    // real transitionJobStatus would.
    store.serviceStatus = 'completed';
    return result;
  });

  return knex;
}

// The ledger receives two kinds of updates: per-row re-link syncs (carry
// service_product_id) and the deselection retraction sweep.
const syncUpdates = (store) => (store.ledgerUpdates || []).filter((u) => 'service_product_id' in u.patch);
const retractionSweeps = (store) => (store.ledgerUpdates || []).filter((u) => u.patch.retraction_reason === 'recap_deselected');

describe('pest recap idempotency (Codex P1)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a second submit updates the same record and does not re-text the customer', async () => {
    const store = { serviceStatus: 'scheduled', records: [] };
    const knex = makeKnex(store);

    const args = {
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Treated kitchen + garage.',
      products: [{ product_name: 'Termidor' }],
      customerRecap: 'Service complete.',
      sendSms: true,
      knex,
    };

    const first = await submitRecap(args);
    const second = await submitRecap(args);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Exactly one service_records row across both submits.
    expect(store.records).toHaveLength(1);
    // The text went out exactly once.
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(first.smsSent).toBe(true);
    expect(second.smsSent).toBe(false);
    expect(second.smsError).toBe('duplicate_suppressed');
    // Both reference the same record.
    expect(second.recordId).toBe(first.recordId);
  });

  test('a recap that did not text can still send later (complete-now, text-later)', async () => {
    // Pre-existing completed record with a NULL claim (e.g. completed via
    // the heavy /complete path, or a recap saved without texting).
    const store = { serviceStatus: 'completed', records: [{ id: 'rec-old', recap_sms_sent_at: null }] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'admin',
      actorId: null,
      technicianNotes: 'Texting the customer now.',
      products: [],
      customerRecap: 'Service complete.',
      sendSms: true,
      knex,
    });

    expect(result.ok).toBe(true);
    // Terminal status -> no transition attempted, but the text still sends.
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.smsSent).toBe(true);
    // No duplicate record created.
    expect(store.records).toHaveLength(1);
  });

  test('a recap after a /complete that already texted is suppressed (cross-path double-text)', async () => {
    // The heavy /complete flow already sent its templated completion SMS
    // (structured_notes claim). A recap re-text on top would be the
    // "two different wordings of the same message" customer complaint.
    const store = {
      serviceStatus: 'completed',
      records: [{
        id: 'rec-complete',
        recap_sms_sent_at: null,
        structured_notes: JSON.stringify({
          completionSmsStatus: 'sent',
          sentSmsBody: 'Hi Pat! Your Quarterly Pest Control service is complete.',
        }),
      }],
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Treated kitchen + garage.',
      products: [],
      customerRecap: 'Service complete.',
      sendSms: true,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(result.smsSent).toBe(false);
    expect(result.smsError).toBe('completion_sms_already_sent');
    // Still no duplicate record — the recap updates the /complete row.
    expect(store.records).toHaveLength(1);
  });

  test('a recap during a fresh in-flight completion SMS is suppressed (sending window)', async () => {
    // /complete writes completionSmsStatus 'sending' before the provider
    // call. A recap landing in that window must not text — the in-flight
    // completion SMS will most likely deliver.
    const store = {
      serviceStatus: 'completed',
      records: [{
        id: 'rec-complete',
        recap_sms_sent_at: null,
        structured_notes: JSON.stringify({
          completionSmsStatus: 'sending',
          completionSmsAttemptedAt: new Date().toISOString(),
        }),
      }],
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Treated kitchen + garage.',
      products: [],
      customerRecap: 'Service complete.',
      sendSms: true,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(result.smsSent).toBe(false);
    expect(result.smsError).toBe('completion_sms_already_sent');
  });

  test('a stale completion SMS "sending" claim (crashed mid-send) does not suppress the recap', async () => {
    // Mirrors /complete's own completionSmsSendingFresh guard: a 'sending'
    // older than 10 minutes is treated as retryable, not delivered.
    const store = {
      serviceStatus: 'completed',
      records: [{
        id: 'rec-complete',
        recap_sms_sent_at: null,
        structured_notes: JSON.stringify({
          completionSmsStatus: 'sending',
          completionSmsAttemptedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
        }),
      }],
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Texting the customer now.',
      products: [],
      customerRecap: 'Service complete.',
      sendSms: true,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(result.smsSent).toBe(true);
  });

  test('a cancelled visit is rejected — no record, no track-complete, no SMS', async () => {
    const store = { serviceStatus: 'cancelled', records: [] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'admin',
      actorId: null,
      technicianNotes: 'Should not be written.',
      products: [{ product_name: 'Termidor' }],
      customerRecap: 'Service complete.',
      sendSms: true,
      knex,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('service_cancelled');
    // No completed artifacts emitted for a cancelled visit.
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a reschedule committing while the submit waits on the row lock rejects the recap (TOCTOU)', async () => {
    // Pre-lock read sees today's date; by the time the FOR UPDATE lock is
    // acquired, a staff live-reschedule has moved the visit to a future
    // day. The under-lock re-check must reject before any artifact.
    const trackTransitions = require('../services/track-transitions');
    trackTransitions.isFutureScheduledDate.mockImplementation((d) => d === '2099-01-01');
    const store = { serviceStatus: 'scheduled', records: [], lockedScheduledDate: '2099-01-01' };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Should not be written.',
      products: [{ product_name: 'Termidor' }],
      customerRecap: 'Service complete.',
      sendSms: true,
      knex,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('future_scheduled_date');
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    trackTransitions.isFutureScheduledDate.mockImplementation(() => false);
  });

  test('re-sending a recap with no products selected preserves recorded chemicals', async () => {
    // Existing completed record (e.g. reopened to re-send the text). The
    // modal starts with no products selected, so the submit carries none.
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      productDeletes: 0,
      productInserts: 0,
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Re-sending the recap.',
      products: [],
      customerRecap: 'Service complete.',
      sendSms: true,
      knex,
    });

    expect(result.ok).toBe(true);
    // Empty product submit must NOT touch service_products — history intact.
    expect(store.productDeletes).toBe(0);
    expect(store.productInserts).toBe(0);
  });

  test('re-completing an existing record invalidates its cached report PDF', async () => {
    // The record was already completed (e.g. via the heavy /complete path,
    // which rendered + cached a PDF). Re-running the recap rewrites the
    // technician notes / products the report renders, so the stale cached PDF
    // must be dropped (pdf_storage_key -> null) for a fresh render on next view.
    const store = { serviceStatus: 'completed', records: [{ id: 'rec-old', recap_sms_sent_at: null }] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Re-treated the garage and updated the recap.',
      products: [{ product_name: 'Termidor' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect((store.recordUpdates || []).some((patch) => patch.pdf_storage_key === null)).toBe(true);
  });

  test('an edited rate syncs the compliance ledger row and re-links it (codex P1 r7)', async () => {
    // The visit was previously completed through /complete, which ledgered
    // its applications in property_application_history. The recap replace
    // (delete + insert) SET-NULLs the ledger's service_product_id link, so
    // the sync must re-link the replacement row AND carry the edited rate
    // into the ledger — the DACS export and application-limit caps read
    // the ledger, not service_products.
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: { id: 'cat-termidor' },
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Corrected the recorded rate.',
      products: [{ product_name: 'Termidor', application_rate: '0.8', rate_unit: 'fl_oz/gal' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    const syncs = syncUpdates(store);
    expect(syncs).toHaveLength(1);
    const { where, patch } = syncs[0];
    expect(where).toEqual({ service_record_id: 'rec-old', product_id: 'cat-termidor' });
    expect(patch.application_rate).toBe(0.8);
    expect(patch.rate_unit).toBe('fl_oz/gal');
    expect(patch.service_product_id).toBe('sp-1');
    // A re-link also clears any prior retraction of this row.
    expect(patch.retracted_at).toBeNull();
    expect(patch.retraction_reason).toBeNull();
  });

  test('a rate-less replacement row re-links the ledger without touching its rate', async () => {
    // Older client / API caller re-submitting with no rate and no prior
    // recorded rate: absence must never erase the ledger's observed value.
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: { id: 'cat-termidor' },
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'admin',
      actorId: 'admin-1',
      technicianNotes: 'Re-saved without a rate.',
      products: [{ product_name: 'Termidor' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    const syncs = syncUpdates(store);
    expect(syncs).toHaveLength(1);
    const { patch } = syncs[0];
    expect(patch.service_product_id).toBe('sp-1');
    expect(patch).not.toHaveProperty('application_rate');
    expect(patch).not.toHaveProperty('rate_unit');
  });

  test('a submitted catalog id is validated, persisted, and keys the ledger exactly (codex P1 r9)', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: { id: 'cat-exact' },
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Exact catalog identity.',
      products: [{ product_id: 'cat-exact', product_name: 'Advion Cockroach Gel', application_rate: '0.5', rate_unit: 'g/spot', rate_confirmed: true }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    // The validated id lands on the service_products row (exact-ID path in
    // the FDACS writer) and keys the ledger sync — no name-pattern match.
    expect(store.productRows[0].product_id).toBe('cat-exact');
    const syncs = syncUpdates(store);
    expect(syncs).toHaveLength(1);
    expect(syncs[0].where).toEqual({ service_record_id: 'rec-old', product_id: 'cat-exact' });
  });

  test('recap metadata binds to the validated catalog row, not caller-supplied fields (codex P1 r10)', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: {
        id: 'cat-exact', name: 'Advion Cockroach Gel Bait', category: 'Bait',
        active_ingredient: 'Indoxacarb', moa_group: '22A', application_method: 'bait_placement',
      },
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Stale caller metadata.',
      products: [{ product_id: 'cat-exact', product_name: 'Advion Cockroach Gel', product_category: 'Wrong', active_ingredient: 'Wrong AI', rate_confirmed: true }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    const row = store.productRows[0];
    expect(row.product_name).toBe('Advion Cockroach Gel Bait');
    expect(row.product_category).toBe('Bait');
    expect(row.active_ingredient).toBe('Indoxacarb');
    expect(row.moa_group).toBe('22A');
    expect(row.application_method).toBe('bait_placement');
  });

  test('a CONFIRMED cleared rate is not restored and clears the ledger rate (codex P1 r9)', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: { id: 'cat-termidor' },
      // Prior recorded rate that a legacy omission WOULD restore.
      priorProductRows: [{ product_name: 'Termidor', application_rate: 0.8, rate_unit: 'fl_oz/gal' }],
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Cleared a wrong rate.',
      products: [{ product_name: 'Termidor', rate_confirmed: true }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    // The deliberate clear survives: no prior-rate restore on the row…
    expect(store.productRows[0].application_rate).toBeUndefined();
    // …and the ledger rate is cleared with it (still re-linked).
    const syncs = syncUpdates(store);
    expect(syncs).toHaveLength(1);
    expect(syncs[0].patch).toEqual({
      service_product_id: 'sp-1', retracted_at: null, retraction_reason: null,
      application_rate: null, rate_unit: null,
    });
  });

  test('deselected products are retracted from the ledger (codex P1 r9)', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: { id: 'cat-a' },
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Reselected only product A.',
      products: [{ product_name: 'Product A', application_rate: '1', rate_unit: 'oz', rate_confirmed: true }],
      productsConfirmed: true,
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    // Null-linked ledger rows for catalog products NOT in the replacement
    // set are RETRACTED — never deleted (append-safe ledger, codex P1
    // r10) — in the same trx. Product-less legacy rows survive via the
    // whereNotNull guard.
    expect(store.ledgerDeletes || []).toHaveLength(0);
    const sweeps = retractionSweeps(store);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].where).toEqual({ service_record_id: 'rec-old' });
    expect(sweeps[0].notIn).toEqual({ col: 'product_id', vals: ['cat-a'] });
    expect(sweeps[0].patch.retracted_at).toBeInstanceOf(Date);
  });

  test('a submitted catalog id that does not resolve is REJECTED, not name-matched (codex P1 r11)', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: undefined, // the id resolves to nothing
    };
    const knex = makeKnex(store);

    await expect(submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Stale id.',
      products: [{ product_id: 'gone-id', product_name: 'Ghost Product', rate_confirmed: true }],
      sendSms: false,
      knex,
    })).rejects.toThrow('Product not found: gone-id');
    // The trx rolled back — nothing was replaced.
    expect(store.productInserts || 0).toBe(0);
  });

  test('an unsupported rate unit is rejected before it reaches the ledger (codex P1 r11)', async () => {
    const store = { serviceStatus: 'completed', records: [{ id: 'rec-old', recap_sms_sent_at: null }] };
    const knex = makeKnex(store);

    await expect(submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Typo unit.',
      products: [{ product_name: 'Termidor', application_rate: '4', rate_unit: 'fl-oz/gallon', rate_confirmed: true }],
      sendSms: false,
      knex,
    })).rejects.toThrow('Invalid product unit for Termidor');
    expect(store.productInserts || 0).toBe(0);
  });

  test('a CONFIRMED empty set clears recorded products and retracts their ledger rows (codex P1 r11)', async () => {
    const { createComplianceRecords } = require('../services/compliance');
    const store = { serviceStatus: 'completed', records: [{ id: 'rec-old', recap_sms_sent_at: null }] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Deselected everything.',
      products: [],
      productsConfirmed: true,
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    // The replace ran: rows deleted, nothing inserted, every attributable
    // ledger row swept into retraction (no whereNotIn — nothing linked).
    expect(store.productDeletes).toBe(1);
    expect(store.productInserts || 0).toBe(0);
    const sweeps = retractionSweeps(store);
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0].notIn).toBeNull();
    expect(createComplianceRecords).not.toHaveBeenCalled();
  });

  test('an UNCONFIRMED partial submit replaces only the named rows and never retracts (codex P1 r12)', async () => {
    // A recorded product missing from the active catalog flips
    // productsConfirmed off in the modal; resubmitting the representable
    // subset must not delete the unmatched row or retract its ledger row.
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: { id: 'cat-a' },
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Partial resubmit.',
      products: [{ product_name: 'Product A', application_rate: '1', rate_unit: 'oz', rate_confirmed: true }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    // The delete was scoped to the submitted names — unmatched rows survive.
    expect(store.productDeleteScopes).toEqual([{ partial: true, names: [['product a']] }]);
    // And no retraction sweep ran: absence from an unconfirmed set proves nothing.
    expect(retractionSweeps(store)).toHaveLength(0);
  });

  test('a same-name replacement re-adopts a product-less legacy ledger row (codex P1 r14)', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: undefined, // no catalog match -> no identified-row sync
      legacyLedgerRows: [{ ledger_id: 'led-1', product_name: 'Termidor' }],
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Legacy row adoption.',
      products: [{ product_name: 'Termidor', application_rate: '0.8', rate_unit: 'fl_oz/gal', rate_confirmed: true }],
      productsConfirmed: true,
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    const adoption = (store.ledgerUpdates || []).find((u) => u.where && u.where.id === 'led-1');
    expect(adoption).toBeDefined();
    expect(adoption.patch.service_product_id).toBe('sp-1');
    expect(adoption.patch.application_rate).toBe(0.8);
    // Adopted, so the leftover retraction never targets it.
    expect((store.ledgerUpdates || []).filter((u) => u.whereIn)).toHaveLength(0);
  });

  test('an authoritative clear retracts captured product-less legacy rows (codex P1 r14)', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      legacyLedgerRows: [{ ledger_id: 'led-1', product_name: 'Old Legacy Product' }],
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Cleared everything, legacy row included.',
      products: [],
      productsConfirmed: true,
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    // The sweep can't reach a null-product row — the captured-id pass must.
    const leftover = (store.ledgerUpdates || []).find((u) => u.whereIn);
    expect(leftover).toBeDefined();
    expect(leftover.whereIn).toEqual({ col: 'id', vals: ['led-1'] });
    expect(leftover.patch.retraction_reason).toBe('recap_deselected');
  });

  test('an UNCONFIRMED empty set still preserves recorded products (legacy resend)', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      productDeletes: 0,
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Resend only.',
      products: [],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(store.productDeletes).toBe(0);
    expect(retractionSweeps(store)).toHaveLength(0);
  });

  test('a fresh recap completion runs the FDACS writer so its applications get ledgered (codex P1 r8)', async () => {
    // No prior /complete: there are no ledger rows for the sync UPDATE to
    // hit, so the recap must invoke the shared idempotent writer or the
    // application never reaches the FDACS ledger / application-limit caps.
    const { createComplianceRecords } = require('../services/compliance');
    const store = { serviceStatus: 'scheduled', records: [] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'First-time recap completion.',
      products: [{ product_name: 'Termidor', application_rate: '0.8', rate_unit: 'fl_oz/gal' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(createComplianceRecords).toHaveBeenCalledTimes(1);
    expect(createComplianceRecords).toHaveBeenCalledWith(result.recordId, { trx: knex });
  });

  test('an empty product submit does not invoke the FDACS writer', async () => {
    const { createComplianceRecords } = require('../services/compliance');
    const store = { serviceStatus: 'completed', records: [{ id: 'rec-old', recap_sms_sent_at: null }] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Re-send only.',
      products: [],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(createComplianceRecords).not.toHaveBeenCalled();
  });

  test('a product with no catalog match skips the ledger sync', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-old', recap_sms_sent_at: null }],
      catalogRow: undefined,
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Unmatched product.',
      products: [{ product_name: 'One-off borrowed product', application_rate: '2', rate_unit: 'oz' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(syncUpdates(store)).toHaveLength(0);
  });

  test('a brand-new recap record issues no pdf cache invalidation (nothing cached yet)', async () => {
    const store = { serviceStatus: 'scheduled', records: [] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'First visit.',
      products: [{ product_name: 'Termidor' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    const updates = store.recordUpdates || [];
    expect(updates.some((patch) => patch && Object.prototype.hasOwnProperty.call(patch, 'pdf_storage_key'))).toBe(false);
  });

  // Recap rates are TECHNICIAN-CONFIRMED (codex P1, PR #3419 r5): the modal
  // collects the rate in an editable prefilled field; the server records
  // only a submitted rate, preserves a previously recorded one when a
  // re-submit omits it, and never writes a catalog default as observed.
  test('a submitted rate is recorded as the applied rate', async () => {
    const store = { serviceStatus: 'scheduled', records: [] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Baited kitchen and bath.',
      products: [{ product_name: 'Advion Ant Bait Gel', application_rate: 0.5, rate_unit: 'g/spot' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(store.productRows).toHaveLength(1);
    expect(store.productRows[0].application_rate).toBe(0.5);
    expect(store.productRows[0].rate_unit).toBe('g/spot');
  });

  test('a rate-less re-submit preserves the rate recorded on the visit', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-1', recap_sms_sent_at: null }],
      priorProductRows: [
        { product_name: 'Advion Ant Bait Gel', application_rate: 0.5, rate_unit: 'g/spot' },
      ],
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Re-sent recap.',
      products: [{ product_name: 'Advion Ant Bait Gel' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(store.productRows).toHaveLength(1);
    expect(store.productRows[0].application_rate).toBe(0.5);
    expect(store.productRows[0].rate_unit).toBe('g/spot');
  });

  test('a submitted rate outranks the previously recorded one', async () => {
    const store = {
      serviceStatus: 'completed',
      records: [{ id: 'rec-1', recap_sms_sent_at: null }],
      priorProductRows: [
        { product_name: 'Advion Ant Bait Gel', application_rate: 0.5, rate_unit: 'g/spot' },
      ],
    };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Corrected the applied rate.',
      products: [{ product_name: 'Advion Ant Bait Gel', application_rate: 0.7, rate_unit: 'g/spot' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(store.productRows[0].application_rate).toBe(0.7);
  });

  test('no submitted rate and no prior record keeps a null rate — a catalog default is never fabricated', async () => {
    const store = { serviceStatus: 'scheduled', records: [] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Foam application.',
      products: [{ product_name: 'Termidor Foam' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(store.productRows[0].application_rate).toBeUndefined();
    expect(store.productRows[0].rate_unit).toBeUndefined();
  });

  test('a zero/invalid submitted rate is not recorded', async () => {
    const store = { serviceStatus: 'scheduled', records: [] };
    const knex = makeKnex(store);

    const result = await submitRecap({
      serviceId: SERVICE_ID,
      actorType: 'tech',
      actorId: 'tech-1',
      technicianNotes: 'Cleared the rate field.',
      products: [{ product_name: 'Advion Ant Bait Gel', application_rate: 0, rate_unit: 'g/spot' }],
      sendSms: false,
      knex,
    });

    expect(result.ok).toBe(true);
    expect(store.productRows[0].application_rate).toBeUndefined();
    expect(store.productRows[0].rate_unit).toBeUndefined();
  });
});
