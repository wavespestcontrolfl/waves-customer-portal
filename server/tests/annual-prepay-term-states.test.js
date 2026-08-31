/**
 * Guard test for the annual-prepay term state machine documented in
 * docs/annual-prepay-term-states.md.
 *
 * Three things must stay in lockstep — the DB CHECK (which names exist), the
 * code (which names are actually written, and the transition functions'
 * guards), and the doc (which moves are allowed). This test fails when any
 * one drifts without the others: a new status literal written to
 * annual_prepay_terms, a CHECK edit, a recordDecision guard loosened, or a
 * doc that stops listing a stage.
 *
 * It deliberately does NOT restructure annual-prepay-renewals.js — the guard
 * reads the module as-is.
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));
jest.mock('../services/invoice', () => ({
  settleInvoiceAsAnnualPrepayCovered: jest.fn(),
  reopenAnnualPrepayCoveredInvoicesForTerm: jest.fn(),
}));
jest.mock('../services/customer-credit', () => ({
  postCreditMovement: jest.fn(),
  WAVEGUARD_EXTENSION_CREDIT_BY: 'system:waveguard_tier_extension',
  WAVEGUARD_EXTENSION_REVERSAL_BY: 'system:waveguard_tier_extension_reversal',
  WAVEGUARD_EXTENSION_RESTORE_BY: 'system:waveguard_tier_extension_restore',
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn().mockResolvedValue({ id: 'n' }) }));

const db = require('../models/db');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const { _private } = AnnualPrepayRenewals;

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MIGRATION = 'server/models/migrations/20260614000001_annual_prepay_terms_checks.js';
const DOC = 'docs/annual-prepay-term-states.md';
// Every file that UPDATEs or INSERTs annual_prepay_terms.status with a literal.
const WRITER_FILES = [
  'server/services/annual-prepay-renewals.js',
  'server/routes/admin-invoices.js',
];

// The state machine as documented. Changing these lists means changing the
// doc (and, for WRITTEN, the code) in the same PR.
const WRITTEN_STATUSES = ['payment_pending', 'active', 'renewal_pending', 'cancelled', 'renewed', 'switch_plan'];
const LEGACY_ONLY_STATUSES = ['canceled', 'refunded']; // in the CHECK, never written
const ACTIVE_STATUSES = ['active', 'renewal_pending'];

function migrationCheckStatuses() {
  const src = read(MIGRATION);
  const m = src.match(/const TERM_STATUSES = \[([\s\S]*?)\];/);
  if (!m) throw new Error('TERM_STATUSES not found in the checks migration');
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

// Collect `status: '<literal>'` inside every `.update({...})` / `.insert({...})`
// that follows a `('annual_prepay_terms')` builder call, before the chain
// terminates. Variable-valued statuses (e.g. PAYMENT_PENDING_STATUS) are
// resolved separately below.
function literalStatusWrites(src) {
  const out = [];
  const re = /\(['"]annual_prepay_terms['"]\)([\s\S]*?)(?:;|\n\s*\n)/g;
  for (const m of src.matchAll(re)) {
    const chain = m[1];
    for (const w of chain.matchAll(/\.(?:update|insert)\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      for (const s of w[1].matchAll(/\bstatus:\s*'([a-z_]+)'/g)) out.push(s[1]);
    }
  }
  return out;
}

describe('annual-prepay term states — CHECK ↔ code ↔ doc', () => {
  test('the DB CHECK is exactly the written stages plus the two legacy names', () => {
    const inCheck = migrationCheckStatuses().sort();
    expect(inCheck).toEqual([...WRITTEN_STATUSES, ...LEGACY_ONLY_STATUSES].sort());
  });

  test('every status literal written to annual_prepay_terms is a documented written stage; legacy names are never written', () => {
    const seen = new Set();
    for (const rel of WRITER_FILES) {
      for (const s of literalStatusWrites(read(rel))) seen.add(s);
    }
    // Sanity: the scan actually found the known write sites (a regex that
    // silently matched nothing would make this test vacuous).
    expect(seen.has('active')).toBe(true);
    expect(seen.has('cancelled')).toBe(true);
    expect(seen.has('payment_pending')).toBe(true);
    for (const s of seen) {
      expect(WRITTEN_STATUSES).toContain(s);
      expect(LEGACY_ONLY_STATUSES).not.toContain(s);
    }
  });

  test('the doc names every stage in the CHECK and every read-side grouping constant', () => {
    const doc = read(DOC);
    for (const s of migrationCheckStatuses()) {
      expect(doc).toMatch(new RegExp(`\\| \`${s}\` \\|`)); // a row in the Stages table
    }
    expect(doc).toContain("ACTIVE_STATUSES = ['active', 'renewal_pending']");
    expect(doc).toContain("DECIDED_COVERED_STATUSES = ['renewed', 'switch_plan']");
    // The two legacy names must be flagged as never written, not documented as live.
    expect(doc).toMatch(/`canceled`[^\n]*never written/);
    expect(doc).toMatch(/`refunded`[^\n]*never written/);
  });

  test('invoiceTermStatus (birth + invoice-driven moves) only yields payment_pending / active / cancelled', () => {
    const f = _private.invoiceTermStatus;
    expect(f(null)).toBe('payment_pending');
    expect(f({ status: 'draft' })).toBe('payment_pending');
    expect(f({ status: 'sent' })).toBe('payment_pending');
    expect(f({ status: 'paid' })).toBe('active');
    expect(f({ status: 'viewed', paid_at: new Date() })).toBe('active');
    // Both spellings and refunded on the INVOICE all land on term 'cancelled' —
    // never on the legacy term names.
    for (const invStatus of ['void', 'cancelled', 'canceled', 'refunded']) {
      expect(f({ status: invStatus })).toBe('cancelled');
    }
  });

  describe('recordDecision — the operator moves out of active / renewal_pending', () => {
    let chain;
    beforeEach(() => {
      db.schema = { hasTable: jest.fn().mockResolvedValue(true) };
      chain = {
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{ id: 'term-1' }]),
      };
      db.mockReturnValue(chain);
    });

    test.each([
      ['contacted', 'renewal_pending', null],
      ['renew', 'renewed', 'renew'],
      ['switch_plan', 'switch_plan', 'switch_plan'],
      ['cancel', 'cancelled', 'cancel'],
    ])('%s → status %s (renewal_decision %s), guarded on ACTIVE_STATUSES + undecided', async (action, status, decision) => {
      await AnnualPrepayRenewals.recordDecision({ termId: 'term-1', action, adminUserId: 'admin-1' });
      expect(chain.where).toHaveBeenCalledWith({ id: 'term-1' });
      expect(chain.whereIn).toHaveBeenCalledWith('status', ACTIVE_STATUSES);
      expect(chain.whereNull).toHaveBeenCalledWith('renewal_decision');
      const payload = chain.update.mock.calls[0][0];
      expect(payload.status).toBe(status);
      if (decision) expect(payload.renewal_decision).toBe(decision);
      else expect(payload).not.toHaveProperty('renewal_decision');
    });

    test('rejects any action that is not a documented move', async () => {
      await expect(AnnualPrepayRenewals.recordDecision({ termId: 'term-1', action: 'refund' }))
        .rejects.toThrow('invalid annual prepay action');
      await expect(AnnualPrepayRenewals.recordDecision({ termId: 'term-1', action: 'canceled' }))
        .rejects.toThrow('invalid annual prepay action');
      expect(chain.update).not.toHaveBeenCalled();
    });

    test('a decided term (guard miss) returns null instead of moving', async () => {
      chain.returning.mockResolvedValue([]);
      await expect(AnnualPrepayRenewals.recordDecision({ termId: 'term-1', action: 'renew' })).resolves.toBeNull();
    });
  });
});
