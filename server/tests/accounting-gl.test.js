/**
 * Comprehensive unit & full-cycle accounting invariant tests for the
 * QuickBooks-style General Ledger core (server/services/accounting/* & routes/admin-accounting.js).
 *
 * Covers:
 * 1. Canonical Chart of Accounts integrity (unique codes, valid types, 16b interest, 50% meals vs 0% entertainment).
 * 2. Strict double-entry validation (rejects unbalanced, single-line, both-sided, float cents, bad calendar dates).
 * 3. Every subledger posting rule (invoices, FL sales tax payable, annual prepays & recognition,
 *    Stripe payments + merchant fees, Stripe payouts clearing 1050, refunds with tax reversal,
 *    shared-bill splits, loan P&I splits, transfers, FL DOR remittance, payroll runs & settlements,
 *    depreciation, opening balance equity plug).
 * 4. Full-cycle end-to-end accounting proof across Trial Balance, Accrual P&L, Balance Sheet,
 *    and Indirect Statement of Cash Flows — asserting every equation holds to $0.00.
 * 5. Reconciliation math (exact $0.00 difference gate) & vendor TIN AES-256-GCM encryption (no plaintext leak).
 * 6. Express router security: dark gate 404, /status when dark, requireAdmin, requireFullAccess on mutations.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn(() => {
    throw new Error('Unexpected DB call in pure unit test');
  });
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => new Date()) };
  fn.transaction = jest.fn();
  return fn;
});

const {
  SYSTEM_CODES,
  SYSTEM_ACCOUNTS,
  ACCOUNT_TYPES,
  naturalBalanceCents,
  sectionSignedBalanceCents,
} = require('../services/accounting/coa-seed');
const { validateJournalEntryInput, AccountingError } = require('../services/accounting/ledger');
const rules = require('../services/accounting/posting-rules');
const {
  computeTrialBalance,
  computeProfitAndLoss,
  computeBalanceSheet,
  computeCashFlowStatement,
} = require('../services/accounting/statements');
const { computeReconciliationMath } = require('../services/accounting/reconciliation');
const { encryptTin, publicVendor } = require('../services/accounting/vendors');

function makeSyntheticAccounts() {
  return SYSTEM_ACCOUNTS.map((a, idx) => ({
    ...a,
    id: `00000000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
    deductible_pct: a.deductible_pct ?? 100,
    active: true,
    is_system: true,
  }));
}

function accumulateEntries(accounts, entries) {
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const sums = new Map();
  for (const entry of entries) {
    const validated = validateJournalEntryInput(entry);
    for (const line of validated.lines) {
      const acct = byCode.get(line.account_code);
      if (!acct) throw new Error(`Unknown synthetic account code ${line.account_code}`);
      const prev = sums.get(acct.id) || { debitCents: 0, creditCents: 0 };
      sums.set(acct.id, {
        debitCents: prev.debitCents + line.debit_cents,
        creditCents: prev.creditCents + line.credit_cents,
      });
    }
  }
  return sums;
}

describe('Chart of Accounts (coa-seed)', () => {
  test('every system account has unique 4-digit code, valid type, and correct compliance mappings', () => {
    const codes = new Set();
    for (const acct of SYSTEM_ACCOUNTS) {
      expect(acct.code).toMatch(/^\d{4}$/);
      expect(codes.has(acct.code)).toBe(false);
      codes.add(acct.code);
      expect(ACCOUNT_TYPES).toContain(acct.account_type);
      expect(['debit', 'credit']).toContain(acct.normal_balance);
    }

    const interest = SYSTEM_ACCOUNTS.find((a) => a.code === SYSTEM_CODES.OPEX_INTEREST_OTHER);
    expect(interest.schedule_c_line).toBe('16b');

    const meals = SYSTEM_ACCOUNTS.find((a) => a.code === SYSTEM_CODES.OPEX_BUSINESS_MEALS);
    const entertainment = SYSTEM_ACCOUNTS.find((a) => a.code === SYSTEM_CODES.OPEX_ENTERTAINMENT);
    expect(meals.deductible_pct).toBe(50);
    expect(entertainment.deductible_pct).toBe(0);

    const fieldWages = SYSTEM_ACCOUNTS.find((a) => a.code === SYSTEM_CODES.COGS_FIELD_WAGES);
    const officeWages = SYSTEM_ACCOUNTS.find((a) => a.code === SYSTEM_CODES.OPEX_OFFICE_WAGES);
    expect(fieldWages.account_type).toBe('cogs');
    expect(officeWages.account_type).toBe('expense');
  });

  test('contra accounts carry opposite sign inside section totals', () => {
    const accum = SYSTEM_ACCOUNTS.find((a) => a.code === SYSTEM_CODES.ACCUM_DEPRECIATION);
    expect(naturalBalanceCents(accum, 0, 50000)).toBe(50000);
    expect(sectionSignedBalanceCents(accum, 0, 50000)).toBe(-50000);

    const draws = SYSTEM_ACCOUNTS.find((a) => a.code === SYSTEM_CODES.OWNER_DRAWS);
    expect(naturalBalanceCents(draws, 25000, 0)).toBe(25000);
    expect(sectionSignedBalanceCents(draws, 25000, 0)).toBe(-25000);
  });
});

describe('Double-entry validation (validateJournalEntryInput)', () => {
  test('accepts a valid balanced multi-line journal entry', () => {
    const out = validateJournalEntryInput({
      entryDate: '2026-11-15',
      entryType: 'adjusting',
      memo: 'Vehicle loan payment split',
      lines: [
        { accountCode: SYSTEM_CODES.LOANS_PAYABLE, debitCents: 45000, creditCents: 0 },
        { accountCode: SYSTEM_CODES.OPEX_INTEREST_OTHER, debitCents: 7500, creditCents: 0 },
        { accountCode: SYSTEM_CODES.CHECKING_PRIMARY, debitCents: 0, creditCents: 52500 },
      ],
    });
    expect(out.totalCents).toBe(52500);
    expect(out.lines).toHaveLength(3);
  });

  test('rejects an entry out of balance by even 1 cent', () => {
    expect(() => validateJournalEntryInput({
      entryDate: '2026-11-15',
      memo: 'Unbalanced entry',
      lines: [
        { accountCode: SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES, debitCents: 10001, creditCents: 0 },
        { accountCode: SYSTEM_CODES.CHECKING_PRIMARY, debitCents: 0, creditCents: 10000 },
      ],
    })).toThrow(/out of balance/i);
  });

  test('rejects single-line, zero-amount, dual-sided, non-integer cents, and impossible calendar dates', () => {
    expect(() => validateJournalEntryInput({
      entryDate: '2026-02-30',
      memo: 'Invalid calendar date',
      lines: [
        { accountCode: '1010', debitCents: 100, creditCents: 0 },
        { accountCode: '4000', debitCents: 0, creditCents: 100 },
      ],
    })).toThrow(/valid YYYY-MM-DD/i);

    expect(() => validateJournalEntryInput({
      entryDate: '2026-11-15',
      memo: 'Single line',
      lines: [{ accountCode: '1010', debitCents: 100, creditCents: 0 }],
    })).toThrow(/between 2 and 200/i);

    expect(() => validateJournalEntryInput({
      entryDate: '2026-11-15',
      memo: 'Both sides populated',
      lines: [
        { accountCode: '1010', debitCents: 100, creditCents: 100 },
        { accountCode: '4000', debitCents: 0, creditCents: 100 },
      ],
    })).toThrow(/strictly positive debit OR credit/i);

    expect(() => validateJournalEntryInput({
      entryDate: '2026-11-15',
      memo: 'Floating cents',
      lines: [
        { accountCode: '1010', debitCents: 100.5, creditCents: 0 },
        { accountCode: '4000', debitCents: 0, creditCents: 100.5 },
      ],
    })).toThrow(/exact integer cents/i);
  });
});

describe('Full-Cycle Accounting Proof (Subledger Rules -> Trial Balance -> P&L -> Balance Sheet -> Cash Flow)', () => {
  test('realistic Waves Pest Control operating month balances every financial statement to $0.00', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));

    // Opening Balances as of 2026-10-31: $25,000 Operating Checking, $5,000 Mercury, $35,000 Ford Transit, $15,000 Vehicle Loan -> $50,000 Equity
    const openingEntries = [
      rules.buildOpeningBalanceEntry({
        asOfDate: '2026-10-31',
        items: [
          { accountCode: SYSTEM_CODES.CHECKING_PRIMARY, balanceCents: 2500000, normalBalance: 'debit' },
          { accountCode: SYSTEM_CODES.CHECKING_PAYROLL, balanceCents: 500000, normalBalance: 'debit' },
          { accountCode: SYSTEM_CODES.FIXED_ASSETS_VEHICLES, balanceCents: 3500000, normalBalance: 'debit' },
          { accountCode: SYSTEM_CODES.LOANS_PAYABLE, balanceCents: 1500000, normalBalance: 'credit' },
        ],
      }),
    ];

    // November 2026 Operating Activity:
    const novEntries = [
      // 1. Commercial pest invoice: $1,000.00 + 7% FL sales tax ($70.00) = $1,070.00 A/R
      rules.buildInvoiceEntry({
        invoiceId: 'inv-comm-1',
        invoiceNumber: 'WPC-2026-1001',
        issueDate: '2026-11-02',
        subtotalCents: 100000,
        taxCents: 7000,
        serviceLine: 'commercial',
        isCommercial: true,
      }),
      // 2. Residential annual prepay invoice: $600.00 -> Unearned Revenue (NOT immediate revenue!)
      rules.buildInvoiceEntry({
        invoiceId: 'inv-prepay-1',
        invoiceNumber: 'WPC-2026-1002',
        issueDate: '2026-11-03',
        subtotalCents: 60000,
        taxCents: 0,
        serviceLine: 'pest',
        isAnnualPrepay: true,
      }),
      // 3. Recognize 1st quarter ($150.00) of annual prepay upon first visit completion
      rules.buildUnearnedRecognitionEntry({
        sourceId: 'inv-prepay-1',
        recognitionDate: '2026-11-05',
        amountCents: 15000,
        serviceLine: 'pest',
      }),
      // 4. Stripe captures commercial invoice ($1,070.00 gross, $31.33 fee -> $1,038.67 net to Stripe Clearing)
      rules.buildPaymentEntry({
        paymentId: 'pay-comm-1',
        paymentDate: '2026-11-04',
        grossCents: 107000,
        feeCents: 3133,
        method: 'stripe',
        serviceLine: 'commercial',
      }),
      // 5. Stripe captures annual prepay ($600.00 gross, $17.70 fee -> $582.30 net to Stripe Clearing)
      rules.buildPaymentEntry({
        paymentId: 'pay-prepay-1',
        paymentDate: '2026-11-04',
        grossCents: 60000,
        feeCents: 1770,
        method: 'stripe',
        serviceLine: 'pest',
      }),
      // 6. Partial commercial refund: $100.00 service + $7.00 FL sales tax reversed from Stripe Clearing
      rules.buildRefundEntry({
        refundId: 'ref-comm-1',
        refundDate: '2026-11-06',
        subtotalCents: 10000,
        taxCents: 700,
        method: 'stripe',
        serviceLine: 'commercial',
      }),
      // 7. Stripe payout settles exact net balance ($1,038.67 + $582.30 - $107.00 = $1,513.97) -> clears 1050 to $0.00!
      rules.buildStripePayoutEntry({
        payoutId: 'po-nov-1',
        arrivalDate: '2026-11-08',
        amountCents: 151397,
      }),
      // 8. FL DOR DR-15 sales tax remittance ($70.00 - $7.00 = $63.00) -> clears 2100 to $0.00 with ZERO P&L hit!
      rules.buildSalesTaxRemittanceEntry({
        sourceId: 'dor-nov-2026',
        paymentDate: '2026-11-20',
        amountCents: 6300,
        periodLabel: 'Nov 2026',
      }),
      // 9. Target Specialty chemical order on Business Credit Card ($250.00 -> COGS Chemicals 5200)
      rules.buildExpenseEntry({
        sourceId: 'exp-chem-1',
        entryDate: '2026-11-10',
        paymentAccountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY,
        splits: [{ accountCode: SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES, amountCents: 25000 }],
        memo: 'Target Specialty — Termidor & Alpine WSG',
      }),
      // 10. Credit card payment from Checking ($250.00 -> clears 2000 Credit Card, ZERO P&L impact!)
      rules.buildTransferEntry({
        sourceId: 'cc-pay-1',
        entryDate: '2026-11-15',
        amountCents: 25000,
        fromAccountCode: SYSTEM_CODES.CHECKING_PRIMARY,
        toAccountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY,
        memo: 'Pay Capital One Business Card',
      }),
      // 11. Vehicle loan payment split: $450.00 principal (2500) + $75.00 interest (6610 Line 16b)
      rules.buildExpenseEntry({
        sourceId: 'loan-nov-1',
        entryDate: '2026-11-15',
        paymentAccountCode: SYSTEM_CODES.CHECKING_PRIMARY,
        splits: [
          { accountCode: SYSTEM_CODES.LOANS_PAYABLE, amountCents: 45000, memo: 'Principal' },
          { accountCode: SYSTEM_CODES.OPEX_INTEREST_OTHER, amountCents: 7500, memo: 'Interest (16b)' },
        ],
        memo: 'Ford Transit monthly financing payment',
      }),
      // 12. Payroll run: $1,200 Field Tech + $400 Office CSR + employer taxes + SIMPLE 2% ($32) + HSA ($50)
      rules.buildPayrollRunEntry({
        runId: 'pr-nov-1',
        payDate: '2026-11-13',
        weekLabel: '2026-11-02',
        fieldGrossCents: 120000,
        adminGrossCents: 40000,
        fieldEmployerTaxCents: 11000,
        adminEmployerTaxCents: 3500,
        employeeTaxWithheldCents: 24000,
        employeeSimpleDeferralCents: 4800,
        employerSimpleCents: 3200,
        employerHsaCents: 5000,
        netPayCents: 131200, // 160000 - 24000 - 4800
      }),
      // 13. Mercury settles Net Pay ($1,312.00) -> clears 2290 to $0.00
      rules.buildPayrollSettlementEntry({
        sourceId: 'merc-pr-1',
        settlementDate: '2026-11-13',
        kind: 'net_pay',
        amountCents: 131200,
        bankAccountCode: SYSTEM_CODES.CHECKING_PAYROLL,
      }),
      // 14. Monthly non-cash depreciation on Ford Transit ($583.33)
      rules.buildDepreciationEntry({
        sourceId: 'depr-transit-2026-11',
        entryDate: '2026-11-30',
        amountCents: 58333,
        assetName: 'Ford Transit Van',
      }),
    ];

    const openingSums = accumulateEntries(accounts, openingEntries);
    const periodSums = accumulateEntries(accounts, novEntries);
    const cumulativeSums = accumulateEntries(accounts, [...openingEntries, ...novEntries]);

    // 1. Trial Balance must balance to the penny
    const tb = computeTrialBalance(accounts, cumulativeSums, { asOf: '2026-11-30' });
    expect(tb.balanced).toBe(true);
    expect(tb.out_of_balance_cents).toBe(0);
    expect(tb.total_debit_cents).toBe(tb.total_credit_cents);

    // 2. Profit & Loss checks
    const pnl = computeProfitAndLoss(accounts, periodSums, { from: '2026-11-01', to: '2026-11-30', basis: 'accrual' });
    // Revenue = $1,000 commercial + $150 earned prepay - $100 refund = $1,050.00 (sales tax & unearned prepay excluded!)
    expect(pnl.totals.revenue_cents).toBe(105000);
    // COGS = $1,200 field wages + $110 field ER tax + $250 chemicals + $49.03 Stripe fees = $1,609.03 (Office CSR excluded from COGS!)
    expect(pnl.totals.cogs_cents).toBe(160903);
    // OpEx = $400 admin wages + $35 admin ER tax + $32 SIMPLE + $50 HSA + $75 interest + $583.33 depr = $1,175.33 (FL DOR & CC payment excluded!)
    expect(pnl.totals.operating_expenses_cents).toBe(117533);
    expect(pnl.totals.interest_cents).toBe(7500);
    expect(pnl.totals.depreciation_cents).toBe(58333);
    expect(pnl.totals.net_income_cents).toBe(105000 - 160903 - 117533);
    // EBITDA adds back Interest ($75) + Depreciation ($583.33)
    expect(pnl.totals.ebitda_cents).toBe(pnl.totals.net_income_cents + 7500 + 58333);

    // 3. Balance Sheet checks (Assets === Liabilities + Equity)
    const bs = computeBalanceSheet(accounts, cumulativeSums, { asOf: '2026-11-30' });
    expect(bs.totals.balanced).toBe(true);
    expect(bs.totals.discrepancy_cents).toBe(0);
    expect(bs.totals.total_assets_cents).toBe(bs.totals.liabilities_and_equity_cents);

    // Verify clearing & pass-through accounts zeroed out cleanly
    const bal = (code) => {
      const a = byCode.get(code);
      const s = cumulativeSums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };
    expect(bal(SYSTEM_CODES.STRIPE_CLEARING)).toBe(0);
    expect(bal(SYSTEM_CODES.SALES_TAX_PAYABLE)).toBe(0);
    expect(bal(SYSTEM_CODES.CREDIT_CARD_PRIMARY)).toBe(0);
    expect(bal(SYSTEM_CODES.NET_PAY_CLEARING)).toBe(0);
    expect(bal(SYSTEM_CODES.UNEARNED_REVENUE)).toBe(45000); // $600 - $150 earned = $450 remaining deferred liability
    expect(bal(SYSTEM_CODES.LOANS_PAYABLE)).toBe(1455000);  // $15,000 - $450 principal paid

    // 4. Indirect Cash Flow Statement reconciles to exact ending cash balance!
    const cf = computeCashFlowStatement(accounts, periodSums, openingSums, { from: '2026-11-01', to: '2026-11-30' });
    expect(cf.summary.reconciles_to_cash).toBe(true);
    expect(cf.summary.discrepancy_cents).toBe(0);
    expect(cf.summary.beginning_cash_cents).toBe(3000000); // $25,000 CapOne + $5,000 Mercury
    // Ending cash = $30,000 + $1,513.97 payout - $63 DOR - $250 CC - $525 loan - $1,312 payroll = $29,363.97
    expect(cf.summary.ending_cash_cents).toBe(2936397);
    expect(cf.operating.depreciation_addback_cents).toBe(58333);
  });
});

describe('Reconciliation math & Vendor TIN vault', () => {
  test('computeReconciliationMath requires exact $0.00 difference to finish', () => {
    const checking = SYSTEM_ACCOUNTS.find((a) => a.code === SYSTEM_CODES.CHECKING_PRIMARY);
    const lines = [
      { debit_cents: 150000, credit_cents: 0 },
      { debit_cents: 0, credit_cents: 45000 },
    ];
    const open = computeReconciliationMath(checking, 1000000, 1105000, lines);
    expect(open.cleared_balance_cents).toBe(1105000);
    expect(open.difference_cents).toBe(0);
    expect(open.can_finish).toBe(true);

    const off = computeReconciliationMath(checking, 1000000, 1105001, lines);
    expect(off.difference_cents).toBe(1);
    expect(off.can_finish).toBe(false);
  });

  test('encryptTin encrypts in Node AES-256-GCM and publicVendor strips ciphertext', () => {
    const prevKey = process.env.ACCOUNTING_TIN_KEY;
    process.env.ACCOUNTING_TIN_KEY = 'unit-test-strong-accounting-tin-key-2026';
    try {
      const enc = encryptTin('12-3456789');
      expect(enc.tin_last4).toBe('6789');
      expect(enc.tin_enc).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
      expect(enc.tin_enc).not.toContain('123456789');

      const pub = publicVendor({ id: 'v1', display_name: 'Acme Pest Sub', tin_last4: enc.tin_last4, tin_enc: enc.tin_enc });
      expect(pub.tin_enc).toBeUndefined();
      expect(pub.has_tin).toBe(true);
      expect(pub.tin_last4).toBe('6789');
    } finally {
      if (prevKey === undefined) delete process.env.ACCOUNTING_TIN_KEY;
      else process.env.ACCOUNTING_TIN_KEY = prevKey;
    }
  });

  test('encryptTin rejects malformed TINs', () => {
    process.env.ACCOUNTING_TIN_KEY = 'unit-test-strong-accounting-tin-key-2026';
    expect(() => encryptTin('1234')).toThrow(AccountingError);
    delete process.env.ACCOUNTING_TIN_KEY;
  });
});

describe('Admin Accounting Router security & dark-gate contract', () => {
  const prevGate = process.env.GATE_ACCOUNTING_GL;
  let router;
  let mockUser = { role: 'admin', email: 'contact@wavespestcontrol.com', id: '00000000-0000-4000-8000-000000000099' };

  function invokeRouter({ method = 'GET', url = '/status', body = {} }) {
    return new Promise((resolve, reject) => {
      const headers = {};
      const req = {
        method,
        url,
        path: url.split('?')[0],
        baseUrl: '/api/admin/accounting',
        query: {},
        params: {},
        body,
        headers: { 'content-type': 'application/json' },
        ip: '127.0.0.1',
        get: (h) => headers[String(h).toLowerCase()] || null,
      };
      const res = {
        statusCode: 200,
        headers: {},
        set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ status: this.statusCode, headers: this.headers, body: payload }); return this; },
      };
      router.handle(req, res, (err) => {
        if (err) reject(err);
        else resolve({ status: 404, headers: res.headers, body: null });
      });
    });
  }

  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../models/db', () => {
      const fn = jest.fn();
      fn.raw = jest.fn((sql) => sql);
      fn.fn = { now: jest.fn(() => new Date()) };
      return fn;
    });
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, res, next) => {
        req.technician = { id: mockUser.id, email: mockUser.email, role: mockUser.role };
        req.technicianId = mockUser.id;
        req.techRole = mockUser.role;
        next();
      },
      requireAdmin: (req, res, next) => {
        if (req.techRole !== 'admin') return res.status(403).json({ error: 'Admin access required' });
        return next();
      },
    }));

    router = require('../routes/admin-accounting');
  });

  afterAll(() => {
    if (prevGate === undefined) delete process.env.GATE_ACCOUNTING_GL;
    else process.env.GATE_ACCOUNTING_GL = prevGate;
  });

  test('answers {enabled:false} on /status and 404 on other routes while GATE_ACCOUNTING_GL is off', async () => {
    delete process.env.GATE_ACCOUNTING_GL;
    mockUser = { role: 'admin', email: 'contact@wavespestcontrol.com', id: '00000000-0000-4000-8000-000000000099' };

    const s = await invokeRouter({ method: 'GET', url: '/status' });
    expect(s.status).toBe(200);
    expect(s.headers['cache-control']).toContain('no-store');
    expect(s.body).toEqual({ enabled: false });

    const r = await invokeRouter({ method: 'GET', url: '/overview' });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ enabled: false });
  });

  test('denies technician logins with 403 and denies non-owner admin writes with 403 (requireFullAccess)', async () => {
    process.env.GATE_ACCOUNTING_GL = 'true';

    mockUser = { role: 'technician', email: 'tech@wavespestcontrol.com', id: '00000000-0000-4000-8000-000000000010' };
    const techRes = await invokeRouter({ method: 'GET', url: '/status' });
    expect(techRes.status).toBe(403);

    mockUser = { role: 'admin', email: 'office@wavespestcontrol.com', id: '00000000-0000-4000-8000-000000000011' };
    const writeRes = await invokeRouter({
      method: 'POST',
      url: '/journal-entries',
      body: { entryDate: '2026-11-15', memo: 'Attempt', lines: [] },
    });
    expect(writeRes.status).toBe(403);
    expect(writeRes.body.error).toMatch(/owner account/i);
  });
});
