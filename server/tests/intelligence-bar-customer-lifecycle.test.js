/**
 * merge_customers / archive_customer — the two confirmed customer-lifecycle
 * writes added so the Intelligence Bar can merge a duplicate ("Unknown"
 * website stub sharing a phone with a real customer) or retire a stale
 * record outright. Both are #1568 preview→confirmed two-step tools
 * (write-gates.js WRITE_TWO_STEP_TOOL_NAMES): an unconfirmed call is
 * mutation-free and returns the rich preview the confirmation card is built
 * from; only a server-derived confirmed:true (never a model-supplied one)
 * runs the write.
 *
 * db is a small hand-rolled chainable query-builder mock (not the real-knex
 * SQL-capture transport from intelligence-bar-operational-reads.test.js —
 * that transport does not support db.transaction(): knex's postgres
 * transaction dialect calls connection.query() directly, bypassing the
 * overridden _query hook). This mirrors the transaction-friendly db mock
 * established in intelligence-bar-update-customer-address.test.js: `qb`
 * chains, `.first`/`.select`/`.update` are mockable terminals, and
 * `db.transaction` just invokes its callback with the same object as `trx`.
 * customer-dedupe.js (the merge engine) is mocked per the assignment.
 */

jest.mock('../models/db', () => {
  const qb = {};
  qb.where = jest.fn(() => qb);
  qb.whereIn = jest.fn(() => qb);
  qb.whereNull = jest.fn(() => qb);
  qb.whereNotIn = jest.fn(() => qb);
  qb.whereRaw = jest.fn(() => qb);
  qb.forUpdate = jest.fn(() => qb);
  qb.count = jest.fn(() => qb);
  qb.select = jest.fn();
  qb.first = jest.fn();
  qb.update = jest.fn(() => Promise.resolve(1));
  const db = jest.fn(() => qb);
  db.transaction = jest.fn(async (cb) => cb(db));
  db.__qb = qb;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockExecuteMerge = jest.fn();
jest.mock('../services/customer-dedupe', () => ({ executeMerge: (...args) => mockExecuteMerge(...args) }));

const mockRelink = jest.fn();
jest.mock('../services/newsletter-subscribers', () => ({ relinkSubscribersFromArchivedCustomer: (...args) => mockRelink(...args) }));

const mockRecordAuditEvent = jest.fn();
jest.mock('../services/audit-log', () => ({ recordAuditEvent: (...args) => mockRecordAuditEvent(...args) }));

const db = require('../models/db');
const { executeCustomerLifecycleTool } = require('../services/intelligence-bar/customer-lifecycle-tools');

const WINNER_ID = '10000000-0000-4000-8000-000000000001';
const LOSER_ID = '10000000-0000-4000-8000-000000000002';
const CUSTOMER_ID = '10000000-0000-4000-8000-000000000003';

const winnerRow = { id: WINNER_ID, first_name: 'Real', last_name: 'Customer', phone: '9415550101', email: 'real@example.com', deleted_at: null };
const loserRow = { id: LOSER_ID, first_name: 'Unknown', last_name: '', phone: '9415550101', email: null, deleted_at: null };
const customerRow = { id: CUSTOMER_ID, first_name: 'Stale', last_name: 'Stub', phone: '9415550199', email: 'stub@example.com', deleted_at: null };

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction.mockImplementation(async (cb) => cb(db));
  db.__qb.update.mockResolvedValue(1);
});

describe('merge_customers', () => {
  test('same id refuses without touching the database', async () => {
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: WINNER_ID }, {});
    expect(result.error).toMatch(/different customers/);
    expect(db).not.toHaveBeenCalled();
  });

  test('preview names both customers, discloses counts, and mutates nothing', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]); // loadMergePair
    db.__qb.first
      .mockResolvedValueOnce({ n: 3 }) // scheduled_services
      .mockResolvedValueOnce({ n: 1 }) // service_records
      .mockResolvedValueOnce({ n: 0 }) // invoices
      .mockResolvedValueOnce({ n: 2 }) // estimates
      .mockResolvedValueOnce({ n: 5 }); // sms_log

    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      preview: true,
      winner_customer_id: WINNER_ID, winner_name: 'Real Customer', winner_phone: '9415550101', winner_email: 'real@example.com',
      loser_customer_id: LOSER_ID, loser_name: 'Unknown', loser_phone: '9415550101', loser_email: null,
      moving: { scheduled_services: 3, service_records: 1, invoices: 0, estimates: 2, sms_log: 5 },
    });
    expect(result.note_to_operator).toMatch(/archived/);
    expect(db.__qb.update).not.toHaveBeenCalled();
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('refuses when the winner or loser does not resolve to a live customer', async () => {
    db.__qb.select.mockResolvedValueOnce([loserRow]); // winner missing
    let result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'record_unavailable' });
    expect(result.error).toMatch(/winner_customer_id/);

    db.__qb.select.mockResolvedValueOnce([{ ...winnerRow }, { ...loserRow, deleted_at: new Date() }]); // loser archived
    result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'record_unavailable' });
    expect(result.error).toMatch(/loser customer is already archived/);
  });

  test('confirmed call runs executeMerge with performedBy/mode from the action context and no preview reads', async () => {
    mockExecuteMerge.mockResolvedValueOnce({ journalId: 'journal-1', repointed: { scheduled_services: 3 }, backfills: {} });

    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-42' },
    );

    expect(mockExecuteMerge).toHaveBeenCalledWith({
      winnerId: WINNER_ID,
      loserId: LOSER_ID,
      performedBy: 'ib:tech-42',
      performedById: 'tech-42',
      mode: 'intelligence_bar',
      evidence: { via: 'intelligence_bar' },
    });
    expect(result).toMatchObject({ success: true, journal_id: 'journal-1' });
    // The confirmed path never re-reads the customer rows or moving counts —
    // executeMerge owns that under its own transaction/locks.
    expect(db.__qb.select).not.toHaveBeenCalled();
    expect(db.__qb.first).not.toHaveBeenCalled();
  });

  test('confirmed call relays an executeMerge refusal without a partial write', async () => {
    mockExecuteMerge.mockRejectedValueOnce(new Error('executeMerge: both customers have Stripe profiles — resolve in Stripe first'));
    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(result.error).toMatch(/Stripe profiles/);
    expect(result.success).toBeUndefined();
  });
});

describe('archive_customer', () => {
  test('preview names the customer and mutates nothing when nothing blocks it', async () => {
    db.__qb.first
      .mockResolvedValueOnce(customerRow) // top-level lookup
      .mockResolvedValueOnce(null) // no blocking appointment
      .mockResolvedValueOnce(null); // no unpaid invoice

    const result = await executeCustomerLifecycleTool('archive_customer', { customer_id: CUSTOMER_ID, reason: 'duplicate stub' }, {});

    expect(result).toMatchObject({
      preview: true, customer_id: CUSTOMER_ID, customer_name: 'Stale Stub',
      customer_phone: '9415550199', customer_email: 'stub@example.com', reason: 'duplicate stub',
    });
    expect(result.note_to_operator).toMatch(/newsletter subscribers/);
    expect(db.__qb.update).not.toHaveBeenCalled();
    expect(mockRelink).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });

  test('refuses (as a tool failure, not a card) when the customer is already archived', async () => {
    db.__qb.first.mockResolvedValueOnce({ ...customerRow, deleted_at: new Date('2026-01-01') });
    const result = await executeCustomerLifecycleTool('archive_customer', { customer_id: CUSTOMER_ID }, {});
    expect(result).toMatchObject({ code: 'record_unavailable' });
    expect(result.error).toMatch(/already archived/);
  });

  test('refuses on a future non-terminal scheduled visit, naming the blocker', async () => {
    db.__qb.first
      .mockResolvedValueOnce(customerRow)
      .mockResolvedValueOnce({ id: 'appt-1' }) // blocking appointment found
      .mockResolvedValueOnce(null);
    const result = await executeCustomerLifecycleTool('archive_customer', { customer_id: CUSTOMER_ID }, {});
    expect(result.code).toBe('archive_blocked');
    expect(result.error).toMatch(/upcoming scheduled visit/);
    expect(result.blockers).toEqual(['has an upcoming scheduled visit that is not cancelled, completed, or skipped']);
  });

  test('refuses on an unpaid invoice, naming the blocker', async () => {
    db.__qb.first
      .mockResolvedValueOnce(customerRow)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'inv-1' }); // unpaid invoice found
    const result = await executeCustomerLifecycleTool('archive_customer', { customer_id: CUSTOMER_ID }, {});
    expect(result.code).toBe('archive_blocked');
    expect(result.error).toMatch(/unpaid invoice/);
  });

  test('confirmed call stamps deleted_at, relinks newsletter subscribers, and writes a critical audit event', async () => {
    db.__qb.first
      .mockResolvedValueOnce(customerRow) // top-level lookup (unconfirmed guard)
      .mockResolvedValueOnce({ id: CUSTOMER_ID, deleted_at: null }) // locked row inside the transaction
      .mockResolvedValueOnce(null) // fresh blockers: appointment
      .mockResolvedValueOnce(null); // fresh blockers: invoice
    mockRelink.mockResolvedValueOnce({ relinked: 2 });

    const result = await executeCustomerLifecycleTool(
      'archive_customer',
      { customer_id: CUSTOMER_ID, reason: 'duplicate stub', confirmed: true },
      { confirmed: true, technicianId: 'tech-7' },
    );

    expect(result).toMatchObject({ success: true, customer_id: CUSTOMER_ID, newsletter_relinked: 2 });
    expect(db.__qb.update).toHaveBeenCalledWith(expect.objectContaining({ deleted_at: expect.any(Date) }));
    expect(mockRelink).toHaveBeenCalledWith(db, CUSTOMER_ID);
    expect(mockRecordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actor_type: 'technician',
      actor_id: 'tech-7',
      action: 'customer.archive',
      resource_type: 'customer',
      resource_id: CUSTOMER_ID,
      critical: true,
      metadata: expect.objectContaining({ newsletterRelinked: 2, reason: 'duplicate stub', source: 'intelligence_bar' }),
    }));
  });

  test('confirmed call refuses with preview_changed when the row was archived since the card was shown', async () => {
    db.__qb.first
      .mockResolvedValueOnce(customerRow) // top-level lookup: still live
      .mockResolvedValueOnce({ id: CUSTOMER_ID, deleted_at: new Date() }); // locked row: archived in the meantime
    const result = await executeCustomerLifecycleTool(
      'archive_customer',
      { customer_id: CUSTOMER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-7' },
    );
    expect(result.preview_changed).toBe(true);
    expect(mockRelink).not.toHaveBeenCalled();
    expect(mockRecordAuditEvent).not.toHaveBeenCalled();
  });
});
