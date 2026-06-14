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
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      del: jest.fn(() => {
        if (table === 'service_products') store.productDeletes = (store.productDeletes || 0) + 1;
        return Promise.resolve(1);
      }),
    };

    q.first = jest.fn(async () => {
      if (table === 'scheduled_services') return { id: SERVICE_ID, status: store.serviceStatus };
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
      if (table === 'service_products') store.productInserts = (store.productInserts || 0) + 1;
      return { returning: jest.fn().mockResolvedValue([]) };
    });

    q.update = jest.fn((patch) => {
      if (table === 'service_records' && store.records.length) {
        const rec = store.records[store.records.length - 1];
        if (Object.prototype.hasOwnProperty.call(patch, 'recap_sms_sent_at')) {
          rec.recap_sms_sent_at = patch.recap_sms_sent_at;
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

  knex.transaction = jest.fn(async (cb) => {
    const result = await cb(knex);
    // First successful completion flips live status to terminal, like the
    // real transitionJobStatus would.
    store.serviceStatus = 'completed';
    return result;
  });

  return knex;
}

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
});
