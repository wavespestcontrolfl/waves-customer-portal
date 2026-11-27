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
  dateCellText,
} = require('../services/accounting/coa-seed');
const {
  validateJournalEntryInput,
  AccountingError,
  getAccountRegister,
  postJournalEntry,
  linkJournalEntryVendor,
  resolveOpeningBalanceItems,
} = require('../services/accounting/ledger');
const rules = require('../services/accounting/posting-rules');
const {
  computeTrialBalance,
  computeProfitAndLoss,
  computeBalanceSheet,
  computeCashFlowStatement,
  allocateCashReceiptToRevenue,
  allocateCumulativeCashReceipt,
  buildInvoiceProfileAsOf,
  buildPayrollProfileAsOf,
  allocateCumulativePayrollSettlement,
  summarizeSalesTaxLines,
  summarize1099VendorLines,
  summarizeBalanceSheetKpis,
} = require('../services/accounting/statements');
const {
  computeReconciliationMath,
  startReconciliation,
  updateReconciliation,
  cancelReconciliation,
  toggleClearedLines,
} = require('../services/accounting/reconciliation');
const { lockPeriod } = require('../services/accounting/periods');
const {
  syncSubledgersToGl,
  billedInvoicePrincipalCents,
  extractAppliedDepositCents,
  extractSurchargeCents,
  resolvePaymentMethod,
  computeProratedRefundTaxCents,
  computeIncrementalRefundTaxCents,
  computePrepayRefundUnearnedCents,
  allocateStatementPrincipalAcrossInvoices,
  allocateStatementRefundAcrossInvoices,
  splitDepositRefundCents,
  findMatchingDepositForOutflow,
  computePrepayVisitRecognitionCents,
  computeGapReceiptAmounts,
  isDisputeOutflow,
  isInvoiceLinkedCreditRow,
  extractStripeDisputeTokens,
  buildExpenseSplits,
  buildInvoiceGlPayload,
  buildInvoiceDeltaEntry,
  resolveBankTxnGlAccount,
  classifyTaxFilingSettlement,
  timestampToUtcDate,
} = require('../services/accounting/sync-bridge');
const migrationGl = require('../models/migrations/20261127140000_accounting_gl_core');
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

  test('requires a client idempotencyKey on manual journal-entries and quick-transfer posts', async () => {
    process.env.GATE_ACCOUNTING_GL = 'true';
    mockUser = { role: 'admin', email: 'contact@wavespestcontrol.com', id: '00000000-0000-4000-8000-000000000099' };

    const jeRes = await invokeRouter({
      method: 'POST',
      url: '/journal-entries',
      body: { entryDate: '2026-11-15', memo: 'No key', lines: [] },
    });
    expect(jeRes.status).toBe(400);
    expect(jeRes.body.error).toMatch(/idempotencyKey/i);

    const xferRes = await invokeRouter({
      method: 'POST',
      url: '/quick-transfer',
      body: { entryDate: '2026-11-15', amountCents: 10000 },
    });
    expect(xferRes.status).toBe(400);
    expect(xferRes.body.error).toMatch(/idempotencyKey/i);
  });
});

describe('Round-0 Audit Regressions (Dates, Deposits, Surcharges, Fees, Cash Basis, Sales Tax, Locks, Sync)', () => {
  test('dateCellText preserves PostgreSQL DATE values without weekday truncation or timezone shift', () => {
    const localNov1 = new Date(2026, 10, 1, 0, 0, 0);
    expect(dateCellText(localNov1)).toBe('2026-11-01');
    expect(dateCellText('2026-11-27')).toBe('2026-11-27');
    expect(dateCellText('2026-11-27T00:00:00.000Z')).toBe('2026-11-27');
    expect(dateCellText(null)).toBeNull();
    expect(dateCellText('Fri Nov 27 2026')).toBeNull();
  });

  test('applied estimate deposits release 2300 Unearned Revenue and recognize full earned revenue', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));

    const depositLines = [
      { description: 'Pest treatment', amount: 100.0, category: 'service' },
      { description: 'Deposit credit (paid at acceptance)', amount: -30.0, category: 'deposit_credit' },
    ];
    expect(extractAppliedDepositCents(depositLines)).toBe(3000);

    const entries = [
      // Deposit collected ($30 face value)
      rules.buildPaymentEntry({
        paymentId: 'dep-1',
        paymentDate: '2026-11-01',
        grossCents: 3000,
        method: 'stripe',
        isDeposit: true,
      }),
      // $100 service invoice with $30 deposit applied -> $70 A/R + $30 DR 2300 / $100 CR 4000
      rules.buildInvoiceEntry({
        invoiceId: 'inv-dep-1',
        invoiceNumber: 'WPC-2026-2001',
        issueDate: '2026-11-05',
        subtotalCents: 10000,
        taxCents: 0,
        appliedDepositCents: 3000,
        serviceLine: 'pest',
      }),
      // Remaining $70 paid via Stripe
      rules.buildPaymentEntry({
        paymentId: 'pay-dep-1',
        paymentDate: '2026-11-06',
        grossCents: 7000,
        method: 'stripe',
        invoiceId: 'inv-dep-1',
        serviceLine: 'pest',
      }),
    ];

    const sums = accumulateEntries(accounts, entries);
    const bal = (code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };
    expect(bal(SYSTEM_CODES.UNEARNED_REVENUE)).toBe(0);
    expect(bal(SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(SYSTEM_CODES.REV_RESIDENTIAL_PEST)).toBe(10000);
    expect(bal(SYSTEM_CODES.STRIPE_CLEARING)).toBe(10000);
  });

  test('card surcharges split to 4085 and Stripe fees clear 1050 Stripe Clearing cleanly to $0.00', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));

    expect(extractSurchargeCents({ amount: '102.90', surcharge_amount_cents: 290 }, 10290)).toBe(290);
    expect(extractSurchargeCents({ amount: '102.90', base_amount_cents: 10000 }, 10290)).toBe(290);

    const entries = [
      rules.buildInvoiceEntry({
        invoiceId: 'inv-card-1',
        issueDate: '2026-11-02',
        subtotalCents: 10000,
        taxCents: 0,
        serviceLine: 'pest',
      }),
      rules.buildPaymentEntry({
        paymentId: 'pay-card-1',
        paymentDate: '2026-11-02',
        grossCents: 10290,
        surchargeCents: 290,
        feeCents: 0,
        method: 'stripe',
        invoiceId: 'inv-card-1',
      }),
      rules.buildStripeFeeEntry({
        txnId: 'txn_fee_1',
        feeDate: '2026-11-02',
        feeCents: 328,
      }),
      rules.buildStripePayoutEntry({
        payoutId: 'po-card-1',
        arrivalDate: '2026-11-04',
        amountCents: 9962, // 10290 - 328
      }),
    ];

    const sums = accumulateEntries(accounts, entries);
    const bal = (code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };
    expect(bal(SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(SYSTEM_CODES.STRIPE_CLEARING)).toBe(0);
    expect(bal(SYSTEM_CODES.REV_CARD_SURCHARGE)).toBe(290);
    expect(bal(SYSTEM_CODES.COGS_MERCHANT_FEES)).toBe(328);
    expect(bal(SYSTEM_CODES.CHECKING_PRIMARY)).toBe(9962);
  });

  test('pro-rata refund sales tax allocation handles full, partial, and card-surcharged refunds', () => {
    const inv = { total: '107.00', tax_amount: '7.00' };
    expect(computeProratedRefundTaxCents(10700, inv, '107.00')).toBe(700);
    expect(computeProratedRefundTaxCents(5350, inv, '107.00')).toBe(350);
    // Card-surcharged payment ($110.10 charged on $107 invoice)
    expect(computeProratedRefundTaxCents(11010, inv, '110.10')).toBe(700);
    expect(computeProratedRefundTaxCents(5505, inv, '110.10')).toBe(350);
  });

  test('cash-basis revenue allocation excludes collected sales tax (full & partial) and offsets reversals', () => {
    const accounts = makeSyntheticAccounts();
    const revIdByCode = new Map(accounts.filter((a) => a.account_type === 'revenue').map((a) => [a.code, a.id]));
    const commId = revIdByCode.get(SYSTEM_CODES.REV_COMMERCIAL_PEST);
    const profile = {
      arDebitedCents: 10700,
      taxCents: 700,
      revenueSplits: [{ accountId: commId, amountCents: 10000 }],
    };

    // Full $107 payment -> $100 pre-tax revenue (excludes $7 sales tax)
    expect(allocateCashReceiptToRevenue(10700, profile, 'commercial', revIdByCode))
      .toEqual([{ accountId: commId, signedCents: 10000 }]);

    // Partial $53.50 payment -> $50 pre-tax revenue
    expect(allocateCashReceiptToRevenue(5350, profile, 'commercial', revIdByCode))
      .toEqual([{ accountId: commId, signedCents: 5000 }]);

    // Reversal of $107 payment -> -$100 pre-tax revenue offset on reversal date
    expect(allocateCashReceiptToRevenue(-10700, profile, 'commercial', revIdByCode))
      .toEqual([{ accountId: commId, signedCents: -10000 }]);
  });

  test('FL sales tax summary classifies reversed taxable invoices as accrued reduction, never FL DOR remittance', () => {
    const out = summarizeSalesTaxLines(0, [
      { source_type: 'invoice', debit_cents: 0, credit_cents: 7000 },
      { source_type: 'reversal', reversed_source_type: 'invoice', debit_cents: 7000, credit_cents: 0 },
      { source_type: 'invoice', debit_cents: 0, credit_cents: 3500 },
      { source_type: 'refund', debit_cents: 500, credit_cents: 0 },
      { source_type: 'sales_tax_remittance', idempotency_key: 'sales-tax-remit:1', debit_cents: 3000, credit_cents: 0 },
    ]);
    expect(out.tax_accrued_cents).toBe(3500);
    expect(out.tax_reversed_on_refunds_cents).toBe(500);
    expect(out.net_tax_due_for_period_cents).toBe(3000);
    expect(out.tax_remitted_cents).toBe(3000);
    expect(out.ending_payable_cents).toBe(0);
  });

  test('postJournalEntry and lockPeriod both acquire the same month advisory lock before checking gl_periods', async () => {
    const rawCalls = [];
    const makeTrx = (periodRow) => {
      const trx = (table) => {
        const chain = {
          where: () => chain,
          orWhereIn: () => chain,
          forUpdate: () => chain,
          select: () => Promise.resolve(table === 'gl_accounts'
            ? [
              { id: '00000000-0000-4000-8000-000000000001', code: '1010', name: 'Checking', active: true, account_type: 'asset', normal_balance: 'debit' },
              { id: '00000000-0000-4000-8000-000000000002', code: '4000', name: 'Revenue', active: true, account_type: 'revenue', normal_balance: 'credit' },
            ]
            : []),
          first: () => Promise.resolve(table === 'gl_periods' ? periodRow : null),
          insert: () => ({ returning: () => Promise.resolve([{ id: '00000000-0000-4000-8000-000000000099', period_month: '2026-11', status: 'locked' }]) }),
          update: () => ({ returning: () => Promise.resolve([{ id: '00000000-0000-4000-8000-000000000099', period_month: '2026-11', status: 'locked' }]) }),
        };
        return chain;
      };
      trx.raw = (sql, bindings) => { rawCalls.push({ sql, bindings }); return Promise.resolve(); };
      trx.fn = { now: () => new Date() };
      trx.isTransaction = true;
      trx.transaction = (cb) => cb(trx);
      return trx;
    };

    const lockedTrx = makeTrx({ status: 'locked' });
    await expect(postJournalEntry({
      entryDate: '2026-11-15',
      memo: 'Blocked post',
      lines: [
        { accountCode: '1010', debitCents: 100, creditCents: 0 },
        { accountCode: '4000', debitCents: 0, creditCents: 100 },
      ],
    }, { conn: lockedTrx })).rejects.toThrow(/locked/i);

    const openTrx = makeTrx(null);
    await lockPeriod('2026-11', { conn: openTrx, notes: 'Month closed' });

    const lockCalls = rawCalls.filter((c) => c.sql.includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(2);
    expect(lockCalls[0].bindings).toEqual(['gl-period:2026-11']);
    expect(lockCalls[1].bindings).toEqual(['gl-period:2026-11']);
  });

  test('getAccountRegister computes closing_balance_cents across the full period beyond the page limit', async () => {
    const acctId = '00000000-0000-4000-8000-000000000001';
    const fakeConn = (table) => {
      const chain = {
        join: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        offset: () => chain,
        clone: () => chain,
        first: () => {
          if (table === 'gl_accounts') {
            return Promise.resolve({ id: acctId, code: '1010', name: 'Checking', account_type: 'asset', normal_balance: 'debit' });
          }
          // Full period has 3 transactions totaling $300 debit, even though page limit returns 2 ($200).
          return Promise.resolve({ total: 3, debit_cents: 30000, credit_cents: 0 });
        },
        select: () => Promise.resolve([
          { id: 'l1', entry_id: 'e1', entry_number: 1, entry_date: '2026-11-01', entry_type: 'operational', source_type: 'manual', entry_memo: 'Tx 1', debit_cents: 10000, credit_cents: 0 },
          { id: 'l2', entry_id: 'e2', entry_number: 2, entry_date: '2026-11-02', entry_type: 'operational', source_type: 'manual', entry_memo: 'Tx 2', debit_cents: 10000, credit_cents: 0 },
        ]),
      };
      return chain;
    };
    fakeConn.raw = (sql) => sql;

    const reg = await getAccountRegister(acctId, { limit: 2, offset: 0, conn: fakeConn });
    expect(reg.total).toBe(3);
    expect(reg.page_closing_balance_cents).toBe(20000);
    expect(reg.closing_balance_cents).toBe(30000);
  });

  test('startReconciliation rejects statement dates at or before the latest finalized statement', async () => {
    const acctId = '00000000-0000-4000-8000-000000000001';
    const fakeConn = (table) => {
      const state = { whereObj: null };
      const chain = {
        where: (obj) => { state.whereObj = obj; return chain; },
        orderBy: () => chain,
        select: () => chain,
        first: () => {
          if (table === 'gl_accounts') {
            return Promise.resolve({ id: acctId, code: '1010', name: 'Checking', sub_type: 'checking', account_type: 'asset', normal_balance: 'debit' });
          }
          if (table === 'gl_reconciliations' && state.whereObj?.status === 'in_progress') {
            return Promise.resolve(null);
          }
          if (table === 'gl_reconciliations' && state.whereObj?.status === 'reconciled') {
            return Promise.resolve({ statement_end_date: '2026-02-28', ending_balance_cents: 500000 });
          }
          return Promise.resolve(null);
        },
      };
      return chain;
    };
    fakeConn.raw = (sql) => sql;
    fakeConn.transaction = (cb) => cb(fakeConn);

    await expect(startReconciliation({
      accountId: acctId,
      statementEndDate: '2026-01-31',
      endingBalanceCents: 400000,
      conn: fakeConn,
    })).rejects.toThrow(/must be after the latest finalized statement \(2026-02-28\)/i);
  });

  test('syncSubledgersToGl dryRun checks existing keys & locked periods and uses injected conn exclusively', async () => {
    const accounts = makeSyntheticAccounts();
    const existingKeys = new Set(['invoice:inv-already-posted']);
    const lockedMonths = new Set(['2026-10']);

    const makeBuilder = (table) => {
      const state = { whereObj: null };
      const chain = {
        leftJoin: () => chain,
        join: () => chain,
        where: (a) => { if (a && typeof a === 'object') state.whereObj = a; return chain; },
        whereIn: () => chain,
        whereNotIn: () => chain,
        whereNull: () => chain,
        whereNotNull: () => chain,
        whereBetween: () => chain,
        whereRaw: () => chain,
        whereNot: () => chain,
        whereExists: () => chain,
        whereNotExists: () => chain,
        orWhere: () => chain,
        orWhereIn: () => chain,
        orWhereRaw: () => chain,
        orderBy: () => chain,
        select: () => {
          if (table === 'gl_accounts') return Promise.resolve(accounts);
          if (table === 'gl_periods') return Promise.resolve([...lockedMonths].map((m) => ({ period_month: m, status: 'locked' })));
          if (table === 'invoices as i' && !state.whereObj?.['i.status']) {
            return Promise.resolve([
              { id: 'inv-already-posted', invoice_number: 'WPC-1', customer_id: null, subtotal: '100', discount_amount: '0', tax_amount: '0', total: '100', credit_applied: '0', line_items: '[]', service_type: 'pest', service_date: '2026-11-05', property_type: 'single_family' },
              { id: 'inv-locked', invoice_number: 'WPC-2', customer_id: null, subtotal: '100', discount_amount: '0', tax_amount: '0', total: '100', credit_applied: '0', line_items: '[]', service_type: 'pest', service_date: '2026-10-15', property_type: 'single_family' },
              { id: 'inv-new', invoice_number: 'WPC-3', customer_id: null, subtotal: '100', discount_amount: '0', tax_amount: '0', total: '100', credit_applied: '0', line_items: '[]', service_type: 'pest', service_date: '2026-11-10', property_type: 'single_family' },
            ]);
          }
          if (table === 'gl_vendors') {
            return Promise.resolve([{ id: '00000000-0000-4000-8000-000000000777', display_name: 'Registered Sub', legal_name: null, is_1099_eligible: true, active: true }]);
          }
          if (table === 'expenses as e') {
            return Promise.resolve([
              { id: 'exp-1', category_id: null, description: 'Sub work', amount: '250.00', tax_deductible_amount: null, expense_date: '2026-11-12', vendor_name: 'Unregistered Sub', payment_method: 'check', category_name: 'Contract Labor' },
            ]);
          }
          if (table === 'payroll_runs as pr') {
            return Promise.resolve([
              { id: '00000000-0000-4000-8000-000000000888', reversed_by_entry_id: null, run_id: 'run-void-1', pay_date: '2026-11-06', voided_at: '2026-11-08T15:00:00Z', void_reason: 'Corrected hours' },
            ]);
          }
          return Promise.resolve([]);
        },
        first: () => {
          if (table === 'gl_journal_entries' && state.whereObj?.idempotency_key) {
            return Promise.resolve(existingKeys.has(state.whereObj.idempotency_key) ? { id: 'existing-je' } : null);
          }
          return Promise.resolve(null);
        },
      };
      return chain;
    };

    const injectedConn = (table) => makeBuilder(table);
    injectedConn.raw = (sql) => sql;
    injectedConn.schema = { hasTable: () => Promise.resolve(true) };

    const preview = await syncSubledgersToGl({ fromDate: '2026-10-01', toDate: '2026-11-30', dryRun: true, conn: injectedConn });
    expect(preview.invoices.would_post).toBe(1);
    expect(preview.invoices.skipped).toBe(1);
    expect(preview.invoices.errors).toHaveLength(1);
    expect(preview.invoices.errors[0].message).toMatch(/2026-10 is locked/i);
    expect(preview.expenses.unmatched_contractor_vendors).toEqual([
      { vendor_name: 'Unregistered Sub', count: 1, total_cents: 25000 },
    ]);
    expect(preview.payroll_runs.would_reverse).toBe(1);
    expect(preview.missing_system_accounts).toEqual([]);
  });

  test('manual tender resolution routes checks/cash/unknown to Undeposited Funds and zelle/ach to Checking', () => {
    expect(resolvePaymentMethod({ metadata: { payment_method: 'check' } })).toBe('check');
    expect(resolvePaymentMethod({ metadata: { payment_method: 'cash' } })).toBe('cash');
    expect(resolvePaymentMethod({ metadata: { payment_method: 'zelle' } })).toBe('zelle');
    expect(resolvePaymentMethod({ payment_method_type: 'us_bank_account' })).toBe('ach_direct');
    expect(resolvePaymentMethod({})).toBe('check');
    const checkJe = rules.buildPaymentEntry({
      paymentId: 'p-check',
      paymentDate: '2026-11-12',
      grossCents: 15000,
      method: resolvePaymentMethod({ metadata: { payment_method: 'check' } }),
    });
    expect(checkJe.lines[0].accountCode).toBe(SYSTEM_CODES.UNDEPOSITED_FUNDS);
  });

  test('expense sync keeps partial tax deductibility as full book expense and splits owner draw only for shared bills', () => {
    const suppliesAcct = { id: 'acc-5200', code: '5200', schedule_c_line: '22' };
    // $100 supplies with $60 tax deduction -> 100% book expense (NO bogus $40 owner draw!)
    const nonShared = buildExpenseSplits(
      { amount: '100.00', tax_deductible_amount: '60.00', notes: 'Partial deduction note' },
      suppliesAcct,
      null,
      10000,
    );
    expect(nonShared).toHaveLength(1);
    expect(nonShared[0].amountCents).toBe(10000);
    expect(nonShared[0].accountId).toBe('acc-5200');

    // Explicit shared bill marker -> 60% business expense, 40% Owner Draws
    const shared = buildExpenseSplits(
      { amount: '100.00', tax_deductible_amount: '60.00', notes: 'Verizon [Shared bill: Cell Plan 60%]' },
      suppliesAcct,
      null,
      10000,
    );
    expect(shared).toEqual([
      { accountId: 'acc-5200', accountCode: null, amountCents: 6000, scheduledServiceId: undefined },
      { accountCode: SYSTEM_CODES.OWNER_DRAWS, amountCents: 4000, memo: 'Shared bill personal share' },
    ]);
  });

  test('payer statement receipts allocate A/R across child invoices and unused deposit refunds clear 2300 without P&L hit', () => {
    const cust1 = '00000000-0000-4000-8000-000000000101';
    const cust2 = '00000000-0000-4000-8000-000000000102';
    const allocs = allocateStatementPrincipalAcrossInvoices(20700, [
      { id: 'inv-1', customer_id: cust1, total: '107.00', credit_applied: '0', service_type: 'commercial', property_type: 'commercial' },
      { id: 'inv-2', customer_id: cust2, total: '100.00', credit_applied: '0', service_type: 'pest', property_type: 'single_family' },
    ]);
    expect(allocs).toHaveLength(2);
    const payJe = rules.buildPaymentEntry({
      paymentId: 'stmt-pay-1',
      paymentDate: '2026-11-15',
      grossCents: 20700,
      method: 'stripe',
      arAllocations: allocs,
    });
    expect(validateJournalEntryInput(payJe).totalCents).toBe(20700);
    expect(payJe.lines.filter((l) => l.accountCode === SYSTEM_CODES.ACCOUNTS_RECEIVABLE).map((l) => l.invoiceRef))
      .toEqual(['inv-1', 'inv-2']);

    // Unused deposit refund ($100 face + $3 surcharge = $103 refunded) clears 2300 + 4085 with zero accrual P&L hit
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const split = splitDepositRefundCents(10300, { amount: '100.00', card_surcharge: '3.00' });
    expect(split).toEqual({ principalCents: 10000, surchargeCents: 300 });
    const sums = accumulateEntries(accounts, [
      rules.buildPaymentEntry({
        paymentId: 'dep-ref-1',
        paymentDate: '2026-11-01',
        grossCents: 10300,
        surchargeCents: 300,
        isDeposit: true,
      }),
      rules.buildDepositRefundEntry({
        txnId: 'txn_dep_ref_1',
        refundDate: '2026-11-05',
        principalCents: split.principalCents,
        surchargeCents: split.surchargeCents,
      }),
    ]);
    const bal = (code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };
    expect(bal(SYSTEM_CODES.UNEARNED_REVENUE)).toBe(0);
    expect(bal(SYSTEM_CODES.REV_CARD_SURCHARGE)).toBe(0);
    expect(bal(SYSTEM_CODES.REV_REFUNDS_ALLOWANCES)).toBe(0);
    expect(bal(SYSTEM_CODES.STRIPE_CLEARING)).toBe(0);
  });

  test('buildInvoiceDeltaEntry creates exact balanced adjustment when invoice source changes', () => {
    const desired = rules.buildInvoiceEntry({
      invoiceId: 'inv-edit-1',
      invoiceNumber: 'WPC-99',
      issueDate: '2026-11-01',
      subtotalCents: 12000,
      taxCents: 840,
      serviceLine: 'commercial',
      isCommercial: true,
    });
    // Previously booked as $100 + $7 tax
    const booked = new Map([
      [SYSTEM_CODES.ACCOUNTS_RECEIVABLE, 10700],
      [SYSTEM_CODES.REV_COMMERCIAL_PEST, -10000],
      [SYSTEM_CODES.SALES_TAX_PAYABLE, -700],
    ]);
    const adj = buildInvoiceDeltaEntry({ id: 'inv-edit-1', invoice_number: 'WPC-99' }, desired.lines, booked, '2026-11-10');
    expect(adj).not.toBeNull();
    expect(validateJournalEntryInput(adj).totalCents).toBe(2140);
  });

  test('cumulative cash-basis allocation eliminates rounding drift across odd-cent partial payments', () => {
    const accounts = makeSyntheticAccounts();
    const revIdByCode = new Map(accounts.filter((a) => a.account_type === 'revenue').map((a) => [a.code, a.id]));
    const commId = revIdByCode.get(SYSTEM_CODES.REV_COMMERCIAL_PEST);
    // $2.00 revenue + $0.14 tax = $2.14 A/R, paid in 3 odd-cent installments ($0.71, $0.71, $0.72)
    const profile = { arDebitedCents: 214, taxCents: 14, revenueSplits: [{ accountId: commId, amountCents: 200 }] };
    const p1 = allocateCumulativeCashReceipt(0, 71, profile, 'commercial', revIdByCode);
    const p2 = allocateCumulativeCashReceipt(71, 71, profile, 'commercial', revIdByCode);
    const p3 = allocateCumulativeCashReceipt(142, 72, profile, 'commercial', revIdByCode);
    const totalRev = (p1[0]?.signedCents || 0) + (p2[0]?.signedCents || 0) + (p3[0]?.signedCents || 0);
    expect(totalRev).toBe(200);
  });

  test('1099-NEC summary excludes card, debit-card, credit-card-paid, and platform (1099-K) payments', () => {
    const out = summarize1099VendorLines([
      { vendor_id: 'v1', display_name: 'Bob Contractor', entity_type: 'sole_prop', w9_received_at: '2026-01-10', entry_id: 'e1', payment_method: 'check', debit_cents: 150000, credit_cents: 0, paid_by_credit_card: false },
      { vendor_id: 'v1', display_name: 'Bob Contractor', entity_type: 'sole_prop', w9_received_at: '2026-01-10', entry_id: 'e2', payment_method: 'card', debit_cents: 100000, credit_cents: 0, paid_by_credit_card: true },
      { vendor_id: 'v1', display_name: 'Bob Contractor', entity_type: 'sole_prop', w9_received_at: '2026-01-10', entry_id: 'e3', payment_method: 'ach', entry_memo: 'Upwork freelancer invoice', debit_cents: 80000, credit_cents: 0, paid_by_credit_card: false },
    ], [], 200000);
    expect(out.vendors[0].total_paid_cents).toBe(150000);
    expect(out.vendors[0].excluded_1099k_cents).toBe(180000);
    expect(out.vendors[0].filing_required).toBe(false);
    expect(out.excluded_1099k_count).toBe(2);
  });

  test('reconciliation enforces opening balance continuity after first statement and audits cleared line toggles', async () => {
    const acctId = '00000000-0000-4000-8000-000000000001';
    const recId = '00000000-0000-4000-8000-000000000055';
    const lineId = '00000000-0000-4000-8000-000000000066';
    const fakeConn = (table) => {
      const state = { whereObj: null };
      const chain = {
        where: (obj) => { state.whereObj = obj; return chain; },
        orderBy: () => chain,
        select: () => chain,
        first: () => {
          if (table === 'gl_accounts') {
            return Promise.resolve({ id: acctId, code: '1010', name: 'Checking', sub_type: 'checking', account_type: 'asset', normal_balance: 'debit' });
          }
          if (table === 'gl_reconciliations' && state.whereObj?.status === 'in_progress') return Promise.resolve(null);
          if (table === 'gl_reconciliations' && state.whereObj?.status === 'reconciled') {
            return Promise.resolve({ statement_end_date: '2026-02-28', ending_balance_cents: 500000 });
          }
          return Promise.resolve(null);
        },
      };
      return chain;
    };
    fakeConn.raw = (sql) => sql;
    fakeConn.transaction = (cb) => cb(fakeConn);

    await expect(startReconciliation({
      accountId: acctId,
      statementEndDate: '2026-03-31',
      openingBalanceCents: 999999,
      endingBalanceCents: 999999,
      conn: fakeConn,
    })).rejects.toThrow(/must match the prior finalized statement ending balance/i);

    const audited = [];
    const toggleConn = (table) => {
      const chain = {
        join: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        whereIn: () => chain,
        whereNull: () => chain,
        orWhere: () => chain,
        forUpdate: () => chain,
        orderBy: () => chain,
        select: () => {
          if (table === 'gl_journal_lines') return Promise.resolve([{ debit_cents: 10000, credit_cents: 0 }]);
          if (table === 'gl_journal_lines as l') return Promise.resolve([]);
          return chain;
        },
        first: () => {
          if (table === 'gl_reconciliations') {
            return Promise.resolve({ id: recId, account_id: acctId, status: 'in_progress', statement_end_date: '2026-03-31', opening_balance_cents: 500000, ending_balance_cents: 510000 });
          }
          if (table === 'gl_accounts') {
            return Promise.resolve({ id: acctId, code: '1010', name: 'Checking', account_type: 'asset', normal_balance: 'debit' });
          }
          return Promise.resolve(null);
        },
        update: () => ({ returning: () => Promise.resolve([{ id: lineId }]) }),
        insert: (row) => {
          audited.push({ table, row });
          return { returning: () => Promise.resolve([{ id: 'audit-1' }]) };
        },
      };
      return chain;
    };
    toggleConn.raw = (sql) => sql;
    toggleConn.fn = { now: () => new Date() };
    toggleConn.transaction = (cb) => cb(toggleConn);

    await toggleClearedLines(recId, { lineIds: [lineId], cleared: true, actorId: '00000000-0000-4000-8000-000000000099', conn: toggleConn });
    expect(audited.some((a) => a.table === 'audit_log' && a.row.action === 'accounting.reconciliation.clear_lines')).toBe(true);
  });

  test('migration down() refuses rollback once accounting evidence or customized COA exists', async () => {
    const makeStub = (hitTable) => {
      const fn = (tbl) => {
        const chain = {
          where: () => chain,
          orWhere: () => chain,
          orWhereNotNull: () => chain,
          orWhereRaw: () => chain,
          first: () => Promise.resolve(tbl === hitTable ? { id: 'row-1' } : null),
        };
        return chain;
      };
      fn.schema = { hasTable: () => Promise.resolve(true) };
      return fn;
    };
    await expect(migrationGl.down(makeStub('gl_journal_entries'))).rejects.toThrow(/holds accounting evidence/i);
    await expect(migrationGl.down(makeStub('gl_accounts'))).rejects.toThrow(/gl_accounts holds custom/i);
  });

  test('Pass-3: card-surcharge-rewritten invoice total bills pre-surcharge principal and clears A/R to $0.00', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    // Stripe card surcharge overwrote invoices.total from $100.00 to $102.90 while subtotal stayed $100.00
    const inv = {
      id: 'inv-sur-1',
      invoice_number: 'WPC-SUR-1',
      subtotal: '100.00',
      discount_amount: '0.00',
      tax_amount: '0.00',
      total: '102.90',
      credit_applied: '0.00',
      line_items: '[]',
      service_type: 'pest',
      service_date: '2026-11-12',
      property_type: 'single_family',
    };
    expect(billedInvoicePrincipalCents(inv)).toBe(10000);
    const invJe = buildInvoiceGlPayload(inv, new Set());
    const payJe = rules.buildPaymentEntry({
      paymentId: 'pay-sur-1',
      paymentDate: '2026-11-12',
      grossCents: 10290,
      surchargeCents: 290,
      feeCents: 0,
      method: 'stripe',
      invoiceId: inv.id,
    });
    const sums = accumulateEntries(accounts, [invJe, payJe]);
    const bal = (code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };
    expect(bal(SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(SYSTEM_CODES.REV_RESIDENTIAL_PEST)).toBe(10000);
    expect(bal(SYSTEM_CODES.REV_CARD_SURCHARGE)).toBe(290);
    expect(bal(SYSTEM_CODES.STRIPE_CLEARING)).toBe(10290);
  });

  test('Pass-3: annual-prepay coverage conversion, zeroing edit, and repeated A->B->A->B edits stay balanced with unique keys', () => {
    // 1. Regular invoice posted for $100 (DR 1100 10000 / CR 4000 10000), then converted to annual-prepay covered visit
    const coveredInv = {
      id: 'inv-cov-1',
      invoice_number: 'WPC-COV-1',
      annual_prepay_covered_term_id: 'term-1',
      subtotal: '100.00',
      discount_amount: '0.00',
      tax_amount: '0.00',
      total: '0.00',
      service_type: 'pest',
      service_date: '2026-11-10',
      property_type: 'single_family',
    };
    const desiredCovered = buildInvoiceGlPayload(coveredInv, new Set());
    expect(desiredCovered.sourceType).toBe('invoice');
    expect(desiredCovered.sourceId).toBe('inv-cov-1');

    const alreadyBookedRegular = new Map([
      [SYSTEM_CODES.ACCOUNTS_RECEIVABLE, 10000],
      [SYSTEM_CODES.REV_RESIDENTIAL_PEST, -10000],
    ]);
    const conversionDelta = buildInvoiceDeltaEntry(coveredInv, desiredCovered.lines, alreadyBookedRegular, '2026-11-12', 1);
    expect(validateJournalEntryInput(conversionDelta).totalCents).toBe(10000);
    // Only reclasses DR 2300 / CR 1100 — zero revenue doubling!
    expect(conversionDelta.lines.map((l) => [l.accountCode, l.debitCents, l.creditCents]).sort()).toEqual([
      [SYSTEM_CODES.ACCOUNTS_RECEIVABLE, 0, 10000],
      [SYSTEM_CODES.UNEARNED_REVENUE, 10000, 0],
    ]);

    // 2. Reducing a previously posted $107 invoice to $0 zeroes out A/R, revenue, and tax cleanly
    const bookedTaxable = new Map([
      [SYSTEM_CODES.ACCOUNTS_RECEIVABLE, 10700],
      [SYSTEM_CODES.REV_COMMERCIAL_PEST, -10000],
      [SYSTEM_CODES.SALES_TAX_PAYABLE, -700],
    ]);
    const zeroDelta = buildInvoiceDeltaEntry({ id: 'inv-zero-1', invoice_number: 'WPC-Z1' }, [], bookedTaxable, '2026-11-14', 1);
    expect(validateJournalEntryInput(zeroDelta).totalCents).toBe(10700);

    // 3. Repeated edits A->B->A->B receive distinct sequence keys so returning to B is never suppressed
    const lines120 = rules.buildInvoiceEntry({ invoiceId: 'inv-aba', issueDate: '2026-11-01', subtotalCents: 12000, taxCents: 0 }).lines;
    const booked100 = new Map([[SYSTEM_CODES.ACCOUNTS_RECEIVABLE, 10000], [SYSTEM_CODES.REV_RESIDENTIAL_PEST, -10000]]);
    const edit1 = buildInvoiceDeltaEntry({ id: 'inv-aba' }, lines120, booked100, '2026-11-02', 1);
    const edit3 = buildInvoiceDeltaEntry({ id: 'inv-aba' }, lines120, booked100, '2026-11-04', 3);
    expect(edit1.idempotencyKey).not.toBe(edit3.idempotencyKey);
  });

  test('Pass-3: manual Zelle audit marker, verified deposit refunds, cumulative refund tax, and UTC payout date', () => {
    // Manual payment recorded via Zelle recovers 'zelle' (1010 Checking) from audit marker
    expect(resolvePaymentMethod({}, null, { invoiceId: 'inv-1', method: 'zelle' })).toBe('zelle');

    // Deposit outflow matching refuses blind single-candidate guess when amount & PI don't match
    const depMaps = {
      byPi: new Map([['pi_dep_exact', { id: 'dep-1', amount: '100.00', refunded_amount: '100.00', card_surcharge: '0' }]]),
      byCustomer: new Map([['cust-1', [{ id: 'dep-1', amount: '100.00', refunded_amount: '100.00', card_surcharge: '0' }]]]),
    };
    expect(findMatchingDepositForOutflow({ customer_id: 'cust-1', description: 'Unrelated refund' }, 7500, depMaps))
      .toEqual({ deposit: null, ambiguous: true });
    expect(findMatchingDepositForOutflow({ customer_id: 'cust-1', description: 'Refund for pi_dep_exact' }, 7500, depMaps).deposit?.id)
      .toBe('dep-1');
    expect(findMatchingDepositForOutflow({ customer_id: 'cust-1', description: 'Exact match' }, 10000, depMaps).deposit?.id)
      .toBe('dep-1');

    // Cumulative Stripe refund sales-tax allocation: two partial refunds on $1.07 (7c tax) reverse 4c + 3c = 7c (never 8c)
    const inv = { subtotal: '1.00', discount_amount: '0', tax_amount: '0.07', total: '1.07' };
    const tax1 = computeIncrementalRefundTaxCents(0, 0, 54, inv, '1.07');
    const tax2 = computeIncrementalRefundTaxCents(54, tax1, 53, inv, '1.07');
    expect(tax1).toBe(4);
    expect(tax2).toBe(3);
    expect(tax1 + tax2).toBe(7);
    // Dispute win reverses the exact tax back
    expect(computeIncrementalRefundTaxCents(107, 7, -53, inv, '1.07')).toBe(3);

    // Midnight UTC Stripe payout arrival_date preserves UTC calendar day (never shifts 1 day early in ET)
    expect(timestampToUtcDate('2026-12-01T00:00:00Z')).toBe('2026-12-01');
  });

  test('Pass-3: opening balances require authoritative normalBalance and postJournalEntry rejects conflicting idempotency reuse', async () => {
    expect(() => rules.buildOpeningBalanceEntry({
      asOfDate: '2026-01-01',
      items: [{ accountCode: '1010', balanceCents: 50000 }],
    })).toThrow(/requires explicit normalBalance/i);

    const acc1010 = { id: '00000000-0000-4000-8000-000000000001', code: '1010', name: 'Checking', active: true, account_type: 'asset', normal_balance: 'debit' };
    const acc4000 = { id: '00000000-0000-4000-8000-000000000002', code: '4000', name: 'Revenue', active: true, account_type: 'revenue', normal_balance: 'credit' };
    const lookupConn = () => {
      const chain = {
        where: () => chain,
        orWhereIn: () => chain,
        select: () => Promise.resolve([acc1010, acc4000]),
      };
      return chain;
    };
    const resolved = await resolveOpeningBalanceItems([{ accountCode: '1010', balanceCents: 50000 }], { conn: lookupConn });
    expect(resolved[0].normalBalance).toBe('debit');
    await expect(resolveOpeningBalanceItems([{ accountCode: '1010', balanceCents: 50000, normalBalance: 'credit' }], { conn: lookupConn }))
      .rejects.toThrow(/conflicts with stored normal balance/i);

    // postJournalEntry with reused idempotencyKey: identical payload -> { created: false }, different payload -> 409 IDEMPOTENCY_CONFLICT
    const existingEntryRow = {
      id: '00000000-0000-4000-8000-000000000077',
      entry_date: '2026-11-15',
      entry_type: 'adjusting',
      basis_scope: 'both',
      source_type: 'manual',
      memo: 'Owner adjustment',
    };
    const existingLines = [
      { account_id: acc1010.id, debit_cents: 10000, credit_cents: 0, customer_id: null, vendor_id: null, invoice_ref: null },
      { account_id: acc4000.id, debit_cents: 0, credit_cents: 10000, customer_id: null, vendor_id: null, invoice_ref: null },
    ];
    const idemTrx = (table) => {
      const chain = {
        where: () => chain,
        orWhereIn: () => chain,
        join: () => chain,
        leftJoin: () => chain,
        orderBy: () => chain,
        select: () => {
          if (table === 'gl_accounts') return Promise.resolve([acc1010, acc4000]);
          if (table === 'gl_journal_lines as l') return Promise.resolve(existingLines);
          return chain;
        },
        first: () => Promise.resolve(table === 'gl_journal_entries' ? existingEntryRow : null),
      };
      return chain;
    };
    idemTrx.raw = (sql) => sql;
    idemTrx.isTransaction = true;

    const sameRes = await postJournalEntry({
      entryDate: '2026-11-15',
      entryType: 'adjusting',
      memo: 'Owner adjustment',
      idempotencyKey: 'manual-form-key-1',
      lines: [
        { accountCode: '1010', debitCents: 10000, creditCents: 0 },
        { accountCode: '4000', debitCents: 0, creditCents: 10000 },
      ],
    }, { conn: idemTrx });
    expect(sameRes.created).toBe(false);

    await expect(postJournalEntry({
      entryDate: '2026-11-15',
      entryType: 'adjusting',
      memo: 'Owner adjustment',
      idempotencyKey: 'manual-form-key-1',
      lines: [
        { accountCode: '1010', debitCents: 25000, creditCents: 0 },
        { accountCode: '4000', debitCents: 0, creditCents: 25000 },
      ],
    }, { conn: idemTrx })).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  test('Pass-4: disputes restore A/R (no negative A/R on replacement pay), gap receipts include surcharge, and prepay visits recognize without base invoice', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));

    // 1. Collectible dispute lifecycle: Invoice ($100) -> Stripe pay ($102.90 w/ $2.90 surcharge) -> Dispute withdrawal (-$102.90) -> Replacement pay ($100)
    const disputeCycle = accumulateEntries(accounts, [
      rules.buildInvoiceEntry({ invoiceId: 'inv-disp-1', issueDate: '2026-11-01', subtotalCents: 10000, taxCents: 0 }),
      rules.buildPaymentEntry({ paymentId: 'pay-disp-1', paymentDate: '2026-11-02', grossCents: 10290, surchargeCents: 290, method: 'stripe', invoiceId: 'inv-disp-1' }),
      rules.buildDisputeWithdrawalEntry({ txnId: 'dp_1', disputeDate: '2026-11-10', grossCents: 10290, surchargeCents: 290, invoiceId: 'inv-disp-1' }),
      rules.buildPaymentEntry({ paymentId: 'pay-disp-2', paymentDate: '2026-11-15', grossCents: 10000, surchargeCents: 0, method: 'ach_direct', invoiceId: 'inv-disp-1' }),
    ]);
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };
    expect(bal(disputeCycle, SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(disputeCycle, SYSTEM_CODES.REV_RESIDENTIAL_PEST)).toBe(10000);
    expect(bal(disputeCycle, SYSTEM_CODES.REV_CARD_SURCHARGE)).toBe(0);
    expect(bal(disputeCycle, SYSTEM_CODES.STRIPE_CLEARING)).toBe(0);
    expect(bal(disputeCycle, SYSTEM_CODES.CHECKING_PRIMARY)).toBe(10000);
    expect(isDisputeOutflow({ reporting_category: 'dispute' })).toBe(true);
    expect(isDisputeOutflow({ reporting_category: 'refund' })).toBe(false);

    // 2. Gap receipt recovery preserves collected card surcharge ($102.90 gross = $100 principal + $2.90 surcharge)
    const gapInv = { subtotal: '100.00', discount_amount: '0', tax_amount: '0', total: '102.90', credit_applied: '0', line_items: '[]' };
    expect(computeGapReceiptAmounts(gapInv)).toEqual({ grossCents: 10290, surchargeCents: 290 });

    // 3. Completed annual-prepay covered visit without base invoice derives recognition amount from visit/term
    expect(computePrepayVisitRecognitionCents({ prepaid_amount: '95.00', estimated_price: '100.00' })).toBe(9500);
    expect(computePrepayVisitRecognitionCents({ prepaid_amount: null, estimated_price: '0', term_prepay_amount: '600.00', coverage_visit_count: 6 })).toBe(10000);

    // 4. Draft payer-statement child invoice accrues cleanly using statement finalization date
    const stmtChild = {
      id: 'inv-stmt-1',
      status: 'draft',
      payer_statement_id: 42,
      statement_status: 'finalized',
      statement_finalized_at: '2026-11-20T15:00:00Z',
      subtotal: '250.00',
      discount_amount: '0',
      tax_amount: '17.50',
      total: '267.50',
      service_type: 'Commercial Quarterly Pest Control',
      property_type: 'commercial',
    };
    const stmtJe = buildInvoiceGlPayload(stmtChild, new Set());
    expect(stmtJe.entryDate).toBe('2026-11-20');
    expect(validateJournalEntryInput(stmtJe).totalCents).toBe(26750);
  });

  test('Pass-4: service labels map to real revenue accounts, malformed opening balances fail 400, and historical cash profiles ignore later edits', () => {
    // 1. Real Waves service labels map to canonical revenue accounts instead of 4095 Other
    expect(rules.revenueAccountCodeFor('Quarterly Pest Control', false)).toBe(SYSTEM_CODES.REV_RESIDENTIAL_PEST);
    expect(rules.revenueAccountCodeFor('Bi-Monthly Mosquito Control', false)).toBe(SYSTEM_CODES.REV_RESIDENTIAL_PEST);
    expect(rules.revenueAccountCodeFor('Lawn & Shrub Fertilization', false)).toBe(SYSTEM_CODES.REV_LAWN_TREE_SHRUB);
    expect(rules.revenueAccountCodeFor('Termite Monitoring & Bait Stations', false)).toBe(SYSTEM_CODES.REV_TERMITE_PROJECTS);
    expect(rules.revenueAccountCodeFor('Rodent Exclusion Project', false)).toBe(SYSTEM_CODES.REV_TERMITE_PROJECTS);
    expect(rules.revenueAccountCodeFor('Commercial Kitchen Service', false)).toBe(SYSTEM_CODES.REV_COMMERCIAL_PEST);

    // 2. Malformed opening balances throw 400 instead of silently turning into 0
    expect(() => rules.buildOpeningBalanceEntry({
      asOfDate: '2026-01-01',
      items: [{ accountCode: '1010', balanceCents: 'not-a-number', normalBalance: 'debit' }],
    })).toThrow(/safe integer in cents/i);
    expect(() => rules.buildOpeningBalanceEntry({
      asOfDate: '2026-01-01',
      items: [{ accountCode: '1010', balanceCents: 12.5, normalBalance: 'debit' }],
    })).toThrow(/safe integer in cents/i);
    expect(() => rules.buildOpeningBalanceEntry({
      asOfDate: '2026-01-01',
      items: [{ accountCode: '1010', balanceCents: '', normalBalance: 'debit' }],
    })).toThrow(/requires an integer balanceCents/i);

    // 3. Historical cash-basis invoice profile ignores invoice edits posted AFTER the cash receipt date
    const invoiceLines = [
      // Nov 1: $100 revenue + $7 tax = $107 A/R
      { entry_date: '2026-11-01', account_id: 'ar', code: SYSTEM_CODES.ACCOUNTS_RECEIVABLE, account_type: 'asset', debit_cents: 10700, credit_cents: 0 },
      { entry_date: '2026-11-01', account_id: 'rev-4010', code: SYSTEM_CODES.REV_COMMERCIAL_PEST, account_type: 'revenue', debit_cents: 0, credit_cents: 10000 },
      { entry_date: '2026-11-01', account_id: 'tax', code: SYSTEM_CODES.SALES_TAX_PAYABLE, account_type: 'liability', debit_cents: 0, credit_cents: 700 },
      // Dec 10: tax corrected to $0 (DR 2100 700 / CR 1100 700)
      { entry_date: '2026-12-10', account_id: 'tax', code: SYSTEM_CODES.SALES_TAX_PAYABLE, account_type: 'liability', debit_cents: 700, credit_cents: 0 },
      { entry_date: '2026-12-10', account_id: 'ar', code: SYSTEM_CODES.ACCOUNTS_RECEIVABLE, account_type: 'asset', debit_cents: 0, credit_cents: 700 },
    ];
    const novProfile = buildInvoiceProfileAsOf(invoiceLines, '2026-11-15');
    expect(novProfile.arDebitedCents).toBe(10700);
    expect(novProfile.taxCents).toBe(700);
    const decProfile = buildInvoiceProfileAsOf(invoiceLines, '2026-12-15');
    expect(decProfile.arDebitedCents).toBe(10000);
    expect(decProfile.taxCents).toBe(0);
  });

  test('Pass-4: in-progress reconciliations can be corrected or canceled with critical audit events', async () => {
    const acctId = '00000000-0000-4000-8000-000000000001';
    const recId = '00000000-0000-4000-8000-000000000055';
    const audited = [];
    let deletedRec = false;

    const makeConn = () => {
      const conn = (table) => {
        const state = { whereObj: null };
        const chain = {
          join: () => chain,
          leftJoin: () => chain,
          where: (o) => { if (o && typeof o === 'object') state.whereObj = o; return chain; },
          whereNot: () => chain,
          whereIn: () => chain,
          whereNull: () => chain,
          orWhere: () => chain,
          forUpdate: () => chain,
          orderBy: () => chain,
          select: () => {
            if (table === 'gl_journal_lines') return Promise.resolve([]);
            if (table === 'gl_journal_lines as l') return Promise.resolve([]);
            return chain;
          },
          first: () => {
            if (table === 'gl_reconciliations' && state.whereObj?.status === 'reconciled') return Promise.resolve(null);
            if (table === 'gl_reconciliations') {
              return Promise.resolve({
                id: recId, account_id: acctId, status: 'in_progress',
                statement_start_date: null, statement_end_date: '2026-11-30',
                opening_balance_cents: 10000, ending_balance_cents: 25000, notes: null,
              });
            }
            if (table === 'gl_accounts') {
              return Promise.resolve({ id: acctId, code: '1010', name: 'Checking', account_type: 'asset', normal_balance: 'debit' });
            }
            return Promise.resolve(null);
          },
          update: () => ({ returning: () => Promise.resolve([{ id: 'l1' }]) }),
          del: () => { deletedRec = true; return Promise.resolve(1); },
          insert: (row) => { audited.push({ table, row }); return { returning: () => Promise.resolve([{ id: 'audit-1' }]) }; },
        };
        return chain;
      };
      conn.raw = (sql) => sql;
      conn.fn = { now: () => new Date() };
      conn.transaction = (cb) => cb(conn);
      return conn;
    };

    await updateReconciliation(recId, {
      statementEndDate: '2026-11-30',
      endingBalanceCents: 20000,
      actorId: '00000000-0000-4000-8000-000000000099',
      conn: makeConn(),
    });
    expect(audited.some((a) => a.row.action === 'accounting.reconciliation.update')).toBe(true);

    const canceled = await cancelReconciliation(recId, {
      reason: 'Wrong statement selected',
      actorId: '00000000-0000-4000-8000-000000000099',
      conn: makeConn(),
    });
    expect(canceled.canceled).toBe(true);
    expect(deletedRec).toBe(true);
    expect(audited.some((a) => a.row.action === 'accounting.reconciliation.cancel')).toBe(true);
  });

  test('Codex R1: visit recognition preserves canonical idempotencyKey, prepay refunds release 2300, and customer credit issuances fund 2350', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    // 1. buildUnearnedRecognitionEntry honors caller idempotencyKey & scheduledServiceId for reversal lookups
    const visitId = '00000000-0000-4000-8000-000000000333';
    const recJe = rules.buildUnearnedRecognitionEntry({
      sourceId: `covered-visit:${visitId}`,
      idempotencyKey: `unearned-visit:${visitId}`,
      recognitionDate: '2026-11-18',
      amountCents: 10000,
      serviceLine: 'Quarterly Pest Control',
      scheduledServiceId: visitId,
    });
    expect(recJe.idempotencyKey).toBe(`unearned-visit:${visitId}`);
    expect(recJe.lines[0].scheduledServiceId).toBe(visitId);

    // 2. Full $1,200 annual-prepay invoice + payment + full $1,200 refund releases 2300 Unearned (zero liability, zero accrual loss)
    const unearnedFull = computePrepayRefundUnearnedCents({
      isAnnualPrepay: true,
      isReversal: false,
      subtotalCents: 120000,
      originalUnearnedCents: 120000,
      recognizedCents: 0,
      priorUnearnedRefundedCents: 0,
    });
    expect(unearnedFull).toBe(120000);
    const prepayCycle = accumulateEntries(accounts, [
      rules.buildInvoiceEntry({ invoiceId: 'inv-ap-1', issueDate: '2026-11-01', subtotalCents: 120000, taxCents: 0, isAnnualPrepay: true }),
      rules.buildPaymentEntry({ paymentId: 'pay-ap-1', paymentDate: '2026-11-01', grossCents: 120000, method: 'stripe', invoiceId: 'inv-ap-1' }),
      rules.buildRefundEntry({ refundId: 'ref-ap-1', refundDate: '2026-11-05', subtotalCents: 120000, unearnedCents: unearnedFull, taxCents: 0, invoiceId: 'inv-ap-1' }),
    ]);
    expect(bal(prepayCycle, SYSTEM_CODES.UNEARNED_REVENUE)).toBe(0);
    expect(bal(prepayCycle, SYSTEM_CODES.REV_REFUNDS_ALLOWANCES)).toBe(0);
    expect(bal(prepayCycle, SYSTEM_CODES.STRIPE_CLEARING)).toBe(0);

    // Partial earned prepay refund: $1,200 prepay, $300 earned, $1,000 refunded -> $900 DR 2300 + $100 DR 4090
    expect(computePrepayRefundUnearnedCents({
      isAnnualPrepay: true,
      isReversal: false,
      subtotalCents: 100000,
      originalUnearnedCents: 120000,
      recognizedCents: 30000,
      priorUnearnedRefundedCents: 0,
    })).toBe(90000);

    // 3. Standalone referral credit grant ($100) + invoice consuming $100 credit leaves 2350 = $0.00 and net accrual income = $0.00
    const creditCycle = accumulateEntries(accounts, [
      rules.buildCustomerCreditEntry({ ledgerId: 'cl-1', entryDate: '2026-11-01', signedDeltaCents: 10000, creditSource: 'referral' }),
      rules.buildInvoiceEntry({ invoiceId: 'inv-cr-1', issueDate: '2026-11-02', subtotalCents: 10000, taxCents: 0, appliedCreditCents: 10000 }),
    ]);
    expect(bal(creditCycle, SYSTEM_CODES.CUSTOMER_CREDITS)).toBe(0);
    expect(bal(creditCycle, SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(creditCycle, SYSTEM_CODES.OPEX_ADVERTISING)).toBe(10000);
    expect(bal(creditCycle, SYSTEM_CODES.REV_RESIDENTIAL_PEST)).toBe(10000);
    expect(isInvoiceLinkedCreditRow({ source: 'invoice_application', invoice_id: 'inv-1' })).toBe(true);
    expect(isInvoiceLinkedCreditRow({ source: 'adjustment', invoice_id: 'inv-1' })).toBe(true);
    expect(isInvoiceLinkedCreditRow({ source: 'referral', invoice_id: null })).toBe(false);
    expect(isInvoiceLinkedCreditRow({ source: 'promo_code', invoice_id: null })).toBe(false);

    // 4. Dispute description token parser extracts dispute/charge/PI references for unlinked dispute resolution
    expect(extractStripeDisputeTokens('Chargeback withdrawal for dp_1ABC23 on ch_9XYZ89')).toEqual({
      disputeId: 'dp_1ABC23',
      chargeId: 'ch_9XYZ89',
      piId: null,
    });
  });

  test('Codex R2: covered prepay invoices recognize discounted allocation so 2300 clears to $0.00', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    // $380 discounted annual prepay covering 4 visits whose undiscounted invoice subtotals stay $100 each
    const prepayInv = rules.buildInvoiceEntry({
      invoiceId: 'inv-prepay-380',
      issueDate: '2026-01-01',
      subtotalCents: 38000,
      taxCents: 0,
      isAnnualPrepay: true,
    });
    const coveredVisits = [1, 2, 3, 4].map((n) => buildInvoiceGlPayload({
      id: `inv-cov-disc-${n}`,
      invoice_number: `WPC-DISC-${n}`,
      annual_prepay_covered_term_id: 'term-380',
      subtotal: '100.00',
      discount_amount: '0.00',
      tax_amount: '0.00',
      total: '0.00',
      visit_prepaid_amount: n <= 2 ? '95.00' : null,
      visit_estimated_price: '100.00',
      cov_term_prepay_amount: '380.00',
      cov_term_visit_count: 4,
      service_type: 'pest',
      service_date: `2026-0${n}-15`,
      property_type: 'single_family',
    }, new Set()));

    for (const je of coveredVisits) {
      expect(validateJournalEntryInput(je).totalCents).toBe(9500);
    }
    // Visit recognition path matches covered invoice path even when visit_prepaid_amount is missing
    expect(computePrepayVisitRecognitionCents({
      prepaid_amount: null,
      estimated_price: '100.00',
      term_prepay_amount: '380.00',
      coverage_visit_count: 4,
    })).toBe(9500);

    const sums = accumulateEntries(accounts, [prepayInv, ...coveredVisits]);
    expect(bal(sums, SYSTEM_CODES.UNEARNED_REVENUE)).toBe(0);
    expect(bal(sums, SYSTEM_CODES.REV_RESIDENTIAL_PEST)).toBe(38000);
  });

  test('Codex R2: linked Plaid/bank GL account is honored on expenses and canonical subtypes flow into statements', () => {
    const secCheckingId = '00000000-0000-4000-8000-000000009015';
    const secCardId = '00000000-0000-4000-8000-000000009020';
    const lookup = {
      byPlaidExternalId: new Map([
        ['plaid_ext_checking_2', { id: secCheckingId, code: '1015' }],
        ['plaid_ext_amex', { id: secCardId, code: '2010' }],
      ]),
      byAccountLabel: new Map([
        ['mercury checking', { id: secCheckingId, code: '1015' }],
      ]),
    };

    expect(resolveBankTxnGlAccount({ plaid_account_id: 'plaid_ext_checking_2', account_label: 'Other', account_type: 'bank' }, lookup))
      .toEqual({ accountId: secCheckingId, accountCode: '1015' });
    expect(resolveBankTxnGlAccount({ plaid_account_id: null, account_label: 'Mercury Checking', account_type: 'bank' }, lookup))
      .toEqual({ accountId: secCheckingId, accountCode: '1015' });
    expect(resolveBankTxnGlAccount({ plaid_account_id: null, account_label: 'Unmapped Card', account_type: 'card' }, lookup))
      .toEqual({ accountId: null, accountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY });

    const btExpId = '00000000-0000-4000-8000-00000000b001';
    const expJe = rules.buildExpenseEntry({
      sourceId: 'exp-plaid-1',
      entryDate: '2026-11-18',
      paymentAccountId: secCheckingId,
      paymentAccountCode: '1015',
      bankTransactionId: btExpId,
      splits: [{ accountCode: SYSTEM_CODES.COGS_CHEMICALS, amountCents: 45000 }],
      memo: 'Chemical restock from secondary checking',
    });
    expect(validateJournalEntryInput(expJe).totalCents).toBe(45000);
    expect(expJe.lines[1].accountId).toBe(secCheckingId);
    expect(expJe.lines[1].accountCode).toBeNull();
    expect(expJe.lines[1].bankTransactionId).toBe(btExpId);

    // Canonical subtypes (ar, prepaid, accum_depreciation, ap, net_pay_clearing, depreciation_expense, interest_expense)
    const customAccounts = [
      ...makeSyntheticAccounts(),
      { id: 'c-prepaid', code: '1310', name: 'Prepaid Insurance', account_type: 'asset', sub_type: 'prepaid', normal_balance: 'debit', deductible_pct: 100, active: true },
      { id: 'c-ap', code: '2050', name: 'Accounts Payable', account_type: 'liability', sub_type: 'ap', normal_balance: 'credit', deductible_pct: 100, active: true },
      { id: 'c-dep', code: '6710', name: 'Custom Depreciation', account_type: 'expense', sub_type: 'depreciation_expense', normal_balance: 'debit', deductible_pct: 100, active: true },
    ];
    const customSums = new Map([
      ['c-prepaid', { debitCents: 12000, creditCents: 0 }],
      ['c-ap', { debitCents: 0, creditCents: 12000 }],
      ['c-dep', { debitCents: 5000, creditCents: 0 }],
      [customAccounts.find((a) => a.code === SYSTEM_CODES.ACCUM_DEPRECIATION).id, { debitCents: 0, creditCents: 5000 }],
    ]);
    const bs = computeBalanceSheet(customAccounts, customSums, '2026-11-30');
    expect(bs.sections.current_assets.some((r) => r.code === '1310')).toBe(true);
    expect(bs.sections.current_liabilities.some((r) => r.code === '2050')).toBe(true);
    expect(bs.sections.fixed_assets.some((r) => r.code === SYSTEM_CODES.ACCUM_DEPRECIATION)).toBe(true);
    expect(bs.totals.balanced).toBe(true);

    const pnl = computeProfitAndLoss(customAccounts, customSums, { from: '2026-11-01', to: '2026-11-30' });
    expect(pnl.totals.net_income_cents).toBe(-5000);
    expect(pnl.totals.ebitda_cents).toBe(0);
  });

  test('Codex R2: payroll and tax filing settlements clear 2290, 2200, 2210, 2100 and syncSubledgersToGl previews settlements & reversals', async () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    expect(classifyTaxFilingSettlement({ filing_type: 'dr15_sales_tax', title: 'FL DR-15' })?.kind).toBe('sales_tax');
    expect(classifyTaxFilingSettlement({ filing_type: 'payroll_941_deposit', source_key: 'payroll:941_deposit:2026-11' })?.kind).toBe('tax_remit');
    expect(classifyTaxFilingSettlement({ filing_type: 'payroll_rt6', title: 'FL RT-6' })?.kind).toBe('tax_remit');
    expect(classifyTaxFilingSettlement({ filing_type: 'payroll_simple_deposit', title: 'SIMPLE IRA' })?.kind).toBe('benefits_remit');
    expect(classifyTaxFilingSettlement({ filing_type: '1040es_quarterly', title: 'Federal Estimated Tax' })).toBeNull();

    // Full payroll + sales tax cycle clears 2290, 2200, 2210, and 2100 to $0.00
    const cycle = accumulateEntries(accounts, [
      rules.buildInvoiceEntry({ invoiceId: 'inv-tax-1', issueDate: '2026-11-01', subtotalCents: 100000, taxCents: 7000, isCommercial: true }),
      rules.buildSalesTaxRemittanceEntry({ sourceId: 'bt-filing:dr15-1', idempotencyKey: 'sales-tax-remit:bt:dr15-1', paymentDate: '2026-11-20', amountCents: 7000, periodLabel: 'Nov 2026' }),
      rules.buildPayrollRunEntry({
        runId: 'run-settle-1',
        payDate: '2026-11-06',
        weekLabel: 'Week of 2026-10-26',
        fieldGrossCents: 200000,
        fieldEmployerTaxCents: 15300,
        employeeTaxWithheldCents: 35000,
        employeeSimpleDeferralCents: 6000,
        employerSimpleCents: 6000,
        employerHsaCents: 5000,
        netPayCents: 159000,
      }),
      rules.buildPayrollSettlementEntry({
        sourceId: 'pp:pp-1',
        idempotencyKey: 'payroll-settle:net_pay:pp:pp-1',
        settlementDate: '2026-11-06',
        kind: 'net_pay',
        amountCents: 159000,
        bankAccountCode: SYSTEM_CODES.CHECKING_PAYROLL,
      }),
      rules.buildPayrollSettlementEntry({
        sourceId: 'bt-filing:941-1',
        idempotencyKey: 'payroll-settle:tax_remit:bt:941-1',
        settlementDate: '2026-11-15',
        kind: 'tax_remit',
        amountCents: 50300,
        bankAccountCode: SYSTEM_CODES.CHECKING_PAYROLL,
      }),
      rules.buildPayrollSettlementEntry({
        sourceId: 'bt-filing:simple-1',
        idempotencyKey: 'payroll-settle:benefits_remit:bt:simple-1',
        settlementDate: '2026-11-15',
        kind: 'benefits_remit',
        amountCents: 17000,
        bankAccountCode: SYSTEM_CODES.CHECKING_PAYROLL,
      }),
    ]);
    expect(bal(cycle, SYSTEM_CODES.NET_PAY_CLEARING)).toBe(0);
    expect(bal(cycle, SYSTEM_CODES.PAYROLL_TAX_LIABILITIES)).toBe(0);
    expect(bal(cycle, SYSTEM_CODES.PAYROLL_BENEFITS_PAYABLE)).toBe(0);
    expect(bal(cycle, SYSTEM_CODES.SALES_TAX_PAYABLE)).toBe(0);

    // Dry-run syncSubledgersToGl previews Mercury sent paychecks, bank-matched checks/filings, and returned Mercury reversals
    const makeBuilder = (table) => {
      const state = { whereObj: null, hasJoinTable: null };
      const chain = {
        leftJoin: () => chain,
        join: (t) => { state.hasJoinTable = t; return chain; },
        where: (a) => { if (a && typeof a === 'object') state.whereObj = a; return chain; },
        whereIn: () => chain,
        whereNotIn: () => chain,
        whereNull: () => chain,
        whereNotNull: () => chain,
        whereBetween: () => chain,
        whereRaw: () => chain,
        whereNot: () => chain,
        whereExists: () => chain,
        whereNotExists: () => chain,
        orWhere: () => chain,
        orWhereIn: () => chain,
        orWhereRaw: () => chain,
        orderBy: () => chain,
        select: () => {
          if (table === 'gl_accounts') return Promise.resolve(accounts);
          if (table === 'payroll_payments as pp') {
            return Promise.resolve([
              { id: 'pp-sent-1', check_id: 'chk-1', amount_cents: 159000, posted_on: '2026-11-06', resolved_at: null, updated_at: '2026-11-06T16:00:00Z', employee_name: 'Tech One', bt_id: null },
            ]);
          }
          if (table === 'gl_journal_entries as e' && state.hasJoinTable === 'payroll_payments as pp') {
            return Promise.resolve([
              { id: 'je-pp-ret-1', reversed_by_entry_id: null, entry_date: '2026-11-06', pp_state: 'returned', resolved_at: '2026-11-09T15:00:00Z', updated_at: '2026-11-09T15:00:00Z', resolution: 'R01 NSF' },
            ]);
          }
          if (table === 'bank_transactions as bt' && state.hasJoinTable === 'payroll_checks as pc') {
            return Promise.resolve([
              { id: '00000000-0000-4000-8000-00000000b002', txn_date: '2026-11-08', amount: '850.00', description: 'Check #1042', account_label: 'Mercury', account_type: 'bank', plaid_account_id: null, matched_payroll_check_id: 'chk-2', employee_name: 'Tech Two' },
            ]);
          }
          if (table === 'bank_transactions as bt' && state.hasJoinTable === 'tax_filing_calendar as tfc') {
            return Promise.resolve([
              { id: '00000000-0000-4000-8000-00000000b003', txn_date: '2026-11-18', amount: '70.00', description: 'FL DOR DR-15', account_label: 'Checking', account_type: 'bank', plaid_account_id: null, matched_tax_filing_id: 'tfc-1', filing_type: 'dr15_sales_tax', filing_title: 'FL Sales Tax Return (DR-15)', filing_period_label: 'Oct 2026', filing_source_key: null },
            ]);
          }
          return Promise.resolve([]);
        },
        first: () => Promise.resolve(null),
      };
      return chain;
    };
    const fakeConn = (table) => makeBuilder(table);
    fakeConn.raw = (sql) => sql;
    fakeConn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };

    const preview = await syncSubledgersToGl({ fromDate: '2026-11-01', toDate: '2026-11-30', dryRun: true, conn: fakeConn });
    expect(preview.payroll_settlements.would_post).toBe(3);
    expect(preview.payroll_settlements.would_reverse).toBe(1);
    expect(preview.payroll_settlements.errors).toEqual([]);
  });

  test('Codex R3: payroll accruals are accrual-only and cash-basis recognizes exact payroll deductions on disbursement', () => {
    const accounts = makeSyntheticAccounts();
    const expIdByCode = new Map(accounts.filter((a) => ['cogs', 'expense'].includes(a.account_type)).map((a) => [a.code, a.id]));
    const idFor = (code) => expIdByCode.get(code);

    const runEntry = rules.buildPayrollRunEntry({
      runId: 'run-cash-1',
      payDate: '2026-11-06',
      weekLabel: 'Week of 2026-10-26',
      fieldGrossCents: 200000,
      adminGrossCents: 100000,
      fieldEmployerTaxCents: 15300,
      adminEmployerTaxCents: 7650,
      employeeTaxWithheldCents: 54000,
      employeeSimpleDeferralCents: 9000,
      employerSimpleCents: 9000,
      employerHsaCents: 5000,
      netPayCents: 237000,
    });
    expect(runEntry.basisScope).toBe('accrual_only');

    const payrollLines = runEntry.lines.map((l) => ({
      entry_date: runEntry.entryDate,
      code: l.accountCode,
      debit_cents: l.debitCents,
      credit_cents: l.creditCents,
    }));
    const profile = buildPayrollProfileAsOf(payrollLines, '2026-11-15');
    expect(profile.netPayLiabilityCents).toBe(237000);
    expect(profile.taxLiabilityCents).toBe(76950);
    expect(profile.benefitsLiabilityCents).toBe(23000);

    // Sum cash-basis allocations across net pay (field + admin), two partial tax remittances, and benefits remittance
    const cashTotals = new Map();
    const applyAllocs = (allocs) => {
      for (const a of allocs) cashTotals.set(a.accountId, (cashTotals.get(a.accountId) || 0) + a.signedCents);
    };
    // Net pay: $158,000 field + $79,000 admin = $237,000
    applyAllocs(allocateCumulativePayrollSettlement(0, 158000, SYSTEM_CODES.NET_PAY_CLEARING, profile, 'field', expIdByCode));
    applyAllocs(allocateCumulativePayrollSettlement(158000, 79000, SYSTEM_CODES.NET_PAY_CLEARING, profile, 'admin', expIdByCode));
    // Two partial payroll tax deposits summing to $76,950
    applyAllocs(allocateCumulativePayrollSettlement(0, 50000, SYSTEM_CODES.PAYROLL_TAX_LIABILITIES, profile, null, expIdByCode));
    applyAllocs(allocateCumulativePayrollSettlement(50000, 26950, SYSTEM_CODES.PAYROLL_TAX_LIABILITIES, profile, null, expIdByCode));
    // Full benefits deposit of $23,000
    applyAllocs(allocateCumulativePayrollSettlement(0, 23000, SYSTEM_CODES.PAYROLL_BENEFITS_PAYABLE, profile, null, expIdByCode));

    expect(cashTotals.get(idFor(SYSTEM_CODES.COGS_FIELD_WAGES))).toBe(200000);
    expect(cashTotals.get(idFor(SYSTEM_CODES.OPEX_OFFICE_WAGES))).toBe(100000);
    expect(cashTotals.get(idFor(SYSTEM_CODES.COGS_FIELD_PAYROLL_TAX))).toBe(15300);
    expect(cashTotals.get(idFor(SYSTEM_CODES.OPEX_OFFICE_PAYROLL_TAX))).toBe(7650);
    expect(cashTotals.get(idFor(SYSTEM_CODES.OPEX_RETIREMENT_SIMPLE))).toBe(9000);
    expect(cashTotals.get(idFor(SYSTEM_CODES.OPEX_EMPLOYEE_BENEFITS))).toBe(5000);

    // Returned net-pay settlement reverses exact cash-basis wage deduction
    const revAllocs = allocateCumulativePayrollSettlement(237000, -158000, SYSTEM_CODES.NET_PAY_CLEARING, profile, 'field', expIdByCode);
    expect(revAllocs).toEqual([{ accountId: idFor(SYSTEM_CODES.COGS_FIELD_WAGES), signedCents: -158000 }]);
  });

  test('Codex R3: statement refunds and reversals allocate cumulatively against child invoices and FL sales tax', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    const children = [
      { id: 'stmt-inv-1', customer_id: '00000000-0000-4000-8000-000000000201', subtotal: '100.00', discount_amount: '0', tax_amount: '7.00', total: '107.00', credit_applied: '0', service_type: 'commercial', property_type: 'commercial' },
      { id: 'stmt-inv-2', customer_id: '00000000-0000-4000-8000-000000000202', subtotal: '100.00', discount_amount: '0', tax_amount: '0.00', total: '100.00', credit_applied: '0', service_type: 'pest', property_type: 'single_family' },
    ];

    // Full statement refund ($207) reverses exact $7 sales tax and $200 revenue allowance
    const fullAllocs = allocateStatementRefundAcrossInvoices({ absCents: 20700, childInvoices: children });
    expect(fullAllocs).toHaveLength(2);
    const fullRefundJe = rules.buildRefundEntry({
      refundId: 'stmt-ref-full',
      refundDate: '2026-11-20',
      allocations: fullAllocs,
      method: 'stripe',
    });
    const fullSums = accumulateEntries(accounts, [
      rules.buildInvoiceEntry({ invoiceId: 'stmt-inv-1', issueDate: '2026-11-01', subtotalCents: 10000, taxCents: 700, isCommercial: true }),
      rules.buildInvoiceEntry({ invoiceId: 'stmt-inv-2', issueDate: '2026-11-01', subtotalCents: 10000, taxCents: 0, isCommercial: false }),
      rules.buildPaymentEntry({
        paymentId: 'stmt-pay-full',
        paymentDate: '2026-11-05',
        grossCents: 20700,
        method: 'stripe',
        arAllocations: allocateStatementPrincipalAcrossInvoices(20700, children),
      }),
      fullRefundJe,
    ]);
    expect(bal(fullSums, SYSTEM_CODES.SALES_TAX_PAYABLE)).toBe(0);
    expect(bal(fullSums, SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(fullSums, SYSTEM_CODES.STRIPE_CLEARING)).toBe(0);
    const pnl = computeProfitAndLoss(accounts, fullSums, { from: '2026-11-01', to: '2026-11-30' });
    expect(pnl.totals.net_income_cents).toBe(0);

    // Two partial refunds ($103.50 + $103.50) + bounced reversal ($103.50) track cumulative tax accurately
    const part1 = allocateStatementRefundAcrossInvoices({ absCents: 10350, childInvoices: children, priorByInvoice: new Map() });
    const priorAfter1 = new Map(part1.map((a) => [a.invoiceId, { grossCents: a.grossCents, taxCents: a.taxCents }]));
    const part2 = allocateStatementRefundAcrossInvoices({ absCents: 10350, childInvoices: children, priorByInvoice: priorAfter1 });
    const totalTaxReversed = [...part1, ...part2].reduce((s, a) => s + a.taxCents, 0);
    expect(totalTaxReversed).toBe(700);

    const priorAfter2 = new Map(part1.map((a, idx) => [a.invoiceId, { grossCents: a.grossCents + part2[idx].grossCents, taxCents: a.taxCents + part2[idx].taxCents }]));
    const revAllocs = allocateStatementRefundAcrossInvoices({ absCents: 10350, childInvoices: children, priorByInvoice: priorAfter2, isReversal: true });
    const revJe = rules.buildRefundReversalEntry({ txnId: 'stmt-ref-rev', reversalDate: '2026-11-25', allocations: revAllocs, method: 'stripe' });
    expect(validateJournalEntryInput(revJe).totalCents).toBe(10350);
    expect(revAllocs.reduce((s, a) => s + a.taxCents, 0)).toBe(350);
  });

  test('Codex R3: corrected expense vendors reconcile with audit trail and overview totals include custom cash/card accounts', async () => {
    const entryId = '00000000-0000-4000-8000-00000000e001';
    const vendorA = '00000000-0000-4000-8000-00000000a001';
    const vendorB = '00000000-0000-4000-8000-00000000b002';
    const audited = [];
    const updated = [];

    const makeVendorConn = () => {
      const conn = (table) => {
        const chain = {
          join: () => chain,
          leftJoin: () => chain,
          where: () => chain,
          whereIn: () => chain,
          whereNull: () => chain,
          whereNotNull: () => chain,
          whereRaw: () => chain,
          orderBy: () => chain,
          first: () => {
            if (table === 'gl_journal_entries') return Promise.resolve({ id: entryId, entry_number: 42, status: 'posted', entry_date: '2026-11-10' });
            if (table === 'gl_vendors') return Promise.resolve({ id: vendorB, display_name: 'Vendor B LLC', active: true });
            return Promise.resolve(null);
          },
          select: () => {
            if (table === 'gl_journal_entries') return chain;
            if (table === 'gl_journal_lines as l') return Promise.resolve([{ id: 'line-1', previous_vendor_id: vendorA }]);
            return Promise.resolve([]);
          },
          update: (patch) => { updated.push({ table, patch }); return Promise.resolve(1); },
          insert: (row) => { audited.push({ table, row }); return { returning: () => Promise.resolve([{ id: 'audit-v1' }]) }; },
        };
        return chain;
      };
      conn.raw = (sql) => sql;
      conn.transaction = (cb) => cb(conn);
      return conn;
    };

    const res = await linkJournalEntryVendor(entryId, {
      vendorId: vendorB,
      allowReplace: true,
      reason: 'Vendor corrected from A to B',
      conn: makeVendorConn(),
    });
    expect(res.updatedLines).toBe(1);
    expect(updated[0].patch).toEqual({ vendor_id: vendorB });
    expect(audited[0].row.metadata.previous_vendor_ids).toEqual([vendorA]);
    expect(audited[0].row.metadata.vendor_id).toBe(vendorB);

    // Overview KPIs include custom checking, savings, and credit card accounts by canonical sub_type
    const customAccounts = [
      ...makeSyntheticAccounts(),
      { id: 'custom-chk', code: '1015', name: 'Secondary Checking', account_type: 'asset', sub_type: 'checking', normal_balance: 'debit', deductible_pct: 100, active: true },
      { id: 'custom-sav', code: '1035', name: 'Treasury Savings', account_type: 'asset', sub_type: 'savings', normal_balance: 'debit', deductible_pct: 100, active: true },
      { id: 'custom-cc', code: '2010', name: 'Amex Business Card', account_type: 'liability', sub_type: 'credit_card', normal_balance: 'credit', deductible_pct: 100, active: true },
    ];
    const primaryChkId = customAccounts.find((a) => a.code === SYSTEM_CODES.CHECKING_PRIMARY).id;
    const ownerEqId = customAccounts.find((a) => a.code === SYSTEM_CODES.OWNER_EQUITY).id;
    const bs = computeBalanceSheet(customAccounts, new Map([
      [primaryChkId, { debitCents: 1000000, creditCents: 0 }],
      ['custom-chk', { debitCents: 500000, creditCents: 0 }],
      ['custom-sav', { debitCents: 300000, creditCents: 0 }],
      ['custom-cc', { debitCents: 0, creditCents: 120000 }],
      [ownerEqId, { debitCents: 0, creditCents: 1680000 }],
    ]), { asOf: '2026-11-30' });
    expect(bs.totals.balanced).toBe(true);
    const kpis = summarizeBalanceSheetKpis(bs);
    expect(kpis.cash_total_cents).toBe(1800000);
    expect(kpis.credit_cards_cents).toBe(120000);
  });
});
