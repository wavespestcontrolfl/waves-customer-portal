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
  defaultNormalBalanceFor,
  parseNewAccountInput,
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
  resolveInvoiceProfileForReceipt,
  buildPayrollProfileAsOf,
  allocateCumulativePayrollSettlement,
  summarizeSalesTaxLines,
  reportable1099LineCents,
  summarize1099VendorLines,
  get1099VendorSummary,
  summarizeBalanceSheetKpis,
} = require('../services/accounting/statements');
const {
  computeReconciliationMath,
  startReconciliation,
  updateReconciliation,
  cancelReconciliation,
  reopenReconciliation,
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
  allocateCombinedRefundAcrossShares,
  splitDepositRefundCents,
  findMatchingDepositForOutflow,
  computePrepayVisitRecognitionCents,
  isPrepayTermCoverageValid,
  isPrepayTermRevokedForPostedVisit,
  isInvoiceLessMonthlyDuesPayment,
  resolveMonthlyDuesPeriod,
  computeGapReceiptAmounts,
  isDisputeOutflow,
  isInvoiceLinkedCreditRow,
  isRefundCreditRestorationRow,
  extractStripeDisputeTokens,
  buildExpenseSplits,
  buildInvoiceGlPayload,
  buildRefundedDepositRestorePayload,
  buildInvoiceDeltaEntry,
  resolveBankTxnGlAccount,
  classifyTaxFilingSettlement,
  isBankCheckSupersededByMercury,
  matchesSettlementKeyBase,
  buildSettlementReclassEntry,
  decideExpenseVendorAction,
  extractMerchantRefundTarget,
  recoverGrossExpenseCents,
  buildMerchantRefundDeltaEntry,
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

  test('Codex R4: returned Mercury transfers stay excluded from bank fallback, restored matches repost, and custom contra accounts get contra normal balances', async () => {
    // 1. Returned / failed / sent Mercury transfers are excluded from bank fallback; separate subsequent paper check is allowed
    const mercuryDebit = { txn_date: '2026-11-06', description: 'MERCURY ACH PAYROLL' };
    expect(isBankCheckSupersededByMercury(mercuryDebit, [])).toBe(false);
    expect(isBankCheckSupersededByMercury(mercuryDebit, [{ attempt: 1, state: 'sent' }])).toBe(true);
    expect(isBankCheckSupersededByMercury(mercuryDebit, [{ attempt: 1, state: 'returned', posted_on: '2026-11-06' }])).toBe(true);
    expect(isBankCheckSupersededByMercury(mercuryDebit, [{ attempt: 1, state: 'failed' }])).toBe(true);
    // Attempt 1 returned Nov 6, attempt 2 paper check #1042 issued Nov 10 -> old Nov 6 debit still excluded, Nov 12 paper check allowed
    const retThenPaper = [
      { attempt: 1, state: 'returned', posted_on: '2026-11-06', created_at: '2026-11-05T15:00:00Z' },
      { attempt: 2, state: 'paper', check_number: '1042', created_at: '2026-11-10T15:00:00Z' },
    ];
    expect(isBankCheckSupersededByMercury(mercuryDebit, retThenPaper)).toBe(true);
    expect(isBankCheckSupersededByMercury({ txn_date: '2026-11-12', description: 'Check #1042' }, retThenPaper)).toBe(false);

    // 2. Restored bank tax-filing match whose prior settlement JE was reversed reposts under :rev-1 instead of being skipped forever
    const baseKey = 'sales-tax-remit:bt:00000000-0000-4000-8000-00000000b099';
    expect(matchesSettlementKeyBase(baseKey, baseKey)).toBe(true);
    expect(matchesSettlementKeyBase(`${baseKey}:rev-1`, baseKey)).toBe(true);
    expect(matchesSettlementKeyBase('payroll-settle:tax_remit:bt:00000000-0000-4000-8000-00000000b099', baseKey)).toBe(false);

    const accounts = makeSyntheticAccounts();
    const btId = '00000000-0000-4000-8000-00000000b099';
    const buildSyncConn = (priorJeRows) => {
      const conn = (table) => {
        const state = { joinTable: null, whereKey: null };
        const chain = {
          leftJoin: () => chain,
          join: (t) => { state.joinTable = t; return chain; },
          where: (a) => { if (a && typeof a === 'object' && a.idempotency_key) state.whereKey = a.idempotency_key; return chain; },
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
            if (table === 'bank_transactions as bt' && state.joinTable === 'tax_filing_calendar as tfc') {
              return Promise.resolve([{
                id: btId, txn_date: '2026-11-18', amount: '70.00', description: 'FL DOR DR-15',
                account_label: 'Checking', account_type: 'bank', plaid_account_id: null,
                matched_tax_filing_id: 'tfc-1', filing_type: 'dr15_sales_tax',
                filing_title: 'FL Sales Tax Return (DR-15)', filing_period_label: 'Oct 2026', filing_source_key: null,
              }]);
            }
            if (table === 'gl_journal_entries') return Promise.resolve(priorJeRows);
            return Promise.resolve([]);
          },
          first: () => {
            if (table === 'gl_journal_entries' && state.whereKey) {
              return Promise.resolve(priorJeRows.find((r) => r.idempotency_key === state.whereKey) || null);
            }
            return Promise.resolve(null);
          },
        };
        return chain;
      };
      conn.raw = (sql) => sql;
      conn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };
      return conn;
    };

    // Original JE was reversed -> restored link must repost under :rev-1 (would_post = 1)
    const repostPreview = await syncSubledgersToGl({
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      dryRun: true,
      conn: buildSyncConn([{ id: 'je-old', idempotency_key: baseKey, reversed_by_entry_id: 'je-rev' }]),
    });
    expect(repostPreview.payroll_settlements.would_post).toBe(1);
    expect(repostPreview.payroll_settlements.errors).toEqual([]);

    // Active :rev-1 JE already exists -> subsequent sync skips cleanly (would_post = 0)
    const idempotentPreview = await syncSubledgersToGl({
      fromDate: '2026-11-01',
      toDate: '2026-11-30',
      dryRun: true,
      conn: buildSyncConn([
        { id: 'je-old', idempotency_key: baseKey, reversed_by_entry_id: 'je-rev' },
        { id: 'je-new', idempotency_key: `${baseKey}:rev-1`, reversed_by_entry_id: null },
      ]),
    });
    expect(idempotentPreview.payroll_settlements.would_post).toBe(0);
    expect(idempotentPreview.payroll_settlements.skipped).toBe(1);

    // 3. Custom contra accounts default to their contra normal balance
    expect(defaultNormalBalanceFor('asset', 'accum_depreciation')).toBe('credit');
    expect(defaultNormalBalanceFor('equity', 'owner_draws')).toBe('debit');
    expect(defaultNormalBalanceFor('equity', 'owner_draw')).toBe('debit');
    expect(defaultNormalBalanceFor('revenue', 'contra_revenue')).toBe('debit');
    expect(defaultNormalBalanceFor('asset', 'checking')).toBe('debit');

    const accumInput = parseNewAccountInput({ code: '1595', name: 'Accum Depr — Trailers', accountType: 'asset', subType: 'accum_depreciation' });
    const drawsInput = parseNewAccountInput({ code: '3110', name: 'Partner Draws', accountType: 'equity', subType: 'owner_draws' });
    const contraRevInput = parseNewAccountInput({ code: '4095', name: 'Warranty Allowances', accountType: 'revenue', subType: 'contra_revenue' });
    expect(accumInput.normal_balance).toBe('credit');
    expect(drawsInput.normal_balance).toBe('debit');
    expect(contraRevInput.normal_balance).toBe('debit');

    // Positive $1,000 opening balance on custom accum_depreciation credits 1595 (reducing fixed assets)
    const openJe = rules.buildOpeningBalanceEntry({
      asOfDate: '2026-01-01',
      items: [{ accountCode: '1595', balanceCents: 100000, normalBalance: accumInput.normal_balance }],
    });
    expect(openJe.lines[0]).toMatchObject({ accountCode: '1595', debitCents: 0, creditCents: 100000 });
  });

  test('Codex R5: taxable annual prepayments strip prepaid sales tax on recognition and 1099 summary excludes closing entries', () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    // Commercial annual prepay: $1,000 service + $70 FL sales tax = $1,070 total across 4 visits ($267.50 gross slice each)
    const prepayInvJe = rules.buildInvoiceEntry({
      invoiceId: 'inv-tax-prepay-1070',
      issueDate: '2026-01-01',
      subtotalCents: 100000,
      taxCents: 7000,
      isCommercial: true,
      isAnnualPrepay: true,
    });

    // Visit-only path (2 visits with stamped gross prepaid_amount $267.50)
    const visitAmt1 = computePrepayVisitRecognitionCents({
      prepaid_amount: '267.50',
      estimated_price: '275.00',
      term_prepay_amount: '1070.00',
      coverage_visit_count: 4,
      prepay_inv_subtotal: '1000.00',
      prepay_inv_discount: '0',
      prepay_inv_tax: '70.00',
      prepay_inv_total: '1070.00',
    });
    expect(visitAmt1).toBe(25000);

    // Covered-invoice path (2 visits with gross slice / gross term_prepay_amount)
    const covJes = [1, 2].map((n) => buildInvoiceGlPayload({
      id: `inv-tax-cov-${n}`,
      invoice_number: `WPC-TCOV-${n}`,
      annual_prepay_covered_term_id: 'term-tax-1070',
      subtotal: '275.00',
      discount_amount: '0',
      tax_amount: '0',
      total: '0',
      visit_prepaid_amount: n === 1 ? '267.50' : null,
      cov_term_prepay_amount: '1070.00',
      cov_term_visit_count: 4,
      cov_prepay_inv_subtotal: '1000.00',
      cov_prepay_inv_discount: '0',
      cov_prepay_inv_tax: '70.00',
      cov_prepay_inv_total: '1070.00',
      service_type: 'commercial',
      service_date: `2026-0${n + 2}-15`,
      property_type: 'commercial',
    }, new Set()));
    expect(validateJournalEntryInput(covJes[0]).totalCents).toBe(25000);
    expect(validateJournalEntryInput(covJes[1]).totalCents).toBe(25000);

    // Already pre-tax term.prepay_amount ($1,000) is NOT double-stripped
    expect(computePrepayVisitRecognitionCents({
      prepaid_amount: '250.00',
      term_prepay_amount: '1000.00',
      coverage_visit_count: 4,
      prepay_inv_subtotal: '1000.00',
      prepay_inv_tax: '70.00',
      prepay_inv_total: '1070.00',
    })).toBe(25000);

    // Full 4-visit recognition clears 2300 to $0.00, keeps 2100 at $70.00, and earns exactly $1,000.00
    const visitJes = [1, 2].map((n) => rules.buildUnearnedRecognitionEntry({
      sourceId: `covered-visit:v-${n}`,
      idempotencyKey: `unearned-visit:v-${n}`,
      recognitionDate: `2026-0${n}-15`,
      amountCents: visitAmt1,
      serviceLine: 'commercial',
      isCommercial: true,
    }));
    const sums = accumulateEntries(accounts, [prepayInvJe, ...visitJes, ...covJes]);
    expect(bal(sums, SYSTEM_CODES.UNEARNED_REVENUE)).toBe(0);
    expect(bal(sums, SYSTEM_CODES.SALES_TAX_PAYABLE)).toBe(7000);
    expect(bal(sums, SYSTEM_CODES.REV_COMMERCIAL_PEST)).toBe(100000);

    // 1099-NEC summary ignores period-closing entries and their reversals on 5500 Contract Labor
    const summary1099 = summarize1099VendorLines(
      [
        { vendor_id: 'v1', display_name: 'Sub One', entity_type: 'sole_prop', w9_received_at: '2026-01-10', entry_id: 'e1', entry_type: 'operational', payment_method: 'check', debit_cents: 250000, credit_cents: 0, paid_by_credit_card: false },
        { vendor_id: 'v1', display_name: 'Sub One', entity_type: 'sole_prop', w9_received_at: '2026-01-10', entry_id: 'e-close', entry_type: 'closing', payment_method: null, debit_cents: 0, credit_cents: 250000, paid_by_credit_card: false },
      ],
      [
        { entry_id: 'e-close', entry_type: 'closing', entry_number: 99, entry_date: '2026-12-31', entry_memo: 'Year-end close', debit_cents: 0, credit_cents: 250000, paid_by_credit_card: false },
        { entry_id: 'e-close-rev', entry_type: 'reversal', reversed_entry_type: 'closing', entry_number: 100, entry_date: '2026-12-31', entry_memo: 'Reverse close', debit_cents: 250000, credit_cents: 0, paid_by_credit_card: false },
      ],
      200000,
    );
    expect(summary1099.vendors[0].total_paid_cents).toBe(250000);
    expect(summary1099.unlinked_contractor_count).toBe(0);
    expect(summary1099.ready_for_filing).toBe(true);
  });

  test('Codex R6: refunded account-credit restorations offset revenue/tax (not A/R), combined refunds allocate all shares, voided superseding invoices restore visits, and inactive vendors keep attribution', async () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    // 1. Refunded account-credit restoration: $100 invoice paid $20 credit + $80 cash, then fully refunded
    const restoreRow = {
      source: 'adjustment',
      invoice_id: 'inv-cred-ref-1',
      delta: '20.00',
      note: 'Account credit returned — invoice WPC-50 fully refunded',
    };
    expect(isRefundCreditRestorationRow(restoreRow)).toBe(true);
    expect(isInvoiceLinkedCreditRow(restoreRow)).toBe(false);
    expect(isInvoiceLinkedCreditRow({ source: 'adjustment', invoice_id: 'inv-void-1', delta: '20.00', note: 'Void invoice credit return' })).toBe(true);

    // Cleared credit_applied + refund_restored_credit_cents keeps original $80 A/R + $20 Credit split (never reopens $20 A/R)
    const invRefundedJe = buildInvoiceGlPayload({
      id: 'inv-cred-ref-1',
      invoice_number: 'WPC-50',
      status: 'refunded',
      subtotal: '100.00',
      discount_amount: '0',
      tax_amount: '0',
      total: '100.00',
      credit_applied: '0.00',
      refund_restored_credit_cents: 2000,
      service_type: 'pest',
      service_date: '2026-11-01',
      property_type: 'single_family',
    }, new Set());
    const credCycle = accumulateEntries(accounts, [
      rules.buildCustomerCreditEntry({ ledgerId: 'cl-orig', entryDate: '2026-10-15', signedDeltaCents: 2000, creditSource: 'referral' }),
      invRefundedJe,
      rules.buildPaymentEntry({ paymentId: 'pay-cred-80', paymentDate: '2026-11-02', grossCents: 8000, method: 'stripe', invoiceId: 'inv-cred-ref-1' }),
      rules.buildRefundEntry({ refundId: 'ref-cred-80', refundDate: '2026-11-05', subtotalCents: 8000, taxCents: 0, method: 'stripe', invoiceId: 'inv-cred-ref-1' }),
      rules.buildCustomerCreditEntry({ ledgerId: 'cl-restore', entryDate: '2026-11-05', signedDeltaCents: 2000, creditSource: 'adjustment', invoiceId: 'inv-cred-ref-1' }),
    ]);
    expect(bal(credCycle, SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(credCycle, SYSTEM_CODES.STRIPE_CLEARING)).toBe(0);
    expect(bal(credCycle, SYSTEM_CODES.CUSTOMER_CREDITS)).toBe(2000);
    // Revenue ($100) minus $80 cash refund minus $20 credit refund allowance = $0 net revenue
    expect(bal(credCycle, SYSTEM_CODES.REV_RESIDENTIAL_PEST) - bal(credCycle, SYSTEM_CODES.REV_REFUNDS_ALLOWANCES)).toBe(0);

    // 2. Combined-charge refund ($321 = $107 inv1 [$7 tax] + $214 inv2 [$14 tax]) reverses full $21 tax across both shares
    const inv1 = { id: 'comb-inv-1', customer_id: '00000000-0000-4000-8000-000000000301', subtotal: '100.00', discount_amount: '0', tax_amount: '7.00', total: '107.00', service_type: 'commercial', property_type: 'commercial' };
    const inv2 = { id: 'comb-inv-2', customer_id: '00000000-0000-4000-8000-000000000301', subtotal: '200.00', discount_amount: '0', tax_amount: '14.00', total: '214.00', service_type: 'commercial', property_type: 'commercial' };
    const shares = [
      { invoice: inv1, shareCents: 10700, paymentAmount: '107.00' },
      { invoice: inv2, shareCents: 21400, paymentAmount: '214.00' },
    ];
    const combAllocs = allocateCombinedRefundAcrossShares({ absCents: 32100, shares });
    expect(combAllocs.reduce((s, a) => s + a.taxCents, 0)).toBe(2100);
    expect(combAllocs.reduce((s, a) => s + a.subtotalCents, 0)).toBe(30000);
    const combSums = accumulateEntries(accounts, [
      rules.buildInvoiceEntry({ invoiceId: 'comb-inv-1', issueDate: '2026-11-01', subtotalCents: 10000, taxCents: 700, isCommercial: true }),
      rules.buildInvoiceEntry({ invoiceId: 'comb-inv-2', issueDate: '2026-11-01', subtotalCents: 20000, taxCents: 1400, isCommercial: true }),
      rules.buildPaymentEntry({ paymentId: 'comb-pay-1', paymentDate: '2026-11-02', grossCents: 10700, method: 'stripe', invoiceId: 'comb-inv-1' }),
      rules.buildPaymentEntry({ paymentId: 'comb-pay-2', paymentDate: '2026-11-02', grossCents: 21400, method: 'stripe', invoiceId: 'comb-inv-2' }),
      rules.buildRefundEntry({ refundId: 'comb-ref-full', refundDate: '2026-11-06', allocations: combAllocs, method: 'stripe' }),
    ]);
    expect(bal(combSums, SYSTEM_CODES.SALES_TAX_PAYABLE)).toBe(0);
    expect(bal(combSums, SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(combSums, SYSTEM_CODES.STRIPE_CLEARING)).toBe(0);
    expect(computeProfitAndLoss(accounts, combSums, { from: '2026-11-01', to: '2026-11-30' }).totals.net_income_cents).toBe(0);

    // 3. Visit recognition reposts under :rev-1 after its superseding covered invoice is voided
    const visitUuid = '00000000-0000-4000-8000-00000000f001';
    const visitConn = (table) => {
      const chain = {
        leftJoin: () => chain,
        join: () => chain,
        where: () => chain,
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
          if (table === 'scheduled_services as ss') {
            return Promise.resolve([{
              id: visitUuid, customer_id: null, annual_prepay_term_id: 'term-1', service_type: 'pest',
              prepaid_amount: '95.00', estimated_price: '100.00', completed_at: '2026-11-05T15:00:00Z',
              scheduled_date: '2026-11-05', term_prepay_amount: '380.00', coverage_visit_count: 4,
              property_type: 'single_family',
            }]);
          }
          if (table === 'gl_journal_entries') {
            return Promise.resolve([{ id: 'je-v-old', idempotency_key: `unearned-visit:${visitUuid}`, reversed_by_entry_id: 'je-v-rev' }]);
          }
          return Promise.resolve([]);
        },
        first: () => Promise.resolve(null),
      };
      return chain;
    };
    visitConn.raw = (sql) => sql;
    visitConn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };
    const visitPreview = await syncSubledgersToGl({ fromDate: '2026-11-01', toDate: '2026-11-30', dryRun: true, conn: visitConn });
    expect(visitPreview.invoices.would_post).toBe(1);
    expect(visitPreview.invoices.errors).toEqual([]);

    // 4. Historical vendor attribution is preserved when a vendor is deactivated or renamed
    const vA = '00000000-0000-4000-8000-00000000a001';
    const vB = '00000000-0000-4000-8000-00000000b002';
    const vendorById = new Map([
      [vA, { id: vA, display_name: 'Old Contractor', active: false }],
      [vB, { id: vB, display_name: 'Active Contractor', active: true }],
    ]);
    expect(decideExpenseVendorAction({ expVendorName: 'Old Contractor', existingVendorId: vA, matchedActiveVendor: null, vendorById }))
      .toEqual({ action: 'keep', vendorId: vA });
    expect(decideExpenseVendorAction({ expVendorName: 'Renamed Old Name', existingVendorId: vB, matchedActiveVendor: null, vendorById }))
      .toEqual({ action: 'keep', vendorId: vB });
    expect(decideExpenseVendorAction({ expVendorName: 'Active Contractor', existingVendorId: vA, matchedActiveVendor: { id: vB }, vendorById }))
      .toEqual({ action: 'set', vendorId: vB });
    expect(decideExpenseVendorAction({ expVendorName: '', existingVendorId: vB, matchedActiveVendor: null, vendorById }))
      .toEqual({ action: 'clear', vendorId: null });
    expect(decideExpenseVendorAction({ expVendorName: '', existingVendorId: vA, matchedActiveVendor: null, vendorById }))
      .toEqual({ action: 'keep', vendorId: vA });
  });

  test('Codex R7: refunded deposit-credited invoices restore 2300 liability and 1099 reversals preserve card/platform exclusions', async () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    // 1. Non-taxable $300 invoice funded by $100 estimate deposit + $200 cash, then fully refunded
    const depInv = {
      id: 'inv-dep-ref-1',
      invoice_number: 'WPC-DEP-1',
      status: 'refunded',
      subtotal: '300.00',
      discount_amount: '0',
      tax_amount: '0',
      total: '200.00',
      credit_applied: '0',
      line_items: [
        { description: 'Termite treatment', amount: 300 },
        { description: 'Estimate deposit applied', category: 'deposit_credit', amount: -100 },
      ],
      service_type: 'termite',
      service_date: '2026-11-01',
      updated_at: '2026-11-08T15:00:00Z',
      property_type: 'single_family',
    };
    const invJe = buildInvoiceGlPayload(depInv, new Set());
    const depRestoreJe = buildRefundedDepositRestorePayload(depInv, new Set());
    expect(depRestoreJe).not.toBeNull();
    expect(depRestoreJe.idempotencyKey).toBe('refund-deposit-restore:inv-dep-ref-1');
    expect(depRestoreJe.basisScope).toBe('accrual_only');
    expect(depRestoreJe.entryDate).toBe('2026-11-08');

    const depCycle = accumulateEntries(accounts, [
      rules.buildPaymentEntry({ paymentId: 'dep-100', paymentDate: '2026-10-20', grossCents: 10000, method: 'stripe', isDeposit: true }),
      invJe,
      rules.buildPaymentEntry({ paymentId: 'pay-200', paymentDate: '2026-11-02', grossCents: 20000, method: 'stripe', invoiceId: 'inv-dep-ref-1' }),
      rules.buildRefundEntry({ refundId: 'ref-200', refundDate: '2026-11-08', subtotalCents: 20000, taxCents: 0, method: 'stripe', invoiceId: 'inv-dep-ref-1' }),
      depRestoreJe,
    ]);
    expect(bal(depCycle, SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(depCycle, SYSTEM_CODES.STRIPE_CLEARING)).toBe(10000);
    expect(bal(depCycle, SYSTEM_CODES.UNEARNED_REVENUE)).toBe(10000);
    expect(bal(depCycle, SYSTEM_CODES.REV_TERMITE_PROJECTS) - bal(depCycle, SYSTEM_CODES.REV_REFUNDS_ALLOWANCES)).toBe(0);

    // Paid (non-refunded) invoice produces no deposit restoration entry
    expect(buildRefundedDepositRestorePayload({ ...depInv, status: 'paid' }, new Set())).toBeNull();

    // Taxable $107 invoice ($100 + $7 tax) funded by $105 deposit + $2 cash: deposit restore clears remaining $5 sales tax
    const taxDepInv = {
      ...depInv,
      id: 'inv-dep-ref-tax',
      invoice_number: 'WPC-DEP-TAX',
      subtotal: '100.00',
      tax_amount: '7.00',
      total: '2.00',
      line_items: [
        { description: 'Commercial service', amount: 100 },
        { description: 'Estimate deposit applied', category: 'deposit_credit', amount: -105 },
      ],
      service_type: 'commercial',
      property_type: 'commercial',
    };
    const taxDepRestore = buildRefundedDepositRestorePayload(taxDepInv, new Set());
    const cashRefundTax = computeProratedRefundTaxCents(200, taxDepInv, '2.00');
    expect(cashRefundTax).toBe(200);
    const taxDepCycle = accumulateEntries(accounts, [
      rules.buildPaymentEntry({ paymentId: 'dep-105', paymentDate: '2026-10-20', grossCents: 10500, method: 'stripe', isDeposit: true }),
      buildInvoiceGlPayload(taxDepInv, new Set()),
      rules.buildPaymentEntry({ paymentId: 'pay-2', paymentDate: '2026-11-02', grossCents: 200, method: 'stripe', invoiceId: 'inv-dep-ref-tax' }),
      rules.buildRefundEntry({ refundId: 'ref-2', refundDate: '2026-11-08', subtotalCents: 200 - cashRefundTax, taxCents: cashRefundTax, method: 'stripe', invoiceId: 'inv-dep-ref-tax' }),
      taxDepRestore,
    ]);
    expect(bal(taxDepCycle, SYSTEM_CODES.SALES_TAX_PAYABLE)).toBe(0);
    expect(bal(taxDepCycle, SYSTEM_CODES.UNEARNED_REVENUE)).toBe(10500);
    expect(bal(taxDepCycle, SYSTEM_CODES.REV_COMMERCIAL_PEST) - bal(taxDepCycle, SYSTEM_CODES.REV_REFUNDS_ALLOWANCES)).toBe(0);

    // Annual prepay invoice with $100 deposit and $0 recognized leaves 2300 intact (no double-credit);
    // once $100+ is recognized into revenue, deposit restore re-credits 2300
    const prepayDepInv = { ...depInv, id: 'inv-prepay-dep', annual_prepay_term_id: 'term-dep-1' };
    expect(buildRefundedDepositRestorePayload(prepayDepInv, new Set(), { recognizedUnearnedCents: 0 })).toBeNull();
    const prepayDepRestore = buildRefundedDepositRestorePayload(prepayDepInv, new Set(), { recognizedUnearnedCents: 25000 });
    expect(validateJournalEntryInput(prepayDepRestore).totalCents).toBe(10000);

    // End-to-end dryRun sync previews BOTH the invoice entry and the deposit restoration entry
    const syncConn = (table) => {
      const chain = {
        leftJoin: () => chain,
        join: () => chain,
        where: () => chain,
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
          if (table === 'invoices as i') return Promise.resolve([depInv]);
          return Promise.resolve([]);
        },
        first: () => Promise.resolve(null),
      };
      return chain;
    };
    syncConn.raw = (sql) => sql;
    syncConn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };
    const syncRes = await syncSubledgersToGl({ fromDate: '2026-11-01', toDate: '2026-11-30', dryRun: true, conn: syncConn });
    expect(syncRes.invoices.would_post).toBe(2);
    expect(syncRes.invoices.errors).toEqual([]);

    // 2. 1099-NEC reversals preserve credit-card and platform exclusions (never subtract card reversal from ACH payments)
    const rawSnippets = [];
    const mock1099Conn = () => {
      const chain = {
        join: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        whereBetween: () => chain,
        whereIn: () => chain,
        whereNull: () => chain,
        orderBy: () => chain,
        select: (...cols) => {
          for (const c of cols) if (typeof c === 'string') rawSnippets.push(c);
          return Promise.resolve([]);
        },
      };
      return chain;
    };
    mock1099Conn.raw = (sql) => {
      rawSnippets.push(sql);
      return sql;
    };
    await get1099VendorSummary({ year: 2026, conn: mock1099Conn });
    expect(rawSnippets.some((s) => s.includes('e.reverses_entry_id') && s.includes("ca.sub_type = 'credit_card'"))).toBe(true);
    expect(rawSnippets.some((s) => s.includes('cl.debit_cents > 0'))).toBe(true);
    expect(rawSnippets).toContain('close_orig.memo as original_entry_memo');

    const rev1099 = summarize1099VendorLines(
      [
        { vendor_id: 'v1', display_name: 'Contractor A', entity_type: 'sole_prop', w9_received_at: '2026-01-05', entry_id: 'e-card', entry_type: 'operational', payment_method: null, debit_cents: 100000, credit_cents: 0, paid_by_credit_card: true },
        { vendor_id: 'v1', display_name: 'Contractor A', entity_type: 'sole_prop', w9_received_at: '2026-01-05', entry_id: 'e-card-rev', entry_type: 'reversal', payment_method: null, debit_cents: 0, credit_cents: 100000, paid_by_credit_card: true },
        { vendor_id: 'v1', display_name: 'Contractor A', entity_type: 'sole_prop', w9_received_at: '2026-01-05', entry_id: 'e-upwork', entry_type: 'operational', payment_method: null, entry_memo: 'Upwork contract', debit_cents: 50000, credit_cents: 0, paid_by_credit_card: false },
        { vendor_id: 'v1', display_name: 'Contractor A', entity_type: 'sole_prop', w9_received_at: '2026-01-05', entry_id: 'e-upwork-rev', entry_type: 'reversal', payment_method: null, entry_memo: 'Reversal of JE #10', original_entry_memo: 'Upwork contract', debit_cents: 0, credit_cents: 50000, paid_by_credit_card: false },
        { vendor_id: 'v1', display_name: 'Contractor A', entity_type: 'sole_prop', w9_received_at: '2026-01-05', entry_id: 'e-ach', entry_type: 'operational', payment_method: 'ach', debit_cents: 300000, credit_cents: 0, paid_by_credit_card: false },
      ],
      [],
      200000,
    );
    expect(rev1099.vendors).toHaveLength(1);
    expect(rev1099.vendors[0].total_paid_cents).toBe(300000);
    expect(rev1099.vendors[0].excluded_1099k_cents).toBe(0);
    expect(rev1099.vendors[0].filing_required).toBe(true);
  });

  test('Codex R8: reopenReconciliation requires newest-first unwinding and merchant refunds post separately from gross expenses', async () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    // 1. Reopening January while February is still finalized is rejected (409 RECONCILIATION_ORDER)
    const janId = '00000000-0000-4000-8000-000000009001';
    const febId = '00000000-0000-4000-8000-000000009002';
    const acctId = byCode.get(SYSTEM_CODES.CHECKING_PRIMARY).id;
    let firstCall = 0;
    const makeReopenConn = (hasLaterFinalized) => {
      firstCall = 0;
      const trx = () => {
        const chain = {
          where: () => chain,
          whereNot: () => chain,
          orWhere: () => chain,
          forUpdate: () => chain,
          orderBy: () => chain,
          select: () => chain,
          first: () => {
            firstCall += 1;
            if (firstCall === 1) {
              return Promise.resolve({
                id: janId,
                account_id: acctId,
                status: 'reconciled',
                statement_end_date: '2026-01-31',
                reconciled_at: '2026-02-02T12:00:00Z',
                notes: null,
              });
            }
            if (firstCall === 2) return Promise.resolve(null); // no in-progress session
            if (firstCall === 3) {
              return Promise.resolve(hasLaterFinalized ? { id: febId, statement_end_date: '2026-02-28' } : null);
            }
            return Promise.resolve(null);
          },
          update: () => Promise.resolve(1),
        };
        return chain;
      };
      trx.raw = (sql) => sql;
      trx.fn = { now: () => new Date() };
      return { transaction: (fn) => fn(trx) };
    };

    await expect(
      reopenReconciliation(janId, { reason: 'Fix Jan typo', conn: makeReopenConn(true) }),
    ).rejects.toMatchObject({ status: 409, code: 'RECONCILIATION_ORDER' });

    // 2. Merchant refunds (both refund_applied and releasedRefundOf) recover gross purchase amount
    //    and post the refund separately on its bank transaction date
    const expId = 'exp-merch-100';
    const btRefId = '00000000-0000-4000-8000-000000007701';
    const appliedBt = {
      id: btRefId,
      status: 'refund_applied',
      amount: '20.00',
      txn_date: '2026-08-05',
      account_type: 'card',
      account_label: 'Amex Blue',
      description: 'WAWA REFUND',
      suggestion: { refundAppliedTo: expId, refundAmount: 20 },
    };
    const releasedBt = {
      id: '00000000-0000-4000-8000-000000007702',
      status: 'ignored',
      amount: '15.00',
      txn_date: '2026-08-10',
      account_type: 'card',
      suggestion: { releasedRefundOf: expId },
    };
    expect(extractMerchantRefundTarget(appliedBt)).toEqual({ expenseId: expId, refundCents: 2000 });
    expect(extractMerchantRefundTarget(releasedBt)).toEqual({ expenseId: expId, refundCents: 1500 });
    expect(extractMerchantRefundTarget({ status: 'unmatched', amount: '20.00', suggestion: {} })).toBeNull();
    expect(recoverGrossExpenseCents('80.00', 2000)).toBe(10000);
    expect(recoverGrossExpenseCents('0.00', 10000)).toBe(10000);

    // $100 July purchase reduced to $80 by an August $20 card refund -> July posts $100, August posts -$20
    const julExpenseJe = rules.buildExpenseEntry({
      sourceId: expId,
      entryDate: '2026-07-10',
      paymentAccountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY,
      paymentMethod: 'card',
      splits: [{ accountCode: SYSTEM_CODES.COGS_FIELD_VEHICLE, amountCents: recoverGrossExpenseCents('80.00', 2000) }],
      memo: 'Wawa fuel',
    });
    const augRefundJe = rules.buildExpenseRefundEntry({
      sourceId: btRefId,
      entryDate: '2026-08-05',
      paymentAccountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY,
      paymentMethod: 'card',
      bankTransactionId: btRefId,
      splits: [{ accountCode: SYSTEM_CODES.COGS_FIELD_VEHICLE, amountCents: 2000 }],
      reference: expId,
      memo: 'Merchant refund — Wawa',
    });
    expect(validateJournalEntryInput(julExpenseJe).totalCents).toBe(10000);
    expect(validateJournalEntryInput(augRefundJe).totalCents).toBe(2000);

    // July balances match the $100 bank debit; YTD balances reflect net $80
    const julSums = accumulateEntries(accounts, [julExpenseJe]);
    expect(bal(julSums, SYSTEM_CODES.CREDIT_CARD_PRIMARY)).toBe(10000);
    expect(bal(julSums, SYSTEM_CODES.COGS_FIELD_VEHICLE)).toBe(10000);

    const ytdSums = accumulateEntries(accounts, [julExpenseJe, augRefundJe]);
    expect(bal(ytdSums, SYSTEM_CODES.CREDIT_CARD_PRIMARY)).toBe(8000);
    expect(bal(ytdSums, SYSTEM_CODES.COGS_FIELD_VEHICLE)).toBe(8000);

    // End-to-end dryRun sync previews BOTH the gross July expense AND the separate August merchant refund
    const merchConn = (table) => {
      const state = { hasJoinExpenses: false };
      const chain = {
        leftJoin: () => chain,
        join: (t) => {
          if (String(t).startsWith('expenses')) state.hasJoinExpenses = true;
          return chain;
        },
        where: () => chain,
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
          if (table === 'expenses as e') {
            return Promise.resolve([{
              id: expId,
              category_id: null,
              description: 'Wawa fuel',
              amount: '80.00',
              tax_deductible_amount: null,
              notes: null,
              expense_date: '2026-07-10',
              vendor_name: 'Wawa',
              payment_method: 'card',
              scheduled_service_id: null,
              updated_at: '2026-08-05T15:00:00Z',
              category_name: 'Fuel',
            }]);
          }
          if (table === 'bank_transactions as bt') {
            if (state.hasJoinExpenses) {
              return Promise.resolve([{
                ...appliedBt,
                exp_id: expId,
                category_id: null,
                exp_description: 'Wawa fuel',
                exp_notes: null,
                vendor_name: 'Wawa',
                payment_method: 'card',
                scheduled_service_id: null,
              }]);
            }
            return Promise.resolve([appliedBt]);
          }
          return Promise.resolve([]);
        },
        first: () => Promise.resolve(null),
      };
      return chain;
    };
    merchConn.raw = (sql) => sql;
    merchConn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };
    const merchPreview = await syncSubledgersToGl({ fromDate: '2026-07-01', toDate: '2026-08-31', dryRun: true, conn: merchConn });
    expect(merchPreview.expenses.would_post).toBe(2);
    expect(merchPreview.expenses.errors).toEqual([]);
  });

  test('Codex R9: preserve end-at-term prepay revenue, base 1099 on disbursements (not A/P accruals), and keep tax profile when receipts precede invoice GL date', async () => {
    const accounts = makeSyntheticAccounts();
    const revIdByCode = new Map(accounts.filter((a) => a.account_type === 'revenue').map((a) => [a.code, a.id]));

    // 1. Paid cancelled prepay terms (both end_at_term and partial end_now_refund) retain earned visits;
    //    only voided, payment_pending, unpaid, or voided/fully-refunded prepay terms are excluded
    expect(isPrepayTermCoverageValid({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_at_term' }, { status: 'paid' })).toBe(true);
    expect(isPrepayTermCoverageValid({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: null }, { status: 'prepaid' })).toBe(true);
    expect(isPrepayTermCoverageValid({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_now_refund' }, { status: 'paid' })).toBe(true);
    expect(isPrepayTermCoverageValid({ status: 'cancelled', renewal_decision: null, cancel_disposition: null }, { status: 'overdue', paid_at: null })).toBe(false);
    expect(isPrepayTermCoverageValid({ status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_at_term' }, { status: 'refunded' })).toBe(false);
    expect(isPrepayTermCoverageValid({ status: 'void' }, { status: 'paid' })).toBe(false);
    expect(isPrepayTermCoverageValid({ status: 'active' }, { status: 'paid' })).toBe(true);

    // 2. 1099-NEC totals count disbursements (direct payments & A/P settlements), NOT unpaid A/P accruals
    const decBillAccrual = {
      vendor_id: 'v1', display_name: 'Sub Co', entity_type: 'sole_prop', w9_received_at: '2025-01-10',
      entry_id: 'e-dec-bill', entry_type: 'manual', account_sub_type: 'subcontractors',
      payment_method: null, debit_cents: 250000, credit_cents: 0, paid_by_credit_card: false,
      entry_disbursement_cents: 0, entry_expense_net_cents: 250000,
    };
    const decSummary = summarize1099VendorLines([decBillAccrual], [
      { entry_id: 'e-dec-unlinked-bill', entry_type: 'manual', entry_number: 5, entry_date: '2025-12-20', entry_memo: 'Accrued bill', account_sub_type: 'subcontractors', debit_cents: 250000, credit_cents: 0, paid_by_credit_card: false, entry_disbursement_cents: 0, entry_expense_net_cents: 250000 },
    ], 60000);
    expect(decSummary.vendors).toEqual([]);
    expect(decSummary.unlinked_contractor_count).toBe(0);

    const janApPayment = {
      vendor_id: 'v1', display_name: 'Sub Co', entity_type: 'sole_prop', w9_received_at: '2025-01-10',
      entry_id: 'e-jan-pay', entry_type: 'manual', account_sub_type: 'ap',
      payment_method: 'ach', debit_cents: 250000, credit_cents: 0, paid_by_credit_card: false,
      entry_disbursement_cents: 250000, entry_expense_net_cents: 0,
    };
    const janCardApPayment = {
      vendor_id: 'v1', display_name: 'Sub Co', entity_type: 'sole_prop', w9_received_at: '2025-01-10',
      entry_id: 'e-jan-card-pay', entry_type: 'manual', account_sub_type: 'ap',
      payment_method: null, debit_cents: 100000, credit_cents: 0, paid_by_credit_card: true,
      entry_disbursement_cents: 100000, entry_expense_net_cents: 0,
    };
    const janSummary = summarize1099VendorLines([janApPayment, janCardApPayment], [], 200000);
    expect(janSummary.vendors).toHaveLength(1);
    expect(janSummary.vendors[0].total_paid_cents).toBe(250000);
    expect(janSummary.vendors[0].excluded_1099k_cents).toBe(100000);
    expect(janSummary.vendors[0].filing_required).toBe(true);

    // Mixed partial-cash + partial-A/P bill reports only the $1,000 disbursed on the bill date
    expect(reportable1099LineCents({
      account_sub_type: 'subcontractors', debit_cents: 250000, credit_cents: 0,
      entry_disbursement_cents: 100000, entry_expense_net_cents: 250000,
    })).toBe(100000);
    expect(reportable1099LineCents({
      account_sub_type: 'ap', debit_cents: 0, credit_cents: 150000,
      entry_disbursement_cents: 100000, entry_expense_net_cents: 250000,
    })).toBe(0);

    // 3. Cash-basis receipt on Nov 28 preceding Dec 5 taxable invoice GL date excludes $7 sales tax
    //    whether the report ends Nov 30 (fallback profile) or extends into Dec (initial GL profile)
    const commRevId = revIdByCode.get(SYSTEM_CODES.REV_COMMERCIAL_PEST);
    const decInvoiceLines = [
      { entry_date: '2026-12-05', code: SYSTEM_CODES.ACCOUNTS_RECEIVABLE, account_type: 'asset', account_id: 'ar-id', debit_cents: 10700, credit_cents: 0 },
      { entry_date: '2026-12-05', code: SYSTEM_CODES.REV_COMMERCIAL_PEST, account_type: 'revenue', account_id: commRevId, debit_cents: 0, credit_cents: 10000 },
      { entry_date: '2026-12-05', code: SYSTEM_CODES.SALES_TAX_PAYABLE, account_type: 'liability', account_id: 'tax-id', debit_cents: 0, credit_cents: 700 },
      // Later Jan edit to $214 must NOT alter the Nov 28 pre-paid receipt's profile
      { entry_date: '2027-01-10', code: SYSTEM_CODES.ACCOUNTS_RECEIVABLE, account_type: 'asset', account_id: 'ar-id', debit_cents: 10700, credit_cents: 0 },
      { entry_date: '2027-01-10', code: SYSTEM_CODES.REV_COMMERCIAL_PEST, account_type: 'revenue', account_id: commRevId, debit_cents: 0, credit_cents: 10000 },
      { entry_date: '2027-01-10', code: SYSTEM_CODES.SALES_TAX_PAYABLE, account_type: 'liability', account_id: 'tax-id', debit_cents: 0, credit_cents: 700 },
    ];
    const fallbackProfile = {
      arDebitedCents: 10700,
      taxCents: 700,
      revenueSplits: [{ accountId: commRevId, amountCents: 10000 }],
    };

    // Report ending Nov 30 (no GL invoice rows yet -> fallback profile)
    const novProfile = resolveInvoiceProfileForReceipt([], '2026-11-28', fallbackProfile);
    const novAlloc = allocateCumulativeCashReceipt(0, 10700, novProfile, 'commercial', revIdByCode);
    expect(novAlloc).toEqual([{ accountId: commRevId, signedCents: 10000 }]);

    // Report extending through Dec 31 or Jan 31 (Dec 5 GL invoice row IS present -> uses earliest GL profile, still $100!)
    const decProfile = resolveInvoiceProfileForReceipt(decInvoiceLines, '2026-11-28', null);
    const decAlloc = allocateCumulativeCashReceipt(0, 10700, decProfile, 'commercial', revIdByCode);
    expect(decAlloc).toEqual([{ accountId: commRevId, signedCents: 10000 }]);
  });

  test('Codex R10: recategorizing an expense reconciles its already-synced merchant refund into the new account', async () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const accountsById = new Map(accounts.map((a) => [String(a.id).toLowerCase(), a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    const expId = 'exp-recat-100';
    const btRefId = '00000000-0000-4000-8000-000000007801';
    const supplies = byCode.get(SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES);
    const utilities = byCode.get(SYSTEM_CODES.OPEX_UTILITIES);

    // 1. Original $100 Supplies purchase + $20 Supplies refund
    const origExpJe = rules.buildExpenseEntry({
      sourceId: expId,
      entryDate: '2026-07-10',
      paymentAccountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY,
      paymentMethod: 'card',
      splits: [{ accountCode: SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES, amountCents: 10000 }],
      memo: 'Initial Supplies purchase',
    });
    const origRefJe = rules.buildExpenseRefundEntry({
      sourceId: btRefId,
      entryDate: '2026-08-05',
      paymentAccountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY,
      paymentMethod: 'card',
      bankTransactionId: btRefId,
      splits: [{ accountCode: SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES, amountCents: 2000 }],
      reference: expId,
      memo: 'Initial Supplies refund',
    });

    // 2. Expense recategorized to Utilities on Aug 12: both gross expense AND merchant refund adjust cleanly
    const expAdjJe = rules.buildExpenseEntry({
      sourceId: `${expId}-adj`,
      entryDate: '2026-08-12',
      paymentAccountCode: SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES,
      splits: [{ accountCode: SYSTEM_CODES.OPEX_UTILITIES, amountCents: 10000 }],
      memo: 'Recat gross expense to Utilities',
    });
    const desiredRef = rules.buildExpenseRefundEntry({
      sourceId: btRefId,
      entryDate: '2026-08-05',
      paymentAccountCode: SYSTEM_CODES.CREDIT_CARD_PRIMARY,
      paymentMethod: 'card',
      bankTransactionId: btRefId,
      splits: [{ accountId: utilities.id, amountCents: 2000 }],
      reference: expId,
      memo: 'Updated Utilities refund',
    });
    const bookedRefByCode = new Map([
      [SYSTEM_CODES.CREDIT_CARD_PRIMARY, 2000],
      [SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES, -2000],
    ]);
    const refAdjJe = buildMerchantRefundDeltaEntry(
      { id: btRefId, exp_id: expId, vendor_name: 'Vendor', description: 'Refund', payment_method: 'card' },
      desiredRef.lines,
      bookedRefByCode,
      '2026-08-12',
      1,
      { accountsById },
    );
    expect(refAdjJe).not.toBeNull();
    expect(refAdjJe.idempotencyKey.startsWith(`expense-refund-adj:${btRefId}:seq-1:`)).toBe(true);
    expect(refAdjJe.entryDate).toBe('2026-08-12');
    expect(validateJournalEntryInput(refAdjJe).totalCents).toBe(2000);

    // Supplies nets to $0, Utilities nets to $80, Credit Card stays at $80 (untouched by category reclass)
    const finalSums = accumulateEntries(accounts, [origExpJe, origRefJe, expAdjJe, refAdjJe]);
    expect(bal(finalSums, SYSTEM_CODES.COGS_CHEMICALS_SUPPLIES)).toBe(0);
    expect(bal(finalSums, SYSTEM_CODES.OPEX_UTILITIES)).toBe(8000);
    expect(bal(finalSums, SYSTEM_CODES.CREDIT_CARD_PRIMARY)).toBe(8000);

    // Unchanged allocation produces null (idempotent skip)
    const unchangedBooked = new Map([
      [SYSTEM_CODES.CREDIT_CARD_PRIMARY, 2000],
      [SYSTEM_CODES.OPEX_UTILITIES, -2000],
    ]);
    expect(buildMerchantRefundDeltaEntry(
      { id: btRefId, exp_id: expId, vendor_name: 'Vendor', description: 'Refund', payment_method: 'card' },
      desiredRef.lines,
      unchangedBooked,
      '2026-08-12',
      2,
      { accountsById },
    )).toBeNull();

    // End-to-end dryRun sync previews would_adjust = 1 on an already-booked refund after category change
    const utilCatId = '00000000-0000-4000-8000-00000000c650';
    const glAccountsWithCat = accounts.map((a) => (a.id === utilities.id ? { ...a, expense_category_id: utilCatId } : a));
    const recatConn = (table) => {
      const state = { hasJoinExpenses: false, sourceType: null };
      const chain = {
        leftJoin: () => chain,
        join: (t) => {
          if (String(t).startsWith('expenses')) state.hasJoinExpenses = true;
          return chain;
        },
        where: (arg) => {
          if (arg && typeof arg === 'object' && arg['e.source_type']) state.sourceType = arg['e.source_type'];
          return chain;
        },
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
          if (table === 'gl_accounts') return Promise.resolve(glAccountsWithCat);
          if (table === 'bank_transactions as bt' && state.hasJoinExpenses) {
            return Promise.resolve([{
              id: btRefId,
              status: 'refund_applied',
              amount: '20.00',
              txn_date: '2026-08-05',
              account_type: 'card',
              account_label: 'Amex Blue',
              description: 'MERCHANT REFUND',
              suggestion: { refundAppliedTo: expId, refundAmount: 20 },
              matched_at: '2026-08-06T12:00:00Z',
              updated_at: '2026-08-06T12:00:00Z',
              exp_id: expId,
              category_id: utilCatId,
              exp_description: 'Updated utility expense',
              exp_notes: null,
              vendor_name: 'FPL',
              payment_method: 'card',
              scheduled_service_id: null,
              exp_updated_at: '2026-08-12T15:00:00Z',
            }]);
          }
          if (table === 'gl_journal_lines as l' && state.sourceType === 'expense_refund') {
            return Promise.resolve([
              { entry_id: 'je-ref-orig', reversed_by_entry_id: null, code: SYSTEM_CODES.CREDIT_CARD_PRIMARY, debit_cents: 2000, credit_cents: 0 },
              { entry_id: 'je-ref-orig', reversed_by_entry_id: null, code: supplies.code, debit_cents: 0, credit_cents: 2000 },
            ]);
          }
          return Promise.resolve([]);
        },
        first: () => Promise.resolve(null),
      };
      return chain;
    };
    recatConn.raw = (sql) => sql;
    recatConn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };
    const recatPreview = await syncSubledgersToGl({ fromDate: '2026-08-01', toDate: '2026-08-31', dryRun: true, conn: recatConn });
    expect(recatPreview.expenses.would_adjust).toBe(1);
    expect(recatPreview.expenses.errors).toEqual([]);
  });

  test('Codex R11: atomic visit supersession on locked periods, retained end-now-refund visits, noncash cash-flow exclusions, and invoice-less monthly dues accrual', async () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    // 1. Replacement covered invoice in a LOCKED month must NOT reverse the already-recognized visit
    const lockedCovInv = {
      id: 'inv-locked-cov-1',
      invoice_number: 'WPC-LOCK-COV',
      status: 'paid',
      scheduled_service_id: '00000000-0000-4000-8000-00000000f111',
      annual_prepay_covered_term_id: 'term-lock-1',
      subtotal: '100.00',
      discount_amount: '0',
      tax_amount: '0',
      total: '0',
      visit_prepaid_amount: '100.00',
      service_type: 'pest',
      service_date: '2026-09-15',
      updated_at: '2026-10-05T14:00:00Z',
      property_type: 'single_family',
    };
    const lockConn = (table) => {
      const state = { isVisitLookup: false };
      const chain = {
        leftJoin: () => chain,
        join: () => chain,
        where: (arg) => {
          if (arg && typeof arg === 'object' && arg.source_type === 'unearned_recognition') {
            state.isVisitLookup = true;
          }
          return chain;
        },
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
          if (table === 'gl_periods') return Promise.resolve([{ period_month: '2026-09', status: 'locked' }]);
          if (table === 'invoices as i') return Promise.resolve([lockedCovInv]);
          return Promise.resolve([]);
        },
        first: () => {
          if (table === 'gl_journal_entries' && state.isVisitLookup) {
            return Promise.resolve({ id: 'je-visit-existing', reversed_by_entry_id: null, entry_date: '2026-09-15' });
          }
          return Promise.resolve(null);
        },
      };
      return chain;
    };
    lockConn.raw = (sql) => sql;
    lockConn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };
    const lockPreview = await syncSubledgersToGl({ fromDate: '2026-09-01', toDate: '2026-10-31', dryRun: true, conn: lockConn });
    expect(lockPreview.invoices.would_post).toBe(0);
    expect(lockPreview.invoices.would_reverse).toBe(0);
    expect(lockPreview.invoices.errors.length).toBeGreaterThan(0);

    // 2. End-now-refund cancellation ($400 4-visit prepay, 1 completed $100 visit, $300 unused refund)
    //    retains the $100 earned visit and clears 2300 Unearned Revenue cleanly to $0
    expect(isPrepayTermRevokedForPostedVisit(
      { status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_now_refund' },
      { status: 'paid' },
    )).toBe(false);
    expect(isPrepayTermRevokedForPostedVisit(
      { status: 'cancelled', renewal_decision: 'cancel', cancel_disposition: 'end_now_refund' },
      { status: 'refunded' },
    )).toBe(false);
    expect(isPrepayTermRevokedForPostedVisit({ status: 'cancelled' }, { status: 'void' })).toBe(true);
    expect(isPrepayTermRevokedForPostedVisit({ status: 'payment_pending' }, { status: 'sent', paid_at: null })).toBe(true);

    const prepayPartialRefundUnearned = computePrepayRefundUnearnedCents({
      isAnnualPrepay: true,
      isReversal: false,
      subtotalCents: 30000,
      originalUnearnedCents: 40000,
      recognizedCents: 10000,
      priorUnearnedRefundedCents: 0,
    });
    expect(prepayPartialRefundUnearned).toBe(30000);
    const endNowSums = accumulateEntries(accounts, [
      rules.buildInvoiceEntry({ invoiceId: 'inv-pp-400', issueDate: '2026-01-01', subtotalCents: 40000, isAnnualPrepay: true }),
      rules.buildPaymentEntry({ paymentId: 'pay-pp-400', paymentDate: '2026-01-01', grossCents: 40000, method: 'stripe', invoiceId: 'inv-pp-400' }),
      rules.buildUnearnedRecognitionEntry({ sourceId: 'covered-visit:v1', recognitionDate: '2026-02-01', amountCents: 10000, serviceLine: 'pest' }),
      rules.buildRefundEntry({ refundId: 'ref-pp-300', refundDate: '2026-03-01', subtotalCents: 30000, unearnedCents: prepayPartialRefundUnearned, method: 'stripe', invoiceId: 'inv-pp-400' }),
    ]);
    expect(bal(endNowSums, SYSTEM_CODES.UNEARNED_REVENUE)).toBe(0);
    expect(bal(endNowSums, SYSTEM_CODES.REV_RESIDENTIAL_PEST)).toBe(10000);
    expect(bal(endNowSums, SYSTEM_CODES.STRIPE_CLEARING)).toBe(10000);

    // 3. Noncash financed vehicle acquisition (DR Vehicles $10,000 / CR Loans Payable $10,000)
    //    reports $0 investing & $0 financing cash flows while disclosing $10,000 noncash activity;
    //    partially financed acquisition ($30,000 truck = $5,000 cash + $25,000 loan) reports -$5,000 investing and $0 financing
    const vehAcct = byCode.get(SYSTEM_CODES.FIXED_ASSETS_VEHICLES);
    const loanAcct = byCode.get(SYSTEM_CODES.LOANS_PAYABLE);
    const chkAcct = byCode.get(SYSTEM_CODES.CHECKING_PRIMARY);

    const pureFinancedSums = accumulateEntries(accounts, [{
      entryDate: '2026-06-01',
      entryType: 'adjusting',
      memo: 'Financed truck',
      lines: [
        { accountCode: SYSTEM_CODES.FIXED_ASSETS_VEHICLES, debitCents: 1000000, creditCents: 0 },
        { accountCode: SYSTEM_CODES.LOANS_PAYABLE, debitCents: 0, creditCents: 1000000 },
      ],
    }]);
    const pureCf = computeCashFlowStatement(accounts, pureFinancedSums, new Map(), {
      from: '2026-06-01',
      to: '2026-06-30',
      nonCashEntries: [
        { entry_id: 'je-fin-1', entry_date: '2026-06-01', memo: 'Financed truck', account_id: vehAcct.id, debit_cents: 1000000, credit_cents: 0 },
        { entry_id: 'je-fin-1', entry_date: '2026-06-01', memo: 'Financed truck', account_id: loanAcct.id, debit_cents: 0, credit_cents: 1000000 },
      ],
    });
    expect(pureCf.investing.total_cents).toBe(0);
    expect(pureCf.financing.total_cents).toBe(0);
    expect(pureCf.non_cash_investing_financing).toHaveLength(1);
    expect(pureCf.non_cash_investing_financing[0].amount_cents).toBe(1000000);
    expect(pureCf.summary.reconciles_to_cash).toBe(true);

    const partialFinancedSums = accumulateEntries(accounts, [{
      entryDate: '2026-06-15',
      entryType: 'adjusting',
      memo: 'Truck down payment + loan',
      lines: [
        { accountCode: SYSTEM_CODES.FIXED_ASSETS_VEHICLES, debitCents: 3000000, creditCents: 0 },
        { accountCode: SYSTEM_CODES.CHECKING_PRIMARY, debitCents: 0, creditCents: 500000 },
        { accountCode: SYSTEM_CODES.LOANS_PAYABLE, debitCents: 0, creditCents: 2500000 },
      ],
    }]);
    const partialCf = computeCashFlowStatement(accounts, partialFinancedSums, new Map(), {
      from: '2026-06-01',
      to: '2026-06-30',
      nonCashEntries: [
        { entry_id: 'je-fin-2', entry_date: '2026-06-15', memo: 'Truck down payment + loan', account_id: vehAcct.id, debit_cents: 3000000, credit_cents: 0 },
        { entry_id: 'je-fin-2', entry_date: '2026-06-15', memo: 'Truck down payment + loan', account_id: chkAcct.id, debit_cents: 0, credit_cents: 500000 },
        { entry_id: 'je-fin-2', entry_date: '2026-06-15', memo: 'Truck down payment + loan', account_id: loanAcct.id, debit_cents: 0, credit_cents: 2500000 },
      ],
    });
    expect(partialCf.investing.total_cents).toBe(-500000);
    expect(partialCf.financing.total_cents).toBe(0);
    expect(partialCf.non_cash_investing_financing[0].amount_cents).toBe(2500000);
    expect(partialCf.summary.reconciles_to_cash).toBe(true);

    // 4. Invoice-less monthly dues (stripe.chargeMonthly) accrue revenue keyed to billed_month
    //    and clear 1100 A/R cleanly to $0 instead of driving A/R negative
    const monthlyPay = {
      id: 'pay-monthly-100',
      customer_id: '00000000-0000-4000-8000-000000000801',
      amount: '100.00',
      processor: 'stripe',
      stripe_payment_intent_id: 'pi_monthly_100',
      payment_date: '2026-12-02',
      description: 'WaveGuard WaveGuard Monthly — Jane Doe',
      metadata: { type: 'monthly_autopay', tier: 'WaveGuard', billed_month: '2026-11' },
      property_type: 'single_family',
    };
    expect(isInvoiceLessMonthlyDuesPayment(monthlyPay, null, null)).toBe(true);
    expect(isInvoiceLessMonthlyDuesPayment(monthlyPay, { id: 'inv-1' }, null)).toBe(false);
    expect(resolveMonthlyDuesPeriod(monthlyPay, '2026-12-02', new Set())).toEqual({ billedMonth: '2026-11', accrualDate: '2026-11-01' });
    expect(resolveMonthlyDuesPeriod(monthlyPay, '2026-12-02', new Set(['2026-11']))).toEqual({ billedMonth: '2026-11', accrualDate: '2026-12-02' });

    const duesAccrual = rules.buildMonthlyDuesAccrualEntry({
      paymentId: monthlyPay.id,
      accrualDate: '2026-11-01',
      billedMonth: '2026-11',
      amountCents: 10000,
      serviceLine: 'pest',
      isCommercial: false,
      customerId: monthlyPay.customer_id,
    });
    const duesPayment = rules.buildPaymentEntry({
      paymentId: monthlyPay.id,
      paymentDate: '2026-12-02',
      grossCents: 10000,
      method: 'stripe',
      invoiceId: duesAccrual.idempotencyKey,
      customerId: monthlyPay.customer_id,
      serviceLine: 'pest',
    });
    const duesSums = accumulateEntries(accounts, [duesAccrual, duesPayment]);
    expect(bal(duesSums, SYSTEM_CODES.ACCOUNTS_RECEIVABLE)).toBe(0);
    expect(bal(duesSums, SYSTEM_CODES.REV_RESIDENTIAL_PEST)).toBe(10000);
    expect(bal(duesSums, SYSTEM_CODES.STRIPE_CLEARING)).toBe(10000);

    // End-to-end dryRun sync previews BOTH the monthly dues accrual AND the payment entry (2 entries)
    const duesConn = (table) => {
      const chain = {
        leftJoin: () => chain,
        join: () => chain,
        where: () => chain,
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
          if (table === 'payments as p') return Promise.resolve([monthlyPay]);
          return Promise.resolve([]);
        },
        first: () => Promise.resolve(null),
      };
      return chain;
    };
    duesConn.raw = (sql) => sql;
    duesConn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };
    const duesPreview = await syncSubledgersToGl({ fromDate: '2026-12-01', toDate: '2026-12-31', dryRun: true, conn: duesConn });
    expect(duesPreview.payments.would_post).toBe(2);
    expect(duesPreview.payments.errors).toEqual([]);
  });

  test('Codex R12: separate asset disposals from depreciation/acquisitions in cash flows and reconcile settlement accounts after bank mapping edits', async () => {
    const accounts = makeSyntheticAccounts();
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const bal = (sums, code) => {
      const a = byCode.get(code);
      const s = sums.get(a.id) || { debitCents: 0, creditCents: 0 };
      return naturalBalanceCents(a, s.debitCents, s.creditCents);
    };

    // 1. Selling a $10,000 vehicle with $2,000 accum depr for $9,000 cash ($1,000 gain)
    //    must report $0 operating cash flow (not -$1,000) and +$9,000 investing proceeds (not +$10,000)
    const chk = byCode.get(SYSTEM_CODES.CHECKING_PRIMARY);
    const veh = byCode.get(SYSTEM_CODES.FIXED_ASSETS_VEHICLES);
    const accum = byCode.get(SYSTEM_CODES.ACCUM_DEPRECIATION);
    const otherRev = byCode.get(SYSTEM_CODES.REV_OTHER);
    const lossAcct = byCode.get(SYSTEM_CODES.OPEX_UNCATEGORIZED);

    const gainDisposalSums = accumulateEntries(accounts, [{
      entryDate: '2026-07-01',
      entryType: 'adjusting',
      memo: 'Sell depreciated vehicle at gain',
      lines: [
        { accountCode: SYSTEM_CODES.CHECKING_PRIMARY, debitCents: 900000, creditCents: 0 },
        { accountCode: SYSTEM_CODES.ACCUM_DEPRECIATION, debitCents: 200000, creditCents: 0 },
        { accountCode: SYSTEM_CODES.FIXED_ASSETS_VEHICLES, debitCents: 0, creditCents: 1000000 },
        { accountCode: SYSTEM_CODES.REV_OTHER, debitCents: 0, creditCents: 100000 },
      ],
    }]);
    const gainCf = computeCashFlowStatement(accounts, gainDisposalSums, new Map(), {
      from: '2026-07-01',
      to: '2026-07-31',
      nonCashEntries: [
        { entry_id: 'je-disp-gain', entry_date: '2026-07-01', memo: 'Sell vehicle', account_id: chk.id, debit_cents: 900000, credit_cents: 0 },
        { entry_id: 'je-disp-gain', entry_date: '2026-07-01', memo: 'Sell vehicle', account_id: accum.id, debit_cents: 200000, credit_cents: 0 },
        { entry_id: 'je-disp-gain', entry_date: '2026-07-01', memo: 'Sell vehicle', account_id: veh.id, debit_cents: 0, credit_cents: 1000000 },
        { entry_id: 'je-disp-gain', entry_date: '2026-07-01', memo: 'Sell vehicle', account_id: otherRev.id, debit_cents: 0, credit_cents: 100000 },
      ],
    });
    expect(gainCf.operating.net_income_cents).toBe(100000);
    expect(gainCf.operating.depreciation_addback_cents).toBe(0);
    expect(gainCf.operating.disposal_gain_loss_adjustment_cents).toBe(-100000);
    expect(gainCf.operating.total_cents).toBe(0);
    expect(gainCf.investing.total_cents).toBe(900000);
    expect(gainCf.summary.reconciles_to_cash).toBe(true);

    // Loss disposal ($10k vehicle, $2k accum depr, sold for $6,500 cash -> $1,500 loss) -> $0 operating, +$6,500 investing
    const lossDisposalSums = accumulateEntries(accounts, [{
      entryDate: '2026-07-15',
      entryType: 'adjusting',
      memo: 'Sell vehicle at loss',
      lines: [
        { accountCode: SYSTEM_CODES.CHECKING_PRIMARY, debitCents: 650000, creditCents: 0 },
        { accountCode: SYSTEM_CODES.ACCUM_DEPRECIATION, debitCents: 200000, creditCents: 0 },
        { accountCode: SYSTEM_CODES.OPEX_UNCATEGORIZED, debitCents: 150000, creditCents: 0 },
        { accountCode: SYSTEM_CODES.FIXED_ASSETS_VEHICLES, debitCents: 0, creditCents: 1000000 },
      ],
    }]);
    const lossCf = computeCashFlowStatement(accounts, lossDisposalSums, new Map(), {
      from: '2026-07-01',
      to: '2026-07-31',
      nonCashEntries: [
        { entry_id: 'je-disp-loss', entry_date: '2026-07-15', memo: 'Sell vehicle at loss', account_id: chk.id, debit_cents: 650000, credit_cents: 0 },
        { entry_id: 'je-disp-loss', entry_date: '2026-07-15', memo: 'Sell vehicle at loss', account_id: accum.id, debit_cents: 200000, credit_cents: 0 },
        { entry_id: 'je-disp-loss', entry_date: '2026-07-15', memo: 'Sell vehicle at loss', account_id: lossAcct.id, debit_cents: 150000, credit_cents: 0 },
        { entry_id: 'je-disp-loss', entry_date: '2026-07-15', memo: 'Sell vehicle at loss', account_id: veh.id, debit_cents: 0, credit_cents: 1000000 },
      ],
    });
    expect(lossCf.operating.total_cents).toBe(0);
    expect(lossCf.investing.total_cents).toBe(650000);
    expect(lossCf.summary.reconciles_to_cash).toBe(true);

    // 2. Reconcile settlement bank account after secondary Plaid account is mapped
    const customChecking = {
      id: '00000000-0000-4000-8000-000000001015',
      code: '1015',
      name: 'Secondary Checking',
      account_type: 'asset',
      sub_type: 'checking',
      normal_balance: 'debit',
      active: true,
      is_system: false,
      plaid_account_id: 'plaid-sec-chk',
    };
    const accountsWithCustom = [...accounts, customChecking];
    const accountsById = new Map(accountsWithCustom.map((a) => [String(a.id).toLowerCase(), a]));
    const btId = '00000000-0000-4000-8000-00000000b715';
    const keyBase = `sales-tax-remit:bt:${btId}`;

    // Originally booked to default 1010 Checking; after mapping Plaid account -> desired targets 1015
    const origRemit = rules.buildSalesTaxRemittanceEntry({
      sourceId: `bt-filing:${btId}`,
      idempotencyKey: keyBase,
      paymentDate: '2026-07-15',
      amountCents: 100000,
      periodLabel: '2026-06',
      bankAccountCode: SYSTEM_CODES.CHECKING_PRIMARY,
      bankTransactionId: btId,
    });
    const desiredRemit = rules.buildSalesTaxRemittanceEntry({
      sourceId: `bt-filing:${btId}`,
      idempotencyKey: keyBase,
      paymentDate: '2026-07-15',
      amountCents: 100000,
      periodLabel: '2026-06',
      bankAccountId: customChecking.id,
      bankTransactionId: btId,
    });
    const bookedMap = new Map([
      [SYSTEM_CODES.SALES_TAX_PAYABLE, 100000],
      [SYSTEM_CODES.CHECKING_PRIMARY, -100000],
    ]);
    const reclassJe = buildSettlementReclassEntry(desiredRemit, keyBase, bookedMap, 1, '2026-07-15', accountsById);
    expect(reclassJe).not.toBeNull();
    expect(matchesSettlementKeyBase(reclassJe.idempotencyKey, keyBase)).toBe(true);
    expect(validateJournalEntryInput(reclassJe).totalCents).toBe(100000);

    // Default 1010 Checking clears back to $0, Secondary 1015 Checking carries -$1,000, 2100 Tax stays +$1,000
    const remitSums = accumulateEntries(accountsWithCustom, [origRemit, reclassJe]);
    expect(bal(remitSums, SYSTEM_CODES.CHECKING_PRIMARY)).toBe(0);
    expect(naturalBalanceCents(customChecking, remitSums.get(customChecking.id)?.debitCents || 0, remitSums.get(customChecking.id)?.creditCents || 0)).toBe(-100000);
    expect(bal(remitSums, SYSTEM_CODES.SALES_TAX_PAYABLE)).toBe(-100000);

    // End-to-end dryRun sync previews would_adjust = 1 on the remapped tax filing settlement
    const settleConn = (table) => {
      const state = { isFilingQuery: false, isEntryKeyQuery: false };
      const chain = {
        leftJoin: () => chain,
        join: (t) => {
          if (String(t).startsWith('tax_filing_calendar')) state.isFilingQuery = true;
          return chain;
        },
        where: () => chain,
        whereIn: (col) => {
          if (col === 'l.entry_id') state.isEntryKeyQuery = true;
          return chain;
        },
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
          if (table === 'gl_accounts') return Promise.resolve(accountsWithCustom);
          if (table === 'gl_accounts as g') {
            return Promise.resolve([{
              id: customChecking.id,
              code: customChecking.code,
              plaid_external_id: 'plaid-sec-chk',
              account_label: 'Secondary Checking',
            }]);
          }
          if (table === 'bank_transactions as bt' && state.isFilingQuery) {
            return Promise.resolve([{
              id: btId,
              txn_date: '2026-07-15',
              amount: '1000.00',
              description: 'FL DOR DR-15',
              account_label: 'Secondary Checking',
              account_type: 'checking',
              plaid_account_id: 'plaid-sec-chk',
              matched_tax_filing_id: 'tfc-1',
              filing_type: 'dr15_sales_tax',
              filing_title: 'FL DR-15 Sales Tax',
              filing_period_label: '2026-06',
              filing_source_key: 'dr15:2026-06',
            }]);
          }
          if (table === 'gl_journal_entries') {
            return Promise.resolve([{ id: 'je-remit-orig', idempotency_key: keyBase, reversed_by_entry_id: null }]);
          }
          if (table === 'gl_journal_lines as l' && state.isEntryKeyQuery) {
            return Promise.resolve([
              { code: SYSTEM_CODES.SALES_TAX_PAYABLE, debit_cents: 100000, credit_cents: 0 },
              { code: SYSTEM_CODES.CHECKING_PRIMARY, debit_cents: 0, credit_cents: 100000 },
            ]);
          }
          return Promise.resolve([]);
        },
        first: () => Promise.resolve(null),
      };
      return chain;
    };
    settleConn.raw = (sql) => sql;
    settleConn.schema = { hasTable: () => Promise.resolve(true), hasColumn: () => Promise.resolve(true) };
    const settlePreview = await syncSubledgersToGl({ fromDate: '2026-07-01', toDate: '2026-07-31', dryRun: true, conn: settleConn });
    expect(settlePreview.payroll_settlements.would_adjust).toBe(1);
    expect(settlePreview.payroll_settlements.errors).toEqual([]);
  });
});
