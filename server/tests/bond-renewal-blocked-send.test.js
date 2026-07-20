/**
 * Bond renewal sweep — blocked sends must NOT consume the once-ever notice.
 *
 * sendTemplate returns {sent:false, blocked:true} WITHOUT throwing when a
 * suppression blocks the send (or the template is inactive). The sweep used
 * to stamp renewal_notified_at unconditionally after any non-throwing call,
 * and the `due` query filters whereNull(renewal_notified_at) — so any
 * bounce-suppressed customer permanently lost their termite-bond renewal
 * notice, unrecoverable after the suppression cleared. Compounding it, the
 * fixed idempotency key deduped against the BLOCKED email_messages row
 * forever ('blocked' is in DEDUPE_STATUSES).
 *
 * Contract:
 *  - {sent:false} → renewal_notified_at NOT stamped (bond stays due).
 *  - {sent:true}  → stamped exactly as before.
 *  - the STABLE key is tried first (a sent-but-unstamped row dedupes as
 *    sent:true → stamp retried, customer NOT emailed twice); only a
 *    deduped-BLOCKED result triggers one retry under a day-scoped key so
 *    a stuck blocked row can't kill the notice forever.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn(async () => true) };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  redactEmailAddresses: jest.fn((s) => s),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const EmailTemplateLibrary = require('../services/email-template-library');
const { runBondRenewalSweep, syncTermiteBonds } = require('../services/lifecycle-email-sweeps');

const BOND = {
  id: 'bond-1',
  customer_id: 'cust-1',
  service_type: 'Termite Bond (Billed Quarterly | 1-Year Term)',
  renews_at: '2026-07-20',
  first_name: 'Marge',
  email: 'marge@example.com',
};

let bondUpdate;
let priorRetryRow;

function chainResolving(rows) {
  const q = {};
  ['where', 'whereNull', 'whereIn', 'leftJoin', 'join', 'select', 'orderBy'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.first = jest.fn(async () => rows[0]);
  q.insert = jest.fn(async () => [1]);
  q.update = bondUpdate;
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
  bondUpdate = jest.fn(async () => 1);
  priorRetryRow = undefined;
  db.schema.hasTable.mockResolvedValue(true);
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return chainResolving([]); // sync: nothing new
    if (table === 'termite_bonds') return chainResolving([BOND]); // due list + stamp update
    if (table === 'email_messages') return chainResolving(priorRetryRow ? [priorRetryRow] : []);
    throw new Error(`unexpected table ${table}`);
  });
});

describe('runBondRenewalSweep blocked-send handling', () => {
  test('suppression-blocked send leaves renewal_notified_at unstamped', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({
      sent: false, blocked: true, reason: 'Email suppressed',
    });

    const result = await runBondRenewalSweep();

    expect(result.sent).toBe(0);
    expect(bondUpdate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('suppression-blocked'));
  });

  test('successful send stamps renewal_notified_at', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });

    const result = await runBondRenewalSweep();

    expect(result.sent).toBe(1);
    expect(bondUpdate).toHaveBeenCalledWith(expect.objectContaining({
      renewal_notified_at: expect.any(Date),
    }));
  });

  test('first attempt uses the STABLE key (sent-but-unstamped rows dedupe, no double email)', async () => {
    // Prior run sent the email but died before stamping: the stable key
    // dedupes as sent:true and the stamp gets retried — one email total.
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, deduped: true });

    const result = await runBondRenewalSweep();

    expect(result.sent).toBe(1);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    const args = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(args.idempotencyKey).toBe('termite.bond_renewal:bond-1:2026-07-20');
    expect(args.triggerEventId).toBe('termite.bond_renewal:bond-1');
    expect(bondUpdate).toHaveBeenCalledWith(expect.objectContaining({
      renewal_notified_at: expect.any(Date),
    }));
  });

  test('a deduped-BLOCKED stable-key hit retries once under a day-scoped key', async () => {
    // Attempt 1 (stable key): stuck blocked row from a prior suppressed
    // run. Attempt 2 (day key): suppression has cleared — sends + stamps.
    EmailTemplateLibrary.sendTemplate
      .mockResolvedValueOnce({ sent: false, blocked: true, deduped: true, reason: 'Email suppressed' })
      .mockResolvedValueOnce({ sent: true });

    const result = await runBondRenewalSweep();

    expect(result.sent).toBe(1);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(2);
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].idempotencyKey)
      .toBe('termite.bond_renewal:bond-1:2026-07-20');
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[1][0].idempotencyKey)
      .toMatch(/^termite\.bond_renewal:bond-1:2026-07-20:\d{4}-\d{2}-\d{2}$/);
    expect(bondUpdate).toHaveBeenCalledTimes(1);
  });

  test('a PRIOR day-scoped retry that sent (stamp then failed) is settled without a second email', async () => {
    // Day 1: stable key blocked-deduped, day-key retry SENT, bond stamp
    // write died. Day 2: stable key still dedupes to the old blocked row —
    // the sent retry row must settle the bond (stamp) without generating a
    // fresh day key and emailing the customer again.
    priorRetryRow = { id: 'em-retry-1', idempotency_key: 'termite.bond_renewal:bond-1:2026-07-20:2026-07-06', status: 'sent' };
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({
      sent: false, blocked: true, deduped: true, reason: 'Email suppressed',
    });

    const result = await runBondRenewalSweep();

    expect(result.sent).toBe(1);
    // Only the stable-key attempt hit the template library — no re-send.
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(bondUpdate).toHaveBeenCalledWith(expect.objectContaining({
      renewal_notified_at: expect.any(Date),
    }));
  });

  test('still suppressed on the day-scoped retry: no stamp, bond stays due', async () => {
    EmailTemplateLibrary.sendTemplate
      .mockResolvedValueOnce({ sent: false, blocked: true, deduped: true, reason: 'Email suppressed' })
      .mockResolvedValueOnce({ sent: false, blocked: true, reason: 'Email suppressed' });

    const result = await runBondRenewalSweep();

    expect(result.sent).toBe(0);
    expect(bondUpdate).not.toHaveBeenCalled();
  });

  test('a throwing send is logged and does not stamp', async () => {
    const err = new Error('SendGrid exploded');
    err.status = 500;
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(err);

    const result = await runBondRenewalSweep();

    expect(result.sent).toBe(0);
    expect(bondUpdate).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('bond-1'));
  });
});

describe('syncTermiteBonds — backfilled closeouts anchor the bond term to the service day (Codex P2, PR #2897 fix round 4)', () => {
  // The sync prefers actual_end_time/check_out_time/completed_at over
  // scheduled_date. Pre-fix, a backdated quiet closeout stamped those with
  // the CLOSEOUT wall clock, so a weeks-old visit started its bond term —
  // and scheduled its renewal notice — from the day the office caught up on
  // paperwork. The write side now backdates every kept end instant to the
  // service day (admin-dispatch backfillCompletionEndInstant) and leaves
  // the unknown-end shape with no end fields at all; both resolve to the
  // visit's real day here.
  function visitRow(overrides = {}) {
    return {
      id: 'svc-b1',
      customer_id: 'cust-b1',
      service_type: 'Termite Bond (Billed Quarterly | 1-Year Term)',
      completed_at: null,
      actual_end_time: null,
      check_out_time: null,
      scheduled_date: '2026-07-01',
      ...overrides,
    };
  }

  function armDb(visits, bondInsert) {
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chainResolving(visits);
      if (table === 'termite_bonds') {
        const q = chainResolving([]);
        q.insert = bondInsert;
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    });
  }

  test('kept backdated end stamp → started_at is the visit day, renewal a year out from IT', async () => {
    const bondInsert = jest.fn(async () => [1]);
    // Noon EDT on the service day — the instant the write-side rule stamps.
    armDb([visitRow({ actual_end_time: '2026-07-01T16:00:00.000Z' })], bondInsert);

    const result = await syncTermiteBonds();

    expect(result.inserted).toBe(1);
    expect(bondInsert).toHaveBeenCalledWith(expect.objectContaining({
      scheduled_service_id: 'svc-b1',
      term_years: 1,
      started_at: '2026-07-01',
      renews_at: '2027-07-01',
    }));
  });

  test('unknown-end backfill shape (all three end fields NULL) → scheduled_date verbatim, visit not lost', async () => {
    const bondInsert = jest.fn(async () => [1]);
    armDb([visitRow()], bondInsert);

    const result = await syncTermiteBonds();

    expect(result.inserted).toBe(1);
    expect(bondInsert).toHaveBeenCalledWith(expect.objectContaining({
      started_at: '2026-07-01',
      renews_at: '2027-07-01',
    }));
  });

  test('the pre-fix hazard, pinned: a wall-clock closeout stamp starts the term on the closeout day', async () => {
    // Documents WHY the write side backdates: this sync's preference order
    // is correct for live completions (evening finishes cross UTC days), so
    // the fix belongs on the stamps, not here.
    const bondInsert = jest.fn(async () => [1]);
    armDb([visitRow({ check_out_time: '2026-07-19T20:00:00.000Z' })], bondInsert);

    await syncTermiteBonds();

    expect(bondInsert).toHaveBeenCalledWith(expect.objectContaining({
      started_at: '2026-07-19',
      renews_at: '2027-07-19',
    }));
  });
});
