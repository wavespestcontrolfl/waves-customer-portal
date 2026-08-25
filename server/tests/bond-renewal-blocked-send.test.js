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

  test('gate ON: "Renew my bond" CTA deep-links to the My Plan bond card', async () => {
    // The portal bond card lives on the My Plan tab
    // (GATE_PORTAL_TERMITE_BOND); /login?next= round-trips the tab param
    // for logged-out clicks. "View my account" stays on plain login.
    process.env.GATE_PORTAL_TERMITE_BOND = 'true';
    try {
      EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });

      await runBondRenewalSweep();

      const args = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
      expect(args.payload.renewal_url).toBe('https://portal.wavespestcontrol.com/?tab=plan');
      expect(args.payload.customer_portal_url).toBe('https://portal.wavespestcontrol.com/login');
    } finally {
      delete process.env.GATE_PORTAL_TERMITE_BOND;
    }
  });

  test('gate OFF (dark rollout): renewal CTA keeps the legacy login landing', async () => {
    // Until the bond card is live, the deep-link would strand customers on
    // a Plan tab with no bond on it (codex #3362 P2) — hold at /login.
    delete process.env.GATE_PORTAL_TERMITE_BOND;
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });

    await runBondRenewalSweep();

    const args = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(args.payload.renewal_url).toBe('https://portal.wavespestcontrol.com/login');
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
    // The insert now rides a transaction that FOR-UPDATE re-reads the
    // visit's owner (Codex #3109 r27) AND its service identity (pre-push
    // P1 — a repoint between the candidate read and the lock must not mint
    // from stale identity) — serve those reads from the sweep's own rows,
    // preferring a lockedOverrides map keyed by visit id when the test
    // wants the locked state to DIFFER from the candidate read.
    db.transaction = jest.fn(async (fn) => {
      const trx = (table) => {
        if (table === 'scheduled_services') {
          return {
            where: jest.fn(({ id }) => ({
              forUpdate: jest.fn(() => ({
                first: jest.fn(async () => {
                  const row = visits.find((v) => v.id === id);
                  if (!row) return null;
                  const locked = { ...row, ...((armDb.lockedOverrides || {})[id] || {}) };
                  return {
                    customer_id: locked.customer_id,
                    service_id: locked.service_id || null,
                    service_type: locked.service_type,
                    service_key_snapshot: locked.service_key_snapshot || null,
                    // Candidate fixtures are completed rows by definition;
                    // an override can flip status to model an un-complete
                    // landing before the lock.
                    status: locked.status || 'completed',
                    completed_at: locked.completed_at ?? null,
                    actual_end_time: locked.actual_end_time ?? null,
                    check_out_time: locked.check_out_time ?? null,
                    scheduled_date: locked.scheduled_date ?? null,
                  };
                }),
              })),
            })),
          };
        }
        if (table === 'services') {
          return {
            where: jest.fn(({ id }) => ({
              first: jest.fn(async () => {
                const row = (armDb.catalogRows || []).find((r) => r.id === id);
                return row ? { service_key: row.service_key } : undefined;
              }),
            })),
          };
        }
        return db(table);
      };
      return fn(trx);
    });
  }
  beforeEach(() => { armDb.lockedOverrides = null; armDb.catalogRows = null; });

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

  test('a repoint landing before the row lock vetoes the insert (identity re-derived under the lock)', async () => {
    // The candidate read saw a bond visit; by lock time an admin repointed
    // it to quarterly pest. The locked re-derivation must skip the insert
    // (pre-push P1) — the stale label alone must not mint a warranty.
    const bondInsert = jest.fn(async () => [1]);
    armDb([visitRow()], bondInsert);
    armDb.lockedOverrides = {
      'svc-b1': { service_key_snapshot: 'pest_general_quarterly', service_type: 'Quarterly Pest Control Service' },
    };

    const result = await syncTermiteBonds();

    expect(result.inserted).toBe(0);
    expect(bondInsert).not.toHaveBeenCalled();
  });

  test('an un-complete landing before the lock vetoes the insert', async () => {
    const bondInsert = jest.fn(async () => [1]);
    armDb([visitRow()], bondInsert);
    armDb.lockedOverrides = { 'svc-b1': { status: 'cancelled' } };

    const result = await syncTermiteBonds();

    expect(result.inserted).toBe(0);
    expect(bondInsert).not.toHaveBeenCalled();
  });

  test('a timing edit landing before the lock dates the bond from the LOCKED timestamps', async () => {
    const bondInsert = jest.fn(async () => [1]);
    armDb([visitRow({ actual_end_time: '2026-07-01T16:00:00.000Z' })], bondInsert);
    armDb.lockedOverrides = { 'svc-b1': { actual_end_time: '2026-07-10T16:00:00.000Z' } };

    const result = await syncTermiteBonds();

    expect(result.inserted).toBe(1);
    expect(bondInsert).toHaveBeenCalledWith(expect.objectContaining({
      started_at: '2026-07-10',
      renews_at: '2027-07-10',
    }));
  });

  test('the locked catalog link drives the inserted term when it disagrees with the candidate read', async () => {
    const bondInsert = jest.fn(async () => [1]);
    armDb([visitRow()], bondInsert);
    armDb.lockedOverrides = { 'svc-b1': { service_id: 'row-10yr' } };
    armDb.catalogRows = [{ id: 'row-10yr', service_key: 'termite_bond_10yr' }];

    const result = await syncTermiteBonds();

    expect(result.inserted).toBe(1);
    expect(bondInsert).toHaveBeenCalledWith(expect.objectContaining({
      term_years: 10,
      started_at: '2026-07-01',
      renews_at: '2036-07-01',
    }));
  });
});
