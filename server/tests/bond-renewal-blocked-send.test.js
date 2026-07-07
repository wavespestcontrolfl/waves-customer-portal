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
 *  - the idempotency key carries a date component so the next daily sweep
 *    can retry past a stuck blocked row; base key parts are unchanged.
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
const { runBondRenewalSweep } = require('../services/lifecycle-email-sweeps');

const BOND = {
  id: 'bond-1',
  customer_id: 'cust-1',
  service_type: 'Termite Bond (Billed Quarterly | 1-Year Term)',
  renews_at: '2026-07-20',
  first_name: 'Marge',
  email: 'marge@example.com',
};

let bondUpdate;

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
  db.schema.hasTable.mockResolvedValue(true);
  db.mockImplementation((table) => {
    if (table === 'scheduled_services') return chainResolving([]); // sync: nothing new
    if (table === 'termite_bonds') return chainResolving([BOND]); // due list + stamp update
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

  test('idempotency key keeps the bond+renewal base and adds a date component', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });

    await runBondRenewalSweep();

    const args = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    // Base parts unchanged (bond id + renewal date), plus a YYYY-MM-DD day
    // component so a stuck blocked row can't dedupe the retry forever.
    expect(args.idempotencyKey).toMatch(/^termite\.bond_renewal:bond-1:2026-07-20:\d{4}-\d{2}-\d{2}$/);
    expect(args.triggerEventId).toBe('termite.bond_renewal:bond-1');
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
