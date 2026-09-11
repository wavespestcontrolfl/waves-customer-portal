/**
 * merge_customers — the confirmed customer-lifecycle write added so the
 * Intelligence Bar can merge a duplicate ("Unknown" website stub sharing a
 * phone with a real customer). A #1568 preview→confirmed two-step tool
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
 * customer-dedupe.js (the merge engine + the canonical eligibility check +
 * FK discovery) is mocked per the assignment.
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
  db.raw = jest.fn((sql) => sql);
  db.__qb = qb;
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockExecuteMerge = jest.fn();
const mockDuplicatePairEligibility = jest.fn();
const mockCustomerFkColumns = jest.fn();
jest.mock('../services/customer-dedupe', () => ({
  executeMerge: (...args) => mockExecuteMerge(...args),
  duplicatePairEligibility: (...args) => mockDuplicatePairEligibility(...args),
  customerFkColumns: (...args) => mockCustomerFkColumns(...args),
}));

const db = require('../models/db');
const { executeCustomerLifecycleTool } = require('../services/intelligence-bar/customer-lifecycle-tools');

const WINNER_ID = '10000000-0000-4000-8000-000000000001';
const LOSER_ID = '10000000-0000-4000-8000-000000000002';

const winnerRow = { id: WINNER_ID, first_name: 'Real', last_name: 'Customer', phone: '9415550101', email: 'real@example.com', deleted_at: null, version: '2026-09-10 20:00:00.000001+00', account_credits: '0' };
const loserRow = { id: LOSER_ID, first_name: 'Unknown', last_name: '', phone: '9415550101', email: null, deleted_at: null, version: '2026-09-10 20:05:00.000002+00', account_credits: '12.50', billing_mode: 'per_application', per_application_fee: '85.00' };

const ELIGIBLE = { eligible: true, code: 'eligible', reason: null, candidate: { tier: 'yellow', reasons: ['name_conflict'] } };

// Default FK columns for the "full moving counts" query: kept small and
// deliberately NOT the legacy five-table subset, so the tests below prove
// the preview no longer hardcodes MOVING_TABLES.
const FK_COLUMNS = [
  { table_name: 'scheduled_services', column_name: 'customer_id' },
  { table_name: 'invoices', column_name: 'customer_id' },
  { table_name: 'sms_log', column_name: 'customer_id' },
];

beforeEach(() => {
  jest.clearAllMocks();
  db.transaction.mockImplementation(async (cb) => cb(db));
  db.__qb.update.mockResolvedValue(1);
  mockDuplicatePairEligibility.mockResolvedValue(ELIGIBLE);
  mockCustomerFkColumns.mockResolvedValue(FK_COLUMNS);
});

describe('merge_customers', () => {
  test('same id refuses without touching the database', async () => {
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: WINNER_ID }, {});
    expect(result.error).toMatch(/different customers/);
    expect(db).not.toHaveBeenCalled();
  });

  test('preview names both customers, discloses full moving counts, billing/contacts, pair, and versions, and mutates nothing', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]); // loadMergePair
    db.__qb.first
      .mockResolvedValueOnce({ n: 3 }) // scheduled_services
      .mockResolvedValueOnce({ n: 0 }) // invoices
      .mockResolvedValueOnce({ n: 5 }); // sms_log

    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});

    expect(result.error).toBeUndefined();
    expect(mockDuplicatePairEligibility).toHaveBeenCalledWith(WINNER_ID, LOSER_ID);
    expect(result).toMatchObject({
      preview: true,
      winner_customer_id: WINNER_ID, winner_name: 'Real Customer', winner_phone: '9415550101', winner_email: 'real@example.com', winner_version: winnerRow.version,
      loser_customer_id: LOSER_ID, loser_name: 'Unknown', loser_phone: '9415550101', loser_email: null, loser_version: loserRow.version,
      pair: { tier: 'yellow', reasons: ['name_conflict'] },
      moving: { scheduled_services: 3, sms_log: 5, total_rows: 8 },
    });
    expect(result.moving.invoices).toBeUndefined(); // zero counts are dropped
    expect(result.billing_and_contacts).toEqual({
      winner: expect.objectContaining({ stripe_customer_id: null, billing_mode: null, per_application_fee: null, account_credits: '0' }),
      loser: expect.objectContaining({ stripe_customer_id: null, billing_mode: 'per_application', per_application_fee: '85.00', account_credits: '12.50' }),
    });
    // The executor's special-case money effects, as amounts (pre-push Codex P1).
    expect(result.financial_effects).toEqual({
      account_credits_moved_to_winner: 12.5,
      billing_mode_adopted_from_loser: 'per_application',
      per_application_fee_adopted_from_loser: 85,
      loser_plan_rate_rows_deleted: 0,
    });
    expect(result.note_to_operator).toMatch(/archived/);
    expect(db.__qb.update).not.toHaveBeenCalled();
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('preview reports a table as unknown instead of throwing when its count fails', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    db.__qb.first
      .mockResolvedValueOnce({ n: 2 }) // scheduled_services
      .mockRejectedValueOnce(new Error('relation "invoices" is unreadable')) // invoices
      .mockResolvedValueOnce({ n: 0 }); // sms_log
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result.error).toBeUndefined();
    expect(result.moving.invoices).toBe('unknown');
    expect(result.moving.scheduled_services).toBe(2);
    expect(result.moving.total_rows).toBe(2);
  });

  test('preview refuses not_in_queue with the canonical message', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: false, code: 'not_in_queue', reason: 'Pair is no longer in the duplicate queue', candidate: null });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'not_in_queue', error: 'Pair is no longer in the duplicate queue' });
  });

  test('preview refuses red_pair with the canonical message', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: false, code: 'red_pair', reason: 'This pair looks like two different people and cannot be merged from the queue', candidate: { tier: 'red', reasons: [] } });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'red_pair', error: 'This pair looks like two different people and cannot be merged from the queue' });
  });

  test('preview refuses address_conflict pointing the operator at the admin duplicates queue, never offering link-as-property', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    mockDuplicatePairEligibility.mockResolvedValueOnce({ eligible: false, code: 'address_conflict', reason: "This duplicate has a different service address — use 'Merge + keep address' so the address isn't lost", candidate: { tier: 'yellow', reasons: ['address_different'] } });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result.code).toBe('address_conflict');
    expect(result.error).toMatch(/admin duplicates queue/);
    expect(result.error).toMatch(/Merge \+ keep address/);
    expect(result.error).toMatch(/does not support/i);
  });

  test('refuses when the winner or loser does not resolve to a live customer', async () => {
    db.__qb.select.mockResolvedValueOnce([loserRow]); // winner missing
    let result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'record_unavailable' });
    expect(result.error).toMatch(/winner_customer_id/);
    expect(mockDuplicatePairEligibility).not.toHaveBeenCalled();

    db.__qb.select.mockResolvedValueOnce([{ ...winnerRow }, { ...loserRow, deleted_at: new Date() }]); // loser archived
    result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(result).toMatchObject({ code: 'record_unavailable' });
    expect(result.error).toMatch(/loser customer is already archived/);
  });

  test('confirmed call re-reads versions and eligibility twice before executeMerge, then runs it with performedBy/mode from the action context', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]); // loadMergePair, called twice
    mockExecuteMerge.mockResolvedValueOnce({ journalId: 'journal-1', repointed: { scheduled_services: 3 }, backfills: {} });

    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-42' },
    );

    expect(mockDuplicatePairEligibility).toHaveBeenCalledTimes(2);
    expect(db.__qb.select).toHaveBeenCalledTimes(2);
    expect(mockExecuteMerge).toHaveBeenCalledWith({
      winnerId: WINNER_ID,
      loserId: LOSER_ID,
      performedBy: 'ib:tech-42',
      performedById: 'tech-42',
      mode: 'intelligence_bar',
      evidence: { via: 'intelligence_bar' },
      expectedVersions: { winner: winnerRow.version, loser: loserRow.version },
      underLock: null, // no card pin on a direct call — nothing to assert under the locks
    });
    expect(result).toMatchObject({ success: true, journal_id: 'journal-1' });
  });

  test('confirmed call refuses with preview_changed when the pair became ineligible since the card was shown', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
    mockDuplicatePairEligibility.mockResolvedValue({ eligible: false, code: 'red_pair', reason: 'This pair looks like two different people and cannot be merged from the queue', candidate: { tier: 'red', reasons: [] } });
    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(result.preview_changed).toBe(true);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('confirmed call refuses with preview_changed when a customer version changed between the two rechecks', async () => {
    db.__qb.select
      .mockResolvedValueOnce([winnerRow, loserRow]) // first recheck
      .mockResolvedValueOnce([{ ...winnerRow, version: 'v2-winner' }, loserRow]); // second recheck: winner moved on
    const result = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(result.preview_changed).toBe(true);
    expect(mockExecuteMerge).not.toHaveBeenCalled();
  });

  test('confirmed call validates the APPROVED card versions (route pin), not freshly sampled ones (pre-push Codex P1)', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
    mockExecuteMerge.mockResolvedValueOnce({ journalId: 'journal-2', repointed: {}, backfills: {} });
    await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: 'approved-w', loser: 'approved-l' } },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ expectedVersions: { winner: 'approved-w', loser: 'approved-l' } }));
    // the executor's own under-lock refusal surfaces as preview_changed
    mockExecuteMerge.mockRejectedValueOnce(Object.assign(new Error('executeMerge: the loser customer changed since this merge was approved — review a fresh proposal'), { previewChanged: true }));
    const drift = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: 'approved-w', loser: 'approved-l' } },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(drift).toMatchObject({ preview_changed: true });
  });

  test('preview carries an effects fingerprint (key-sorted moving counts + money effects) the route pins on the card', async () => {
    db.__qb.select.mockResolvedValueOnce([winnerRow, loserRow]);
    db.__qb.first.mockResolvedValueOnce({ n: 2 }).mockResolvedValueOnce({ n: 0 }).mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 0 });
    const result = await executeCustomerLifecycleTool('merge_customers', { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID }, {});
    expect(typeof result.effects_fingerprint).toBe('string');
    const parsed = JSON.parse(result.effects_fingerprint);
    expect(parsed).toEqual({ moving: result.moving, financial_effects: result.financial_effects });
    expect(Object.keys(parsed.moving)).toEqual([...Object.keys(parsed.moving)].sort());
  });

  test('confirmed call with an approved effects pin recounts UNDER executeMerge\'s locks and refuses on drift (pre-push Codex P1)', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
    // Card showed 3 scheduled_services + 5 sms_log, 12.50 credits, 0 plan-rate rows.
    const approved = JSON.stringify({
      moving: { scheduled_services: 3, sms_log: 5, total_rows: 8 },
      financial_effects: { account_credits_moved_to_winner: 12.5, billing_mode_adopted_from_loser: 'per_application', loser_plan_rate_rows_deleted: 0, per_application_fee_adopted_from_loser: 85 },
    });
    mockExecuteMerge.mockImplementation(async ({ underLock }) => {
      await underLock(db, { winner: winnerRow, loser: loserRow });
      return { journalId: 'journal-3', repointed: {}, backfills: {} };
    });
    // Under the lock: same counts → proceeds.
    db.__qb.first.mockReset();
    db.__qb.first.mockResolvedValueOnce({ n: 3 }).mockResolvedValueOnce({ n: 0 }).mockResolvedValueOnce({ n: 5 }).mockResolvedValueOnce({ n: 0 });
    const ok = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: winnerRow.version, loser: loserRow.version }, _approved_effects: approved },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(ok).toMatchObject({ success: true, journal_id: 'journal-3' });
    expect(mockExecuteMerge).toHaveBeenCalledWith(expect.objectContaining({ underLock: expect.any(Function) }));
    // Under the lock: a new invoice landed on the loser → preview_changed, nothing committed.
    db.__qb.first.mockReset();
    db.__qb.first.mockResolvedValueOnce({ n: 3 }).mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 5 }).mockResolvedValueOnce({ n: 0 });
    const drift = await executeCustomerLifecycleTool(
      'merge_customers',
      { winner_customer_id: WINNER_ID, loser_customer_id: LOSER_ID, confirmed: true, _approved_versions: { winner: winnerRow.version, loser: loserRow.version }, _approved_effects: approved },
      { confirmed: true, technicianId: 'tech-42' },
    );
    expect(drift).toMatchObject({ preview_changed: true });
    expect(drift.error).toMatch(/rows that would move changed/);
    expect(drift.success).toBeUndefined();
  });

  test('confirmed call relays an executeMerge refusal without a partial write', async () => {
    db.__qb.select.mockResolvedValue([winnerRow, loserRow]);
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
